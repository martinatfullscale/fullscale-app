// Scene-first video indexing.
//
// Why this exists: ffmpeg gives us shot-cut timestamps but doesn't tell us
// which shots are the SAME scene returning. In a podcast filmed with two
// cameras (host shot, guest shot) we cut back and forth between two angles of
// the same set ten times — that's not ten scenes, it's two scenes
// alternating. The product placement model needs to know that, otherwise:
//   - we re-scan the same set ten times for surfaces
//   - a placement on the coffee table at :08 doesn't carry over to :46 even
//     though it's the same physical coffee table
//
// This module takes the ffmpeg cut list, extracts one keyframe per shot,
// computes a perceptual hash (dHash) per keyframe, and clusters shots whose
// hashes are visually close into named scene IDs. The result feeds the
// scanner so surface detection runs once per unique scene, not per shot.
//
// dHash specifics:
//   - Resize to 9x8 grayscale → 9 columns, 8 rows
//   - For each row, set bit if pixel[i] > pixel[i+1] (8 bits per row)
//   - Concatenate to 64-bit fingerprint
//   - Hamming distance < 12 = likely same scene
//
// dHash is robust to brightness/contrast shifts and small framing changes —
// good for "host shot returns" detection. Less robust to large camera angle
// changes within the same set; for those we'll layer in DINOv2 embeddings
// later. dHash buys us ~80% of the value with zero external dependencies.
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";

export interface SceneShot {
  shotIdx: number;       // 0-based position in cut order
  sceneId: number;       // 0-based unique scene cluster ID
  tStart: number;        // Shot start time in seconds
  tEnd: number;          // Shot end time in seconds (or video duration for last shot)
  hash: string;          // 16-char hex dHash for debugging
}

export interface SceneIndex {
  shots: SceneShot[];
  sceneCount: number;
  // For backwards compat with existing sceneBoundaries[] consumers.
  cuts: number[];
  // Set when cut detection handed us ZERO cuts on a long video. A single
  // uncut hour is almost never real footage — it's the upstream detector
  // timing out or failing open — so the resulting sceneCount=1 must not
  // drive frame budgeting. Callers should switch to uniform sampling
  // across the timeline instead of trusting one scene's worth of frames.
  degenerate?: boolean;
}

const DHASH_HAMMING_THRESHOLD = 12;

// Keyframes that couldn't be extracted or hashed get a 'fail'-prefixed
// sentinel instead of a real dHash (see processShot). Sentinels contain
// non-hex characters that hammingDistance coerces to 0 bits, so two
// DIFFERENT failed shots look nearly identical — without a guard they all
// chain into one bogus mega-scene.
function isFailedHash(hash: string): boolean {
  return hash.startsWith("fail");
}

// Cluster perceptual hashes by similarity using single-link clustering.
// Two hashes are in the same cluster if their hamming distance is below
// threshold OR they share at least one hash that's transitively close.
// Exported so the scanner can run the exact same clustering on dense-grid
// frame hashes when no shot-cut list exists (streamed path) — recurring
// scene classes come out of the same algorithm either way.
//
// Failed-hash sentinels each get their own singleton cluster: an
// unhashable frame tells us nothing about which scene it belongs to, and
// letting sentinels compare with anything collapses unrelated failures
// (or worse, real scenes) together.
export function clusterHashes(
  hashes: string[],
  threshold: number = DHASH_HAMMING_THRESHOLD,
): number[] {
  const n = hashes.length;
  const sceneId = new Array(n).fill(-1);
  let nextId = 0;

  for (let i = 0; i < n; i++) {
    if (sceneId[i] !== -1) continue;
    sceneId[i] = nextId;
    if (!isFailedHash(hashes[i])) {
      // Single-link: anything within threshold of any member of this cluster
      // joins it. Iterate until no new additions (BFS).
      let added = true;
      while (added) {
        added = false;
        for (let j = 0; j < n; j++) {
          if (sceneId[j] !== -1 || isFailedHash(hashes[j])) continue;
          for (let k = 0; k < n; k++) {
            if (sceneId[k] !== nextId) continue;
            if (hammingDistance(hashes[j], hashes[k]) < threshold) {
              sceneId[j] = nextId;
              added = true;
              break;
            }
          }
        }
      }
    }
    nextId++;
  }

  return sceneId;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x > 0) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

