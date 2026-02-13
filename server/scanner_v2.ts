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
  FRAME_MAX_DIMENSION: 1280,
  FRAME_QUALITY: 85,
  
  // Disk safety
  MIN_DISK_SPACE_MB: 100,
  
  // Detection method: 'gemini' or 'edge'
  // Gemini AI provides accurate surface classification and tight bounding boxes
  // Edge detection is a fast fallback but can't distinguish real surfaces from random edges
  DETECTION_METHOD: 'gemini' as 'gemini' | 'edge',
  
  // Detection thresholds (for edge detection)
  EDGE_THRESHOLD: 20,
  HORIZONTAL_LINE_MIN_LENGTH: 0.20,
  SURFACE_CONFIDENCE_THRESHOLD: 0.25, // Require reasonable confidence

  // Fallback detection - only add if Gemini found ZERO surfaces in entire video
  MIN_SURFACES_BEFORE_FALLBACK: 0,
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
  // Lighting & camera data for realistic product placement
  lightingDirection?: string;  // left, right, top, top-left, top-right, ambient
  lightingIntensity?: number;  // 0.0-1.0
  cameraAngle?: string;        // eye-level, slightly-above, top-down, low-angle
}

interface FrameAnalysisResult {
  hasSurface: boolean;
  confidence: number;
  surfaces: DetectedSurface[];
  isVertical: boolean;
  /** True if AI successfully analyzed the frame (even if it found no surfaces) */
  aiAnalyzed?: boolean;
}

// EdgeAnalysisResult removed — replaced by band-based detection in analyzeFrameForSurfaces

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
  lighting_direction?: string;  // left, right, top, top-left, top-right, ambient
  lighting_intensity?: number;  // 0.0-1.0
  camera_angle?: string;        // eye-level, slightly-above, top-down, low-angle
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

const SURFACE_DETECTION_PROMPT = `You are analyzing a video frame to identify the SINGLE most prominent REAL, PHYSICAL flat surface where a product could naturally be placed.

TASK: Find the ONE best flat surface (table, desk, countertop, shelf) visible in the frame where a small product like a beverage bottle, phone, or gadget could physically sit. Return ONLY the single most prominent and clearly visible surface.

CRITICAL RULES — RETURN MAXIMUM 1 SURFACE:
- Only detect REAL physical surfaces that exist in the 3D scene
- Return ONLY the single best surface — the largest, clearest, most prominent flat horizontal surface
- If multiple surfaces exist, pick the ONE that is most suitable for product placement (largest visible area, best lit, most natural for a product)
- The bounding box must tightly wrap ONLY the visible, FLAT, HORIZONTAL surface area
- The surface must occupy at least 5% of the total frame area (width * height) to be valid
- Do NOT flag roads, sidewalks, floors, or ground surfaces
- Do NOT flag walls, ceilings, curtains, or vertical surfaces (unless it's a shelf)
- Do NOT flag bridges, buildings, vehicles, or outdoor structures
- Do NOT flag areas with heavy motion blur or out-of-focus regions
- Do NOT flag surfaces blocked by people's bodies or hands
- Do NOT flag surfaces that are too small to place a product on
- If a person occupies more than 50% of the frame (close-up, medium shot, or bust shot), return surfaces_found: false UNLESS a clear table/desk surface is ALSO prominently visible SEPARATE FROM the person's body
- If the frame is an exterior/outdoor shot with no furniture, return surfaces_found: false
- If the frame is a close-up of a person with no visible surfaces, return surfaces_found: false

ANTI-HALLUCINATION RULES (CRITICAL — READ CAREFULLY):
- You MUST be able to clearly see the physical surface material (wood, glass, metal, stone, etc.)
- The bounding box MUST NOT overlap with any person's body, clothing, arms, hands, or lap
- If a laptop is on someone's lap, that is NOT a desk surface — it is a laptop on a person
- If someone is wearing dark clothing, the dark area is NOT a desk — it is clothing
- A microphone boom arm, monitor arm, or equipment mount is NOT a surface
- Do NOT draw a bounding box that covers a person's chest, torso, or lap area and call it a "desk"
- The surface must be GEOMETRICALLY SEPARATE from any person in the frame — there must be clear visual separation between the person's body and the surface edge
- If you are unsure whether something is a real surface or just a dark/shadowy region near a person, return surfaces_found: false

BOUNDING BOX RULES:
- x, y = top-left corner of the surface as percentage of frame (0-100)
- width, height = size of the surface area as percentage of frame (0-100)
- The box must ONLY cover the visible FLAT HORIZONTAL surface where a product could physically sit
- Do NOT include table legs, chairs, people, or the area BELOW the table in the bounding box
- Do NOT include the area ABOVE the table in the bounding box
- The height of a table/desk bounding box seen at eye level should be THIN (typically 5-20% of frame height), because you are looking at the surface edge-on
- A wide table seen at eye level might be: x:15, y:55, width:70, height:10 (THIN horizontal strip)
- A desk seen from slightly above might be: x:20, y:50, width:40, height:20
- Do NOT make bounding boxes taller than 30% of frame height unless viewed from directly above (top-down)
- The bounding box center (y + height/2) should be in the LOWER portion of the frame (y > 40%) for tables/desks at eye level

GOOD SURFACES (flag the single best one):
- Studio desks in podcast/recording setups — but ONLY if you can see the actual desk surface (the flat top where objects sit), not just equipment or a person sitting
- Desks, tables, countertops with visible flat area and clear surface material visible
- Shelves or ledges with clear space
- Nightstands, side tables, coffee tables
- Kitchen counters with some clear space

PODCAST / INTERVIEW / TALKING-HEAD RULES:
- In podcast or interview setups, people sit behind desks or tables — but the desk may NOT be visible in the frame
- If a single person fills more than 40% of the frame (headshot, medium shot, bust shot, or solo interview angle), return surfaces_found: false — there is NO usable surface
- If two or more people are visible but no clear table/desk surface is visible between them, return surfaces_found: false
- Do NOT invent or hallucinate a "desk" or "table" that is not clearly visible with a defined horizontal edge and flat area
- If you cannot see the actual surface top (the flat plane where a product would sit), do NOT flag it
- A dark area below a person's torso is NOT a desk — it is clothing, lap, shadow, or dark background
- Microphones, monitor stands, and equipment edges are NOT surfaces
- Only flag a desk/table if you can clearly see: (1) the horizontal front edge of the table AND (2) some of the flat top surface behind that edge
- If the desk is behind/below a person but you can only see a tiny sliver of it, return surfaces_found: false — the surface is not prominent enough

BAD "SURFACES" (do NOT flag):
- Roads, highways, pavement
- Building edges, bridge structures
- Sky, trees, outdoor scenery
- Floors (even indoor floors)
- Walls (even if flat)
- Any area where a product would look unnatural
- Dark regions below a person's chest/torso (these are NOT desks)
- Inferred/assumed surfaces that are not clearly visible in the frame
- A person's lap, thighs, or clothing — even if a laptop or object is resting on them
- Equipment surfaces like laptop screens, monitor backs, or camera housings

For the surface found, provide:
- **location**: Tight bounding box as {x, y, width, height} in percentages (0-100)
- **surface_type**: desk, table, shelf, counter, nightstand, coffee_table, studio_desk
- **confidence**: 0.0 to 1.0 — use >0.7 only if the surface is clearly, unambiguously visible. Use 0.4-0.6 if partially visible. Use <0.4 if uncertain (these will be filtered out).
- **reasoning**: Brief explanation of why this is the best surface
- **lighting_direction**: Where the main light source is coming from relative to the surface. One of: "left", "right", "top", "top-left", "top-right", "ambient" (if diffuse/even lighting)
- **lighting_intensity**: 0.0 to 1.0 — how bright the scene is (0.0 = very dark, 0.5 = moderate, 1.0 = very bright/overexposed)
- **camera_angle**: The camera's viewing angle relative to the surface. One of: "eye-level", "slightly-above", "top-down", "low-angle"

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no code fences):
{
  "surfaces_found": true,
  "frame_description": "Brief description of what's in the frame",
  "surfaces": [
    {
      "location": {"x": 20, "y": 55, "width": 30, "height": 20},
      "surface_type": "studio_desk",
      "confidence": 0.85,
      "reasoning": "Clear studio desk surface, well-lit, main placement area in podcast setup",
      "lighting_direction": "top-left",
      "lighting_intensity": 0.7,
      "camera_angle": "slightly-above"
    }
  ],
  "recommended_placement": {
    "location": {"x": 25, "y": 58, "width": 15, "height": 12},
    "reason": "Best spot — clear area on desk near subject"
  }
}

If NO suitable surfaces exist:
{
  "surfaces_found": false,
  "frame_description": "Description of frame",
  "surfaces": [],
  "recommended_placement": null,
  "no_surface_reason": "Why no placement works here"
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
  // Test2.mov - Podcast sample (separate from test_video2.mov)
  'test-podcast-sample': './public/videos/Test2.mov',
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
      "-nostdin",               // Non-interactive mode
      "-y",                     // Overwrite output files
      "-i", absoluteVideoPath,
      "-an",                    // Skip audio (faster, avoids codec issues)
      "-vsync", "vfr",         // Variable frame rate (prevents duplicate frames)
      "-pix_fmt", "yuvj420p",  // Force JPEG-compatible pixel format (fixes HEVC/HDR)
      "-vf", `fps=1/${CONFIG.FRAME_INTERVAL_SECONDS},scale='min(${CONFIG.FRAME_MAX_DIMENSION},iw)':'min(${CONFIG.FRAME_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`,
      "-q:v", "2",
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

