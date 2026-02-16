/**
 * Prompt Builder for Seeddance 2.0 Text-to-Video Generation
 *
 * Builds optimized text-to-video prompts from scene context + brand product data.
 * Generates cinematic video clips (4-8s) featuring products in context-appropriate
 * scenes that match the source video's visual aesthetic.
 *
 * Seeddance 2.0 is a VIDEO generation model — prompts include:
 * - Camera movement / motion cues
 * - Product-specific action verbs & visual dynamics
 * - Aspect ratio + resolution targeting for platform output
 * - Duration guidance (4-15s supported, 4-8s default)
 *
 * NOTE: Seeddance 2.0 API is not yet publicly available. This module scaffolds
 * the prompt structure for when it launches.
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
  /** Target platform — determines aspect ratio + duration sweet spot */
  targetPlatform?: string;
}

export interface PromptBuilderOutput {
  /** Cinematic text-to-video prompt */
  prompt: string;
  /** Negative prompt (artifacts to avoid) */
  negativePrompt: string;
  /** Style description used */
  style: string;
  /** Video aspect ratio string for Seeddance API (e.g. "16:9", "9:16") */
  aspectRatio: string;
  /** Target resolution */
  resolution: string;
  /** Suggested video duration in seconds */
  duration: number;
}

// ─── Cinematic Tone Styles ──────────────────────────────────────

interface ToneStyle {
  visual: string;
  camera: string;
  motion: string;
}

const TONE_STYLE_MAP: Record<string, ToneStyle> = {
  enthusiastic: {
    visual: "vibrant colors, high-energy, dynamic lighting, lens flare",
    camera: "tracking shot, push in, slight dutch angle",
    motion: "fast subtle movements, energetic pacing",
  },
  serious: {
    visual: "professional, muted tones, clean composition, sharp focus",
    camera: "static wide shot, slow dolly, locked tripod",
    motion: "minimal movement, deliberate pacing",
  },
  casual: {
    visual: "natural lighting, lifestyle aesthetic, shallow depth of field",
    camera: "handheld feel, gentle sway, eye-level",
    motion: "relaxed movement, organic flow",
  },
  educational: {
    visual: "clean, well-lit, informative, neutral background",
    camera: "overhead shot, smooth pan, product close-up",
    motion: "steady, methodical reveal",
  },
  humorous: {
    visual: "playful colors, bright, fun composition, pop art feel",
    camera: "quick zoom, whip pan, unexpected angle",
    motion: "bouncy, exaggerated, snappy timing",
  },
  intimate: {
    visual: "warm tones, soft bokeh, golden hour, cozy atmosphere",
    camera: "slow push-in, rack focus, close-up",
    motion: "gentle, dreamy, slow-motion accents",
  },
  inspirational: {
    visual: "golden hour, aspirational, elevated perspective, cinematic grain",
    camera: "sweeping crane shot, slow reveal, rising angle",
    motion: "graceful upward movement, time-lapse elements",
  },
  neutral: {
    visual: "clean, balanced, product photography, studio-like",
    camera: "static or slow orbit, centered framing",
    motion: "subtle rotation, gentle floating",
  },
};

// ─── Product Category Action Verbs ──────────────────────────────

const CATEGORY_ACTIONS: Record<string, string> = {
  beverage: "condensation glistens on the surface, liquid pours smoothly, ice cubes clink",
  electronics: "screen illuminates, device powers on, LED indicators glow softly",
  fashion: "fabric flows with movement, texture catches the light, garment drapes naturally",
  food: "steam rises gently, ingredients tumble in slow motion, plating comes together",
  cosmetics: "product glides on skin, shimmer catches light, texture swirls smoothly",
  automotive: "headlights sweep on, paint gleams under studio light, wheels rotate slowly",
  sports: "equipment in motion, impact moment frozen, energy burst radiates",
  furniture: "camera orbits around piece, sunlight shifts across surface, styled room reveals",
  tech: "holographic UI elements appear, data visualizations flow, device unfolds",
  default: "product rotates slowly on surface, light shifts to reveal details, elegant presentation",
};

// ─── Platform Output Configs ────────────────────────────────────

interface PlatformVideoConfig {
  aspectRatio: string;
  resolution: string;
  durationRange: [number, number]; // [min, max] seconds
  sweetSpot: number; // ideal duration
}

