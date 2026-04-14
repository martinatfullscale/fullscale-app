import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import axios from "axios";
import { fal } from "@fal-ai/client";
import type { Scene, SlideCategory } from "./storyExtractor.js";

const execFileAsync = promisify(execFile);

/**
 * Slides that are primarily photographs → Kling IMAGE-to-video (animate the actual photo).
 * These slides look best when the real image gets subtle motion (breathing, parallax).
 */
const IMAGE_SLIDES: SlideCategory[] = ["title", "person", "graphic"];

/**
 * Slides that are text-heavy or diagrams → Seedance TEXT-to-video (generate new visuals).
 * These slides look terrible when AI tries to animate the text. Instead, generate
 * a cinematic clip from the scene description that TELLS the story visually.
 */
const TEXT_SLIDES: SlideCategory[] = ["text", "data", "product"];

/**
 * Category-specific prompts for Kling image-to-video (IMAGE_SLIDES only).
 */
const IMAGE_MOTION_PROMPTS: Record<string, string> = {
  person:
    "Subtle lifelike animation. Person blinks naturally, slight head movement, " +
    "gentle breathing motion. Preserve the original face exactly — no morphing. " +
    "Background stays completely still. Cinematic shallow depth of field.",
  title:
    "Dramatic, cinematic camera movement. Bold entrance energy. " +
    "Subtle particle effects or light rays in background. " +
    "Text stays crisp and centered — no warping. Premium keynote feel.",
  graphic:
    "Cinematic ken burns effect — slow, elegant camera movement across the visual. " +
    "Subtle depth separation between foreground and background. " +
    "Colors gently shift with cinematic lighting. Smooth and polished.",
};

/**
 * Generate a visual for a scene.
 *
 * MVP:  Pass the slide image straight through (zero cost).
 * V1:   Hybrid — image-to-video for photos, text-to-video for text-heavy slides.
 * V2:   Reserved.
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

  // ALL slides use Seedance 1.5 Pro image-to-video.
  // Sends the actual slide image and adds cinematic motion.
  return generateSeedanceImageToVideoClip(scene, slideImagePath);
}

// ═══════════════════════════════════════════════════════════════
// PATH 1: Kling IMAGE-TO-VIDEO — for slides that ARE photographs
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Seedance 1.5 Pro IMAGE-TO-VIDEO — the 3/24 approach
// ═══════════════════════════════════════════════════════════════

/**
 * Animate a slide using Seedance 1.5 Pro image-to-video.
 * Sends the actual slide image and a motion prompt.
 * Seedance adds cinematic motion to the real content.
 */
async function generateSeedanceImageToVideoClip(
  scene: Scene,
  slideImagePath: string
): Promise<string> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    console.warn("[VisualLayer] No FAL_KEY — falling back to Ken Burns");
    return generateKenBurnsClip(scene, slideImagePath);
  }

  fal.config({ credentials: falKey });

  const outputDir = path.dirname(slideImagePath);
  const videoPath = path.join(outputDir, `scene_${scene.sceneNumber}_video.mp4`);
  const category = scene.slideCategory || "text";

  // Build a motion prompt — tells Seedance HOW to animate, not WHAT to show
  const prompt = buildImageToVideoPrompt(scene);

  console.log(`[VisualLayer] Scene ${scene.sceneNumber}: ${category} — Seedance 1.5 Pro image-to-video`);
  console.log(`[VisualLayer] Prompt: "${prompt.slice(0, 150)}..."`);

  try {
    // Upload the slide image to fal.ai storage
    const imageBuffer = fs.readFileSync(slideImagePath);
    const imageFile = new File([imageBuffer], path.basename(slideImagePath), { type: "image/jpeg" });
    const imageUrl = await fal.storage.upload(imageFile);
    console.log(`[VisualLayer] Uploaded slide image for scene ${scene.sceneNumber}`);

    const result = await fal.subscribe(
      "fal-ai/bytedance/seedance/v1.5/pro/image-to-video",
      {
        input: {
          image_url: imageUrl,
          prompt,
          duration: 4,                 // Shorter = less text degradation
          resolution: "720p",
          aspect_ratio: "16:9",
          generate_audio: false,
          camera_fixed: true,          // Lock camera — reduces drift that warps text
          end_image_url: imageUrl,     // End on the same frame — forces content preservation
        },
        logs: true,
        onQueueUpdate: (update) => {
          if (update.status === "IN_PROGRESS") {
            const msgs = (update as any).logs;
            if (msgs) {
              msgs.map((log: any) => log.message).forEach((msg: string) => {
                console.log(`[VisualLayer/seedance] ${msg}`);
              });
            }
          }
        },
      }
    );

    const videoUrl = (result as any).data?.video?.url || (result as any).video?.url;
    if (!videoUrl) throw new Error("No video URL in Seedance 1.5 response");

    console.log(`[VisualLayer] Downloading Seedance clip for scene ${scene.sceneNumber}...`);
    const response = await axios.get(videoUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(videoPath, Buffer.from(response.data));

    const fileSizeKB = Math.round(fs.statSync(videoPath).size / 1024);
    console.log(`[VisualLayer] Scene ${scene.sceneNumber} Seedance clip: ${videoPath} (${fileSizeKB} KB)`);
    return videoPath;
  } catch (err: any) {
    console.error(`[VisualLayer] Seedance 1.5 failed for scene ${scene.sceneNumber}: ${err.message}`);
    console.warn("[VisualLayer] Falling back to Ken Burns");
    return generateKenBurnsClip(scene, slideImagePath);
  }
}

