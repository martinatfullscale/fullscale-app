/**
 * What a placement spot is like, measured at scan time.
 *
 * The same numbers already existed — a harmonize run analysed the region a
 * product landed in and produced its normal and tilt, the shadow already in
 * the scene, the dominant colour, what sits nearby, how crowded it is. But
 * they were produced INSIDE the harmonizer and stored on the placement, which
 * puts them in the wrong place twice over:
 *
 *   1. A surface's tilt is a property of the CONTENT, not of whatever product
 *      someone happened to drop there. Measuring it per-placement re-measures
 *      the same physical spot once per sale.
 *   2. It only exists AFTER a placement is made and harmonized. Nothing can
 *      rank spots before a product is chosen, and a surface nobody bought has
 *      no measurement at all — so the inventory is unmeasured by construction.
 *
 * Measuring at scan fixes both, and costs nothing: the scan's vision call
 * already returns lighting and camera angle per surface, so these fields ride
 * along in a response we were already paying for.
 *
 * `recommendedScale` from the harmonize-side RegionAnalysis is deliberately
 * NOT here. It is a multiplier on a specific product's chosen size — the one
 * genuinely product-dependent value in that set, and so the one thing that
 * really does belong on the placement.
 */

export const SURFACE_NORMALS = [
  "horizontal", "vertical", "tilted-toward-camera", "tilted-away",
] as const;

export const SHADOW_DIRECTIONS = [
  "top-left", "top", "top-right", "left", "right",
  "bottom-left", "bottom", "bottom-right", "ambient",
] as const;

export const OPEN_SPACE = ["cramped", "open", "isolated"] as const;

export type SurfaceNormal = (typeof SURFACE_NORMALS)[number];
export type ShadowDirection = (typeof SHADOW_DIRECTIONS)[number];
export type OpenSpaceClass = (typeof OPEN_SPACE)[number];

/** Where a measurement came from. Kept on the row so a dataset consumer can
 *  tell an inventory measurement from one taken during a render, and so a
 *  future external engine reporting its own numbers is never mistaken for
 *  ours. */
export type MeasurementSource = "scan" | "harmonize" | "external";

export interface SurfaceMeasurement {
  surfaceNormal: SurfaceNormal;
  /** -90..90, 0 = perpendicular to the camera axis. */
  tiltDegrees: number;
  existingShadowDirection: ShadowDirection;
  existingShadowIntensity: number;
  /** 0..360. CIRCULAR — see foldSurfaceMeasurements before averaging these. */
  dominantHueDeg: number;
  dominantSaturation: number;
  averageLuminance: number;
  neighboringObjects: string[];
  openSpaceClass: OpenSpaceClass;
  source: MeasurementSource;
}

/**
 * One surface's measurement rolled up across every frame it was seen in.
 *
 * Carries two things a single observation cannot: how many frames agreed, and
 * how much they agreed about the hue. Hue is the one field where disagreement
 * is invisible in the result — averaging red and cyan lands on a confident,
 * meaningless green — so the agreement is reported rather than hidden.
 */
export interface FoldedSurfaceMeasurement extends SurfaceMeasurement {
  sampleCount: number;
  /** 0..1 resultant length of the hue vectors. Near 1 = the frames agree;
   *  near 0 = they point opposite ways and dominantHueDeg means nothing. */
  hueAgreement: number;
}

const MAX_NEIGHBORS = 16;
const MAX_NEIGHBOR_LEN = 64;
const SOURCES: readonly MeasurementSource[] = ["scan", "harmonize", "external"];

const num = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

const oneOf = <T extends readonly string[]>(v: unknown, allowed: T): T[number] | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T[number]) : null;

const readNeighbors = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw
        .filter((s: unknown): s is string => typeof s === "string" && s.length > 0)
        .slice(0, MAX_NEIGHBORS)
        .map((s: string) => s.slice(0, MAX_NEIGHBOR_LEN))
    : [];

/**
 * Validate one surface's measurement as it came back from the vision model.
 *
 * Partial measurements are dropped whole, matching the placement-side rule: a
 * half-filled row reads as measured and quietly skews anything that averages
 * over it. Neighbours are the one exception — an empty neighbour list is a
 * real answer ("nothing beside it"), not a missing field.
 */
