/**
 * Face Tracker — Smart reframing for portrait clips.
 *
 * Detects people in sampled frames using COCO-SSD (already loaded for surface detection),
 * computes a smooth crop trajectory, and generates an FFmpeg crop filter expression
 * that pans to follow the speaker instead of padding with black bars.
 */

import * as tf from "@tensorflow/tfjs-node";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import sharp from "sharp";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Types ──────────────────────────────────────────────────────

export interface FaceBox {
  /** Normalized 0-1 coordinates relative to frame dimensions */
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface FaceDetectionFrame {
  /** Time in seconds (clip-relative) */
  time: number;
  faces: FaceBox[];
}

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

// ── Model Singleton (shared with surfaceDetector) ──────────────

let model: cocoSsd.ObjectDetection | null = null;
let modelLoading: Promise<cocoSsd.ObjectDetection> | null = null;

async function loadModel(): Promise<cocoSsd.ObjectDetection> {
  if (model) return model;
  if (modelLoading) return modelLoading;

  console.log("[FaceTracker] Loading COCO-SSD model...");
  modelLoading = cocoSsd.load({ base: "mobilenet_v2" });
  model = await modelLoading;
  console.log("[FaceTracker] COCO-SSD model loaded");
  return model;
}

// ── Face Detection ─────────────────────────────────────────────

const MAX_SAMPLES = 60;
const DETECTION_WIDTH = 480; // Reduced from 640 — faster inference, still accurate for person bbox
const MIN_PERSON_CONFIDENCE = 0.35;
const FACE_REGION_RATIO = 0.35; // Upper 35% of person bbox is face
const DETECTION_BATCH_SIZE = 6; // Parallel frame processing (was 4)

/**
 * Detect faces/people in sampled frames from a video clip.
 * @param deadlineMs — Soft deadline in milliseconds. When exceeded, returns partial
 * results collected so far instead of throwing. Better than center-crop fallback on
 * long clips where some samples DID succeed.
 */
export async function detectFacesInClip(
  videoPath: string,
  startTime: number,
  duration: number,
  sampleIntervalSec: number = 0.5,
  deadlineMs?: number
): Promise<FaceDetectionFrame[]> {
  try {
    return await detectFacesInClipInner(videoPath, startTime, duration, sampleIntervalSec, deadlineMs);
  } catch (err: any) {
    // Never let face detection crash the remix pipeline
    console.warn(`[FaceTracker] Face detection failed (non-fatal): ${err.message}`);
    return [];
  }
}

async function detectFacesInClipInner(
  videoPath: string,
  startTime: number,
  duration: number,
  sampleIntervalSec: number,
  deadlineMs?: number
): Promise<FaceDetectionFrame[]> {
  const started = Date.now();
  // Auto-increase interval for long clips to cap at MAX_SAMPLES
  const numSamples = Math.ceil(duration / sampleIntervalSec);
  if (numSamples > MAX_SAMPLES) {
    sampleIntervalSec = duration / MAX_SAMPLES;
  }

  const sampleTimes: number[] = [];
  for (let t = 0; t < duration; t += sampleIntervalSec) {
    sampleTimes.push(t);
  }

  // Process samples coarse-to-fine (whole-clip passes at increasing density)
  // instead of sequentially from t=0. With a soft deadline, sequential order
  // meant a cutoff left the clip's TAIL completely untracked — observed in
  // prod as "42/60 samples" = the last ~30% of a 58s clip had no data, so the
  // crop froze wherever it was (wrong person on screen when the speaker
  // switched late in the clip). Coarse-to-fine makes any prefix of the work
  // span the full duration at reduced density. Results are time-sorted on
  // return, so downstream trajectory math is unaffected.
  const orderedTimes = coarseToFineOrder(sampleTimes);

  const tmpDir = path.join(os.tmpdir(), `facetrack-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const loadedModel = await loadModel();

  try {
    // Extract frames in parallel
    const results: FaceDetectionFrame[] = [];

    for (let i = 0; i < orderedTimes.length; i += DETECTION_BATCH_SIZE) {
      // Soft deadline check — return partial results rather than throwing
      if (deadlineMs && Date.now() - started > deadlineMs) {
        console.warn(
          `[FaceTracker] Soft deadline hit (${deadlineMs}ms) with ${results.length}/${orderedTimes.length} samples — using partial (full-duration coverage, reduced density)`
        );
        break;
      }

      const batch = orderedTimes.slice(i, i + DETECTION_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (clipTime) => {
          const absTime = startTime + clipTime;
          const framePath = path.join(tmpDir, `frame_${clipTime.toFixed(2)}.jpg`);

          // Extract single frame
          await extractFrame(videoPath, absTime, framePath);

          if (!fs.existsSync(framePath)) {
            return { time: clipTime, faces: [] };
          }

          // Run detection
          const faces = await detectFacesInFrame(loadedModel, framePath);
          return { time: clipTime, faces };
        })
      );
      results.push(...batchResults);
    }

    return results.sort((a, b) => a.time - b.time);
  } finally {
    // Clean up temp frames
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Reorder sample times so processing covers the whole clip first at coarse
 * granularity, then progressively fills in: endpoints, then midpoints, then
 * finer strides. Any prefix of the output spans the full input range.
 */
function coarseToFineOrder(times: number[]): number[] {
  const n = times.length;
  if (n <= 2) return times.slice();
  const picked = new Array<boolean>(n).fill(false);
  const out: number[] = [];
  let stride = n - 1;
  while (true) {
    for (let i = 0; i < n; i += stride) {
      if (!picked[i]) {
        picked[i] = true;
        out.push(times[i]);
      }
    }
    if (stride === 1) break;
    stride = Math.max(1, Math.floor(stride / 2));
  }
  return out;
}

/**
 * Extract a single JPEG frame from a video at a given timestamp.
 */
async function extractFrame(videoPath: string, time: number, outputPath: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", [
      "-nostdin", "-y",
      "-ss", String(time),
      "-i", videoPath,
      "-vframes", "1",
      "-vf", `scale=${DETECTION_WIDTH}:-2`,
      "-q:v", "4",
      outputPath,
    ]);

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 10000);

    proc.on("close", () => { clearTimeout(timeout); resolve(); });
    proc.on("error", () => { clearTimeout(timeout); resolve(); });
  });
}

/**
 * Detect people in a single frame and derive face regions.
 */
async function detectFacesInFrame(
  cocoModel: cocoSsd.ObjectDetection,
  framePath: string
): Promise<FaceBox[]> {
  try {
    const { data, info } = await sharp(framePath)
      .resize(DETECTION_WIDTH, undefined, { fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const tensor = tf.tensor3d(
      new Uint8Array(data),
      [info.height, info.width, info.channels]
    );

    const predictions = await cocoModel.detect(tensor);
    tensor.dispose();

    // Filter to "person" class with sufficient confidence
    const people = predictions.filter(
      (p) => p.class === "person" && p.score >= MIN_PERSON_CONFIDENCE
    );

    // Derive face region from upper portion of person bounding box
    return people.map((p) => {
      const [bx, by, bw, bh] = p.bbox; // pixels
      return {
        x: bx / info.width,
        y: by / info.height,
        width: bw / info.width,
        height: (bh * FACE_REGION_RATIO) / info.height,
        confidence: p.score,
      };
    });
  } catch {
    return [];
  }
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

  if (frames.length === 0) {
    return {
      frames: [{ time: 0, cropX: Math.round((srcW - effectiveCropW) / 2), cropY: 0 }],
      cropW: effectiveCropW,
      cropH,
    };
  }

  // ── Build speaker → face position map ──
  const speakerPositions = buildSpeakerPositionMap(frames, speakerSegments, clipStartTime, srcW);

  // Threshold: if a face/speaker jumps more than this fraction of the frame width,
  // treat it as a scene cut and snap (don't smooth through the cut).
  const SNAP_JUMP_FRACTION = 0.20;
  const snapThreshold = srcW * SNAP_JUMP_FRACTION;

  // Compute raw crop center for each frame
  const rawCenters: { time: number; cx: number; snap: boolean }[] = [];
  let lastKnownCx = srcW / 2;

  for (const frame of frames) {
    let cx: number;
    const absTime = clipStartTime + frame.time;
    const activeSpeaker = speakerSegments ? findActiveSpeaker(speakerSegments, absTime) : undefined;

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
      } else {
        // No speaker info — pick the face closest to where we last were
        // (maintains continuity; prevents jumping between hosts arbitrarily)
        const closestToLast = allFaces.reduce((a, b) =>
          Math.abs(a.cx - lastKnownCx) < Math.abs(b.cx - lastKnownCx) ? a : b
        );
        cx = closestToLast.cx;
      }
    }

    // Continuity reference for the multi-face "closest to last" tie-break only.
    // Snap/cut detection is deferred to a second pass that can see the future.
    lastKnownCx = cx;
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
    Math.max(0, Math.min(srcW - effectiveCropW, Math.round(cx - effectiveCropW / 2)));
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
