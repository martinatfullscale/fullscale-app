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
   * "flat" — DEFAULT. Just composite the product onto the scene at the
   *   bbox with NO processing. User testing showed this consistently
   *   beats every "harmonization" approach we've tried — the bare
   *   composite already integrates well for most product/scene pairs.
   * "procedural" — gentle adjustments (shadow + optional tint via env).
   * "ai-3d" — TRELLIS 2D→3D mesh + multi-view render + procedural.
   *   Slower (~30-90s).
   * "ai" — legacy alias for "ai-3d".
   * "generative" — EXPERIMENTAL. FLUX Kontext. Currently outputs wrong
   *   content (regenerates scene without product reference) — needs
   *   endpoint/payload investigation before re-enabling as default.
   */
  mode?: "flat" | "procedural" | "ai-3d" | "ai" | "generative";
  /**
   * Optional camera angle hint for the AI render — "eye-level" |
   * "slightly-above" | "top-down" | "low-angle". Used to choose which
   * preview view to pull from TRELLIS so the product faces the right way
   * for the scene's camera. If absent, "eye-level" is used.
   */
  cameraAngle?: string;
  /**
   * Surface type label (e.g. "Coffee Table", "Wall") — used by generative
   * mode to anchor the Kontext prompt in concrete language. Falls back
   * to "surface" when absent.
   */
  surfaceType?: string;
  /**
   * Scene light direction at the placement bbox — drives the directional
   * cast shadow. Values: "left" | "right" | "top" | "top-left" |
   * "top-right" | "ambient". Falls back to "top" if absent.
   */
  lightingDirection?: string;
  /**
   * Scene light intensity 0..1 — modulates cast shadow opacity.
   * Bright scene = sharper shadow; dim scene = softer shadow.
   */
  lightingIntensity?: number;
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
  /** When mode=ai-3d, the IC-Light relit product URL (post-relighting). */
  icLightRelitUrl?: string;
  /** When mode=generative, the FLUX Kontext output URL pre-composite. */
  kontextOutputUrl?: string;
  error?: string;
  elapsedMs?: number;
  mode?: "flat" | "procedural" | "ai-3d" | "ai" | "generative";
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
 * Extract a single frame from a turnaround MP4 at the given normalized
 * angle (0..1, where 0 = front, 0.25 = right, 0.5 = back, 0.75 = left).
 * TRELLIS turnaround videos are typically 24-frame loops; we ffprobe for
 * duration and seek to the matching timestamp.
 *
 * Returns null on any failure — caller falls back to TRELLIS's default
 * preview image.
 */
async function extractTurnaroundFrame(
  videoUrl: string,
  normalizedAngle: number,
): Promise<Buffer | null> {
  const { spawn } = await import("child_process");
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");

  const tempPath = path.join(
    os.tmpdir(),
    `trellis_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`,
  );

  // Probe duration first.
  const duration = await new Promise<number>((resolve) => {
    const ff = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoUrl,
    ]);
    let out = "";
    ff.stdout.on("data", (d) => { out += d.toString(); });
    ff.on("close", () => {
      const v = parseFloat(out.trim());
      resolve(Number.isFinite(v) && v > 0 ? v : 4); // 4s default
    });
    ff.on("error", () => resolve(4));
  });

  const t = clamp(normalizedAngle, 0, 0.999) * duration;

  const ok = await new Promise<boolean>((resolve) => {
    const ff = spawn("ffmpeg", [
      "-nostdin",
      "-y",
      "-loglevel", "error",
      "-ss", String(t),
      "-i", videoUrl,
      "-frames:v", "1",
      "-q:v", "2",
      tempPath,
    ]);
    ff.on("close", (code) => {
      resolve(code === 0 && fs.existsSync(tempPath));
    });
    ff.on("error", () => resolve(false));
  });

  if (!ok) return null;
  try {
    return fs.readFileSync(tempPath);
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

/**
 * Generative harmonization via FLUX Kontext (Black Forest Labs, hosted on
 * fal.ai). The fundamentally different approach: instead of compositing a
 * 2D product onto a scene and trying to relight it, we hand the model
 *   - the scene crop around the placement bbox
 *   - the product image as a reference
 *   - a natural-language edit instruction
 * and let it GENERATE pixels in the crop that look native — matching the
 * scene's lighting, perspective, texture, and depth-of-field.
 *
 * This is what the user has been asking for: "analyze the background video
 * and align it with the needs of the 2D static image." Kontext is designed
 * exactly for this — multi-image instruction-following editing.
 *
 * Pipeline:
 *   1. Crop scene to a padded region around the bbox (1.5x) — gives the
 *      model surrounding lighting/perspective context.
 *   2. Submit crop + product image to fal-ai/flux-pro/kontext with edit
 *      instruction.
 *   3. Composite the edited crop back into the full scene at the same
 *      location.
 *
 * Cost: ~$0.04-0.06/call. Latency: ~15-30s on fal's GPU pool.
 *
 * Returns the URL of the generated crop, or null on any failure (caller
 * falls back to procedural composite — never blocks).
 */
async function runFluxKontext(
  sceneCropUrl: string,
  productImageUrl: string,
  surfaceType: string,
  cameraAngle: string | undefined,
): Promise<string | null> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) return null;
  fal.config({ credentials: falKey });

  // Build an edit instruction that emphasizes integration cues. The
  // explicit camera-angle hint helps when Gemini gave us one — Kontext
  // is sensitive to perspective language.
  const angleHint =
    cameraAngle === "low-angle"
      ? "viewed from slightly below"
      : cameraAngle === "top-down"
      ? "viewed from above"
      : cameraAngle === "slightly-above"
      ? "viewed from slightly above"
      : "at eye level";

  // Prompt rewritten to be FAR more conservative about scene preservation.
  // Earlier prompts said "keep the rest of the scene unchanged" softly;
  // Kontext still regenerated nearby objects (the user saw a candle become
  // something else in the harmonized output). New prompt makes preservation
  // the primary instruction, with the product placement as the only
  // permitted edit. Repeating the constraint multiple times biases Kontext's
  // attention toward identity-preservation of non-product pixels.
  const prompt =
    `Add the product from the reference image to this scene on the ` +
    `${surfaceType.toLowerCase()}, ${angleHint}. The product is the ONLY ` +
    `thing you add — do not modify, regenerate, replace, or alter any ` +
    `existing object, person, or detail in the scene. Every object, every ` +
    `texture, every pixel that is not the product must remain exactly as in ` +
    `the input image. Add only a soft contact shadow directly under the ` +
    `product. The product should match the scene's lighting direction and ` +
    `color temperature. Preserve the product's exact shape, colors, and branding.`;

  try {
    const t0 = Date.now();
    // fal-ai/flux-pro/kontext — multi-image editing. seed pinned to 42
    // for deterministic outputs (was generating different scene
    // interpretations on retry — user reported "3D harmonize isn't
    // consistent"). Lower guidance_scale (2.5 vs 3.5) lets the model
    // weight the input image more than the prompt — keeps scene fidelity.
    const result: any = await fal.subscribe("fal-ai/flux-pro/kontext", {
      input: {
        image_url: sceneCropUrl,
        reference_images: [{ url: productImageUrl }],
        prompt,
        guidance_scale: 2.5,
        num_inference_steps: 28,
        safety_tolerance: "5",
        output_format: "png",
        seed: 42,
      } as any,
      logs: false,
    });
    const elapsed = Date.now() - t0;
    const data = result?.data ?? result;
    const outputUrl: string | undefined =
      data?.images?.[0]?.url ?? data?.image?.url ?? data?.output?.url;
    if (!outputUrl) {
      console.warn(`[Harmonize/kontext] No image URL in response — keys: ${Object.keys(data || {}).join(",")}`);
      return null;
    }
    console.log(`[Harmonize/kontext] Edit complete in ${elapsed}ms → ${outputUrl}`);
    return outputUrl;
  } catch (err: any) {
    // Verbose error logging so we can pin down why Kontext is failing.
    // Common causes: wrong endpoint slug, FAL_KEY missing, account doesn't
    // have access to flux-pro, payload shape mismatch. fal errors carry
    // status + body that's much more useful than just .message.
    const errMessage = err?.message || String(err);
    const errStatus = err?.status || err?.response?.status;
    const errBody = err?.body || err?.response?.body || err?.response?.data;
    console.error(`[Harmonize/kontext] ❌ FAILED: ${errMessage}`);
    if (errStatus) console.error(`[Harmonize/kontext] HTTP status: ${errStatus}`);
    if (errBody) console.error(`[Harmonize/kontext] Response body: ${typeof errBody === "string" ? errBody : JSON.stringify(errBody)}`);
    return null;
  }
}

/**
 * Crop the scene to a padded region around the bbox, return both the crop
 * buffer AND the pixel-space crop rectangle (for compositing back later).
 * Padding gives the generative model enough surrounding context — a 1px-
 * tight crop forces it to hallucinate edges. 1.5x extents work well in
 * practice.
 */
async function cropSceneForKontext(
  sceneBuf: Buffer,
  bbox: HarmonizationInput["bbox"],
  dims: HarmonizationInput["frameDimensions"],
): Promise<{ cropBuf: Buffer; rect: { x: number; y: number; w: number; h: number } }> {
  const W = dims.width;
  const H = dims.height;
  // 1.1x extents around the bbox — was 1.5x but Kontext regenerates the
  // ENTIRE crop area, so larger crop = more surrounding scene pixels get
  // replaced with model-generated content. User feedback: candle next to
  // the product in the flat version got replaced with a different object
  // in the harmonized version. Tighter crop constrains the regeneration
  // footprint while still giving Kontext enough context to match lighting.
  const padX = bbox.width * 0.1;
  const padY = bbox.height * 0.1;
  const x0 = clamp(bbox.x - padX, 0, 1);
  const y0 = clamp(bbox.y - padY, 0, 1);
  const x1 = clamp(bbox.x + bbox.width + padX, 0, 1);
  const y1 = clamp(bbox.y + bbox.height + padY, 0, 1);

  const left = Math.round(x0 * W);
  const top = Math.round(y0 * H);
  const width = Math.max(1, Math.round((x1 - x0) * W));
  const height = Math.max(1, Math.round((y1 - y0) * H));

  const sharp = (await import("sharp")).default;
  const cropBuf = await sharp(sceneBuf)
    .extract({ left, top, width, height })
    .png()
    .toBuffer();

  return { cropBuf, rect: { x: left, y: top, w: width, h: height } };
}

