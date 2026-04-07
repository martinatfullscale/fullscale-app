/**
 * Asset Generator — Seedance 2.0 via fal.ai
 *
 * Generates product video clips, transition cards, and outro cards
 * using Seedance 2.0 text-to-video through fal.ai's serverless API.
 *
 * Uses the same FAL_KEY that powers the Studio pipeline.
 * When FAL_KEY is not set, falls back to placeholder mode for dev/testing.
 */

import { buildGenerationPrompt, type PromptBuilderInput, type PromptBuilderOutput } from "./promptBuilder";
import * as fs from "fs";
import * as path from "path";

// ─── Configuration ──────────────────────────────────────────────

/** Max assets per video to prevent runaway generation */
const ASSET_GEN_MAX_PER_VIDEO = 20;
/** Max time to wait for fal.ai video generation (5 minutes) */
const VIDEO_GEN_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────

export interface AssetGenerationInput {
  videoId: number;
  surfaceId: number;
  brandProduct: {
    id: number;
    name: string;
    category: string | null;
  };
  sceneContext: {
    narrativeContext: string;
    emotionalTone: string;
    culturalTags: string[];
    suggestedProductCategories: string[];
  };
  surfaceDimensions: {
    width: number;
    height: number;
    aspectRatio: number;
  };
  sceneAesthetic: {
    colorWarmth: number;
    brightness: { overall: number; top: number; bottom: number };
    dominantColors: string[];
  };
  /** Target platform for aspect ratio / duration optimization */
  targetPlatform?: string;
}

export interface AssetGenerationOutput {
  success: boolean;
  /** Relative path to the generated video clip (MP4) */
  assetPath: string | null;
  /** The prompt used for generation */
  prompt: string;
  /** Full prompt builder output (includes aspect ratio, duration, etc.) */
  promptDetails: PromptBuilderOutput | null;
  /** Job ID (for tracking / debugging) */
  jobId: string | null;
  /** Asset type — always "video" for Seedance 2.0 */
  assetType: "video";
  /** Video duration in seconds */
  duration: number | null;
  error?: string;
}

export interface TransitionCardInput {
  videoId: number;
  brandProduct: {
    id: number;
    name: string;
    category: string | null;
    dominantColor?: string | null;
    logoUrl?: string | null;
  };
  targetPlatform?: string;
  style?: "minimal" | "bold" | "gradient";
}

export interface OutroCardInput {
  videoId: number;
  brandProduct: {
    id: number;
    name: string;
    category: string | null;
    dominantColor?: string | null;
    logoUrl?: string | null;
  };
  ctaText?: string;
  targetPlatform?: string;
}

export interface CardGenerationOutput {
  success: boolean;
  assetPath: string | null;
  prompt: string;
  assetType: "transition_card" | "outro_card";
  duration: number;
  error?: string;
}

// ─── API Config ────────────────────────────────────────────────

function getModelsLabKey(): string | null {
  return process.env.MODELSLAB_API_KEY || null;
}

// ─── Main Generator ─────────────────────────────────────────────

/**
 * Generate a product video clip using Seedance 2.0 via fal.ai.
 * Falls back to placeholder when FAL_KEY is not set.
 */
