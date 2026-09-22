/**
 * Where the product actually landed, as opposed to where the creator dragged it.
 *
 * Every renderer already computes this and throws it away: the exporter works
 * out an exact pixel rect and the seconds the product is on screen, the clip
 * pipeline bakes a sprite at an exact rect in source pixels — and then only the
 * file is kept. So a placement's record said what was INTENDED, never what a
 * viewer saw. Intent and delivery diverge for ordinary reasons: a crop, a
 * different frame size, a clamp at the frame edge, a visibility window that
 * only covers part of the cut.
 *
 * These are the numbers a studio can act on ("20 pixels from the corner, on
 * screen for 9 seconds"), so they are recorded in the frame they were rendered
 * in, with the fraction alongside the pixels so two different resolutions stay
 * comparable.
 */

export interface DeliveredRect {
  /** Pixels in the rendered frame. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DeliveredSample {
  /** Seconds into the rendered output. */
  t: number;
  rect: DeliveredRect;
}

export interface DeliveredPlacement {
  /** Index within this render's placement list. */
  placementIndex: number;
  savedPlacementId: number | null;
  surfaceId: number | null;
  renderKind: "video_export" | "editorial_clip";
  frame: { width: number; height: number };
  /** Representative rect: the static overlay, or the median of the samples. */
  rect: DeliveredRect;
  /** The same rect as fractions of the frame, so resolutions are comparable. */
  rectFrac: { x: number; y: number; w: number; h: number };
  areaShare: number;
  sampleKind: "static" | "frame-sampled";
  sampleCount: number;
  /** Bounded trace for a moving placement; absent for a static one. */
  samples?: DeliveredSample[];
  visibleWindows: Array<[number, number]>;
  /** Seconds on screen. Null when the render had no visibility data and ran the
   *  product for the whole duration — unknown, not "the whole video". */
  visibleSec: number | null;
  /**
   * How that number was arrived at, because the three renderers know different
   * things and a reader must not average across them blindly:
   *  - "visibility-windows": gated by the surface's own keyframes. Exact.
   *  - "sampled": measured from frames actually drawn, at one sample a second.
   *  - "full-render": the overlay ran for the whole cut. An upper bound — it
   *    does not subtract stretches where full-frame b-roll covered it.
   */
  dwellBasis: "visibility-windows" | "sampled" | "full-render" | "unknown";
  /** True when the rect was pushed back inside the frame to keep it visible. */
  clippedAtEdge: boolean;
  /** False when the placement's offsets had no recorded canvas, so the position
   *  rests on a renderer's assumption. */
  canvasKnown: boolean;
  renderedAt: string;
}

/**
 * Contiguous runs of keyframe timestamps, padded and clamped — the same maths
 * the exporter's `enable=between(...)` expression is built from, extracted so
 * the dwell we RECORD cannot drift from the dwell we RENDER.
 */
export function visibilityWindows(
  timestamps: number[],
  opts: { gapThresholdSec: number; duration: number; padSec?: number },
): Array<[number, number]> {
  const pad = opts.padSec ?? 0;
  const sorted = (timestamps ?? []).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const windows: Array<[number, number]> = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - prev > opts.gapThresholdSec) {
      windows.push([start, prev]);
      start = sorted[i];
    }
    prev = sorted[i];
  }
  windows.push([start, prev]);
  return windows.map(([a, b]) => [
    Math.max(0, a - pad),
    Math.min(opts.duration, b + pad),
  ] as [number, number]);
}

/** Seconds covered by the windows, merging any that overlap after padding. */
export function visibleSeconds(windows: Array<[number, number]>): number {
  if (!windows.length) return 0;
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s > curEnd) { total += curEnd - curStart; curStart = s; curEnd = e; }
    else if (e > curEnd) { curEnd = e; }
  }
  total += curEnd - curStart;
  return Math.round(total * 100) / 100;
}

/**
 * Collects per-frame rects without keeping one per frame: a three-minute
 * export at 24fps is 4,300 frames per placement, which is a log file, not a
 * measurement. One sample per interval, hard-capped.
 */
export class GeometrySampler {
  private readonly byPlacement = new Map<number, DeliveredSample[]>();
  private readonly lastT = new Map<number, number>();

  constructor(private readonly opts: { maxSamples?: number; minIntervalSec?: number } = {}) {}

  add(placementIndex: number, t: number, rect: DeliveredRect): void {
    const maxSamples = this.opts.maxSamples ?? 120;
    const minInterval = this.opts.minIntervalSec ?? 1;
    const last = this.lastT.get(placementIndex);
    if (last !== undefined && t - last < minInterval) return;
    const list = this.byPlacement.get(placementIndex) ?? [];
    if (list.length >= maxSamples) return;
    list.push({ t: Math.round(t * 100) / 100, rect });
    this.byPlacement.set(placementIndex, list);
    this.lastT.set(placementIndex, t);
  }

  samplesFor(placementIndex: number): DeliveredSample[] {
    return this.byPlacement.get(placementIndex) ?? [];
  }

  indices(): number[] {
    return Array.from(this.byPlacement.keys()).sort((a, b) => a - b);
  }
}

/** Median per edge — robust to a single bad frame in a tracked placement. */
export function medianRect(samples: DeliveredSample[]): DeliveredRect | null {
  if (!samples.length) return null;
  const pick = (get: (r: DeliveredRect) => number): number => {
    const vals = samples.map((s) => get(s.rect)).sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
  };
  return { x: pick((r) => r.x), y: pick((r) => r.y), w: pick((r) => r.w), h: pick((r) => r.h) };
}

export function buildDeliveredPlacement(input: {
  placementIndex: number;
  savedPlacementId?: number | null;
  surfaceId?: number | null;
  renderKind: DeliveredPlacement["renderKind"];
  frame: { width: number; height: number };
  rect: DeliveredRect;
  samples?: DeliveredSample[];
  visibleWindows: Array<[number, number]>;
  /** False when the render had no visibility data and ran the whole duration. */
  windowsKnown: boolean;
  dwellBasis: DeliveredPlacement["dwellBasis"];
  clippedAtEdge?: boolean;
  canvasKnown: boolean;
  renderedAt: string;
}): DeliveredPlacement {
  const { frame, rect } = input;
  const frac = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10000) / 10000 : 0);
  const samples = input.samples ?? [];
  return {
    placementIndex: input.placementIndex,
    savedPlacementId: input.savedPlacementId ?? null,
    surfaceId: input.surfaceId ?? null,
    renderKind: input.renderKind,
    frame,
    rect,
    rectFrac: {
      x: frac(rect.x, frame.width),
      y: frac(rect.y, frame.height),
      w: frac(rect.w, frame.width),
      h: frac(rect.h, frame.height),
    },
    areaShare: frame.width > 0 && frame.height > 0
      ? Math.round(((rect.w * rect.h) / (frame.width * frame.height)) * 10000) / 10000
      : 0,
    sampleKind: samples.length > 0 ? "frame-sampled" : "static",
    sampleCount: samples.length,
    ...(samples.length > 0 ? { samples } : {}),
    visibleWindows: input.visibleWindows,
    visibleSec: input.windowsKnown ? visibleSeconds(input.visibleWindows) : null,
    dwellBasis: input.windowsKnown ? input.dwellBasis : "unknown",
    clippedAtEdge: !!input.clippedAtEdge,
    canvasKnown: input.canvasKnown,
    renderedAt: input.renderedAt,
  };
}