// Compute dHash for an image file. Returns 16-character hex string (64 bits).
export async function computeDHash(imagePath: string): Promise<string> {
  const buf = await sharp(imagePath)
    .resize(9, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();

  // 8 rows × 9 cols. For each row, compare adjacent pixels.
  let bits = "";
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = buf[row * 9 + col];
      const right = buf[row * 9 + col + 1];
      bits += left > right ? "1" : "0";
    }
  }
  // Convert 64-bit binary to 16-char hex.
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

// Extract one frame at the given timestamp to the temp dir. Uses ffmpeg's
// fast input seek to keep this cheap (no full decode).
async function extractKeyframe(
  videoPath: string,
  timestamp: number,
  outPath: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const ff = spawn("ffmpeg", [
      "-nostdin",
      "-y",
      "-loglevel", "error",
      "-ss", String(Math.max(0, timestamp)),
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", "scale=160:-1",
      "-q:v", "5",
      outPath,
    ]);
    let stderr = "";
    ff.stderr.on("data", (d) => { stderr += d.toString(); });
    ff.on("close", (code) => {
      if (code === 0 && fs.existsSync(outPath)) {
        resolve(true);
      } else {
        if (stderr) {
          console.warn(`[SceneIndex] keyframe ffmpeg failed at t=${timestamp}: ${stderr.slice(-150)}`);
        }
        resolve(false);
      }
    });
    ff.on("error", (err) => {
      console.warn(`[SceneIndex] keyframe spawn error at t=${timestamp}: ${err.message}`);
      resolve(false);
    });
  });
}

// Refine an ffmpeg-detected cut to the exact frame of visual discontinuity.
// ffmpeg's scene filter at threshold=0.3 triggers AFTER the histogram diff
// exceeds threshold, which means the reported timestamp is 1-2 frames late.
// The user's symptom: product visible briefly past the cut, then disappears.
//
// Algorithm: extract a dense burst of frames around the approximate cut
// (default ±400ms at 60fps = ~48 frames). Compute dHash for each, find the
// adjacent pair with maximum hamming distance — that's where the actual
// visual change happens. Return its timestamp.
//
// Cost: ~48 ffmpeg+dHash ops per cut. With CONCURRENCY=8 → ~6s wall time
// per cut. For a 60-cut podcast that's ~6 min wall total, but parallelized
// across cuts the total stays bounded. Run AFTER the initial cut detect
// and BEFORE sceneIndex clustering.
async function refineCutBoundary(
  videoPath: string,
  approxT: number,
  windowMs: number = 400,
): Promise<number> {
  const sampleHz = 60;
  const halfWindow = windowMs / 1000;
  const startT = Math.max(0, approxT - halfWindow);
  const endT = approxT + halfWindow;
  const frameCount = Math.round((endT - startT) * sampleHz);
  if (frameCount < 4) return approxT;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cut-refine-"));
  const burstPattern = path.join(tempDir, "f_%04d.jpg");

  // Extract a dense burst via fps filter. One ffmpeg call → many frames.
  // Much faster than calling extractKeyframe 48 times.
  const ok = await new Promise<boolean>((resolve) => {
    const ff = spawn("ffmpeg", [
      "-nostdin",
      "-y",
      "-loglevel", "error",
      "-ss", String(startT),
      "-to", String(endT),
      "-i", videoPath,
      "-vf", `fps=${sampleHz},scale=160:-1`,
      "-q:v", "5",
      burstPattern,
    ]);
    let stderr = "";
    ff.stderr.on("data", (d) => { stderr += d.toString(); });
    ff.on("close", (code) => {
      if (code === 0) resolve(true);
      else {
        console.warn(`[SceneIndex/refine] burst extract failed at t=${approxT}: ${stderr.slice(-150)}`);
        resolve(false);
      }
    });
    ff.on("error", () => resolve(false));
  });

  if (!ok) {
    try { fs.rmdirSync(tempDir, { recursive: true } as any); } catch {}
    return approxT;
  }

  // List frames, hash each, find adjacent pair with max hamming distance.
  try {
    const files = fs.readdirSync(tempDir)
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .map((f) => path.join(tempDir, f));

    if (files.length < 4) return approxT;

    const hashes: string[] = [];
    for (const f of files) {
      try {
        hashes.push(await computeDHash(f));
      } catch {
        hashes.push("");
      }
    }

    let maxDist = 0;
    let cutIdx = 0;
    for (let i = 1; i < hashes.length; i++) {
      if (!hashes[i] || !hashes[i - 1]) continue;
      const d = hammingDistance(hashes[i - 1], hashes[i]);
      if (d > maxDist) {
        maxDist = d;
        cutIdx = i;
      }
    }

    // Convert burst index back to absolute timestamp. ffmpeg's fps filter
    // outputs frame i at startT + i / fps (roughly — there's a half-frame
    // bias from the resampler that we ignore since we're going for ±1 frame).
    const refinedT = startT + cutIdx / sampleHz;

    console.log(
      `[SceneIndex/refine] cut ${approxT.toFixed(3)}s → ${refinedT.toFixed(3)}s ` +
      `(burst dist=${maxDist}, idx=${cutIdx}/${hashes.length})`,
    );
    return refinedT;
  } finally {
    try {
      for (const f of fs.readdirSync(tempDir)) {
        try { fs.unlinkSync(path.join(tempDir, f)); } catch {}
      }
      fs.rmdirSync(tempDir);
    } catch {}
  }
}