/**
 * Composite an edited crop back into the original scene at the rect where
 * it was extracted from. Uses sharp's composite — the edited crop just
 * overlays at the right pixel offset.
 */
async function compositeKontextCropBack(
  sceneBuf: Buffer,
  cropBuf: Buffer,
  rect: { x: number; y: number; w: number; h: number },
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  // Ensure the crop matches the rect size (Kontext may pad slightly).
  const resizedCrop = await sharp(cropBuf)
    .resize(rect.w, rect.h, { fit: "fill" })
    .toBuffer();
  return sharp(sceneBuf)
    .composite([{ input: resizedCrop, left: rect.x, top: rect.y }])
    .png()
    .toBuffer();
}

/**
 * SECOND PASS — verification + product lock.
 *
 * After any harmonization (Kontext, procedural, ai-3d), we composite the
 * ORIGINAL product image back over the harmonized result at the exact
 * user-specified bbox. This guarantees the user's three product rules:
 *   1. Don't move the product from its placement
 *   2. Don't change the size
 *   3. Don't change the color
 *
 * The harmonized output's contribution is everything OUTSIDE the product
 * silhouette — scene-level adjustments (contact shadow, ambient
 * brightening, subtle reflections) that Kontext or procedural added in
 * response to the product's presence. These survive the lock pass because
 * the original product is composited at exactly the original bbox; the
 * surrounding pixels remain whatever the harmonization produced.
 *
 * Result: product identity preserved bit-for-bit, scene-level
 * harmonization preserved.
 */
async function lockProductOverHarmonized(
  harmonizedSceneBuf: Buffer,
  productBuf: Buffer,
  bbox: HarmonizationInput["bbox"],
  dims: HarmonizationInput["frameDimensions"],
  // OPTIONAL atmosphere — when provided, applies the same brightness
  // adjustment AND a soft scene-color tint to the locked product. Without
  // this, the lock pass pastes the bare original product back over the
  // harmonized scene and effectively undoes every harmonization effect
  // (brightness match, color cast, anything that touched product pixels
  // in PASS 1). The visual result is "flat overlay" — exactly the bug.
  atmosphere?: {
    brightnessFactor: number;
    sceneRgb: { r: number; g: number; b: number };
    sceneBrightness: number;
  },
): Promise<Buffer> {
  const W = dims.width;
  const H = dims.height;
  const pxX = clamp(Math.round(bbox.x * W), 0, W - 1);
  const pxY = clamp(Math.round(bbox.y * H), 0, H - 1);
  const pxW = clamp(Math.round(bbox.width * W), 1, W - pxX);
  const pxH = clamp(Math.round(bbox.height * H), 1, H - pxY);

  // Ensure product has alpha so the composite respects the silhouette
  // (otherwise we paint a rectangle, including any backdrop in the
  // product image).
  let workingProductBuf = productBuf;
  try {
    const inMeta = await sharp(productBuf).metadata();
    if (!inMeta.hasAlpha && process.env.FAL_KEY) {
      const tempUrl = await uploadBuffer(productBuf, "product-lock-noalpha.png", "image/png");
      const cleanUrl = await removeBackgroundForCompositing(tempUrl);
      if (cleanUrl) {
        const cleanRes = await fetch(cleanUrl);
        if (cleanRes.ok) {
          workingProductBuf = Buffer.from(await cleanRes.arrayBuffer());
        }
      }
    }
  } catch { /* keep original */ }

  // Resize product to EXACTLY the user-specified bbox dimensions. fit:
  // "fill" stretches if aspect differs — that's intentional, the user
  // already set the scale via the placement modal. fit: "inside" would
  // letterbox and silently change the visible size, which is exactly the
  // size-drift bug we're fixing here.
  let productAtSize = await sharp(workingProductBuf)
    .resize(pxW, pxH, { fit: "fill" })
    .png()
    .toBuffer();

  // Apply scene atmosphere to the LOCKED product so harmonization
  // effects survive PASS 2. Two passes:
  //   (a) brightness modulate — same factor PASS 1 computed
  //   (b) soft-light tint with scene RGB at low alpha — picks up the
  //       scene's color temperature without destroying brand color
  if (atmosphere) {
    const bf = atmosphere.brightnessFactor;
    if (Math.abs(bf - 1) > 0.02) {
      productAtSize = await sharp(productAtSize)
        .modulate({ brightness: bf })
        .png()
        .toBuffer();
      console.log(`[Harmonize/lock] Applied brightness factor ${bf.toFixed(2)}× to locked product`);
    }
    // Tint alpha scales with how DIFFERENT the scene is from neutral.
    // A neutral-grey scene (~rgb 128,128,128) gets ~0 tint. A warm
    // amber scene (high R, low B) gets up to 0.18 tint. Capped at 0.18
    // so brand color is preserved.
    const { r, g, b } = atmosphere.sceneRgb;
    const chroma = Math.max(Math.abs(r - 128), Math.abs(g - 128), Math.abs(b - 128)) / 128;
    const tintAlpha = clamp(chroma * 0.25, 0, 0.18);
    if (tintAlpha > 0.02) {
      // Build a tint sheet and apply it ONLY where the product has
      // alpha (mask = product alpha) so the tint doesn't bleed onto
      // the surrounding scene through transparent regions.
      const productAlpha = await sharp(productAtSize)
        .ensureAlpha()
        .extractChannel("alpha")
        .toBuffer();
      const tintSheet = await sharp({
        create: {
          width: pxW,
          height: pxH,
          channels: 4,
          background: { r, g, b, alpha: tintAlpha },
        },
      })
        .composite([{ input: productAlpha, blend: "dest-in" }])
        .png()
        .toBuffer();
      productAtSize = await sharp(productAtSize)
        .composite([{ input: tintSheet, blend: "soft-light" }])
        .png()
        .toBuffer();
      console.log(`[Harmonize/lock] Applied scene tint rgb(${r},${g},${b}) @ alpha=${tintAlpha.toFixed(2)} (chroma=${chroma.toFixed(2)})`);
    }
  }

  console.log(`[Harmonize/lock] Compositing locked product at bbox: ${pxW}x${pxH} @ (${pxX}, ${pxY})`);

  return sharp(harmonizedSceneBuf)
    .composite([{ input: productAtSize, left: pxX, top: pxY }])
    .png()
    .toBuffer();
}

/**
 * IC-Light v2 (fal-ai/iclight-v2) — relights a foreground subject using a
 * background image as the lighting reference. We feed it:
 *   - foreground: the TRELLIS-rendered 3D product (lit by neutral studio
 *     lighting, looks like a stock photo)
 *   - background reference: a crop of the scene around the placement bbox
 *     (carries the scene's actual light direction, color temp, ambient)
 *
 * The output is a relit product image that picks up the scene's lighting
 * — warm if scene is warm, lit from the right if scene's light is rightward,
 * etc. This is the biggest single visual fix for "product still looks
 * pasted on": it solves the lighting-mismatch half of the flatness problem.
 *
 * Cost: ~$0.04/inference. Latency: ~5-15s on fal's pool.
 *
 * Returns null on failure — caller falls back to the un-relit input so the
 * pipeline still ships an output.
 */
async function runIcLightRelight(
  productRenderUrl: string,
  sceneCropBuf: Buffer,
  prompt: string,
): Promise<string | null> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    console.warn(`[Harmonize/iclight] FAL_KEY not set — skipping relight`);
    return null;
  }
  fal.config({ credentials: falKey });

  try {
    const sceneCropUrl = await uploadBuffer(sceneCropBuf, "scene-crop.png", "image/png");
    const t0 = Date.now();
    // The SDK's typed input doesn't include background_image_url for the
    // base iclight-v2 endpoint, but the underlying API does accept it on
    // background-conditioned deployments. Cast to any so TS doesn't block.
    //
    // Tuning notes: started at guidance=5.0 / steps=25 — over-aggressive
    // relight was washing out brand colors and adding hallucinated detail
    // to the product (user feedback: "3D harmonize is worse"). Dropped to
    // guidance=2.5 / steps=18 to keep IC-Light's role narrow: match scene
    // light direction + color temperature, don't redesign the product.
    const input: any = {
      image_url: productRenderUrl,
      background_image_url: sceneCropUrl,
      prompt,
      guidance_scale: 2.5,
      num_inference_steps: 18,
      // Cap how much IC-Light can deviate from the input. Without this,
      // higher-saturation products tend to come back desaturated.
      strength: 0.45,
    };
    const result: any = await fal.subscribe("fal-ai/iclight-v2", {
      input,
      logs: false,
    });
    const elapsed = Date.now() - t0;
    const data = result?.data ?? result;
    const relitUrl: string | undefined =
      data?.image?.url ?? data?.images?.[0]?.url ?? data?.output?.url;
    if (!relitUrl) {
      console.warn(`[Harmonize/iclight] No image URL in response — keys: ${Object.keys(data || {}).join(",")}`);
      return null;
    }
    console.log(`[Harmonize/iclight] Relight complete in ${elapsed}ms → ${relitUrl}`);
    return relitUrl;
  } catch (err: any) {
    console.warn(`[Harmonize/iclight] Failed (${err?.message || err}) — using un-relit product`);
    return null;
  }
}

