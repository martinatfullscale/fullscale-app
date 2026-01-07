/**
 * AI Insertion Engine Types
 */

export type PlacementSurface = 
  | 'screen'
  | 'wall'
  | 'table'
  | 'clothing'
  | 'vehicle'
  | 'product'
  | 'signage'
  | 'background';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneAnalysis {
  frameNumber: number;
  timestamp: number;
  surfaces: PlacementSurface[];
  boundingBoxes: Record<PlacementSurface, BoundingBox>;
  confidence: number;
  sceneType: string;
  lighting: 'natural' | 'artificial' | 'mixed';
  motion: 'static' | 'slow' | 'fast';
}

export interface InsertionOpportunity {
  id: string;
  videoId: string;
  startTime: number;
  endTime: number;
  surface: PlacementSurface;
  boundingBox: BoundingBox;
  confidence: number;
  estimatedValue: number;
  sceneContext: string;
  brandFit: string[];
}

export interface AnalysisRequest {
  videoUrl: string;
  videoId: string;
  userId: string;
  sampleRate?: number;
  targetSurfaces?: PlacementSurface[];
}

export interface AnalysisResult {
  videoId: string;
  opportunities: InsertionOpportunity[];
  totalDuration: number;
  framesAnalyzed: number;
  processingTime: number;
}
