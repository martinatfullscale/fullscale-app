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
import { uploadFileToStorage, downloadToTempFile, storageServeUrl } from "./lib/objectStorage";
import { downloadVideo as downloadYouTubeVideo, getYoutubeVideoDuration } from "./lib/scanner";
import { downloadFacebookVideo, downloadInstagramVideo } from "./lib/socialDownloader";
import { safeDecrypt } from "./lib/socialAnalytics";
import { getFreshYoutubeTokenForUser } from "./lib/youtubeAuth";
import { resolveYoutubeStreamUrl, resolveGraphStreamUrl, type StreamSource } from "./lib/streamResolver";
import { buildSceneIndex, sceneIdForTimestamp, sampleMultiTimestampsPerScene, type SceneIndex } from "./lib/scenes/sceneIndex";

// ============================================================================
// GEMINI AI CLIENT
// ============================================================================

// Startup diagnostics — logs once at module load time so you can see the config in Replit logs
console.log(`[Scanner V2] =============================================`);
console.log(`[Scanner V2] AI_INTEGRATIONS_GEMINI_API_KEY exists: ${!!process.env.AI_INTEGRATIONS_GEMINI_API_KEY}`);
console.log(`[Scanner V2] AI_INTEGRATIONS_GEMINI_API_KEY length: ${process.env.AI_INTEGRATIONS_GEMINI_API_KEY?.length || 0}`);
console.log(`[Scanner V2] AI_INTEGRATIONS_GEMINI_BASE_URL: ${process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || '(NOT SET — will use Google default)'}`);
console.log(`[Scanner V2] =============================================`);

const ai = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
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

  // Fallback detection - add placeholder surfaces when Gemini finds fewer than this count
  // Set to 1 so that videos scanned without Gemini (missing API key) still get placeholders
  MIN_SURFACES_BEFORE_FALLBACK: 1,
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
// SCAN MODE CONFIGURATION
// ============================================================================
// Standard mode: strict rules for manual placement flow
// AutoRemix mode: relaxed rules for narrative-first approach (auto-remix engine)

export interface ScanModeConfig {
  maxPersonOccupancy: number;
  minSurfaceArea: number;
  maxBboxHeight: number;
  requireTableEdge: boolean;
  allowBackgroundPlacements: boolean;
  fallbackToGeneration: boolean;
}

export const scanModes: Record<string, ScanModeConfig> = {
  standard: {
    maxPersonOccupancy: 0.5,
    minSurfaceArea: 0.08,
    maxBboxHeight: 0.3,
    requireTableEdge: true,
    allowBackgroundPlacements: false,
    fallbackToGeneration: false,
  },
  autoRemix: {
    maxPersonOccupancy: 0.7,
    minSurfaceArea: 0.05,
    maxBboxHeight: 0.4,
    requireTableEdge: false,
    allowBackgroundPlacements: true,
    fallbackToGeneration: true,
  },
};

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
  orientation?: "horizontal" | "vertical";  // horizontal = product placement, vertical = signage/poster
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
  orientation?: "horizontal" | "vertical";
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

const SURFACE_DETECTION_PROMPT = `You are analyzing a video frame to identify REAL, PHYSICAL surfaces where a brand could naturally place product or signage.

CRITICAL FRAMING — READ FIRST:
This task heavily rewards FALSE POSITIVES if you let it. Most frames in
podcast / interview / vlog content do NOT contain a usable placement
surface — the camera is on people, not on furniture. Your default
posture should be: "no clear surface exists in this frame, return empty."
Only flag a surface when you can confidently describe what it is, where
it sits in 3D space, and what it's made of. When in doubt, return empty.

BEFORE PICKING ANY SURFACE — describe the 3D layout:
- What is in the foreground (person, microphone, hands)?
- What is in the mid-ground (furniture, props)?
- What is in the background (walls, plants, decor)?
- Where is the camera positioned (eye-level, above, below, behind)?
This 3D understanding is required to avoid the most common error: treating
a flat-looking 2D region as a horizontal surface when it's actually a
wall, a curtain, a couch back, or empty space.

TASK: Find UP TO 4 of the best placement surfaces visible in the frame.
Surfaces fall into two distinct categories with different placement use cases:

  1. HORIZONTAL surfaces (orientation: "horizontal") — flat surfaces where physical objects can sit.
     Examples: desks, tables, countertops, shelves, nightstands, coffee tables, studio desks.
     Plus FLOOR space — indoor floor area with usable empty room for floor-resting products.
     Use case: bottles, cans, phones, gadgets, books, packaged goods (table-top sized);
     sneakers, shoe boxes, large bottles, plants, decorative props (floor-sized).

  2. VERTICAL surfaces (orientation: "vertical") — flat upright planes where signage/posters/art belong.
     Examples: walls (the empty parts), doors, windows, large empty backdrops.
     Use case: posters, brand banners, framed art, logos, projected signage.

Return them ranked by suitability. Quality > quantity — if only one surface is genuinely usable, return only one. If none, return zero. Never inflate to hit 2.

CRITICAL RULES:
- Maximum 4 surfaces total across both orientations (was 2; bumped to capture
  complex scenes that have shelves AND tables AND floor AND walls all visible).
  Still: quality > quantity. If only 2 are genuinely usable, return only 2.
- Only detect REAL physical surfaces that exist in the 3D scene
- Each surface must occupy at least 5% of total frame area
- Each surface must have CLEAR visual separation from people in the frame
- Do NOT flag roads, sidewalks, or outdoor ground (concrete, asphalt, dirt)
- Do NOT flag ceilings or curtains
- Indoor floors ARE valid (see FLOOR rules below) — but only when usable empty floor area is clearly visible
- Do NOT flag bridges, vehicles, or outdoor structures
- Do NOT flag areas with heavy motion blur or out-of-focus regions
- Do NOT flag surfaces blocked by people's bodies, hands, or large objects
- If a person occupies >50% of the frame (close-up, bust shot), return surfaces_found: false UNLESS a clear surface is ALSO prominently visible SEPARATE from the person
- If the frame is exterior/outdoor with no architectural features, return surfaces_found: false

ANTI-HALLUCINATION RULES (CRITICAL — READ CAREFULLY):
- You MUST be able to clearly see the physical surface material (wood, paint, drywall, glass, metal, stone)
- The bounding box MUST NOT overlap with any person's body, clothing, arms, hands, lap, legs, knees, or feet
- A laptop on someone's lap is NOT a desk surface — it is a laptop on a person
- Dark clothing is NOT a desk — it is clothing
- A microphone boom, monitor arm, or equipment mount is NOT a surface
- Do NOT bounding-box someone's chest/torso/lap area and call it a "desk"
- The surface must be GEOMETRICALLY SEPARATE from any person — clear visual separation between body and surface edge
- A wall texture you can't actually see (out of focus, behind people, in shadow) is NOT a wall placement surface
- If unsure whether something is a real surface vs a shadow/dark region near a person, do NOT include it

PEOPLE / CHAIRS / FURNITURE-WITH-PEOPLE — STRICT BAN LIST (MOST COMMON HALLUCINATION):
The single most common error in podcast/interview frames is labeling a person
or the chair they're sitting in as a "coffee_table" / "table" / "studio_desk".
These are NEVER placement surfaces — never flag them, never bound-box them:
- A person's body, head, face, hair, neck, shoulders, arms, hands, lap, legs, knees, or feet
- Clothing of any kind (shirt, jacket, hoodie, pants, suit, tracksuit) — even if it looks flat
- The arm-rest, seat, back, or cushion of a chair, armchair, sofa, or couch
- A leather/upholstered surface that has a person sitting on, against, or near it
- A chair that contains a person — even the empty parts of the chair around them
- The space between two seated people (that's a gap, not a coffee table)
- A pillow, throw, blanket, or cushion on a chair or couch

VERIFICATION CHECK before flagging ANY horizontal surface (run this mentally):
1. Is there a person occupying or touching the bounding box region? → REJECT
2. Is the box on or against a chair/sofa/armchair seat or back? → REJECT
3. Could the entire bounding box be replaced by "person sitting" without changing the frame meaning? → REJECT
4. Is the box on cushy/fabric/leather upholstery rather than a wood/glass/stone top? → REJECT
5. Can I see a clear flat HORIZONTAL plane (a top edge where a glass would rest) inside the box? → If NO, REJECT

PODCAST CHAIR SPECIFIC: In talking-head shows, hosts sit in chesterfield/leather
armchairs. The LEATHER SEAT, ARM-REST, and CHAIR-BACK are NEVER coffee tables.
Even if a chair arm looks like it could hold a small object, do NOT flag it.

LABEL ACCURACY RULES (CRITICAL):
- Before assigning a surface_type, look at the bounding box region and ask:
  "What is physically there?" — match the LABEL to what you actually see.
- If the region shows a vertical plane (wall, painted backdrop, curtain-back-panel,
  textured background, mural, art on wall): label as "wall" with orientation:"vertical".
  Do NOT label vertical regions as desk/table/countertop just because something brand-
  shaped could go there. Wrong label = wrong placement physics downstream.
- If the region shows a flat horizontal plane (table top, desk top, counter top, shelf
  top): label as the appropriate horizontal type.
- "studio_desk" specifically requires a visible HORIZONTAL desk surface (the flat top
  where a podcaster would set their water bottle). Do NOT use "studio_desk" for an
  upper-frame area, an arm-rest, a couch back, or anything that is not a flat horizontal
  desk top. If you see a podcast/interview studio but the actual desk top is NOT visible
  in the frame, do NOT flag a "studio_desk" surface.
- "table" / "coffee_table" / "side_table" require a visible horizontal table top. If the
  bbox is centered above floor level on a vertical plane, it is NOT a table.
- A common error to AVOID: labeling the empty wall/backdrop next to a person as
  "studio_desk" or "table". Walls behind/beside subjects in podcast scenes are walls.
  Label them as "wall" with orientation:"vertical".
- Couch backs, chair backs, headboards: not desks. If they're flat enough to hold a
  poster they could be "wall" (vertical). If they're horizontal arm-rests with width,
  they could be "table" but only if visible flat top is wide enough for a product.
- When in doubt between desk and wall, ask: would a glass of water naturally rest on
  this surface without falling? If no → it's not horizontal → it's wall (or filter).

HORIZONTAL surface bounding box rules:
- The box must cover ONLY the visible flat top where a product could sit
- Do NOT include table legs, chairs, people, or the area BELOW or ABOVE the table
- A wide table at eye level is a THIN horizontal strip: x:15, y:55, width:70, height:10
- A desk slightly above eye level: x:20, y:50, width:40, height:20
- Box height should rarely exceed 30% of frame unless viewed top-down
- For eye-level tables/desks, box center y > 40% (lower portion of frame)

FLOOR surface rules (use surface_type:"floor", orientation:"horizontal"):
- Only flag floor space when there's a CLEARLY VISIBLE empty patch of indoor
  floor — wood, carpet, tile, concrete (interior), polished surfaces.
- Use case is products that rest on the floor: sneakers, shoe boxes, large
  drink bottles, decorative plants, suitcases, gym equipment, branded props.
- The floor patch must be:
  * IN FOCUS (not background blur)
  * Empty of clutter — no shoes/cables/feet currently on that exact spot
  * Big enough for a sneaker — at least 8% of frame area
  * In the LOWER portion of the frame (box center y > 60%)
- Box typically lives at the bottom of the frame: x:10, y:65, width:35, height:25
  (a clear patch of carpet at someone's feet but not under their feet).
- Do NOT flag the floor BENEATH a person's feet — they're standing on it.
- Do NOT flag floor that's mostly out of focus (depth-of-field background).
- Outdoor ground (sidewalks, asphalt, grass) is NOT floor — those stay excluded.

VERTICAL surface bounding box rules:
- The box must cover only the EMPTY/UNOBSTRUCTED part of the wall/door/window
- Do NOT include picture frames already on the wall, light switches, or wall fixtures
- Do NOT include parts blocked by furniture or people
- Walls usually have generous height: x:10, y:10, width:30, height:50 is normal
- Box should be a substantial usable plane, not tiny patches between objects
- The wall must be IN FOCUS — out-of-focus background walls are not placement surfaces

PODCAST / INTERVIEW / TALKING-HEAD RULES (read carefully — we hallucinate here):
- Most podcast frames have NO usable surface. Default to surfaces_found:false.
- People sitting on COUCHES with no visible coffee table → no surface. Return empty.
  Couch arm-rests are NOT desks. Couch cushions are NOT tables. The throw pillow
  next to them is NOT a surface.
- People sitting in CHAIRS with no visible side table → no surface. Return empty.
  The chair arm is not a surface.
- The wall/backdrop BEHIND the subject: only flag as "wall" if it is IN FOCUS,
  large, mostly empty (no existing art/posters/shelves filling it), and clearly
  intended as a backdrop. A blurred or partially-visible background wall is NOT
  a placement surface.
- The decorative art piece, mural, or painted backdrop behind the subject is NOT
  a placement target — it's existing decor and a brand poster wouldn't go there.
- A "studio_desk" requires you to actually SEE the flat horizontal desk top in
  the frame. If you can only see the front edge / the side / the equipment on
  it but not the top plane, return empty for that surface.
- A coffee table in front of the couch counts ONLY if its TOP is clearly visible
  (not occluded by people's legs / drinks already on it / the camera angle being
  too low to see the top).
- If you cannot describe in one sentence "there is a [surface_type] at [location]
  made of [material]," then it is not a real surface and should not be flagged.

GOOD SURFACES (flag up to 4 of these):
- Studio desks in podcast/recording setups (when desk top is visible)
- Desks, tables, countertops with visible flat area
- Shelves with clear space
- Nightstands, side tables, coffee tables
- Kitchen counters with some clear space
- Indoor FLOOR — clear empty patch of wood, carpet, tile, polished concrete
  (in focus, not under someone's feet, big enough for a sneaker/large product)
- Walls with substantial empty/unobstructed sections (in focus)
- Doors (when prominently visible in frame, not just edges)
- Large windows (when behind something brand-relevant could go)

PRIORITY GUIDANCE — DON'T LET TABLES CROWD OUT EVERYTHING:
A common failure mode: when a frame has a side table + a clearly visible
bookshelf + visible floor + visible wall, you return TWO instances of the
side table (or duplicate detections of one table) and miss the bookshelf,
floor, and wall. With the 4-surface cap, prefer DIVERSITY over duplicates:
- If a substantial bookshelf is clearly visible (in focus, books/items
  visible, multiple shelves), it MUST be one of your returned surfaces.
  Don't skip it for a third side-table detection.
- If a clear empty patch of indoor floor is visible in the lower frame
  (carpet, wood, tile — at someone's feet but not under them), include it
  as surface_type:"floor", orientation:"horizontal".
- If a substantial empty wall is visible (in focus, not blurred, not
  covered in art), include it as surface_type:"wall", orientation:"vertical".
- Among the 4 returned: aim for at most ONE of each
  {coffee_table, side_table, nightstand, table} unless there are genuinely
  two distinct tables in the scene at different positions.

BAD "SURFACES" (do NOT flag):
- Roads, highways, pavement, outdoor ground (asphalt, dirt, grass)
- Ceilings, curtains
- Sky, trees, outdoor scenery without architectural features
- Building exteriors, bridges, vehicles
- Walls that are completely out of focus (background blur)
- Walls already covered with art, posters, or shelving (no usable empty area)
- Dark regions below a person's chest/torso
- Inferred/assumed surfaces not clearly visible
- A person's lap, thighs, or clothing
- Laptop screens, monitor faces, camera housings
- Microphone boom arms, monitor stands

CONFIDENCE GUIDANCE:
- Use >0.7 only if surface is clearly, unambiguously visible with usable area
- Use 0.4-0.6 for partially visible or partially obstructed
- Use <0.4 for uncertain (will be filtered out — better to omit)

For each surface, provide:
- **location**: bounding box {x, y, width, height} in percentages (0-100)
- **orientation**: "horizontal" or "vertical"
- **surface_type**: desk, table, shelf, counter, nightstand, coffee_table, studio_desk, floor, wall, door, window
- **confidence**: 0.0 to 1.0 (see guidance above)
- **reasoning**: brief explanation
- **lighting_direction**: "left", "right", "top", "top-left", "top-right", "ambient"
- **lighting_intensity**: 0.0 to 1.0
- **camera_angle**: "eye-level", "slightly-above", "top-down", "low-angle"

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no code fences):
{
  "surfaces_found": true,
  "frame_description": "Brief description of what's in the frame",
  "surfaces": [
    {
      "location": {"x": 20, "y": 55, "width": 30, "height": 20},
      "orientation": "horizontal",
      "surface_type": "studio_desk",
      "confidence": 0.85,
      "reasoning": "Clear studio desk surface, well-lit, main placement area",
      "lighting_direction": "top-left",
      "lighting_intensity": 0.7,
      "camera_angle": "slightly-above"
    },
    {
      "location": {"x": 5, "y": 5, "width": 35, "height": 45},
      "orientation": "vertical",
      "surface_type": "wall",
      "confidence": 0.75,
      "reasoning": "Empty unobstructed wall section behind subject, in focus",
      "lighting_direction": "top",
      "lighting_intensity": 0.6,
      "camera_angle": "eye-level"
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

/** Parse ISO 8601 duration ("PT1H46M2S", "PT30M", "PT45S") to seconds.
 *  Returns null if the input isn't a valid ISO 8601 duration. YouTube's
 *  Data API returns durations in this format and we store them verbatim
 *  on video_index.duration. Supports: hours (H), minutes (M), seconds (S);
 *  ignores days/weeks since YT durations don't use them. */
function parseIsoDuration(input: string | null | undefined): number | null {
  if (!input || typeof input !== "string") return null;
  // Plain seconds (already-numeric) — accept e.g. "2760"
  const numeric = Number(input);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const m = input.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return null;
  const hours = parseInt(m[1] || "0", 10);
  const minutes = parseInt(m[2] || "0", 10);
  const seconds = parseFloat(m[3] || "0");
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

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
  outputDir: string,
  opts: { intervalSeconds?: number; maxFrames?: number } = {},
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const intervalSeconds = opts.intervalSeconds ?? CONFIG.FRAME_INTERVAL_SECONDS;
    const maxFrames = opts.maxFrames ?? CONFIG.MAX_FRAMES_PER_VIDEO;
    const absoluteVideoPath = path.resolve(videoPath);
    const absoluteOutputDir = path.resolve(outputDir);
    const outputPattern = path.join(absoluteOutputDir, "frame_%04d.jpg");

    console.log(`[Scanner V2] Extracting frames from: ${absoluteVideoPath}`);
    console.log(`[Scanner V2] Output directory: ${absoluteOutputDir}`);
    console.log(`[Scanner V2] Plan: every ${intervalSeconds}s, up to ${maxFrames} frames`);

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
      "-vf", `fps=1/${intervalSeconds},scale='min(${CONFIG.FRAME_MAX_DIMENSION},iw)':'min(${CONFIG.FRAME_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`,
      "-q:v", "2",
      "-frames:v", maxFrames.toString(),
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

