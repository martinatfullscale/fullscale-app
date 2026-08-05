/**
 * Remix Orchestrator — 9-Step Auto-Remix Pipeline
 *
 * Top-level entry point for the Auto-Remix Engine. Orchestrates the full flow:
 *
 * Step 1: IDENTIFY — Find high-viability moments from scene analysis
 * Step 2: EXTRACT — Pull clip candidates with optimal boundaries
 * Step 3: ANALYZE — Score brand matches and narrative coherence per clip
 * Step 4: INSERT — Attach product placements to clip surfaces
 * Step 5: FORMAT — Generate platform-specific clips with FFmpeg
 * Step 6: CAPTION — Generate and burn-in auto-captions
 * Step 7: SCORE — Quality-score each generated clip
 * Step 8: EXPORT — Write clips to disk and create DB records
 * Step 9: DISTRIBUTE — Mark clips ready for publishing (actual push is manual)
 *
 * Supports two detection modes:
 * - Legacy: Per-frame scene analysis via clipDetector.ts
 * - Editorial: Transcript-first Claude Dense analysis via editorialAnalyzer + clipRanker
 *
 * Called by POST /api/remix/:videoId/start route.
 */

import * as path from "path";
import * as fs from "fs";
import { storage } from "../../storage";
import { detectClipCandidates, PLATFORM_CONFIGS, type ClipCandidate } from "./clipDetector";
import { generateClip, type ClipPlacement } from "./clipGenerator";
import { generateCaptions } from "./captionEngine";
import { scoreClipQuality } from "./qualityScorer";
import type { RankedClip } from "./clipRanker";
import { objectKeyFromServeUrl, downloadToTempFile, uploadFileToStorage } from "../objectStorage";

export interface RemixConfig {
  minClipDuration: number;
  maxClipDuration: number;
  maxClips: number;
  platformTargets: string[];
  captionsEnabled: boolean;
  captionStyle: "highlight" | "brand_callout" | "narrative";
  /** When provided, skip detection and generate a single clip from this exact time range */
  clipRange?: { start: number; end: number };
  /** When true, use editorial intelligence pipeline instead of legacy per-frame detection */
  editorialMode?: boolean;
  /** Theme/keywords the user is chasing — steers editorial analysis toward
   *  matching transcript beats (passed to analyzeEditorial as `query`) */
  keywords?: string;
  /** Enable face-tracking smart reframing for portrait clips (default: true) */
  faceTrackingEnabled?: boolean;
}

export interface RemixResult {
  jobId: number;
  success: boolean;
  clipsGenerated: number;
  clipsPublishReady: number;
  clipsNeedReview: number;
  clips: Array<{
    clipId: number;
    platform: string;
    duration: number;
    qualityScore: number;
    recommendation: string;
    exportPath: string | null;
    thumbnailPath: string | null;
  }>;
  error?: string;
  /** Candidates that entered the render step and produced nothing, when at
   *  least one other clip succeeded. A partially-empty run is still a success,
   *  but the creator should be able to find out what was lost. */
  partialFailures?: string[];
}

const DEFAULT_CONFIG: RemixConfig = {
  minClipDuration: 15,
  maxClipDuration: 60,
  maxClips: 5,
  platformTargets: ["tiktok", "youtube_shorts"],
  captionsEnabled: true,
  captionStyle: "highlight",
  faceTrackingEnabled: true,
};

/**
 * Convert a RankedClip (from editorial intelligence pipeline) to a ClipCandidate
 * (expected by clipGenerator, captionEngine, qualityScorer).
 */
function rankedClipToCandidate(ranked: RankedClip, platform: string): ClipCandidate {
  return {
    startTime: ranked.clipStart,
    endTime: ranked.clipEnd,
    duration: ranked.duration,
    score: ranked.finalScore,
    sceneAnalysisIds: [],
    surfaceIds: ranked.surfaces.map((s) => s.id),
    brandProductIds: [...new Set(ranked.brandMatches.map((bm) => bm.brandProductId))],
    primaryTone: ranked.monetizationTier, // Repurposed: "premium"/"standard"/"organic"
    narrativeSummary: ranked.suggestedTitle,
    platform,
  };
}

/**
 * Resolve a video's file path to a local path accessible by FFmpeg.
 * - Object Storage paths (/storage/...) → download to a per-scope temp subdirectory
 * - Local paths → use directly
 *
 * The `scope` parameter MUST be unique per concurrent operation (e.g. `job-${jobId}`,
 * `stitch-${planId}`, `rerender-${clipId}-${Date.now()}`). Multiple concurrent callers
 * with the same source video must get different local paths, otherwise FFmpeg processes
 * will stomp on each other (half-written files → "moov atom not found", deleted files
 * mid-read → "Video file not found" or EIO).
 *
 * Returns { localPath, isTempFile, tempScopeDir } so callers can clean up the whole
 * scope directory at the end of the operation, even if multiple temp files were written.
 */
async function resolveVideoPath(
  filePath: string,
  scope: string
): Promise<{ localPath: string; isTempFile: boolean; tempScopeDir: string | null }> {
  if (filePath.startsWith("/storage/")) {
    console.log(`[Remix] Resolving Object Storage path: ${filePath} (scope: ${scope})`);
    const objectKey = objectKeyFromServeUrl(filePath);
    const tempScopeDir = path.join("/tmp/remix-videos", scope);
    const localPath = await downloadToTempFile(objectKey, tempScopeDir);
    console.log(`[Remix] Downloaded to temp file: ${localPath}`);
    return { localPath, isTempFile: true, tempScopeDir };
  }

  // Try as a path relative to public dir
  if (filePath.startsWith("/") && !fs.existsSync(filePath)) {
    const publicPath = path.join(process.cwd(), "public", filePath);
    if (fs.existsSync(publicPath)) {
      return { localPath: publicPath, isTempFile: false, tempScopeDir: null };
    }
  }

  return { localPath: filePath, isTempFile: false, tempScopeDir: null };
}

/**
 * Run the full 9-step Auto-Remix pipeline.
 */
/**
 * Check if a remix job has been cancelled by the user.
 * Called between pipeline stages to enable soft cancellation.
 * Throws if cancelled.
 */
async function checkCancelled(jobId: number): Promise<void> {
  try {
    const job = await storage.getRemixJob(jobId);
    if (job?.status === "cancelled") {
      throw new Error("CANCELLED_BY_USER");
    }
    // "failed" can be written externally (startup sweep during an overlapping
    // redeploy). Terminal statuses are sticky, so keeping rendering would burn
    // CPU on a job whose status can never be updated — abort at the checkpoint.
    if (job?.status === "failed") {
      throw new Error("JOB_MARKED_FAILED_EXTERNALLY");
    }
  } catch (err: any) {
    if (err.message === "CANCELLED_BY_USER" || err.message === "JOB_MARKED_FAILED_EXTERNALLY") throw err;
    // DB errors — don't block the pipeline
  }
}

