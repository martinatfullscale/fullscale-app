/**
 * Editorial Analyzer — Claude Dense transcript-first clip identification.
 *
 * This is the NEW narrative intelligence layer (Phase 7) that analyzes the FULL
 * transcript to find viral clip moments. Unlike narrativeAnalyzer.ts (which
 * analyzes individual frames), this module analyzes the entire conversation.
 *
 * Principle: "Narrative-first, surface-second."
 * Find the best editorial moments, THEN check for surface placement opportunities.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  RubricScores,
  EditorialAnalysisOutput,
} from "../../remix/clipScoringRubric";
import { validateScores, calculateCompositeScore } from "../../remix/clipScoringRubric";
import type { TranscriptSegment } from "../../remix/speechToText";

// ── Types ──────────────────────────────────────────────────────────

export interface EditorialAnalysisInput {
  videoId: number;
  transcript: TranscriptSegment[];
  surfaces: Array<{
    id: number;
    timestamp: number;
    surfaceType: string;
    confidence: number;
    boundingBox: { x: number; y: number; width: number; height: number };
  }>;
  brandCatalog: Array<{
    id: number;
    name: string;
    category: string | null;
    dominantColor: string | null;
  }>;
  maxClips?: number;
}

interface ClaudeEditorialResponse {
  clipStart: number;
  clipEnd: number;
  scores: {
    hookStrength: number;
    narrativeCompleteness: number;
    emotionalArc: number;
    speakerClarity: number;
    replayability: number;
    culturalRelevance: number;
  };
  compositeScore: number;
  surfacesInRange: number[];
  compatibleBrands: Array<{
    brandProductId: number;
    reasoning: string;
  }>;
  suggestedTitle: string;
  topicTags: string[];
  reasoning: string;
}

// ── Configuration ──────────────────────────────────────────────────

const EDITORIAL_CONFIG = {
  model: "claude-sonnet-4-5-20250929",
  maxTokens: 4096,       // Larger response for multiple clips
  timeout: 90000,        // 90s — transcript analysis takes longer
  maxTranscriptChars: 50000, // Truncate very long transcripts
} as const;

// ── Claude Client ──────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY required for editorial analysis");
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

// ── Prompt Builder ─────────────────────────────────────────────────

function buildEditorialAnalysisPrompt(
  transcript: TranscriptSegment[],
  surfaces: EditorialAnalysisInput["surfaces"],
  brandCatalog: EditorialAnalysisInput["brandCatalog"],
  maxClips: number = 10
): string {
  // Prepare compact transcript representation
  const compactTranscript = transcript.map((seg) => ({
    start: seg.start,
    end: seg.end,
    text: seg.text,
    speaker: seg.speaker || undefined,
  }));

  // Prepare compact surface representation
  const compactSurfaces = surfaces.map((s) => ({
    id: s.id,
    timestamp: s.timestamp,
    surfaceType: s.surfaceType,
    confidence: s.confidence,
  }));

  // Prepare compact brand catalog
  const compactBrands = brandCatalog.map((b) => ({
    id: b.id,
    name: b.name,
    category: b.category,
  }));

  // Truncate transcript if too long
  let transcriptStr = JSON.stringify(compactTranscript);
  if (transcriptStr.length > EDITORIAL_CONFIG.maxTranscriptChars) {
    transcriptStr = transcriptStr.substring(0, EDITORIAL_CONFIG.maxTranscriptChars) + "...]";
  }

  return `You are an expert short-form content editor analyzing a podcast transcript for viral clip potential. Your job is to find moments that would perform well as standalone TikTok/Reels/Shorts clips.

Here is the full transcript with timestamps:
${transcriptStr}

Here are the detected surfaces and their timestamps:
${JSON.stringify(compactSurfaces)}

Here are the available brand products seeking placement:
${JSON.stringify(compactBrands)}

TASK:
1. Identify the top ${maxClips} moments that would make compelling standalone clips. Each must be 15-60 seconds long.

2. Score each moment against these criteria (0.0-1.0 each):
   - hookStrength: Do the first 3 seconds grab attention? Look for questions, bold statements, laughter, surprising revelations. Penalize mid-sentence starts, dead air, filler words.
   - narrativeCompleteness: Does the clip contain a complete thought or story beat with beginning, middle, and resolution? Penalize clips that cut off mid-point or have unresolved setups.
   - emotionalArc: Is there an emotional shift within the clip? Look for excitement, humor, tension, surprise, agreement/disagreement. Penalize flat monotone segments.
   - speakerClarity: Is the primary speaker clearly audible and articulate? Penalize mumbling, crosstalk at critical moments, excessive filler.
   - replayability: Would someone watch this clip twice or share it? Look for quotable moments, universal truths, genuine reactions.
   - culturalRelevance: Is the topic brand-safe and relatable without full episode context? Penalize inside jokes, unresolved controversy.

3. For each moment, specify:
   - clipStart: Exact start timestamp in seconds (clean entry point, 0.5-1.0s before the hook statement begins, never mid-word)
   - clipEnd: Exact end timestamp in seconds (clean exit, 0.5-1.0s after final word, end on completed thought or punchline, never on "um"/"uh"/"so"/"and")
   - surfacesInRange: Array of surface IDs visible during this clip's timerange
   - compatibleBrands: Array of brand product IDs that contextually fit this moment, with reasoning for each match
   - suggestedTitle: Scroll-stopping title under 60 characters
   - topicTags: Array of topic tags for categorization
   - reasoning: Why this moment works as a standalone clip

4. Rank moments by composite quality. Prioritize moments where:
   - High editorial quality AND surface placement opportunity overlap
   - The topic naturally aligns with an available brand product
   - The emotional tone matches the brand's positioning

Return as JSON array sorted by composite score descending. No markdown, no code fences, just the raw JSON array:
[
  {
    "clipStart": 142.5,
    "clipEnd": 178.3,
    "scores": {
      "hookStrength": 0.9,
      "narrativeCompleteness": 0.85,
      "emotionalArc": 0.8,
      "speakerClarity": 0.95,
      "replayability": 0.88,
      "culturalRelevance": 0.7
    },
    "compositeScore": 0.84,
    "surfacesInRange": [12, 15, 18],
    "compatibleBrands": [
      { "brandProductId": 5, "reasoning": "Finance topic aligns with fintech brand" }
    ],
    "suggestedTitle": "I Was $50K in Debt at 25",
    "topicTags": ["personal finance", "debt", "motivation"],
    "reasoning": "Host shares vulnerable personal finance story with clear emotional arc..."
  }
]`;
}

// ── Response Parser ────────────────────────────────────────────────

function parseEditorialResponse(text: string): EditorialAnalysisOutput[] {
  try {
    let jsonStr = text.trim();

    // Remove markdown code fences if present
    if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
    else if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);

    const parsed = JSON.parse(jsonStr.trim()) as ClaudeEditorialResponse[];

    if (!Array.isArray(parsed)) {
      console.error("[EditorialAnalyzer] Response is not an array");
      return [];
    }

    return parsed
      .filter((item) => {
        if (typeof item.clipStart !== "number" || typeof item.clipEnd !== "number") {
          console.warn("[EditorialAnalyzer] Skipping item with missing timestamps");
          return false;
        }
        if (item.clipEnd <= item.clipStart) {
          console.warn("[EditorialAnalyzer] Skipping item with invalid time range");
          return false;
        }
        return true;
      })
      .map((item) => {
        // Validate and clamp scores
        const validatedScores = validateScores({
          hookStrength: item.scores?.hookStrength,
          narrativeCompleteness: item.scores?.narrativeCompleteness,
          emotionalArc: item.scores?.emotionalArc,
          speakerClarity: item.scores?.speakerClarity,
          surfaceCompatibility: 0, // Calculated later in clipRanker
          culturalRelevance: item.scores?.culturalRelevance,
          replayability: item.scores?.replayability,
        });

        return {
          clipStart: item.clipStart,
          clipEnd: item.clipEnd,
          scores: validatedScores,
          compositeScore: item.compositeScore ?? calculateCompositeScore(validatedScores),
          surfacesInRange: Array.isArray(item.surfacesInRange) ? item.surfacesInRange : [],
          compatibleBrands: Array.isArray(item.compatibleBrands) ? item.compatibleBrands : [],
          suggestedTitle: item.suggestedTitle || "Untitled Clip",
          topicTags: Array.isArray(item.topicTags) ? item.topicTags : [],
          reasoning: item.reasoning || "",
        };
      });
  } catch (err) {
    console.error("[EditorialAnalyzer] Failed to parse response:", err);
    console.error("[EditorialAnalyzer] Raw text that failed to parse:", text.substring(0, 1000));
    return [];
  }
}

// ── Main Analysis Function ─────────────────────────────────────────

/**
 * Analyze a video transcript to identify the best editorial clip moments.
 *
 * Uses Claude Dense API with the 7-dimension scoring rubric to find moments
 * that would make compelling standalone short-form clips.
 *
 * Returns scored moments sorted by composite quality score (descending).
 */