/**
 * Extract one frame at each requested timestamp. Used by the scene-first
 * scan path — instead of sampling the video uniformly every N seconds, we
 * sample at the midpoints of representative shots per unique scene.
 *
 * Returns parallel arrays so the caller can map frame[i] → its real
 * timestamp (vs. extractFrames where timestamp = i × interval).
 */
async function extractFramesAtTimestamps(
  videoPath: string,
  outputDir: string,
  timestamps: number[],
): Promise<{ frames: string[]; timestamps: number[] }> {
  const absoluteVideoPath = path.resolve(videoPath);
  const absoluteOutputDir = path.resolve(outputDir);
  fs.mkdirSync(absoluteOutputDir, { recursive: true });

  const out: { frames: string[]; timestamps: number[] } = { frames: [], timestamps: [] };

  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    const outPath = path.join(absoluteOutputDir, `scene_frame_${i.toString().padStart(4, "0")}.jpg`);

    const ok = await new Promise<boolean>((resolve) => {
      // -ss BEFORE -i = fast input seek (decoder skips most of the file).
      // 480 max dim is plenty for Gemini surface detection and saves bytes.
      const ff = spawn("ffmpeg", [
        "-nostdin",
        "-y",
        "-loglevel", "error",
        "-ss", String(Math.max(0, t)),
        "-i", absoluteVideoPath,
        "-an",
        "-frames:v", "1",
        "-pix_fmt", "yuvj420p",
        "-vf", `scale='min(${CONFIG.FRAME_MAX_DIMENSION},iw)':'min(${CONFIG.FRAME_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`,
        "-q:v", "2",
        outPath,
      ]);
      let stderr = "";
      ff.stderr.on("data", (d) => { stderr += d.toString(); });
      const tm = setTimeout(() => {
        try { ff.kill("SIGKILL"); } catch {}
        console.warn(`[Scanner V2] Timestamp extract t=${t}s timed out`);
        resolve(false);
      }, 60_000);
      ff.on("close", (code) => {
        clearTimeout(tm);
        if (code === 0 && fs.existsSync(outPath)) {
          resolve(true);
        } else {
          if (stderr) {
            console.warn(`[Scanner V2] Timestamp extract t=${t}s failed: ${stderr.slice(-150)}`);
          }
          resolve(false);
        }
      });
      ff.on("error", (err) => {
        clearTimeout(tm);
        console.warn(`[Scanner V2] Timestamp extract spawn error t=${t}s: ${err.message}`);
        resolve(false);
      });
    });

    if (ok) {
      out.frames.push(outPath);
      out.timestamps.push(t);
    }
  }

  console.log(`[Scanner V2] Scene-first extraction: ${out.frames.length}/${timestamps.length} frames at requested timestamps`);
  return out;
}

/**
 * Extract frames directly from a remote CDN URL via ffmpeg HTTP-range seeking —
 * no full download, nothing written to disk except the sampled frame JPGs.
 *
 * This is the OAuth stream-and-scan path: for each timestamp, ffmpeg opens the
 * URL, issues an HTTP range request to seek near that timestamp (`-ss` before
 * `-i` = fast input seek), decodes one frame, and stops. For a well-indexed
 * progressive mp4 that pulls only the bytes around each frame, not the whole
 * video. `-reconnect*` flags make it resilient to the transient drops that CDN
 * range reads occasionally hit.
 */
async function extractFramesFromUrl(
  source: StreamSource,
  outputDir: string,
  timestamps: number[],
): Promise<{ frames: string[]; timestamps: number[] }> {
  const absoluteOutputDir = path.resolve(outputDir);
  fs.mkdirSync(absoluteOutputDir, { recursive: true });

  const out: { frames: string[]; timestamps: number[] } = { frames: [], timestamps: [] };
  const headerArg = source.headers
    ? Object.entries(source.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n"
    : null;

  let consecutiveFailures = 0;
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    const outPath = path.join(absoluteOutputDir, `stream_frame_${i.toString().padStart(4, "0")}.jpg`);

    const ok = await new Promise<boolean>((resolve) => {
      const args = [
        "-nostdin",
        "-y",
        "-loglevel", "error",
        // Resilience for CDN range reads.
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
      ];
      if (headerArg) args.push("-headers", headerArg);
      args.push(
        "-ss", String(Math.max(0, t)),   // fast input seek — range-request to ~t
        "-i", source.url,
        "-an",
        "-frames:v", "1",
        "-pix_fmt", "yuvj420p",
        "-vf", `scale='min(${CONFIG.FRAME_MAX_DIMENSION},iw)':'min(${CONFIG.FRAME_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`,
        "-q:v", "2",
        outPath,
      );
      const ff = spawn("ffmpeg", args);
      let stderr = "";
      ff.stderr.on("data", (d) => { stderr += d.toString(); });
      const tm = setTimeout(() => {
        try { ff.kill("SIGKILL"); } catch {}
        console.warn(`[Scanner V2] Stream extract t=${t}s timed out`);
        resolve(false);
      }, 60_000);
      ff.on("close", (code) => {
        clearTimeout(tm);
        if (code === 0 && fs.existsSync(outPath)) {
          resolve(true);
        } else {
          if (stderr) console.warn(`[Scanner V2] Stream extract t=${t}s failed: ${stderr.slice(-160)}`);
          resolve(false);
        }
      });
      ff.on("error", (err) => {
        clearTimeout(tm);
        console.warn(`[Scanner V2] Stream extract spawn error t=${t}s: ${err.message}`);
        resolve(false);
      });
    });

    if (ok) {
      out.frames.push(outPath);
      out.timestamps.push(t);
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      // If the first several seeks all fail, the URL is unusable (expired,
      // DASH-only, geo-blocked). Bail early so we fall through to the download
      // fallback instead of grinding through 24 timeouts.
      if (consecutiveFailures >= 3 && out.frames.length === 0) {
        console.warn(`[Scanner V2] Stream extraction: ${consecutiveFailures} consecutive failures with 0 frames — aborting stream path`);
        break;
      }
    }
  }

  console.log(`[Scanner V2] Stream extraction: ${out.frames.length}/${timestamps.length} frames pulled from CDN URL`);
  return out;
}

/**
 * Detect scene-cut timestamps in a video using ffmpeg's scene filter.
 *
 * Why: When the camera cuts to a different shot (e.g. wide podcast room →
 * solo close-up), surfaces from one shot shouldn't merge with surfaces
 * from the next, and product placements made in shot A shouldn't render
 * in shot B. This function returns the timestamps (seconds) of detected
 * cuts so downstream code can group surfaces by shot.
 *
 * Approach: ffmpeg's `select=gt(scene,N)` filter computes the per-frame
 * scene-change probability (0-1, based on histogram diff between frames);
 * when it crosses N (default 0.3), ffmpeg flags it as a cut. We pipe the
 * showinfo output to stderr and parse `pts_time:` lines.
 *
 * Returns: sorted array of seconds, e.g. [12.5, 28.0, 45.2]. Always
 * includes 0 implicitly as the start of the first shot — callers can
 * prepend if needed. Empty array means no cuts detected (single shot).
 *
 * Cost: one extra ffmpeg pass over the video. ~10-20% of extract time.
 * Acceptable since we already have the file local at this point.
 */
async function detectSceneCuts(
  videoPath: string,
  threshold: number = 0.3,
): Promise<number[]> {
  return new Promise((resolve) => {
    const absoluteVideoPath = path.resolve(videoPath);
    if (!fs.existsSync(absoluteVideoPath)) {
      console.warn(`[Scene Cuts] Video not found: ${absoluteVideoPath}`);
      resolve([]);
      return;
    }

    // -vf "select='gt(scene,T)',showinfo" prints info for each detected cut.
    // -an drops audio (faster). -f null discards the output (we only want stderr).
    const args = [
      "-nostdin",
      "-i", absoluteVideoPath,
      "-an",
      "-vf", `select='gt(scene,${threshold})',showinfo`,
      "-f", "null",
      "-",
    ];

    console.log(`[Scene Cuts] Detecting cuts (threshold=${threshold}) in ${absoluteVideoPath}`);
    const ffmpeg = spawn("ffmpeg", args);

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => { stderr += data.toString(); });

    // Cap at 5 minutes — even multi-GB videos shouldn't take longer for
    // detection-only (no encode). If it does, return empty + log.
    const timeout = setTimeout(() => {
      try { ffmpeg.kill("SIGKILL"); } catch {}
      console.warn(`[Scene Cuts] Timed out after 5min — returning empty cut list`);
      resolve([]);
    }, 5 * 60 * 1000);

    ffmpeg.on("close", () => {
      clearTimeout(timeout);
      // showinfo lines look like: "[Parsed_showinfo_1 @ 0x...] n: 0 pts: ... pts_time:12.5 ..."
      // We extract the pts_time values.
      const cuts: number[] = [];
      const re = /pts_time:(\d+(?:\.\d+)?)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stderr)) !== null) {
        const t = parseFloat(m[1]);
        if (Number.isFinite(t) && t > 0) cuts.push(t);
      }
      // Dedup + sort (shouldn't have duplicates but be safe).
      const sorted = Array.from(new Set(cuts)).sort((a, b) => a - b);
      console.log(`[Scene Cuts] Detected ${sorted.length} cut(s): ${sorted.slice(0, 10).map(t => t.toFixed(1)).join(", ")}${sorted.length > 10 ? " ..." : ""}`);
      resolve(sorted);
    });

    ffmpeg.on("error", (err) => {
      clearTimeout(timeout);
      console.warn(`[Scene Cuts] ffmpeg spawn failed (non-fatal):`, err?.message || err);
      resolve([]);
    });
  });
}

