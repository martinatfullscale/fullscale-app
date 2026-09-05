/**
 * Face Tracker — Smart reframing for portrait clips.
 *
 * Detects people in sampled frames using COCO-SSD, computes a smooth crop
 * trajectory, and generates an FFmpeg crop filter expression that pans to
 * follow the speaker instead of padding with black bars.
 *
 * DETECTION RUNS IN A CHILD PROCESS. TensorFlow's native init and every CPU
 * inference are synchronous compute; run in the server process they held the
 * event loop — first bounded per-batch, then per-inference (the setImmediate
 * yield below in history), and still measured in production as
 *   [Stall] EVENT LOOP BLOCKED 12820ms — nothing else ran.
 * the moment a render lazily imported tfjs-node. The comment that added the
 * yield named this exact move as "the real fix"; this is that fix. The child
 * also isolates OOM: TF allocating past this instance's free memory now
 * kills a disposable pid instead of the server holding every connection —
 * which is what mid-render "Load failed" on unrelated requests was.
 *
 * This module keeps the public API and all the pure trajectory math. The TF
 * side lives in faceDetectCore.ts, reached via faceDetectChild.ts.
 */
import { spawn, fork, type ChildProcess } from "child_process";
import * as path from "path";

// Types live with the detection core; re-exported so callers keep importing
// them from here.
export type { FaceBox, FaceDetectionFrame } from "./faceDetectCore";
import type { FaceDetectionFrame } from "./faceDetectCore";

export interface CropKeyframe {
  time: number;
  /** Pixel coordinates in source frame */
  cropX: number;
  cropY: number;
}

export interface CropTrajectory {
  frames: CropKeyframe[];
  /** Constant crop dimensions in source pixels */
  cropW: number;
  cropH: number;
}

// ── Detection child manager ────────────────────────────────────
//
// One long-lived child per server process, forked on first use, retired
// after an idle period so ~300MB of TF memory is not held between renders
// (in-process it was held forever — the model singleton had no release
// path). Requests are matched to responses by id; a dead or wedged child
// resolves every pending request to undefined and the wrapper returns the
// caller's degraded value ([] / null), which the pipeline already treats
// as "no tracking, center-crop" — the same contract as before.

const CHILD_IDLE_MS = 120_000;

type Pending = { resolve: (v: unknown) => void; timer: NodeJS.Timeout };

let child: ChildProcess | null = null;
let childBroken = false;      // could never start — environment can't fork this
let childEverReady = false;   // saw {ready} at least once this process
let reqSeq = 0;
const pending = new Map<number, Pending>();
let idleTimer: NodeJS.Timeout | null = null;

function childEntryPath(): string {
  // Production runs the esbuild bundle; the child is its sibling bundle
  // (script/build.ts builds both). Dev forks the TS file directly — fork
  // inherits execArgv, which under `tsx server/index.ts` carries the tsx
  // loader, so a .ts entry resolves.
  if (process.env.NODE_ENV === "production") {
    return path.resolve(path.dirname(process.argv[1] ?? "dist/index.cjs"), "facetrack-child.cjs");
  }
  return path.resolve(process.cwd(), "server/lib/remix/faceDetectChild.ts");
}

function settleAll(reason: string) {
  if (pending.size > 0) {
    console.warn(`[FaceTracker] child ${reason} with ${pending.size} request(s) in flight — degrading those to no-tracking`);
  }
  for (const p of Array.from(pending.values())) {
    clearTimeout(p.timer);
    p.resolve(undefined);
  }
  pending.clear();
}

function stopChild(reason: string) {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!child) return;
  console.log(`[FaceTracker] stopping detection child (${reason})`);
  try { child.kill("SIGKILL"); } catch {}
  child = null;
  settleAll(reason);
}

