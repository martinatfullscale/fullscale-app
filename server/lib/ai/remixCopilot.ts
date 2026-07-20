/**
 * Remix Co-Pilot — AI-powered remix assistant (Phase 4).
 *
 * Claude-powered assistant that understands the full remix context
 * (video metadata, transcript, editorial analysis, current clip state,
 * placements, quality scores) and provides actionable suggestions.
 *
 * Suggestion types:
 * - trim: Adjust clip boundaries for better hook/payoff
 * - hook_improvement: Start clip at a more attention-grabbing moment
 * - add_placement: Insert a brand placement on a detected surface
 * - generate_asset: Generate an image/video asset via Seeddance
 * - stitch: Combine this clip with other moments for a highlight reel
 * - caption_edit: Adjust caption style or timing
 * - platform_switch: Re-target clip for a better-suited platform
 * - reject: Flag a clip as unlikely to perform well
 *
 * Trigger points:
 * - After clip generation → proactive suggestions
 * - After creator trims → contextual follow-up
 * - After low quality score → improvement guidance
 * - On demand → freeform chat questions
 */

import Anthropic from "@anthropic-ai/sdk";
import type { RubricScores } from "../remix/clipScoringRubric";
import type { TranscriptSegment } from "../remix/speechToText";
import type { CaptionSegment } from "../remix/clipGenerator";

// ── Types ──────────────────────────────────────────────────────────

export interface CopilotSuggestion {
  type:
    | "trim"
    | "hook_improvement"
    | "add_placement"
    | "generate_asset"
    | "stitch"
    | "caption_edit"
    | "platform_switch"
    | "reject";
  reason: string;
  confidence: number; // 0-1
  data: CopilotSuggestionData;
}

export type CopilotSuggestionData =
  | TrimSuggestionData
  | HookImprovementData
  | AddPlacementData
  | GenerateAssetData
  | StitchData
  | CaptionEditData
  | PlatformSwitchData
  | RejectData;

export interface TrimSuggestionData {
  type: "trim";
  newStart: number;
  newEnd: number;
  trimDelta: { startDelta: number; endDelta: number };
}

export interface HookImprovementData {
  type: "hook_improvement";
  alternativeStart: number;
  hookLine: string; // the transcript line that makes a better hook
}

export interface AddPlacementData {
  type: "add_placement";
  surfaceId: number;
  productId: number;
  productName: string;
  placementTimestamp: number;
}

export interface GenerateAssetData {
  type: "generate_asset";
  prompt: string;
  assetType: "product_shot" | "transition_card" | "outro_card" | "b_roll";
  targetSurface?: number;
  /** Brand product id from the catalog when the asset features a product —
   *  required for the client to auto-apply via /api/generate/product-asset */
  productId?: number | null;
}

export interface StitchData {
  type: "stitch";
  additionalSegments: Array<{ start: number; end: number; reason: string }>;
  suggestedTransition: "cut" | "crossfade" | "branded_wipe";
}

export interface CaptionEditData {
  type: "caption_edit";
  suggestedStyle: "highlight" | "brand_callout" | "narrative";
  keyMoments?: Array<{ time: number; text: string }>;
}

export interface PlatformSwitchData {
  type: "platform_switch";
  currentPlatform: string;
  betterPlatform: string;
  platformReasons: string[];
}

export interface RejectData {
  type: "reject";
  issues: string[];
  fixable: boolean;
}

// ── Session Context ────────────────────────────────────────────────

export interface CopilotSessionContext {
  videoId: number;
  videoTitle: string;
  videoDuration: number;

  /** Full transcript for context */
  transcript: TranscriptSegment[];

  /** Current clip being discussed */
  currentClip?: {
    clipId: number;
    start: number;
    end: number;
    duration: number;
    platform: string;
    qualityScore: number;
    scores?: RubricScores;
    placements: Array<{
      surfaceId: number;
      productId: number;
      productName: string;
      timestamp: number;
    }>;
    captions?: CaptionSegment[];
    exportPath?: string;
  };

  /** Available surfaces in the video */
  surfaces: Array<{
    id: number;
    timestamp: number;
    surfaceType: string;
    confidence: number;
  }>;

