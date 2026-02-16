/**
 * Content Synthesis — End-to-End Asset Generation Pipeline
 *
 * Orchestrates the full flow from placement decision → video generation →
 * optional compositing → quality evaluation. This is the top-level
 * entry point that scanner_v2.ts calls when a surface needs generated content.
 *
 * Pipeline steps (Video mode — Seeddance 2.0):
 * 1. Generate product video clip via Seeddance 2.0
 * 2. (Optional) Evaluate quality with Claude vision
 * 3. Return result with approval status
 *
 * Pipeline steps (Image mode — legacy/fallback):
 * 1. Generate product asset image
 * 2. Apply style transfer to match scene aesthetic
 * 3. Composite asset onto frame
 * 4. Generate comparison preview
 * 5. Evaluate quality with Claude
 *
 * NOTE: Seeddance 2.0 API is not yet available. When no API key is set,
 * the pipeline creates placeholder metadata files and still runs the
 * quality evaluation step (if enabled) for pipeline testing.
 */

import * as path from "path";
import * as fs from "fs";
import { generateProductAsset, type AssetGenerationInput, type AssetGenerationOutput } from "../image-gen/assetGenerator";
import { applyStyleTransfer } from "../image-gen/styleTransfer";
import { compositeAssetOnFrame, generateComparisonPreview } from "../image-gen/compositing";
import { evaluateComposite } from "./sceneEnhancer";

// ─── Types ──────────────────────────────────────────────────────

export interface SynthesisInput {
  videoId: number;
  surfaceId: number;
  /** Brand product to generate */
  brandProduct: {
    id: number;
    name: string;
    category: string | null;
  };
  /** Scene context from narrative analysis */
  sceneContext: {
    narrativeContext: string;
    emotionalTone: string;
    culturalTags: string[];
    suggestedProductCategories: string[];
  };
  /** Surface geometry */
  surfaceBbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Scene visual properties */
  sceneAesthetic: {
    colorWarmth: number;
    brightness: { overall: number; top: number; bottom: number };
    dominantColors: string[];
  };
  /** Lighting info for style transfer (image mode only) */
  lightingDirection: string;
  /** Path to the source video frame */
  framePath: string;
  /** Frame dimensions */
  frameDimensions: { width: number; height: number };
  /** Skip quality evaluation (faster, for batch mode) */
  skipEvaluation?: boolean;
  /** Target platform for video generation aspect ratio / duration */
  targetPlatform?: string;
}

export interface SynthesisOutput {
  success: boolean;
  /** Path to the generated asset (video MP4 or image PNG) */
  assetPath: string | null;
  /** Asset type: "video" for Seeddance 2.0, "image" for legacy */
  assetType: "video" | "image" | "placeholder";
  /** Path to the composite (asset on frame) — image mode only */
  compositePath: string | null;
  /** Path to side-by-side comparison preview — image mode only */
  comparisonPath: string | null;
  /** Quality evaluation results */
  evaluation: {
    qualityScore: number;
    naturalness: number;
    assessment: string;
    needsManualReview: boolean;
  } | null;
  /** Prompt used for generation */
  prompt: string;
  /** Seeddance job ID — video mode only */
  jobId: string | null;
  /** Video duration in seconds — video mode only */
  videoDuration: number | null;
  /** Video aspect ratio — video mode only */
  videoAspectRatio: string | null;
  /** Style adjustments applied — image mode only */
  styleAdjustments: {
    brightnessShift: number;
    warmthShift: number;
    contrastMultiplier: number;
  } | null;
  error?: string;
}

const AUTO_APPROVE_QUALITY = 0.75;

// ─── Main Pipeline ──────────────────────────────────────────────

/**
 * Run the full content synthesis pipeline for a single surface.
 *
 * Automatically determines whether to run video mode (Seeddance 2.0)
 * or image mode (legacy) based on the asset generator output.
 */
export async function synthesizeContent(input: SynthesisInput): Promise<SynthesisOutput> {
  const emptyResult: SynthesisOutput = {
    success: false,
    assetPath: null,
    assetType: "placeholder",
    compositePath: null,
    comparisonPath: null,
    evaluation: null,
    prompt: "",
    jobId: null,
    videoDuration: null,
    videoAspectRatio: null,
    styleAdjustments: null,
  };

  try {
    console.log(`[Synthesis] Starting pipeline for video ${input.videoId}, surface ${input.surfaceId}, product "${input.brandProduct.name}"`);

    // Step 1: Generate product asset via Seeddance 2.0
    console.log("[Synthesis] Step 1: Generating product asset via Seeddance 2.0...");
    const assetInput: AssetGenerationInput = {
      videoId: input.videoId,
      surfaceId: input.surfaceId,
      brandProduct: input.brandProduct,
      sceneContext: input.sceneContext,
      surfaceDimensions: {
        width: Math.round(input.surfaceBbox.width * input.frameDimensions.width),
        height: Math.round(input.surfaceBbox.height * input.frameDimensions.height),
        aspectRatio: input.surfaceBbox.width / Math.max(input.surfaceBbox.height, 0.001),
      },
      sceneAesthetic: input.sceneAesthetic,
      targetPlatform: input.targetPlatform,
    };

    const genResult = await generateProductAsset(assetInput);

    if (!genResult.success || !genResult.assetPath) {
      return { ...emptyResult, prompt: genResult.prompt, error: genResult.error };
    }

    // Determine asset type from generator output
    const isVideo = genResult.assetType === "video" && genResult.assetPath.endsWith(".mp4");
    const isPlaceholder = genResult.assetPath.endsWith(".json");

    if (isVideo) {
      // ── Video Mode Pipeline ──────────────────────────────────
      return await runVideoPipeline(input, genResult);
    } else if (isPlaceholder) {
      // ── Placeholder Mode (API not available) ─────────────────
      return await runPlaceholderPipeline(input, genResult);
    } else {
      // ── Image Mode Pipeline (legacy fallback) ────────────────
      return await runImagePipeline(input, genResult);
    }
  } catch (err: any) {
    console.error("[Synthesis] Pipeline error:", err);
    return { ...emptyResult, error: err.message };
  }
}

