/**
 * Clip Detector — Identify Optimal Clip Boundaries from Narrative Analysis
 *
 * The Auto-Remix Engine's first step: analyze scene analysis data to find
 * high-viability moments, then segment them into platform-appropriate clips.
 *
 * Algorithm:
 * 1. Load all scene analyses for a video sorted by timestamp
 * 2. Score each moment based on: viability, brand match strength, narrative coherence
 * 3. Group consecutive high-scoring frames into candidate clips
 * 4. Apply platform constraints (min/max duration)
 * 5. Rank candidates by combined score and return top N
 */

import type { SceneAnalysis, BrandMatchScore, DetectedSurface } from "../../../shared/schema";

export interface PlatformConfig {
  name: string;
  minDuration: number;  // seconds
  maxDuration: number;  // seconds
  aspectRatio: string;  // "9:16", "16:9", "1:1"
  targetWidth: number;
  targetHeight: number;
  targetFps: number;
}

export const PLATFORM_CONFIGS: Record<string, PlatformConfig> = {
  tiktok: {
    name: "TikTok",
    minDuration: 15,
    maxDuration: 60,
    aspectRatio: "9:16",
    targetWidth: 1080,
    targetHeight: 1920,
    targetFps: 30,
  },
  instagram_reels: {
    name: "Instagram Reels",
    minDuration: 15,
    maxDuration: 60,
    aspectRatio: "9:16",
    targetWidth: 1080,
    targetHeight: 1920,
    targetFps: 30,
  },
  youtube_shorts: {
    name: "YouTube Shorts",
    minDuration: 15,
    maxDuration: 60,
    aspectRatio: "9:16",
    targetWidth: 1080,
    targetHeight: 1920,
    targetFps: 30,
  },
  youtube: {
    name: "YouTube",
    minDuration: 30,
    maxDuration: 120,
    aspectRatio: "16:9",
    targetWidth: 1920,
    targetHeight: 1080,
    targetFps: 24,
  },
  twitter: {
    name: "Twitter/X",
    minDuration: 6,
    maxDuration: 140,
    aspectRatio: "16:9",
    targetWidth: 1280,
    targetHeight: 720,
    targetFps: 30,
  },
  linkedin: {
    name: "LinkedIn",
    minDuration: 15,
    maxDuration: 120,
    aspectRatio: "16:9",
    targetWidth: 1280,
    targetHeight: 720,
    targetFps: 24,
  },
};

export interface ClipCandidate {
  /** Start timestamp in seconds */
  startTime: number;
  /** End timestamp in seconds */
  endTime: number;
  /** Duration in seconds */
  duration: number;
  /** Overall quality/viability score 0-1 */
  score: number;
  /** Scene analyses included in this clip */
  sceneAnalysisIds: number[];
  /** Surface IDs with product placements */
  surfaceIds: number[];
  /** Brand product IDs matched to this clip */
  brandProductIds: number[];
  /** Primary emotional tone for the clip */
  primaryTone: string;
  /** Narrative summary */
  narrativeSummary: string;
  /** Target platform */
  platform: string;
}

interface AnalysisWithBrands {
  analysis: SceneAnalysis;
  brandMatches: BrandMatchScore[];
  surface: DetectedSurface | null;
}

/**
 * Detect optimal clip boundaries from scene analyses.
 */
export function detectClipCandidates(
  analyses: AnalysisWithBrands[],
  platforms: string[],
  maxClips: number = 5,
  videoDuration: number = 0
): ClipCandidate[] {
  if (analyses.length === 0) return [];

  // Sort by frame start time
  const sorted = [...analyses].sort((a, b) =>
    (a.analysis.frameStart || 0) - (b.analysis.frameStart || 0)
  );

  const allCandidates: ClipCandidate[] = [];

  for (const platform of platforms) {
    const config = PLATFORM_CONFIGS[platform];
    if (!config) continue;

    // Step 1: Score each analysis moment
    const scoredMoments = sorted.map(item => ({
      ...item,
      momentScore: scoreMoment(item),
      timestamp: item.analysis.frameStart || 0,
    }));

    // Step 2: Find contiguous high-scoring regions
    const regions = findHighScoreRegions(scoredMoments, 0.35); // min 0.35 score threshold

    // Step 3: Convert regions into platform-constrained clips
    for (const region of regions) {
      const clipStart = region.startTime;
      let clipEnd = region.endTime;

      // Ensure minimum duration
      if (clipEnd - clipStart < config.minDuration) {
        // Extend the clip to meet minimum, centered on the high-score region
        const center = (clipStart + clipEnd) / 2;
        const halfMin = config.minDuration / 2;
        clipEnd = Math.min(center + halfMin, videoDuration || center + halfMin);
        const adjustedStart = Math.max(0, clipEnd - config.minDuration);
        region.startTime = adjustedStart;
      }

      // Cap at maximum duration
      if (clipEnd - region.startTime > config.maxDuration) {
        clipEnd = region.startTime + config.maxDuration;
      }

      const duration = clipEnd - region.startTime;
      if (duration < config.minDuration) continue;

      // Collect metadata from all moments in this region
      const includedMoments = scoredMoments.filter(m =>
        m.timestamp >= region.startTime && m.timestamp <= clipEnd
      );

      const tones = includedMoments
        .map(m => m.analysis.emotionalTone)
        .filter(Boolean) as string[];
      const primaryTone = getMostFrequent(tones) || "neutral";

      const narratives = includedMoments
        .map(m => m.analysis.narrativeContext)
        .filter(Boolean) as string[];

      allCandidates.push({
        startTime: Math.round(region.startTime * 100) / 100,
        endTime: Math.round(clipEnd * 100) / 100,
        duration: Math.round(duration * 100) / 100,
        score: region.avgScore,
        sceneAnalysisIds: includedMoments.map(m => m.analysis.id),
        surfaceIds: includedMoments
          .filter(m => m.surface)
          .map(m => m.surface!.id),
        brandProductIds: [...new Set(
          includedMoments.flatMap(m =>
            m.brandMatches
              .filter(bm => bm.approved || (bm.compatibilityScore && bm.compatibilityScore >= 0.6))
              .map(bm => bm.brandProductId)
          )
        )],
        primaryTone,
        narrativeSummary: narratives.slice(0, 2).join(" ").slice(0, 200),
        platform,
      });
    }
  }

  // Rank by score, deduplicate overlapping clips, take top N
  const ranked = allCandidates.sort((a, b) => b.score - a.score);
  const deduped = deduplicateOverlapping(ranked);
  return deduped.slice(0, maxClips);
}