/**
 * Given a sorted list of scene-cut timestamps and a target timestamp,
 * return the 0-indexed scene block ID. Block N covers [cuts[N-1], cuts[N]),
 * with block 0 starting at 0. Out-of-range timestamps clamp to the last
 * block. Used downstream to constrain clusterSurfaces so the same
 * "Coffee Table" detection in two different shots doesn't merge.
 */
function sceneBlockForTimestamp(cuts: number[], t: number): number {
  if (cuts.length === 0 || t < 0) return 0;
  // cuts are start-of-new-shot. If t < cuts[0], block 0.
  // If cuts[i-1] <= t < cuts[i], block i.
  for (let i = 0; i < cuts.length; i++) {
    if (t < cuts[i]) return i;
  }
  return cuts.length;
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
 * IoU (intersection over union) between two normalized bounding boxes.
 * Both boxes use {x, y, width, height} in 0-1 space.
 */
function bboxIoU(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const interX1 = Math.max(a.x, b.x);
  const interY1 = Math.max(a.y, b.y);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);
  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;
  const aArea = a.width * a.height;
  const bArea = b.width * b.height;
  const union = aArea + bArea - interArea;
  if (union <= 0) return 0;
  return interArea / union;
}

/**
 * Remove overlapping surface detections, keeping the higher-confidence one.
 *
 * Per-frame NMS: when two boxes overlap heavily (IoU > 0.4) OR have very close
 * centers AND the same surface type, they describe the same physical surface
 * and we keep the higher-confidence one. The previous y-center-only check
 * missed the green+blue duplicate case where two coffee_table detections
 * landed on the same actual coffee table with slightly different bboxes.
 */
function deduplicateSurfaces(surfaces: DetectedSurface[]): DetectedSurface[] {
  if (surfaces.length <= 1) return surfaces;

  const sorted = [...surfaces].sort((a, b) => b.confidence - a.confidence);
  const kept: DetectedSurface[] = [];

  const IOU_THRESHOLD = 0.4;
  const CENTER_DIST_THRESHOLD = 0.12;

  const canonical = (t: string) => SURFACE_TYPE_SYNONYMS[t.toLowerCase()] || t;

  for (const surface of sorted) {
    const sType = canonical(surface.surfaceType);
    const sCenterX = surface.boundingBox.x + surface.boundingBox.width / 2;
    const sCenterY = surface.boundingBox.y + surface.boundingBox.height / 2;

    const overlaps = kept.some(k => {
      const kType = canonical(k.surfaceType);
      const kCenterX = k.boundingBox.x + k.boundingBox.width / 2;
      const kCenterY = k.boundingBox.y + k.boundingBox.height / 2;
      const centerDist = Math.hypot(sCenterX - kCenterX, sCenterY - kCenterY);
      const iou = bboxIoU(surface.boundingBox, k.boundingBox);
      // Drop if same canonical type AND (high IoU OR very close centers)
      const sameType = sType === kType;
      return (sameType && iou > IOU_THRESHOLD) || (sameType && centerDist < CENTER_DIST_THRESHOLD);
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

    // Infer orientation from surface_type if Gemini didn't provide it explicitly.
    // Vertical types: walls, doors, windows. Everything else is horizontal.
    const inferOrientation = (surfaceType: string): "horizontal" | "vertical" => {
      const t = surfaceType.toLowerCase();
      if (t === "wall" || t === "door" || t === "window") return "vertical";
      return "horizontal";
    };

    // Sanity-correct Gemini's worst label mistakes BEFORE filtering. The
    // most common one we've seen: backdrops/walls behind subjects in
    // podcast scenes get labeled "studio_desk" or "table" because Gemini
    // sees brand-placement-shape but doesn't verify it's actually a
    // horizontal surface. Re-label these as "wall" so downstream code +
    // brand-side displays see the right surface type.
    const correctMislabel = (s: GeminiDetectedSurface): GeminiDetectedSurface => {
      const claimedType = s.surface_type.toLowerCase();
      const claimedOrientation = s.orientation || inferOrientation(s.surface_type);
      // Only inspect surfaces Gemini called horizontal (desks, tables, etc.)
      if (claimedOrientation !== "horizontal") return s;
      const bbY = s.location.y / 100;
      const bbH = s.location.height / 100;
      const centerY = bbY + bbH / 2;
      // Common mislabel: bbox center is in the top 40% of the frame AND
      // the bbox is reasonably tall (>25% frame height). Real horizontal
      // surfaces at eye level are thin strips in the lower half; anything
      // tall + high in the frame is almost certainly a wall/backdrop.
      const isUpperHalf = centerY < 0.40;
      const isTall = bbH > 0.25;
      // Shelves are exempt — they legitimately appear high in the frame
      const isShelf = claimedType.includes("shelf");
      if (!isShelf && isUpperHalf && isTall) {
        console.log(`[Gemini] LABEL CORRECTION: ${s.surface_type} → wall (bbox center y=${(centerY*100).toFixed(0)}%, h=${(bbH*100).toFixed(0)}% — likely a wall, not a horizontal surface)`);
        return { ...s, surface_type: "wall", orientation: "vertical" };
      }
      return s;
    };

    // Map Gemini surfaces, filter low-confidence, validate against ghost patterns.
    // Up to 3 surfaces per frame, mixing horizontal (product placement) and
    // vertical (poster/signage). Ghost filters apply only to horizontal — walls
    // legitimately occupy the upper frame and span large vertical areas.
    const allSurfaces: DetectedSurface[] = parsed.surfaces
      .map(correctMislabel)
      .filter((s: GeminiDetectedSurface) => s.confidence >= 0.75)
      .filter((s: GeminiDetectedSurface) => {
        const orientation = s.orientation || inferOrientation(s.surface_type);
        if (orientation === "vertical") {
          // Walls/doors/windows have different geometry — skip horizontal-surface ghost rules
          return true;
        }

        // GHOST SURFACE FILTER (horizontal only) — reject boxes that likely overlap a person's body
        const bbX = s.location.x / 100;
        const bbY = s.location.y / 100;
        const bbW = s.location.width / 100;
        const bbH = s.location.height / 100;
        const centerX = bbX + bbW / 2;
        const centerY = bbY + bbH / 2;
        const area = bbW * bbH;
        const surfTypeLower = s.surface_type.toLowerCase();
        const isFloor = surfTypeLower.includes('floor');

        // Ghost pattern 1: small box centered on person's torso area
        const isInPersonZone = centerX > 0.20 && centerX < 0.80 && centerY > 0.15 && centerY < 0.55;
        const isSmallArea = area < 0.10;
        if (isInPersonZone && isSmallArea) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — bbox center (${(centerX*100).toFixed(0)}%, ${(centerY*100).toFixed(0)}%) in person zone, small area ${(area*100).toFixed(1)}%`);
          return false;
        }

        // Ghost pattern 2: tall box overlapping person center (real eye-level tables are thin)
        // Center frame: 0.25-0.75. Real eye-level tables are < 25% tall horizontal strips.
        if (bbH > 0.25 && centerY < 0.55 && centerX > 0.25 && centerX < 0.75) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — tall bbox (h=${(bbH*100).toFixed(0)}%) centered on person area`);
          return false;
        }

        // Ghost pattern 2b: tall box on a SIDE-OF-FRAME person (the Shay Shay case).
        // In two-host podcast frames, hosts sit at the LEFT (x ~0-0.30) and RIGHT
        // (x ~0.70-1.0) of frame. Gemini sometimes calls a leather chair seat or
        // a person's torso/lap/legs a "coffee_table" because it sees a flat-ish
        // tone. Real coffee tables in these frames sit in the MIDDLE of frame
        // between the two hosts — never against the left or right edge.
        // Reject any horizontal-surface bbox whose center is in the outer thirds
        // AND is taller than a real eye-level table strip (>20% frame height).
        // Floor surfaces are exempt — floor space at someone's feet legitimately
        // sits at the side of frame.
        const isInSidePersonZone = !isFloor && (centerX < 0.30 || centerX > 0.70) && centerY > 0.10 && centerY < 0.85;
        if (isInSidePersonZone && bbH > 0.20) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — tall bbox (h=${(bbH*100).toFixed(0)}%) at side-of-frame person zone (cx=${(centerX*100).toFixed(0)}%)`);
          return false;
        }

        // Ghost pattern 2c: bbox spans most of frame height — that's a person/chair, not a table.
        // Real horizontal table-top boxes are short strips (< 25% height). Anything
        // > 30% frame height that claims to be horizontal is a hallucinated
        // bound-box around a person or piece of vertical furniture. Tightened
        // from 0.35 → 0.30 because Gemini was returning 0.30-0.34 height
        // bboxes around seated podcast hosts (torso to ankles) that survived.
        if (!isFloor && bbH > 0.30) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — bbox too tall for a horizontal surface (h=${(bbH*100).toFixed(0)}%, max 30%)`);
          return false;
        }

        // Ghost pattern 3: horizontal surface entirely in upper frame (shelves exempt)
        const isShelf = surfTypeLower.includes('shelf');
        if (!isShelf && bbY + bbH < 0.40) {
          console.log(`[Gemini] GHOST FILTER: Rejected ${s.surface_type} — bbox entirely in upper frame (bottom at ${((bbY+bbH)*100).toFixed(0)}%)`);
          return false;
        }

        return true;
      })
      .map((s: GeminiDetectedSurface) => ({
        surfaceType: s.surface_type.charAt(0).toUpperCase() + s.surface_type.slice(1),
        orientation: s.orientation || inferOrientation(s.surface_type),
        confidence: s.confidence,
        boundingBox: {
          x: s.location.x / 100,
          y: s.location.y / 100,
          width: s.location.width / 100,
          height: s.location.height / 100,
        },
        timestamp,
        lightingDirection: s.lighting_direction || undefined,
        lightingIntensity: typeof s.lighting_intensity === 'number' ? s.lighting_intensity : undefined,
        cameraAngle: s.camera_angle || undefined,
      }))
      .sort((a: DetectedSurface, b: DetectedSurface) => b.confidence - a.confidence)
      .slice(0, 4); // Max 4 surfaces per frame (was 2) — recall complex scenes
                    // (shelves + tables + floor + wall) without dropping real
                    // surfaces. Per-frame dedup + cluster IoU still merge
                    // duplicates of the same physical surface downstream.

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
    
  } catch (err: any) {
    // Log detailed error info to diagnose production issues (API key, base URL, connectivity)
    const errMsg = err?.message || String(err);
    const errStatus = err?.status || err?.statusCode || 'unknown';
    const errBody = err?.body || err?.response?.data || '';
    console.error(`[Gemini] Frame analysis error at ${timestamp}s: ${errMsg}`);
    console.error(`[Gemini] Error details — status: ${errStatus}, body: ${typeof errBody === 'string' ? errBody.substring(0, 300) : JSON.stringify(errBody).substring(0, 300)}`);
    console.error(`[Gemini] Base URL: ${process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || '(not set)'}, API key set: ${!!process.env.AI_INTEGRATIONS_GEMINI_API_KEY}`);

    // Re-throw rate limit errors so the retry wrapper can catch and backoff
    const bodyStr = typeof errBody === 'string' ? errBody : JSON.stringify(errBody);
    const is429 = errStatus === 429 || errStatus === '429' ||
                  errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit') ||
                  errMsg.toLowerCase().includes('resource_exhausted') ||
                  bodyStr.includes('RESOURCE_EXHAUSTED') || bodyStr.includes('429');
    if (is429) {
      const rateLimitErr: any = new Error(`Gemini rate limited at ${timestamp}s`);
      rateLimitErr.status = 429;
      rateLimitErr.isRateLimit = true;
      throw rateLimitErr;
    }

    return defaultResult;
  }
}

/**
 * Call analyzeFrameWithGemini with exponential backoff on 429 rate limit errors.
 * Returns the default empty result after all retries are exhausted.
 */
