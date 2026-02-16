/**
 * Cultural Relevance Tagger
 *
 * Identifies cultural moments, trending topics, and audience alignment
 * from narrative analysis output. Helps mid-market brands find creators
 * whose content authentically aligns with their products.
 *
 * Feeds into brandMatcher for more nuanced matching beyond just surface type.
 */

import type { NarrativeAnalysisOutput, CulturalRelevanceOutput } from "./types";

// Cultural theme taxonomy — maps narrative signals to cultural categories
const CULTURAL_THEME_MAP: Record<string, string[]> = {
  // Content themes → cultural tags
  finance: ['personal-finance', 'investing', 'entrepreneurship', 'fintech'],
  tech: ['technology', 'gadgets', 'software', 'innovation', 'ai'],
  health: ['wellness', 'fitness', 'nutrition', 'mental-health', 'self-care'],
  food: ['cooking', 'restaurants', 'food-culture', 'recipes'],
  business: ['entrepreneurship', 'startups', 'career', 'leadership'],
  education: ['learning', 'skills', 'personal-development', 'academic'],
  entertainment: ['pop-culture', 'movies', 'music', 'gaming'],
  lifestyle: ['fashion', 'travel', 'home-decor', 'relationships'],
  sports: ['athletics', 'fitness', 'outdoor', 'competition'],
  creative: ['art', 'design', 'music-production', 'photography'],
};

// Audience alignment signals based on emotional tone + themes
const AUDIENCE_MAP: Record<string, string[]> = {
  enthusiastic: ['gen-z', 'millennials', 'early-adopters'],
  serious: ['professionals', 'decision-makers', 'researchers'],
  casual: ['general-audience', 'millennials', 'content-browsers'],
  educational: ['students', 'professionals', 'lifelong-learners'],
  humorous: ['gen-z', 'millennials', 'social-media-native'],
  intimate: ['niche-community', 'loyal-followers', 'deep-engagement'],
  inspirational: ['aspirational-buyers', 'self-improvement', 'goal-setters'],
};

export function analyzeCulturalRelevance(
  narrative: NarrativeAnalysisOutput
): CulturalRelevanceOutput {
  const culturalMoments: string[] = [];
  const audienceAlignment: string[] = [];
  const trendingTopics: string[] = [];
  const contentThemes: string[] = [];

  // Extract content themes from cultural tags and suggested categories
  const allSignals = [
    ...narrative.culturalTags,
    ...narrative.suggestedProductCategories,
    narrative.narrativeContext.toLowerCase(),
  ].join(' ');

  for (const [theme, tags] of Object.entries(CULTURAL_THEME_MAP)) {
    if (allSignals.includes(theme)) {
      contentThemes.push(theme);
      culturalMoments.push(...tags.slice(0, 2));
    }
  }

  // Audience alignment from emotional tone
  const toneAudiences = AUDIENCE_MAP[narrative.emotionalTone.toLowerCase()];
  if (toneAudiences) {
    audienceAlignment.push(...toneAudiences);
  }

  // High-viability scenes are trending content signals
  if (narrative.placementViability >= 0.7) {
    trendingTopics.push('high-engagement-content');
  }
  if (narrative.culturalTags.length >= 3) {
    trendingTopics.push('culturally-rich');
  }

  // Deduplicate
  return {
    culturalMoments: [...new Set(culturalMoments)].slice(0, 8),
    audienceAlignment: [...new Set(audienceAlignment)].slice(0, 5),
    trendingTopics: [...new Set(trendingTopics)].slice(0, 5),
    contentThemes: [...new Set(contentThemes)].slice(0, 5),
  };
}
