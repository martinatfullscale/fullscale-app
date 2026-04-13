import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import axios from "axios";
import { fal } from "@fal-ai/client";
// @ts-ignore — sharp resolves via parent server node_modules when dynamically imported
import sharp from "sharp";
import type { Scene, SlideCategory, SlideRegion } from "./storyExtractor.js";
import type { ReconciledRegion } from "./timingEngine.js";

const execFileAsync = promisify(execFile);

/**
 * Categories that get AI animation via Seedance 2.0.
 * "data" and "text" stay static — AI mangles text/numbers.
 */
const ANIMATED_CATEGORIES: SlideCategory[] = ["person", "product", "graphic", "title"];
const STATIC_CATEGORIES: SlideCategory[] = ["data", "text"];

/**
 * Category-specific prompt templates for Seedance 2.0 image-to-video.
 * Each template describes HOW to animate the slide — not WHAT's in it.
 * The actual slide image provides the visual content.
 */
const CATEGORY_PROMPTS: Record<SlideCategory, string> = {
  person:
    "Subtle lifelike animation. Person blinks naturally, slight head movement, " +
    "gentle breathing motion. Preserve the original face and features exactly — no morphing or distortion. " +
    "Background stays completely still. Cinematic shallow depth of field.",

  product:
    "Gentle parallax depth effect revealing layers of the interface. " +
    "Subtle zoom into the key feature area. Preserve all text, UI elements, and screen content exactly as shown. " +
    "Smooth, professional camera drift. No warping or distortion.",

  graphic:
    "Cinematic ken burns effect — slow, elegant camera movement across the visual. " +
    "Subtle depth separation between foreground and background elements. " +
    "Colors gently shift with cinematic lighting. Smooth and polished.",

  data:
    "Static hold. No animation. Clean presentation of data.",

  text:
    "Static hold. No animation. Clean presentation of text.",

  title:
    "Dramatic, cinematic camera movement. Bold entrance energy. " +
    "Subtle particle effects or light rays in background. " +
    "Text stays crisp and centered — no warping. " +
    "Feels like the opening of a premium keynote.",
};

/**
 * Generate a visual for a scene based on the current tier.
 *
 * MVP:  Pass the slide image straight through (zero cost, no API call).
 * V1:   Seedance 2.0 image-to-video via fal.ai — animates based on slide category.
 *       Static categories (data, text) stay as images (AI mangles text/numbers).
 * V2:   Reserved for future upgrades.
 */
export async function generateVisual(
  scene: Scene,
  slideImagePath: string,
  tier: "mvp" | "v1" | "v2" = "mvp"
): Promise<string> {
  if (!fs.existsSync(slideImagePath)) {
    throw new Error(`Slide image not found: ${slideImagePath}`);
  }

  if (tier === "mvp") {
    return slideImagePath;
  }

  // V1 / V2: Branch on per-scene treatment (set by Claude or defaulted from category)
  const treatment = scene.treatment || (
    ["text", "data"].includes(scene.slideCategory) ? "kenburns" : "seedance"
  );

  switch (treatment) {
    case "seedance":
      return generateSeedanceClip(scene, slideImagePath);

    case "kenburns":
      // Text-heavy slides — subtle zoom 1.0 → 1.06 with 3D lifted card effect
      return generateKenBurnsClip(scene, slideImagePath, { intensity: "standard", liftedCard: true });

    case "static_highlight":
      // Data slides (charts, metrics) — very subtle zoom 1.0 → 1.03 so the slide feels alive
      return generateKenBurnsClip(scene, slideImagePath, { intensity: "subtle", liftedCard: false });

    default:
      return slideImagePath;
  }
}

interface KenBurnsOptions {
  /** "standard" = 1.0→1.06 zoom (text slides). "subtle" = 1.0→1.03 zoom (data slides). */
  intensity: "standard" | "subtle";
  /** Apply a subtle 3D drop-shadow "card lift" effect to the slide before animating. */
  liftedCard: boolean;
}

/**
 * Render a red ellipse around the highlight region onto a copy of the slide image.
 * Used as the "highlight variant" which gets overlaid with a time-gated alpha fade.
 */