function ensureChild(): ChildProcess | null {
  if (childBroken) return null;
  if (child) return child;
  const entry = childEntryPath();
  try {
    const c = fork(entry, [], {
      env: { ...process.env, FACETRACK_CHILD: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    // Keep TF's init chatter visible, but attributed — those oneDNN lines in
    // the server log used to read as the server itself grinding.
    c.stdout?.on("data", (d) => process.stdout.write(`[FaceTrack:child] ${d}`));
    c.stderr?.on("data", (d) => process.stderr.write(`[FaceTrack:child] ${d}`));
    c.on("message", (msg: any) => {
      if (msg?.ready) { childEverReady = true; return; }
      const p = typeof msg?.id === "number" ? pending.get(msg.id) : undefined;
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else {
        console.warn(`[FaceTracker] child request failed: ${msg.error}`);
        p.resolve(undefined);
      }
      armIdleTimer();
    });
    c.on("error", (err) => {
      console.error(`[FaceTracker] detection child error: ${err?.message}`);
    });
    c.on("exit", (code, signal) => {
      const clean = code === 0 && !signal;
      if (!clean) console.warn(`[FaceTracker] detection child exited (code ${code}, signal ${signal})`);
      if (child === c) child = null;
      // Died before ever reaching ready and never served a request: the
      // environment can't run the child (bad entry path, missing loader).
      // Mark broken so callers use the in-process fallback for this server's
      // lifetime instead of paying a doomed fork per render.
      if (!childEverReady) {
        childBroken = true;
        console.error(
          `[FaceTracker] detection child could not start (entry ${entry}) — falling back to IN-PROCESS detection. ` +
          `Renders will work but may briefly stall other requests.`,
        );
      }
      settleAll("exited");
    });
    child = c;
    return c;
  } catch (err: any) {
    childBroken = true;
    console.error(`[FaceTracker] fork failed (${err?.message}) — falling back to IN-PROCESS detection`);
    return null;
  }
}

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (pending.size > 0) return;
  idleTimer = setTimeout(() => {
    if (pending.size === 0 && child) stopChild("idle — releasing TensorFlow memory");
  }, CHILD_IDLE_MS);
  // Never hold the process open just to time out an idle child.
  idleTimer.unref?.();
}

function childRequest(payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const c = ensureChild();
  if (!c) return Promise.resolve(undefined);
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const id = ++reqSeq;
  return new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(undefined);
      // A child past its hard timeout is wedged or grinding a hopeless input;
      // killing it frees the memory and the next request re-forks cleanly.
      stopChild(`request ${id} exceeded ${timeoutMs}ms`);
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    c.send({ id, ...payload }, (err) => {
      if (err) {
        const p = pending.get(id);
        if (p) { pending.delete(id); clearTimeout(p.timer); p.resolve(undefined); }
      }
    });
  });
}

/** Escape hatch, and the dev fallback when the child can't start. */
function forceInProcess(): boolean {
  return process.env.FACETRACK_IN_PROCESS === "1" || childBroken;
}

/**
 * Detect faces/people in sampled frames from a video clip.
 *
 * Runs in the detection child process; this wrapper only forwards and
 * degrades. Any failure — child died (OOM), hard timeout, couldn't fork —
 * returns [] and the render falls back to a center crop, exactly the
 * degraded path it always had. It never crashes the remix pipeline and it
 * never blocks the server's event loop.
 *
 * @param deadlineMs — Soft deadline, enforced INSIDE the child (partial
 * results come back, coarse-to-fine order makes any prefix span the whole
 * clip). The parent holds a harder timeout above it for a wedged child.
 */
export async function detectFacesInClip(
  videoPath: string,
  startTime: number,
  duration: number,
  sampleIntervalSec: number = 0.5,
  deadlineMs?: number
): Promise<FaceDetectionFrame[]> {
  if (forceInProcess()) {
    try {
      const core = await import("./faceDetectCore");
      return await core.detectFacesInClipCore(videoPath, startTime, duration, sampleIntervalSec, deadlineMs);
    } catch (err: any) {
      console.warn(`[FaceTracker] in-process face detection failed (non-fatal): ${err?.message}`);
      return [];
    }
  }
  // Hard timeout: the soft deadline plus headroom for first-use model load
  // (30-60s of tfjs-node init on a starved instance) and IPC.
  const hardTimeout = (deadlineMs ?? 180_000) + 90_000;
  const result = await childRequest(
    { type: "clip", videoPath, startTime, duration, sampleIntervalSec, deadlineMs },
    hardTimeout,
  );
  if (!Array.isArray(result)) {
    if (result !== undefined) console.warn(`[FaceTracker] unexpected child result shape — degrading to no-tracking`);
    return [];
  }
  return result as FaceDetectionFrame[];
}

