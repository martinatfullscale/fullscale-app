/**
 * Clip Extractor — Edit Point Refinement + FFmpeg clip extraction.
 *
 * Ensures clips have clean, professional entry and exit points using
 * transcript word boundaries, filler word detection, and reaction handling.
 *
 * Pipeline: Raw clip boundaries (from Claude Dense) → Refined edit points → FFmpeg extraction
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import type { TranscriptSegment, TranscriptWord } from "./speechToText";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────

export interface EditPointRules {
  entry: EntryPointRules;
  exit: ExitPointRules;
  duration: DurationRules;
  pacing: PacingRules;
}

export interface EntryPointRules {
  preHookPadding: number;              // seconds before hook (min)
  maxPreHookPadding: number;           // seconds before hook (max)
  neverStartMidWord: boolean;
  preferSpeakerTransitions: boolean;
  useBreathPauses: boolean;
  includeReactionSetup: boolean;
  avoidFillerStarts: string[];
}

export interface ExitPointRules {
  postFinalWordPadding: number;
  maxPostFinalWordPadding: number;
  neverEndMidSentence: boolean;
  preferredExits: string[];
  extendForLaughter: number;
  extendForAgreement: number;
  avoidFillerEnds: string[];
}

export interface DurationRules {
  tiktokReelsShorts: { min: number; ideal: number; max: number };
  linkedinTwitter: { min: number; ideal: number; max: number };
  youtubeCommunity: { min: number; ideal: number; max: number };
}

export interface PacingRules {
  maxDeadAir: number;
  tightenSlowStart: boolean;
  extendAbruptEnd: boolean;
}

export interface RefinedEditPoints {
  start: number;
  end: number;
  adjustments: string[];
}

export interface ClipExtractionInput {
  videoId: number;
  videoPath: string;           // local path to video file
  clipStart: number;           // refined start time
  clipEnd: number;             // refined end time
  outputDir?: string;
  clipIndex?: number;
}

export interface ClipExtractionOutput {
  success: boolean;
  clipPath: string;
  duration: number;
  fileSizeBytes: number;
  error?: string;
}

// ── Default Edit Point Rules ───────────────────────────────────────

export const EDIT_POINT_RULES: EditPointRules = {
  entry: {
    preHookPadding: 0.5,
    maxPreHookPadding: 1.0,
    neverStartMidWord: true,
    preferSpeakerTransitions: true,
    useBreathPauses: true,
    includeReactionSetup: true,
    avoidFillerStarts: [
      "um", "uh", "like", "you know", "basically", "so basically",
      "i mean", "right", "yeah so",
    ],
  },
  exit: {
    postFinalWordPadding: 0.5,
    maxPostFinalWordPadding: 1.0,
    neverEndMidSentence: true,
    preferredExits: [
      "punchline", "audience_reaction", "silence_after_statement", "completed_thought",
    ],
    extendForLaughter: 1.5,
    extendForAgreement: 1.0,
    avoidFillerEnds: [
      "um", "uh", "so", "and", "but", "like", "you know", "anyway",
    ],
  },
  duration: {
    tiktokReelsShorts: { min: 15, ideal: 30, max: 60 },
    linkedinTwitter: { min: 30, ideal: 60, max: 90 },
    youtubeCommunity: { min: 60, ideal: 120, max: 180 },
  },
  pacing: {
    maxDeadAir: 2.0,
    tightenSlowStart: true,
    extendAbruptEnd: true,
  },
};

// ── Transcript Helper Functions ────────────────────────────────────

/**
 * Get all words in a flat array with their timestamps from transcript segments.
 */
function getAllWords(transcript: TranscriptSegment[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const seg of transcript) {
    if (seg.words) {
      words.push(...seg.words);
    }
  }
  return words;
}

/**
 * Find the transcript segment that contains the given timestamp.
 */
function findSegmentAtTime(
  transcript: TranscriptSegment[],
  time: number
): TranscriptSegment | undefined {
  return transcript.find((seg) => seg.start <= time && seg.end >= time);
}

/**
 * Get the word at (or nearest to) a specific timestamp.
 */
function getWordAtTime(
  words: TranscriptWord[],
  time: number,
  tolerance: number = 0.5
): TranscriptWord | undefined {
  let closest: TranscriptWord | undefined;
  let closestDist = Infinity;

  for (const w of words) {
    const dist = Math.min(Math.abs(w.start - time), Math.abs(w.end - time));
    if (dist < closestDist && dist <= tolerance) {
      closest = w;
      closestDist = dist;
    }
  }
  return closest;
}

/**
 * Check if a timestamp falls within a word (mid-word).
 */
function isWithinWord(words: TranscriptWord[], time: number): boolean {
  return words.some((w) => w.start < time && w.end > time);
}

/**
 * Find the previous word boundary (start of a word) before the given time.
 */
