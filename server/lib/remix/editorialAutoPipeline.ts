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
  if (!video.filePath) {
    return { ...emptyResult, error: "Video has no filePath", durationMs: Date.now() - start };
  }

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
      return await renderClipsOnly(videoId, video.filePath, unrendered, start);
    }
  }

  let videoLocalPath: string | null = null;
  let tempScopeDir: string | null = null;

  try {
    // ── 1. Transcript ────────────────────────────────────────────
    await storage.updateVideoEditorialStatus(videoId, "transcribing", { error: null });

    const transcript = await ensureTranscript(videoId, video.filePath);
    if (!transcript || !transcript.segments || transcript.segments.length === 0) {
      throw new Error("Transcript not available after pipeline run");
    }
    console.log(`[EditorialAuto] Transcript ready: ${transcript.segments.length} segments, ${transcript.wordCount} words`);

    // ── 2. Editorial Analysis ────────────────────────────────────
    await storage.updateVideoEditorialStatus(videoId, "analyzing");

    const surfaces = await storage.getDetectedSurfaces(videoId);
    const brandProducts = await storage.getAllBrandProducts();
    const brandMatches = await storage.getBrandMatchesByVideo(videoId);

    const editorialMoments = await analyzeEditorial({
      videoId,
      transcript: transcript.segments as any,
      surfaces: surfaces.map((s) => ({
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
      })),
      brandCatalog: brandProducts.map((b) => ({
        id: b.id,
        name: b.name,
        category: b.category,
        dominantColor: b.dominantColor,
      })),
      maxClips: targetClipCount,
    });

    if (editorialMoments.length === 0) {
      throw new Error("Editorial analyzer returned no moments");
    }
    console.log(`[EditorialAuto] Found ${editorialMoments.length} editorial moments`);

    // Rank + dedupe
    const rankedClips = deduplicateClips(
      rankClips(
        editorialMoments,
        surfaces.map((s) => ({
          id: s.id,
          videoId: s.videoId,
          timestamp: parseFloat(String(s.timestamp)),
          surfaceType: s.surfaceType,
          confidence: parseFloat(String(s.confidence)),
        })),
        brandMatches.map((bm) => ({
          id: bm.id,
          sceneAnalysisId: bm.sceneAnalysisId,
          brandProductId: bm.brandProductId,
          compatibilityScore: bm.compatibilityScore ?? 0,
          reasoning: bm.reasoning ?? "",
          suggestedPlacementStyle: bm.suggestedPlacementStyle ?? undefined,
        })),
        transcript.segments as any,
        targetClipCount
      )
    );

    if (rankedClips.length === 0) {
      throw new Error("No clips passed the minimum score threshold");
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
    const resolved = await resolveSourceVideo(video.filePath, videoId);
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

        if (needsReframe) {
          // ── Smart Reframe: face-tracking punch-in zoom ──────────
          // Detect faces → compute smooth crop trajectory → crop+scale (no black bars)
          console.log(`[EditorialAuto]   Face tracking clip ${clip.id} (${clip.duration.toFixed(1)}s)...`);

          const faceFrames = await Promise.race([
            // Sample every 0.5s to catch scene cuts quickly (was 1.0s).
            // Soft deadline 90s → returns partial samples if hit; hard timeout 150s as safety net.
            detectFacesInClip(videoLocalPath, clip.clipStart, clip.duration, 0.5, 90000),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Face detection timeout")), 150000)
            ),
          ]).catch(() => {
            console.warn(`[EditorialAuto]   Face detection timed out — using center crop`);
            return [] as Awaited<ReturnType<typeof detectFacesInClip>>;
          });

          const trajectory = computeCropTrajectory(
            faceFrames,
            srcSize.width,
            srcSize.height,
            platformConfig.targetWidth,
            platformConfig.targetHeight,
            {
              speakerSegments: transcript.segments as any,
              clipStartTime: clip.clipStart,
            }
          );

          const cropFilter = buildCropFilterExpr(trajectory);
          const scaleFilter = `scale=${platformConfig.targetWidth}:${platformConfig.targetHeight}`;
          const vf = `${cropFilter},${scaleFilter}`;

          console.log(`[EditorialAuto]   Rendering ${clip.duration.toFixed(1)}s with smart reframe + speaker tracking (crop ${trajectory.cropW}x${trajectory.cropH}, ${faceFrames.length} face samples)`);

          await runFFmpegRender({
            videoPath: videoLocalPath,
            startTime: clip.clipStart,
            duration: clip.duration,
            vf,
            fps: platformConfig.targetFps,
            outputPath,
          });
        } else {
          // ── Same aspect ratio or portrait source — simple scale ──
          const vf = `scale=${platformConfig.targetWidth}:${platformConfig.targetHeight}:force_original_aspect_ratio=decrease,pad=${platformConfig.targetWidth}:${platformConfig.targetHeight}:(ow-iw)/2:(oh-ih)/2:black`;

          await runFFmpegRender({
            videoPath: videoLocalPath,
            startTime: clip.clipStart,
            duration: clip.duration,
            vf,
            fps: platformConfig.targetFps,
            outputPath,
          });
        }

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

    const finalStatus = renderedCount >= AUTO_PIPELINE_CONFIG.minClipCount ? "ready" : "ready"; // accept partial
    await storage.updateVideoEditorialStatus(videoId, finalStatus, {
      clipCount: renderedCount,
      error: renderErrors.length > 0 ? `${renderErrors.length} render failures` : null,
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

        if (needsReframe) {
          console.log(`[EditorialAuto:Resume]   Face tracking clip ${clip.id} (${clip.duration.toFixed(1)}s)...`);
          const faceFrames = await Promise.race([
            detectFacesInClip(videoLocalPath, clip.clipStart, clip.duration, 0.5, 90000),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Face detection timeout")), 150000)
            ),
          ]).catch(() => {
            console.warn(`[EditorialAuto:Resume]   Face detection timed out — using center crop`);
            return [] as Awaited<ReturnType<typeof detectFacesInClip>>;
          });

          const trajectory = computeCropTrajectory(
            faceFrames,
            srcSize.width,
            srcSize.height,
            platformConfig.targetWidth,
            platformConfig.targetHeight,
            { speakerSegments, clipStartTime: clip.clipStart }
          );

          const vf = `${buildCropFilterExpr(trajectory)},scale=${platformConfig.targetWidth}:${platformConfig.targetHeight}`;
          await runFFmpegRender({
            videoPath: videoLocalPath,
            startTime: clip.clipStart,
            duration: clip.duration,
            vf,
            fps: platformConfig.targetFps,
            outputPath,
          });
        } else {
          const vf = `scale=${platformConfig.targetWidth}:${platformConfig.targetHeight}:force_original_aspect_ratio=decrease,pad=${platformConfig.targetWidth}:${platformConfig.targetHeight}:(ow-iw)/2:(oh-ih)/2:black`;
          await runFFmpegRender({
            videoPath: videoLocalPath,
            startTime: clip.clipStart,
            duration: clip.duration,
            vf,
            fps: platformConfig.targetFps,
            outputPath,
          });
        }

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

// ── Single Clip Render (for search results / manual adds) ─────────

/**
 * Render a single editorialClips row that's already in the DB.
 * Reuses the same face-tracking smart-reframe path as the auto-pipeline.
 */
export async function renderSingleEditorialClip(videoId: number, clipId: number): Promise<void> {
  const video = await storage.getVideoById(videoId);
  if (!video || !video.filePath) throw new Error("Video not found or has no filePath");

  const existing = await storage.getEditorialClipsByVideo(videoId);
  const clip = existing.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);

  await storage.updateEditorialClipRender(clip.id, { renderStatus: "rendering" });

  let videoLocalPath: string | null = null;
  let tempScopeDir: string | null = null;
  const renderOutputDir = path.join("/tmp/editorial-renders", `single-${clipId}-${Date.now()}`);
  fs.mkdirSync(renderOutputDir, { recursive: true });

  try {
    const resolved = await resolveSourceVideo(video.filePath, videoId);
    videoLocalPath = resolved.localPath;
    tempScopeDir = resolved.tempScopeDir;

    const srcSize = await getVideoSize(videoLocalPath).catch(() => ({ width: 1920, height: 1080 }));
    const platformConfig = PLATFORM_CONFIGS[AUTO_PIPELINE_CONFIG.platformKey];
    const needsReframe = srcSize.width > srcSize.height && platformConfig.aspectRatio === "9:16";

    const outputFilename = `editorial_${clip.id}_v${videoId}_${Date.now()}.mp4`;
    const outputPath = path.join(renderOutputDir, outputFilename);
    const thumbPath = outputPath.replace(".mp4", "_thumb.jpg");

    if (needsReframe) {
      const faceFrames = await Promise.race([
        // Soft 90s deadline returns partial samples; hard 150s timeout is a safety net
        detectFacesInClip(videoLocalPath, clip.clipStart, clip.duration, 0.5, 90000),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Face detection timeout")), 150000)
        ),
      ]).catch(() => []);

      // Fetch transcript for speaker-aware crop tracking
      const transcriptRecord = await storage.getVideoTranscript(videoId);
      const speakerSegments = transcriptRecord?.segments as any[] | undefined;

      const trajectory = computeCropTrajectory(
        faceFrames,
        srcSize.width,
        srcSize.height,
        platformConfig.targetWidth,
        platformConfig.targetHeight,
        {
          speakerSegments,
          clipStartTime: clip.clipStart,
        }
      );

      const vf = `${buildCropFilterExpr(trajectory)},scale=${platformConfig.targetWidth}:${platformConfig.targetHeight}`;
      await runFFmpegRender({
        videoPath: videoLocalPath,
        startTime: clip.clipStart,
        duration: clip.duration,
        vf,
        fps: platformConfig.targetFps,
        outputPath,
      });
    } else {
      const vf = `scale=${platformConfig.targetWidth}:${platformConfig.targetHeight}:force_original_aspect_ratio=decrease,pad=${platformConfig.targetWidth}:${platformConfig.targetHeight}:(ow-iw)/2:(oh-ih)/2:black`;
      await runFFmpegRender({
        videoPath: videoLocalPath,
        startTime: clip.clipStart,
        duration: clip.duration,
        vf,
        fps: platformConfig.targetFps,
        outputPath,
      });
    }

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
    try { fs.rmSync(renderOutputDir, { recursive: true, force: true }); } catch {}
    if (tempScopeDir) {
      try { fs.rmSync(tempScopeDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// ── FFmpeg Render Helpers ──────────────────────────────────────────

interface RenderOptions {
  videoPath: string;
  startTime: number;
  duration: number;
  vf: string;
  fps: number;
  outputPath: string;
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
 */
async function runFFmpegRender(opts: RenderOptions): Promise<void> {
  const { videoPath, startTime, duration, vf, fps, outputPath } = opts;

  const args = [
    "-nostdin", "-y",
    "-ss", startTime.toString(),
    "-i", videoPath,
    "-t", duration.toString(),
    "-vf", vf,
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
