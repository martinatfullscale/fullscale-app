/**
 * Asset Generator — Seeddance 2.0 Text-to-Video API Client
 *
 * Orchestrates text-to-video generation for product video clips when Scanner V2
 * finds a viable surface but no natural product moment exists.
 *
 * Seeddance 2.0 uses an async job-based API:
 *   1. POST /video/text-to-video  →  returns { job_id }
 *   2. GET  /video/jobs/{job_id}  →  poll until status: "completed"
 *   3. Download video_url         →  save as MP4
 *
 * NOTE: Seeddance 2.0 API is NOT yet publicly available.
 * This module scaffolds the full async pipeline with:
 * - Real API integration (ready to activate when API launches)
 * - Mock/placeholder fallback (returns placeholder path for dev/testing)
 * - Configurable API provider URL (Atlas Cloud, laozhang.ai, or official)
 */

import { buildGenerationPrompt, type PromptBuilderInput, type PromptBuilderOutput } from "./promptBuilder";
import * as fs from "fs";
import * as path from "path";

// ─── Configuration ──────────────────────────────────────────────

/** Max time to wait for video generation (5 minutes — video gen is slow) */
const VIDEO_GEN_TIMEOUT_MS = 5 * 60 * 1000;
/** Polling interval when checking job status */
const POLL_INTERVAL_MS = 5000;
/** Max assets per video to prevent runaway generation */
const ASSET_GEN_MAX_PER_VIDEO = 20;

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
  /** Seeddance job ID (for tracking / debugging) */
  jobId: string | null;
  /** Asset type — always "video" for Seeddance 2.0 */
  assetType: "video";
  /** Video duration in seconds (from API or estimated) */
  duration: number | null;
  error?: string;
}

/** Seeddance API job submission response */
interface SeeddanceJobResponse {
  job_id: string;
  status: string;
}

/** Seeddance API job status response */
interface SeeddanceJobStatus {
  job_id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress?: number;
  video_url?: string;
  error?: string;
  duration?: number;
  metadata?: Record<string, any>;
}

// ─── API Provider Configuration ─────────────────────────────────

/**
 * Supported Seeddance 2.0 API providers.
 * Set SEEDDANCE_API_URL env var to use a specific provider.
 *
 * Known providers (when available):
 * - Official:     https://api.seeddance.com/v2          (not yet launched)
 * - Atlas Cloud:  https://api.atlascloud.ai/api/v1      (third-party)
 * - LaoZhang:     https://api.laozhang.ai/v1            (third-party)
 */
function getApiConfig() {
  const baseUrl = process.env.SEEDDANCE_API_URL || "https://api.seeddance.com/v2";
  return {
    submitUrl: `${baseUrl}/video/text-to-video`,
    statusUrl: (jobId: string) => `${baseUrl}/video/jobs/${jobId}`,
    apiKey: process.env.SEEDDANCE_API_KEY || "",
  };
}

// ─── Main Generator ─────────────────────────────────────────────

/**
 * Generate a product video clip using Seeddance 2.0 API.
 *
 * When the API isn't available (no key or API not launched), returns
 * a placeholder result for development/testing.
 *
 * Saves the result to public/generated-assets/{videoId}/
 */