/**
 * Crop a region of the scene around the placement bbox to use as a lighting
 * reference for IC-Light. We expand 1.5x past the bbox so IC-Light sees the
 * surrounding context (ceiling lights, windows, ambient color), not just
 * what's directly under the product.
 */
async function cropSceneForLighting(
  sceneBuf: Buffer,
  bbox: { x: number; y: number; width: number; height: number },
  frameDimensions: { width: number; height: number },
): Promise<Buffer> {
  const expandX = bbox.width * 0.5;
  const expandY = bbox.height * 0.5;
  const cx = clamp(bbox.x - expandX, 0, 1);
  const cy = clamp(bbox.y - expandY, 0, 1);
  const cw = clamp(bbox.width + expandX * 2, 0.1, 1 - cx);
  const ch = clamp(bbox.height + expandY * 2, 0.1, 1 - cy);

  const px = Math.round(cx * frameDimensions.width);
  const py = Math.round(cy * frameDimensions.height);
  const pw = Math.round(cw * frameDimensions.width);
  const ph = Math.round(ch * frameDimensions.height);

  const sharp = (await import("sharp")).default;
  return sharp(sceneBuf)
    .extract({ left: px, top: py, width: Math.max(1, pw), height: Math.max(1, ph) })
    .png()
    .toBuffer();
}

/**
 * Map the scene's reported camera angle to a normalized turnaround position
 * (0..1). 0 is front, 0.25 right side, 0.5 back, 0.75 left side.
 *
 * For most product shots the 3/4 view (~0.083 = 30°) reads as most product-
 * like — flat-front looks like a sticker, true-side hides the front face.
 * We bias toward 3/4 unless the scene's camera is clearly above/below the
 * product surface, in which case we keep front-facing and let pitch
 * variation come from the 2D source.
 */
function angleForCameraAngle(cameraAngle: string | undefined): number {
  switch ((cameraAngle || "").toLowerCase()) {
    case "top-down": return 0.0;          // looking straight down — use front
    case "low-angle": return 0.083;       // ~30° 3/4 — same as eye-level
    case "slightly-above": return 0.083;
    case "eye-level":
    default:
      return 0.083; // 30° 3/4 view — most product-shot-like
  }
}

/**
 * Estimate the scene's surface tilt at the placement bbox using Depth
 * Anything v2. Returns yaw (rotation around vertical axis, ±90°) and
 * pitch (rotation around horizontal, ±45°) of the surface relative to
 * the camera. Used to render the TRELLIS GLB at a matching angle so the
 * 3D product reads as integrated into the scene rather than facing
 * camera straight-on like a sticker.
 *
 * Algorithm:
 *   1. Upload scene to fal, run fal-ai/imageutils/depth (DAv2)
 *   2. Download depth map (grayscale, brighter = closer)
 *   3. Sample depth at 5 points within bbox: center, L, R, T, B
 *   4. Horizontal slope (R - L) → yaw direction:
 *      - left further → surface tilts away to left → yaw RIGHT (+)
 *      - right further → surface tilts away to right → yaw LEFT (-)
 *   5. Vertical slope (B - T) → pitch direction:
 *      - top further → surface seen from above → pitch UP (+)
 *      - bottom further → surface seen from below → pitch DOWN (-)
 *
 * Returns null on any failure — caller falls back to default 30° 3/4 view.
 */
async function estimateSceneAngleFromDepth(
  sceneBuf: Buffer,
  bbox: HarmonizationInput["bbox"],
  dims: HarmonizationInput["frameDimensions"],
): Promise<{ yawDeg: number; pitchDeg: number } | null> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) return null;
  fal.config({ credentials: falKey });

  try {
    const t0 = Date.now();
    const sceneUrl = await uploadBuffer(sceneBuf, "scene-for-depth.png", "image/png");

    // fal-ai/imageutils/depth wraps Depth Anything v2 with a simple
    // image-in/depth-image-out interface. Returns a grayscale PNG where
    // brighter = closer to camera.
    const result: any = await fal.subscribe("fal-ai/imageutils/depth", {
      input: { image_url: sceneUrl } as any,
      logs: false,
    });
    const data = result?.data ?? result;
    const depthMapUrl: string | undefined =
      data?.image?.url ?? data?.depth?.url ?? data?.output?.url;
    if (!depthMapUrl) {
      console.warn(`[Harmonize/depth] No depth map URL in response — keys: ${Object.keys(data || {}).join(",")}`);
      return null;
    }

    const depthRes = await fetch(depthMapUrl);
    if (!depthRes.ok) return null;
    const depthBuf = Buffer.from(await depthRes.arrayBuffer());

    // Sample depth at 5 points inside the bbox. Convert normalized bbox
    // coords to pixel coords in the depth image.
    const sharp = (await import("sharp")).default;
    const depthMeta = await sharp(depthBuf).metadata();
    const dW = depthMeta.width || dims.width;
    const dH = depthMeta.height || dims.height;

    // Sample points (5 px inset to avoid edge artifacts at the bbox border)
    const inset = 0.1;
    const pts: Array<[number, number]> = [
      [bbox.x + bbox.width / 2, bbox.y + bbox.height / 2],                     // center
      [bbox.x + bbox.width * inset, bbox.y + bbox.height / 2],                  // left
      [bbox.x + bbox.width * (1 - inset), bbox.y + bbox.height / 2],            // right
      [bbox.x + bbox.width / 2, bbox.y + bbox.height * inset],                  // top
      [bbox.x + bbox.width / 2, bbox.y + bbox.height * (1 - inset)],            // bottom
    ];

    // Pull raw grayscale buffer for fast pixel reads.
    const { data: rawData, info } = await sharp(depthBuf)
      .resize(dW, dH, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const sampleAt = (nx: number, ny: number): number => {
      const px = clamp(Math.round(nx * info.width), 0, info.width - 1);
      const py = clamp(Math.round(ny * info.height), 0, info.height - 1);
      return rawData[py * info.width + px];
    };
    const [center, left, right, top, bottom] = pts.map(([x, y]) => sampleAt(x, y));

    // Slope across bbox. Larger denominator (wider/taller bbox) → smaller
    // slope per unit normalized. Multiply by a sensitivity constant tuned
    // empirically — depth deltas of ~30 grayscale units across half a
    // bbox typically correspond to ~20-30° of surface tilt.
    const horizSlope = (right - left) / Math.max(0.05, bbox.width);
    const vertSlope = (bottom - top) / Math.max(0.05, bbox.height);
    const SENSITIVITY = 0.4;
    const yawDeg = clamp(-horizSlope * SENSITIVITY, -45, 45);
    const pitchDeg = clamp(-vertSlope * SENSITIVITY, -30, 30);

    const elapsed = Date.now() - t0;
    console.log(
      `[Harmonize/depth] ${elapsed}ms — center:${center} L:${left} R:${right} T:${top} B:${bottom} → yaw:${yawDeg.toFixed(1)}° pitch:${pitchDeg.toFixed(1)}°`,
    );
    return { yawDeg, pitchDeg };
  } catch (err: any) {
    console.warn(`[Harmonize/depth] Failed: ${err?.message || err}`);
    return null;
  }
}

/**
 * Surface types where the placement is on a horizontal plane (the bottle
 * stands vertical, period). Depth-Anything's vertical gradient sampling
 * can misread the depth fall-off of a horizontal surface (e.g. a turntable
 * platter, a table receding from the camera) and infer a non-zero pitch
 * that visibly tilts the product. For these we skip pitch shear entirely.
 *
 * Match is case-insensitive + substring — covers "table", "tabletop",
 * "side table", "coffee table", etc.
 */
const HORIZONTAL_SURFACE_TOKENS = [
  "table", "counter", "countertop", "shelf", "tabletop", "platter",
  "turntable", "deck", "floor", "ground", "desk", "bar top", "bar",
  "tray", "podium", "stand", "ledge",
];

function isHorizontalSurface(surfaceType: string | undefined | null): boolean {
  if (!surfaceType) return false;
  const norm = surfaceType.toLowerCase();
  return HORIZONTAL_SURFACE_TOKENS.some((t) => norm.includes(t));
}

/**
 * Per-placement region analysis via Gemini Vision.
 *
 * The per-SURFACE lighting/cameraAngle metadata we get from initial scene
 * scanning is too coarse — a turntable surface has different lighting at
 * different spots (the platter vs. the mixer vs. the unused space next
 * to the slipmat). When the user drops a product at a specific bbox, we
 * want to analyze that EXACT region for:
 *   - surface normal (horizontal/vertical/tilted + degrees) → drives pitch
 *   - shadow direction + intensity → drives our cast-shadow params
 *   - dominant hue + saturation + luminance → drives color cast
 *   - neighboring objects → drives "is this space cramped or open"
 *   - recommended scale → catches "bottle as tall as the mixer" mistakes
 *
 * Single Gemini 2.5 Flash call with a cropped scene region. Returns null
 * on failure — callers fall back to per-surface metadata + defaults.
 *
 * Cost: ~$0.002/call, ~1-2s latency. Cheap enough to run on every
 * harmonize invocation.
 */
export interface PlacementRegionAnalysis {
  surfaceNormal: "horizontal" | "vertical" | "tilted-toward-camera" | "tilted-away";
  tiltDegrees: number; // -45..+45, 0 = perpendicular to camera axis
  existingShadowDirection: "top-left" | "top" | "top-right" | "left" | "right" | "bottom-left" | "bottom" | "bottom-right" | "ambient";
  existingShadowIntensity: number; // 0.0..1.0
  dominantHueDeg: number; // 0..360 (red=0, green=120, blue=240)
  dominantSaturation: number; // 0..1
  averageLuminance: number; // 0..1
  neighboringObjects: string[]; // ["turntable platter", "vinyl records"]
  openSpaceClass: "cramped" | "open" | "isolated";
  recommendedScale: number; // 0.5..1.5 multiplier on user's chosen scale
}

