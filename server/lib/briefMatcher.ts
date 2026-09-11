/**
 * Brief Matcher — score editorial clips against a brand's brief.
 *
 * Lightweight keyword-overlap scoring (no LLM call) for fast personalized
 * sort on the BrandClipsBrowser. Score is 0–100; clips with ANY signal in
 * thingsToAvoid get filtered to a "blocked" bucket the UI can hide by default.
 *
 * Inputs we score against:
 *   - clip.topicTags             ↔ brief.audienceInterests
 *   - clip.topicTags             ↔ brief.contentCategories
 *   - clip.suggestedTitle/text   ↔ brief.thingsToAvoid (penalty)
 *   - clip.monetizationTier      ↔ brief.budgetRange   (tier bonus when match)
 *
 * Future upgrade path: replace this with sentence embeddings + cosine
 * similarity once the marketplace has enough data.
 */

import type { BrandBrief, EditorialClip } from "@shared/schema";

export interface ScoredClip {
  /** Original clip (passed through unchanged) */
  clip: EditorialClip & Record<string, any>;
  /** 0-100 relevance score */
  relevanceScore: number;
  /** True if the clip touches anything in brief.thingsToAvoid — UI may hide */
  blocked: boolean;
  /** Human-readable reasons why this clip matched (top 3) */
  matchReasons: string[];
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to", "for", "with",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
  "did", "will", "would", "should", "could", "may", "might", "this", "that", "these",
  "those", "i", "you", "he", "she", "it", "we", "they", "them", "their",
]);

/** Tokenize free-text into a Set of lowercased non-stopword tokens. */
function tokenize(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** Lowercased trimmed copy of an array's strings. */
function normalizeArray(arr: string[] | null | undefined): string[] {
  if (!arr || !Array.isArray(arr)) return [];
  return arr.map((s) => (s || "").toString().toLowerCase().trim()).filter(Boolean);
}

/** Count overlapping items between two normalized arrays. */
function arrayOverlap(a: string[], b: string[]): { count: number; matches: string[] } {
  if (a.length === 0 || b.length === 0) return { count: 0, matches: [] };
  const setB = new Set(b);
  const matches = a.filter((x) => setB.has(x));
  return { count: matches.length, matches };
}

/**
 * Score a single clip against a brief. Returns 0-100 with reasons.
 */
export function scoreClipForBrief(clip: EditorialClip & Record<string, any>, brief: BrandBrief): ScoredClip {
  const reasons: string[] = [];
  let score = 0;
  let blocked = false;

  const clipTags = normalizeArray(clip.topicTags as any);
  const interests = normalizeArray(brief.audienceInterests as any);
  const categories = normalizeArray(brief.contentCategories as any);
  const placementTypes = normalizeArray(brief.placementTypes as any);

  // ── Audience interest overlap (weight: 30) ──
  const interestMatch = arrayOverlap(clipTags, interests);
  if (interestMatch.count > 0) {
    const points = Math.min(30, interestMatch.count * 12);
    score += points;
    reasons.push(`${interestMatch.count} audience-interest match${interestMatch.count > 1 ? "es" : ""}: ${interestMatch.matches.slice(0, 3).join(", ")}`);
  }

  // ── Content category overlap (weight: 25) ──
  const categoryMatch = arrayOverlap(clipTags, categories);
  if (categoryMatch.count > 0) {
    const points = Math.min(25, categoryMatch.count * 10);
    score += points;
    reasons.push(`${categoryMatch.count} content-category match${categoryMatch.count > 1 ? "es" : ""}: ${categoryMatch.matches.slice(0, 3).join(", ")}`);
  }

  // ── Placement type vs surfaces ──
  // (scoring stays simple — checking if brief lists a placement type the clip's video has surfaces for
  // would require a join; deferring that until needed)

  // ── Tier vs budget (weight: 15) ──
  // Match high-budget brands to premium clips, low-budget to organic
  const tier = (clip.monetizationTier || "").toLowerCase();
  const budget = (brief.budgetRange || "").toLowerCase();
  if (tier === "premium" && (budget === "100k_500k" || budget === "500k_plus" || budget === "25k_100k")) {
    score += 15;
    reasons.push("Premium tier matches your budget range");
  } else if (tier === "standard" && (budget === "5k_25k" || budget === "25k_100k")) {
    score += 12;
    reasons.push("Standard tier matches your budget range");
  } else if (tier === "organic" && (budget === "under_5k" || budget === "5k_25k")) {
    score += 10;
    reasons.push("Organic tier matches your budget range");
  }

  // ── Final-score bonus (weight: 15) — high-quality clips bubble up ──
  const final = clip.finalScore ?? 0;
  if (final > 0.8) score += 15;
  else if (final > 0.6) score += 10;
  else if (final > 0.4) score += 5;

  // ── Things-to-avoid filter (binary) ──
  const avoidTokens = tokenize(brief.thingsToAvoid);
  if (avoidTokens.size > 0) {
    const clipText = `${clip.suggestedTitle || ""} ${(clip.topicTags as any[] || []).join(" ")} ${clip.reasoning || ""}`.toLowerCase();
    const clipTokens = tokenize(clipText);
    let avoidHit: string | null = null;
    avoidTokens.forEach((tok) => {
      if (avoidHit) return;
      if (clipTokens.has(tok)) avoidHit = tok;
    });
    if (avoidHit) {
      blocked = true;
      reasons.unshift(`⚠ Matches "things to avoid": "${avoidHit}"`);
    }
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));

  return {
    clip,
    relevanceScore: Math.round(score),
    blocked,
    matchReasons: reasons.slice(0, 3),
  };
}

/**
 * Score a list of clips against a brief and return them sorted by relevance.
 */
export function scoreClipsForBrief(
  clips: Array<EditorialClip & Record<string, any>>,
  brief: BrandBrief,
): ScoredClip[] {
  return clips
    .map((c) => scoreClipForBrief(c, brief))
    .sort((a, b) => {
      // Blocked clips go to the bottom regardless of score
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
      return b.relevanceScore - a.relevanceScore;
    });
}
