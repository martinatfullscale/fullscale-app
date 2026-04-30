/**
 * Placement Pricing — single source of truth for what brands pay per placement.
 *
 * Model: per-placement fee tiered by the editorial clip's monetizationTier.
 * Take rate is 30% to platform, 70% to creator. Test placements (admin-marked)
 * zero out all charges.
 *
 * All amounts are in CENTS (integer) to avoid floating-point money bugs.
 *
 * The actual Stripe charge happens elsewhere — this module just calculates
 * what the charge should be when a placement is created or approved.
 */

/** Monetization tiers from editorial_clips.monetization_tier */
export type MonetizationTier = "premium" | "standard" | "organic" | null | undefined;

/** Platform's cut. 30% to the platform, 70% to the creator. */
export const PLATFORM_TAKE_RATE = 0.30;

/**
 * Per-placement fee in cents, by clip tier.
 * Starter pricing — adjust once we have real data.
 */
export const PLACEMENT_FEE_BY_TIER: Record<NonNullable<MonetizationTier>, number> = {
  premium: 20000,    // $200 — top-scoring clips with strong reach
  standard: 10000,   // $100 — mid-tier
  organic: 5000,     // $50  — long-tail
};

/** Fallback when a clip has no tier set (rare but possible for older clips). */
export const DEFAULT_PLACEMENT_FEE_CENTS = PLACEMENT_FEE_BY_TIER.organic;

export interface PlacementPricing {
  placementFeeCents: number;
  platformTakeCents: number;
  creatorPayoutCents: number;
  isTestPlacement: boolean;
}

/**
 * Calculate the fee, take, and payout for a placement.
 * @param tier — clip's monetization tier (or null/undefined for fallback pricing)
 * @param isTestPlacement — admin override to zero out everything
 */
export function calculatePlacementPricing(
  tier: MonetizationTier,
  isTestPlacement: boolean = false,
): PlacementPricing {
  if (isTestPlacement) {
    return {
      placementFeeCents: 0,
      platformTakeCents: 0,
      creatorPayoutCents: 0,
      isTestPlacement: true,
    };
  }

  const fee = tier && tier in PLACEMENT_FEE_BY_TIER
    ? PLACEMENT_FEE_BY_TIER[tier as NonNullable<MonetizationTier>]
    : DEFAULT_PLACEMENT_FEE_CENTS;

  // Round to whole cents (no half-cents); integer math from the start
  const platformTake = Math.round(fee * PLATFORM_TAKE_RATE);
  const creatorPayout = fee - platformTake;

  return {
    placementFeeCents: fee,
    platformTakeCents: platformTake,
    creatorPayoutCents: creatorPayout,
    isTestPlacement: false,
  };
}

/**
 * Format cents as a human-readable USD string (no $ prefix — caller adds it).
 * 12345 → "123.45"; 100 → "1.00"; 0 → "0.00"
 */
export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
