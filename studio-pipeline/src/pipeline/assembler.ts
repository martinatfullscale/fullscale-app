import { execFile } from "child_process";
import fs from "fs";
import path from "path";

export interface AssemblyScene {
  imageFile?: string;  // path to JPEG (MVP — static slide)
  videoFile?: string;  // path to MP4 (V1 — AI-generated clip)
  audioFile: string;   // path to MP3
  durationSeconds: number;
}

// 5 minutes per scene, 10 minutes for concat
const SCENE_TIMEOUT_MS = 5 * 60 * 1000;
const CONCAT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run ffmpeg via execFile with a hard timeout.
 * Returns stdout/stderr for debugging.
 */
function runFfmpeg(args: string[], timeoutMs: number, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`[Assembler] ${label} starting...`);
    console.log(`[Assembler] ffmpeg ${args.slice(0, 8).join(" ")}...`);

    const proc = execFile("ffmpeg", args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[Assembler] ${label} FAILED: ${error.message}`);
        if (stderr) console.error(`[Assembler] ${label} stderr: ${stderr.slice(-500)}`);
        reject(new Error(`FFmpeg ${label} failed: ${error.message}`));
      } else {
        console.log(`[Assembler] ${label} done.`);
        resolve(stderr || stdout || "");
      }
    });
  });
}

/**
 * Assemble a final MP4 video from scene images and audio tracks.
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

  console.log(`[Assembler] Starting assembly of ${scenes.length} scenes → ${outputPath}`);

  // Step 1: Create individual scene clips
  const sceneClips: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const clipPath = path.join(outputDir, `_scene_clip_${i}.mp4`);
    sceneClips.push(clipPath);

    console.log(`[Assembler] Encoding scene ${i + 1}/${scenes.length} (${scene.durationSeconds}s)...`);

    if (scene.videoFile) {
      await createVideoSceneClip(scene.videoFile, scene.audioFile, scene.durationSeconds, clipPath);
    } else {
      await createImageSceneClip(scene.imageFile!, scene.audioFile, scene.durationSeconds, clipPath);
    }

    const clipSize = fs.existsSync(clipPath) ? Math.round(fs.statSync(clipPath).size / 1024) : 0;
    console.log(`[Assembler] Scene ${i + 1} done: ${clipSize} KB`);
  }

  // Step 2: Concatenate
  console.log(`[Assembler] Concatenating ${sceneClips.length} scenes...`);

  if (sceneClips.length === 1) {
    fs.copyFileSync(sceneClips[0], outputPath);
  } else {
    await concatClips(sceneClips, outputPath, outputDir);
  }

  // Step 3: Clean up temp clips
  for (const clip of sceneClips) {
    try { fs.unlinkSync(clip); } catch {}
  }
  try { fs.unlinkSync(path.join(outputDir, "_concat_list.txt")); } catch {}

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Assembler finished but output file missing: ${outputPath}`);
  }

  const fileSizeMB = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[Assembler] COMPLETE: ${outputPath} (${fileSizeMB} MB)`);
}

/**
 * Create a scene clip from a static image + audio.
 * Uses 1fps input and output for maximum speed on weak CPUs.
 */
function createImageSceneClip(
  imageFile: string,
  audioFile: string,
  durationSeconds: number,
  outputPath: string
): Promise<string> {
  return runFfmpeg([
    "-y",
    "-loop", "1",
    "-framerate", "1",
    "-i", imageFile,
    "-i", audioFile,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "stillimage",
    "-r", "1",
    "-c:a", "aac",
    "-b:a", "128k",
    "-pix_fmt", "yuv420p",
    "-shortest",
    "-t", String(durationSeconds),
    "-vf", "scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2:color=black",
    outputPath,
  ], SCENE_TIMEOUT_MS, `image-scene`);
}

/**
 * Create a scene clip from a looping video + audio.
 */
function createVideoSceneClip(
  videoFile: string,
  audioFile: string,
  durationSeconds: number,
  outputPath: string
): Promise<string> {
  return runFfmpeg([
    "-y",
    "-stream_loop", "-1",
    "-i", videoFile,
    "-i", audioFile,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-c:a", "aac",
    "-b:a", "128k",
    "-pix_fmt", "yuv420p",
    "-shortest",
    "-t", String(durationSeconds),
    "-vf", "scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2:color=black",
    outputPath,
  ], SCENE_TIMEOUT_MS, `video-scene`);
}

/**
 * Concatenate clips using the concat demuxer with stream copy.
 */
function concatClips(
  clipPaths: string[],
  outputPath: string,
  workDir: string
): Promise<string> {
  const listPath = path.join(workDir, "_concat_list.txt");
  const listContent = clipPaths.map((p) => `file '${p}'`).join("\n");
  fs.writeFileSync(listPath, listContent);

  return runFfmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath,
  ], CONCAT_TIMEOUT_MS, `concat-${clipPaths.length}-clips`);
}
