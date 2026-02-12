/**
 * Video Exporter — Server-side FFmpeg + Sharp pipeline
 *
 * Composites product placements onto every frame of a video, then re-encodes to MP4.
 *
 * Flow:
 * 1. Extract all frames from source video at target FPS using FFmpeg
 * 2. For each frame: interpolate bounding box positions using keyframes, then
 *    resize/rotate/position product images and composite with Sharp
 * 3. Re-encode composited frames back to MP4 with FFmpeg (copies original audio)
 * 4. Clean up temp files
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { storage } from "../storage";

// ── Types ──

interface SurfaceKeyframe {
  timestamp: number;
  bbox: { x: number; y: number; w: number; h: number }; // 0-100 percentage
  confidence?: number;
}

interface ExportPlacementData {
  surfaceType: string;
  productImageUrl: string;
  transform: {
    offsetX: number;
    offsetY: number;
    scale: number;
    rotation: number;
    flipH: boolean;
  };
  blend: {
    opacity: number;
    blendMode: string;
    shadowEnabled: boolean;
    shadowBlur: number;
    shadowOffsetX: number;
    shadowOffsetY: number;
    shadowColor: string;
    featherRadius: number;
    brightness: number;
    contrast: number;
  };
  keyframes: SurfaceKeyframe[];
}

// ── Config ──

const EXPORT_CONFIG = {
  TARGET_FPS: 24,
  JPEG_QUALITY: 92,
  CRF: 23, // H.264 quality (18=high, 23=default, 28=low)
  PRESET: "fast", // H.264 encoding speed
  FFMPEG_TIMEOUT_MS: 600000, // 10 minutes max per FFmpeg call
};

// ── Math Helpers ──

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpBBox(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  t: number
) {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    w: lerp(a.w, b.w, t),
    h: lerp(a.h, b.h, t),
  };
}

function findKeyframes(keyframes: SurfaceKeyframe[], time: number) {
  if (keyframes.length === 0) return { prev: null, next: null, progress: 0 };

  // Before first keyframe — use first
  if (time <= keyframes[0].timestamp) {
    return { prev: keyframes[0], next: null, progress: 0 };
  }

  // After last keyframe — use last
  if (time >= keyframes[keyframes.length - 1].timestamp) {
    return { prev: keyframes[keyframes.length - 1], next: null, progress: 0 };
  }

  // Between two keyframes — interpolate
  for (let i = 0; i < keyframes.length - 1; i++) {
    if (time >= keyframes[i].timestamp && time <= keyframes[i + 1].timestamp) {
      const range = keyframes[i + 1].timestamp - keyframes[i].timestamp;
      const progress = range > 0 ? (time - keyframes[i].timestamp) / range : 0;
      return { prev: keyframes[i], next: keyframes[i + 1], progress };
    }
  }

  return { prev: keyframes[keyframes.length - 1], next: null, progress: 0 };
}

// ── FFmpeg Helpers ──

function runFFmpeg(args: string[], timeoutMs: number = EXPORT_CONFIG.FFMPEG_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

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

/** Get video duration in seconds using ffprobe */
async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      videoPath,
    ]);

    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", (code) => {
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

// ── Core Export Pipeline ──

/**
 * Composite a single frame with product placements
 */
