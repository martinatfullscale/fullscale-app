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
 * This is a PRODUCT boundary, not a technical one. The tool exists to make
 * short-form video; without a ceiling it drifts into being a general-purpose
 * long-video editor, which is neither what it is for nor what the render path
 * is tuned for. Three minutes sits above every short-form platform's own
 * limit, so it never bites a legitimate reel.
 */
export const MAX_REEL_SEC = 180;

/** Human phrasing, so the client and the API refuse in the same words. */
export const MAX_REEL_LABEL = `${MAX_REEL_SEC / 60} minutes`;

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
