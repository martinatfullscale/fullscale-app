#!/usr/bin/env node
// Stage 2 of the Creates content-library pipeline: turn masters into web
// deliverables.
//
// Two tiers, because 302 minutes of runtime at one quality is either too big or
// too soft. The featured ten carry the landing page and get 1080p; the 152 in
// the gallery are behind a poster until someone clicks, so they get 720p at a
// lower rate. Combined that lands near 3.8GB instead of ~9GB at a flat 1080p.
//
// `+faststart` is the flag that actually matters. Without it the moov atom sits
// at the end of the file and a browser downloads the whole thing before showing
// a frame — a 40MB clip becomes a 40MB wait.
//
//   node scripts/creates-library/transcode.mjs [--soft] [--only <slug>] [--jobs N]
//
//     --soft   use libx264 instead of the hardware encoder (slower, slightly
//              better at a given size; use if videotoolbox output looks wrong)
//     --only   transcode a single slug, for checking settings before committing
//              to a multi-hour run
//
// Reads manifest.draft.json, writes out/<slug>.mp4 + out/<slug>.jpg and
// manifest.local.json. Idempotent: an output newer than its source is skipped,
// so an interrupted run resumes where it stopped.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRAFT = path.join(HERE, "manifest.draft.json");
const LOCAL = path.join(HERE, "manifest.local.json");
const OUT_DIR = path.join(HERE, "out");

// Featured pieces sit at full width on the landing page; catalogue pieces open
// in a lightbox from a poster grid. Different jobs, different budgets.
const TIERS = {
  featured:  { longEdge: 1920, videoKbps: 4000, posterEdge: 1600 },
  catalogue: { longEdge: 1280, videoKbps: 1600, posterEdge: 1280 },
};

const args = process.argv.slice(2);
const SOFT = args.includes("--soft");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const JOBS = args.includes("--jobs") ? Math.max(1, Number(args[args.indexOf("--jobs") + 1])) : 2;

function run(bin, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, argv, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; if (err.length > 60_000) err = err.slice(-30_000); });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}\n${err.slice(-1500)}`)));
  });
}

/**
 * Scale so the LONG edge is at most `long`, never upscale, and force even
 * dimensions — H.264 with yuv420p cannot encode an odd width or height, and
 * ffmpeg's error for it is not obvious.
 */
function scaleFilter(long) {
  return `scale='if(gte(iw,ih),min(${long},iw),-2)':'if(gte(iw,ih),-2,min(${long},ih))'` +
         `,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
}

function videoCodecArgs(kbps) {
  if (SOFT) {
    // CRF with a ceiling: quality-targeted, but a busy sizzle reel can't run
    // away with the bitrate budget.
    return [
      "-c:v", "libx264", "-preset", "medium", "-crf", "23",
      "-maxrate", `${Math.round(kbps * 1.4)}k`, "-bufsize", `${Math.round(kbps * 2.8)}k`,
    ];
  }
  // videotoolbox has no usable CRF mode — it is rate-targeted, so give it a
  // rate plus headroom for motion.
  return [
    "-c:v", "h264_videotoolbox",
    "-b:v", `${kbps}k`,
    "-maxrate", `${Math.round(kbps * 1.5)}k`,
    "-bufsize", `${Math.round(kbps * 3)}k`,
  ];
}

async function isFresh(out, sourceMtimeMs) {
  try {
    const st = await fs.stat(out);
    return st.size > 0 && st.mtimeMs >= sourceMtimeMs;
  } catch {
    return false;
  }
}