async function analyzeFrameWithGeminiRetry(
  framePath: string,
  timestamp: number,
  isDense: boolean = false,
  maxRetries: number = 5
): Promise<any> {
  const defaultResult = {
    surfaces: [],
    isVertical: false,
    aiAnalyzed: true,
  };
  let lastErr: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await analyzeFrameWithGemini(framePath, timestamp, isDense);
    } catch (err: any) {
      lastErr = err;
      if (!err.isRateLimit) {
        // Non-rate-limit errors already return defaultResult inside analyzeFrameWithGemini
        return defaultResult;
      }
      if (attempt < maxRetries) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s (capped)
        const backoffMs = Math.min(2000 * Math.pow(2, attempt), 32000);
        console.log(`[Gemini] Rate limited at ${timestamp}s — retry ${attempt + 1}/${maxRetries} in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }
  console.error(`[Gemini] Rate limit retries exhausted at ${timestamp}s — returning empty`);
  return defaultResult;
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

  // Group surfaces by rounded timestamp — matches the scanner's filename
  // convention (Math.round(t) under scene-first sampling). Math.floor was
  // here previously and lost every scene-first surface whose timestamp
  // landed >= x.5s (e.g. 64.5s → looked for "frame_64s.jpg" but scanner
  // saved "frame_65s.jpg"). Math.round is uniform-scan-compatible too —
  // integer timestamps round to themselves.
  const timestampMap = new Map<number, typeof surfaces>();
  for (const surface of surfaces) {
    const ts = Math.round(Number(surface.timestamp));
    if (!timestampMap.has(ts)) {
      timestampMap.set(ts, []);
    }
    timestampMap.get(ts)!.push(surface);
  }

  console.log(`[FullScale Edge Context] ${surfaces.length} surfaces across ${timestampMap.size} unique timestamps`);

  let enrichedCount = 0;

  for (const [timestamp, surfacesAtTime] of Array.from(timestampMap.entries())) {
    // Try the canonical filename first (Math.round of timestamp), then
    // fall back to Math.floor for legacy surfaces from older scans whose
    // frames were saved with the floor convention.
    const candidates = [
      `frame_${timestamp}s.jpg`,
      `frame_${Math.floor(Number(surfacesAtTime[0].timestamp))}s.jpg`,
    ];
    let framePath = "";
    for (const fn of candidates) {
      const p = path.join(permanentFramesDir, fn);
      if (fs.existsSync(p)) { framePath = p; break; }
    }

    if (!framePath) {
      console.log(`[FullScale Edge Context] Frame not found in ${permanentFramesDir} (tried ${candidates.join(", ")}), skipping`);
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
// PHASE 2A: SURFACE KEYFRAME CAPTURE — Preserve Raw Per-Frame Bounding Boxes
// ============================================================================
//
// Before normalization overwrites all bboxes with the median, we capture each
// surface's raw per-frame position as a "keyframe". During remix clip generation,
// these keyframes are used for smooth spline interpolation so placed products
// follow natural camera movement instead of sitting static.
//
// Keyframes are linked to the canonical surface ID from each cluster, enabling
// N-point motion tracking per surface across the clip's time range.

async function captureSurfaceKeyframes(videoId: number): Promise<void> {
  console.log(`[Keyframes] Capturing raw per-frame bounding boxes for video ${videoId}`);

  const surfaces = await storage.getDetectedSurfaces(videoId);
  const validSurfaces = surfaces.filter(
    (s) => s.surfaceType !== "Filtered" && s.surfaceType !== "Potential Surface"
  );

  if (validSurfaces.length === 0) {
    console.log(`[Keyframes] No valid surfaces to capture`);
    return;
  }

  // Load this video's scene-cut timestamps so cross-shot surfaces don't
  // cluster together. A coffee table in shot A and a coffee table in shot B
  // are different objects even if their bboxes look similar.
  let sceneCuts: number[] = [];
  try {
    const video = await storage.getVideoById(videoId);
    const raw = (video as any)?.sceneBoundaries;
    if (Array.isArray(raw)) sceneCuts = raw.filter(t => typeof t === "number" && Number.isFinite(t));
  } catch { /* ignore */ }

  // Cluster surfaces to identify which ones represent the same physical surface
  // Use the same clustering logic as normalization
  const clusters = clusterSurfaces(validSurfaces as any, sceneCuts);
  console.log(`[Keyframes] Found ${clusters.length} cluster(s) across ${validSurfaces.length} surfaces (scene cuts: ${sceneCuts.length})`);

  const keyframeBatch: Array<{
    surfaceId: number;
    videoId: number;
    timestamp: string;
    boundingBoxX: string;
    boundingBoxY: string;
    boundingBoxWidth: string;
    boundingBoxHeight: string;
    confidence: string;
  }> = [];

  for (const cluster of clusters) {
    if (cluster.surfaces.length === 0) continue;

    // The canonical surface is the highest-confidence one in the cluster
    const canonical = cluster.surfaces.reduce((best, s) =>
      s.confidence > best.confidence ? s : best
    );
    const canonicalId = canonical.id;

    // Create a keyframe for EVERY surface in the cluster, linked to the canonical ID
    // Each surface entry represents a different timestamp (frame)
    for (const member of cluster.surfaces) {
      // Find the original surface record to get the timestamp
      const original = validSurfaces.find((s) => s.id === member.id);
      if (!original) continue;

      keyframeBatch.push({
        surfaceId: canonicalId,
        videoId,
        timestamp: String(original.timestamp),
        boundingBoxX: member.bbX.toFixed(6),
        boundingBoxY: member.bbY.toFixed(6),
        boundingBoxWidth: member.bbW.toFixed(6),
        boundingBoxHeight: member.bbH.toFixed(6),
        confidence: member.confidence.toFixed(4),
      });
    }

    console.log(
      `[Keyframes] Cluster "${cluster.surfaceType}" → ${cluster.surfaces.length} keyframe(s) linked to surface #${canonicalId}`
    );
  }

  // Bulk insert all keyframes
  if (keyframeBatch.length > 0) {
    await storage.bulkInsertSurfaceKeyframes(keyframeBatch);
    console.log(`[Keyframes] Saved ${keyframeBatch.length} keyframes for video ${videoId}`);
  }
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

// Normalize surface type synonyms to a canonical name
// e.g., "Studio_desk", "studio_desk", "desk", "table" all → "Table"
const SURFACE_TYPE_SYNONYMS: Record<string, string> = {
  desk: "Table",
  table: "Table",
  studio_desk: "Table",
  "studio desk": "Table",
  counter: "Counter",
  countertop: "Counter",
  kitchen_counter: "Counter",
  shelf: "Shelf",
  bookshelf: "Shelf",
  nightstand: "Nightstand",
  side_table: "Nightstand",
  coffee_table: "Coffee Table",
};

