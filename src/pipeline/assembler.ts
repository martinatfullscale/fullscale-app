import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";

export interface AssemblyScene {
  imageFile?: string;  // path to JPEG (MVP — static slide)
  videoFile?: string;  // path to MP4 (V1 — AI-generated clip)
  audioFile: string;   // path to MP3
  durationSeconds: number;
}

// Timeout per scene clip (5 minutes) and concat (10 minutes)
const SCENE_TIMEOUT_MS = 5 * 60 * 1000;
const CONCAT_TIMEOUT_MS = 10 * 60 * 1000;

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
    console.log(`[Assembler] Scene ${i + 1}/${scenes.length} done.`);
  }

  // Step 2: Concatenate all scene clips
  console.log(`[Assembler] Concatenating ${sceneClips.length} scenes...`);

  if (sceneClips.length === 1) {
    // Single scene — just copy
    fs.copyFileSync(sceneClips[0], outputPath);
  } else {
    await concatClips(sceneClips, outputPath, outputDir);
  }

  console.log(`[Assembler] Concatenation done.`);

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
 * Run an ffmpeg command with a timeout. Kills the process if it exceeds the limit.
 */
function runWithTimeout(cmd: ffmpeg.FfmpegCommand, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ffmpegProcess: any = null;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        console.error(`[Assembler] TIMEOUT: ${label} exceeded ${timeoutMs / 1000}s`);
        try {
          if (ffmpegProcess) ffmpegProcess.kill("SIGKILL");
          else cmd.kill("SIGKILL");
        } catch {}
        reject(new Error(`FFmpeg timeout: ${label} exceeded ${timeoutMs / 1000}s limit`));
      }
    }, timeoutMs);

    cmd
      .on("start", (commandLine: string) => {
        console.log(`[Assembler] ${label} cmd: ${commandLine.substring(0, 200)}...`);
      })
      .on("end", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      })
      .on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`FFmpeg ${label} failed: ${err.message}`));
        }
      })
      .on("progress", (progress: any) => {
        if (progress?.timemark) {
          console.log(`[Assembler] ${label} progress: ${progress.timemark}`);
        }
      });

    // Capture the spawned process
    try {
      ffmpegProcess = cmd.run();
    } catch (err: any) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`FFmpeg ${label} spawn failed: ${err.message}`));
      }
    }
  });
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
  const cmd = ffmpeg()
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
    .output(outputPath);

  return runWithTimeout(cmd, SCENE_TIMEOUT_MS, `image-scene`);
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
  const cmd = ffmpeg()
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
    .output(outputPath);

  return runWithTimeout(cmd, SCENE_TIMEOUT_MS, `video-scene`);
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

  const cmd = ffmpeg()
    .input(listPath)
    .inputOptions([
      "-f", "concat",
      "-safe", "0",
    ])
    .outputOptions([
      "-c", "copy",           // stream copy — no re-encoding needed
      "-movflags", "+faststart",
    ])
    .output(outputPath);

  return runWithTimeout(cmd, CONCAT_TIMEOUT_MS, `concat-${clipPaths.length}-clips`);
}
