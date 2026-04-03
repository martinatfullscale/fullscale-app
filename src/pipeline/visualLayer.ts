import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import axios from "axios";
import { fal } from "@fal-ai/client";
import type { Scene } from "./storyExtractor.js";

const execFileAsync = promisify(execFile);

/**
 * Generate a visual for a scene based on the current tier.
 *
 * MVP:  Pass the slide image straight through (zero cost, no API call).
 * V1:   Kling 3.0 image-to-video via fal.ai — animates the actual slide image.
 *       Text-heavy slides stay static (AI mangles text/numbers).
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
      return generateKlingClip(scene, slideImagePath);

    case "v2":
      throw new Error("V2 tier not yet configured. Using V1 (Kling 3.0).");

    default:
      return slideImagePath;
  }
}

/**
 * Generate an AI video clip using Kling 3.0 image-to-video via fal.ai.
 * Takes the actual slide image and animates it into a video clip.
 * Text-heavy slides are kept static — AI mangles text and numbers.
 * Falls back to the static slide image if FAL_KEY is not set or on error.
 */
async function generateKlingClip(
  scene: Scene,
  slideImagePath: string
): Promise<string> {
  // Skip AI animation for text-heavy slides — keeps text crisp and readable
  const slideType = (scene as any).slideType || "text-heavy";
  if (slideType === "text-heavy") {
    console.log(`[VisualLayer] Scene ${scene.sceneNumber}: text-heavy slide — keeping static (no AI animation)`);
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
  const prompt = buildVideoPrompt(scene);

  console.log(`[VisualLayer] Scene ${scene.sceneNumber}: visual slide — animating with Kling 3.0 image-to-video`);
  console.log(`[VisualLayer] Prompt: "${prompt.slice(0, 200)}..."`);

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

    const result = await fal.subscribe(
      "fal-ai/kling-video/v3/standard/image-to-video",
      {
        input: {
          start_image_url: imageUrl,
          prompt,
          duration: "5",
          generate_audio: false,
          negative_prompt: "blur, distort, low quality, watermark, morphing text, changing letters, garbled words",
          cfg_scale: 0.5,
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
    if (!videoUrl) {
      throw new Error("No video URL in fal.ai response");
    }

    console.log(`[VisualLayer] Downloading clip for scene ${scene.sceneNumber}...`);
    const response = await axios.get(videoUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(videoPath, Buffer.from(response.data));

    const fileSizeKB = Math.round(fs.statSync(videoPath).size / 1024);
    console.log(`[VisualLayer] Scene ${scene.sceneNumber} video: ${videoPath} (${fileSizeKB} KB)`);
    return videoPath;
  } catch (err: any) {
    console.error(`[VisualLayer] Kling generation failed for scene ${scene.sceneNumber}: ${err.message}`);
    console.warn("[VisualLayer] Falling back to static slide image");
    return slideImagePath;
  }
}

/**
 * Build a motion/camera prompt for image-to-video.
 * Since the actual slide image is the visual input, the prompt focuses on
 * HOW to animate it — camera movement, subtle motion, and cinematic feel.
 * We do NOT describe what's in the image (Kling already sees it).
 */
function buildVideoPrompt(scene: Scene): string {
  const camera = (scene as any).cameraDirection || "slow cinematic push-in";

  const parts: string[] = [];

  // Describe the desired motion/animation, not the content
  parts.push(`${camera}.`);

  // Add subtle life to the image
  parts.push(
    "Subtle natural motion, gentle parallax depth effect. " +
    "Cinematic lighting with soft highlights. " +
    "Smooth, professional camera movement. " +
    "Keep all text and graphics sharp and stable — do not warp or distort any elements."
  );

  return parts.join(" ");
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
