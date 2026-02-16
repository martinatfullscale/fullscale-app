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
 * Called by POST /api/remix/:videoId/start route.
 */

import * as path from "path";
import * as fs from "fs";
import { storage } from "../../storage";
import { detectClipCandidates, PLATFORM_CONFIGS, type ClipCandidate } from "./clipDetector";
import { generateClip, type ClipPlacement } from "./clipGenerator";
import { generateCaptions } from "./captionEngine";
import { scoreClipQuality } from "./qualityScorer";

export interface RemixConfig {
  minClipDuration: number;
  maxClipDuration: number;
  maxClips: number;
  platformTargets: string[];
  captionsEnabled: boolean;
  captionStyle: "highlight" | "brand_callout" | "narrative";
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
}

const DEFAULT_CONFIG: RemixConfig = {
  minClipDuration: 15,
  maxClipDuration: 60,
  maxClips: 5,
  platformTargets: ["tiktok", "youtube_shorts"],
  captionsEnabled: true,
  captionStyle: "highlight",
};

/**
 * Run the full 9-step Auto-Remix pipeline.
 */
export async function runRemixPipeline(
  videoId: number,
  userId: number,
  config: Partial<RemixConfig> = {}
): Promise<RemixResult> {
  const mergedConfig: RemixConfig = { ...DEFAULT_CONFIG, ...config };

  // Create the remix job record
  const job = await storage.createRemixJob({
    videoId,
    userId,
    status: "processing",
    config: mergedConfig,
    platformTargets: mergedConfig.platformTargets,
  });

  const jobId = job.id;

  console.log(`[Remix] ========== STARTING REMIX JOB ${jobId} ==========`);
  console.log(`[Remix] Video: ${videoId}, Platforms: ${mergedConfig.platformTargets.join(", ")}, Max clips: ${mergedConfig.maxClips}`);

  try {
    // Get video info
    const video = await storage.getVideoById(videoId);
    if (!video || !video.localFilePath) {
      throw new Error("Video not found or no local file path");
    }

    const videoPath = video.localFilePath;
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    // Get video duration from ffprobe
    const videoDuration = await getVideoDuration(videoPath);
    console.log(`[Remix] Video duration: ${videoDuration.toFixed(1)}s`);

    // ─── STEP 1: IDENTIFY — Load narrative analyses ───────────────
    await storage.updateRemixJobStatus(jobId, "step_1_identify");
    console.log(`[Remix] Step 1/9: Identifying high-viability moments...`);

    const analyses = await storage.getSceneAnalysisByVideo(videoId);
    if (analyses.length === 0) {
      throw new Error("No scene analyses found. Run Claude Dense analysis first.");
    }

    const surfaces = await storage.getSurfacesForVideo(videoId);
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
    console.log(`[Remix] Step 2/9: Extracting clip candidates...`);

    const candidates = detectClipCandidates(
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

    // Already scored by clipDetector, just log rankings
    for (const [i, clip] of candidates.entries()) {
      console.log(`[Remix]   #${i + 1}: ${clip.platform} ${clip.startTime.toFixed(1)}s-${clip.endTime.toFixed(1)}s (score: ${(clip.score * 100).toFixed(0)}%)`);
    }

    // ─── STEP 4: INSERT — Attach product placements ──────────────
    await storage.updateRemixJobStatus(jobId, "step_4_insert");
    console.log(`[Remix] Step 4/9: Attaching product placements to clips...`);

    const items = await storage.getMonetizationItems();
    const itemMap = new Map(items.map(i => [i.id, i]));

    const clipPlacements = new Map<number, ClipPlacement[]>();
    for (let i = 0; i < candidates.length; i++) {
      const clip = candidates[i];
      const placements: ClipPlacement[] = [];

      for (const surfaceId of clip.surfaceIds) {
        const surface = surfaceMap.get(surfaceId);
        if (!surface) continue;

        // Find the approved brand match for this surface
        const surfaceAnalyses = analyses.filter(a => a.surfaceId === surfaceId);
        for (const sa of surfaceAnalyses) {
          const matches = await storage.getBrandMatchesByScene(sa.id);
          const approved = matches.find(m => m.approved);
          if (!approved) continue;

          const product = itemMap.get(approved.brandProductId);
          if (!product || !product.imageUrl) continue;

          // Resolve product image path
          const imagePath = product.imageUrl.startsWith("/")
            ? path.join(process.cwd(), "public", product.imageUrl)
            : product.imageUrl;

          if (!fs.existsSync(imagePath)) continue;

          placements.push({
            surfaceId,
            brandProductId: approved.brandProductId,
            productImagePath: imagePath,
            bboxStart: {
              x: surface.bboxX || 0,
              y: surface.bboxY || 0,
              width: surface.bboxWidth || 0.2,
              height: surface.bboxHeight || 0.2,
            },
            opacity: 0.92,
          });
        }
      }

      clipPlacements.set(i, placements);
      console.log(`[Remix]   Clip #${i + 1}: ${placements.length} product placement(s)`);
    }

    // ─── STEP 5+6: FORMAT + CAPTION — Generate clips ─────────────
    await storage.updateRemixJobStatus(jobId, "step_5_format");
    console.log(`[Remix] Steps 5-6/9: Generating and captioning clips...`);

    const outputDir = path.join(process.cwd(), "public", "exported-clips", jobId.toString());
    fs.mkdirSync(outputDir, { recursive: true });

    const generatedClips: RemixResult["clips"] = [];

    for (let i = 0; i < candidates.length; i++) {
      const clip = candidates[i];
      const platformConfig = PLATFORM_CONFIGS[clip.platform];
      if (!platformConfig) continue;

      const placements = clipPlacements.get(i) || [];

      // Step 6: Generate captions
      let captionSegments = undefined;
      if (mergedConfig.captionsEnabled) {
        try {
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
          });
          captionSegments = captionResult.segments;
          console.log(`[Remix]   Clip #${i + 1}: ${captionSegments.length} caption segments`);
        } catch (captionErr) {
          console.warn(`[Remix]   Clip #${i + 1}: Caption generation failed (non-fatal)`, captionErr);
        }
      }

      // Step 5: Generate the clip
      console.log(`[Remix]   Generating clip #${i + 1}/${candidates.length} (${clip.platform})...`);

      const clipResult = await generateClip({
        videoPath,
        videoId,
        clip,
        platformConfig,
        placements,
        captionsEnabled: mergedConfig.captionsEnabled && !!captionSegments,
        captionSegments,
        outputDir,
        jobId,
      });

      if (!clipResult.success) {
        console.error(`[Remix]   Clip #${i + 1} generation failed: ${clipResult.error}`);
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
      });

      // ─── STEP 8: EXPORT — Save to DB ───────────────────────────
      console.log(`[Remix] Step 8/9: Saving clip #${i + 1} to database...`);

      const relativePath = clipResult.clipPath
        ? "/" + path.relative(path.join(process.cwd(), "public"), clipResult.clipPath)
        : null;
      const relativeThumb = clipResult.thumbnailPath
        ? "/" + path.relative(path.join(process.cwd(), "public"), clipResult.thumbnailPath)
        : null;

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
        exportPath: relativePath,
        thumbnailPath: relativeThumb,
        status: clipStatus,
      });

      generatedClips.push({
        clipId: dbClip.id,
        platform: clip.platform,
        duration: clipResult.duration,
        qualityScore: qualityResult.overallScore,
        recommendation: qualityResult.recommendation,
        exportPath: relativePath,
        thumbnailPath: relativeThumb,
      });
    }

    // ─── STEP 9: DISTRIBUTE — Mark job complete ──────────────────
    console.log(`[Remix] Step 9/9: Finalizing distribution status...`);

    const publishReady = generatedClips.filter(c => c.recommendation === "publish").length;
    const needReview = generatedClips.filter(c => c.recommendation === "review").length;

    await storage.updateRemixJobStatus(jobId, "completed");
    // Update clip count on the job
    // (storage method doesn't have a dedicated update for this, use status update)

    console.log(`[Remix] ========== REMIX JOB ${jobId} COMPLETE ==========`);
    console.log(`[Remix] Generated: ${generatedClips.length} clips`);
    console.log(`[Remix] Publish-ready: ${publishReady}, Needs review: ${needReview}`);

    return {
      jobId,
      success: true,
      clipsGenerated: generatedClips.length,
      clipsPublishReady: publishReady,
      clipsNeedReview: needReview,
      clips: generatedClips,
    };
  } catch (err: any) {
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
