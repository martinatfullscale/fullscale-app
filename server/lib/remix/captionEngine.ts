/**
 * Caption Engine — Auto-Caption Generation for Remix Clips
 *
 * Uses FFmpeg speech-to-text (whisper via ffmpeg) or Claude for caption generation.
 * Falls back to Claude narrative summarization when audio transcription isn't available.
 *
 * Caption styles:
 * - Full transcript: word-by-word from audio
 * - Highlight captions: key phrases from narrative analysis
 * - Brand callouts: product name overlays at placement moments
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CaptionSegment } from "./clipGenerator";

export interface CaptionInput {
  /** Clip start time in the source video */
  clipStart: number;
  /** Clip end time in the source video */
  clipEnd: number;
  /** Clip duration */
  duration: number;
  /** Narrative context from scene analysis */
  narrativeContext: string;
  /** Emotional tone */
  emotionalTone: string;
  /** Brand product names for callout captions */
  brandNames: string[];
  /** Transcript text if available (from existing video metadata) */
  existingTranscript?: string;
  /** Caption style */
  style: "highlight" | "brand_callout" | "narrative";
}

export interface CaptionOutput {
  segments: CaptionSegment[];
  style: string;
}

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY required for caption generation");
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

/**
 * Generate captions for a clip based on its narrative content.
 */
export async function generateCaptions(input: CaptionInput): Promise<CaptionOutput> {
  switch (input.style) {
    case "brand_callout":
      return generateBrandCallouts(input);
    case "highlight":
      return generateHighlightCaptions(input);
    case "narrative":
    default:
      return generateNarrativeCaptions(input);
  }
}

/**
 * Brand callout captions: show product names at strategic moments.
 */
function generateBrandCallouts(input: CaptionInput): CaptionOutput {
  const segments: CaptionSegment[] = [];
  const { duration, brandNames } = input;

  if (brandNames.length === 0) {
    return { segments: [], style: "brand_callout" };
  }

  // Place each brand callout evenly throughout the clip
  const interval = duration / (brandNames.length + 1);

  for (let i = 0; i < brandNames.length; i++) {
    const start = Math.round((interval * (i + 1) - 1.5) * 100) / 100;
    const end = Math.round((start + 3) * 100) / 100; // 3-second display

    segments.push({
      text: brandNames[i],
      startTime: Math.max(0, start),
      endTime: Math.min(duration, end),
    });
  }

  return { segments, style: "brand_callout" };
}

/**
 * Highlight captions: key phrases from the narrative, spread across the clip.
 */