/**
 * Build a motion prompt for Seedance 1.5 Pro image-to-video.
 * This tells the AI HOW to animate the slide — not what to generate from scratch.
 * The slide image provides the visual content; the prompt provides motion direction.
 *
 * CRITICAL: Seedance tends to generate yellow/colored rectangles and distort text.
 * The prompt must explicitly forbid this.
 */
function buildImageToVideoPrompt(scene: Scene): string {
  const category = scene.slideCategory || "text";
  const camera = scene.cameraDirection || "very slow gentle drift";

  // Base constraint that applies to ALL slides
  const constraint = "Do not add any rectangles, boxes, highlights, overlays, borders, or colored shapes. " +
    "Do not modify, move, or distort any text or letters. All text must remain exactly as shown. " +
    "Only add very subtle camera motion to the existing image.";

  switch (category) {
    case "person":
      return `${camera}. Very subtle lifelike animation — people blink naturally, slight breathing. Preserve all faces and text exactly. ${constraint}`;
    case "title":
      return `${camera}. Very subtle cinematic motion. Preserve all text exactly as shown. ${constraint}`;
    case "graphic":
      return `${camera}. Very slow, elegant drift across the visual. Preserve all elements exactly. ${constraint}`;
    case "product":
      return `${camera}. Very gentle parallax effect. All screenshots and text stay perfectly sharp. ${constraint}`;
    case "data":
      return `${camera}. Nearly still — only the faintest motion. All numbers and text stay perfectly readable. ${constraint}`;
    case "text":
    default:
      return `${camera}. Very subtle slow drift. All text stays perfectly readable and in place. ${constraint}`;
  }
}

// ═══════════════════════════════════════════════════════════════
// FALLBACK: Ken Burns zoom (FFmpeg only, no AI, no distortion)
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a Ken Burns (slow pan+zoom) clip from the slide image.
 * Used as fallback when both Kling and Seedance fail.
 */
async function generateKenBurnsClip(
  scene: Scene,
  slideImagePath: string
): Promise<string> {
  const outputDir = path.dirname(slideImagePath);
  const videoPath = path.join(outputDir, `scene_${scene.sceneNumber}_kenburns.mp4`);
  const duration = Math.max(5, scene.estimatedDurationSeconds || 10);
  const totalFrames = duration * 24;

  console.log(`[VisualLayer] Scene ${scene.sceneNumber}: Ken Burns fallback (${duration}s)`);

  const panX = "iw/2-(iw/zoom/2)";
  const panY = "ih/2-(ih/zoom/2)";

  return new Promise((resolve) => {
    execFile("ffmpeg", [
      "-nostdin", "-y",
      "-loop", "1",
      "-i", slideImagePath,
      "-vf",
      `scale=2560:1440,zoompan=z='min(zoom+0.0001,1.02)':x='${panX}':y='${panY}':d=${totalFrames}:s=1280x720:fps=24`,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "medium",
      "-crf", "22",
      "-t", String(duration),
      "-an",
      videoPath,
    ], { timeout: 60000 }, (err: any) => {
      if (err) {
        console.error(`[VisualLayer] Ken Burns failed: ${err.message}`);
        resolve(slideImagePath);
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

// ═══════════════════════════════════════════════════════════════
// PDF → Slide Images (unchanged)
// ═══════════════════════════════════════════════════════════════

/**
 * Convert each page of a PDF into a JPEG image using pdftoppm.
 */
export async function slidesToImages(
  pdfPath: string,
  outputDir: string
): Promise<string[]> {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF file not found: ${pdfPath}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPrefix = path.join(outputDir, "slide");

  console.log(`[VisualLayer] Converting PDF slides to images...`);

  try {
    await execFileAsync("pdftoppm", ["-jpeg", "-r", "150", pdfPath, outputPrefix]);
  } catch (err: any) {
    console.error(`[VisualLayer] pdftoppm failed: ${err.message}`);
    console.warn("[VisualLayer] Falling back to placeholder slide images");
    return createPlaceholderSlideImages(pdfPath, outputDir);
  }

  const files = fs.readdirSync(outputDir)
    .filter((f) => f.startsWith("slide") && f.endsWith(".jpg"))
    .sort();

  const imagePaths = files.map((f) => path.join(outputDir, f));

  if (imagePaths.length === 0) {
    console.warn("[VisualLayer] pdftoppm produced no images, using placeholders");
    return createPlaceholderSlideImages(pdfPath, outputDir);
  }

  console.log(`[VisualLayer] Generated ${imagePaths.length} slide images`);
  return imagePaths;
}

async function createPlaceholderSlideImages(
  pdfPath: string,
  outputDir: string
): Promise<string[]> {
  fs.mkdirSync(outputDir, { recursive: true });

  let pageCount = 10;
  try {
    const { stdout } = await execFileAsync("pdfinfo", [pdfPath]);
    const match = stdout.match(/Pages:\s+(\d+)/);
    if (match) pageCount = parseInt(match[1], 10);
  } catch {}

  const images: string[] = [];
  for (let i = 1; i <= pageCount; i++) {
    const imgPath = path.join(outputDir, `slide-${String(i).padStart(3, "0")}.jpg`);
    try {
      await execFileAsync("ffmpeg", [
        "-y", "-f", "lavfi",
        "-i", `color=c=#1a1a2e:s=1280x720:d=1`,
        "-vf", `drawtext=text='Slide ${i}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2`,
        "-frames:v", "1", imgPath,
      ], { timeout: 10000 });
    } catch {
      try {
        await execFileAsync("ffmpeg", [
          "-y", "-f", "lavfi",
          "-i", `color=c=#1a1a2e:s=1280x720:d=1`,
          "-frames:v", "1", imgPath,
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
