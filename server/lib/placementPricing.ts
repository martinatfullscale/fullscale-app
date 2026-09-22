/**
 * Placement Pricing — CPM-based rubric with multiple value drivers.
 *
 * Formula:
 *   PlacementFee = (ExpectedImpressions / 1000)
 *                × BASE_CPM
 *                × CreatorTierMultiplier  (follower count)
 *                × ContentTierMultiplier  (clip's monetizationTier)
 *                × RecencyMultiplier      (video age)
 *                × SurfaceMultiplier      (bbox prominence + type)
 *                × DurationMultiplier     (single / 1mo / 3mo / 6mo / 12mo)
 *
 * Take rate locked at 30% platform / 70% creator.
 * Floor $5, ceiling $5,000 per single placement; ceiling $50,000 per duration commitment.
 *
 * All amounts are in CENTS (integer) to avoid floating-point money bugs.
 */

// ── Tunable constants — change these to adjust pricing ─────────────────────

/** Default base CPM in USD ($7 = midpoint of $5-$10 range). */
export const BASE_CPM_USD = 7;

/** Locked: 30% platform, 70% creator. */
export const PLATFORM_TAKE_RATE = 0.30;

/** Floor and ceiling per single placement to protect against extreme calcs. */
export const PLACEMENT_FEE_FLOOR_CENTS = 500;       // $5
export const SINGLE_PLACEMENT_CEILING_CENTS = 500_000;   // $5,000
export const DURATION_PLACEMENT_CEILING_CENTS = 5_000_000; // $50,000

// ── Tier definitions ──────────────────────────────────────────────────────

export type CreatorTier = "mega" | "macro" | "mid" | "micro" | "nano";
export type ContentTier = "premium" | "standard" | "organic";
export type DurationTerm = "single" | "1-month" | "3-month" | "6-month" | "12-month";

/** Creator tier multipliers (driven by follower/subscriber count). */
export const CREATOR_TIER_MULTIPLIER: Record<CreatorTier, number> = {
  mega: 1.5,    // > 1M followers
  macro: 1.3,   // 100K - 1M
  mid: 1.0,     // 10K - 100K
  micro: 0.8,   // 1K - 10K
  nano: 0.6,    // < 1K
};

/** Content tier multipliers (driven by editorial clip's monetizationTier). */
export const CONTENT_TIER_MULTIPLIER: Record<ContentTier, number> = {
  premium: 1.3,
  standard: 1.0,
  organic: 0.7,
};

/** Duration term multipliers — longer commitment = bigger total fee, but lower per-month rate. */
export const DURATION_MULTIPLIER: Record<DurationTerm, number> = {
  single: 1.0,
  "1-month": 1.0,    // same as single — placement locked for 1 month
  "3-month": 2.5,    // 17% discount per month vs single
  "6-month": 4.5,    // 25% discount per month
  "12-month": 8.0,   // 33% discount per month
};

/** Number of days each duration term covers (for expires_at calculation). */
export const DURATION_DAYS: Record<DurationTerm, number> = {
  single: 0,         // no expiry
  "1-month": 30,
  "3-month": 90,
  "6-month": 180,
  "12-month": 365,
};

// ── Helpers ───────────────────────────────────────────────────────────────

/** Bucket a follower count into a creator tier. */
export function followerCountToTier(followers: number | null | undefined): CreatorTier {
  if (!followers || followers < 0) return "nano";
  if (followers >= 1_000_000) return "mega";
  if (followers >= 100_000) return "macro";
  if (followers >= 10_000) return "mid";
  if (followers >= 1_000) return "micro";
  return "nano";
}

/** Recency multiplier from video age in days. Older content pays less. */
export function recencyMultiplier(ageDays: number | null | undefined): number {
  if (ageDays === null || ageDays === undefined || ageDays < 0) return 1.0;
  if (ageDays < 7) return 1.20;
  if (ageDays < 30) return 1.00;
  if (ageDays < 90) return 0.75;
  if (ageDays < 365) return 0.50;
  if (ageDays < 730) return 0.30;
  return 0.20;
}

/**
 * A surface is sellable inventory only if it survived post-scan filtering
 * (surfaces stamped "Filtered" were rejected by enrichment or by the creator)
 * AND the creator explicitly approved it. Surfaces default to unapproved —
 * hidden from brands until approved, per the creator-controlled exposure model.
 */
