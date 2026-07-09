/**
 * Clip Stitcher — Multi-segment video concatenation with transitions.
 *
 * Takes multiple non-contiguous segments from a source video, applies
 * transitions (cut, crossfade) between them, and produces a single
 * highlight reel output.
 *
 * Used by Phase 2B: Multi-Segment Stitching (OpusClip-style).
 */

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { PlatformConfig } from "./clipDetector";
import type { CaptionSegment } from "./clipGenerator";
import { withRenderSlot } from "./renderQueue";

// ── Types ──────────────────────────────────────────────────────────

export interface StitchSegment {
  start: number;    // absolute timestamp in source video (seconds)
  end: number;      // absolute timestamp in source video (seconds)
  transitionIn: "cut" | "crossfade" | "branded_wipe";
  transitionDuration?: number; // seconds, default 0.5
}

export interface StitchInput {
  videoPath: string;
  videoId: number;
  segments: StitchSegment[];
  platformConfig: PlatformConfig;
  captionsEnabled: boolean;
  captionSegments?: CaptionSegment[]; // timestamps relative to final output start
  outputDir: string;
  planId: number;
  /** Brand product for transition card generation (Phase 3) */
  brandProduct?: {
    id: number;
    name: string;
    category: string | null;
    dominantColor?: string | null;
  };
}

export interface StitchOutput {
  success: boolean;
  outputPath: string | null;
  thumbnailPath: string | null;
  duration: number;
  fileSize: number;
  error?: string;
}

// ── Config ─────────────────────────────────────────────────────────

const STITCH_CONFIG = {
  CRF: 20,
  PRESET: "medium",
  AUDIO_BITRATE: "128k",
  THUMBNAIL_WIDTH: 360,
  FFMPEG_TIMEOUT_MS: 600000, // 10 minutes — stitching is heavier
  DEFAULT_CROSSFADE_DURATION: 0.5,
};

// ── Main Stitch Function ───────────────────────────────────────────

/**
 * Stitch multiple video segments into a single highlight reel.
 *
 * Strategy:
 * - If all transitions are "cut": Use FFmpeg concat demuxer (fast)
 * - If any transitions are "crossfade": Use filter_complex with xfade (quality)
 */
export function stitchSegments(input: StitchInput): Promise<StitchOutput> {
  // Gated by the global render queue — a stitch runs N segment extractions plus
  // a concat/xfade encode, the heaviest single render in the app.
  return withRenderSlot(
    `stitchSegments(video ${input.videoId}, ${input.segments.length} segments)`,
    () => stitchSegmentsUngated(input),
  );
}

