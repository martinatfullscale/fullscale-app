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
import { keyValue, KEY_ALIASES } from "../../envKeys";

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
  /** Optional search query — when provided, Claude prioritizes clips matching this topic/keyword */
  query?: string;
  /** Ranges already covered by selected clips — retry rounds must find DIFFERENT moments */
  excludeRanges?: Array<{ start: number; end: number }>;
}

interface ClaudeEditorialResponse {
  clipStart: number;
  clipEnd: number;
  segments?: Array<{ start: number; end: number; role?: string }>;
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
    // Resolve the key under any spelling and honor the Replit AI base URL —
    // the same resolver the copilot client uses. Exact-matching
    // process.env.ANTHROPIC_API_KEY here would throw on CLAUDE_API_KEY, an
    // aliased name, or the AI sidecar, even though the call would work.
    const apiKey = keyValue(KEY_ALIASES.anthropic);
    const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;
    if (!apiKey && !baseURL) {
      throw new Error("No Anthropic credential (no key under any known spelling, no AI base URL) for editorial analysis");
    }
    const config: Record<string, any> = {};
    if (apiKey) config.apiKey = apiKey;
    if (baseURL) config.baseURL = baseURL;
    anthropicClient = new Anthropic(config);
  }
  return anthropicClient;
}

// ── Prompt Builder ─────────────────────────────────────────────────

