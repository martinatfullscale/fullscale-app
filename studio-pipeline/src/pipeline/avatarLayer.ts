import fs from "fs";
import path from "path";
import axios from "axios";
import { fal } from "@fal-ai/client";

// ── Types ──────────────────────────────────────────────────────

export type AvatarProvider = "aurora" | "kling-pro";
export type AvatarResolution = "480p" | "720p";

export interface AvatarOptions {
  portraitPath: string;
  provider?: AvatarProvider;
  resolution?: AvatarResolution;
}

// ── Provider config ────────────────────────────────────────────

const PROVIDER_SLUGS: Record<AvatarProvider, string> = {
  aurora: "fal-ai/creatify/aurora",
  "kling-pro": "fal-ai/kling-video/v1/pro/ai-avatar",
};

// ── Cached uploads ─────────────────────────────────────────────
// The portrait is the same across all scenes in a single pipeline
// run — upload once and reuse the URL.

let _cachedPortraitUrl: string | null = null;
let _cachedPortraitPath: string | null = null;

/**
 * Upload the portrait once per pipeline run.
 * Returns the fal.storage URL, cached across calls.
 */
async function getPortraitUrl(portraitPath: string): Promise<string> {
  if (_cachedPortraitUrl && _cachedPortraitPath === portraitPath) {
    return _cachedPortraitUrl;
  }

  const buf = fs.readFileSync(portraitPath);
  const ext = path.extname(portraitPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  const file = new File([buf], path.basename(portraitPath), { type: mime });
  _cachedPortraitUrl = await fal.storage.upload(file);
  _cachedPortraitPath = portraitPath;

  console.log(`[AvatarLayer] Portrait uploaded (${Math.round(buf.length / 1024)} KB)`);
  return _cachedPortraitUrl;
}

/**
 * Reset the portrait cache between pipeline runs (if the process is
 * long-lived, e.g., a server).
 */
export function resetPortraitCache(): void {
  _cachedPortraitUrl = null;
  _cachedPortraitPath = null;
}

// ── Main function ──────────────────────────────────────────────

/**
 * Generate a talking-head avatar clip for one scene.
 *
 * Takes the scene's VO audio and the founder's portrait, sends them to
 * Creatify Aurora (or Kling Pro), and returns the path to the generated
 * avatar MP4.
 *
 * Falls back gracefully: if FAL_KEY is missing or the provider fails,
 * returns null (caller should fall back to slide-only layout).
 */
export async function generateAvatarClip(
  audioPath: string,
  sceneNumber: number,
  outputDir: string,
  options: AvatarOptions
): Promise<string | null> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    console.warn("[AvatarLayer] No FAL_KEY — skipping avatar for scene", sceneNumber);
    return null;
  }

  fal.config({ credentials: falKey });

  const provider = options.provider || "aurora";
  const resolution = options.resolution || "480p";
  const slug = PROVIDER_SLUGS[provider];

  fs.mkdirSync(outputDir, { recursive: true });
  const videoPath = path.join(outputDir, `scene_${sceneNumber}_avatar.mp4`);

  console.log(`[AvatarLayer] Scene ${sceneNumber}: ${provider} @ ${resolution}`);

  try {
    // Upload portrait (cached across scenes) and audio
    const portraitUrl = await getPortraitUrl(options.portraitPath);

    const audioBuf = fs.readFileSync(audioPath);
    const audioFile = new File([audioBuf], `scene_${sceneNumber}.mp3`, { type: "audio/mpeg" });
    const audioUrl = await fal.storage.upload(audioFile);

    // Build provider-specific input
    let input: Record<string, any>;
    if (provider === "aurora") {
      input = {
        image_url: portraitUrl,
        audio_url: audioUrl,
        resolution,
      };
    } else {
      // kling-pro
      input = {
        image_url: portraitUrl,
        audio_url: audioUrl,
        prompt: "Professional business presentation. Person speaks naturally with subtle head movements and natural eye contact.",
      };
    }

    const result: any = await fal.subscribe(slug, {
      input,
      logs: true,
      pollInterval: 3000,
      onQueueUpdate: (update: any) => {
        if (update.status === "IN_PROGRESS") {
          const msgs = (update as any).logs;
          if (msgs) {
            msgs.map((log: any) => log.message).forEach((msg: string) => {
              console.log(`[AvatarLayer/scene${sceneNumber}] ${msg}`);
            });
          }
        }
      },
    });

    const videoUrl = result.data?.video?.url || result.video?.url;
    if (!videoUrl) {
      console.error(`[AvatarLayer] No video URL for scene ${sceneNumber}:`, JSON.stringify(result).slice(0, 300));
      return null;
    }

    // Download
    const response = await axios.get(videoUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(videoPath, Buffer.from(response.data));

    const kb = Math.round(fs.statSync(videoPath).size / 1024);
    console.log(`[AvatarLayer] Scene ${sceneNumber} avatar: ${videoPath} (${kb} KB)`);
    return videoPath;
  } catch (err: any) {
    console.error(`[AvatarLayer] Failed for scene ${sceneNumber}: ${err.message}`);
    return null;
  }
}
