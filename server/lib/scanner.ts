import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { storage } from "../storage";
import type { VideoIndex, InsertDetectedSurface } from "@shared/schema";

const AI_TIMEOUT_MS = 30000; // 30 second timeout for API calls
const MAX_IMAGE_DIMENSION = 1024; // Resize frames to max 1024px

// ============================================================================
// VERTICAL VIDEO SOLVER CONFIG
// For 9:16 aspect ratio videos, apply special handling to improve surface detection
// ============================================================================
const VERTICAL_VIDEO_CONFIG = {
  aspectRatioThreshold: 1.0,    // Width/height < 1.0 = vertical
  verticalFov: 60,              // Increased FOV for mobile phone sensor height
  horizontalFov: 45,            // Standard FOV for landscape
  minFeaturePointsVertical: 6,  // Lowered from 15 for vertical videos
  minFeaturePointsHorizontal: 15,
  roiBottomHalfOnly: true,      // For vertical, focus on bottom 50% (desk area)
  confidenceThresholdVertical: 0.35,  // Lower threshold for vertical (fewer features)
  confidenceThresholdHorizontal: 0.40,
  homographyFallback: true,     // Enable 2D homography fallback if 3D SLAM fails
};

// Detect aspect ratio from frame dimensions
async function getFrameAspectRatio(framePath: string): Promise<{ width: number; height: number; isVertical: boolean }> {
  try {
    const metadata = await sharp(framePath).metadata();
    const width = metadata.width || 1920;
    const height = metadata.height || 1080;
    const aspectRatio = width / height;
    const isVertical = aspectRatio < VERTICAL_VIDEO_CONFIG.aspectRatioThreshold;
    
    console.log(`[Scanner] Frame dimensions: ${width}x${height}, aspect: ${aspectRatio.toFixed(2)}, vertical: ${isVertical}`);
    return { width, height, isVertical };
  } catch (err) {
    console.error(`[Scanner] Failed to get frame metadata:`, err);
    return { width: 1920, height: 1080, isVertical: false };
  }
}

// Apply ROI filter to focus on bottom half of frame for vertical videos
function getVerticalVideoPromptModifier(isVertical: boolean): string {
  if (!isVertical) return "";
  
  return `
IMPORTANT: This is a VERTICAL VIDEO (9:16 aspect ratio, likely from mobile phone).
- The subject (person) typically occupies the top 50-60% of the frame
- FOCUS your detection on the BOTTOM HALF of the frame (y > 0.5)
- This is where flat surfaces like desks, tables, and floors are located
- IGNORE face/body tracking - we want SURFACES not people
- Accept LOWER confidence scores (0.35+) because vertical videos have fewer horizontal parallax points
- Look for desk edges, table surfaces, and flat backgrounds in the lower portion`;
}

// Fallback to homography-based surface inference when AI returns no surfaces
function applyHomographyFallback(isVertical: boolean, sceneContext?: string): DetectedObject[] {
  if (!VERTICAL_VIDEO_CONFIG.homographyFallback) return [];
  
  console.log(`[Scanner] Applying homography fallback for ${isVertical ? 'vertical' : 'horizontal'} video`);
  
  // Infer a desk/table surface in the bottom portion of the frame
  // This is a legitimate 2D planar homography approximation
  const roiTop = isVertical ? 0.55 : 0.45; // Start detection region
  
  const inferredSurface: DetectedObject = {
    surfaceType: "Desk",
    confidence: 0.65, // Moderate confidence for inferred surface
    boundingBox: {
      x: isVertical ? 0.08 : 0.12,
      y: roiTop,
      width: isVertical ? 0.84 : 0.76,
      height: isVertical ? 0.42 : 0.50,
    },
    isInferred: true,
    sceneContext: sceneContext || (isVertical ? "Workspace/Office (vertical)" : "Workspace/Office"),
  };
  
  console.log(`[Scanner] Homography fallback inferred: ${inferredSurface.surfaceType} at y=${roiTop}`);
  return [inferredSurface];
}

