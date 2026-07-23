// Per-scene surface consensus — the "double authentication" layer.
//
// Problem this solves (observed on real scans): a single Gemini pass on a
// single frame becomes the truth for a whole video. One frame's
// hallucination ("Wall" box sitting on the floor between two people) ships
// straight to creators and brands, rooms full of placeable surfaces come
// back as "2 Surfaces", and the same physical table gets different labels
// at different timestamps.
//
// The fix is structural, not prompt-tweaking:
//   AUTH 1 — cross-frame consensus: within one scene, detection runs on
//     multiple frames. A surface only survives if independently detected in
//     >=2 frames at a compatible position (IoU or center-distance match).
//     One-frame wonders die here.
//   AUTH 2 — position plausibility: each surface class carries physical
//     priors (a Floor lives in the lower half of frame; a Wall/Backdrop
//     does not sit in the bottom quarter; a Ceiling hugs the top). Boxes
//     that violate their class prior are rejected regardless of votes.
//     (The scanner may additionally run a model-verify pass on survivors —
//     that's AUTH 2b, wired in scanner_v2.)
//
// Output: ONE canonical surface set per scene — stable identity, median
// bbox, vote-weighted confidence — which is what makes placements
// consistent from 0s to the end of the scene instead of flickering
// per-timestamp.

export interface FrameDetection {
  /** Timestamp of the sampled frame (seconds in source) */
  frameT: number;
  surfaces: Array<{
    surfaceType: string;
    confidence: number; // 0-1
    /** Normalized 0-1 bbox */
    bbox: { x: number; y: number; width: number; height: number };
    /** Opaque caller payload (e.g. the full detection object) — carried
     *  through untouched to consensus members so inserts keep every field */
    ref?: unknown;
  }>;
}

export interface ConsensusSurface {
  surfaceType: string;
  /** Median bbox across supporting detections (normalized 0-1) */
  bbox: { x: number; y: number; width: number; height: number };
  /** Mean member confidence, scaled by frame support (votes/frames) */
  confidence: number;
  /** Number of distinct frames that detected this surface */
  votes: number;
  /** Number of frames analyzed for the scene */
  framesAnalyzed: number;
  /** Timestamps of supporting frames */
  supportTimestamps: number[];
  /** Every supporting detection with its own frame-local bbox — callers
   *  insert one row per member to preserve keyframe density downstream */
  members: Array<{ frameT: number; confidence: number; bbox: { x: number; y: number; width: number; height: number }; ref?: unknown }>;
}

export interface ConsensusRejection {
  surfaceType: string;
  bbox: { x: number; y: number; width: number; height: number };
  frameT: number;
  reason: "single_frame" | "implausible_position";
}

export interface SceneConsensusResult {
  surfaces: ConsensusSurface[];
  rejected: ConsensusRejection[];
}

// ── Class position priors (normalized frame coords; y=0 is TOP) ────

interface PositionPrior {
  /** Allowed range for bbox center Y [min, max] */
  centerY?: [number, number];
  /** Allowed range for bbox center X [min, max] */
  centerX?: [number, number];
  /** Minimum bbox area (w*h) — tiny slivers of big structures are noise */
  minArea?: number;
}

// Canonical class → prior. Types not listed have no prior (always pass
// AUTH 2). Ranges are deliberately loose — they exist to catch absurdities
// (a "Wall" in the bottom quarter of frame), not to be a physics engine.
const POSITION_PRIORS: Record<string, PositionPrior> = {
  wall: { centerY: [0, 0.62], minArea: 0.02 },
  backdrop: { centerY: [0, 0.62], minArea: 0.02 },
  ceiling: { centerY: [0, 0.35] },
  floor: { centerY: [0.55, 1], minArea: 0.02 },
  rug: { centerY: [0.55, 1] },
  carpet: { centerY: [0.55, 1] },
  table: { centerY: [0.35, 1] },
  desk: { centerY: [0.35, 1] },
  "coffee table": { centerY: [0.45, 1] },
  "side table": { centerY: [0.35, 1] },
  shelf: { centerY: [0, 0.85] },
  counter: { centerY: [0.35, 1] },
  couch: { centerY: [0.3, 1], minArea: 0.02 },
  sofa: { centerY: [0.3, 1], minArea: 0.02 },
};

function priorFor(surfaceType: string): PositionPrior | null {
  const key = surfaceType.toLowerCase().trim();
  if (POSITION_PRIORS[key]) return POSITION_PRIORS[key];
  // Substring fallback: "Studio_desk" → desk prior, "Backdrop wall" → wall
  for (const [k, v] of Object.entries(POSITION_PRIORS)) {
    if (key.includes(k)) return v;
  }
  return null;
}

