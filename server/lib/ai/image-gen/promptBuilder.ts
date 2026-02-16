/**
 * Prompt Builder for Seeddance 2.0 Image Generation
 *
 * Builds optimized text-to-image prompts from scene context + brand product data.
 * Matches the generated asset to the video's visual aesthetic (color warmth,
 * brightness, dominant colors) so the product looks natural in the scene.
 */

export interface PromptBuilderInput {
  sceneContext: {
    narrativeContext: string;
    emotionalTone: string;
    culturalTags: string[];
    suggestedProductCategories: string[];
  };
  brandProduct: {
    id: number;
    name: string;
    category: string | null;
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

export interface PromptBuilderOutput {
  prompt: string;
  negativePrompt: string;
  style: string;
  dimensions: { width: number; height: number };
}

// Map emotional tones to visual styles
const TONE_STYLE_MAP: Record<string, string> = {
  enthusiastic: "vibrant, high-energy, bright colors",
  serious: "professional, muted tones, clean composition",
  casual: "relaxed, natural lighting, lifestyle photography",
  educational: "clear, well-lit, informative, clean background",
  humorous: "playful, bright, fun composition",
  intimate: "warm tones, soft lighting, cozy atmosphere",
  inspirational: "golden hour, aspirational, elevated perspective",
  neutral: "clean, balanced, product photography",
};

// Standard negative prompt to avoid common generation artifacts
const BASE_NEGATIVE_PROMPT = "blurry, distorted, low quality, watermark, text overlay, cartoon, anime, illustration, 3d render, CGI, unrealistic, oversaturated";

export function buildGenerationPrompt(input: PromptBuilderInput): PromptBuilderOutput {
  const { sceneContext, brandProduct, surfaceDimensions, sceneAesthetic } = input;

  // Determine visual style from scene tone
  const toneStyle = TONE_STYLE_MAP[sceneContext.emotionalTone.toLowerCase()] || TONE_STYLE_MAP.neutral;

  // Build color/lighting description from scene aesthetics
  const warmthDesc = sceneAesthetic.colorWarmth > 15 ? "warm lighting" :
    sceneAesthetic.colorWarmth < -15 ? "cool lighting" : "neutral lighting";
  const brightnessDesc = sceneAesthetic.brightness.overall > 160 ? "bright, well-lit" :
    sceneAesthetic.brightness.overall < 80 ? "dim, moody lighting" : "moderate lighting";

  // Compose the prompt
  const promptParts = [
    `Professional product photography of ${brandProduct.name}`,
    brandProduct.category ? `(${brandProduct.category} product)` : "",
    `placed naturally on a surface`,
    `${toneStyle}`,
    `${warmthDesc}, ${brightnessDesc}`,
    sceneAesthetic.dominantColors.length > 0
      ? `color palette matching ${sceneAesthetic.dominantColors.slice(0, 3).join(", ")}`
      : "",
    `photorealistic, high detail, studio quality`,
  ].filter(Boolean);

  const prompt = promptParts.join(", ");

  // Negative prompt: base + scene-specific exclusions
  const negativePromptParts = [BASE_NEGATIVE_PROMPT];
  if (sceneContext.emotionalTone === "serious") {
    negativePromptParts.push("playful, cartoon, whimsical");
  }

  // Calculate output dimensions based on surface aspect ratio
  // Seeddance 2.0 works best with standard dimensions
  let width = 512;
  let height = 512;

  if (surfaceDimensions.aspectRatio > 1.5) {
    // Wide surface — landscape product shot
    width = 768;
    height = 512;
  } else if (surfaceDimensions.aspectRatio < 0.67) {
    // Tall surface — portrait product shot
    width = 512;
    height = 768;
  }

  return {
    prompt,
    negativePrompt: negativePromptParts.join(", "),
    style: toneStyle,
    dimensions: { width, height },
  };
}
