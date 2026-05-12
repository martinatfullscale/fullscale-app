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
   * "procedural" — fast (sharp-only, ~2s), no 3D awareness. Legacy.
   * "ai-3d" — TRELLIS 2D→3D mesh + multi-view render, then procedural
   *   lighting on top. Slower (~30-90s) but the product reads as a 3D
   *   object that belongs in the room rather than a flat sticker.
   * "ai" — legacy alias for "ai-3d" (used by older clients).
   * "generative" — FLUX Kontext multi-image editing. State-of-the-art
   *   for "make this product look native to this scene": the model sees
   *   the scene + the product reference and GENERATES pixels in the
   *   bbox region that look like the product was actually there at
   *   shoot time. ~15-30s, ~$0.05/call. Default for new placements.
   */
  mode?: "procedural" | "ai-3d" | "ai" | "generative";
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
  mode?: "procedural" | "ai-3d" | "ai" | "generative";
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

  const prompt =
    `Place the product from the reference image on the ${surfaceType.toLowerCase()} ` +
    `at the indicated location, ${angleHint}. The product should look like it was ` +
    `physically present when this scene was photographed: matching the room's ` +
    `lighting direction and color temperature, casting a realistic contact shadow ` +
    `on the surface beneath it, with depth-of-field consistent with the rest of ` +
    `the frame. Preserve the product's exact shape, colors, and branding. Keep ` +
    `the rest of the scene unchanged.`;

  try {
    const t0 = Date.now();
    // fal-ai/flux-pro/kontext — multi-image editing. The first image is
    // the base; reference_images carries additional context (the product).
    const result: any = await fal.subscribe("fal-ai/flux-pro/kontext", {
      input: {
        image_url: sceneCropUrl,
        reference_images: [{ url: productImageUrl }],
        prompt,
        guidance_scale: 3.5,
        num_inference_steps: 28,
        safety_tolerance: "5",
        output_format: "png",
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
  // 1.5x extents around the bbox center
  const padX = bbox.width * 0.5;
  const padY = bbox.height * 0.5;
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
 * Apply a vertical perspective shear via sharp affine to simulate a small
 * pitch angle. TRELLIS turnaround MP4 only varies yaw; pitch we have to
 * fake at the 2D level. ±20° pitch produces a noticeable shear that reads
 * as "looking at the product from above/below" without needing a real
 * GLB re-render. Larger pitch values would benefit from actual 3D render
 * (the next iteration of this work).
 */
async function applyPitchShear(
  imageBuf: Buffer,
  pitchDeg: number,
): Promise<Buffer> {
  if (Math.abs(pitchDeg) < 3) return imageBuf;
  const sharp = (await import("sharp")).default;
  const radians = (pitchDeg * Math.PI) / 180;
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
): Promise<{ result: Buffer; flatComposite: Buffer }> {
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

  // ── Step 1: resize product to fit the bbox, preserving aspect ──
  const productResized = await sharp(workingProductBuf)
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
  // Hard rule: brand colors must stay recognizable. So no full tint — that
  // would shift the product's intrinsic palette. We do TWO mild adjustments:
  //   - Brightness: stronger swing (was ±15%, now ±30%) so dim scenes
  //     visibly dim the product instead of leaving it floating bright on
  //     a dark background.
  //   - Hue/temperature pull: 8% blend toward the scene's color cast.
  //     Mild enough that brand colors stay recognizable, strong enough
  //     that the eye reads "this product is lit by this room" instead
  //     of "sticker pasted on top."
  const brightnessFactor = clamp(0.70 + sceneBrightness * 0.50, 0.70, 1.20);
  const productAdjusted = await sharp(productResized)
    .modulate({ brightness: brightnessFactor })
    .png()
    .toBuffer();
  console.log(`[Harmonize/proc] Brightness adjustment: ${brightnessFactor.toFixed(2)}× (saturation + hue preserved)`);

  // ── Step 5: scene color cast — 8% pull toward scene atmosphere ──
  // Build an RGBA tint layer the size of the product and overlay-blend it
  // at low opacity. The product silhouette gates it via dest-in so we
  // don't bleed onto background pixels.
  const tintAlpha = 0.08; // 8% — visible without killing brand colors
  let castBuf: Buffer = Buffer.alloc(0);
  try {
    const productAlpha = await sharp(productAdjusted)
      .ensureAlpha()
      .extractChannel("alpha")
      .toBuffer();
    const tintLayer = await sharp({
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
    castBuf = tintLayer;
    console.log(`[Harmonize/proc] Scene cast layer: rgb(${Math.round(meanR)},${Math.round(meanG)},${Math.round(meanB)}) @ ${(tintAlpha*100).toFixed(0)}%`);
  } catch (err) {
    console.warn(`[Harmonize/proc] Scene cast build failed (continuing without):`, (err as any)?.message);
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
        background: { r: 0, g: 0, b: 0, alpha: 0.45 },
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
        background: { r: 0, g: 0, b: 0, alpha: 0.65 },
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
  const softShadowOffsetY = Math.max(8, Math.round(finalH * 0.06));
  const tightShadowOffsetY = Math.max(2, Math.round(finalH * 0.015));
  const composites: Array<{ input: Buffer; left: number; top: number; blend?: any }> = [];
  if (softShadowBuf.length > 0) {
    composites.push({
      input: softShadowBuf,
      left: offsetX - softPad + 4,
      top: offsetY - softPad + softShadowOffsetY,
      blend: "over",
    });
  }
  if (tightShadowBuf.length > 0) {
    composites.push({
      input: tightShadowBuf,
      left: offsetX - softPad + 1,
      top: offsetY - softPad + tightShadowOffsetY,
      blend: "over",
    });
  }
  composites.push({ input: productAdjusted, left: offsetX, top: offsetY });
  if (castBuf.length > 0) {
    composites.push({ input: castBuf, left: offsetX, top: offsetY, blend: "over" });
  }

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
        // LOUD log so the deploy logs make this obvious. The user reported
        // a harmonize result that looked procedural and asked why generative
        // didn't run — they couldn't tell because the response was still
        // success=true. Server log now flags the fallback explicitly; the
        // response carries mode="procedural" + fellBackFromKontext=true.
        console.warn(`[Harmonize/generative] ⚠️  FLUX Kontext FAILED — falling back to procedural composite. Check FAL_KEY and the [Harmonize/kontext] error line above.`);
        const { result, flatComposite } = await applyProceduralHarmonization(
          sceneBuf, productBuf, input.bbox, input.frameDimensions,
        );
        const [imageUrl, flatCompositeUrl] = await Promise.all([
          uploadBuffer(result, "harmonized-fallback.png", "image/png"),
          uploadBuffer(flatComposite, "flat-composite.png", "image/png"),
        ]);
        return {
          success: true,
          imageUrl,
          flatCompositeUrl,
          elapsedMs: Date.now() - startedAt,
          mode: "procedural",
          error: "FLUX Kontext failed — fell back to procedural composite. See server logs for the underlying error.",
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
      const finalBuf = await compositeKontextCropBack(sceneBuf, editedCropBuf, rect);

      // Also build the flat composite for before/after comparison.
      const { flatComposite } = await applyProceduralHarmonization(
        sceneBuf, productBuf, input.bbox, input.frameDimensions,
      );

      const [imageUrl, flatCompositeUrl] = await Promise.all([
        uploadBuffer(finalBuf, "harmonized-generative.png", "image/png"),
        uploadBuffer(flatComposite, "flat-composite.png", "image/png"),
      ]);

      const elapsedMs = Date.now() - startedAt;
      console.log(`[Harmonize] generative done in ${elapsedMs}ms (Kontext)`);
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

      try {
        // Stage A.0 — depth analysis IN PARALLEL with TRELLIS. Depth
        // Anything v2 estimates the surface tilt at the placement bbox so
        // we can render the product at a matching camera angle instead of
        // the default 30° 3/4 view (the user's "looks like a 2D scene"
        // complaint stems from this perspective mismatch).
        const [trellis, depthAngle] = await Promise.all([
          runTrellis3D(productBuf),
          estimateSceneAngleFromDepth(sceneBuf, input.bbox, input.frameDimensions),
        ]);
        trellisRenderUrl = trellis.renderUrl;
        meshUrl = trellis.meshUrl;

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
        if (!renderedProductUrl) {
          const renderRes = await fetch(trellis.renderUrl);
          if (renderRes.ok) {
            renderedProductBuf = Buffer.from(await renderRes.arrayBuffer());
            renderedProductUrl = trellis.renderUrl;
          } else {
            console.warn(`[Harmonize/ai-3d] Failed to fetch TRELLIS render (${renderRes.status}); using original product image`);
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
        console.log(`[Harmonize] ai-3d done in ${elapsedMs}ms (TRELLIS${icLightRelitUrl ? " + IC-Light" : ""} + procedural)`);
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
      const dataUrl = `data:image/png;base64,${result.toString("base64")}`;
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
