import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";

export interface AssemblyScene {
  imageFile?: string;  // path to JPEG (MVP — static slide)
  videoFile?: string;  // path to MP4 (V1 — AI-generated clip)
  audioFile: string;   // path to MP3
  durationSeconds: number;
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

  // Step 1: Create individual scene clips
  const sceneClips: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const clipPath = path.join(outputDir, `_scene_clip_${i}.mp4`);
    sceneClips.push(clipPath);

    console.log(`[Assembler] Encoding scene ${i + 1}/${scenes.length} (${scene.durationSeconds}s)...`);

    await createSceneClip(scene, clipPath);
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
 * Create a single scene clip from either a static image or a video clip + audio.
 */
function createSceneClip(scene: AssemblyScene, outputPath: string): Promise<void> {
  if (scene.videoFile) {
    return createVideoSceneClip(scene.videoFile, scene.audioFile, scene.durationSeconds, outputPath);
  }
  return createImageSceneClip(scene.imageFile!, scene.audioFile, scene.durationSeconds, outputPath);
}

/**
 * Loop a static image for the scene duration with audio overlay (MVP).
 */
function createImageSceneClip(
  imageFile: string,
  audioFile: string,
  durationSeconds: number,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imageFile)
      .inputOptions(["-loop", "1", "-framerate", "24"])
      .input(audioFile)
      .outputOptions([
        "-c:v", "libx264",
        "-tune", "stillimage",
        "-c:a", "aac",
        "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-shortest",
        "-t", String(durationSeconds),
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`FFmpeg image scene encode failed: ${err.message}`)))
      .run();
  });
}

/**
 * Loop a short video clip to fill the scene duration, then overlay audio (V1).
 * Seedance clips are 5s; scenes are 20-45s — we loop the clip to fill.
 */
function createVideoSceneClip(
  videoFile: string,
  audioFile: string,
  durationSeconds: number,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoFile)
      .inputOptions(["-stream_loop", "-1"]) // Loop video indefinitely
      .input(audioFile)
      .outputOptions([
        "-c:v", "libx264",
        "-c:a", "aac",
        "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-shortest",
        "-t", String(durationSeconds),
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`FFmpeg video scene encode failed: ${err.message}`)))
      .run();
  });
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
