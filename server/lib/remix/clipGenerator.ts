/**
 * Clip Generator — FFmpeg-based Clip Extraction + Platform Formatting
 *
 * Takes clip candidates from clipDetector and extracts actual video clips
 * with product placements composited. Handles:
 * - Precise time-range extraction from source video
 * - Aspect ratio conversion (letterbox/pillarbox/crop)
 * - Frame-by-frame product placement compositing
 * - Audio extraction and sync
 * - Thumbnail generation
 *
 * Adapts patterns from videoExporter.ts for clip-specific workflows.
 */

import { spawn } from "child_process";
import { buildAssSubtitles, escapeAssFilterPath } from "./captionStyler";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { storage } from "../../storage";
import type { ClipCandidate, PlatformConfig, PLATFORM_CONFIGS } from "./clipDetector";
import type { CameraMotionData, CumulativeTransform } from "./motionTracker";
import { detectFacesInClip, computeCropTrajectory, buildCropFilterExpr, getVideoSize } from "./faceTracker";
import type { CropTrajectory } from "./faceTracker";
import { withRenderSlot } from "./renderQueue";

export interface ClipGeneratorInput {
  /** Source video path */
  videoPath: string;
  /** Video ID */
  videoId: number;
  /** The clip candidate to generate */
  clip: ClipCandidate;
  /** Platform configuration */
  platformConfig: PlatformConfig;
  /** Product placements to composite (optional — empty = clean clip) */
  placements: ClipPlacement[];
  /** Enable captions overlay */
  captionsEnabled: boolean;
  /** Caption visual style (ASS karaoke styling); defaults to "highlight" */
  captionStyle?: string;
  /** Caption data if available */
  captionSegments?: CaptionSegment[];
  /** Output directory */
  outputDir: string;
  /** Remix job ID for file naming */
  jobId: number;
  /** Camera motion data from vidstab analysis (VFX matchmoving) */
  cameraMotion?: CameraMotionData;
  /** Face tracking for smart reframing (portrait clips) */
  faceTracking?: {
    enabled: boolean;
    sampleIntervalSec?: number;
  };
}

export interface PlacementKeyframe {
  /** Time in seconds relative to clip start */
  time: number;
  x: number;      // 0-1 normalized
  y: number;
  width: number;
  height: number;
}

export interface ClipPlacement {
  surfaceId: number;
  brandProductId: number;
  productImagePath: string;
  /** Multi-point keyframes for smooth motion tracking (Phase 2A) */
  keyframes: PlacementKeyframe[];
  /** Legacy: Bounding box at clip start (used as fallback if keyframes empty) */
  bboxStart: { x: number; y: number; width: number; height: number };
  /** Legacy: Bounding box at clip end — for 2-point linear interpolation */
  bboxEnd?: { x: number; y: number; width: number; height: number };
  opacity: number;
}

export interface CaptionSegment {
  text: string;
  startTime: number; // relative to clip start
  endTime: number;   // relative to clip start
  /** Word-level timing (clip-relative) — powers karaoke/word-highlight
   *  styling. Absent for AI-generated (non-transcript) captions, which
   *  degrade to plain per-segment display. */
  words?: Array<{ word: string; start: number; end: number }>;
}

export interface ClipGeneratorOutput {
  success: boolean;
  /** Path to the exported clip */
  clipPath: string | null;
  /** Path to the thumbnail */
  thumbnailPath: string | null;
  /** Actual clip duration */
  duration: number;
  /** File size in bytes */
  fileSize: number;
  error?: string;
}

const CLIP_CONFIG = {
  CRF: 20,           // Slightly better quality than full exports
  PRESET: "medium",  // Better compression for shorter clips
  AUDIO_BITRATE: "128k",
  THUMBNAIL_WIDTH: 360,
  FFMPEG_TIMEOUT_MS: 300000, // 5 minutes max
};

/**
 * Generate a single clip from a source video.
 * Gated by the global render queue — frame extraction, face detection, and the
 * x264 encode are all CPU-heavy, so only MAX_CONCURRENT_RENDERS run at once.
 */
export function generateClip(input: ClipGeneratorInput): Promise<ClipGeneratorOutput> {
  return withRenderSlot(
    `generateClip(job ${input.jobId}, video ${input.videoId})`,
    () => generateClipUngated(input),
  );
}

async function generateClipUngated(input: ClipGeneratorInput): Promise<ClipGeneratorOutput> {
  const {
    videoPath, videoId, clip, platformConfig, placements,
    captionsEnabled, captionSegments, outputDir, jobId
  } = input;

  const emptyResult: ClipGeneratorOutput = {
    success: false, clipPath: null, thumbnailPath: null, duration: 0, fileSize: 0,
  };

  try {
    fs.mkdirSync(outputDir, { recursive: true });

    const clipFilename = `clip_j${jobId}_v${videoId}_${clip.platform}_${Date.now()}.mp4`;
    const clipPath = path.join(outputDir, clipFilename);

    if (placements.length > 0) {
      // Complex path: extract frames → composite placements → re-encode
      await generateWithPlacements(input, clipPath);
    } else {
      // Simple path: direct FFmpeg clip extraction + reformat
      await generateCleanClip(videoPath, clip, platformConfig, captionsEnabled, captionSegments, clipPath, input.faceTracking, input.captionStyle);
    }

    // Verify output exists
    if (!fs.existsSync(clipPath)) {
      return { ...emptyResult, error: "Clip file not created" };
    }

    const stats = fs.statSync(clipPath);

    // Generate thumbnail from middle of clip
    const thumbnailFilename = clipFilename.replace(".mp4", "_thumb.jpg");
    const thumbnailPath = path.join(outputDir, thumbnailFilename);
    await generateThumbnail(clipPath, thumbnailPath, clip.duration / 2, platformConfig);

    const duration = await getClipDuration(clipPath);

    console.log(`[ClipGenerator] Generated: ${clipFilename} (${duration.toFixed(1)}s, ${(stats.size / 1024 / 1024).toFixed(1)}MB)`);

    return {
      success: true,
      clipPath,
      thumbnailPath: fs.existsSync(thumbnailPath) ? thumbnailPath : null,
      duration,
      fileSize: stats.size,
    };
  } catch (err: any) {
    console.error("[ClipGenerator] Error:", err.message);
    return { ...emptyResult, error: err.message };
  }
}