async function burnHighlightIntoImage(
  baseImagePath: string,
  outputPath: string,
  region: { x: number; y: number; width: number; height: number }
): Promise<void> {
  const cx = (region.x + region.width / 2) * 1280;
  const cy = (region.y + region.height / 2) * 720;
  const rx = (region.width / 2) * 1280 + 20;  // 20px horizontal padding
  const ry = (region.height / 2) * 720 + 15;  // 15px vertical padding

  const svg = `<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}"
             rx="${rx.toFixed(0)}" ry="${ry.toFixed(0)}"
             fill="none" stroke="#E63946" stroke-width="8"/>
  </svg>`;

  // Ensure base image is exactly 1280x720 first, then composite the SVG over it
  await sharp(baseImagePath)
    .resize(1280, 720, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toFile(outputPath);
}

/**
 * Apply a subtle 3D "lifted card" effect to the slide image.
 * Inset the slide inside a dark canvas with a soft drop shadow — makes text
 * slides feel like physical cards floating above a surface, not flat screenshots.
 */
async function applyLiftedCardEffect(
  baseImagePath: string,
  outputPath: string
): Promise<void> {
  // Resize the slide down to 94% of canvas (1203x676), center it, drop shadow underneath
  const cardWidth = 1203;
  const cardHeight = 676;
  const marginX = (1280 - cardWidth) / 2;  // 38
  const marginY = (720 - cardHeight) / 2;  // 22

  // Base dark canvas
  const canvas = sharp({
    create: {
      width: 1280,
      height: 720,
      channels: 4,
      background: { r: 18, g: 18, b: 22, alpha: 1 }, // near-black with slight warmth
    },
  });

  // Soft shadow: the slide resized + blurred + darkened, offset by +8px down
  const shadowBuffer = await sharp(baseImagePath)
    .resize(cardWidth, cardHeight, { fit: "contain", background: { r: 0, g: 0, b: 0 } })
    .blur(18)
    .modulate({ brightness: 0.3 })
    .toBuffer();

  // The actual card
  const cardBuffer = await sharp(baseImagePath)
    .resize(cardWidth, cardHeight, { fit: "contain", background: { r: 255, g: 255, b: 255 } })
    .toBuffer();

  await canvas
    .composite([
      { input: shadowBuffer, top: Math.round(marginY + 12), left: Math.round(marginX) },
      { input: cardBuffer, top: Math.round(marginY), left: Math.round(marginX) },
    ])
    .jpeg({ quality: 92 })
    .toFile(outputPath);
}

/**
 * Generate a Ken Burns (slow pan+zoom) clip from a slide image.
 * When the scene has a highlightRegion, also renders a second variant with a
 * red ellipse circle burned in, and composites it on top with a time-gated
 * alpha fade (fade in at highlightStartSec, fade out at highlightEndSec).
 *
 * Because both variants go through identical zoompan params, the circle is
 * pixel-perfect aligned with the underlying text as it pans/zooms.
 */
async function generateKenBurnsClip(
  scene: Scene,
  slideImagePath: string,
  options: KenBurnsOptions = { intensity: "standard", liftedCard: true }
): Promise<string> {
  const outputDir = path.dirname(slideImagePath);
  const videoPath = path.join(outputDir, `scene_${scene.sceneNumber}_kenburns.mp4`);
  const duration = Math.max(5, scene.estimatedDurationSeconds || 10);
  const totalFrames = duration * 24; // 24fps

  console.log(`[VisualLayer] Scene ${scene.sceneNumber}: ${scene.slideCategory} — Ken Burns ${options.intensity} (${duration}s)`);

  // Intensity controls zoom ceiling + speed
  const zoomMax = options.intensity === "subtle" ? 1.03 : 1.06;
  const zoomStep = options.intensity === "subtle" ? 0.0002 : 0.0004;

  // Pan center: blend 70% slide-center + 30% highlight-center (softer bias than before)
  let panX = "iw/2-(iw/zoom/2)";
  let panY = "ih/2-(ih/zoom/2)";
  if (scene.highlightRegion) {
    const hx = scene.highlightRegion.x + scene.highlightRegion.width / 2;
    const hy = scene.highlightRegion.y + scene.highlightRegion.height / 2;
    const targetX = 0.5 * 0.7 + hx * 0.3;
    const targetY = 0.5 * 0.7 + hy * 0.3;
    panX = `iw*${targetX.toFixed(3)}-(iw/zoom/2)`;
    panY = `ih*${targetY.toFixed(3)}-(ih/zoom/2)`;
  }

  try {
    // Step 1: Prepare the "plain" image — possibly with 3D lifted card effect
    let plainPath = slideImagePath;
    if (options.liftedCard) {
      plainPath = path.join(outputDir, `scene_${scene.sceneNumber}_lifted.jpg`);
      await applyLiftedCardEffect(slideImagePath, plainPath);
    }

    // Step 2: Prepare the "circled" variant if we have a highlight region
    let circledPath: string | null = null;
    if (scene.highlightRegion) {
      circledPath = path.join(outputDir, `scene_${scene.sceneNumber}_circled.jpg`);
      await burnHighlightIntoImage(plainPath, circledPath, scene.highlightRegion);
    }

    // Step 3: Run FFmpeg
    const zoompanExpr = `scale=2560:1440,zoompan=z='min(zoom+${zoomStep},${zoomMax})':x='${panX}':y='${panY}':d=${totalFrames}:s=1280x720:fps=24`;

    let args: string[];
    if (circledPath) {
      // Dual-input filtergraph: plain + circled with time-gated alpha fade overlay
      const fadeInStart = Math.max(0, scene.highlightStartSec ?? 0.5);
      const fadeOutStart = Math.max(fadeInStart + 0.5, scene.highlightEndSec ?? duration - 0.5);
      const fadeDur = 0.4;

      const filtergraph = [
        `[0:v]${zoompanExpr}[plain]`,
        `[1:v]${zoompanExpr},format=yuva420p,fade=in:st=${fadeInStart.toFixed(2)}:d=${fadeDur}:alpha=1,fade=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDur}:alpha=1[circled]`,
        `[plain][circled]overlay=shortest=1[out]`,
      ].join(";");

      args = [
        "-nostdin", "-y",
        "-loop", "1", "-i", plainPath,
        "-loop", "1", "-i", circledPath,
        "-filter_complex", filtergraph,
        "-map", "[out]",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "medium",
        "-crf", "22",
        "-t", String(duration),
        "-an",
        videoPath,
      ];
    } else {
      // Single-input simple Ken Burns
      args = [
        "-nostdin", "-y",
        "-loop", "1",
        "-i", plainPath,
        "-vf", zoompanExpr,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "medium",
        "-crf", "22",
        "-t", String(duration),
        "-an",
        videoPath,
      ];
    }

    await new Promise<void>((resolve, reject) => {
      execFile("ffmpeg", args, { timeout: 90000 }, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 1000) {
      const kb = Math.round(fs.statSync(videoPath).size / 1024);
      console.log(`[VisualLayer] Scene ${scene.sceneNumber} Ken Burns${scene.highlightRegion ? " + highlight" : ""}: ${videoPath} (${kb} KB)`);
      return videoPath;
    }
    throw new Error("Output file missing or too small");
  } catch (err: any) {
    console.error(`[VisualLayer] Ken Burns failed for scene ${scene.sceneNumber}: ${err.message}`);
    return slideImagePath; // Fall back to static image
  }
}

/**
 * Generate an AI video clip using Seedance 2.0 image-to-video via fal.ai.
 * Animation style is determined by the slide category:
 * - person: subtle life (blink, breathe)
 * - product: parallax zoom into feature
 * - graphic: ken burns cinematic pan
 * - title: dramatic camera movement
 * - data/text: SKIP — return static image
 */
async function generateSeedanceClip(
  scene: Scene,
  slideImagePath: string
): Promise<string> {
  const category: SlideCategory = scene.slideCategory || "text";

  // Static categories skip AI animation entirely
  if (STATIC_CATEGORIES.includes(category)) {
    console.log(`[VisualLayer] Scene ${scene.sceneNumber}: ${category} slide — keeping static`);
    return slideImagePath;
  }

  // Studio pipeline uses Kling 3.0 only (Seedance 2.0 via ModelsLab lives in the main
  // FullScale App for product asset generation — not here).
  const falKey = process.env.FAL_KEY;

  if (!falKey) {
    console.warn("[VisualLayer] No FAL_KEY — falling back to MVP (static slides)");
    return slideImagePath;
  }

  const outputDir = path.dirname(slideImagePath);
  const videoPath = path.join(outputDir, `scene_${scene.sceneNumber}_video.mp4`);

  // Build category-specific prompt
  const categoryPrompt = CATEGORY_PROMPTS[category];
  const cameraDirection = scene.cameraDirection || "";
  const prompt = `${cameraDirection}. ${categoryPrompt}`;

  // Kling 3.0 via fal.ai
  console.log(`[VisualLayer] Scene ${scene.sceneNumber}: ${category} slide — animating with Kling 3.0`);
  console.log(`[VisualLayer] Prompt: "${prompt.slice(0, 150)}..."`);

  try {
    fal.config({ credentials: falKey });

    const imageBuffer = fs.readFileSync(slideImagePath);
    const imageFile = new File(
      [imageBuffer],
      path.basename(slideImagePath),
      { type: "image/jpeg" }
    );
    const imageUrl = await fal.storage.upload(imageFile);
    console.log(`[VisualLayer] Uploaded slide image for scene ${scene.sceneNumber}`);

    const cfgScale = category === "person" ? 0.3
      : category === "product" ? 0.3
      : category === "title" ? 0.7
      : 0.5;

    const result = await fal.subscribe(
      "fal-ai/kling-video/v3/standard/image-to-video",
      {
        input: {
          start_image_url: imageUrl,
          prompt,
          duration: "5",
          generate_audio: false,
          negative_prompt:
            "blur, distort, low quality, watermark, morphing text, changing letters, " +
            "garbled words, face deformation, extra fingers, melting, glitch",
          cfg_scale: cfgScale,
        },
        logs: true,
        onQueueUpdate: (update) => {
          if (update.status === "IN_PROGRESS") {
            const msgs = (update as any).logs;
            if (msgs) {
              msgs.map((log: any) => log.message).forEach((msg: string) => {
                console.log(`[VisualLayer/fal] ${msg}`);
              });
            }
          }
        },
      }
    );

    const videoUrl = (result as any).data?.video?.url;
    if (!videoUrl) throw new Error("No video URL in Kling fal.ai response");

    console.log(`[VisualLayer] Downloading clip for scene ${scene.sceneNumber}...`);
    const response = await axios.get(videoUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(videoPath, Buffer.from(response.data));

    const fileSizeKB = Math.round(fs.statSync(videoPath).size / 1024);
    console.log(`[VisualLayer] Scene ${scene.sceneNumber} video: ${videoPath} (${fileSizeKB} KB)`);
    return videoPath;
  } catch (err: any) {
    console.error(`[VisualLayer] Kling 3.0 failed for scene ${scene.sceneNumber}: ${err.message}`);
    console.warn("[VisualLayer] Falling back to static slide image");
    return slideImagePath;
  }
}

// ═══════════════════════════════════════════════════════════════
// Per-Region Compositing (Studio v4)
// ═══════════════════════════════════════════════════════════════

const SLIDE_W = 1280;
const SLIDE_H = 720;

export interface RegionVariant {
  regionId: string;
  type: string;
  animationType: string;
  bounds: SlideRegion["bounds"];
  /** Path to the Sharp-rendered PNG for raise/fade_in regions */
  variantPngPath?: string;
  /** Path to the Kling-animated MP4 for kling_motion regions (per-region, not full-slide) */
  klingClipPath?: string;
}

/**
 * Extract region variants from a slide image.
 * - "raise" regions: Sharp crops + renders a raised variant (105% + shadow)
 * - "kling_motion" regions: no Sharp work — cropped from Kling clip at compose time
 * - "fade_in" regions: Sharp crop at full opacity as transparent PNG
 */
export async function extractRegionVariants(
  scene: Scene,
  slideImagePath: string,
  outputDir: string
): Promise<RegionVariant[]> {
  const regions = scene.regions || [];
  const variants: RegionVariant[] = [];

  for (const region of regions) {
    if (region.animationType === "none") continue;

    const pixelBounds = {
      left: Math.round(region.bounds.x * SLIDE_W),
      top: Math.round(region.bounds.y * SLIDE_H),
      width: Math.round(region.bounds.width * SLIDE_W),
      height: Math.round(region.bounds.height * SLIDE_H),
    };

    // Clamp to image bounds
    pixelBounds.left = Math.max(0, Math.min(SLIDE_W - 2, pixelBounds.left));
    pixelBounds.top = Math.max(0, Math.min(SLIDE_H - 2, pixelBounds.top));
    pixelBounds.width = Math.min(SLIDE_W - pixelBounds.left, Math.max(10, pixelBounds.width));
    pixelBounds.height = Math.min(SLIDE_H - pixelBounds.top, Math.max(10, pixelBounds.height));

    if (region.animationType === "raise" || region.animationType === "fade_in") {
      const pngPath = path.join(outputDir, `region_${region.id}_raised.png`);

      try {
        if (region.animationType === "raise") {
          // Render a "raised" variant: crop → scale 105% → add shadow → save as transparent PNG
          const regionBuffer = await sharp(slideImagePath)
            .extract(pixelBounds)
            .toBuffer();

          const scaledW = Math.round(pixelBounds.width * 1.05);
          const scaledH = Math.round(pixelBounds.height * 1.05);

          // Shadow: blurred, darkened version
          const shadowBuffer = await sharp(regionBuffer)
            .resize(scaledW, scaledH)
            .blur(8)
            .modulate({ brightness: 0.35 })
            .ensureAlpha(0.6)
            .toBuffer();

          // Card: the region at full brightness
          const cardBuffer = await sharp(regionBuffer)
            .resize(scaledW, scaledH)
            .ensureAlpha()
            .toBuffer();

          // Composite shadow + card onto a transparent canvas
          const canvasW = scaledW + 8;
          const canvasH = scaledH + 10;
          await sharp({
            create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
          })
            .composite([
              { input: shadowBuffer, top: 6, left: 4 },  // shadow offset +6 down, +4 right
              { input: cardBuffer, top: 0, left: 0 },
            ])
            .png()
            .toFile(pngPath);
        } else {
          // fade_in: just crop and save as transparent PNG
          await sharp(slideImagePath)
            .extract(pixelBounds)
            .ensureAlpha()
            .png()
            .toFile(pngPath);
        }

        variants.push({
          regionId: region.id,
          type: region.type,
          animationType: region.animationType,
          bounds: region.bounds,
          variantPngPath: pngPath,
        });
      } catch (err: any) {
        console.warn(`[VisualLayer] Region ${region.id} extraction failed: ${err.message}`);
      }
    } else if (region.animationType === "kling_motion") {
      // Extract the image region, pad to 720p, send to Kling individually
      // so Kling focuses entirely on this content (not the whole slide)
      try {
        const paddedPath = path.join(outputDir, `region_${region.id}_padded.jpg`);
        const klingOutPath = path.join(outputDir, `region_${region.id}_kling.mp4`);

        // Extract region and pad to 1280x720 (Kling's preferred resolution)
        await sharp(slideImagePath)
          .extract(pixelBounds)
          .resize(SLIDE_W, SLIDE_H, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0 },
          })
          .jpeg({ quality: 90 })
          .toFile(paddedPath);

        console.log(`[VisualLayer] Region ${region.id}: extracted + padded to 720p for Kling`);

        // Send the padded region to Kling — it sees ONLY this image content
        const categoryPrompt = CATEGORY_PROMPTS[region.type === "logo" ? "title" : "person"] || CATEGORY_PROMPTS["person"];
        const klingScene = {
          ...scene,
          cameraDirection: "slow push-in on subject",
          slideCategory: (region.type === "logo" ? "title" : "person") as SlideCategory,
        };

        // Use the Kling path from generateSeedanceClip but with the padded region image
        const falKey = process.env.FAL_KEY;
        if (falKey) {
          fal.config({ credentials: falKey });
          const imageBuffer = fs.readFileSync(paddedPath);
          const imageFile = new File([imageBuffer], `region_${region.id}.jpg`, { type: "image/jpeg" });
          const imageUrl = await fal.storage.upload(imageFile);

          const prompt = `${klingScene.cameraDirection}. ${categoryPrompt}`;
          const result = await fal.subscribe("fal-ai/kling-video/v3/standard/image-to-video", {
            input: {
              start_image_url: imageUrl,
              prompt,
              duration: "5",
              generate_audio: false,
              negative_prompt: "blur, distort, low quality, watermark, morphing text, face deformation, melting",
              cfg_scale: 0.3, // Low = preserve original content
            },
            logs: true,
            onQueueUpdate: (update) => {
              if (update.status === "IN_PROGRESS") {
                const msgs = (update as any).logs;
                if (msgs) msgs.map((l: any) => l.message).forEach((m: string) => console.log(`[VisualLayer/kling] ${m}`));
              }
            },
          });

          const videoUrl = (result as any).data?.video?.url;
          if (videoUrl) {
            const dlRes = await axios.get(videoUrl, { responseType: "arraybuffer" });
            fs.writeFileSync(klingOutPath, Buffer.from(dlRes.data));
            console.log(`[VisualLayer] Region ${region.id} Kling clip: ${klingOutPath} (${Math.round(fs.statSync(klingOutPath).size / 1024)} KB)`);

            variants.push({
              regionId: region.id,
              type: region.type,
              animationType: region.animationType,
              bounds: region.bounds,
              klingClipPath: klingOutPath,
            });
            continue;
          }
        }
        // Kling failed — fall back to raise treatment
        console.warn(`[VisualLayer] Region ${region.id}: Kling failed, falling back to raise`);
        variants.push({
          regionId: region.id,
          type: region.type,
          animationType: "raise", // Degraded fallback
          bounds: region.bounds,
        });
      } catch (err: any) {
        console.warn(`[VisualLayer] Region ${region.id} Kling extraction failed: ${err.message}`);
        variants.push({
          regionId: region.id,
          type: region.type,
          animationType: "raise",
          bounds: region.bounds,
        });
      }
    }
  }

  return variants;
}

/**
 * Generate all visual assets for a scene with per-region compositing.
 * Returns the base Ken Burns clip, region variants, and optional Kling clip.
 */
export async function generateSceneVisualWithRegions(
  scene: Scene,
  slideImagePath: string,
  reconciledRegions: ReconciledRegion[],
  outputDir: string
): Promise<{ baseClipPath: string; regionVariants: RegionVariant[]; klingClipPath: string | null }> {
  // Determine if the slide is a full-bleed image (title with background photo,
  // person slide, graphic slide) — if so, Kling the WHOLE slide as the base layer
  // instead of just doing a Ken Burns zoom on a flat JPEG.
  const isFullImageSlide = ["title", "person", "graphic"].includes(scene.slideCategory)
    && !reconciledRegions.some((r) => r.type === "text_block" || r.type === "heading");

  let baseClipPath: string;
  if (isFullImageSlide && process.env.FAL_KEY) {
    // Full-slide Kling animation as the base — sends the whole 1280x720 slide
    console.log(`[VisualLayer] Scene ${scene.sceneNumber}: full-image slide — Kling base layer`);
    try {
      baseClipPath = await generateSeedanceClip(scene, slideImagePath);
    } catch (err: any) {
      console.warn(`[VisualLayer] Scene ${scene.sceneNumber}: Kling base failed, using Ken Burns`);
      baseClipPath = await generateKenBurnsClip(scene, slideImagePath, {
        intensity: "subtle",
        liftedCard: false,
      });
    }
  } else {
    // Standard Ken Burns base for text-heavy slides
    baseClipPath = await generateKenBurnsClip(scene, slideImagePath, {
      intensity: "subtle",
      liftedCard: false,
    });
  }

  // Extract + animate regions individually
  const regionVariants = await extractRegionVariants(scene, slideImagePath, outputDir);

  const klingCount = regionVariants.filter((v) => v.klingClipPath).length;
  const raiseCount = regionVariants.filter((v) => v.variantPngPath).length;
  console.log(`[VisualLayer] Scene ${scene.sceneNumber}: ${klingCount} Kling regions, ${raiseCount} raise regions`);

  return { baseClipPath, regionVariants, klingClipPath: null };
}

/**
 * Compose a final video for a scene by overlaying animated regions onto
 * the base Ken Burns clip using FFmpeg's filter_complex.
 *
 * The filtergraph:
 * - Input 0: base Ken Burns clip (subtle zoom on full slide)
 * - Input 1 (if any kling regions): Kling-animated clip of the full slide
 * - Input 2+: PNG variants for raise/fade regions (looped as still images)
 *
 * Each region is overlaid at its original position with time-gated enable
 * synced to actualStartSec/actualEndSec from the timing engine.
 */
export async function composeSceneWithRegions(
  scene: Scene,
  baseClipPath: string,
  klingClipPath: string | null,
  regionVariants: RegionVariant[],
  reconciledRegions: ReconciledRegion[],
  sceneDurationSec: number,
  outputDir: string
): Promise<string> {
  const outputPath = path.join(outputDir, `scene_${scene.sceneNumber}_composed.mp4`);
  const totalFrames = sceneDurationSec * 24;

  // If no regions, just return the base clip
  if (reconciledRegions.length === 0) return baseClipPath;

  // Build the reconciled map for quick lookup
  const reconMap = new Map(reconciledRegions.map((r) => [r.id, r]));

  // Separate kling regions (with their own clips) from raise/fade regions
  const klingRegions = regionVariants.filter((v) => v.klingClipPath && fs.existsSync(v.klingClipPath));
  const raiseRegions = regionVariants.filter(
    (v) => (v.animationType === "raise" || v.animationType === "fade_in") && v.variantPngPath
  );

  // Build input args
  const inputArgs: string[] = ["-nostdin", "-y"];

  // Input 0: base Ken Burns clip
  inputArgs.push("-i", baseClipPath);

  // Inputs 1+: Per-region Kling clips (each is its own input, looped)
  const klingInputMap = new Map<string, number>(); // regionId → input index
  let nextInputIdx = 1;
  for (const kv of klingRegions) {
    inputArgs.push("-stream_loop", "-1", "-i", kv.klingClipPath!);
    klingInputMap.set(kv.regionId, nextInputIdx);
    nextInputIdx++;
  }

  // Inputs N+: PNG variants for raise/fade regions
  const pngInputMap = new Map<string, number>(); // regionId → input index
  for (const rv of raiseRegions) {
    if (rv.variantPngPath && fs.existsSync(rv.variantPngPath)) {
      inputArgs.push("-loop", "1", "-i", rv.variantPngPath);
      pngInputMap.set(rv.regionId, nextInputIdx);
      nextInputIdx++;
    }
  }

  // Build filtergraph
  const filters: string[] = [];
  let currentLabel = "base";

  // Base: scale to standard resolution
  filters.push(`[0:v]scale=${SLIDE_W}:${SLIDE_H},setsar=1[${currentLabel}]`);

  // Per-region Kling overlays — each region has its own animated clip
  // The Kling clip is 720p (padded from the extracted region), so we need to:
  // 1. Scale the Kling output to the original region size
  // 2. Overlay it at the region's position on the base slide
  for (const kv of klingRegions) {
    const recon = reconMap.get(kv.regionId);
    const klingIdx = klingInputMap.get(kv.regionId);
    if (!recon || klingIdx === undefined) continue;

    const regionW = Math.round(kv.bounds.width * SLIDE_W);
    const regionH = Math.round(kv.bounds.height * SLIDE_H);
    const posX = Math.round(kv.bounds.x * SLIDE_W);
    const posY = Math.round(kv.bounds.y * SLIDE_H);
    const start = recon.actualStartSec.toFixed(2);
    const end = recon.actualEndSec.toFixed(2);
    const fadeIn = recon.actualStartSec.toFixed(2);
    const fadeOut = Math.max(recon.actualStartSec + 0.5, recon.actualEndSec - 0.3).toFixed(2);

    const klingLabel = `kling_${kv.regionId}`;
    const nextLabel = `comp_${kv.regionId}`;

    // The Kling clip is 1280x720 with the region content centered (padded by Sharp).
    // Crop the center area matching the region's aspect ratio, then scale to exact region size.
    // This removes the black padding bars that Kling rendered around the content.
    const cropW = Math.round(Math.min(SLIDE_W, regionW * (SLIDE_H / regionH)));
    const cropH = Math.round(Math.min(SLIDE_H, regionH * (SLIDE_W / regionW)));
    const cropX = Math.round((SLIDE_W - cropW) / 2);
    const cropY = Math.round((SLIDE_H - cropH) / 2);

    filters.push(
      `[${klingIdx}:v]crop=${cropW}:${cropH}:${cropX}:${cropY},` +
      `scale=${regionW}:${regionH},` +
      `format=yuva420p,fade=in:st=${fadeIn}:d=0.3:alpha=1,fade=out:st=${fadeOut}:d=0.3:alpha=1[${klingLabel}]`
    );
    filters.push(
      `[${currentLabel}][${klingLabel}]overlay=x=${posX}:y=${posY}:enable='between(t,${start},${end})'[${nextLabel}]`
    );
    currentLabel = nextLabel;
  }

  // Raise/fade PNG overlays
  for (const rv of raiseRegions) {
    const recon = reconMap.get(rv.regionId);
    const inputIdx = pngInputMap.get(rv.regionId);
    if (!recon || inputIdx === undefined) continue;

    // The raised PNG is slightly larger than the original region (105% + shadow padding)
    // Position it so its center aligns with the original region center
    const origCenterX = (rv.bounds.x + rv.bounds.width / 2) * SLIDE_W;
    const origCenterY = (rv.bounds.y + rv.bounds.height / 2) * SLIDE_H;

    const start = recon.actualStartSec.toFixed(2);
    const end = recon.actualEndSec.toFixed(2);
    const fadeIn = recon.actualStartSec.toFixed(2);
    const fadeOut = Math.max(recon.actualStartSec + 0.5, recon.actualEndSec - 0.3).toFixed(2);

    const raisedLabel = `raise_${rv.regionId}`;
    const nextLabel = `comp_${rv.regionId}`;

    // Use zoompan for subtle "breathing" scale 1.0→1.03 during active window
    filters.push(
      `[${inputIdx}:v]loop=loop=-1:size=1:start=0,` +
      `zoompan=z='if(between(t,${start},${end}),min(zoom+0.0003,1.03),1.0)':` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:fps=24,` +
      `format=yuva420p,` +
      `fade=in:st=${fadeIn}:d=0.3:alpha=1,fade=out:st=${fadeOut}:d=0.3:alpha=1` +
      `[${raisedLabel}]`
    );

    // Overlay position: center the raised PNG over the original region center
    // The PNG size isn't known statically, so use `main_w`/`main_h` and `overlay_w`/`overlay_h`
    const overlayX = `${Math.round(origCenterX)}-overlay_w/2`;
    const overlayY = `${Math.round(origCenterY)}-overlay_h/2`;

    filters.push(
      `[${currentLabel}][${raisedLabel}]overlay=x='${overlayX}':y='${overlayY}':enable='between(t,${start},${end})'[${nextLabel}]`
    );
    currentLabel = nextLabel;
  }

  // If no overlays were added, just return base
  if (currentLabel === "base") return baseClipPath;

  // Rename final output
  if (currentLabel !== "out") {
    filters.push(`[${currentLabel}]null[out]`);
  }

  const filtergraph = filters.join(";\n");

  const outputArgs = [
    "-filter_complex", filtergraph,
    "-map", "[out]",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "medium",
    "-crf", "21",
    "-t", String(sceneDurationSec),
    "-an",
    outputPath,
  ];

  const args = [...inputArgs, ...outputArgs];

  console.log(`[VisualLayer] Compositing scene ${scene.sceneNumber} — ${klingRegions.length} kling + ${raiseRegions.length} raise regions`);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile("ffmpeg", args, { timeout: 120000 }, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      const kb = Math.round(fs.statSync(outputPath).size / 1024);
      console.log(`[VisualLayer] Scene ${scene.sceneNumber} composed: ${outputPath} (${kb} KB)`);
      return outputPath;
    }
    throw new Error("Composed output missing or too small");
  } catch (err: any) {
    console.error(`[VisualLayer] Scene ${scene.sceneNumber} compositing failed: ${err.message}`);
    return baseClipPath; // Graceful fallback to base Ken Burns
  }
}

/**
 * Convert each page of a PDF into a JPEG image using pdftoppm.
 * Returns an ordered array of image file paths.
 */
export async function slidesToImages(
  pdfPath: string,
  outputDir: string
): Promise<string[]> {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF file not found: ${pdfPath}`);
  }

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const outputPrefix = path.join(outputDir, "slide");
  console.log(`[VisualLayer] Converting PDF slides to images...`);

  try {
    // pdftoppm -jpeg -r 150 input.pdf outputDir/slide
    // This produces: slide-01.jpg, slide-02.jpg, etc.
    await execFileAsync("pdftoppm", [
      "-jpeg",
      "-r",
      "150",
      pdfPath,
      outputPrefix,
    ]);
  } catch (err: any) {
    console.error(`[VisualLayer] pdftoppm failed: ${err.message}`);
    console.warn("[VisualLayer] Falling back to placeholder slide images");
    // Create simple placeholder images using ffmpeg (which IS available)
    return createPlaceholderSlideImages(pdfPath, outputDir);
  }

  // Read the output directory and return sorted image paths
  const files = fs.readdirSync(outputDir)
    .filter((f) => f.startsWith("slide") && f.endsWith(".jpg"))
    .sort(); // pdftoppm zero-pads, so alphabetical sort is correct

  const imagePaths = files.map((f) => path.join(outputDir, f));

  if (imagePaths.length === 0) {
    console.warn("[VisualLayer] pdftoppm produced no images, using placeholders");
    return createPlaceholderSlideImages(pdfPath, outputDir);
  }

  console.log(`[VisualLayer] Generated ${imagePaths.length} slide images`);
  return imagePaths;
}

/**
 * Create simple solid-color placeholder images when pdftoppm is unavailable.
 * Uses ffmpeg (available on Replit) to generate 1280x720 JPEG frames.
 */
async function createPlaceholderSlideImages(
  pdfPath: string,
  outputDir: string
): Promise<string[]> {
  fs.mkdirSync(outputDir, { recursive: true });

  // Get approximate page count from the PDF text (fallback: 10)
  let pageCount = 10;
  try {
    const { stdout } = await execFileAsync("pdfinfo", [pdfPath]);
    const match = stdout.match(/Pages:\s+(\d+)/);
    if (match) pageCount = parseInt(match[1], 10);
  } catch {
    // pdfinfo not available either; guess 10 slides
  }

  const images: string[] = [];
  for (let i = 1; i <= pageCount; i++) {
    const imgPath = path.join(outputDir, `slide-${String(i).padStart(3, "0")}.jpg`);
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-f", "lavfi",
        "-i", `color=c=#1a1a2e:s=1280x720:d=1`,
        "-vf", `drawtext=text='Slide ${i}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2`,
        "-frames:v", "1",
        imgPath,
      ], { timeout: 10000 });
    } catch {
      // If ffmpeg drawtext filter isn't available, create without text
      try {
        await execFileAsync("ffmpeg", [
          "-y",
          "-f", "lavfi",
          "-i", `color=c=#1a1a2e:s=1280x720:d=1`,
          "-frames:v", "1",
          imgPath,
        ], { timeout: 10000 });
      } catch (e: any) {
        console.error(`[VisualLayer] Could not create placeholder for slide ${i}: ${e.message}`);
        continue;
      }
    }
    images.push(imgPath);
  }

  console.log(`[VisualLayer] Created ${images.length} placeholder slide images`);
  return images;
}
