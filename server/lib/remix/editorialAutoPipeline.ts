/**
 * Editorial Auto-Pipeline — Auto-generate scored story-clips on video ingest.
 *
 * Feature A — fires after upload completes, produces ≥10 playable editorial clips
 * without any manual user action.
 *
 * Pipeline steps:
 *   1. Idempotency check (skip if already ready)
 *   2. Ensure transcript (run transcriptPipeline if missing)
 *   3. Run editorial analysis (analyzeEditorial → rankClips → dedupe)
 *   4. Save clip metadata to editorialClips table
 *   5. Render each clip via stitchSegments (single-segment extraction)
 *   6. Upload rendered MP4 + thumbnail to Object Storage
 *   7. Update editorialClips rows with exportPath/thumbnailPath
 *   8. Update videoIndex.editorialStatus → ready
 *
 * The "narrative" promise: editorial analyzer scores for narrativeCompleteness,
 * hookStrength, etc. — each clip is a self-contained story moment, not a
 * time-range extract. Multi-segment narrative assembly (stitchPlans) is a
 * separate future feature built on the same foundation.
 */

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { storage } from "../../storage";
import { runTranscriptPipeline } from "./transcriptPipeline";
import { analyzeEditorial } from "../ai/claude-dense/editorialAnalyzer";
import { rankClips, deduplicateClips } from "./clipRanker";
import { PLATFORM_CONFIGS } from "./clipDetector";
import { detectFacesInClip, computeCropTrajectory, buildCropFilterExpr, getVideoSize } from "./faceTracker";
import { withRenderSlot } from "./renderQueue";
import { generateTranscriptCaptions } from "./captionEngine";
import { buildCaptionFilter } from "./clipGenerator";
import { downloadToTempFile, uploadFileToStorage, objectKeyFromServeUrl } from "../objectStorage";

// ── Configuration ──────────────────────────────────────────────────

const AUTO_PIPELINE_CONFIG = {
  /** Target number of editorial clips per video */
  targetClipCount: 12,
  /** Minimum to count as "success" */
  minClipCount: 6,
  /** Platform config for rendered output */
  platformKey: "tiktok" as const, // 9:16 1080x1920 — default for discovery-friendly format
  /** Minimum audio duration to run pipeline on (seconds) */
  minVideoDurationSeconds: 30,
  /** Skip transcript auto-trigger if already processing */
  transcriptStaleAfterMs: 10 * 60 * 1000, // 10 minutes
} as const;

// ── Types ──────────────────────────────────────────────────────────

export interface EditorialAutoPipelineResult {
  success: boolean;
  videoId: number;
  status: "ready" | "failed" | "skipped";
  clipsGenerated: number;
  clipsRendered: number;
  error?: string;
  stage?: "transcribe" | "analyze" | "render";
  durationMs: number;
}

export interface EditorialAutoPipelineOptions {
  /** Force re-run even if already ready */
  force?: boolean;
  /** Override target clip count */
  targetClipCount?: number;
  /**
   * Resume mode: skip transcript+analysis, only render clips with
   * renderStatus !== "rendered". Preserves existing rendered clips.
   * Used to recover from stuck state after server restart.
   */
  resume?: boolean;
}

/** Status is considered stuck if no DB update in this many ms while in-flight */
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ── Main Pipeline ──────────────────────────────────────────────────

/**
 * Run the editorial auto-pipeline for a video.
 *
 * Fire-and-forget: callers should not await this for request/response paths.
 * All progress is persisted via videoIndex.editorialStatus so the UI can poll.
 */