async function stitchSegmentsUngated(input: StitchInput): Promise<StitchOutput> {
  const {
    videoPath, videoId, segments, platformConfig,
    captionsEnabled, captionSegments, outputDir, planId,
  } = input;

  const emptyResult: StitchOutput = {
    success: false, outputPath: null, thumbnailPath: null, duration: 0, fileSize: 0,
  };

  if (segments.length === 0) {
    return { ...emptyResult, error: "No segments provided" };
  }

  try {
    fs.mkdirSync(outputDir, { recursive: true });

    const outputFilename = `stitch_p${planId}_v${videoId}_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);
    const tempDir = path.join(outputDir, `temp_stitch_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Phase 3: Generate transition card placeholders for branded_wipe segments
    const hasBrandedWipe = segments.some((seg, i) => i > 0 && seg.transitionIn === "branded_wipe");
    if (hasBrandedWipe && input.brandProduct) {
      try {
        const { generateTransitionCard } = await import("../ai/image-gen/assetGenerator");
        const cardResult = await generateTransitionCard({
          videoId,
          brandProduct: input.brandProduct,
          targetPlatform: platformConfig.name.toLowerCase(),
          style: "minimal",
        });
        if (cardResult.success) {
          console.log(`[ClipStitcher] Transition card generated: ${cardResult.assetPath}`);
          // Note: When Seeddance API is live, this card MP4 will be inserted between segments.
          // For now, branded_wipe falls back to crossfade with the placeholder recorded.
        }
      } catch (err: any) {
        console.warn(`[ClipStitcher] Transition card generation failed: ${err.message}`);
      }
    }

    // Determine if we need crossfade or can do simple concat
    // branded_wipe falls back to crossfade until Seeddance transition cards produce real video
    const hasCrossfade = segments.some(
      (seg, i) => i > 0 && (seg.transitionIn === "crossfade" || seg.transitionIn === "branded_wipe")
    );

    if (segments.length === 1) {
      // Single segment — just extract it
      await extractSegment(videoPath, segments[0], platformConfig, outputPath);
    } else if (!hasCrossfade) {
      // All cuts — use fast concat demuxer
      await stitchWithConcatDemuxer(videoPath, segments, platformConfig, tempDir, outputPath);
    } else {
      // Has crossfades (or branded_wipe fallback) — use filter_complex
      await stitchWithXfade(videoPath, segments, platformConfig, tempDir, outputPath);
    }

    // Verify output
    if (!fs.existsSync(outputPath)) {
      return { ...emptyResult, error: "Stitched output not created" };
    }

    // Apply caption burn-in if needed (post-stitch)
    if (captionsEnabled && captionSegments && captionSegments.length > 0) {
      const captionedPath = outputPath.replace(".mp4", "_captioned.mp4");
      await burnCaptions(outputPath, captionSegments, platformConfig, captionedPath);
      if (fs.existsSync(captionedPath)) {
        fs.unlinkSync(outputPath);
        fs.renameSync(captionedPath, outputPath);
      }
    }

    const stats = fs.statSync(outputPath);

    // Generate thumbnail from 25% into the output
    const duration = await getOutputDuration(outputPath);
    const thumbnailFilename = outputFilename.replace(".mp4", "_thumb.jpg");
    const thumbnailPath = path.join(outputDir, thumbnailFilename);
    await generateThumbnail(outputPath, thumbnailPath, duration * 0.25);

    // Cleanup temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }

    console.log(
      `[ClipStitcher] Generated: ${outputFilename} ` +
        `(${duration.toFixed(1)}s, ${(stats.size / 1024 / 1024).toFixed(1)}MB, ` +
        `${segments.length} segments)`
    );

    return {
      success: true,
      outputPath,
      thumbnailPath: fs.existsSync(thumbnailPath) ? thumbnailPath : null,
      duration,
      fileSize: stats.size,
    };
  } catch (err: any) {
    console.error("[ClipStitcher] Error:", err.message);
    return { ...emptyResult, error: err.message };
  }
}

// ── Single Segment Extraction ──────────────────────────────────────

async function extractSegment(
  videoPath: string,
  segment: StitchSegment,
  config: PlatformConfig,
  outputPath: string
): Promise<void> {
  const duration = segment.end - segment.start;
  const filters = buildScaleFilters(config);

  const args = [
    "-nostdin", "-y",
    "-ss", segment.start.toString(),
    "-i", videoPath,
    "-t", duration.toString(),
    "-vf", filters.join(","),
    "-r", config.targetFps.toString(),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-preset", STITCH_CONFIG.PRESET,
    "-crf", STITCH_CONFIG.CRF.toString(),
    "-c:a", "aac", "-b:a", STITCH_CONFIG.AUDIO_BITRATE,
    "-shortest",
    "-movflags", "+faststart",
    outputPath,
  ];

  await runFFmpeg(args);
}

// ── Concat Demuxer (Cut transitions only) ──────────────────────────

