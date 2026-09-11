/**
 * Where a placement sits on the timeline of the post that carried it.
 *
 * Placement positions are source-video seconds. A post is often not the source
 * upload: it can be a trimmed clip, or an assembled one stitched from beats
 * across the video. Go-live used to record no clip at all, and the retention
 * readout scored every exposure against the source upload's curve, including
 * clips posted on their own, which are a different video with a different
 * audience.
 *
 * Pure on purpose: no storage, so the mapping is testable without a database.
 */

export interface ClipTiming {
  id: number;
  clipStart: number;
  duration: number;
  segments?: Array<{ start: number; end: number }> | null;
}

export type PostTimeline =
  /** The post is the source upload, so post seconds are source seconds. */
  | { kind: "source"; editorialClipId: null; offsetSec: 0 }
  /** A clip: post seconds = source seconds − offsetSec, for this placement's moment. */
  | { kind: "clip"; editorialClipId: number; offsetSec: number }
  /** A clip that doesn't contain this placement's moment, or no moment to map. */
  | { kind: "clip-unmapped"; editorialClipId: number; offsetSec: null; reason: string }
  | { kind: "unknown"; editorialClipId: null; offsetSec: null; reason: string };

/** The renderer's own test (validClipSegments): two or more well-formed beats. */
function assembledBeats(clip: ClipTiming): Array<{ start: number; end: number }> | null {
  const segs = clip.segments;
  if (!Array.isArray(segs) || segs.length < 2) return null;
  const ok = segs.every((s) => typeof s?.start === "number" && typeof s?.end === "number" && s.end > s.start);
  return ok ? segs : null;
}

export function resolvePostTimeline(args: {
  /** The published post's platform id. */
  platformPostId: string | null;
  /** The source upload's own platform id (video_index.youtubeId). */
  sourcePlatformPostId: string | null;
  /** The clip this placement was authored for, when it has one. */
  clip: ClipTiming | null;
  /** The placement's moment, in source-video seconds. */
  sourceSec: number | null;
}): PostTimeline {
  const { platformPostId, sourcePlatformPostId, clip, sourceSec } = args;
  if (platformPostId && sourcePlatformPostId && platformPostId === sourcePlatformPostId) {
    return { kind: "source", editorialClipId: null, offsetSec: 0 };
  }
  if (!clip) {
    return {
      kind: "unknown", editorialClipId: null, offsetSec: null,
      reason: "the post isn't the source upload, and no clip is linked to this placement",
    };
  }
  if (sourceSec == null || !Number.isFinite(sourceSec)) {
    return {
      kind: "clip-unmapped", editorialClipId: clip.id, offsetSec: null,
      reason: "the placement has no timestamp to place inside the clip",
    };
  }

  const beats = assembledBeats(clip);
  if (!beats) {
    const end = clip.clipStart + clip.duration;
    if (sourceSec < clip.clipStart || sourceSec > end) {
      return {
        kind: "clip-unmapped", editorialClipId: clip.id, offsetSec: null,
        reason: `the placement (${sourceSec}s) is outside the clip (${clip.clipStart}–${end}s)`,
      };
    }
    return { kind: "clip", editorialClipId: clip.id, offsetSec: clip.clipStart };
  }

  // Beats play back to back in the order stored, so a moment's post time is
  // the length of every earlier beat plus how far into its own beat it falls.
  let elapsed = 0;
  for (const beat of beats) {
    if (sourceSec >= beat.start && sourceSec <= beat.end) {
      const postSec = elapsed + (sourceSec - beat.start);
      return { kind: "clip", editorialClipId: clip.id, offsetSec: sourceSec - postSec };
    }
    elapsed += beat.end - beat.start;
  }
  return {
    kind: "clip-unmapped", editorialClipId: clip.id, offsetSec: null,
    reason: `the placement (${sourceSec}s) isn't inside any beat of this assembled clip`,
  };
}

export interface RetentionCurveRow {
  platformPostId?: string | null;
  videoDurationSec?: string | number | null;
  curve?: Array<{ ratio: number; watchRatio: number; relativePerformance?: number | null }> | null;
  capturedAt?: Date | string | null;
}

export interface RetentionReading {
  positionRatio: number;
  postRelativeSec: number;
  watchRatioAtPlacement: number;
  videoMeanWatchRatio: number;
  /** >0 means more viewers than average were present while the product was on screen. */
  liftVsVideoMean: number;
  relativePerformanceAtPlacement: number | null;
  curvePoints: number;
  capturedAt: Date | string | null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Read the retention curve at the moment a placement was on screen, or say why
 * it can't be. The captured curve belongs to the source upload, so it is used
 * only when the post IS the source upload.
 */
export function retentionAtPlacement(args: {
  exposure: { platformPostId?: string | null; sourceStartSec?: string | number | null };
  curve: RetentionCurveRow | undefined;
  /** The source upload's platform id, for curve rows saved before they recorded one. */
  sourcePlatformPostId: string | null;
}): { retention: RetentionReading; reason: null } | { retention: null; reason: string } {
  const { exposure, curve, sourcePlatformPostId } = args;
  const points = Array.isArray(curve?.curve) ? curve!.curve! : [];
  if (points.length === 0) {
    return { retention: null, reason: "no retention curve yet (below YouTube's reporting threshold, or not captured)" };
  }
  const postId = exposure.platformPostId ? String(exposure.platformPostId) : null;
  const curvePostId = curve?.platformPostId ? String(curve.platformPostId) : sourcePlatformPostId;
  if (!postId) {
    return { retention: null, reason: "no post id on this exposure, so there's no telling whose retention curve applies" };
  }
  if (!curvePostId || postId !== curvePostId) {
    return {
      retention: null,
      reason: "this post isn't the source upload (a clip or a re-upload); only the source upload's curve is captured, and it describes a different audience",
    };
  }

  const sourceStart = exposure.sourceStartSec != null ? parseFloat(String(exposure.sourceStartSec)) : NaN;
  const durationSec = curve?.videoDurationSec != null ? parseFloat(String(curve.videoDurationSec)) : NaN;
  if (!Number.isFinite(sourceStart) || !Number.isFinite(durationSec) || durationSec <= 0) {
    return { retention: null, reason: "missing placement timestamp or video duration — cannot position on the curve" };
  }
  // The post is the source upload, so its seconds are source seconds.
  const postRelativeSec = Math.max(0, sourceStart);
  const positionRatio = Math.min(1, postRelativeSec / durationSec);
  // Nearest bucket at or before the placement position.
  let at = points[0];
  for (const pt of points) {
    if (pt.ratio <= positionRatio) at = pt; else break;
  }
  const meanWatch = points.reduce((sum, p) => sum + p.watchRatio, 0) / points.length;
  return {
    retention: {
      positionRatio: round3(positionRatio),
      postRelativeSec: Math.round(postRelativeSec),
      watchRatioAtPlacement: round3(at.watchRatio),
      videoMeanWatchRatio: round3(meanWatch),
      liftVsVideoMean: round3(at.watchRatio - meanWatch),
      relativePerformanceAtPlacement: at.relativePerformance ?? null,
      curvePoints: points.length,
      capturedAt: curve?.capturedAt ?? null,
    },
    reason: null,
  };
}