/**
 * Simple clip extraction: trim video + reformat for platform.
 */
async function generateCleanClip(
  videoPath: string,
  clip: ClipCandidate,
  config: PlatformConfig,
  captionsEnabled: boolean,
  captionSegments: CaptionSegment[] | undefined,
  outputPath: string,
  faceTracking?: { enabled: boolean; sampleIntervalSec?: number },
  captionStyle?: string,
): Promise<void> {
  const args = [
    "-nostdin", "-y",
    "-ss", clip.startTime.toString(),
    "-i", videoPath,
    "-t", clip.duration.toString(),
  ];

  // Build video filter chain
  const filters: string[] = [];

  // Scale + crop for target aspect ratio
  const [arW, arH] = config.aspectRatio.split(":").map(Number);
  const targetAR = arW / arH;

  if (targetAR < 1) {
    // Portrait (9:16) — smart crop with face tracking or center crop
    const cropFilter = await buildSmartCropFilter(
      videoPath, clip, config, faceTracking
    );
    if (cropFilter) {
      filters.push(cropFilter);
      filters.push(`scale=${config.targetWidth}:${config.targetHeight}`);
    } else {
      // Fallback: center crop (still no black bars)
      filters.push(`scale=-2:${config.targetHeight}`);
      filters.push(`crop=${config.targetWidth}:${config.targetHeight}`);
    }
  } else {
    // Landscape (16:9) — scale to fit height, pad horizontally if needed
    filters.push(`scale=-2:${config.targetHeight}`);
    filters.push(`pad=${config.targetWidth}:${config.targetHeight}:(ow-iw)/2:(oh-ih)/2:black`);
  }

  // Burn-in captions if enabled and segments provided. Preferred path is
  // ASS/libass (word-timed karaoke styling); the legacy drawtext filter is
  // the fallback so a styling failure never costs the clip.
  const baseFilters = [...filters];
  let assPath: string | null = null;
  if (captionsEnabled && captionSegments && captionSegments.length > 0) {
    const assContent = buildAssSubtitles(captionSegments, captionStyle ?? "highlight", config);
    if (assContent) {
      assPath = `${outputPath}.captions.ass`;
      try {
        fs.writeFileSync(assPath, assContent);
        filters.push(`ass='${escapeAssFilterPath(assPath)}'`);
      } catch {
        assPath = null;
      }
    }
    if (!assPath) {
      const subtitleFilter = buildCaptionFilter(captionSegments, config);
      if (subtitleFilter) filters.push(subtitleFilter);
    }
  }

  const encodeArgs = (vf: string[]): string[] => [
    ...args,
    "-vf", vf.join(","),
    "-r", config.targetFps.toString(),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-preset", CLIP_CONFIG.PRESET,
    "-crf", CLIP_CONFIG.CRF.toString(),
    "-c:a", "aac", "-b:a", CLIP_CONFIG.AUDIO_BITRATE,
    "-shortest",
    "-movflags", "+faststart",
    outputPath,
  ];

  try {
    await runFFmpeg(encodeArgs(filters));
  } catch (err) {
    if (!assPath) throw err;
    // ASS render failed (missing fonts / libass quirk) — retry with the
    // legacy drawtext captions rather than shipping no clip.
    console.warn(`[ClipGen] ASS caption render failed — retrying with drawtext fallback`);
    const fallbackFilters = [...baseFilters];
    const subtitleFilter = buildCaptionFilter(captionSegments!, config);
    if (subtitleFilter) fallbackFilters.push(subtitleFilter);
    await runFFmpeg(encodeArgs(fallbackFilters));
  } finally {
    if (assPath) { try { fs.unlinkSync(assPath); } catch { /* ignore */ } }
  }
}

/** A computed portrait reframe: the crop trajectory plus the source dimensions
 * it is expressed in. Shared by the clean-clip filter path and the placement
 * frame-composite path so both reframe identically. */
interface ReframeData {
  trajectory: CropTrajectory;
  srcW: number;
  srcH: number;
}

/**
 * Compute a crop trajectory for reframing a clip to the target aspect ratio.
 * Runs face detection (with a hard timeout + fallback) when enabled and faces
 * are found; otherwise returns a static center-crop trajectory (which still
 * fills the target with no black bars). Returns null only on hard failure.
 */
