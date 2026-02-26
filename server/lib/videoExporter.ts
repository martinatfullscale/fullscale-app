/**
 * Video Exporter — Server-side FFmpeg + Sharp pipeline
 *
 * Composites product placements onto every frame of a video, then re-encodes to MP4.
 * Matches the client-side RemixEngine preview as closely as possible.
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
import { uploadFileToStorage, downloadToTempFile } from "./objectStorage";

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
  productAspectRatio?: number; // sent from client for accurate sizing
  motionTrackData?: {
    transforms: Array<{ x: number; y: number; w: number; h: number } | null>;
    fps: number;
    duration: number;
  } | null;
}

interface ExportContext {
  canvasWidth: number;
  canvasHeight: number;
}

// ── Config ──

const EXPORT_CONFIG = {
  TARGET_FPS: 24,
  JPEG_QUALITY: 92,
  CRF: 23, // H.264 quality (18=high, 23=default, 28=low)
  PRESET: "fast", // H.264 encoding speed
  FFMPEG_TIMEOUT_MS: 600000, // 10 minutes max per FFmpeg call
};

// Scene-change detection: if gap between keyframes > this, surface is not visible
const GAP_THRESHOLD_SECONDS = 2.0;
const CONFIDENCE_FADE_THRESHOLD = 0.3;

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

interface FindKeyframesResult {
  prev: SurfaceKeyframe;
  next: SurfaceKeyframe | null;
  progress: number;
  opacity: number; // 0-1, factors in gap proximity and confidence
}

function getConfidenceOpacity(confidence: number | undefined): number {
  if (confidence === undefined || confidence === null) return 1;
  if (confidence >= CONFIDENCE_FADE_THRESHOLD) return 1;
  return Math.max(0, confidence / CONFIDENCE_FADE_THRESHOLD);
}

function findKeyframes(keyframes: SurfaceKeyframe[], time: number): FindKeyframesResult | null {
  if (keyframes.length === 0) return null;

  const firstKf = keyframes[0];
  const lastKf = keyframes[keyframes.length - 1];

  // Before first keyframe — check if within threshold
  if (time < firstKf.timestamp - GAP_THRESHOLD_SECONDS) return null; // Surface not yet visible
  if (time <= firstKf.timestamp) {
    const dist = firstKf.timestamp - time;
    const fadeIn = 1 - (dist / GAP_THRESHOLD_SECONDS);
    return { prev: firstKf, next: null, progress: 0, opacity: fadeIn * getConfidenceOpacity((firstKf as any).confidence) };
  }

  // After last keyframe — check if within threshold
  if (time > lastKf.timestamp + GAP_THRESHOLD_SECONDS) return null; // Surface gone (scene cut)
  if (time >= lastKf.timestamp) {
    const dist = time - lastKf.timestamp;
    const fadeOut = 1 - (dist / GAP_THRESHOLD_SECONDS);
    return { prev: lastKf, next: null, progress: 0, opacity: fadeOut * getConfidenceOpacity((lastKf as any).confidence) };
  }

  // Between two keyframes — check for large gaps (scene cuts)
  for (let i = 0; i < keyframes.length - 1; i++) {
    if (time >= keyframes[i].timestamp && time <= keyframes[i + 1].timestamp) {
      const gap = keyframes[i + 1].timestamp - keyframes[i].timestamp;

      // Large gap = scene cut. Fade out near prev, fade in near next, null in middle.
      if (gap > GAP_THRESHOLD_SECONDS * 2) {
        const midpoint = keyframes[i].timestamp + gap / 2;
        if (time < midpoint) {
          const distFromPrev = time - keyframes[i].timestamp;
          if (distFromPrev > GAP_THRESHOLD_SECONDS) return null;
          const fadeOut = 1 - (distFromPrev / GAP_THRESHOLD_SECONDS);
          return { prev: keyframes[i], next: null, progress: 0, opacity: fadeOut * getConfidenceOpacity((keyframes[i] as any).confidence) };
        } else {
          const distFromNext = keyframes[i + 1].timestamp - time;
          if (distFromNext > GAP_THRESHOLD_SECONDS) return null;
          const fadeIn = 1 - (distFromNext / GAP_THRESHOLD_SECONDS);
          return { prev: keyframes[i + 1], next: null, progress: 0, opacity: fadeIn * getConfidenceOpacity((keyframes[i + 1] as any).confidence) };
        }
      }

      const range = gap;
      const progress = range > 0 ? (time - keyframes[i].timestamp) / range : 0;
      const prevConf = (keyframes[i] as any).confidence ?? 1;
      const nextConf = (keyframes[i + 1] as any).confidence ?? 1;
      const interpConf = prevConf + (nextConf - prevConf) * progress;
      return { prev: keyframes[i], next: keyframes[i + 1], progress, opacity: getConfidenceOpacity(interpConf) };
    }
  }

  return null;
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
 * Composite a single frame with product placements.
 * Matches the client-side RemixEngine drawProduct() logic:
 * - Aspect-ratio fitting (contain within bbox)
 * - Offset scaling from preview canvas → full resolution
 * - Brightness/contrast via Sharp modulate/linear
 * - Opacity via alpha channel manipulation
 * - Rotation and horizontal flip
 */
