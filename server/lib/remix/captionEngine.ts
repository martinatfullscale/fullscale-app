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
  /** Transcript segments with word-level timing from editorial pipeline */
  transcriptSegments?: Array<{
    start: number;
    end: number;
    text: string;
    speaker?: string;
    words?: Array<{ word: string; start: number; end: number; confidence?: number }>;
  }>;
  /**
   * Creator corrections to mis-transcribed words, clip-relative. Each replaces
   * the spoken word(s) in its [start,end] window with `text` in the BURNED-IN
   * caption only — the audio is untouched. This is how a creator fixes
   * "full scale" → "FullScale" without cutting the word out of the clip.
   */
  captionEdits?: Array<{ start: number; end: number; text: string }>;
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
 * When transcript segments with word-level timing are available, generates
 * accurate captions directly from the transcript instead of using Claude.
 */
export async function generateCaptions(input: CaptionInput): Promise<CaptionOutput> {
  // If we have transcript segments with word-level timing, prefer those for accurate captions
  if (input.transcriptSegments && input.transcriptSegments.length > 0) {
    const transcriptCaptions = generateTranscriptCaptions(input);
    if (transcriptCaptions.segments.length > 0) {
      return transcriptCaptions;
    }
    // Fall through to AI-generated captions if transcript parsing fails
  }

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
 * Generate captions from transcript segments with accurate word-level timing.
 * Groups words into display-friendly segments of 4-8 words each.
 * Exported for render paths (editorial pipeline) that need the DETERMINISTIC
 * transcript path only — generateCaptions falls through to a Claude call when
 * transcript parsing yields nothing, which render loops must never do.
 */
export function generateTranscriptCaptions(input: CaptionInput): CaptionOutput {
  const segments: CaptionSegment[] = [];
  const { clipStart, duration, transcriptSegments } = input;

  if (!transcriptSegments) return { segments: [], style: "transcript" };

  // Collect all words with their timestamps, adjusted relative to clip start
  const allWords: Array<{ word: string; start: number; end: number }> = [];

  for (const seg of transcriptSegments) {
    if (seg.words && seg.words.length > 0) {
      // Use word-level timestamps
      for (const w of seg.words) {
        const relStart = w.start - clipStart;
        const relEnd = w.end - clipStart;
        if (relStart >= -0.5 && relStart <= duration + 0.5) {
          allWords.push({
            word: w.word,
            start: Math.max(0, relStart),
            end: Math.min(duration, relEnd),
          });
        }
      }
    } else {
      // Fall back to segment-level timestamps with estimated word positions
      const words = seg.text.split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;

      const segDuration = seg.end - seg.start;
      const wordDuration = segDuration / words.length;

      for (let i = 0; i < words.length; i++) {
        const relStart = (seg.start + i * wordDuration) - clipStart;
        const relEnd = (seg.start + (i + 1) * wordDuration) - clipStart;
        if (relStart >= -0.5 && relStart <= duration + 0.5) {
          allWords.push({
            word: words[i],
            start: Math.max(0, relStart),
            end: Math.min(duration, relEnd),
          });
        }
      }
    }
  }

  if (allWords.length === 0) return { segments: [], style: "transcript" };

  // Apply creator caption corrections (clip-relative). A word whose midpoint
  // falls inside an edit window takes the edit's text; the first such word in a
  // multi-word window carries the full replacement and the rest blank out, so
  // "full scale" → "FullScale" reads as one corrected token. Audio is untouched.
  const edits = (input.captionEdits ?? []).filter((e) => e && typeof e.text === "string");
  if (edits.length > 0) {
    for (const e of edits) {
      const lo = Math.min(e.start, e.end);
      const hi = Math.max(e.start, e.end);
      let first = true;
      for (const w of allWords) {
        const mid = (w.start + w.end) / 2;
        if (mid >= lo - 0.05 && mid <= hi + 0.05) {
          w.word = first ? e.text : "";
          first = false;
        }
      }
    }
    // Drop any words blanked by a multi-word correction.
    for (let i = allWords.length - 1; i >= 0; i--) {
      if (allWords[i].word === "") allWords.splice(i, 1);
    }
  }

  // Group words into caption segments of 4-8 words
  const WORDS_PER_SEGMENT = 6;
  for (let i = 0; i < allWords.length; i += WORDS_PER_SEGMENT) {
    const chunk = allWords.slice(i, i + WORDS_PER_SEGMENT);
    if (chunk.length === 0) continue;

    const text = chunk.map((w) => w.word).join(" ");
    const startTime = Math.round(chunk[0].start * 100) / 100;
    const endTime = Math.round(chunk[chunk.length - 1].end * 100) / 100;

    // Ensure minimum display time of 1 second
    segments.push({
      text,
      startTime,
      endTime: Math.max(endTime, startTime + 1),
      // Word timing preserved for karaoke/word-highlight caption styles
      words: chunk.map((w) => ({ word: w.word, start: w.start, end: w.end })),
    });
  }

  console.log(`[CaptionEngine] Generated ${segments.length} transcript-based caption segments from ${allWords.length} words`);
  return { segments, style: "transcript" };
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