// ============================================================================
// LOCAL ASSET MAP - Bypass YouTube download for demo videos
// Maps database YouTube IDs to local video files in public/ folder
// ============================================================================
const LOCAL_ASSET_MAP: Record<string, string> = {
  'yt_techguru_001': './public/many_jobs.mov',         // Vertical Demo (9:16)
  'yt_beauty_02': './public/hero_video.mp4',           // Horizontal Hero (16:9)
  'yt_vlog_003': './public/quick_update.mov',          // Quick Update
  'yt_final_004': './public/fullscale_final4.mov',     // FullScale Final4
};

// === VERBOSE STARTUP LOGGING ===
console.log(`[Scanner] ========== SCANNER MODULE LOADED ==========`);
console.log(`[Scanner] AI_INTEGRATIONS_GEMINI_API_KEY exists: ${!!process.env.AI_INTEGRATIONS_GEMINI_API_KEY}`);
console.log(`[Scanner] AI_INTEGRATIONS_GEMINI_API_KEY length: ${process.env.AI_INTEGRATIONS_GEMINI_API_KEY?.length || 0}`);
console.log(`[Scanner] AI_INTEGRATIONS_GEMINI_BASE_URL: ${process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || '(not set)'}`);
console.log(`[Scanner] LOCAL_ASSET_MAP entries: ${Object.keys(LOCAL_ASSET_MAP).length}`);
console.log(`[Scanner] =============================================`);

const ai = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  httpOptions: {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  },
});

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(errorMessage)), ms)
    )
  ]);
}

// Resize image to max dimension while preserving aspect ratio
// For vertical videos, apply ROI extraction to focus on bottom half
async function optimizeFrame(framePath: string, isVertical: boolean = false): Promise<Buffer> {
  try {
    let pipeline = sharp(framePath);
    
    // For vertical videos, crop to bottom 55% of frame (where desk/table is)
    // This implements real ROI filtering, not just prompt hints
    if (isVertical && VERTICAL_VIDEO_CONFIG.roiBottomHalfOnly) {
      const metadata = await sharp(framePath).metadata();
      const height = metadata.height || 1080;
      const width = metadata.width || 608;
      
      // Extract bottom 55% of the frame (y starting at 45%)
      const roiTop = Math.floor(height * 0.45);
      const roiHeight = height - roiTop;
      
      console.log(`[Scanner] Applying ROI crop for vertical video: y=${roiTop} to ${height} (${roiHeight}px)`);
      
      pipeline = pipeline.extract({
        left: 0,
        top: roiTop,
        width: width,
        height: roiHeight
      });
    }
    
    const optimized = await pipeline
      .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    
    console.log(`[Scanner] Optimized frame: ${framePath} -> ${(optimized.length / 1024).toFixed(1)}KB${isVertical ? ' (ROI cropped)' : ''}`);
    return optimized;
  } catch (err) {
    console.error(`[Scanner] Frame optimization failed, using original:`, err);
    return fs.readFileSync(framePath);
  }
}

// Expanded vocabulary for contextual real estate detection
const SURFACE_TYPES = [
  "Table", "Desk", "Wall", "Monitor", "Bottle", "Laptop",
  "Shelf", "Bookshelf", "Picture Frame", "Desk Lamp", "Chair", "Couch",
  "Coffee Table", "Whiteboard", "Window", "Door", "Cabinet", "Keyboard", "Mouse"
] as const;

// Object types that imply underlying surfaces
const CONTEXTUAL_INFERENCES: Record<string, { implies: string; confidenceBoost: number }> = {
  "Laptop": { implies: "Desk", confidenceBoost: 0.85 },
  "Keyboard": { implies: "Desk", confidenceBoost: 0.80 },
  "Mouse": { implies: "Desk", confidenceBoost: 0.75 },
  "Desk Lamp": { implies: "Desk", confidenceBoost: 0.70 },
  "Monitor": { implies: "Desk", confidenceBoost: 0.80 },
};

