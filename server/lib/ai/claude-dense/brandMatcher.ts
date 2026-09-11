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

PLACEMENT STYLE SELECTION (pick the one that fits the surface type):

For Desk / Table surfaces (3D physical placements):
- "natural tabletop" — beverage cans, cups, small electronics resting on the surface
- "foreground feature" — product positioned closer to camera, hero treatment
- "corner accent" — subtle product placement at edge of frame

For Shelf surfaces (3D placements + 2D book-spines):
- "shelf prop" — product sitting on shelf alongside other items
- "book spine" — branded book with spine label visible
- "decorative item" — branded decor (mug, candle, small sculpture) on display
- "background shelf" — product on a shelf behind subject

For Wall surfaces (2D placements — flat artwork, signage):
- "wall poster" — printed poster, framed or unframed
- "framed art" — branded artwork in a frame, gallery-style
- "wall decal" — adhesive logo or sticker on the wall
- "neon sign" — illuminated brand sign, especially for nightlife/bar/studio scenes
- "mural" — large painted-on-wall brand artwork
- "shelf above-wall ledge" — narrow ledge mounted on wall

For Monitor / Laptop / TV surfaces:
- "screen overlay" — branded UI, app interface, or product demo on screen
- "wallpaper" — branded desktop background

For Floor surfaces:
- "floor display" — large product or floor-standing sign

CRITICAL: Only suggest placement styles that physically work with the surface type. Don't suggest "wall poster" for a desk surface, or "natural tabletop" for a wall.

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no code fences):
{
  "matches": [
    {
      "brandProductId": 123,
      "compatibilityScore": 0.85,
      "reasoning": "Why this brand fits or doesn't, including why this placement style suits the surface",
      "suggestedPlacementStyle": "wall poster"
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

/**
 * Fallback placement style when the model doesn't return one.
 * Picks a sensible default based on surface type so we never suggest
 * "natural tabletop" for a wall.
 */
function defaultPlacementStyle(surfaceType: string): string {
  const t = (surfaceType || '').toLowerCase();
  if (t.includes('wall')) return 'wall poster';
  if (t.includes('shelf')) return 'shelf prop';
  if (t.includes('monitor') || t.includes('laptop') || t.includes('tv') || t.includes('screen')) return 'screen overlay';
  if (t.includes('floor')) return 'floor display';
  return 'natural tabletop';
}

function parseBrandMatchResponse(text: string, surfaceType: string): BrandMatchOutput | null {
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

    const fallbackStyle = defaultPlacementStyle(surfaceType);

    return {
      matches: parsed.matches
        .filter((m: any) => typeof m.compatibilityScore === 'number' && m.brandProductId)
        .map((m: any) => ({
          brandProductId: m.brandProductId,
          compatibilityScore: Math.max(0, Math.min(1, m.compatibilityScore)),
          reasoning: m.reasoning || '',
          suggestedPlacementStyle: m.suggestedPlacementStyle || fallbackStyle,
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

    const result = parseBrandMatchResponse(textBlock.text, input.surfaceDetails.surfaceType);
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