function buildEditorialAnalysisPrompt(
  transcript: TranscriptSegment[],
  surfaces: EditorialAnalysisInput["surfaces"],
  brandCatalog: EditorialAnalysisInput["brandCatalog"],
  maxClips: number = 10,
  query?: string,
  excludeRanges?: Array<{ start: number; end: number }>
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
1. Identify the top ${maxClips} moments that would make compelling standalone clips. Each must be 15-60 seconds long.${query ? `

SEARCH FOCUS: The user is specifically looking for clips about "${query}". PRIORITIZE moments that relate to this topic. If fewer than ${maxClips} moments match the search query, include the best remaining moments to fill the list, but rank search-matching clips higher.` : ""}

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
   - segments (OPTIONAL — assembled narrative): when the STRONGEST version of this story spans non-contiguous parts of the transcript (e.g. the hook statement and its payoff are separated by a tangent), assemble 2-4 segments in NARRATIVE order instead of one long range. Each segment is { "start": seconds, "end": seconds, "role": "hook"|"body"|"payoff" }. Rules: every segment cuts on clean sentence boundaries (same entry/exit rules as above); combined duration 15-60s; segments may come from any part of the source but MUST be listed in the order they should play; when segments are provided, set clipStart/clipEnd to the min start / max end across segments. Use a single contiguous clipStart/clipEnd when the story is already contiguous — do NOT force segmentation.
   - surfacesInRange: Array of surface IDs visible during this clip's timerange
   - compatibleBrands: Array of brand product IDs that contextually fit this moment, with reasoning for each match
   - suggestedTitle: Scroll-stopping title under 60 characters
   - topicTags: Array of topic tags for categorization
   - reasoning: Why this moment works as a standalone clip

4. Rank moments by composite quality. Prioritize moments where:
   - High editorial quality AND surface placement opportunity overlap
   - The topic naturally aligns with an available brand product
   - The emotional tone matches the brand's positioning

${excludeRanges && excludeRanges.length > 0 ? `IMPORTANT — ALREADY COVERED: these time ranges are already selected as clips. Do NOT select moments that overlap them; find DIFFERENT moments elsewhere in the transcript: ${excludeRanges.map((r) => `${r.start.toFixed(0)}s-${r.end.toFixed(0)}s`).join(", ")}.

` : ""}Return as JSON array sorted by composite score descending. No markdown, no code fences, just the raw JSON array:
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
  },
  {
    "clipStart": 210.0,
    "clipEnd": 512.4,
    "segments": [
      { "start": 480.2, "end": 495.0, "role": "hook" },
      { "start": 210.0, "end": 231.5, "role": "body" },
      { "start": 500.1, "end": 512.4, "role": "payoff" }
    ],
    "scores": { "hookStrength": 0.92, "narrativeCompleteness": 0.9, "emotionalArc": 0.85, "speakerClarity": 0.9, "replayability": 0.9, "culturalRelevance": 0.75 },
    "compositeScore": 0.87,
    "surfacesInRange": [12],
    "compatibleBrands": [],
    "suggestedTitle": "The Advice That Changed Everything",
    "topicTags": ["career", "mentorship"],
    "reasoning": "The tease of the outcome makes the hook, the earlier setup is the body, and the resolution lands as payoff — assembled, this plays as one complete story."
  }
]`;
}

// ── Response Parser ────────────────────────────────────────────────

/**
 * Recover the complete top-level objects from a JSON array string that was cut
 * off mid-element (token-truncated). Scans for balanced `{...}` at array depth,
 * honoring string literals and escapes, and JSON.parses each one individually.
 * A trailing incomplete object is simply dropped.
 */
function salvageObjects(s: string): any[] {
  const out: any[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(s.slice(start, i + 1))); } catch { /* skip malformed */ }
        start = -1;
      }
    }
  }
  return out;
}

function parseEditorialResponse(text: string): EditorialAnalysisOutput[] {
  try {
    let jsonStr = text.trim();

    // Remove markdown code fences if present
    if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
    else if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);

    let parsed: ClaudeEditorialResponse[];
    try {
      parsed = JSON.parse(jsonStr.trim()) as ClaudeEditorialResponse[];
    } catch {
      // Truncated mid-array (the model hit the token cap). Rather than throw the
      // WHOLE batch away, recover every COMPLETE top-level object and keep those
      // clips. Walks the string tracking brace depth and string state so nested
      // objects don't confuse it.
      parsed = salvageObjects(jsonStr.trim());
      if (parsed.length === 0) throw new Error("no complete objects to salvage");
      console.warn(`[EditorialAnalyzer] Recovered ${parsed.length} complete clip(s) from a truncated response.`);
    }

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
      .map((item): EditorialAnalysisOutput | null => {
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

        // Validate assembled-narrative segments: 2-4 beats, each well-formed,
        // total 10-90s. Invalid segment sets degrade to the contiguous range.
        let segments: Array<{ start: number; end: number; role?: string }> | undefined = undefined;
        if (Array.isArray(item.segments) && item.segments.length >= 2 && item.segments.length <= 4) {
          const wellFormed = item.segments.every(
            (s) => typeof s?.start === "number" && typeof s?.end === "number" && s.end > s.start
          );
          const total = wellFormed
            ? item.segments.reduce((sum, s) => sum + (s.end - s.start), 0)
            : 0;
          if (wellFormed && total >= 10 && total <= 90) {
            segments = item.segments.map((s) => ({
              start: s.start,
              end: s.end,
              role: typeof s.role === "string" ? s.role : undefined,
            }));
          } else {
            // The envelope of a malformed assembled item is NOT a playable
            // range (it can span minutes of unrelated material) — drop the
            // whole item rather than degrade to it.
            console.warn("[EditorialAnalyzer] Dropping item with malformed segments (envelope is not a playable range)");
            return null;
          }
        }

        return {
          clipStart: segments ? Math.min(...segments.map((s) => s.start)) : item.clipStart,
          clipEnd: segments ? Math.max(...segments.map((s) => s.end)) : item.clipEnd,
          segments,
          scores: validatedScores,
          compositeScore: item.compositeScore ?? calculateCompositeScore(validatedScores),
          surfacesInRange: Array.isArray(item.surfacesInRange) ? item.surfacesInRange : [],
          compatibleBrands: Array.isArray(item.compatibleBrands) ? item.compatibleBrands : [],
          suggestedTitle: item.suggestedTitle || "Untitled Clip",
          topicTags: Array.isArray(item.topicTags) ? item.topicTags : [],
          reasoning: item.reasoning || "",
        };
      })
      .filter((item): item is EditorialAnalysisOutput => item !== null);
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
  const { videoId, transcript, surfaces, brandCatalog, maxClips = 10, query, excludeRanges } = input;

  if (!transcript || transcript.length === 0) {
    console.warn(`[EditorialAnalyzer] No transcript for video ${videoId}`);
    return [];
  }

  console.log(
    `[EditorialAnalyzer] Analyzing video ${videoId}: ` +
      `${transcript.length} segments, ${surfaces.length} surfaces, ${brandCatalog.length} brands` +
      (query ? `, query: "${query}"` : "")
  );

  try {
    const client = getClient();

    const prompt = buildEditorialAnalysisPrompt(transcript, surfaces, brandCatalog, maxClips, query, excludeRanges);

    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(() => reject(new Error("Editorial analysis timeout")), EDITORIAL_CONFIG.timeout);
    });

    // Scale the output budget with the number of clips requested. Each clip is
    // a fat object (six sub-scores, per-brand reasoning, title, tags, a
    // sentence of reasoning, optional segments) — roughly 450 tokens — so a
    // fixed 4096 truncated the JSON mid-array for a 12-clip request and, with
    // the all-or-nothing parse below now salvaging, was still leaving clips on
    // the table. Bounded to a safe ceiling for the model.
    const scaledMaxTokens = Math.min(8192, Math.max(EDITORIAL_CONFIG.maxTokens, maxClips * 450 + 600));

    const analysisPromise = client.messages.create({
      model: EDITORIAL_CONFIG.model,
      max_tokens: scaledMaxTokens,
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

    if ((response as Anthropic.Message).stop_reason === "max_tokens") {
      console.warn(`[EditorialAnalyzer] Response hit the ${scaledMaxTokens}-token cap for ${maxClips} clips — recovering the complete clips from the truncated array.`);
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

// ── Narrative Threading Types ─────────────────────────────────────

export interface NarrativeThreadInput {
  videoId: number;
  transcript: TranscriptSegment[];
  surfaces: EditorialAnalysisInput["surfaces"];
  brandCatalog: EditorialAnalysisInput["brandCatalog"];
  targetDuration?: number; // total highlight reel target in seconds (default: 90)
  segmentCount?: number;   // number of segments (default: 3-5)
}

export interface NarrativeSegment {
  start: number;
  end: number;
  role: "hook" | "development" | "climax" | "payoff" | "bridge";
  narrativePurpose: string;
  connectionToNext?: string;
  suggestedTransition: "cut" | "crossfade" | "branded_wipe";
  scores: RubricScores;
}

export interface NarrativeThreadOutput {
  segments: NarrativeSegment[];
  narrativeArc: string;
  totalDuration: number;
  suggestedTitle: string;
}

// ── Narrative Threading Prompt ────────────────────────────────────

function buildNarrativeThreadPrompt(
  transcript: TranscriptSegment[],
  surfaces: EditorialAnalysisInput["surfaces"],
  brandCatalog: EditorialAnalysisInput["brandCatalog"],
  targetDuration: number = 90,
  segmentCount: number = 4
): string {
  const compactTranscript = transcript.map((seg) => ({
    start: seg.start,
    end: seg.end,
    text: seg.text,
    speaker: seg.speaker || undefined,
  }));

  const compactSurfaces = surfaces.map((s) => ({
    id: s.id,
    timestamp: s.timestamp,
    surfaceType: s.surfaceType,
  }));

  const compactBrands = brandCatalog.map((b) => ({
    id: b.id,
    name: b.name,
    category: b.category,
  }));

  let transcriptStr = JSON.stringify(compactTranscript);
  if (transcriptStr.length > EDITORIAL_CONFIG.maxTranscriptChars) {
    transcriptStr = transcriptStr.substring(0, EDITORIAL_CONFIG.maxTranscriptChars) + "...]";
  }

  return `You are an expert short-form content editor creating a multi-segment highlight reel from a long-form video. Your job is to identify ${segmentCount} non-contiguous moments that, when stitched together, tell a coherent story.

