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

  // ALL slides use Seedance 1.5 Pro text-to-video.
  // The slide image is the script source, NOT the visual source.
  // Seedance generates entirely new cinematic visuals from the scene description.
  return generateTextToVideoClip(scene, slideImagePath);
}

// ═══════════════════════════════════════════════════════════════
// PATH 1: Kling IMAGE-TO-VIDEO — for slides that ARE photographs
// ═══════════════════════════════════════════════════════════════

/**
 * Animate a photograph slide using Kling 3.0 image-to-video.
 * The actual slide image is sent to Kling, which adds subtle motion.
 * Best for: title slides with background photos, headshots, lifestyle imagery.
 */
async function generateImageMotionClip(
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
  const category = scene.slideCategory || "title";
  const prompt = `${scene.cameraDirection || "slow push-in"}. ${IMAGE_MOTION_PROMPTS[category] || IMAGE_MOTION_PROMPTS["title"]}`;

  console.log(`[VisualLayer] Scene ${scene.sceneNumber}: ${category} — Kling image-to-video`);
  console.log(`[VisualLayer] Prompt: "${prompt.slice(0, 120)}..."`);

  try {
    const imageBuffer = fs.readFileSync(slideImagePath);
    const imageFile = new File([imageBuffer], path.basename(slideImagePath), { type: "image/jpeg" });
    const imageUrl = await fal.storage.upload(imageFile);

    const cfgScale = category === "person" ? 0.3 : category === "title" ? 0.7 : 0.5;

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
                console.log(`[VisualLayer/kling] ${msg}`);
              });
            }
          }
        },
      }
    );

    const videoUrl = (result as any).data?.video?.url;
    if (!videoUrl) throw new Error("No video URL in Kling response");

    console.log(`[VisualLayer] Downloading Kling clip for scene ${scene.sceneNumber}...`);
    const response = await axios.get(videoUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(videoPath, Buffer.from(response.data));

    const fileSizeKB = Math.round(fs.statSync(videoPath).size / 1024);
    console.log(`[VisualLayer] Scene ${scene.sceneNumber} Kling clip: ${videoPath} (${fileSizeKB} KB)`);
    return videoPath;
  } catch (err: any) {
    console.error(`[VisualLayer] Kling failed for scene ${scene.sceneNumber}: ${err.message}`);
    console.warn("[VisualLayer] Falling back to Ken Burns");
    return generateKenBurnsClip(scene, slideImagePath);
  }
}

// ═══════════════════════════════════════════════════════════════
// PATH 2: Seedance TEXT-TO-VIDEO — for text-heavy / diagram slides
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a cinematic video clip from a TEXT PROMPT describing the scene.
 * Does NOT animate the slide image — creates entirely new visuals that
 * tell the story cinematically. Best for text-heavy slides where animating
 * the actual JPEG produces distorted garbage.
 *
 * Uses Seedance 1.5 Pro text-to-video on fal.ai.
 */
async function generateTextToVideoClip(
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
  const prompt = buildTextToVideoPrompt(scene);

  console.log(`[VisualLayer] Scene ${scene.sceneNumber}: ${scene.slideCategory} — Seedance text-to-video`);
  console.log(`[VisualLayer] Prompt: "${prompt.slice(0, 150)}..."`);

  try {
    const result = await fal.subscribe(
      "fal-ai/bytedance/seedance/v1.5/pro/text-to-video",
      {
        input: {
          prompt,
          duration: 5,
          resolution: "720p",
          aspect_ratio: "16:9",
          generate_audio: false,
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
    if (!videoUrl) throw new Error("No video URL in Seedance response");

    console.log(`[VisualLayer] Downloading Seedance clip for scene ${scene.sceneNumber}...`);
    const response = await axios.get(videoUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(videoPath, Buffer.from(response.data));

    const fileSizeKB = Math.round(fs.statSync(videoPath).size / 1024);
    console.log(`[VisualLayer] Scene ${scene.sceneNumber} Seedance clip: ${videoPath} (${fileSizeKB} KB)`);
    return videoPath;
  } catch (err: any) {
    console.error(`[VisualLayer] Seedance text-to-video failed for scene ${scene.sceneNumber}: ${err.message}`);
    console.warn("[VisualLayer] Falling back to Ken Burns");
    return generateKenBurnsClip(scene, slideImagePath);
  }
}

/**
 * Build a video prompt from scene data.
 * Matches the 3/24 approach: simple, grounded, professional.
 * The AI should generate REAL-WORLD visuals, not abstract art.
 */
function buildTextToVideoPrompt(scene: Scene): string {
  return (
    `Professional cinematic visual: ${scene.visualFocus}. ` +
    `Scene context: "${scene.sceneTitle}". ` +
    `Camera: ${scene.cameraDirection || "smooth slow push-in"}. ` +
    `Style: photorealistic, real-world setting, natural lighting, ` +
    `modern and clean. High production value. ` +
    `No text, no words, no letters, no UI overlays, no abstract shapes, no geometric patterns. ` +
    `Only real objects, real people, real environments.`
  );
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
      `scale=2560:1440,zoompan=z='min(zoom+0.0005,1.06)':x='${panX}':y='${panY}':d=${totalFrames}:s=1280x720:fps=24`,
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
