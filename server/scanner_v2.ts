/**
 * ============================================================================
 * SCANNER V2 - Resource-Safe Surface Detection for Replit
 * ============================================================================
 * 
 * This is a lightweight, production-safe replacement for scanner.ts.
 * 
 * KEY DIFFERENCES FROM V1:
 * - Uses Sharp edge detection instead of Gemini AI (faster, free, no timeouts)
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

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Frame extraction
  FRAME_INTERVAL_SECONDS: 5,
  MAX_FRAMES_PER_VIDEO: 24,
  FRAME_MAX_DIMENSION: 640,
  FRAME_QUALITY: 70,
  
  // Disk safety
  MIN_DISK_SPACE_MB: 100,
  
  // Detection thresholds
  EDGE_THRESHOLD: 30,
  HORIZONTAL_LINE_MIN_LENGTH: 0.3,
  SURFACE_CONFIDENCE_THRESHOLD: 0.4,
  
  // Timeouts
  FFMPEG_TIMEOUT_MS: 60000,
  FRAME_PROCESS_TIMEOUT_MS: 5000,
  
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

// ============================================================================
// LOCAL ASSET MAP
// ============================================================================

const LOCAL_ASSET_MAP: Record<string, string> = {
  'yt_techguru_001': './public/many_jobs.mov',
  'yt_beauty_02': './public/hero_video.mp4',
  'yt_vlog_003': './public/quick_update.mov',
  'yt_final_004': './public/fullscale_final4.mov',
  'test-video-1': './public/hero_video.mp4',
  'user-quick-update': './attached_assets/Quick_Update_1767906117156.mov',
  'user-many-jobs': './attached_assets/Many_Jobs_1767904823555.mov',
  'user-hero-video': './attached_assets/hero_video_1767897215595.mp4',
  'user-fullscale-final': './attached_assets/FullScale_Final4_1767897231210.mov',
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
    return defaultResult;
  }
  
  const rowEdgeCounts: number[] = [];
  let maxEdgeCount = 0;
  let maxEdgeRow = 0;
  
  for (let y = 1; y < height - 1; y++) {
    let edgeCount = 0;
    let consecutiveEdge = 0;
    let maxConsecutive = 0;
    
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      
      const above = buffer[idx - width];
      const below = buffer[idx + width];
      const gradient = Math.abs(below - above);
      
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
    
    for (let i = 0; i < frames.length; i++) {
      const framePath = frames[i];
      const timestamp = i * CONFIG.FRAME_INTERVAL_SECONDS;
      
      try {
        console.log(`[Scanner V2] Processing frame ${i + 1}/${frames.length} (${timestamp}s)...`);
        
        const analysis = await analyzeFrameForSurfaces(framePath, timestamp, isVertical);
        
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