function findPreviousWordBoundary(words: TranscriptWord[], time: number): number {
  let latest = time;
  for (const w of words) {
    if (w.start <= time && w.start > latest - 2) {
      latest = w.start;
    }
  }
  // Find the word whose start is closest to but <= time
  const candidates = words.filter((w) => w.start <= time).sort((a, b) => b.start - a.start);
  return candidates.length > 0 ? candidates[0].start : time;
}

/**
 * Find the next non-filler word after the given time.
 */
function findNextNonFillerWord(
  words: TranscriptWord[],
  time: number,
  fillerWords: string[]
): number {
  const upcoming = words
    .filter((w) => w.start >= time)
    .sort((a, b) => a.start - b.start);

  for (const w of upcoming) {
    if (!fillerWords.includes(w.word.toLowerCase().replace(/[.,!?]/g, ""))) {
      return w.start;
    }
  }
  return time;
}

/**
 * Find the previous non-filler word before the given time.
 */
function findPreviousNonFillerWord(
  words: TranscriptWord[],
  time: number,
  fillerWords: string[]
): number {
  const preceding = words
    .filter((w) => w.end <= time)
    .sort((a, b) => b.end - a.end);

  for (const w of preceding) {
    if (!fillerWords.includes(w.word.toLowerCase().replace(/[.,!?]/g, ""))) {
      return w.end;
    }
  }
  return time;
}

/**
 * Check if there's a sentence boundary near the given time.
 */
function isAtSentenceBoundary(
  transcript: TranscriptSegment[],
  words: TranscriptWord[],
  time: number,
  tolerance: number = 1.0
): boolean {
  // Check segment boundaries
  for (const seg of transcript) {
    if (Math.abs(seg.end - time) < tolerance) return true;
  }

  // Check for sentence-ending punctuation in nearby words
  const nearbyWords = words.filter(
    (w) => Math.abs(w.end - time) < tolerance
  );
  return nearbyWords.some((w) =>
    /[.!?]$/.test(w.word.replace(/\s/g, ""))
  );
}

/**
 * Find the next sentence boundary after the given time.
 */
function findNextSentenceBoundary(
  transcript: TranscriptSegment[],
  words: TranscriptWord[],
  time: number,
  maxExtend: number = 5
): number {
  // Look for sentence-ending punctuation in upcoming words
  const upcoming = words
    .filter((w) => w.end > time && w.end <= time + maxExtend)
    .sort((a, b) => a.end - b.end);

  for (const w of upcoming) {
    if (/[.!?]$/.test(w.word.replace(/\s/g, ""))) {
      return w.end;
    }
  }

  // Fallback: look for segment boundaries
  for (const seg of transcript) {
    if (seg.end > time && seg.end <= time + maxExtend) {
      return seg.end;
    }
  }

  return time;
}

/**
 * Detect if there's a gap (dead air) longer than threshold at the start of a clip.
 */
function hasSlowStart(
  words: TranscriptWord[],
  clipStart: number,
  windowSeconds: number = 3.0,
  deadAirThreshold: number = 1.5
): boolean {
  const earlyWords = words
    .filter((w) => w.start >= clipStart && w.start <= clipStart + windowSeconds)
    .sort((a, b) => a.start - b.start);

  if (earlyWords.length === 0) return true;

  // Check gap between clip start and first word
  if (earlyWords[0].start - clipStart > deadAirThreshold) return true;

  // Check gaps between early words
  for (let i = 1; i < earlyWords.length; i++) {
    if (earlyWords[i].start - earlyWords[i - 1].end > deadAirThreshold) return true;
  }

  return false;
}

// ── Edit Point Refinement ──────────────────────────────────────────

/**
 * Refine raw clip boundaries to professional edit points.
 *
 * Uses transcript word boundaries, filler detection, and pacing rules
 * to ensure clean entry/exit points.
 */