async function transcodeOne(video, sourceDir) {
  const tier = video.featuredRank ? TIERS.featured : TIERS.catalogue;
  const src = path.join(sourceDir, video.sourceFile);
  const mp4 = path.join(OUT_DIR, `${video.slug}.mp4`);
  const jpg = path.join(OUT_DIR, `${video.slug}.jpg`);

  // The masters live on an external drive that is not always mounted. Without
  // it the video cannot be re-encoded, but a poster can still be cut from the
  // transcode we already have — so a poster fix never waits on the drive.
  let st = null;
  try { st = await fs.stat(src); } catch { /* master unavailable */ }
  const result = { slug: video.slug, skipped: true };

  if (st && !(await isFresh(mp4, st.mtimeMs))) {
    const partial = `${mp4}.partial.mp4`;
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", src,
      "-vf", scaleFilter(tier.longEdge),
      ...videoCodecArgs(tier.videoKbps),
      "-pix_fmt", "yuv420p",
      "-profile:v", "high",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      // Some masters carry timecode or data streams the browser cannot use and
      // ffmpeg will happily try to copy into an mp4.
      "-map", "0:v:0", "-map", "0:a:0?",
      "-movflags", "+faststart",
      partial,
    ]);
    // Rename only on a zero exit, so an interrupted run never leaves a
    // truncated file that `isFresh` would then treat as done.
    await fs.rename(partial, mp4);
    result.skipped = false;
  } else if (!st) {
    try { await fs.access(mp4); } catch {
      throw new Error(`master unavailable (${video.sourceFile}) and no transcode to fall back on`);
    }
  }

  // With the master gone there is no source mtime to compare against, so an
  // existing poster is kept; delete the .jpg to force a re-cut.
  const posterSrc = st ? src : mp4;
  if (!(await isFresh(jpg, st ? st.mtimeMs : 0))) {
    // An explicit posterAt wins. Otherwise 10% in — far enough past a
    // fade-from-black or a slate to usually be a real frame.
    const at = typeof video.posterAt === "number"
      ? video.posterAt
      : Math.max(0.5, (video.durationSec || 10) * 0.1);
    const partial = `${jpg}.partial.jpg`;
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(at), "-i", posterSrc,
      "-frames:v", "1",
      "-vf", scaleFilter(tier.posterEdge),
      "-q:v", "3",
      partial,
    ]);
    await fs.rename(partial, jpg);
    result.skipped = false;
  }

  const [vs, ps] = await Promise.all([fs.stat(mp4), fs.stat(jpg)]);
  result.outBytes = vs.size;
  result.posterBytes = ps.size;
  result.tier = video.featuredRank ? "featured" : "catalogue";
  return result;
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(DRAFT, "utf8"));
  await fs.mkdir(OUT_DIR, { recursive: true });

  let queue = manifest.videos.filter((v) => !v.probeError);
  if (ONLY) queue = queue.filter((v) => v.slug === ONLY);
  if (!queue.length) {
    console.error(ONLY ? `No video with slug "${ONLY}"` : "Nothing to transcode.");
    process.exit(1);
  }

  console.log(`Transcoding ${queue.length} videos with ${SOFT ? "libx264" : "h264_videotoolbox"}, ${JOBS} at a time`);
  console.log(`  featured  -> ${TIERS.featured.longEdge}px @ ${TIERS.featured.videoKbps}kbps`);
  console.log(`  catalogue -> ${TIERS.catalogue.longEdge}px @ ${TIERS.catalogue.videoKbps}kbps\n`);

  const results = new Map();
  const failures = [];
  let done = 0;
  let cursor = 0;

  // Hand-rolled pool rather than a dependency: the hardware encoder has a small
  // number of sessions and more parallelism makes it slower, not faster.
  async function worker() {
    while (cursor < queue.length) {
      const v = queue[cursor++];
      const n = ++done;
      try {
        const r = await transcodeOne(v, manifest.sourceDir);
        results.set(v.slug, r);
        console.log(
          `${String(n).padStart(3)}/${queue.length} ${r.skipped ? "skip" : " ok "} ` +
          `${(r.outBytes / 1e6).toFixed(1).padStart(6)}MB  ${v.title.slice(0, 48)}`,
        );
      } catch (err) {
        failures.push({ slug: v.slug, title: v.title, error: err.message.split("\n")[0] });
        console.log(`${String(n).padStart(3)}/${queue.length} FAIL       ${v.title.slice(0, 48)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: JOBS }, worker));

  const out = {
    ...manifest,
    transcodedAt: new Date().toISOString(),
    outDir: OUT_DIR,
    videos: manifest.videos.map((v) => {
      const r = results.get(v.slug);
      return r ? { ...v, outBytes: r.outBytes, posterBytes: r.posterBytes, tier: r.tier } : v;
    }),
  };
  await fs.writeFile(LOCAL, JSON.stringify(out, null, 2) + "\n", "utf8");

  const totalOut = [...results.values()].reduce((n, r) => n + r.outBytes + r.posterBytes, 0);
  const totalIn = manifest.videos.reduce((n, v) => n + (v.sizeBytes || 0), 0);
  console.log(`\nWrote ${LOCAL}`);
  console.log(`  ${results.size} ok, ${failures.length} failed`);
  console.log(`  ${(totalIn / 1e9).toFixed(1)} GB in -> ${(totalOut / 1e9).toFixed(2)} GB out`);
  for (const f of failures) console.log(`  FAILED ${f.slug}: ${f.error}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
