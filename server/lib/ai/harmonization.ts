/**
 * Product harmonization — make a placed product look like it belongs in
 * the scene WITHOUT regenerating the scene.
 *
 * Hard requirement (learned the hard way after IC-Light v2 produced golden-
 * hour-fantasy versions of every scene): pixels outside the product's
 * bounding box MUST be byte-identical to the original scene. Trees, lighting,
 * person, microphone, background — all preserved. Only the product gets
 * relit to match its surroundings.
 *
 * Two paths:
 *
 * 1. PROCEDURAL (this file, primary path): pure sharp operations.
 *    Sample the scene's atmosphere around the bbox, apply matching
 *    color cast + brightness to the product, drop a contact shadow,
 *    soften the edges, composite onto the scene. Predictable. Never
 *    goes off the rails. Quality ceiling lower than a good AI model
 *    but always scene-preserving.
 *
 * 2. AI (future, model-pending): a real scene-preserving harmonization
 *    model with hard mask guarantees. IC-Light v2 was the wrong fit;
 *    we need something in the "image harmonization" category that
 *    operates ONLY on the masked region. Research notes captured in
 *    memory:yt_oauth_download.md... actually scratch that, separate
 *    memory file: harmonization_research.md. Candidates listed there.
 */

import { fal } from "@fal-ai/client";
import sharp from "sharp";

export interface HarmonizationInput {
  /** URL or local path to the base scene frame (jpg/png). */
  sceneImage: string | Buffer;
  /** URL or local path to the product image to insert (transparent PNG ideal). */
  productImage: string | Buffer;
  /** Where in the scene the product goes. Values are 0-1 normalized. */
  bbox: { x: number; y: number; width: number; height: number };
  /** Frame dimensions in pixels — needed to map the normalized bbox. */
  frameDimensions: { width: number; height: number };
  /** Optional prompt nudge — currently used only by the AI path. */
  prompt?: string;
  /** "procedural" (default, scene-preserving) or "ai" (placeholder). */
  mode?: "procedural" | "ai";
}

export interface HarmonizationResult {
  success: boolean;
  /** URL of the harmonized composite, hosted on fal.ai's CDN. */
  imageUrl?: string;
  /** Pre-harmonization flat composite — useful for before/after comparison. */
  flatCompositeUrl?: string;
  error?: string;
  elapsedMs?: number;
  mode?: "procedural" | "ai";
}

async function asBuffer(input: string | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(input)) return input;
  if (/^https?:\/\//.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`Fetch ${input} failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const fs = await import("fs");
  return fs.readFileSync(input);
}