// Probe video duration via ffprobe — needed to compute the last shot's tEnd.
async function probeDuration(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    const ff = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    let out = "";
    ff.stdout.on("data", (d) => { out += d.toString(); });
    ff.on("close", () => {
      const v = parseFloat(out.trim());
      resolve(Number.isFinite(v) ? v : 0);
    });
    ff.on("error", () => resolve(0));
  });
}

// Build the scene index given a list of shot-cut timestamps from ffmpeg.
// `cuts` is the same array we already write to videoIndex.sceneBoundaries —
// each entry marks the START of a new shot. So shot 0 = [0, cuts[0]),
// shot 1 = [cuts[0], cuts[1]), etc.
//
// Returns null on any unrecoverable failure — caller should fall back to
// treating each shot as its own scene (current behavior).
export async function buildSceneIndex(
  videoPath: string,
  cuts: number[],
): Promise<SceneIndex | null> {
  if (!fs.existsSync(videoPath)) {
    console.warn(`[SceneIndex] video not found: ${videoPath}`);
    return null;
  }

  const duration = await probeDuration(videoPath);
  if (duration <= 0) {
    console.warn(`[SceneIndex] could not probe duration of ${videoPath}`);
    return null;
  }

  // Refine each ffmpeg-detected cut to the exact frame of visual change.
  // Run in waves of CONCURRENCY (same as the hashing pass below) to keep
  // wall time bounded. Skipped if cuts is empty / very short video.
  let refinedCuts = cuts.filter((t) => t > 0 && t < duration);
  if (refinedCuts.length > 0 && refinedCuts.length < 200) {
    console.log(`[SceneIndex] Refining ${refinedCuts.length} cut boundaries with frame-accurate sampling`);
    const REFINE_CONCURRENCY = 8;
    const refined: number[] = new Array(refinedCuts.length);
    for (let i = 0; i < refinedCuts.length; i += REFINE_CONCURRENCY) {
      const wave = refinedCuts.slice(i, i + REFINE_CONCURRENCY);
      const results = await Promise.all(
        wave.map((t) => refineCutBoundary(videoPath, t)),
      );
      for (let j = 0; j < results.length; j++) {
        refined[i + j] = results[j];
      }
    }
    refinedCuts = refined.sort((a, b) => a - b);
  }

  // Zero usable cuts on a >10-min video means the detector broke, not that
  // the creator shot an uncut hour. Flag rather than silently returning
  // sceneCount=1 — the scanner budgets frames PER SCENE, so a silent
  // single-scene result starves an hour of footage down to a handful of
  // samples.
  const degenerate = refinedCuts.length === 0 && duration > 600;
  if (degenerate) {
    console.warn(
      `[SceneIndex] Zero cuts on a ${(duration / 60).toFixed(1)}-min video — ` +
      `flagging index as degenerate (single-scene result is untrustworthy)`,
    );
  }

  // Build shot list: [0, cuts[0]), [cuts[0], cuts[1]), ..., [cuts[N-1], duration)
  const shotStarts = [0, ...refinedCuts];
  const shots: Array<{ shotIdx: number; tStart: number; tEnd: number }> = [];
  for (let i = 0; i < shotStarts.length; i++) {
    const tStart = shotStarts[i];
    const tEnd = i === shotStarts.length - 1 ? duration : shotStarts[i + 1];
    if (tEnd - tStart < 0.5) continue; // skip tiny shots (transitions)
    shots.push({ shotIdx: i, tStart, tEnd });
  }

  if (shots.length === 0) {
    return { shots: [], sceneCount: 0, cuts };
  }

  console.log(`[SceneIndex] Hashing ${shots.length} shots from ${cuts.length} cuts (duration ${duration.toFixed(1)}s)`);

  // Extract keyframe + hash per shot in PARALLEL with concurrency cap.
  // Sequential ffmpeg spawns were ~3-4 minutes on a 60-shot podcast (cold-
  // start dominates per call). Parallel-8 takes ~30s for the same video
  // since ffmpeg's input seek is I/O bound, not CPU. Sharp's dHash is
  // CPU-bound but cheap enough that 8 in flight doesn't peg the box.
  const CONCURRENCY = 8;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-idx-"));
  const hashes: string[] = new Array(shots.length).fill("");

  async function processShot(shot: { shotIdx: number; tStart: number; tEnd: number }, slot: number): Promise<void> {
    const midpoint = shot.tStart + (shot.tEnd - shot.tStart) / 2;
    const keyframePath = path.join(tempDir, `shot_${shot.shotIdx}.jpg`);
    const ok = await extractKeyframe(videoPath, midpoint, keyframePath);
    if (!ok) {
      hashes[slot] = `fail${shot.shotIdx.toString(16).padStart(12, "0")}`;
      return;
    }
    try {
      hashes[slot] = await computeDHash(keyframePath);
    } catch (err: any) {
      console.warn(`[SceneIndex] dHash failed for shot ${shot.shotIdx}: ${err.message}`);
      hashes[slot] = `fail${shot.shotIdx.toString(16).padStart(12, "0")}`;
    } finally {
      try { fs.unlinkSync(keyframePath); } catch {}
    }
  }

  try {
    // Process in CONCURRENCY-sized waves. Promise.all per wave so errors
    // in one shot don't stall the others, and the next wave starts as
    // soon as the previous finishes.
    for (let i = 0; i < shots.length; i += CONCURRENCY) {
      const wave = shots.slice(i, i + CONCURRENCY);
      await Promise.all(wave.map((shot, j) => processShot(shot, i + j)));
    }
  } finally {
    try { fs.rmdirSync(tempDir); } catch {}
  }

  // Cluster.
  const sceneIds = clusterHashes(hashes);
  const sceneCount = new Set(sceneIds).size;

  const indexedShots: SceneShot[] = shots.map((shot, i) => ({
    shotIdx: shot.shotIdx,
    sceneId: sceneIds[i],
    tStart: shot.tStart,
    tEnd: shot.tEnd,
    hash: hashes[i],
  }));

  console.log(`[SceneIndex] Clustered ${shots.length} shots into ${sceneCount} unique scene(s)`);
  // Log scene composition for debugging.
  const sceneToShots = new Map<number, number[]>();
  for (const s of indexedShots) {
    const list = sceneToShots.get(s.sceneId) ?? [];
    list.push(s.shotIdx);
    sceneToShots.set(s.sceneId, list);
  }
  for (const [sid, shotList] of Array.from(sceneToShots.entries())) {
    console.log(`[SceneIndex]   Scene ${sid}: ${shotList.length} shot(s) [${shotList.slice(0, 8).join(", ")}${shotList.length > 8 ? " ..." : ""}]`);
  }

  // Return REFINED cuts so downstream consumers (placement render filter,
  // surface clustering) use the frame-accurate boundaries instead of
  // ffmpeg's approximate ones. Was returning the input `cuts` previously —
  // that's why the user saw products bleed past cuts before disappearing.
  return {
    shots: indexedShots,
    sceneCount,
    cuts: refinedCuts,
    ...(degenerate ? { degenerate: true } : {}),
  };
}

