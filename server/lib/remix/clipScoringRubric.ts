/**
 * Clip Scoring Rubric — 7-dimension weighted scoring for editorial clip quality.
 *
 * Evaluates each potential clip moment against:
 * 1. Hook Strength (20%) — Do the first 3 seconds grab attention?
 * 2. Narrative Completeness (20%) — Complete thought/story beat?
 * 3. Emotional Arc (15%) — Emotional shift within the clip?
 * 4. Speaker Clarity (10%) — Clear, articulate primary speaker?
 * 5. Surface Compatibility (15%) — Product placement opportunity?
 * 6. Cultural Relevance (10%) — Brand-safe and relatable?
 * 7. Replayability (10%) — Would someone watch twice or share?
 *
 * Produces a composite score (0-1) used to rank clips before extraction.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface RubricScores {
  hookStrength: number;            // 0-1
  narrativeCompleteness: number;   // 0-1
  emotionalArc: number;            // 0-1
  speakerClarity: number;          // 0-1
  surfaceCompatibility: number;    // 0-1
  culturalRelevance: number;       // 0-1
  replayability: number;           // 0-1
}

export interface RubricWeights {
  hookStrength: number;
  narrativeCompleteness: number;
  emotionalArc: number;
  speakerClarity: number;
  surfaceCompatibility: number;
  culturalRelevance: number;
  replayability: number;
}

export interface ScoredClipMoment {
  clipStart: number;               // seconds
  clipEnd: number;                 // seconds
  scores: RubricScores;
  compositeScore: number;          // weighted composite 0-1
  monetizationTier?: "premium" | "standard" | "organic";
  surfacesInRange: number[];       // surface IDs visible during clip
  compatibleBrands: Array<{
    brandProductId: number;
    reasoning: string;
  }>;
  suggestedTitle: string;
  topicTags: string[];
  reasoning: string;               // why this moment works
}

export interface EditorialAnalysisOutput {
  clipStart: number;
  clipEnd: number;
  scores: RubricScores;
  compositeScore: number;
  surfacesInRange: number[];
  compatibleBrands: Array<{
    brandProductId: number;
    reasoning: string;
  }>;
  suggestedTitle: string;
  topicTags: string[];
  reasoning: string;
}

// ── Default Weights ────────────────────────────────────────────────

export const DEFAULT_RUBRIC_WEIGHTS: RubricWeights = {
  hookStrength: 0.20,
  narrativeCompleteness: 0.20,
  emotionalArc: 0.15,
  speakerClarity: 0.10,
  surfaceCompatibility: 0.15,
  culturalRelevance: 0.10,
  replayability: 0.10,
};

// ── Scoring Configuration ──────────────────────────────────────────

export const SCORING_CONFIG = {
  // Minimum composite score to consider a moment as a clip candidate
  minCompositeScore: 0.5,
  // Maximum clips to extract per video
  maxClipsPerVideo: 10,
  // Hook evaluation window (first N seconds of clip)
  hookWindowSeconds: 3.0,
  // Minimum clip duration (seconds)
  minClipDuration: 15,
  // Maximum clip duration (seconds)
  maxClipDuration: 60,
  // Surface placement multipliers
  surfaceMultipliers: {
    present: 1.2,       // Surface detected + brand match = best case
    generatable: 1.0,   // Surface detected, no brand match yet
    impossible: 0.7,    // No surface — would need text-to-image generation
  },
} as const;

// ── Scoring Functions ──────────────────────────────────────────────

/**
 * Calculate the weighted composite score from individual rubric dimensions.
 */
export function calculateCompositeScore(
  scores: RubricScores,
  weights: RubricWeights = DEFAULT_RUBRIC_WEIGHTS
): number {
  const composite =
    scores.hookStrength * weights.hookStrength +
    scores.narrativeCompleteness * weights.narrativeCompleteness +
    scores.emotionalArc * weights.emotionalArc +
    scores.speakerClarity * weights.speakerClarity +
    scores.surfaceCompatibility * weights.surfaceCompatibility +
    scores.culturalRelevance * weights.culturalRelevance +
    scores.replayability * weights.replayability;

  // Clamp to 0-1
  return Math.max(0, Math.min(1, composite));
}

/**
 * Apply surface placement multiplier to a composite score.
 *
 * - present (1.2x): Surface detected AND brand match exists
 * - generatable (1.0x): Surface detected, no brand match yet
 * - impossible (0.7x): No surface in clip range — would need AI generation
 */