async function compositeFrame(
  framePath: string,
  placements: ExportPlacementData[],
  currentTime: number,
  productImageCache: Map<string, Buffer>,
): Promise<Buffer> {
  const frameBuffer = fs.readFileSync(framePath);
  const metadata = await sharp(frameBuffer).metadata();
  const width = metadata.width!;
  const height = metadata.height!;

  const composites: sharp.OverlayOptions[] = [];

  for (const placement of placements) {
    const { prev, next, progress } = findKeyframes(placement.keyframes, currentTime);
    if (!prev) continue;

    const bbox = next ? lerpBBox(prev.bbox, next.bbox, progress) : prev.bbox;
    const px = (bbox.x / 100) * width;
    const py = (bbox.y / 100) * height;
    const pw = (bbox.w / 100) * width;
    const ph = (bbox.h / 100) * height;

    // Get cached product image
    let productBuf = productImageCache.get(placement.productImageUrl);
    if (!productBuf) continue; // Skip if product wasn't loaded

    // Calculate scaled dimensions
    const scaledW = Math.max(1, Math.round(pw * placement.transform.scale));
    const scaledH = Math.max(1, Math.round(ph * placement.transform.scale));

    try {
      // Resize product to fit bounding box with scale
      let product = sharp(productBuf)
        .resize(scaledW, scaledH, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        });

      // Apply rotation
      if (placement.transform.rotation !== 0) {
        product = product.rotate(placement.transform.rotation, {
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        });
      }

      // Apply horizontal flip
      if (placement.transform.flipH) {
        product = product.flop();
      }

      // Apply opacity by pre-multiplying alpha
      const opacity = Math.max(0, Math.min(100, placement.blend.opacity)) / 100;
      if (opacity < 1) {
        // Extract raw pixels, multiply alpha, repack
        const { data, info } = await product
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        for (let i = 3; i < data.length; i += 4) {
          data[i] = Math.round(data[i] * opacity);
        }

        product = sharp(data, {
          raw: { width: info.width, height: info.height, channels: 4 },
        });
      }

      const productBuffer = await product.png().toBuffer();
      const productMeta = await sharp(productBuffer).metadata();
      const finalW = productMeta.width || scaledW;
      const finalH = productMeta.height || scaledH;

      // Calculate position: centered in bounding box + offset
      const centerX = Math.round(px + pw / 2 + placement.transform.offsetX);
      const centerY = Math.round(py + ph / 2 + placement.transform.offsetY);
      const left = Math.round(centerX - finalW / 2);
      const top = Math.round(centerY - finalH / 2);

      // Clamp to frame bounds
      composites.push({
        input: productBuffer,
        left: Math.max(0, Math.min(width - 1, left)),
        top: Math.max(0, Math.min(height - 1, top)),
        blend: "over" as const,
      });
    } catch (err: any) {
      console.warn(`[VideoExporter] Skipping placement ${placement.surfaceType} on frame at ${currentTime}s: ${err.message}`);
    }
  }

  if (composites.length === 0) {
    // No placements applied — return original frame
    return sharp(frameBuffer).jpeg({ quality: EXPORT_CONFIG.JPEG_QUALITY }).toBuffer();
  }

  return sharp(frameBuffer)
    .composite(composites)
    .jpeg({ quality: EXPORT_CONFIG.JPEG_QUALITY })
    .toBuffer();
}

/**
 * Main export pipeline — runs asynchronously
 */