// Look up the sceneId covering a given video timestamp. Returns 0 if no
// index is present (degenerate single-scene fallback).
export function sceneIdForTimestamp(
  index: SceneIndex | null | undefined,
  t: number,
): number {
  if (!index || index.shots.length === 0) return 0;
  for (const shot of index.shots) {
    if (t >= shot.tStart && t < shot.tEnd) return shot.sceneId;
  }
  // Past end of last shot — clamp to last scene.
  return index.shots[index.shots.length - 1].sceneId;
}

// Pick a representative timestamp for each unique scene — used by scanner to
// run surface detection ONCE per scene rather than per shot. Returns
// [{sceneId, tSample}] where tSample is the midpoint of the longest shot in
// that scene (most representative framing).
export function sampleTimestampsPerScene(index: SceneIndex): Array<{
  sceneId: number;
  tSample: number;
}> {
  const longestPerScene = new Map<number, SceneShot>();
  for (const shot of index.shots) {
    const cur = longestPerScene.get(shot.sceneId);
    const shotLen = shot.tEnd - shot.tStart;
    const curLen = cur ? cur.tEnd - cur.tStart : -1;
    if (shotLen > curLen) longestPerScene.set(shot.sceneId, shot);
  }
  return Array.from(longestPerScene.entries()).map(([sceneId, shot]) => ({
    sceneId,
    tSample: shot.tStart + (shot.tEnd - shot.tStart) / 2,
  }));
}