export async function generateProductAsset(input: AssetGenerationInput): Promise<AssetGenerationOutput> {
  const promptInput: PromptBuilderInput = {
    sceneContext: input.sceneContext,
    brandProduct: input.brandProduct,
    surfaceDimensions: input.surfaceDimensions,
    sceneAesthetic: input.sceneAesthetic,
    targetPlatform: input.targetPlatform,
  };
  const promptOutput = buildGenerationPrompt(promptInput);

  console.log(`[Seedance] Generating video asset for product "${input.brandProduct.name}" (video ${input.videoId}, surface ${input.surfaceId})`);
  console.log(`[Seedance] Prompt: "${promptOutput.prompt.substring(0, 120)}..."`);
  console.log(`[Seedance] Config: ${promptOutput.aspectRatio} @ ${promptOutput.resolution}, ${promptOutput.duration}s`);

  const modelsLabKey = getModelsLabKey();
  if (!modelsLabKey) {
    console.warn("[Seedance] No MODELSLAB_API_KEY set — returning placeholder for development");
    return createPlaceholder(input, promptOutput);
  }

  try {
    // Submit to ModelsLab Seedance 2.0 text-to-video
    const submitRes = await fetch("https://modelslab.com/api/v6/video/text2video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: modelsLabKey,
        model_id: "seedance-t2v",
        prompt: promptOutput.prompt,
        negative_prompt: promptOutput.negativePrompt,
        height: 720,
        width: 1280,
        num_inference_steps: 30,
        guidance_scale: 7.5,
        output_type: "mp4",
      }),
    });

    const submitData = await submitRes.json() as any;
    let videoUrl: string | null = null;

    if (submitData.status === "success" && submitData.output?.[0]) {
      videoUrl = submitData.output[0];
    } else if (submitData.status === "processing" && submitData.fetch_result) {
      // Poll for completion
      console.log(`[Seedance] Job queued — polling ${submitData.fetch_result}...`);
      const startTime = Date.now();
      while (Date.now() - startTime < VIDEO_GEN_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 10000));
        const pollRes = await fetch(submitData.fetch_result, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: modelsLabKey }),
        });
        const pollData = await pollRes.json() as any;
        if (pollData.status === "success" && pollData.output?.[0]) {
          videoUrl = pollData.output[0];
          break;
        } else if (pollData.status === "failed" || pollData.status === "error") {
          throw new Error(`ModelsLab job failed: ${pollData.message || "unknown"}`);
        }
        console.log(`[Seedance] Still processing...`);
      }
    } else {
      throw new Error(`Unexpected ModelsLab response: ${JSON.stringify(submitData).slice(0, 200)}`);
    }

    if (!videoUrl) throw new Error("No video URL after polling");

    const savedPath = await downloadAndSaveVideo(videoUrl, input);
    if (!savedPath) {
      return {
        success: false, assetPath: null, prompt: promptOutput.prompt,
        promptDetails: promptOutput, jobId: null, assetType: "video",
        duration: null, error: "Failed to download generated video",
      };
    }

    console.log(`[Seedance] Video saved: ${savedPath}`);
    return {
      success: true, assetPath: savedPath, prompt: promptOutput.prompt,
      promptDetails: promptOutput, jobId: `modelslab_${Date.now()}`, assetType: "video",
      duration: promptOutput.duration,
    };
  } catch (err: any) {
    console.error("[Seedance] Generation error:", err.message);
    return {
      success: false, assetPath: null, prompt: promptOutput.prompt,
      promptDetails: promptOutput, jobId: null, assetType: "video",
      duration: null, error: err.message,
    };
  }
}

// ─── Card Generators ───────────────────────────────────────────

/**
 * Generate a branded transition card (1-2s animated brand wipe).
 */
export async function generateTransitionCard(input: TransitionCardInput): Promise<CardGenerationOutput> {
  const prompt = `Minimal elegant transition card: brand name "${input.brandProduct.name}" centered on a ${
    input.brandProduct.dominantColor || "dark gradient"
  } background with subtle particle animation, cinematic quality, smooth fade, ${
    input.style === "bold" ? "bold modern typography" : input.style === "gradient" ? "flowing gradient animation" : "clean minimal design"
  }`;

  console.log(`[Seedance] Generating transition card for "${input.brandProduct.name}"`);
  return generateCardClip(input.videoId, input.brandProduct, prompt, "transition_card", 2, "16:9");
}

/**
 * Generate a branded outro card with product hero shot + CTA (2-3s).
 */
export async function generateOutroCard(input: OutroCardInput): Promise<CardGenerationOutput> {
  const cta = input.ctaText || `Discover ${input.brandProduct.name}`;
  const prompt = `Product showcase outro card: "${input.brandProduct.name}" product hero shot centered, "${cta}" text below in elegant typography, ${
    input.brandProduct.dominantColor || "rich dark"
  } background with subtle brand color accents, call-to-action design, cinematic quality, professional advertising aesthetic`;

  console.log(`[Seedance] Generating outro card for "${input.brandProduct.name}"`);
  return generateCardClip(input.videoId, input.brandProduct, prompt, "outro_card", 3, "9:16");
}

/**
 * Shared logic for card generation via fal.ai Seedance 2.0.
 */
