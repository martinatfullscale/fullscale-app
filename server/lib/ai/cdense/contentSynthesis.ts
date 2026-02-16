/**
 * Content Synthesis — End-to-End Asset Generation Pipeline
 *
 * Orchestrates the full flow from placement decision → asset generation →
 * style transfer → compositing → quality evaluation. This is the top-level
 * entry point that scanner_v2.ts calls when a surface needs a generated asset.
 *
 * Pipeline steps:
 * 1. Generate product asset via Seeddance 2.0
 * 2. Apply style transfer to match scene aesthetic
 * 3. Composite asset onto frame
 * 4. Evaluate quality with Claude
 * 5. Return result with approval status
 */

import * as path from "path";
import * as fs from "fs";
import { generateProductAsset, type AssetGenerationInput } from "../image-gen/assetGenerator";
import { applyStyleTransfer } from "../image-gen/styleTransfer";
import { compositeAssetOnFrame, generateComparisonPreview } from "../image-gen/compositing";
import { evaluateComposite } from "./sceneEnhancer";

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
  /** Lighting info for style transfer */
  lightingDirection: string;
  /** Path to the source video frame */
  framePath: string;
  /** Frame dimensions */
  frameDimensions: { width: number; height: number };
  /** Skip quality evaluation (faster, for batch mode) */
  skipEvaluation?: boolean;
}

export interface SynthesisOutput {
  success: boolean;
  /** Path to the generated product asset */
  assetPath: string | null;
  /** Path to the composite (asset on frame) */
  compositePath: string | null;
  /** Path to side-by-side comparison preview */
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
  /** Style adjustments applied */
  styleAdjustments: {
    brightnessShift: number;
    warmthShift: number;
    contrastMultiplier: number;
  } | null;
  error?: string;
}

const AUTO_APPROVE_QUALITY = 0.75;

/**
 * Run the full content synthesis pipeline for a single surface.
 */
export async function synthesizeContent(input: SynthesisInput): Promise<SynthesisOutput> {
  const emptyResult: SynthesisOutput = {
    success: false,
    assetPath: null,
    compositePath: null,
    comparisonPath: null,
    evaluation: null,
    prompt: "",
    styleAdjustments: null,
  };

  try {
    console.log(`[Synthesis] Starting pipeline for video ${input.videoId}, surface ${input.surfaceId}, product "${input.brandProduct.name}"`);

    // Step 1: Generate product asset via Seeddance 2.0
    console.log("[Synthesis] Step 1/5: Generating product asset...");
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
    };

    const genResult = await generateProductAsset(assetInput);
    if (!genResult.success || !genResult.assetPath) {
      return { ...emptyResult, prompt: genResult.prompt, error: genResult.error };
    }

    // Resolve the full path from the relative path
    const fullAssetPath = path.join(process.cwd(), "public", genResult.assetPath.replace(/^\//, ""));

    // Step 2: Apply style transfer
    console.log("[Synthesis] Step 2/5: Applying style transfer...");
    const styleResult = await applyStyleTransfer({
      assetPath: fullAssetPath,
      sceneAesthetic: input.sceneAesthetic,
      lightingDirection: input.lightingDirection,
    });

    // Step 3: Composite onto frame
    console.log("[Synthesis] Step 3/5: Compositing onto frame...");
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
    console.log("[Synthesis] Step 4/5: Generating comparison preview...");
    const comparisonPath = path.join(outputDir, `comparison_v${input.videoId}_s${input.surfaceId}_${Date.now()}.jpg`);
    await generateComparisonPreview(input.framePath, compositeResult.compositePath, comparisonPath);

    // Step 5: Quality evaluation (optional)
    let evaluation: SynthesisOutput["evaluation"] = null;

    if (!input.skipEvaluation) {
      console.log("[Synthesis] Step 5/5: Evaluating quality...");
      try {
        const compositeBase64 = fs.readFileSync(compositeResult.compositePath).toString("base64");
        const originalBase64 = fs.readFileSync(input.framePath).toString("base64");

        const evalResult = await evaluateComposite({
          compositeBase64,
          originalBase64,
          productName: input.brandProduct.name,
          placementStyle: "generated asset",
          narrativeContext: input.sceneContext.narrativeContext,
        });

        evaluation = {
          qualityScore: evalResult.qualityScore,
          naturalness: evalResult.naturalness,
          assessment: evalResult.assessment,
          needsManualReview: evalResult.needsManualReview || evalResult.qualityScore < AUTO_APPROVE_QUALITY,
        };
      } catch (evalErr) {
        console.warn("[Synthesis] Quality evaluation failed, marking for manual review:", evalErr);
        evaluation = {
          qualityScore: 0,
          naturalness: 0,
          assessment: "Evaluation failed — manual review required",
          needsManualReview: true,
        };
      }
    } else {
      console.log("[Synthesis] Step 5/5: Skipped (skipEvaluation=true)");
    }

    // Convert paths to relative for storage
    const publicDir = path.join(process.cwd(), "public");
    const relativeComposite = "/" + path.relative(publicDir, compositeResult.compositePath);
    const relativeComparison = "/" + path.relative(publicDir, comparisonPath);

    console.log(`[Synthesis] Pipeline complete. Quality: ${evaluation ? (evaluation.qualityScore * 100).toFixed(0) + "%" : "N/A"}`);

    return {
      success: true,
      assetPath: genResult.assetPath,
      compositePath: relativeComposite,
      comparisonPath: relativeComparison,
      evaluation,
      prompt: genResult.prompt,
      styleAdjustments: styleResult.adjustments,
    };
  } catch (err: any) {
    console.error("[Synthesis] Pipeline error:", err);
    return { ...emptyResult, error: err.message };
  }
}

/**
 * Run synthesis for multiple surfaces in series (to respect API rate limits).
 */
export async function batchSynthesize(
  inputs: SynthesisInput[]
): Promise<Array<{ surfaceId: number; result: SynthesisOutput }>> {
  const results: Array<{ surfaceId: number; result: SynthesisOutput }> = [];

  for (const input of inputs) {
    const result = await synthesizeContent(input);
    results.push({ surfaceId: input.surfaceId, result });

    // Small delay between API calls to respect rate limits
    if (inputs.indexOf(input) < inputs.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return results;
}

export { AUTO_APPROVE_QUALITY };