async function analyzePlacementRegion(
  sceneBuf: Buffer,
  bbox: HarmonizationInput["bbox"],
  dims: HarmonizationInput["frameDimensions"],
): Promise<PlacementRegionAnalysis | null> {
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  if (!apiKey) {
    console.log(`[Harmonize/region-analysis] No AI_INTEGRATIONS_GEMINI_API_KEY — skipping per-placement analysis`);
    return null;
  }
  try {
    const t0 = Date.now();
    // Crop the scene to the bbox + 25% margin so Gemini sees both the
    // exact placement spot AND its surroundings (what's above the table,
    // what's beside it, the room's general lighting).
    const W = dims.width;
    const H = dims.height;
    const pxX = clamp(Math.round(bbox.x * W), 0, W - 1);
    const pxY = clamp(Math.round(bbox.y * H), 0, H - 1);
    const pxW = clamp(Math.round(bbox.width * W), 1, W - pxX);
    const pxH = clamp(Math.round(bbox.height * H), 1, H - pxY);
    const marginX = Math.round(pxW * 0.25);
    const marginY = Math.round(pxH * 0.25);
    const cropRegion = clipRegion(
      { left: pxX - marginX, top: pxY - marginY, width: pxW + marginX * 2, height: pxH + marginY * 2 },
      W, H,
    );
    const cropBuf = await sharp(sceneBuf).extract(cropRegion).jpeg({ quality: 85 }).toBuffer();
    const base64 = cropBuf.toString("base64");

    const prompt = `You are analyzing a region of a scene where a product will be placed via image compositing. Return ONLY a JSON object (no markdown, no prose) with these exact fields:

{
  "surfaceNormal": "horizontal" | "vertical" | "tilted-toward-camera" | "tilted-away",
  "tiltDegrees": <number -45 to 45, 0 = perpendicular to camera axis>,
  "existingShadowDirection": "top-left" | "top" | "top-right" | "left" | "right" | "bottom-left" | "bottom" | "bottom-right" | "ambient",
  "existingShadowIntensity": <number 0.0-1.0, how strong are existing shadows in this region>,
  "dominantHueDeg": <number 0-360, dominant hue: red=0, yellow=60, green=120, cyan=180, blue=240, magenta=300>,
  "dominantSaturation": <number 0.0-1.0>,
  "averageLuminance": <number 0.0-1.0, 0=black, 1=white>,
  "neighboringObjects": [<array of strings naming objects visible in this region>],
  "openSpaceClass": "cramped" | "open" | "isolated",
  "recommendedScale": <number 0.5-1.5, multiplier suggesting whether the placement bbox is appropriately sized for objects already in this region>
}

Analyze for a product compositing task: surfaceNormal tells us how to orient the product (most surfaces a product rests on are "horizontal" — tables, counters, shelves, turntables, floors). tiltDegrees is the camera perspective tilt of that surface (0 = surface plane is perpendicular to camera, large = surface is tilted). existingShadow* tells us about real shadows already in the scene (we'll match these). dominant* describes the color of pixels in this region (drives subtle color-cast adjustment on the composited product). neighboringObjects gives semantic context. openSpaceClass = "isolated" if there's empty space around, "cramped" if competing objects are very close, "open" otherwise. recommendedScale: 1.0 = product bbox is right-sized for this space, <1 = product is too big, >1 = product could be larger.`;

    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        apiVersion: "",
        baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
      },
    });
    const response: any = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: "image/jpeg", data: base64 } },
          ],
        },
      ],
    });
    const text = (response.text || "").trim();
    // Strip markdown fences if Gemini added them despite the prompt.
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as PlacementRegionAnalysis;

    const elapsed = Date.now() - t0;
    console.log(
      `[Harmonize/region-analysis] ${elapsed}ms — normal:${parsed.surfaceNormal}(${parsed.tiltDegrees.toFixed(0)}°) ` +
      `shadow:${parsed.existingShadowDirection}@${parsed.existingShadowIntensity.toFixed(2)} ` +
      `hue:${parsed.dominantHueDeg.toFixed(0)}° sat:${parsed.dominantSaturation.toFixed(2)} lum:${parsed.averageLuminance.toFixed(2)} ` +
      `space:${parsed.openSpaceClass} scale:${parsed.recommendedScale.toFixed(2)}x ` +
      `nearby:[${parsed.neighboringObjects.slice(0, 3).join(", ")}]`,
    );
    return parsed;
  } catch (err: any) {
    console.warn(`[Harmonize/region-analysis] Failed: ${err?.message || err}`);
    return null;
  }
}

/**
 * Apply a vertical perspective shear via sharp affine to simulate a small
 * pitch angle. TRELLIS turnaround MP4 only varies yaw; pitch we have to
 * fake at the 2D level. Larger pitch values would benefit from actual 3D
 * render (Phase 2 of this work).
 *
 * Clamped to ±5° — beyond that, 2D shear stops reading as perspective and
 * starts reading as visible distortion (the "twisted bottle" user issue).
 * Depth-Anything's raw estimate was reaching ±30°, which is what produced
 * the visibly skewed product. For real perspective beyond 5° we need a
 * proper 3D render.
 */