// Like sampleTimestampsPerScene but returns up to `perScene` timestamps per
// scene — picks the midpoints of the top-K longest shots in each scene.
// Catches drift within a scene that has many shots (e.g. host scene where
// the host moves through different parts of the couch over 30 shots — one
// keyframe might miss it).
export function sampleMultiTimestampsPerScene(
  index: SceneIndex,
  perScene: number = 2,
): Array<{ sceneId: number; t: number; shotIdx: number }> {
  const byScene = new Map<number, SceneShot[]>();
  for (const shot of index.shots) {
    const arr = byScene.get(shot.sceneId) ?? [];
    arr.push(shot);
    byScene.set(shot.sceneId, arr);
  }
  const samples: Array<{ sceneId: number; t: number; shotIdx: number }> = [];
  for (const [sceneId, shots] of Array.from(byScene.entries())) {
    const sorted = [...shots].sort(
      (a, b) => (b.tEnd - b.tStart) - (a.tEnd - a.tStart),
    );
    const want = Math.max(2, perScene); // consensus voting needs >=2 samples
    const top = sorted.slice(0, want);
    for (const shot of top) {
      samples.push({
        sceneId,
        shotIdx: shot.shotIdx,
        t: shot.tStart + (shot.tEnd - shot.tStart) / 2,
      });
    }
    // Scenes with fewer shots than `want` (e.g. a single long shot) get
    // extra points spread WITHIN the longest shot — a scene sampled once
    // can't be cross-frame verified.
    let deficit = want - top.length;
    if (deficit > 0) {
      const longest = sorted[0];
      const len = longest.tEnd - longest.tStart;
      // Midpoint is taken above; add 1/4 and 3/4 points (then 3/8, 5/8...)
      const fractions = [0.25, 0.75, 0.375, 0.625, 0.125, 0.875];
      for (const f of fractions) {
        if (deficit <= 0) break;
        if (len * Math.abs(f - 0.5) < 0.75) continue; // too close to midpoint on short shots
        samples.push({ sceneId, shotIdx: longest.shotIdx, t: longest.tStart + len * f });
        deficit--;
      }
    }
  }
  return samples.sort((a, b) => a.t - b.t);
}