/**
 * Tier 2 (scanner): tight FULL-BODY person boxes for a single frame image.
 * Unlike the clip path this returns the whole person bbox (no face-region
 * truncation) — the scanner's occlusion-remainder ghost filter needs the
 * true person envelope, and COCO-SSD's boxes are deterministic
 * frame-to-frame where Gemini's "generous" envelopes vary. Normalized 0-1
 * coordinates. Fail-open: any error (child OOM, decode failure) returns
 * null so the caller falls back to Gemini's people boxes.
 */
export async function detectPeopleInFrame(
  framePath: string
): Promise<Array<{ x: number; y: number; width: number; height: number; confidence: number }> | null> {
  if (forceInProcess()) {
    try {
      const core = await import("./faceDetectCore");
      return await core.detectPeopleInFrameCore(framePath);
    } catch (err: any) {
      console.warn(`[FaceTracker] detectPeopleInFrame failed (non-fatal): ${err?.message || err}`);
      return null;
    }
  }
  // Generous first-call budget: model load happens on whichever request
  // arrives first, and the scanner calls this with .catch(() => null) anyway.
  const result = await childRequest({ type: "frame", framePath }, 90_000);
  return Array.isArray(result) ? (result as Array<{ x: number; y: number; width: number; height: number; confidence: number }>) : null;
}

// ── Crop Trajectory Computation ────────────────────────────────

const EMA_ALPHA = 0.35; // Moderate smoothing — responsive to speaker changes without jitter
const SPEAKER_HOLD_SEC = 0.15; // Shorter hold before panning to new speaker
const SPEAKER_PAN_SEC = 0.3; // Faster pan to new speaker

// Transcript segment type (matches speechToText output)
export interface SpeakerSegment {
  start: number;   // absolute time in source video (seconds)
  end: number;
  speaker?: string;
}

export interface CropTrajectoryOptions {
  /** Transcript segments (absolute timestamps in source video) for speaker-aware tracking */
  speakerSegments?: SpeakerSegment[];
  /** Absolute time of clip start in source video (for mapping frame times to speaker times) */
  clipStartTime?: number;
  /**
   * Boxes that MUST stay inside the 9:16 window — the fixtures carrying a
   * brand placement.
   *
   * The trajectory is otherwise driven purely by face detections, and the
   * crop is applied AFTER the product is composited onto the source frame.
   * A creator can therefore position a product perfectly, and a vertical
   * reframe that follows a speaker to the opposite side of the frame will
   * crop it out of the delivered clip entirely — silently, because the
   * render still succeeds. Coordinates are 0-1 normalized to the source frame.
   */
  anchorBoxes?: Array<{ x: number; width: number }>;
}

/**
 * Compute a smooth crop trajectory from face detection results.
 * When speakerSegments are provided, uses transcript diarization to track
 * the ACTIVE SPEAKER (not just the largest face).
 *
 * Returns pixel-space crop keyframes for the source video.
 */
