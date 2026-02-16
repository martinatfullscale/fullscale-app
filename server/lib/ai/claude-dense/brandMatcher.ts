/**
 * Brand ↔ Scene Compatibility Matcher
 *
 * Takes narrative analysis + brand catalog, scores each brand against the scene.
 * Uses a multi-factor scoring model:
 * 1. Category alignment (brand category vs suggested product categories)
 * 2. Cultural fit (brand persona vs content cultural tags)
 * 3. Surface suitability (physical placement logistics)
 * 4. Narrative coherence (does the brand make sense in this conversation?)
 *
 * The auto-approve threshold (0.85) allows high-confidence matches to skip
 * manual brand review for faster automated placement.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { BrandMatchInput, BrandMatchOutput } from "./types";

const BRAND_MATCH_MIN_COMPATIBILITY = 0.5;
const BRAND_MATCH_AUTO_APPROVE_THRESHOLD = 0.85;

const BRAND_MATCHING_PROMPT = `You are a brand-content matching expert. Analyze the compatibility between available brand products and a video scene.

SCENE CONTEXT:
- Narrative: {narrative}
- Emotional tone: {tone}
- Cultural tags: {culturalTags}
- Suggested categories: {suggestedCategories}
- Surface type: {surfaceType} (confidence: {confidence}%)
- Lighting: {lighting}

AVAILABLE BRANDS:
{brandList}

TASK: Score each brand's compatibility with this scene on a 0-1 scale.

SCORING CRITERIA:
- 0.85-1.0: Perfect natural fit — brand category matches scene, tone aligns, would look authentic
- 0.7-0.85: Strong fit — category is adjacent, would look natural with minor styling
- 0.5-0.7: Moderate fit — could work but requires careful placement
- 0.3-0.5: Weak fit — technically possible but would feel forced
- 0.0-0.3: Poor fit — brand doesn't belong in this context

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no code fences):
{
  "matches": [
    {
      "brandProductId": 123,
      "compatibilityScore": 0.85,
      "reasoning": "Why this brand fits or doesn't",
      "suggestedPlacementStyle": "natural tabletop" | "background shelf" | "foreground feature" | "corner accent"
    }
  ]
}

Only include brands scoring >= 0.3. Sort by score descending.`;

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required for brand matching");
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

function parseBrandMatchResponse(text: string): BrandMatchOutput | null {
  try {
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
    else if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);

    const parsed = JSON.parse(jsonStr.trim());

    if (!Array.isArray(parsed.matches)) {
      console.warn('[Brand Matcher] Invalid response: missing matches array');
      return null;
    }

    return {
      matches: parsed.matches
        .filter((m: any) => typeof m.compatibilityScore === 'number' && m.brandProductId)
        .map((m: any) => ({
          brandProductId: m.brandProductId,
          compatibilityScore: Math.max(0, Math.min(1, m.compatibilityScore)),
          reasoning: m.reasoning || '',
          suggestedPlacementStyle: m.suggestedPlacementStyle || 'natural tabletop',
        }))
        .sort((a: any, b: any) => b.compatibilityScore - a.compatibilityScore),
    };
  } catch (e) {
    console.error('[Brand Matcher] Failed to parse response:', e);
    return null;
  }
}

export async function matchBrands(input: BrandMatchInput): Promise<BrandMatchOutput> {
  const emptyResult: BrandMatchOutput = { matches: [] };

  if (input.availableBrands.length === 0) {
    console.log('[Brand Matcher] No brands available to match');
    return emptyResult;
  }

  try {
    const client = getClient();

    const brandList = input.availableBrands
      .map(b => `- ID: ${b.id}, Name: "${b.name}", Category: "${b.category || 'uncategorized'}"`)
      .join('\n');

    const prompt = BRAND_MATCHING_PROMPT
      .replace('{narrative}', input.narrativeAnalysis.narrativeContext)
      .replace('{tone}', input.narrativeAnalysis.emotionalTone)
      .replace('{culturalTags}', input.narrativeAnalysis.culturalTags.join(', '))
      .replace('{suggestedCategories}', input.narrativeAnalysis.suggestedProductCategories.join(', '))
      .replace('{surfaceType}', input.surfaceDetails.surfaceType)
      .replace('{confidence}', (input.surfaceDetails.confidence * 100).toFixed(0))
      .replace('{lighting}', input.surfaceDetails.lightingDirection)
      .replace('{brandList}', brandList);

    console.log(`[Brand Matcher] Matching ${input.availableBrands.length} brands against scene...`);

    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find(
      (block: Anthropic.ContentBlock) => block.type === 'text'
    );
    if (!textBlock || textBlock.type !== 'text') {
      console.error('[Brand Matcher] No text in response');
      return emptyResult;
    }

    const result = parseBrandMatchResponse(textBlock.text);
    if (!result) return emptyResult;

    // Filter by minimum compatibility
    result.matches = result.matches.filter(m => m.compatibilityScore >= BRAND_MATCH_MIN_COMPATIBILITY);

    console.log(`[Brand Matcher] Found ${result.matches.length} compatible brands (>= ${BRAND_MATCH_MIN_COMPATIBILITY})`);
    for (const match of result.matches.slice(0, 3)) {
      console.log(`[Brand Matcher]   #${match.brandProductId}: ${(match.compatibilityScore * 100).toFixed(0)}% — ${match.suggestedPlacementStyle}`);
    }

    return result;
  } catch (err) {
    console.error('[Brand Matcher] Error:', err);
    return emptyResult;
  }
}

export { BRAND_MATCH_MIN_COMPATIBILITY, BRAND_MATCH_AUTO_APPROVE_THRESHOLD };
