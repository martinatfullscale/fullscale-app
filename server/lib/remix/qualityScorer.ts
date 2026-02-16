/**
 * Quality Scorer — Evaluate Generated Clips for Publishing Readiness
 *
 * Uses Claude vision to evaluate the generated clip's thumbnail and metadata,
 * plus heuristic scoring based on:
 * - Clip duration vs platform optimal range
 * - Brand placement coverage
 * - Narrative coherence (viability scores)
 * - Caption quality
 *
 * Returns a 0-1 quality score and publishing recommendation.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import type { ClipCandidate } from "./clipDetector";

export interface QualityScorerInput {
  /** Path to the clip's thumbnail */
  thumbnailPath: string | null;
  /** Clip metadata */
  clip: ClipCandidate;
  /** Platform target */
  platform: string;
  /** Actual exported duration */
  actualDuration: number;
  /** Number of product placements in the clip */
  placementCount: number;
  /** Whether captions were added */
  hasCaptions: boolean;
  /** File size in bytes */
  fileSize: number;
}

export interface QualityScoreOutput {
  /** Overall quality score 0-1 */
  overallScore: number;
  /** Individual dimension scores */
  dimensions: {
    durationFit: number;     // How well duration matches platform sweet spot
    placementQuality: number; // Product placement integration
    narrativeStrength: number; // Story/narrative coherence
    technicalQuality: number; // Resolution, file size, format
  };
  /** Publishing recommendation */
  recommendation: "publish" | "review" | "reject";
  /** Brief explanation */
  reasoning: string;
}

// Platform sweet spots (optimal duration ranges for engagement)
const PLATFORM_SWEET_SPOTS: Record<string, { min: number; max: number; ideal: number }> = {
  tiktok: { min: 15, max: 30, ideal: 21 },
  instagram_reels: { min: 15, max: 30, ideal: 22 },
  youtube_shorts: { min: 20, max: 45, ideal: 30 },
  youtube: { min: 60, max: 90, ideal: 75 },
  twitter: { min: 15, max: 45, ideal: 30 },
  linkedin: { min: 30, max: 90, ideal: 60 },
};

// File size limits per platform (bytes)
const MAX_FILE_SIZE: Record<string, number> = {
  tiktok: 287 * 1024 * 1024,     // 287MB
  instagram_reels: 250 * 1024 * 1024,
  youtube_shorts: 256 * 1024 * 1024,
  youtube: 512 * 1024 * 1024,
  twitter: 512 * 1024 * 1024,
  linkedin: 200 * 1024 * 1024,
};

/**
 * Score a generated clip's quality.
 */
export async function scoreClipQuality(input: QualityScorerInput): Promise<QualityScoreOutput> {
  const dimensions = {
    durationFit: scoreDurationFit(input.actualDuration, input.platform),
    placementQuality: scorePlacementQuality(input.clip, input.placementCount),
    narrativeStrength: input.clip.score, // Already computed by clipDetector
    technicalQuality: scoreTechnicalQuality(input.fileSize, input.platform, input.actualDuration),
  };

  // Weighted average — narrative and placements matter most
  const overallScore = (
    dimensions.durationFit * 0.15 +
    dimensions.placementQuality * 0.30 +
    dimensions.narrativeStrength * 0.35 +
    dimensions.technicalQuality * 0.20
  );

  // If we have a thumbnail and Claude API, do visual quality check
  let visualBonus = 0;
  if (input.thumbnailPath && fs.existsSync(input.thumbnailPath) && process.env.ANTHROPIC_API_KEY) {
    try {
      visualBonus = await getVisualQualityBonus(input.thumbnailPath);
    } catch {
      // Non-fatal
    }
  }

  const finalScore = Math.min(1, overallScore + visualBonus * 0.1);

  // Determine recommendation
  let recommendation: "publish" | "review" | "reject";
  let reasoning: string;

  if (finalScore >= 0.7) {
    recommendation = "publish";
    reasoning = `High quality clip (${(finalScore * 100).toFixed(0)}%) — ready for ${input.platform}`;
  } else if (finalScore >= 0.45) {
    recommendation = "review";
    reasoning = buildReviewReasoning(dimensions, input);
  } else {
    recommendation = "reject";
    reasoning = `Low quality score (${(finalScore * 100).toFixed(0)}%) — ` +
      Object.entries(dimensions)
        .filter(([, v]) => v < 0.4)
        .map(([k]) => k.replace(/([A-Z])/g, " $1").toLowerCase())
        .join(", ") + " need improvement";
  }

  console.log(`[QualityScorer] ${input.platform}: ${(finalScore * 100).toFixed(0)}% → ${recommendation}`);

  return {
    overallScore: Math.round(finalScore * 100) / 100,
    dimensions,
    recommendation,
    reasoning,
  };
}