Here is the full transcript with timestamps:
${transcriptStr}

Here are the detected surfaces and their timestamps:
${JSON.stringify(compactSurfaces)}

Here are the available brand products:
${JSON.stringify(compactBrands)}

TASK:
1. Identify exactly ${segmentCount} moments from this transcript that form a compelling narrative thread when placed in sequence. The total combined duration should be approximately ${targetDuration} seconds. Each segment should be 15-30 seconds long.

2. Each moment must serve a specific narrative role:
   - "hook": Opens with something attention-grabbing (bold claim, surprising fact, question). This MUST be the first segment.
   - "development": Builds context, provides background, deepens the topic. Usually 1-2 segments.
   - "climax": The peak moment — the most emotionally charged, insightful, or entertaining part.
   - "payoff": Resolution, conclusion, call-to-action, or punchline. This MUST be the last segment.
   - "bridge": Optional connective segment that smoothly transitions between major beats.

3. For each segment provide:
   - start/end: Exact timestamps in seconds. Clean entry/exit points (not mid-word).
   - role: One of the narrative roles above.
   - narrativePurpose: 1-2 sentences explaining WHY this segment was chosen and what it contributes to the story.
   - connectionToNext: How this segment connects thematically to the next one (omit for last segment).
   - suggestedTransition: How to transition INTO this segment from the previous:
     - "cut": Hard cut for dramatic effect or when topics shift sharply
     - "crossfade": Smooth dissolve for flowing topic continuation
     - "branded_wipe": Brand transition card (for topic changes with brand integration opportunity)
     The first segment should use "cut" (no previous segment to transition from).
   - scores: Rate this individual segment on the 6-dimension rubric (0.0-1.0 each):
     hookStrength, narrativeCompleteness, emotionalArc, speakerClarity, replayability, culturalRelevance