async function detectCropTrajectory(
  videoPath: string,
  clip: ClipCandidate,
  config: PlatformConfig,
  faceTracking?: { enabled: boolean; sampleIntervalSec?: number }
): Promise<ReframeData | null> {
  try {
    const srcSize = await getVideoSize(videoPath);
    const targetAR = config.targetWidth / config.targetHeight;
    const cropW = Math.min(Math.round(srcSize.height * targetAR), srcSize.width);
    const cropH = srcSize.height;

    if (faceTracking?.enabled) {
      console.log(`[ClipGenerator] Running face detection for smart reframe (${clip.duration.toFixed(1)}s clip)...`);
      const interval = faceTracking.sampleIntervalSec || 0.5;

      // Hard timeout on face detection. The sharp/ONNX model lazy-loads on first
      // call and has been observed to hang indefinitely on CPU-starved containers,
      // wedging the entire remix pipeline. 60 seconds is a generous upper bound
      // for a legitimate run (even a 60s clip sampled every 0.5s = 120 frames at
      // ~250ms each = 30s). Anything longer is definitely stuck, so we fall back
      // to center crop and keep the pipeline moving.
      const FACE_DETECTION_TIMEOUT_MS = 60_000;
      let detectionTimedOut = false;

      const frames = await Promise.race([
        detectFacesInClip(videoPath, clip.startTime, clip.duration, interval),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            detectionTimedOut = true;
            reject(new Error(`Face detection timed out after ${FACE_DETECTION_TIMEOUT_MS}ms`));
          }, FACE_DETECTION_TIMEOUT_MS)
        ),
      ]).catch((err: any) => {
        if (detectionTimedOut) {
          console.warn(`[ClipGenerator] ⚠️  ${err.message} — falling back to center crop. This likely means the face detection model is blocked (cold-start model load on CPU-starved container).`);
        } else {
          console.warn(`[ClipGenerator] Face detection errored: ${err.message} — falling back to center crop`);
        }
        return [] as Awaited<ReturnType<typeof detectFacesInClip>>;
      });

      const totalFaces = frames.reduce((sum, f) => sum + f.faces.length, 0);

      if (totalFaces > 0) {
        console.log(`[ClipGenerator] Detected ${totalFaces} person instances across ${frames.length} samples — computing crop trajectory`);
        const trajectory = computeCropTrajectory(
          frames, srcSize.width, srcSize.height,
          config.targetWidth, config.targetHeight
        );
        return { trajectory, srcW: srcSize.width, srcH: srcSize.height };
      }

      console.log("[ClipGenerator] No faces detected — using center crop");
    }

    // Static center-crop trajectory (fills the frame, no black bars)
    const centerX = Math.round((srcSize.width - cropW) / 2);
    return {
      trajectory: { frames: [{ time: 0, cropX: centerX, cropY: 0 }], cropW, cropH },
      srcW: srcSize.width,
      srcH: srcSize.height,
    };
  } catch (err: any) {
    console.warn(`[ClipGenerator] Crop trajectory failed: ${err.message}`);
    return null;
  }
}

/**
 * Build a smart crop filter using face detection.
 * Returns a crop filter string, or null to fall back to center crop.
 */
async function buildSmartCropFilter(
  videoPath: string,
  clip: ClipCandidate,
  config: PlatformConfig,
  faceTracking?: { enabled: boolean; sampleIntervalSec?: number }
): Promise<string | null> {
  const reframe = await detectCropTrajectory(videoPath, clip, config, faceTracking);
  if (!reframe) return null;
  const { trajectory } = reframe;
  // A single static keyframe → a constant crop expression (same as the old
  // center-crop fallback string). Multiple keyframes → a time-varying pan.
  if (trajectory.frames.length <= 1) {
    const f = trajectory.frames[0];
    return `crop=${trajectory.cropW}:${trajectory.cropH}:${f ? f.cropX : 0}:0`;
  }
  return buildCropFilterExpr(trajectory);
}

/** Linearly interpolate the crop-X of a trajectory at a clip-relative time. */
function cropXAtTime(trajectory: CropTrajectory, t: number): number {
  const f = trajectory.frames;
  if (f.length === 0) return 0;
  if (f.length === 1 || t <= f[0].time) return f[0].cropX;
  const last = f[f.length - 1];
  if (t >= last.time) return last.cropX;
  for (let i = 1; i < f.length; i++) {
    if (t <= f[i].time) {
      const a = f[i - 1];
      const b = f[i];
      const span = b.time - a.time;
      const frac = span > 0 ? (t - a.time) / span : 0;
      return Math.round(a.cropX + (b.cropX - a.cropX) * frac);
    }
  }
  return last.cropX;
}

/**
 * Complex clip generation with product placements composited frame-by-frame.
 */
