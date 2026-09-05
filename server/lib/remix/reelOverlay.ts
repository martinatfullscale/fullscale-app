import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { buildEditGraph, type BrollCut, type EditStack, type MusicBed, type TextOverlay } from "./editStack";

/**
 * The reel overlay engine — V1, V2 and A1.
 *
 * WHY A SECOND PASS AND NOT A REWRITE. `clipStitcher` is a strictly
 * sequential concat/xfade: one input per segment, no overlay node anywhere.
 * Making it composite would mean rebuilding the thing that already reliably
 * assembles reels. But the tracks a reel wants are not per-segment — a title,
 * a picture-in-picture, a music bed are anchored to the FINISHED reel's
 * timeline and do not care where the joins fall. So a pass over the
 * concatenated file is not a workaround; it is the shape that matches.
 *
 * The precedent is already in the stitcher: `burnCaptions` re-encodes the
 * concatenated output, writes `<out>_captioned.mp4`, unlinks the original and
 * renames over it. This does the same thing one step later, so overlays sit
 * above burned captions.
 *
 * The compositor itself is not new either. `buildEditGraph` already does
 * picture-in-picture at arbitrary scale/x/y with a time window, rasterized
 * text PNGs, and a ducked music bed — it was simply only ever called for a
 * single story clip. Handing it the finished reel as input 0 makes all three
 * compile unchanged.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CLOCK IS THE HARD PART. A reel of N segments is always crossfaded, so
 * the finished file is SHORTER than the sum of its parts by the overlap at
 * every junction. The editor lays overlays out against the naive sum, so an
 * overlay authored at 0:20 of a six-segment reel would land 2.5 seconds late
 * without a remap — and progressively worse the further in it sits. Every
 * incoming time goes through `remapReelOverlays` first. This mirrors what
 * `remapCaptionsForMode` already does for captions, and it has to stay in
 * step with it.
 */

/** What the reel editor's non-V0 tracks compile to. Deliberately a SUBSET of
 *  EditStack: the retime family (wordCuts, silenceCut, speedRamps,
 *  stabilization) is excluded, because captions are already burned into the
 *  base and every overlay anchor would shift under a retime. */
export interface ReelOverlayStack {
  /** V1 — video overlay / picture-in-picture. */
  broll?: BrollCut[] | null;
  /** V2 — rasterized text. */
  textOverlays?: TextOverlay[] | null;
  /** A1 — one music bed, with ducking. */
  music?: MusicBed | null;
  /** Gain on the reel's own audio, 0-2. */
  baseAudioLevel?: number | null;
}

export const reelOverlayStackIsEmpty = (s: ReelOverlayStack | null | undefined): boolean =>
  !s ||
  ((s.broll ?? []).length === 0 &&
    (s.textOverlays ?? []).length === 0 &&
    !s.music &&
    !(Number.isFinite(Number(s.baseAudioLevel)) && Math.abs(Number(s.baseAudioLevel) - 1) > 0.01));

/** Enough of a stitch segment to work out where its join lands. */
export interface ReelSegmentTiming {
  start: number;
  end: number;
  transitionIn: "cut" | "crossfade" | "branded_wipe";
  transitionDuration?: number;
}

const DEFAULT_CROSSFADE = 0.5;
/** The xfade path shaves a little even off a "cut" join. Matches
 *  remapCaptionsForMode in clipStitcher — change both or neither. */
const CUT_OVERLAP = 0.1;

/**
 * Offsets from the editor's naive timeline onto the finished file's.
 *
 * Returns one entry per segment: the span it occupies in AUTHORED time, and
 * the shift to apply to anything inside that span. The shift is piecewise
 * constant because only the joins overlap — a segment's own duration is
 * unchanged by the crossfade around it.
 */
export function reelTimeOffsets(segments: ReelSegmentTiming[]): Array<{ from: number; to: number; shift: number }> {
  const out: Array<{ from: number; to: number; shift: number }> = [];
  let authored = 0;
  let shift = 0;
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      shift -= segments[i].transitionIn === "cut"
        ? CUT_OVERLAP
        : segments[i].transitionDuration ?? DEFAULT_CROSSFADE;
    }
    const len = Math.max(0, segments[i].end - segments[i].start);
    out.push({ from: authored, to: authored + len, shift });
    authored += len;
  }
  return out;
}

/** The finished-file duration of a reel, given its segments. */
export function reelFinishedDuration(segments: ReelSegmentTiming[]): number {
  const spans = reelTimeOffsets(segments);
  if (spans.length === 0) return 0;
  const last = spans[spans.length - 1];
  return Math.max(0, last.to + last.shift);
}

const shiftAt = (t: number, spans: Array<{ from: number; to: number; shift: number }>): number => {
  if (spans.length === 0) return 0;
  for (const s of spans) if (t >= s.from && t < s.to) return s.shift;
  // Past the end (or exactly on it): carry the last segment's shift rather
  // than snapping to zero, which would fling a trailing overlay forward.
  return t < spans[0].from ? spans[0].shift : spans[spans.length - 1].shift;
};

