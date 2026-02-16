/**
 * Scene Enhancer — AI-Powered Scene Quality Enhancement
 *
 * Uses Claude to evaluate and suggest enhancements for scenes that have
 * generated product assets. Ensures the final composite looks natural and
 * maintains content quality.
 *
 * Enhancement categories:
 * - Lighting adjustment suggestions
 * - Color grading recommendations
 * - Placement refinement (position tweaks)
 * - Quality scoring for the final composite
 */

import Anthropic from "@anthropic-ai/sdk";

export interface EnhancementInput {
  /** Base64 of the composite frame (asset placed on surface) */
  compositeBase64: string;
  /** Base64 of the original frame (without asset) */
  originalBase64: string;
  /** What product was placed */
  productName: string;
  /** Where it was placed */
  placementStyle: string;
  /** Scene narrative context */
  narrativeContext: string;
}

export interface EnhancementOutput {
  /** Overall quality score of the composite (0-1) */
  qualityScore: number;
  /** Does the product look natural in the scene? */
  naturalness: number;
  /** Specific enhancement suggestions */
  suggestions: EnhancementSuggestion[];
  /** Brief assessment of the placement */
  assessment: string;
  /** Should this go to manual review? */
  needsManualReview: boolean;
}

export interface EnhancementSuggestion {
  type: "lighting" | "color" | "position" | "scale" | "opacity" | "remove";
  description: string;
  priority: "high" | "medium" | "low";
  /** Numeric adjustment hint if applicable */
  adjustmentValue?: number;
}

const ENHANCEMENT_PROMPT = `You are a visual quality assessor for product placement in video content.
Analyze this composite image where a product has been digitally placed into a scene.

PRODUCT: {productName}
PLACEMENT STYLE: {placementStyle}
SCENE CONTEXT: {narrativeContext}

EVALUATE:
1. Overall quality (0-1): Does it look professional?
2. Naturalness (0-1): Does the product look like it belongs in the scene?
3. Lighting consistency: Does the product lighting match the scene?
4. Color harmony: Do the product colors work with the scene palette?
5. Scale appropriateness: Is the product the right size for the surface?
6. Position accuracy: Is it placed naturally on the surface?

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no code fences):
{
  "qualityScore": 0.85,
  "naturalness": 0.8,
  "assessment": "Brief 1-2 sentence assessment",
  "needsManualReview": false,
  "suggestions": [
    {
      "type": "lighting",
      "description": "What to adjust",
      "priority": "medium",
      "adjustmentValue": 10
    }
  ]
}

If the placement looks good, return an empty suggestions array. Only flag needsManualReview if quality < 0.5.`;

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY required for scene enhancement");
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

/**
 * Evaluate a composite frame and suggest enhancements.
 */
export async function evaluateComposite(input: EnhancementInput): Promise<EnhancementOutput> {
  const defaultResult: EnhancementOutput = {
    qualityScore: 0.5,
    naturalness: 0.5,
    suggestions: [],
    assessment: "Could not evaluate — using defaults",
    needsManualReview: true,
  };

  try {
    const client = getClient();

    const prompt = ENHANCEMENT_PROMPT
      .replace("{productName}", input.productName)
      .replace("{placementStyle}", input.placementStyle)
      .replace("{narrativeContext}", input.narrativeContext);

    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: input.compositeBase64 },
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: input.originalBase64 },
          },
          { type: "text", text: prompt },
        ],
      }],
    });

    const textBlock = response.content.find(
      (block: Anthropic.ContentBlock) => block.type === "text"
    );
    if (!textBlock || textBlock.type !== "text") {
      console.error("[SceneEnhancer] No text in response");
      return defaultResult;
    }

    const result = parseEnhancementResponse(textBlock.text);
    if (!result) return defaultResult;

    console.log(`[SceneEnhancer] Quality: ${(result.qualityScore * 100).toFixed(0)}%, Naturalness: ${(result.naturalness * 100).toFixed(0)}%, Suggestions: ${result.suggestions.length}`);
    return result;
  } catch (err) {
    console.error("[SceneEnhancer] Error:", err);
    return defaultResult;
  }
}

function parseEnhancementResponse(text: string): EnhancementOutput | null {
  try {
    let jsonStr = text.trim();
    if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
    else if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);

    const parsed = JSON.parse(jsonStr.trim());

    return {
      qualityScore: clamp(parsed.qualityScore ?? 0.5, 0, 1),
      naturalness: clamp(parsed.naturalness ?? 0.5, 0, 1),
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map((s: any) => ({
        type: s.type || "lighting",
        description: s.description || "",
        priority: s.priority || "medium",
        adjustmentValue: s.adjustmentValue,
      })) : [],
      assessment: parsed.assessment || "",
      needsManualReview: parsed.needsManualReview ?? false,
    };
  } catch (e) {
    console.error("[SceneEnhancer] Parse error:", e);
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
