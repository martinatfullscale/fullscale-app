/**
 * The editor's data model, in one place.
 *
 * These shapes are the client half of a contract whose other half is the
 * validator at server/routes.ts (POST /api/editorial-clips/:id/rerender) and
 * the filtergraph builder at server/lib/remix/editStack.ts. A field that is
 * not in all three does not survive a save — which is how `wordsPerPhrase`
 * and `outline` ended up in the payload with no control writing them.
 */

export interface Word { word: string; start: number; end: number; confidence?: number }
export interface Segment { start: number; end: number; text: string; speaker?: string; words?: Word[] }

export interface WordCut { start: number; end: number; text?: string; reason?: "filler" | "manual" }

export interface TextOverlayEdit {
  start: number; end: number; text: string;
  x: number; y: number; size: number;
  color: string; background: string | null;
  weight: "regular" | "bold"; align: "left" | "center" | "right";
}

export interface BrollEdit {
  assetId: number;
  /** Placement on the OUTPUT timeline, clip-relative seconds. */
  start: number;
  end: number;
  /**
   * Which part of the SOURCE file plays, in source seconds. Optional: absent
   * means "from the head", the behaviour before the field existed. Ignored
   * for stills, which have no source timeline.
   */
  srcStart?: number;
  srcEnd?: number;
  fit: string;
  scale: number;
  x: number;
  y: number;
  muted: boolean;
  /** Ken Burns for stills — a static full-frame image reads as a freeze. */
  motion?: "push" | "pull" | "none";
}

export interface StudioEdits {
  wordCuts?: WordCut[];
  silenceCut?: { enabled: boolean; thresholdDb: number; minDurationSec: number; paddingSec: number } | null;
  speedRamps?: Array<{ start: number; end: number; rate: number }>;
  captionEdits?: Array<{ start: number; end: number; text: string }>;
  textOverlays?: TextOverlayEdit[];
  broll?: BrollEdit[];
  music?: { assetId: number; volume: number; ducking: boolean; duckAmountDb: number; fadeInSec: number; fadeOutSec: number } | null;
  stabilization?: { enabled: boolean; strength: number } | null;
  /**
   * Gain on the clip's own audio, 0-2 where 1 is untouched. Only stored when
   * it differs from unity, so an untouched clip's payload is unchanged from
   * before the field existed.
   */
  baseAudioLevel?: number | null;
  /**
   * Razor cuts on the base track, as clip-relative times.
   *
   * The renderer ignores this — a boundary with nothing on either side of it
   * changes no frames. It exists so a split SURVIVES A RELOAD, and so the
   * inspector has a segment to attach a speed or a deletion to. Setting a
   * rate on a segment writes a speedRamp; deleting one writes a wordCut.
   * Both of those are what the filtergraph actually reads.
   */
  splits?: number[];
}

export interface AssetRow {
  id: number;
  kind: string;
  name: string;
  url: string;
  durationSec: string | null;
  createdAt?: string | null;
}

export interface ClipShape {
  id: number;
  clipStart: number;
  clipEnd: number;
  duration: number;
  suggestedTitle?: string | null;
  aspectRatio?: string | null;
  exportPath?: string | null;
  thumbnailPath?: string | null;
  renderStatus?: string | null;
  captionsEnabled?: boolean | null;
  captionStyle?: string | null;
  captionSettings?: Record<string, any> | null;
  segments?: Array<{ start: number; end: number; role?: string }> | null;
  edits?: StudioEdits | null;
  silenceAnalysis?: { spans: Array<{ start: number; end: number }>; totalSilentSec: number } | null;
  renderWarnings?: string[] | null;
}

/** What is selected on the timeline. The inspector is a function of this. */
export type Selection =
  | { kind: "segment"; index: number }
  | { kind: "broll"; index: number }
  | { kind: "text"; index: number }
  | { kind: "music" }
  | null;

/** One stretch of the base track between two razor cuts. */
export interface BaseSegment {
  index: number;
  start: number;
  end: number;
  /** The speed ramp covering this segment, if any. */
  rate: number;
  /** True when the whole segment is inside a wordCut — a ripple-deleted piece. */
  removed: boolean;
}

export const fmtTime = (s: number) => {
  const m = Math.floor(Math.max(0, s) / 60);
  const sec = Math.max(0, s) % 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
};

export const fmtShort = (s: number) => {
  const m = Math.floor(Math.max(0, s) / 60);
  const sec = Math.floor(Math.max(0, s) % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

/**
 * Split the base track at every razor cut, and report what each piece carries.
 *
 * A segment's `rate` is the ramp that covers it exactly; a ramp that only
 * partly overlaps is ignored here rather than half-claimed, because the
 * inspector edits a segment as a unit.
 */
export function baseSegments(edits: StudioEdits, duration: number): BaseSegment[] {
  // Array.from rather than a spread: this repo's tsconfig targets below
  // ES2015 and downlevelIteration is off, so spreading a Set does not compile.
  const cuts = Array.from(new Set((edits.splits ?? []).filter((t) => t > 0.05 && t < duration - 0.05))).sort((a, b) => a - b);
  const bounds = [0, ...cuts, duration];
  const out: BaseSegment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end - start < 0.05) continue;
    const ramp = (edits.speedRamps ?? []).find(
      (r) => Math.abs(r.start - start) < 0.05 && Math.abs(r.end - end) < 0.05,
    );
    const removed = (edits.wordCuts ?? []).some(
      (c) => c.start <= start + 0.05 && c.end >= end - 0.05,
    );
    out.push({ index: out.length, start, end, rate: ramp?.rate ?? 1, removed });
  }
  return out;
}

/** Every removed span, merged — cuts plus enabled silence. Drives the preview. */
export function removedSpans(
  edits: StudioEdits,
  silence: { spans: Array<{ start: number; end: number }> } | null | undefined,
): Array<{ start: number; end: number }> {
  const spans = (edits.wordCuts ?? []).map((c) => ({ start: c.start, end: c.end }));
  if (edits.silenceCut?.enabled && silence?.spans) {
    const pad = edits.silenceCut.paddingSec ?? 0;
    for (const s of silence.spans) {
      const st = s.start + pad;
      const en = s.end - pad;
      if (en > st) spans.push({ start: st, end: en });
    }
  }
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 0.02) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/**
 * A clip is "assembled" when it carries two or more narrative beats.
 *
 * This is the client's copy of validClipSegments (editorialAutoPipeline.ts).
 * It matters because the whole edit stack — b-roll, text, music, speed,
 * silence removal, stabilization — is dropped at render for such a clip, and
 * the editor has to say so BEFORE the work is done rather than after.
 */
export const isAssembled = (clip: ClipShape): boolean =>
  Array.isArray(clip.segments) &&
  clip.segments.length > 1 &&
  clip.segments.every((s) => typeof s?.start === "number" && typeof s?.end === "number" && s.end > s.start);

/**
 * The clip's own audio gain, or null when it is untouched.
 *
 * Not `Number.isFinite(Number(x))`: Number(null) is 0, which is finite, so
 * that test reports an untouched clip as having a gain of zero — the editor
 * showed "clip audio 0.00x - applied at render" on every clip that had never
 * been touched, and the slider sat at silence.
 */
export function baseGainOf(edits: StudioEdits): number | null {
  const v = edits.baseAudioLevel;
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Server-side caps, mirrored so the UI can refuse before the server silently drops. */
export const CAPS = { broll: 8, textOverlays: 12, speedRamps: 8, wordCuts: 400, splits: 16 } as const;