const PLATFORM_VIDEO_CONFIGS: Record<string, PlatformVideoConfig> = {
  tiktok:          { aspectRatio: "9:16", resolution: "1080p", durationRange: [4, 10], sweetSpot: 6 },
  instagram_reels: { aspectRatio: "9:16", resolution: "1080p", durationRange: [4, 10], sweetSpot: 6 },
  youtube_shorts:  { aspectRatio: "9:16", resolution: "1080p", durationRange: [4, 10], sweetSpot: 8 },
  youtube:         { aspectRatio: "16:9", resolution: "1080p", durationRange: [5, 15], sweetSpot: 8 },
  twitter:         { aspectRatio: "16:9", resolution: "720p",  durationRange: [4, 8],  sweetSpot: 5 },
  linkedin:        { aspectRatio: "16:9", resolution: "1080p", durationRange: [5, 10], sweetSpot: 6 },
  default:         { aspectRatio: "16:9", resolution: "1080p", durationRange: [4, 8],  sweetSpot: 6 },
};

// ─── Video Negative Prompt ──────────────────────────────────────

const BASE_NEGATIVE_PROMPT = [
  "blurry", "distorted", "low quality", "watermark", "text overlay",
  "cartoon", "anime", "illustration", "CGI", "unrealistic",
  "glitchy", "flickering", "jump cuts", "static noise", "frame drops",
  "morphing artifacts", "deformed objects", "unnatural motion",
  "oversaturated", "grainy", "pixelated",
].join(", ");

// ─── Main Builder ───────────────────────────────────────────────

export function buildGenerationPrompt(input: PromptBuilderInput): PromptBuilderOutput {
  const { sceneContext, brandProduct, surfaceDimensions, sceneAesthetic, targetPlatform } = input;

  // Determine cinematic style from scene tone
  const toneStyle = TONE_STYLE_MAP[sceneContext.emotionalTone.toLowerCase()] || TONE_STYLE_MAP.neutral;

  // Determine product action verbs from category
  const category = (brandProduct.category || "default").toLowerCase();
  const productAction = CATEGORY_ACTIONS[category] || CATEGORY_ACTIONS.default;

  // Build color/lighting description from scene aesthetics
  const warmthDesc = sceneAesthetic.colorWarmth > 15
    ? "warm golden lighting"
    : sceneAesthetic.colorWarmth < -15
      ? "cool blue-toned lighting"
      : "neutral balanced lighting";

  const brightnessDesc = sceneAesthetic.brightness.overall > 160
    ? "bright, well-lit environment"
    : sceneAesthetic.brightness.overall < 80
      ? "dim, moody atmosphere"
      : "moderate ambient lighting";

  // Get platform config
  const platformConfig = PLATFORM_VIDEO_CONFIGS[targetPlatform || "default"] || PLATFORM_VIDEO_CONFIGS.default;

  // Compose the cinematic video prompt
  const promptParts = [
    // Core subject
    `Cinematic product video of ${brandProduct.name}`,
    brandProduct.category ? `(${brandProduct.category})` : "",

    // Scene and setting
    `placed naturally in a lifestyle setting`,
    toneStyle.visual,

    // Camera and motion
    `Camera: ${toneStyle.camera}`,
    `Motion: ${toneStyle.motion}`,

    // Product-specific action
    productAction,

    // Lighting and color
    warmthDesc,
    brightnessDesc,
    sceneAesthetic.dominantColors.length > 0
      ? `color palette: ${sceneAesthetic.dominantColors.slice(0, 3).join(", ")}`
      : "",

    // Quality markers
    `photorealistic, cinematic quality, 24fps, smooth motion, professional videography`,
  ].filter(Boolean);

  const prompt = promptParts.join(". ");

  // Negative prompt: base + tone-specific exclusions
  const negativePromptParts = [BASE_NEGATIVE_PROMPT];
  if (sceneContext.emotionalTone === "serious") {
    negativePromptParts.push("playful, whimsical, cartoon");
  }
  if (sceneContext.emotionalTone === "intimate") {
    negativePromptParts.push("harsh lighting, overexposed, clinical");
  }

  return {
    prompt,
    negativePrompt: negativePromptParts.join(", "),
    style: `${toneStyle.visual} | ${toneStyle.camera}`,
    aspectRatio: platformConfig.aspectRatio,
    resolution: platformConfig.resolution,
    duration: platformConfig.sweetSpot,
  };
}
