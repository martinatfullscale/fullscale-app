/**
 * CDense Connector — Bridge between Claude Dense analysis and Scene Enhancement
 *
 * Orchestrates the flow from narrative analysis results to scene enhancement
 * decisions. Determines which scenes are candidates for enhancement (plus-up)
 * vs standard overlay placement.
 *
 * Decision logic:
 * - High viability (>0.7) + matched brand → standard overlay
 * - Moderate viability (0.4-0.7) + no natural product moment → generate asset
 * - Low viability (<0.4) → skip or flag for manual review
 */

import type { NarrativeAnalysisOutput, BrandMatchOutput } from "../claude-dense/types";
import type { AssetGenerationInput } from "../image-gen/assetGenerator";

export type PlacementDecision =
  | { type: "standard_overlay"; reason: string }
  | { type: "generate_asset"; reason: string; generationInput: Omit<AssetGenerationInput, "videoId"> }
  | { type: "skip"; reason: string }
  | { type: "manual_review"; reason: string };

export interface DecisionContext {
  videoId: number;
  surfaceId: number;
  narrativeAnalysis: NarrativeAnalysisOutput;
  brandMatches: BrandMatchOutput;
  surfaceDetails: {
    surfaceType: string;
    boundingBox: { x: number; y: number; width: number; height: number };
    confidence: number;
    lightingDirection: string;
  };
  sceneAesthetic: {
    colorWarmth: number;
    brightness: { overall: number; top: number; bottom: number };
    dominantColors: string[];
  };
  hasExistingPlacement: boolean;
  scanMode: "standard" | "autoRemix";
}

const VIABILITY_HIGH = 0.7;
const VIABILITY_LOW = 0.4;
const BRAND_MATCH_THRESHOLD = 0.6;

/**
 * Decide what to do with a surface based on narrative analysis and brand matches.
 */
export function decidePlacement(ctx: DecisionContext): PlacementDecision {
  const { narrativeAnalysis, brandMatches, surfaceDetails, hasExistingPlacement, scanMode } = ctx;
  const viability = narrativeAnalysis.placementViability;

  // If surface already has a placement, skip generation
  if (hasExistingPlacement) {
    return { type: "skip", reason: "Surface already has an active placement" };
  }

  // Low confidence surface — skip
  if (surfaceDetails.confidence < 0.5) {
    return { type: "skip", reason: `Surface confidence too low (${(surfaceDetails.confidence * 100).toFixed(0)}%)` };
  }

  // High viability with strong brand matches → standard overlay
  const topMatch = brandMatches.matches[0];
  if (viability >= VIABILITY_HIGH && topMatch && topMatch.compatibilityScore >= BRAND_MATCH_THRESHOLD) {
    return {
      type: "standard_overlay",
      reason: `High viability (${(viability * 100).toFixed(0)}%) with compatible brand match (${(topMatch.compatibilityScore * 100).toFixed(0)}%)`,
    };
  }

  // Moderate viability — generate an asset if in autoRemix mode
  if (viability >= VIABILITY_LOW && scanMode === "autoRemix") {
    const bestBrand = topMatch || null;
    if (!bestBrand) {
      return {
        type: "manual_review",
        reason: `Moderate viability (${(viability * 100).toFixed(0)}%) but no brand matches — needs manual brand selection`,
      };
    }

    const bbox = surfaceDetails.boundingBox;
    return {
      type: "generate_asset",
      reason: `Moderate viability (${(viability * 100).toFixed(0)}%) — generating product asset for "${bestBrand.brandProductId}"`,
      generationInput: {
        surfaceId: ctx.surfaceId,
        brandProduct: {
          id: bestBrand.brandProductId,
          name: `Product #${bestBrand.brandProductId}`,
          category: null,
        },
        sceneContext: {
          narrativeContext: narrativeAnalysis.narrativeContext,
          emotionalTone: narrativeAnalysis.emotionalTone,
          culturalTags: narrativeAnalysis.culturalTags,
          suggestedProductCategories: narrativeAnalysis.suggestedProductCategories,
        },
        surfaceDimensions: {
          width: Math.round(bbox.width * 1920), // Assuming 1080p reference
          height: Math.round(bbox.height * 1080),
          aspectRatio: bbox.width / Math.max(bbox.height, 0.001),
        },
        sceneAesthetic: ctx.sceneAesthetic,
      },
    };
  }

  // Standard mode with moderate viability — suggest manual review
  if (viability >= VIABILITY_LOW && scanMode === "standard") {
    return {
      type: "manual_review",
      reason: `Moderate viability (${(viability * 100).toFixed(0)}%) in standard mode — needs manual approval for generation`,
    };
  }

  // Low viability — skip
  return {
    type: "skip",
    reason: `Low placement viability (${(viability * 100).toFixed(0)}%) — scene not suitable for product placement`,
  };
}

/**
 * Process all surfaces for a video and return decisions.
 */
export function batchDecide(
  contexts: DecisionContext[]
): Array<{ surfaceId: number; decision: PlacementDecision }> {
  return contexts.map(ctx => ({
    surfaceId: ctx.surfaceId,
    decision: decidePlacement(ctx),
  }));
}

export { VIABILITY_HIGH, VIABILITY_LOW, BRAND_MATCH_THRESHOLD };
