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
 * - Object Storage paths (/storage/...) → download to temp file
 * - Local paths → use directly
 * Returns { localPath, isTempFile } so callers can clean up temp files.
 */
async function resolveVideoPath(
  filePath: string
): Promise<{ localPath: string; isTempFile: boolean }> {
  if (filePath.startsWith("/storage/")) {
    console.log(`[Remix] Resolving Object Storage path: ${filePath}`);
    const objectKey = objectKeyFromServeUrl(filePath);
    const localPath = await downloadToTempFile(objectKey, "/tmp/remix-videos");
    console.log(`[Remix] Downloaded to temp file: ${localPath}`);
    return { localPath, isTempFile: true };
  }

  // Try as a path relative to public dir
  if (filePath.startsWith("/") && !fs.existsSync(filePath)) {
    const publicPath = path.join(process.cwd(), "public", filePath);
    if (fs.existsSync(publicPath)) {
      return { localPath: publicPath, isTempFile: false };
    }
  }

  return { localPath: filePath, isTempFile: false };
}

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

  let tempVideoPath: string | null = null;

  try {
    // Get video info
    const video = await storage.getVideoById(videoId);
    if (!video || !video.filePath) {
      throw new Error("Video not found or no file path");
    }

    // Resolve video path (handles Object Storage download if needed)
    const resolved = await resolveVideoPath(video.filePath);
    const videoPath = resolved.localPath;
    if (resolved.isTempFile) tempVideoPath = videoPath;

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

    // ─── STEP 4: INSERT — Attach product placements ──────────────
    await storage.updateRemixJobStatus(jobId, "step_4_insert");
    console.log(`[Remix] Step 4/9: Attaching product placements to clips...`);

    // Load surfaces (may already be loaded in editorial path, but safe to reload)
    const allSurfaces = await storage.getDetectedSurfaces(videoId);
    const surfaceMap = new Map(allSurfaces.map(s => [s.id, s]));

    // Load brand products (brandMatchScores.brandProductId references brandProducts, not monetizationItems)
    const brandProductList = await storage.getAllBrandProducts();
    const itemMap = new Map(brandProductList.map(i => [i.id, i]));

    const clipPlacements = new Map<number, ClipPlacement[]>();
    for (let i = 0; i < candidates.length; i++) {
      const clip = candidates[i];
      const placements: ClipPlacement[] = [];

      for (const surfaceId of clip.surfaceIds) {
        const surface = surfaceMap.get(surfaceId);
        if (!surface) continue;

        // Find the approved brand match for this surface
        const surfaceAnalysis = await storage.getSceneAnalysisBySurface(surfaceId);
        if (!surfaceAnalysis) continue;

        const matches = await storage.getBrandMatchesByScene(surfaceAnalysis.id);
        const approved = matches.find(m => m.approved);
        if (!approved) continue;

        const product = itemMap.get(approved.brandProductId);
        if (!product) continue;

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
  } finally {
    // Clean up temp video file if downloaded from Object Storage
    if (tempVideoPath) {
      try {
        fs.unlinkSync(tempVideoPath);
        console.log(`[Remix] Cleaned up temp video: ${tempVideoPath}`);
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

  // Resolve video path
  const filePath = video.filePath;
  if (!filePath) {
    return {
      jobId: 0,
      success: false,
      clipsGenerated: 0,
      clipsPublishReady: 0,
      clipsNeedReview: 0,
      clips: [],
      error: "Video has no file path",
    };
  }

  let tempVideoPath: string | null = null;
  let videoPath: string;

  try {
    const resolved = await resolveVideoPath(filePath);
    videoPath = resolved.localPath;
    if (resolved.isTempFile) tempVideoPath = resolved.localPath;
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

    // Step 5: Generate clip
    const clipResult = await generateClip({
      videoPath,
      videoId: originalClip.videoId,
      clip,
      platformConfig,
      placements,
      captionsEnabled: captionsEnabled && !!captionSegments,
      captionSegments,
      outputDir,
      jobId: originalClip.remixJobId,
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
    if (tempVideoPath) {
      try {
        fs.unlinkSync(tempVideoPath);
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