  /** Brand catalog for placement suggestions */
  brandCatalog: Array<{
    id: number;
    name: string;
    category: string | null;
  }>;

  /** Previously generated clips for this video (for stitch suggestions) */
  existingClips: Array<{
    clipId: number;
    start: number;
    end: number;
    platform: string;
    qualityScore: number;
  }>;

  /** Editorial analysis results if available */
  editorialAnalysis?: Array<{
    clipStart: number;
    clipEnd: number;
    scores: RubricScores;
    compositeScore: number;
    suggestedTitle: string;
    reasoning: string;
  }>;

  /** Creator's edit history (actions taken this session) */
  editHistory: CopilotEditAction[];
}

export interface CopilotEditAction {
  action: "trim" | "re_render" | "toggle_captions" | "change_platform" | "stitch" | "generate_asset";
  timestamp: number; // Date.now()
  details: Record<string, unknown>;
}

// ── Copilot Request/Response ───────────────────────────────────────

export interface CopilotRequest {
  sessionContext: CopilotSessionContext;
  trigger: "post_generation" | "post_trim" | "low_score" | "user_question";
  userMessage?: string; // freeform question from creator
}

export interface CopilotResponse {
  message: string; // Claude's conversational response
  suggestions: CopilotSuggestion[];
  followUpQuestions?: string[]; // suggested follow-up questions for the creator
}

// ── Config ─────────────────────────────────────────────────────────

const COPILOT_CONFIG = {
  MODEL: "claude-sonnet-4-5-20250929",
  MAX_TOKENS: 4096,
  TEMPERATURE: 0.7,
  MAX_TRANSCRIPT_CHARS: 8000, // truncate long transcripts
  MAX_SUGGESTIONS: 4,
};

// ── Client ─────────────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    // Support Replit AI Integrations sidecar if available
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;

    const config: Record<string, any> = {};
    if (apiKey) config.apiKey = apiKey;
    if (baseURL) config.baseURL = baseURL;

    console.log(`[RemixCopilot] Creating Anthropic client — key: ${apiKey ? apiKey.substring(0, 8) + '...' : 'NOT SET'}, baseURL: ${baseURL || '(default)'}`);

    anthropicClient = new Anthropic(config);
  }
  return anthropicClient;
}

// ── Main Entry Point ───────────────────────────────────────────────

/**
 * Ask the co-pilot for suggestions or answers.
 * Returns a structured response with conversational text + actionable suggestions.
 */