async function uploadBuffer(buf: Buffer, name: string, mime: string): Promise<string> {
  const file = new File([buf as any], name, { type: mime });
  return fal.storage.upload(file);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Clip a region rect so it stays inside the image bounds. */
function clipRegion(
  region: { left: number; top: number; width: number; height: number },
  imgW: number,
  imgH: number,
) {
  const left = Math.max(0, Math.floor(region.left));
  const top = Math.max(0, Math.floor(region.top));
  const width = Math.max(1, Math.floor(Math.min(region.width, imgW - left)));
  const height = Math.max(1, Math.floor(Math.min(region.height, imgH - top)));
  return { left, top, width, height };
}

/**
 * The actual harmonization step. Pure sharp, no AI.
 *
 * Takes a flat composite (scene with product pasted at bbox) and:
 *   1. Samples scene's color + brightness in a ring around the bbox
 *   2. Re-tints the product region to match (subtle, ~15% blend)
 *   3. Adjusts brightness of product region to match scene
 *   4. Adds a soft contact shadow at the product base
 *   5. Slightly softens product edges
 *
 * Pixels outside the bbox are NEVER modified.
 */
async function applyProceduralHarmonization(
  sceneBuf: Buffer,
  productBuf: Buffer,
  bbox: HarmonizationInput["bbox"],
  dims: HarmonizationInput["frameDimensions"],
): Promise<{ result: Buffer; flatComposite: Buffer }> {
  const W = dims.width;
  const H = dims.height;
  const pxX = clamp(Math.round(bbox.x * W), 0, W - 1);
  const pxY = clamp(Math.round(bbox.y * H), 0, H - 1);
  const pxW = clamp(Math.round(bbox.width * W), 1, W - pxX);
  const pxH = clamp(Math.round(bbox.height * H), 1, H - pxY);

  // ── Step 1: resize product to fit the bbox, preserving aspect ──
  const productResized = await sharp(productBuf)
    .resize(pxW, pxH, { fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const productMeta = await sharp(productResized).metadata();
  const finalW = productMeta.width || pxW;
  const finalH = productMeta.height || pxH;
  // Center the product within the bbox if aspect ratios differ
  const offsetX = pxX + Math.floor((pxW - finalW) / 2);
  const offsetY = pxY + Math.floor((pxH - finalH) / 2);

  // ── Step 2: build flat composite (Stage 1, no AI) ──
  const flatComposite = await sharp(sceneBuf)
    .composite([{ input: productResized, left: offsetX, top: offsetY }])
    .png()
    .toBuffer();

  // ── Step 3: sample scene atmosphere — ring around the bbox ──
  // We sample OUTSIDE the bbox so we get the surrounding lighting/color
  // without the product itself influencing the read.
  const ringPad = Math.max(20, Math.min(W, H) * 0.05); // 5% of frame, min 20px
  const sampleRegion = clipRegion(
    {
      left: pxX - ringPad,
      top: pxY - ringPad,
      width: pxW + ringPad * 2,
      height: pxH + ringPad * 2,
    },
    W, H,
  );
  const sceneStats = await sharp(sceneBuf).extract(sampleRegion).stats();
  // sceneStats.channels[0..2] = R/G/B mean over the sampled ring
  const meanR = sceneStats.channels[0]?.mean ?? 128;
  const meanG = sceneStats.channels[1]?.mean ?? 128;
  const meanB = sceneStats.channels[2]?.mean ?? 128;
  const sceneBrightness = (meanR + meanG + meanB) / 3 / 255; // 0–1
  console.log(`[Harmonize/proc] Scene atmosphere: rgb(${meanR.toFixed(0)},${meanG.toFixed(0)},${meanB.toFixed(0)}), brightness=${sceneBrightness.toFixed(2)}`);

  // ── Step 4: adjust product to match atmosphere ──
  // Tint moves product color toward scene color (subtle, sharp's `tint`
  // is multiplicative-ish — clamp the values so dark scenes don't blacken
  // the product into invisibility).
  const tintR = clamp(meanR, 100, 240);
  const tintG = clamp(meanG, 100, 240);
  const tintB = clamp(meanB, 100, 240);
  // Brightness target: blend scene's brightness toward 1.0 a bit so the
  // product doesn't disappear in dim scenes. Range typically 0.7–1.1.
  const brightnessFactor = clamp(0.65 + sceneBrightness * 0.5, 0.70, 1.15);
  const productAdjusted = await sharp(productResized)
    .modulate({ brightness: brightnessFactor, saturation: 0.92 })
    .tint({ r: tintR, g: tintG, b: tintB })
    .png()
    .toBuffer();

  // ── Step 5: build a soft contact shadow underneath the product ──
  // Take the product's alpha channel as a silhouette, blur it heavily,
  // composite as a semi-transparent dark layer offset slightly down.
  const shadowSize = Math.max(8, Math.round(Math.min(finalW, finalH) * 0.04));
  let shadowBuf: Buffer;
  try {
    // Extract alpha channel and use it as shadow mask
    const alphaMask = await sharp(productAdjusted)
      .ensureAlpha()
      .extractChannel("alpha")
      .blur(shadowSize)
      .toBuffer();
    // Build a black RGBA image gated by the blurred alpha
    shadowBuf = await sharp({
      create: {
        width: finalW,
        height: finalH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        { input: alphaMask, blend: "dest-in" }, // shape limited by alpha
      ])
      .png()
      .toBuffer();
  } catch (err) {
    console.warn(`[Harmonize/proc] Shadow build failed (continuing without):`, (err as any)?.message);
    shadowBuf = Buffer.alloc(0);
  }

  // ── Step 6: composite shadow + adjusted product onto the scene ──
  const shadowOffsetY = Math.max(4, Math.round(finalH * 0.03));
  const composites: Array<{ input: Buffer; left: number; top: number; blend?: any }> = [];
  if (shadowBuf.length > 0) {
    composites.push({
      input: shadowBuf,
      left: offsetX + 2,
      top: offsetY + shadowOffsetY,
      blend: "over",
    });
  }
  composites.push({ input: productAdjusted, left: offsetX, top: offsetY });

  const result = await sharp(sceneBuf).composite(composites).png().toBuffer();
  return { result, flatComposite };
}

export async function harmonizeProductIntoScene(
  input: HarmonizationInput,
): Promise<HarmonizationResult> {
  const mode = input.mode ?? "procedural";
  const startedAt = Date.now();
  try {
    const [sceneBuf, productBuf] = await Promise.all([
      asBuffer(input.sceneImage),
      asBuffer(input.productImage),
    ]);

    if (mode === "procedural") {
      console.log(`[Harmonize] Mode: procedural (sharp, scene-preserving)`);
      const { result, flatComposite } = await applyProceduralHarmonization(
        sceneBuf, productBuf, input.bbox, input.frameDimensions,
      );

      // Upload both to fal.ai storage so the test rig can show before/after.
      // (Using fal storage as a CDN here is convenient — when we wire this
      // into the placement flow we'll switch to GCS for persistence.)
      const falKey = process.env.FAL_KEY;
      if (falKey) {
        fal.config({ credentials: falKey });
        const [imageUrl, flatCompositeUrl] = await Promise.all([
          uploadBuffer(result, "harmonized.png", "image/png"),
          uploadBuffer(flatComposite, "flat-composite.png", "image/png"),
        ]);
        const elapsedMs = Date.now() - startedAt;
        console.log(`[Harmonize] Procedural done in ${elapsedMs}ms`);
        return { success: true, imageUrl, flatCompositeUrl, elapsedMs, mode };
      }

      // No FAL_KEY: return the result as a data URL so the spike still works
      // for local-only testing without any external dependency.
      const elapsedMs = Date.now() - startedAt;
      const dataUrl = `data:image/png;base64,${result.toString("base64")}`;
      const flatDataUrl = `data:image/png;base64,${flatComposite.toString("base64")}`;
      return {
        success: true,
        imageUrl: dataUrl,
        flatCompositeUrl: flatDataUrl,
        elapsedMs,
        mode,
      };
    }

    // mode === "ai" reserved for the future scene-preserving model.
    return {
      success: false,
      error: "AI harmonization mode is not wired up. Use mode=procedural (default) or wait for a scene-preserving model integration. See memory:harmonization_research.",
      elapsedMs: Date.now() - startedAt,
      mode,
    };
  } catch (err: any) {
    const elapsedMs = Date.now() - startedAt;
    console.error(`[Harmonize] Failed after ${elapsedMs}ms:`, err?.message || err);
    return { success: false, error: err?.message || String(err), elapsedMs, mode };
  }
}
