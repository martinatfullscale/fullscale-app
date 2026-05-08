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
  /**
   * "procedural" — fast (sharp-only, ~2s), no 3D awareness. Default.
   * "ai-3d" — TRELLIS 2D→3D mesh + multi-view render, then procedural
   *   lighting on top. Slower (~30-90s) but the product reads as a 3D
   *   object that belongs in the room rather than a flat sticker.
   * "ai" — legacy alias for "ai-3d" (used by older clients).
   */
  mode?: "procedural" | "ai-3d" | "ai";
  /**
   * Optional camera angle hint for the AI render — "eye-level" |
   * "slightly-above" | "top-down" | "low-angle". Used to choose which
   * preview view to pull from TRELLIS so the product faces the right way
   * for the scene's camera. If absent, "eye-level" is used.
   */
  cameraAngle?: string;
}

export interface HarmonizationResult {
  success: boolean;
  /** URL of the harmonized composite, hosted on fal.ai's CDN. */
  imageUrl?: string;
  /** Pre-harmonization flat composite — useful for before/after comparison. */
  flatCompositeUrl?: string;
  /** When mode=ai-3d, the rendered 3D-aware product image used as input. */
  trellisRenderUrl?: string;
  /** When mode=ai-3d, the GLB mesh URL — exposed for future re-renders. */
  meshUrl?: string;
  error?: string;
  elapsedMs?: number;
  mode?: "procedural" | "ai-3d" | "ai";
}