// ─── Video Pipeline ─────────────────────────────────────────────

/**
 * Video mode: Seeddance generated an MP4 clip.
 * No compositing needed — the video IS the asset.
 * Optional quality evaluation with Claude vision (on a frame extract).
 */
async function runVideoPipeline(
  input: SynthesisInput,
  genResult: AssetGenerationOutput
): Promise<SynthesisOutput> {
  console.log("[Synthesis] Running video pipeline (Seeddance 2.0 output)");

  let evaluation: SynthesisOutput["evaluation"] = null;

  // Quality evaluation: use Claude to evaluate a representative frame
  // For video assets we can't directly evaluate, but we can send the
  // original frame context + prompt for narrative coherence scoring
  if (!input.skipEvaluation && process.env.ANTHROPIC_API_KEY) {
    console.log("[Synthesis] Evaluating video asset quality...");
    try {
      const originalBase64 = fs.readFileSync(input.framePath).toString("base64");

      const evalResult = await evaluateComposite({
        compositeBase64: originalBase64, // Use original frame as context
        originalBase64,
        productName: input.brandProduct.name,
        placementStyle: "generated video clip (text-to-video)",
        narrativeContext: `${input.sceneContext.narrativeContext}. Video prompt: ${genResult.prompt.substring(0, 200)}`,
      });

      evaluation = {
        qualityScore: evalResult.qualityScore,
        naturalness: evalResult.naturalness,
        assessment: `[Video Asset] ${evalResult.assessment}`,
        needsManualReview: evalResult.needsManualReview || evalResult.qualityScore < AUTO_APPROVE_QUALITY,
      };
    } catch (evalErr) {
      console.warn("[Synthesis] Video quality evaluation failed:", evalErr);
      evaluation = {
        qualityScore: 0.5,
        naturalness: 0.5,
        assessment: "Video quality evaluation not available — manual review recommended",
        needsManualReview: true,
      };
    }
  }

  const duration = genResult.duration || genResult.promptDetails?.duration || null;
  const aspectRatio = genResult.promptDetails?.aspectRatio || null;

  console.log(`[Synthesis] Video pipeline complete. Asset: ${genResult.assetPath}, Duration: ${duration}s, AR: ${aspectRatio}`);

  return {
    success: true,
    assetPath: genResult.assetPath,
    assetType: "video",
    compositePath: null, // No compositing for video assets
    comparisonPath: null,
    evaluation,
    prompt: genResult.prompt,
    jobId: genResult.jobId,
    videoDuration: duration,
    videoAspectRatio: aspectRatio,
    styleAdjustments: null,
  };
}

// ─── Placeholder Pipeline ───────────────────────────────────────

/**
 * Placeholder mode: Seeddance API not available.
 * Returns metadata about what WOULD have been generated.
 * Still runs quality evaluation on the scene context for testing.
 */
async function runPlaceholderPipeline(
  input: SynthesisInput,
  genResult: AssetGenerationOutput
): Promise<SynthesisOutput> {
  console.log("[Synthesis] Running placeholder pipeline (Seeddance API not available)");

  let evaluation: SynthesisOutput["evaluation"] = null;

  // Even in placeholder mode, we can evaluate the scene for testing
  if (!input.skipEvaluation && process.env.ANTHROPIC_API_KEY) {
    console.log("[Synthesis] Evaluating scene context (placeholder mode)...");
    try {
      const originalBase64 = fs.readFileSync(input.framePath).toString("base64");

      const evalResult = await evaluateComposite({
        compositeBase64: originalBase64,
        originalBase64,
        productName: input.brandProduct.name,
        placementStyle: "future video generation (placeholder)",
        narrativeContext: input.sceneContext.narrativeContext,
      });

      evaluation = {
        qualityScore: evalResult.qualityScore,
        naturalness: evalResult.naturalness,
        assessment: `[Placeholder] Scene evaluation for future video gen: ${evalResult.assessment}`,
        needsManualReview: true, // Always review placeholders
      };
    } catch {
      evaluation = {
        qualityScore: 0,
        naturalness: 0,
        assessment: "Placeholder — Seeddance 2.0 API not yet available. Scene evaluation pending.",
        needsManualReview: true,
      };
    }
  } else {
    evaluation = {
      qualityScore: 0,
      naturalness: 0,
      assessment: "Placeholder — Seeddance 2.0 API not yet available",
      needsManualReview: true,
    };
  }

  const duration = genResult.promptDetails?.duration || null;
  const aspectRatio = genResult.promptDetails?.aspectRatio || null;

  console.log(`[Synthesis] Placeholder pipeline complete. Metadata: ${genResult.assetPath}`);

  return {
    success: true,
    assetPath: genResult.assetPath,
    assetType: "placeholder",
    compositePath: null,
    comparisonPath: null,
    evaluation,
    prompt: genResult.prompt,
    jobId: genResult.jobId,
    videoDuration: duration,
    videoAspectRatio: aspectRatio,
    styleAdjustments: null,
  };
}

