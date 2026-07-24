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
  /**
   * Preferred over captionSegments: one caption group per stitch segment,
   * index-aligned with `segments`, timestamps relative to that SEGMENT's
   * start. The stitcher remaps them onto the output timeline of whichever
   * stitch mode actually renders — callers can't know that up front, because
   * branded-card availability is decided here at render time (a pre-remapped
   * xfade timeline drifts 1.3s per junction when the card path runs).
   */
  captionsBySegment?: Array<CaptionSegment[] | undefined>;
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
  CARD_DURATION_SEC: 0.8, // branded interstitial length — caption remap depends on it
  // All concat parts must share these audio params for -c copy to hold —
  // the card is synthesized at this rate, so segments must be forced to it
  // (sources are commonly 48kHz/mono, which would corrupt the copied stream).
  AUDIO_SAMPLE_RATE: "44100",
  AUDIO_CHANNELS: "2",
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

    // Branded wipes: generate the card image and render it into a short
    // interstitial video matched to the segment encoding, then splice it
    // between segments. Previously the card was generated and DISCARDED
    // ('for now, falls back to crossfade').
    const hasBrandedWipe = segments.some((seg, i) => i > 0 && seg.transitionIn === "branded_wipe");
    let cardVideoPath: string | null = null;
    if (hasBrandedWipe && input.brandProduct) {
      try {
        const { generateTransitionCard } = await import("../ai/image-gen/assetGenerator");
        const cardResult = await generateTransitionCard({
          videoId,
          brandProduct: input.brandProduct,
          targetPlatform: platformConfig.name.toLowerCase(),
          style: "minimal",
        });
        if (cardResult.success && cardResult.assetPath && fs.existsSync(cardResult.assetPath)) {
          cardVideoPath = path.join(tempDir, "brand_card.mp4");
          await renderCardVideo(cardResult.assetPath, platformConfig, cardVideoPath);
          console.log(`[ClipStitcher] Branded transition card rendered: ${cardVideoPath}`);
        }
      } catch (err: any) {
        console.warn(`[ClipStitcher] Transition card generation failed (falling back to crossfade): ${err.message}`);
        cardVideoPath = null;
      }
    }

    const hasCrossfade = segments.some(
      (seg, i) => i > 0 && (seg.transitionIn === "crossfade" || (seg.transitionIn === "branded_wipe" && !cardVideoPath))
    );

    if (segments.length === 1) {
      // Single segment — just extract it
      await extractSegment(videoPath, segments[0], platformConfig, outputPath);
    } else if (hasBrandedWipe && cardVideoPath) {
      // Real branded wipes: concat with the card spliced at wipe junctions.
      // (Crossfade junctions render as cuts in this mode — the concat
      // demuxer can't mix with xfade; the card IS the transition.)
      await stitchWithBrandedCards(videoPath, segments, platformConfig, tempDir, outputPath, cardVideoPath);
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

    // Captions: remap per-segment groups onto the timeline of the mode that
    // ACTUALLY rendered (card splices add time, xfades consume it) — falling
    // back to caller-flattened captionSegments for legacy callers.
    let effectiveCaptions = captionSegments;
    if (input.captionsBySegment && input.captionsBySegment.some((g) => g && g.length > 0)) {
      const mode: StitchMode = segments.length > 1 && hasBrandedWipe && cardVideoPath
        ? "card"
        : segments.length > 1 && hasCrossfade
          ? "xfade"
          : "concat";
      effectiveCaptions = remapCaptionsForMode(segments, input.captionsBySegment, mode);
    }

    // Apply caption burn-in if needed (post-stitch)
    if (captionsEnabled && effectiveCaptions && effectiveCaptions.length > 0) {
      const captionedPath = outputPath.replace(".mp4", "_captioned.mp4");
      await burnCaptions(outputPath, effectiveCaptions, platformConfig, captionedPath);
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

/** Render a still card image into a short interstitial video whose encode
 *  parameters exactly match extractSegment's output, so the concat demuxer
 *  can -c copy the spliced sequence. */
async function renderCardVideo(
  cardImagePath: string,
  config: PlatformConfig,
  outputPath: string,
  durationSec: number = STITCH_CONFIG.CARD_DURATION_SEC,
): Promise<void> {
  const args = [
    "-nostdin", "-y",
    "-loop", "1", "-i", cardImagePath,
    "-f", "lavfi", "-i", `anullsrc=r=${STITCH_CONFIG.AUDIO_SAMPLE_RATE}:cl=stereo`,
    "-t", durationSec.toString(),
    "-vf", `scale=${config.targetWidth}:${config.targetHeight}:force_original_aspect_ratio=decrease,pad=${config.targetWidth}:${config.targetHeight}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p,fade=t=in:st=0:d=0.15,fade=t=out:st=${(durationSec - 0.15).toFixed(2)}:d=0.15`,
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

/** Concat segments with the branded card spliced at every branded_wipe
 *  junction. All parts share extractSegment's encoding so -c copy holds. */
async function stitchWithBrandedCards(
  videoPath: string,
  segments: StitchSegment[],
  config: PlatformConfig,
  tempDir: string,
  outputPath: string,
  cardVideoPath: string,
): Promise<void> {
  console.log(`[ClipStitcher] Branded-card stitch: ${segments.length} segments`);
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (i > 0 && segments[i].transitionIn === "branded_wipe") {
      parts.push(cardVideoPath);
    }
    const segPath = path.join(tempDir, `seg_${i}.mp4`);
    await extractSegment(videoPath, segments[i], config, segPath);
    parts.push(segPath);
  }

  const concatListPath = path.join(tempDir, "concat_cards.txt");
  fs.writeFileSync(concatListPath, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  await runFFmpeg([
    "-nostdin", "-y",
    "-f", "concat", "-safe", "0",
    "-i", concatListPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath,
  ]);
}

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
    "-ar", STITCH_CONFIG.AUDIO_SAMPLE_RATE, "-ac", STITCH_CONFIG.AUDIO_CHANNELS,
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

// ── Caption Remap (mode-aware) ─────────────────────────────────────

type StitchMode = "card" | "concat" | "xfade";

/**
 * Remap per-segment captions (times relative to each segment's start) onto
 * the OUTPUT timeline of the mode actually rendered:
 * - card:   hard-cut concat; each branded_wipe junction ADDS a card's length.
 * - xfade:  crossfades overlap 0.5s; cuts render as 0.1s micro-fades.
 * - concat: true zero-overlap cuts (also single-segment) — plain offsets.
 */
function remapCaptionsForMode(
  segments: StitchSegment[],
  captionsBySegment: Array<CaptionSegment[] | undefined>,
  mode: StitchMode,
): CaptionSegment[] {
  const out: CaptionSegment[] = [];
  let offset = 0;
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      if (mode === "card") {
        if (segments[i].transitionIn === "branded_wipe") offset += STITCH_CONFIG.CARD_DURATION_SEC;
      } else if (mode === "xfade") {
        offset -= segments[i].transitionIn === "cut"
          ? 0.1
          : (segments[i].transitionDuration ?? STITCH_CONFIG.DEFAULT_CROSSFADE_DURATION);
      }
    }
    for (const c of captionsBySegment[i] || []) {
      out.push({ ...c, startTime: Math.max(0, c.startTime + offset), endTime: Math.max(0, c.endTime + offset) });
    }
    offset += segments[i].end - segments[i].start;
  }
  return out;
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