function canonicalSurfaceType(type: string): string {
  const lower = type.toLowerCase().trim();
  return SURFACE_TYPE_SYNONYMS[lower] || type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Cluster surfaces by CANONICAL type and spatial proximity.
 * Two surfaces join the same cluster if:
 * - Same canonical type (Table/Desk/Studio_desk all merge)
 * - IoU > 0.30 against ANY existing surface in the cluster, OR
 * - Bounding box centers are within CLUSTER_TOLERANCE of each other (fallback for thin strips)
 *
 * IoU-against-all-members fixes the green+blue duplicate case: when bboxes
 * drift across frames, the rolling cluster member chain merges them into
 * one cluster instead of breaking off a new one.
 */
function clusterSurfaces(
  surfaces: Array<{ id: number; surfaceType: string; timestamp?: string | number; boundingBoxX: string; boundingBoxY: string; boundingBoxWidth: string; boundingBoxHeight: string; confidence: string; sceneId?: number | null }>,
  sceneCuts: number[] = [],
): SurfaceCluster[] {
  const CLUSTER_TOLERANCE = 0.18; // L∞ center distance (fallback)
  const IOU_MERGE = 0.30;

  const clusters: (SurfaceCluster & { sceneKey?: number })[] = [];

  for (const s of surfaces) {
    const bbX = parseFloat(s.boundingBoxX);
    const bbY = parseFloat(s.boundingBoxY);
    const bbW = parseFloat(s.boundingBoxWidth);
    const bbH = parseFloat(s.boundingBoxHeight);
    const centerX = bbX + bbW / 2;
    const centerY = bbY + bbH / 2;
    const canonical = canonicalSurfaceType(s.surfaceType);
    const candidateBox = { x: bbX, y: bbY, width: bbW, height: bbH };
    // Scene key — prefer the persisted sceneId (from sceneIndex's perceptual
    // clustering), fall back to per-shot sceneBlock for surfaces that were
    // detected before scene-first indexing shipped. Two surfaces with the
    // same sceneId are in the same physical scene (host shot returns), so
    // cross-shot clustering IS allowed there. Different sceneId = different
    // room = never cluster.
    const ts = typeof s.timestamp === "number" ? s.timestamp : parseFloat(String(s.timestamp ?? 0));
    const sceneKey = (typeof s.sceneId === "number")
      ? s.sceneId
      : sceneBlockForTimestamp(sceneCuts, Number.isFinite(ts) ? ts : 0);

    let matched = false;
    for (const cluster of clusters) {
      if (canonicalSurfaceType(cluster.surfaceType) !== canonical) continue;
      // HARD GATE: different scenes never cluster.
      if (cluster.sceneKey !== undefined && cluster.sceneKey !== sceneKey) continue;

      // Match against ANY member — bboxes drift across frames so the rolling
      // chain (frame N matches N+1, N+1 matches N+2, ...) keeps the cluster
      // intact even when the first and last bboxes wouldn't match each other.
      const isMatch = cluster.surfaces.some(member => {
        const memberBox = { x: member.bbX, y: member.bbY, width: member.bbW, height: member.bbH };
        if (bboxIoU(candidateBox, memberBox) > IOU_MERGE) return true;
        const mCX = member.bbX + member.bbW / 2;
        const mCY = member.bbY + member.bbH / 2;
        return Math.abs(centerX - mCX) < CLUSTER_TOLERANCE && Math.abs(centerY - mCY) < CLUSTER_TOLERANCE;
      });

      if (isMatch) {
        cluster.surfaces.push({ id: s.id, bbX, bbY, bbW, bbH, confidence: parseFloat(s.confidence) });
        matched = true;
        break;
      }
    }

    if (!matched) {
      clusters.push({
        surfaceType: canonical,
        sceneKey,
        surfaces: [{ id: s.id, bbX, bbY, bbW, bbH, confidence: parseFloat(s.confidence) }],
      });
    }
  }

  return clusters;
}

/**
 * After clustering produces the median bboxes, two SEPARATE clusters of the
 * same canonical type can still end up overlapping (e.g. Gemini split the
 * same coffee table into two semantic groups due to confidence drift).
 * Merge clusters whose median bboxes have IoU > 0.4 — drop the
 * lower-cumulative-confidence one, mark its surfaces Filtered.
 */
async function dedupeOverlappingClusters(
  clusters: SurfaceCluster[],
  computeMedianFn: (c: SurfaceCluster['surfaces']) => { x: number; y: number; w: number; h: number },
): Promise<{ keep: SurfaceCluster[]; drop: SurfaceCluster[] }> {
  const IOU_MERGE = 0.40;
  const enriched = clusters.map(c => ({
    cluster: c,
    median: computeMedianFn(c.surfaces),
    score: c.surfaces.reduce((sum, s) => sum + s.confidence, 0),
  })).sort((a, b) => b.score - a.score);

  const keep: SurfaceCluster[] = [];
  const drop: SurfaceCluster[] = [];
  for (const e of enriched) {
    const eBox = { x: e.median.x, y: e.median.y, width: e.median.w, height: e.median.h };
    const conflict = keep.find(k => {
      if (canonicalSurfaceType(k.surfaceType) !== canonicalSurfaceType(e.cluster.surfaceType)) return false;
      const kEnriched = enriched.find(x => x.cluster === k);
      if (!kEnriched) return false;
      const kBox = { x: kEnriched.median.x, y: kEnriched.median.y, width: kEnriched.median.w, height: kEnriched.median.h };
      return bboxIoU(eBox, kBox) > IOU_MERGE;
    });
    if (conflict) {
      drop.push(e.cluster);
    } else {
      keep.push(e.cluster);
    }
  }
  return { keep, drop };
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
  // Height limits differ by orientation: horizontal surfaces (tables/desks)
  // seen at eye level are inherently thin strips (max ~40%), but vertical
  // surfaces (walls/doors/windows) legitimately span most of the frame.
  // Without per-orientation limits, every detected wall got removed as
  // "oversized" — exactly what the user just hit.
  const MIN_SURFACE_AREA = 0.03; // 3% of frame area minimum (applies to both orientations)
  const MAX_HORIZONTAL_HEIGHT = 0.40; // tables/desks at eye level
  const MAX_VERTICAL_HEIGHT = 0.95; // walls can fill almost the entire frame
  const phantomIds: number[] = [];
  for (const s of surfaces) {
    const width = parseFloat(String(s.boundingBoxWidth));
    const height = parseFloat(String(s.boundingBoxHeight));
    const area = width * height;
    const orientation = (s as any).orientation as string | null | undefined;
    // Backstop for legacy rows that pre-date the orientation field —
    // infer from surfaceType so the filter still does the right thing.
    const isVertical = orientation === "vertical"
      || ["wall", "door", "window"].includes((s.surfaceType || "").toLowerCase());
    const heightLimit = isVertical ? MAX_VERTICAL_HEIGHT : MAX_HORIZONTAL_HEIGHT;

    if (area < MIN_SURFACE_AREA) {
      phantomIds.push(s.id);
      console.log(`[Normalize] Removing phantom surface ${s.id} (${s.surfaceType}, area=${(area * 100).toFixed(1)}% < ${(MIN_SURFACE_AREA * 100)}%)`);
    } else if (height > heightLimit && s.surfaceType !== "Filtered") {
      // Bounding box exceeds the per-orientation max — likely overlaps people/floor
      phantomIds.push(s.id);
      console.log(`[Normalize] Removing oversized ${isVertical ? "vertical" : "horizontal"} surface ${s.id} (${s.surfaceType}, height=${(height * 100).toFixed(1)}% > ${(heightLimit * 100)}%)`);
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

  // Step 2: Cluster remaining valid surfaces. Pass scene cuts so cross-shot
  // surfaces don't merge — same rationale as captureSurfaceKeyframes.
  const validSurfaces = surfaces.filter(s => !phantomIds.includes(s.id));
  let sceneCuts: number[] = [];
  try {
    const video = await storage.getVideoById(videoId);
    const raw = (video as any)?.sceneBoundaries;
    if (Array.isArray(raw)) sceneCuts = raw.filter(t => typeof t === "number" && Number.isFinite(t));
  } catch { /* ignore */ }
  const clusters = clusterSurfaces(validSurfaces as any, sceneCuts);

  console.log(`[Normalize] Found ${clusters.length} cluster(s) from ${validSurfaces.length} surfaces (scene cuts: ${sceneCuts.length})`);

  // Step 2b: Drop overlapping clusters of the same canonical type. clusterSurfaces
  // groups by IoU/center-distance against members, but two clusters of the same
  // type can still drift far enough apart that no individual member matches —
  // their MEDIANS, however, can still overlap heavily. This pass catches the
  // green+blue duplicate case where Gemini split one real coffee table into two
  // semantic groups across many frames.
  const { keep: keptClusters, drop: droppedClusters } = await dedupeOverlappingClusters(clusters, computeMedianBBox);
  if (droppedClusters.length > 0) {
    console.log(`[Normalize] Dropping ${droppedClusters.length} overlapping cluster(s) of duplicate type`);
    for (const cluster of droppedClusters) {
      for (const surface of cluster.surfaces) {
        try {
          await storage.updateDetectedSurface(surface.id, {
            surfaceType: "Filtered",
            sceneContext: `Removed: duplicate ${cluster.surfaceType} cluster overlapping a stronger one`,
          });
        } catch (err) {
          console.warn(`[Normalize] Failed to filter duplicate cluster surface ${surface.id}:`, err);
        }
      }
    }
  }

  // Step 3: For each kept cluster with 2+ surfaces, compute median bbox and update all
  let normalizedCount = 0;
  for (const cluster of keptClusters) {
    if (cluster.surfaces.length < 2) continue;

    const medianBox = computeMedianBBox(cluster.surfaces);
    console.log(`[Normalize] Cluster "${cluster.surfaceType}" (${cluster.surfaces.length} surfaces) → median bbox: x=${(medianBox.x * 100).toFixed(1)}%, y=${(medianBox.y * 100).toFixed(1)}%, w=${(medianBox.w * 100).toFixed(1)}%, h=${(medianBox.h * 100).toFixed(1)}%`);

    for (const surface of cluster.surfaces) {
      try {
        await storage.updateDetectedSurface(surface.id, {
          surfaceType: cluster.surfaceType, // Normalize name (e.g., "Studio_desk" → "Table")
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

  console.log(`[Normalize] Normalized ${normalizedCount} surfaces across ${keptClusters.length} cluster(s)`);
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
async function groupSurfacesTemporally(
  videoId: number,
  intervalHint: number = CONFIG.FRAME_INTERVAL_SECONDS,
): Promise<void> {
  console.log(`[Temporal] Starting temporal grouping for video ${videoId} (interval hint: ${intervalHint}s)`);

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
    // "Consecutive" means within 1.5× the actual scan interval. With the
    // sliding-scale plan, intervals can be 2-5s — using a hard-coded
    // CONFIG.FRAME_INTERVAL_SECONDS (=2) here would mark every 4-5s gap
    // as non-consecutive, fragmenting tracks into one-frame slivers and
    // filtering 95%+ of detections.
    const isConsecutive = timeDiff <= intervalHint * 1.5;

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
    const duration = track.endTime - track.startTime + intervalHint;
    console.log(`[Temporal]   ${track.surfaceType}: ${track.startTime}s - ${track.endTime}s (${duration}s, ${track.surfaces.length} frames, ${(track.avgConfidence * 100).toFixed(0)}% avg confidence)`);
  }

  if (tracks.length <= 1) {
    console.log(`[Temporal] Only 1 track, no filtering needed`);
    // Store temporal range in scene_context for the surfaces in this track
    if (tracks.length === 1) {
      const track = tracks[0];
      const duration = track.endTime - track.startTime + intervalHint;
      const contextNote = `Visible: ${track.startTime}s - ${track.endTime + intervalHint}s (${duration}s)`;
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
    const duration = track.endTime - track.startTime + intervalHint;
    // Score = duration (in seconds) * average confidence
    const score = duration * track.avgConfidence;
    return { ...track, score, duration };
  }).sort((a, b) => b.score - a.score);

  // Keep the best track PER surface type (not one global best). Previously
  // this kept only the single best across all types, which deleted walls
  // when a desk track scored higher (and vice versa). With the new "max 3
  // surfaces per frame, walls + tables + windows" model, each distinct
  // type should retain its best track. Result: one Wall track, one Coffee
  // Table track, one Window track — not one of those, all gone.
  const bestPerType = new Map<string, typeof scoredTracks[0]>();
  for (const t of scoredTracks) {
    const key = t.surfaceType.toLowerCase();
    const existing = bestPerType.get(key);
    if (!existing || t.score > existing.score) {
      bestPerType.set(key, t);
    }
  }
  const keepIds = new Set<number>();
  const winningTracks = Array.from(bestPerType.values());
  for (const t of winningTracks) {
    console.log(`[Temporal] Keeping ${t.surfaceType}: ${t.startTime}s - ${t.endTime}s (${t.duration}s, score=${t.score.toFixed(2)})`);
    const contextNote = `Visible: ${t.startTime}s - ${t.endTime + intervalHint}s (${t.duration}s)`;
    for (const s of t.surfaces) {
      keepIds.add(s.id);
      try {
        await storage.updateDetectedSurface(s.id, { sceneContext: contextNote });
      } catch (err) { /* non-fatal */ }
    }
  }

  // Filter out surfaces NOT in any winning per-type track. These are
  // weaker secondary tracks of the same type as a winning one (e.g. a
  // brief 2-frame wall detection in a different camera angle when the
  // primary wall track has 11 frames).
  for (const track of scoredTracks) {
    if (track.surfaces.every(s => keepIds.has(s.id))) continue; // entirely a winner
    for (const s of track.surfaces) {
      if (keepIds.has(s.id)) continue;
      const winner = bestPerType.get(track.surfaceType.toLowerCase());
      const winnerLabel = winner ? `${winner.surfaceType} (${winner.duration}s)` : "best track";
      console.log(`[Temporal] Filtering surface ${s.id} (${track.surfaceType}, ${track.duration}s) — winning ${track.surfaceType} track is ${winnerLabel}`);
      try {
        await storage.updateDetectedSurface(s.id, {
          surfaceType: "Filtered",
          sceneContext: `Removed: weaker ${track.surfaceType} track (${track.duration}s) — best is ${winnerLabel}`,
        });
      } catch (err) {
        console.warn(`[Temporal] Failed to filter surface ${s.id}:`, err);
      }
    }
  }

  console.log(`[Temporal] Kept ${keepIds.size} surfaces across ${bestPerType.size} type-tracks, filtered ${validSurfaces.length - keepIds.size}`);
}

// ============================================================================
// MAIN SCAN FUNCTIONS
// ============================================================================

// Single-flight lock per videoId. Prevents stacked scans when the user clicks
// the Scan button repeatedly while a scan is already running. Subsequent calls
// for the same videoId join the in-flight promise rather than starting a new
// scan, so the user gets one scan and one consistent result regardless of how
// many times they click. The map clears once each scan settles.
const SCAN_IN_FLIGHT = new Map<number, Promise<ScanResult>>();

export function isVideoScanInFlight(videoId: number): boolean {
  return SCAN_IN_FLIGHT.has(videoId);
}

export async function processVideoScan(
  videoId: number,
  forceRescan: boolean = false,
  scanMode: keyof typeof scanModes = "standard"
): Promise<ScanResult> {
  // If a scan is already running for this video, return the existing promise.
  // The caller's "click again" results in the same response as the original
  // run — no wipe, no parallel work, no race.
  const existing = SCAN_IN_FLIGHT.get(videoId);
  if (existing) {
    console.log(`[Scanner V2] Video ${videoId}: scan already in progress, joining existing run (forceRescan=${forceRescan} ignored)`);
    return existing;
  }

  const promise = (async () => {
    try {
      return await processVideoScanInner(videoId, forceRescan, scanMode);
    } finally {
      SCAN_IN_FLIGHT.delete(videoId);
    }
  })();

  SCAN_IN_FLIGHT.set(videoId, promise);
  return promise;
}

async function processVideoScanInner(
  videoId: number,
  forceRescan: boolean = false,
  scanMode: keyof typeof scanModes = "standard"
): Promise<ScanResult> {
  console.log(`[Scanner V2] ========== STARTING SCAN ==========`);
  console.log(`[Scanner V2] Video ID: ${videoId}, Force Rescan: ${forceRescan}`);

  const tempDir = path.join(os.tmpdir(), `scan-v2-${videoId}-${Date.now()}`);
  const framesDir = path.join(tempDir, "frames");

  // Snapshot existing surface IDs BEFORE any wipe. If this scan succeeds with
  // new surfaces we'll delete the snapshotted ones at the end. If the scan
  // fails or finds nothing, we leave the prior data alone — preserves the
  // creator's previous results across an error or a click-twice rescan.
  let priorSurfaceIds: number[] = [];
  try {
    const prior = await storage.getDetectedSurfaces(videoId);
    priorSurfaceIds = prior.map(s => s.id);
    if (priorSurfaceIds.length > 0) {
      console.log(`[Scanner V2] Snapshotted ${priorSurfaceIds.length} existing surfaces — will replace only on successful scan`);
    }
  } catch (err: any) {
    console.warn(`[Scanner V2] Could not snapshot existing surfaces:`, err?.message || err);
  }

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
    
    // Mark "Scanning" up front — BEFORE any download/stream resolution — so the
    // library poll sees the transition immediately instead of clearing the
    // spinner while a slow source resolution is still in flight. (A later
    // updateVideoStatus("Scanning") is a harmless no-op re-write.)
    await storage.updateVideoStatus(videoId, "Scanning");

    // LOCATE VIDEO FILE
    let videoPath: string | undefined;

    // OAuth stream-and-scan: frames pulled directly from a CDN URL without ever
    // downloading the full video (see streamResolver.ts + extractFramesFromUrl).
    // When this succeeds, we skip the local-file requirement entirely and feed
    // these frames straight into detection.
    let streamedFrames: { frames: string[]; timestamps: number[] } | null = null;

    if ((video as any).filePath?.startsWith('/storage/')) {
      try {
        const objectKey = (video as any).filePath.replace(/^\/storage\//, 'public/');
        videoPath = await downloadToTempFile(objectKey, tempDir);
        console.log(`[Scanner V2] Downloaded from Object Storage to: ${videoPath}`);
      } catch (e: any) {
        console.error(`[Scanner V2] Object Storage download failed:`, e.message);
      }
    } else if ((video as any).filePath) {
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

    // YOUTUBE FALLBACK: imported videos (via /api/youtube/sync or
    // import-selected) have no filePath — only a youtubeId. Pull the source
    // to tempDir so the rest of the scan pipeline has bytes to work with.
    // tempDir is cleaned up in the finally block, so the source video is
    // discarded automatically once frames are extracted (light-cloud model:
    // we never persist creator source files).
    const looksLikeRealYouTubeId = (id: string) =>
      !!id && !id.startsWith("upload-") && !id.startsWith("ig-")
        && !id.startsWith("fb-") && !id.startsWith("demo-")
        && !id.startsWith("hero-");

    let scanPlan: { intervalSeconds: number; maxFrames: number } = {
      intervalSeconds: CONFIG.FRAME_INTERVAL_SECONDS,
      maxFrames: CONFIG.MAX_FRAMES_PER_VIDEO,
    };

    // Resolve video duration. Primary source: the DB (YouTube import stores
    // ISO 8601 like "PT1H46M2S" in video.duration). Fast + reliable since
    // we already have it. Fallback: yt-dlp metadata probe — but that's
    // slow and frequently times out on long videos, so we only try it if
    // the DB doesn't have a duration.
    const durationSec = (() => {
      const fromDb = parseIsoDuration((video as any).duration);
      if (fromDb && fromDb > 0) {
        console.log(`[Scanner V2] Duration from DB: ${fromDb}s (${(fromDb/60).toFixed(1)} min)`);
        return fromDb;
      }
      return null;
    })();

    // ─── OAuth STREAM-AND-SCAN (primary path for imported videos) ───────────
    // For YouTube/IG/FB imports (no local filePath), resolve a direct CDN URL
    // via the creator's OAuth credentials and pull sample frames straight from
    // it — no full download, no upload. This is the intended model: the source
    // is never persisted. Falls through to the download fallbacks below only if
    // URL resolution or streaming extraction fails.
    const platform = (video as any).platform as string | undefined;
    const isStreamableImport =
      !videoPath &&
      ((platform === "youtube" && looksLikeRealYouTubeId(video.youtubeId)) ||
       ((platform === "instagram" || platform === "facebook") &&
        (video.youtubeId.startsWith("instagram:") || video.youtubeId.startsWith("facebook:"))));

    if (isStreamableImport) {
      // Plan evenly-spaced sample timestamps across the (capped) duration.
      // Budget is MAX_FRAMES_PER_VIDEO — for streaming we can't cheaply do
      // scene-cut detection (that needs the whole file), so we sample uniformly.
      const MAX_DURATION_SEC = 60 * 60;
      const planStreamTimestamps = (durSec: number | null): number[] => {
        if (durSec && durSec > 0) {
          const eff = Math.min(durSec, MAX_DURATION_SEC);
          const count = Math.max(1, Math.min(CONFIG.MAX_FRAMES_PER_VIDEO, Math.floor(eff / 2)));
          const interval = eff / count;
          return Array.from({ length: count }, (_, i) => Math.round((i + 0.5) * interval));
        }
        // Duration unknown (common for IG): sample the first ~72s at 3s spacing.
        // Covers typical Reels end-to-end and the opening of long-form content.
        return Array.from({ length: CONFIG.MAX_FRAMES_PER_VIDEO }, (_, i) => i * 3);
      };

      let source: StreamSource | null = null;
      try {
        if (platform === "youtube") {
          const oauthToken = await getFreshYoutubeTokenForUser(video.userId).catch(() => null);
          source = await resolveYoutubeStreamUrl(video.youtubeId, oauthToken || undefined);
        } else {
          const user = await storage.getUserById((video as any).userId);
          const token = safeDecrypt(user?.facebookAccessToken);
          if (!token) {
            console.warn(`[Scanner V2] No Facebook token for user ${(video as any).userId} — cannot stream ${platform}`);
          } else {
            source = await resolveGraphStreamUrl(video.youtubeId, platform as "instagram" | "facebook", token);
          }
        }
      } catch (e: any) {
        console.warn(`[Scanner V2] Stream URL resolution threw: ${e?.message || e}`);
      }

      if (source) {
        const timestamps = planStreamTimestamps(durationSec);
        console.log(`[Scanner V2] Stream-and-scan: sampling ${timestamps.length} frames from ${platform} CDN URL (no download)`);
        fs.mkdirSync(framesDir, { recursive: true });
        const result = await extractFramesFromUrl(source, framesDir, timestamps);
        if (result.frames.length > 0) {
          streamedFrames = result;
          console.log(`[Scanner V2] Stream-and-scan succeeded: ${result.frames.length} frames — skipping download`);
        } else {
          console.warn(`[Scanner V2] Stream-and-scan produced 0 frames — falling back to download`);
        }
      }
    }

    if (!videoPath && !streamedFrames && (video as any).platform === "youtube" && looksLikeRealYouTubeId(video.youtubeId)) {
      console.log(`[Scanner V2] No filePath; attempting YouTube download for ${video.youtubeId}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const downloadPath = path.join(tempDir, `${video.youtubeId}.mp4`);

      // Path B (OAuth): pass the creator's stored YouTube token so anonymous
      // bot detection doesn't block long downloads. Falls back to anonymous
      // if no token is available.
      const oauthToken = await getFreshYoutubeTokenForUser(video.userId).catch(() => null);

      // Plan adaptive sampling — duration-banded, NOT a fixed frame target.
      // Fixed-target was wrong: 75 frames on a 30-min video = every 24s,
      // way too sparse for podcasts where surfaces shift between cuts.
      // Sliding scale gets denser sampling on shorter content where
      // action density is higher, and reasonable spacing on longer
      // content. Hard cap at 1 hour — anything longer scans only the
      // first hour (creator-confirmed: nothing >1hr in scope).
      const MAX_DURATION_SEC = 60 * 60; // 1 hour
      let probedDuration = durationSec;
      if (!probedDuration) {
        probedDuration = await getYoutubeVideoDuration(video.youtubeId, oauthToken || undefined);
        if (probedDuration) {
          console.log(`[Scanner V2] Duration from yt-dlp probe: ${probedDuration}s`);
        }
      }

      const planFromDuration = (durSec: number): { intervalSeconds: number; maxFrames: number } => {
        // Cap effective duration at 1hr — long videos still scan, just
        // limited to first hour of content.
        const eff = Math.min(durSec, MAX_DURATION_SEC);
        let interval: number;
        if (eff <= 5 * 60) interval = 2;          // ≤5min: every 2s
        else if (eff <= 15 * 60) interval = 3;    // 5–15min: every 3s
        else if (eff <= 30 * 60) interval = 4;    // 15–30min: every 4s
        else interval = 5;                         // 30–60min: every 5s
        const maxFrames = Math.ceil(eff / interval);
        return { intervalSeconds: interval, maxFrames };
      };

      if (probedDuration && probedDuration > 0) {
        scanPlan = planFromDuration(probedDuration);
        const coveredMin = (scanPlan.intervalSeconds * scanPlan.maxFrames / 60).toFixed(1);
        const fullMin = (probedDuration / 60).toFixed(1);
        const cappedNote = probedDuration > MAX_DURATION_SEC ? ` (CAPPED at 1hr — full video is ${fullMin}min)` : "";
        console.log(`[Scanner V2] Plan: every ${scanPlan.intervalSeconds}s × ${scanPlan.maxFrames} frames = ${coveredMin}min coverage${cappedNote}`);
      } else {
        // Duration unknown — default to "5 min, every 2s" plan = 150 frames.
        scanPlan = { intervalSeconds: 2, maxFrames: 150 };
        console.log(`[Scanner V2] Duration unknown — using fallback plan: every 2s × 150 frames (5min coverage)`);
      }

      // Download budget: enough seconds to cover the planned frames + a buffer.
      const plannedRange = scanPlan.intervalSeconds * scanPlan.maxFrames + 30;
      const cappedDuration = probedDuration ? Math.min(probedDuration, MAX_DURATION_SEC) : null;
      const trimSec = cappedDuration ? Math.min(cappedDuration, plannedRange) : plannedRange;

      const ok = await downloadYouTubeVideo(video.youtubeId, downloadPath, {
        trimToSeconds: trimSec,
        timeoutMs: 10 * 60 * 1000, // 10min cap — long videos with full-duration scans take longer
        oauthToken: oauthToken || undefined,
      });
      if (ok && fs.existsSync(downloadPath)) {
        videoPath = downloadPath;
        console.log(`[Scanner V2] YouTube download succeeded: ${videoPath}`);
      } else {
        console.error(`[Scanner V2] YouTube download failed for ${video.youtubeId}`);
      }
    }

    // FACEBOOK / INSTAGRAM FALLBACK: imported videos (via /api/social/sync)
    // have no filePath — the importer only stored Graph API metadata. Resolve
    // the CDN-hosted source URL on-demand using the user's stored Page access
    // token (also valid for the linked IG Business account), download to
    // tempDir, and let the existing finally{} cleanup discard the bytes.
    // Same light-cloud model as the YouTube path above.
    const isFbOrIg =
      !videoPath && !streamedFrames &&
      ((video as any).platform === "facebook" || (video as any).platform === "instagram") &&
      (video.youtubeId.startsWith("facebook:") || video.youtubeId.startsWith("instagram:"));

    if (isFbOrIg) {
      const platform = (video as any).platform as "facebook" | "instagram";
      const user = await storage.getUserById((video as any).userId);
      const token = safeDecrypt(user?.facebookAccessToken);
      if (!token) {
        console.error(`[Scanner V2] No Facebook access token for user ${(video as any).userId} — cannot download ${platform} source`);
      } else {
        console.log(`[Scanner V2] No filePath; attempting ${platform} download for ${video.youtubeId}`);
        fs.mkdirSync(tempDir, { recursive: true });
        const safeId = video.youtubeId.replace(/[^a-zA-Z0-9]/g, "_");
        const downloadPath = path.join(tempDir, `${safeId}.mp4`);
        const ok = platform === "facebook"
          ? await downloadFacebookVideo(video.youtubeId, token, downloadPath)
          : await downloadInstagramVideo(video.youtubeId, token, downloadPath);
        if (ok && fs.existsSync(downloadPath)) {
          videoPath = downloadPath;
          console.log(`[Scanner V2] ${platform} download succeeded: ${videoPath}`);
        } else {
          console.error(`[Scanner V2] ${platform} download failed for ${video.youtubeId}`);
        }
      }
    }

    // DEBUG LOGGING
    console.log('[Scanner V2] DEBUG - youtubeId:', video.youtubeId);
    console.log('[Scanner V2] DEBUG - LOCAL_ASSET_MAP keys:', Object.keys(LOCAL_ASSET_MAP));
    console.log('[Scanner V2] DEBUG - Resolved videoPath:', videoPath);

    // No frames from streaming AND no local/downloaded file → genuine failure.
    // Give a descriptive, actionable status instead of the ambiguous
    // "Pending Upload" (which the UI rendered identically to "Pending Scan",
    // making a failed scan look like nothing happened).
    if (!streamedFrames && (!videoPath || !fs.existsSync(videoPath))) {
      console.error(`[Scanner V2] No frames from stream and no video file: ${videoPath}`);
      const platform = (video as any).platform as string | undefined;
      const failStatus =
        platform === "instagram" || platform === "facebook"
          ? "Scan Failed — Reconnect Instagram/Facebook"
          : platform === "youtube"
          ? "Scan Failed — Source Unavailable"
          : "Pending Upload";
      await storage.updateVideoStatus(videoId, failStatus);
      return {
        success: false,
        videoId,
        surfacesDetected: 0,
        error: streamedFrames === null && (platform === "youtube" || platform === "instagram" || platform === "facebook")
          ? `Could not access ${platform} source. The connection may need to be re-authorized, or the video may be private/unavailable.`
          : "Video file not found. Upload required.",
      };
    }

    if (videoPath) {
      const fileSizeMB = fs.statSync(videoPath).size / 1024 / 1024;
      console.log(`[Scanner V2] Video file size: ${fileSizeMB.toFixed(2)}MB`);
    }

    fs.mkdirSync(framesDir, { recursive: true });

    let frames: string[] = [];
    let frameTimestamps: number[] = [];
    let usedSceneFirst = false;
    let sceneIndex: SceneIndex | null = null;

    if (streamedFrames) {
      // OAuth stream path: frames were already pulled from the CDN URL. We
      // can't do scene-cut detection here (that reads the whole file, which
      // we deliberately never downloaded), so we use the uniformly-sampled
      // frames as-is. sceneBoundaries stays whatever a prior full scan set.
      frames = streamedFrames.frames;
      frameTimestamps = streamedFrames.timestamps;
      console.log(`[Scanner V2] Using ${frames.length} streamed frames (uniform sampling; scene-cut detection skipped — no local file)`);
    } else if (videoPath) {
      // LOCAL/DOWNLOADED path — scene-first detection for denser, cheaper sampling.
      // SCENE-FIRST: detect cuts and cluster shots into unique scenes BEFORE
      // extracting frames. Sample 1-2 frames per UNIQUE SCENE rather than
      // uniformly — a podcast with 60 cuts but 2 unique scenes goes from 50
      // frames to ~4. Failure is non-fatal — falls back to uniform.
      let sceneCuts: number[] = [];
      try {
        sceneCuts = await detectSceneCuts(videoPath);
        await storage.updateVideoIndex(videoId, { sceneBoundaries: sceneCuts as any });
        console.log(`[Scanner V2] Persisted ${sceneCuts.length} scene cut(s) to videoIndex.sceneBoundaries`);
      } catch (sceneErr: any) {
        console.warn(`[Scanner V2] Scene-cut detection failed (non-fatal):`, sceneErr?.message || sceneErr);
      }

      try {
        sceneIndex = await buildSceneIndex(videoPath, sceneCuts);
        if (sceneIndex) {
          await storage.updateVideoIndex(videoId, {
            sceneIndex: sceneIndex as any,
            sceneBoundaries: sceneIndex.cuts as any,
          });
          console.log(`[Scanner V2] Persisted scene index: ${sceneIndex.sceneCount} unique scene(s) across ${sceneIndex.shots.length} shot(s); refined ${sceneIndex.cuts.length} cuts`);
        }
      } catch (sidxErr: any) {
        console.warn(`[Scanner V2] Scene index build failed (non-fatal):`, sidxErr?.message || sidxErr);
      }

      if (sceneIndex && sceneIndex.sceneCount > 0) {
        const desiredPerScene = Math.max(
          1,
          Math.min(6, Math.floor(CONFIG.MAX_FRAMES_PER_VIDEO / sceneIndex.sceneCount)),
        );
        const samples = sampleMultiTimestampsPerScene(sceneIndex, desiredPerScene);
        const trimmed = samples.slice(0, CONFIG.MAX_FRAMES_PER_VIDEO);
        console.log(`[Scanner V2] Scene-first extraction: ${trimmed.length} frames across ${sceneIndex.sceneCount} unique scene(s) (${desiredPerScene}/scene target)`);

        const result = await extractFramesAtTimestamps(videoPath, framesDir, trimmed.map(s => s.t));
        if (result.frames.length > 0) {
          frames = result.frames;
          frameTimestamps = result.timestamps;
          usedSceneFirst = true;
        } else {
          console.warn(`[Scanner V2] Scene-first extraction returned 0 frames — falling back to uniform`);
        }
      }

      if (!usedSceneFirst) {
        console.log(`[Scanner V2] Extracting frames with plan: every ${scanPlan.intervalSeconds}s × ${scanPlan.maxFrames} frames`);
        frames = await extractFrames(videoPath, framesDir, scanPlan);
        frameTimestamps = frames.map((_, i) => i * scanPlan.intervalSeconds);
      }
    }

    if (frames.length === 0) {
      await storage.updateVideoStatus(videoId, "Scan Failed");
      return { success: false, videoId, surfacesDetected: 0, error: "No frames extracted" };
    }

    console.log(`[Scanner V2] Using ${frames.length} frames (${usedSceneFirst ? "scene-first" : "uniform"})`);

    const { isVertical } = await getFrameMetadata(frames[0]);
    console.log(`[Scanner V2] Video orientation: ${isVertical ? "VERTICAL (9:16)" : "HORIZONTAL (16:9)"}`);
    
    // Frames uploaded to Object Storage instead of local disk

    // PROCESS FRAMES ONE BY ONE (with immediate cleanup)
    let totalSurfaces = 0;
    const geminiKeyPresent = !!process.env.AI_INTEGRATIONS_GEMINI_API_KEY
      && process.env.AI_INTEGRATIONS_GEMINI_API_KEY !== 'dummy-key';
    console.log(`[Scanner V2] Detection method: ${CONFIG.DETECTION_METHOD.toUpperCase()}`);
    console.log(`[Scanner V2] Gemini API key: ${geminiKeyPresent ? 'CONFIGURED (' + process.env.AI_INTEGRATIONS_GEMINI_API_KEY!.substring(0, 8) + '...)' : 'NOT SET — will use edge detection fallback (less accurate)'}`);
    if (!geminiKeyPresent) {
      console.warn(`[Scanner V2] ⚠️  AI_INTEGRATIONS_GEMINI_API_KEY not set. Surface detection will be limited. Set this env var for accurate AI-powered scanning.`);
    }

    for (let i = 0; i < frames.length; i++) {
      const framePath = frames[i];
      // Real timestamp at this frame — scene-first sets this to the
      // representative shot midpoint per scene; uniform fallback uses
      // i × intervalSeconds. sceneId lookup downstream needs the real t.
      const timestamp = frameTimestamps[i] ?? i * scanPlan.intervalSeconds;
      // Round to int seconds for filename uniqueness without colliding
      // (multiple scene-first samples can land between integer seconds).
      const tsKey = Math.round(timestamp);

      try {
        console.log(`[Scanner V2] Processing frame ${i + 1}/${frames.length} (${timestamp.toFixed(2)}s)...`);

        // Save ALL valid frames to permanent directory for thumbnail strip
        const frameFilename = `frame_${tsKey}s.jpg`;

        try {
          const frameSize = fs.statSync(framePath).size;
          if (frameSize > 5000) {
            const objectKey = `public/uploads/frames/${videoId}/${frameFilename}`;
            await uploadFileToStorage(framePath, objectKey);
          } else {
            console.warn(`[Scanner V2] Skipping tiny frame ${frameFilename} (${frameSize} bytes)`);
          }
        } catch (copyErr) {
          console.error(`[Scanner V2] Failed to upload frame to storage:`, copyErr);
        }

        // Use Gemini AI or edge detection based on config
        // Falls back to edge detection if Gemini API key is missing
        const useGemini = CONFIG.DETECTION_METHOD === 'gemini'
          && process.env.AI_INTEGRATIONS_GEMINI_API_KEY
          && process.env.AI_INTEGRATIONS_GEMINI_API_KEY !== 'dummy-key';

        let analysis: FrameAnalysisResult;
        if (useGemini) {
          analysis = await analyzeFrameWithGeminiRetry(framePath, timestamp, isVertical);
          // Only fall back to edge if Gemini API actually failed (not if it just found no surfaces)
          // If aiAnalyzed=true, Gemini worked fine — it just said "no surfaces here"
          if (!analysis.aiAnalyzed && !analysis.hasSurface) {
            console.warn(`[Scanner V2] ⚠️  Gemini API FAILED for frame ${timestamp}s (aiAnalyzed=false). This likely means the API request failed (wrong base URL, auth error, or timeout). Falling back to edge detection...`);
            analysis = await analyzeFrameForSurfaces(framePath, timestamp, isVertical);
          }
        } else {
          if (i === 0) console.log(`[Scanner V2] Gemini API key not configured, using edge detection fallback`);
          analysis = await analyzeFrameForSurfaces(framePath, timestamp, isVertical);
        }

        if (analysis.hasSurface && analysis.surfaces.length > 0) {
          const frameUrl = `/storage/uploads/frames/${videoId}/${frameFilename}`;

          // Resolve sceneId for this timestamp once per frame (all surfaces
          // in this frame share the same scene). Falls back to scene 0 when
          // no index was built (degenerate single-scene video).
          const sceneIdForFrame = sceneIndex
            ? sceneIdForTimestamp(sceneIndex, timestamp)
            : 0;

          for (const surface of analysis.surfaces) {
            const dbSurface: InsertDetectedSurface = {
              videoId,
              timestamp: timestamp.toString(),
              surfaceType: surface.surfaceType,
              orientation: surface.orientation || null,
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
              // Scene cluster — same physical set across cuts gets same ID,
              // unlocks placement continuity in the frontend.
              sceneId: sceneIdForFrame,
              // creatorApproved defaults to false in schema — surfaces hidden from
              // brands until creator explicitly approves via UI toggle
            };

            const inserted = await storage.insertDetectedSurface(dbSurface);
            console.log(`[Scanner V2] *** SURFACE FOUND: ${surface.surfaceType} at ${timestamp}s scene=${sceneIdForFrame} (confidence: ${(surface.confidence * 100).toFixed(1)}%, id: ${inserted.id}) ***`);
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
      
      // Find frames that didn't get surfaces and add potential surfaces.
      // Scene-first sampling produces non-integer timestamps (e.g. 14.7s)
      // so we round before set membership comparison — same key the
      // fallback loop below uses for the frameUrl filename.
      const framesWithSurfaces = new Set<number>();
      const existingSurfaces = await storage.getDetectedSurfaces(videoId);
      existingSurfaces.forEach(s => framesWithSurfaces.add(Math.round(parseFloat(String(s.timestamp)))));
      
      for (let i = 0; i < frames.length && totalSurfaces < CONFIG.MIN_SURFACES_BEFORE_FALLBACK + 2; i++) {
        // Use real per-frame timestamp (scene-first or uniform) instead of
        // recomputing from the loop index — uniform pre-existing behavior
        // happens to match, scene-first uses non-uniform sampling so the
        // reconstruction would be wrong without this.
        const timestamp = frameTimestamps[i] ?? i * scanPlan.intervalSeconds;
        const tsKey = Math.round(timestamp);
        if (!framesWithSurfaces.has(tsKey)) {
          const fallbackFrameFilename = `frame_${tsKey}s.jpg`;

          const dbSurface = {
            videoId,
            timestamp: String(timestamp),
            surfaceType: "Potential Surface",
            confidence: String(CONFIG.FALLBACK_CONFIDENCE),
            boundingBoxX: "0.05",
            boundingBoxY: "0.6", // Bottom 40%
            boundingBoxWidth: "0.9",
            boundingBoxHeight: "0.35",
            frameUrl: `/storage/uploads/frames/${videoId}/${fallbackFrameFilename}`,
            surroundings: null,
            sceneContext: "Fallback detection - potential placement area",
            sceneId: sceneIndex ? sceneIdForTimestamp(sceneIndex, timestamp) : 0,
          };

          await storage.insertDetectedSurface(dbSurface);
          console.log(`[Scanner V2] *** FALLBACK SURFACE at ${timestamp.toFixed(2)}s (confidence: ${(CONFIG.FALLBACK_CONFIDENCE * 100).toFixed(1)}%) ***`);
          totalSurfaces++;
        }
      }
    }
    
    // PHASE 2A: CAPTURE SURFACE KEYFRAMES — Save raw per-frame bboxes for motion tracking
    // Must happen BEFORE normalization overwrites bboxes with the median
    try {
      await captureSurfaceKeyframes(videoId);
    } catch (kfErr) {
      console.error(`[Scanner V2] Keyframe capture failed (non-fatal):`, kfErr);
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
      await groupSurfacesTemporally(videoId, scanPlan.intervalSeconds);
    } catch (temporalErr) {
      console.error(`[Scanner V2] Temporal grouping failed (non-fatal):`, temporalErr);
    }

    // Remove filtered/phantom surfaces from count.
    // CRITICAL: only subtract NEW surfaces inserted during THIS scan run.
    // With the snapshot/preserve-priors logic added earlier, the DB also
    // contains old Filtered surfaces from previous scans — counting those
    // here drove totalSurfaces to 0 even when this run inserted real
    // detections (Floor + Shelf were vanishing this way on Call Her Daddy).
    const postNormSurfaces = await storage.getDetectedSurfaces(videoId);
    const priorIdSet = new Set(priorSurfaceIds);
    const filteredOut = postNormSurfaces
      .filter(s => !priorIdSet.has(s.id) && s.surfaceType === "Filtered")
      .length;
    totalSurfaces = Math.max(0, totalSurfaces - filteredOut);
    console.log(`[Scanner V2] Net new active surfaces this run: ${totalSurfaces} (inserted - filtered ${filteredOut} new surfaces)`);

    // SCENE CONTEXT ENRICHMENT — FullScale Edge image analysis
    // Uses Sharp to analyze brightness, edges, and color to infer scene context
    try {
      const enrichmentDir = path.join(tempDir, "enrichment_frames");
      fs.mkdirSync(enrichmentDir, { recursive: true });
      const enrichmentSurfaces = await storage.getDetectedSurfaces(videoId);

      // Pre-download each surface's frame from GCS. Prefer surface.frameUrl
      // (the EXACT path scanner saved — most reliable), with Math.round
      // (current scanner) and Math.floor (legacy) fallbacks. Was Math.floor-
      // only previously; that path lost all scene-first surfaces with
      // non-integer timestamps because scanner uses Math.round naming.
      const downloadedKeys = new Set<string>();
      for (const s of enrichmentSurfaces) {
        const tsFloat = Number(s.timestamp);
        const candidateKeys: string[] = [];
        if (s.frameUrl) {
          candidateKeys.push(
            s.frameUrl
              .replace(/^\/storage\//, "public/")
              .replace(/^\/uploads\//, "public/uploads/"),
          );
        }
        candidateKeys.push(`public/uploads/frames/${videoId}/frame_${Math.round(tsFloat)}s.jpg`);
        candidateKeys.push(`public/uploads/frames/${videoId}/frame_${Math.floor(tsFloat)}s.jpg`);

        for (const objKey of candidateKeys) {
          if (downloadedKeys.has(objKey)) break;
          try {
            const tempPath = await downloadToTempFile(objKey, enrichmentDir);
            downloadedKeys.add(objKey);
            console.log(`[Scanner V2] Downloaded frame for enrichment: ${tempPath}`);
            break; // first key that resolves wins
          } catch { /* try next candidate */ }
        }
      }
      await enrichSurfacesWithContext(videoId, enrichmentDir);
    } catch (enrichErr) {
      console.error(`[Scanner V2] Scene context enrichment failed (non-fatal):`, enrichErr);
    }

    // CLAUDE DENSE + GENERATION DECISION BRANCH
    // If in autoRemix mode and ANTHROPIC_API_KEY is set, run narrative analysis
    // and decide whether to generate assets for surfaces without natural product moments
    if (scanMode === "autoRemix" && process.env.ANTHROPIC_API_KEY) {
      try {
        console.log(`[Scanner V2] Running Claude Dense narrative analysis (autoRemix mode)...`);
        const enrichedSurfaces = await storage.getDetectedSurfaces(videoId);
        const activeSurfaces = enrichedSurfaces.filter(s => s.surfaceType !== "Filtered");

        if (activeSurfaces.length > 0) {
          const { analyzeNarrative } = await import("./lib/ai/claude-dense/narrativeAnalyzer");
          const { decidePlacement } = await import("./lib/ai/cdense/connector");

          let analysisCount = 0;
          let generateCount = 0;

          for (const surface of activeSurfaces.slice(0, 10)) {
            try {
              // Build frame path for this surface's timestamp
              const frameTimestamp = Math.round(surface.timestampStart || 0);
              const claudeFrameDir = path.join(tempDir, "claude_frames");
              if (!fs.existsSync(claudeFrameDir)) fs.mkdirSync(claudeFrameDir, { recursive: true });
              let framePath: string;
              try {
                const claudeObjKey = `public/uploads/frames/${videoId}/frame_${frameTimestamp}s.jpg`;
                framePath = await downloadToTempFile(claudeObjKey, claudeFrameDir);
              } catch {
                continue;
              }

              if (!fs.existsSync(framePath)) continue;

              const frameBase64 = fs.readFileSync(framePath).toString("base64");

              const narrativeResult = await analyzeNarrative({
                videoId,
                frameIndex: frameTimestamp,
                frameBase64,
                detectedSurfaces: [{
                  id: surface.id,
                  surfaceType: surface.surfaceType || "table",
                  confidence: surface.confidence || 0.5,
                  boundingBox: {
                    x: surface.bboxX || 0,
                    y: surface.bboxY || 0,
                    width: surface.bboxWidth || 0.2,
                    height: surface.bboxHeight || 0.2,
                  },
                  lightingDirection: surface.lightingDirection || undefined,
                }],
                sceneContext: {
                  sceneType: surface.sceneType || "unknown",
                  brightness: { overall: surface.brightness || 128, top: 128, bottom: 128 },
                  edgeDensity: surface.edgeDensity || 0,
                  colorWarmth: surface.colorWarmth || 0,
                  surroundings: [],
                  brandCategorySuggestions: [],
                },
              });

              // Save analysis to DB
              await storage.createSceneAnalysis({
                videoId,
                surfaceId: surface.id,
                frameStart: frameTimestamp,
                narrativeContext: narrativeResult.narrativeContext,
                emotionalTone: narrativeResult.emotionalTone,
                culturalTags: narrativeResult.culturalTags,
                placementViability: narrativeResult.placementViability,
                suggestedCategories: narrativeResult.suggestedProductCategories,
                reasoning: narrativeResult.reasoning,
              });
              analysisCount++;

              // Check placement decision
              const existingPlacements = await storage.getPlacementsForVideo(videoId);
              const hasExisting = existingPlacements.some(p => p.detectedSurfaceId === surface.id);

              const decision = decidePlacement({
                videoId,
                surfaceId: surface.id,
                narrativeAnalysis: narrativeResult,
                brandMatches: { matches: [] }, // No brand matching during scan — done later via UI
                surfaceDetails: {
                  surfaceType: surface.surfaceType || "table",
                  boundingBox: {
                    x: surface.bboxX || 0,
                    y: surface.bboxY || 0,
                    width: surface.bboxWidth || 0.2,
                    height: surface.bboxHeight || 0.2,
                  },
                  confidence: surface.confidence || 0.5,
                  lightingDirection: surface.lightingDirection || "ambient",
                },
                sceneAesthetic: {
                  colorWarmth: surface.colorWarmth || 0,
                  brightness: { overall: surface.brightness || 128, top: 128, bottom: 128 },
                  dominantColors: [],
                },
                hasExistingPlacement: hasExisting,
                scanMode: "autoRemix",
              });

              if (decision.type === "generate_asset") generateCount++;
              console.log(`[Scanner V2] Surface ${surface.id}: ${decision.type} — ${decision.reason}`);

            } catch (surfaceErr) {
              console.warn(`[Scanner V2] Claude Dense failed for surface ${surface.id} (non-fatal):`, surfaceErr);
            }
          }

          console.log(`[Scanner V2] Claude Dense: analyzed ${analysisCount} surfaces, ${generateCount} flagged for generation`);
        }
      } catch (claudeErr) {
        console.error(`[Scanner V2] Claude Dense pipeline failed (non-fatal):`, claudeErr);
      }
    }

    // FINALIZE
    let finalStatus: string;
    if (totalSurfaces > 0) {
      finalStatus = `Ready (${totalSurfaces} Spots)`;
    } else if (!geminiKeyPresent) {
      finalStatus = "Ready (0 Spots)";
      console.warn(`[Scanner V2] ⚠️  0 surfaces found — Gemini API key is NOT configured. Set AI_INTEGRATIONS_GEMINI_API_KEY for AI-powered surface detection.`);
    } else {
      finalStatus = "Ready (0 Spots)";
      console.warn(`[Scanner V2] 0 surfaces found despite Gemini being available. The video may not contain clear flat surfaces, or ghost filters may be too aggressive.`);
    }

    // Replace prior surfaces ONLY now — scan succeeded. If totalSurfaces > 0,
    // delete the snapshotted prior IDs so the new surfaces stand alone. If
    // totalSurfaces == 0, KEEP the prior data — a re-scan that finds nothing
    // shouldn't wipe creator's earlier good results.
    if (totalSurfaces > 0 && priorSurfaceIds.length > 0) {
      try {
        for (const id of priorSurfaceIds) {
          await storage.updateDetectedSurface(id, { surfaceType: "Filtered", sceneContext: "Replaced by re-scan" });
        }
        console.log(`[Scanner V2] Marked ${priorSurfaceIds.length} prior surfaces as Filtered (replaced by ${totalSurfaces} new surfaces)`);
      } catch (err: any) {
        console.warn(`[Scanner V2] Failed to filter prior surfaces:`, err?.message || err);
      }
    } else if (totalSurfaces === 0 && priorSurfaceIds.length > 0) {
      console.log(`[Scanner V2] Re-scan found 0 surfaces — keeping ${priorSurfaceIds.length} prior surfaces intact (re-scan didn't find replacements)`);
    }

    await storage.updateVideoStatus(videoId, finalStatus);

    console.log(`[Scanner V2] ========== SCAN COMPLETE ==========`);
    console.log(`[Scanner V2] Video ID: ${videoId}, Surfaces: ${totalSurfaces}, Gemini: ${geminiKeyPresent ? 'YES' : 'NO'}`);

    // AUTO-TRIGGER TRANSCRIPTION — kick off transcript pipeline in background after scan
    // This ensures editorial clips are ready when the creator opens the video
    try {
      const existingTranscript = await storage.getVideoTranscript(videoId);
      if (!existingTranscript && video.filePath) {
        console.log(`[Scanner V2] Auto-triggering transcription for video ${videoId}...`);
        // Dynamic import to avoid circular dependency — transcriptPipeline.ts is in remix module
        const { runTranscriptPipeline } = await import("./lib/remix/transcriptPipeline");

        // Create initial transcript record
        const transcript = await storage.createVideoTranscript({
          videoId,
          provider: "deepgram",
          language: "en",
          status: "processing",
        });

        // Run in background — don't block scan completion
        runTranscriptPipeline({ videoId, filePath: video.filePath, language: "en" })
          .then(async (result) => {
            await storage.updateVideoTranscript(transcript.id, {
              segments: result.segments,
              fullText: result.fullText,
              speakerMap: result.speakerMap ?? null,
              wordCount: result.wordCount,
              segmentCount: result.segmentCount,
              audioDuration: result.audioDuration ?? null,
              processingTimeMs: result.totalProcessingTimeMs ?? null,
              provider: result.provider,
              status: "completed",
            });
            console.log(`[Scanner V2] Auto-transcription completed for video ${videoId}: ${result.wordCount} words`);
          })
          .catch(async (err) => {
            console.warn(`[Scanner V2] Auto-transcription failed for video ${videoId} (non-fatal):`, err.message);
            await storage.updateVideoTranscriptStatus(transcript.id, "failed", err.message);
          });
      } else if (!video.filePath) {
        console.log(`[Scanner V2] No file path for video ${videoId}, skipping auto-transcription`);
      } else {
        console.log(`[Scanner V2] Transcript already exists for video ${videoId}, skipping auto-transcription`);
      }
    } catch (transcriptErr) {
      console.warn(`[Scanner V2] Auto-transcription setup failed (non-fatal):`, transcriptErr);
    }

    return {
      success: true,
      videoId,
      surfacesDetected: totalSurfaces,
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Scanner V2] SCAN FAILED: ${errorMessage}`);

    // Roll back any partial new surfaces inserted during this failed run, so
    // the creator's prior data (snapshotted above) remains the source of truth.
    // Anything currently in the DB whose ID is NOT in priorSurfaceIds was
    // inserted by THIS scan attempt — mark Filtered so it doesn't render.
    try {
      const priorIdSet = new Set(priorSurfaceIds);
      const current = await storage.getDetectedSurfaces(videoId);
      const partialNew = current.filter(s => !priorIdSet.has(s.id) && s.surfaceType !== "Filtered");
      if (partialNew.length > 0) {
        for (const s of partialNew) {
          try {
            await storage.updateDetectedSurface(s.id, { surfaceType: "Filtered", sceneContext: "Removed: scan failed mid-way" });
          } catch { /* ignore */ }
        }
        console.log(`[Scanner V2] Rolled back ${partialNew.length} partial new surfaces; ${priorSurfaceIds.length} prior surfaces restored as the active set`);
      }
    } catch (rollbackErr: any) {
      console.warn(`[Scanner V2] Rollback of partial surfaces failed (non-fatal):`, rollbackErr?.message || rollbackErr);
    }

    try {
      // If we had prior surfaces, status reverts to whatever Ready tier matches
      // their count — otherwise mark Scan Failed.
      if (priorSurfaceIds.length > 0) {
        await storage.updateVideoStatus(videoId, `Ready (${priorSurfaceIds.length} Spots)`);
      } else {
        await storage.updateVideoStatus(videoId, "Scan Failed");
      }
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

/**
 * Phase 2A: Dense re-scan for a specific time range at higher frame density.
 * Used before remix clip generation to get smoother motion tracking keyframes.
 *
 * Extracts frames at 0.5s intervals (4x denser than standard 2s scan),
 * runs Gemini surface detection on each, and creates keyframe entries
 * linked to existing surface IDs.
 *
 * @param videoId - The video to re-scan
 * @param startTime - Clip start time in seconds
 * @param endTime - Clip end time in seconds
 * @param surfaceIds - Which surfaces to track (only create keyframes for matching surfaces)
 * @param intervalSeconds - Frame interval (default 0.5s)
 */
export async function denseScanRange(
  videoId: number,
  startTime: number,
  endTime: number,
  surfaceIds: number[],
  intervalSeconds: number = 0.5
): Promise<{ keyframesCreated: number }> {
  console.log(`[DenseScan] Starting dense scan for video ${videoId}: ${startTime.toFixed(1)}s-${endTime.toFixed(1)}s @ ${intervalSeconds}s intervals`);

  const video = await storage.getVideoById(videoId);
  if (!video || !(video as any).filePath) {
    console.error(`[DenseScan] Video not found or no file path`);
    return { keyframesCreated: 0 };
  }

  const tempDir = path.join(os.tmpdir(), `dense-scan-${videoId}-${Date.now()}`);
  const framesDir = path.join(tempDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  let videoPath: string | undefined;
  try {
    // Resolve video path (Object Storage or local)
    const filePath = (video as any).filePath;
    if (filePath.startsWith("/storage/")) {
      const objectKey = filePath.replace(/^\/storage\//, "public/");
      videoPath = await downloadToTempFile(objectKey, tempDir);
    } else {
      videoPath = path.resolve(process.cwd(), filePath);
    }

    if (!videoPath || !fs.existsSync(videoPath)) {
      console.error(`[DenseScan] Video file not found: ${videoPath}`);
      return { keyframesCreated: 0 };
    }

    // Load reference surfaces to match against
    const refSurfaces = await storage.getDetectedSurfaces(videoId);
    const targetSurfaces = refSurfaces.filter((s) => surfaceIds.includes(s.id));
    if (targetSurfaces.length === 0) {
      console.warn(`[DenseScan] No matching surfaces found for IDs: ${surfaceIds.join(", ")}`);
      return { keyframesCreated: 0 };
    }

    // Extract frames at dense interval for the specified range
    const duration = endTime - startTime;
    const fpsFilter = `fps=1/${intervalSeconds}`;
    const framePattern = path.join(framesDir, "frame_%05d.jpg");

    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-nostdin", "-y",
        "-ss", startTime.toString(),
        "-i", videoPath!,
        "-t", duration.toString(),
        "-vf", `${fpsFilter},scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease`,
        "-q:v", "3",
        framePattern,
      ]);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`))));
      proc.on("error", reject);
    });

    const frames = fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).sort();
    console.log(`[DenseScan] Extracted ${frames.length} frames`);

    // For dense tracking, we need a wider spatial tolerance because the camera can move
    // the surface significantly across the frame. When there's only one target surface of
    // a given type, we rely on type matching alone (the surface is unique).
    const CLUSTER_TOLERANCE = 0.40; // 40% tolerance for camera movement
    const keyframeBatch: Array<{
      surfaceId: number;
      videoId: number;
      timestamp: string;
      boundingBoxX: string;
      boundingBoxY: string;
      boundingBoxWidth: string;
      boundingBoxHeight: string;
      confidence: string;
    }> = [];

    // Count how many target surfaces share each type (for matching strategy)
    const typeCounts = new Map<string, number>();
    for (const t of targetSurfaces) {
      const key = t.surfaceType.toLowerCase();
      typeCounts.set(key, (typeCounts.get(key) || 0) + 1);
    }

    for (let i = 0; i < frames.length; i++) {
      const framePath = path.join(framesDir, frames[i]);
      const timestamp = startTime + i * intervalSeconds;

      try {
        const analysis = await analyzeFrameWithGeminiRetry(framePath, timestamp, false);

        if (analysis.hasSurface && analysis.surfaces.length > 0) {
          // Match detected surfaces to our target surfaces
          for (const detected of analysis.surfaces) {
            const centerX = detected.boundingBox.x + detected.boundingBox.width / 2;
            const centerY = detected.boundingBox.y + detected.boundingBox.height / 2;

            for (const target of targetSurfaces) {
              const typeMatch = detected.surfaceType.toLowerCase() === target.surfaceType.toLowerCase();
              if (!typeMatch) continue;

              // If this is the only surface of its type, match by type alone —
              // the surface is unique so spatial proximity is unnecessary
              // (and would reject valid matches when camera moves significantly)
              const typeCount = typeCounts.get(target.surfaceType.toLowerCase()) || 1;
              let shouldMatch = false;

              if (typeCount === 1) {
                // Unique surface type → type match is sufficient
                shouldMatch = true;
              } else {
                // Multiple surfaces of same type → also require spatial proximity
                const targetCX = parseFloat(String(target.boundingBoxX)) + parseFloat(String(target.boundingBoxWidth)) / 2;
                const targetCY = parseFloat(String(target.boundingBoxY)) + parseFloat(String(target.boundingBoxHeight)) / 2;
                const posMatch = Math.abs(centerX - targetCX) < CLUSTER_TOLERANCE && Math.abs(centerY - targetCY) < CLUSTER_TOLERANCE;
                shouldMatch = posMatch;
              }

              if (shouldMatch) {
                keyframeBatch.push({
                  surfaceId: target.id,
                  videoId,
                  timestamp: timestamp.toFixed(2),
                  boundingBoxX: detected.boundingBox.x.toFixed(6),
                  boundingBoxY: detected.boundingBox.y.toFixed(6),
                  boundingBoxWidth: detected.boundingBox.width.toFixed(6),
                  boundingBoxHeight: detected.boundingBox.height.toFixed(6),
                  confidence: detected.confidence.toFixed(4),
                });
                break; // matched, move to next detected surface
              }
            }
          }
        }
      } finally {
        safeUnlink(framePath);
      }
    }

    // Remove existing keyframes in this time range to prevent duplicates
    // (if dense scan runs twice for the same range, old keyframes are replaced)
    if (keyframeBatch.length > 0) {
      for (const surfaceId of surfaceIds) {
        try {
          await storage.deleteSurfaceKeyframesInRange(surfaceId, startTime, endTime);
        } catch (delErr: any) {
          console.warn(`[DenseScan] Failed to clear old keyframes for surface ${surfaceId}: ${delErr.message}`);
        }
      }
      await storage.bulkInsertSurfaceKeyframes(keyframeBatch);
    }

    console.log(`[DenseScan] Created ${keyframeBatch.length} keyframes for ${targetSurfaces.length} surface(s)`);
    return { keyframesCreated: keyframeBatch.length };
  } catch (err: any) {
    console.error(`[DenseScan] Failed: ${err.message}`);
    return { keyframesCreated: 0 };
  } finally {
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
    let resolvedPath = videoPath;
    if (videoPath.startsWith('/storage/')) {
      try {
        const objectKey = videoPath.replace(/^\/storage\//, 'public/');
        resolvedPath = await downloadToTempFile(objectKey, tempDir);
        console.log(`[Scanner V2] detectSurface: Downloaded from Object Storage: ${resolvedPath}`);
      } catch (e: any) {
        console.error(`[Scanner V2] detectSurface: Object Storage download failed:`, e.message);
        return { hasSurface: false, confidence: 0 };
      }
    }

    if (!fs.existsSync(resolvedPath)) {
      return { hasSurface: false, confidence: 0 };
    }
    
    fs.mkdirSync(framesDir, { recursive: true });
    
    const frames = await extractFrames(resolvedPath, framesDir);
    
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