/**
 * Score a single moment based on narrative analysis and brand matches.
 */
function scoreMoment(item: AnalysisWithBrands): number {
  const viability = item.analysis.placementViability || 0;

  // Brand match bonus: best match score * 0.3
  const bestBrandScore = item.brandMatches.length > 0
    ? Math.max(...item.brandMatches.map(m => m.compatibilityScore || 0))
    : 0;
  const brandBonus = bestBrandScore * 0.3;

  // Approved brand bonus
  const hasApproved = item.brandMatches.some(m => m.approved);
  const approvalBonus = hasApproved ? 0.15 : 0;

  // Surface confidence bonus
  const surfaceBonus = item.surface
    ? (item.surface.confidence || 0) * 0.1
    : 0;

  return Math.min(1, viability * 0.5 + brandBonus + approvalBonus + surfaceBonus);
}

interface ScoredRegion {
  startTime: number;
  endTime: number;
  avgScore: number;
}

/**
 * Find contiguous regions of high-scoring moments.
 */
function findHighScoreRegions(
  moments: Array<{ momentScore: number; timestamp: number }>,
  threshold: number
): ScoredRegion[] {
  const regions: ScoredRegion[] = [];
  let currentRegion: { start: number; end: number; scores: number[] } | null = null;

  // Gap tolerance: if two high-score moments are within 8 seconds, merge them
  const GAP_TOLERANCE = 8;

  for (const moment of moments) {
    if (moment.momentScore >= threshold) {
      if (currentRegion && moment.timestamp - currentRegion.end <= GAP_TOLERANCE) {
        // Extend current region
        currentRegion.end = moment.timestamp;
        currentRegion.scores.push(moment.momentScore);
      } else {
        // Save previous region and start new
        if (currentRegion) {
          regions.push({
            startTime: currentRegion.start,
            endTime: currentRegion.end + 2, // Add 2s buffer after last moment
            avgScore: currentRegion.scores.reduce((a, b) => a + b, 0) / currentRegion.scores.length,
          });
        }
        currentRegion = {
          start: Math.max(0, moment.timestamp - 1), // 1s lead-in
          end: moment.timestamp,
          scores: [moment.momentScore],
        };
      }
    }
  }

  // Don't forget the last region
  if (currentRegion) {
    regions.push({
      startTime: currentRegion.start,
      endTime: currentRegion.end + 2,
      avgScore: currentRegion.scores.reduce((a, b) => a + b, 0) / currentRegion.scores.length,
    });
  }

  return regions;
}

/**
 * Remove clips that overlap more than 50% with a higher-scored clip.
 */
function deduplicateOverlapping(clips: ClipCandidate[]): ClipCandidate[] {
  const kept: ClipCandidate[] = [];

  for (const clip of clips) {
    const overlapsWithBetter = kept.some(existing => {
      const overlapStart = Math.max(existing.startTime, clip.startTime);
      const overlapEnd = Math.min(existing.endTime, clip.endTime);
      if (overlapStart >= overlapEnd) return false;

      const overlapDuration = overlapEnd - overlapStart;
      const overlapRatio = overlapDuration / Math.min(existing.duration, clip.duration);
      return overlapRatio > 0.5;
    });

    if (!overlapsWithBetter) {
      kept.push(clip);
    }
  }

  return kept;
}

function getMostFrequent(arr: string[]): string | null {
  if (arr.length === 0) return null;
  const counts = new Map<string, number>();
  for (const item of arr) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  let best = arr[0];
  let bestCount = 0;
  for (const [item, count] of counts) {
    if (count > bestCount) { best = item; bestCount = count; }
  }
  return best;
}