async function generateWithPlacements(
  input: ClipGeneratorInput,
  outputPath: string
): Promise<void> {
  const { videoPath, clip, platformConfig, placements, captionsEnabled, captionSegments } = input;
  const tempDir = path.join(path.dirname(outputPath), `temp_${Date.now()}`);
  const framesDir = path.join(tempDir, "frames");
  const compositedDir = path.join(tempDir, "composited");

  // Clear the keyframe stabilization cache for this new clip
  clearStabilizationCache();

  // Portrait targets must be reframed (smart crop) before compositing — otherwise
  // the source frame is letterboxed into 9:16 with black bars AND the product
  // overlays (whose coordinates are normalized to the SOURCE frame) land in the
  // wrong place. Compute the crop trajectory once, then crop + map coords per frame.
  const [arW, arH] = platformConfig.aspectRatio.split(":").map(Number);
  const isPortrait = arW / arH < 1;
  let reframe: ReframeData | null = null;
  if (isPortrait) {
    reframe = await detectCropTrajectory(videoPath, clip, platformConfig, input.faceTracking);
    if (reframe) {
      console.log(`[ClipGenerator] Reframing ${placements.length} placement clip(s) to ${platformConfig.aspectRatio} (crop ${reframe.trajectory.cropW}x${reframe.trajectory.cropH})`);
    }
  }

  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(compositedDir, { recursive: true });

  try {
    // Step 1: Extract frames for the clip range
    const framePattern = path.join(framesDir, "frame_%05d.jpg");
    await runFFmpeg([
      "-nostdin", "-y",
      "-ss", clip.startTime.toString(),
      "-i", videoPath,
      "-t", clip.duration.toString(),
      "-an",
      "-vf", `fps=${platformConfig.targetFps}`,
      "-q:v", "2",
      framePattern,
    ]);

    // Step 2: Prepare motion tracking data (VFX matchmoving)
    let cumulativeTransforms: CumulativeTransform[] | null = null;
    let motionRefPositions: Map<number, { x: number; y: number; width: number; height: number }> | null = null;
    let motionData: CameraMotionData | null = input.cameraMotion || null;

    if (motionData && motionData.transforms.length > 0) {
      const { getCumulativeTransforms, selectReferencePosition } = await import("./motionTracker");

      // Pre-compute cumulative transforms once for the entire clip
      cumulativeTransforms = getCumulativeTransforms(
        motionData.transforms,
        motionData.referenceFrameIndex
      );

      // For each placement, determine its reference position (the "anchor")
      motionRefPositions = new Map();
      for (const placement of placements) {
        const ref = selectReferencePosition(
          placement.keyframes,
          placement.bboxStart,
          clip.duration,
          motionData.fps
        );
        motionRefPositions.set(placement.surfaceId, ref.position);
      }

      console.log(`[ClipGenerator] Using VFX motion tracking for ${placements.length} placement(s) (${cumulativeTransforms.length} frames)`);
    }

    // Step 3: Composite placements onto each frame
    const frames = fs.readdirSync(framesDir).filter(f => f.endsWith(".jpg")).sort();
    const totalFrames = frames.length;
    const clipDuration = clip.duration;

    // Read the ACTUAL first-frame dimensions. Two uses: (1) the crop trajectory
    // was computed from ffprobe's coded dimensions, but extracted JPEGs have
    // auto-rotation applied — on mismatch, sharp's .extract() would throw and
    // abort the clip, so we fall back to letterboxing; (2) the letterbox
    // fallback needs the real dims to map placement coords into the displayed
    // image region instead of the full canvas (black bars).
    let frameDims: { width: number; height: number } | null = null;
    if (totalFrames > 0) {
      try {
        const meta = await sharp(path.join(framesDir, frames[0])).metadata();
        if (meta.width && meta.height) frameDims = { width: meta.width, height: meta.height };
      } catch (err: any) {
        console.warn(`[ClipGenerator] Could not read frame metadata (${err.message})`);
      }
    }
    if (reframe && (!frameDims || frameDims.width !== reframe.srcW || frameDims.height !== reframe.srcH)) {
      console.warn(
        `[ClipGenerator] Frame dims ${frameDims?.width}x${frameDims?.height} differ from probed ${reframe.srcW}x${reframe.srcH} ` +
          `(rotation/anamorphic?) — disabling smart reframe for this clip, letterboxing instead`
      );
      reframe = null;
    }

    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(framesDir, frames[i]);
      const outputFrame = path.join(compositedDir, frames[i]);
      // Current time in seconds relative to clip start
      const currentTime = totalFrames > 1 ? (i / (totalFrames - 1)) * clipDuration : 0;

      // Per-frame crop window for portrait reframing (null = letterbox fallback)
      const reframeWindow = reframe
        ? {
            cropX: cropXAtTime(reframe.trajectory, currentTime),
            cropW: reframe.trajectory.cropW,
            cropH: reframe.trajectory.cropH,
            srcW: reframe.srcW,
            srcH: reframe.srcH,
          }
        : null;

      await compositeFrameWithPlacements(
        framePath, outputFrame, placements, currentTime, clipDuration, platformConfig,
        i, cumulativeTransforms, motionRefPositions, motionData, reframeWindow, frameDims
      );
    }

    // Step 3: Re-encode composited frames with audio
    const compositedPattern = path.join(compositedDir, "frame_%05d.jpg");
    const encodeArgs = [
      "-nostdin", "-y",
      "-framerate", platformConfig.targetFps.toString(),
      "-i", compositedPattern,
      "-ss", clip.startTime.toString(),
      "-i", videoPath,
      "-t", clip.duration.toString(),
      "-map", "0:v", "-map", "1:a?",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-preset", CLIP_CONFIG.PRESET,
      "-crf", CLIP_CONFIG.CRF.toString(),
      "-c:a", "aac", "-b:a", CLIP_CONFIG.AUDIO_BITRATE,
      "-shortest",
      "-movflags", "+faststart",
      outputPath,
    ];

    await runFFmpeg(encodeArgs);
  } finally {
    // Clean up temp directories
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Composite product placements onto a single frame with aspect ratio handling.
 *
 * Supports two positioning modes:
 * 1. MOTION TRACKED (VFX matchmoving): Uses vidstab camera transforms to compute
 *    exact position from a reference frame. Product moves in lockstep with the scene.
 * 2. KEYFRAME INTERPOLATION (fallback): Uses stabilized Gemini keyframes with
 *    Catmull-Rom spline interpolation. Less precise but works without vidstab.
 */
async function compositeFrameWithPlacements(
  framePath: string,
  outputPath: string,
  placements: ClipPlacement[],
  currentTime: number,  // seconds relative to clip start
  clipDuration: number,
  config: PlatformConfig,
  // Motion tracking parameters (optional — null = use keyframe fallback)
  frameIndex?: number,
  cumulativeTransforms?: CumulativeTransform[] | null,
  motionRefPositions?: Map<number, { x: number; y: number; width: number; height: number }> | null,
  cameraMotion?: CameraMotionData | null,
  // Portrait reframe window in SOURCE pixels (null = letterbox the source frame)
  reframeWindow?: { cropX: number; cropW: number; cropH: number; srcW: number; srcH: number } | null,
  // Actual frame dimensions (for correct letterbox coordinate mapping)
  frameDims?: { width: number; height: number } | null,
): Promise<void> {
  let pipeline = sharp(framePath);

  // Letterbox geometry (contain fit): where the source image actually lands on
  // the target canvas. Needed to map source-normalized placement coords when we
  // are NOT smart-cropping — mapping them straight to canvas coords puts
  // products on the black bars.
  let letterbox: { offX: number; offY: number; dispW: number; dispH: number } | null = null;

  if (reframeWindow) {
    // Smart-crop the source frame to the target AR (no black bars), then scale.
    const left = Math.max(0, Math.min(reframeWindow.srcW - reframeWindow.cropW, reframeWindow.cropX));
    pipeline = pipeline
      .extract({ left, top: 0, width: reframeWindow.cropW, height: reframeWindow.cropH })
      .resize(config.targetWidth, config.targetHeight);
  } else {
    // No reframe (landscape, or reframe unavailable) — letterbox into target
    pipeline = pipeline.resize(config.targetWidth, config.targetHeight, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    });
    if (frameDims && frameDims.width > 0 && frameDims.height > 0) {
      const scale = Math.min(
        config.targetWidth / frameDims.width,
        config.targetHeight / frameDims.height,
      );
      const dispW = frameDims.width * scale;
      const dispH = frameDims.height * scale;
      letterbox = {
        offX: (config.targetWidth - dispW) / 2,
        offY: (config.targetHeight - dispH) / 2,
        dispW,
        dispH,
      };
    }
  }

  // Composite each placement
  const composites: sharp.OverlayOptions[] = [];

  for (const placement of placements) {
    try {
      if (!fs.existsSync(placement.productImagePath)) continue;

      let bbox: { x: number; y: number; width: number; height: number };

      // Try motion-tracked positioning first (VFX matchmoving)
      if (
        cumulativeTransforms &&
        motionRefPositions &&
        cameraMotion &&
        frameIndex !== undefined &&
        frameIndex < cumulativeTransforms.length
      ) {
        const refPos = motionRefPositions.get(placement.surfaceId);
        if (refPos) {
          // Use camera transform to compute exact position relative to reference
          const { applyTransformToPosition } = await import("./motionTracker");
          bbox = applyTransformToPosition(
            refPos,
            cumulativeTransforms[frameIndex],
            cameraMotion.analysisWidth,
            cameraMotion.analysisHeight
          );
        } else {
          // No reference position for this surface — fall back to keyframe interpolation
          bbox = interpolatePlacement(placement, currentTime, clipDuration);
        }
      } else {
        // No motion data — use existing keyframe interpolation (stabilized + Catmull-Rom)
        bbox = interpolatePlacement(placement, currentTime, clipDuration);
      }

      // Convert normalized (source-frame) coords to target pixel coords.
      let px: number, py: number, pw: number, ph: number;
      if (reframeWindow) {
        // Map through the crop window: source px → crop-relative → target px.
        const { cropX, cropW, cropH, srcW, srcH } = reframeWindow;
        px = Math.round(((bbox.x * srcW - cropX) / cropW) * config.targetWidth);
        py = Math.round(((bbox.y * srcH) / cropH) * config.targetHeight);
        pw = Math.round(((bbox.width * srcW) / cropW) * config.targetWidth);
        ph = Math.round(((bbox.height * srcH) / cropH) * config.targetHeight);
      } else if (letterbox) {
        // Map into the letterboxed image region, not the full canvas — the
        // source only occupies [offX..offX+dispW] × [offY..offY+dispH].
        px = Math.round(letterbox.offX + bbox.x * letterbox.dispW);
        py = Math.round(letterbox.offY + bbox.y * letterbox.dispH);
        pw = Math.round(bbox.width * letterbox.dispW);
        ph = Math.round(bbox.height * letterbox.dispH);
      } else {
        px = Math.round(bbox.x * config.targetWidth);
        py = Math.round(bbox.y * config.targetHeight);
        pw = Math.round(bbox.width * config.targetWidth);
        ph = Math.round(bbox.height * config.targetHeight);
      }

      // Surface entirely outside the canvas (cropped out by the reframe, or a
      // motion-tracked box that drifted off) — don't composite it.
      if (px + pw <= 0 || py + ph <= 0 || px >= config.targetWidth || py >= config.targetHeight) {
        continue;
      }

      // Resize product image
      let productBuffer = await sharp(placement.productImagePath)
        .resize(Math.max(pw, 16), Math.max(ph, 16), { fit: "inside" })
        .ensureAlpha()
        .png()
        .toBuffer();

      // Apply opacity
      if (placement.opacity < 1.0) {
        const { data, info } = await sharp(productBuffer).raw().toBuffer({ resolveWithObject: true });
        if (info.channels === 4) {
          for (let i = 3; i < data.length; i += 4) {
            data[i] = Math.round(data[i] * placement.opacity);
          }
          productBuffer = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
        }
      }

      // Clip the overlay to the visible canvas region. Two failure modes
      // otherwise: (1) sharp THROWS if an overlay is larger than the canvas
      // (a reframed wide surface easily is), killing the whole clip; (2) a
      // product straddling the crop's left/top edge would be slid into frame by
      // the left/top clamp instead of being edge-cropped, detaching it from its
      // surface. Crop the buffer to the intersection instead.
      const meta = await sharp(productBuffer).metadata();
      const bufW = meta.width ?? pw;
      const bufH = meta.height ?? ph;
      const cropLeft = Math.max(0, -px);
      const cropTop = Math.max(0, -py);
      const visW = Math.min(bufW - cropLeft, config.targetWidth - Math.max(0, px));
      const visH = Math.min(bufH - cropTop, config.targetHeight - Math.max(0, py));
      if (visW <= 0 || visH <= 0) continue;
      if (cropLeft > 0 || cropTop > 0 || visW < bufW || visH < bufH) {
        productBuffer = await sharp(productBuffer)
          .extract({ left: cropLeft, top: cropTop, width: visW, height: visH })
          .png()
          .toBuffer();
      }

      composites.push({
        input: productBuffer,
        left: Math.max(0, px),
        top: Math.max(0, py),
        blend: "over",
      });
    } catch (err) {
      console.warn(`[ClipGenerator] Skipping placement for surface ${placement.surfaceId}:`, err);
    }
  }

  if (composites.length > 0) {
    pipeline = pipeline.composite(composites);
  }

  await pipeline.jpeg({ quality: 92 }).toFile(outputPath);
}

