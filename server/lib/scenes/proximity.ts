/**
 * How close is a placement surface to a person?
 *
 * "If I put chips here, next to my face, would you buy them?" is a relational
 * question, and the scanner already has everything needed to answer it: a
 * local person detector runs on every analysed frame, and the vision model
 * returns its own people boxes in the response we already pay for. Both were
 * being used as a yes/no ghost filter and then dropped.
 *
 * Pure on purpose — no I/O, no model — so the maths is testable and can be
 * recomputed later against a different box. That matters: a post-processing
 * pass rewrites every row in a cluster to the cluster's median box, so a
 * number computed at detection time goes stale. The raw person boxes are
 * persisted next to these scalars precisely so they can be recomputed, both
 * for the normalised surface box and later for the product rect itself, which
 * is not known until a creator places something.
 *
 * Coordinates are frame-normalised (0-1). Distances are corrected for the
 * frame's aspect ratio, because a tenth of the width and a tenth of the height
 * are not the same distance on a 16:9 frame.
 */

export interface PersonBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SurfaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type NearestSide = "left" | "right" | "above" | "below" | "overlapping";

export interface PersonProximity {
  /** People detected in this frame, whether or not they are near the surface. */
  personCount: number;
  /** Share of the surface covered by people: a true union, not a sum of overlaps. */
  overlapFraction: number;
  /**
   * Gap from the surface to the nearest person, as a fraction of the frame's
   * diagonal, aspect-corrected. 0 when they overlap, null when nobody is in
   * frame — null and 0 mean very different things and must not collapse.
   */
  nearestGap: number | null;
  /** Where that nearest person is, relative to the surface. */
  nearestSide: NearestSide | null;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

const usable = (b: PersonBox): boolean =>
  Number.isFinite(b?.x) && Number.isFinite(b?.y) &&
  Number.isFinite(b?.w) && Number.isFinite(b?.h) && b.w > 0 && b.h > 0;

/**
 * Area of the surface covered by ANY person.
 *
 * Summing per-person intersections double-counts two people standing
 * shoulder to shoulder and can report more coverage than the surface has.
 * A sweep over the distinct x edges costs nothing at these counts and is
 * exact.
 */
export function unionAreaWithin(box: SurfaceBox, people: PersonBox[]): number {
  const clipped = people
    .filter(usable)
    .map((p) => ({
      x0: Math.max(box.x, p.x),
      x1: Math.min(box.x + box.width, p.x + p.w),
      y0: Math.max(box.y, p.y),
      y1: Math.min(box.y + box.height, p.y + p.h),
    }))
    .filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
  if (clipped.length === 0) return 0;

  const xs = Array.from(new Set(clipped.flatMap((r) => [r.x0, r.x1]))).sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const stripX0 = xs[i];
    const stripX1 = xs[i + 1];
    const width = stripX1 - stripX0;
    if (width <= 0) continue;
    // Height covered anywhere in this vertical strip, by merging y ranges.
    const spans = clipped
      .filter((r) => r.x0 <= stripX0 && r.x1 >= stripX1)
      .map((r) => [r.y0, r.y1] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let curStart = NaN;
    let curEnd = NaN;
    for (const [s, e] of spans) {
      if (Number.isNaN(curStart)) { curStart = s; curEnd = e; continue; }
      if (s > curEnd) { covered += curEnd - curStart; curStart = s; curEnd = e; }
      else if (e > curEnd) { curEnd = e; }
    }
    if (!Number.isNaN(curStart)) covered += curEnd - curStart;
    area += width * covered;
  }
  return area;
}

/**
 * `frameAspect` is width / height of the source frame. Gaps are expressed in
 * frame-height units and divided by the diagonal, so the number is comparable
 * between a 16:9 episode and a 9:16 vertical cut.
 */
export function personProximity(
  box: SurfaceBox,
  people: PersonBox[],
  frameAspect: number,
): PersonProximity {
  const valid = (people ?? []).filter(usable);
  const aspect = Number.isFinite(frameAspect) && frameAspect > 0 ? frameAspect : 1;
  const base: PersonProximity = {
    personCount: valid.length,
    overlapFraction: 0,
    nearestGap: null,
    nearestSide: null,
  };
  if (valid.length === 0) return base;

  const area = box.width * box.height;
  // Rounded like the gap below: these are stored measurements, and floating
  // point makes three-quarters of a surface read as 0.7499999999999999.
  base.overlapFraction = area > 0
    ? Math.round(clamp01(unionAreaWithin(box, valid) / area) * 10000) / 10000
    : 0;

  const diagonal = Math.sqrt(aspect * aspect + 1);
  let bestGap = Infinity;
  let bestSide: NearestSide = "overlapping";
  for (const p of valid) {
    // Edge-to-edge gap per axis; zero on an axis means they overlap there.
    const dx = Math.max(0, Math.max(box.x - (p.x + p.w), p.x - (box.x + box.width))) * aspect;
    const dy = Math.max(0, Math.max(box.y - (p.y + p.h), p.y - (box.y + box.height)));
    const gap = Math.sqrt(dx * dx + dy * dy) / diagonal;
    if (gap >= bestGap) continue;
    bestGap = gap;
    if (dx === 0 && dy === 0) {
      bestSide = "overlapping";
    } else if (dx >= dy) {
      bestSide = p.x + p.w / 2 < box.x + box.width / 2 ? "left" : "right";
    } else {
      bestSide = p.y + p.h / 2 < box.y + box.height / 2 ? "above" : "below";
    }
  }
  base.nearestGap = Math.round(clamp01(bestGap) * 10000) / 10000;
  base.nearestSide = bestSide;
  return base;
}