export async function generateProductAsset(input: AssetGenerationInput): Promise<AssetGenerationOutput> {
  const config = getApiConfig();

  // Build the video prompt from scene context
  const promptInput: PromptBuilderInput = {
    sceneContext: input.sceneContext,
    brandProduct: input.brandProduct,
    surfaceDimensions: input.surfaceDimensions,
    sceneAesthetic: input.sceneAesthetic,
    targetPlatform: input.targetPlatform,
  };
  const promptOutput = buildGenerationPrompt(promptInput);

  console.log(`[Seeddance] Generating video asset for product "${input.brandProduct.name}" (video ${input.videoId}, surface ${input.surfaceId})`);
  console.log(`[Seeddance] Prompt: "${promptOutput.prompt.substring(0, 120)}..."`);
  console.log(`[Seeddance] Config: ${promptOutput.aspectRatio} @ ${promptOutput.resolution}, ${promptOutput.duration}s`);

  // Check if API is configured
  if (!config.apiKey) {
    console.warn("[Seeddance] No SEEDDANCE_API_KEY set — returning placeholder for development");
    return createPlaceholder(input, promptOutput);
  }

  try {
    // Step 1: Submit video generation job
    const jobId = await submitVideoJob(config, promptOutput);

    if (!jobId) {
      return {
        success: false,
        assetPath: null,
        prompt: promptOutput.prompt,
        promptDetails: promptOutput,
        jobId: null,
        assetType: "video",
        duration: null,
        error: "Failed to submit Seeddance video generation job",
      };
    }

    console.log(`[Seeddance] Job submitted: ${jobId} — polling for completion...`);

    // Step 2: Poll for completion
    const result = await pollJobUntilDone(config, jobId);

    if (!result || result.status === "failed") {
      console.error(`[Seeddance] Job ${jobId} failed: ${result?.error || "Unknown error"}`);
      return {
        success: false,
        assetPath: null,
        prompt: promptOutput.prompt,
        promptDetails: promptOutput,
        jobId,
        assetType: "video",
        duration: null,
        error: result?.error || "Video generation job failed",
      };
    }

    if (!result.video_url) {
      return {
        success: false,
        assetPath: null,
        prompt: promptOutput.prompt,
        promptDetails: promptOutput,
        jobId,
        assetType: "video",
        duration: null,
        error: "Seeddance returned completed status but no video URL",
      };
    }

    // Step 3: Download and save the video
    const savedPath = await downloadAndSaveVideo(result.video_url, input);

    if (!savedPath) {
      return {
        success: false,
        assetPath: null,
        prompt: promptOutput.prompt,
        promptDetails: promptOutput,
        jobId,
        assetType: "video",
        duration: result.duration || promptOutput.duration,
        error: "Failed to download generated video from Seeddance",
      };
    }

    console.log(`[Seeddance] Video saved: ${savedPath} (job: ${jobId})`);

    return {
      success: true,
      assetPath: savedPath,
      prompt: promptOutput.prompt,
      promptDetails: promptOutput,
      jobId,
      assetType: "video",
      duration: result.duration || promptOutput.duration,
    };
  } catch (err: any) {
    console.error("[Seeddance] Generation error:", err);
    return {
      success: false,
      assetPath: null,
      prompt: promptOutput.prompt,
      promptDetails: promptOutput,
      jobId: null,
      assetType: "video",
      duration: null,
      error: err.message,
    };
  }
}

// ─── API Helpers ────────────────────────────────────────────────

/**
 * Submit a text-to-video generation job to Seeddance 2.0.
 */
async function submitVideoJob(
  config: ReturnType<typeof getApiConfig>,
  prompt: PromptBuilderOutput
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout for submission

    const response = await fetch(config.submitUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "seedance-2.0",
        prompt: prompt.prompt,
        negative_prompt: prompt.negativePrompt,
        aspect_ratio: prompt.aspectRatio,
        resolution: prompt.resolution,
        duration: prompt.duration,
        // Additional params the API may support
        fps: 24,
        output_format: "mp4",
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Seeddance] Submit error ${response.status}: ${errorText.substring(0, 300)}`);
      return null;
    }

    const data = await response.json() as SeeddanceJobResponse;
    return data.job_id || null;
  } catch (err: any) {
    if (err.name === "AbortError") {
      console.error("[Seeddance] Job submission timed out");
    } else {
      console.error("[Seeddance] Job submission error:", err.message);
    }
    return null;
  }
}

/**
 * Poll a Seeddance job until it completes, fails, or times out.
 */
async function pollJobUntilDone(
  config: ReturnType<typeof getApiConfig>,
  jobId: string
): Promise<SeeddanceJobStatus | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < VIDEO_GEN_TIMEOUT_MS) {
    try {
      const response = await fetch(config.statusUrl(jobId), {
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
        },
      });

      if (!response.ok) {
        console.warn(`[Seeddance] Status check error ${response.status} for job ${jobId}`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const status = await response.json() as SeeddanceJobStatus;

      if (status.status === "completed") {
        console.log(`[Seeddance] Job ${jobId} completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
        return status;
      }

      if (status.status === "failed") {
        return status;
      }

      // Still processing — log progress and wait
      const progress = status.progress ? `${Math.round(status.progress * 100)}%` : "...";
      console.log(`[Seeddance] Job ${jobId} status: ${status.status} (${progress})`);
      await sleep(POLL_INTERVAL_MS);
    } catch (err: any) {
      console.warn(`[Seeddance] Poll error for job ${jobId}:`, err.message);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  console.error(`[Seeddance] Job ${jobId} timed out after ${VIDEO_GEN_TIMEOUT_MS / 1000}s`);
  return null;
}