/**
 * Catmull-Rom spline scalar interpolation.
 * Given 4 control points p0,p1,p2,p3 and parameter t (0-1 between p1 and p2),
 * returns the smoothly interpolated value.
 */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

// ── Keyframe Stabilization Pipeline ─────────────────────────────────
// Eliminates bounding box jitter from noisy frame-by-frame Gemini detections.
// Applied once per placement before interpolation begins.

/**
 * Remove outlier keyframes that jump too far from their neighbors.
 * A keyframe is an outlier if its position is more than `threshold` (normalized)
 * away from the median of its immediate neighborhood.
 */
function rejectOutlierKeyframes(
  kfs: PlacementKeyframe[],
  threshold: number = 0.12
): PlacementKeyframe[] {
  if (kfs.length <= 3) return kfs; // Too few to filter

  const result: PlacementKeyframe[] = [kfs[0]]; // Always keep first

  for (let i = 1; i < kfs.length - 1; i++) {
    const prev = kfs[i - 1];
    const curr = kfs[i];
    const next = kfs[i + 1];

    // Expected position = midpoint between prev and next
    const expectedX = (prev.x + next.x) / 2;
    const expectedY = (prev.y + next.y) / 2;

    const dx = Math.abs(curr.x - expectedX);
    const dy = Math.abs(curr.y - expectedY);

    // If this keyframe deviates too far from expected, skip it
    if (dx > threshold || dy > threshold) {
      console.log(`[ClipGenerator] Rejected outlier keyframe at t=${curr.time.toFixed(2)}s (dx=${dx.toFixed(4)}, dy=${dy.toFixed(4)})`);
      continue;
    }
    result.push(curr);
  }

  result.push(kfs[kfs.length - 1]); // Always keep last
  return result;
}

