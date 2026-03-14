/**
 * Motion Tracker — VFX-Quality Camera Motion Estimation via FFmpeg vidstab
 *
 * Uses FFmpeg's built-in vidstabdetect filter to analyze per-frame camera motion
 * (pan, tilt, zoom, rotation). The transforms are applied to a reference surface
 * position so placed products move in mathematical lockstep with the scene —
 * exactly like a real object sitting on the surface.
 *
 * Pipeline:
 * 1. Run vidstabdetect on clip → .trf file with per-frame transforms
 * 2. Parse .trf → FrameTransform[] (dx, dy, rotation, zoom per frame)
 * 3. Pre-compute cumulative transforms from reference frame
 * 4. For each compositing frame: apply cumulative transform to reference position
 *
 * Falls back gracefully if vidstab is not available in the FFmpeg build.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Interfaces ──────────────────────────────────────────────────────

export interface FrameTransform {
  frameIndex: number;
  /** Horizontal pixel displacement (relative to previous frame) */
  dx: number;
  /** Vertical pixel displacement (relative to previous frame) */
  dy: number;
  /** Rotation angle in radians (relative to previous frame) */
  da: number;
  /** Zoom delta (relative to previous frame; 0 = no zoom change) */
  zoom: number;
}

export interface CameraMotionData {
  /** Per-frame transforms from vidstab analysis */
  transforms: FrameTransform[];
  /** Width of frames during vidstab analysis (for pixel → normalized conversion) */
  analysisWidth: number;
  /** Height of frames during vidstab analysis */
  analysisHeight: number;
  /** Frame rate used during analysis */
  fps: number;
  /** Which frame index corresponds to the reference detection */
  referenceFrameIndex: number;
}

export interface CumulativeTransform {
  /** Total horizontal pixel displacement from reference frame */
  dx: number;
  /** Total vertical pixel displacement from reference frame */
  dy: number;
  /** Total rotation in radians from reference frame */
  da: number;
  /** Multiplicative zoom factor from reference frame (1.0 = no change) */
  zoom: number;
}

export interface MotionTrackedPosition {
  x: number;      // 0-1 normalized
  y: number;
  width: number;
  height: number;
}

// ── Vidstab Availability Check ──────────────────────────────────────

let _vidstabAvailable: boolean | null = null;

/**
 * Check if the FFmpeg build includes vidstab filters.
 * Result is cached after first check.
 */
export async function checkVidstabAvailability(): Promise<boolean> {
  if (_vidstabAvailable !== null) return _vidstabAvailable;

  try {
    const output = await runFFmpegCapture(["-filters"]);
    _vidstabAvailable = output.includes("vidstabdetect");

    if (_vidstabAvailable) {
      console.log("[MotionTracker] vidstab filter available in FFmpeg build");
    } else {
      console.warn("[MotionTracker] vidstab not available — motion tracking will use keyframe fallback");
    }

    return _vidstabAvailable;
  } catch {
    _vidstabAvailable = false;
    console.warn("[MotionTracker] Could not check FFmpeg filters — assuming vidstab unavailable");
    return false;
  }
}

// ── Core Analysis Function ──────────────────────────────────────────

/**
 * Analyze camera motion in a clip range using FFmpeg vidstabdetect.
 *
 * Runs vidstab analysis on the specified time range and returns per-frame
 * camera transforms (dx, dy, rotation, zoom). These transforms describe
 * how the camera moved between each pair of consecutive frames.
 *
 * @param videoPath - Path to source video file
 * @param clipStart - Start time in seconds
 * @param clipDuration - Duration in seconds
 * @param fps - Target frame rate for analysis
 * @returns CameraMotionData with per-frame transforms, or null if unavailable
 */
