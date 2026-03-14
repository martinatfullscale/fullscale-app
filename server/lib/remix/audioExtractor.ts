/**
 * Audio Extractor — FFmpeg audio extraction for speech-to-text pipeline.
 *
 * Phase 6.5 of the scanner pipeline.
 * Downloads video from Object Storage → extracts audio → WAV @ 16kHz mono.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { downloadToTempFile } from "../objectStorage";

const execFileAsync = promisify(execFile);

// Audio extraction configuration
const AUDIO_CONFIG = {
  sampleRate: 16000,       // 16kHz — optimal for speech-to-text
  channels: 1,             // Mono — STT doesn't need stereo
  format: "wav",           // WAV — lossless, universally supported by STT providers
  codec: "pcm_s16le",      // 16-bit PCM — standard for speech recognition
  maxDuration: 7200,       // 2 hours max (safety limit)
} as const;

export interface AudioExtractionInput {
  videoId: number;
  filePath: string;        // Object Storage serve URL (e.g., /storage/uploads/video.mp4)
}

export interface AudioExtractionOutput {
  success: boolean;
  audioPath: string;       // Path to extracted WAV file
  duration: number;        // Audio duration in seconds
  sampleRate: number;
  channels: number;
  fileSizeBytes: number;
  error?: string;
}

/**
 * Get the local file path for a video, downloading from Object Storage if needed.
 */
async function resolveVideoPath(filePath: string): Promise<string> {
  // Object Storage path — download to temp
  if (filePath.startsWith("/storage/")) {
    const objectKey = filePath.replace(/^\/storage\//, "public/");
    console.log(`[AudioExtractor] Downloading from Object Storage: ${objectKey}`);
    const localPath = await downloadToTempFile(objectKey, "/tmp/audio-extract");
    return localPath;
  }

  // Local path (legacy) — use directly
  if (fs.existsSync(filePath)) {
    return filePath;
  }

  // Try public/ prefix
  const publicPath = path.join(process.cwd(), "public", filePath.replace(/^\//, ""));
  if (fs.existsSync(publicPath)) {
    return publicPath;
  }

  throw new Error(`Video file not found: ${filePath}`);
}

/**
 * Get audio duration using ffprobe.
 */
async function getAudioDuration(audioPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    return parseFloat(stdout.trim()) || 0;
  } catch (err) {
    console.error("[AudioExtractor] ffprobe error:", err);
    return 0;
  }
}

/**
 * Extract audio from a video file.
 *
 * Produces a 16kHz mono WAV file optimized for speech-to-text processing.
 * Handles both Object Storage and local file paths.
 */
export async function extractAudio(
  input: AudioExtractionInput
): Promise<AudioExtractionOutput> {
  const { videoId, filePath } = input;
  const outputDir = "/tmp/audio-extract";
  const outputPath = path.join(outputDir, `video-${videoId}-audio.wav`);

  console.log(`[AudioExtractor] Starting audio extraction for video ${videoId}`);

  try {
    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Clean up any previous extraction
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    // Resolve video file path (download from Object Storage if needed)
    const localVideoPath = await resolveVideoPath(filePath);
    console.log(`[AudioExtractor] Video resolved to: ${localVideoPath}`);

    // Extract audio with FFmpeg
    // -vn: no video, -acodec pcm_s16le: 16-bit PCM, -ar 16000: 16kHz, -ac 1: mono
    const ffmpegArgs = [
      "-i", localVideoPath,
      "-vn",                                // No video
      "-acodec", AUDIO_CONFIG.codec,        // 16-bit PCM
      "-ar", String(AUDIO_CONFIG.sampleRate), // 16kHz
      "-ac", String(AUDIO_CONFIG.channels), // Mono
      "-t", String(AUDIO_CONFIG.maxDuration), // Safety limit
      "-y",                                 // Overwrite
      outputPath,
    ];

    console.log(`[AudioExtractor] Running FFmpeg: ffmpeg ${ffmpegArgs.join(" ")}`);

    await execFileAsync("ffmpeg", ffmpegArgs, {
      timeout: 120000, // 2 minute timeout for extraction
    });

    // Verify output exists
    if (!fs.existsSync(outputPath)) {
      throw new Error("FFmpeg completed but output file not found");
    }

    const stats = fs.statSync(outputPath);
    const duration = await getAudioDuration(outputPath);

    console.log(`[AudioExtractor] Audio extracted: ${duration.toFixed(1)}s, ${(stats.size / 1024 / 1024).toFixed(1)}MB`);

    return {
      success: true,
      audioPath: outputPath,
      duration,
      sampleRate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels,
      fileSizeBytes: stats.size,
    };
  } catch (err: any) {
    console.error(`[AudioExtractor] Extraction failed for video ${videoId}:`, err.message);
    return {
      success: false,
      audioPath: "",
      duration: 0,
      sampleRate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels,
      fileSizeBytes: 0,
      error: err.message,
    };
  }
}

/**
 * Clean up temporary audio files for a video.
 */
export function cleanupAudioFiles(videoId: number): void {
  const audioPath = `/tmp/audio-extract/video-${videoId}-audio.wav`;
  try {
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
      console.log(`[AudioExtractor] Cleaned up: ${audioPath}`);
    }
  } catch (err) {
    console.warn(`[AudioExtractor] Cleanup failed for ${audioPath}:`, err);
  }
}

export { AUDIO_CONFIG };