export async function processVideoExport(
  exportId: number,
  videoPath: string,
  placements: ExportPlacementData[],
): Promise<void> {
  const tempDir = path.join("./public/exports", `export_${exportId}`);
  const framesDir = path.join(tempDir, "frames");
  const compositedDir = path.join(tempDir, "composited");

  try {
    // Update status to processing
    await storage.updateVideoExportProgress(exportId, 0);
    const exportJob = await storage.getVideoExport(exportId);
    if (!exportJob) throw new Error("Export job not found");

    // Create temp directories
    fs.mkdirSync(framesDir, { recursive: true });
    fs.mkdirSync(compositedDir, { recursive: true });

    // Resolve video path
    const absoluteVideoPath = path.resolve(videoPath);
    if (!fs.existsSync(absoluteVideoPath)) {
      throw new Error(`Video file not found: ${absoluteVideoPath}`);
    }

    // Get video duration
    const duration = await getVideoDuration(absoluteVideoPath);
    if (duration <= 0) {
      throw new Error("Could not determine video duration");
    }

    console.log(`[VideoExporter] Starting export ${exportId}: ${duration.toFixed(1)}s video, ${placements.length} placements`);

    // ── Step 1: Extract frames ──
    await storage.updateVideoExportProgress(exportId, 5);
    console.log(`[VideoExporter] Extracting frames at ${EXPORT_CONFIG.TARGET_FPS}fps...`);

    const framePattern = path.join(framesDir, "frame_%05d.jpg");
    await runFFmpeg([
      "-nostdin",
      "-y",
      "-i", absoluteVideoPath,
      "-an", // Skip audio for frame extraction
      "-vf", `fps=${EXPORT_CONFIG.TARGET_FPS}`,
      "-q:v", "2",
      "-pix_fmt", "yuvj420p",
      framePattern,
    ]);

    // Count extracted frames
    const frameFiles = fs.readdirSync(framesDir)
      .filter(f => f.startsWith("frame_") && f.endsWith(".jpg"))
      .sort();
    const totalFrames = frameFiles.length;

    if (totalFrames === 0) {
      throw new Error("No frames extracted from video");
    }

    console.log(`[VideoExporter] Extracted ${totalFrames} frames`);
    await storage.updateVideoExportProgress(exportId, 10);

    // ── Step 2: Load product images ──
    const productImageCache = new Map<string, Buffer>();
    for (const placement of placements) {
      const url = placement.productImageUrl;
      if (productImageCache.has(url)) continue;

      try {
        // Handle both local paths and URLs
        if (url.startsWith("/")) {
          // Local file — resolve relative to public directory
          const localPath = path.join("./public", url);
          if (fs.existsSync(localPath)) {
            productImageCache.set(url, fs.readFileSync(localPath));
          } else {
            console.warn(`[VideoExporter] Product image not found: ${localPath}`);
          }
        } else if (url.startsWith("http")) {
          // Remote URL — fetch it
          const response = await fetch(url);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            productImageCache.set(url, Buffer.from(arrayBuffer));
          }
        } else if (url.startsWith("data:")) {
          // Data URL — decode base64
          const base64 = url.split(",")[1];
          if (base64) {
            productImageCache.set(url, Buffer.from(base64, "base64"));
          }
        }
      } catch (err: any) {
        console.warn(`[VideoExporter] Failed to load product image ${url}: ${err.message}`);
      }
    }

    console.log(`[VideoExporter] Loaded ${productImageCache.size} product images`);

    // ── Step 3: Composite each frame ──
    const fps = EXPORT_CONFIG.TARGET_FPS;

    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(framesDir, frameFiles[i]);
      const outputPath = path.join(compositedDir, frameFiles[i]);
      const currentTime = i / fps;

      const compositedBuffer = await compositeFrame(
        framePath,
        placements,
        currentTime,
        productImageCache,
      );

      fs.writeFileSync(outputPath, compositedBuffer);

      // Update progress: 10% for extraction, 80% for compositing, 10% for encoding
      const compositeProgress = 10 + Math.round((i / totalFrames) * 80);
      if (i % Math.max(1, Math.floor(totalFrames / 20)) === 0) {
        // Update DB every ~5% to avoid hammering it
        await storage.updateVideoExportProgress(exportId, compositeProgress);
      }

      // Delete original frame to save disk space
      try { fs.unlinkSync(framePath); } catch {}
    }

    console.log(`[VideoExporter] Composited ${totalFrames} frames`);
    await storage.updateVideoExportProgress(exportId, 90);

    // ── Step 4: Re-encode to MP4 ──
    const outputFilename = `export_${exportId}.mp4`;
    const outputMp4 = path.join("./public/exports", outputFilename);

    // Ensure exports directory exists
    fs.mkdirSync("./public/exports", { recursive: true });

    const compositedPattern = path.join(compositedDir, "frame_%05d.jpg");
    const encodeArgs = [
      "-nostdin",
      "-y",
      "-framerate", fps.toString(),
      "-i", compositedPattern,
      "-i", absoluteVideoPath, // Source for audio
      "-map", "0:v", // Use composited frames for video
      "-map", "1:a?", // Use original audio (? = optional, don't fail if no audio)
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", EXPORT_CONFIG.PRESET,
      "-crf", EXPORT_CONFIG.CRF.toString(),
      "-c:a", "aac", // Re-encode audio to AAC for compatibility
      "-shortest", // End when shortest stream ends
      "-movflags", "+faststart", // Web-optimized MP4
      outputMp4,
    ];

    console.log(`[VideoExporter] Encoding MP4...`);
    await runFFmpeg(encodeArgs);

    // Verify output exists and has size
    if (!fs.existsSync(outputMp4)) {
      throw new Error("FFmpeg encoding produced no output file");
    }
    const stats = fs.statSync(outputMp4);
    if (stats.size < 1000) {
      throw new Error(`Output file suspiciously small: ${stats.size} bytes`);
    }

    console.log(`[VideoExporter] Export complete: ${outputMp4} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);

    // ── Step 5: Update export job ──
    const outputUrl = `/exports/${outputFilename}`;
    await storage.updateVideoExportComplete(exportId, outputMp4, outputUrl);

    // ── Step 6: Cleanup temp directories ──
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupErr: any) {
      console.warn(`[VideoExporter] Cleanup warning: ${cleanupErr.message}`);
    }

  } catch (err: any) {
    console.error(`[VideoExporter] Export ${exportId} failed:`, err.message);
    await storage.updateVideoExportFailed(exportId, err.message);

    // Cleanup on failure too
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}