4. Also provide:
   - narrativeArc: A one-sentence description of the overall story thread
   - suggestedTitle: A scroll-stopping title for the highlight reel (under 60 chars)
   - totalDuration: Sum of all segment durations

CRITICAL RULES:
- Segments MUST NOT overlap in time
- Segments should be ordered by their position in the narrative thread, NOT by timestamp
- The combined story must make sense to someone who hasn't seen the full video
- Avoid segments that require context from parts not included
- Prefer segments where brand surfaces are visible (check surface timestamps)

Return as JSON object. No markdown, no code fences, just raw JSON:
{
  "segments": [
    {
      "start": 12.5,
      "end": 28.0,
      "role": "hook",
      "narrativePurpose": "Opens with the host's shocking revelation about...",
      "connectionToNext": "Sets up the deeper exploration that follows",
      "suggestedTransition": "cut",
      "scores": {
        "hookStrength": 0.9,
        "narrativeCompleteness": 0.7,
        "emotionalArc": 0.8,
        "speakerClarity": 0.95,
        "replayability": 0.85,
        "culturalRelevance": 0.75
      }
    }
  ],
  "narrativeArc": "A journey from shock to understanding to actionable advice",
  "suggestedTitle": "The Truth Nobody Tells You About...",
  "totalDuration": 88.5
}`;
}

// ── Narrative Threading Parser ────────────────────────────────────

function parseNarrativeThreadResponse(text: string): NarrativeThreadOutput | null {
  try {
    let jsonStr = text.trim();

    // Remove markdown code fences if present
    if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
    else if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);

    const parsed = JSON.parse(jsonStr.trim());

    if (!parsed.segments || !Array.isArray(parsed.segments)) {
      console.error("[NarrativeThread] Response missing segments array");
      return null;
    }

    const validSegments: NarrativeSegment[] = parsed.segments
      .filter((seg: any) => {
        if (typeof seg.start !== "number" || typeof seg.end !== "number") {
          console.warn("[NarrativeThread] Skipping segment with missing timestamps");
          return false;
        }
        if (seg.end <= seg.start) {
          console.warn("[NarrativeThread] Skipping segment with invalid time range");
          return false;
        }
        return true;
      })
      .map((seg: any) => {
        const validatedScores = validateScores({
          hookStrength: seg.scores?.hookStrength,
          narrativeCompleteness: seg.scores?.narrativeCompleteness,
          emotionalArc: seg.scores?.emotionalArc,
          speakerClarity: seg.scores?.speakerClarity,
          surfaceCompatibility: 0,
          culturalRelevance: seg.scores?.culturalRelevance,
          replayability: seg.scores?.replayability,
        });

        const validRoles = ["hook", "development", "climax", "payoff", "bridge"];
        const role = validRoles.includes(seg.role) ? seg.role : "development";

        const validTransitions = ["cut", "crossfade", "branded_wipe"];
        const transition = validTransitions.includes(seg.suggestedTransition)
          ? seg.suggestedTransition
          : "crossfade";

        return {
          start: seg.start,
          end: seg.end,
          role,
          narrativePurpose: seg.narrativePurpose || "",
          connectionToNext: seg.connectionToNext || undefined,
          suggestedTransition: transition,
          scores: validatedScores,
        } as NarrativeSegment;
      });

    if (validSegments.length === 0) {
      console.error("[NarrativeThread] No valid segments after parsing");
      return null;
    }

    const totalDuration = validSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);

    return {
      segments: validSegments,
      narrativeArc: parsed.narrativeArc || "Highlight reel",
      totalDuration: parsed.totalDuration || totalDuration,
      suggestedTitle: parsed.suggestedTitle || "Highlight Reel",
    };
  } catch (err) {
    console.error("[NarrativeThread] Failed to parse response:", err);
    return null;
  }
}

// ── Main Narrative Threading Function ─────────────────────────────

/**
 * Analyze a video transcript to identify a narrative thread for a highlight reel.
 *
 * Uses Claude to find 3-5 non-contiguous moments that form a coherent story
 * when stitched together (OpusClip-style). Each segment gets a narrative role
 * (hook, development, climax, payoff) and transition suggestion.
 */
export async function analyzeNarrativeThread(
  input: NarrativeThreadInput
): Promise<NarrativeThreadOutput | null> {
  const {
    videoId,
    transcript,
    surfaces,
    brandCatalog,
    targetDuration = 110,
    segmentCount = 4,
  } = input;

  if (!transcript || transcript.length === 0) {
    console.warn(`[NarrativeThread] No transcript for video ${videoId}`);
    return null;
  }

  console.log(
    `[NarrativeThread] Analyzing video ${videoId}: ` +
      `${transcript.length} segments, target ${targetDuration}s, ${segmentCount} segments`
  );

  try {
    const client = getClient();

    const prompt = buildNarrativeThreadPrompt(
      transcript,
      surfaces,
      brandCatalog,
      targetDuration,
      segmentCount
    );

    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(() => reject(new Error("Narrative thread analysis timeout")), EDITORIAL_CONFIG.timeout);
    });

    const analysisPromise = client.messages.create({
      model: EDITORIAL_CONFIG.model,
      max_tokens: EDITORIAL_CONFIG.maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const response = await Promise.race([analysisPromise, timeoutPromise]);

    if (!response) {
      console.error("[NarrativeThread] Request timed out");
      return null;
    }

    const textBlock = (response as Anthropic.Message).content.find(
      (block: Anthropic.ContentBlock) => block.type === "text"
    );
    if (!textBlock || textBlock.type !== "text") {
      console.error("[NarrativeThread] No text in response");
      return null;
    }

    console.log(`[NarrativeThread] Raw response length: ${textBlock.text.length} chars`);

    const result = parseNarrativeThreadResponse(textBlock.text);

    if (result) {
      console.log(
        `[NarrativeThread] Found ${result.segments.length} segments for video ${videoId}: ` +
          `"${result.suggestedTitle}" (${result.totalDuration.toFixed(1)}s)`
      );
      for (const [i, seg] of result.segments.entries()) {
        console.log(
          `[NarrativeThread]   #${i + 1} [${seg.role}] ${seg.start.toFixed(1)}s-${seg.end.toFixed(1)}s → ${seg.suggestedTransition}`
        );
      }
    }

    return result;
  } catch (err: any) {
    console.error(`[NarrativeThread] Analysis error for video ${videoId}:`, err.message);
    return null;
  }
}