export function refineEditPoints(
  rawClip: { start: number; end: number },
  transcript: TranscriptSegment[],
  rules: EditPointRules = EDIT_POINT_RULES
): RefinedEditPoints {
  const adjustments: string[] = [];
  let { start, end } = rawClip;
  const allWords = getAllWords(transcript);

  if (allWords.length === 0) {
    // No word-level data — apply basic padding only
    start = Math.max(0, start - rules.entry.preHookPadding);
    end = end + rules.exit.postFinalWordPadding;
    adjustments.push("No word-level data — basic padding only");
    return { start, end, adjustments };
  }

  // ── ENTRY REFINEMENT ─────────────────────────────────────────

  // Check if start is mid-word — snap to word boundary
  if (rules.entry.neverStartMidWord && isWithinWord(allWords, start)) {
    start = findPreviousWordBoundary(allWords, start);
    adjustments.push("Snapped entry to word boundary");
  }

  // Check if start is on a filler word — move forward
  const startWord = getWordAtTime(allWords, start);
  if (
    startWord &&
    rules.entry.avoidFillerStarts.includes(
      startWord.word.toLowerCase().replace(/[.,!?]/g, "")
    )
  ) {
    const newStart = findNextNonFillerWord(allWords, start, rules.entry.avoidFillerStarts);
    if (newStart > start && newStart < end) {
      adjustments.push(`Skipped filler word "${startWord.word}" at entry`);
      start = newStart;
    }
  }

  // Tighten slow start — if first 3s feel slow, move entry point forward
  if (rules.pacing.tightenSlowStart && hasSlowStart(allWords, start)) {
    const firstSubstantiveWord = allWords
      .filter((w) => w.start >= start && w.start <= start + 5)
      .sort((a, b) => a.start - b.start)
      .find((w) => !rules.entry.avoidFillerStarts.includes(w.word.toLowerCase().replace(/[.,!?]/g, "")));

    if (firstSubstantiveWord && firstSubstantiveWord.start > start) {
      start = Math.max(start, firstSubstantiveWord.start - rules.entry.preHookPadding);
      adjustments.push("Tightened slow start");
    }
  }

  // Add pre-hook padding
  start = Math.max(0, start - rules.entry.preHookPadding);

  // ── EXIT REFINEMENT ──────────────────────────────────────────

  // Check if end is mid-sentence — extend to sentence boundary
  if (
    rules.exit.neverEndMidSentence &&
    !isAtSentenceBoundary(transcript, allWords, end)
  ) {
    const boundary = findNextSentenceBoundary(transcript, allWords, end);
    if (boundary > end) {
      adjustments.push("Extended exit to sentence boundary");
      end = boundary;
    }
  }

  // Check if end is on a filler word — pull back
  const endWord = getWordAtTime(allWords, end);
  if (
    endWord &&
    rules.exit.avoidFillerEnds.includes(
      endWord.word.toLowerCase().replace(/[.,!?]/g, "")
    )
  ) {
    const newEnd = findPreviousNonFillerWord(allWords, end, rules.exit.avoidFillerEnds);
    if (newEnd < end && newEnd > start) {
      adjustments.push(`Pulled back from filler word "${endWord.word}" at exit`);
      end = newEnd;
    }
  }

  // Extend abrupt end — if ending feels abrupt, extend slightly
  if (rules.pacing.extendAbruptEnd) {
    const lastWord = allWords
      .filter((w) => w.end <= end + 0.5)
      .sort((a, b) => b.end - a.end)[0];

    if (lastWord && end - lastWord.end < 0.2) {
      // Ending right on the word — add breathing room
      end = lastWord.end + rules.exit.postFinalWordPadding;
      adjustments.push("Added breathing room after final word");
    }
  }

  // Add post-final-word padding
  end = end + rules.exit.postFinalWordPadding;

  return { start: Math.max(0, start), end, adjustments };
}

// ── FFmpeg Clip Extraction ─────────────────────────────────────────

/**
 * Extract a clip from a video file using FFmpeg with refined edit points.
 */
export async function extractClip(
  input: ClipExtractionInput
): Promise<ClipExtractionOutput> {
  const {
    videoId,
    videoPath,
    clipStart,
    clipEnd,
    outputDir = "/tmp/clip-extract",
    clipIndex = 0,
  } = input;

  const duration = clipEnd - clipStart;
  const outputPath = path.join(outputDir, `video-${videoId}-clip-${clipIndex}.mp4`);

  console.log(
    `[ClipExtractor] Extracting clip ${clipIndex} from video ${videoId}: ` +
      `${clipStart.toFixed(1)}s → ${clipEnd.toFixed(1)}s (${duration.toFixed(1)}s)`
  );

  try {
    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Clean up previous extraction
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    // FFmpeg extraction with keyframe-accurate seeking
    const ffmpegArgs = [
      "-ss", String(clipStart),          // Seek to start
      "-i", videoPath,                    // Input video
      "-t", String(duration),             // Duration
      "-c:v", "libx264",                  // Re-encode video for accuracy
      "-c:a", "aac",                      // AAC audio
      "-preset", "fast",                  // Fast encoding
      "-crf", "23",                       // Quality (lower = better)
      "-avoid_negative_ts", "make_zero",  // Handle timestamp issues
      "-y",                               // Overwrite
      outputPath,
    ];

    await execFileAsync("ffmpeg", ffmpegArgs, { timeout: 60000 });

    if (!fs.existsSync(outputPath)) {
      throw new Error("FFmpeg completed but clip file not found");
    }

    const stats = fs.statSync(outputPath);

    console.log(
      `[ClipExtractor] Clip extracted: ${outputPath} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`
    );

    return {
      success: true,
      clipPath: outputPath,
      duration,
      fileSizeBytes: stats.size,
    };
  } catch (err: any) {
    console.error(
      `[ClipExtractor] Extraction failed for video ${videoId} clip ${clipIndex}:`,
      err.message
    );
    return {
      success: false,
      clipPath: "",
      duration: 0,
      fileSizeBytes: 0,
      error: err.message,
    };
  }
}

export { EDIT_POINT_RULES as DEFAULT_EDIT_POINT_RULES };
