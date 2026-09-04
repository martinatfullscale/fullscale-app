/**
 * What this machine's ffmpeg can actually do.
 *
 * ffmpeg builds differ in which filters are compiled in, and the difference
 * is not cosmetic: `vidstabdetect`/`vidstabtransform` need --enable-libvidstab,
 * `drawtext` needs libfreetype, `ass` needs libass. A filtergraph naming a
 * filter this build lacks fails the WHOLE render with "No such filter", so a
 * missing optional feature would take the clip down with it.
 *
 * Probed once per process and cached. Every caller is expected to degrade
 * with a recorded reason rather than emitting a graph ffmpeg will reject —
 * "stabilization unavailable on this server" is a usable answer; a render
 * that dies at 90% is not.
 */

import { spawn } from "child_process";

export interface FfmpegCapabilities {
  /** Two-pass vidstab. The good stabilizer. */
  vidstab: boolean;
  /** Single-pass deshake. Weaker, but present in most stock builds. */
  deshake: boolean;
  /** Text rendered by ffmpeg itself. We do NOT rely on this — text overlays
   *  are rasterized with sharp and composited — but it's recorded because a
   *  build without it also tends to lack `ass`. */
  drawtext: boolean;
  /** libass subtitle burn-in — the caption path's preferred renderer. */
  ass: boolean;
  /** Ducking a music bed under speech. */
  sidechaincompress: boolean;
  /** Music bed mixing. */
  amix: boolean;
  /** Speed ramps on the audio side. */
  atempo: boolean;
  /** Silence analysis. */
  silencedetect: boolean;
  /** Segment-based re-timing (silence removal, speed ramps). */
  trim: boolean;
  concat: boolean;
  /** Everything the b-roll and product-overlay paths need. Effectively
   *  always present; checked so a broken build fails loudly at probe time. */
  overlay: boolean;
}

let cached: FfmpegCapabilities | null = null;
let inflight: Promise<FfmpegCapabilities> | null = null;

const FALLBACK: FfmpegCapabilities = {
  // Assume only the universally-compiled filters when the probe itself fails.
  vidstab: false, deshake: false, drawtext: false, ass: false,
  sidechaincompress: false, amix: false, atempo: false, silencedetect: false,
  trim: true, concat: true, overlay: true,
};

function probe(): Promise<string> {
  return new Promise((resolve) => {
    try {
      const proc = spawn("ffmpeg", ["-hide_banner", "-filters"]);
      let out = "";
      proc.stdout.on("data", (d) => { out += d.toString(); });
      proc.stderr.on("data", () => { /* filter list goes to stdout */ });
      const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(""); }, 10_000);
      proc.on("close", () => { clearTimeout(timer); resolve(out); });
      proc.on("error", () => { clearTimeout(timer); resolve(""); });
    } catch {
      resolve("");
    }
  });
}

export async function getFfmpegCapabilities(): Promise<FfmpegCapabilities> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const list = await probe();
    if (!list) {
      console.warn("[FfmpegCaps] Could not enumerate filters — assuming a minimal build");
      cached = FALLBACK;
      return cached;
    }
    /**
     * Filter names sit in the second column of `ffmpeg -filters`.
     *
     * The flags column is NOT a fixed width across builds. ffmpeg 6 (the
     * bundled ffmpeg-static) prints three characters — " ..C amix" — while
     * ffmpeg 8 prints two — " .. amix". The original `[A-Z.]{3}` matched only
     * the former, so on a newer build every single filter failed to parse,
     * `names` came back empty, and every capability resolved to false. That is
     * worse than the FALLBACK, which at least assumes trim/concat/overlay:
     * silence removal, speed ramps, the music bed and ducking would all switch
     * themselves off silently, with a plausible-looking warning each, and the
     * renders would just quietly stop doing what the editor said they would.
     *
     * 2-4 flag characters, and an explicit name charset so a legend line like
     * "  T.. = Timeline support" cannot be mistaken for a filter.
     */
    const names = new Set<string>();
    for (const line of list.split("\n")) {
      const m = /^\s*[A-Z.]{2,4}\s+([A-Za-z0-9_]+)\s/.exec(line);
      if (m) names.add(m[1]);
    }
    // A build with no recognisable filters means the format changed again.
    // Say so loudly and take the fallback rather than reporting "no features".
    if (names.size < 10) {
      console.warn(
        `[FfmpegCaps] Parsed only ${names.size} filter name(s) from \`ffmpeg -filters\` — the output format is not one this parser knows. ` +
        `Assuming a minimal build rather than reporting every feature as missing.`,
      );
      cached = FALLBACK;
      return cached;
    }
    const has = (n: string) => names.has(n);
    cached = {
      vidstab: has("vidstabdetect") && has("vidstabtransform"),
      deshake: has("deshake"),
      drawtext: has("drawtext"),
      ass: has("ass") || has("subtitles"),
      sidechaincompress: has("sidechaincompress"),
      amix: has("amix"),
      atempo: has("atempo"),
      silencedetect: has("silencedetect"),
      trim: has("trim") && has("atrim"),
      concat: has("concat"),
      overlay: has("overlay"),
    };
    console.log(
      `[FfmpegCaps] stabilize=${cached.vidstab ? "vidstab" : cached.deshake ? "deshake" : "none"} ` +
      `ass=${cached.ass} music=${cached.amix} duck=${cached.sidechaincompress} ` +
      `retime=${cached.trim && cached.concat} silence=${cached.silencedetect}`,
    );
    return cached;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Test seam — lets a caller force a capability set. */
export function __setFfmpegCapabilitiesForTest(caps: FfmpegCapabilities | null): void {
  cached = caps;
}