/** Move every overlay onto the finished reel's clock, and drop what falls off. */
export function remapReelOverlays(stack: ReelOverlayStack, segments: ReelSegmentTiming[]): ReelOverlayStack {
  const spans = reelTimeOffsets(segments);
  const total = reelFinishedDuration(segments);
  const move = <T extends { start: number; end: number }>(x: T): T | null => {
    const s = Math.max(0, x.start + shiftAt(x.start, spans));
    const e = Math.min(total, x.end + shiftAt(x.end, spans));
    return e - s >= 0.3 ? ({ ...x, start: s, end: e } as T) : null;
  };
  return {
    ...stack,
    broll: (stack.broll ?? []).map(move).filter(Boolean) as BrollCut[],
    textOverlays: (stack.textOverlays ?? []).map(move).filter(Boolean) as TextOverlay[],
  };
}

function runFFmpeg(args: string[], timeoutMs = 600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`FFmpeg timed out after ${timeoutMs}ms`)); }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-600)}`));
      else resolve(stderr);
    });
  });
}

async function hasAudioStream(file: string): Promise<boolean> {
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileP = promisify(execFile);
    const probe = await execFileP("ffprobe", [
      "-v", "quiet", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file,
    ], { timeout: 20_000 });
    return probe.stdout.trim().length > 0;
  } catch {
    return true;   // assume audio — the common case, and the safer guess
  }
}

export interface ApplyReelOverlaysResult {
  applied: boolean;
  /** Things asked for that this render could not do, in plain words. */
  warnings: string[];
}

/**
 * Composite V1/V2/A1 over a finished reel, in place.
 *
 * `stack` must already be on the finished file's clock — call
 * remapReelOverlays first. On any failure the original file is left exactly
 * as it was: a reel without its overlays is a disappointment, a reel replaced
 * by a half-written file is a lost render.
 */
export async function applyReelOverlays(opts: {
  /** The concatenated, captioned reel. Overwritten on success. */
  inputPath: string;
  stack: ReelOverlayStack;
  /** Finished duration, from reelFinishedDuration. */
  durationSec: number;
  outWidth: number;
  outHeight: number;
  /** Scratch space for rasterized text PNGs. */
  workDir: string;
}): Promise<ApplyReelOverlaysResult> {
  const { inputPath, stack, durationSec, outWidth, outHeight, workDir } = opts;
  const warnings: string[] = [];
  if (reelOverlayStackIsEmpty(stack)) return { applied: false, warnings };
  if (!fs.existsSync(inputPath)) return { applied: false, warnings: ["Overlay pass skipped — the stitched reel was missing."] };

  const { rasterizeTextOverlays } = await import("./textOverlay");
  const textImages = await rasterizeTextOverlays(stack.textOverlays ?? [], outWidth, outHeight, workDir);

  const hasAudio = await hasAudioStream(inputPath);
  const graph = await buildEditGraph({
    // Only the compositing fields. Handing buildEditGraph a retime here would
    // re-cut a reel whose captions are already burned at fixed times.
    stack: {
      broll: stack.broll ?? null,
      textOverlays: stack.textOverlays ?? null,
      music: stack.music ?? null,
      baseAudioLevel: stack.baseAudioLevel ?? null,
    } as EditStack,
    clipDurationSec: durationSec,
    outWidth,
    outHeight,
    nextInputIndex: 1,          // the reel itself is input 0
    textImages,
    hasAudio,
  });
  warnings.push(...graph.warnings);
  if (graph.isEmpty) return { applied: false, warnings };

  const args: string[] = ["-nostdin", "-y", "-i", inputPath];
  for (const extra of graph.extraInputs) {
    if (extra.loop) args.push("-loop", "1");
    args.push("-i", extra.path);
  }

  // The bridge between the overlay chain and the text chain is `null`, not a
  // crop: the single-clip caller scales and crops here, but a stitched reel is
  // already at the platform's output size and re-scaling would soften it.
  const textParts = graph.videoPost("[vbridge]", "[vout]");
  const filterParts = [...graph.videoPre];
  filterParts.push(`${graph.videoOutLabel}null${textParts.length > 0 ? "[vbridge]" : "[vout]"}`);
  filterParts.push(...textParts);

  const maps = ["-map", "[vout]"];
  if (graph.audio && graph.audio.length > 0) {
    filterParts.push(...graph.audio);
    maps.push("-map", graph.audioOutLabel ?? "[aout]");
  } else if (hasAudio) {
    maps.push("-map", "0:a?");
  }

  args.push(
    "-filter_complex", filterParts.join(";"),
    ...maps,
    // Bound the output to the reel's own length. A looped still or a music
    // bed longer than the reel would otherwise extend it.
    "-t", durationSec.toFixed(3),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "20",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
  );

  const outPath = inputPath.replace(/\.mp4$/i, "_overlaid.mp4");
  args.push(outPath);

  try {
    await runFFmpeg(args);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
      throw new Error("the overlay pass produced no usable file");
    }
    fs.unlinkSync(inputPath);
    fs.renameSync(outPath, inputPath);
    return { applied: true, warnings };
  } catch (err: any) {
    // Leave the base reel intact and say what was lost. Half a render is
    // worse than a render without its titles.
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* best effort */ }
    console.error(`[ReelOverlay] Overlay pass failed: ${err?.message || err}`);
    warnings.push(`Overlays were not applied — ${err?.message || "the overlay pass failed"}. The reel itself rendered.`);
    return { applied: false, warnings };
  } finally {
    for (const t of textImages) { try { fs.unlinkSync(t.path); } catch { /* temp */ } }
  }
}

/** Where a reel's overlay scratch lives. Sits beside the output, so the
 *  route's existing cleanup takes it with everything else. */
export const reelOverlayWorkDir = (outputDir: string) => path.join(outputDir, "overlay-work");