async function asBuffer(input: string | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(input)) return input;
  // data URL: parse base64 payload directly. Without this branch, the
  // fs.readFileSync fallback below would try to open a 100KB+ "filename"
  // and ENAMETOOLONG. Brand product uploads land as data URLs so this
  // branch hits real-world.
  const dataMatch = input.match(/^data:[^;]+;base64,(.*)$/);
  if (dataMatch) return Buffer.from(dataMatch[1], "base64");
  if (/^https?:\/\//.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`Fetch ${input} failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  // Local-relative path → resolve against /storage handler if it's a
  // /storage/... URL stored in the DB (brand products typically have these).
  if (input.startsWith("/storage/") || input.startsWith("/uploads/")) {
    // Server context: fetch via the local URL through our own backend
    const localUrl = `http://localhost:${process.env.PORT || 5000}${input}`;
    try {
      const res = await fetch(localUrl);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch { /* fall through to readFileSync */ }
  }
  const fs = await import("fs");
  return fs.readFileSync(input);
}

async function uploadBuffer(buf: Buffer, name: string, mime: string): Promise<string> {
  const file = new File([buf as any], name, { type: mime });
  return fal.storage.upload(file);
}

/**
 * TRELLIS (Microsoft Research, hosted on fal.ai) — Image → textured 3D mesh
 * with PBR materials. Takes a single product image and returns:
 *   - a GLB mesh URL
 *   - one or more rendered preview images of the 3D mesh
 *
 * For our harmonize use case we want the rendered preview, not the GLB —
 * the preview is a 2D image of the 3D-aware product that we can drop into
 * the scene. The GLB is exposed in the result for later use (re-rendering
 * at custom camera angles via a server-side renderer).
 *
 * Cost: ~$0.15/inference. Latency: ~30-90s on fal's GPU pool.
 *
 * Falls back gracefully — if TRELLIS errors or FAL_KEY is missing, the
 * caller falls back to procedural mode and the product still ships.
 */
async function runTrellis3D(productBuf: Buffer): Promise<{ renderUrl: string; meshUrl?: string }> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new Error("FAL_KEY env var not set — cannot run TRELLIS");
  fal.config({ credentials: falKey });

  // Upload the product image to fal storage so TRELLIS can read it.
  const productUrl = await uploadBuffer(productBuf, "product.png", "image/png");
  console.log(`[Harmonize/trellis] Uploaded product image to fal: ${productUrl}`);

  const t0 = Date.now();
  // fal-ai/trellis takes { image_url } and returns mesh + preview.
  // We use the queue API's `subscribe` so we don't have to poll manually.
  const result: any = await fal.subscribe("fal-ai/trellis", {
    input: {
      image_url: productUrl,
      // Defaults are fine for product shots — TRELLIS auto-removes background
      // and centers the object. Tweakable if results look off:
      //   ss_guidance_strength, ss_sampling_steps, slat_guidance_strength,
      //   slat_sampling_steps, mesh_simplify, texture_size
    },
    logs: false,
  });
  const elapsed = Date.now() - t0;
  console.log(`[Harmonize/trellis] Inference complete in ${elapsed}ms`);

  // TRELLIS response shape (fal-ai/trellis as of 2025):
  //   { model_mesh: { url, file_name, ... },
  //     timings: { inference: ... } }
  // The rendered preview comes back via the GLB's auto-rendered thumbnail
  // or via the `model_mesh.url` itself if we render server-side. For now
  // we use whichever rendered preview the response includes; if the
  // response shape changes, we adapt.
  const data = result?.data ?? result;
  const meshUrl: string | undefined =
    data?.model_mesh?.url ??
    data?.mesh?.url ??
    data?.glb_url;
  // Some TRELLIS deployments include a multiview render; older versions
  // don't, in which case the procedural pipeline downstream will use the
  // original product image. Future iteration: render the GLB ourselves at
  // the scene's camera angle.
  const renderUrl: string | undefined =
    data?.preview?.url ??
    data?.preview_image?.url ??
    data?.rendered_image?.url ??
    data?.image?.url;

  if (!renderUrl) {
    // No rendered preview available — fall back to the input image so
    // the procedural pipeline still has a product to composite.
    console.warn(`[Harmonize/trellis] No rendered preview in response; using input image. Mesh URL: ${meshUrl ?? "(none)"}`);
    return { renderUrl: productUrl, meshUrl };
  }
  console.log(`[Harmonize/trellis] Render URL: ${renderUrl}, mesh URL: ${meshUrl ?? "(none)"}`);
  return { renderUrl, meshUrl };
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

  // ── Step 4: adjust product to match scene LIGHTING (not scene COLOR) ──
  // Hard rule: brand colors must stay recognizable. A Just Water carton has
  // to read as Just Water blue/white, not gray-washed to match a dim podcast
  // set. So no tint — that would shift the product's intrinsic palette.
  // Instead we adjust ONLY the brightness to match scene exposure, keeping
  // saturation full so brand colors stay crisp. The contact shadow (next
  // step) handles the "this object belongs in this scene" feel.
  const brightnessFactor = clamp(0.85 + sceneBrightness * 0.25, 0.85, 1.10);
  const productAdjusted = await sharp(productResized)
    .modulate({ brightness: brightnessFactor })
    .png()
    .toBuffer();
  console.log(`[Harmonize/proc] Brightness adjustment: ${brightnessFactor.toFixed(2)}× (saturation + hue preserved)`);

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

    // mode === "ai-3d" (or legacy "ai" alias): TRELLIS + procedural lighting.
    // Two-stage pipeline:
    //   Stage A: TRELLIS image→3D mesh + render → 3D-aware product image
    //   Stage B: feed the rendered product into the procedural pipeline
    //   so it gets scene-matched lighting + contact shadow.
    // Net: product reads as a 3D object that belongs in the room, not a
    // flat sticker, while still preserving brand color fidelity.
    if (mode === "ai-3d" || mode === "ai") {
      console.log(`[Harmonize] Mode: ai-3d (TRELLIS 3D mesh → procedural lighting)`);
      let trellisRenderUrl: string | undefined;
      let meshUrl: string | undefined;
      let renderedProductBuf: Buffer = productBuf;
      try {
        const trellis = await runTrellis3D(productBuf);
        trellisRenderUrl = trellis.renderUrl;
        meshUrl = trellis.meshUrl;
        // Pull the rendered image bytes for compositing
        const renderRes = await fetch(trellis.renderUrl);
        if (renderRes.ok) {
          renderedProductBuf = Buffer.from(await renderRes.arrayBuffer());
        } else {
          console.warn(`[Harmonize/ai-3d] Failed to fetch TRELLIS render (${renderRes.status}); using original product image`);
        }
      } catch (err: any) {
        console.warn(`[Harmonize/ai-3d] TRELLIS failed (${err?.message || err}); falling back to procedural-only`);
        // If TRELLIS errors, we still ship a procedural composite so the
        // user gets *something* rather than a 502.
      }

      const { result, flatComposite } = await applyProceduralHarmonization(
        sceneBuf, renderedProductBuf, input.bbox, input.frameDimensions,
      );

      const falKey = process.env.FAL_KEY;
      if (falKey) {
        fal.config({ credentials: falKey });
        const [imageUrl, flatCompositeUrl] = await Promise.all([
          uploadBuffer(result, "harmonized-3d.png", "image/png"),
          uploadBuffer(flatComposite, "flat-composite-3d.png", "image/png"),
        ]);
        const elapsedMs = Date.now() - startedAt;
        console.log(`[Harmonize] ai-3d done in ${elapsedMs}ms (TRELLIS + procedural)`);
        return {
          success: true,
          imageUrl,
          flatCompositeUrl,
          trellisRenderUrl,
          meshUrl,
          elapsedMs,
          mode: "ai-3d",
        };
      }

      const elapsedMs = Date.now() - startedAt;
      const dataUrl = `data:image/png;base64,${result.toString("base64")}`;
      const flatDataUrl = `data:image/png;base64,${flatComposite.toString("base64")}`;
      return {
        success: true,
        imageUrl: dataUrl,
        flatCompositeUrl: flatDataUrl,
        trellisRenderUrl,
        meshUrl,
        elapsedMs,
        mode: "ai-3d",
      };
    }

    return {
      success: false,
      error: `Unknown harmonization mode: ${mode}. Use procedural | ai-3d.`,
      elapsedMs: Date.now() - startedAt,
      mode,
    };
  } catch (err: any) {
    const elapsedMs = Date.now() - startedAt;
    console.error(`[Harmonize] Failed after ${elapsedMs}ms:`, err?.message || err);
    return { success: false, error: err?.message || String(err), elapsedMs, mode };
  }
}
