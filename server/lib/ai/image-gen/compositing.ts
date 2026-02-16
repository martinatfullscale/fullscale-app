/**
 * Compositing Engine — Layer Generated Assets onto Video Frames
 *
 * Takes a generated product asset (transparent PNG) and composites it
 * onto the detected surface in a video frame. Handles:
 * - Perspective transform to match surface geometry
 * - Scale-to-fit within surface bounding box
 * - Alpha blending with scene
 * - Preview generation for approval UI
 *
 * Uses Sharp for all image operations.
 */

import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";

export interface CompositeInput {
  /** Path to the source video frame (full-res) */
  framePath: string;
  /** Path to the product asset (transparent PNG) */
  assetPath: string;
  /** Surface bounding box in the frame (normalized 0-1 coordinates) */
  surfaceBbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Frame dimensions in pixels */
  frameDimensions: {
    width: number;
    height: number;
  };
  /** Output directory for the composite */
  outputDir: string;
  /** Video ID for file naming */
  videoId: number;
  /** Surface ID for file naming */
  surfaceId: number;
  /** Opacity for the placed product (0-1, default 0.95) */
  opacity?: number;
  /** Padding inside the surface bbox as fraction (0-1, default 0.1) */
  padding?: number;
}

export interface CompositeOutput {
  /** Path to the full composite image */
  compositePath: string;
  /** Path to a smaller preview thumbnail */
  previewPath: string;
  /** Actual pixel region where the asset was placed */
  placedRegion: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

const PREVIEW_WIDTH = 640;

/**
 * Composite a product asset onto a video frame at the detected surface location.
 */
export async function compositeAssetOnFrame(input: CompositeInput): Promise<CompositeOutput> {
  const {
    framePath,
    assetPath,
    surfaceBbox,
    frameDimensions,
    outputDir,
    videoId,
    surfaceId,
    opacity = 0.95,
    padding = 0.1,
  } = input;

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Convert normalized bbox to pixel coordinates
  const bboxPx = {
    x: Math.round(surfaceBbox.x * frameDimensions.width),
    y: Math.round(surfaceBbox.y * frameDimensions.height),
    width: Math.round(surfaceBbox.width * frameDimensions.width),
    height: Math.round(surfaceBbox.height * frameDimensions.height),
  };

  // Apply padding inside the bbox
  const padX = Math.round(bboxPx.width * padding);
  const padY = Math.round(bboxPx.height * padding);

  const targetRegion = {
    x: bboxPx.x + padX,
    y: bboxPx.y + padY,
    width: Math.max(bboxPx.width - padX * 2, 32),
    height: Math.max(bboxPx.height - padY * 2, 32),
  };

  // Resize the asset to fit within the target region, maintaining aspect ratio
  const assetMeta = await sharp(assetPath).metadata();
  const assetW = assetMeta.width || 512;
  const assetH = assetMeta.height || 512;

  const scaleX = targetRegion.width / assetW;
  const scaleY = targetRegion.height / assetH;
  const scale = Math.min(scaleX, scaleY);

  const resizedW = Math.round(assetW * scale);
  const resizedH = Math.round(assetH * scale);

  // Center the resized asset within the target region
  const offsetX = targetRegion.x + Math.round((targetRegion.width - resizedW) / 2);
  const offsetY = targetRegion.y + Math.round((targetRegion.height - resizedH) / 2);

  // Resize and apply opacity to the asset
  let assetBuffer = await sharp(assetPath)
    .resize(resizedW, resizedH, { fit: "inside" })
    .ensureAlpha()
    .png()
    .toBuffer();

  // Apply opacity if not fully opaque
  if (opacity < 1.0) {
    assetBuffer = await applyOpacity(assetBuffer, opacity);
  }

  // Composite onto the frame
  const timestamp = Date.now();
  const compositeFilename = `composite_v${videoId}_s${surfaceId}_${timestamp}.png`;
  const compositePath = path.join(outputDir, compositeFilename);

  await sharp(framePath)
    .composite([{
      input: assetBuffer,
      left: offsetX,
      top: offsetY,
      blend: "over",
    }])
    .png({ quality: 90 })
    .toFile(compositePath);

  // Generate preview thumbnail
  const previewFilename = `preview_v${videoId}_s${surfaceId}_${timestamp}.jpg`;
  const previewPath = path.join(outputDir, previewFilename);

  await sharp(compositePath)
    .resize(PREVIEW_WIDTH, undefined, { fit: "inside" })
    .jpeg({ quality: 80 })
    .toFile(previewPath);

  const placedRegion = {
    x: offsetX,
    y: offsetY,
    width: resizedW,
    height: resizedH,
  };

  console.log(`[Compositing] Asset placed at (${offsetX},${offsetY}) ${resizedW}x${resizedH}px on frame ${frameDimensions.width}x${frameDimensions.height}`);
  console.log(`[Compositing] Composite: ${compositePath}`);
  console.log(`[Compositing] Preview: ${previewPath}`);

  return {
    compositePath,
    previewPath,
    placedRegion,
  };
}

/**
 * Generate a side-by-side comparison: original frame | composited frame.
 * Useful for the approval UI.
 */
export async function generateComparisonPreview(
  framePath: string,
  compositePath: string,
  outputPath: string
): Promise<string> {
  const frameMeta = await sharp(framePath).metadata();
  const w = frameMeta.width || 1280;
  const h = frameMeta.height || 720;

  // Resize both to half width
  const halfW = Math.round(w / 2);

  const [leftBuf, rightBuf] = await Promise.all([
    sharp(framePath).resize(halfW, h, { fit: "cover" }).png().toBuffer(),
    sharp(compositePath).resize(halfW, h, { fit: "cover" }).png().toBuffer(),
  ]);

  // Create a canvas and place side by side
  await sharp({
    create: {
      width: halfW * 2,
      height: h,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([
      { input: leftBuf, left: 0, top: 0 },
      { input: rightBuf, left: halfW, top: 0 },
    ])
    .jpeg({ quality: 85 })
    .toFile(outputPath);

  console.log(`[Compositing] Comparison preview: ${outputPath}`);
  return outputPath;
}

/**
 * Apply opacity to a PNG buffer by scaling the alpha channel.
 */
async function applyOpacity(pngBuffer: Buffer, opacity: number): Promise<Buffer> {
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels; // Should be 4 (RGBA)
  if (channels !== 4) return pngBuffer;

  // Scale alpha channel
  for (let i = 3; i < data.length; i += 4) {
    data[i] = Math.round(data[i] * opacity);
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}