/**
 * Apply exponential moving average (EMA) smoothing to keyframe positions.
 * This acts as a low-pass filter to eliminate frame-to-frame detection noise
 * while preserving genuine camera/object motion.
 *
 * alpha = 0.3 → heavy smoothing (slower to react, very stable)
 * alpha = 0.5 → moderate smoothing (good balance)
 * alpha = 0.7 → light smoothing (responsive, less stable)
 */
function smoothKeyframes(
  kfs: PlacementKeyframe[],
  alpha: number = 0.4
): PlacementKeyframe[] {
  if (kfs.length <= 1) return kfs;

  const smoothed: PlacementKeyframe[] = [{ ...kfs[0] }]; // First keyframe unchanged

  for (let i = 1; i < kfs.length; i++) {
    const prev = smoothed[i - 1];
    smoothed.push({
      time: kfs[i].time,
      x: alpha * kfs[i].x + (1 - alpha) * prev.x,
      y: alpha * kfs[i].y + (1 - alpha) * prev.y,
      width: alpha * kfs[i].width + (1 - alpha) * prev.width,
      height: alpha * kfs[i].height + (1 - alpha) * prev.height,
    });
  }

  // Second pass: reverse EMA to reduce phase delay (bidirectional smoothing)
  const biSmoothed: PlacementKeyframe[] = new Array(smoothed.length);
  biSmoothed[smoothed.length - 1] = { ...smoothed[smoothed.length - 1] };

  for (let i = smoothed.length - 2; i >= 0; i--) {
    const next = biSmoothed[i + 1];
    biSmoothed[i] = {
      time: smoothed[i].time,
      x: alpha * smoothed[i].x + (1 - alpha) * next.x,
      y: alpha * smoothed[i].y + (1 - alpha) * next.y,
      width: alpha * smoothed[i].width + (1 - alpha) * next.width,
      height: alpha * smoothed[i].height + (1 - alpha) * next.height,
    };
  }

  // Blend forward and reverse passes (average)
  return smoothed.map((fwd, i) => ({
    time: fwd.time,
    x: (fwd.x + biSmoothed[i].x) / 2,
    y: (fwd.y + biSmoothed[i].y) / 2,
    width: (fwd.width + biSmoothed[i].width) / 2,
    height: (fwd.height + biSmoothed[i].height) / 2,
  }));
}