export async function runEditorialAutoPipeline(
  videoId: number,
  userId: number,
  options: EditorialAutoPipelineOptions = {}
): Promise<EditorialAutoPipelineResult> {
  const start = Date.now();
  const { force = false, resume = false, targetClipCount = AUTO_PIPELINE_CONFIG.targetClipCount } = options;

  const emptyResult: EditorialAutoPipelineResult = {
    success: false,
    videoId,
    status: "failed",
    clipsGenerated: 0,
    clipsRendered: 0,
    durationMs: 0,
  };

  console.log(`[EditorialAuto] ▶ Starting for video ${videoId} (user ${userId}, force=${force}, resume=${resume})`);

  // ── 0. Pre-flight checks ─────────────────────────────────────────
  const video = await storage.getVideoById(videoId);
  if (!video) {
    return { ...emptyResult, error: "Video not found", durationMs: Date.now() - start };
  }
  if (!video.filePath && !video.youtubeId) {
    return { ...emptyResult, error: "Video has no source (no file and no platform id)", durationMs: Date.now() - start };
  }

  // Lazy PINNED source resolution. Light-cloud imports (YouTube/IG/FB) have
  // no filePath — pull via the shared source cache and hard-link into a
  // job-scoped pin dir so the cache sweeper (1h TTL / 500MB size cap) can't
  // unlink the file mid-pipeline. Resolution is deferred until AFTER the
  // idempotency/in-flight guards so a skipped run never downloads anything,
  // and callers write an in-flight status before awaiting the download.
  let sourcePinDir: string | null = null;
  const resolvePinnedSource = async (): Promise<string> => {
    if (video.filePath) return video.filePath as string;
    const { getPinnedSourcePath } = await import("../sourceCache");
    sourcePinDir = path.join("/tmp/editorial-source", `pin-${videoId}-${Date.now()}`);
    const p = await getPinnedSourcePath(video as any, sourcePinDir);
    console.log(`[EditorialAuto] Pulled + pinned platform source for video ${videoId}: ${p}`);
    return p;
  };
  const cleanupPin = () => {
    if (sourcePinDir) { try { fs.rmSync(sourcePinDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  };

  // Idempotency: if already ready and we have rendered clips, skip (unless force/resume)
  if (!force && !resume && video.editorialStatus === "ready") {
    const existing = await storage.getEditorialClipsByVideo(videoId);
    const rendered = existing.filter((c) => c.renderStatus === "rendered").length;
    if (rendered >= AUTO_PIPELINE_CONFIG.minClipCount) {
      console.log(`[EditorialAuto] Already ready with ${rendered} rendered clips, skipping`);
      return {
        ...emptyResult,
        success: true,
        status: "skipped",
        clipsGenerated: existing.length,
        clipsRendered: rendered,
        durationMs: Date.now() - start,
      };
    }
  }

  // In-flight check with stale-state recovery: don't double-run UNLESS the in-flight
  // state is stale (DB hasn't been updated in STALE_THRESHOLD_MS) — that means the
  // previous run died (server restart, crash) and left orphaned status. Take it over.
  const isInFlight =
    video.editorialStatus === "transcribing" ||
    video.editorialStatus === "analyzing" ||
    video.editorialStatus === "rendering";

  if (isInFlight && !force && !resume) {
    const lastUpdate = video.updatedAt ? new Date(video.updatedAt).getTime() : 0;
    const ageMs = Date.now() - lastUpdate;
    if (ageMs < STALE_THRESHOLD_MS) {
      console.log(`[EditorialAuto] Already in-flight (status=${video.editorialStatus}, ${Math.round(ageMs / 1000)}s old), skipping`);
      return {
        ...emptyResult,
        success: true,
        status: "skipped",
        durationMs: Date.now() - start,
      };
    }
    console.warn(
      `[EditorialAuto] Stale in-flight state detected (status=${video.editorialStatus}, ${Math.round(ageMs / 60000)} min old) — taking over`
    );
  }

  // ── Resume mode: skip transcript+analysis, render unrendered clips only ──
  if (resume) {
    const existing = await storage.getEditorialClipsByVideo(videoId);
    const unrendered = existing.filter((c) => c.renderStatus !== "rendered");
    if (existing.length === 0) {
      console.warn(`[EditorialAuto] Resume requested but no existing clips found — falling through to full run`);
    } else if (unrendered.length === 0) {
      console.log(`[EditorialAuto] Resume requested but all ${existing.length} clips already rendered — marking ready`);
      await storage.updateVideoEditorialStatus(videoId, "ready", { clipCount: existing.length });
      return {
        ...emptyResult,
        success: true,
        status: "ready",
        clipsGenerated: existing.length,
        clipsRendered: existing.length,
        durationMs: Date.now() - start,
      };
    } else {
      console.log(`[EditorialAuto] Resume mode: rendering ${unrendered.length} of ${existing.length} pending clips`);
      try {
        // In-flight status BEFORE the (possibly minutes-long) import download
        // so concurrent triggers hit the guard instead of double-running.
        await storage.updateVideoEditorialStatus(videoId, "rendering", { error: null });
        const resumeSource = await resolvePinnedSource();
        return await renderClipsOnly(videoId, resumeSource, unrendered, start);
      } catch (resumeErr: any) {
        await storage.updateVideoEditorialStatus(videoId, "failed", { error: `Source download failed: ${resumeErr?.message || resumeErr}` }).catch(() => {});
        return { ...emptyResult, error: `Source download failed: ${resumeErr?.message || resumeErr}`, durationMs: Date.now() - start };
      } finally {
        cleanupPin();
      }
    }
  }

  let videoLocalPath: string | null = null;
  let tempScopeDir: string | null = null;

  try {
    // ── 1. Transcript ────────────────────────────────────────────
    await storage.updateVideoEditorialStatus(videoId, "transcribing", { error: null });

    // Import download happens here — after guards, with in-flight status set.
    const sourceFilePath = await resolvePinnedSource();

    const transcript = await ensureTranscript(videoId, sourceFilePath);
    if (!transcript || !transcript.segments || transcript.segments.length === 0) {
      throw new Error("Transcript not available after pipeline run");
    }
    console.log(`[EditorialAuto] Transcript ready: ${transcript.segments.length} segments, ${transcript.wordCount} words`);

    // ── 2. Editorial Analysis ────────────────────────────────────
    await storage.updateVideoEditorialStatus(videoId, "analyzing");

    const surfaces = await storage.getDetectedSurfaces(videoId);
    const brandProducts = await storage.getAllBrandProducts();
    const brandMatches = await storage.getBrandMatchesByVideo(videoId);

    const surfacesForAnalysis = surfaces.map((s) => ({
      id: s.id,
      timestamp: parseFloat(String(s.timestamp)),
      surfaceType: s.surfaceType,
      confidence: parseFloat(String(s.confidence)),
      boundingBox: {
        x: parseFloat(String(s.boundingBoxX)),
        y: parseFloat(String(s.boundingBoxY)),
        width: parseFloat(String(s.boundingBoxWidth)),
        height: parseFloat(String(s.boundingBoxHeight)),
      },
    }));
    const catalogForAnalysis = brandProducts.map((b) => ({
      id: b.id,
      name: b.name,
      category: b.category,
      dominantColor: b.dominantColor,
    }));
    const surfacesForRanker = surfaces.map((s) => ({
      id: s.id,
      videoId: s.videoId,
      timestamp: parseFloat(String(s.timestamp)),
      surfaceType: s.surfaceType,
      confidence: parseFloat(String(s.confidence)),
    }));
    const matchesForRanker = brandMatches.map((bm) => ({
      id: bm.id,
      sceneAnalysisId: bm.sceneAnalysisId,
      brandProductId: bm.brandProductId,
      compatibilityScore: bm.compatibilityScore ?? 0,
      reasoning: bm.reasoning ?? "",
      suggestedPlacementStyle: bm.suggestedPlacementStyle ?? undefined,
    }));

    const editorialMoments = await analyzeEditorial({
      videoId,
      transcript: transcript.segments as any,
      surfaces: surfacesForAnalysis,
      brandCatalog: catalogForAnalysis,
      maxClips: targetClipCount,
    });

    if (editorialMoments.length === 0) {
      throw new Error("Editorial analyzer returned no moments");
    }
    console.log(`[EditorialAuto] Found ${editorialMoments.length} editorial moments`);

    // Rank + dedupe
    let rankedClips = deduplicateClips(
      rankClips(editorialMoments, surfacesForRanker, matchesForRanker, transcript.segments as any, targetClipCount)
    );

    if (rankedClips.length === 0) {
      throw new Error("No clips passed the minimum score threshold");
    }

    // ── ≥10 enforcement: one retry round for thin batches ────────
    // Score filtering + overlap dedupe can shrink the batch well below the
    // promised floor. Ask the analyzer once more for DIFFERENT moments
    // (excluding covered ranges), merge, and re-rank. One round only —
    // a transcript that can't yield 10 distinct stories shouldn't loop.
    const CLIP_FLOOR = Math.min(10, targetClipCount);
    if (rankedClips.length < CLIP_FLOOR) {
      // Cover PLAYED ranges only — an assembled clip's envelope would
      // blacklist the whole span including gaps full of unused material.
      const covered = rankedClips.flatMap((c) =>
        c.segments && c.segments.length > 0
          ? c.segments.map((s) => ({ start: s.start, end: s.end }))
          : [{ start: c.clipStart, end: c.clipEnd }]
      );
      console.log(`[EditorialAuto] Only ${rankedClips.length}/${CLIP_FLOOR} clips after dedupe — retrying for more (excluding covered ranges)`);
      try {
        const extraMoments = await analyzeEditorial({
          videoId,
          transcript: transcript.segments as any,
          surfaces: surfacesForAnalysis,
          brandCatalog: catalogForAnalysis,
          maxClips: CLIP_FLOOR - rankedClips.length + 2,
          excludeRanges: covered,
        });
        if (extraMoments.length > 0) {
          const extraRanked = rankClips(extraMoments, surfacesForRanker, matchesForRanker, transcript.segments as any, targetClipCount);
          // Existing clips first so dedupe keeps them on overlap
          rankedClips = deduplicateClips([...rankedClips, ...extraRanked])
            .sort((a, b) => b.finalScore - a.finalScore)
            .slice(0, targetClipCount);
          console.log(`[EditorialAuto] Retry round added ${rankedClips.length - covered.length} clip(s) → ${rankedClips.length} total`);
        }
      } catch (retryErr: any) {
        console.warn(`[EditorialAuto] Retry round failed (non-fatal): ${retryErr?.message || retryErr}`);
      }
    }

    console.log(`[EditorialAuto] Ranked ${rankedClips.length} final clips`);

    // Persist clip metadata (this replaces any existing clips for this video)
    const savedClips = await storage.saveEditorialClips(videoId, userId, rankedClips);
    console.log(`[EditorialAuto] Saved ${savedClips.length} clip records`);

    // ── 3. Render each clip ──────────────────────────────────────
    await storage.updateVideoEditorialStatus(videoId, "rendering", {
      clipCount: savedClips.length,
    });

    // Resolve source video to local path once (reused for all clips)
    const resolved = await resolveSourceVideo(sourceFilePath, videoId);
    videoLocalPath = resolved.localPath;
    tempScopeDir = resolved.tempScopeDir;

    if (!fs.existsSync(videoLocalPath)) {
      throw new Error(`Source video not found locally: ${videoLocalPath}`);
    }

    const platformConfig = PLATFORM_CONFIGS[AUTO_PIPELINE_CONFIG.platformKey];
    const renderOutputDir = path.join("/tmp/editorial-renders", `video-${videoId}-${Date.now()}`);
    fs.mkdirSync(renderOutputDir, { recursive: true });

    // Get source video dimensions for smart reframe
    let srcSize = { width: 1920, height: 1080 };
    try {
      srcSize = await getVideoSize(videoLocalPath);
      console.log(`[EditorialAuto] Source video: ${srcSize.width}x${srcSize.height}`);
    } catch {
      console.warn(`[EditorialAuto] Could not determine video size, assuming 1920x1080`);
    }

    // Determine if smart reframe is needed (landscape source → portrait output)
    const needsReframe = srcSize.width > srcSize.height && platformConfig.aspectRatio === "9:16";

    let renderedCount = 0;
    const renderErrors: string[] = [];

    for (const clip of savedClips) {
      // ── Cancellation check: bail if user cancelled ──
      const freshVideo = await storage.getVideoById(videoId);
      if (freshVideo?.editorialStatus === "failed" && freshVideo?.editorialError === "Cancelled by user") {
        console.log(`[EditorialAuto] Cancelled by user — stopping render loop`);
        break;
      }

      try {
        await storage.updateEditorialClipRender(clip.id, { renderStatus: "rendering" });

        const outputFilename = `editorial_${clip.id}_v${videoId}_${Date.now()}.mp4`;
        const outputPath = path.join(renderOutputDir, outputFilename);
        const thumbPath = outputPath.replace(".mp4", "_thumb.jpg");

        // Assembled multi-beat narrative or single range — both go through
        // the shared quality path (face tracking + transcript captions).
        await renderEditorialClipOutput(clip, outputPath, {
          videoLocalPath,
          platformConfig,
          srcSize,
          needsReframe,
          speakerSegments: transcript.segments as any[],
          logTag: "EditorialAuto",
        });

        if (!fs.existsSync(outputPath)) {
          throw new Error("FFmpeg produced no output file");
        }

        // Generate thumbnail at 25% into the clip
        try {
          await runFFmpegThumbnail(outputPath, thumbPath, clip.duration * 0.25);
        } catch { /* non-fatal */ }

        // Upload rendered MP4 to Object Storage
        const mp4ObjectKey = `public/editorial-clips/video-${videoId}/${outputFilename}`;
        const mp4Url = await uploadFileToStorage(outputPath, mp4ObjectKey);

        // Upload thumbnail if available
        let thumbUrl: string | null = null;
        if (fs.existsSync(thumbPath)) {
          const thumbFilename = path.basename(thumbPath);
          const thumbObjectKey = `public/editorial-clips/video-${videoId}/${thumbFilename}`;
          thumbUrl = await uploadFileToStorage(thumbPath, thumbObjectKey);
        }

        // Clean up local files
        try { fs.unlinkSync(outputPath); } catch {}
        try { fs.unlinkSync(thumbPath); } catch {}

        await storage.updateEditorialClipRender(clip.id, {
          exportPath: mp4Url,
          thumbnailPath: thumbUrl,
          aspectRatio: platformConfig.aspectRatio,
          renderStatus: "rendered",
          renderError: null,
        });

        renderedCount += 1;
        console.log(
          `[EditorialAuto]   ✓ Rendered clip ${clip.id} (${clip.duration.toFixed(1)}s${needsReframe ? ", smart reframe" : ""}) → ${mp4Url}`
        );
      } catch (err: any) {
        const msg = err?.message || String(err);
        renderErrors.push(`clip ${clip.id}: ${msg}`);
        await storage.updateEditorialClipRender(clip.id, {
          renderStatus: "failed",
          renderError: msg,
        });
        console.error(`[EditorialAuto]   ✗ Render failed for clip ${clip.id}:`, msg);
      }
    }

    // Cleanup render output dir
    try {
      fs.rmSync(renderOutputDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }

    // ── 4. Final status ──────────────────────────────────────────
    if (renderedCount === 0) {
      throw new Error(`All ${savedClips.length} clip renders failed`);
    }

    // A partial batch is still usable, so we ship it as "ready" rather than
    // discarding good clips — but we no longer silently claim a healthy batch.
    // When the count is below the minimum, record why so the state is honest and
    // measurable (true enforcement/retry to reach the target is a follow-up).
    const belowTarget = renderedCount < AUTO_PIPELINE_CONFIG.minClipCount;
    const notes: string[] = [];
    if (belowTarget) {
      notes.push(`Only ${renderedCount}/${AUTO_PIPELINE_CONFIG.minClipCount} target clips rendered`);
      console.warn(
        `[EditorialAuto] ⚠️  Video ${videoId} below target batch: ` +
          `${renderedCount}/${AUTO_PIPELINE_CONFIG.minClipCount} clips`
      );
    }
    if (renderErrors.length > 0) notes.push(`${renderErrors.length} render failures`);
    await storage.updateVideoEditorialStatus(videoId, "ready", {
      clipCount: renderedCount,
      error: notes.length > 0 ? notes.join("; ") : null,
    });

    // In-app heads-up for the creator (best-effort; video.userId is the
    // creator's identity key — the int userId param is display-only).
    storage.createNotification({
      userId: String(video.userId),
      type: "editorial_ready",
      title: "Your clips are ready",
      body: `${renderedCount} editorial clip${renderedCount === 1 ? "" : "s"} rendered for "${(video.title || "your video").slice(0, 80)}".`,
      linkPath: "/library",
      metadata: { videoId, clipCount: renderedCount },
    });

    const durationMs = Date.now() - start;
    console.log(
      `[EditorialAuto] ✅ Complete for video ${videoId}: ` +
        `${renderedCount}/${savedClips.length} rendered in ${(durationMs / 1000).toFixed(1)}s`
    );

    return {
      success: true,
      videoId,
      status: "ready",
      clipsGenerated: savedClips.length,
      clipsRendered: renderedCount,
      durationMs,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[EditorialAuto] ❌ Failed for video ${videoId}:`, msg);
    await storage.updateVideoEditorialStatus(videoId, "failed", { error: msg });

    return {
      ...emptyResult,
      error: msg,
      durationMs: Date.now() - start,
    };
  } finally {
    // Clean up downloaded source video
    cleanupPin();
    if (videoLocalPath && tempScopeDir) {
      try {
        fs.rmSync(tempScopeDir, { recursive: true, force: true });
      } catch { /* non-fatal */ }
    }
  }
}

// ── Resume / Recovery Helper ───────────────────────────────────────

/**
 * Render a specific subset of already-saved editorial clips. Used by resume
 * mode to recover stuck pipelines without re-running transcript or analysis.
 * Preserves any clips that are already in renderStatus="rendered".
 *
 * Caller must have verified the clips exist in DB and at least one is unrendered.
 */
async function renderClipsOnly(
  videoId: number,
  filePath: string,
  clipsToRender: Array<Awaited<ReturnType<typeof storage.getEditorialClipsByVideo>>[number]>,
  start: number
): Promise<EditorialAutoPipelineResult> {
  const emptyResult: EditorialAutoPipelineResult = {
    success: false,
    videoId,
    status: "failed",
    clipsGenerated: 0,
    clipsRendered: 0,
    durationMs: 0,
  };

  let videoLocalPath: string | null = null;
  let tempScopeDir: string | null = null;

  try {
    // Status → rendering. Touches updatedAt so stale-detection won't trigger.
    await storage.updateVideoEditorialStatus(videoId, "rendering", { error: null });

    // Need transcript for speaker-aware face tracking
    const transcriptRecord = await storage.getVideoTranscript(videoId);
    const speakerSegments = (transcriptRecord?.segments as any[]) || [];

    // Resolve source video to local path
    const resolved = await resolveSourceVideo(filePath, videoId);
    videoLocalPath = resolved.localPath;
    tempScopeDir = resolved.tempScopeDir;

    if (!fs.existsSync(videoLocalPath)) {
      throw new Error(`Source video not found locally: ${videoLocalPath}`);
    }

    const platformConfig = PLATFORM_CONFIGS[AUTO_PIPELINE_CONFIG.platformKey];
    const renderOutputDir = path.join("/tmp/editorial-renders", `video-${videoId}-resume-${Date.now()}`);
    fs.mkdirSync(renderOutputDir, { recursive: true });

    let srcSize = { width: 1920, height: 1080 };
    try {
      srcSize = await getVideoSize(videoLocalPath);
    } catch { /* keep default */ }

    const needsReframe = srcSize.width > srcSize.height && platformConfig.aspectRatio === "9:16";
    const allClips = await storage.getEditorialClipsByVideo(videoId);
    const alreadyRendered = allClips.filter((c) => c.renderStatus === "rendered").length;

    let renderedCount = alreadyRendered;
    const renderErrors: string[] = [];

    for (const clip of clipsToRender) {
      // Cancellation check
      const freshVideo = await storage.getVideoById(videoId);
      if (freshVideo?.editorialStatus === "failed" && freshVideo?.editorialError === "Cancelled by user") {
        console.log(`[EditorialAuto:Resume] Cancelled by user — stopping`);
        break;
      }

      try {
        await storage.updateEditorialClipRender(clip.id, { renderStatus: "rendering" });

        const outputFilename = `editorial_${clip.id}_v${videoId}_${Date.now()}.mp4`;
        const outputPath = path.join(renderOutputDir, outputFilename);
        const thumbPath = outputPath.replace(".mp4", "_thumb.jpg");

        await renderEditorialClipOutput(clip, outputPath, {
          videoLocalPath,
          platformConfig,
          srcSize,
          needsReframe,
          speakerSegments,
          logTag: "EditorialAuto:Resume",
        });

        if (!fs.existsSync(outputPath)) throw new Error("FFmpeg produced no output file");

        try {
          await runFFmpegThumbnail(outputPath, thumbPath, clip.duration * 0.25);
        } catch { /* non-fatal */ }

        const mp4ObjectKey = `public/editorial-clips/video-${videoId}/${outputFilename}`;
        const mp4Url = await uploadFileToStorage(outputPath, mp4ObjectKey);

        let thumbUrl: string | null = null;
        if (fs.existsSync(thumbPath)) {
          const thumbObjectKey = `public/editorial-clips/video-${videoId}/${path.basename(thumbPath)}`;
          thumbUrl = await uploadFileToStorage(thumbPath, thumbObjectKey);
        }

        try { fs.unlinkSync(outputPath); } catch {}
        try { fs.unlinkSync(thumbPath); } catch {}

        await storage.updateEditorialClipRender(clip.id, {
          exportPath: mp4Url,
          thumbnailPath: thumbUrl,
          aspectRatio: platformConfig.aspectRatio,
          renderStatus: "rendered",
          renderError: null,
        });

        renderedCount += 1;
        console.log(`[EditorialAuto:Resume]   ✓ Rendered clip ${clip.id} → ${mp4Url}`);
      } catch (err: any) {
        const msg = err?.message || String(err);
        renderErrors.push(`clip ${clip.id}: ${msg}`);
        await storage.updateEditorialClipRender(clip.id, { renderStatus: "failed", renderError: msg });
        console.error(`[EditorialAuto:Resume]   ✗ Render failed for clip ${clip.id}:`, msg);
      }
    }

    try { fs.rmSync(renderOutputDir, { recursive: true, force: true }); } catch {}

    await storage.updateVideoEditorialStatus(videoId, "ready", {
      clipCount: renderedCount,
      error: renderErrors.length > 0 ? `${renderErrors.length} render failures (resume)` : null,
    });

    const durationMs = Date.now() - start;
    console.log(
      `[EditorialAuto:Resume] ✅ Complete for video ${videoId}: ${renderedCount}/${allClips.length} rendered in ${(durationMs / 1000).toFixed(1)}s`
    );

    return {
      success: true,
      videoId,
      status: "ready",
      clipsGenerated: allClips.length,
      clipsRendered: renderedCount,
      durationMs,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[EditorialAuto:Resume] ❌ Failed for video ${videoId}:`, msg);
    await storage.updateVideoEditorialStatus(videoId, "failed", { error: msg });
    return { ...emptyResult, error: msg, durationMs: Date.now() - start };
  } finally {
    if (videoLocalPath && tempScopeDir) {
      try { fs.rmSync(tempScopeDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Ensure transcript exists for the video. Creates + runs pipeline if missing.
 * Returns the completed transcript or null on failure.
 */
async function ensureTranscript(videoId: number, filePath: string): Promise<{ segments: any[]; wordCount: number } | null> {
  let existing = await storage.getVideoTranscript(videoId);

  // If completed, return as-is
  if (existing && existing.status === "completed" && existing.segments) {
    return { segments: existing.segments as any[], wordCount: existing.wordCount ?? 0 };
  }

  // If processing and fresh, wait briefly then re-check (avoid racing with manual trigger)
  if (existing && existing.status === "processing") {
    const createdAt = existing.createdAt ? new Date(existing.createdAt).getTime() : 0;
    const age = Date.now() - createdAt;
    if (age < AUTO_PIPELINE_CONFIG.transcriptStaleAfterMs) {
      console.log(`[EditorialAuto] Transcript already processing (${(age / 1000).toFixed(0)}s old), waiting...`);
      // Poll up to 3 minutes
      for (let i = 0; i < 36; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        existing = await storage.getVideoTranscript(videoId);
        if (existing?.status === "completed" && existing.segments) {
          return { segments: existing.segments as any[], wordCount: existing.wordCount ?? 0 };
        }
        if (existing?.status === "failed") {
          console.warn(`[EditorialAuto] Waiting transcript failed, will retry`);
          break;
        }
      }
    }
  }

  // Create or reset transcript record
  let transcriptId: number;
  if (existing) {
    await storage.updateVideoTranscriptStatus(existing.id, "processing");
    transcriptId = existing.id;
  } else {
    const created = await storage.createVideoTranscript({
      videoId,
      provider: "auto",
      language: "en",
      status: "processing",
    });
    transcriptId = created.id;
  }

  // Run pipeline
  const result = await runTranscriptPipeline({
    videoId,
    filePath,
    language: "en",
  });

  if (!result.success) {
    await storage.updateVideoTranscriptStatus(transcriptId, "failed", result.error || "Unknown transcript error");
    return null;
  }

  await storage.updateVideoTranscript(transcriptId, {
    provider: result.provider,
    fullText: result.fullText,
    segments: result.segments,
    speakerMap: result.speakerMap,
    audioDuration: result.audioDuration,
    wordCount: result.wordCount,
    segmentCount: result.segmentCount,
    status: "completed",
    processingTimeMs: result.totalProcessingTimeMs,
  });

  return { segments: result.segments as any[], wordCount: result.wordCount };
}

/**
 * Resolve a source video filePath to a local file for FFmpeg.
 * Handles Object Storage URLs + local paths.
 */
async function resolveSourceVideo(
  filePath: string,
  videoId: number
): Promise<{ localPath: string; tempScopeDir: string | null }> {
  if (filePath.startsWith("/storage/")) {
    const objectKey = objectKeyFromServeUrl(filePath);
    const tempScopeDir = path.join("/tmp/editorial-source", `video-${videoId}-${Date.now()}`);
    const localPath = await downloadToTempFile(objectKey, tempScopeDir);
    return { localPath, tempScopeDir };
  }
  // Direct local path (dev / legacy)
  return { localPath: filePath, tempScopeDir: null };
}

// ── Assembled-narrative rendering ─────────────────────────────────
//
// A clip may carry `segments` — 2-4 non-contiguous beats in NARRATIVE order
// (hook → body → payoff) chosen by the editorial analyzer. Each beat renders
// through the full quality path (face-tracked reframe + transcript captions
// with beat-local timing), then the parts are losslessly concatenated. This
// is what makes clips assembled stories instead of time-range splices.

interface EditorialRenderCtx {
  videoLocalPath: string;
  platformConfig: { targetWidth: number; targetHeight: number; targetFps: number; aspectRatio: string };
  srcSize: { width: number; height: number };
  needsReframe: boolean;
  speakerSegments: any[] | undefined;
  brandOverlays?: BrandOverlay[];
  logTag: string;
}

async function renderEditorialRange(
  rangeStart: number,
  rangeEnd: number,
  outputPath: string,
  ctx: EditorialRenderCtx,
): Promise<void> {
  const duration = rangeEnd - rangeStart;
  const captionFilter = buildEditorialCaptionFilter(
    ctx.speakerSegments,
    rangeStart,
    duration,
    ctx.platformConfig as any,
  );

  if (ctx.needsReframe) {
    console.log(`[${ctx.logTag}]   Face tracking ${rangeStart.toFixed(1)}–${rangeEnd.toFixed(1)}s...`);
    const faceFrames = await Promise.race([
      detectFacesInClip(ctx.videoLocalPath, rangeStart, duration, 0.5, 90000),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Face detection timeout")), 150000)
      ),
    ]).catch(() => {
      console.warn(`[${ctx.logTag}]   Face detection timed out — using center crop`);
      return [] as Awaited<ReturnType<typeof detectFacesInClip>>;
    });

    const trajectory = computeCropTrajectory(
      faceFrames,
      ctx.srcSize.width,
      ctx.srcSize.height,
      ctx.platformConfig.targetWidth,
      ctx.platformConfig.targetHeight,
      { speakerSegments: ctx.speakerSegments as any, clipStartTime: rangeStart }
    );

    const vf = `${buildCropFilterExpr(trajectory)},scale=${ctx.platformConfig.targetWidth}:${ctx.platformConfig.targetHeight}`;
    await runFFmpegRender({
      videoPath: ctx.videoLocalPath,
      startTime: rangeStart,
      duration,
      vf,
      fps: ctx.platformConfig.targetFps,
      outputPath,
      srcWidth: ctx.srcSize.width,
      srcHeight: ctx.srcSize.height,
      brandOverlays: ctx.brandOverlays,
      captionFilter,
    });
  } else {
    const vf = `scale=${ctx.platformConfig.targetWidth}:${ctx.platformConfig.targetHeight}:force_original_aspect_ratio=decrease,pad=${ctx.platformConfig.targetWidth}:${ctx.platformConfig.targetHeight}:(ow-iw)/2:(oh-ih)/2:black`;
    await runFFmpegRender({
      videoPath: ctx.videoLocalPath,
      startTime: rangeStart,
      duration,
      vf,
      fps: ctx.platformConfig.targetFps,
      outputPath,
      srcWidth: ctx.srcSize.width,
      srcHeight: ctx.srcSize.height,
      brandOverlays: ctx.brandOverlays,
      captionFilter,
    });
  }
}

/** Lossless concat of same-codec parts (all rendered with identical settings). */
async function concatMp4Parts(partPaths: string[], outputPath: string): Promise<void> {
  const listPath = `${outputPath}.concat.txt`;
  fs.writeFileSync(listPath, partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", listPath,
        "-c", "copy", outputPath,
      ]);
      let stderr = "";
      proc.stderr?.on("data", (d) => { stderr += String(d); });
      const killer = setTimeout(() => proc.kill("SIGKILL"), 120000);
      proc.on("close", (code) => {
        clearTimeout(killer);
        if (code === 0) resolve();
        else reject(new Error(`concat failed (${code}): ${stderr.slice(0, 300)}`));
      });
      proc.on("error", reject);
    });
  } finally {
    try { fs.unlinkSync(listPath); } catch { /* ignore */ }
  }
}

function validClipSegments(clip: any): Array<{ start: number; end: number; role?: string }> | null {
  const segs = clip?.segments;
  if (!Array.isArray(segs) || segs.length < 2) return null;
  const ok = segs.every((s: any) => typeof s?.start === "number" && typeof s?.end === "number" && s.end > s.start);
  return ok ? segs : null;
}

/** Render a clip — assembled multi-beat when it carries segments, single range otherwise. */
export async function renderEditorialClipOutput(clip: any, outputPath: string, ctx: EditorialRenderCtx): Promise<void> {
  const segs = validClipSegments(clip);

  if (!segs) {
    await renderEditorialRange(clip.clipStart, clip.clipStart + clip.duration, outputPath, ctx);
    return;
  }

  console.log(`[${ctx.logTag}]   Assembling ${segs.length}-beat narrative (${segs.map((s) => s.role || "beat").join(" → ")})`);
  const parts: string[] = [];
  try {
    for (let i = 0; i < segs.length; i++) {
      const partPath = outputPath.replace(/\.mp4$/, `_part${i}.mp4`);
      await renderEditorialRange(segs[i].start, segs[i].end, partPath, ctx);
      if (!fs.existsSync(partPath)) throw new Error(`Beat ${i + 1}/${segs.length} produced no output`);
      parts.push(partPath);
    }
    await concatMp4Parts(parts, outputPath);
  } finally {
    for (const p of parts) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  }
}

// ── Single Clip Render (for search results / manual adds) ─────────

/**
 * Render a single editorialClips row that's already in the DB.
 * Reuses the same face-tracking smart-reframe path as the auto-pipeline.
 */
export async function renderSingleEditorialClip(videoId: number, clipId: number): Promise<void> {
  const video = await storage.getVideoById(videoId);
  if (!video || (!video.filePath && !video.youtubeId)) throw new Error("Video not found or has no source");

  // Light-cloud imports: pull + pin the source (hard link survives the
  // cache sweeper) — cleaned up in this function's cleanup below.
  let singleSourcePath: string = video.filePath as string;
  let singlePinDir: string | null = null;
  if (!singleSourcePath) {
    const { getPinnedSourcePath } = await import("../sourceCache");
    singlePinDir = path.join("/tmp/editorial-source", `pin-single-${clipId}-${Date.now()}`);
    singleSourcePath = await getPinnedSourcePath(video as any, singlePinDir);
  }

  const existing = await storage.getEditorialClipsByVideo(videoId);
  const clip = existing.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);

  await storage.updateEditorialClipRender(clip.id, { renderStatus: "rendering" });

  let videoLocalPath: string | null = null;
  let tempScopeDir: string | null = null;
  const renderOutputDir = path.join("/tmp/editorial-renders", `single-${clipId}-${Date.now()}`);
  fs.mkdirSync(renderOutputDir, { recursive: true });

  try {
    const resolved = await resolveSourceVideo(singleSourcePath, videoId);
    videoLocalPath = resolved.localPath;
    tempScopeDir = resolved.tempScopeDir;

    const srcSize = await getVideoSize(videoLocalPath).catch(() => ({ width: 1920, height: 1080 }));
    const platformConfig = PLATFORM_CONFIGS[AUTO_PIPELINE_CONFIG.platformKey];
    const needsReframe = srcSize.width > srcSize.height && platformConfig.aspectRatio === "9:16";

    const outputFilename = `editorial_${clip.id}_v${videoId}_${Date.now()}.mp4`;
    const outputPath = path.join(renderOutputDir, outputFilename);
    const thumbPath = outputPath.replace(".mp4", "_thumb.jpg");

    // ── Brand placement overlays ───────────────────────────────────────
    // Fetch any approved placements scoped to this clip (or to the video if
    // legacy assignments). Build BrandOverlay objects with locally-downloaded
    // product images.
    const brandOverlays = await loadBrandOverlaysForClip(clip.id, videoId, renderOutputDir);
    if (brandOverlays.length > 0) {
      console.log(`[RenderSingle] Compositing ${brandOverlays.length} brand placement(s) onto clip ${clip.id}`);
    }

    // Transcript serves both speaker-aware crop tracking and caption burn-in,
    // so fetch it before the branch (previously only the reframe branch had it).
    const transcriptRecord = await storage.getVideoTranscript(videoId);
    const speakerSegments = transcriptRecord?.segments as any[] | undefined;
    await renderEditorialClipOutput(clip, outputPath, {
      videoLocalPath,
      platformConfig,
      srcSize,
      needsReframe,
      speakerSegments,
      brandOverlays,
      logTag: "EditorialAuto:Single",
    });

    if (!fs.existsSync(outputPath)) throw new Error("FFmpeg produced no output");

    try { await runFFmpegThumbnail(outputPath, thumbPath, clip.duration * 0.25); } catch {}

    const mp4ObjectKey = `public/editorial-clips/video-${videoId}/${outputFilename}`;
    const mp4Url = await uploadFileToStorage(outputPath, mp4ObjectKey);

    let thumbUrl: string | null = null;
    if (fs.existsSync(thumbPath)) {
      const thumbFilename = path.basename(thumbPath);
      const thumbObjectKey = `public/editorial-clips/video-${videoId}/${thumbFilename}`;
      thumbUrl = await uploadFileToStorage(thumbPath, thumbObjectKey);
    }

    try { fs.unlinkSync(outputPath); } catch {}
    try { fs.unlinkSync(thumbPath); } catch {}

    await storage.updateEditorialClipRender(clip.id, {
      exportPath: mp4Url,
      thumbnailPath: thumbUrl,
      aspectRatio: platformConfig.aspectRatio,
      renderStatus: "rendered",
      renderError: null,
    });

    console.log(`[RenderSingle] ✓ Rendered clip ${clip.id} → ${mp4Url}`);
  } finally {
    if (singlePinDir) { try { fs.rmSync(singlePinDir, { recursive: true, force: true }); } catch {} }
    try { fs.rmSync(renderOutputDir, { recursive: true, force: true }); } catch {}
    if (tempScopeDir) {
      try { fs.rmSync(tempScopeDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// ── Brand Placement Overlay Helpers ────────────────────────────────

/**
 * Fetch approved brand placements for a clip and convert each into a BrandOverlay
 * (with the product image downloaded locally so FFmpeg can read it).
 *
 * Considers placements that are:
 *   - Targeted at this specific clipId (preferred — new flow), OR
 *   - Targeted at the parent video AND the surface's timestamp falls within
 *     the clip's [clipStart, clipEnd] range (legacy fallback)
 *
 * Skips and logs any placement whose image can't be fetched — render proceeds
 * without it rather than failing the whole render.
 */
async function loadBrandOverlaysForClip(
  clipId: number,
  videoId: number,
  tmpDir: string,
): Promise<BrandOverlay[]> {
  try {
    const clip = await storage.getEditorialClipById(clipId);
    if (!clip) return [];

    // All approved placements on this video
    const allApproved = await storage.getApprovedPlacementsForVideo(videoId);
    if (allApproved.length === 0) return [];

    // Surfaces visible in this clip's time range
    const clipSurfaces = await storage.getSurfacesInEditorialClip(clipId);
    const clipSurfaceIds = new Set(clipSurfaces.map((s) => s.id));

    // Filter placements: clip-targeted OR video-targeted with surface inside clip
    const relevant = allApproved.filter((p) => {
      if (p.editorialClipId === clipId) return true;
      if (!p.editorialClipId && clipSurfaceIds.has(p.surfaceId)) return true;
      return false;
    });

    if (relevant.length === 0) return [];

    const overlays: BrandOverlay[] = [];
    for (const placement of relevant) {
      try {
        // Delegated-choice placements get their product at creator approval;
        // a null here means pre-approval — nothing to composite yet.
        if (placement.brandProductId == null) continue;
        const product = await storage.getBrandProduct(placement.brandProductId);
        if (!product || !product.imageUrl) {
          console.warn(`[BrandOverlay] Placement ${placement.id} has no product image — skipping`);
          continue;
        }
        const surface = clipSurfaces.find((s) => s.id === placement.surfaceId);
        if (!surface) {
          console.warn(`[BrandOverlay] Placement ${placement.id} surface ${placement.surfaceId} not in clip — skipping`);
          continue;
        }

        const localImagePath = await downloadBrandProductImage(product.imageUrl, tmpDir, product.id);
        if (!localImagePath) {
          console.warn(`[BrandOverlay] Could not download product image for placement ${placement.id}`);
          continue;
        }

        overlays.push({
          imagePath: localImagePath,
          bboxX: parseFloat(surface.boundingBoxX),
          bboxY: parseFloat(surface.boundingBoxY),
          bboxWidth: parseFloat(surface.boundingBoxWidth),
          bboxHeight: parseFloat(surface.boundingBoxHeight),
        });
      } catch (err: any) {
        console.warn(`[BrandOverlay] Skipping placement ${placement.id}: ${err.message}`);
      }
    }
    return overlays;
  } catch (err: any) {
    console.error(`[BrandOverlay] Failed to load overlays for clip ${clipId}:`, err.message);
    return [];
  }
}

/**
 * Resolve a brand product imageUrl to a local file path. Handles:
 *   - Object Storage URLs (/storage/...) → download to tmp
 *   - Local upload paths (/uploads/...) → resolve to ./public path
 *   - Full HTTP URLs → fetch to tmp
 */
async function downloadBrandProductImage(
  imageUrl: string,
  tmpDir: string,
  productId: number,
): Promise<string | null> {
  // Object Storage path
  if (imageUrl.startsWith("/storage/")) {
    try {
      const objectKey = objectKeyFromServeUrl(imageUrl);
      return await downloadToTempFile(objectKey, tmpDir);
    } catch (err: any) {
      console.warn(`[BrandOverlay] Object Storage download failed: ${err.message}`);
      return null;
    }
  }
  // Local upload path
  if (imageUrl.startsWith("/uploads/") || imageUrl.startsWith("uploads/")) {
    const cleanPath = imageUrl.startsWith("/") ? imageUrl.slice(1) : imageUrl;
    const localCandidate = path.join("public", cleanPath);
    if (fs.existsSync(localCandidate)) return localCandidate;
    const altCandidate = path.join(".", cleanPath);
    if (fs.existsSync(altCandidate)) return altCandidate;
    console.warn(`[BrandOverlay] Local file not found: ${imageUrl}`);
    return null;
  }
  // Full URL — fetch
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    try {
      const res = await fetch(imageUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = imageUrl.split(".").pop()?.split("?")[0] || "png";
      const localPath = path.join(tmpDir, `brand_product_${productId}.${ext}`);
      fs.writeFileSync(localPath, buf);
      return localPath;
    } catch (err: any) {
      console.warn(`[BrandOverlay] HTTP fetch failed for ${imageUrl}: ${err.message}`);
      return null;
    }
  }
  console.warn(`[BrandOverlay] Unrecognized image URL format: ${imageUrl}`);
  return null;
}

// ── FFmpeg Render Helpers ──────────────────────────────────────────

interface BrandOverlay {
  imagePath: string;       // Local path to brand product PNG
  bboxX: number;           // 0-1 normalized to source video
  bboxY: number;
  bboxWidth: number;
  bboxHeight: number;
  /** Padding inside the bbox as a fraction (default 0.10 = 10% inset) */
  padding?: number;
}

interface RenderOptions {
  videoPath: string;
  startTime: number;
  duration: number;
  /** Video filter chain (crop+scale, etc.) — applied AFTER overlays when overlays present */
  vf: string;
  fps: number;
  outputPath: string;
  /** Source video dimensions — required when brandOverlays is set (pixel math) */
  srcWidth?: number;
  srcHeight?: number;
  /** Brand product overlays composited onto the source video before vf is applied */
  brandOverlays?: BrandOverlay[];
  /** Pre-built caption drawtext filter — appended after the vf chain */
  captionFilter?: string | null;
}

/**
 * Build the burned-in caption filter for an editorial clip from the video's
 * persisted transcript. Uses ONLY the deterministic word-timing path (never a
 * Claude call — this runs inside the render loop). Returns null when the clip
 * range has no transcript content; render proceeds uncaptioned.
 */
function buildEditorialCaptionFilter(
  transcriptSegments: any[] | null | undefined,
  clipStart: number,
  clipDuration: number,
  platformConfig: { aspectRatio: string; targetHeight: number },
): string | null {
  try {
    if (!transcriptSegments || transcriptSegments.length === 0) return null;
    const result = generateTranscriptCaptions({
      clipStart,
      clipEnd: clipStart + clipDuration,
      duration: clipDuration,
      narrativeContext: "",
      emotionalTone: "",
      brandNames: [],
      style: "highlight",
      transcriptSegments: transcriptSegments as any,
    });
    if (result.segments.length === 0) return null;
    console.log(`[EditorialAuto]   Captions: ${result.segments.length} segment(s) will be burned in`);
    return buildCaptionFilter(result.segments, platformConfig);
  } catch (err: any) {
    console.warn(`[EditorialAuto]   Caption build failed (non-fatal): ${err?.message || err}`);
    return null;
  }
}

const RENDER_CONFIG = {
  CRF: 20,
  PRESET: "medium",
  AUDIO_BITRATE: "128k",
  TIMEOUT_MS: 900000, // 15 minutes per clip (long videos on CPU-only VMs need time)
};

/**
 * Render a single clip segment with the given video filters.
 * Used for both smart-reframe (crop+scale) and simple scale+pad paths.
 *
 * If brandOverlays is provided, builds a filter_complex graph that:
 *   1. Scales each overlay PNG to fit its surface bbox (with padding)
 *   2. Composites each overlay onto the source video at its bbox position
 *   3. Then applies the standard vf filter (crop+scale or scale+pad)
 *
 * Without overlays, uses the simple -vf path (lower overhead).
 */
function runFFmpegRender(opts: RenderOptions): Promise<void> {
  // Gated by the global render queue so editorial batch renders can't stack
  // unbounded ffmpeg encodes on top of user-initiated remix renders.
  return withRenderSlot(
    `editorialRender(${opts.outputPath.split("/").pop()})`,
    () => runFFmpegRenderUngated(opts),
  );
}

async function runFFmpegRenderUngated(opts: RenderOptions): Promise<void> {
  const { videoPath, startTime, duration, fps, outputPath, brandOverlays, srcWidth, srcHeight, captionFilter } = opts;
  // Captions burn in after the crop/scale chain so coordinates are in target
  // pixels; drawtext is a linear filter, so appending works in both the plain
  // -vf path and inside the filter_complex chain segment.
  const vf = captionFilter ? `${opts.vf},${captionFilter}` : opts.vf;

  const hasOverlays = brandOverlays && brandOverlays.length > 0;

  const inputArgs: string[] = ["-nostdin", "-y", "-ss", startTime.toString(), "-i", videoPath];
  let videoFilterArgs: string[];

  if (hasOverlays && srcWidth && srcHeight) {
    // Add each overlay PNG as an additional input
    for (const ov of brandOverlays!) {
      inputArgs.push("-i", ov.imagePath);
    }

    // Build filter_complex graph
    const padding = 0.10;
    const filterParts: string[] = [];
    let lastLabel = "[0:v]";

    brandOverlays!.forEach((ov, idx) => {
      const inputIdx = idx + 1; // 0 is main video
      const pad = ov.padding ?? padding;

      // Pixel dimensions for the overlay area, with padding inset
      const bboxPxW = Math.max(20, Math.round(ov.bboxWidth * srcWidth * (1 - 2 * pad)));
      const bboxPxH = Math.max(20, Math.round(ov.bboxHeight * srcHeight * (1 - 2 * pad)));
      const bboxPxX = Math.round((ov.bboxX + pad * ov.bboxWidth) * srcWidth);
      const bboxPxY = Math.round((ov.bboxY + pad * ov.bboxHeight) * srcHeight);

      const scaledLabel = `[ov${idx}]`;
      const composedLabel = idx === brandOverlays!.length - 1 ? "[vcomp]" : `[v${idx}]`;

      // Scale overlay to fit bbox, preserving aspect ratio (force_original_aspect_ratio=decrease)
      filterParts.push(
        `[${inputIdx}:v]scale=${bboxPxW}:${bboxPxH}:force_original_aspect_ratio=decrease${scaledLabel}`,
      );
      // Overlay onto current main video chain
      filterParts.push(
        `${lastLabel}${scaledLabel}overlay=x=${bboxPxX}:y=${bboxPxY}:eof_action=pass${composedLabel}`,
      );
      lastLabel = composedLabel;
    });

    // Apply the existing vf chain (crop+scale or scale+pad) AFTER overlays
    filterParts.push(`${lastLabel}${vf}[vout]`);

    videoFilterArgs = ["-filter_complex", filterParts.join(";"), "-map", "[vout]", "-map", "0:a?"];
  } else {
    videoFilterArgs = ["-vf", vf];
  }

  const args = [
    ...inputArgs,
    "-t", duration.toString(),
    ...videoFilterArgs,
    "-r", fps.toString(),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-preset", RENDER_CONFIG.PRESET,
    "-crf", RENDER_CONFIG.CRF.toString(),
    "-c:a", "aac", "-b:a", RENDER_CONFIG.AUDIO_BITRATE,
    "-shortest",
    "-movflags", "+faststart",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`FFmpeg render timed out after ${RENDER_CONFIG.TIMEOUT_MS}ms`));
    }, RENDER_CONFIG.TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-300)}`));
      } else {
        resolve();
      }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

/**
 * Generate a thumbnail JPEG from a rendered clip at the given seek time.
 */
async function runFFmpegThumbnail(clipPath: string, outputPath: string, seekTime: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-nostdin", "-y",
      "-ss", seekTime.toString(),
      "-i", clipPath,
      "-vframes", "1",
      "-vf", "scale=360:-2",
      outputPath,
    ]);

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(); // thumbnail is non-fatal
    }, 15000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error("Thumbnail generation failed"));
      else resolve();
    });
    proc.on("error", () => { clearTimeout(timeout); resolve(); });
  });
}
