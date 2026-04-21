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
const DETECTION_WIDTH = 640;
const MIN_PERSON_CONFIDENCE = 0.35;
const FACE_REGION_RATIO = 0.35; // Upper 35% of person bbox is face

/**
 * Detect faces/people in sampled frames from a video clip.
 */
export async function detectFacesInClip(
  videoPath: string,
  startTime: number,
  duration: number,
  sampleIntervalSec: number = 0.5
): Promise<FaceDetectionFrame[]> {
  try {
    return await detectFacesInClipInner(videoPath, startTime, duration, sampleIntervalSec);
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
  sampleIntervalSec: number
): Promise<FaceDetectionFrame[]> {
  // Auto-increase interval for long clips to cap at MAX_SAMPLES
  const numSamples = Math.ceil(duration / sampleIntervalSec);
  if (numSamples > MAX_SAMPLES) {
    sampleIntervalSec = duration / MAX_SAMPLES;
  }

  const sampleTimes: number[] = [];
  for (let t = 0; t < duration; t += sampleIntervalSec) {
    sampleTimes.push(t);
  }

  const tmpDir = path.join(os.tmpdir(), `facetrack-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const loadedModel = await loadModel();

  try {
    // Extract frames in parallel (concurrency cap of 4)
    const results: FaceDetectionFrame[] = [];
    const batchSize = 4;

    for (let i = 0; i < sampleTimes.length; i += batchSize) {
      const batch = sampleTimes.slice(i, i + batchSize);
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
  let firstAssignment = true;

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

    // Detect scene cut: if cx jumps more than threshold, flag as snap point
    const snap = !firstAssignment && Math.abs(cx - lastKnownCx) > snapThreshold;
    if (snap) {
      console.log(`[FaceTracker] Scene cut detected at t=${frame.time.toFixed(1)}s (jump ${Math.abs(cx - lastKnownCx).toFixed(0)}px)`);
    }

    lastKnownCx = cx;
    firstAssignment = false;
    rawCenters.push({ time: frame.time, cx, snap });
  }

  // Apply snap-aware smoothing: smooth within segments, but hard-cut at scene boundaries
  const smoothed = smoothWithSnaps(rawCenters);

  // Convert centers to crop X coordinates, clamped to source bounds
  const keyframes: CropKeyframe[] = rawCenters.map((r, i) => {
    const cx = smoothed[i];
    let cropX = Math.round(cx - effectiveCropW / 2);
    cropX = Math.max(0, Math.min(srcW - effectiveCropW, cropX));
    return { time: r.time, cropX, cropY: 0 };
  });

  return { frames: keyframes, cropW: effectiveCropW, cropH };
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