export async function analyzeClipMotion(
  videoPath: string,
  clipStart: number,
  clipDuration: number,
  fps: number
): Promise<CameraMotionData | null> {
  // Check if vidstab is available
  const available = await checkVidstabAvailability();
  if (!available) {
    console.log("[MotionTracker] Skipping motion analysis (vidstab not available)");
    return null;
  }

  // Skip very short clips (not enough frames for meaningful analysis)
  if (clipDuration < 1.0) {
    console.log("[MotionTracker] Skipping motion analysis (clip < 1s)");
    return null;
  }

  const tempDir = path.join(os.tmpdir(), `motion-track-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const trfPath = path.join(tempDir, "transforms.trf");

  try {
    // Step 1: Get video resolution for the clip range
    const dimensions = await getVideoDimensions(videoPath);
    if (!dimensions) {
      console.warn("[MotionTracker] Could not determine video dimensions");
      return null;
    }

    // Step 2: Run vidstabdetect on the clip range
    // shakiness=5: moderate detection sensitivity
    // accuracy=15: maximum accuracy for transform detection
    // mincontrast=0.20: detect features even in lower contrast scenes
    console.log(`[MotionTracker] Analyzing ${clipDuration.toFixed(1)}s clip at ${fps}fps...`);

    await runFFmpegVoid([
      "-nostdin", "-y",
      "-ss", clipStart.toString(),
      "-i", videoPath,
      "-t", clipDuration.toString(),
      "-vf", `fps=${fps},vidstabdetect=shakiness=5:accuracy=15:mincontrast=0.20:result=${trfPath}`,
      "-f", "null",
      "-",
    ], 120000); // 2 minute timeout for analysis

    // Step 3: Parse the .trf file
    if (!fs.existsSync(trfPath)) {
      console.warn("[MotionTracker] vidstabdetect did not produce .trf file");
      return null;
    }

    const transforms = parseTrfFile(trfPath);

    if (transforms.length === 0) {
      console.warn("[MotionTracker] .trf file contained no transforms");
      return null;
    }

    console.log(`[MotionTracker] Parsed ${transforms.length} frame transforms from vidstab`);

    // Step 4: Select reference frame (middle of clip for minimum drift)
    const referenceFrameIndex = Math.floor(transforms.length / 2);

    return {
      transforms,
      analysisWidth: dimensions.width,
      analysisHeight: dimensions.height,
      fps,
      referenceFrameIndex,
    };
  } catch (err: any) {
    console.warn(`[MotionTracker] Analysis failed: ${err.message}`);
    return null;
  } finally {
    // Clean up temp files
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// ── .trf File Parser ────────────────────────────────────────────────

/**
 * Parse a vid.stab .trf (transform) file.
 *
 * File format (vid.stab 1.x):
 * - Header: "VID.STAB 1" (version line)
 * - Lines starting with '#' are comments
 * - Each data line: frameIndex dx dy da [zoom] [extra]
 *   - dx, dy: pixel displacement
 *   - da: rotation angle in radians
 *   - zoom: zoom delta (may be absent in older format)
 */
function parseTrfFile(trfPath: string): FrameTransform[] {
  const content = fs.readFileSync(trfPath, "utf-8");
  const lines = content.split("\n");
  const transforms: FrameTransform[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines, headers, and comments
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("VID.STAB")) {
      continue;
    }

    // Parse space/tab-separated values
    const parts = trimmed.split(/\s+/).map(Number);

    // Need at minimum: frameIndex, dx, dy, da
    if (parts.length < 4 || parts.some(isNaN)) continue;

    transforms.push({
      frameIndex: parts[0],
      dx: parts[1],
      dy: parts[2],
      da: parts[3],
      zoom: parts.length >= 5 ? parts[4] : 0,
    });
  }

  return transforms;
}

// ── Cumulative Transform Computation ────────────────────────────────

/**
 * Pre-compute cumulative transforms for every frame relative to a reference frame.
 *
 * The vidstab transforms describe motion BETWEEN consecutive frames.
 * To get the total camera motion from the reference frame to any target frame,
 * we accumulate transforms:
 * - Forward from reference: sum(dx[ref+1] ... dx[target])
 * - Backward from reference: -sum(dx[target+1] ... dx[ref])
 *
 * This is computed once per clip and cached, so per-frame lookup is O(1).
 */
export function getCumulativeTransforms(
  transforms: FrameTransform[],
  referenceFrameIndex: number
): CumulativeTransform[] {
  const totalFrames = transforms.length + 1; // transforms are between frames, so N transforms → N+1 frames
  const cumulative: CumulativeTransform[] = new Array(totalFrames);

  // Reference frame has identity transform (no displacement from itself)
  const refIdx = Math.min(referenceFrameIndex, totalFrames - 1);
  cumulative[refIdx] = { dx: 0, dy: 0, da: 0, zoom: 1.0 };

  // Accumulate forward from reference frame
  for (let i = refIdx + 1; i < totalFrames; i++) {
    const prev = cumulative[i - 1];
    const t = transforms[i - 1]; // transform FROM frame i-1 TO frame i
    if (t) {
      cumulative[i] = {
        dx: prev.dx + t.dx,
        dy: prev.dy + t.dy,
        da: prev.da + t.da,
        zoom: prev.zoom * (1 + (t.zoom || 0)),
      };
    } else {
      cumulative[i] = { ...prev };
    }
  }

  // Accumulate backward from reference frame
  for (let i = refIdx - 1; i >= 0; i--) {
    const next = cumulative[i + 1];
    const t = transforms[i]; // transform FROM frame i TO frame i+1
    if (t) {
      cumulative[i] = {
        dx: next.dx - t.dx,
        dy: next.dy - t.dy,
        da: next.da - t.da,
        zoom: next.zoom / (1 + (t.zoom || 0)),
      };
    } else {
      cumulative[i] = { ...next };
    }
  }

  return cumulative;
}

// ── Transform Application ───────────────────────────────────────────

/**
 * Apply a cumulative camera transform to a reference surface position.
 *
 * This is the core VFX matchmoving math. Given:
 * - The surface's position in the reference frame (from Gemini detection)
 * - The cumulative camera motion from reference to current frame
 *
 * Computes where the product should appear in the current frame so it
 * stays locked to the physical surface in the scene.
 *
 * Camera motion convention (vidstab):
 * - vidstab dx/dy describe "how to shift this frame to align with the previous"
 * - Positive dx = frame should move right to stabilize = camera panned right
 * - A world-fixed point appears shifted LEFT when camera pans RIGHT
 * - So we SUBTRACT cumulative dx/dy from the reference position
 *
 * @param refPos - Surface position in reference frame (0-1 normalized)
 * @param ct - Cumulative transform from reference to current frame
 * @param analysisWidth - Frame width during vidstab analysis
 * @param analysisHeight - Frame height during vidstab analysis
 */
export function applyTransformToPosition(
  refPos: { x: number; y: number; width: number; height: number },
  ct: CumulativeTransform,
  analysisWidth: number,
  analysisHeight: number
): MotionTrackedPosition {
  // Convert reference position (normalized 0-1) to pixel space
  const refCenterX = (refPos.x + refPos.width / 2) * analysisWidth;
  const refCenterY = (refPos.y + refPos.height / 2) * analysisHeight;

  // Image center (pivot point for rotation and zoom)
  const imgCenterX = analysisWidth / 2;
  const imgCenterY = analysisHeight / 2;

  // Vector from image center to surface center
  let relX = refCenterX - imgCenterX;
  let relY = refCenterY - imgCenterY;

  // Apply rotation (camera rotated → surface appears to rotate opposite)
  const cos = Math.cos(-ct.da);
  const sin = Math.sin(-ct.da);
  const rotatedX = relX * cos - relY * sin;
  const rotatedY = relX * sin + relY * cos;

  // Apply zoom (camera zoomed in → surface appears larger, closer to center)
  const zoomFactor = ct.zoom > 0 ? (1 / ct.zoom) : 1;
  const zoomedX = rotatedX * zoomFactor;
  const zoomedY = rotatedY * zoomFactor;

  // Apply translation (subtract camera motion: camera pans right → surface moves left)
  const finalCenterX = (zoomedX + imgCenterX) - ct.dx;
  const finalCenterY = (zoomedY + imgCenterY) - ct.dy;

  // Scale dimensions by zoom factor
  const finalWidth = refPos.width * zoomFactor;
  const finalHeight = refPos.height * zoomFactor;

  // Convert back to normalized 0-1 coordinates
  return {
    x: (finalCenterX / analysisWidth) - finalWidth / 2,
    y: (finalCenterY / analysisHeight) - finalHeight / 2,
    width: Math.max(0.01, finalWidth),
    height: Math.max(0.01, finalHeight),
  };
}

// ── Reference Frame Selection ───────────────────────────────────────

/**
 * Select the best Gemini keyframe to use as the reference position for
 * motion tracking.
 *
 * Strategy:
 * 1. If keyframes exist, pick the one closest to the temporal center
 *    of the clip (minimizes cumulative drift in both directions)
 * 2. Falls back to bboxStart at frame 0
 *
 * @param keyframes - Available Gemini keyframes (time relative to clip start)
 * @param clipDuration - Clip duration in seconds
 * @param fps - Frame rate
 * @returns Object with the reference position and its frame index
 */
export function selectReferencePosition(
  keyframes: Array<{ time: number; x: number; y: number; width: number; height: number }>,
  bboxStart: { x: number; y: number; width: number; height: number },
  clipDuration: number,
  fps: number
): { position: { x: number; y: number; width: number; height: number }; frameIndex: number } {
  if (!keyframes || keyframes.length === 0) {
    return { position: bboxStart, frameIndex: 0 };
  }

  // Pick keyframe closest to clip center (minimizes cumulative drift)
  const centerTime = clipDuration / 2;
  let bestKf = keyframes[0];
  let bestDist = Math.abs(bestKf.time - centerTime);

  for (const kf of keyframes) {
    const dist = Math.abs(kf.time - centerTime);
    if (dist < bestDist) {
      bestDist = dist;
      bestKf = kf;
    }
  }

  const frameIndex = Math.round(bestKf.time * fps);

  return {
    position: { x: bestKf.x, y: bestKf.y, width: bestKf.width, height: bestKf.height },
    frameIndex,
  };
}

// ── Helper Functions ────────────────────────────────────────────────

/**
 * Get video dimensions using ffprobe.
 */
async function getVideoDimensions(
  videoPath: string
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-select_streams", "v:0",
      videoPath,
    ]);

    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) { resolve(null); return; }
      try {
        const info = JSON.parse(stdout);
        const stream = info.streams?.[0];
        if (stream?.width && stream?.height) {
          resolve({ width: stream.width, height: stream.height });
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });

    proc.on("error", () => resolve(null));
  });
}

/**
 * Run FFmpeg and capture stderr output (used for filter checks).
 */
function runFFmpegCapture(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", () => resolve(stderr));
    proc.on("error", (err) => reject(err));
  });
}

/**
 * Run FFmpeg and wait for completion (used for vidstab analysis).
 */
function runFFmpegVoid(args: string[], timeoutMs: number = 120000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`[MotionTracker] FFmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`[MotionTracker] FFmpeg exited ${code}: ${stderr.slice(-300)}`));
      } else {
        resolve();
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`[MotionTracker] FFmpeg error: ${err.message}`));
    });
  });
}
