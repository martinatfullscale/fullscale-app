/**
 * ============================================================================
 * SCANNER V2 - Resource-Safe Surface Detection for Replit
 * ============================================================================
 * 
 * This is a lightweight, production-safe replacement for scanner.ts.
 * 
 * DETECTION METHODS:
 * - Gemini AI: Deep understanding of scene content, product placement zones
 * - Sharp edge detection: Fast fallback for desk/table horizontal lines
 * 
 * KEY FEATURES:
 * - Deletes frames IMMEDIATELY after processing (disk-safe)
 * - Never throws - all errors caught and returned gracefully
 * - Pre-flight disk space check before extraction
 * - Processes one frame at a time (memory-safe)
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import sharp from "sharp";
import { storage } from "./storage";
import type { InsertDetectedSurface } from "@shared/schema";
import { GoogleGenAI } from "@google/genai";

// ============================================================================
// GEMINI AI CLIENT
// ============================================================================

const ai = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY || "dummy-key",
  httpOptions: {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  },
});

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Frame extraction - every 2 seconds for better coverage
  FRAME_INTERVAL_SECONDS: 2,
  MAX_FRAMES_PER_VIDEO: 24,
  FRAME_MAX_DIMENSION: 640,
  FRAME_QUALITY: 70,
  
  // Disk safety
  MIN_DISK_SPACE_MB: 100,
  
  // Detection method: 'gemini' or 'edge'
  DETECTION_METHOD: 'edge' as 'gemini' | 'edge',
  
  // Detection thresholds (for edge detection fallback)
  EDGE_THRESHOLD: 15,
  HORIZONTAL_LINE_MIN_LENGTH: 0.15,
  SURFACE_CONFIDENCE_THRESHOLD: 0.05, // Lowered to catch more surfaces
  
  // Fallback detection - add "Potential Surface" if too few found
  MIN_SURFACES_BEFORE_FALLBACK: 3,
  FALLBACK_CONFIDENCE: 0.15,
  
  // Timeouts
  FFMPEG_TIMEOUT_MS: 60000,
  FRAME_PROCESS_TIMEOUT_MS: 5000,
  GEMINI_TIMEOUT_MS: 30000,
  
  // Vertical video handling
  VERTICAL_ASPECT_THRESHOLD: 1.0,
  VERTICAL_ROI_TOP: 0.4,
} as const;

// ============================================================================
// TYPES
// ============================================================================

interface ScanResult {
  success: boolean;
  videoId: number;
  surfacesDetected: number;
  error?: string;
}

interface DetectedSurface {
  surfaceType: string;
  confidence: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  timestamp: number;
  frameUrl?: string;
}

interface FrameAnalysisResult {
  hasSurface: boolean;
  confidence: number;
  surfaces: DetectedSurface[];
  isVertical: boolean;
}

interface EdgeAnalysisResult {
  horizontalEdgeDensity: number;
  dominantHorizontalY: number;
  surfaceConfidence: number;
  regionOfInterest: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

// Gemini AI types
interface GeminiBoundingBox {
  x: number;      // percentage 0-100
  y: number;      // percentage 0-100  
  width: number;  // percentage 0-100
  height: number; // percentage 0-100
}

interface GeminiDetectedSurface {
  location: GeminiBoundingBox;
  surface_type: string;
  confidence: number;
  reasoning: string;
}

interface GeminiSurfaceDetectionResult {
  surfaces_found: boolean;
  frame_description: string;
  surfaces: GeminiDetectedSurface[];
  recommended_placement: {
    location: GeminiBoundingBox;
    reason: string;
  } | null;
  no_surface_reason?: string;
}

// ============================================================================
// GEMINI AI PROMPT
// ============================================================================

const SURFACE_DETECTION_PROMPT = `You are analyzing a video frame to identify suitable areas for product placement in advertising.

TASK: Find areas where a product (like a beverage, phone, or small object) could be naturally placed.

LOOK FOR:
1. **Flat surfaces** - Tables, desks, countertops, shelves, nightstands, coffee tables
2. **Empty spaces** - Clear areas beside or near the subject where a product could appear
3. **Natural placement zones** - Lower third of frame, surfaces in foreground/background
4. **Contextual fits** - Kitchen counter for food products, desk for tech products, etc.

DO NOT FLAG:
- Areas blocked by people or moving hands
- Surfaces that are too cluttered
- Areas outside the main visual focus
- Vertical surfaces (walls) unless they have shelves

For each suitable area found, provide:
- **location**: Bounding box as {x, y, width, height} in percentages (0-100) of frame dimensions
- **surface_type**: What it is (desk, table, shelf, counter, open_space, etc.)
- **confidence**: 0.0 to 1.0 based on how suitable it is for product placement
- **reasoning**: Brief explanation of why this spot works

RESPOND IN THIS EXACT JSON FORMAT:
{
  "surfaces_found": true/false,
  "frame_description": "Brief description of what's in the frame",
  "surfaces": [
    {
      "location": {"x": 20, "y": 60, "width": 30, "height": 25},
      "surface_type": "desk",
      "confidence": 0.85,
      "reasoning": "Clear wooden desk surface in lower right, good lighting, unobstructed"
    }
  ],
  "recommended_placement": {
    "location": {"x": ..., "y": ..., "width": ..., "height": ...},
    "reason": "Best overall spot because..."
  }
}

If NO suitable surfaces exist in this frame, respond with:
{
  "surfaces_found": false,
  "frame_description": "Description of frame",
  "surfaces": [],
  "recommended_placement": null,
  "no_surface_reason": "Why no placement works (e.g., 'close-up face shot', 'too much motion blur', 'fully outdoor scene with no surfaces')"
}

Analyze the frame now:`;

// ============================================================================
// LOCAL ASSET MAP
// ============================================================================

const LOCAL_ASSET_MAP: Record<string, string> = {
  // Production video - permanently deployed
  'upload-1769888669571-r3dd53': './public/videos/many_jobs.mov',
  // Test video 2 - Bar table test
  'test-video-2': './public/videos/test_video2.mov',
  'upload-test-video-2': './public/videos/test_video2.mov',
  // Legacy mappings
  'yt_techguru_001': './public/videos/many_jobs.mov',
  'yt_beauty_02': './public/hero_video.mp4',
  'test-video-1': './public/hero_video.mp4',
  'hero-local-001': './public/hero_video.mp4',
  'many-jobs-test': './public/videos/many_jobs.mov',
  'local-many-jobs': './public/videos/many_jobs.mov',
  'prod-many-jobs': './public/videos/many_jobs.mov',
};

export function addToLocalAssetMap(videoId: string, filePath: string): void {
  LOCAL_ASSET_MAP[videoId] = filePath;
  console.log(`[Scanner V2] Added to LOCAL_ASSET_MAP: ${videoId} -> ${filePath}`);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

async function getAvailableDiskSpaceMB(): Promise<number> {
  try {
    const tmpDir = os.tmpdir();
    return new Promise((resolve) => {
      const df = spawn("df", ["-m", tmpDir]);
      let output = "";
      
      df.stdout.on("data", (data) => {
        output += data.toString();
      });
      
      df.on("close", () => {
        const lines = output.trim().split("\n");
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          if (parts.length >= 4) {
            const availableMB = parseInt(parts[3], 10);
            if (!isNaN(availableMB)) {
              resolve(availableMB);
              return;
            }
          }
        }
        resolve(1000);
      });
      
      df.on("error", () => {
        resolve(1000);
      });
    });
  } catch {
    return 1000;
  }
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[Scanner V2] Deleted: ${filePath}`);
    }
  } catch (err) {
    console.error(`[Scanner V2] Failed to delete ${filePath}:`, err);
  }
}

function safeRmdir(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      console.log(`[Scanner V2] Removed directory: ${dirPath}`);
    }
  } catch (err) {
    console.error(`[Scanner V2] Failed to remove directory ${dirPath}:`, err);
  }
}

async function getFrameMetadata(framePath: string): Promise<{ width: number; height: number; isVertical: boolean }> {
  try {
    const metadata = await sharp(framePath).metadata();
    const width = metadata.width || 1920;
    const height = metadata.height || 1080;
    const isVertical = (width / height) < CONFIG.VERTICAL_ASPECT_THRESHOLD;
    return { width, height, isVertical };
  } catch {
    return { width: 1920, height: 1080, isVertical: false };
  }
}

// ============================================================================
// FRAME EXTRACTION (FFmpeg)
// ============================================================================

async function extractFrames(
  videoPath: string,
  outputDir: string
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const absoluteVideoPath = path.resolve(videoPath);
    const absoluteOutputDir = path.resolve(outputDir);
    const outputPattern = path.join(absoluteOutputDir, "frame_%04d.jpg");
    
    console.log(`[Scanner V2] Extracting frames from: ${absoluteVideoPath}`);
    console.log(`[Scanner V2] Output directory: ${absoluteOutputDir}`);
    
    if (!fs.existsSync(absoluteVideoPath)) {
      reject(new Error(`Video file not found: ${absoluteVideoPath}`));
      return;
    }
    
    fs.mkdirSync(absoluteOutputDir, { recursive: true });
    
    const ffmpegArgs = [
      "-i", absoluteVideoPath,
      "-vf", `fps=1/${CONFIG.FRAME_INTERVAL_SECONDS},scale='min(${CONFIG.FRAME_MAX_DIMENSION},iw)':'min(${CONFIG.FRAME_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`,
      "-q:v", "5",
      "-frames:v", CONFIG.MAX_FRAMES_PER_VIDEO.toString(),
      outputPattern,
    ];
    
    console.log(`[Scanner V2] FFmpeg command: ffmpeg ${ffmpegArgs.join(" ")}`);
    
    const ffmpeg = spawn("ffmpeg", ffmpegArgs);
    
    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    
    const timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      reject(new Error(`FFmpeg timed out after ${CONFIG.FFMPEG_TIMEOUT_MS}ms`));
    }, CONFIG.FFMPEG_TIMEOUT_MS);
    
    ffmpeg.on("close", (code) => {
      clearTimeout(timeout);
      
      if (code !== 0) {
        console.error(`[Scanner V2] FFmpeg failed with code ${code}`);
        console.error(`[Scanner V2] FFmpeg stderr: ${stderr.slice(-500)}`);
        reject(new Error(`FFmpeg exited with code ${code}`));
        return;
      }
      
      try {
        const frames = fs.readdirSync(absoluteOutputDir)
          .filter(f => f.endsWith(".jpg"))
          .sort()
          .map(f => path.join(absoluteOutputDir, f));
        
        console.log(`[Scanner V2] Extracted ${frames.length} frames`);
        resolve(frames);
      } catch (err) {
        reject(err);
      }
    });
    
    ffmpeg.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ============================================================================
// EDGE-BASED SURFACE DETECTION (Sharp)
// ============================================================================

async function analyzeFrameForSurfaces(
  framePath: string,
  timestamp: number,
  isVertical: boolean
): Promise<FrameAnalysisResult> {
  const defaultResult: FrameAnalysisResult = {
    hasSurface: false,
    confidence: 0,
    surfaces: [],
    isVertical,
  };
  
  try {
    const image = sharp(framePath);
    const metadata = await image.metadata();
    const width = metadata.width || 640;
    const height = metadata.height || 480;
    
    const roiTop = isVertical ? Math.floor(height * CONFIG.VERTICAL_ROI_TOP) : Math.floor(height * 0.3);
    const roiHeight = height - roiTop;
    
    const roiBuffer = await image
      .extract({ left: 0, top: roiTop, width, height: roiHeight })
      .greyscale()
      .raw()
      .toBuffer();
    
    const edgeAnalysis = analyzeHorizontalEdges(roiBuffer, width, roiHeight);
    
    console.log(`[Scanner V2] Frame ${timestamp}s: horizontal edge density = ${(edgeAnalysis.horizontalEdgeDensity * 100).toFixed(1)}%, confidence = ${(edgeAnalysis.surfaceConfidence * 100).toFixed(1)}%`);
    
    if (edgeAnalysis.surfaceConfidence >= CONFIG.SURFACE_CONFIDENCE_THRESHOLD) {
      const surface: DetectedSurface = {
        surfaceType: "Desk",
        confidence: edgeAnalysis.surfaceConfidence,
        boundingBox: {
          x: edgeAnalysis.regionOfInterest.x,
          y: (roiTop / height) + (edgeAnalysis.regionOfInterest.y * (roiHeight / height)),
          width: edgeAnalysis.regionOfInterest.width,
          height: edgeAnalysis.regionOfInterest.height * (roiHeight / height),
        },
        timestamp,
      };
      
      return {
        hasSurface: true,
        confidence: edgeAnalysis.surfaceConfidence,
        surfaces: [surface],
        isVertical,
      };
    }
    
    return defaultResult;
    
  } catch (err) {
    console.error(`[Scanner V2] Frame analysis error:`, err);
    return defaultResult;
  }
}

function analyzeHorizontalEdges(
  buffer: Buffer,
  width: number,
  height: number
): EdgeAnalysisResult {
  const defaultResult: EdgeAnalysisResult = {
    horizontalEdgeDensity: 0,
    dominantHorizontalY: 0.5,
    surfaceConfidence: 0,
    regionOfInterest: { x: 0.1, y: 0.3, width: 0.8, height: 0.5 },
  };
  
  if (buffer.length !== width * height) {
    console.log(`[Scanner V2] DEBUG: Buffer size mismatch - expected ${width * height}, got ${buffer.length}`);
    return defaultResult;
  }
  
  // Debug: Check pixel value distribution
  let minVal = 255, maxVal = 0, sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    minVal = Math.min(minVal, buffer[i]);
    maxVal = Math.max(maxVal, buffer[i]);
    sum += buffer[i];
  }
  console.log(`[Scanner V2] DEBUG: Pixel range: ${minVal}-${maxVal}, mean: ${(sum / buffer.length).toFixed(1)}`);
  
  const rowEdgeCounts: number[] = [];
  let maxEdgeCount = 0;
  let maxEdgeRow = 0;
  let totalGradientSum = 0;
  let edgesAtThreshold10 = 0;
  let edgesAtThreshold20 = 0;
  let edgesAtThreshold30 = 0;
  
  for (let y = 1; y < height - 1; y++) {
    let edgeCount = 0;
    let consecutiveEdge = 0;
    let maxConsecutive = 0;
    
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      
      const above = buffer[idx - width];
      const below = buffer[idx + width];
      const gradient = Math.abs(below - above);
      totalGradientSum += gradient;
      
      if (gradient > 10) edgesAtThreshold10++;
      if (gradient > 20) edgesAtThreshold20++;
      if (gradient > 30) edgesAtThreshold30++;
      
      if (gradient > CONFIG.EDGE_THRESHOLD) {
        edgeCount++;
        consecutiveEdge++;
        maxConsecutive = Math.max(maxConsecutive, consecutiveEdge);
      } else {
        consecutiveEdge = 0;
      }
    }
    
    const continuousRatio = maxConsecutive / width;
    if (continuousRatio > CONFIG.HORIZONTAL_LINE_MIN_LENGTH) {
      rowEdgeCounts[y] = edgeCount;
      if (edgeCount > maxEdgeCount) {
        maxEdgeCount = edgeCount;
        maxEdgeRow = y;
      }
    } else {
      rowEdgeCounts[y] = 0;
    }
  }
  
  const totalPixels = (width - 2) * (height - 2);
  console.log(`[Scanner V2] DEBUG: Avg gradient: ${(totalGradientSum / totalPixels).toFixed(2)}`);
  console.log(`[Scanner V2] DEBUG: Edges at threshold 10: ${(edgesAtThreshold10/totalPixels*100).toFixed(2)}%`);
  console.log(`[Scanner V2] DEBUG: Edges at threshold 20: ${(edgesAtThreshold20/totalPixels*100).toFixed(2)}%`);
  console.log(`[Scanner V2] DEBUG: Edges at threshold 30: ${(edgesAtThreshold30/totalPixels*100).toFixed(2)}%`);
  console.log(`[Scanner V2] DEBUG: Max consecutive edge run: ${maxEdgeCount} pixels (need ${Math.floor(width * CONFIG.HORIZONTAL_LINE_MIN_LENGTH)} for ${CONFIG.HORIZONTAL_LINE_MIN_LENGTH * 100}% threshold)`);
  
  const totalEdges = rowEdgeCounts.reduce((sum, count) => sum + (count || 0), 0);
  const maxPossibleEdges = width * height;
  const horizontalEdgeDensity = totalEdges / maxPossibleEdges;
  
  const dominantY = maxEdgeRow / height;
  const positionBonus = dominantY > 0.4 ? 0.2 : 0;
  const densityScore = Math.min(1, horizontalEdgeDensity * 10);
  const continuityScore = maxEdgeCount / width;
  
  const surfaceConfidence = Math.min(1, 
    (densityScore * 0.3) + 
    (continuityScore * 0.5) + 
    positionBonus
  );
  
  return {
    horizontalEdgeDensity,
    dominantHorizontalY: dominantY,
    surfaceConfidence,
    regionOfInterest: {
      x: 0.05,
      y: Math.max(0, dominantY - 0.1),
      width: 0.9,
      height: 0.4,
    },
  };
}

// ============================================================================
// GEMINI AI SURFACE DETECTION
// ============================================================================

function parseGeminiResponse(rawResponse: string): GeminiSurfaceDetectionResult | null {
  try {
    let jsonStr = rawResponse.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    
    const parsed = JSON.parse(jsonStr.trim());
    
    if (typeof parsed.surfaces_found !== 'boolean') {
      console.warn('[Gemini] Invalid response: missing surfaces_found');
      return null;
    }
    
    if (parsed.surfaces_found && Array.isArray(parsed.surfaces)) {
      parsed.surfaces = parsed.surfaces.filter((s: any) => {
        return s.location && 
               typeof s.location.x === 'number' &&
               typeof s.location.y === 'number' &&
               typeof s.confidence === 'number';
      });
    }
    
    return parsed;
  } catch (e) {
    console.error('[Gemini] Failed to parse response:', e);
    console.error('[Gemini] Raw response:', rawResponse.substring(0, 500));
    return null;
  }
}

async function analyzeFrameWithGemini(
  framePath: string,
  timestamp: number,
  isVertical: boolean
): Promise<FrameAnalysisResult> {
  const defaultResult: FrameAnalysisResult = {
    hasSurface: false,
    confidence: 0,
    surfaces: [],
    isVertical,
  };
  
  try {
    console.log(`[Gemini] Analyzing frame at ${timestamp}s...`);
    
    const imageBuffer = fs.readFileSync(framePath);
    const base64Image = imageBuffer.toString('base64');
    const metadata = await sharp(framePath).metadata();
    const mimeType = metadata.format === 'png' ? 'image/png' : 'image/jpeg';
    
    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(() => reject(new Error('Gemini timeout')), CONFIG.GEMINI_TIMEOUT_MS);
    });
    
    const analysisPromise = ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { text: SURFACE_DETECTION_PROMPT },
          { inlineData: { mimeType, data: base64Image } }
        ]
      }],
    });
    
    const response = await Promise.race([analysisPromise, timeoutPromise]);
    
    if (!response) {
      console.error('[Gemini] Request timed out');
      return defaultResult;
    }
    
    const textContent = response.candidates?.[0]?.content?.parts?.[0];
    if (!textContent || !('text' in textContent) || !textContent.text) {
      console.error('[Gemini] No text in response');
      return defaultResult;
    }
    
    const parsed = parseGeminiResponse(textContent.text as string);
    
    if (!parsed) {
      console.error('[Gemini] Failed to parse response');
      return defaultResult;
    }
    
    console.log(`[Gemini] Frame ${timestamp}s: ${parsed.frame_description}`);
    console.log(`[Gemini] Surfaces found: ${parsed.surfaces_found}, count: ${parsed.surfaces.length}`);
    
    if (parsed.no_surface_reason) {
      console.log(`[Gemini] No surface reason: ${parsed.no_surface_reason}`);
    }
    
    if (!parsed.surfaces_found || parsed.surfaces.length === 0) {
      return defaultResult;
    }
    
    const surfaces: DetectedSurface[] = parsed.surfaces.map(s => ({
      surfaceType: s.surface_type.charAt(0).toUpperCase() + s.surface_type.slice(1),
      confidence: s.confidence,
      boundingBox: {
        x: s.location.x / 100,
        y: s.location.y / 100,
        width: s.location.width / 100,
        height: s.location.height / 100,
      },
      timestamp,
    }));
    
    const maxConfidence = Math.max(...surfaces.map(s => s.confidence));
    
    return {
      hasSurface: true,
      confidence: maxConfidence,
      surfaces,
      isVertical,
    };
    
  } catch (err) {
    console.error(`[Gemini] Frame analysis error:`, err);
    return defaultResult;
  }
}

// ============================================================================
// MAIN SCAN FUNCTIONS
// ============================================================================

export async function processVideoScan(
  videoId: number,
  forceRescan: boolean = false
): Promise<ScanResult> {
  console.log(`[Scanner V2] ========== STARTING SCAN ==========`);
  console.log(`[Scanner V2] Video ID: ${videoId}, Force Rescan: ${forceRescan}`);
  
  const tempDir = path.join(os.tmpdir(), `scan-v2-${videoId}-${Date.now()}`);
  const framesDir = path.join(tempDir, "frames");
  
  try {
    // PRE-FLIGHT CHECKS
    const availableMB = await getAvailableDiskSpaceMB();
    console.log(`[Scanner V2] Available disk space: ${availableMB}MB`);
    
    if (availableMB < CONFIG.MIN_DISK_SPACE_MB) {
      console.error(`[Scanner V2] Insufficient disk space: ${availableMB}MB < ${CONFIG.MIN_DISK_SPACE_MB}MB required`);
      return {
        success: false,
        videoId,
        surfacesDetected: 0,
        error: `Insufficient disk space: ${availableMB}MB available, ${CONFIG.MIN_DISK_SPACE_MB}MB required`,
      };
    }
    
    const video = await storage.getVideoById(videoId);
    if (!video) {
      return { success: false, videoId, surfacesDetected: 0, error: "Video not found" };
    }
    
    console.log(`[Scanner V2] Video: ${video.title} (${video.youtubeId})`);
    
    if (!forceRescan && video.status !== "Pending Scan") {
      return {
        success: false,
        videoId,
        surfacesDetected: 0,
        error: `Video status is "${video.status}", not "Pending Scan"`,
      };
    }
    
    // LOCATE VIDEO FILE
    let videoPath: string | undefined;
    
    if ((video as any).filePath) {
      videoPath = path.resolve(process.cwd(), (video as any).filePath);
      console.log(`[Scanner V2] Using DB filePath: ${videoPath}`);
    }
    
    if (!videoPath && LOCAL_ASSET_MAP[video.youtubeId]) {
      videoPath = path.resolve(process.cwd(), LOCAL_ASSET_MAP[video.youtubeId]);
      console.log(`[Scanner V2] Using LOCAL_ASSET_MAP: ${videoPath}`);
    }
    
    if (!videoPath && video.youtubeId.startsWith("upload-")) {
      const fileMatch = video.description?.match(/File: (\/uploads\/[^\s|]+)/);
      if (fileMatch) {
        videoPath = path.resolve(process.cwd(), `./public${fileMatch[1]}`);
        console.log(`[Scanner V2] Using description fallback: ${videoPath}`);
      }
    }
    
    // DEBUG LOGGING
    console.log('[Scanner V2] DEBUG - youtubeId:', video.youtubeId);
    console.log('[Scanner V2] DEBUG - LOCAL_ASSET_MAP keys:', Object.keys(LOCAL_ASSET_MAP));
    console.log('[Scanner V2] DEBUG - Resolved videoPath:', videoPath);
    
    if (!videoPath || !fs.existsSync(videoPath)) {
      console.error(`[Scanner V2] Video file not found: ${videoPath}`);
      await storage.updateVideoStatus(videoId, "Pending Upload");
      return {
        success: false,
        videoId,
        surfacesDetected: 0,
        error: "Video file not found. Upload required.",
      };
    }
    
    const fileSizeMB = fs.statSync(videoPath).size / 1024 / 1024;
    console.log(`[Scanner V2] Video file size: ${fileSizeMB.toFixed(2)}MB`);
    
    // UPDATE STATUS & CLEAR OLD DATA
    await storage.clearDetectedSurfaces(videoId);
    await storage.updateVideoStatus(videoId, "Scanning");
    
    fs.mkdirSync(framesDir, { recursive: true });
    
    // EXTRACT FRAMES
    console.log(`[Scanner V2] Extracting frames...`);
    const frames = await extractFrames(videoPath, framesDir);
    
    if (frames.length === 0) {
      await storage.updateVideoStatus(videoId, "Scan Failed");
      return { success: false, videoId, surfacesDetected: 0, error: "No frames extracted" };
    }
    
    console.log(`[Scanner V2] Extracted ${frames.length} frames`);
    
    const { isVertical } = await getFrameMetadata(frames[0]);
    console.log(`[Scanner V2] Video orientation: ${isVertical ? "VERTICAL (9:16)" : "HORIZONTAL (16:9)"}`);
    
    const permanentFramesDir = path.join(process.cwd(), "public", "uploads", "frames", videoId.toString());
    if (!fs.existsSync(permanentFramesDir)) {
      fs.mkdirSync(permanentFramesDir, { recursive: true });
    }
    
    // PROCESS FRAMES ONE BY ONE (with immediate cleanup)
    let totalSurfaces = 0;
    console.log(`[Scanner V2] Detection method: ${CONFIG.DETECTION_METHOD.toUpperCase()}`);
    
    for (let i = 0; i < frames.length; i++) {
      const framePath = frames[i];
      const timestamp = i * CONFIG.FRAME_INTERVAL_SECONDS;
      
      try {
        console.log(`[Scanner V2] Processing frame ${i + 1}/${frames.length} (${timestamp}s)...`);
        
        // Use Gemini AI or edge detection based on config
        const analysis = CONFIG.DETECTION_METHOD === 'gemini'
          ? await analyzeFrameWithGemini(framePath, timestamp, isVertical)
          : await analyzeFrameForSurfaces(framePath, timestamp, isVertical);
        
        if (analysis.hasSurface && analysis.surfaces.length > 0) {
          const frameFilename = `frame_${timestamp}s.jpg`;
          const permanentPath = path.join(permanentFramesDir, frameFilename);
          
          try {
            fs.copyFileSync(framePath, permanentPath);
          } catch (copyErr) {
            console.error(`[Scanner V2] Failed to save frame:`, copyErr);
          }
          
          const frameUrl = `/uploads/frames/${videoId}/${frameFilename}`;
          
          for (const surface of analysis.surfaces) {
            const dbSurface: InsertDetectedSurface = {
              videoId,
              timestamp: timestamp.toString(),
              surfaceType: surface.surfaceType,
              confidence: surface.confidence.toString(),
              boundingBoxX: surface.boundingBox.x.toString(),
              boundingBoxY: surface.boundingBox.y.toString(),
              boundingBoxWidth: surface.boundingBox.width.toString(),
              boundingBoxHeight: surface.boundingBox.height.toString(),
              frameUrl,
            };
            
            const inserted = await storage.insertDetectedSurface(dbSurface);
            console.log(`[Scanner V2] *** SURFACE FOUND: ${surface.surfaceType} at ${timestamp}s (confidence: ${(surface.confidence * 100).toFixed(1)}%, id: ${inserted.id}) ***`);
            totalSurfaces++;
          }
        }
        
      } finally {
        // CRITICAL: Always delete the frame after processing
        safeUnlink(framePath);
      }
    }
    
    // FALLBACK DETECTION - Add "Potential Surface" for videos with too few detections
    if (totalSurfaces < CONFIG.MIN_SURFACES_BEFORE_FALLBACK && frames.length > 0) {
      console.log(`[Scanner V2] Low surface count (${totalSurfaces}), adding fallback surfaces...`);
      
      // Find frames that didn't get surfaces and add potential surfaces
      const framesWithSurfaces = new Set<number>();
      const existingSurfaces = await storage.getDetectedSurfaces(videoId);
      existingSurfaces.forEach(s => framesWithSurfaces.add(parseInt(s.timestamp)));
      
      for (let i = 0; i < frames.length && totalSurfaces < CONFIG.MIN_SURFACES_BEFORE_FALLBACK + 2; i++) {
        const timestamp = i * CONFIG.FRAME_INTERVAL_SECONDS;
        if (!framesWithSurfaces.has(timestamp)) {
          // Add fallback surface for bottom 40% of frame
          const dbSurface = {
            videoId,
            timestamp: String(timestamp),
            surfaceType: "Potential Surface",
            confidence: String(CONFIG.FALLBACK_CONFIDENCE),
            boundingBoxX: "0.05",
            boundingBoxY: "0.6", // Bottom 40%
            boundingBoxWidth: "0.9",
            boundingBoxHeight: "0.35",
            frameUrl: null,
            surroundings: null,
            sceneContext: "Fallback detection - potential placement area",
          };
          
          await storage.insertDetectedSurface(dbSurface);
          console.log(`[Scanner V2] *** FALLBACK SURFACE at ${timestamp}s (confidence: ${(CONFIG.FALLBACK_CONFIDENCE * 100).toFixed(1)}%) ***`);
          totalSurfaces++;
        }
      }
    }
    
    // FINALIZE
    const finalStatus = totalSurfaces > 0 ? `Ready (${totalSurfaces} Spots)` : "Ready (0 Spots)";
    await storage.updateVideoStatus(videoId, finalStatus);
    
    console.log(`[Scanner V2] ========== SCAN COMPLETE ==========`);
    console.log(`[Scanner V2] Video ID: ${videoId}, Surfaces: ${totalSurfaces}`);
    
    return {
      success: true,
      videoId,
      surfacesDetected: totalSurfaces,
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Scanner V2] SCAN FAILED: ${errorMessage}`);
    
    try {
      await storage.updateVideoStatus(videoId, "Scan Failed");
    } catch {
      // Ignore DB errors during error handling
    }
    
    return {
      success: false,
      videoId,
      surfacesDetected: 0,
      error: errorMessage,
    };
    
  } finally {
    // CLEANUP - Always runs, even on error
    safeRmdir(tempDir);
  }
}

export async function scanPendingVideos(
  userId: string,
  limit: number = 5
): Promise<ScanResult[]> {
  console.log(`[Scanner V2] Scanning pending videos for user ${userId} (limit: ${limit})`);
  
  try {
    const pendingVideos = await storage.getPendingVideos(userId, limit);
    console.log(`[Scanner V2] Found ${pendingVideos.length} pending videos`);
    
    const results: ScanResult[] = [];
    
    for (const video of pendingVideos) {
      const result = await processVideoScan(video.id);
      results.push(result);
    }
    
    return results;
    
  } catch (error) {
    console.error(`[Scanner V2] scanPendingVideos error:`, error);
    return [];
  }
}

export async function detectSurface(
  videoPath: string
): Promise<{ hasSurface: boolean; confidence: number }> {
  const tempDir = path.join(os.tmpdir(), `detect-${Date.now()}`);
  const framesDir = path.join(tempDir, "frames");
  
  try {
    if (!fs.existsSync(videoPath)) {
      return { hasSurface: false, confidence: 0 };
    }
    
    fs.mkdirSync(framesDir, { recursive: true });
    
    const frames = await extractFrames(videoPath, framesDir);
    
    if (frames.length === 0) {
      return { hasSurface: false, confidence: 0 };
    }
    
    const middleFrame = frames[Math.floor(frames.length / 2)];
    const { isVertical } = await getFrameMetadata(middleFrame);
    const analysis = await analyzeFrameForSurfaces(middleFrame, 0, isVertical);
    
    return {
      hasSurface: analysis.hasSurface,
      confidence: analysis.confidence,
    };
    
  } catch {
    return { hasSurface: false, confidence: 0 };
    
  } finally {
    safeRmdir(tempDir);
  }
}

// ============================================================================
// YOUTUBE THUMBNAIL HELPERS
// ============================================================================

export function getYouTubeThumbnailUrl(
  youtubeId: string,
  quality: "default" | "hq" | "mq" | "sd" | "maxres" = "hq"
): string {
  const qualityMap: Record<string, string> = {
    default: "default.jpg",
    mq: "mqdefault.jpg",
    hq: "hqdefault.jpg",
    sd: "sddefault.jpg",
    maxres: "maxresdefault.jpg",
  };
  return `https://i.ytimg.com/vi/${youtubeId}/${qualityMap[quality]}`;
}

export function getYouTubeThumbnailWithFallback(youtubeId: string): string {
  return getYouTubeThumbnailUrl(youtubeId, "hq");
}

// ============================================================================
// MODULE INITIALIZATION
// ============================================================================

console.log(`[Scanner V2] ========== MODULE LOADED ==========`);
console.log(`[Scanner V2] Frame interval: ${CONFIG.FRAME_INTERVAL_SECONDS}s`);
console.log(`[Scanner V2] Max frames: ${CONFIG.MAX_FRAMES_PER_VIDEO}`);
console.log(`[Scanner V2] Min disk space: ${CONFIG.MIN_DISK_SPACE_MB}MB`);
console.log(`[Scanner V2] Confidence threshold: ${CONFIG.SURFACE_CONFIDENCE_THRESHOLD}`);
console.log(`[Scanner V2] LOCAL_ASSET_MAP entries: ${Object.keys(LOCAL_ASSET_MAP).length}`);
console.log(`[Scanner V2] ==========================================`);