/**
 * Lock bounding box dimensions to the median size across all keyframes.
 * Prevents the product image from visibly resizing frame-to-frame
 * due to noisy width/height detections.
 */
function stabilizeDimensions(kfs: PlacementKeyframe[]): PlacementKeyframe[] {
  if (kfs.length <= 1) return kfs;

  // Use median dimensions as the "true" surface size
  const widths = kfs.map((k) => k.width).sort((a, b) => a - b);
  const heights = kfs.map((k) => k.height).sort((a, b) => a - b);

  const medianW = widths[Math.floor(widths.length / 2)];
  const medianH = heights[Math.floor(heights.length / 2)];

  // Allow minor dimension changes (< 15% from median), but clamp wild swings
  const maxDrift = 0.15;
  return kfs.map((k) => ({
    ...k,
    width: Math.abs(k.width - medianW) / medianW > maxDrift ? medianW : k.width,
    height: Math.abs(k.height - medianH) / medianH > maxDrift ? medianH : k.height,
  }));
}

/**
 * Full stabilization pipeline: outlier rejection → dimension lock → EMA smoothing.
 * Call this once per placement's keyframes before interpolation.
 */
function stabilizeKeyframes(kfs: PlacementKeyframe[]): PlacementKeyframe[] {
  if (!kfs || kfs.length <= 2) return kfs;

  // Step 1: Remove spatial outliers (bad detections that jump wildly)
  let result = rejectOutlierKeyframes(kfs, 0.12);

  // Step 2: Lock dimensions to median (prevents product resize flicker)
  result = stabilizeDimensions(result);

  // Step 3: Apply bidirectional EMA smoothing (eliminates remaining noise)
  result = smoothKeyframes(result, 0.4);

  return result;
}

// Cache stabilized keyframes per surfaceId to avoid re-processing per frame
const _stabilizedCache = new Map<number, PlacementKeyframe[]>();

function getStabilizedKeyframes(placement: ClipPlacement): PlacementKeyframe[] {
  const cached = _stabilizedCache.get(placement.surfaceId);
  if (cached) return cached;

  const stabilized = stabilizeKeyframes(placement.keyframes);
  _stabilizedCache.set(placement.surfaceId, stabilized);

  if (placement.keyframes.length > 0) {
    console.log(`[ClipGenerator] Surface ${placement.surfaceId}: ${placement.keyframes.length} raw → ${stabilized.length} stabilized keyframes`);
  }

  return stabilized;
}

/**
 * Clear the stabilization cache. Call at the start of each clip generation.
 */
function clearStabilizationCache(): void {
  _stabilizedCache.clear();
}

/**
 * Interpolate bounding box position at a given time using stabilized keyframes.
 *
 * - 0 keyframes: falls back to bboxStart (static)
 * - 1 keyframe: static position
 * - 2 keyframes: linear interpolation
 * - 3+ keyframes: Catmull-Rom spline for smooth curves
 *
 * Edge behavior: Uses velocity extrapolation at clip boundaries instead of
 * hard-clamping, so products don't "snap" to a fixed position at edges.
 */
