/**
 * Where the dead air is.
 *
 * Silence removal is the feature that makes a talking-head clip watchable,
 * and it is the one place in the toolkit that needs a real analysis pass
 * rather than a parameter: you cannot cut gaps you haven't measured.
 *
 * ffmpeg's `silencedetect` writes spans to stderr as it decodes; this runs it
 * over the clip's range only (not the whole source), parses the pairs, and
 * returns clip-relative spans. The render pass turns those into the segment
 * timeline — see editStack.compileTimeline, which resolves them together with
 * speed ramps so audio and video stay locked.
 *
 * Deliberately does NOT apply padding here. The creator can change padding
 * without re-analyzing, so the raw measurement is what gets stored and the
 * padding is applied at compile time.
 */

import { spawn } from "child_process";
import { getFfmpegCapabilities } from "./ffmpegCapabilities";

export interface SilenceSpan {
  /** Clip-relative seconds. */
  start: number;
  end: number;
}

export interface SilenceAnalysis {
  spans: SilenceSpan[];
  /** Total silent seconds found, before padding. */
  totalSilentSec: number;
  /** What the analysis ran with, so a stored result is interpretable. */
  thresholdDb: number;
  minDurationSec: number;
  /** Set when analysis could not run; spans is then empty. */
  unavailableReason?: string;
}

const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @param videoPath  source file
 * @param clipStart  seconds into the source where the clip begins
 * @param clipDuration  clip length in seconds
 */
export async function analyzeSilence(
  videoPath: string,
  clipStart: number,
  clipDuration: number,
  opts: { thresholdDb?: number; minDurationSec?: number } = {},
): Promise<SilenceAnalysis> {
  const thresholdDb = Math.min(-20, Math.max(-50, Number(opts.thresholdDb ?? -35)));
  const minDurationSec = Math.min(3, Math.max(0.15, Number(opts.minDurationSec ?? 0.6)));

  const caps = await getFfmpegCapabilities();
  if (!caps.silencedetect) {
    return {
      spans: [], totalSilentSec: 0, thresholdDb, minDurationSec,
      unavailableReason: "This server's ffmpeg has no silencedetect filter.",
    };
  }

  const args = [
    "-nostdin", "-hide_banner",
    "-ss", String(Math.max(0, clipStart)),
    "-t", String(Math.max(0, clipDuration)),
    "-i", videoPath,
    "-map", "0:a:0?",
    "-af", `silencedetect=noise=${thresholdDb}dB:d=${minDurationSec}`,
    "-f", "null", "-",
  ];

  const stderr = await new Promise<string>((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let buf = "";
    proc.stderr.on("data", (d) => { buf += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Silence analysis timed out after ${ANALYSIS_TIMEOUT_MS}ms`));
    }, ANALYSIS_TIMEOUT_MS);
    proc.on("close", () => { clearTimeout(timer); resolve(buf); });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });

  // silencedetect emits "silence_start: N" and "silence_end: N | silence_duration: D".
  // A clip that ends mid-silence gets a start with no matching end — closed at
  // the clip boundary rather than dropped, since trailing dead air is exactly
  // what a creator wants gone.
  const spans: SilenceSpan[] = [];
  let open: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { open = Math.max(0, parseFloat(s[1])); continue; }
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && open !== null) {
      const end = Math.min(clipDuration, parseFloat(e[1]));
      if (end > open) spans.push({ start: open, end });
      open = null;
    }
  }
  if (open !== null && clipDuration - open > minDurationSec) {
    spans.push({ start: open, end: clipDuration });
  }

  // Audio streams can lag video by a frame or two; a span that starts at
  // literally 0 usually means the clip opens on a beat of room tone, which is
  // a legitimate cut, so it is kept.
  const merged: SilenceSpan[] = [];
  for (const sp of spans.sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && sp.start - last.end < 0.05) { last.end = Math.max(last.end, sp.end); continue; }
    merged.push({ ...sp });
  }

  const totalSilentSec = merged.reduce((acc, s) => acc + (s.end - s.start), 0);
  console.log(
    `[SilenceAnalysis] ${merged.length} span(s), ${totalSilentSec.toFixed(1)}s of ${clipDuration.toFixed(1)}s ` +
    `at ${thresholdDb}dB / ${minDurationSec}s`,
  );
  return { spans: merged, totalSilentSec, thresholdDb, minDurationSec };
}

/**
 * Stabilization pass 1 — vidstabdetect, when the build has it.
 *
 * vidstab is two-pass by design: detect writes a transforms file, transform
 * consumes it. Builds without libvidstab fall back to single-pass deshake in
 * the graph builder, which needs no analysis, so a null here is normal rather
 * than an error.
 */
export async function analyzeStabilization(
  videoPath: string,
  clipStart: number,
  clipDuration: number,
  transformsPath: string,
  strength: number,
): Promise<string | null> {
  const caps = await getFfmpegCapabilities();
  if (!caps.vidstab) return null;

  const shakiness = Math.min(10, Math.max(1, Math.round(strength)));
  const args = [
    "-nostdin", "-hide_banner", "-y",
    "-ss", String(Math.max(0, clipStart)),
    "-t", String(Math.max(0, clipDuration)),
    "-i", videoPath,
    "-vf", `vidstabdetect=shakiness=${shakiness}:accuracy=15:result=${transformsPath}`,
    "-f", "null", "-",
  ];

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", args);
      let err = "";
      proc.stderr.on("data", (d) => { err += d.toString(); });
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("vidstabdetect timed out"));
      }, ANALYSIS_TIMEOUT_MS);
      proc.on("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`vidstabdetect exited ${code}: ${err.slice(-200)}`));
      });
      proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    return transformsPath;
  } catch (err: any) {
    // Analysis failure degrades to deshake rather than failing the render.
    console.warn(`[Stabilize] vidstabdetect failed, falling back to deshake: ${err?.message}`);
    return null;
  }
}