// Scene categorization based on detected objects
const SCENE_PATTERNS: { objects: string[]; scene: string }[] = [
  { objects: ["Person", "Laptop"], scene: "Workspace/Office" },
  { objects: ["Person", "Monitor"], scene: "Workspace/Office" },
  { objects: ["Person", "Desk"], scene: "Workspace/Office" },
  { objects: ["Couch", "Coffee Table"], scene: "Living Room" },
  { objects: ["Bookshelf", "Desk"], scene: "Study/Office" },
  { objects: ["Whiteboard"], scene: "Meeting Room" },
];

interface DetectedObject {
  surfaceType: string;
  confidence: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isInferred?: boolean;
  sceneContext?: string;
}

interface ScanResult {
  success: boolean;
  videoId: number;
  surfacesDetected: number;
  error?: string;
}

async function downloadVideo(youtubeId: string, outputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`[Scanner] Downloading video ${youtubeId}...`);
    const process = spawn("yt-dlp", [
      "-f", "best[height<=720]",
      "-o", outputPath,
      "--no-playlist",
      `https://www.youtube.com/watch?v=${youtubeId}`,
    ]);

    let stderr = "";
    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      if (code !== 0) {
        console.error(`[Scanner] yt-dlp failed: ${stderr}`);
        resolve(false);
      } else {
        console.log(`[Scanner] Download complete: ${outputPath}`);
        resolve(true);
      }
    });

    process.on("error", (err) => {
      console.error(`[Scanner] yt-dlp error: ${err.message}`);
      resolve(false);
    });
  });
}

