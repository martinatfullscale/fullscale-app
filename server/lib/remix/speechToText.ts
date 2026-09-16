/**
 * Speech-to-Text Client — Whisper API + Deepgram integration.
 *
 * Converts extracted audio to timestamped transcript segments with speaker diarization.
 * Supports OpenAI Whisper (primary) and Deepgram (alternative with native diarization).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import FormData from "form-data";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────

export interface TranscriptWord {
  word: string;
  start: number;     // seconds
  end: number;       // seconds
  confidence: number; // 0-1
}

export interface TranscriptSegment {
  start: number;      // seconds
  end: number;        // seconds
  text: string;
  speaker?: string;   // speaker ID (e.g., "SPEAKER_0", "SPEAKER_1")
  confidence: number; // 0-1
  words?: TranscriptWord[];
}

export interface SpeechToTextInput {
  audioPath: string;   // Path to WAV file
  language?: string;   // ISO 639-1 (default: "en")
  provider?: "whisper" | "deepgram"; // STT provider
}

export interface SpeechToTextOutput {
  success: boolean;
  provider: "whisper" | "deepgram";
  fullText: string;
  segments: TranscriptSegment[];
  speakerMap: Record<string, string>;  // speaker ID → display name
  language: string;
  audioDuration: number;
  wordCount: number;
  segmentCount: number;
  processingTimeMs: number;
  error?: string;
}

// ── Configuration ──────────────────────────────────────────────────

const STT_CONFIG = {
  whisper: {
    model: "whisper-1",
    responseFormat: "verbose_json",
    timestampGranularity: "word",
    maxFileSize: 25 * 1024 * 1024,  // 25MB Whisper limit
    timeout: 120000,                 // 2 minutes
  },
  deepgram: {
    model: "nova-2",
    tier: "nova",
    timeout: 120000,
  },
} as const;

// ── Whisper Implementation ─────────────────────────────────────────

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface WhisperSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
}

interface WhisperResponse {
  text: string;
  language: string;
  duration: number;
  segments: WhisperSegment[];
  words?: WhisperWord[];
}

async function transcribeWithWhisper(
  audioPath: string,
  language: string
): Promise<SpeechToTextOutput> {
  const stats = fs.statSync(audioPath);
  if (stats.size > STT_CONFIG.whisper.maxFileSize) {
    // ~13.6 minutes of 16kHz mono 16-bit WAV hits the 25MB Whisper cap.
    // Long-form videos go through time-based chunking instead of failing.
    return transcribeWhisperChunked(audioPath, language);
  }
  return transcribeWhisperSingle(audioPath, language);
}

async function transcribeWhisperSingle(
  audioPath: string,
  language: string
): Promise<SpeechToTextOutput> {
  const startTime = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY required for Whisper speech-to-text");
  }

  const stats = fs.statSync(audioPath);
  console.log(`[SpeechToText] Whisper: Transcribing ${audioPath} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);

  // Build multipart form data
  const form = new FormData();
  form.append("file", fs.createReadStream(audioPath));
  form.append("model", STT_CONFIG.whisper.model);
  form.append("response_format", STT_CONFIG.whisper.responseFormat);
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  if (language) form.append("language", language);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STT_CONFIG.whisper.timeout);

  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      body: form as any,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whisper API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as WhisperResponse;

    // Convert Whisper segments to our format
    const segments: TranscriptSegment[] = (data.segments || []).map((seg) => {
      // Find words that belong to this segment's time range
      const segmentWords: TranscriptWord[] = (data.words || [])
        .filter((w) => w.start >= seg.start && w.end <= seg.end + 0.1)
        .map((w) => ({
          word: w.word.trim(),
          start: w.start,
          end: w.end,
          confidence: Math.exp(seg.avg_logprob), // Convert log probability to confidence
        }));

      return {
        start: seg.start,
        end: seg.end,
        text: seg.text.trim(),
        confidence: Math.max(0, Math.min(1, Math.exp(seg.avg_logprob))),
        words: segmentWords.length > 0 ? segmentWords : undefined,
      };
    });

    const wordCount = data.text.split(/\s+/).filter(Boolean).length;

    console.log(
      `[SpeechToText] Whisper complete: ${segments.length} segments, ${wordCount} words, ${data.duration?.toFixed(1)}s`
    );

    return {
      success: true,
      provider: "whisper",
      fullText: data.text.trim(),
      segments,
      speakerMap: {},  // Whisper doesn't provide diarization natively
      language: data.language || language,
      audioDuration: data.duration || 0,
      wordCount,
      segmentCount: segments.length,
      processingTimeMs: Date.now() - startTime,
    };
  } catch (err: any) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Whisper chunked transcription (long-form audio) ────────────────

// 600s of 16kHz mono 16-bit PCM ≈ 18.3MB — comfortably under the 25MB
// Whisper cap even with header overhead or slight format drift.
const WHISPER_CHUNK_SECONDS = 600;

async function transcribeWhisperChunked(
  audioPath: string,
  language: string
): Promise<SpeechToTextOutput> {
  const startTime = Date.now();
  const stats = fs.statSync(audioPath);
  const chunkDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-chunks-"));

  try {
    // Stream-copy split on sample boundaries — no re-encode, fast even
    // for hours of audio.
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", audioPath,
      "-f", "segment",
      "-segment_time", String(WHISPER_CHUNK_SECONDS),
      "-c", "copy",
      path.join(chunkDir, "chunk-%04d.wav"),
    ], { timeout: 120000 });

    const chunkFiles = fs.readdirSync(chunkDir).filter(f => f.startsWith("chunk-")).sort();
    if (chunkFiles.length === 0) throw new Error("Whisper chunking produced no segments");

    console.log(
      `[SpeechToText] Whisper chunked: ${(stats.size / 1024 / 1024).toFixed(1)}MB → ${chunkFiles.length} chunks of ≤${WHISPER_CHUNK_SECONDS}s`
    );

    const allSegments: TranscriptSegment[] = [];
    const textParts: string[] = [];
    let offset = 0;
    let detectedLanguage = language;

    for (let i = 0; i < chunkFiles.length; i++) {
      const chunkPath = path.join(chunkDir, chunkFiles[i]);
      const result = await transcribeWhisperSingle(chunkPath, language);
      if (i === 0 && result.language) detectedLanguage = result.language;

      for (const seg of result.segments) {
        allSegments.push({
          ...seg,
          start: seg.start + offset,
          end: seg.end + offset,
          words: seg.words?.map(w => ({ ...w, start: w.start + offset, end: w.end + offset })),
        });
      }
      textParts.push(result.fullText);

      // Advance by the chunk's true duration (API-reported, falling back
      // to PCM byte math) so later chunks stay aligned to source time.
      const chunkStats = fs.statSync(chunkPath);
      const pcmDuration = Math.max(0, chunkStats.size - 44) / 32000; // 16kHz mono 16-bit
      offset += result.audioDuration || pcmDuration;
      console.log(`[SpeechToText] Whisper chunk ${i + 1}/${chunkFiles.length} done (offset now ${offset.toFixed(1)}s)`);
    }

    const fullText = textParts.join(" ").trim();
    return {
      success: true,
      provider: "whisper",
      fullText,
      segments: allSegments,
      speakerMap: {},
      language: detectedLanguage,
      audioDuration: offset,
      wordCount: fullText.split(/\s+/).filter(Boolean).length,
      segmentCount: allSegments.length,
      processingTimeMs: Date.now() - startTime,
    };
  } finally {
    fs.rmSync(chunkDir, { recursive: true, force: true });
  }
}

// ── Deepgram Implementation ────────────────────────────────────────

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: number;
  punctuated_word?: string;
}

interface DeepgramUtterance {
  start: number;
  end: number;
  confidence: number;
  channel: number;
  transcript: string;
  words: DeepgramWord[];
  speaker?: number;
  id: string;
}

interface DeepgramResponse {
  results: {
    channels: Array<{
      alternatives: Array<{
        transcript: string;
        confidence: number;
        words: DeepgramWord[];
      }>;
    }>;
    utterances?: DeepgramUtterance[];
  };
  metadata: {
    duration: number;
    channels: number;
  };
}

async function transcribeWithDeepgram(
  audioPath: string,
  language: string
): Promise<SpeechToTextOutput> {
  const startTime = Date.now();
  const apiKey = process.env.DEEPGRAM_API_KEY;

  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY required for Deepgram speech-to-text");
  }

  const stats = fs.statSync(audioPath);
  console.log(`[SpeechToText] Deepgram: Transcribing ${audioPath} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);

  const audioBuffer = fs.readFileSync(audioPath);

  // Deepgram URL with query params for diarization + word timestamps
  const queryParams = new URLSearchParams({
    model: STT_CONFIG.deepgram.model,
    language: language,
    punctuate: "true",
    diarize: "true",           // Speaker diarization
    utterances: "true",        // Group into utterances
    smart_format: "true",      // Smart formatting
    paragraphs: "true",
  });

  const controller = new AbortController();
  // Long-form audio needs proportionally longer upload+processing time —
  // a fixed 2min cap aborted every 1hr+ video. 2s per MB, floor at the
  // configured base.
  const timeoutMs = Math.max(
    STT_CONFIG.deepgram.timeout,
    Math.ceil(stats.size / (1024 * 1024)) * 2000
  );
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://api.deepgram.com/v1/listen?${queryParams.toString()}`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "audio/wav",
        },
        body: audioBuffer,
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Deepgram API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as DeepgramResponse;

    // Use utterances (with diarization) if available, otherwise fall back to words
    const segments: TranscriptSegment[] = [];
    const speakerMap: Record<string, string> = {};

    if (data.results.utterances && data.results.utterances.length > 0) {
      // Deepgram utterances include speaker diarization
      for (const utt of data.results.utterances) {
        const speakerId = utt.speaker !== undefined ? `SPEAKER_${utt.speaker}` : undefined;
        if (speakerId && !(speakerId in speakerMap)) {
          speakerMap[speakerId] = `Speaker ${Object.keys(speakerMap).length + 1}`;
        }

        segments.push({
          start: utt.start,
          end: utt.end,
          text: utt.transcript.trim(),
          speaker: speakerId,
          confidence: utt.confidence,
          words: utt.words.map((w) => ({
            word: w.punctuated_word || w.word,
            start: w.start,
            end: w.end,
            confidence: w.confidence,
          })),
        });
      }
    } else {
      // Fallback: use channel alternatives
      const channel = data.results.channels[0];
      if (channel?.alternatives[0]) {
        const alt = channel.alternatives[0];
        // Group words into ~10-second segments
        let currentSegment: TranscriptWord[] = [];
        let segStart = 0;

        for (const w of alt.words) {
          if (currentSegment.length === 0) segStart = w.start;
          currentSegment.push({
            word: w.punctuated_word || w.word,
            start: w.start,
            end: w.end,
            confidence: w.confidence,
          });

          // Split at ~10s boundaries on sentence-ending punctuation
          if (
            w.end - segStart >= 10 &&
            (w.punctuated_word || w.word).match(/[.!?]$/)
          ) {
            segments.push({
              start: segStart,
              end: w.end,
              text: currentSegment.map((cw) => cw.word).join(" "),
              confidence: currentSegment.reduce((s, cw) => s + cw.confidence, 0) / currentSegment.length,
              words: currentSegment,
            });
            currentSegment = [];
          }
        }

        // Flush remaining words
        if (currentSegment.length > 0) {
          segments.push({
            start: segStart,
            end: currentSegment[currentSegment.length - 1].end,
            text: currentSegment.map((cw) => cw.word).join(" "),
            confidence: currentSegment.reduce((s, cw) => s + cw.confidence, 0) / currentSegment.length,
            words: currentSegment,
          });
        }
      }
    }

    const fullText =
      data.results.channels[0]?.alternatives[0]?.transcript ||
      segments.map((s) => s.text).join(" ");
    const wordCount = fullText.split(/\s+/).filter(Boolean).length;

    console.log(
      `[SpeechToText] Deepgram complete: ${segments.length} segments, ${wordCount} words, ` +
        `${Object.keys(speakerMap).length} speakers, ${data.metadata.duration?.toFixed(1)}s`
    );

    return {
      success: true,
      provider: "deepgram",
      fullText: fullText.trim(),
      segments,
      speakerMap,
      language,
      audioDuration: data.metadata.duration || 0,
      wordCount,
      segmentCount: segments.length,
      processingTimeMs: Date.now() - startTime,
    };
  } catch (err: any) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Main Entry Point ───────────────────────────────────────────────

/**
 * Transcribe audio to timestamped segments with optional speaker diarization.
 *
 * Provider selection:
 * - "whisper": OpenAI Whisper (good quality, no native diarization)
 * - "deepgram": Deepgram Nova-2 (excellent quality + native diarization)
 *
 * Falls back to the other provider if the primary one fails.
 */
