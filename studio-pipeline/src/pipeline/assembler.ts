import ffmpeg from "fluent-ffmpeg";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

/**
 * Scene layout — determines how avatar and slide share the frame.
 *
 * "avatar-full"  → Avatar fills 1280×720, slide is not shown.
 *                   Used for title, closing / "ask" scenes.
 * "avatar-pip"   → Slide fills 1280×720, avatar in bottom-right PIP (240×240).
 *                   Used for text-heavy / data scenes so content is readable.
 * "slide-only"   → Slide fills 1280×720, no avatar.
 *                   Used for photo / product / graphic scenes, or fallback when
 *                   avatar generation fails.
 */
export type SceneLayout = "avatar-full" | "avatar-pip" | "slide-only";

export interface AssemblyScene {
  imageFile?: string;    // path to JPEG (MVP — static slide)
  videoFile?: string;    // path to MP4 (V1 — Ken Burns clip or AI-generated)
  audioFile: string;     // path to MP3
  durationSeconds: number;

  // Phase 1: avatar integration
  avatarFile?: string;   // path to talking-head MP4 (from avatarLayer)
  layout?: SceneLayout;  // defaults to "slide-only" if omitted

  // Legacy highlight fields (Phase 0 no-op'd — kept for type compat)
  keyPhrase?: string;
  highlightRegion?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  highlightStartSec?: number;
  highlightEndSec?: number;
}

/**
 * Assemble a final MP4 video from scene images and audio tracks.
 *
 * For each scene: loops the image for durationSeconds with the audio overlay.
 * Then concatenates all scenes into a single MP4.
 */