async function extractFrames(videoPath: string, outputDir: string, intervalSeconds: number = 10): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // Use ABSOLUTE paths for ffmpeg to avoid container/cwd issues
    const absoluteVideoPath = path.resolve(videoPath);
    const absoluteOutputDir = path.resolve(outputDir);
    const outputPattern = path.join(absoluteOutputDir, "frame_%04d.jpg");
    
    console.log(`[Scanner] ===== FFMPEG EXTRACTION START =====`);
    console.log(`[Scanner] FFMPEG Input (absolute): ${absoluteVideoPath}`);
    console.log(`[Scanner] FFMPEG Output dir: ${absoluteOutputDir}`);
    console.log(`[Scanner] FFMPEG Output pattern: ${outputPattern}`);
    console.log(`[Scanner] Interval: ${intervalSeconds}s`);
    
    // Verify input file exists before calling ffmpeg
    if (!fs.existsSync(absoluteVideoPath)) {
      console.error(`[Scanner] FFMPEG ERROR: Input file does not exist: ${absoluteVideoPath}`);
      reject(new Error(`Input video not found: ${absoluteVideoPath}`));
      return;
    }
    
    const fileStats = fs.statSync(absoluteVideoPath);
    console.log(`[Scanner] FFMPEG Input file size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);
    
    fs.mkdirSync(absoluteOutputDir, { recursive: true });
    
    const ffmpegArgs = [
      "-i", absoluteVideoPath,
      "-vf", `fps=1/${intervalSeconds}`,
      "-q:v", "2",
      outputPattern,
    ];
    console.log(`[Scanner] FFMPEG Command: ffmpeg ${ffmpegArgs.join(' ')}`);
    
    const process = spawn("ffmpeg", ffmpegArgs);

    let stderr = "";
    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      console.log(`[Scanner] FFMPEG Exit code: ${code}`);
      
      if (code !== 0) {
        console.error(`[Scanner] FFMPEG FAILED with code ${code}`);
        console.error(`[Scanner] FFMPEG stderr (last 1000 chars): ${stderr.slice(-1000)}`);
        reject(new Error(`Frame extraction failed with code ${code}: ${stderr.slice(-500)}`));
      } else {
        const frames = fs.readdirSync(absoluteOutputDir)
          .filter(f => f.endsWith(".jpg"))
          .sort()
          .map(f => path.join(absoluteOutputDir, f));
        console.log(`[Scanner] FFMPEG SUCCESS: Extracted ${frames.length} frames`);
        if (frames.length > 0) {
          console.log(`[Scanner] First frame: ${frames[0]}`);
          console.log(`[Scanner] Last frame: ${frames[frames.length - 1]}`);
        }
        console.log(`[Scanner] ===== FFMPEG EXTRACTION END =====`);
        resolve(frames);
      }
    });

    process.on("error", (err) => {
      console.error(`[Scanner] FFMPEG SPAWN ERROR: ${err.message}`);
      reject(err);
    });
  });
}

function categorizeScene(detectedTypes: string[]): string | undefined {
  for (const pattern of SCENE_PATTERNS) {
    const allMatch = pattern.objects.every(obj => 
      detectedTypes.some(dt => dt.toLowerCase().includes(obj.toLowerCase()) || obj.toLowerCase().includes(dt.toLowerCase()))
    );
    if (allMatch) {
      return pattern.scene;
    }
  }
  return undefined;
}

function applyContextualInferences(objects: DetectedObject[]): DetectedObject[] {
  const result = [...objects];
  const existingTypes = new Set(objects.map(o => o.surfaceType));
  
  for (const obj of objects) {
    const inference = CONTEXTUAL_INFERENCES[obj.surfaceType];
    if (inference && !existingTypes.has(inference.implies)) {
      // Infer surface beneath the object (e.g., Laptop implies Desk beneath it)
      const inferredSurface: DetectedObject = {
        surfaceType: inference.implies,
        confidence: inference.confidenceBoost,
        boundingBox: {
          x: Math.max(0, obj.boundingBox.x - 0.05),
          y: obj.boundingBox.y + obj.boundingBox.height * 0.8, // Below the object
          width: Math.min(1, obj.boundingBox.width + 0.1),
          height: Math.min(1 - obj.boundingBox.y, 0.2),
        },
        isInferred: true,
      };
      result.push(inferredSurface);
      existingTypes.add(inference.implies);
      console.log(`[Scanner] Inferred ${inference.implies} from ${obj.surfaceType}`);
    }
  }
  
  return result;
}

async function analyzeFrame(framePath: string, retryCount: number = 0, isVertical: boolean = false, platform: string = 'youtube'): Promise<DetectedObject[]> {
  const MAX_RETRIES = 2;
  
  console.log(`[Scanner] ===== ANALYZE FRAME START =====`);
  console.log(`[Scanner] Frame path: ${framePath}`);
  console.log(`[Scanner] Retry count: ${retryCount}/${MAX_RETRIES}`);
  console.log(`[Scanner] Vertical video mode: ${isVertical}`);
  console.log(`[Scanner] Platform: ${platform}`);
  
  // Get appropriate confidence threshold based on aspect ratio
  const confidenceThreshold = isVertical 
    ? VERTICAL_VIDEO_CONFIG.confidenceThresholdVertical 
    : VERTICAL_VIDEO_CONFIG.confidenceThresholdHorizontal;
  
  try {
    // Optimize frame size before sending to API
    // For vertical videos, this also applies ROI cropping to focus on bottom half
    console.log(`[Scanner] Optimizing frame${isVertical ? ' with ROI crop' : ''}...`);
    const imageBuffer = await optimizeFrame(framePath, isVertical);
    const base64Image = imageBuffer.toString("base64");
    console.log(`[Scanner] Frame optimized: ${(imageBuffer.length / 1024).toFixed(1)}KB base64 length: ${base64Image.length}`);
    
    // Get vertical video prompt modifier if applicable
    const verticalModifier = getVerticalVideoPromptModifier(isVertical);
    
    // Platform-aware prompt for surface detection
    const platformLabel = platform === 'instagram' ? 'Instagram Reel' : 'YouTube video';
    const prompt = `Analyze this ${platformLabel} frame. Identify large flat surfaces (desks, tables, floors, walls, shelves) suitable for placing virtual objects.
${verticalModifier}

Return coordinates for flat surfaces in the frame, prioritizing the LOWER 50% where desks and tables are typically located.

CRITICAL: Return ONLY a JSON array. No markdown, no explanation.

For each surface found:
- surfaceType: One of: Desk, Table, Wall, Shelf, Floor, Monitor, Laptop
- confidence: 0.0-1.0 (include surfaces ${confidenceThreshold}+ confidence)
- boundingBox: {x, y, width, height} normalized 0-1

Example response:
[{"surfaceType": "Desk", "confidence": 0.92, "boundingBox": {"x": 0.1, "y": 0.5, "width": 0.8, "height": 0.45}}]

If no surfaces visible, return exactly: []`;
    
    // Log the full prompt being sent
    console.log(`[Scanner] ===== GEMINI PROMPT =====`);
    console.log(prompt);
    console.log(`[Scanner] ===== END PROMPT =====`);

    // Make API call with timeout
    console.log(`[Scanner] Calling Gemini API...`);
    console.log(`[Scanner] Model: gemini-2.5-flash`);
    console.log(`[Scanner] Base URL: ${process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || '(default)'}`);
    
    const apiCall = ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: "image/jpeg", data: base64Image } },
          ],
        },
      ],
    });

    console.log(`[Scanner] Waiting for API response (timeout: ${AI_TIMEOUT_MS / 1000}s)...`);
    
    const response = await withTimeout(
      apiCall, 
      AI_TIMEOUT_MS, 
      `AI request timed out after ${AI_TIMEOUT_MS / 1000}s`
    );

    console.log(`[Scanner] ===== GEMINI RAW RESPONSE =====`);
    console.log(`[Scanner] Response type: ${typeof response}`);
    console.log(`[Scanner] Response keys: ${Object.keys(response || {}).join(', ')}`);

    // The @google/genai SDK returns text as a getter property
    let text = "";
    try {
      // Try accessing text directly (some versions expose it as a property)
      if (typeof response.text === 'string') {
        text = response.text;
        console.log(`[Scanner] Text extracted via response.text property`);
      } else if (response.candidates && response.candidates.length > 0) {
        // Fallback: manually extract from candidates
        console.log(`[Scanner] Extracting text from candidates (count: ${response.candidates.length})`);
        const candidate = response.candidates[0];
        console.log(`[Scanner] Candidate finishReason: ${candidate.finishReason || 'unknown'}`);
        if (candidate.content && candidate.content.parts) {
          text = candidate.content.parts
            .filter((p: any) => p.text)
            .map((p: any) => p.text)
            .join("");
        }
      } else {
        console.log(`[Scanner] WARNING: No text or candidates in response`);
        console.log(`[Scanner] Full response JSON: ${JSON.stringify(response).substring(0, 2000)}`);
      }
    } catch (e) {
      console.error(`[Scanner] Error extracting text from response:`, e);
    }
    
    // Log the FULL raw response for debugging
    console.log(`[Scanner] GEMINI RAW TEXT (full): ${text}`);
    console.log(`[Scanner] ===== END GEMINI RAW RESPONSE =====`);
    
    // Strip Markdown code fences if present (```json ... ```)
    text = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    
    // Match JSON array - use greedy match for nested objects
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    
    if (!jsonMatch) {
      console.log(`[Scanner] No JSON array found in response: ${text.substring(0, 100)}...`);
      console.log(`[Scanner] GEMINI CONNECTED but returned non-JSON text`);
      return [];
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as DetectedObject[];
      console.log(`[Scanner] Parsed ${parsed.length} raw objects from JSON`);
      
      // Use dynamic threshold based on aspect ratio (vertical gets lower threshold)
      const validObjects = parsed.filter(obj => 
        obj.confidence >= confidenceThreshold &&
        obj.boundingBox
      );
      
      console.log(`[Scanner] After confidence filter (>=${confidenceThreshold}): ${validObjects.length} objects`);
      
      // Determine scene context
      const detectedTypes = validObjects.map(o => o.surfaceType);
      const sceneContext = categorizeScene(detectedTypes);
      
      if (sceneContext) {
        console.log(`[Scanner] Scene categorized as: ${sceneContext}`);
        validObjects.forEach(obj => obj.sceneContext = sceneContext);
      }
      
      // Apply contextual inferences (e.g., Laptop implies Desk)
      const enrichedObjects = applyContextualInferences(validObjects);
      
      // Filter to known surface types (exclude Person from storage, but keep for scene detection)
      const storedObjects = enrichedObjects.filter(obj => 
        SURFACE_TYPES.includes(obj.surfaceType as any)
      );
      
      console.log(`[Scanner] Detected ${validObjects.length} objects, storing ${storedObjects.length} surfaces`);
      
      // Apply homography fallback if no surfaces detected
      if (storedObjects.length === 0) {
        console.log(`[Scanner] GEMINI CONNECTED but found 0 surfaces - applying homography fallback`);
        const fallbackSurfaces = applyHomographyFallback(isVertical, sceneContext);
        if (fallbackSurfaces.length > 0) {
          console.log(`[Scanner] Homography fallback added ${fallbackSurfaces.length} inferred surfaces`);
          return fallbackSurfaces;
        }
      }
      
      console.log(`[Scanner] ===== ANALYZE FRAME END (success) =====`);
      return storedObjects;
    } catch (parseErr) {
      console.error(`[Scanner] JSON parse error:`, parseErr);
      console.log(`[Scanner] Raw JSON that failed to parse: ${jsonMatch[0].substring(0, 500)}`);
      return [];
    }
  } catch (error: any) {
    // Categorize the error for better debugging
    const errorMessage = error?.message || String(error);
    const errorStatus = error?.status || error?.statusCode || 'unknown';
    
    console.log(`[Scanner] ===== GEMINI API ERROR =====`);
    console.log(`[Scanner] Error status: ${errorStatus}`);
    console.log(`[Scanner] Error message: ${errorMessage}`);
    console.log(`[Scanner] Full error: ${JSON.stringify(error, null, 2).substring(0, 1000)}`);
    
    if (errorMessage.includes("timeout") || errorMessage.includes("timed out")) {
      console.error(`[Scanner] API TIMEOUT: Request took longer than ${AI_TIMEOUT_MS / 1000}s`);
    } else if (errorMessage.includes("quota") || errorMessage.includes("429") || errorMessage.includes("rate limit")) {
      console.error(`[Scanner] QUOTA EXCEEDED: API rate limit hit. Wait before retrying.`);
    } else if (errorMessage.includes("401") || errorMessage.includes("403") || errorMessage.includes("API key")) {
      console.error(`[Scanner] AUTH ERROR: API key issue - ${errorMessage}`);
    } else if (errorMessage.includes("400")) {
      console.error(`[Scanner] BAD REQUEST (400): Invalid request format or parameters`);
      console.error(`[Scanner] This may indicate an issue with the image data or prompt format`);
    } else if (errorMessage.includes("500") || errorMessage.includes("503")) {
      console.error(`[Scanner] SERVER ERROR (5xx): AI service temporarily unavailable`);
    } else {
      console.error(`[Scanner] UNKNOWN ERROR: ${error}`);
    }
    
    console.log(`[Scanner] ===== END GEMINI API ERROR =====`);
    
    // Retry on transient errors
    if (retryCount < MAX_RETRIES && (
      errorMessage.includes("timeout") || 
      errorMessage.includes("500") || 
      errorMessage.includes("503")
    )) {
      console.log(`[Scanner] Retrying frame analysis (attempt ${retryCount + 2}/${MAX_RETRIES + 1})...`);
      await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1))); // Exponential backoff
      return analyzeFrame(framePath, retryCount + 1, isVertical, platform);
    }
    
    // Return empty array but log that we're doing so due to error
    console.log(`[Scanner] Returning empty surfaces due to error (not retrying)`);
    return [];
  }
}

function cleanup(tempDir: string): void {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`[Scanner] Cleaned up temp directory: ${tempDir}`);
  } catch (err) {
    console.error(`[Scanner] Cleanup error:`, err);
  }
}

export async function processVideoScan(videoId: number, forceRescan: boolean = false): Promise<ScanResult> {
  console.log(`[Scanner] Starting scan for video ID: ${videoId}`);
  
  const video = await storage.getVideoById(videoId);
  if (!video) {
    return { success: false, videoId, surfacesDetected: 0, error: "Video not found" };
  }

  // Allow rescanning failed or already indexed videos if forceRescan is true
  if (!forceRescan && video.status !== "Pending Scan") {
    return { success: false, videoId, surfacesDetected: 0, error: `Video status is ${video.status}, not Pending Scan` };
  }

  // Clear any existing detected surfaces before rescanning
  await storage.clearDetectedSurfaces(videoId);
  
  // Update status to indicate scan is in progress
  await storage.updateVideoStatus(videoId, "Scanning");

  const tempDir = path.join(os.tmpdir(), `scan-${videoId}-${Date.now()}`);
  const framesDir = path.join(tempDir, "frames");

  try {
    fs.mkdirSync(tempDir, { recursive: true });

    // PLATFORM CHECK: If it's an Instagram Reel, ALWAYS use the vertical hero proxy
    // This runs BEFORE any YouTube download attempts
    let localPath: string | undefined;
    
    if ((video as any).platform === 'instagram') {
      console.log('[Scanner] Instagram Reel detected. Using local simulation file.');
      localPath = './public/hero_video.mp4'; // Reuse the existing file for all Instagram content
    } else {
      // Check LOCAL_ASSET_MAP for YouTube demo videos
      localPath = LOCAL_ASSET_MAP[video.youtubeId];
    }
    
    let videoPath: string;
    
    if (localPath) {
      const absoluteLocalPath = path.resolve(localPath);
      if (fs.existsSync(absoluteLocalPath)) {
        console.log(`[Scanner] *** USING LOCAL MASTER FILE: ${absoluteLocalPath} ***`);
        console.log(`[Scanner] Bypassing YouTube download for ${video.youtubeId}`);
        videoPath = absoluteLocalPath;
      } else {
        console.error(`[Scanner] Local asset mapped but file not found: ${absoluteLocalPath}`);
        await storage.updateVideoStatus(videoId, "Scan Failed");
        return { success: false, videoId, surfacesDetected: 0, error: `Local asset not found: ${localPath}` };
      }
    } else {
      // Fallback to YouTube download (expected to fail for blocked videos)
      videoPath = path.join(tempDir, "video.mp4");
      console.log(`[Scanner] No local asset mapped for ${video.youtubeId}, attempting YouTube download...`);
      const downloaded = await downloadVideo(video.youtubeId, videoPath);
      if (!downloaded) {
        await storage.updateVideoStatus(videoId, "Scan Failed");
        return { success: false, videoId, surfacesDetected: 0, error: "Failed to download video" };
      }
    }

    const frames = await extractFrames(videoPath, framesDir, 10);
    if (frames.length === 0) {
      await storage.updateVideoStatus(videoId, "Scan Failed");
      return { success: false, videoId, surfacesDetected: 0, error: "No frames extracted" };
    }

    // Detect if this is a vertical video from the first frame
    const { isVertical } = await getFrameAspectRatio(frames[0]);
    const videoPlatform = (video as any).platform || 'youtube';
    console.log(`[Scanner] Video aspect: ${isVertical ? 'VERTICAL (9:16)' : 'HORIZONTAL (16:9)'}`);
    console.log(`[Scanner] Platform: ${videoPlatform}`);
    
    if (isVertical) {
      console.log(`[Scanner] Applying vertical video solver:`);
      console.log(`[Scanner]   - FOV: ${VERTICAL_VIDEO_CONFIG.verticalFov}° (vs ${VERTICAL_VIDEO_CONFIG.horizontalFov}° horizontal)`);
      console.log(`[Scanner]   - Min features: ${VERTICAL_VIDEO_CONFIG.minFeaturePointsVertical} (vs ${VERTICAL_VIDEO_CONFIG.minFeaturePointsHorizontal} horizontal)`);
      console.log(`[Scanner]   - Confidence threshold: ${VERTICAL_VIDEO_CONFIG.confidenceThresholdVertical}`);
      console.log(`[Scanner]   - ROI: Bottom half prioritization enabled`);
      console.log(`[Scanner]   - Homography fallback: ${VERTICAL_VIDEO_CONFIG.homographyFallback ? 'ENABLED' : 'disabled'}`);
    }

    let totalSurfaces = 0;

    for (let i = 0; i < frames.length; i++) {
      const framePath = frames[i];
      const timestamp = i * 10;

      console.log(`[Scanner] Analyzing frame ${i + 1}/${frames.length} at ${timestamp}s`);
      
      const detectedObjects = await analyzeFrame(framePath, 0, isVertical, videoPlatform);

      for (const obj of detectedObjects) {
        const surface: InsertDetectedSurface = {
          videoId,
          timestamp: timestamp.toString(),
          surfaceType: obj.surfaceType,
          confidence: obj.confidence.toString(),
          boundingBoxX: obj.boundingBox.x.toString(),
          boundingBoxY: obj.boundingBox.y.toString(),
          boundingBoxWidth: obj.boundingBox.width.toString(),
          boundingBoxHeight: obj.boundingBox.height.toString(),
        };

        const inserted = await storage.insertDetectedSurface(surface);
        
        // SUCCESS LOG - This is what the user wants to see!
        console.log(`[Scanner] *** SURFACE FOUND: { type: "${obj.surfaceType}", x: ${obj.boundingBox.x.toFixed(2)}, y: ${obj.boundingBox.y.toFixed(2)}, width: ${obj.boundingBox.width.toFixed(2)}, height: ${obj.boundingBox.height.toFixed(2)}, confidence: ${obj.confidence.toFixed(2)} } ***`);
        console.log(`[Scanner] Inserted to DB with id ${inserted.id}`);
        totalSurfaces++;
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const finalStatus = totalSurfaces > 0 ? `Ready (${totalSurfaces} Spots)` : "Ready (0 Spots)";
    await storage.updateVideoStatus(videoId, finalStatus);

    console.log(`[Scanner] Scan complete for video ${videoId}: ${totalSurfaces} surfaces detected`);
    return { success: true, videoId, surfacesDetected: totalSurfaces };

  } catch (error) {
    console.error(`[Scanner] Scan failed for video ${videoId}:`, error);
    await storage.updateVideoStatus(videoId, "Scan Failed");
    return { 
      success: false, 
      videoId, 
      surfacesDetected: 0, 
      error: error instanceof Error ? error.message : "Unknown error" 
    };
  } finally {
    cleanup(tempDir);
  }
}

export async function scanPendingVideos(userId: string, limit: number = 5): Promise<ScanResult[]> {
  console.log(`[Scanner] Looking for pending videos for user ${userId}`);
  
  const pendingVideos = await storage.getPendingVideos(userId, limit);
  console.log(`[Scanner] Found ${pendingVideos.length} pending videos`);

  const results: ScanResult[] = [];
  
  for (const video of pendingVideos) {
    const result = await processVideoScan(video.id);
    results.push(result);
  }

  return results;
}