export async function transcribeAudio(
  input: SpeechToTextInput
): Promise<SpeechToTextOutput> {
  const { audioPath, language = "en" } = input;

  // Auto-detect provider based on available API keys
  let provider = input.provider;
  if (!provider) {
    if (process.env.DEEPGRAM_API_KEY) {
      provider = "deepgram"; // Prefer Deepgram for native diarization
    } else if (process.env.OPENAI_API_KEY) {
      provider = "whisper";
    } else {
      return {
        success: false,
        provider: "whisper",
        fullText: "",
        segments: [],
        speakerMap: {},
        language,
        audioDuration: 0,
        wordCount: 0,
        segmentCount: 0,
        processingTimeMs: 0,
        error: "No STT API key configured. Set OPENAI_API_KEY or DEEPGRAM_API_KEY.",
      };
    }
  }

  console.log(`[SpeechToText] Using provider: ${provider}`);

  try {
    if (provider === "deepgram") {
      return await transcribeWithDeepgram(audioPath, language);
    } else {
      return await transcribeWithWhisper(audioPath, language);
    }
  } catch (primaryErr: any) {
    console.error(`[SpeechToText] ${provider} failed:`, primaryErr.message);

    // Attempt fallback to the other provider
    const fallback = provider === "whisper" ? "deepgram" : "whisper";
    const fallbackKey =
      fallback === "whisper" ? process.env.OPENAI_API_KEY : process.env.DEEPGRAM_API_KEY;

    if (fallbackKey) {
      console.log(`[SpeechToText] Falling back to ${fallback}`);
      try {
        if (fallback === "deepgram") {
          return await transcribeWithDeepgram(audioPath, language);
        } else {
          return await transcribeWithWhisper(audioPath, language);
        }
      } catch (fallbackErr: any) {
        console.error(`[SpeechToText] Fallback ${fallback} also failed:`, fallbackErr.message);
      }
    }

    return {
      success: false,
      provider,
      fullText: "",
      segments: [],
      speakerMap: {},
      language,
      audioDuration: 0,
      wordCount: 0,
      segmentCount: 0,
      processingTimeMs: 0,
      error: `STT failed: ${primaryErr.message}`,
    };
  }
}

export { STT_CONFIG };