function interpolatePlacement(
  placement: ClipPlacement,
  currentTime: number, // seconds relative to clip start
  clipDuration: number,
): { x: number; y: number; width: number; height: number } {
  // Use stabilized keyframes (outlier rejected + smoothed)
  const kfs = getStabilizedKeyframes(placement);

  // Fallback: no keyframes → use legacy bboxStart/bboxEnd
  if (!kfs || kfs.length === 0) {
    const t = clipDuration > 0 ? Math.min(1, Math.max(0, currentTime / clipDuration)) : 0;
    const start = placement.bboxStart;
    const end = placement.bboxEnd || start;
    return {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      width: start.width + (end.width - start.width) * t,
      height: start.height + (end.height - start.height) * t,
    };
  }

  // 1 keyframe: static
  if (kfs.length === 1) {
    return { x: kfs[0].x, y: kfs[0].y, width: kfs[0].width, height: kfs[0].height };
  }

  // Edge extrapolation: smoothly extend motion beyond keyframe boundaries
  // instead of hard-clamping (which causes visible snapping)
  if (currentTime <= kfs[0].time) {
    if (kfs.length >= 2) {
      // Extrapolate backwards using velocity from first two keyframes
      const dt = kfs[1].time - kfs[0].time;
      if (dt > 0) {
        const timeBefore = kfs[0].time - currentTime;
        // Decay the extrapolation so it doesn't drift too far (max 0.5s of motion)
        const extFactor = Math.min(timeBefore / dt, 0.5);
        return {
          x: kfs[0].x - (kfs[1].x - kfs[0].x) * extFactor,
          y: kfs[0].y - (kfs[1].y - kfs[0].y) * extFactor,
          width: Math.max(0.01, kfs[0].width),
          height: Math.max(0.01, kfs[0].height),
        };
      }
    }
    return { x: kfs[0].x, y: kfs[0].y, width: kfs[0].width, height: kfs[0].height };
  }
  if (currentTime >= kfs[kfs.length - 1].time) {
    const last = kfs[kfs.length - 1];
    if (kfs.length >= 2) {
      // Extrapolate forward using velocity from last two keyframes
      const prev = kfs[kfs.length - 2];
      const dt = last.time - prev.time;
      if (dt > 0) {
        const timeAfter = currentTime - last.time;
        const extFactor = Math.min(timeAfter / dt, 0.5);
        return {
          x: last.x + (last.x - prev.x) * extFactor,
          y: last.y + (last.y - prev.y) * extFactor,
          width: Math.max(0.01, last.width),
          height: Math.max(0.01, last.height),
        };
      }
    }
    return { x: last.x, y: last.y, width: last.width, height: last.height };
  }

  // Find the segment: kfs[i] <= currentTime < kfs[i+1]
  let i = 0;
  for (; i < kfs.length - 1; i++) {
    if (currentTime >= kfs[i].time && currentTime < kfs[i + 1].time) break;
  }

  const segDuration = kfs[i + 1].time - kfs[i].time;
  const t = segDuration > 0 ? (currentTime - kfs[i].time) / segDuration : 0;

  // 2 keyframes: linear
  if (kfs.length === 2) {
    return {
      x: kfs[0].x + (kfs[1].x - kfs[0].x) * t,
      y: kfs[0].y + (kfs[1].y - kfs[0].y) * t,
      width: kfs[0].width + (kfs[1].width - kfs[0].width) * t,
      height: kfs[0].height + (kfs[1].height - kfs[0].height) * t,
    };
  }

  // 3+ keyframes: Catmull-Rom spline
  // Get 4 control points: p0, p1 (current), p2 (next), p3
  // Mirror endpoints for boundary segments
  const p0 = kfs[Math.max(0, i - 1)];
  const p1 = kfs[i];
  const p2 = kfs[i + 1];
  const p3 = kfs[Math.min(kfs.length - 1, i + 2)];

  return {
    x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
    y: catmullRom(p0.y, p1.y, p2.y, p3.y, t),
    width: Math.max(0.01, catmullRom(p0.width, p1.width, p2.width, p3.width, t)),
    height: Math.max(0.01, catmullRom(p0.height, p1.height, p2.height, p3.height, t)),
  };
}

/**
 * Escape caption text for an FFmpeg drawtext `text='...'` value.
 *
 * FFmpeg is spawned directly (no shell), but the value still passes through TWO
 * quote/backslash-aware unescape passes — the graph tokenizer, then the
 * per-filter option splitter (which splits on `:` AFTER the outer quotes are
 * gone). drawtext's own text-expansion pass would be a THIRD, so the filter is
 * built with `expansion=none` (we use no %{...} features), which also makes a
 * literal `%` safe. Escapes, in this exact order (empirically pixel-verified
 * against ffmpeg 6.0 and 8.0):
 *   1. literal backslashes → `\\` (one doubling per surviving unescape level)
 *   2. literal colons → `\:` (survives the option split; added AFTER (1) so its
 *      backslash is not re-doubled)
 *   3. literal single quotes → the bytes  '\\\''  — close the level-1 quote,
 *      emit `\\` + `\'` (level 1 reduces them to `\'`, level 2 to a literal,
 *      non-quoting `'`), reopen the quote. The single-level `'\''` idiom is NOT
 *      enough here: level 1 collapses it to a bare `'`, which flips level 2
 *      into quote mode and silently swallows every following option.
 */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\\\\\''");
}

/**
 * Build FFmpeg drawtext filter for caption segments.
 * Exported for other render paths (editorial pipeline) so caption burn-in and
 * its escaping stay in ONE place. Param is the structural subset actually
 * read, so callers without a full PlatformConfig can use it.
 */
export function buildCaptionFilter(
  segments: CaptionSegment[],
  config: { aspectRatio: string; targetHeight: number },
): string | null {
  if (segments.length === 0) return null;

  // Position captions in the lower third
  const fontSize = config.aspectRatio === "9:16" ? 36 : 28;
  const yPos = Math.round(config.targetHeight * 0.82);

  const parts = segments.map(seg => {
    const escapedText = escapeDrawtext(seg.text);

    return `drawtext=text='${escapedText}':expansion=none:fontsize=${fontSize}:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=${yPos}:enable='between(t,${seg.startTime},${seg.endTime})'`;
  });

  return parts.join(",");
}

/**
 * Generate a thumbnail from the middle of a clip.
 */
async function generateThumbnail(
  clipPath: string,
  outputPath: string,
  seekTime: number,
  config: PlatformConfig
): Promise<void> {
  try {
    await runFFmpeg([
      "-nostdin", "-y",
      "-ss", seekTime.toString(),
      "-i", clipPath,
      "-vframes", "1",
      "-vf", `scale=${CLIP_CONFIG.THUMBNAIL_WIDTH}:-2`,
      outputPath,
    ]);
  } catch {
    // Non-fatal — clip works without thumbnail
  }
}

/**
 * Get clip duration using ffprobe.
 */
async function getClipDuration(clipPath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      clipPath,
    ]);
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", () => {
      try {
        const info = JSON.parse(stdout);
        resolve(parseFloat(info.format.duration) || 0);
      } catch {
        resolve(0);
      }
    });
    proc.on("error", () => resolve(0));
  });
}

function runFFmpeg(args: string[], timeoutMs: number = CLIP_CONFIG.FFMPEG_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      } else {
        resolve(stderr);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}