export function computeCropTrajectory(
  frames: FaceDetectionFrame[],
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
  options: CropTrajectoryOptions = {}
): CropTrajectory {
  const { speakerSegments, clipStartTime = 0 } = options;

  // Compute crop dimensions in source pixels
  const targetAR = targetW / targetH;
  const cropW = Math.round(srcH * targetAR);
  const cropH = srcH;
  const effectiveCropW = Math.min(cropW, srcW);

  // Keep any placement anchor inside the window. The union of the anchor
  // boxes gives the span that must remain visible; when it fits, the crop is
  // clamped so it can't slide past either edge, and when it doesn't fit (a
  // box wider than a 9:16 window) the crop centers on it instead — losing
  // some of the product is recoverable, losing all of it is not.
  const anchors = (options.anchorBoxes ?? []).filter(
    (b) => Number.isFinite(b.x) && Number.isFinite(b.width) && b.width > 0,
  );
  const anchorLeftPx = anchors.length > 0
    ? Math.max(0, Math.min(...anchors.map((b) => b.x)) * srcW) : 0;
  const anchorRightPx = anchors.length > 0
    ? Math.min(srcW, Math.max(...anchors.map((b) => b.x + b.width)) * srcW) : 0;

  const constrainToAnchor = (cropX: number): number => {
    if (anchors.length === 0 || anchorRightPx <= anchorLeftPx) return cropX;
    const span = anchorRightPx - anchorLeftPx;
    if (span > effectiveCropW) {
      const centered = Math.round((anchorLeftPx + anchorRightPx) / 2 - effectiveCropW / 2);
      return Math.max(0, Math.min(srcW - effectiveCropW, centered));
    }
    const minX = Math.max(0, anchorRightPx - effectiveCropW);
    const maxX = Math.min(srcW - effectiveCropW, anchorLeftPx);
    if (minX > maxX) return cropX; // degenerate — leave the face-driven value
    return Math.max(minX, Math.min(maxX, cropX));
  };

  if (frames.length === 0) {
    // No faces: center crop, but still held over the placement if there is one.
    return {
      frames: [{
        time: 0,
        cropX: constrainToAnchor(Math.round((srcW - effectiveCropW) / 2)),
        cropY: 0,
      }],
      cropW: effectiveCropW,
      cropH,
    };
  }

  // ── Build speaker → face position map ──
  const speakerPositions = buildSpeakerPositionMap(frames, speakerSegments, clipStartTime, srcW);

  // Diagnostic: make the tracking regime visible in render logs. Three cases:
  //   no segments        → no transcript passed (wiring problem)
  //   no speaker labels  → transcript wasn't diarized (Whisper, or pre-Deepgram
  //                        transcript) — voice-following CANNOT work
  //   labels, 0 learned  → diarized but no solo shots to anchor who sits where
  //                        (known limitation on static two-shots)
  if (!speakerSegments || speakerSegments.length === 0) {
    console.log(`[FaceTracker] No transcript segments — voice-following disabled (nearest-face tracking only)`);
  } else {
    const labels = new Set(
      speakerSegments.map((s) => s.speaker).filter((sp): sp is string => !!sp),
    );
    if (labels.size === 0) {
      console.log(`[FaceTracker] Transcript has NO speaker labels (non-diarized STT) — voice-following disabled`);
    } else {
      console.log(
        `[FaceTracker] Speaker tracking: ${labels.size} speaker(s) in transcript, anchor positions learned for ${speakerPositions.size}`,
      );
    }
  }

  // Threshold: if a face/speaker jumps more than this fraction of the frame width,
  // treat it as a scene cut and snap (don't smooth through the cut).
  const SNAP_JUMP_FRACTION = 0.20;
  const snapThreshold = srcW * SNAP_JUMP_FRACTION;

  // Ignore speaker turns shorter than this when deciding camera moves — a
  // brief "mm-hm" interjection must not whip the crop across a two-shot and
  // back. Dropped turns leave findActiveSpeaker undefined for that span, so
  // the camera simply holds.
  const MIN_SPEAKER_TURN_SEC = 1.5;
  const stableSpeakerSegments = speakerSegments?.filter(
    (s) => !s.speaker || s.end - s.start >= MIN_SPEAKER_TURN_SEC,
  );

  // Compute raw crop center for each frame
  const rawCenters: { time: number; cx: number; snap: boolean }[] = [];
  let lastKnownCx = srcW / 2;
  let lastActiveSpeaker: string | undefined;

  for (const frame of frames) {
    let cx: number;
    const absTime = clipStartTime + frame.time;
    const activeSpeaker = stableSpeakerSegments
      ? findActiveSpeaker(stableSpeakerSegments, absTime)
      : undefined;

    if (frame.faces.length === 0) {
      // No faces detected in this frame — prefer speaker's known position if available
      const speakerPos = activeSpeaker ? speakerPositions.get(activeSpeaker) : undefined;
      cx = speakerPos ?? lastKnownCx;
    } else if (frame.faces.length === 1) {
      // Single face — always center on it (even if it's not the "speaker" — it's all we've got)
      const face = frame.faces[0];
      cx = (face.x + face.width / 2) * srcW;
    } else {
      // Multiple faces — ALWAYS pick one decisively. Never center between them
      // (that produces the "cut both people in half" artifact).
      const allFaces = frame.faces.map((f) => ({
        cx: (f.x + f.width / 2) * srcW,
        area: f.width * f.height,
        confidence: f.confidence,
      }));

      if (activeSpeaker && speakerPositions.has(activeSpeaker)) {
        // We know this speaker's usual position — pick the face closest to it
        const speakerCx = speakerPositions.get(activeSpeaker)!;
        const closest = allFaces.reduce((a, b) =>
          Math.abs(a.cx - speakerCx) < Math.abs(b.cx - speakerCx) ? a : b
        );
        cx = closest.cx;
      } else if (
        activeSpeaker &&
        lastActiveSpeaker &&
        activeSpeaker !== lastActiveSpeaker
      ) {
        // Speaker CHANGED but we have no anchor for the new speaker (anchors
        // only get learned from solo shots, and centered solo shots often
        // teach nothing about who sits where in the wide shot). In a
        // conversation, the new speaker is almost never the face we're
        // already holding — cut to the face farthest from the current
        // position. Even from a wrong start, this locks into correct
        // alternation after one turn; the previous behavior (closest-to-last)
        // NEVER switched during a wide shot, which parked the camera on a
        // silent listener for entire segments.
        const farthest = allFaces.reduce((a, b) =>
          Math.abs(a.cx - lastKnownCx) > Math.abs(b.cx - lastKnownCx) ? a : b
        );
        cx = farthest.cx;
      } else {
        // Same speaker (or no speaker info) — stay with the face closest to
        // where we last were (continuity; prevents arbitrary host-hopping)
        const closestToLast = allFaces.reduce((a, b) =>
          Math.abs(a.cx - lastKnownCx) < Math.abs(b.cx - lastKnownCx) ? a : b
        );
        cx = closestToLast.cx;
      }
    }

    // Continuity reference for the multi-face "closest to last" tie-break only.
    // Snap/cut detection is deferred to a second pass that can see the future.
    lastKnownCx = cx;
    if (activeSpeaker) lastActiveSpeaker = activeSpeaker;
    rawCenters.push({ time: frame.time, cx, snap: false });
  }

  // ── Reject single-frame detection spikes ──
  // A false detection (or a person briefly leaving frame) can throw cx far off
  // for one sample and back. Replacing isolated spikes with their neighbours'
  // midpoint stops the crop lurching to a non-focus point and snapping back —
  // the root cause of the "camera wildly moving to things that aren't the focus"
  // artifact. Genuine cuts survive: at a real cut the sample AGREES with the next
  // one (new position), so the neighbours disagree and it is not treated as a spike.
  const cleaned = rejectCenterSpikes(rawCenters.map((r) => r.cx), snapThreshold);

  // ── Flag genuine (sustained) scene cuts ──
  // A large jump is a real cut only if the NEW position holds on the next sample.
  // If it reverts, it was an outlier (already smoothed above), not a cut — so we
  // no longer exempt one-off jumps from smoothing.
  const points = rawCenters.map((r, i) => {
    const prev = i > 0 ? cleaned[i - 1] : cleaned[i];
    const jumped = i > 0 && Math.abs(cleaned[i] - prev) > snapThreshold;
    // A jump is a real cut only if the new position HOLDS on the next sample.
    // The final sample has no next sample to confirm with, so it can never be a
    // snap — an unconfirmable jump there is far more likely a stray detection
    // (which endpoint spike-rejection also guards) than a sub-0.5s final shot.
    const sustained =
      i < cleaned.length - 1 && Math.abs(cleaned[i] - cleaned[i + 1]) <= snapThreshold;
    const snap = jumped && sustained;
    if (snap) {
      console.log(`[FaceTracker] Scene cut at t=${r.time.toFixed(1)}s (jump ${Math.abs(cleaned[i] - prev).toFixed(0)}px)`);
    }
    return { time: r.time, cx: cleaned[i], snap };
  });

  // Apply snap-aware smoothing: smooth within segments, but hard-cut at scene boundaries
  const smoothed = smoothWithSnaps(points);

  // ── Deadband: hold the camera still until it drifts past a small threshold ──
  // Without this the crop re-targets on every 0.5s sample and never settles,
  // reading as a perpetually floating camera. Snap points force an immediate move.
  const stabilized = applyDeadband(smoothed, points.map((p) => p.snap), srcW);

  // Convert centers to crop X coordinates, clamped to source bounds.
  // At each snap, first emit a HOLD keyframe (previous position, 1ms before the
  // cut): the render-side lerp interpolates between every adjacent keyframe
  // pair, so without the hold a "snap" still rendered as a 0.5s whip-pan across
  // the cut. Hold-then-jump makes the crop change hands frame-accurately.
  const SNAP_HOLD_EPS = 0.001;
  const toCropX = (cx: number) =>
    constrainToAnchor(
      Math.max(0, Math.min(srcW - effectiveCropW, Math.round(cx - effectiveCropW / 2))),
    );
  const keyframes: CropKeyframe[] = [];
  for (let i = 0; i < points.length; i++) {
    const cropX = toCropX(stabilized[i]);
    if (points[i].snap && keyframes.length > 0) {
      const prevKf = keyframes[keyframes.length - 1];
      const holdTime = points[i].time - SNAP_HOLD_EPS;
      if (holdTime > prevKf.time) {
        keyframes.push({ time: holdTime, cropX: prevKf.cropX, cropY: 0 });
      }
    }
    keyframes.push({ time: points[i].time, cropX, cropY: 0 });
  }

  return { frames: keyframes, cropW: effectiveCropW, cropH };
}

