/**
 * Clip Ranker — Cross-references editorial scores with surface detection.
 *
 * After Claude Dense identifies the best editorial moments (narrative-first),
 * this module cross-references with Scanner V2 surface data to determine
 * monetization potential and final clip ranking.
 *
 * Principle: "Narrative-first, surface-second."
 * The editorial score is the primary signal. Surface presence is a multiplier.
 */

import type { EditorialAnalysisOutput, RubricScores } from "./clipScoringRubric";
import {
  applySurfaceMultiplier,
  calculateBrandBonus,
  SCORING_CONFIG,
} from "./clipScoringRubric";
import { refineEditPoints, EDIT_POINT_RULES } from "./clipExtractor";
import type { RefinedEditPoints } from "./clipExtractor";
import type { TranscriptSegment } from "./speechToText";

// ── Types ──────────────────────────────────────────────────────────

export interface DetectedSurfaceCompact {
  id: number;
  videoId: number;
  timestamp: number;
  surfaceType: string;
  confidence: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export interface BrandMatchCompact {
  id: number;
  surfaceId?: number;
  sceneAnalysisId: number;
  brandProductId: number;
  compatibilityScore: number;
  reasoning: string;
  suggestedPlacementStyle?: string;
}

export interface RankedClip {
  clipStart: number;                    // Refined start (after edit point refinement)
  clipEnd: number;                      // Refined end
  duration: number;
  editorialScore: number;              // From Claude Dense rubric (0-1)
  surfaceScore: number;                // From surface detection overlap (0-1)
  brandMatchScore: number;             // From brand compatibility (0-0.1)
  finalScore: number;                  // editorial * surface multiplier + brand bonus
  monetizationTier: "premium" | "standard" | "organic";
  scores: RubricScores;               // Individual dimension scores
  surfaces: DetectedSurfaceCompact[];  // Surfaces visible during this clip
  brandMatches: BrandMatchCompact[];   // Brand matches for overlapping surfaces
  editPoints: RefinedEditPoints;       // Edit point refinement details
  suggestedTitle: string;
  topicTags: string[];
  reasoning: string;
  // Original boundaries before refinement
  rawClipStart: number;
  rawClipEnd: number;
}

// ── Ranking Functions ──────────────────────────────────────────────

/**
 * Find surfaces that are visible during a clip's time range.
 */
function findOverlappingSurfaces(
  clipStart: number,
  clipEnd: number,
  surfaces: DetectedSurfaceCompact[]
): DetectedSurfaceCompact[] {
  return surfaces.filter(
    (s) => s.timestamp >= clipStart && s.timestamp <= clipEnd
  );
}

/**
 * Find brand matches that correspond to overlapping surfaces.
 */
function findRelevantBrandMatches(
  overlappingSurfaces: DetectedSurfaceCompact[],
  brandMatches: BrandMatchCompact[]
): BrandMatchCompact[] {
  const surfaceIds = new Set(overlappingSurfaces.map((s) => s.id));
  return brandMatches.filter(
    (bm) => bm.surfaceId !== undefined && surfaceIds.has(bm.surfaceId)
  );
}

/**
 * Calculate the best surface confidence score from overlapping surfaces.
 */
function calculateSurfaceScore(surfaces: DetectedSurfaceCompact[]): number {
  if (surfaces.length === 0) return 0;
  return Math.max(...surfaces.map((s) => s.confidence));
}

/**
 * Rank editorial moments against surface detection and brand matches.
 *
 * Takes the raw editorial moments from Claude Dense and:
 * 1. Cross-references with detected surfaces in each clip's time range
 * 2. Finds brand matches for overlapping surfaces
 * 3. Applies surface multiplier (1.2x/1.0x/0.7x)
 * 4. Adds brand match bonus (up to 10%)
 * 5. Refines edit points using transcript word boundaries
 * 6. Returns ranked clips sorted by final score
 */
export function rankClips(
  editorialMoments: EditorialAnalysisOutput[],
  surfaces: DetectedSurfaceCompact[],
  brandMatches: BrandMatchCompact[],
  transcript: TranscriptSegment[],
  maxClips: number = SCORING_CONFIG.maxClipsPerVideo
): RankedClip[] {
  console.log(
    `[ClipRanker] Ranking ${editorialMoments.length} moments against ` +
      `${surfaces.length} surfaces, ${brandMatches.length} brand matches`
  );

  const rankedClips: RankedClip[] = editorialMoments
    .filter((m) => m.compositeScore >= SCORING_CONFIG.minCompositeScore)
    .map((moment) => {
      // 1. Find surfaces visible during this clip's time range
      const overlappingSurfaces = findOverlappingSurfaces(
        moment.clipStart,
        moment.clipEnd,
        surfaces
      );

      // 2. Find brand matches for overlapping surfaces
      const relevantBrandMatches = findRelevantBrandMatches(
        overlappingSurfaces,
        brandMatches
      );

      // 3. Calculate surface multiplier
      const hasSurfaces = overlappingSurfaces.length > 0;
      const hasBrandMatch = relevantBrandMatches.length > 0;
      const { adjustedScore, multiplier, tier } = applySurfaceMultiplier(
        moment.compositeScore,
        hasSurfaces,
        hasBrandMatch
      );

      // 4. Calculate brand match bonus
      const brandBonus = calculateBrandBonus(
        relevantBrandMatches.map((bm) => ({
          compatibilityScore: bm.compatibilityScore,
        }))
      );

      // 5. Refine edit points using transcript
      const editPoints = refineEditPoints(
        { start: moment.clipStart, end: moment.clipEnd },
        transcript,
        EDIT_POINT_RULES
      );

      // 6. Calculate final score
      const finalScore = Math.min(1, adjustedScore + brandBonus);
      const surfaceScore = calculateSurfaceScore(overlappingSurfaces);

      return {
        clipStart: editPoints.start,
        clipEnd: editPoints.end,
        duration: editPoints.end - editPoints.start,
        editorialScore: moment.compositeScore,
        surfaceScore,
        brandMatchScore: brandBonus * 10, // Normalize to 0-1 range for display
        finalScore,
        monetizationTier: tier,
        scores: moment.scores,
        surfaces: overlappingSurfaces,
        brandMatches: relevantBrandMatches,
        editPoints,
        suggestedTitle: moment.suggestedTitle,
        topicTags: moment.topicTags,
        reasoning: moment.reasoning,
        rawClipStart: moment.clipStart,
        rawClipEnd: moment.clipEnd,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, maxClips);

  // Log ranking summary
  if (rankedClips.length > 0) {
    console.log(`[ClipRanker] Ranking results:`);
    rankedClips.forEach((clip, i) => {
      console.log(
        `  ${i + 1}. "${clip.suggestedTitle}" ` +
          `[${clip.clipStart.toFixed(1)}s-${clip.clipEnd.toFixed(1)}s] ` +
          `editorial=${clip.editorialScore.toFixed(2)} ` +
          `final=${clip.finalScore.toFixed(2)} ` +
          `tier=${clip.monetizationTier} ` +
          `surfaces=${clip.surfaces.length} ` +
          `brands=${clip.brandMatches.length}`
      );
    });

    const tiers = {
      premium: rankedClips.filter((c) => c.monetizationTier === "premium").length,
      standard: rankedClips.filter((c) => c.monetizationTier === "standard").length,
      organic: rankedClips.filter((c) => c.monetizationTier === "organic").length,
    };
    console.log(
      `[ClipRanker] Tier breakdown: ${tiers.premium} premium, ${tiers.standard} standard, ${tiers.organic} organic`
    );
  } else {
    console.log(`[ClipRanker] No clips met the minimum score threshold (${SCORING_CONFIG.minCompositeScore})`);
  }

  return rankedClips;
}

/**
 * Deduplicate overlapping clips — if two clips overlap by more than 50%,
 * keep the one with the higher final score.
 */
export function deduplicateClips(
  clips: RankedClip[],
  overlapThreshold: number = 0.5
): RankedClip[] {
  if (clips.length <= 1) return clips;

  const kept: RankedClip[] = [];

  for (const clip of clips) {
    const hasOverlap = kept.some((existing) => {
      const overlapStart = Math.max(clip.clipStart, existing.clipStart);
      const overlapEnd = Math.min(clip.clipEnd, existing.clipEnd);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const shorter = Math.min(clip.duration, existing.duration);
      return shorter > 0 && overlap / shorter > overlapThreshold;
    });

    if (!hasOverlap) {
      kept.push(clip);
    }
  }

  console.log(`[ClipRanker] Deduplication: ${clips.length} → ${kept.length} clips`);
  return kept;
}