/**
 * FullScale Edge V2 — Smart surface detection using Sharp image analysis.
 *
 * Approach:
 * 1. Scan full frame for horizontal edge rows (gradient between above/below pixels)
 * 2. Cluster edge-dense rows into surface bands (groups of adjacent rows with edges)
 * 3. For each band, find horizontal extent by scanning columns for edge density
 * 4. Classify surface type based on vertical position in frame
 * 5. Score confidence based on edge continuity, band thickness, and position
 *
 * This produces tight, accurate bounding boxes around actual flat surfaces.
 */
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

    // Analyze full frame in greyscale
    const buffer = await image.greyscale().raw().toBuffer();

    if (buffer.length !== width * height) {
      console.log(`[Scanner V2] Buffer mismatch: expected ${width * height}, got ${buffer.length}`);
      return defaultResult;
    }

    // Step 1: For each row, compute horizontal edge score
    // A row with a strong horizontal edge has a long consecutive run of vertical gradients
    const rowScores: { edgeCount: number; maxRun: number; runStart: number; runEnd: number }[] = [];

    for (let y = 2; y < height - 2; y++) {
      let edgeCount = 0;
      let currentRun = 0;
      let maxRun = 0;
      let bestRunStart = 0;
      let bestRunEnd = 0;
      let runStart = 0;

      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        // Vertical gradient (Sobel-like: weighted above/below)
        const above = buffer[idx - width] * 0.5 + buffer[idx - 2 * width] * 0.5;
        const below = buffer[idx + width] * 0.5 + buffer[idx + 2 * width] * 0.5;
        const gradient = Math.abs(below - above);

        if (gradient > CONFIG.EDGE_THRESHOLD) {
          if (currentRun === 0) runStart = x;
          currentRun++;
          edgeCount++;
        } else {
          if (currentRun > maxRun) {
            maxRun = currentRun;
            bestRunStart = runStart;
            bestRunEnd = runStart + currentRun;
          }
          currentRun = 0;
        }
      }
      // Check final run
      if (currentRun > maxRun) {
        maxRun = currentRun;
        bestRunStart = runStart;
        bestRunEnd = runStart + currentRun;
      }

      rowScores[y] = { edgeCount, maxRun, runStart: bestRunStart, runEnd: bestRunEnd };
    }

    // Step 2: Find surface bands — clusters of adjacent rows with significant horizontal edges
    const minRunLength = Math.floor(width * CONFIG.HORIZONTAL_LINE_MIN_LENGTH);
    interface SurfaceBand {
      topRow: number;
      bottomRow: number;
      leftCol: number;
      rightCol: number;
      peakEdgeRow: number;
      peakEdgeScore: number;
      avgRunLength: number;
    }

    const bands: SurfaceBand[] = [];
    let currentBand: SurfaceBand | null = null;
    const GAP_TOLERANCE = Math.max(5, Math.floor(height * 0.02)); // Allow small gaps in bands

    for (let y = 2; y < height - 2; y++) {
      const row = rowScores[y];
      if (!row) continue;

      const hasSignificantEdge = row.maxRun >= minRunLength;

      if (hasSignificantEdge) {
        if (!currentBand) {
          currentBand = {
            topRow: y,
            bottomRow: y,
            leftCol: row.runStart,
            rightCol: row.runEnd,
            peakEdgeRow: y,
            peakEdgeScore: row.maxRun,
            avgRunLength: row.maxRun,
          };
        } else {
          currentBand.bottomRow = y;
          currentBand.leftCol = Math.min(currentBand.leftCol, row.runStart);
          currentBand.rightCol = Math.max(currentBand.rightCol, row.runEnd);
          if (row.maxRun > currentBand.peakEdgeScore) {
            currentBand.peakEdgeRow = y;
            currentBand.peakEdgeScore = row.maxRun;
          }
          const bandRows = currentBand.bottomRow - currentBand.topRow + 1;
          currentBand.avgRunLength = (currentBand.avgRunLength * (bandRows - 1) + row.maxRun) / bandRows;
        }
      } else {
        // Gap — close band if gap exceeds tolerance
        if (currentBand && (y - currentBand.bottomRow) > GAP_TOLERANCE) {
          const bandHeight = currentBand.bottomRow - currentBand.topRow;
          if (bandHeight >= 3) { // Min 3 rows to be a surface
            bands.push(currentBand);
          }
          currentBand = null;
        }
      }
    }
    // Close final band
    if (currentBand) {
      const bandHeight = currentBand.bottomRow - currentBand.topRow;
      if (bandHeight >= 3) {
        bands.push(currentBand);
      }
    }

    console.log(`[Scanner V2] Frame ${timestamp}s: found ${bands.length} edge band(s)`);

    // Step 3: Convert bands to surfaces with classification and confidence
    const surfaces: DetectedSurface[] = [];

    for (const band of bands) {
      const centerY = ((band.topRow + band.bottomRow) / 2) / height; // 0-1 normalized
      const bandHeightNorm = (band.bottomRow - band.topRow) / height;
      const bandWidthNorm = (band.rightCol - band.leftCol) / width;
      const runRatio = band.avgRunLength / width;

      // Skip very thin or very narrow bands
      if (bandWidthNorm < 0.15 || bandHeightNorm < 0.01) continue;

      // Skip bands that span almost the entire frame (likely scene boundaries, not surfaces)
      if (bandWidthNorm > 0.95 && bandHeightNorm > 0.5) continue;

      // Confidence scoring
      let confidence = 0;

      // Edge continuity: longer horizontal runs = more likely a flat surface
      confidence += Math.min(0.35, runRatio * 0.5);

      // Band thickness: real surfaces have some vertical depth (not just a single edge line)
      const thicknessScore = Math.min(0.25, bandHeightNorm * 2);
      confidence += thicknessScore;

      // Position bonus: surfaces in the middle 30-75% of frame are most likely tables/desks
      if (centerY >= 0.35 && centerY <= 0.75) {
        confidence += 0.25;
      } else if (centerY >= 0.25 && centerY <= 0.85) {
        confidence += 0.10;
      }

      // Width bonus: wider surfaces more likely real
      if (bandWidthNorm > 0.3) {
        confidence += 0.10;
      }

      confidence = Math.min(0.95, confidence);

      if (confidence < CONFIG.SURFACE_CONFIDENCE_THRESHOLD) continue;

      // Classify based on vertical position
      let surfaceType: string;
      if (centerY < 0.25) {
        surfaceType = "Shelf"; // Top quarter = shelf/high surface
      } else if (centerY < 0.45) {
        surfaceType = "Desk"; // Upper-middle = desk (person sitting behind it)
      } else if (centerY < 0.65) {
        surfaceType = "Table"; // Center = table
      } else if (centerY < 0.80) {
        surfaceType = "Desk"; // Lower-middle = desk (close-up or standing desk)
      } else {
        surfaceType = "Floor"; // Bottom = likely floor edge, skip
        continue; // Don't create surfaces for floor edges
      }

      // Build tight bounding box with some padding
      const padX = Math.min(0.03, bandWidthNorm * 0.1);
      const padY = Math.min(0.02, bandHeightNorm * 0.15);

      // The surface area extends from the edge band downward (the top of a table is the edge,
      // the placeable surface area is on/below it)
      const surfaceTopY = Math.max(0, (band.topRow / height) - padY);
      const surfaceBottomY = Math.min(1, (band.bottomRow / height) + bandHeightNorm * 0.5 + padY);

      const surface: DetectedSurface = {
        surfaceType,
        confidence,
        boundingBox: {
          x: Math.max(0, (band.leftCol / width) - padX),
          y: surfaceTopY,
          width: Math.min(1, bandWidthNorm + padX * 2),
          height: Math.min(1 - surfaceTopY, surfaceBottomY - surfaceTopY),
        },
        timestamp,
      };

      console.log(`[Scanner V2] Band → ${surfaceType} at y=${(centerY * 100).toFixed(0)}% (${(confidence * 100).toFixed(0)}% confidence, width=${(bandWidthNorm * 100).toFixed(0)}%, height=${(bandHeightNorm * 100).toFixed(0)}%)`);

      surfaces.push(surface);
    }

    // Deduplicate overlapping surfaces (keep higher confidence one)
    const dedupedSurfaces = deduplicateSurfaces(surfaces);

    if (dedupedSurfaces.length > 0) {
      const maxConfidence = Math.max(...dedupedSurfaces.map(s => s.confidence));
      return {
        hasSurface: true,
        confidence: maxConfidence,
        surfaces: dedupedSurfaces,
        isVertical,
      };
    }

    return defaultResult;

  } catch (err) {
    console.error(`[Scanner V2] Frame analysis error:`, err);
    return defaultResult;
  }
}