/**
 * Replace isolated single-frame spikes in a center series with the midpoint of
 * their neighbours. A point is a spike when it deviates from BOTH neighbours by
 * more than `threshold` while those neighbours agree with each other (i.e. the
 * excursion is one sample wide and reverts). Genuine scene cuts are preserved
 * because at a cut the point agrees with the following sample, so the neighbours
 * straddle the cut and do not agree.
 */
function rejectCenterSpikes(centers: number[], threshold: number): number[] {
  const n = centers.length;
  if (n < 3) return centers.slice();
  const out = centers.slice();
  for (let i = 1; i < n - 1; i++) {
    const prev = centers[i - 1];
    const cur = centers[i];
    const next = centers[i + 1];
    const deviatesFromPrev = Math.abs(cur - prev) > threshold;
    const deviatesFromNext = Math.abs(cur - next) > threshold;
    const neighboursAgree = Math.abs(prev - next) <= threshold;
    if (deviatesFromPrev && deviatesFromNext && neighboursAgree) {
      out[i] = (prev + next) / 2;
    }
  }
  // Endpoints have only one neighbour, so the window test above can't protect
  // them — yet a stray detection on the first/last sample would otherwise hold
  // a wrong framing for the clip's opening/closing 0.5s (and the last sample
  // can't be confirmed as a cut at all). Reject an endpoint that deviates from
  // its neighbour while the two samples beyond it agree with each other.
  if (Math.abs(centers[0] - centers[1]) > threshold && Math.abs(centers[1] - centers[2]) <= threshold) {
    out[0] = centers[1];
  }
  if (
    Math.abs(centers[n - 1] - centers[n - 2]) > threshold &&
    Math.abs(centers[n - 2] - centers[n - 3]) <= threshold
  ) {
    out[n - 1] = centers[n - 2];
  }
  return out;
}

