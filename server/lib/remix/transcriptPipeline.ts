/**
 * Transcript Pipeline Orchestrator — Phase 6.5 of scanner pipeline.
 *
 * Orchestrates: Video → Audio Extraction (FFmpeg) → Speech-to-Text → Store Transcript.
 * This is the bridge between surface detection (Phase 6) and narrative analysis (Phase 7).
 *
 * Pipeline: extractAudio() → transcribeAudio() → store in videoTranscripts table
 */

import { extractAudio, cleanupAudioFiles } from "./audioExtractor";
import { transcribeAudio } from "./speechToText";
import type { SpeechToTextOutput, TranscriptSegment } from "./speechToText";

// ── Types ──────────────────────────────────────────────────────────

export interface TranscriptPipelineInput {
  videoId: number;
  filePath: string;           // Object Storage serve URL or local path
  language?: string;          // ISO 639-1 (default: "en")
  provider?: "whisper" | "deepgram";
}

export interface TranscriptPipelineOutput {
  success: boolean;
  videoId: number;
  provider: "whisper" | "deepgram";
  fullText: string;
  segments: TranscriptSegment[];
  speakerMap: Record<string, string>;
  audioDuration: number;
  wordCount: number;
  segmentCount: number;
  totalProcessingTimeMs: number;
  stages: {
    audioExtraction: { success: boolean; durationMs: number; error?: string };
    speechToText: { success: boolean; durationMs: number; error?: string };
  };
  error?: string;
}

// ── Configuration ──────────────────────────────────────────────────

const PIPELINE_CONFIG = {
  // Minimum audio duration to proceed with transcription (skip very short clips)
  minAudioDuration: 5,         // seconds
  // Maximum audio duration (safety limit)
  maxAudioDuration: 7200,      // 2 hours
  // Minimum word count to consider transcript valid
  minWordCount: 10,
  // Timeout for entire pipeline
  pipelineTimeout: 300000,     // 5 minutes
} as const;

// ── Pipeline ───────────────────────────────────────────────────────

/**
 * Run the full transcript pipeline for a video.
 *
 * 1. Extract audio from video (FFmpeg → WAV @ 16kHz mono)
 * 2. Send to speech-to-text (Whisper or Deepgram)
 * 3. Return structured transcript with timestamps + speaker diarization
 *
 * The caller (routes.ts) is responsible for storing the result in the DB.
 */
export async function runTranscriptPipeline(
  input: TranscriptPipelineInput
): Promise<TranscriptPipelineOutput> {
  const { videoId, filePath, language = "en", provider } = input;
  const pipelineStart = Date.now();

  console.log(`[TranscriptPipeline] Starting for video ${videoId}`);
  console.log(`[TranscriptPipeline] File: ${filePath}, Language: ${language}, Provider: ${provider || "auto"}`);

  const stages = {
    audioExtraction: { success: false, durationMs: 0, error: undefined as string | undefined },
    speechToText: { success: false, durationMs: 0, error: undefined as string | undefined },
  };

  try {
    // ── Stage 1: Audio Extraction ──────────────────────────────────
    const audioStart = Date.now();
    console.log(`[TranscriptPipeline] Stage 1: Extracting audio...`);

    const audioResult = await extractAudio({ videoId, filePath });
    stages.audioExtraction.durationMs = Date.now() - audioStart;

    if (!audioResult.success) {
      stages.audioExtraction.error = audioResult.error;
      console.error(`[TranscriptPipeline] Audio extraction failed: ${audioResult.error}`);
      return buildFailureResult(videoId, stages, pipelineStart, `Audio extraction failed: ${audioResult.error}`);
    }

    stages.audioExtraction.success = true;
    console.log(
      `[TranscriptPipeline] Audio extracted: ${audioResult.duration.toFixed(1)}s, ` +
        `${(audioResult.fileSizeBytes / 1024 / 1024).toFixed(1)}MB`
    );

    // Validate audio duration
    if (audioResult.duration < PIPELINE_CONFIG.minAudioDuration) {
      const msg = `Audio too short: ${audioResult.duration.toFixed(1)}s (min: ${PIPELINE_CONFIG.minAudioDuration}s)`;
      console.warn(`[TranscriptPipeline] ${msg}`);
      cleanupAudioFiles(videoId);
      return buildFailureResult(videoId, stages, pipelineStart, msg);
    }

    // ── Stage 2: Speech-to-Text ────────────────────────────────────
    const sttStart = Date.now();
    console.log(`[TranscriptPipeline] Stage 2: Running speech-to-text...`);

    const sttResult: SpeechToTextOutput = await transcribeAudio({
      audioPath: audioResult.audioPath,
      language,
      provider,
    });
    stages.speechToText.durationMs = Date.now() - sttStart;

    // Clean up temp audio file immediately after STT
    cleanupAudioFiles(videoId);

    if (!sttResult.success) {
      stages.speechToText.error = sttResult.error;
      console.error(`[TranscriptPipeline] STT failed: ${sttResult.error}`);
      return buildFailureResult(videoId, stages, pipelineStart, `Speech-to-text failed: ${sttResult.error}`);
    }

    stages.speechToText.success = true;

    // Validate transcript quality
    if (sttResult.wordCount < PIPELINE_CONFIG.minWordCount) {
      console.warn(
        `[TranscriptPipeline] Transcript too short: ${sttResult.wordCount} words (min: ${PIPELINE_CONFIG.minWordCount})`
      );
      // Still return success — caller can decide what to do with short transcripts
    }

    const totalMs = Date.now() - pipelineStart;

    console.log(
      `[TranscriptPipeline] Complete for video ${videoId}: ` +
        `${sttResult.segmentCount} segments, ${sttResult.wordCount} words, ` +
        `${Object.keys(sttResult.speakerMap).length} speakers, ` +
        `total: ${(totalMs / 1000).toFixed(1)}s`
    );

    return {
      success: true,
      videoId,
      provider: sttResult.provider,
      fullText: sttResult.fullText,
      segments: sttResult.segments,
      speakerMap: sttResult.speakerMap,
      audioDuration: sttResult.audioDuration,
      wordCount: sttResult.wordCount,
      segmentCount: sttResult.segmentCount,
      totalProcessingTimeMs: totalMs,
      stages,
    };
  } catch (err: any) {
    console.error(`[TranscriptPipeline] Pipeline error for video ${videoId}:`, err);
    cleanupAudioFiles(videoId);
    return buildFailureResult(videoId, stages, pipelineStart, err.message);
  }
}

/**
 * Build a failure result with consistent structure.
 */
function buildFailureResult(
  videoId: number,
  stages: TranscriptPipelineOutput["stages"],
  startTime: number,
  error: string
): TranscriptPipelineOutput {
  return {
    success: false,
    videoId,
    provider: "whisper",
    fullText: "",
    segments: [],
    speakerMap: {},
    audioDuration: 0,
    wordCount: 0,
    segmentCount: 0,
    totalProcessingTimeMs: Date.now() - startTime,
    stages,
    error,
  };
}

export { PIPELINE_CONFIG };
