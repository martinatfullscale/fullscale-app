/**
 * The TensorFlow side of face tracking — model load, frame extraction,
 * per-frame inference. Everything here does CPU-bound synchronous compute.
 *
 * THIS MODULE MUST ONLY BE IMPORTED FROM THE DETECTION CHILD PROCESS
 * (faceDetectChild.ts) or from faceTracker's explicit in-process fallback.
 * Importing it in the server process puts tfjs-node's native init and every
 * inference on the request-serving event loop — measured in production as
 *   [Stall] EVENT LOOP BLOCKED 12820ms — nothing else ran.
 * (the tfjs import + model load + first inference, the moment a render
 * needed face tracking). The logic is unchanged from when it lived in
 * faceTracker.ts; only the process it runs in is different.
 */

// TensorFlow is LAZY-LOADED: the tfjs-node native binding takes 30-60s+ to
// initialize on small instances. Type-only imports are erased at compile
// time, so they're free.
import type * as tfType from "@tensorflow/tfjs-node";
import type * as cocoSsd from "@tensorflow-models/coco-ssd";
import sharp from "sharp";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

// ── Model Singleton ────────────────────────────────────────────

let model: cocoSsd.ObjectDetection | null = null;
let modelLoading: Promise<cocoSsd.ObjectDetection> | null = null;
let tfMod: typeof tfType | null = null;

async function loadModel(): Promise<cocoSsd.ObjectDetection> {
  if (model) return model;
  if (modelLoading) return modelLoading;

  console.log("[FaceTracker] Loading TensorFlow + COCO-SSD model (lazy)...");
  modelLoading = (async () => {
    tfMod = await import("@tensorflow/tfjs-node");
    const cocoSsdMod = await import("@tensorflow-models/coco-ssd");
    return cocoSsdMod.load({ base: "mobilenet_v2" });
  })();
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
export async function detectFacesInClipCore(
  videoPath: string,
  startTime: number,
  duration: number,
  sampleIntervalSec: number = 0.5,
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

      // Sequential, with a yield after every frame. In the child process this
      // no longer protects HTTP traffic (that is the whole point of the
      // child), but it still lets IPC messages and kill signals get through
      // between inferences instead of after a whole batch.
      const batchResults: FaceDetectionFrame[] = [];
      for (const clipTime of batch) {
        const absTime = startTime + clipTime;
        const framePath = path.join(tmpDir, `frame_${clipTime.toFixed(2)}.jpg`);

        await extractFrame(videoPath, absTime, framePath);

        if (!fs.existsSync(framePath)) {
          batchResults.push({ time: clipTime, faces: [] });
        } else {
          const faces = await detectFacesInFrame(loadedModel, framePath);
          batchResults.push({ time: clipTime, faces });
        }

        await new Promise((r) => setImmediate(r));

        // Deadline is checked per FRAME, not per batch: a batch that overruns
        // used to blow past the soft deadline by its whole remainder.
        if (deadlineMs && Date.now() - started > deadlineMs) break;
      }
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

    // tfMod is set by loadModel(), which necessarily ran before any
    // detection call (the model instance comes from it).
    const tensor = tfMod!.tensor3d(
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

/**
 * Tier 2 (scanner): tight FULL-BODY person boxes for a single frame image.
 * Unlike detectFacesInFrame this returns the whole person bbox (no
 * FACE_REGION_RATIO truncation) — the scanner's occlusion-remainder ghost
 * filter needs the true person envelope, and COCO-SSD's boxes are
 * deterministic frame-to-frame where Gemini's "generous" envelopes vary.
 * Normalized 0-1 coordinates. Throws on failure — the caller decides the
 * fallback (the wrapper in faceTracker.ts maps failure to null).
 */
export async function detectPeopleInFrameCore(
  framePath: string
): Promise<Array<{ x: number; y: number; width: number; height: number; confidence: number }>> {
  const loadedModel = await loadModel();
  const { data, info } = await sharp(framePath)
    .resize(DETECTION_WIDTH, undefined, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const tensor = tfMod!.tensor3d(new Uint8Array(data), [info.height, info.width, info.channels]);
  const predictions = await loadedModel.detect(tensor);
  tensor.dispose();
  return predictions
    .filter((p) => p.class === "person" && p.score >= MIN_PERSON_CONFIDENCE)
    .map((p) => {
      const [bx, by, bw, bh] = p.bbox;
      return {
        x: bx / info.width,
        y: by / info.height,
        width: bw / info.width,
        height: bh / info.height,
        confidence: p.score,
      };
    });
}