/**
 * Download a video from Seeddance and save locally.
 */
async function downloadAndSaveVideo(
  videoUrl: string,
  input: AssetGenerationInput
): Promise<string | null> {
  try {
    const response = await fetch(videoUrl);
    if (!response.ok) {
      console.error(`[Seeddance] Download failed: ${response.status}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const videoBuffer = Buffer.from(arrayBuffer);

    // Save to public/generated-assets/{videoId}/
    const outputDir = path.join(process.cwd(), "public", "generated-assets", input.videoId.toString());
    fs.mkdirSync(outputDir, { recursive: true });

    const filename = `video_s${input.surfaceId}_p${input.brandProduct.id}_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, filename);
    fs.writeFileSync(outputPath, videoBuffer);

    const relativePath = `/generated-assets/${input.videoId}/${filename}`;
    const sizeMB = (videoBuffer.length / (1024 * 1024)).toFixed(2);
    console.log(`[Seeddance] Video saved: ${relativePath} (${sizeMB}MB)`);

    return relativePath;
  } catch (err: any) {
    console.error("[Seeddance] Download error:", err.message);
    return null;
  }
}

// ─── Development Placeholder ────────────────────────────────────

/**
 * When Seeddance API is not available, create a placeholder entry
 * so the rest of the pipeline can still be tested end-to-end.
 */
function createPlaceholder(
  input: AssetGenerationInput,
  promptOutput: PromptBuilderOutput
): AssetGenerationOutput {
  // Create the output directory
  const outputDir = path.join(process.cwd(), "public", "generated-assets", input.videoId.toString());
  fs.mkdirSync(outputDir, { recursive: true });

  // Write a metadata JSON placeholder (useful for reviewing prompt quality)
  const filename = `placeholder_s${input.surfaceId}_p${input.brandProduct.id}_${Date.now()}.json`;
  const placeholderPath = path.join(outputDir, filename);
  const metadata = {
    type: "seeddance_placeholder",
    status: "api_not_available",
    message: "Seeddance 2.0 API is not yet available. This placeholder represents a future video generation.",
    prompt: promptOutput.prompt,
    negativePrompt: promptOutput.negativePrompt,
    aspectRatio: promptOutput.aspectRatio,
    resolution: promptOutput.resolution,
    duration: promptOutput.duration,
    style: promptOutput.style,
    product: input.brandProduct.name,
    category: input.brandProduct.category,
    videoId: input.videoId,
    surfaceId: input.surfaceId,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(placeholderPath, JSON.stringify(metadata, null, 2));

  const relativePath = `/generated-assets/${input.videoId}/${filename}`;
  console.log(`[Seeddance] Placeholder saved: ${relativePath} (API not available)`);

  return {
    success: true,
    assetPath: relativePath,
    prompt: promptOutput.prompt,
    promptDetails: promptOutput,
    jobId: `placeholder_${Date.now()}`,
    assetType: "video",
    duration: promptOutput.duration,
  };
}

// ─── Utility ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Phase 3: Transition Card + Outro Card Generation ───────────

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

/**
 * Generate a branded transition card for multi-segment stitching.
 * When Seeddance is available: generates a 1-2s animated brand wipe.
 * When not available: creates a placeholder with brand metadata.
 */
export async function generateTransitionCard(
  input: TransitionCardInput
): Promise<CardGenerationOutput> {
  const config = getApiConfig();

  const prompt = `Minimal elegant transition card: brand name "${input.brandProduct.name}" centered on a ${
    input.brandProduct.dominantColor || "dark gradient"
  } background with subtle particle animation, cinematic 4K quality, smooth fade, ${
    input.style === "bold" ? "bold modern typography" : input.style === "gradient" ? "flowing gradient animation" : "clean minimal design"
  }`;

  console.log(`[Seeddance] Generating transition card for "${input.brandProduct.name}"`);

  if (!config.apiKey) {
    return createCardPlaceholder(input.videoId, input.brandProduct, prompt, "transition_card", 1.5);
  }

  try {
    const jobId = await submitVideoJob(prompt, "16:9", 2, "1080p", config);
    if (!jobId) return { success: false, assetPath: null, prompt, assetType: "transition_card", duration: 0, error: "Job submission failed" };

    const videoUrl = await pollJobUntilDone(jobId, config);
    if (!videoUrl) return { success: false, assetPath: null, prompt, assetType: "transition_card", duration: 0, error: "Job polling failed" };

    const assetPath = await downloadAndSaveVideo(videoUrl, input.videoId, `transition_${input.brandProduct.id}`);
    if (!assetPath) return { success: false, assetPath: null, prompt, assetType: "transition_card", duration: 0, error: "Download failed" };

    return { success: true, assetPath, prompt, assetType: "transition_card", duration: 1.5 };
  } catch (err: any) {
    return { success: false, assetPath: null, prompt, assetType: "transition_card", duration: 0, error: err.message };
  }
}

/**
 * Generate a branded outro card with product hero shot + CTA.
 * When Seeddance is available: generates a 2-3s animated product showcase.
 * When not available: creates a placeholder with brand metadata.
 */
export async function generateOutroCard(
  input: OutroCardInput
): Promise<CardGenerationOutput> {
  const config = getApiConfig();

  const cta = input.ctaText || `Discover ${input.brandProduct.name}`;
  const prompt = `Product showcase outro card: "${input.brandProduct.name}" product hero shot centered, "${cta}" text below in elegant typography, ${
    input.brandProduct.dominantColor || "rich dark"
  } background with subtle brand color accents, call-to-action design, cinematic 4K quality, professional advertising aesthetic`;

  console.log(`[Seeddance] Generating outro card for "${input.brandProduct.name}"`);

  if (!config.apiKey) {
    return createCardPlaceholder(input.videoId, input.brandProduct, prompt, "outro_card", 3);
  }

  try {
    const jobId = await submitVideoJob(prompt, "9:16", 3, "1080p", config);
    if (!jobId) return { success: false, assetPath: null, prompt, assetType: "outro_card", duration: 0, error: "Job submission failed" };

    const videoUrl = await pollJobUntilDone(jobId, config);
    if (!videoUrl) return { success: false, assetPath: null, prompt, assetType: "outro_card", duration: 0, error: "Job polling failed" };

    const assetPath = await downloadAndSaveVideo(videoUrl, input.videoId, `outro_${input.brandProduct.id}`);
    if (!assetPath) return { success: false, assetPath: null, prompt, assetType: "outro_card", duration: 0, error: "Download failed" };

    return { success: true, assetPath, prompt, assetType: "outro_card", duration: 3 };
  } catch (err: any) {
    return { success: false, assetPath: null, prompt, assetType: "outro_card", duration: 0, error: err.message };
  }
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
    type: `seeddance_${assetType}_placeholder`,
    status: "api_not_available",
    prompt,
    brandName: brandProduct.name,
    brandColor: brandProduct.dominantColor,
    duration,
    videoId,
    createdAt: new Date().toISOString(),
  }, null, 2));

  const relativePath = `/generated-assets/${videoId}/${filename}`;
  console.log(`[Seeddance] ${assetType} placeholder saved: ${relativePath}`);

  return { success: true, assetPath: relativePath, prompt, assetType, duration };
}

export { VIDEO_GEN_TIMEOUT_MS, ASSET_GEN_MAX_PER_VIDEO };