async function generateHighlightCaptions(input: CaptionInput): Promise<CaptionOutput> {
  try {
    const client = getClient();

    const prompt = `You are generating short highlight captions for a video clip.

CLIP CONTEXT:
- Duration: ${input.duration.toFixed(1)} seconds
- Narrative: ${input.narrativeContext.slice(0, 500)}
- Tone: ${input.emotionalTone}
- Products featured: ${input.brandNames.join(", ") || "none"}

Generate 3-5 short caption phrases (2-6 words each) that capture the key moments.
Each caption will be shown for 2-3 seconds.

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no code fences):
[
  { "text": "Short phrase", "relativePosition": 0.15 },
  { "text": "Another phrase", "relativePosition": 0.45 },
  { "text": "Final phrase", "relativePosition": 0.75 }
]

relativePosition is 0-1 representing when in the clip to show this caption.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find((b: Anthropic.ContentBlock) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return fallbackCaptions(input);
    }

    const parsed = parseJsonResponse(textBlock.text);
    if (!Array.isArray(parsed)) return fallbackCaptions(input);

    const segments: CaptionSegment[] = parsed.map((item: any) => ({
      text: String(item.text || "").slice(0, 50),
      startTime: Math.round((item.relativePosition || 0) * input.duration * 100) / 100,
      endTime: Math.round(((item.relativePosition || 0) * input.duration + 2.5) * 100) / 100,
    })).filter((s: CaptionSegment) => s.text && s.endTime <= input.duration);

    return { segments, style: "highlight" };
  } catch (err) {
    console.warn("[CaptionEngine] Claude highlight captions failed, using fallback:", err);
    return fallbackCaptions(input);
  }
}

/**
 * Narrative captions: summarize the scene content as readable text overlays.
 */
async function generateNarrativeCaptions(input: CaptionInput): Promise<CaptionOutput> {
  // If we have existing transcript, chunk it into display segments
  if (input.existingTranscript) {
    return chunkTranscript(input.existingTranscript, input.duration);
  }

  // Otherwise, generate narrative-style captions from context
  try {
    const client = getClient();

    const prompt = `Generate subtitle-style captions for a ${input.duration.toFixed(0)}-second video clip.

Context: ${input.narrativeContext.slice(0, 300)}
Tone: ${input.emotionalTone}

Create 4-8 caption lines that could overlay this clip as descriptive text.
Each line should be 3-10 words, shown for 2-4 seconds.

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no code fences):
[
  { "text": "Caption line one", "start": 0.5, "end": 3.0 },
  { "text": "Caption line two", "start": 3.5, "end": 6.5 }
]

Times are in seconds relative to clip start.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find((b: Anthropic.ContentBlock) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return fallbackCaptions(input);
    }

    const parsed = parseJsonResponse(textBlock.text);
    if (!Array.isArray(parsed)) return fallbackCaptions(input);

    const segments: CaptionSegment[] = parsed.map((item: any) => ({
      text: String(item.text || "").slice(0, 60),
      startTime: Number(item.start) || 0,
      endTime: Number(item.end) || 0,
    })).filter((s: CaptionSegment) => s.text && s.endTime > s.startTime && s.endTime <= input.duration);

    return { segments, style: "narrative" };
  } catch (err) {
    console.warn("[CaptionEngine] Claude narrative captions failed:", err);
    return fallbackCaptions(input);
  }
}

/**
 * Chunk a transcript into timed caption segments.
 */
function chunkTranscript(transcript: string, duration: number): CaptionOutput {
  const words = transcript.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { segments: [], style: "narrative" };

  // Estimate ~3 words per second of speaking
  const wordsPerSegment = 8;
  const segments: CaptionSegment[] = [];
  const segmentDuration = duration / Math.ceil(words.length / wordsPerSegment);

  for (let i = 0; i < words.length; i += wordsPerSegment) {
    const chunk = words.slice(i, i + wordsPerSegment).join(" ");
    const segIndex = Math.floor(i / wordsPerSegment);
    const startTime = Math.round(segIndex * segmentDuration * 100) / 100;
    const endTime = Math.round(Math.min((segIndex + 1) * segmentDuration, duration) * 100) / 100;

    segments.push({ text: chunk, startTime, endTime });
  }

  return { segments, style: "narrative" };
}

/**
 * Simple fallback captions when AI generation fails.
 */
function fallbackCaptions(input: CaptionInput): CaptionOutput {
  const segments: CaptionSegment[] = [];

  // Show emotional tone as opening caption
  if (input.emotionalTone) {
    segments.push({
      text: input.emotionalTone.charAt(0).toUpperCase() + input.emotionalTone.slice(1),
      startTime: 0.5,
      endTime: 3.0,
    });
  }

  // Show brand names if any
  if (input.brandNames.length > 0) {
    const mid = input.duration / 2;
    segments.push({
      text: input.brandNames[0],
      startTime: Math.round((mid - 1.5) * 100) / 100,
      endTime: Math.round((mid + 1.5) * 100) / 100,
    });
  }

  return { segments, style: "fallback" };
}

function parseJsonResponse(text: string): any {
  try {
    let jsonStr = text.trim();
    if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
    else if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
    return JSON.parse(jsonStr.trim());
  } catch {
    return null;
  }
}