export async function analyzeEditorial(
  input: EditorialAnalysisInput
): Promise<EditorialAnalysisOutput[]> {
  const { videoId, transcript, surfaces, brandCatalog, maxClips = 10 } = input;

  if (!transcript || transcript.length === 0) {
    console.warn(`[EditorialAnalyzer] No transcript for video ${videoId}`);
    return [];
  }

  console.log(
    `[EditorialAnalyzer] Analyzing video ${videoId}: ` +
      `${transcript.length} segments, ${surfaces.length} surfaces, ${brandCatalog.length} brands`
  );

  try {
    const client = getClient();

    const prompt = buildEditorialAnalysisPrompt(transcript, surfaces, brandCatalog, maxClips);

    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(() => reject(new Error("Editorial analysis timeout")), EDITORIAL_CONFIG.timeout);
    });

    const analysisPromise = client.messages.create({
      model: EDITORIAL_CONFIG.model,
      max_tokens: EDITORIAL_CONFIG.maxTokens,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const response = await Promise.race([analysisPromise, timeoutPromise]);

    if (!response) {
      console.error("[EditorialAnalyzer] Request timed out");
      return [];
    }

    const textBlock = (response as Anthropic.Message).content.find(
      (block: Anthropic.ContentBlock) => block.type === "text"
    );
    if (!textBlock || textBlock.type !== "text") {
      console.error("[EditorialAnalyzer] No text in response");
      return [];
    }

    // Log raw response for debugging
    console.log(`[EditorialAnalyzer] Raw response length: ${textBlock.text.length} chars`);
    console.log(`[EditorialAnalyzer] Raw response preview: ${textBlock.text.substring(0, 500)}...`);

    const moments = parseEditorialResponse(textBlock.text);

    console.log(
      `[EditorialAnalyzer] Found ${moments.length} clip moments for video ${videoId}`
    );

    if (moments.length > 0) {
      const topMoment = moments[0];
      console.log(
        `[EditorialAnalyzer] Top moment: "${topMoment.suggestedTitle}" ` +
          `(${topMoment.clipStart.toFixed(1)}s-${topMoment.clipEnd.toFixed(1)}s, ` +
          `score: ${topMoment.compositeScore.toFixed(2)})`
      );
    }

    return moments;
  } catch (err: any) {
    console.error(`[EditorialAnalyzer] Analysis error for video ${videoId}:`, err.message);
    console.error(`[EditorialAnalyzer] Full error:`, err);
    return [];
  }
}

export { EDITORIAL_CONFIG };