async function generateCardClip(
  videoId: number,
  brandProduct: { id: number; name: string; dominantColor?: string | null },
  prompt: string,
  assetType: "transition_card" | "outro_card",
  duration: number,
  aspectRatio: string
): Promise<CardGenerationOutput> {
  const modelsLabKey = getModelsLabKey();
  if (!modelsLabKey) {
    return createCardPlaceholder(videoId, brandProduct, prompt, assetType, duration);
  }

  try {
    const [h, w] = aspectRatio === "9:16" ? [1280, 720] : [720, 1280];
    const submitRes = await fetch("https://modelslab.com/api/v6/video/text2video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: modelsLabKey,
        model_id: "seedance-t2v",
        prompt,
        height: h,
        width: w,
        num_inference_steps: 30,
        guidance_scale: 7.5,
        output_type: "mp4",
      }),
    });

    const submitData = await submitRes.json() as any;
    let videoUrl: string | null = null;

    if (submitData.status === "success" && submitData.output?.[0]) {
      videoUrl = submitData.output[0];
    } else if (submitData.status === "processing" && submitData.fetch_result) {
      const startTime = Date.now();
      while (Date.now() - startTime < VIDEO_GEN_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 10000));
        const pollRes = await fetch(submitData.fetch_result, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: modelsLabKey }),
        });
        const pollData = await pollRes.json() as any;
        if (pollData.status === "success" && pollData.output?.[0]) { videoUrl = pollData.output[0]; break; }
        if (pollData.status === "failed" || pollData.status === "error") throw new Error("Job failed");
      }
    }

    if (!videoUrl) throw new Error("No video URL after polling");

    const response = await fetch(videoUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const videoBuffer = Buffer.from(arrayBuffer);

    const outputDir = path.join(process.cwd(), "public", "generated-assets", videoId.toString());
    fs.mkdirSync(outputDir, { recursive: true });
    const filename = `${assetType}_p${brandProduct.id}_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, filename);
    fs.writeFileSync(outputPath, videoBuffer);

    const relativePath = `/generated-assets/${videoId}/${filename}`;
    console.log(`[Seedance] ${assetType} saved: ${relativePath}`);
    return { success: true, assetPath: relativePath, prompt, assetType, duration };
  } catch (err: any) {
    console.error(`[Seedance] ${assetType} generation failed:`, err.message);
    return { success: false, assetPath: null, prompt, assetType, duration: 0, error: err.message };
  }
}

// ─── Download Helper ───────────────────────────────────────────

async function downloadAndSaveVideo(
  videoUrl: string,
  input: AssetGenerationInput
): Promise<string | null> {
  try {
    const response = await fetch(videoUrl);
    if (!response.ok) {
      console.error(`[Seedance] Download failed: ${response.status}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const videoBuffer = Buffer.from(arrayBuffer);

    const outputDir = path.join(process.cwd(), "public", "generated-assets", input.videoId.toString());
    fs.mkdirSync(outputDir, { recursive: true });

    const filename = `video_s${input.surfaceId}_p${input.brandProduct.id}_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, filename);
    fs.writeFileSync(outputPath, videoBuffer);

    const relativePath = `/generated-assets/${input.videoId}/${filename}`;
    const sizeMB = (videoBuffer.length / (1024 * 1024)).toFixed(2);
    console.log(`[Seedance] Video saved: ${relativePath} (${sizeMB}MB)`);

    return relativePath;
  } catch (err: any) {
    console.error("[Seedance] Download error:", err.message);
    return null;
  }
}

// ─── Placeholders (dev/testing) ────────────────────────────────

function createPlaceholder(
  input: AssetGenerationInput,
  promptOutput: PromptBuilderOutput
): AssetGenerationOutput {
  const outputDir = path.join(process.cwd(), "public", "generated-assets", input.videoId.toString());
  fs.mkdirSync(outputDir, { recursive: true });

  const filename = `placeholder_s${input.surfaceId}_p${input.brandProduct.id}_${Date.now()}.json`;
  const placeholderPath = path.join(outputDir, filename);
  fs.writeFileSync(placeholderPath, JSON.stringify({
    type: "seedance_placeholder",
    status: "api_key_not_set",
    message: "MODELSLAB_API_KEY not configured. Set it to enable Seedance 2.0 video generation.",
    prompt: promptOutput.prompt,
    negativePrompt: promptOutput.negativePrompt,
    aspectRatio: promptOutput.aspectRatio,
    resolution: promptOutput.resolution,
    duration: promptOutput.duration,
    product: input.brandProduct.name,
    videoId: input.videoId,
    surfaceId: input.surfaceId,
    createdAt: new Date().toISOString(),
  }, null, 2));

  const relativePath = `/generated-assets/${input.videoId}/${filename}`;
  console.log(`[Seedance] Placeholder saved: ${relativePath} (FAL_KEY not set)`);

  return {
    success: true, assetPath: relativePath, prompt: promptOutput.prompt,
    promptDetails: promptOutput, jobId: `placeholder_${Date.now()}`,
    assetType: "video", duration: promptOutput.duration,
  };
}

function createCardPlaceholder(
  videoId: number,
  brandProduct: { id: number; name: string; dominantColor?: string | null },
  prompt: string,
  assetType: "transition_card" | "outro_card",
  duration: number
): CardGenerationOutput {
  const outputDir = path.join(process.cwd(), "public", "generated-assets", videoId.toString());
  fs.mkdirSync(outputDir, { recursive: true });

  const filename = `${assetType}_p${brandProduct.id}_${Date.now()}.json`;
  const placeholderPath = path.join(outputDir, filename);
  fs.writeFileSync(placeholderPath, JSON.stringify({
    type: `seedance_${assetType}_placeholder`,
    status: "fal_key_not_set",
    prompt,
    brandName: brandProduct.name,
    brandColor: brandProduct.dominantColor,
    duration,
    videoId,
    createdAt: new Date().toISOString(),
  }, null, 2));

  const relativePath = `/generated-assets/${videoId}/${filename}`;
  console.log(`[Seedance] ${assetType} placeholder saved: ${relativePath}`);

  return { success: true, assetPath: relativePath, prompt, assetType, duration };
}

export { VIDEO_GEN_TIMEOUT_MS, ASSET_GEN_MAX_PER_VIDEO };
