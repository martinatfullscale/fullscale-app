/**
 * Claude Dense Narrative Analyzer
 *
 * Runs AFTER Scanner V2 Phase 6 (Scene Context Enrichment).
 * Takes detected surfaces + Sharp scene context as input, sends to Claude API
 * for deep narrative understanding: what's being discussed, emotional tone,
 * cultural relevance, and placement viability scoring.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { NarrativeAnalysisInput, NarrativeAnalysisOutput } from "./types";

const CLAUDE_DENSE_TIMEOUT = 45000;
const CLAUDE_DENSE_MIN_VIABILITY = 0.4;

const NARRATIVE_ANALYSIS_PROMPT = `You are analyzing a video frame from a podcast, interview, or content creator video to assess its narrative context for product placement opportunities.

You are given:
1. A video frame image
2. Detected surfaces (flat areas where products could be placed)
3. Scene context from image analysis (brightness, edge density, color warmth, surroundings)

TASK: Provide a narrative intelligence assessment for this frame.

Analyze:
- What is happening in this scene? (conversation topic, activity, setting)
- What is the emotional tone? (enthusiastic, serious, casual, educational, humorous, intimate)
- What cultural themes or topics are present?
- How viable is this frame for product placement? (0.0 = terrible, 1.0 = perfect)
- What product categories would feel natural here?

PLACEMENT VIABILITY SCORING:
- 0.8-1.0: Clear surface, engaging content, natural product fit, good lighting
- 0.6-0.8: Usable surface, decent content context, moderate fit
- 0.4-0.6: Surface exists but context is weak or lighting is poor
- 0.2-0.4: Marginal — surface barely visible or content is negative/controversial
- 0.0-0.2: Not viable — no surface, person blocking, or inappropriate content

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no code fences):
{
  "narrativeContext": "Brief description of what's happening in the scene",
  "emotionalTone": "one word: enthusiastic, serious, casual, educational, humorous, intimate, inspirational, confrontational",
  "culturalTags": ["tag1", "tag2", "tag3"],
  "placementViability": 0.75,
  "suggestedProductCategories": ["category1", "category2", "category3"],
  "reasoning": "Why this is/isn't a good placement opportunity"
}`;

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required for Claude Dense narrative analysis");
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

function parseClaudeResponse(text: string): NarrativeAnalysisOutput | null {
  try {
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
    else if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);

    const parsed = JSON.parse(jsonStr.trim());

    if (!parsed.narrativeContext || typeof parsed.placementViability !== 'number') {
      console.warn('[Claude Dense] Invalid response structure');
      return null;
    }

    return {
      narrativeContext: parsed.narrativeContext,
      emotionalTone: parsed.emotionalTone || 'neutral',
      culturalTags: Array.isArray(parsed.culturalTags) ? parsed.culturalTags : [],
      placementViability: Math.max(0, Math.min(1, parsed.placementViability)),
      suggestedProductCategories: Array.isArray(parsed.suggestedProductCategories) ? parsed.suggestedProductCategories : [],
      reasoning: parsed.reasoning || '',
    };
  } catch (e) {
    console.error('[Claude Dense] Failed to parse response:', e);
    return null;
  }
}

export async function analyzeNarrative(input: NarrativeAnalysisInput): Promise<NarrativeAnalysisOutput | null> {
  try {
    console.log(`[Claude Dense] Analyzing narrative for video ${input.videoId}, frame ${input.frameIndex}`);

    const client = getClient();

    const surfacesSummary = input.detectedSurfaces.map(s =>
      `${s.surfaceType} (confidence: ${(s.confidence * 100).toFixed(0)}%, position: ${(s.boundingBox.x * 100).toFixed(0)}%,${(s.boundingBox.y * 100).toFixed(0)}%)`
    ).join('; ');

    const contextSummary = `Scene: ${input.sceneContext.sceneType}, Brightness: ${input.sceneContext.brightness.overall.toFixed(0)}, Edge density: ${(input.sceneContext.edgeDensity * 100).toFixed(1)}%, Color warmth: ${input.sceneContext.colorWarmth.toFixed(0)}, Surroundings: ${input.sceneContext.surroundings.join(', ')}`;

    const userMessage = `${NARRATIVE_ANALYSIS_PROMPT}

DETECTED SURFACES: ${surfacesSummary || 'None detected'}
SCENE CONTEXT: ${contextSummary}
${input.transcript ? `TRANSCRIPT: ${input.transcript}` : ''}

Analyze the frame now:`;

    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(() => reject(new Error('Claude Dense timeout')), CLAUDE_DENSE_TIMEOUT);
    });

    const analysisPromise = client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: userMessage },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: input.frameBase64,
            },
          },
        ],
      }],
    });

    const response = await Promise.race([analysisPromise, timeoutPromise]);

    if (!response) {
      console.error('[Claude Dense] Request timed out');
      return null;
    }

    const textBlock = (response as Anthropic.Message).content.find(
      (block: Anthropic.ContentBlock) => block.type === 'text'
    );
    if (!textBlock || textBlock.type !== 'text') {
      console.error('[Claude Dense] No text in response');
      return null;
    }

    const result = parseClaudeResponse(textBlock.text);

    if (result) {
      console.log(`[Claude Dense] Narrative: "${result.narrativeContext.substring(0, 80)}..."`);
      console.log(`[Claude Dense] Tone: ${result.emotionalTone}, Viability: ${(result.placementViability * 100).toFixed(0)}%`);
      console.log(`[Claude Dense] Cultural tags: ${result.culturalTags.join(', ')}`);
    }

    return result;
  } catch (err) {
    console.error('[Claude Dense] Narrative analysis error:', err);
    return null;
  }
}

export { CLAUDE_DENSE_MIN_VIABILITY };
