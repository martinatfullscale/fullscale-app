/**
 * Caption Formatter — Platform-Specific Captions & Hashtags
 *
 * Generates optimized captions for each social platform, respecting:
 * - Character limits
 * - Hashtag conventions
 * - CTA patterns
 * - Brand mention formatting
 *
 * Uses Claude for intelligent caption generation when narrative context is available.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface CaptionFormatInput {
  /** Target platform */
  platform: string;
  /** Brand product names featured in the clip */
  brandNames: string[];
  /** Narrative context from scene analysis */
  narrativeContext: string;
  /** Emotional tone */
  emotionalTone: string;
  /** Cultural tags for hashtag generation */
  culturalTags: string[];
  /** Custom caption override (user-provided) */
  customCaption?: string;
  /** Whether to include brand mentions */
  includeBrandMentions?: boolean;
}

export interface CaptionFormatOutput {
  /** Full formatted caption text */
  caption: string;
  /** Separate hashtags array */
  hashtags: string[];
  /** Caption without hashtags */
  captionText: string;
  /** Character count */
  characterCount: number;
  /** Platform limit */
  characterLimit: number;
}

const PLATFORM_LIMITS: Record<string, { captionLimit: number; hashtagLimit: number; hashtagCount: number }> = {
  tiktok: { captionLimit: 2200, hashtagLimit: 100, hashtagCount: 8 },
  instagram_reels: { captionLimit: 2200, hashtagLimit: 100, hashtagCount: 15 },
  youtube_shorts: { captionLimit: 100, hashtagLimit: 60, hashtagCount: 5 },
  youtube: { captionLimit: 5000, hashtagLimit: 500, hashtagCount: 10 },
  twitter: { captionLimit: 280, hashtagLimit: 100, hashtagCount: 3 },
  linkedin: { captionLimit: 3000, hashtagLimit: 100, hashtagCount: 5 },
};

const TONE_EMOJI_MAP: Record<string, string> = {
  enthusiastic: "🔥",
  serious: "💡",
  casual: "✌️",
  educational: "📚",
  humorous: "😂",
  intimate: "💛",
  inspirational: "✨",
  neutral: "📌",
};

/**
 * Format a caption for a specific platform.
 */
export async function formatCaption(input: CaptionFormatInput): Promise<CaptionFormatOutput> {
  const limits = PLATFORM_LIMITS[input.platform] || PLATFORM_LIMITS.tiktok;

  // If user provided a custom caption, use it with auto-hashtags
  if (input.customCaption) {
    const hashtags = generateHashtags(input, limits.hashtagCount);
    return buildOutput(input.customCaption, hashtags, limits.captionLimit);
  }

  // Try Claude-powered caption generation
  if (process.env.ANTHROPIC_API_KEY && input.narrativeContext) {
    try {
      return await generateAICaption(input, limits);
    } catch (err) {
      console.warn("[CaptionFormatter] AI caption failed, using template:", err);
    }
  }

  // Fallback: template-based captions
  return generateTemplateCaption(input, limits);
}

/**
 * Generate an AI-powered caption with Claude.
 */
