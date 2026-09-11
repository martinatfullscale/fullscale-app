/**
 * Facts about a reel that the client and the server must agree on.
 *
 * Shared rather than duplicated because a cap that only one side knows about
 * is not a cap. The reel editor enforced 3 minutes in its reducer while the
 * API accepted anything, so the ceiling held only for people using the UI as
 * intended — which is exactly the population that was never the problem.
 */

/**
 * The longest a reel may be, in seconds.
 *
 * This is a PRODUCT boundary, not a technical one, and it has moved once.
 *
 * It was 180 — "the tool exists to make short-form video; without a ceiling it
 * drifts into being a general-purpose long-video editor". That call was
 * reversed on 2026-09-04: long form is allowed on FullScale, in and out, and
 * 65 minutes is the platform ceiling. It is deliberately one minute over the
 * hour so an hour-long recording is never refused for overrunning.
 *
 * THE RENDER PATH IS NOT YET TUNED FOR THIS. Raising the number is what makes
 * a long reel expressible; it is not what makes one render well. Known gaps,
 * none of which this constant fixes:
 *   · server/lib/sourceCache.ts holds pulled sources in /tmp under a 500 MB
 *     cap — one 65-minute 1080p source can be most of that on its own.
 *   · a single ffmpeg filtergraph over 65 minutes of material is untested here
 *     for memory and wall time.
 *   · storage per render grows by roughly the same factor.
 * Treat a long reel as working-but-unproven until those are addressed.
 */
export const MAX_REEL_SEC = 65 * 60;

/**
 * Human phrasing, so the client and the API refuse in the same words.
 * Rounded because a non-integral cap would otherwise read "65.5 minutes".
 */
export const MAX_REEL_LABEL = `${Math.round(MAX_REEL_SEC / 60)} minutes`;

/**
 * Total output seconds for a set of segments.
 *
 * Crossfades are deliberately NOT subtracted. The cap is about how much
 * material someone is assembling, and half a second per junction is noise
 * against a three-minute ceiling — while pretending a reel is shorter than
 * the sum of its parts would let a long one squeak under.
 */
export function reelTotalSeconds(segments: Array<{ start: number; end: number }>): number {
  return segments.reduce((sum, s) => sum + Math.max(0, Number(s.end) - Number(s.start)), 0);
}
