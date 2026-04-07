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
  switch (tier) {
    case "mvp":
      // Pass through — the slide image IS the visual
      if (!fs.existsSync(slideImagePath)) {
        throw new Error(`Slide image not found: ${slideImagePath}`);
      }
      return slideImagePath;

    case "v1":
      return generateSeedanceClip(scene, slideImagePath);

    case "v2":
      throw new Error("V2 tier not yet configured.");

    default:
      return slideImagePath;
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

  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    console.warn("[VisualLayer] No FAL_KEY — falling back to MVP (static slides)");
    return slideImagePath;
  }

  fal.config({ credentials: falKey });

  const outputDir = path.dirname(slideImagePath);
  const videoPath = path.join(outputDir, `scene_${scene.sceneNumber}_video.mp4`);

  // Build category-specific prompt
  const categoryPrompt = CATEGORY_PROMPTS[category];
  const cameraDirection = scene.cameraDirection || "";
  const prompt = `${cameraDirection}. ${categoryPrompt}`;

  console.log(`[VisualLayer] Scene ${scene.sceneNumber}: ${category} slide — animating with Seedance 2.0`);
  console.log(`[VisualLayer] Prompt: "${prompt.slice(0, 150)}..."`);

  try {
    // Upload the slide image to fal.ai storage so it can be used as input
    const imageBuffer = fs.readFileSync(slideImagePath);
    const imageFile = new File(
      [imageBuffer],
      path.basename(slideImagePath),
      { type: "image/jpeg" }
    );
    const imageUrl = await fal.storage.upload(imageFile);
    console.log(`[VisualLayer] Uploaded slide image for scene ${scene.sceneNumber}`);

    // For person/product slides, lock camera to preserve content fidelity
    const cameraFixed = category === "person" || category === "product";

    const result = await fal.subscribe(
      "fal-ai/bytedance/seedance-2.0/image-to-video",
      {
        input: {
          image_url: imageUrl,
          prompt,
          duration: 5,
          resolution: "720p",
          aspect_ratio: "16:9",
          generate_audio: false,
          camera_fixed: cameraFixed,
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

    // Seedance 2.0 fal.ai response: { video: { url: "..." }, seed: ... }
    const videoUrl = (result as any).data?.video?.url || (result as any).video?.url;
    if (!videoUrl) {
      throw new Error("No video URL in Seedance 2.0 fal.ai response");
    }

    console.log(`[VisualLayer] Downloading clip for scene ${scene.sceneNumber}...`);
    const response = await axios.get(videoUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(videoPath, Buffer.from(response.data));

    const fileSizeKB = Math.round(fs.statSync(videoPath).size / 1024);
    console.log(`[VisualLayer] Scene ${scene.sceneNumber} video: ${videoPath} (${fileSizeKB} KB)`);
    return videoPath;
  } catch (err: any) {
    console.error(`[VisualLayer] Seedance 2.0 generation failed for scene ${scene.sceneNumber}: ${err.message}`);
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
