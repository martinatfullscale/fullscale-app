/**
 * Style Transfer — Post-Generation Aesthetic Matching
 *
 * After Seeddance 2.0 generates a product asset, this module adjusts
 * the image to match the target video frame's visual characteristics:
 * - Color temperature (warm/cool shift)
 * - Brightness/contrast alignment
 * - Shadow direction matching
 *
 * Uses Sharp for all image manipulation — no external API calls.
 */

import sharp from "sharp";

export interface StyleTransferInput {
  /** Path to the generated product asset (PNG with transparency) */
  assetPath: string;
  /** Scene aesthetic to match */
  sceneAesthetic: {
    colorWarmth: number; // negative = cool, positive = warm
    brightness: { overall: number; top: number; bottom: number };
    dominantColors: string[];
  };
  /** Surface lighting for shadow/highlight direction */
  lightingDirection: string; // e.g., "top-left", "top-right", "ambient"
}

export interface StyleTransferOutput {
  /** Path to the style-matched asset */
  outputPath: string;
  /** Adjustments applied */
  adjustments: {
    brightnessShift: number;
    warmthShift: number;
    contrastMultiplier: number;
  };
}

/**
 * Apply style transfer to match generated asset to scene aesthetic.
 * Overwrites the asset in-place and returns the adjustments made.
 */
export async function applyStyleTransfer(input: StyleTransferInput): Promise<StyleTransferOutput> {
  const { assetPath, sceneAesthetic, lightingDirection } = input;

  // Calculate brightness adjustment
  // Target scene brightness 0-255, normalize to a -50..+50 shift
  const targetBrightness = sceneAesthetic.brightness.overall;
  const brightnessShift = Math.round((targetBrightness - 128) * 0.25);

  // Calculate warmth adjustment via color temperature tinting
  // colorWarmth: negative = cool (blue tint), positive = warm (orange tint)
  const warmthShift = Math.round(sceneAesthetic.colorWarmth * 0.4);

  // Contrast: brighter scenes tend to be higher contrast
  const contrastMultiplier = targetBrightness > 160 ? 1.1 :
    targetBrightness < 80 ? 0.9 : 1.0;

  // Build Sharp pipeline
  let pipeline = sharp(assetPath).ensureAlpha();

  // Brightness + contrast via modulate and linear
  if (brightnessShift !== 0 || contrastMultiplier !== 1.0) {
    pipeline = pipeline.modulate({
      brightness: 1 + (brightnessShift / 100),
    }).linear(
      contrastMultiplier,
      Math.round(128 * (1 - contrastMultiplier)) // offset to keep midpoint
    );
  }

  // Color temperature — warm shifts red/yellow, cool shifts blue
  if (Math.abs(warmthShift) > 5) {
    const isWarm = warmthShift > 0;
    const intensity = Math.min(Math.abs(warmthShift), 40);

    // Apply a subtle tint via recomb matrix
    const tintStrength = intensity / 200; // 0.0 - 0.2 range
    const r = isWarm ? 1 + tintStrength : 1 - (tintStrength * 0.5);
    const g = 1.0;
    const b = isWarm ? 1 - (tintStrength * 0.5) : 1 + tintStrength;

    pipeline = pipeline.recomb([
      [r, 0, 0],
      [0, g, 0],
      [0, 0, b],
    ]);
  }

  // Apply subtle shadow based on lighting direction
  // For compositing realism — add a very mild vignette on the shadow side
  if (lightingDirection && lightingDirection !== "ambient") {
    const metadata = await sharp(assetPath).metadata();
    const w = metadata.width || 512;
    const h = metadata.height || 512;

    // Create a gradient overlay for shadow simulation
    const shadowOverlay = await createShadowOverlay(w, h, lightingDirection);
    if (shadowOverlay) {
      pipeline = pipeline.composite([{
        input: shadowOverlay,
        blend: "multiply",
      }]);
    }
  }

  // Write the result back to the same path
  const buffer = await pipeline.png().toBuffer();
  await sharp(buffer).toFile(assetPath);

  console.log(`[StyleTransfer] Applied: brightness=${brightnessShift}, warmth=${warmthShift}, contrast=${contrastMultiplier.toFixed(2)} → ${assetPath}`);

  return {
    outputPath: assetPath,
    adjustments: {
      brightnessShift,
      warmthShift,
      contrastMultiplier,
    },
  };
}

/**
 * Create a subtle shadow gradient overlay based on lighting direction.
 * Returns a semi-transparent PNG buffer, or null if direction is not mappable.
 */
async function createShadowOverlay(
  width: number,
  height: number,
  direction: string
): Promise<Buffer | null> {
  // Determine shadow opacity gradient based on light direction
  // Light from top-left → shadow on bottom-right, etc.
  let gradientAngle: "left" | "right" | "top" | "bottom";

  if (direction.includes("left")) {
    gradientAngle = "right"; // shadow falls on opposite side
  } else if (direction.includes("right")) {
    gradientAngle = "left";
  } else if (direction.includes("top")) {
    gradientAngle = "bottom";
  } else if (direction.includes("bottom")) {
    gradientAngle = "top";
  } else {
    return null;
  }

  // Create a subtle gradient: 95% opaque white → 85% opaque white
  // This creates a very gentle shadow effect when used as multiply blend
  const isHorizontal = gradientAngle === "left" || gradientAngle === "right";
  const reverse = gradientAngle === "right" || gradientAngle === "bottom";

  const channels = 4; // RGBA
  const pixelCount = isHorizontal ? width : height;
  const lineSize = isHorizontal ? height : width;

  const raw = Buffer.alloc(width * height * channels);

  for (let i = 0; i < pixelCount; i++) {
    // Normalized position 0..1
    let t = i / Math.max(pixelCount - 1, 1);
    if (reverse) t = 1 - t;

    // Shadow intensity: from 255 (no shadow) to 220 (subtle shadow)
    const val = Math.round(255 - (35 * t));

    for (let j = 0; j < lineSize; j++) {
      const x = isHorizontal ? i : j;
      const y = isHorizontal ? j : i;
      const offset = (y * width + x) * channels;

      raw[offset] = val;     // R
      raw[offset + 1] = val; // G
      raw[offset + 2] = val; // B
      raw[offset + 3] = 255; // A (fully opaque — blended via multiply)
    }
  }

  return sharp(raw, { raw: { width, height, channels } })
    .png()
    .toBuffer();
}