export async function runRemixPipeline(
  jobId: number,
  videoId: number,
  userId: number,
  config: Partial<RemixConfig> = {}
): Promise<RemixResult> {
  const mergedConfig: RemixConfig = { ...DEFAULT_CONFIG, ...config };

  // Transition the pre-existing job record from "queued" → "processing".
  // IMPORTANT: the caller (route handler) creates the job row so that the client
  // gets a job ID immediately from the POST response. This function MUST NOT create
  // its own job row — doing so would produce a ghost "queued" job that the UI polls
  // forever while all the real status updates go to a different record.
  await storage.updateRemixJobStatus(jobId, "processing");

  console.log(`[Remix] ========== STARTING REMIX JOB ${jobId} ==========`);
  console.log(`[Remix] Video: ${videoId}, Platforms: ${mergedConfig.platformTargets.join(", ")}, Max clips: ${mergedConfig.maxClips}`);

  let tempScopeDir: string | null = null;
  let sourcePinDir: string | null = null;

  try {
    // Get video info
    const video = await storage.getVideoById(videoId);
    if (!video || (!video.filePath && !video.youtubeId)) {
      throw new Error("Video not found or has no source");
    }

    // Light-cloud imports (YouTube/IG/FB) have no filePath — pull via the
    // shared source cache (OAuth-capable, TTL'd) the same way playback does.
    let sourceFilePath: string = video.filePath as string;
    if (!sourceFilePath) {
      // Pin (hard link) so the playback cache sweeper can't unlink the
      // source under this multi-minute job; cleaned with tempScopeDir below.
      const { getPinnedSourcePath } = await import("../sourceCache");
      sourcePinDir = path.join("/tmp/remix-videos", `job-${jobId}-pin`);
      sourceFilePath = await getPinnedSourcePath(video as any, sourcePinDir);
      console.log(`[Remix] Pulled + pinned platform source for video ${videoId}: ${sourceFilePath}`);
    }

    // Resolve video path (handles Object Storage download if needed).
    // Scope the temp path with this job's ID so concurrent remix jobs never collide.
    const resolved = await resolveVideoPath(sourceFilePath, `job-${jobId}`);
    const videoPath = resolved.localPath;
    if (resolved.tempScopeDir) tempScopeDir = resolved.tempScopeDir;

    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    // Get video duration from ffprobe
    const videoDuration = await getVideoDuration(videoPath);
    console.log(`[Remix] Video duration: ${videoDuration.toFixed(1)}s`);

    // Load transcript for editorial-mode captions
    const transcript = await storage.getVideoTranscript(videoId);
    const hasTranscript = transcript?.status === "completed" && transcript.segments;

    let candidates: ClipCandidate[];

    // ═══════════════════════════════════════════════════════════════
    // EDITORIAL PATH — Use editorial intelligence pipeline
    // ═══════════════════════════════════════════════════════════════

    if (mergedConfig.clipRange) {
      // Direct clip range from editorial UI — skip Steps 1-3 entirely
      await storage.updateRemixJobStatus(jobId, "step_2_extract");
      console.log(`[Remix] Editorial mode: Direct clip range ${mergedConfig.clipRange.start.toFixed(1)}s-${mergedConfig.clipRange.end.toFixed(1)}s`);

      const { start, end } = mergedConfig.clipRange;
      const duration = end - start;
      const platform = mergedConfig.platformTargets[0] || "tiktok";

      candidates = [{
        startTime: start,
        endTime: end,
        duration,
        score: 0.8, // Editorial clips are pre-scored — assume high quality
        sceneAnalysisIds: [],
        surfaceIds: [],
        brandProductIds: [],
        primaryTone: "editorial",
        narrativeSummary: `Editorial clip ${start.toFixed(1)}s-${end.toFixed(1)}s`,
        platform,
      }];

      // Try to enrich with surface data from that time range
      const surfaces = await storage.getDetectedSurfaces(videoId);
      const overlapping = surfaces.filter(
        (s) => parseFloat(String(s.timestamp)) >= start && parseFloat(String(s.timestamp)) <= end
      );
      if (overlapping.length > 0) {
        candidates[0].surfaceIds = overlapping.map((s) => s.id);
      }

      console.log(`[Remix] Single editorial clip with ${overlapping.length} surface(s)`);

    } else if (mergedConfig.editorialMode && hasTranscript) {
      // Editorial mode: Use Claude Dense editorial analysis + clip ranker
      await storage.updateRemixJobStatus(jobId, "step_1_identify");
      console.log(`[Remix] Step 1/9: Loading editorial intelligence data...`);

      // Dynamically import editorial pipeline
      const { analyzeEditorial } = await import("../ai/claude-dense/editorialAnalyzer");
      const { rankClips, deduplicateClips } = await import("./clipRanker");

      const surfaces = await storage.getDetectedSurfaces(videoId);
      const brandProducts = await storage.getAllBrandProducts();

      console.log(`[Remix] Running editorial analysis: ${transcript.segments!.length} segments, ${surfaces.length} surfaces`);

      const editorialMoments = await analyzeEditorial({
        videoId,
        transcript: transcript.segments!,
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
        maxClips: mergedConfig.maxClips,
        query: mergedConfig.keywords,
      });

      if (editorialMoments.length === 0) {
        throw new Error("Editorial analysis returned no clip moments.");
      }

      // Get brand matches for surface cross-reference
      const brandMatches = await storage.getBrandMatchesByVideo(videoId);

      // Rank and deduplicate
      await storage.updateRemixJobStatus(jobId, "step_2_extract");
      console.log(`[Remix] Step 2/9: Ranking ${editorialMoments.length} editorial moments...`);

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
          transcript.segments!,
          mergedConfig.maxClips
        )
      );

      if (rankedClips.length === 0) {
        throw new Error("No ranked clips met the minimum score threshold.");
      }

      // Convert RankedClip[] → ClipCandidate[]
      const platform = mergedConfig.platformTargets[0] || "tiktok";
      candidates = rankedClips.map((rc) => rankedClipToCandidate(rc, platform));

      console.log(`[Remix] Editorial pipeline: ${rankedClips.length} ranked clips → ${candidates.length} candidates`);

      // Step 3: Log rankings
      await storage.updateRemixJobStatus(jobId, "step_3_analyze");
      console.log(`[Remix] Step 3/9: Editorial ranking results:`);
      for (const [i, clip] of candidates.entries()) {
        console.log(`[Remix]   #${i + 1}: ${clip.platform} ${clip.startTime.toFixed(1)}s-${clip.endTime.toFixed(1)}s (score: ${(clip.score * 100).toFixed(0)}%) "${clip.narrativeSummary}"`);
      }

    } else {
      // ═══════════════════════════════════════════════════════════════
      // LEGACY PATH — Per-frame scene analysis via clipDetector
      // ═══════════════════════════════════════════════════════════════

      // ─── STEP 1: IDENTIFY — Load narrative analyses ───────────────
      await storage.updateRemixJobStatus(jobId, "step_1_identify");
      console.log(`[Remix] Step 1/9: Identifying high-viability moments (legacy mode)...`);

      const analyses = await storage.getSceneAnalysisByVideo(videoId);
      if (analyses.length === 0) {
        throw new Error("No scene analyses found. Run Claude Dense analysis first.");
      }

      const surfaces = await storage.getDetectedSurfaces(videoId);
      const surfaceMap = new Map(surfaces.map(s => [s.id, s]));

      // Load brand matches for each analysis
      const analysesWithBrands = await Promise.all(
        analyses.map(async (analysis) => ({
          analysis,
          brandMatches: await storage.getBrandMatchesByScene(analysis.id),
          surface: analysis.surfaceId ? surfaceMap.get(analysis.surfaceId) || null : null,
        }))
      );

      // ─── STEP 2: EXTRACT — Detect clip candidates ────────────────
      await storage.updateRemixJobStatus(jobId, "step_2_extract");
      console.log(`[Remix] Step 2/9: Extracting clip candidates (legacy detector)...`);

      candidates = detectClipCandidates(
        analysesWithBrands,
        mergedConfig.platformTargets,
        mergedConfig.maxClips,
        videoDuration
      );

      if (candidates.length === 0) {
        throw new Error("No viable clip candidates found. Scenes may not have high enough viability scores.");
      }

      console.log(`[Remix] Found ${candidates.length} clip candidates`);

      // ─── STEP 3: ANALYZE — Score and rank candidates ─────────────
      await storage.updateRemixJobStatus(jobId, "step_3_analyze");
      console.log(`[Remix] Step 3/9: Analyzing and ranking candidates...`);

      for (const [i, clip] of candidates.entries()) {
        console.log(`[Remix]   #${i + 1}: ${clip.platform} ${clip.startTime.toFixed(1)}s-${clip.endTime.toFixed(1)}s (score: ${(clip.score * 100).toFixed(0)}%)`);
      }
    }

    await checkCancelled(jobId);

    // ─── STEP 4: INSERT — Attach product placements ──────────────
    await storage.updateRemixJobStatus(jobId, "step_4_insert");
    console.log(`[Remix] Step 4/9: Attaching product placements to clips...`);

    // Load surfaces (may already be loaded in editorial path, but safe to reload)
    const allSurfaces = await storage.getDetectedSurfaces(videoId);
    const surfaceMap = new Map(allSurfaces.map(s => [s.id, s]));

    // Load brand products (brandMatchScores.brandProductId references brandProducts, not monetizationItems)
    const brandProductList = await storage.getAllBrandProducts();
    const itemMap = new Map(brandProductList.map(i => [i.id, i]));

    // ── Phase 2A Enhancement: Dense Keyframe Pre-scan ──────────────
    // Check if existing keyframes are too sparse for smooth motion tracking.
    // If a clip has surfaces with < 4 keyframes per second of clip duration,
    // trigger a dense re-scan at 0.5s intervals before building placements.
    const MIN_KEYFRAMES_PER_SECOND = 1.5; // Need at least 1.5 kf/s for smooth tracking

    for (const clip of candidates) {
      if (clip.surfaceIds.length === 0) continue;

      const clipDuration = clip.endTime - clip.startTime;
      const minKeyframes = Math.ceil(clipDuration * MIN_KEYFRAMES_PER_SECOND);

      // Check keyframe density for each surface in this clip
      const sparseSurfaces: number[] = [];

      for (const surfaceId of clip.surfaceIds) {
        const existingKfs = await storage.getSurfaceKeyframesInRange(
          surfaceId, clip.startTime, clip.endTime
        );
        if (existingKfs.length < minKeyframes) {
          sparseSurfaces.push(surfaceId);
          console.log(`[Remix]   Surface ${surfaceId}: only ${existingKfs.length} keyframes for ${clipDuration.toFixed(1)}s clip (need ~${minKeyframes})`);
        }
      }

      // Run dense scan for sparse surfaces
      if (sparseSurfaces.length > 0) {
        try {
          console.log(`[Remix]   Running dense keyframe scan for ${sparseSurfaces.length} surface(s) in clip ${clip.startTime.toFixed(1)}s-${clip.endTime.toFixed(1)}s...`);
          const { denseScanRange } = await import("../../scanner_v2");
          const denseScanResult = await denseScanRange(
            videoId,
            clip.startTime,
            clip.endTime,
            sparseSurfaces,
            0.5 // 0.5s interval = 2 keyframes/second
          );
          console.log(`[Remix]   Dense scan created ${denseScanResult.keyframesCreated} additional keyframes`);
        } catch (denseErr: any) {
          console.warn(`[Remix]   Dense scan failed (non-fatal, using existing keyframes): ${denseErr.message}`);
        }
      }
    }

    const clipPlacements = new Map<number, ClipPlacement[]>();
    for (let i = 0; i < candidates.length; i++) {
      const clip = candidates[i];
      const placements: ClipPlacement[] = [];

      // ── Diagnostic: Log placement prerequisites for this clip ──
      console.log(`[Remix]   Clip #${i + 1} placement check: ${clip.surfaceIds.length} surface(s) in time range ${clip.startTime.toFixed(1)}s-${clip.endTime.toFixed(1)}s`);
      if (clip.surfaceIds.length === 0) {
        console.warn(`[Remix]   ⚠️ Clip #${i + 1}: No detected surfaces — will produce clean cut (no product placement)`);
      }

      for (const surfaceId of clip.surfaceIds) {
        const surface = surfaceMap.get(surfaceId);
        if (!surface) {
          console.warn(`[Remix]   ⚠️ Surface ${surfaceId} not found in surfaceMap — skipping`);
          continue;
        }

        // Find the approved brand match for this surface
        const surfaceAnalysis = await storage.getSceneAnalysisBySurface(surfaceId);
        if (!surfaceAnalysis) {
          console.warn(`[Remix]   ⚠️ Surface ${surfaceId}: No scene analysis found — skipping (run editorial analysis first)`);
          continue;
        }

        const matches = await storage.getBrandMatchesByScene(surfaceAnalysis.id);
        const approved = matches.find(m => m.approved);
        if (!approved) {
          console.warn(`[Remix]   ⚠️ Surface ${surfaceId}: ${matches.length} brand match(es) found but none approved — skipping (approve a brand match in the UI)`);
          continue;
        }

        const product = itemMap.get(approved.brandProductId);
        if (!product) {
          console.warn(`[Remix]   ⚠️ Surface ${surfaceId}: Approved brand product #${approved.brandProductId} not found in catalog — skipping`);
          continue;
        }

        // Phase 3: Auto-generate product asset via Seeddance if no image exists
        let resolvedImageUrl = product.imageUrl;
        if (!resolvedImageUrl) {
          try {
            console.log(`[Remix]   No image for product "${product.name}" — attempting Seeddance generation...`);
            const { generateProductAsset } = await import("../ai/image-gen/assetGenerator");
            const genResult = await generateProductAsset({
              videoId,
              surfaceId,
              brandProduct: { id: product.id, name: product.name, category: product.category || null },
              sceneContext: {
                narrativeContext: surfaceAnalysis.narrativeContext || "",
                emotionalTone: surfaceAnalysis.emotionalTone || "neutral",
                culturalTags: (surfaceAnalysis as any).culturalTags || [],
                suggestedProductCategories: [],
              },
              surfaceDimensions: {
                width: parseFloat(String(surface.boundingBoxWidth)) || 0.2,
                height: parseFloat(String(surface.boundingBoxHeight)) || 0.2,
                aspectRatio: (parseFloat(String(surface.boundingBoxWidth)) || 0.2) / (parseFloat(String(surface.boundingBoxHeight)) || 0.2),
              },
              sceneAesthetic: {
                colorWarmth: 0.5,
                brightness: { overall: 0.5, top: 0.5, bottom: 0.5 },
                dominantColors: [],
              },
              targetPlatform: clip.platform,
            });

            if (genResult.success && genResult.assetPath) {
              console.log(`[Remix]   Seeddance generated: ${genResult.assetPath} (${genResult.assetType})`);
              // Save the generated asset record
              await storage.createGeneratedAsset({
                videoId,
                surfaceId,
                brandProductId: product.id,
                assetType: genResult.assetType,
                generationPrompt: genResult.prompt,
                assetPath: genResult.assetPath,
                seeddanceJobId: genResult.jobId,
                videoDuration: genResult.duration,
                targetPlatform: clip.platform,
                approved: false,
                needsManualReview: true,
              });
              resolvedImageUrl = genResult.assetPath;
            } else {
              console.warn(`[Remix]   Seeddance generation failed: ${genResult.error || "unknown"}`);
              continue;
            }
          } catch (genErr: any) {
            console.warn(`[Remix]   Asset generation error: ${genErr.message}`);
            continue;
          }
        }

        // Resolve product image path
        const imagePath = resolvedImageUrl!.startsWith("/")
          ? path.join(process.cwd(), "public", resolvedImageUrl!)
          : resolvedImageUrl!;

        if (!fs.existsSync(imagePath)) continue;

        // Phase 2A: Load motion keyframes for this surface within the clip's time range
        // (Now includes dense-scanned keyframes from the pre-scan above)
        const keyframeRecords = await storage.getSurfaceKeyframesInRange(
          surfaceId,
          clip.startTime,
          clip.endTime
        );

        // Convert to ClipPlacement keyframes (times relative to clip start)
        const keyframes = keyframeRecords.map((kf) => ({
          time: parseFloat(String(kf.timestamp)) - clip.startTime,
          x: parseFloat(String(kf.boundingBoxX)),
          y: parseFloat(String(kf.boundingBoxY)),
          width: parseFloat(String(kf.boundingBoxWidth)),
          height: parseFloat(String(kf.boundingBoxHeight)),
        }));

        // Static fallback bbox from the normalized surface record
        const bboxStart = {
          x: parseFloat(String(surface.boundingBoxX)) || 0,
          y: parseFloat(String(surface.boundingBoxY)) || 0,
          width: parseFloat(String(surface.boundingBoxWidth)) || 0.2,
          height: parseFloat(String(surface.boundingBoxHeight)) || 0.2,
        };

        placements.push({
          surfaceId,
          brandProductId: approved.brandProductId,
          productImagePath: imagePath,
          keyframes,
          bboxStart,
          opacity: 0.92,
        });
      }

      clipPlacements.set(i, placements);
      const kfCounts = placements.map((p) => p.keyframes.length);
      console.log(`[Remix]   Clip #${i + 1}: ${placements.length} placement(s) [keyframes: ${kfCounts.join(", ") || "none"}]`);
    }

    // ─── STEP 4B: MOTION ANALYSIS — VFX Camera Tracking ────────────
    // Run vidstab camera motion analysis for clips that have product placements.
    // This gives us per-frame camera transforms so products stay locked to the
    // scene like real objects, instead of jittering from frame-to-frame re-detection.
    const clipMotionData = new Map<number, import("./motionTracker").CameraMotionData>();

    for (let i = 0; i < candidates.length; i++) {
      const clip = candidates[i];
      const placements = clipPlacements.get(i) || [];
      if (placements.length === 0) continue; // No placements = no need for motion tracking

      const platformConfig = PLATFORM_CONFIGS[clip.platform];
      if (!platformConfig) continue;

      try {
        const { analyzeClipMotion } = await import("./motionTracker");
        console.log(`[Remix]   Running VFX motion analysis for clip #${i + 1} (${clip.duration.toFixed(1)}s)...`);

        const motionData = await analyzeClipMotion(
          videoPath,
          clip.startTime,
          clip.duration,
          platformConfig.targetFps
        );

        if (motionData && motionData.transforms.length > 0) {
          clipMotionData.set(i, motionData);
          console.log(`[Remix]   Motion analysis: ${motionData.transforms.length} frame transforms — products will be scene-locked`);
        } else {
          console.log(`[Remix]   Motion analysis unavailable — using keyframe interpolation fallback`);
        }
      } catch (motionErr: any) {
        console.warn(`[Remix]   Motion analysis failed (non-fatal): ${motionErr.message}`);
      }
    }

    await checkCancelled(jobId);

    // ─── STEP 5+6: FORMAT + CAPTION — Generate clips ─────────────
    await storage.updateRemixJobStatus(jobId, "step_5_format");
    console.log(`[Remix] Steps 5-6/9: Generating and captioning clips...`);

    const outputDir = path.join(process.cwd(), "public", "exported-clips", jobId.toString());
    fs.mkdirSync(outputDir, { recursive: true });

    const generatedClips: RemixResult["clips"] = [];
    // Why each candidate produced nothing. Without this a job that renders
    // zero clips reports plain success and the creator is told "complete"
    // with an empty grid and no way to find out why.
    const clipFailures: string[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const clip = candidates[i];
      const platformConfig = PLATFORM_CONFIGS[clip.platform];
      if (!platformConfig) {
        clipFailures.push(`clip #${i + 1}: no platform config for "${clip.platform}"`);
        continue;
      }

      const placements = clipPlacements.get(i) || [];

      // Step 6: Generate captions (prefer transcript-based when available)
      let captionSegments = undefined;
      if (mergedConfig.captionsEnabled) {
        try {
          // Build transcript segments for this clip's time range
          let clipTranscriptSegments = undefined;
          if (transcript && transcript.status === "completed" && transcript.segments) {
            clipTranscriptSegments = transcript.segments.filter(
              (seg: any) => seg.start >= clip.startTime && seg.start <= clip.endTime
            );
          }

          const captionResult = await generateCaptions({
            clipStart: clip.startTime,
            clipEnd: clip.endTime,
            duration: clip.duration,
            narrativeContext: clip.narrativeSummary,
            emotionalTone: clip.primaryTone,
            brandNames: clip.brandProductIds.map(id => {
              const item = itemMap.get(id);
              return item?.name || `Product ${id}`;
            }),
            style: mergedConfig.captionStyle,
            transcriptSegments: clipTranscriptSegments,
          });
          captionSegments = captionResult.segments;
          console.log(`[Remix]   Clip #${i + 1}: ${captionSegments.length} caption segments${clipTranscriptSegments ? " (transcript-based)" : ""}`);
        } catch (captionErr) {
          console.warn(`[Remix]   Clip #${i + 1}: Caption generation failed (non-fatal)`, captionErr);
        }
      }

      // Check for cancellation before each expensive clip generation
      await checkCancelled(jobId);

      // Step 5: Generate the clip (with VFX motion tracking if available)
      console.log(`[Remix]   Generating clip #${i + 1}/${candidates.length} (${clip.platform})...`);

      const clipResult = await generateClip({
        videoPath,
        videoId,
        clip,
        platformConfig,
        placements,
        captionsEnabled: mergedConfig.captionsEnabled && !!captionSegments,
        captionSegments,
        captionStyle: mergedConfig.captionStyle,
        outputDir,
        jobId,
        cameraMotion: clipMotionData.get(i),
        faceTracking: {
          enabled: mergedConfig.faceTrackingEnabled ?? true,
          sampleIntervalSec: 0.5,
        },
      });

      if (!clipResult.success) {
        console.error(`[Remix]   Clip #${i + 1} generation failed: ${clipResult.error}`);
        clipFailures.push(`clip #${i + 1}: ${clipResult.error || "render failed"}`);
        continue;
      }

      // ─── STEP 7: SCORE — Quality assessment ─────────────────────
      console.log(`[Remix] Step 7/9: Scoring clip #${i + 1}...`);

      const qualityResult = await scoreClipQuality({
        thumbnailPath: clipResult.thumbnailPath,
        clip,
        platform: clip.platform,
        actualDuration: clipResult.duration,
        placementCount: placements.length,
        hasCaptions: mergedConfig.captionsEnabled && !!captionSegments,
        fileSize: clipResult.fileSize,
        editorialScore: (mergedConfig.clipRange || mergedConfig.editorialMode) ? clip.score : undefined,
      });

      // ─── STEP 8: EXPORT — Upload to Object Storage + Save to DB ─
      await storage.updateRemixJobStatus(jobId, "step_7_score");
      console.log(`[Remix] Step 8/9: Uploading clip #${i + 1} to Object Storage...`);

      let storagePath: string | null = null;
      let thumbStoragePath: string | null = null;

      // Upload clip MP4 to Object Storage for permanent persistence
      if (clipResult.clipPath && fs.existsSync(clipResult.clipPath)) {
        try {
          const clipFilename = path.basename(clipResult.clipPath);
          const objectKey = `public/exported-clips/${jobId}/${clipFilename}`;
          storagePath = await uploadFileToStorage(clipResult.clipPath, objectKey);
          console.log(`[Remix]   Clip uploaded to Object Storage: ${storagePath}`);
          // Clean up local file after successful upload
          fs.unlinkSync(clipResult.clipPath);
        } catch (uploadErr: any) {
          console.warn(`[Remix]   Clip upload failed (keeping local): ${uploadErr.message}`);
          // Fallback to local relative path if upload fails
          storagePath = "/" + path.relative(path.join(process.cwd(), "public"), clipResult.clipPath);
        }
      }

      // Upload thumbnail to Object Storage
      if (clipResult.thumbnailPath && fs.existsSync(clipResult.thumbnailPath)) {
        try {
          const thumbFilename = path.basename(clipResult.thumbnailPath);
          const objectKey = `public/exported-clips/${jobId}/${thumbFilename}`;
          thumbStoragePath = await uploadFileToStorage(clipResult.thumbnailPath, objectKey);
          console.log(`[Remix]   Thumbnail uploaded to Object Storage: ${thumbStoragePath}`);
          fs.unlinkSync(clipResult.thumbnailPath);
        } catch (uploadErr: any) {
          console.warn(`[Remix]   Thumbnail upload failed (keeping local): ${uploadErr.message}`);
          thumbStoragePath = "/" + path.relative(path.join(process.cwd(), "public"), clipResult.thumbnailPath);
        }
      }

      const clipStatus = qualityResult.recommendation === "publish"
        ? "ready"
        : qualityResult.recommendation === "review"
          ? "pending_review"
          : "rejected";

      const dbClip = await storage.createGeneratedClip({
        remixJobId: jobId,
        videoId,
        clipStart: clip.startTime,
        clipEnd: clip.endTime,
        duration: clipResult.duration,
        format: "mp4",
        platformTarget: clip.platform,
        productPlacements: placements.map(p => ({
          surfaceId: p.surfaceId,
          brandProductId: p.brandProductId,
          placementId: 0,
        })),
        captionsEnabled: mergedConfig.captionsEnabled,
        qualityScore: qualityResult.overallScore,
        exportPath: storagePath,
        thumbnailPath: thumbStoragePath,
        status: clipStatus,
      });

      generatedClips.push({
        clipId: dbClip.id,
        platform: clip.platform,
        duration: clipResult.duration,
        qualityScore: qualityResult.overallScore,
        recommendation: qualityResult.recommendation,
        exportPath: storagePath,
        thumbnailPath: thumbStoragePath,
      });
    }

    // ─── STEP 9: DISTRIBUTE — Mark job complete ──────────────────
    console.log(`[Remix] Step 9/9: Finalizing distribution status...`);

    const publishReady = generatedClips.filter(c => c.recommendation === "publish").length;
    const needReview = generatedClips.filter(c => c.recommendation === "review").length;

    // ZERO CLIPS IS A FAILURE, NOT A SUCCESS.
    // Every candidate can fail to render — each one `continue`s past the DB
    // insert — and the job would still have been marked "completed". The
    // creator then sees "complete", an empty clip grid, and no error anywhere:
    // the exact "it says done but there's no output" report. Surface the real
    // reason on the row the UI is already polling.
    if (generatedClips.length === 0) {
      const why = clipFailures.length > 0
        ? `No clips were produced. ${clipFailures.slice(0, 3).join("; ")}${clipFailures.length > 3 ? ` (+${clipFailures.length - 3} more)` : ""}`
        : `No clips were produced — ${candidates.length} candidate(s) entered the render step and none completed.`;
      console.error(`[Remix] ========== REMIX JOB ${jobId} PRODUCED NOTHING ==========`);
      console.error(`[Remix] ${why}`);
      await storage.updateRemixJobStatus(jobId, "failed", why);
      await storage.setRemixJobClipCount(jobId, 0).catch(() => {});
      return {
        jobId,
        success: false,
        clipsGenerated: 0,
        clipsPublishReady: 0,
        clipsNeedReview: 0,
        clips: [],
        error: why,
      };
    }

    await storage.updateRemixJobStatus(jobId, "completed");
    // clip_count exists on the row and nothing ever wrote it, so the UI could
    // not distinguish "0 clips" from "not counted".
    await storage.setRemixJobClipCount(jobId, generatedClips.length).catch((e: any) =>
      console.warn(`[Remix] Could not persist clip count for job ${jobId}: ${e?.message}`));

    console.log(`[Remix] ========== REMIX JOB ${jobId} COMPLETE ==========`);
    console.log(`[Remix] Generated: ${generatedClips.length} clips`);
    console.log(`[Remix] Publish-ready: ${publishReady}, Needs review: ${needReview}`);
    if (clipFailures.length > 0) {
      console.warn(`[Remix] ${clipFailures.length} candidate(s) did not render: ${clipFailures.join("; ")}`);
    }

    return {
      jobId,
      success: true,
      clipsGenerated: generatedClips.length,
      clipsPublishReady: publishReady,
      clipsNeedReview: needReview,
      clips: generatedClips,
      partialFailures: clipFailures.length > 0 ? clipFailures : undefined,
    };
  } catch (err: any) {
    // Distinguish cancellation from real failure
    if (err.message === "CANCELLED_BY_USER") {
      console.log(`[Remix] Job ${jobId} pipeline stopped — user cancelled`);
      // Status is already "cancelled" in DB from the cancel endpoint
      return {
        jobId,
        success: false,
        clipsGenerated: 0,
        clipsPublishReady: 0,
        clipsNeedReview: 0,
        clips: [],
        error: "Cancelled by user",
      };
    }
    console.error(`[Remix] Pipeline failed: ${err.message}`);
    await storage.updateRemixJobStatus(jobId, "failed", err.message);

    return {
      jobId,
      success: false,
      clipsGenerated: 0,
      clipsPublishReady: 0,
      clipsNeedReview: 0,
      clips: [],
      error: err.message,
    };
  } finally {
    // Clean up the entire per-job temp scope directory. Using rm -rf (fs.rmSync with
    // recursive:true, force:true) means it's idempotent and tolerates missing files,
    // and it cleans up any intermediate temp files the pipeline may have written into
    // the scope directory, not just the downloaded source video.
    if (sourcePinDir) { try { fs.rmSync(sourcePinDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    if (tempScopeDir) {
      try {
        fs.rmSync(tempScopeDir, { recursive: true, force: true });
        console.log(`[Remix] Cleaned up temp scope: ${tempScopeDir}`);
      } catch {
        // Non-fatal
      }
    }
  }
}

// ── Phase 2C: Re-Render Clip (Steps 4-8 only) ────────────────────

export interface ReRenderModifications {
  newStart?: number;
  newEnd?: number;
  captionsEnabled?: boolean;
  captionStyle?: "highlight" | "brand_callout" | "narrative";
  platformTarget?: string;
}

/**
 * Re-render an existing generated clip with modifications.
 * Runs Steps 4-8 only (INSERT → FORMAT → CAPTION → SCORE → EXPORT).
 * Creates a NEW generatedClip record (does not overwrite the original).
 */
export async function reRenderClip(
  clipId: number,
  modifications: ReRenderModifications
): Promise<RemixResult> {
  console.log(`[Remix Re-Render] Starting re-render for clip ${clipId}`);

  // Load the original clip
  const originalClip = await storage.getClipById(clipId);
  if (!originalClip) {
    return {
      jobId: 0,
      success: false,
      clipsGenerated: 0,
      clipsPublishReady: 0,
      clipsNeedReview: 0,
      clips: [],
      error: `Clip ${clipId} not found`,
    };
  }

  // Load the video
  const video = await storage.getVideoById(originalClip.videoId);
  if (!video) {
    return {
      jobId: 0,
      success: false,
      clipsGenerated: 0,
      clipsPublishReady: 0,
      clipsNeedReview: 0,
      clips: [],
      error: `Video ${originalClip.videoId} not found`,
    };
  }

  // Resolve video path — pull light-cloud imports via the source cache.
  let filePath = video.filePath;
  let rerenderPinDir: string | null = null;
  if (!filePath && video.youtubeId) {
    try {
      const { getPinnedSourcePath } = await import("../sourceCache");
      rerenderPinDir = path.join("/tmp/remix-videos", `rerender-${clipId}-pin-${Date.now()}`);
      filePath = await getPinnedSourcePath(video as any, rerenderPinDir);
    } catch (dlErr: any) {
      return {
        jobId: 0,
        success: false,
        clipsGenerated: 0,
        clipsPublishReady: 0,
        clipsNeedReview: 0,
        clips: [],
        error: `Source download failed: ${dlErr?.message || dlErr}`,
      };
    }
  }
  if (!filePath) {
    return {
      jobId: 0,
      success: false,
      clipsGenerated: 0,
      clipsPublishReady: 0,
      clipsNeedReview: 0,
      clips: [],
      error: "Video has no source",
    };
  }

  let tempScopeDir: string | null = null;
  let videoPath: string;

  try {
    // Unique per-re-render scope — include timestamp so rapid-fire re-renders of the
    // same clip don't collide either.
    const resolved = await resolveVideoPath(filePath, `rerender-${clipId}-${Date.now()}`);
    videoPath = resolved.localPath;
    if (resolved.tempScopeDir) tempScopeDir = resolved.tempScopeDir;
  } catch (err: any) {
    return {
      jobId: 0,
      success: false,
      clipsGenerated: 0,
      clipsPublishReady: 0,
      clipsNeedReview: 0,
      clips: [],
      error: `Failed to resolve video path: ${err.message}`,
    };
  }

  // Determine modified clip boundaries
  const clipStart = modifications.newStart ?? originalClip.clipStart;
  const clipEnd = modifications.newEnd ?? originalClip.clipEnd;
  const duration = clipEnd - clipStart;
  const platform = modifications.platformTarget ?? originalClip.platformTarget ?? "tiktok";
  const captionsEnabled = modifications.captionsEnabled ?? originalClip.captionsEnabled ?? true;
  const captionStyle = modifications.captionStyle ?? "highlight";

  try {
    // Build a ClipCandidate from the modified boundaries
    const clip: ClipCandidate = {
      startTime: clipStart,
      endTime: clipEnd,
      duration,
      score: originalClip.qualityScore ?? 0.5,
      sceneAnalysisIds: [],
      surfaceIds: (originalClip.productPlacements || []).map((p: any) => p.surfaceId).filter(Boolean),
      brandProductIds: (originalClip.productPlacements || []).map((p: any) => p.brandProductId).filter(Boolean),
      primaryTone: "standard",
      narrativeSummary: "",
      platform,
    };

    const platformConfig = PLATFORM_CONFIGS[platform];
    if (!platformConfig) {
      return {
        jobId: originalClip.remixJobId,
        success: false,
        clipsGenerated: 0,
        clipsPublishReady: 0,
        clipsNeedReview: 0,
        clips: [],
        error: `Unknown platform: ${platform}`,
      };
    }

    // ─── Step 4: INSERT — Attach product placements ────────────
    console.log(`[Re-Render] Step 4: Attaching product placements...`);

    const allSurfaces = await storage.getDetectedSurfaces(originalClip.videoId);
    const surfaceMap = new Map(allSurfaces.map(s => [s.id, s]));

    const brandProductList = await storage.getAllBrandProducts();
    const itemMap = new Map(brandProductList.map(i => [i.id, i]));

    // Dense keyframe pre-scan for sparse surfaces (same as main pipeline)
    const MIN_KFS_PER_SEC = 1.5;
    if (clip.surfaceIds.length > 0) {
      const minKfs = Math.ceil(duration * MIN_KFS_PER_SEC);
      const sparseSurfaces: number[] = [];
      for (const sid of clip.surfaceIds) {
        const existing = await storage.getSurfaceKeyframesInRange(sid, clipStart, clipEnd);
        if (existing.length < minKfs) sparseSurfaces.push(sid);
      }
      if (sparseSurfaces.length > 0) {
        try {
          console.log(`[Re-Render]   Running dense scan for ${sparseSurfaces.length} sparse surface(s)...`);
          const { denseScanRange } = await import("../../scanner_v2");
          const dsr = await denseScanRange(originalClip.videoId, clipStart, clipEnd, sparseSurfaces, 0.5);
          console.log(`[Re-Render]   Dense scan created ${dsr.keyframesCreated} keyframes`);
        } catch (e: any) {
          console.warn(`[Re-Render]   Dense scan failed (non-fatal): ${e.message}`);
        }
      }
    }

    const placements: ClipPlacement[] = [];
    for (const surfaceId of clip.surfaceIds) {
      const surface = surfaceMap.get(surfaceId);
      if (!surface) continue;

      const surfaceAnalysis = await storage.getSceneAnalysisBySurface(surfaceId);
      if (!surfaceAnalysis) continue;

      const matches = await storage.getBrandMatchesByScene(surfaceAnalysis.id);
      const approved = matches.find(m => m.approved);
      if (!approved) continue;

      const product = itemMap.get(approved.brandProductId);
      if (!product || !product.imageUrl) continue;

      const imagePath = product.imageUrl.startsWith("/")
        ? path.join(process.cwd(), "public", product.imageUrl)
        : product.imageUrl;

      if (!fs.existsSync(imagePath)) continue;

      // Load motion keyframes
      const keyframeRecords = await storage.getSurfaceKeyframesInRange(
        surfaceId, clip.startTime, clip.endTime
      );
      const keyframes = keyframeRecords.map((kf) => ({
        time: parseFloat(String(kf.timestamp)) - clip.startTime,
        x: parseFloat(String(kf.boundingBoxX)),
        y: parseFloat(String(kf.boundingBoxY)),
        width: parseFloat(String(kf.boundingBoxWidth)),
        height: parseFloat(String(kf.boundingBoxHeight)),
      }));

      const bboxStart = {
        x: parseFloat(String(surface.boundingBoxX)) || 0,
        y: parseFloat(String(surface.boundingBoxY)) || 0,
        width: parseFloat(String(surface.boundingBoxWidth)) || 0.2,
        height: parseFloat(String(surface.boundingBoxHeight)) || 0.2,
      };

      placements.push({
        surfaceId,
        brandProductId: approved.brandProductId,
        productImagePath: imagePath,
        keyframes,
        bboxStart,
        opacity: 0.92,
      });
    }

    console.log(`[Re-Render]   ${placements.length} placement(s)`);

    // ─── Step 4B: VFX Motion Analysis ─────────────────────────
    let reRenderMotionData: import("./motionTracker").CameraMotionData | undefined;
    if (placements.length > 0) {
      try {
        const { analyzeClipMotion } = await import("./motionTracker");
        console.log(`[Re-Render] Running VFX motion analysis (${duration.toFixed(1)}s)...`);
        const motionResult = await analyzeClipMotion(videoPath, clipStart, duration, platformConfig.targetFps);
        if (motionResult && motionResult.transforms.length > 0) {
          reRenderMotionData = motionResult;
          console.log(`[Re-Render]   Motion tracking: ${motionResult.transforms.length} frame transforms`);
        } else {
          console.log(`[Re-Render]   Motion tracking unavailable — using keyframe fallback`);
        }
      } catch (motionErr: any) {
        console.warn(`[Re-Render]   Motion analysis failed (non-fatal): ${motionErr.message}`);
      }
    }

    // ─── Step 5+6: FORMAT + CAPTION ────────────────────────────
    console.log(`[Re-Render] Steps 5-6: Generating clip with captions...`);

    const outputDir = path.join(process.cwd(), "public", "exported-clips", `rerender_${Date.now()}`);
    fs.mkdirSync(outputDir, { recursive: true });

    // Step 6: Generate captions
    let captionSegments = undefined;
    if (captionsEnabled) {
      try {
        // Load transcript for this video's clip range
        const transcript = await storage.getVideoTranscript(originalClip.videoId);
        let clipTranscriptSegments = undefined;
        if (transcript && transcript.status === "completed" && transcript.segments) {
          clipTranscriptSegments = (transcript.segments as any[]).filter(
            (seg: any) => seg.start >= clip.startTime && seg.start <= clip.endTime
          );
        }

        const captionResult = await generateCaptions({
          clipStart: clip.startTime,
          clipEnd: clip.endTime,
          duration: clip.duration,
          narrativeContext: clip.narrativeSummary || "",
          emotionalTone: clip.primaryTone,
          brandNames: clip.brandProductIds.map(id => {
            const item = itemMap.get(id);
            return item?.name || `Product ${id}`;
          }),
          style: captionStyle,
          transcriptSegments: clipTranscriptSegments,
        });
        captionSegments = captionResult.segments;
        console.log(`[Re-Render]   ${captionSegments.length} caption segments`);
      } catch (captionErr) {
        console.warn(`[Re-Render] Caption generation failed (non-fatal)`, captionErr);
      }
    }

    // Step 5: Generate clip (with VFX motion tracking + face reframing if available)
    const clipResult = await generateClip({
      videoPath,
      videoId: originalClip.videoId,
      clip,
      platformConfig,
      placements,
      captionsEnabled: captionsEnabled && !!captionSegments,
      captionSegments,
      captionStyle,
      outputDir,
      jobId: originalClip.remixJobId,
      cameraMotion: reRenderMotionData,
      faceTracking: { enabled: true, sampleIntervalSec: 0.5 },
    });

    if (!clipResult.success) {
      return {
        jobId: originalClip.remixJobId,
        success: false,
        clipsGenerated: 0,
        clipsPublishReady: 0,
        clipsNeedReview: 0,
        clips: [],
        error: `Re-render failed: ${clipResult.error}`,
      };
    }

    // ─── Step 7: SCORE ─────────────────────────────────────────
    console.log(`[Re-Render] Step 7: Scoring re-rendered clip...`);

    const qualityResult = await scoreClipQuality({
      thumbnailPath: clipResult.thumbnailPath,
      clip,
      platform,
      actualDuration: clipResult.duration,
      placementCount: placements.length,
      hasCaptions: captionsEnabled && !!captionSegments,
      fileSize: clipResult.fileSize,
    });

    // ─── Step 8: EXPORT ────────────────────────────────────────
    console.log(`[Re-Render] Step 8: Uploading to Object Storage...`);

    let storagePath: string | null = null;
    let thumbStoragePath: string | null = null;

    if (clipResult.clipPath && fs.existsSync(clipResult.clipPath)) {
      try {
        const clipFilename = path.basename(clipResult.clipPath);
        const objectKey = `public/exported-clips/rerender/${clipFilename}`;
        storagePath = await uploadFileToStorage(clipResult.clipPath, objectKey);
        fs.unlinkSync(clipResult.clipPath);
      } catch (uploadErr: any) {
        console.warn(`[Re-Render] Upload failed (keeping local): ${uploadErr.message}`);
        storagePath = "/" + path.relative(path.join(process.cwd(), "public"), clipResult.clipPath!);
      }
    }

    if (clipResult.thumbnailPath && fs.existsSync(clipResult.thumbnailPath)) {
      try {
        const thumbFilename = path.basename(clipResult.thumbnailPath);
        const objectKey = `public/exported-clips/rerender/${thumbFilename}`;
        thumbStoragePath = await uploadFileToStorage(clipResult.thumbnailPath, objectKey);
        fs.unlinkSync(clipResult.thumbnailPath);
      } catch (uploadErr: any) {
        console.warn(`[Re-Render] Thumbnail upload failed: ${uploadErr.message}`);
        thumbStoragePath = "/" + path.relative(path.join(process.cwd(), "public"), clipResult.thumbnailPath!);
      }
    }

    const clipStatus = qualityResult.recommendation === "publish"
      ? "ready"
      : qualityResult.recommendation === "review"
        ? "pending_review"
        : "rejected";

    // Create NEW clip record (preserves original)
    const dbClip = await storage.createGeneratedClip({
      remixJobId: originalClip.remixJobId,
      videoId: originalClip.videoId,
      clipStart,
      clipEnd,
      duration: clipResult.duration,
      format: "mp4",
      platformTarget: platform,
      productPlacements: placements.map(p => ({
        surfaceId: p.surfaceId,
        brandProductId: p.brandProductId,
        placementId: 0,
      })),
      captionsEnabled,
      qualityScore: qualityResult.overallScore,
      exportPath: storagePath,
      thumbnailPath: thumbStoragePath,
      status: clipStatus,
    });

    console.log(`[Re-Render] Complete — new clip #${dbClip.id} (${qualityResult.recommendation})`);

    return {
      jobId: originalClip.remixJobId,
      success: true,
      clipsGenerated: 1,
      clipsPublishReady: qualityResult.recommendation === "publish" ? 1 : 0,
      clipsNeedReview: qualityResult.recommendation === "review" ? 1 : 0,
      clips: [{
        clipId: dbClip.id,
        platform,
        duration: clipResult.duration,
        qualityScore: qualityResult.overallScore,
        recommendation: qualityResult.recommendation,
        exportPath: storagePath,
        thumbnailPath: thumbStoragePath,
      }],
    };
  } catch (err: any) {
    console.error(`[Re-Render] Failed: ${err.message}`);
    return {
      jobId: originalClip.remixJobId,
      success: false,
      clipsGenerated: 0,
      clipsPublishReady: 0,
      clipsNeedReview: 0,
      clips: [],
      error: err.message,
    };
  } finally {
    if (rerenderPinDir) { try { fs.rmSync(rerenderPinDir, { recursive: true, force: true }); } catch { /* non-fatal */ } }
    if (tempScopeDir) {
      try {
        fs.rmSync(tempScopeDir, { recursive: true, force: true });
      } catch { /* non-fatal */ }
    }
  }
}

/** Get video duration using ffprobe */
async function getVideoDuration(videoPath: string): Promise<number> {
  const { spawn } = await import("child_process");
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_format", videoPath,
    ]);
    let stdout = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.on("close", () => {
      try {
        const info = JSON.parse(stdout);
        resolve(parseFloat(info.format.duration) || 0);
      } catch { resolve(0); }
    });
    proc.on("error", () => resolve(0));
  });
}