export function isSellableSurface(
  s: { surfaceType?: string | null; creatorApproved?: boolean | null } | null | undefined,
): boolean {
  return !!s && s.surfaceType !== "Filtered" && s.creatorApproved === true;
}

/** Surface multiplier — combines bbox area, surface type bonuses. */
export interface SurfaceForPricing {
  surfaceType: string;
  boundingBoxWidth: number;   // 0-1 normalized
  boundingBoxHeight: number;  // 0-1 normalized
}

export function surfaceMultiplier(surface: SurfaceForPricing | null | undefined): number {
  if (!surface) return 1.0;
  const area = (surface.boundingBoxWidth || 0) * (surface.boundingBoxHeight || 0);

  // Base multiplier by bbox prominence
  let mult: number;
  if (area > 0.25) mult = 1.5;       // hero (>25% of frame)
  else if (area > 0.10) mult = 1.0;  // standard
  else mult = 0.7;                   // background

  // Surface-type bonuses for high-value real estate
  const typeStr = (surface.surfaceType || "").toLowerCase();
  if (typeStr.includes("wall")) mult += 0.2;       // walls = poster real estate
  else if (typeStr.includes("monitor") || typeStr.includes("laptop") || typeStr.includes("tv") || typeStr.includes("screen")) {
    mult += 0.1;                                    // screens = takeover potential
  }

  return mult;
}

/** Compute video age in days from a published/created timestamp. */
export function videoAgeDays(publishedAt: Date | string | null | undefined, fallback: Date | string | null | undefined): number {
  const stamp = publishedAt ?? fallback;
  if (!stamp) return 0;
  const date = typeof stamp === "string" ? new Date(stamp) : stamp;
  if (isNaN(date.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)));
}

// ── Main pricing calc ─────────────────────────────────────────────────────

export interface PlacementPricingInput {
  /** Creator's follower/subscriber count (null = treat as nano) */
  creatorFollowerCount?: number | null;
  /** Average view count across creator's recent videos (best signal for actual reach) */
  creatorAvgViews?: number | null;
  /** View count of the parent video for this clip (fallback if creator stats missing) */
  clipParentVideoViews?: number | null;
  /** Clip's editorial monetization tier */
  contentTier?: ContentTier | string | null;
  /** Source video's age in days */
  videoAgeDays?: number;
  /** Surface details for prominence calculation */
  surface?: SurfaceForPricing | null;
  /** Duration commitment (default: single one-shot) */
  durationTerm?: DurationTerm;
  /** Admin override: zero out the charge (test placements) */
  isTestPlacement?: boolean;
  /** Admin override: bespoke fee in cents — bypasses calculation entirely */
  customFeeCents?: number | null;
}

export interface PlacementPricingBreakdown {
  // Inputs (echoed for audit)
  expectedImpressions: number;
  creatorTier: CreatorTier;
  creatorTierMultiplier: number;
  contentTier: ContentTier;
  contentTierMultiplier: number;
  recencyMultiplier: number;
  surfaceMultiplier: number;
  durationTerm: DurationTerm;
  durationMultiplier: number;
  baseCpmUsd: number;
  // Final amounts (in cents)
  rawCalculatedCents: number;     // pre-floor/ceiling
  placementFeeCents: number;      // post-floor/ceiling, post-override
  platformTakeCents: number;
  creatorPayoutCents: number;
  // Flags
  isTestPlacement: boolean;
  isCustomOverride: boolean;
  // Lifecycle
  durationDays: number;
}

/**
 * Calculate placement pricing using the full CPM rubric.
 *
 * Order of precedence for fee:
 *   1. isTestPlacement → 0
 *   2. customFeeCents → use as-is
 *   3. CPM-based calculation with floor/ceiling
 */