/**
 * Deadband follower: hold the crop center fixed while the target stays within a
 * small band (kills the constant sub-threshold float / jitter), but once the
 * target moves beyond the band, track it CONTINUOUSLY — lagging by exactly the
 * deadband — so a genuine slow pan stays smooth instead of stair-stepping.
 * (Latching `held` straight to the target only when it crosses the band would
 * quantize a real pan into visible ~deadband-sized steps.) A snap (true scene
 * cut) releases the hold so the crop jumps to the new shot immediately.
 */
function applyDeadband(values: number[], snaps: boolean[], srcW: number): number[] {
  const DEADBAND = srcW * 0.03; // ~3% of frame width
  // Slow re-centering inside the band: without it, the follower settles a full
  // DEADBAND (~9% of a 9:16 crop) off-center after every pan. 0.08/sample moves
  // <5px per 0.5s on a 1080p source — imperceptible, converges in a few seconds.
  const RECENTER_ALPHA = 0.08;
  const out = new Array<number>(values.length);
  let held = values.length > 0 ? values[0] : 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - held;
    if (snaps[i]) {
      held = values[i];
    } else if (d > DEADBAND) {
      held = values[i] - DEADBAND;
    } else if (d < -DEADBAND) {
      held = values[i] + DEADBAND;
    } else {
      held += d * RECENTER_ALPHA;
    }
    out[i] = held;
  }
  return out;
}

