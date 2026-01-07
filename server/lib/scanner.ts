import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { GoogleGenAI } from "@google/genai";
import { storage } from "../storage";
import type { VideoIndex, InsertDetectedSurface } from "@shared/schema";

const ai = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  httpOptions: {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  },
});

const SURFACE_TYPES = ["Table", "Desk", "Wall", "Monitor", "Bottle", "Laptop"] as const;

interface DetectedObject {
  surfaceType: string;
  confidence: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
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

async function analyzeFrame(framePath: string): Promise<DetectedObject[]> {
  try {
    const imageBuffer = fs.readFileSync(framePath);
    const base64Image = imageBuffer.toString("base64");
    
    const prompt = `Analyze this video frame and detect any of these surfaces that could be used for product placement: ${SURFACE_TYPES.join(", ")}.

For each detected surface, provide:
1. The surface type (exactly one of: ${SURFACE_TYPES.join(", ")})
2. Confidence score (0.0 to 1.0)
3. Bounding box coordinates (normalized 0-1 for x, y, width, height relative to image dimensions)

Respond ONLY with a valid JSON array. Example:
[{"surfaceType": "Desk", "confidence": 0.92, "boundingBox": {"x": 0.1, "y": 0.3, "width": 0.5, "height": 0.4}}]

If no surfaces are detected, return an empty array: []`;

    const response = await ai.models.generateContent({
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

    let text = response.text || "";
    
    // Strip Markdown code fences if present (```json ... ```)
    text = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    
    // Match JSON array
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    
    if (!jsonMatch) {
      console.log(`[Scanner] No JSON array found in response: ${text.substring(0, 100)}...`);
      return [];
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as DetectedObject[];
      return parsed.filter(obj => 
        SURFACE_TYPES.includes(obj.surfaceType as any) &&
        obj.confidence >= 0.5 &&
        obj.boundingBox
      );
    } catch (parseErr) {
      console.error(`[Scanner] JSON parse error:`, parseErr);
      return [];
    }
  } catch (error) {
    console.error(`[Scanner] Frame analysis error:`, error);
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

        await storage.insertDetectedSurface(surface);
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
