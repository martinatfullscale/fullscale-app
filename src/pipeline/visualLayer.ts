import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import axios from "axios";
import { fal } from "@fal-ai/client";
import type { Scene, SlideCategory } from "./storyExtractor.js";

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
      return generateKenBurnsClip(scene, slideImagePath);

    case "static_highlight":
      // Stay static — assembler will add drawbox highlight overlay
      return slideImagePath;

    default:
      return slideImagePath;
  }
}

/**
 * Generate a Ken Burns (slow pan+zoom) clip from a static slide image.
 * Uses FFmpeg zoompan filter — no AI, no text distortion.
 * Safe for text-heavy slides, bullets, team bios, quotes.
 *
 * The pan direction biases toward the highlightRegion if present, so the zoom
 * gradually reveals the key text area.
 */
async function generateKenBurnsClip(
  scene: Scene,
  slideImagePath: string
): Promise<string> {
  const outputDir = path.dirname(slideImagePath);
  const videoPath = path.join(outputDir, `scene_${scene.sceneNumber}_kenburns.mp4`);
  const duration = Math.max(5, scene.estimatedDurationSeconds || 10);
  const totalFrames = duration * 24; // 24fps

  console.log(`[VisualLayer] Scene ${scene.sceneNumber}: ${scene.slideCategory} — Ken Burns (${duration}s, no AI)`);

  // Zoom from 1.0 → 1.1 over the scene duration (very subtle)
  // Pan toward the highlight region center if present, else center
  let panX = "iw/2-(iw/zoom/2)";
  let panY = "ih/2-(ih/zoom/2)";

  if (scene.highlightRegion) {
    const cx = scene.highlightRegion.x + scene.highlightRegion.width / 2;
    const cy = scene.highlightRegion.y + scene.highlightRegion.height / 2;
    // Interpolate from center (0.5, 0.5) toward the highlight center over time
    // At zoom=1.0, pan=center. At zoom=1.1, pan biases toward highlight.
    panX = `iw*${cx.toFixed(3)}-(iw/zoom/2)`;
    panY = `ih*${cy.toFixed(3)}-(ih/zoom/2)`;
  }

  return new Promise((resolve, reject) => {
    const { execFile } = require("child_process");
    const args = [
      "-nostdin", "-y",
      "-loop", "1",
      "-i", slideImagePath,
      "-vf",
      `scale=2560:1440,zoompan=z='min(zoom+0.0008,1.1)':x='${panX}':y='${panY}':d=${totalFrames}:s=1280x720:fps=24`,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "medium",
      "-crf", "22",
      "-t", String(duration),
      "-an",
      videoPath,
    ];

    execFile("ffmpeg", args, { timeout: 60000 }, (err: any) => {
      if (err) {
        console.error(`[VisualLayer] Ken Burns failed for scene ${scene.sceneNumber}: ${err.message}`);
        resolve(slideImagePath); // Fall back to static image
        return;
      }
      if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 1000) {
        const kb = Math.round(fs.statSync(videoPath).size / 1024);
        console.log(`[VisualLayer] Scene ${scene.sceneNumber} Ken Burns: ${videoPath} (${kb} KB)`);
        resolve(videoPath);
      } else {
        resolve(slideImagePath);
      }
    });
  });
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