async function stitchWithConcatDemuxer(
  videoPath: string,
  segments: StitchSegment[],
  config: PlatformConfig,
  tempDir: string,
  outputPath: string
): Promise<void> {
  console.log(`[ClipStitcher] Using concat demuxer for ${segments.length} segments (all cuts)`);

  // Step 1: Extract each segment to a temp file with consistent encoding
  const segPaths: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segPath = path.join(tempDir, `seg_${i}.mp4`);
    await extractSegment(videoPath, seg, config, segPath);
    segPaths.push(segPath);
  }

  // Step 2: Create concat list file
  const concatListPath = path.join(tempDir, "concat.txt");
  const concatList = segPaths.map(p => `file '${p}'`).join("\n");
  fs.writeFileSync(concatListPath, concatList);

  // Step 3: Concat with demuxer (fast, no re-encode needed since segments are already formatted)
  const args = [
    "-nostdin", "-y",
    "-f", "concat", "-safe", "0",
    "-i", concatListPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath,
  ];

  await runFFmpeg(args);
}

// ── Xfade Stitching (Crossfade transitions) ────────────────────────

async function stitchWithXfade(
  videoPath: string,
  segments: StitchSegment[],
  config: PlatformConfig,
  tempDir: string,
  outputPath: string
): Promise<void> {
  console.log(`[ClipStitcher] Using xfade filter for ${segments.length} segments`);

  // Step 1: Extract each segment to a temp file with consistent encoding
  const segPaths: string[] = [];
  const segDurations: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segPath = path.join(tempDir, `seg_${i}.mp4`);
    await extractSegment(videoPath, seg, config, segPath);
    segPaths.push(segPath);
    segDurations.push(seg.end - seg.start);
  }

  // Step 2: Build filter_complex for xfade chain
  // For N segments, we need N-1 xfade operations chained together.
  //
  // Video: [0:v][1:v]xfade=transition=fade:duration=D:offset=O[v01];
  //        [v01][2:v]xfade=transition=fade:duration=D:offset=O[v012]; ...
  // Audio: [0:a][1:a]acrossfade=d=D[a01];
  //        [a01][2:a]acrossfade=d=D[a012]; ...

  const inputArgs: string[] = [];
  for (const segPath of segPaths) {
    inputArgs.push("-i", segPath);
  }

  const videoFilters: string[] = [];
  const audioFilters: string[] = [];

  // Track the cumulative offset (where each xfade starts in the output timeline)
  let cumulativeOffset = segDurations[0]; // First segment plays fully

  for (let i = 1; i < segments.length; i++) {
    const transitionType = segments[i].transitionIn === "cut" ? "fade" : "fade";
    const fadeDuration = segments[i].transitionIn === "cut"
      ? 0
      : (segments[i].transitionDuration || STITCH_CONFIG.DEFAULT_CROSSFADE_DURATION);

    // For cut transitions within an xfade chain, use a very short fade (0.1s) instead of 0
    const effectiveFadeDuration = fadeDuration === 0 ? 0.1 : fadeDuration;

    const vIn1 = i === 1 ? "[0:v]" : `[v${i - 1}]`;
    const vOut = i === segments.length - 1 ? "[vout]" : `[v${i}]`;
    const offset = Math.max(0, cumulativeOffset - effectiveFadeDuration);

    videoFilters.push(
      `${vIn1}[${i}:v]xfade=transition=${transitionType}:duration=${effectiveFadeDuration}:offset=${offset.toFixed(3)}${vOut}`
    );

    const aIn1 = i === 1 ? "[0:a]" : `[a${i - 1}]`;
    const aOut = i === segments.length - 1 ? "[aout]" : `[a${i}]`;

    audioFilters.push(
      `${aIn1}[${i}:a]acrossfade=d=${effectiveFadeDuration}${aOut}`
    );

    // Next offset = current offset + next segment duration - fade overlap
    cumulativeOffset = offset + segDurations[i];
  }

  const filterComplex = [...videoFilters, ...audioFilters].join(";");

  const args = [
    "-nostdin", "-y",
    ...inputArgs,
    "-filter_complex", filterComplex,
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-preset", STITCH_CONFIG.PRESET,
    "-crf", STITCH_CONFIG.CRF.toString(),
    "-c:a", "aac", "-b:a", STITCH_CONFIG.AUDIO_BITRATE,
    "-movflags", "+faststart",
    outputPath,
  ];

  await runFFmpeg(args, STITCH_CONFIG.FFMPEG_TIMEOUT_MS);
}