export function passesPositionPrior(surfaceType: string, bbox: { x: number; y: number; width: number; height: number }): boolean {
  const prior = priorFor(surfaceType);
  if (!prior) return true;
  const cy = bbox.y + bbox.height / 2;
  const cx = bbox.x + bbox.width / 2;
  if (prior.centerY && (cy < prior.centerY[0] || cy > prior.centerY[1])) return false;
  if (prior.centerX && (cx < prior.centerX[0] || cx > prior.centerX[1])) return false;
  if (prior.minArea && bbox.width * bbox.height < prior.minArea) return false;
  return true;
}

// ── Geometry ───────────────────────────────────────────────────────

export function bboxIoU(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function centerDistance(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2, by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── Consensus ──────────────────────────────────────────────────────

export interface ConsensusOptions {
  /** IoU at/above which two same-type detections are the same surface */
  iouThreshold?: number;
  /** Fallback: same-type detections whose centers are this close (normalized) also match — catches loose boxes on big structures */
  centerThreshold?: number;
  /** Minimum distinct-frame votes for a surface to survive (AUTH 1) */
  minVotes?: number;
  /** Normalize a raw label to its canonical form (scanner's synonym table); defaults to lowercase trim */
  normalizeType?: (raw: string) => string;
}

/**
 * Fuse per-frame detections for ONE scene into a canonical surface set.
 *
 * A surface survives only if:
 *  - detected in >= minVotes DISTINCT frames at a compatible position (AUTH 1)
 *  - its consensus bbox satisfies its class position prior (AUTH 2)
 *
 * With a single analyzed frame (degenerate scene), minVotes clamps to 1 —
 * consensus can't manufacture certainty from one sample, but AUTH 2 still
 * filters implausible boxes.
 */
export function buildSceneConsensus(
  frames: FrameDetection[],
  options: ConsensusOptions = {},
): SceneConsensusResult {
  const iouThreshold = options.iouThreshold ?? 0.25;
  const centerThreshold = options.centerThreshold ?? 0.18;
  const normalize = options.normalizeType ?? ((raw: string) => raw.toLowerCase().trim());
  const framesAnalyzed = frames.length;
  const minVotes = Math.min(options.minVotes ?? 2, Math.max(1, framesAnalyzed));

  const rejected: ConsensusRejection[] = [];

  interface Cluster {
    surfaceType: string;
    members: Array<{ frameT: number; confidence: number; bbox: FrameDetection["surfaces"][number]["bbox"]; ref?: unknown }>;
  }
  const clusters: Cluster[] = [];

  for (const frame of frames) {
    for (const det of frame.surfaces) {
      const type = normalize(det.surfaceType);

      // AUTH 2 per-detection: implausible boxes never even get to vote —
      // a floor-positioned "Wall" shouldn't validate a real wall cluster.
      if (!passesPositionPrior(type, det.bbox)) {
        rejected.push({ surfaceType: type, bbox: det.bbox, frameT: frame.frameT, reason: "implausible_position" });
        continue;
      }

      const match = clusters.find(
        (c) =>
          c.surfaceType === type &&
          (bboxIoU(c.members[c.members.length - 1].bbox, det.bbox) >= iouThreshold ||
            centerDistance(c.members[c.members.length - 1].bbox, det.bbox) <= centerThreshold),
      );
      if (match) {
        match.members.push({ frameT: frame.frameT, confidence: det.confidence, bbox: det.bbox, ref: det.ref });
      } else {
        clusters.push({ surfaceType: type, members: [{ frameT: frame.frameT, confidence: det.confidence, bbox: det.bbox, ref: det.ref }] });
      }
    }
  }

  const surfaces: ConsensusSurface[] = [];
  for (const cluster of clusters) {
    const distinctFrames = new Set(cluster.members.map((m) => m.frameT));
    if (distinctFrames.size < minVotes) {
      // AUTH 1 failure: one-frame wonder
      for (const m of cluster.members) {
        rejected.push({ surfaceType: cluster.surfaceType, bbox: m.bbox, frameT: m.frameT, reason: "single_frame" });
      }
      continue;
    }

    const bbox = {
      x: median(cluster.members.map((m) => m.bbox.x)),
      y: median(cluster.members.map((m) => m.bbox.y)),
      width: median(cluster.members.map((m) => m.bbox.width)),
      height: median(cluster.members.map((m) => m.bbox.height)),
    };
    const meanConf = cluster.members.reduce((s, m) => s + m.confidence, 0) / cluster.members.length;
    const support = distinctFrames.size / Math.max(1, framesAnalyzed);

    surfaces.push({
      surfaceType: cluster.surfaceType,
      bbox,
      // Support-weighted: full-agreement surfaces keep their confidence,
      // bare-majority ones are discounted. Floor at 0.5 so a real 2/3
      // surface isn't crushed below usability.
      confidence: Math.min(1, meanConf * (0.5 + 0.5 * support)),
      votes: distinctFrames.size,
      framesAnalyzed,
      supportTimestamps: Array.from(distinctFrames).sort((a, b) => a - b),
      members: cluster.members,
    });
  }

  surfaces.sort((a, b) => b.confidence - a.confidence);
  return { surfaces, rejected };
}
