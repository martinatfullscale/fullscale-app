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
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { storage } from "../../storage";
import type { ClipCandidate, PlatformConfig, PLATFORM_CONFIGS } from "./clipDetector";

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
  /** Caption data if available */
  captionSegments?: CaptionSegment[];
  /** Output directory */
  outputDir: string;
  /** Remix job ID for file naming */
  jobId: number;
}

export interface ClipPlacement {
  surfaceId: number;
  brandProductId: number;
  productImagePath: string;
  /** Bounding box at clip start (normalized 0-1) */
  bboxStart: { x: number; y: number; width: number; height: number };
  /** Bounding box at clip end (normalized 0-1) — for motion interpolation */
  bboxEnd?: { x: number; y: number; width: number; height: number };
  opacity: number;
}

export interface CaptionSegment {
  text: string;
  startTime: number; // relative to clip start
  endTime: number;   // relative to clip start
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
 */
export async function generateClip(input: ClipGeneratorInput): Promise<ClipGeneratorOutput> {
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
      await generateCleanClip(videoPath, clip, platformConfig, captionsEnabled, captionSegments, clipPath);
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
  outputPath: string
): Promise<void> {
  const args = [
    "-nostdin", "-y",
    "-ss", clip.startTime.toString(),
    "-i", videoPath,
    "-t", clip.duration.toString(),
  ];

  // Build video filter chain
  const filters: string[] = [];

  // Scale + pad/crop for target aspect ratio
  const [arW, arH] = config.aspectRatio.split(":").map(Number);
  const targetAR = arW / arH;

  if (targetAR < 1) {
    // Portrait (9:16) — scale to fit width, pad vertically
    filters.push(`scale=${config.targetWidth}:-2`);
    filters.push(`pad=${config.targetWidth}:${config.targetHeight}:(ow-iw)/2:(oh-ih)/2:black`);
  } else {
    // Landscape (16:9) — scale to fit height, pad horizontally
    filters.push(`scale=-2:${config.targetHeight}`);
    filters.push(`pad=${config.targetWidth}:${config.targetHeight}:(ow-iw)/2:(oh-ih)/2:black`);
  }

  // Burn-in captions if enabled and segments provided
  if (captionsEnabled && captionSegments && captionSegments.length > 0) {
    const subtitleFilter = buildCaptionFilter(captionSegments, config);
    if (subtitleFilter) filters.push(subtitleFilter);
  }

  args.push("-vf", filters.join(","));
  args.push("-r", config.targetFps.toString());
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  args.push("-preset", CLIP_CONFIG.PRESET);
  args.push("-crf", CLIP_CONFIG.CRF.toString());
  args.push("-c:a", "aac", "-b:a", CLIP_CONFIG.AUDIO_BITRATE);
  args.push("-shortest");
  args.push("-movflags", "+faststart");
  args.push(outputPath);

  await runFFmpeg(args);
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

    // Step 2: Composite placements onto each frame
    const frames = fs.readdirSync(framesDir).filter(f => f.endsWith(".jpg")).sort();
    const totalFrames = frames.length;

    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(framesDir, frames[i]);
      const outputFrame = path.join(compositedDir, frames[i]);
      const progress = totalFrames > 1 ? i / (totalFrames - 1) : 0;

      await compositeFrameWithPlacements(framePath, outputFrame, placements, progress, platformConfig);
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
 */
async function compositeFrameWithPlacements(
  framePath: string,
  outputPath: string,
  placements: ClipPlacement[],
  progress: number,  // 0-1 through the clip
  config: PlatformConfig
): Promise<void> {
  let pipeline = sharp(framePath);

  // Resize for target platform
  const [arW, arH] = config.aspectRatio.split(":").map(Number);
  const targetAR = arW / arH;

  pipeline = pipeline.resize(config.targetWidth, config.targetHeight, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 1 },
  });

  // Composite each placement
  const composites: sharp.OverlayOptions[] = [];

  for (const placement of placements) {
    try {
      if (!fs.existsSync(placement.productImagePath)) continue;

      // Interpolate bounding box position through the clip
      const bbox = interpolateBbox(
        placement.bboxStart,
        placement.bboxEnd || placement.bboxStart,
        progress
      );

      // Convert normalized coords to pixel coords
      const px = Math.round(bbox.x * config.targetWidth);
      const py = Math.round(bbox.y * config.targetHeight);
      const pw = Math.round(bbox.width * config.targetWidth);
      const ph = Math.round(bbox.height * config.targetHeight);

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

function interpolateBbox(
  start: { x: number; y: number; width: number; height: number },
  end: { x: number; y: number; width: number; height: number },
  t: number
) {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    width: start.width + (end.width - start.width) * t,
    height: start.height + (end.height - start.height) * t,
  };
}

/**
 * Build FFmpeg drawtext filter for caption segments.
 */
function buildCaptionFilter(segments: CaptionSegment[], config: PlatformConfig): string | null {
  if (segments.length === 0) return null;

  // Position captions in the lower third
  const fontSize = config.aspectRatio === "9:16" ? 36 : 28;
  const yPos = Math.round(config.targetHeight * 0.82);

  const parts = segments.map(seg => {
    const escapedText = seg.text
      .replace(/'/g, "\\'")
      .replace(/:/g, "\\:")
      .replace(/\\/g, "\\\\");

    return `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=${yPos}:enable='between(t,${seg.startTime},${seg.endTime})'`;
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