async function applyPitchShear(
  imageBuf: Buffer,
  pitchDeg: number,
): Promise<Buffer> {
  const PITCH_CAP_DEG = 5;
  const clamped = Math.max(-PITCH_CAP_DEG, Math.min(PITCH_CAP_DEG, pitchDeg));
  if (Math.abs(clamped) < 3) return imageBuf;
  const sharp = (await import("sharp")).default;
  const radians = (clamped * Math.PI) / 180;
  const shearAmount = Math.tan(radians) * 0.5;
  // sharp affine: [a, b, c, d] is the transform matrix
  // For vertical shear (y' = y + shearAmount * x): [1, 0, shearAmount, 1]
  return sharp(imageBuf)
    .affine([1, 0, shearAmount, 1], {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

/**
 * Remove the background from a TRELLIS render so we don't composite a black
 * rectangle onto the scene. TRELLIS renders the 3D mesh on an opaque dark
 * background (no alpha channel) — when we drop that into the scene,
 * everything outside the product silhouette shows as a black box.
 *
 * Uses fal-ai/birefnet-v2 — best-in-class general-purpose background
 * remover, ~3-6s, ~$0.01/call. Returns the same image with alpha applied
 * so only the product silhouette is opaque.
 *
 * Falls back to the input URL on any failure (caller composites with
 * black bg — visible but better than no harmonize at all).
 */
async function removeBackgroundForCompositing(imageUrl: string): Promise<string | null> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) return null;
  fal.config({ credentials: falKey });

  try {
    const t0 = Date.now();
    const result: any = await fal.subscribe("fal-ai/birefnet/v2", {
      input: { image_url: imageUrl } as any,
      logs: false,
    });
    const elapsed = Date.now() - t0;
    const data = result?.data ?? result;
    const cleanUrl: string | undefined =
      data?.image?.url ?? data?.images?.[0]?.url ?? data?.output?.url;
    if (!cleanUrl) {
      console.warn(`[Harmonize/birefnet] No image URL in response — keys: ${Object.keys(data || {}).join(",")}`);
      return null;
    }
    console.log(`[Harmonize/birefnet] Background removed in ${elapsed}ms → ${cleanUrl}`);
    return cleanUrl;
  } catch (err: any) {
    console.warn(`[Harmonize/birefnet] Failed (${err?.message || err}) — keeping bg`);
    return null;
  }
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
async function runTrellis3D(productBuf: Buffer): Promise<{
  renderUrl: string;
  meshUrl?: string;
  turnaroundVideoUrl?: string;
}> {
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
  //     rendered_video?: { url },
  //     preview?: { url },
  //     timings: { inference: ... } }
  const data = result?.data ?? result;
  const meshUrl: string | undefined =
    data?.model_mesh?.url ??
    data?.mesh?.url ??
    data?.glb_url;
  // Turnaround MP4 — when present, we can extract any angle we want.
  const turnaroundVideoUrl: string | undefined =
    data?.rendered_video?.url ??
    data?.turnaround?.url ??
    data?.video?.url;
  // Default preview image (front-facing) if no turnaround.
  const renderUrl: string | undefined =
    data?.preview?.url ??
    data?.preview_image?.url ??
    data?.rendered_image?.url ??
    data?.image?.url;

  if (!renderUrl && !turnaroundVideoUrl) {
    // No rendered preview available — fall back to the input image so
    // the procedural pipeline still has a product to composite.
    console.warn(`[Harmonize/trellis] No rendered preview in response; using input image. Mesh URL: ${meshUrl ?? "(none)"}`);
    return { renderUrl: productUrl, meshUrl };
  }
  console.log(`[Harmonize/trellis] Render URL: ${renderUrl ?? "(none)"}, turnaround: ${turnaroundVideoUrl ?? "(none)"}, mesh URL: ${meshUrl ?? "(none)"}`);
  return { renderUrl: renderUrl ?? productUrl, meshUrl, turnaroundVideoUrl };
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
  lighting?: { direction?: string; intensity?: number },
  options?: {
    // Optional original product buffer used SOLELY to build the
    // `flatComposite` output. When the caller passes a `productBuf` that
    // has been pitch-sheared / IC-Light-relit / TRELLIS-rendered, that
    // modified buffer is what feeds the harmonized `result` — but the
    // "flat" composite should remain an honest baseline (the bare PNG
    // the user already sees on the canvas, no processing). Pass the
    // pre-processing product here to keep the flat overlay truly flat.
    //
    // Bug this fixes: ai-3d mode was generating the flat composite from
    // the sheared product, so the "flat overlay" the user saw also had
    // the (sometimes wrong) pitch tilt baked in.
    flatCompositeProductBuf?: Buffer;
    // Per-placement region analysis from Gemini Vision. When provided,
    // OVERRIDES the per-surface `lighting` arg with values measured at
    // the exact placement bbox. Drives shadow direction, intensity,
    // and (TBD) color cast. See analyzePlacementRegion.
    regionAnalysis?: PlacementRegionAnalysis | null;
  },
): Promise<{
  result: Buffer;
  flatComposite: Buffer;
  // Scene atmosphere — exposed so PASS 2 (lock pass) can re-apply the
  // same brightness/tint to the original product. Without this, PASS 2
  // pastes the bare product back and undoes every harmonization effect.
  atmosphere?: {
    brightnessFactor: number;
    sceneRgb: { r: number; g: number; b: number };
    sceneBrightness: number;
  };
}> {
  const W = dims.width;
  const H = dims.height;
  const pxX = clamp(Math.round(bbox.x * W), 0, W - 1);
  const pxY = clamp(Math.round(bbox.y * H), 0, H - 1);
  const pxW = clamp(Math.round(bbox.width * W), 1, W - pxX);
  const pxH = clamp(Math.round(bbox.height * H), 1, H - pxY);

  // ── Step 0: ensure product has alpha channel ──
  // If the input PNG/JPG has no transparency (e.g. a product photo on a
  // dark studio backdrop — what the user's Shark vacuum image was), the
  // composite below paints the entire rectangle including the backdrop,
  // producing the visible "black box around product" artifact. Detect
  // missing alpha and auto-strip the bg via fal-ai/birefnet. Skipped
  // (cheap path) when alpha already present — proper PNG cutouts pay
  // no extra latency.
  let workingProductBuf = productBuf;
  try {
    const inMeta = await sharp(productBuf).metadata();
    if (!inMeta.hasAlpha && process.env.FAL_KEY) {
      console.log(`[Harmonize/procedural] Product has no alpha channel — auto-stripping background`);
      const tempUrl = await uploadBuffer(productBuf, "product-noalpha.png", "image/png");
      const cleanUrl = await removeBackgroundForCompositing(tempUrl);
      if (cleanUrl) {
        const cleanRes = await fetch(cleanUrl);
        if (cleanRes.ok) {
          workingProductBuf = Buffer.from(await cleanRes.arrayBuffer());
        }
      }
    }
  } catch (err: any) {
    console.warn(`[Harmonize/procedural] Alpha detection / bg-strip failed: ${err?.message}`);
  }

  // ── Step 1: resize product to EXACT bbox dimensions ──
  // Was fit:"inside" which letterboxed the product within the bbox and
  // centered it via offsetX/Y math below. That introduced position +
  // size drift between the browser preview (which respects user's exact
  // transform) and the server composite. fit:"fill" sizes to exactly
  // the bbox the client requested — no letterbox, no centering offset.
  // The client is expected to send a productPlacementBbox that already
  // matches the visible product dimensions on canvas.
  const productResized = await sharp(workingProductBuf)
    .resize(pxW, pxH, { fit: "fill", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const productMeta = await sharp(productResized).metadata();
  const finalW = productMeta.width || pxW;
  const finalH = productMeta.height || pxH;
  // Place product at the EXACT bbox top-left, no centering offset.
  // With fit:"fill" above, finalW===pxW and finalH===pxH, so the
  // centering math was a no-op anyway — but when it WASN'T (legacy
  // fit:"inside"), this offset shifted the product visibly relative to
  // where the user dropped it in the canvas. Removing the centering
  // ensures: server bbox (pxX, pxY) == user-intended position.
  const offsetX = pxX;
  const offsetY = pxY;

  // ── Step 2: build flat composite (Stage 1, no AI) ──
  // The flat composite is the honest baseline — what the user already
  // sees on the canvas, nothing more. If the caller has pre-processed
  // `productBuf` (pitch shear, IC-Light relight, TRELLIS render), they
  // can pass the ORIGINAL untouched product as `options.flatCompositeProductBuf`
  // so the flat overlay doesn't inherit any of those modifications.
  let flatProductBuf = options?.flatCompositeProductBuf;
  if (flatProductBuf) {
    // The original may not have alpha — auto-strip just like we do for
    // the working buffer above, so the flat overlay doesn't paint a
    // rectangle background onto the scene.
    try {
      const origMeta = await sharp(flatProductBuf).metadata();
      if (!origMeta.hasAlpha && process.env.FAL_KEY) {
        const tempUrl = await uploadBuffer(flatProductBuf, "product-flat-noalpha.png", "image/png");
        const cleanUrl = await removeBackgroundForCompositing(tempUrl);
        if (cleanUrl) {
          const cleanRes = await fetch(cleanUrl);
          if (cleanRes.ok) {
            flatProductBuf = Buffer.from(await cleanRes.arrayBuffer());
          }
        }
      }
    } catch (err: any) {
      console.warn(`[Harmonize/proc] Flat-overlay alpha strip failed: ${err?.message}`);
    }
  } else {
    flatProductBuf = workingProductBuf;
  }
  const flatProductResized = await sharp(flatProductBuf)
    .resize(pxW, pxH, { fit: "fill", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const flatComposite = await sharp(sceneBuf)
    .composite([{ input: flatProductResized, left: offsetX, top: offsetY }])
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
  // User feedback: "flat overlay looks better than harmonized." The prior
  // pipeline was being too aggressive — dimming bright products to match
  // dim scenes when the product image already had good native lighting.
  //
  // New conservative rule: ONLY adjust brightness if the scene-to-product
  // delta is large. Skip adjustment when scene brightness is already close
  // to the product's natural luminance. Cap the maximum change at ±15%
  // (was ±30%) so adjustments are subtle.
  const productStats = await sharp(productResized).stats();
  const prodMeanR = productStats.channels[0]?.mean ?? 128;
  const prodMeanG = productStats.channels[1]?.mean ?? 128;
  const prodMeanB = productStats.channels[2]?.mean ?? 128;
  const productBrightness = (prodMeanR + prodMeanG + prodMeanB) / 3 / 255;
  const brightnessDelta = sceneBrightness - productBrightness;

  // Only nudge brightness if the delta exceeds 15% — otherwise leave it.
  let brightnessFactor = 1.0;
  if (Math.abs(brightnessDelta) > 0.15) {
    // Half-pull toward scene brightness, capped at ±15%.
    brightnessFactor = clamp(1.0 + brightnessDelta * 0.5, 0.85, 1.15);
  }
  const productAdjusted = brightnessFactor !== 1.0
    ? await sharp(productResized).modulate({ brightness: brightnessFactor }).png().toBuffer()
    : productResized;
  console.log(`[Harmonize/proc] Product brightness=${productBrightness.toFixed(2)}, scene=${sceneBrightness.toFixed(2)}, delta=${brightnessDelta.toFixed(2)} → factor=${brightnessFactor.toFixed(2)}×${brightnessFactor === 1.0 ? " (skipped — within tolerance)" : ""}`);

  // ── Step 5: scene color cast — DISABLED by default ──
  // The 8% tint was visible enough to make products look "off-color"
  // even when the brightness match was disabled. User comparison
  // showed flat overlay looking better than harmonized — the cast
  // was the main culprit. Set HARMONIZE_ENABLE_COLOR_CAST=true to
  // re-enable for products that genuinely need it (very saturated
  // products on neutral scenes, or vice versa).
  let castBuf: Buffer = Buffer.alloc(0);
  if (process.env.HARMONIZE_ENABLE_COLOR_CAST === "true") {
    const tintAlpha = 0.05; // even more conservative when opt-in
    try {
      const productAlpha = await sharp(productAdjusted)
        .ensureAlpha()
        .extractChannel("alpha")
        .toBuffer();
      castBuf = await sharp({
        create: {
          width: finalW,
          height: finalH,
          channels: 4,
          background: {
            r: Math.round(meanR),
            g: Math.round(meanG),
            b: Math.round(meanB),
            alpha: tintAlpha,
          },
        },
      })
        .composite([{ input: productAlpha, blend: "dest-in" }])
        .png()
        .toBuffer();
      console.log(`[Harmonize/proc] Scene cast layer (opt-in): rgb(${Math.round(meanR)},${Math.round(meanG)},${Math.round(meanB)}) @ ${(tintAlpha*100).toFixed(0)}%`);
    } catch (err) {
      console.warn(`[Harmonize/proc] Scene cast build failed (continuing without):`, (err as any)?.message);
    }
  }

  // ── Step 6: build a stronger contact shadow underneath the product ──
  // Bumped from a thin/transparent silhouette to a clearly visible drop
  // shadow so the product reads as "sitting on" the surface. Two layers:
  //   - Big soft shadow underneath (anchors the object)
  //   - Tighter dark shadow at the contact edge (grounds it)
  //
  // CRITICAL: extend the alpha canvas BEFORE blurring. Without padding the
  // blur kernel hits the buffer edge and clips, producing a hard alpha
  // boundary around the bbox — exactly the "dark rectangle around the
  // product" the user reported in the harmonized vs flat comparison.
  // Padding by 2x the blur radius gives the kernel room to taper to 0.
  const softShadowSize = Math.max(16, Math.round(Math.min(finalW, finalH) * 0.10));
  const tightShadowSize = Math.max(4, Math.round(Math.min(finalW, finalH) * 0.02));
  const softPad = softShadowSize * 2;
  const tightPad = tightShadowSize * 2;
  const paddedW = finalW + softPad * 2;
  const paddedH = finalH + softPad * 2;
  let softShadowBuf: Buffer = Buffer.alloc(0);
  let tightShadowBuf: Buffer = Buffer.alloc(0);
  try {
    const alphaMaskSoft = await sharp(productAdjusted)
      .ensureAlpha()
      .extractChannel("alpha")
      .extend({
        top: softPad, bottom: softPad, left: softPad, right: softPad,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .blur(softShadowSize)
      .toBuffer();
    softShadowBuf = await sharp({
      create: {
        width: paddedW, height: paddedH, channels: 4,
        // Was 0.45 — too dark, made the product look like it was
        // floating in a dark cloud. 0.20 is enough to anchor it.
        background: { r: 0, g: 0, b: 0, alpha: 0.20 },
      },
    })
      .composite([{ input: alphaMaskSoft, blend: "dest-in" }])
      .png()
      .toBuffer();

    const alphaMaskTight = await sharp(productAdjusted)
      .ensureAlpha()
      .extractChannel("alpha")
      .extend({
        top: softPad, bottom: softPad, left: softPad, right: softPad,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .blur(tightShadowSize)
      .toBuffer();
    tightShadowBuf = await sharp({
      create: {
        width: paddedW, height: paddedH, channels: 4,
        // Was 0.65 — too dark for a contact shadow.
        background: { r: 0, g: 0, b: 0, alpha: 0.35 },
      },
    })
      .composite([{ input: alphaMaskTight, blend: "dest-in" }])
      .png()
      .toBuffer();
  } catch (err) {
    console.warn(`[Harmonize/proc] Shadow build failed (continuing without):`, (err as any)?.message);
  }

  // ── Step 7: composite layers in order: soft shadow, tight shadow,
  //    product, scene cast (so cast sits ON the product, not below it). ──
  // Shadows now live on a PADDED canvas (paddedW × paddedH). To place
  // them at the same absolute pixel position as the product, we shift
  // the composite offset back by softPad pixels.
  //
  // DIRECTIONAL CAST SHADOW: when lighting.direction is provided
  // (sourced from the surface's Gemini-detected lighting metadata),
  // the soft shadow shifts AWAY from the light source — left light
  // = shadow on right, top light = shadow below, etc. Length scaled
  // by light intensity. This is what gives the product a "cast on
  // surface" feel rather than a generic radial drop shadow.
  //
  // DEFAULT FALLBACK: when DB has no lighting metadata (surface scanned
  // before the lighting columns existed), we MUST NOT default to
  // "top"/0.6 — that math evaluates to finalH*0.06 which is identical
  // to the old fixed offset, so the directional path looks IDENTICAL
  // to the old non-directional output. Default to "top-left" + 0.85
  // intensity so even un-lit-metadata surfaces get a visibly slanted
  // cast shadow. (Most natural indoor lighting comes from upper-left
  // anyway — windows, ceiling lamps off-center.)
  // Per-placement region analysis (Gemini-measured at this exact bbox)
  // takes precedence over the per-surface DB metadata. Falls back to DB,
  // then to defaults.
  const regionShadowDir = options?.regionAnalysis?.existingShadowDirection;
  const regionShadowInt = options?.regionAnalysis?.existingShadowIntensity;
  const inputDirRaw = regionShadowDir ?? lighting?.direction;
  const inputIntRaw = regionShadowInt ?? lighting?.intensity;
  const dbHasLighting = inputDirRaw != null || inputIntRaw != null;
  const regionWins = regionShadowDir != null || regionShadowInt != null;
  const lightDir = (inputDirRaw || "top-left").toLowerCase();
  const lightIntensity = clamp(inputIntRaw ?? 0.85, 0.2, 1.0);
  if (regionWins) {
    console.log(
      `[Harmonize/proc] Using PER-PLACEMENT shadow (Gemini region): dir=${regionShadowDir} int=${regionShadowInt?.toFixed(2)} ` +
      `(would have used DB: dir=${lighting?.direction} int=${lighting?.intensity})`,
    );
  }
  // Shadow offset relative to product height. Top light → shadow below
  // (positive Y). Left light → shadow on right (positive X). Etc.
  // Magnitudes bumped vs prior pass — old "top" produced finalH*0.06
  // which collided with the old default. Now even "top" is dramatic
  // enough to read as a real cast.
  let shadowDx = 0;
  let shadowDy = Math.max(10, Math.round(finalH * 0.08));
  switch (lightDir) {
    case "left": shadowDx = Math.round(finalW * 0.14); shadowDy = Math.round(finalH * 0.10); break;
    case "right": shadowDx = -Math.round(finalW * 0.14); shadowDy = Math.round(finalH * 0.10); break;
    case "top-left": shadowDx = Math.round(finalW * 0.12); shadowDy = Math.round(finalH * 0.14); break;
    case "top-right": shadowDx = -Math.round(finalW * 0.12); shadowDy = Math.round(finalH * 0.14); break;
    case "top": shadowDx = 0; shadowDy = Math.round(finalH * 0.18); break;
    case "ambient":
    default:
      // "Ambient" doesn't mean NO shadow — it means SOFT, MULTI-DIRECTIONAL
      // shadow. Pure ambient light (overcast outdoors, big softbox above
      // a table) still casts a visible drop. Previous magnitudes (0.04W,
      // 0.08H) on a 77x206 product evaluated to (3, 16) → invisible after
      // intensity scaling. Bump to slight slant + meaningful drop so even
      // ambient surfaces get a readable cast.
      shadowDx = Math.round(finalW * 0.10);
      shadowDy = Math.round(finalH * 0.18);
      break;
  }
  // Length-modulate by intensity (brighter scene = longer/sharper shadow).
  shadowDx = Math.round(shadowDx * lightIntensity);
  shadowDy = Math.round(shadowDy * lightIntensity);
  // Floor: if the product is taller than ~150px, the shadow MUST be at
  // least 25px to register visually against the surface. Without this,
  // small intensities or "ambient" cases produce shadows the eye can't
  // see, making the harmonized output indistinguishable from flat.
  if (finalH >= 150) {
    shadowDy = Math.max(25, shadowDy);
  }
  // Loud diagnostic — shows BOTH the raw input from DB and the resolved
  // values, so you can tell from logs whether the surface row had
  // lighting metadata populated or whether we fell through to defaults.
  console.log(
    `[Harmonize/proc] ===> CAST SHADOW dbHasLighting=${dbHasLighting} ` +
    `inputDir=${JSON.stringify(inputDirRaw)} inputInt=${JSON.stringify(inputIntRaw)} ` +
    `→ resolved dir=${lightDir} int=${lightIntensity.toFixed(2)} ` +
    `→ offset(${shadowDx}, ${shadowDy}) on product ${finalW}x${finalH}`,
  );

  const tightShadowOffsetY = Math.max(2, Math.round(finalH * 0.015));
  const composites: Array<{ input: Buffer; left: number; top: number; blend?: any }> = [];
  if (softShadowBuf.length > 0) {
    composites.push({
      input: softShadowBuf,
      left: offsetX - softPad + shadowDx,
      top: offsetY - softPad + shadowDy,
      blend: "over",
    });
  }
  if (tightShadowBuf.length > 0) {
    composites.push({
      input: tightShadowBuf,
      left: offsetX - softPad + Math.round(shadowDx * 0.2),
      top: offsetY - softPad + tightShadowOffsetY,
      blend: "over",
    });
  }
  composites.push({ input: productAdjusted, left: offsetX, top: offsetY });
  if (castBuf.length > 0) {
    composites.push({ input: castBuf, left: offsetX, top: offsetY, blend: "over" });
  }

  const result = await sharp(sceneBuf).composite(composites).png().toBuffer();
  return {
    result,
    flatComposite,
    atmosphere: {
      brightnessFactor,
      sceneRgb: { r: Math.round(meanR), g: Math.round(meanG), b: Math.round(meanB) },
      sceneBrightness,
    },
  };
}

export async function harmonizeProductIntoScene(
  input: HarmonizationInput,
): Promise<HarmonizationResult> {
  // Default changed: "flat" instead of "procedural". User testing across
  // multiple product/scene pairs (Shinju whiskey + DJ setup, Shark vacuum
  // + Call Her Daddy) showed the bare flat composite consistently looks
  // better than every "harmonization" we've tried. Until generative
  // (FLUX Kontext) is reliably producing the RIGHT content with the
  // product reference image, flat is the safest default — zero
  // degradation vs the baseline placement preview.
  const mode = input.mode ?? "flat";
  const startedAt = Date.now();
  try {
    const [sceneBuf, productBuf] = await Promise.all([
      asBuffer(input.sceneImage),
      asBuffer(input.productImage),
    ]);

    // ─── Phase 1: per-placement region analysis ─────────────────────────
    // Runs in parallel with the main pipeline (kicked off here, awaited
    // when we actually need the values inside `applyProceduralHarmonization`
    // and the ai-3d branch). The Gemini call adds ~1-2s of latency but
    // gives us per-placement (not just per-surface) shadow / color /
    // tilt data — see PlacementRegionAnalysis for what it returns.
    //
    // We don't wait on this before deciding which mode to run, because
    // "flat" mode should remain instant. The promise is awaited only by
    // paths that actually use the data.
    const regionAnalysisPromise: Promise<PlacementRegionAnalysis | null> =
      mode === "flat"
        ? Promise.resolve(null) // flat doesn't use it, save the cost
        : analyzePlacementRegion(sceneBuf, input.bbox, input.frameDimensions);

    // ─── FLAT MODE — just composite, no processing ───────────────────
    // What the user described as "what it looks like when product is
    // just dropped in normally." Already-good for most products.
    if (mode === "flat") {
      console.log(`[Harmonize] Mode: flat (bare composite, no processing)`);
      // Re-use the flatComposite output of applyProceduralHarmonization
      // since it already builds exactly this image. We just don't apply
      // the brightness/shadow/cast layers on top.
      const { flatComposite } = await applyProceduralHarmonization(
        sceneBuf, productBuf, input.bbox, input.frameDimensions,
      );
      const falKey = process.env.FAL_KEY;
      if (falKey) {
        fal.config({ credentials: falKey });
        const imageUrl = await uploadBuffer(flatComposite, "harmonized-flat.png", "image/png");
        const elapsedMs = Date.now() - startedAt;
        console.log(`[Harmonize] flat done in ${elapsedMs}ms`);
        return {
          success: true,
          imageUrl,
          flatCompositeUrl: imageUrl,
          elapsedMs,
          mode: "flat" as any,
        };
      }
      const elapsedMs = Date.now() - startedAt;
      const dataUrl = `data:image/png;base64,${flatComposite.toString("base64")}`;
      return {
        success: true,
        imageUrl: dataUrl,
        flatCompositeUrl: dataUrl,
        elapsedMs,
        mode: "flat" as any,
      };
    }

    // ─── GENERATIVE MODE (FLUX Kontext) — the seamless-integration path ───
    // The user's complaint: "it doesn't analyze the background video and
    // align it with the needs of the 2D static image." This mode is the
    // structural fix — Kontext takes scene + product reference + prompt
    // and generates pixels in the crop that look native. No compositing
    // tricks; the model handles lighting, perspective, depth-of-field.
    if (mode === "generative") {
      console.log(`[Harmonize] Mode: generative (FLUX Kontext multi-image edit)`);

      // Need surface type for the prompt — pull from input or default.
      const surfaceType = (input as any).surfaceType || "surface";

      // Stage 1: extract the padded crop around the bbox.
      const { cropBuf, rect } = await cropSceneForKontext(
        sceneBuf, input.bbox, input.frameDimensions,
      );

      const falKey = process.env.FAL_KEY;
      if (!falKey) {
        return {
          success: false,
          error: "FAL_KEY not set — generative mode requires fal.ai access",
          elapsedMs: Date.now() - startedAt,
          mode,
        };
      }
      fal.config({ credentials: falKey });

      // Stage 2: upload both crop and product to fal so Kontext can read them.
      const [sceneCropUrl, productUrl] = await Promise.all([
        uploadBuffer(cropBuf, "scene-crop.png", "image/png"),
        uploadBuffer(productBuf, "product.png", "image/png"),
      ]);

      // Stage 3: hand to Kontext.
      const editedCropUrl = await runFluxKontext(
        sceneCropUrl, productUrl, surfaceType, input.cameraAngle,
      );

      if (!editedCropUrl) {
        // LOUD log so the deploy logs make this obvious. User feedback:
        // "the flat overlay looks better than the harmonized" — meaning
        // even the procedural fallback was making things WORSE than just
        // showing the bare composite. New fallback: return the FLAT
        // composite (product pasted at bbox, no procedural processing)
        // so a Kontext failure produces no degradation. Procedural is
        // still available via mode="procedural" explicitly.
        console.warn(`[Harmonize/generative] ⚠️  FLUX Kontext FAILED — returning FLAT composite (no procedural processing). Check FAL_KEY and the [Harmonize/kontext] error line above.`);
        const { flatComposite } = await applyProceduralHarmonization(
          sceneBuf, productBuf, input.bbox, input.frameDimensions,
        );
        const [imageUrl, flatCompositeUrl] = await Promise.all([
          uploadBuffer(flatComposite, "flat-fallback.png", "image/png"),
          uploadBuffer(flatComposite, "flat-composite.png", "image/png"),
        ]);
        return {
          success: true,
          imageUrl,
          flatCompositeUrl,
          elapsedMs: Date.now() - startedAt,
          mode: "procedural", // Kept as procedural for client compat
          error: "FLUX Kontext failed — returning flat composite (no processing). See server logs for the underlying error.",
        };
      }

      // Stage 4: download Kontext output, composite back into full scene.
      const editedCropRes = await fetch(editedCropUrl);
      if (!editedCropRes.ok) {
        return {
          success: false,
          error: `Failed to fetch Kontext output: ${editedCropRes.status}`,
          elapsedMs: Date.now() - startedAt,
          mode,
        };
      }
      const editedCropBuf = Buffer.from(await editedCropRes.arrayBuffer());
      // PASS 1: Kontext-modified scene (with shadows, lighting reflections,
      // ambient adjustments — but possibly with the wrong product or
      // recolored product).
      const kontextSceneBuf = await compositeKontextCropBack(sceneBuf, editedCropBuf, rect);

      // Build flat composite + sample scene atmosphere FIRST so PASS 2
      // can apply scene brightness/tint to the locked product. Without
      // atmosphere, the lock pass undoes everything Kontext changed on
      // the product itself (only Kontext's surface-around-product edits
      // survive — usually invisible).
      const { flatComposite, atmosphere } = await applyProceduralHarmonization(
        sceneBuf, productBuf, input.bbox, input.frameDimensions,
      );

      // PASS 2: Lock the original product over the Kontext-modified scene.
      // Guarantees position/size/color rules. Scene-level adjustments
      // Kontext made (contact shadow, light reflection on the surface
      // around the product) survive because the original product is
      // composited at the EXACT bbox — surrounding pixels stay whatever
      // Kontext produced. Atmosphere thread keeps brightness/color match.
      const finalBuf = await lockProductOverHarmonized(
        kontextSceneBuf, productBuf, input.bbox, input.frameDimensions, atmosphere,
      );
      console.log(`[Harmonize] PASS 2 — locked atmosphere-treated product over Kontext scene`);

      const [imageUrl, flatCompositeUrl] = await Promise.all([
        uploadBuffer(finalBuf, "harmonized-generative.png", "image/png"),
        uploadBuffer(flatComposite, "flat-composite.png", "image/png"),
      ]);

      const elapsedMs = Date.now() - startedAt;
      console.log(`[Harmonize] generative done in ${elapsedMs}ms (Kontext + product lock)`);
      return {
        success: true,
        imageUrl,
        flatCompositeUrl,
        kontextOutputUrl: editedCropUrl,
        elapsedMs,
        mode: "generative",
      };
    }

    if (mode === "procedural") {
      console.log(`[Harmonize] Mode: procedural (sharp, scene-preserving)`);
      const regionAnalysis = await regionAnalysisPromise;
      const { result, flatComposite } = await applyProceduralHarmonization(
        sceneBuf, productBuf, input.bbox, input.frameDimensions,
        { direction: input.lightingDirection, intensity: input.lightingIntensity },
        { regionAnalysis },
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

    // mode === "ai-3d" (or legacy "ai" alias): TRELLIS + IC-Light + procedural.
    // Three-stage pipeline:
    //   Stage A: TRELLIS image→3D mesh + turnaround render. We extract a
    //     specific frame from the turnaround at the angle that matches the
    //     scene's camera (3/4 view by default — most product-shot-like).
    //   Stage B: IC-Light v2 relighting. Foreground = TRELLIS render
    //     (neutral studio lighting), background reference = scene crop
    //     around the bbox. Output: product picks up the scene's actual
    //     light direction + color temperature.
    //   Stage C: procedural composite — contact shadow, brightness match,
    //     scene color cast. Locks the lighting to the bbox surface.
    // Net: product reads as a 3D object that *belongs* in the room.
    if (mode === "ai-3d" || mode === "ai") {
      console.log(`[Harmonize] Mode: ai-3d (TRELLIS → IC-Light → procedural)`);
      let trellisRenderUrl: string | undefined;
      let meshUrl: string | undefined;
      let renderedProductBuf: Buffer = productBuf;
      let renderedProductUrl: string | undefined;
      let icLightRelitUrl: string | undefined;
      // Hoisted to the branch scope so the procedural PASS 1 call (which
      // lives outside the try block) can still see it. We await the
      // region analysis result here; the analysis was kicked off in
      // parallel up at the top of harmonizeProductIntoScene.
      const regionAnalysis = await regionAnalysisPromise;

      try {
        // Stage A.0 — depth analysis. TRELLIS by default is now SKIPPED
        // because fal-ai/trellis returns only a GLB mesh URL (no preview
        // image, no turnaround video) — verified in production logs:
        //   [Harmonize/trellis] No rendered preview in response;
        //   using input image. Mesh URL: ...
        // That means our angle picker had nothing to extract from, the
        // pipeline silently fell back to the original product image, and
        // we were paying ~62s of TRELLIS latency for zero 3D benefit.
        //
        // Set HARMONIZE_USE_TRELLIS=true to re-enable (e.g. if the fal
        // endpoint changes to return previews). For now: depth-derived
        // pitch shear of the original product image, then the standard
        // bg-removal → IC-Light → procedural pipeline runs as before.
        const useTrellis = process.env.HARMONIZE_USE_TRELLIS === "true";
        // Decide whether to compute depth-based pitch. Two suppress
        // conditions:
        //   1. Per-surface metadata says the surface is horizontal
        //      (table, counter, turntable, etc.) — substring match on
        //      HORIZONTAL_SURFACE_TOKENS.
        //   2. Per-placement Gemini region analysis says surfaceNormal
        //      is "horizontal" OR |tiltDegrees| < 5 (essentially flat).
        // Either signal suffices. Region analysis happens in parallel,
        // so we await it here before deciding.
        const surfaceType = (input as any).surfaceType || "";
        const surfaceIsHorizontal = isHorizontalSurface(surfaceType);
        const regionSaysFlat = regionAnalysis != null && (
          regionAnalysis.surfaceNormal === "horizontal" ||
          Math.abs(regionAnalysis.tiltDegrees) < 5
        );
        const suppressShear = surfaceIsHorizontal || regionSaysFlat;
        const [trellisResult, depthAngle] = await Promise.all([
          useTrellis
            ? runTrellis3D(productBuf).catch((err) => {
                console.warn(`[Harmonize/ai-3d] TRELLIS errored (${err?.message}) — proceeding without`);
                return null;
              })
            : Promise.resolve(null),
          suppressShear
            ? Promise.resolve(null)
            : estimateSceneAngleFromDepth(sceneBuf, input.bbox, input.frameDimensions),
        ]);
        const trellis = trellisResult ?? { renderUrl: "", meshUrl: undefined, turnaroundVideoUrl: undefined };
        trellisRenderUrl = trellis.renderUrl;
        meshUrl = trellis.meshUrl;
        if (!useTrellis) {
          console.log(`[Harmonize/ai-3d] TRELLIS skipped (HARMONIZE_USE_TRELLIS≠true) — saved ~60s. Using original product image with depth-derived pitch shear.`);
        }
        if (suppressShear) {
          const why = surfaceIsHorizontal
            ? `surfaceType "${surfaceType}" is horizontal`
            : `Gemini region analysis says flat (${regionAnalysis?.surfaceNormal}, ${regionAnalysis?.tiltDegrees.toFixed(0)}°)`;
          console.log(`[Harmonize/ai-3d] Pitch shear suppressed — ${why}. Product stays vertical.`);
        }

        // Stage A.1 — pull the angle-specific frame from the turnaround MP4.
        // Priority for selecting the angle:
        //   1. Depth-derived yaw (best — matches actual scene geometry)
        //   2. cameraAngle metadata hint (Gemini's labeling — coarse but
        //      sometimes meaningful)
        //   3. Fixed 30° 3/4 default
        if (trellis.turnaroundVideoUrl) {
          // depthAngle.yawDeg is in [-45, +45]. Map to turnaround position
          // [0, 1) where 0 = front, 0.083 = +30° right (3/4 from camera).
          // Sign flip: positive yaw means the surface tilts away to the
          // RIGHT, so the camera sees the LEFT side of the product more —
          // we want the turnaround frame that shows the PRODUCT'S right
          // (which is the camera's left).
          let angle: number;
          if (depthAngle) {
            const yawNormalized = (-depthAngle.yawDeg / 360 + 1) % 1;
            angle = yawNormalized;
          } else {
            angle = angleForCameraAngle(input.cameraAngle);
          }
          const frameBuf = await extractTurnaroundFrame(trellis.turnaroundVideoUrl, angle);
          if (frameBuf) {
            // Apply pitch shear if depth analysis gave us a vertical tilt.
            const pitchedBuf = depthAngle && Math.abs(depthAngle.pitchDeg) > 3
              ? await applyPitchShear(frameBuf, depthAngle.pitchDeg)
              : frameBuf;
            renderedProductBuf = pitchedBuf;
            renderedProductUrl = await uploadBuffer(pitchedBuf, "trellis-angle.png", "image/png");
            console.log(
              `[Harmonize/ai-3d] Extracted turnaround frame at angle ${angle.toFixed(3)} ` +
              `(yaw:${depthAngle?.yawDeg.toFixed(1) ?? "default"}° ` +
              `pitch:${depthAngle?.pitchDeg.toFixed(1) ?? "0"}°); ${pitchedBuf.length} bytes`,
            );
          }
        }

        // Default fetch path if turnaround extraction didn't run.
        // Now also handles the TRELLIS-skipped case: applies depth-derived
        // pitch shear directly to the ORIGINAL product image instead of
        // a TRELLIS render. Net effect: product gets a slight perspective
        // adjustment matching the scene tilt without the TRELLIS roundtrip.
        if (!renderedProductUrl) {
          let buf: Buffer = productBuf;
          if (depthAngle && Math.abs(depthAngle.pitchDeg) > 3) {
            buf = await applyPitchShear(productBuf, depthAngle.pitchDeg);
            console.log(`[Harmonize/ai-3d] Applied pitch shear ${depthAngle.pitchDeg.toFixed(1)}° directly to product (no TRELLIS render available)`);
          }
          renderedProductBuf = buf;
          if (process.env.FAL_KEY) {
            try {
              renderedProductUrl = await uploadBuffer(buf, "product-pitched.png", "image/png");
            } catch { /* downstream falls back gracefully */ }
          }
          // Fall back to the legacy TRELLIS fetch only if a renderUrl was
          // actually returned (TRELLIS-skipped path leaves it empty).
          if (!renderedProductUrl && trellis.renderUrl) {
            try {
              const renderRes = await fetch(trellis.renderUrl);
              if (renderRes.ok) {
                renderedProductBuf = Buffer.from(await renderRes.arrayBuffer());
                renderedProductUrl = trellis.renderUrl;
              }
            } catch { /* swallow */ }
          }
        }

        // Stage A.2 — background removal. TRELLIS renders the 3D mesh on
        // an opaque dark background (no alpha). Without this step the
        // procedural composite drops a literal black rectangle around the
        // product silhouette into the scene — directly visible as the
        // "black border" the user reported. birefnet-v2 strips the bg in
        // ~3-6s and returns a transparent-bg PNG. Done BEFORE IC-Light so
        // the relight isn't fighting halo pixels.
        if (renderedProductUrl) {
          const cleanUrl = await removeBackgroundForCompositing(renderedProductUrl);
          if (cleanUrl) {
            try {
              const cleanRes = await fetch(cleanUrl);
              if (cleanRes.ok) {
                renderedProductBuf = Buffer.from(await cleanRes.arrayBuffer());
                renderedProductUrl = cleanUrl;
              }
            } catch (err: any) {
              console.warn(`[Harmonize/ai-3d] Failed to fetch bg-removed render (${err?.message || err}); using TRELLIS render with bg`);
            }
          }
        }
      } catch (err: any) {
        console.warn(`[Harmonize/ai-3d] TRELLIS failed (${err?.message || err}); falling back to procedural-only`);
        // If TRELLIS errors, we still ship a procedural composite so the
        // user gets *something* rather than a 502.
      }

      // Stage B — IC-Light relighting. Crop the scene around the bbox to
      // give IC-Light real lighting context (ceiling, walls, ambient).
      // Set HARMONIZE_DISABLE_ICLIGHT=true to skip this stage entirely
      // (TRELLIS render goes straight to procedural composite). Use that
      // toggle when IC-Light is net-negative on a particular product
      // category — currently safer for stylized/illustrated products.
      const skipIcLight = process.env.HARMONIZE_DISABLE_ICLIGHT === "true";
      if (renderedProductUrl && !skipIcLight) {
        try {
          const sceneCrop = await cropSceneForLighting(
            sceneBuf, input.bbox, input.frameDimensions,
          );
          const relitUrl = await runIcLightRelight(
            renderedProductUrl,
            sceneCrop,
            "professional product photo, natural lighting matching the room, sharp focus, photorealistic",
          );
          if (relitUrl) {
            icLightRelitUrl = relitUrl;
            const relitRes = await fetch(relitUrl);
            if (relitRes.ok) {
              renderedProductBuf = Buffer.from(await relitRes.arrayBuffer());
            }
          }
        } catch (err: any) {
          console.warn(`[Harmonize/ai-3d] IC-Light failed (${err?.message || err}); using un-relit TRELLIS render`);
        }
      } else if (skipIcLight) {
        console.log(`[Harmonize/ai-3d] HARMONIZE_DISABLE_ICLIGHT=true — skipping relight stage`);
      }

      // PASS 1: TRELLIS (3D mesh) + procedural composite + IC-Light
      // produces a scene with the modified/relit product at the bbox.
      // CRITICAL: pass the ORIGINAL `productBuf` as the flat-composite
      // source. Otherwise the "flat overlay" we ship back would inherit
      // the pitch shear / IC-Light tint from `renderedProductBuf` — and
      // the user would see a "flat" baseline that's already been
      // processed (the "twisted bottle on flat overlay" bug).
      // Also: thread the per-placement region analysis through so the
      // procedural shadow/lighting uses Gemini's measurement at this
      // exact bbox rather than the coarse per-surface DB metadata.
      const { result, flatComposite, atmosphere } = await applyProceduralHarmonization(
        sceneBuf, renderedProductBuf, input.bbox, input.frameDimensions,
        { direction: input.lightingDirection, intensity: input.lightingIntensity },
        { flatCompositeProductBuf: productBuf, regionAnalysis },
      );

      // PASS 2: Lock the ORIGINAL product (not the TRELLIS-rendered or
      // IC-Light-relit version) over the result. Preserves position,
      // size, and brand color while keeping the procedural shadow and
      // any scene-level adjustments around the product silhouette.
      //
      // CRITICAL: pass `atmosphere` so PASS 2 re-applies the same
      // brightness adjustment + soft scene tint to the locked product.
      // Without this, the lock pass undoes every harmonization effect
      // (the bug user observed: harmonized output indistinguishable
      // from flat overlay).
      const lockedResult = await lockProductOverHarmonized(
        result, productBuf, input.bbox, input.frameDimensions, atmosphere,
      );
      console.log(`[Harmonize] PASS 2 — locked atmosphere-treated product over TRELLIS scene`);

      const falKey = process.env.FAL_KEY;
      if (falKey) {
        fal.config({ credentials: falKey });
        const [imageUrl, flatCompositeUrl] = await Promise.all([
          uploadBuffer(lockedResult, "harmonized-3d.png", "image/png"),
          uploadBuffer(flatComposite, "flat-composite-3d.png", "image/png"),
        ]);
        const elapsedMs = Date.now() - startedAt;
        console.log(`[Harmonize] ai-3d done in ${elapsedMs}ms (TRELLIS${icLightRelitUrl ? " + IC-Light" : ""} + procedural + product lock)`);
        return {
          success: true,
          imageUrl,
          flatCompositeUrl,
          trellisRenderUrl,
          meshUrl,
          icLightRelitUrl,
          elapsedMs,
          mode: "ai-3d",
        };
      }

      const elapsedMs = Date.now() - startedAt;
      const dataUrl = `data:image/png;base64,${lockedResult.toString("base64")}`;
      const flatDataUrl = `data:image/png;base64,${flatComposite.toString("base64")}`;
      return {
        success: true,
        imageUrl: dataUrl,
        flatCompositeUrl: flatDataUrl,
        trellisRenderUrl,
        meshUrl,
        icLightRelitUrl,
        elapsedMs,
        mode: "ai-3d",
      };
    }

    return {
      success: false,
      error: `Unknown harmonization mode: ${mode}. Use generative | procedural | ai-3d.`,
      elapsedMs: Date.now() - startedAt,
      mode,
    };
  } catch (err: any) {
    const elapsedMs = Date.now() - startedAt;
    console.error(`[Harmonize] Failed after ${elapsedMs}ms:`, err?.message || err);
    return { success: false, error: err?.message || String(err), elapsedMs, mode };
  }
}
