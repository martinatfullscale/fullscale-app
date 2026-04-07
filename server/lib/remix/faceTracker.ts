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

const EMA_ALPHA = 0.15; // Heavy smoothing for camera-like motion
const SPEAKER_HOLD_SEC = 0.3; // Hold before panning to new speaker
const SPEAKER_PAN_SEC = 0.5; // Time to pan to new speaker

/**
 * Compute a smooth crop trajectory from face detection results.
 * Returns pixel-space crop keyframes for the source video.
 */
export function computeCropTrajectory(
  frames: FaceDetectionFrame[],
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number
): CropTrajectory {
  // Compute crop dimensions in source pixels
  // For portrait: crop a vertical strip from the landscape source
  const targetAR = targetW / targetH; // e.g., 0.5625 for 9:16
  const cropW = Math.round(srcH * targetAR);
  const cropH = srcH;

  // Clamp cropW to source width
  const effectiveCropW = Math.min(cropW, srcW);

  if (frames.length === 0) {
    // No detections at all — center crop
    return {
      frames: [{ time: 0, cropX: Math.round((srcW - effectiveCropW) / 2), cropY: 0 }],
      cropW: effectiveCropW,
      cropH,
    };
  }

  // Compute raw crop center for each frame
  const rawCenters: { time: number; cx: number }[] = [];
  let lastKnownCx = srcW / 2; // default: center

  for (const frame of frames) {
    let cx: number;

    if (frame.faces.length === 0) {
      // No faces — carry forward
      cx = lastKnownCx;
    } else if (frame.faces.length === 1) {
      // Single face — center on it
      const face = frame.faces[0];
      cx = (face.x + face.width / 2) * srcW;
    } else {
      // Multiple faces — try to fit all, else follow largest
      const allCenters = frame.faces.map((f) => (f.x + f.width / 2) * srcW);
      const minCx = Math.min(...allCenters);
      const maxCx = Math.max(...allCenters);
      const span = maxCx - minCx;

      if (span < effectiveCropW * 0.8) {
        // All faces fit — center on group
        cx = (minCx + maxCx) / 2;
      } else {
        // Too spread — follow largest (assumed active speaker)
        const largest = frame.faces.reduce((a, b) =>
          a.width * a.height > b.width * b.height ? a : b
        );
        cx = (largest.x + largest.width / 2) * srcW;
      }
    }

    lastKnownCx = cx;
    rawCenters.push({ time: frame.time, cx });
  }

  // Apply bidirectional EMA smoothing
  const smoothed = smoothBidirectional(rawCenters.map((r) => r.cx));

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