export function calculatePlacementPricing(input: PlacementPricingInput): PlacementPricingBreakdown {
  const durationTerm = input.durationTerm ?? "single";
  const durationMult = DURATION_MULTIPLIER[durationTerm];
  const durationDays = DURATION_DAYS[durationTerm];

  // Bucket follower count → creator tier
  const creatorTier = followerCountToTier(input.creatorFollowerCount);
  const creatorMult = CREATOR_TIER_MULTIPLIER[creatorTier];

  // Content tier (default to standard if missing)
  const contentTier: ContentTier =
    (input.contentTier === "premium" || input.contentTier === "standard" || input.contentTier === "organic")
      ? input.contentTier
      : "standard";
  const contentMult = CONTENT_TIER_MULTIPLIER[contentTier];

  // Recency
  const recMult = recencyMultiplier(input.videoAgeDays);

  // Surface
  const surfMult = surfaceMultiplier(input.surface);

  // Expected impressions: prefer creator's recent avg views, fall back to parent video views
  const expectedImpressions =
    (input.creatorAvgViews && input.creatorAvgViews > 0)
      ? input.creatorAvgViews
      : (input.clipParentVideoViews && input.clipParentVideoViews > 0)
        ? input.clipParentVideoViews
        : 1000;  // baseline floor — no signals available

  // Raw calculation
  const rawUsd =
    (expectedImpressions / 1000) *
    BASE_CPM_USD *
    creatorMult *
    contentMult *
    recMult *
    surfMult *
    durationMult;

  const rawCents = Math.round(rawUsd * 100);

  // Apply ceiling (different for single vs duration)
  const ceiling = durationTerm === "single" || durationTerm === "1-month"
    ? SINGLE_PLACEMENT_CEILING_CENTS
    : DURATION_PLACEMENT_CEILING_CENTS;

  // Decide final fee
  let finalFeeCents: number;
  let isCustomOverride = false;

  if (input.isTestPlacement) {
    finalFeeCents = 0;
  } else if (input.customFeeCents !== null && input.customFeeCents !== undefined && input.customFeeCents >= 0) {
    finalFeeCents = Math.round(input.customFeeCents);
    isCustomOverride = true;
  } else {
    finalFeeCents = Math.max(PLACEMENT_FEE_FLOOR_CENTS, Math.min(ceiling, rawCents));
  }

  const platformCents = Math.round(finalFeeCents * PLATFORM_TAKE_RATE);
  const creatorCents = finalFeeCents - platformCents;

  return {
    expectedImpressions,
    creatorTier,
    creatorTierMultiplier: creatorMult,
    contentTier,
    contentTierMultiplier: contentMult,
    recencyMultiplier: recMult,
    surfaceMultiplier: surfMult,
    durationTerm,
    durationMultiplier: durationMult,
    baseCpmUsd: BASE_CPM_USD,
    rawCalculatedCents: rawCents,
    placementFeeCents: finalFeeCents,
    platformTakeCents: platformCents,
    creatorPayoutCents: creatorCents,
    isTestPlacement: !!input.isTestPlacement,
    isCustomOverride,
    durationDays,
  };
}

/**
 * Format cents as a human-readable USD string (no $ prefix — caller adds it).
 * 12345 → "123.45"
 */
export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Format an integer impression count with thousands separator.
 * 12345 → "12,345"
 */
export function formatImpressions(n: number): string {
  return n.toLocaleString("en-US");
}

// ── Input-gathering helper ────────────────────────────────────────────────

/**
 * Pull creator stats from a list of their videos: average view count across
 * the most recent N videos. This is the strongest signal for actual reach.
 */
export function avgRecentViews(
  creatorVideos: Array<{ viewCount?: number | null; createdAt?: Date | null }>,
  recentCount: number = 10,
): number {
  if (!creatorVideos || creatorVideos.length === 0) return 0;
  // Sort by createdAt descending, take top N
  const sorted = [...creatorVideos]
    .filter((v) => typeof v.viewCount === "number" && v.viewCount! > 0)
    .sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, recentCount);

  if (sorted.length === 0) return 0;
  const sum = sorted.reduce((s, v) => s + (v.viewCount || 0), 0);
  return Math.round(sum / sorted.length);
}

/**
 * Compute the expires_at timestamp for a duration commitment.
 * Returns null for single placements (no expiry).
 */
export function computeExpiresAt(durationTerm: DurationTerm, fromDate: Date = new Date()): Date | null {
  const days = DURATION_DAYS[durationTerm];
  if (days === 0) return null;
  return new Date(fromDate.getTime() + days * 24 * 60 * 60 * 1000);
}