/**
 * Remove overlapping surface detections, keeping the higher-confidence one.
 * Two surfaces overlap if their vertical centers are within 10% of frame height.
 */
function deduplicateSurfaces(surfaces: DetectedSurface[]): DetectedSurface[] {
  if (surfaces.length <= 1) return surfaces;

  // Sort by confidence descending
  const sorted = [...surfaces].sort((a, b) => b.confidence - a.confidence);
  const kept: DetectedSurface[] = [];

  for (const surface of sorted) {
    const centerY = surface.boundingBox.y + surface.boundingBox.height / 2;
    const overlaps = kept.some(k => {
      const kCenterY = k.boundingBox.y + k.boundingBox.height / 2;
      return Math.abs(centerY - kCenterY) < 0.10;
    });
    if (!overlaps) {
      kept.push(surface);
    }
  }

  return kept;
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
      // Gemini analyzed successfully but found no surfaces — don't fall back to edge
      return { ...defaultResult, aiAnalyzed: true };
    }

    // Map Gemini surfaces, filter low-confidence, validate against ghost patterns
    // We want exactly 1 prominent surface per frame to avoid ghost/duplicate detections
    const allSurfaces: DetectedSurface[] = parsed.surfaces
      .filter((s: GeminiDetectedSurface) => s.confidence >= 0.6) // Higher threshold: only high-quality detections
      .filter((s: GeminiDetectedSurface) => {
        // GHOST SURFACE FILTER — reject bounding boxes that likely overlap a person's body
        const bbX = s.location.x / 100;
        const bbY = s.location.y / 100;
        const bbW = s.location.width / 100;
        const bbH = s.location.height / 100;
        const centerX = bbX + bbW / 2;
        const centerY = bbY + bbH / 2;
        const area = bbW * bbH;

        // Ghost pattern 1: Bounding box centered on person's torso area
        // In podcast setups, person typically occupies frame center (x: 25-75%, y: 15-60%)
        // A real desk/table surface should be BELOW the person (y > 55%) or to the SIDE
        const isInPersonZone = centerX > 0.20 && centerX < 0.80 && centerY > 0.15 && centerY < 0.55;
        const isSmallArea = area < 0.10; // Small surfaces in person zone are very suspect
        if (isInPersonZone && isSmallArea) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — bbox center (${(centerX*100).toFixed(0)}%, ${(centerY*100).toFixed(0)}%) is in person zone with small area ${(area*100).toFixed(1)}%`);
          return false;
        }

        // Ghost pattern 2: Tall bounding box overlapping person center
        // Real desk surfaces seen at eye level should be thin (height < 25%)
        // A bbox that is both tall AND centered on person area is likely on the person
        if (bbH > 0.25 && centerY < 0.55 && centerX > 0.25 && centerX < 0.75) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — tall bbox (h=${(bbH*100).toFixed(0)}%) centered on person area`);
          return false;
        }

        // Ghost pattern 3: Surface entirely in the upper half of frame
        // Real tables/desks are almost always in the lower portion (y > 40%)
        // unless it's a shelf (which is fine)
        const isShelf = s.surface_type.toLowerCase().includes('shelf');
        if (!isShelf && bbY + bbH < 0.40) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — bbox entirely in upper frame (bottom edge at ${((bbY+bbH)*100).toFixed(0)}%)`);
          return false;
        }

        return true;
      })
      .map((s: GeminiDetectedSurface) => ({
        surfaceType: s.surface_type.charAt(0).toUpperCase() + s.surface_type.slice(1),
        confidence: s.confidence,
        boundingBox: {
          x: s.location.x / 100,
          y: s.location.y / 100,
          width: s.location.width / 100,
          height: s.location.height / 100,
        },
        timestamp,
        // Lighting & camera data for realistic product placement
        lightingDirection: s.lighting_direction || undefined,
        lightingIntensity: typeof s.lighting_intensity === 'number' ? s.lighting_intensity : undefined,
        cameraAngle: s.camera_angle || undefined,
      }))
      .sort((a: DetectedSurface, b: DetectedSurface) => b.confidence - a.confidence)
      .slice(0, 1); // Max 1 surface per frame — only the single most prominent surface

    if (allSurfaces.length === 0) {
      return { ...defaultResult, aiAnalyzed: true };
    }

    const maxConfidence = Math.max(...allSurfaces.map(s => s.confidence));

    return {
      hasSurface: true,
      confidence: maxConfidence,
      surfaces: allSurfaces,
      isVertical,
      aiAnalyzed: true,
    };
    
  } catch (err) {
    console.error(`[Gemini] Frame analysis error:`, err);
    return defaultResult;
  }
}

// ============================================================================
// SCENE CONTEXT ANALYSIS — FullScale Edge (Sharp-based, no external AI)
// ============================================================================

interface SceneContextResult {
  sceneSetting: string;
  refinedSurfaceType: string;
  surroundings: string[];
  mood: string;
  culturalContext: string;
  brandCategories: string[];
}

/**
 * Analyzes a video frame using Sharp image statistics to infer scene context.
 * Uses brightness zones, color channel distribution, edge density patterns,
 * and aspect ratio to classify the scene — no external AI API required.
 */
async function analyzeSceneContext(
  framePath: string,
  currentSurfaceType: string,
  isVertical: boolean,
): Promise<SceneContextResult | null> {
  try {
    const image = sharp(framePath);
    const metadata = await image.metadata();
    const width = metadata.width || 1280;
    const height = metadata.height || 720;

    // Get image statistics (channel means, dominant colors)
    const stats = await image.stats();
    const rMean = stats.channels[0]?.mean || 0;
    const gMean = stats.channels[1]?.mean || 0;
    const bMean = stats.channels[2]?.mean || 0;
    const overallBrightness = (rMean + gMean + bMean) / 3;

    // Analyze top third vs bottom third brightness (helps detect studio lighting)
    const topThird = await sharp(framePath)
      .extract({ left: 0, top: 0, width, height: Math.floor(height / 3) })
      .stats();
    const bottomThird = await sharp(framePath)
      .extract({ left: 0, top: Math.floor(height * 2 / 3), width, height: Math.floor(height / 3) })
      .stats();

    const topBrightness = ((topThird.channels[0]?.mean || 0) + (topThird.channels[1]?.mean || 0) + (topThird.channels[2]?.mean || 0)) / 3;
    const bottomBrightness = ((bottomThird.channels[0]?.mean || 0) + (bottomThird.channels[1]?.mean || 0) + (bottomThird.channels[2]?.mean || 0)) / 3;

    // Analyze edge density in the surface region (bottom half)
    const bottomHalf = await sharp(framePath)
      .extract({ left: 0, top: Math.floor(height / 2), width, height: Math.floor(height / 2) })
      .greyscale()
      .raw()
      .toBuffer();

    let edgeCount = 0;
    const bw = width;
    const bh = Math.floor(height / 2);
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const idx = y * bw + x;
        const gradient = Math.abs(bottomHalf[idx + bw] - bottomHalf[idx - bw]);
        if (gradient > 15) edgeCount++;
      }
    }
    const edgeDensity = edgeCount / ((bw - 2) * (bh - 2));

    // Color warmth analysis (warm = reddish/orange, cool = bluish)
    const warmth = rMean - bMean; // positive = warm, negative = cool

    // Classify scene based on heuristics
    const sceneSetting = classifyScene(overallBrightness, topBrightness, bottomBrightness, edgeDensity, warmth, isVertical);
    const refinedSurfaceType = refineSurfaceType(currentSurfaceType, sceneSetting, edgeDensity, overallBrightness);
    const surroundings = inferSurroundings(sceneSetting, edgeDensity, overallBrightness, warmth);
    const mood = inferMood(overallBrightness, warmth, edgeDensity);
    const brandCategories = suggestBrands(sceneSetting, mood);

    console.log(`[FullScale Edge Context] Setting: ${sceneSetting}`);
    console.log(`[FullScale Edge Context] Refined type: ${refinedSurfaceType} (was: ${currentSurfaceType})`);
    console.log(`[FullScale Edge Context] Brightness: ${overallBrightness.toFixed(0)}, Warmth: ${warmth.toFixed(0)}, Edge density: ${(edgeDensity * 100).toFixed(1)}%`);

    return {
      sceneSetting,
      refinedSurfaceType,
      surroundings,
      mood,
      culturalContext: "General", // Sharp can't determine cultural markers — needs future training data
      brandCategories,
    };
  } catch (err) {
    console.error("[FullScale Edge Context] Analysis failed:", err);
    return null;
  }
}

function classifyScene(
  brightness: number, topBright: number, bottomBright: number,
  edgeDensity: number, warmth: number, isVertical: boolean,
): string {
  const lightingContrast = Math.abs(topBright - bottomBright);

  // Studio/podcast: controlled lighting (low contrast), darker background, bright subject area
  if (lightingContrast > 30 && topBright < bottomBright && brightness > 80) {
    return "Podcast/Recording Studio";
  }
  if (lightingContrast > 30 && topBright < 100 && bottomBright > 120) {
    return "Studio Setup";
  }

  // Office/workspace: moderate brightness, high edge density (lots of objects/edges)
  if (edgeDensity > 0.15 && brightness > 100 && brightness < 200) {
    return warmth > 10 ? "Warm Office/Workspace" : "Modern Office/Workspace";
  }

  // Kitchen: typically warm, moderate brightness, high edge density
  if (warmth > 20 && edgeDensity > 0.12 && brightness > 120) {
    return "Kitchen/Dining Area";
  }

  // Outdoor: very bright, high brightness variance
  if (brightness > 170) {
    return "Outdoor/Bright Setting";
  }

  // Dark/moody setting: low overall brightness
  if (brightness < 60) {
    return "Dark/Moody Setting";
  }

  // Living space: moderate everything
  if (brightness > 90 && brightness < 160 && warmth > 0) {
    return "Living Space";
  }

  // Vertical video often = mobile/casual content
  if (isVertical) {
    return "Mobile/Casual Setting";
  }

  return "Indoor Setting";
}

function refineSurfaceType(
  currentType: string, sceneSetting: string,
  edgeDensity: number, brightness: number,
): string {
  // Keep specific types from edge detection (Table, Shelf, etc.)
  // Only refine generic types
  if (currentType !== "Desk" && currentType !== "Table" && currentType !== "Potential Surface") {
    return currentType;
  }

  const setting = sceneSetting.toLowerCase();

  if (currentType === "Desk" || currentType === "Table") {
    // Add scene context to the type
    if (setting.includes("podcast") || setting.includes("studio") || setting.includes("recording")) {
      return "Studio Desk";
    }
    if (setting.includes("kitchen") || setting.includes("dining")) {
      return "Counter";
    }
    if (setting.includes("office") || setting.includes("workspace")) {
      return edgeDensity > 0.2 ? "Work Desk" : "Clean Desk";
    }
    if (setting.includes("outdoor")) {
      return currentType === "Table" ? "Outdoor Table" : "Outdoor Desk";
    }
    if (setting.includes("living")) {
      return currentType === "Table" ? "Coffee Table" : "Side Table";
    }
    return currentType; // Keep as-is if no scene match
  }

  // Potential Surface — make more specific
  if (currentType === "Potential Surface") {
    if (setting.includes("podcast") || setting.includes("studio")) return "Studio Surface";
    if (setting.includes("office")) return "Desk Area";
    return "Surface";
  }

  return currentType;
}

function inferSurroundings(
  sceneSetting: string, edgeDensity: number,
  brightness: number, warmth: number,
): string[] {
  const items: string[] = [];
  const setting = sceneSetting.toLowerCase();

  if (setting.includes("podcast") || setting.includes("studio")) {
    items.push("Microphone", "Monitor", "Camera");
    if (edgeDensity > 0.15) items.push("Cables", "Audio equipment");
  }
  if (setting.includes("office") || setting.includes("workspace")) {
    items.push("Computer", "Chair");
    if (edgeDensity > 0.2) items.push("Books", "Papers", "Stationery");
    if (brightness > 140) items.push("Desk lamp", "Window");
  }
  if (setting.includes("kitchen") || setting.includes("dining")) {
    items.push("Countertop", "Appliances");
    if (warmth > 20) items.push("Warm lighting", "Food items");
  }
  if (setting.includes("outdoor")) {
    items.push("Natural light", "Plants");
  }
  if (setting.includes("living")) {
    items.push("Sofa", "Decor");
    if (warmth > 15) items.push("Warm lighting", "Textiles");
  }

  // Generic items based on edge density
  if (edgeDensity > 0.18 && items.length < 3) items.push("Multiple objects");
  if (brightness > 150 && !items.includes("Window")) items.push("Well-lit");
  if (warmth > 25 && !items.includes("Warm lighting")) items.push("Warm ambiance");

  return items.slice(0, 8);
}

function inferMood(brightness: number, warmth: number, edgeDensity: number): string {
  if (brightness > 160 && warmth > 15) return "Energetic";
  if (brightness > 130 && edgeDensity < 0.1) return "Calm";
  if (brightness > 100 && warmth < -5) return "Professional";
  if (brightness < 80) return "Intimate";
  if (edgeDensity > 0.2) return "Creative";
  if (warmth > 10) return "Casual";
  return "Neutral";
}

function suggestBrands(sceneSetting: string, mood: string): string[] {
  const setting = sceneSetting.toLowerCase();
  const brands: string[] = [];

  if (setting.includes("podcast") || setting.includes("studio")) {
    brands.push("Audio equipment", "Tech accessories", "Beverages", "Software");
  } else if (setting.includes("kitchen") || setting.includes("dining")) {
    brands.push("Food & beverage", "Kitchen appliances", "Health & wellness");
  } else if (setting.includes("office") || setting.includes("workspace")) {
    brands.push("Tech products", "Office supplies", "Productivity software", "Coffee/beverages");
  } else if (setting.includes("outdoor")) {
    brands.push("Outdoor gear", "Fitness", "Suncare", "Beverages");
  } else if (setting.includes("living")) {
    brands.push("Home decor", "Lifestyle", "Streaming services", "Beverages");
  } else {
    brands.push("Lifestyle", "Consumer electronics", "Beverages");
  }

  // Mood-based additions
  if (mood === "Professional") brands.push("Business services");
  if (mood === "Creative") brands.push("Creative tools", "Art supplies");
  if (mood === "Energetic") brands.push("Energy drinks", "Sports brands");

  return [...new Set(brands)].slice(0, 5);
}

/**
 * Runs FullScale Edge scene context analysis on detected surfaces after the main scan.
 * Picks unique frames (one per timestamp) to minimize processing.
 * Updates surface records with refined types, scene context, and surroundings.
 * Uses Sharp image statistics only — no external AI API.
 */
async function enrichSurfacesWithContext(
  videoId: number,
  permanentFramesDir: string,
): Promise<void> {
  console.log(`[FullScale Edge Context] Starting post-scan enrichment for video ${videoId}`);

  const surfaces = await storage.getDetectedSurfaces(videoId);
  if (surfaces.length === 0) {
    console.log("[FullScale Edge Context] No surfaces to enrich");
    return;
  }

  // Group surfaces by timestamp — only analyze one frame per unique timestamp
  const timestampMap = new Map<number, typeof surfaces>();
  for (const surface of surfaces) {
    const ts = Math.floor(Number(surface.timestamp));
    if (!timestampMap.has(ts)) {
      timestampMap.set(ts, []);
    }
    timestampMap.get(ts)!.push(surface);
  }

  console.log(`[FullScale Edge Context] ${surfaces.length} surfaces across ${timestampMap.size} unique timestamps`);

  let enrichedCount = 0;

  for (const [timestamp, surfacesAtTime] of timestampMap) {
    const frameFilename = `frame_${timestamp}s.jpg`;
    const framePath = path.join(permanentFramesDir, frameFilename);

    if (!fs.existsSync(framePath)) {
      console.log(`[FullScale Edge Context] Frame not found: ${frameFilename}, skipping`);
      continue;
    }

    // Detect if frame is vertical
    const frameMeta = await sharp(framePath).metadata();
    const isVertical = (frameMeta.height || 720) > (frameMeta.width || 1280);

    // Use the highest-confidence surface type as input
    const bestSurface = surfacesAtTime.reduce((a, b) =>
      parseFloat(String(a.confidence)) > parseFloat(String(b.confidence)) ? a : b
    );

    const result = await analyzeSceneContext(framePath, bestSurface.surfaceType, isVertical);
    if (!result) continue;

    // Update ALL surfaces at this timestamp with the context
    for (const surface of surfacesAtTime) {
      try {
        await storage.updateDetectedSurface(surface.id, {
          surfaceType: result.refinedSurfaceType,
          sceneContext: `${result.sceneSetting} | ${result.mood} | Brands: ${result.brandCategories.slice(0, 3).join(", ")}`,
          surroundings: result.surroundings.slice(0, 10),
        });
        enrichedCount++;
      } catch (err) {
        console.error(`[FullScale Edge Context] Failed to update surface ${surface.id}:`, err);
      }
    }
  }

  console.log(`[FullScale Edge Context] Enriched ${enrichedCount}/${surfaces.length} surfaces`);
}

// ============================================================================
// POST-SCAN NORMALIZATION — Cluster & Normalize Bounding Boxes
// ============================================================================
//
// Problem: Gemini analyzes each frame independently, so the "same" table gets
// wildly different bounding boxes at different timestamps. This causes:
// 1. Products to appear at different positions per frame
// 2. Scene group matching to fail (different bbX/bbY = different group)
//
// Solution: After scanning all frames, cluster surfaces that represent the same
// physical surface (same type + approximate position), then force all surfaces
// in a cluster to share the MEDIAN bounding box. This ensures consistent
// product placement across frames of the same camera angle.

interface SurfaceCluster {
  surfaces: { id: number; bbX: number; bbY: number; bbW: number; bbH: number; confidence: number }[];
  surfaceType: string;
}

/**
 * Cluster surfaces by type and spatial proximity.
 * Two surfaces join the same cluster if:
 * - Same surfaceType (case-insensitive)
 * - Bounding box centers are within CLUSTER_TOLERANCE of each other (normalized 0-1)
 */
function clusterSurfaces(
  surfaces: Array<{ id: number; surfaceType: string; boundingBoxX: string; boundingBoxY: string; boundingBoxWidth: string; boundingBoxHeight: string; confidence: string }>,
): SurfaceCluster[] {
  const CLUSTER_TOLERANCE = 0.20; // 20% of frame = same surface

  const clusters: SurfaceCluster[] = [];

  for (const s of surfaces) {
    const bbX = parseFloat(s.boundingBoxX);
    const bbY = parseFloat(s.boundingBoxY);
    const bbW = parseFloat(s.boundingBoxWidth);
    const bbH = parseFloat(s.boundingBoxHeight);
    const centerX = bbX + bbW / 2;
    const centerY = bbY + bbH / 2;
    const type = s.surfaceType.toLowerCase();

    let matched = false;
    for (const cluster of clusters) {
      if (cluster.surfaceType.toLowerCase() !== type) continue;

      // Check if this surface's center is near any existing surface in the cluster
      const representative = cluster.surfaces[0];
      const repCX = representative.bbX + representative.bbW / 2;
      const repCY = representative.bbY + representative.bbH / 2;

      if (Math.abs(centerX - repCX) < CLUSTER_TOLERANCE && Math.abs(centerY - repCY) < CLUSTER_TOLERANCE) {
        cluster.surfaces.push({ id: s.id, bbX, bbY, bbW, bbH, confidence: parseFloat(s.confidence) });
        matched = true;
        break;
      }
    }

    if (!matched) {
      clusters.push({
        surfaceType: s.surfaceType,
        surfaces: [{ id: s.id, bbX, bbY, bbW, bbH, confidence: parseFloat(s.confidence) }],
      });
    }
  }

  return clusters;
}

/**
 * Compute the median bounding box for a cluster.
 * Uses the median of each dimension independently for robustness against outliers.
 */
function computeMedianBBox(surfaces: SurfaceCluster['surfaces']): { x: number; y: number; w: number; h: number } {
  const median = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  return {
    x: median(surfaces.map(s => s.bbX)),
    y: median(surfaces.map(s => s.bbY)),
    w: median(surfaces.map(s => s.bbW)),
    h: median(surfaces.map(s => s.bbH)),
  };
}

/**
 * Post-scan normalization pipeline.
 * Groups all detected surfaces by spatial similarity, computes a single
 * consistent bounding box per group, and updates all surfaces to use it.
 * Also filters out phantom surfaces that are too small (<5% frame area).
 */
async function normalizeSurfaceBoundingBoxes(videoId: number): Promise<void> {
  console.log(`[Normalize] Starting bounding box normalization for video ${videoId}`);

  const surfaces = await storage.getDetectedSurfaces(videoId);
  if (surfaces.length < 2) {
    console.log(`[Normalize] Only ${surfaces.length} surface(s), nothing to normalize`);
    return;
  }

  // Step 1: Filter out phantom and invalid surfaces
  const MIN_SURFACE_AREA = 0.03; // 3% of frame area minimum
  const MAX_SURFACE_HEIGHT = 0.40; // Surface seen at eye level shouldn't be >40% of frame height
  const phantomIds: number[] = [];
  for (const s of surfaces) {
    const width = parseFloat(String(s.boundingBoxWidth));
    const height = parseFloat(String(s.boundingBoxHeight));
    const area = width * height;

    if (area < MIN_SURFACE_AREA) {
      phantomIds.push(s.id);
      console.log(`[Normalize] Removing phantom surface ${s.id} (${s.surfaceType}, area=${(area * 100).toFixed(1)}% < ${(MIN_SURFACE_AREA * 100)}%)`);
    } else if (height > MAX_SURFACE_HEIGHT && s.surfaceType !== "Filtered") {
      // Bounding box is unrealistically tall — likely includes legs/floor/people
      phantomIds.push(s.id);
      console.log(`[Normalize] Removing oversized surface ${s.id} (${s.surfaceType}, height=${(height * 100).toFixed(1)}% > ${(MAX_SURFACE_HEIGHT * 100)}%)`);
    }
  }

  // Delete phantom surfaces
  for (const id of phantomIds) {
    try {
      await storage.updateDetectedSurface(id, { surfaceType: "Filtered", sceneContext: "Removed: surface too small" });
    } catch (err) {
      console.warn(`[Normalize] Failed to filter surface ${id}:`, err);
    }
  }

  // Step 2: Cluster remaining valid surfaces
  const validSurfaces = surfaces.filter(s => !phantomIds.includes(s.id));
  const clusters = clusterSurfaces(validSurfaces as any);

  console.log(`[Normalize] Found ${clusters.length} cluster(s) from ${validSurfaces.length} surfaces`);

  // Step 3: For each cluster with 2+ surfaces, compute median bbox and update all
  let normalizedCount = 0;
  for (const cluster of clusters) {
    if (cluster.surfaces.length < 2) continue;

    const medianBox = computeMedianBBox(cluster.surfaces);
    console.log(`[Normalize] Cluster "${cluster.surfaceType}" (${cluster.surfaces.length} surfaces) → median bbox: x=${(medianBox.x * 100).toFixed(1)}%, y=${(medianBox.y * 100).toFixed(1)}%, w=${(medianBox.w * 100).toFixed(1)}%, h=${(medianBox.h * 100).toFixed(1)}%`);

    for (const surface of cluster.surfaces) {
      try {
        await storage.updateDetectedSurface(surface.id, {
          boundingBoxX: medianBox.x.toFixed(6),
          boundingBoxY: medianBox.y.toFixed(6),
          boundingBoxWidth: medianBox.w.toFixed(6),
          boundingBoxHeight: medianBox.h.toFixed(6),
        });
        normalizedCount++;
      } catch (err) {
        console.warn(`[Normalize] Failed to update surface ${surface.id}:`, err);
      }
    }
  }

  console.log(`[Normalize] Normalized ${normalizedCount} surfaces across ${clusters.length} cluster(s)`);
}

// ============================================================================
// TEMPORAL SURFACE GROUPING
// ============================================================================

/**
 * Groups surfaces across frames into temporal tracks based on surface type
 * and bounding box similarity. This identifies when a surface "starts" and
 * "ends" in the video. Keeps only the single best track (longest duration,
 * highest confidence) and marks the rest as Filtered.
 *
 * This prevents ghost/duplicate surfaces and ensures we show 1 prominent
 * surface with clear start/end timestamps.
 */
async function groupSurfacesTemporally(videoId: number): Promise<void> {
  console.log(`[Temporal] Starting temporal grouping for video ${videoId}`);

  const surfaces = await storage.getDetectedSurfaces(videoId);
  const validSurfaces = surfaces.filter(s => s.surfaceType !== "Filtered" && s.surfaceType !== "Potential Surface");

  if (validSurfaces.length < 2) {
    console.log(`[Temporal] Only ${validSurfaces.length} valid surface(s), skipping temporal grouping`);
    return;
  }

  // Sort by timestamp
  const sorted = [...validSurfaces].sort((a, b) => parseFloat(String(a.timestamp)) - parseFloat(String(b.timestamp)));

  // Build tracks: consecutive frames with same surface type and overlapping bounding boxes
  interface SurfaceTrack {
    surfaceType: string;
    surfaces: typeof sorted;
    startTime: number;
    endTime: number;
    avgConfidence: number;
  }

  const tracks: SurfaceTrack[] = [];
  let currentTrack: typeof sorted = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const prevTs = parseFloat(String(prev.timestamp));
    const currTs = parseFloat(String(curr.timestamp));
    const timeDiff = currTs - prevTs;

    // Check if surfaces are consecutive (within 1.5x frame interval) and same type
    const isSameType = curr.surfaceType.toLowerCase() === prev.surfaceType.toLowerCase();
    const isConsecutive = timeDiff <= CONFIG.FRAME_INTERVAL_SECONDS * 1.5;

    // Check bounding box overlap (center Y within 15% tolerance)
    const prevCenterY = parseFloat(String(prev.boundingBoxY)) + parseFloat(String(prev.boundingBoxHeight)) / 2;
    const currCenterY = parseFloat(String(curr.boundingBoxY)) + parseFloat(String(curr.boundingBoxHeight)) / 2;
    const isSimilarPosition = Math.abs(prevCenterY - currCenterY) < 0.15;

    if (isConsecutive && (isSameType || isSimilarPosition)) {
      currentTrack.push(curr);
    } else {
      // Close current track and start a new one
      const timestamps = currentTrack.map(s => parseFloat(String(s.timestamp)));
      tracks.push({
        surfaceType: currentTrack[0].surfaceType,
        surfaces: [...currentTrack],
        startTime: Math.min(...timestamps),
        endTime: Math.max(...timestamps),
        avgConfidence: currentTrack.reduce((sum, s) => sum + parseFloat(String(s.confidence)), 0) / currentTrack.length,
      });
      currentTrack = [curr];
    }
  }

  // Close the last track
  const timestamps = currentTrack.map(s => parseFloat(String(s.timestamp)));
  tracks.push({
    surfaceType: currentTrack[0].surfaceType,
    surfaces: [...currentTrack],
    startTime: Math.min(...timestamps),
    endTime: Math.max(...timestamps),
    avgConfidence: currentTrack.reduce((sum, s) => sum + parseFloat(String(s.confidence)), 0) / currentTrack.length,
  });

  console.log(`[Temporal] Found ${tracks.length} surface track(s):`);
  for (const track of tracks) {
    const duration = track.endTime - track.startTime + CONFIG.FRAME_INTERVAL_SECONDS;
    console.log(`[Temporal]   ${track.surfaceType}: ${track.startTime}s - ${track.endTime}s (${duration}s, ${track.surfaces.length} frames, ${(track.avgConfidence * 100).toFixed(0)}% avg confidence)`);
  }

  if (tracks.length <= 1) {
    console.log(`[Temporal] Only 1 track, no filtering needed`);
    // Store temporal range in scene_context for the surfaces in this track
    if (tracks.length === 1) {
      const track = tracks[0];
      const duration = track.endTime - track.startTime + CONFIG.FRAME_INTERVAL_SECONDS;
      const contextNote = `Visible: ${track.startTime}s - ${track.endTime + CONFIG.FRAME_INTERVAL_SECONDS}s (${duration}s)`;
      for (const s of track.surfaces) {
        try {
          await storage.updateDetectedSurface(s.id, { sceneContext: contextNote });
        } catch (err) { /* non-fatal */ }
      }
    }
    return;
  }

  // Score tracks: prefer longer duration and higher confidence
  const scoredTracks = tracks.map(track => {
    const duration = track.endTime - track.startTime + CONFIG.FRAME_INTERVAL_SECONDS;
    // Score = duration (in seconds) * average confidence
    const score = duration * track.avgConfidence;
    return { ...track, score, duration };
  }).sort((a, b) => b.score - a.score);

  // Keep only the best track
  const bestTrack = scoredTracks[0];
  const bestDuration = bestTrack.duration;
  console.log(`[Temporal] Best track: ${bestTrack.surfaceType} (${bestTrack.startTime}s - ${bestTrack.endTime}s, ${bestDuration}s, score=${bestTrack.score.toFixed(2)})`);

  // Store temporal range in the best track's surfaces
  const contextNote = `Visible: ${bestTrack.startTime}s - ${bestTrack.endTime + CONFIG.FRAME_INTERVAL_SECONDS}s (${bestDuration}s)`;
  for (const s of bestTrack.surfaces) {
    try {
      await storage.updateDetectedSurface(s.id, { sceneContext: contextNote });
    } catch (err) { /* non-fatal */ }
  }

  // Filter out surfaces from non-best tracks
  for (let i = 1; i < scoredTracks.length; i++) {
    const track = scoredTracks[i];
    console.log(`[Temporal] Filtering out track: ${track.surfaceType} (${track.startTime}s - ${track.endTime}s, score=${track.score.toFixed(2)})`);
    for (const s of track.surfaces) {
      try {
        await storage.updateDetectedSurface(s.id, {
          surfaceType: "Filtered",
          sceneContext: `Removed: lower-priority track (${track.surfaceType}, ${track.duration}s) — best track is ${bestTrack.surfaceType} (${bestDuration}s)`,
        });
      } catch (err) {
        console.warn(`[Temporal] Failed to filter surface ${s.id}:`, err);
      }
    }
  }

  console.log(`[Temporal] Kept ${bestTrack.surfaces.length} surfaces, filtered ${validSurfaces.length - bestTrack.surfaces.length} from weaker tracks`);
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
    
    // Clear old frames from permanent directory before re-extracting
    try {
      const existingFrames = fs.readdirSync(permanentFramesDir).filter(f => f.endsWith('.jpg'));
      for (const f of existingFrames) {
        safeUnlink(path.join(permanentFramesDir, f));
      }
      console.log(`[Scanner V2] Cleared ${existingFrames.length} old frames from permanent directory`);
    } catch (clearErr) {
      console.warn(`[Scanner V2] Could not clear old frames:`, clearErr);
    }

    // PROCESS FRAMES ONE BY ONE (with immediate cleanup)
    let totalSurfaces = 0;
    console.log(`[Scanner V2] Detection method: ${CONFIG.DETECTION_METHOD.toUpperCase()}`);

    for (let i = 0; i < frames.length; i++) {
      const framePath = frames[i];
      const timestamp = i * CONFIG.FRAME_INTERVAL_SECONDS;

      try {
        console.log(`[Scanner V2] Processing frame ${i + 1}/${frames.length} (${timestamp}s)...`);

        // Save ALL valid frames to permanent directory for thumbnail strip
        const frameFilename = `frame_${timestamp}s.jpg`;
        const permanentPath = path.join(permanentFramesDir, frameFilename);

        try {
          const frameSize = fs.statSync(framePath).size;
          if (frameSize > 5000) { // Skip corrupt/blank frames under 5KB
            fs.copyFileSync(framePath, permanentPath);
          } else {
            console.warn(`[Scanner V2] Skipping tiny frame ${frameFilename} (${frameSize} bytes)`);
          }
        } catch (copyErr) {
          console.error(`[Scanner V2] Failed to save frame:`, copyErr);
        }

        // Use Gemini AI or edge detection based on config
        // Falls back to edge detection if Gemini API key is missing
        const useGemini = CONFIG.DETECTION_METHOD === 'gemini'
          && process.env.AI_INTEGRATIONS_GEMINI_API_KEY
          && process.env.AI_INTEGRATIONS_GEMINI_API_KEY !== 'dummy-key';

        let analysis: FrameAnalysisResult;
        if (useGemini) {
          analysis = await analyzeFrameWithGemini(framePath, timestamp, isVertical);
          // Only fall back to edge if Gemini API actually failed (not if it found no surfaces)
          // If aiAnalyzed=true, Gemini worked fine — it just said "no surfaces here"
          if (!analysis.aiAnalyzed && !analysis.hasSurface) {
            console.log(`[Scanner V2] Gemini API failed for frame ${timestamp}s, trying edge detection fallback...`);
            analysis = await analyzeFrameForSurfaces(framePath, timestamp, isVertical);
          }
        } else {
          if (i === 0) console.log(`[Scanner V2] Gemini API key not configured, using edge detection fallback`);
          analysis = await analyzeFrameForSurfaces(framePath, timestamp, isVertical);
        }

        if (analysis.hasSurface && analysis.surfaces.length > 0) {
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
              // Lighting & camera data from Gemini AI
              lightingDirection: surface.lightingDirection || null,
              lightingIntensity: surface.lightingIntensity != null ? surface.lightingIntensity.toString() : null,
              cameraAngle: surface.cameraAngle || null,
            };

            const inserted = await storage.insertDetectedSurface(dbSurface);
            console.log(`[Scanner V2] *** SURFACE FOUND: ${surface.surfaceType} at ${timestamp}s (confidence: ${(surface.confidence * 100).toFixed(1)}%, id: ${inserted.id}) ***`);
            totalSurfaces++;
          }
        }

      } finally {
        // CRITICAL: Always delete the temp frame after processing
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
          // Only add fallback surface if the frame file actually exists on disk
          const fallbackFrameFilename = `frame_${timestamp}s.jpg`;
          const fallbackFramePath = path.join(permanentFramesDir, fallbackFrameFilename);
          const fallbackFrameExists = fs.existsSync(fallbackFramePath);

          const dbSurface = {
            videoId,
            timestamp: String(timestamp),
            surfaceType: "Potential Surface",
            confidence: String(CONFIG.FALLBACK_CONFIDENCE),
            boundingBoxX: "0.05",
            boundingBoxY: "0.6", // Bottom 40%
            boundingBoxWidth: "0.9",
            boundingBoxHeight: "0.35",
            frameUrl: fallbackFrameExists ? `/uploads/frames/${videoId}/${fallbackFrameFilename}` : null,
            surroundings: null,
            sceneContext: "Fallback detection - potential placement area",
          };

          await storage.insertDetectedSurface(dbSurface);
          console.log(`[Scanner V2] *** FALLBACK SURFACE at ${timestamp}s (confidence: ${(CONFIG.FALLBACK_CONFIDENCE * 100).toFixed(1)}%, frameExists: ${fallbackFrameExists}) ***`);
          totalSurfaces++;
        }
      }
    }
    
    // POST-SCAN NORMALIZATION — Cluster similar surfaces and normalize bounding boxes
    // This ensures consistent product placement across frames of the same camera angle
    try {
      await normalizeSurfaceBoundingBoxes(videoId);
    } catch (normErr) {
      console.error(`[Scanner V2] Bounding box normalization failed (non-fatal):`, normErr);
    }

    // TEMPORAL SURFACE GROUPING — Group consecutive surfaces into tracks
    // Keep only the best track (longest duration, highest confidence) and mark others as Filtered
    try {
      await groupSurfacesTemporally(videoId);
    } catch (temporalErr) {
      console.error(`[Scanner V2] Temporal grouping failed (non-fatal):`, temporalErr);
    }

    // Remove filtered/phantom surfaces from count
    const postNormSurfaces = await storage.getDetectedSurfaces(videoId);
    const filteredOut = postNormSurfaces.filter(s => s.surfaceType === "Filtered").length;
    totalSurfaces = Math.max(0, totalSurfaces - filteredOut);

    // SCENE CONTEXT ENRICHMENT — FullScale Edge image analysis
    // Uses Sharp to analyze brightness, edges, and color to infer scene context
    try {
      await enrichSurfacesWithContext(videoId, permanentFramesDir);
    } catch (enrichErr) {
      console.error(`[Scanner V2] Scene context enrichment failed (non-fatal):`, enrichErr);
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