export async function askCopilot(request: CopilotRequest): Promise<CopilotResponse> {
  console.log(`[RemixCopilot] Trigger: ${request.trigger}, Video: ${request.sessionContext.videoId}`);

  try {
    const client = getClient();
    const systemPrompt = buildSystemPrompt(request.sessionContext);
    const userPrompt = buildUserPrompt(request);

    console.log(`[RemixCopilot] System prompt length: ${systemPrompt.length}, User prompt length: ${userPrompt.length}`);

    const response = await client.messages.create({
      model: COPILOT_CONFIG.MODEL,
      max_tokens: COPILOT_CONFIG.MAX_TOKENS,
      temperature: COPILOT_CONFIG.TEMPERATURE,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return parseCopilotResponse(text, request);
  } catch (err: any) {
    console.error("[RemixCopilot] Error:", err.message);
    return {
      message: "I'm having trouble analyzing this clip right now. Please try again in a moment.",
      suggestions: [],
      followUpQuestions: ["Can you retry the analysis?"],
    };
  }
}

/**
 * Stream co-pilot response via SSE (for chat panel).
 * Yields partial text chunks, then a final structured response.
 */
export async function* streamCopilot(
  request: CopilotRequest
): AsyncGenerator<{ type: "text" | "done"; data: string }, void, unknown> {
  try {
    const client = getClient();
    const systemPrompt = buildSystemPrompt(request.sessionContext);
    const userPrompt = buildUserPrompt(request);

    console.log(`[RemixCopilot] Streaming — Trigger: ${request.trigger}, Video: ${request.sessionContext.videoId}`);
    console.log(`[RemixCopilot] System prompt length: ${systemPrompt.length}, User prompt length: ${userPrompt.length}`);

    const stream = client.messages.stream({
      model: COPILOT_CONFIG.MODEL,
      max_tokens: COPILOT_CONFIG.MAX_TOKENS,
      temperature: COPILOT_CONFIG.TEMPERATURE,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    let fullText = "";

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullText += event.delta.text;
        yield { type: "text", data: event.delta.text };
      }
    }

    // Parse the full response to extract structured suggestions
    const parsed = parseCopilotResponse(fullText, request);
    yield { type: "done", data: JSON.stringify(parsed) };
  } catch (err: any) {
    const errorType = err.constructor?.name || "Error";
    console.error(`[RemixCopilot] Stream error (${errorType}):`, err.message);
    if (err.status) console.error(`[RemixCopilot] HTTP Status: ${err.status}`);
    if (err.error) console.error(`[RemixCopilot] API Error:`, JSON.stringify(err.error));
    if (err.stack) console.error(`[RemixCopilot] Stack:`, err.stack);

    // Provide more specific error messages
    const errStr = (err.message || "").toLowerCase();
    let errorMsg = `I encountered an error (${errorType}: ${err.message || 'unknown'}). Please try again.`;
    if (err.status === 401 || errStr.includes("invalid x-api-key") || errStr.includes("api_key") || errStr.includes("authentication")) {
      errorMsg = "AI authentication failed. The Anthropic API key may be invalid or expired. Please check your ANTHROPIC_API_KEY in environment secrets.";
    } else if (err.status === 429 || errStr.includes("rate")) {
      errorMsg = "AI rate limit reached. Please wait a moment before trying again.";
    } else if (err.status === 500 || err.status === 503 || errStr.includes("overloaded")) {
      errorMsg = "The AI service is temporarily unavailable. Please try again in a minute.";
    } else if (errStr.includes("econnrefused") || errStr.includes("enotfound") || errStr.includes("fetch failed") || errStr.includes("timeout") || errStr.includes("network")) {
      errorMsg = "Cannot reach the AI service. Check your network connection and ANTHROPIC_API_KEY.";
    } else if (errStr.includes("could not resolve") || errStr.includes("api key")) {
      errorMsg = "ANTHROPIC_API_KEY is missing or invalid. Please set it in your environment secrets.";
    }

    yield {
      type: "done",
      data: JSON.stringify({
        message: errorMsg,
        suggestions: [],
        followUpQuestions: ["Can you retry?"],
      }),
    };
  }
}

// ── Proactive Suggestion Triggers ──────────────────────────────────

/**
 * Generate proactive suggestions after a clip is generated.
 * Called automatically after remix pipeline Step 8 (EXPORT).
 */
export async function getPostGenerationSuggestions(
  context: CopilotSessionContext
): Promise<CopilotResponse> {
  return askCopilot({
    sessionContext: context,
    trigger: "post_generation",
  });
}

/**
 * Generate suggestions after a low quality score (< 0.7).
 */
export async function getLowScoreSuggestions(
  context: CopilotSessionContext
): Promise<CopilotResponse> {
  return askCopilot({
    sessionContext: context,
    trigger: "low_score",
  });
}

// ── Prompt Building ────────────────────────────────────────────────

function buildSystemPrompt(ctx: CopilotSessionContext): string {
  return `You are the AI Co-Pilot for FullScale's Remix Studio — a video remixing platform that creates short-form clips from long-form content with product placements.

Your role: Help creators optimize their clips for maximum engagement and brand fit. You understand video editing, social media algorithms, narrative structure, and brand integration.

RESPONSE FORMAT — MANDATORY:
Your response MUST be valid JSON with this exact structure:
{
  "message": "Your conversational explanation to the creator (2-4 sentences, friendly and actionable)",
  "suggestions": [
    {
      "type": "trim|hook_improvement|add_placement|generate_asset|stitch|caption_edit|platform_switch|reject",
      "reason": "Why this suggestion will improve the clip",
      "confidence": 0.0-1.0,
      "data": { ... type-specific fields ... }
    }
  ],
  "followUpQuestions": ["Optional suggested follow-up questions for the creator"]
}

SUGGESTION DATA SCHEMAS:

For "trim": { "type": "trim", "newStart": number, "newEnd": number, "trimDelta": { "startDelta": number, "endDelta": number } }
For "hook_improvement": { "type": "hook_improvement", "alternativeStart": number, "hookLine": "the transcript text" }
For "add_placement": { "type": "add_placement", "surfaceId": number, "productId": number, "productName": "string", "placementTimestamp": number }
For "generate_asset": { "type": "generate_asset", "prompt": "image generation prompt", "assetType": "product_shot|transition_card|outro_card|b_roll", "targetSurface": number|null, "productId": number|null (id from BRAND CATALOG when the asset features a product — include it whenever possible so the suggestion can be applied in one click) }
For "stitch": { "type": "stitch", "additionalSegments": [{ "start": number, "end": number, "reason": "why" }], "suggestedTransition": "cut|crossfade|branded_wipe" }
For "caption_edit": { "type": "caption_edit", "suggestedStyle": "highlight|brand_callout|narrative", "keyMoments": [{ "time": number, "text": "string" }] }
For "platform_switch": { "type": "platform_switch", "currentPlatform": "string", "betterPlatform": "string", "platformReasons": ["reason1"] }
For "reject": { "type": "reject", "issues": ["issue1"], "fixable": true|false }

RULES:
- Maximum ${COPILOT_CONFIG.MAX_SUGGESTIONS} suggestions per response
- Be specific — reference exact timestamps, transcript lines, and surface IDs
- Be constructive — even when rejecting, explain what could be done differently
- Prioritize high-confidence suggestions first
- Consider platform-specific best practices (TikTok hooks < 3s, YouTube Shorts < 60s, etc.)
- Only suggest placements on surfaces that exist in the video
- Only suggest brand products from the available catalog
- All timestamps must be within the video's duration (0 to ${parseFloat(String(ctx.videoDuration)) || 0}s)

PLATFORM BEST PRACTICES:
- TikTok: Hook in first 1-2 seconds, 15-60s optimal, vertical 9:16, text captions boost 40%
- YouTube Shorts: Strong hook + payoff, up to 60s, can be slightly longer narrative
- Instagram Reels: Visual-first, 15-30s sweet spot, bold captions, trend-aligned
- Twitter/X: Punchy, conversational, 15-45s, controversy or surprise hooks

QUALITY SCORE DIMENSIONS (each 0-1):
- hookStrength (20%): First 3 seconds grab attention
- narrativeCompleteness (20%): Complete thought or story beat
- emotionalArc (15%): Emotional shift within clip
- speakerClarity (10%): Clear, articulate speaker
- surfaceCompatibility (15%): Product placement opportunity
- culturalRelevance (10%): Brand-safe and relatable
- replayability (10%): Worth watching twice or sharing`;
}

function buildUserPrompt(request: CopilotRequest): string {
  const ctx = request.sessionContext;
  const parts: string[] = [];

  // Safe number coercion — many DB fields are stored as varchar/text and arrive as strings.
  // This prevents "x.toFixed is not a function" crashes throughout prompt building.
  const n = (v: any, fallback = 0): number => {
    if (typeof v === "number" && !isNaN(v)) return v;
    const parsed = parseFloat(String(v));
    return isNaN(parsed) ? fallback : parsed;
  };

  const duration = n(ctx.videoDuration);

  // Video context
  parts.push(`VIDEO: "${ctx.videoTitle}" (${duration.toFixed(1)}s)`);

  // Transcript (truncated)
  if (ctx.transcript.length > 0) {
    const transcriptText = ctx.transcript
      .map((seg) => `[${n(seg.start).toFixed(1)}s] ${seg.speaker || "?"}: ${seg.text}`)
      .join("\n");
    const truncated = transcriptText.slice(0, COPILOT_CONFIG.MAX_TRANSCRIPT_CHARS);
    parts.push(`\nTRANSCRIPT:\n${truncated}${transcriptText.length > COPILOT_CONFIG.MAX_TRANSCRIPT_CHARS ? "\n... (truncated)" : ""}`);
  }

  // Current clip context
  if (ctx.currentClip) {
    const clip = ctx.currentClip;
    parts.push(`\nCURRENT CLIP (ID: ${clip.clipId}):`);
    parts.push(`  Time: ${n(clip.start).toFixed(1)}s → ${n(clip.end).toFixed(1)}s (${n(clip.duration).toFixed(1)}s)`);
    parts.push(`  Platform: ${clip.platform}`);
    parts.push(`  Quality Score: ${(n(clip.qualityScore) * 100).toFixed(0)}%`);
    if (clip.scores) {
      parts.push(`  Scores: Hook=${(n(clip.scores.hookStrength) * 100).toFixed(0)}%, Narrative=${(n(clip.scores.narrativeCompleteness) * 100).toFixed(0)}%, Emotion=${(n(clip.scores.emotionalArc) * 100).toFixed(0)}%, Speaker=${(n(clip.scores.speakerClarity) * 100).toFixed(0)}%, Surface=${(n(clip.scores.surfaceCompatibility) * 100).toFixed(0)}%, Cultural=${(n(clip.scores.culturalRelevance) * 100).toFixed(0)}%, Replay=${(n(clip.scores.replayability) * 100).toFixed(0)}%`);
    }
    if (clip.placements.length > 0) {
      parts.push(`  Placements: ${clip.placements.map((p) => `${p.productName} @ ${n(p.timestamp).toFixed(1)}s (surface #${p.surfaceId})`).join(", ")}`);
    }

    // Transcript snippet for the clip's time range
    const clipStart = n(clip.start);
    const clipEnd = n(clip.end);
    const clipTranscript = ctx.transcript.filter(
      (seg) => n(seg.start) >= clipStart && n(seg.end) <= clipEnd
    );
    if (clipTranscript.length > 0) {
      parts.push(`  Clip Transcript: "${clipTranscript.map((s) => s.text).join(" ")}"`);
    }
  }

  // Surfaces available
  if (ctx.surfaces.length > 0) {
    parts.push(`\nAVAILABLE SURFACES (${ctx.surfaces.length}):`);
    ctx.surfaces.slice(0, 20).forEach((s) => {
      parts.push(`  #${s.id}: ${s.surfaceType} @ ${n(s.timestamp).toFixed(1)}s (confidence: ${(n(s.confidence) * 100).toFixed(0)}%)`);
    });
  }

  // Brand catalog
  if (ctx.brandCatalog.length > 0) {
    parts.push(`\nBRAND CATALOG (${ctx.brandCatalog.length}):`);
    ctx.brandCatalog.forEach((b) => {
      parts.push(`  #${b.id}: ${b.name}${b.category ? ` (${b.category})` : ""}`);
    });
  }

  // Existing clips (for stitch suggestions)
  if (ctx.existingClips.length > 0) {
    parts.push(`\nEXISTING CLIPS FOR THIS VIDEO (${ctx.existingClips.length}):`);
    ctx.existingClips.forEach((c) => {
      parts.push(`  Clip #${c.clipId}: ${n(c.start).toFixed(1)}s → ${n(c.end).toFixed(1)}s, ${c.platform}, score: ${(n(c.qualityScore) * 100).toFixed(0)}%`);
    });
  }

  // Editorial analysis
  if (ctx.editorialAnalysis && ctx.editorialAnalysis.length > 0) {
    parts.push(`\nEDITORIAL ANALYSIS — TOP MOMENTS:`);
    ctx.editorialAnalysis.slice(0, 5).forEach((e) => {
      parts.push(`  ${n(e.clipStart).toFixed(1)}s → ${n(e.clipEnd).toFixed(1)}s: "${e.suggestedTitle}" (score: ${(n(e.compositeScore) * 100).toFixed(0)}%) — ${e.reasoning}`);
    });
  }

  // Edit history
  if (ctx.editHistory.length > 0) {
    parts.push(`\nCREATOR'S EDIT HISTORY THIS SESSION:`);
    ctx.editHistory.slice(-10).forEach((action) => {
      parts.push(`  [${new Date(action.timestamp).toLocaleTimeString()}] ${action.action}: ${JSON.stringify(action.details)}`);
    });
  }

  // Trigger-specific prompt
  parts.push("");
  switch (request.trigger) {
    case "post_generation":
      parts.push("TASK: This clip was just generated. Analyze it and provide 2-3 actionable suggestions to improve engagement, brand fit, or hook strength. Be specific about what to change and why.");
      break;
    case "post_trim":
      parts.push("TASK: The creator just trimmed this clip. Evaluate the new boundaries — is the hook better? Is the payoff intact? Suggest any further refinements or complementary changes.");
      break;
    case "low_score":
      parts.push(`TASK: This clip scored ${ctx.currentClip ? (n(ctx.currentClip.qualityScore) * 100).toFixed(0) : "?"}% which is below the quality threshold (70%). Identify the weakest dimensions and provide specific, fixable suggestions to bring the score up.`);
      break;
    case "user_question":
      parts.push(`TASK: The creator asks: "${request.userMessage || "How can I improve this clip?"}"\n\nProvide a helpful answer with specific, actionable suggestions where relevant.`);
      break;
  }

  return parts.join("\n");
}

// ── Response Parsing ───────────────────────────────────────────────

function parseCopilotResponse(text: string, request: CopilotRequest): CopilotResponse {
  const defaultResponse: CopilotResponse = {
    message: text.slice(0, 500),
    suggestions: [],
    followUpQuestions: [],
  };

  try {
    // Try to extract JSON from the response
    // Claude may wrap JSON in markdown code blocks
    let jsonStr = text;

    // Strip markdown code fences if present
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    // Try to find a JSON object in the text
    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!objectMatch) {
      // No JSON found — return the raw text as message
      return {
        ...defaultResponse,
        followUpQuestions: generateFallbackQuestions(request),
      };
    }

    const parsed = JSON.parse(objectMatch[0]);

    const response: CopilotResponse = {
      message: typeof parsed.message === "string" ? parsed.message : defaultResponse.message,
      suggestions: [],
      followUpQuestions: Array.isArray(parsed.followUpQuestions) ? parsed.followUpQuestions.slice(0, 3) : [],
    };

    // Validate and sanitize suggestions
    if (Array.isArray(parsed.suggestions)) {
      for (const sug of parsed.suggestions.slice(0, COPILOT_CONFIG.MAX_SUGGESTIONS)) {
        const validated = validateSuggestion(sug, request.sessionContext);
        if (validated) {
          response.suggestions.push(validated);
        }
      }
    }

    // Sort by confidence (highest first)
    response.suggestions.sort((a, b) => b.confidence - a.confidence);

    return response;
  } catch (err) {
    console.warn("[RemixCopilot] Failed to parse response as JSON, returning raw text");
    return {
      ...defaultResponse,
      followUpQuestions: generateFallbackQuestions(request),
    };
  }
}

function validateSuggestion(raw: any, ctx: CopilotSessionContext): CopilotSuggestion | null {
  if (!raw || typeof raw !== "object") return null;

  const validTypes = [
    "trim", "hook_improvement", "add_placement", "generate_asset",
    "stitch", "caption_edit", "platform_switch", "reject",
  ];

  if (!validTypes.includes(raw.type)) return null;
  if (typeof raw.reason !== "string") return null;

  // Ensure videoDuration is a number (schema stores as varchar)
  const vidDuration = typeof ctx.videoDuration === "number"
    ? ctx.videoDuration
    : parseFloat(String(ctx.videoDuration)) || 0;

  const confidence = typeof raw.confidence === "number"
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0.5;

  const data = raw.data || raw;

  // Type-specific validation
  switch (raw.type) {
    case "trim": {
      const newStart = typeof data.newStart === "number" ? data.newStart : null;
      const newEnd = typeof data.newEnd === "number" ? data.newEnd : null;
      if (newStart === null || newEnd === null) return null;
      if (newStart < 0 || newEnd > vidDuration || newStart >= newEnd) return null;
      const currentStart = ctx.currentClip?.start ?? 0;
      const currentEnd = ctx.currentClip?.end ?? 0;
      return {
        type: "trim",
        reason: raw.reason,
        confidence,
        data: {
          type: "trim",
          newStart,
          newEnd,
          trimDelta: {
            startDelta: newStart - currentStart,
            endDelta: newEnd - currentEnd,
          },
        },
      };
    }

    case "hook_improvement": {
      const altStart = typeof data.alternativeStart === "number" ? data.alternativeStart : null;
      if (altStart === null || altStart < 0 || altStart > vidDuration) return null;
      return {
        type: "hook_improvement",
        reason: raw.reason,
        confidence,
        data: {
          type: "hook_improvement",
          alternativeStart: altStart,
          hookLine: typeof data.hookLine === "string" ? data.hookLine : "",
        },
      };
    }

    case "add_placement": {
      const surfaceId = typeof data.surfaceId === "number" ? data.surfaceId : null;
      const productId = typeof data.productId === "number" ? data.productId : null;
      if (surfaceId === null || productId === null) return null;
      // Verify surface and product exist
      const surfaceExists = ctx.surfaces.some((s) => s.id === surfaceId);
      const product = ctx.brandCatalog.find((b) => b.id === productId);
      if (!surfaceExists || !product) return null;
      return {
        type: "add_placement",
        reason: raw.reason,
        confidence,
        data: {
          type: "add_placement",
          surfaceId,
          productId,
          productName: product.name,
          placementTimestamp: typeof data.placementTimestamp === "number" ? data.placementTimestamp : 0,
        },
      };
    }

    case "generate_asset": {
      const validAssetTypes = ["product_shot", "transition_card", "outro_card", "b_roll"];
      const assetType = validAssetTypes.includes(data.assetType) ? data.assetType : "product_shot";
      return {
        type: "generate_asset",
        reason: raw.reason,
        confidence,
        data: {
          type: "generate_asset",
          prompt: typeof data.prompt === "string" ? data.prompt : "Generate a product image",
          assetType,
          targetSurface: typeof data.targetSurface === "number" ? data.targetSurface : undefined,
        },
      };
    }

    case "stitch": {
      const segments = Array.isArray(data.additionalSegments)
        ? data.additionalSegments
            .filter((s: any) => typeof s.start === "number" && typeof s.end === "number")
            .map((s: any) => ({
              start: Math.max(0, s.start),
              end: Math.min(vidDuration, s.end),
              reason: typeof s.reason === "string" ? s.reason : "Complementary segment",
            }))
        : [];
      if (segments.length === 0) return null;
      const validTransitions = ["cut", "crossfade", "branded_wipe"];
      return {
        type: "stitch",
        reason: raw.reason,
        confidence,
        data: {
          type: "stitch",
          additionalSegments: segments,
          suggestedTransition: validTransitions.includes(data.suggestedTransition)
            ? data.suggestedTransition
            : "crossfade",
        },
      };
    }

    case "caption_edit": {
      const validStyles = ["highlight", "brand_callout", "narrative"];
      return {
        type: "caption_edit",
        reason: raw.reason,
        confidence,
        data: {
          type: "caption_edit",
          suggestedStyle: validStyles.includes(data.suggestedStyle) ? data.suggestedStyle : "highlight",
          keyMoments: Array.isArray(data.keyMoments)
            ? data.keyMoments
                .filter((m: any) => typeof m.time === "number" && typeof m.text === "string")
                .slice(0, 10)
            : undefined,
        },
      };
    }

    case "platform_switch": {
      if (typeof data.betterPlatform !== "string") return null;
      return {
        type: "platform_switch",
        reason: raw.reason,
        confidence,
        data: {
          type: "platform_switch",
          currentPlatform: ctx.currentClip?.platform || "unknown",
          betterPlatform: data.betterPlatform,
          platformReasons: Array.isArray(data.platformReasons) ? data.platformReasons : [raw.reason],
        },
      };
    }

    case "reject": {
      return {
        type: "reject",
        reason: raw.reason,
        confidence,
        data: {
          type: "reject",
          issues: Array.isArray(data.issues) ? data.issues : [raw.reason],
          fixable: typeof data.fixable === "boolean" ? data.fixable : true,
        },
      };
    }

    default:
      return null;
  }
}

function generateFallbackQuestions(request: CopilotRequest): string[] {
  switch (request.trigger) {
    case "post_generation":
      return [
        "How can I make the hook stronger?",
        "Are there better moments in this video for a clip?",
        "Which brand products would fit best here?",
      ];
    case "post_trim":
      return [
        "Is this clip length optimal for the platform?",
        "Should I add captions?",
        "Would this work better on a different platform?",
      ];
    case "low_score":
      return [
        "What's the biggest issue with this clip?",
        "Can you suggest a completely different moment?",
        "How do I improve the hook strength?",
      ];
    case "user_question":
      return [
        "What else can I improve?",
        "Can you suggest a highlight reel?",
        "What platform would this perform best on?",
      ];
  }
}
