/**
 * Product harmonization via fal.ai ACE++.
 *
 * Takes a scene frame, a product image, and a bounding box; returns a
 * harmonized composite where the product is inpainted into the bbox with
 * scene-aware lighting, shadow, and color grading. Used to make a static
 * product placement look like it actually belongs in the shot rather than
 * a flat overlay.
 *
 * Spike scope: single frame, single model, returns image URL. Multi-frame
 * video harmonization, caching, and placement-flow integration are TBD.
 */

import { fal } from "@fal-ai/client";
import sharp from "sharp";

export interface HarmonizationInput {
  /** URL or local path to the base scene frame (jpg/png). */
  sceneImage: string | Buffer;
  /** URL or local path to the product image to insert. */
  productImage: string | Buffer;
  /** Where in the scene the product goes. Values are 0-1 normalized. */
  bbox: { x: number; y: number; width: number; height: number };
  /** Frame dimensions in pixels — needed to render the mask correctly. */
  frameDimensions: { width: number; height: number };
  /** Optional prompt nudge — describe the product or desired styling. */
  prompt?: string;
}

export interface HarmonizationResult {
  success: boolean;
  /** URL of the harmonized composite (hosted on fal.ai's CDN). */
  imageUrl?: string;
  error?: string;
  /** Round-trip wall time in ms — useful for cost/perf tuning. */
  elapsedMs?: number;
}

const MODEL_ID = "fal-ai/ace-plus"; // ACE++ object composition

/**
 * Build a mask image where the bounding box is white (inpaint) and the
 * rest of the frame is black (preserve). Returned as a Buffer ready to
 * upload to fal.ai storage.
 */
async function buildMask(
  bbox: HarmonizationInput["bbox"],
  dims: HarmonizationInput["frameDimensions"],
): Promise<Buffer> {
  const W = dims.width;
  const H = dims.height;
  const pxX = Math.round(bbox.x * W);
  const pxY = Math.round(bbox.y * H);
  const pxW = Math.round(bbox.width * W);
  const pxH = Math.round(bbox.height * H);

  // Black canvas, then paste a white rectangle at the bbox.
  const black = await sharp({
    create: {
      width: W,
      height: H,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  }).png().toBuffer();

  const white = await sharp({
    create: {
      width: pxW,
      height: pxH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  }).png().toBuffer();

  return sharp(black)
    .composite([{ input: white, left: pxX, top: pxY }])
    .png()
    .toBuffer();
}

async function asUploadedUrl(input: string | Buffer, suggestedFilename: string): Promise<string> {
  if (typeof input === "string") {
    // If it's already a URL, pass through. If it's a local path, read + upload.
    if (/^https?:\/\//.test(input)) return input;
    const fs = await import("fs");
    const buf = fs.readFileSync(input);
    const file = new File([buf as any], suggestedFilename, { type: "image/png" });
    return fal.storage.upload(file);
  }
  const file = new File([input as any], suggestedFilename, { type: "image/png" });
  return fal.storage.upload(file);
}

export async function harmonizeProductIntoScene(
  input: HarmonizationInput,
): Promise<HarmonizationResult> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { success: false, error: "FAL_KEY not set in environment" };
  }
  fal.config({ credentials: falKey });

  const startedAt = Date.now();
  try {
    const [sceneUrl, productUrl, maskBuf] = await Promise.all([
      asUploadedUrl(input.sceneImage, "scene.png"),
      asUploadedUrl(input.productImage, "product.png"),
      buildMask(input.bbox, input.frameDimensions),
    ]);
    const maskUrl = await asUploadedUrl(maskBuf, "mask.png");

    console.log(`[Harmonize] Submitting to ${MODEL_ID}`);
    console.log(`[Harmonize]   scene: ${sceneUrl}`);
    console.log(`[Harmonize]   product: ${productUrl}`);
    console.log(`[Harmonize]   mask: ${maskUrl}`);
    console.log(`[Harmonize]   bbox (norm): ${JSON.stringify(input.bbox)}`);

    // ACE++ input shape (fal.ai schema may evolve — adjust here when it does).
    // Common fields across object-composition models: image, mask, reference,
    // and a prompt nudge. If ACE++ rejects this shape, the error message
    // will tell us what it expects so we can adjust.
    const result: any = await fal.subscribe(MODEL_ID, {
      input: {
        image_url: sceneUrl,
        mask_url: maskUrl,
        reference_image_url: productUrl,
        prompt: input.prompt
          || "Place the product naturally in the scene. Match scene lighting, shadows, and color temperature. Realistic integration.",
      },
      logs: true,
      onQueueUpdate: (update: any) => {
        if (update.status === "IN_PROGRESS") {
          const msgs = update.logs;
          if (msgs) {
            msgs.forEach((log: any) => console.log(`[Harmonize/ace++] ${log.message}`));
          }
        }
      },
    });

    const elapsedMs = Date.now() - startedAt;
    // fal.ai response shapes vary by model — try a few common locations.
    const imageUrl: string | undefined =
      result?.data?.image?.url
      ?? result?.data?.images?.[0]?.url
      ?? result?.data?.image_url
      ?? result?.image?.url
      ?? result?.url;

    if (!imageUrl) {
      console.error(`[Harmonize] No image URL in result`, JSON.stringify(result).slice(0, 500));
      return { success: false, error: "No image URL in fal.ai response", elapsedMs };
    }

    console.log(`[Harmonize] Done in ${elapsedMs}ms — ${imageUrl}`);
    return { success: true, imageUrl, elapsedMs };
  } catch (err: any) {
    const elapsedMs = Date.now() - startedAt;
    const detail = err?.body?.detail || err?.message || String(err);
    console.error(`[Harmonize] Failed after ${elapsedMs}ms:`, detail);
    return { success: false, error: detail, elapsedMs };
  }
}