export async function assembleVideo(
  scenes: AssemblyScene[],
  outputPath: string
): Promise<void> {
  if (scenes.length === 0) {
    throw new Error("No scenes provided for assembly");
  }

  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  // Step 1: Create individual scene clips with fade transitions
  const sceneClips: string[] = [];
  const FADE_DURATION = 0.4; // seconds — brief dip-to-black between scenes

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const clipPath = path.join(outputDir, `_scene_clip_${i}.mp4`);
    sceneClips.push(clipPath);

    console.log(`[Assembler] Encoding scene ${i + 1}/${scenes.length} (${scene.durationSeconds}s)...`);

    await createSceneClip(scene, clipPath);

    // Add fade-in / fade-out to each clip for smooth transitions.
    // First clip gets fade-in only, last gets fade-out only, middle gets both.
    const fadeIn = i > 0;
    const fadeOut = i < scenes.length - 1;
    if (fadeIn || fadeOut) {
      await addFadeTransitions(clipPath, scene.durationSeconds, FADE_DURATION, fadeIn, fadeOut);
    }
  }

  // Step 2: Concatenate all scene clips
  console.log(`[Assembler] Concatenating ${sceneClips.length} scenes...`);

  if (sceneClips.length === 1) {
    // Single scene — just copy
    fs.copyFileSync(sceneClips[0], outputPath);
  } else {
    await concatClips(sceneClips, outputPath, outputDir);
  }

  // Step 3: Clean up temp scene clips
  for (const clip of sceneClips) {
    try {
      fs.unlinkSync(clip);
    } catch {}
  }

  // Clean up concat list file
  try {
    fs.unlinkSync(path.join(outputDir, "_concat_list.txt"));
  } catch {}

  const fileSizeMB = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[Assembler] Output: ${outputPath} (${fileSizeMB} MB)`);
}

/**
 * Create a single scene clip, branching on layout:
 *
 * "avatar-full"  → Avatar MP4 scaled to 1280×720, audio from avatar track
 * "avatar-pip"   → Slide as base + avatar in bottom-right PIP (240px wide)
 * "slide-only"   → Existing slide-only path (Ken Burns or still image + audio)
 */
function createSceneClip(scene: AssemblyScene, outputPath: string): Promise<void> {
  const layout = scene.layout || "slide-only";
  const hasAvatar = scene.avatarFile && fs.existsSync(scene.avatarFile) && fs.statSync(scene.avatarFile).size > 1000;

  // Avatar-full: avatar video fills the frame
  if (layout === "avatar-full" && hasAvatar) {
    return withTimeout(
      createAvatarFullClip(scene, outputPath),
      180000,
      `Avatar-full clip encoding timed out`
    );
  }

  // Avatar-PIP: slide as main, avatar overlay in corner
  if (layout === "avatar-pip" && hasAvatar) {
    return withTimeout(
      createAvatarPipClip(scene, outputPath),
      180000,
      `Avatar-PIP clip encoding timed out`
    );
  }

  // Slide-only (default): existing Ken Burns / still image path
  if (scene.videoFile && fs.existsSync(scene.videoFile) && fs.statSync(scene.videoFile).size > 1000) {
    return withTimeout(
      createVideoSceneClip(scene, outputPath),
      120000,
      `Scene clip encoding timed out`
    );
  }

  const imageFile = scene.imageFile || scene.videoFile;
  if (!imageFile || !fs.existsSync(imageFile)) {
    console.warn(`[Assembler] Missing media file for scene — skipping`);
    return createBlankClip(scene.audioFile, scene.durationSeconds, outputPath);
  }
  return withTimeout(
    createImageSceneClip(imageFile, scene, outputPath),
    120000,
    `Image scene encoding timed out`
  );
}

/**
 * Build an FFmpeg drawbox filter string for the highlight region.
 *
 * PHASE 0: Permanently disabled. The yellow highlight box was producing
 * visible artifacts in generated videos even after the Claude prompt was
 * stripped of highlight instructions (any residual highlightRegion data
 * on a scene would still render a box here).
 *
 * The function signature is preserved so callers don't need changes; it
 * always returns an empty string, so ffmpeg filter chains skip the overlay.
 * If highlight overlays are ever wanted again, reinstate by reverting this
 * file — the original implementation is in git history.
 */
function buildHighlightFilter(_scene: AssemblyScene): string {
  return "";
}

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

// ═══════════════════════════════════════════════════════════════
// AVATAR-FULL: talking head fills the entire 1280×720 frame
// ═══════════════════════════════════════════════════════════════

function createAvatarFullClip(scene: AssemblyScene, outputPath: string): Promise<void> {
  const baseFilter = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black";

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(scene.avatarFile!)
      .inputOptions([])
      .input(scene.audioFile)
      .outputOptions([
        "-c:v", "libx264",
        "-c:a", "aac",
        "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-shortest",
        "-t", String(scene.durationSeconds),
        "-vf", baseFilter,
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`FFmpeg avatar-full failed: ${err.message}`)))
      .run();
  });
}

// ═══════════════════════════════════════════════════════════════
// AVATAR-PIP: slide fills 1280×720, avatar in bottom-right corner
// ═══════════════════════════════════════════════════════════════

/**
 * Composite slide (Ken Burns or still) as the main frame with the avatar
 * video overlaid as a picture-in-picture in the bottom-right corner.
 *
 * PIP size: 240×240 with 16px margin from the right and bottom edges.
 * The avatar is scaled to fit inside that box, maintaining aspect ratio.
 *
 * Uses raw ffmpeg via execFile because fluent-ffmpeg's -filter_complex
 * API can be unreliable with multi-input overlays.
 */
function createAvatarPipClip(scene: AssemblyScene, outputPath: string): Promise<void> {
  // Determine slide input — prefer video (Ken Burns MP4), fall back to image
  const slideInput = (scene.videoFile && fs.existsSync(scene.videoFile) && fs.statSync(scene.videoFile).size > 1000)
    ? scene.videoFile
    : scene.imageFile;

  if (!slideInput || !fs.existsSync(slideInput)) {
    // No slide available — fall back to avatar-full
    return createAvatarFullClip(scene, outputPath);
  }

  const isSlideImage = !slideInput.endsWith(".mp4");
  const pipW = 240;
  const margin = 16;

  // Build the filter_complex:
  // [0] = slide (video or image), [1] = avatar, [2] = audio
  // Scale slide to 1280×720, scale avatar to pipW wide, overlay in bottom-right
  const filterComplex = [
    `[0]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black[bg]`,
    `[1]scale=${pipW}:-1[pip]`,
    `[bg][pip]overlay=W-w-${margin}:H-h-${margin}:shortest=1[out]`,
  ].join(";");

  const args: string[] = [
    "-nostdin", "-y",
    // Input 0: slide
    ...(isSlideImage ? ["-loop", "1", "-framerate", "24"] : []),
    "-i", slideInput,
    // Input 1: avatar
    "-i", scene.avatarFile!,
    // Input 2: audio
    "-i", scene.audioFile,
    // Filter
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-map", "2:a",
    // Encoding
    "-c:v", "libx264",
    "-c:a", "aac",
    "-b:a", "192k",
    "-pix_fmt", "yuv420p",
    "-t", String(scene.durationSeconds),
    "-shortest",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    execFile("/opt/homebrew/bin/ffmpeg", args, { timeout: 180000 }, (err) => {
      if (err) {
        console.error(`[Assembler] Avatar-PIP ffmpeg failed:`, err.message);
        // Fall back to avatar-full on composite failure
        console.warn("[Assembler] Falling back to avatar-full layout");
        createAvatarFullClip(scene, outputPath).then(resolve).catch(reject);
        return;
      }
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
        resolve();
      } else {
        reject(new Error("Avatar-PIP produced empty output"));
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// BLANK CLIP (fallback)
// ═══════════════════════════════════════════════════════════════

function createBlankClip(audioFile: string, durationSeconds: number, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(`color=c=black:s=1280x720:d=${durationSeconds}`)
      .inputOptions(["-f", "lavfi"])
      .input(audioFile)
      .outputOptions([
        "-c:v", "libx264",
        "-c:a", "aac",
        "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-shortest",
        "-t", String(durationSeconds),
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`FFmpeg blank clip failed: ${err.message}`)))
      .run();
  });
}

/**
 * Loop a static image for the scene duration with audio overlay (MVP).
 * Applies highlight drawbox if the scene has highlightRegion.
 */
function createImageSceneClip(
  imageFile: string,
  scene: AssemblyScene,
  outputPath: string
): Promise<void> {
  const baseFilter = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black";
  const highlight = buildHighlightFilter(scene);
  const vf = highlight ? `${baseFilter},${highlight}` : baseFilter;

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imageFile)
      .inputOptions(["-loop", "1", "-framerate", "24"])
      .input(scene.audioFile)
      .outputOptions([
        "-c:v", "libx264",
        "-tune", "stillimage",
        "-c:a", "aac",
        "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-shortest",
        "-t", String(scene.durationSeconds),
        "-vf", vf,
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`FFmpeg image scene encode failed: ${err.message}`)))
      .run();
  });
}

/**
 * Loop a short video clip to fill the scene duration, then overlay audio (V1).
 * Applies highlight drawbox if the scene has highlightRegion.
 */
function createVideoSceneClip(
  scene: AssemblyScene,
  outputPath: string
): Promise<void> {
  const baseFilter = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black";
  const highlight = buildHighlightFilter(scene);
  const vf = highlight ? `${baseFilter},${highlight}` : baseFilter;

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(scene.videoFile!)
      // No looping — play the clip once, then hold on the last frame
      .inputOptions([])
      .input(scene.audioFile)
      .outputOptions([
        "-c:v", "libx264",
        "-c:a", "aac",
        "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-shortest",
        "-t", String(scene.durationSeconds),
        "-vf", vf,
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`FFmpeg video scene encode failed: ${err.message}`)))
      .run();
  });
}

// ═══════════════════════════════════════════════════════════════
// FADE TRANSITIONS — smooth dip-to-black between scenes
// ═══════════════════════════════════════════════════════════════

/**
 * Add fade-in and/or fade-out to an existing clip.
 * Re-encodes the clip (fast for short scenes — adds ~2-3s per clip).
 */
async function addFadeTransitions(
  clipPath: string,
  durationSeconds: number,
  fadeDuration: number,
  fadeIn: boolean,
  fadeOut: boolean
): Promise<void> {
  const tempPath = clipPath.replace(".mp4", "_prefade.mp4");
  fs.renameSync(clipPath, tempPath);

  const vFilters: string[] = [];
  const aFilters: string[] = [];

  if (fadeIn) {
    vFilters.push(`fade=t=in:st=0:d=${fadeDuration}`);
    aFilters.push(`afade=t=in:st=0:d=${fadeDuration}`);
  }
  if (fadeOut) {
    const outStart = Math.max(0, durationSeconds - fadeDuration);
    vFilters.push(`fade=t=out:st=${outStart}:d=${fadeDuration}`);
    aFilters.push(`afade=t=out:st=${outStart}:d=${fadeDuration}`);
  }

  const args: string[] = [
    "-nostdin", "-y",
    "-i", tempPath,
    "-vf", vFilters.join(","),
    "-af", aFilters.join(","),
    "-c:v", "libx264",
    "-c:a", "aac",
    "-pix_fmt", "yuv420p",
    "-preset", "fast",
    clipPath,
  ];

  try {
    await execFileAsync("/opt/homebrew/bin/ffmpeg", args, { timeout: 30000 });
  } catch (err: any) {
    // If fade fails, restore the original clip (hard cut is better than no clip)
    console.warn(`[Assembler] Fade failed, keeping hard cut: ${err.message}`);
    if (fs.existsSync(tempPath)) {
      fs.renameSync(tempPath, clipPath);
    }
    return;
  }

  // Clean up temp
  try { fs.unlinkSync(tempPath); } catch {}
}

/**
 * Concatenate multiple MP4 clips using FFmpeg concat demuxer.
 */
function concatClips(
  clipPaths: string[],
  outputPath: string,
  workDir: string
): Promise<void> {
  // Write a concat list file
  const listPath = path.join(workDir, "_concat_list.txt");
  const listContent = clipPaths
    .map((p) => `file '${p}'`)
    .join("\n");
  fs.writeFileSync(listPath, listContent);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions([
        "-f", "concat",
        "-safe", "0",
      ])
      .outputOptions([
        "-c:v", "libx264",
        "-c:a", "aac",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`FFmpeg concat failed: ${err.message}`)))
      .run();
  });
}