async function generateAICaption(
  input: CaptionFormatInput,
  limits: { captionLimit: number; hashtagLimit: number; hashtagCount: number }
): Promise<CaptionFormatOutput> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  const prompt = `Write a social media caption for a ${input.platform.replace("_", " ")} video post.

CONTEXT:
- Scene: ${input.narrativeContext.slice(0, 300)}
- Tone: ${input.emotionalTone}
- Featured brands: ${input.brandNames.join(", ") || "none"}
- Cultural themes: ${input.culturalTags.join(", ") || "general"}

RULES:
- Max ${limits.captionLimit} characters total
- ${input.platform === "twitter" ? "Very concise, punchy" : "Engaging, hook-driven"}
- Include a subtle CTA (not aggressive)
- ${input.brandNames.length > 0 ? `Naturally mention: ${input.brandNames.join(", ")}` : "No brand mentions needed"}
- Do NOT include hashtags in the caption (they'll be added separately)
- Match the ${input.emotionalTone} tone

Reply with ONLY the caption text, nothing else.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b: Anthropic.ContentBlock) => b.type === "text");
  const captionText = textBlock && textBlock.type === "text"
    ? textBlock.text.trim()
    : "";

  if (!captionText) {
    return generateTemplateCaption(input, limits);
  }

  const hashtags = generateHashtags(input, limits.hashtagCount);
  return buildOutput(captionText, hashtags, limits.captionLimit);
}

/**
 * Template-based caption generation (no API call).
 */
function generateTemplateCaption(
  input: CaptionFormatInput,
  limits: { captionLimit: number; hashtagLimit: number; hashtagCount: number }
): CaptionFormatOutput {
  const emoji = TONE_EMOJI_MAP[input.emotionalTone] || "📌";
  const parts: string[] = [];

  // Hook line based on tone
  const hooks: Record<string, string[]> = {
    enthusiastic: ["This is what we've been waiting for", "Game changer alert", "You need to see this"],
    serious: ["Let's talk about this", "Something worth noting", "Pay attention to this"],
    casual: ["Just vibing with", "Quick look at", "Check this out"],
    educational: ["Here's what you should know", "Learn something new", "Did you know"],
    humorous: ["Wait for it...", "Not what you expected right?", "Plot twist incoming"],
    inspirational: ["Moments like these", "This is what it's all about", "Believe in the process"],
    neutral: ["Take a look at this", "What do you think?", "Here's something interesting"],
  };

  const hookList = hooks[input.emotionalTone] || hooks.neutral;
  const hook = hookList[Math.floor(Math.random() * hookList.length)];

  parts.push(`${emoji} ${hook}`);

  if (input.brandNames.length > 0 && input.includeBrandMentions !== false) {
    parts.push(`featuring ${input.brandNames.slice(0, 2).join(" & ")}`);
  }

  // CTA
  const ctas = [
    "What do you think? 👇",
    "Drop your thoughts below 💬",
    "Save this for later 🔖",
    "Share with someone who needs to see this 📲",
  ];
  if (limits.captionLimit > 200) {
    parts.push(ctas[Math.floor(Math.random() * ctas.length)]);
  }

  const captionText = parts.join("\n\n");
  const hashtags = generateHashtags(input, limits.hashtagCount);

  return buildOutput(captionText, hashtags, limits.captionLimit);
}

/**
 * Generate relevant hashtags from context.
 */
function generateHashtags(input: CaptionFormatInput, maxCount: number): string[] {
  const tags = new Set<string>();

  // Platform-specific base tags
  const platformTags: Record<string, string[]> = {
    tiktok: ["fyp", "foryou", "viral"],
    instagram_reels: ["reels", "explore", "trending"],
    youtube_shorts: ["shorts", "youtube"],
    twitter: [],
    linkedin: ["content", "marketing"],
  };

  const baseTags = platformTags[input.platform] || [];
  baseTags.forEach(t => tags.add(t));

  // Brand tags
  for (const brand of input.brandNames) {
    tags.add(brand.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, ""));
  }

  // Cultural tags
  for (const tag of input.culturalTags) {
    const cleaned = tag.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");
    if (cleaned.length > 2 && cleaned.length < 30) {
      tags.add(cleaned);
    }
  }

  // Tone-based tags
  const toneTags: Record<string, string[]> = {
    enthusiastic: ["lifestyle", "energy", "vibes"],
    educational: ["learn", "tips", "knowledge"],
    humorous: ["funny", "comedy", "lol"],
    inspirational: ["motivation", "inspiration", "goals"],
  };
  (toneTags[input.emotionalTone] || []).forEach(t => tags.add(t));

  return Array.from(tags).slice(0, maxCount);
}

/**
 * Build the final output, respecting character limits.
 */
function buildOutput(
  captionText: string,
  hashtags: string[],
  captionLimit: number
): CaptionFormatOutput {
  const hashtagString = hashtags.map(h => `#${h}`).join(" ");
  let fullCaption = captionText;

  // Add hashtags if they fit
  if (captionText.length + hashtagString.length + 2 <= captionLimit) {
    fullCaption = `${captionText}\n\n${hashtagString}`;
  } else {
    // Trim caption to make room for hashtags
    const available = captionLimit - hashtagString.length - 5;
    if (available > 50) {
      fullCaption = `${captionText.slice(0, available)}...\n\n${hashtagString}`;
    }
  }

  // Final trim to limit
  if (fullCaption.length > captionLimit) {
    fullCaption = fullCaption.slice(0, captionLimit - 3) + "...";
  }

  return {
    caption: fullCaption,
    hashtags,
    captionText,
    characterCount: fullCaption.length,
    characterLimit: captionLimit,
  };
}

/**
 * Batch format captions for multiple platforms.
 */
export async function formatCaptionsMultiPlatform(
  input: Omit<CaptionFormatInput, "platform">,
  platforms: string[]
): Promise<Record<string, CaptionFormatOutput>> {
  const results: Record<string, CaptionFormatOutput> = {};

  for (const platform of platforms) {
    results[platform] = await formatCaption({ ...input, platform });
  }

  return results;
}