/**
 * Smooth crop centers while respecting scene cut boundaries.
 * Values marked with snap=true start a new smoothing segment (hard cut — no blending).
 */
function smoothWithSnaps(points: { time: number; cx: number; snap: boolean }[]): number[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [points[0].cx];

  // Split into segments at snap points
  const segments: { start: number; end: number }[] = [];
  let segStart = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].snap) {
      segments.push({ start: segStart, end: i - 1 });
      segStart = i;
    }
  }
  segments.push({ start: segStart, end: points.length - 1 });

  // Smooth each segment independently
  const result = new Array(points.length);
  for (const seg of segments) {
    const segValues = points.slice(seg.start, seg.end + 1).map((p) => p.cx);
    const smoothed = smoothBidirectional(segValues);
    for (let i = 0; i < smoothed.length; i++) {
      result[seg.start + i] = smoothed[i];
    }
  }
  return result;
}

/**
 * Find the speaker active at a given absolute timestamp.
 */
function findActiveSpeaker(segments: SpeakerSegment[], absTime: number): string | undefined {
  for (const seg of segments) {
    if (absTime >= seg.start && absTime <= seg.end && seg.speaker) {
      return seg.speaker;
    }
  }
  return undefined;
}

/**
 * Build a speaker → spatial position map by correlating detected faces with active speaker.
 *
 * Strategy: For each frame where we know who's speaking, look at where the faces are.
 * If multiple faces, we can't assign this frame. If single face, assign to current speaker.
 * After processing, each speaker has a median x-position (in source pixels).
 */
function buildSpeakerPositionMap(
  frames: FaceDetectionFrame[],
  speakerSegments: SpeakerSegment[] | undefined,
  clipStartTime: number,
  srcW: number
): Map<string, number> {
  const positionsBySpeaker = new Map<string, number[]>();

  if (!speakerSegments) return new Map();

  for (const frame of frames) {
    if (frame.faces.length === 0) continue;
    const absTime = clipStartTime + frame.time;
    const speaker = findActiveSpeaker(speakerSegments, absTime);
    if (!speaker) continue;

    // Only assign from frames with a SINGLE face — unambiguous
    if (frame.faces.length === 1) {
      const face = frame.faces[0];
      const cx = (face.x + face.width / 2) * srcW;
      const arr = positionsBySpeaker.get(speaker) ?? [];
      arr.push(cx);
      positionsBySpeaker.set(speaker, arr);
    }
  }

  // Compute median per speaker
  const result = new Map<string, number>();
  for (const [speaker, positions] of Array.from(positionsBySpeaker.entries())) {
    if (positions.length === 0) continue;
    const sorted = positions.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    result.set(speaker, median);
    console.log(`[FaceTracker] Speaker ${speaker} → x=${median.toFixed(0)}px (from ${positions.length} samples)`);
  }

  return result;
}