// ── Caption Burn-in (post-stitch) ──────────────────────────────────

/**
 * Escape caption text for an FFmpeg drawtext `text='...'` value.
 * The value passes two quote/backslash-aware unescape passes (graph tokenizer,
 * then the option splitter that splits on `:` after quotes are stripped), and
 * the filter uses `expansion=none` to disable drawtext's third expansion pass.
 * Order: double backslashes, escape colons, then quotes via the two-level
 * close/`\\`+`\'`/reopen idiom — the single-level `'\''` collapses at level 1
 * and silently swallows the remaining options. (Kept in sync with
 * clipGenerator.escapeDrawtext — see the full derivation there.)
 */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "'\\\\\\''");
}

async function burnCaptions(
  inputPath: string,
  captionSegments: CaptionSegment[],
  config: PlatformConfig,
  outputPath: string
): Promise<void> {
  if (captionSegments.length === 0) return;

  const fontSize = config.aspectRatio === "9:16" ? 36 : 28;
  const yPos = Math.round(config.targetHeight * 0.82);

  const drawTextParts = captionSegments.map(seg => {
    const escapedText = escapeDrawtext(seg.text);

    return `drawtext=text='${escapedText}':expansion=none:fontsize=${fontSize}:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=${yPos}:enable='between(t,${seg.startTime},${seg.endTime})'`;
  });

  const args = [
    "-nostdin", "-y",
    "-i", inputPath,
    "-vf", drawTextParts.join(","),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-preset", STITCH_CONFIG.PRESET,
    "-crf", STITCH_CONFIG.CRF.toString(),
    "-c:a", "copy",
    "-movflags", "+faststart",
    outputPath,
  ];

  await runFFmpeg(args);
}

// ── Helpers ────────────────────────────────────────────────────────

function buildScaleFilters(config: PlatformConfig): string[] {
  const filters: string[] = [];
  const [arW, arH] = config.aspectRatio.split(":").map(Number);
  const targetAR = arW / arH;

  if (targetAR < 1) {
    // Portrait (9:16)
    filters.push(`scale=${config.targetWidth}:-2`);
    filters.push(`pad=${config.targetWidth}:${config.targetHeight}:(ow-iw)/2:(oh-ih)/2:black`);
  } else {
    // Landscape (16:9)
    filters.push(`scale=-2:${config.targetHeight}`);
    filters.push(`pad=${config.targetWidth}:${config.targetHeight}:(ow-iw)/2:(oh-ih)/2:black`);
  }

  return filters;
}

async function generateThumbnail(
  clipPath: string,
  outputPath: string,
  seekTime: number
): Promise<void> {
  try {
    await runFFmpeg([
      "-nostdin", "-y",
      "-ss", seekTime.toString(),
      "-i", clipPath,
      "-vframes", "1",
      "-vf", `scale=${STITCH_CONFIG.THUMBNAIL_WIDTH}:-2`,
      outputPath,
    ]);
  } catch {
    // Thumbnail generation is non-fatal
    console.warn("[ClipStitcher] Thumbnail generation failed");
  }
}

async function getOutputDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      filePath,
    ]);
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", () => {
      try {
        const info = JSON.parse(stdout);
        resolve(parseFloat(info.format.duration) || 0);
      } catch {
        resolve(0);
      }
    });
  });
}

function runFFmpeg(args: string[], timeoutMs: number = STITCH_CONFIG.FFMPEG_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      } else {
        resolve(stderr);
      }
    });
  });
}
