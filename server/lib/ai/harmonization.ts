/**
 * Product harmonization via fal.ai IC-Light v2.
 *
 * Two-stage workflow because IC-Light expects an object already positioned
 * in a scene and relights it — not a mask-based inpaint:
 *   Stage 1 (server, sharp): basic overlay of the product image at the
 *           bounding-box location. Pure pixel composite, no AI yet —
 *           gives us the "flat-pasted" version current placement uses.
 *   Stage 2 (fal.ai IC-Light v2): relights the composited image so the
 *           product's lighting + color temperature + shadow match the
 *           surrounding scene. This is what makes it look like the
 *           product BELONGS rather than being slapped on.
 *
 * Spike scope: single frame, returns image URL. Multi-frame video
 * harmonization (keyframes + interpolation) is the next layer.
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
  /** Frame dimensions in pixels — used to map the normalized bbox. */
  frameDimensions: { width: number; height: number };
  /** Optional prompt nudge — describe the product or desired styling. */
  prompt?: string;
}

export interface HarmonizationResult {
  success: boolean;
  /** URL of the harmonized composite (hosted on fal.ai's CDN). */
  imageUrl?: string;
  /** URL of the pre-AI flat composite, useful for before/after comparison. */
  flatCompositeUrl?: string;
  error?: string;
  /** Round-trip wall time in ms — useful for cost/perf tuning. */
  elapsedMs?: number;
}

const MODEL_ID = "fal-ai/iclight-v2"; // IC-Light v2 — relights foreground to match scene

/** Pre-AI overlay: paste the product image into the scene at the bbox. */
async function buildFlatComposite(
  scene: Buffer,
  product: Buffer,
  bbox: HarmonizationInput["bbox"],
  dims: HarmonizationInput["frameDimensions"],
): Promise<Buffer> {
  const W = dims.width;
  const H = dims.height;
  const pxX = Math.max(0, Math.round(bbox.x * W));
  const pxY = Math.max(0, Math.round(bbox.y * H));
  const pxW = Math.max(1, Math.round(bbox.width * W));
  const pxH = Math.max(1, Math.round(bbox.height * H));

  // Resize product to fit the bbox (preserve aspect, fit inside, transparent BG)
  const productResized = await sharp(product)
    .resize(pxW, pxH, { fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const productMeta = await sharp(productResized).metadata();
  const offsetX = pxX + Math.floor((pxW - (productMeta.width || pxW)) / 2);
  const offsetY = pxY + Math.floor((pxH - (productMeta.height || pxH)) / 2);

  return sharp(scene)
    .composite([{ input: productResized, left: offsetX, top: offsetY }])
    .png()
    .toBuffer();
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
    // Resolve both input images to Buffers (whether they came as URL or path or Buffer).
    const [sceneBuf, productBuf] = await Promise.all([
      asBuffer(input.sceneImage),
      asBuffer(input.productImage),
    ]);

    // Stage 1 — flat overlay (pre-AI baseline).
    const flatBuf = await buildFlatComposite(sceneBuf, productBuf, input.bbox, input.frameDimensions);
    const flatCompositeUrl = await uploadBuffer(flatBuf, "flat-composite.png", "image/png");

    console.log(`[Harmonize] Stage 1 complete (flat composite uploaded)`);
    console.log(`[Harmonize] Stage 2 — submitting to ${MODEL_ID}`);
    console.log(`[Harmonize]   composite: ${flatCompositeUrl}`);
    console.log(`[Harmonize]   bbox (norm): ${JSON.stringify(input.bbox)}`);

    const prompt = input.prompt
      || "Photorealistic product placement. Match scene lighting, color temperature, and shadows. Subtle, natural integration with the surrounding environment.";

    // IC-Light v2 input shape on fal.ai. If the schema rejects this, the
    // error body has the validator's expected fields and we adjust.
    const result: any = await fal.subscribe(MODEL_ID, {
      input: {
        image_url: flatCompositeUrl,
        prompt,
        // Common IC-Light optional knobs — leaving defaults but ready to tune:
        // initial_latent: "Left",   // light from left
        // num_inference_steps: 28,
        // guidance_scale: 5,
      },
      logs: true,
      onQueueUpdate: (update: any) => {
        if (update.status === "IN_PROGRESS") {
          const msgs = update.logs;
          if (msgs) {
            msgs.forEach((log: any) => console.log(`[Harmonize/iclight] ${log.message}`));
          }
        }
      },
    });

    const elapsedMs = Date.now() - startedAt;
    const imageUrl: string | undefined =
      result?.data?.image?.url
      ?? result?.data?.images?.[0]?.url
      ?? result?.data?.image_url
      ?? result?.image?.url
      ?? result?.url;

    if (!imageUrl) {
      console.error(`[Harmonize] No image URL in result`, JSON.stringify(result).slice(0, 500));
      // Still return the flat composite — at least the user can see Stage 1.
      return { success: false, error: "No image URL in fal.ai response", elapsedMs, flatCompositeUrl };
    }

    console.log(`[Harmonize] Done in ${elapsedMs}ms — ${imageUrl}`);
    return { success: true, imageUrl, flatCompositeUrl, elapsedMs };
  } catch (err: any) {
    const elapsedMs = Date.now() - startedAt;
    const detail = err?.body?.detail || err?.message || String(err);
    console.error(`[Harmonize] Failed after ${elapsedMs}ms:`, detail);
    return { success: false, error: detail, elapsedMs };
  }
}