async function compositeFrame(
  framePath: string,
  placements: ExportPlacementData[],
  currentTime: number,
  productImageCache: Map<string, { buffer: Buffer; width: number; height: number }>,
  exportCtx: ExportContext,
): Promise<Buffer> {
  const frameBuffer = fs.readFileSync(framePath);
  const metadata = await sharp(frameBuffer).metadata();
  const width = metadata.width!;
  const height = metadata.height!;

  // Scale ratio: how much bigger is the export frame vs the preview canvas
  const scaleX = width / exportCtx.canvasWidth;
  const scaleY = height / exportCtx.canvasHeight;

  const composites: sharp.OverlayOptions[] = [];

  for (const placement of placements) {
    // ── FAST PATH: Pre-computed motion-track data from preview ──
    // When the client sends motionTrackData, use it DIRECTLY so export matches preview exactly.
    // This skips the separate dense-scan + stabilization pipeline that caused position mismatch.
    if (placement.motionTrackData?.transforms?.length) {
      const mtd = placement.motionTrackData;
      const frameIndex = Math.min(
        Math.round(currentTime * mtd.fps),
        mtd.transforms.length - 1
      );
      const pos = mtd.transforms[Math.max(0, frameIndex)];

      // Null position = surface not visible (scene cut)
      if (!pos) continue;

      // Convert 0-1 normalized coords to pixel coords
      const px = pos.x * width;
      const py = pos.y * height;
      const pw = pos.w * width;
      const ph = pos.h * height;

      // Get cached product image with dimensions
      const productInfo = productImageCache.get(placement.productImageUrl);
      if (!productInfo) continue;

      // Match client-side aspect-ratio fitting
      const prodAspect = placement.productAspectRatio || (productInfo.width / productInfo.height);
      const boxAspect = pw / ph;

      let drawWidth: number, drawHeight: number;
      if (prodAspect > boxAspect) {
        drawWidth = pw * placement.transform.scale;
        drawHeight = (pw / prodAspect) * placement.transform.scale;
      } else {
        drawHeight = ph * placement.transform.scale;
        drawWidth = (ph * prodAspect) * placement.transform.scale;
      }

      const scaledW = Math.max(1, Math.round(drawWidth));
      const scaledH = Math.max(1, Math.round(drawHeight));

      try {
        let product = sharp(productInfo.buffer)
          .resize(scaledW, scaledH, {
            fit: "fill",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          });

        // Apply brightness/contrast
        if (placement.blend.brightness !== 0 || placement.blend.contrast !== 0) {
          const brightnessFactor = (100 + placement.blend.brightness) / 100;
          const contrastFactor = (100 + placement.blend.contrast) / 100;
          const a = contrastFactor * brightnessFactor;
          const b = 128 * (1 - contrastFactor) * brightnessFactor;
          product = product.linear(a, b);
        }

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

        // Apply opacity
        const blendOpacity = Math.max(0, Math.min(100, placement.blend.opacity)) / 100;
        if (blendOpacity <= 0.01) continue;
        if (blendOpacity < 1) {
          const { data, info } = await product
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          for (let i = 3; i < data.length; i += 4) {
            data[i] = Math.round(data[i] * blendOpacity);
          }
          product = sharp(data, {
            raw: { width: info.width, height: info.height, channels: 4 },
          });
        }

        const productBuffer = await product.ensureAlpha().png().toBuffer();
        const productMeta = await sharp(productBuffer).metadata();
        const finalW = productMeta.width || scaledW;
        const finalH = productMeta.height || scaledH;

        // Center position: scale offsets from preview canvas to export resolution
        const centerX = Math.round(px + pw / 2 + placement.transform.offsetX * scaleX);
        const centerY = Math.round(py + ph / 2 + placement.transform.offsetY * scaleY);
        const left = Math.round(centerX - finalW / 2);
        const top = Math.round(centerY - finalH / 2);

        composites.push({
          input: productBuffer,
          left: Math.max(0, Math.min(width - 1, left)),
          top: Math.max(0, Math.min(height - 1, top)),
          blend: "over" as const,
        });
      } catch (err: any) {
        console.warn(`[VideoExporter] Motion-track fast-path skip ${placement.surfaceType} at ${currentTime}s: ${err.message}`);
      }

      continue; // Skip the stabilization pipeline below
    }

    // ── Anchor-Lock Stabilization Pipeline (matches client-side preview) ──
    // Step 1: Lock dimensions to median across all keyframes
    const allWidths = placement.keyframes.map(k => k.bbox.w).sort((a, b) => a - b);
    const allHeights = placement.keyframes.map(k => k.bbox.h).sort((a, b) => a - b);
    const lockedW = allWidths[Math.floor(allWidths.length / 2)] || placement.keyframes[0]?.bbox.w || 10;
    const lockedH = allHeights[Math.floor(allHeights.length / 2)] || placement.keyframes[0]?.bbox.h || 10;

    // Step 2: Anchor persistence — pin to top-right corner of first keyframe
    // This prevents the product from drifting to a different surface region
    const anchorKf = placement.keyframes[0];
    const anchorTRX = anchorKf.bbox.x + anchorKf.bbox.w; // top-right X
    const anchorTRY = anchorKf.bbox.y;                     // top-right Y

    // Step 3: Stabilize keyframe positions (constrain drift from anchor)
    const stabilizedKfs = placement.keyframes.map(kf => {
      const trX = kf.bbox.x + kf.bbox.w;
      const trY = kf.bbox.y;
      const driftX = Math.abs(trX - anchorTRX);
      const driftY = Math.abs(trY - anchorTRY);
      let stableX = kf.bbox.x;
      let stableY = kf.bbox.y;
      // Constrain top-right drift to 2% max (tight lock to prevent jitter)
      if (driftX > 2) stableX = anchorTRX - lockedW + Math.sign(trX - anchorTRX) * 2;
      if (driftY > 2) stableY = anchorTRY + Math.sign(trY - anchorTRY) * 2;
      return { ...kf, bbox: { ...kf.bbox, x: stableX, y: stableY, w: lockedW, h: lockedH } };
    });

    // Step 4: Bidirectional EMA smoothing (same as server motion-track pipeline)
    let smoothedKfs = stabilizedKfs;
    if (stabilizedKfs.length >= 3) {
      const ema = 0.15;
      const fwdKfs = [{ ...stabilizedKfs[0] }];
      for (let si = 1; si < stabilizedKfs.length; si++) {
        fwdKfs.push({
          ...stabilizedKfs[si],
          bbox: {
            x: ema * stabilizedKfs[si].bbox.x + (1 - ema) * fwdKfs[si - 1].bbox.x,
            y: ema * stabilizedKfs[si].bbox.y + (1 - ema) * fwdKfs[si - 1].bbox.y,
            w: lockedW,
            h: lockedH,
          },
        });
      }
      const bwdKfs = new Array(fwdKfs.length);
      bwdKfs[fwdKfs.length - 1] = { ...fwdKfs[fwdKfs.length - 1] };
      for (let si = fwdKfs.length - 2; si >= 0; si--) {
        bwdKfs[si] = {
          ...fwdKfs[si],
          bbox: {
            x: ema * fwdKfs[si].bbox.x + (1 - ema) * bwdKfs[si + 1].bbox.x,
            y: ema * fwdKfs[si].bbox.y + (1 - ema) * bwdKfs[si + 1].bbox.y,
            w: lockedW,
            h: lockedH,
          },
        };
      }
      smoothedKfs = fwdKfs.map((f, si) => ({
        ...f,
        bbox: {
          x: (f.bbox.x + bwdKfs[si].bbox.x) / 2,
          y: (f.bbox.y + bwdKfs[si].bbox.y) / 2,
          w: lockedW,
          h: lockedH,
        },
      }));
    }

    // Step 5: Interpolate position using stabilized keyframes (with scene-change detection)
    const kfResult = findKeyframes(smoothedKfs, currentTime);
    if (!kfResult) continue; // Surface not visible at this time (scene cut or out of range)
    const { prev, next, progress, opacity: kfOpacity } = kfResult;

    // Anchor-lock: track top-right corner, derive position from there
    let topRightX: number, topRightY: number;
    if (next) {
      const prevTRX = prev.bbox.x + prev.bbox.w;
      const prevTRY = prev.bbox.y;
      const nextTRX = next.bbox.x + next.bbox.w;
      const nextTRY = next.bbox.y;
      topRightX = lerp(prevTRX, nextTRX, progress);
      topRightY = lerp(prevTRY, nextTRY, progress);
    } else {
      topRightX = prev.bbox.x + prev.bbox.w;
      topRightY = prev.bbox.y;
    }

    // Derive top-left from anchor and locked dimensions
    const px = ((topRightX - lockedW) / 100) * width;
    const py = (topRightY / 100) * height;
    const pw = (lockedW / 100) * width;
    const ph = (lockedH / 100) * height;

    // Get cached product image with dimensions
    const productInfo = productImageCache.get(placement.productImageUrl);
    if (!productInfo) continue;

    // Match client-side aspect-ratio fitting logic from drawProduct():
    // If product aspect > box aspect: fit to width, else fit to height
    const prodAspect = placement.productAspectRatio || (productInfo.width / productInfo.height);
    const boxAspect = pw / ph;

    let drawWidth: number, drawHeight: number;
    if (prodAspect > boxAspect) {
      drawWidth = pw * placement.transform.scale;
      drawHeight = (pw / prodAspect) * placement.transform.scale;
    } else {
      drawHeight = ph * placement.transform.scale;
      drawWidth = (ph * prodAspect) * placement.transform.scale;
    }

    const scaledW = Math.max(1, Math.round(drawWidth));
    const scaledH = Math.max(1, Math.round(drawHeight));

    try {
      // Resize product to match client-side sizing
      let product = sharp(productInfo.buffer)
        .resize(scaledW, scaledH, {
          fit: "fill", // "fill" to exactly match computed dimensions (aspect already handled above)
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        });

      // Apply brightness/contrast to match client-side CSS filter
      // Client uses: brightness(${100 + val}%) contrast(${100 + val}%)
      // Sharp equivalent: modulate for brightness, linear for contrast
      if (placement.blend.brightness !== 0 || placement.blend.contrast !== 0) {
        const brightnessFactor = (100 + placement.blend.brightness) / 100; // e.g., brightness 20 → 1.2
        const contrastFactor = (100 + placement.blend.contrast) / 100;
        // Apply via linear: output = input * a + b
        // For brightness: multiply all channels
        // For contrast: multiply deviation from mid-gray
        // Combined: a = contrastFactor * brightnessFactor, b = 128 * (1 - contrastFactor) * brightnessFactor
        const a = contrastFactor * brightnessFactor;
        const b = 128 * (1 - contrastFactor) * brightnessFactor;
        product = product.linear(a, b);
      }

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

      // Apply opacity by pre-multiplying alpha channel
      // kfOpacity accounts for scene-change fade in/out and confidence
      const blendOpacity = Math.max(0, Math.min(100, placement.blend.opacity)) / 100;
      const opacity = blendOpacity * kfOpacity;
      if (opacity <= 0.01) continue; // Nearly invisible — skip entirely
      if (opacity < 1) {
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

      // Apply shadow: render product on a slightly larger canvas with blur behind it
      let productBuffer: Buffer;
      if (placement.blend.shadowEnabled && placement.blend.shadowBlur > 0) {
        // Scale shadow params to match export resolution
        const sBlur = Math.round(placement.blend.shadowBlur * scaleX);
        const sOffX = Math.round(placement.blend.shadowOffsetX * scaleX);
        const sOffY = Math.round(placement.blend.shadowOffsetY * scaleX);

        // Get the product PNG first
        const prodPng = await product.ensureAlpha().png().toBuffer();
        const prodMeta = await sharp(prodPng).metadata();
        const pW = prodMeta.width || scaledW;
        const pH = prodMeta.height || scaledH;

        // Create a larger canvas to hold both shadow and product
        const padding = sBlur * 2 + Math.abs(sOffX) + Math.abs(sOffY);
        const canvasW = pW + padding * 2;
        const canvasH = pH + padding * 2;

        // Parse shadow color (e.g. "rgba(0,0,0,0.3)" or "#000000")
        let shadowR = 0, shadowG = 0, shadowB = 0, shadowA = 0.3;
        const rgbaMatch = placement.blend.shadowColor?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (rgbaMatch) {
          shadowR = parseInt(rgbaMatch[1]);
          shadowG = parseInt(rgbaMatch[2]);
          shadowB = parseInt(rgbaMatch[3]);
          shadowA = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
        }

        // Create shadow: take product alpha as shape, fill with shadow color, blur it
        const shadowBase = await sharp(prodPng)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        // Replace RGB with shadow color, keep alpha
        for (let i = 0; i < shadowBase.data.length; i += 4) {
          shadowBase.data[i] = shadowR;
          shadowBase.data[i + 1] = shadowG;
          shadowBase.data[i + 2] = shadowB;
          shadowBase.data[i + 3] = Math.round(shadowBase.data[i + 3] * shadowA);
        }

        const shadowPng = await sharp(shadowBase.data, {
          raw: { width: shadowBase.info.width, height: shadowBase.info.height, channels: 4 },
        })
          .blur(Math.max(0.3, sBlur))
          .png()
          .toBuffer();

        // Composite shadow + product onto transparent canvas
        const shadowLeft = padding + sOffX;
        const shadowTop = padding + sOffY;
        const productLeft = padding;
        const productTop = padding;

        productBuffer = await sharp({
          create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        })
          .composite([
            { input: shadowPng, left: Math.max(0, shadowLeft), top: Math.max(0, shadowTop) },
            { input: prodPng, left: productLeft, top: productTop },
          ])
          .png()
          .toBuffer();

        // Adjust position to account for the padding
        const productMeta = await sharp(productBuffer).metadata();
        const finalW = productMeta.width || canvasW;
        const finalH = productMeta.height || canvasH;

        // Center position: scale offsets from preview canvas to export resolution
        const centerX = Math.round(px + pw / 2 + placement.transform.offsetX * scaleX);
        const centerY = Math.round(py + ph / 2 + placement.transform.offsetY * scaleY);
        const left = Math.round(centerX - finalW / 2);
        const top = Math.round(centerY - finalH / 2);

        composites.push({
          input: productBuffer,
          left: Math.max(0, Math.min(width - 1, left)),
          top: Math.max(0, Math.min(height - 1, top)),
          blend: "over" as const,
        });
      } else {
        // No shadow — simpler path
        productBuffer = await product.ensureAlpha().png().toBuffer();
        const productMeta = await sharp(productBuffer).metadata();
        const finalW = productMeta.width || scaledW;
        const finalH = productMeta.height || scaledH;

        // Center position: scale offsets from preview canvas to export resolution
        const centerX = Math.round(px + pw / 2 + placement.transform.offsetX * scaleX);
        const centerY = Math.round(py + ph / 2 + placement.transform.offsetY * scaleY);
        const left = Math.round(centerX - finalW / 2);
        const top = Math.round(centerY - finalH / 2);

        composites.push({
          input: productBuffer,
          left: Math.max(0, Math.min(width - 1, left)),
          top: Math.max(0, Math.min(height - 1, top)),
          blend: "over" as const,
        });
      }
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
  exportCtx: ExportContext = { canvasWidth: 640, canvasHeight: 360 },
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

    let absoluteVideoPath: string;
    let tempVideoFile: string | null = null;

    if (videoPath.startsWith('/storage/')) {
      const objectKey = videoPath.replace(/^\/storage\//, 'public/');
      tempVideoFile = await downloadToTempFile(objectKey, tempDir);
      absoluteVideoPath = tempVideoFile;
      console.log(`[VideoExporter] Downloaded from Object Storage: ${absoluteVideoPath}`);
    } else {
      absoluteVideoPath = path.resolve(videoPath);
      if (!fs.existsSync(absoluteVideoPath)) {
        throw new Error(`Video file not found: ${absoluteVideoPath}`);
      }
    }

    // Get video duration
    const duration = await getVideoDuration(absoluteVideoPath);
    if (duration <= 0) {
      throw new Error("Could not determine video duration");
    }

    console.log(`[VideoExporter] Starting export ${exportId}: ${duration.toFixed(1)}s video, ${placements.length} placements`);
    console.log(`[VideoExporter] Preview canvas: ${exportCtx.canvasWidth}×${exportCtx.canvasHeight}`);

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

    // ── Step 2: Load product images (with dimensions for aspect ratio) ──
    const productImageCache = new Map<string, { buffer: Buffer; width: number; height: number }>();
    for (const placement of placements) {
      const url = placement.productImageUrl;
      if (productImageCache.has(url)) continue;

      try {
        let imageBuffer: Buffer | null = null;

        // Handle Object Storage URLs (/storage/...), local paths, HTTP URLs, and data URIs
        if (url.startsWith("/storage/")) {
          // Replit Object Storage — convert /storage/... to public/... key and download
          const objectKey = url.replace(/^\/storage\//, "public/");
          console.log(`[VideoExporter] Loading product from Object Storage: ${objectKey}`);
          try {
            const { fileExistsInStorage, getStorageStream } = await import("./objectStorage");
            if (await fileExistsInStorage(objectKey)) {
              const { file } = getStorageStream(objectKey);
              const [downloadBuffer] = await file.download();
              imageBuffer = downloadBuffer;
            } else {
              console.warn(`[VideoExporter] Product image not in Object Storage: ${objectKey}`);
            }
          } catch (storageErr: any) {
            console.warn(`[VideoExporter] Object Storage download failed for product: ${storageErr.message}`);
          }
        } else if (url.startsWith("/")) {
          const localPath = path.join("./public", url);
          if (fs.existsSync(localPath)) {
            imageBuffer = fs.readFileSync(localPath);
          } else {
            console.warn(`[VideoExporter] Product image not found locally: ${localPath}`);
          }
        } else if (url.startsWith("http")) {
          const response = await fetch(url);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            imageBuffer = Buffer.from(arrayBuffer);
          }
        } else if (url.startsWith("data:")) {
          const base64 = url.split(",")[1];
          if (base64) {
            imageBuffer = Buffer.from(base64, "base64");
          }
        }

        if (imageBuffer) {
          const meta = await sharp(imageBuffer).metadata();
          productImageCache.set(url, {
            buffer: imageBuffer,
            width: meta.width || 100,
            height: meta.height || 100,
          });
          console.log(`[VideoExporter] Loaded product image (${meta.width}x${meta.height}) from: ${url.substring(0, 80)}...`);
        } else {
          console.warn(`[VideoExporter] ⚠️ Product image buffer is null for URL: ${url.substring(0, 80)}...`);
        }
      } catch (err: any) {
        console.warn(`[VideoExporter] Failed to load product image ${url.substring(0, 80)}: ${err.message}`);
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
        exportCtx,
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

    console.log(`[VideoExporter] Encoding complete: ${outputMp4} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);

    const objectKey = `public/exports/${outputFilename}`;
    const storageUrl = await uploadFileToStorage(outputMp4, objectKey);
    console.log(`[VideoExporter] Uploaded to Object Storage: ${storageUrl}`);

    await storage.updateVideoExportComplete(exportId, storageUrl, storageUrl);

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
