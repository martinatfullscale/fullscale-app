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
async function optimizeFrame(framePath: string): Promise<Buffer> {
  try {
    const optimized = await sharp(framePath)
      .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    
    console.log(`[Scanner] Optimized frame: ${framePath} -> ${(optimized.length / 1024).toFixed(1)}KB`);
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
    console.log(`[Scanner] Extracting frames every ${intervalSeconds}s...`);
    
    fs.mkdirSync(outputDir, { recursive: true });
    
    const process = spawn("ffmpeg", [
      "-i", videoPath,
      "-vf", `fps=1/${intervalSeconds}`,
      "-q:v", "2",
      path.join(outputDir, "frame_%04d.jpg"),
    ]);

    let stderr = "";
    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      if (code !== 0) {
        console.error(`[Scanner] ffmpeg failed: ${stderr}`);
        reject(new Error("Frame extraction failed"));
      } else {
        const frames = fs.readdirSync(outputDir)
          .filter(f => f.endsWith(".jpg"))
          .sort()
          .map(f => path.join(outputDir, f));
        console.log(`[Scanner] Extracted ${frames.length} frames`);
        resolve(frames);
      }
    });

    process.on("error", (err) => {
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

async function analyzeFrame(framePath: string, retryCount: number = 0): Promise<DetectedObject[]> {
  const MAX_RETRIES = 2;
  
  try {
    // Optimize frame size before sending to API
    const imageBuffer = await optimizeFrame(framePath);
    const base64Image = imageBuffer.toString("base64");
    
    // Enhanced prompt for contextual real estate detection
    const prompt = `You are an AI assistant helping identify product placement opportunities in video frames.

Analyze this image and detect ALL visible objects and surfaces that could be used for product placement or brand integration, including:
- Surfaces: ${SURFACE_TYPES.join(", ")}
- People: Look for "Person" in the frame (important for scene context)

Be GENEROUS in detection. Even if you're only 50% sure, include it. We want to capture ALL possible placement opportunities.

For EACH detected item, provide:
1. surfaceType: The object type (use exact names from the list, or "Person" for people)
2. confidence: Score from 0.0-1.0 (include anything 0.4 or higher)
3. boundingBox: Normalized coordinates (x, y, width, height) from 0-1

Focus on finding:
- Laptops on desks (common in office/workspace videos)
- Monitors/screens
- Walls and shelves (great for posters/products)
- Tables and desks
- Any flat surface where products could be placed

Respond ONLY with a valid JSON array. Example:
[{"surfaceType": "Laptop", "confidence": 0.85, "boundingBox": {"x": 0.3, "y": 0.4, "width": 0.3, "height": 0.2}}, {"surfaceType": "Person", "confidence": 0.95, "boundingBox": {"x": 0.1, "y": 0.1, "width": 0.4, "height": 0.8}}]

If truly nothing is detected, return: []`;

    // Make API call with timeout
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

    const response = await withTimeout(
      apiCall, 
      AI_TIMEOUT_MS, 
      `AI request timed out after ${AI_TIMEOUT_MS / 1000}s`
    );

    // The @google/genai SDK returns text as a getter property
    let text = "";
    try {
      // Try accessing text directly (some versions expose it as a property)
      if (typeof response.text === 'string') {
        text = response.text;
      } else if (response.candidates && response.candidates.length > 0) {
        // Fallback: manually extract from candidates
        const candidate = response.candidates[0];
        if (candidate.content && candidate.content.parts) {
          text = candidate.content.parts
            .filter((p: any) => p.text)
            .map((p: any) => p.text)
            .join("");
        }
      }
    } catch (e) {
      console.error(`[Scanner] Error extracting text from response:`, e);
    }
    
    console.log(`[Scanner] Gemini raw response text (first 500 chars): ${text.substring(0, 500)}`);
    
    // Strip Markdown code fences if present (```json ... ```)
    text = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    
    // Match JSON array - use greedy match for nested objects
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    
    if (!jsonMatch) {
      console.log(`[Scanner] No JSON array found in response: ${text.substring(0, 100)}...`);
      return [];
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as DetectedObject[];
      
      // Lower threshold to 0.4 for more generous detection
      const validObjects = parsed.filter(obj => 
        obj.confidence >= 0.4 &&
        obj.boundingBox
      );
      
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
      
      return storedObjects;
    } catch (parseErr) {
      console.error(`[Scanner] JSON parse error:`, parseErr);
      return [];
    }
  } catch (error: any) {
    // Categorize the error for better debugging
    const errorMessage = error?.message || String(error);
    
    if (errorMessage.includes("timeout") || errorMessage.includes("timed out")) {
      console.error(`[Scanner] API TIMEOUT: Request took longer than ${AI_TIMEOUT_MS / 1000}s`);
    } else if (errorMessage.includes("quota") || errorMessage.includes("429") || errorMessage.includes("rate limit")) {
      console.error(`[Scanner] QUOTA EXCEEDED: API rate limit hit. Wait before retrying.`);
    } else if (errorMessage.includes("401") || errorMessage.includes("403") || errorMessage.includes("API key")) {
      console.error(`[Scanner] AUTH ERROR: API key issue - ${errorMessage}`);
    } else if (errorMessage.includes("500") || errorMessage.includes("503")) {
      console.error(`[Scanner] SERVER ERROR: AI service temporarily unavailable`);
    } else {
      console.error(`[Scanner] Frame analysis error:`, error);
    }
    
    // Retry on transient errors
    if (retryCount < MAX_RETRIES && (
      errorMessage.includes("timeout") || 
      errorMessage.includes("500") || 
      errorMessage.includes("503")
    )) {
      console.log(`[Scanner] Retrying frame analysis (attempt ${retryCount + 2}/${MAX_RETRIES + 1})...`);
      await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1))); // Exponential backoff
      return analyzeFrame(framePath, retryCount + 1);
    }
    
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
  const videoPath = path.join(tempDir, "video.mp4");
  const framesDir = path.join(tempDir, "frames");

  try {
    fs.mkdirSync(tempDir, { recursive: true });

    const downloaded = await downloadVideo(video.youtubeId, videoPath);
    if (!downloaded) {
      await storage.updateVideoStatus(videoId, "Scan Failed");
      return { success: false, videoId, surfacesDetected: 0, error: "Failed to download video" };
    }

    const frames = await extractFrames(videoPath, framesDir, 10);
    if (frames.length === 0) {
      await storage.updateVideoStatus(videoId, "Scan Failed");
      return { success: false, videoId, surfacesDetected: 0, error: "No frames extracted" };
    }

    let totalSurfaces = 0;

    for (let i = 0; i < frames.length; i++) {
      const framePath = frames[i];
      const timestamp = i * 10;

      console.log(`[Scanner] Analyzing frame ${i + 1}/${frames.length} at ${timestamp}s`);
      
      const detectedObjects = await analyzeFrame(framePath);

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
        console.log(`[Scanner] Inserted surface: ${obj.surfaceType} at ${timestamp}s with id ${inserted.id}`);
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