// ─── Image Pipeline (Legacy) ────────────────────────────────────

/**
 * Image mode: legacy pipeline for static image compositing.
 * Used if a future image generation provider is swapped in.
 */
async function runImagePipeline(
  input: SynthesisInput,
  genResult: AssetGenerationOutput
): Promise<SynthesisOutput> {
  console.log("[Synthesis] Running image pipeline (legacy mode)");

  const fullAssetPath = path.join(process.cwd(), "public", genResult.assetPath!.replace(/^\//, ""));

  // Step 2: Apply style transfer
  console.log("[Synthesis] Applying style transfer...");
  const styleResult = await applyStyleTransfer({
    assetPath: fullAssetPath,
    sceneAesthetic: input.sceneAesthetic,
    lightingDirection: input.lightingDirection,
  });

  // Step 3: Composite onto frame
  console.log("[Synthesis] Compositing onto frame...");
  const outputDir = path.join(process.cwd(), "public", "generated-assets", input.videoId.toString());
  const compositeResult = await compositeAssetOnFrame({
    framePath: input.framePath,
    assetPath: fullAssetPath,
    surfaceBbox: input.surfaceBbox,
    frameDimensions: input.frameDimensions,
    outputDir,
    videoId: input.videoId,
    surfaceId: input.surfaceId,
  });

  // Step 4: Generate comparison preview
  console.log("[Synthesis] Generating comparison preview...");
  const comparisonPath = path.join(outputDir, `comparison_v${input.videoId}_s${input.surfaceId}_${Date.now()}.jpg`);
  await generateComparisonPreview(input.framePath, compositeResult.compositePath, comparisonPath);

  // Step 5: Quality evaluation
  let evaluation: SynthesisOutput["evaluation"] = null;

  if (!input.skipEvaluation) {
    console.log("[Synthesis] Evaluating composite quality...");
    try {
      const compositeBase64 = fs.readFileSync(compositeResult.compositePath).toString("base64");
      const originalBase64 = fs.readFileSync(input.framePath).toString("base64");

      const evalResult = await evaluateComposite({
        compositeBase64,
        originalBase64,
        productName: input.brandProduct.name,
        placementStyle: "generated image asset",
        narrativeContext: input.sceneContext.narrativeContext,
      });

      evaluation = {
        qualityScore: evalResult.qualityScore,
        naturalness: evalResult.naturalness,
        assessment: evalResult.assessment,
        needsManualReview: evalResult.needsManualReview || evalResult.qualityScore < AUTO_APPROVE_QUALITY,
      };
    } catch (evalErr) {
      console.warn("[Synthesis] Quality evaluation failed:", evalErr);
      evaluation = {
        qualityScore: 0,
        naturalness: 0,
        assessment: "Evaluation failed — manual review required",
        needsManualReview: true,
      };
    }
  }

  // Convert paths to relative
  const publicDir = path.join(process.cwd(), "public");
  const relativeComposite = "/" + path.relative(publicDir, compositeResult.compositePath);
  const relativeComparison = "/" + path.relative(publicDir, comparisonPath);

  console.log(`[Synthesis] Image pipeline complete. Quality: ${evaluation ? (evaluation.qualityScore * 100).toFixed(0) + "%" : "N/A"}`);

  return {
    success: true,
    assetPath: genResult.assetPath,
    assetType: "image",
    compositePath: relativeComposite,
    comparisonPath: relativeComparison,
    evaluation,
    prompt: genResult.prompt,
    jobId: null,
    videoDuration: null,
    videoAspectRatio: null,
    styleAdjustments: styleResult.adjustments,
  };
}

// ─── Batch Processing ───────────────────────────────────────────

/**
 * Run synthesis for multiple surfaces in series (to respect API rate limits).
 */
export async function batchSynthesize(
  inputs: SynthesisInput[]
): Promise<Array<{ surfaceId: number; result: SynthesisOutput }>> {
  const results: Array<{ surfaceId: number; result: SynthesisOutput }> = [];

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const result = await synthesizeContent(input);
    results.push({ surfaceId: input.surfaceId, result });

    // Delay between API calls to respect rate limits
    if (i < inputs.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2s between video gen jobs
    }
  }

  return results;
}

export { AUTO_APPROVE_QUALITY };
