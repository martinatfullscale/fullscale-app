/**
 * Asset Generator — Seeddance 2.0 API Client
 *
 * Orchestrates text-to-image generation for product assets when Scanner V2
 * finds a viable surface but no natural product moment exists.
 *
 * Seeddance 2.0 API integration:
 * - Generates product images matched to scene aesthetic
 * - Returns transparent-background PNGs for compositing
 * - Respects rate limits and timeout configuration
 */

import { buildGenerationPrompt, type PromptBuilderInput } from "./promptBuilder";
import * as fs from "fs";
import * as path from "path";

const ASSET_GEN_TIMEOUT = 60000;
const ASSET_GEN_MAX_PER_VIDEO = 20;

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
}

export interface AssetGenerationOutput {
  success: boolean;
  assetPath: string | null;
  prompt: string;
  error?: string;
}

/**
 * Generate a product asset image using Seeddance 2.0 API.
 * Saves the result to public/generated-assets/{videoId}/
 */
export async function generateProductAsset(input: AssetGenerationInput): Promise<AssetGenerationOutput> {
  const apiKey = process.env.SEEDDANCE_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      assetPath: null,
      prompt: "",
      error: "SEEDDANCE_API_KEY environment variable is required",
    };
  }

  try {
    console.log(`[Seeddance] Generating asset for product "${input.brandProduct.name}" (video ${input.videoId}, surface ${input.surfaceId})`);

    // Build the prompt from scene context
    const promptInput: PromptBuilderInput = {
      sceneContext: input.sceneContext,
      brandProduct: input.brandProduct,
      surfaceDimensions: input.surfaceDimensions,
      sceneAesthetic: input.sceneAesthetic,
    };
    const { prompt, negativePrompt, dimensions } = buildGenerationPrompt(promptInput);

    console.log(`[Seeddance] Prompt: "${prompt.substring(0, 100)}..."`);
    console.log(`[Seeddance] Dimensions: ${dimensions.width}x${dimensions.height}`);

    // Call Seeddance 2.0 API
    const apiUrl = process.env.SEEDDANCE_API_URL || "https://api.seeddance.com/v2/generate";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ASSET_GEN_TIMEOUT);

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        negative_prompt: negativePrompt,
        width: dimensions.width,
        height: dimensions.height,
        num_inference_steps: 30,
        guidance_scale: 7.5,
        output_format: "png",
        background_removal: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Seeddance] API error ${response.status}: ${errorText.substring(0, 200)}`);
      return {
        success: false,
        assetPath: null,
        prompt,
        error: `Seeddance API error: ${response.status}`,
      };
    }

    const result = await response.json() as any;

    // Extract the image data (base64 or URL depending on API response format)
    let imageBuffer: Buffer;
    if (result.image_base64) {
      imageBuffer = Buffer.from(result.image_base64, "base64");
    } else if (result.image_url) {
      const imgResponse = await fetch(result.image_url);
      const arrayBuffer = await imgResponse.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
    } else {
      return {
        success: false,
        assetPath: null,
        prompt,
        error: "Seeddance API returned no image data",
      };
    }

    // Save to public/generated-assets/{videoId}/
    const outputDir = path.join(process.cwd(), "public", "generated-assets", input.videoId.toString());
    fs.mkdirSync(outputDir, { recursive: true });

    const filename = `asset_s${input.surfaceId}_p${input.brandProduct.id}_${Date.now()}.png`;
    const outputPath = path.join(outputDir, filename);
    fs.writeFileSync(outputPath, imageBuffer);

    const relativePath = `/generated-assets/${input.videoId}/${filename}`;
    console.log(`[Seeddance] Asset saved: ${relativePath} (${(imageBuffer.length / 1024).toFixed(1)}KB)`);

    return {
      success: true,
      assetPath: relativePath,
      prompt,
    };
  } catch (err: any) {
    if (err.name === "AbortError") {
      console.error(`[Seeddance] Generation timed out after ${ASSET_GEN_TIMEOUT}ms`);
      return { success: false, assetPath: null, prompt: "", error: "Generation timed out" };
    }
    console.error("[Seeddance] Generation error:", err);
    return { success: false, assetPath: null, prompt: "", error: err.message };
  }
}

export { ASSET_GEN_TIMEOUT, ASSET_GEN_MAX_PER_VIDEO };
