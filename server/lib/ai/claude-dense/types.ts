/**
 * Shared types for the Claude Dense narrative intelligence module.
 * All interfaces used across narrativeAnalyzer, culturalRelevance, and brandMatcher.
 */

export interface NarrativeAnalysisInput {
  videoId: number;
  frameIndex: number;
  frameBase64: string;
  detectedSurfaces: Array<{
    id: number;
    surfaceType: string;
    confidence: number;
    boundingBox: { x: number; y: number; width: number; height: number };
    lightingDirection?: string;
    lightingIntensity?: number;
    cameraAngle?: string;
  }>;
  sceneContext: {
    sceneType: string;
    brightness: { overall: number; top: number; bottom: number };
    edgeDensity: number;
    colorWarmth: number;
    surroundings: string[];
    brandCategorySuggestions: string[];
  };
  transcript?: string;
}

export interface NarrativeAnalysisOutput {
  narrativeContext: string;
  emotionalTone: string;
  culturalTags: string[];
  placementViability: number;
  suggestedProductCategories: string[];
  reasoning: string;
}

export interface BrandMatchInput {
  narrativeAnalysis: NarrativeAnalysisOutput;
  availableBrands: Array<{
    id: number;
    name: string;
    category: string | null;
    imageUrl: string;
  }>;
  surfaceDetails: {
    surfaceType: string;
    boundingBox: { x: number; y: number; width: number; height: number };
    confidence: number;
    lightingDirection: string;
  };
}

export interface BrandMatchOutput {
  matches: Array<{
    brandProductId: number;
    compatibilityScore: number;
    reasoning: string;
    suggestedPlacementStyle: string;
  }>;
}

export interface CulturalRelevanceOutput {
  culturalMoments: string[];
  audienceAlignment: string[];
  trendingTopics: string[];
  contentThemes: string[];
}