/**
 * Bidirectional EMA smoothing — forward pass, reverse pass, average.
 * Produces camera-operator-like smooth panning.
 */
function smoothBidirectional(values: number[]): number[] {
  if (values.length <= 1) return [...values];

  // Forward pass
  const forward: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    forward.push(EMA_ALPHA * values[i] + (1 - EMA_ALPHA) * forward[i - 1]);
  }

  // Reverse pass
  const reverse: number[] = new Array(values.length);
  reverse[values.length - 1] = values[values.length - 1];
  for (let i = values.length - 2; i >= 0; i--) {
    reverse[i] = EMA_ALPHA * values[i] + (1 - EMA_ALPHA) * reverse[i + 1];
  }

  // Average
  return forward.map((f, i) => (f + reverse[i]) / 2);
}

// ── FFmpeg Filter Builder ──────────────────────────────────────

/**
 * Build an FFmpeg crop filter expression with time-varying X position.
 * Returns a string like: crop=607:1080:if(lt(t\,0.5)\,lerp(...)...):0
 *
 * Note: commas in FFmpeg filter expressions inside -vf must be escaped
 * when part of a filter chain. The caller handles this.
 */
export function buildCropFilterExpr(
  trajectory: CropTrajectory
): string {
  const { frames, cropW, cropH } = trajectory;

  if (frames.length === 0) {
    return `crop=${cropW}:${cropH}:0:0`;
  }

  if (frames.length === 1) {
    return `crop=${cropW}:${cropH}:${frames[0].cropX}:${frames[0].cropY}`;
  }

  // Build time-varying X expression using nested if/lerp
  const xExpr = buildLerpExpr(frames.map((f) => ({ time: f.time, value: f.cropX })));
  const yExpr = String(frames[0].cropY); // Usually 0 for landscape→portrait

  return `crop=${cropW}:${cropH}:${xExpr}:${yExpr}`;
}

/**
 * Build a nested if(lt(t,...), lerp, ...) expression for FFmpeg.
 * FFmpeg uses: val1 + (val2 - val1) * ((t - t1) / (t2 - t1))
 */
function buildLerpExpr(keyframes: { time: number; value: number }[]): string {
  if (keyframes.length === 1) return String(Math.round(keyframes[0].value));

  // Build from the last keyframe backward
  let expr = String(Math.round(keyframes[keyframes.length - 1].value));

  for (let i = keyframes.length - 2; i >= 0; i--) {
    const t0 = keyframes[i].time;
    const t1 = keyframes[i + 1].time;
    const v0 = Math.round(keyframes[i].value);
    const v1 = Math.round(keyframes[i + 1].value);
    const dt = t1 - t0;

    if (dt <= 0) continue;

    // Linear interpolation: v0 + (v1 - v0) * ((t - t0) / dt)
    const lerp = `${v0}+(${v1 - v0})*((t-${t0.toFixed(3)})/${dt.toFixed(3)})`;
    expr = `if(lt(t\\,${t1.toFixed(3)})\\,${lerp}\\,${expr})`;
  }

  return expr;
}

// ── Video Info Helper ──────────────────────────────────────────

export interface VideoSize {
  width: number;
  height: number;
}

/**
 * Get video dimensions using ffprobe.
 */
export async function getVideoSize(videoPath: string): Promise<VideoSize> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-select_streams", "v:0",
      videoPath,
    ]);
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", () => {
      try {
        const info = JSON.parse(stdout);
        const stream = info.streams?.[0];
        if (stream?.width && stream?.height) {
          resolve({ width: stream.width, height: stream.height });
        } else {
          reject(new Error("Could not determine video dimensions"));
        }
      } catch {
        reject(new Error("Failed to parse ffprobe output"));
      }
    });
    proc.on("error", (err) => reject(err));
  });
}