export function sanitizeSurfaceMeasurement(
  raw: unknown,
  source: MeasurementSource = "scan",
): SurfaceMeasurement | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const surfaceNormal = oneOf(r.surfaceNormal, SURFACE_NORMALS);
  const existingShadowDirection = oneOf(r.existingShadowDirection, SHADOW_DIRECTIONS);
  const openSpaceClass = oneOf(r.openSpaceClass, OPEN_SPACE);
  const tiltDegrees = num(r.tiltDegrees, -90, 90);
  const existingShadowIntensity = num(r.existingShadowIntensity, 0, 1);
  const dominantHueDeg = num(r.dominantHueDeg, 0, 360);
  const dominantSaturation = num(r.dominantSaturation, 0, 1);
  const averageLuminance = num(r.averageLuminance, 0, 1);
  if (
    surfaceNormal === null || existingShadowDirection === null || openSpaceClass === null ||
    tiltDegrees === null || existingShadowIntensity === null || dominantHueDeg === null ||
    dominantSaturation === null || averageLuminance === null
  ) return null;
  return {
    surfaceNormal,
    tiltDegrees,
    existingShadowDirection,
    existingShadowIntensity,
    dominantHueDeg,
    dominantSaturation,
    averageLuminance,
    neighboringObjects: readNeighbors(r.neighboringObjects),
    openSpaceClass,
    source: oneOf(r.source, SOURCES) ?? source,
  };
}

/**
 * Middle value; mean of the two middles when even. Copies before sorting, so a
 * caller's array is never reordered underneath it.
 *
 * Exported because it is the fold primitive the other per-surface measurements
 * need too — screen time and depth roll up the same way — and because the
 * no-mutation guarantee is only checkable if it can be called directly.
 */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Most frequent value, ties broken by first appearance.
 *
 * First-seen rather than enum order: the frames arrive in time order, so a tie
 * resolves to the earlier observation, which is at least a real reading of a
 * real frame rather than an alphabetical artefact.
 */
function majority<T extends string>(values: T[]): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestN = -1;
  for (const v of values) {
    const n = counts.get(v)!;
    if (n > bestN) { best = v; bestN = n; }
  }
  return best;
}

const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Circular mean of hue angles, with the resultant length as an agreement score.
 *
 * Hue wraps: the arithmetic mean of 350 and 10 is 180, a confident answer that
 * is the opposite colour. Averaging the unit vectors and taking the angle back
 * gives 0, which is right. The resultant length falls out of the same maths for
 * free and is the only signal that the frames disagreed at all.
 */
export function circularMeanDeg(degrees: number[]): { mean: number; agreement: number } {
  let x = 0;
  let y = 0;
  for (const d of degrees) {
    const rad = (d * Math.PI) / 180;
    x += Math.cos(rad);
    y += Math.sin(rad);
  }
  const n = degrees.length;
  const agreement = Math.sqrt(x * x + y * y) / n;
  // atan2(0, 0) is 0 — a defined but arbitrary answer. It only arises when the
  // vectors cancel exactly, and `agreement` is then ~0, which is the caller's
  // signal that the number carries no information.
  const mean = ((Math.atan2(y / n, x / n) * 180) / Math.PI + 360) % 360;
  return { mean: round(mean, 2), agreement: round(agreement, 4) };
}

/**
 * Roll every frame's reading of one physical surface into a single measurement.
 *
 * Magnitudes take the median so one bad frame cannot drag the answer; classes
 * take a majority; hue takes the circular mean because it wraps. Neighbours are
 * unioned and ordered by how many frames saw them, so a thing glimpsed once
 * ranks below a thing present throughout.
 *
 * Returns null for an empty list rather than a zero-valued shell — "no frames
 * measured this" and "this surface measured zero" are different facts.
 */
export function foldSurfaceMeasurements(
  samples: SurfaceMeasurement[],
): FoldedSurfaceMeasurement | null {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const hue = circularMeanDeg(samples.map((s) => s.dominantHueDeg));

  const neighborCounts = new Map<string, number>();
  for (const s of samples) {
    // Count each neighbour once per frame, however often that frame repeats it.
    const seenHere = new Set<string>();
    for (const name of s.neighboringObjects) {
      if (seenHere.has(name)) continue;
      seenHere.add(name);
      neighborCounts.set(name, (neighborCounts.get(name) ?? 0) + 1);
    }
  }
  const neighborPairs: Array<[string, number]> = [];
  neighborCounts.forEach((count, name) => { neighborPairs.push([name, count]); });
  const neighboringObjects = neighborPairs
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_NEIGHBORS)
    .map(([name]) => name);

  return {
    surfaceNormal: majority(samples.map((s) => s.surfaceNormal)),
    tiltDegrees: round(median(samples.map((s) => s.tiltDegrees)), 2),
    existingShadowDirection: majority(samples.map((s) => s.existingShadowDirection)),
    existingShadowIntensity: round(median(samples.map((s) => s.existingShadowIntensity)), 4),
    dominantHueDeg: hue.mean,
    dominantSaturation: round(median(samples.map((s) => s.dominantSaturation)), 4),
    averageLuminance: round(median(samples.map((s) => s.averageLuminance)), 4),
    neighboringObjects,
    openSpaceClass: majority(samples.map((s) => s.openSpaceClass)),
    source: majority(samples.map((s) => s.source)),
    sampleCount: samples.length,
    hueAgreement: hue.agreement,
  };
}