export function applySurfaceMultiplier(
  compositeScore: number,
  hasSurfaces: boolean,
  hasBrandMatch: boolean
): { adjustedScore: number; multiplier: number; tier: "premium" | "standard" | "organic" } {
  let multiplier: number;
  let tier: "premium" | "standard" | "organic";

  if (hasSurfaces && hasBrandMatch) {
    multiplier = SCORING_CONFIG.surfaceMultipliers.present;
    tier = "premium";
  } else if (hasSurfaces) {
    multiplier = SCORING_CONFIG.surfaceMultipliers.generatable;
    tier = "standard";
  } else {
    multiplier = SCORING_CONFIG.surfaceMultipliers.impossible;
    tier = "organic";
  }

  return {
    adjustedScore: Math.min(1, compositeScore * multiplier),
    multiplier,
    tier,
  };
}

/**
 * Calculate brand match bonus (0-0.1 range) based on compatible brands.
 */
export function calculateBrandBonus(
  compatibleBrands: Array<{ compatibilityScore?: number }>
): number {
  if (compatibleBrands.length === 0) return 0;

  const avgCompatibility =
    compatibleBrands.reduce(
      (sum, b) => sum + (b.compatibilityScore ?? 0.5),
      0
    ) / compatibleBrands.length;

  // Up to 10% bonus
  return avgCompatibility * 0.1;
}

/**
 * Validate rubric scores — ensure all dimensions are within 0-1 range.
 */
export function validateScores(scores: Partial<RubricScores>): RubricScores {
  const clamp = (v: number | undefined) => Math.max(0, Math.min(1, v ?? 0));
  return {
    hookStrength: clamp(scores.hookStrength),
    narrativeCompleteness: clamp(scores.narrativeCompleteness),
    emotionalArc: clamp(scores.emotionalArc),
    speakerClarity: clamp(scores.speakerClarity),
    surfaceCompatibility: clamp(scores.surfaceCompatibility),
    culturalRelevance: clamp(scores.culturalRelevance),
    replayability: clamp(scores.replayability),
  };
}

/**
 * Rank clip moments by their final score (composite + surface multiplier + brand bonus).
 * Filters out moments below the minimum composite score threshold.
 */
export function rankAndFilterMoments(
  moments: EditorialAnalysisOutput[],
  surfacesByRange: Map<string, { hasSurfaces: boolean; hasBrandMatch: boolean }>,
  maxClips: number = SCORING_CONFIG.maxClipsPerVideo
): ScoredClipMoment[] {
  return moments
    .filter((m) => m.compositeScore >= SCORING_CONFIG.minCompositeScore)
    .map((m) => {
      const rangeKey = `${m.clipStart}-${m.clipEnd}`;
      const surfaceInfo = surfacesByRange.get(rangeKey) ?? { hasSurfaces: false, hasBrandMatch: false };
      const { adjustedScore, tier } = applySurfaceMultiplier(
        m.compositeScore,
        surfaceInfo.hasSurfaces,
        surfaceInfo.hasBrandMatch
      );
      const brandBonus = calculateBrandBonus(
        m.compatibleBrands.map((b) => ({ compatibilityScore: 0.7 }))
      );

      return {
        ...m,
        compositeScore: Math.min(1, adjustedScore + brandBonus),
        monetizationTier: tier,
      } as ScoredClipMoment;
    })
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, maxClips);
}

/**
 * Adjust rubric weights based on feedback performance data.
 *
 * Over time, if clips with high hookStrength consistently get better completion rates,
 * hookStrength weight increases. This is the self-improving editorial intelligence loop.
 */
export function adjustWeightsFromFeedback(
  currentWeights: RubricWeights,
  performanceCorrelations: Partial<Record<keyof RubricScores, number>>
): RubricWeights {
  const adjustmentRate = 0.05; // Max 5% adjustment per iteration
  const dimensions = Object.keys(currentWeights) as (keyof RubricWeights)[];

  const adjusted = { ...currentWeights };
  let totalWeight = 0;

  for (const dim of dimensions) {
    const correlation = performanceCorrelations[dim] ?? 0;
    // Positive correlation → increase weight, negative → decrease
    adjusted[dim] = Math.max(
      0.05, // Minimum 5% weight for any dimension
      adjusted[dim] + correlation * adjustmentRate
    );
    totalWeight += adjusted[dim];
  }

  // Normalize so weights sum to 1.0
  for (const dim of dimensions) {
    adjusted[dim] = adjusted[dim] / totalWeight;
  }

  return adjusted;
}
