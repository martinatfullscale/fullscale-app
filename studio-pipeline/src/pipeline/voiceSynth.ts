import axios from "axios";
import fs from "fs";
import path from "path";
import { execFileSync, execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────

export interface WordTiming {
  word: string;
  start: number;  // seconds from audio start
  end: number;    // seconds from audio start
}

export interface VoiceResult {
  audioPath: string;
  wordTimings: WordTiming[];
  actualDurationSec: number;
}

// ── Main Function ──────────────────────────────────────────────

/**
 * Generate voice narration for a scene using ElevenLabs TTS API.
 * Uses the /with-timestamps endpoint to get word-level timing data
 * for narration-synced region animations.
 *
 * Falls back to silent audio when ELEVENLABS_API_KEY is not set.
 */
export async function generateVoice(
  narrationText: string,
  sceneNumber: number,
  outputDir: string
): Promise<VoiceResult> {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `scene_${sceneNumber}.mp3`);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    console.log(`[VoiceSynth] No ElevenLabs key — generating silent audio for scene ${sceneNumber}`);
    return generateSilentAudio(narrationText, sceneNumber, outputPath);
  }

  console.log(`[VoiceSynth] Generating voice for scene ${sceneNumber} (${narrationText.length} chars)...`);

  try {
    // Use the /with-timestamps endpoint for word-level timing
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
      {
        text: narrationText,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      },
      {
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        responseType: "json",
      }
    );

    const data = response.data;

    // Extract and save the audio
    const audioBase64 = data.audio_base64;
    if (!audioBase64) {
      throw new Error("No audio_base64 in ElevenLabs response");
    }
    const audioBuffer = Buffer.from(audioBase64, "base64");
    fs.writeFileSync(outputPath, audioBuffer);

    // Parse word timings from character-level alignment
    let wordTimings: WordTiming[] = [];
    if (data.alignment) {
      wordTimings = aggregateWordsFromCharacters(
        data.alignment.characters || [],
        data.alignment.character_start_times_seconds || [],
        data.alignment.character_end_times_seconds || []
      );
    }

    // Measure actual audio duration
    const actualDurationSec = await measureAudioDuration(outputPath);

    const fileSizeKB = Math.round(fs.statSync(outputPath).size / 1024);
    console.log(`[VoiceSynth] Scene ${sceneNumber} audio: ${outputPath} (${fileSizeKB} KB, ${actualDurationSec.toFixed(1)}s, ${wordTimings.length} words)`);

    return { audioPath: outputPath, wordTimings, actualDurationSec };
  } catch (err: any) {
    // If with-timestamps fails (e.g. endpoint not available), fall back to standard TTS
    console.warn(`[VoiceSynth] with-timestamps failed (${err.message}), falling back to standard TTS`);
    return generateVoiceFallback(narrationText, sceneNumber, outputPath, apiKey, voiceId);
  }
}

// ── Fallback: Standard TTS (no timestamps) ─────────────────────

async function generateVoiceFallback(
  narrationText: string,
  sceneNumber: number,
  outputPath: string,
  apiKey: string,
  voiceId: string
): Promise<VoiceResult> {
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text: narrationText,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    },
    {
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      responseType: "arraybuffer",
    }
  );

  fs.writeFileSync(outputPath, Buffer.from(response.data));

  const actualDurationSec = await measureAudioDuration(outputPath);
  const fileSizeKB = Math.round(fs.statSync(outputPath).size / 1024);
  console.log(`[VoiceSynth] Scene ${sceneNumber} audio (no timestamps): ${outputPath} (${fileSizeKB} KB, ${actualDurationSec.toFixed(1)}s)`);

  // Estimate word timings from text (evenly spaced)
  const words = narrationText.trim().split(/\s+/);
  const wordDur = actualDurationSec / words.length;
  const wordTimings: WordTiming[] = words.map((word, i) => ({
    word: word.replace(/[^a-zA-Z0-9'-]/g, ""),
    start: i * wordDur,
    end: (i + 1) * wordDur,
  }));

  return { audioPath: outputPath, wordTimings, actualDurationSec };
}

// ── Character → Word Aggregation ───────────────────────────────

function aggregateWordsFromCharacters(
  characters: string[],
  startTimes: number[],
  endTimes: number[]
): WordTiming[] {
  const words: WordTiming[] = [];
  let currentWord = "";
  let wordStart = 0;
  let wordEnd = 0;

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    const isSpace = ch === " " || ch === "\n" || ch === "\t";

    if (isSpace) {
      if (currentWord.length > 0) {
        words.push({
          word: currentWord.replace(/[^a-zA-Z0-9'-]/g, ""),
          start: wordStart,
          end: wordEnd,
        });
        currentWord = "";
      }
    } else {
      if (currentWord.length === 0) {
        wordStart = startTimes[i] || 0;
      }
      currentWord += ch;
      wordEnd = endTimes[i] || wordStart;
    }
  }

  // Flush last word
  if (currentWord.length > 0) {
    words.push({
      word: currentWord.replace(/[^a-zA-Z0-9'-]/g, ""),
      start: wordStart,
      end: wordEnd,
    });
  }

  return words.filter((w) => w.word.length > 0);
}

// ── Audio Duration Measurement ─────────────────────────────────

async function measureAudioDuration(audioPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      audioPath,
    ]);
    const info = JSON.parse(stdout);
    return parseFloat(info.format?.duration) || 0;
  } catch {
    // Estimate from file size (~16kbps for mp3 at quality 9)
    try {
      const size = fs.statSync(audioPath).size;
      return size / (16000 / 8); // 16kbps in bytes/sec
    } catch {
      return 10; // fallback
    }
  }
}

// ── Silent Audio Fallback ──────────────────────────────────────

function generateSilentAudio(
  narrationText: string,
  sceneNumber: number,
  outputPath: string
): VoiceResult {
  const wordCount = narrationText.split(/\s+/).length;
  const durationSec = Math.max(5, Math.ceil((wordCount / 150) * 60));

  try {
    execFileSync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", `anullsrc=r=44100:cl=mono`,
      "-t", String(durationSec),
      "-q:a", "9",
      outputPath,
    ], { stdio: "pipe" });
  } catch {
    const silentMp3 = Buffer.from(
      "//uQxAAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV" +
      "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV",
      "base64"
    );
    fs.writeFileSync(outputPath, silentMp3);
  }

  console.log(`[VoiceSynth] Silent audio for scene ${sceneNumber}: ${outputPath}`);
  return { audioPath: outputPath, wordTimings: [], actualDurationSec: durationSec };
}
