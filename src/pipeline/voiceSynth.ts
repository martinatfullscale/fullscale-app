import axios from "axios";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

/**
 * Generate voice narration for a scene using ElevenLabs TTS API.
 * Falls back to silent audio when ELEVENLABS_API_KEY is not set.
 * Returns the path to the output .mp3 file.
 */
export async function generateVoice(
  narrationText: string,
  sceneNumber: number,
  outputDir: string
): Promise<string> {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `scene_${sceneNumber}.mp3`);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    console.log(`[VoiceSynth] No ElevenLabs key — generating silent audio for scene ${sceneNumber}`);
    return generateSilentAudio(narrationText, sceneNumber, outputPath);
  }

  console.log(`[VoiceSynth] Generating voice for scene ${sceneNumber} (${narrationText.length} chars)...`);

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

  const fileSizeKB = Math.round(fs.statSync(outputPath).size / 1024);
  console.log(`[VoiceSynth] Scene ${sceneNumber} audio: ${outputPath} (${fileSizeKB} KB)`);

  return outputPath;
}

/**
 * Generate silent audio matching estimated narration duration.
 * ~150 words/min reading speed → duration from word count.
 */
function generateSilentAudio(
  narrationText: string,
  sceneNumber: number,
  outputPath: string
): string {
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
    // ffmpeg not available — write a minimal valid MP3 (silence frame)
    // This is a single MPEG audio frame of silence (417 bytes)
    const silentMp3 = Buffer.from(
      "//uQxAAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV" +
      "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV",
      "base64"
    );
    fs.writeFileSync(outputPath, silentMp3);
  }

  console.log(`[VoiceSynth] Silent audio for scene ${sceneNumber}: ${outputPath}`);
  return outputPath;
}