function scoreDurationFit(duration: number, platform: string): number {
  const sweetSpot = PLATFORM_SWEET_SPOTS[platform] || { min: 15, max: 60, ideal: 30 };

  if (duration >= sweetSpot.min && duration <= sweetSpot.max) {
    // In range — score based on distance from ideal
    const distFromIdeal = Math.abs(duration - sweetSpot.ideal) / sweetSpot.ideal;
    return Math.max(0.5, 1 - distFromIdeal);
  }

  // Out of range — penalize
  if (duration < sweetSpot.min) {
    return Math.max(0.1, duration / sweetSpot.min);
  }
  return Math.max(0.2, sweetSpot.max / duration);
}

function scorePlacementQuality(clip: ClipCandidate, placementCount: number): number {
  if (clip.brandProductIds.length === 0 && placementCount === 0) {
    // No brands expected, no placements — acceptable
    return 0.5;
  }

  if (clip.brandProductIds.length > 0 && placementCount === 0) {
    // Brands expected but no placements — poor
    return 0.2;
  }

  // Has placements — good
  const matchRatio = Math.min(1, placementCount / Math.max(clip.brandProductIds.length, 1));
  return 0.5 + matchRatio * 0.5;
}

function scoreTechnicalQuality(fileSize: number, platform: string, duration: number): number {
  let score = 1.0;

  // Check file size
  const maxSize = MAX_FILE_SIZE[platform] || 256 * 1024 * 1024;
  if (fileSize > maxSize) {
    score *= 0.3; // Over limit
  } else if (fileSize > maxSize * 0.9) {
    score *= 0.7; // Near limit
  }

  // Check bitrate sanity (too low = poor quality)
  const bitrate = (fileSize * 8) / Math.max(duration, 1); // bits per second
  if (bitrate < 500_000) {
    score *= 0.5; // Under 500kbps — likely poor quality
  } else if (bitrate < 1_000_000) {
    score *= 0.8; // Under 1Mbps — acceptable
  }

  // Very small files are suspicious
  if (fileSize < 100_000) {
    score *= 0.2; // Under 100KB — probably broken
  }

  return Math.max(0, Math.min(1, score));
}

function buildReviewReasoning(
  dimensions: QualityScoreOutput["dimensions"],
  input: QualityScorerInput
): string {
  const issues: string[] = [];
  if (dimensions.durationFit < 0.5) issues.push("duration outside sweet spot");
  if (dimensions.placementQuality < 0.5) issues.push("product placement coverage low");
  if (dimensions.narrativeStrength < 0.5) issues.push("narrative coherence weak");
  if (dimensions.technicalQuality < 0.5) issues.push("technical quality concerns");
  if (!input.hasCaptions) issues.push("no captions");

  return `Moderate quality — needs review: ${issues.join(", ") || "marginal scores across dimensions"}`;
}

/**
 * Quick visual quality check using Claude vision on the thumbnail.
 */
async function getVisualQualityBonus(thumbnailPath: string): Promise<number> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const imageData = fs.readFileSync(thumbnailPath).toString("base64");

  const response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 128,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: imageData },
        },
        {
          type: "text",
          text: "Rate this video frame's visual quality on a scale of 0-10 (10 = professional, 0 = unusable). Reply with just the number.",
        },
      ],
    }],
  });

  const textBlock = response.content.find((b: Anthropic.ContentBlock) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return 0;

  const match = textBlock.text.match(/\d+/);
  if (!match) return 0;

  return Math.min(1, parseInt(match[0]) / 10);
}