// ── Cross-video library thread (job #2) ──────────────────────────────────
//
// The single-video analyzers above find a story WITHIN one video. This one
// reads a CORPUS of transcripts across many videos and proposes the strongest
// moments ACROSS them that assemble into one reel — the AI half of the reel
// builder. It only PROPOSES an ordered set of cross-video beats; rendering is
// the reel endpoint's job (POST /api/remix/reel).

export interface LibraryVideoInput {
  videoId: number;
  title: string;
  transcript: TranscriptSegment[];
}
export interface LibraryThreadInput {
  videos: LibraryVideoInput[];
  targetDuration?: number;
  segmentCount?: number;
}
export interface LibraryThreadSegment {
  videoId: number;
  start: number;
  end: number;
  role: string;
  reason: string;
  suggestedTransition: "cut" | "crossfade" | "branded_wipe";
}
export interface LibraryThreadOutput {
  segments: LibraryThreadSegment[];
  narrativeArc: string;
  suggestedTitle: string;
  totalDuration: number;
}

/** How many videos and how much transcript we feed the model at once. */
const LIBRARY_MAX_VIDEOS = 8;

/** A single beat longer than this is almost certainly a hallucinated end. */
const LIBRARY_MAX_BEAT_SEC = 45;

export async function analyzeLibraryThread(input: LibraryThreadInput): Promise<LibraryThreadOutput | null> {
  // Clamp caller-supplied knobs: segmentCount flows from the request body into
  // the prompt and bounds the response size, so an oversized value could push
  // the model past its token cap and truncate the whole proposal.
  const targetDuration = Math.max(15, Math.min(300, Number(input.targetDuration) || 90));
  const segmentCount = Math.max(2, Math.min(10, Number(input.segmentCount) || 5));

  // Only videos that actually have transcript, capped so the corpus fits.
  const videos = input.videos.filter((v) => v.transcript && v.transcript.length > 0).slice(0, LIBRARY_MAX_VIDEOS);
  if (videos.length < 2) {
    console.warn(`[LibraryThread] Need at least 2 transcribed videos, got ${videos.length}`);
    return null;
  }

  // Split the total transcript budget evenly across videos so one long video
  // can't crowd the others out of the model's context.
  const perVideoBudget = Math.floor(EDITORIAL_CONFIG.maxTranscriptChars / videos.length);
  const corpus = videos.map((v, i) => {
    const compact = v.transcript.map((seg) => ({ start: Math.round(seg.start * 10) / 10, end: Math.round(seg.end * 10) / 10, text: seg.text }));
    // DOWNSAMPLE, don't head-truncate. Slicing the JSON string keeps only the
    // opening of a long video, so the model never sees the back half and can't
    // pull a payoff from it. Instead drop evenly-spaced segments until it fits,
    // so the whole timeline is still represented (coarser, but end to end).
    let kept = compact;
    let str = JSON.stringify(kept);
    while (str.length > perVideoBudget && kept.length > 8) {
      const stride = Math.ceil(kept.length / Math.max(8, Math.floor(kept.length * 0.75)));
      kept = kept.filter((_, idx) => idx % stride !== stride - 1);
      str = JSON.stringify(kept);
    }
    if (str.length > perVideoBudget) str = str.substring(0, perVideoBudget) + "...]";
    const note = kept.length < compact.length ? ` (sampled ${kept.length}/${compact.length} lines across the full video)` : "";
    return `VIDEO ${i} — "${v.title}"${note}\n${str}`;
  }).join("\n\n");

  const prompt = `You are assembling ONE short-form highlight reel from moments drawn across SEVERAL different long-form videos by the same creator.

Below are ${videos.length} videos, each with a timestamped transcript. Video indices are 0-based.

${corpus}

TASK
Find the ${segmentCount} strongest moments — pulled from ANY of these videos — that, placed in sequence, form one compelling narrative arc. Moments may come from different videos; that is the point. Total combined duration ~${targetDuration}s, each moment 12-30s.

Each moment must serve a narrative role: "hook" (open strong), "development", "climax", "payoff", or "bridge".

Timestamps are RELATIVE TO THE VIDEO the moment comes from. Pick clean entry/exit points (not mid-word).

Return ONLY a JSON object, no prose, no code fence:
{
  "suggestedTitle": "string",
  "narrativeArc": "one sentence describing the story the reel tells",
  "segments": [
    { "videoIndex": number, "start": number, "end": number, "role": "hook|development|climax|payoff|bridge", "reason": "why this moment, and how it connects", "suggestedTransition": "cut|crossfade|branded_wipe" }
  ]
}`;

  try {
    const client = getClient();
    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(() => reject(new Error("Library thread timeout")), EDITORIAL_CONFIG.timeout);
    });
    const analysisPromise = client.messages.create({
      model: EDITORIAL_CONFIG.model,
      // Scale with segmentCount so the object never truncates for a legit request.
      max_tokens: Math.min(6000, 1200 + segmentCount * 350),
      messages: [{ role: "user", content: prompt }],
    });
    const response = await Promise.race([analysisPromise, timeoutPromise]);
    if (!response) { console.error("[LibraryThread] timed out"); return null; }

    const textBlock = (response as Anthropic.Message).content.find((b: Anthropic.ContentBlock) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;

    let raw = textBlock.text.trim();
    if (raw.startsWith("```json")) raw = raw.slice(7);
    else if (raw.startsWith("```")) raw = raw.slice(3);
    if (raw.endsWith("```")) raw = raw.slice(0, -3);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { console.error("[LibraryThread] no JSON object in response"); return null; }

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed?.segments)) { console.error("[LibraryThread] missing segments"); return null; }

    const roles = new Set(["hook", "development", "climax", "payoff", "bridge"]);
    const transitions = new Set(["cut", "crossfade", "branded_wipe"]);
    const segments: LibraryThreadSegment[] = [];
    for (const s of parsed.segments) {
      const vi = Number(s?.videoIndex);
      const start = Number(s?.start);
      const end = Number(s?.end);
      // videoIndex must map to a real video; a hallucinated index is dropped.
      if (!Number.isInteger(vi) || vi < 0 || vi >= videos.length) continue;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const s0 = Math.max(0, start);
      // Cap the beat length. The model only sees a downsampled transcript for
      // long videos, so it can hallucinate an end far past the intended 12-30s
      // (or past EOF); an uncapped end silently blows the reel's length and the
      // caption window. Trim rather than drop, keeping the beat's start.
      const end0 = Math.min(end, s0 + LIBRARY_MAX_BEAT_SEC);
      if (end0 - s0 < 1) continue;
      segments.push({
        videoId: videos[vi].videoId,
        start: s0,
        end: end0,
        role: roles.has(s?.role) ? s.role : "bridge",
        reason: String(s?.reason ?? "").slice(0, 300),
        suggestedTransition: transitions.has(s?.suggestedTransition) ? s.suggestedTransition : "crossfade",
      });
    }
    if (segments.length < 2) { console.warn("[LibraryThread] fewer than 2 valid segments after validation"); return null; }

    const totalDuration = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
    console.log(`[LibraryThread] ${segments.length} beats across ${new Set(segments.map((s) => s.videoId)).size} video(s): "${parsed.suggestedTitle}" (${totalDuration.toFixed(1)}s)`);
    return {
      segments,
      narrativeArc: String(parsed.narrativeArc ?? "").slice(0, 500),
      suggestedTitle: String(parsed.suggestedTitle ?? "Cross-video reel").slice(0, 200),
      totalDuration,
    };
  } catch (err: any) {
    console.error("[LibraryThread] error:", err.message);
    return null;
  }
}

export { EDITORIAL_CONFIG };
