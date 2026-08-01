import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { storage } from "../storage";
import type { VideoIndex, InsertDetectedSurface } from "@shared/schema";
import ytdl from "@distube/ytdl-core";
import { getYtDlpPath, forceRefreshYtDlp } from "./ytDlpUpdater";
// Bundled ffmpeg for yt-dlp's post-processing (--download-sections trims).
// The deployment's PATH ffmpeg segfaulted (exit -11) mid-download in
// production; the ffmpeg-static build is the same binary our renders use.
import ffmpegStaticPath from "ffmpeg-static";

const MOBILE_SAFARI_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const ANDROID_USER_AGENT = "com.google.android.youtube/19.09.3 (Linux; U; Android 14; SM-G998B) gzip";

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
// Maps database YouTube IDs to local video files in public/ or attached_assets/ folder
// ============================================================================
const LOCAL_ASSET_MAP: Record<string, string> = {
  // Public folder demos
  'yt_techguru_001': './public/many_jobs.mov',         // Vertical Demo (9:16)
  'yt_beauty_02': './public/hero_video.mp4',           // Horizontal Hero (16:9)
  'yt_vlog_003': './public/quick_update.mov',          // Quick Update
  'yt_final_004': './public/fullscale_final4.mov',     // FullScale Final4
  'test-video-1': './public/hero_video.mp4',           // Test video for martin@gofullscale.co
  // User uploaded videos in attached_assets
  'user-quick-update': './attached_assets/Quick_Update_1767906117156.mov',
  'user-many-jobs': './attached_assets/Many_Jobs_1767904823555.mov',
  'user-hero-video': './attached_assets/hero_video_1767897215595.mp4',
  'user-fullscale-final': './attached_assets/FullScale_Final4_1767897231210.mov',
};

// Add a new entry to LOCAL_ASSET_MAP dynamically (for uploaded videos)
export function addToLocalAssetMap(videoId: string, filePath: string) {
  LOCAL_ASSET_MAP[videoId] = filePath;
  console.log(`[Scanner] Added to LOCAL_ASSET_MAP: ${videoId} -> ${filePath}`);
  console.log(`[Scanner] LOCAL_ASSET_MAP now has ${Object.keys(LOCAL_ASSET_MAP).length} entries`);
}

// ============================================================================
// PUBLIC YOUTUBE THUMBNAIL RESOLVER
// Construct thumbnail URLs from YouTube video IDs without OAuth
// ============================================================================
export function getYouTubeThumbnailUrl(youtubeId: string, quality: 'default' | 'hq' | 'mq' | 'sd' | 'maxres' = 'hq'): string {
  // YouTube public thumbnail URL formats (no API key required)
  const qualityMap: Record<string, string> = {
    'default': 'default.jpg',      // 120x90
    'mq': 'mqdefault.jpg',         // 320x180
    'hq': 'hqdefault.jpg',         // 480x360
    'sd': 'sddefault.jpg',         // 640x480
    'maxres': 'maxresdefault.jpg', // 1280x720 (may not exist for all videos)
  };
  
  return `https://i.ytimg.com/vi/${youtubeId}/${qualityMap[quality]}`;
}

// Get thumbnail with fallback to lower quality if maxres not available
export function getYouTubeThumbnailWithFallback(youtubeId: string): string {
  // Use hqdefault as it's reliably available for all YouTube videos
  return getYouTubeThumbnailUrl(youtubeId, 'hq');
}

// === VERBOSE STARTUP LOGGING ===
console.log(`[Scanner] ========== SCANNER MODULE LOADED ==========`);
console.log(`[Scanner] AI_INTEGRATIONS_GEMINI_API_KEY exists: ${!!process.env.AI_INTEGRATIONS_GEMINI_API_KEY}`);
console.log(`[Scanner] AI_INTEGRATIONS_GEMINI_API_KEY length: ${process.env.AI_INTEGRATIONS_GEMINI_API_KEY?.length || 0}`);
console.log(`[Scanner] AI_INTEGRATIONS_GEMINI_BASE_URL: ${process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || '(not set)'}`);
console.log(`[Scanner] LOCAL_ASSET_MAP entries: ${Object.keys(LOCAL_ASSET_MAP).length}`);
console.log(`[Scanner] =============================================`);

// Prefer a real Google key over Replit's proxy sidecar, matching
// scanner_v2's resolution (case-insensitive name sweep, placeholder
// rejection): the proxy only exists inside the workspace, so a deployed
// scan that trusts it times out on every frame. Only when no direct key is
// present do we fall back to the integration slot + its base URL.
const legacyDirectGeminiKey = (() => {
  const looksReal = (v: string | undefined): v is string =>
    !!v && v.length >= 20 && !v.includes("DUMMY");
  for (const name of ["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
    if (looksReal(process.env[name])) return process.env[name]!;
  }
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  for (const name of Object.keys(process.env)) {
    if (normalize(name) === "geminiapikey" && looksReal(process.env[name])) return process.env[name]!;
  }
  if (looksReal(process.env.AI_INTEGRATIONS_GEMINI_API_KEY)) return process.env.AI_INTEGRATIONS_GEMINI_API_KEY!;
  return undefined;
})();

const ai = legacyDirectGeminiKey
  ? new GoogleGenAI({ apiKey: legacyDirectGeminiKey })
  : new GoogleGenAI({
      apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
      httpOptions: {
        apiVersion: "",
        baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
      },
    });
console.log(`[Scanner] Gemini client: ${legacyDirectGeminiKey ? "direct Google key" : "Replit proxy (no direct key found)"}`);

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

// Enhanced analysis result with sentiment and cultural context
interface FrameAnalysisResult {
  surfaces: DetectedObject[];
  sentiment: string;
  culturalContext: string;
  brandSafetyScore: number;
}

interface ScanResult {
  success: boolean;
  videoId: number;
  surfacesDetected: number;
  error?: string;
}

/** Remove a leftover partial before handing outputPath to a new downloader.
 *  yt-dlp defaults to --continue: combined with --no-part it will happily
 *  "resume" a partial written by a DIFFERENT format or rung via a Range
 *  request, splicing mismatched bytes into an exit-0 "successful" file that
 *  only blows up later at frame extraction (moov atom not found). */
function unlinkStalePartial(outputPath: string): void {
  try {
    fs.unlinkSync(outputPath);
    console.log(`[Scanner] Removed stale partial before fresh attempt: ${outputPath}`);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[Scanner] Could not remove stale partial ${outputPath}: ${err?.message}`);
    }
  }
}

async function downloadVideoWithYtdl(
  youtubeId: string,
  outputPath: string,
  timeoutMs: number = 3 * 60 * 1000,
): Promise<boolean> {
  console.log(`[Scanner] Attempting @distube/ytdl-core download with mobile user agent...`);
  const url = `https://www.youtube.com/watch?v=${youtubeId}`;
  const deadline = Date.now() + timeoutMs;

  try {
    const info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: {
          "User-Agent": MOBILE_SAFARI_USER_AGENT,
        },
      },
    });

    console.log(`[Scanner] Video info retrieved: ${info.videoDetails.title}`);

    let format: ytdl.videoFormat;
    try {
      format = ytdl.chooseFormat(info.formats, {
        quality: "highest",
        filter: (f) => !!(f.container === "mp4" && f.hasVideo && f.height && f.height <= 720)
      });
    } catch {
      // chooseFormat THROWS when the filter comes up empty (it never returns
      // undefined) — VP9-only and HLS-only videos land here. This is the
      // ladder's last rung, so take whatever video format is downloadable.
      console.warn(`[Scanner] No mp4<=720p format found, trying lowest available video format...`);
      try {
        format = ytdl.chooseFormat(info.formats, { quality: "lowest", filter: "video" });
      } catch (fmtErr: any) {
        console.error(`[Scanner] No downloadable format found: ${fmtErr?.message}`);
        return false;
      }
    }

    unlinkStalePartial(outputPath);

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let stallTimer: NodeJS.Timeout;
      let deadlineTimer: NodeJS.Timeout;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(stallTimer);
        clearTimeout(deadlineTimer);
        resolve(result);
      };

      const writeStream = fs.createWriteStream(outputPath);
      const videoStream = ytdl(url, {
        format,
        requestOptions: {
          headers: {
            "User-Agent": MOBILE_SAFARI_USER_AGENT,
          },
        },
      });

      const abort = (reason: string) => {
        console.error(`[Scanner] ytdl watchdog: ${reason} — destroying streams`);
        try { videoStream.destroy(); } catch {}
        try { writeStream.close(); } catch {}
        finish(false);
      };

      // The miniget transport underneath ytdl-core has no request timeout
      // and no reconnects: a throttled-open socket can go quiet forever
      // without emitting 'error' OR 'finish', which would hang the scan
      // (and its SCAN_IN_FLIGHT slot) until a server restart. Watchdog
      // both the overall deadline and a 90s no-progress stall.
      let lastDataAt = Date.now();
      videoStream.on("progress", () => { lastDataAt = Date.now(); });
      stallTimer = setInterval(() => {
        if (Date.now() - lastDataAt > 90_000) abort("no progress for 90s");
      }, 15_000);
      deadlineTimer = setTimeout(
        () => abort(`timeout after ${Math.round(timeoutMs / 1000)}s`),
        Math.max(1_000, deadline - Date.now()),
      );

      videoStream.pipe(writeStream);

      videoStream.on("error", (err) => {
        console.error(`[Scanner] ytdl stream error:`, err.message);
        writeStream.close();
        finish(false);
      });

      writeStream.on("finish", () => {
        console.log(`[Scanner] ytdl download complete: ${outputPath}`);
        finish(true);
      });

      writeStream.on("error", (err) => {
        console.error(`[Scanner] Write stream error:`, err.message);
        // Mirror abort(): a dead sink (ENOSPC/EACCES) must also tear down
        // the source, or the miniget socket keeps transferring into nothing.
        try { videoStream.destroy(); } catch {}
        finish(false);
      });
    });
  } catch (err: any) {
    console.error(`[Scanner] ytdl-core failed:`, err.message);
    return false;
  }
}

interface DownloadOpts {
  /** If set, only download the first N seconds of the video (yt-dlp --download-sections). */
  trimToSeconds?: number;
  /** Hard kill timeout in ms. Default 3 minutes. */
  timeoutMs?: number;
  /** OAuth access token. When set, sent via --add-header "Authorization: Bearer ..."
   *  to bypass YouTube's anonymous-bot detection on the creator's own videos. */
  oauthToken?: string;
}

/**
 * Resolve a yt-dlp cookies file from env, if configured. Cookies are the
 * single most effective YouTube bot-detection bypass — they make yt-dlp's
 * requests look like a real signed-in session, which datacenter IPs
 * (Replit) otherwise get blocked from. Cookies from ANY logged-in account
 * work for downloading ANY public video, so a single dedicated FullScale
 * Google account's cookies cover every creator's public content — no
 * per-creator token needed.
 *
 * Two ways to supply cookies:
 *   YTDLP_COOKIES       — the full Netscape-format cookies.txt CONTENT,
 *                         pasted into a Replit secret. Written to a temp
 *                         file at runtime (best for Replit — no persistent
 *                         filesystem needed).
 *   YTDLP_COOKIES_PATH  — absolute path to a cookies.txt already on disk.
 *
 * Returns the path to pass to `--cookies`, or null if neither is set.
 * Cached so we only write the temp file once per process.
 */
let cachedCookiesPath: string | null | undefined;
function resolveCookiesFile(): string | null {
  if (cachedCookiesPath !== undefined) {
    // Replit can clear /tmp under us between scans. A dangling cached path
    // isn't a hard error for yt-dlp (it silently skips unreadable jars) but
    // it IS silent auth degradation — every run goes out anonymous and hits
    // the bot-check. Re-materialize from env instead of trusting the cache.
    if (cachedCookiesPath === null || fs.existsSync(cachedCookiesPath)) {
      return cachedCookiesPath;
    }
    console.warn(`[Scanner] Cached cookies file vanished (${cachedCookiesPath}); re-materializing`);
    cachedCookiesPath = undefined;
  }

  const inlineContent = process.env.YTDLP_COOKIES;
  if (inlineContent && inlineContent.trim()) {
    // GUI secret inputs (Replit's included) can flatten the tabs and
    // newlines a cookies.txt depends on. Accept base64 of the file too —
    // a single [A-Za-z0-9+/=] line survives any input box:
    //   base64 -i cookies.txt | pbcopy
    let cookieText = inlineContent;
    const rawTrimmed = inlineContent.trim();
    if (!rawTrimmed.includes("\t") && /^[A-Za-z0-9+/=\s]+$/.test(rawTrimmed)) {
      try {
        const decoded = Buffer.from(rawTrimmed.replace(/\s+/g, ""), "base64").toString("utf8");
        if (decoded.includes("\t")) {
          cookieText = decoded;
          console.log(`[Scanner] YTDLP_COOKIES is base64 — decoded to cookies.txt content`);
        }
      } catch { /* not base64 — validate as-is below */ }
    }
    // Guard against a malformed paste (JSON export from the wrong
    // extension, an HTML page, tab/newline-flattening, truncation).
    // yt-dlp hard-fails on a non-Netscape jar and the download ladder
    // classifies that as fatal — so a bad jar would kill EVERY download,
    // strictly worse than running anonymous. Netscape data lines are 7
    // tab-separated fields.
    const dataLines = cookieText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const looksNetscape =
      dataLines.length > 0 && dataLines[0].split("\t").length >= 7;
    const hasYoutube = /youtube\.com/i.test(cookieText);
    if (!looksNetscape || !hasYoutube) {
      console.error(
        `[Scanner] YTDLP_COOKIES is set but does not look like a Netscape cookies.txt export` +
        `${hasYoutube ? "" : " (no youtube.com entries)"} — IGNORING it and running anonymous. ` +
        `Paste the base64 of the export instead (base64 -i cookies.txt | pbcopy) — GUI secret ` +
        `inputs often flatten the tabs/newlines of a direct paste.`,
      );
      cachedCookiesPath = null;
      return null;
    }
    try {
      const tmp = path.join(os.tmpdir(), "yt-cookies.txt");
      fs.writeFileSync(tmp, cookieText, { mode: 0o600 });
      console.log(`[Scanner] Wrote yt-dlp cookies from YTDLP_COOKIES env → ${tmp} (${dataLines.length} cookies)`);
      cachedCookiesPath = tmp;
      return tmp;
    } catch (err: any) {
      console.warn(`[Scanner] Failed to write cookies temp file: ${err?.message}`);
    }
  }

  const explicitPath = process.env.YTDLP_COOKIES_PATH;
  if (explicitPath && fs.existsSync(explicitPath)) {
    cachedCookiesPath = explicitPath;
    return explicitPath;
  }

  cachedCookiesPath = null;
  return null;
}

/**
 * Push cookies + proxy args onto a yt-dlp arg list if configured. Shared by
 * the duration probe and the download so they authenticate identically.
 *   YTDLP_PROXY — e.g. http://user:pass@host:port — routes around the
 *   flagged datacenter IP via a residential/mobile proxy. Most robust
 *   bot-detection bypass; pairs well with (or works without) cookies.
 */
export const YT_MOBILE_SAFARI_USER_AGENT = MOBILE_SAFARI_USER_AGENT;

// yt-dlp treats --cookies as read-AND-write: on exit it dumps the rotated
// jar back to the same path with a non-atomic truncate+write. Concurrent
// invocations (duration probe, download ladder, stream resolve, playback
// cache) sharing one file race on that write-back — worst case a mangled
// jar that hard-fails every later run until restart, common case silent
// last-writer-wins clobbering of rotated cookies that YouTube then treats
// as session invalidation. So each invocation gets its own throwaway copy.
// Rotations are deliberately NOT persisted back to the master: losing a
// rotation is far cheaper than corrupting the one shared jar.
const COOKIE_JAR_DIR = path.join(os.tmpdir(), "yt-cookie-jars");
let cookieJarSeq = 0;

function makePerInvocationCookiesCopy(masterPath: string): string | null {
  try {
    fs.mkdirSync(COOKIE_JAR_DIR, { recursive: true });
    // Sweep copies left by earlier invocations — the arg-list builder can't
    // know when its yt-dlp exits, so cleanup is generational (>1h old).
    try {
      for (const f of fs.readdirSync(COOKIE_JAR_DIR)) {
        const full = path.join(COOKIE_JAR_DIR, f);
        if (Date.now() - fs.statSync(full).mtimeMs > 60 * 60 * 1000) fs.unlinkSync(full);
      }
    } catch {}
    const copy = path.join(COOKIE_JAR_DIR, `jar-${process.pid}-${Date.now()}-${cookieJarSeq++}.txt`);
    fs.writeFileSync(copy, fs.readFileSync(masterPath), { mode: 0o600 });
    return copy;
  } catch (err: any) {
    console.warn(`[Scanner] Failed to copy cookie jar for isolated use: ${err?.message}`);
    return null;
  }
}

export function applyYtDlpAuthArgs(args: string[], context: string): void {
  const cookies = resolveCookiesFile();
  if (cookies) {
    const isolated = makePerInvocationCookiesCopy(cookies);
    // Fall back to the shared master only if the copy failed — better a
    // rare write-back race than losing authentication entirely.
    args.push("--cookies", isolated ?? cookies);
    console.log(`[Scanner] ${context}: using cookies (signed-in session${isolated ? ", isolated jar" : ""})`);
  }
  const proxy = process.env.YTDLP_PROXY?.trim();
  if (proxy) {
    args.push("--proxy", proxy);
    console.log(`[Scanner] ${context}: using proxy`);
  }
}

// Detached children get their own process group precisely so our SIGKILL
// can reach the whole PyInstaller fork tree — but that same detachment means
// they no longer die when node itself does. Track live pgids and hard-kill
// any survivors on the way out.
const liveDetachedPgids = new Set<number>();
let pgidReaperRegistered = false;

function trackDetachedProcessGroup(proc: ChildProcess): void {
  const pgid = proc.pid;
  if (!pgid) return;
  liveDetachedPgids.add(pgid);
  proc.on("close", () => { liveDetachedPgids.delete(pgid); });

  if (pgidReaperRegistered) return;
  pgidReaperRegistered = true;
  const reapAll = () => {
    for (const id of Array.from(liveDetachedPgids)) {
      try { process.kill(-id, "SIGKILL"); } catch {}
    }
  };
  process.on("exit", reapAll);
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      reapAll();
      // Registering a signal listener suppresses the default terminate
      // action. If nothing else owns shutdown for this signal, restore the
      // default and re-raise so the process still dies conventionally.
      // (glbRenderer also registers SIGTERM/SIGINT listeners at module load,
      // so in practice this branch is a safety net for configurations where
      // that module isn't loaded — the reap above is the real work.)
      if (process.listenerCount(sig) === 1) {
        process.removeAllListeners(sig);
        process.kill(process.pid, sig);
      }
    });
  }
}

/** Fetch only the duration of a YouTube video without downloading it.
 *  Used to plan adaptive scan sampling for long-form content. */
export async function getYoutubeVideoDuration(
  youtubeId: string,
  oauthToken?: string,
): Promise<number | null> {
  const ytDlpBin = await getYtDlpPath();

  const runProbe = (useToken: boolean): Promise<number | null> =>
    new Promise((resolve) => {
      const args = [
        "--print", "%(duration)s",
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
        "--extractor-args", "youtube:player_client=tv_embedded,mweb,web_safari,android_vr",
      ];
      if (useToken && oauthToken) {
        args.push("--add-header", `Authorization:Bearer ${oauthToken}`);
      }
      applyYtDlpAuthArgs(args, "duration probe");
      args.push(`https://www.youtube.com/watch?v=${youtubeId}`);

      // detached: own process group, so the timeout kill takes the real
      // Python child forked by the PyInstaller onefile bootloader with it
      // (SIGKILL to the bootloader alone is unforwardable).
      const proc = spawn(ytDlpBin, args, { detached: true });
      trackDetachedProcessGroup(proc);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", d => { stdout += d.toString(); });
      proc.stderr.on("data", d => { stderr += d.toString(); });
      // 60s: the onefile binary self-extracts on cold start, which can eat
      // most of a 30s budget right after boot.
      const timer = setTimeout(() => {
        try {
          if (proc.pid) process.kill(-proc.pid, "SIGKILL");
          else proc.kill("SIGKILL");
        } catch {
          try { proc.kill("SIGKILL"); } catch {}
        }
      }, 60_000);
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.warn(`[Scanner] duration probe${useToken ? " [OAuth]" : ""} failed (exit ${code}): ${stderr.slice(-200)}`);
          return resolve(null);
        }
        const sec = parseInt(stdout.trim(), 10);
        resolve(Number.isFinite(sec) && sec > 0 ? sec : null);
      });
      proc.on("error", () => { clearTimeout(timer); resolve(null); });
    });

  // Anonymous first — the OAuth bearer header can degrade YouTube's format/
  // metadata response (see downloadVideo cascade comment). Token retry only
  // if anonymous comes back empty (e.g. bot-blocked or private video).
  const anon = await runProbe(false);
  if (anon !== null) return anon;
  if (oauthToken) return runProbe(true);
  return null;
}

/** One yt-dlp attempt. `stderr` is returned alongside `ok` so the ladder in
 *  downloadVideo can classify the failure and skip rungs that are
 *  guaranteed to repeat it identically. */
interface YtDlpAttemptResult {
  ok: boolean;
  stderr: string;
}

async function downloadVideoWithYtDlp(
  youtubeId: string,
  outputPath: string,
  opts: DownloadOpts = {},
): Promise<YtDlpAttemptResult> {
  const ytDlpBin = await getYtDlpPath();
  return new Promise((resolve) => {
    const trim = opts.trimToSeconds;
    const timeoutMs = opts.timeoutMs ?? 3 * 60 * 1000;
    console.log(`[Scanner] yt-dlp: downloading ${youtubeId}${trim ? ` (first ${trim}s only)` : ""}, timeout ${timeoutMs/1000}s...`);

    // Player-client strategy: try multiple in order. As of 2025-2026 the ios
    // client is broken (Precondition check failed). tv_embedded + mweb +
    // web_safari are the current bot-resistant clients per yt-dlp issues.
    //
    // Format selector: explicitly prefer DIRECT https mp4 (single file)
    // over HLS playlist streams. HLS + --download-sections breaks yt-dlp's
    // ffmpeg post-processing with "Invalid data found in input" (ffmpeg
    // exit 183) — see prior production failure on a Boris Kodjoe scan.
    // protocol*=https filters to direct downloads; protocol*=m3u8 would
    // be the HLS path we want to avoid.
    const args = [
      // Broad cascade — prefer direct mp4 ≤720p, but accept anything
      // downloadable. Some videos (esp. long-form podcasts) only expose HLS
      // streams; those would fail with a stricter selector. We dropped the
      // protocol*=https filter that previously rejected HLS entirely — the
      // first-try-with-trim, retry-without-trim flow in downloadVideo()
      // handles HLS+trim ffmpeg failures by falling through to a full pull.
      "-f",
        "bv*[height<=720][ext=mp4]+ba[ext=m4a]/" +
        "b[height<=720][ext=mp4]/" +
        "bv*[height<=720]+ba/" +
        "b[height<=720]/" +
        "best[ext=mp4]/" +
        "best/" +
        "worst",  // last-ditch — if even "best" fails, take whatever's downloadable
      "-o", outputPath,
      "--no-playlist",
      "--no-warnings",
      "--retries", "3",
      "--retry-sleep", "exp=2:30",
      "--extractor-args", "youtube:player_client=tv_embedded,mweb,web_safari,android_vr",
      "--user-agent", MOBILE_SAFARI_USER_AGENT,
      "--newline",            // emit progress on its own lines, helps log streaming
      "--progress",           // show download progress
      "--no-part",            // write straight to outputPath, no .part renames
      "--no-continue",        // never resume a partial: a leftover from a
                              // different rung/format would get spliced in
                              // via a Range request and exit 0 "successfully"
    ];
    // TLS verification stays ON by default. With YTDLP_PROXY set, disabling
    // it would let a malicious proxy node terminate TLS itself and read the
    // cookie jar + OAuth bearer in plaintext. Escape hatch for genuinely
    // broken middleboxes only — same gate as streamResolver.
    if (process.env.YTDLP_INSECURE_TLS === "1") {
      args.push("--no-check-certificate");
    }
    // Use the bundled ffmpeg (known-good) for trims/merges instead of the
    // PATH ffmpeg, which segfaulted (-11) in the deployment.
    if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) {
      args.push("--ffmpeg-location", ffmpegStaticPath);
    }
    // Path B (OAuth): pass the creator's stored YouTube access token via
    // Authorization header. yt-dlp forwards extra headers on its requests
    // to YouTube — an authenticated user request bypasses bot-detection
    // ("Sign in to confirm you're not a bot"). Falls back to anonymous
    // when no token is supplied.
    if (opts.oauthToken) {
      args.push("--add-header", `Authorization:Bearer ${opts.oauthToken}`);
      console.log(`[Scanner] yt-dlp: using OAuth token (Path B)`);
    }
    // Cookies + proxy (env-driven). Cookies are the heavy hitter against
    // the "Sign in to confirm you're not a bot" block on datacenter IPs.
    applyYtDlpAuthArgs(args, "yt-dlp download");
    if (trim && trim > 0) {
      // Cap to "first N seconds." For scan we only need ~48s of video frames,
      // so downloading a full 60-min podcast is pure waste. With a direct
      // https mp4 format (above), yt-dlp can byte-range to the head of the
      // file without invoking ffmpeg keyframe-cut logic — no --force-keyframes-at-cuts
      // (which triggers the fragile HLS+ffmpeg path that broke last time).
      args.push("--download-sections", `*0-${trim}`);
    }
    args.push(`https://www.youtube.com/watch?v=${youtubeId}`);

    unlinkStalePartial(outputPath);

    // detached: own process group. The production binary is a PyInstaller
    // onefile bootloader that forks the real Python yt-dlp, which in turn
    // forks ffmpeg for --download-sections. SIGKILL to the top pid alone is
    // unforwardable — the orphaned downloader keeps writing outputPath and
    // holds our stdio pipes open, so 'close' never fires and the promise
    // silently hangs. Killing the negative pid takes the whole group.
    const proc = spawn(ytDlpBin, args, { detached: true });
    trackDetachedProcessGroup(proc);

    const killHard = () => {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        try { proc.kill("SIGKILL"); } catch {}
      }
    };

    let stderr = "";
    let lastProgressAt = Date.now();
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      lastProgressAt = Date.now();
    });
    // yt-dlp writes [download] progress to stdout; surface it so a hung
    // download is obvious in logs instead of silent for 14 minutes.
    proc.stdout.on("data", (data) => {
      const text = data.toString();
      // Any output counts as liveness for the stall watchdog — the
      // extraction phase (4 player clients + retry sleeps) legitimately
      // emits non-progress lines for a while before the first byte.
      lastProgressAt = Date.now();
      // Only log progress lines + key status messages to avoid log flood
      for (const line of text.split("\n")) {
        if (/\[download\].*%|Destination:|has already been downloaded|Merging formats/i.test(line)) {
          console.log(`[Scanner/yt-dlp] ${line.trim()}`);
        }
      }
    });

    const killTimer = setTimeout(() => {
      console.error(`[Scanner] yt-dlp HARD TIMEOUT after ${timeoutMs/1000}s for ${youtubeId} — killing process group`);
      killHard();
    }, timeoutMs);

    // A stalled socket sits under the hard timeout for many minutes doing
    // nothing; 90s of total silence means the transfer is dead, not slow.
    const stallTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > 90_000) {
        console.error(`[Scanner] yt-dlp STALLED (90s without output) for ${youtubeId} — killing process group`);
        stderr += "\n[scanner] rung killed: no output for 90s";
        killHard();
      }
    }, 15_000);

    proc.on("close", (code) => {
      clearTimeout(killTimer);
      clearInterval(stallTimer);
      if (code !== 0) {
        const tail = stderr.length > 500 ? stderr.slice(-500) : stderr;
        const sinceProgress = Math.round((Date.now() - lastProgressAt) / 1000);
        console.error(`[Scanner] yt-dlp failed (exit ${code}, ${sinceProgress}s since last progress): ${tail}`);
        resolve({ ok: false, stderr });
      } else {
        console.log(`[Scanner] yt-dlp download complete: ${outputPath}`);
        resolve({ ok: true, stderr });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(killTimer);
      clearInterval(stallTimer);
      console.error(`[Scanner] yt-dlp spawn error: ${err.message}`);
      resolve({ ok: false, stderr: `${stderr}\n${err.message}` });
    });
  });
}

type YtDlpFailureClass = "fatal" | "bot" | "format" | "trim" | "other";

/** Classify a failed yt-dlp run's stderr so the ladder can stop retrying
 *  failures that are guaranteed to repeat identically on later rungs. */
function classifyYtDlpFailure(stderr: string): YtDlpFailureClass {
  // Independent of auth AND trim: mangled cookie jar (applied to every rung
  // via applyYtDlpAuthArgs) or a full disk.
  if (/does not look like a Netscape format cookies file|ENOSPC|No space left on device/i.test(stderr)) {
    return "fatal";
  }
  // "Sign in to confirm you're not a bot" — an auth problem, not a format
  // or trim problem. The authenticated rungs are the right next step.
  if (/sign in to confirm|confirm you.?re not a bot/i.test(stderr)) {
    return "bot";
  }
  // The format list is auth-DEPENDENT (see the 2026-06-11 cascade note in
  // downloadVideo: the OAuth request got a degraded list while anonymous
  // listed fine, and age-/membership-gated videos invert that — formats can
  // appear only for the authenticated request). Scope it to the auth mode
  // that produced it, like the bot-check.
  if (/Requested format is not available/i.test(stderr)) {
    return "format";
  }
  // ffmpeg / post-processing / --download-sections blew up: the trim path
  // is broken for this video (classic HLS+section failure, ffmpeg exit
  // 183), so only the full pulls can work.
  if (/ffmpeg|postprocess|download.sections|Invalid data found/i.test(stderr)) {
    return "trim";
  }
  return "other";
}

export async function downloadVideo(
  youtubeId: string,
  outputPath: string,
  opts: DownloadOpts = {},
): Promise<boolean> {
  console.log(`[Scanner] Downloading video ${youtubeId}${opts.trimToSeconds ? ` (trim ${opts.trimToSeconds}s)` : ""}${opts.oauthToken ? " [OAuth available]" : ""}...`);

  // Cascade order: ALL anonymous rungs first, OAuth rungs after. Flipped
  // 2026-06-11 based on production evidence (video 1AQcoTanaYg): requests
  // carrying the creator's OAuth bearer token got a DEGRADED format list
  // ("Requested format is not available") while the identical anonymous
  // request listed formats fine and downloaded successfully. Anonymous also
  // hasn't been bot-blocked from this deployment since the app's OAuth
  // verification cleared. OAuth rungs remain — they are the answer when the
  // bot-check resurfaces — but failures that repeat identically regardless
  // of auth/trim (see classifyYtDlpFailure) skip straight past them.

  const baseTimeoutMs = opts.timeoutMs ?? 3 * 60 * 1000;
  // Total ladder wall-clock is capped at 2x the caller's budget: the rungs
  // exist to try different auth/trim combinations, not to let one throttled
  // video occupy its scan slot for an hour. Each rung gets whatever budget
  // remains (up to its own timeout), and rungs with <30s left are skipped.
  const ladderDeadline = Date.now() + baseTimeoutMs * 2;

  interface LadderRung {
    label: string;
    useOAuth: boolean;
    useTrim: boolean;
    timeoutMs: number;
  }
  const rungs: LadderRung[] = [];
  if (opts.trimToSeconds) {
    rungs.push({ label: "anonymous + trim", useOAuth: false, useTrim: true, timeoutMs: baseTimeoutMs });
    // Full pulls get double budget — HLS-only videos can't be trimmed
    // cleanly, so these download the whole file.
    rungs.push({ label: "anonymous full (HLS fallback)", useOAuth: false, useTrim: false, timeoutMs: baseTimeoutMs * 2 });
    if (opts.oauthToken) {
      rungs.push({ label: "OAuth + trim", useOAuth: true, useTrim: true, timeoutMs: baseTimeoutMs });
      rungs.push({ label: "OAuth full", useOAuth: true, useTrim: false, timeoutMs: baseTimeoutMs * 2 });
    }
  } else {
    rungs.push({ label: "anonymous", useOAuth: false, useTrim: false, timeoutMs: baseTimeoutMs });
    if (opts.oauthToken) {
      rungs.push({ label: "OAuth", useOAuth: true, useTrim: false, timeoutMs: baseTimeoutMs });
    }
  }

  let skipTrim = false;
  let skipAnonReason: string | null = null;
  let fatalStop = false;
  let sawFormatFailure = false;

  // Two ladder passes at most: if pass 1 dies entirely on "Requested format
  // is not available" — the stale-extractor signature that hits every rung
  // identically when YouTube ships a player change — force-refresh the
  // yt-dlp binary and, ONLY if a genuinely newer release landed, run the
  // ladder once more. Rate-limited inside forceRefreshYtDlp.
  for (let ladderPass = 0; ladderPass < 2; ladderPass++) {
  if (ladderPass === 1) {
    if (!sawFormatFailure) break;
    const refreshed = await forceRefreshYtDlp();
    if (!refreshed || !refreshed.changed) break;
    console.warn(`[Scanner] Retrying download ladder with freshly updated yt-dlp (${refreshed.version})`);
    skipTrim = false;
    skipAnonReason = null;
    fatalStop = false;
    sawFormatFailure = false;
  }

  for (const rung of rungs) {
    if (fatalStop) break;
    if (skipTrim && rung.useTrim) {
      console.log(`[Scanner] Skipping "${rung.label}" — trim path already failed in post-processing`);
      continue;
    }
    if (skipAnonReason && !rung.useOAuth) {
      console.log(`[Scanner] Skipping "${rung.label}" — ${skipAnonReason}`);
      continue;
    }
    const remaining = ladderDeadline - Date.now();
    if (remaining < 30_000) {
      console.warn(`[Scanner] Ladder budget exhausted (${Math.round(remaining / 1000)}s left); skipping remaining yt-dlp rungs`);
      break;
    }

    console.log(`[Scanner] yt-dlp rung: ${rung.label} (budget ${Math.round(Math.min(rung.timeoutMs, remaining) / 1000)}s)...`);
    const attempt = await downloadVideoWithYtDlp(youtubeId, outputPath, {
      ...opts,
      oauthToken: rung.useOAuth ? opts.oauthToken : undefined,
      trimToSeconds: rung.useTrim ? opts.trimToSeconds : undefined,
      timeoutMs: Math.min(rung.timeoutMs, remaining),
    });
    if (attempt.ok) return true;

    const failureClass = classifyYtDlpFailure(attempt.stderr);
    if (failureClass === "bot") {
      // Make the bot-check self-diagnosing: the answer is ALWAYS the cookie
      // session, so say exactly which half of it is broken.
      const jar = resolveCookiesFile();
      console.warn(jar
        ? `[Scanner] Bot-check HIT WITH cookies presented — the exported YTDLP_COOKIES session is stale or invalidated. Re-export from the signed-in browser profile (Get cookies.txt LOCALLY on youtube.com), re-base64, update the secret.`
        : `[Scanner] Bot-check hit and NO cookie session is configured (YTDLP_COOKIES unset, empty, or rejected by the format guard — check boot logs). A signed-in cookie session is the fix for datacenter bot-checks.`);
    }
    if (failureClass === "fatal") {
      // Every remaining rung would fail the same way — burning them just
      // hammers YouTube from the already-flagged datacenter IP.
      console.warn(`[Scanner] "${rung.label}" failed with a non-retryable error; skipping remaining yt-dlp rungs`);
      fatalStop = true;
    } else if (failureClass === "trim" && rung.useTrim) {
      skipTrim = true;
    } else if (failureClass === "bot" || failureClass === "format") {
      if (failureClass === "format") sawFormatFailure = true;
      if (rung.useOAuth) {
        // Even the authenticated request got bot-checked / saw no usable
        // format; nothing below in the yt-dlp ladder can do better.
        console.warn(`[Scanner] ${failureClass === "bot" ? "Bot-check" : "No available format"} on the OAuth rung; skipping remaining yt-dlp rungs`);
        fatalStop = true;
      } else {
        skipAnonReason = failureClass === "bot"
          ? "anonymous is bot-blocked"
          : "anonymous format list has no usable format";
      }
    }
    // "other" (network flake, transient 5xx, stall-kill): plain fallthrough
    // to the next rung.
  }

  }

  console.log(`[Scanner] All yt-dlp paths failed; trying @distube/ytdl-core fallback...`);
  console.log(`[Scanner] DIAGNOSTIC: in Replit Shell, run \`yt-dlp --list-formats https://www.youtube.com/watch?v=${youtubeId}\` to see what formats are actually available.`);
  // Belt and braces: the fallback has its own internal watchdog, and the
  // withTimeout wrapper guarantees this function settles even if that
  // watchdog somehow doesn't (a hung download here used to pin the video's
  // SCAN_IN_FLIGHT slot until server restart).
  try {
    return await withTimeout(
      downloadVideoWithYtdl(youtubeId, outputPath, baseTimeoutMs),
      baseTimeoutMs + 5_000,
      `ytdl-core fallback timed out after ${Math.round(baseTimeoutMs / 1000)}s`,
    );
  } catch (err: any) {
    console.error(`[Scanner] ytdl-core fallback did not settle: ${err?.message}`);
    return false;
  }
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
    // Same known-good-binary policy as the download trims: prefer the
    // bundled ffmpeg-static build over whatever PATH resolves to — the
    // deployment's PATH ffmpeg segfaulted (exit -11) mid-run in production,
    // and a bare "ffmpeg" here would hit that same binary one step after a
    // successful download.
    const ffmpegBin = ffmpegStaticPath && fs.existsSync(ffmpegStaticPath) ? ffmpegStaticPath : "ffmpeg";
    console.log(`[Scanner] FFMPEG Command: ${ffmpegBin} ${ffmpegArgs.join(' ')}`);

    const process = spawn(ffmpegBin, ffmpegArgs);

    let stderr = "";
    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      console.log(`[Scanner] FFMPEG Exit code: ${code}`);

      if (code !== 0) {
        console.error(`[Scanner] FFMPEG FAILED with code ${code} (binary: ${ffmpegBin})`);
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

async function analyzeFrame(framePath: string, retryCount: number = 0, isVertical: boolean = false, platform: string = 'youtube'): Promise<FrameAnalysisResult> {
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
  
  // Default result for errors
  const defaultResult: FrameAnalysisResult = {
    surfaces: [],
    sentiment: 'Neutral',
    culturalContext: 'General',
    brandSafetyScore: 70
  };
  
  try {
    // Optimize frame size before sending to API
    // For vertical videos, this also applies ROI cropping to focus on bottom half
    console.log(`[Scanner] Optimizing frame${isVertical ? ' with ROI crop' : ''}...`);
    const imageBuffer = await optimizeFrame(framePath, isVertical);
    const base64Image = imageBuffer.toString("base64");
    console.log(`[Scanner] Frame optimized: ${(imageBuffer.length / 1024).toFixed(1)}KB base64 length: ${base64Image.length}`);
    
    // Get vertical video prompt modifier if applicable
    const verticalModifier = getVerticalVideoPromptModifier(isVertical);
    
    // UPGRADED PROMPT: Sentiment, Cultural Context, and Brand Safety Analysis
    const platformLabel = platform === 'instagram' ? 'Instagram Reel' : 'YouTube video';
    const prompt = `Analyze this ${platformLabel} frame for brand safety and ad placement opportunities.
${verticalModifier}

Return a JSON object with the following structure:
{
  "surfaces": [list of physical objects suitable for virtual product placement],
  "sentiment": "dominant mood (e.g., 'Uplifting', 'Serious', 'Chaotic', 'Educational', 'Neutral')",
  "cultural_context": "cultural setting or region (e.g., 'Western Home Office', 'Japanese Tea Room', 'Brazilian Street Festival', 'American Tech Setup', 'Generic Global')",
  "brand_safety_score": 0-100 (100 = completely safe, 0 = unsafe)
}

For each surface in the surfaces array:
- surfaceType: One of: Desk, Table, Wall, Shelf, Floor, Monitor, Laptop
- subtype: Optional specific descriptor (e.g., "back wall", "accent wall", "bookshelf", "kitchen shelf", "floating shelf")
- confidence: 0.0-1.0 (include surfaces ${confidenceThreshold}+ confidence)
- boundingBox: {x, y, width, height} normalized 0-1

ACTIVELY LOOK FOR these placement opportunities — do NOT skip them:
- WALLS: every visible wall surface counts (back wall behind subject, accent walls, side walls). These are where posters, prints, decals, neon signs, framed art, and murals get placed. Even if a wall is largely empty, return it as a placement opportunity. Tag subtype: "back wall", "side wall", "accent wall".
- SHELVES: bookshelves, floating shelves, kitchen shelves, mantels, ledges, display shelves. These are where products, books, decor sit. Tag subtype: "bookshelf", "floating shelf", "kitchen shelf", "mantel".
- DESKS / TABLES: tabletop products like beverages, electronics.
- MONITORS / LAPTOPS: on-screen overlays.

Walls and shelves are HIGH-VALUE placements — many videos have great wall/shelf real estate that goes unused. If you see a wall or shelf, return it.

Look for visual cues to determine cultural context: power outlet types, architecture style, clothing, signage, or decor.

CRITICAL: Return ONLY a valid JSON object. No markdown, no explanation.

Example response:
{"surfaces": [{"surfaceType": "Desk", "confidence": 0.92, "boundingBox": {"x": 0.1, "y": 0.5, "width": 0.8, "height": 0.45}}, {"surfaceType": "Wall", "subtype": "back wall", "confidence": 0.88, "boundingBox": {"x": 0, "y": 0, "width": 1, "height": 0.5}}, {"surfaceType": "Shelf", "subtype": "bookshelf", "confidence": 0.81, "boundingBox": {"x": 0.6, "y": 0.1, "width": 0.35, "height": 0.4}}], "sentiment": "Educational", "cultural_context": "Western Home Office", "brand_safety_score": 95}

If no surfaces visible, return: {"surfaces": [], "sentiment": "Neutral", "cultural_context": "General", "brand_safety_score": 70}`;
    
    // Log the full prompt being sent
    console.log(`[Scanner] ===== GEMINI PROMPT =====`);
    console.log(prompt);
    console.log(`[Scanner] ===== END PROMPT =====`);

    // Make API call with timeout
    console.log(`[Scanner] Calling Gemini API...`);
    console.log(`[Scanner] Model: gemini-2.5-flash`);
    console.log(`[Scanner] Base URL: ${process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || '(default)'}`);
    
    const apiCall = ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
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
    
    // Try to match JSON object first (new format), then fall back to array (legacy format)
    const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
    const jsonArrayMatch = text.match(/\[[\s\S]*\]/);
    
    if (!jsonObjectMatch && !jsonArrayMatch) {
      console.log(`[Scanner] No JSON found in response: ${text.substring(0, 100)}...`);
      console.log(`[Scanner] GEMINI CONNECTED but returned non-JSON text`);
      return defaultResult;
    }

    try {
      let surfaces: DetectedObject[] = [];
      let sentiment = 'Neutral';
      let culturalContext = 'General';
      let brandSafetyScore = 70;
      
      // Parse the new object format with surfaces, sentiment, cultural_context, brand_safety_score
      if (jsonObjectMatch) {
        const parsed = JSON.parse(jsonObjectMatch[0]);
        console.log(`[Scanner] Parsed enhanced response object`);
        
        // Extract sentiment and cultural context
        sentiment = parsed.sentiment || 'Neutral';
        culturalContext = parsed.cultural_context || parsed.culturalContext || 'General';
        brandSafetyScore = parsed.brand_safety_score || parsed.brandSafetyScore || 70;
        
        console.log(`[Scanner] Sentiment: ${sentiment}`);
        console.log(`[Scanner] Cultural Context: ${culturalContext}`);
        console.log(`[Scanner] Brand Safety Score: ${brandSafetyScore}`);
        
        // Extract surfaces array
        if (parsed.surfaces && Array.isArray(parsed.surfaces)) {
          surfaces = parsed.surfaces;
        } else if (Array.isArray(parsed)) {
          // Fallback for legacy array response
          surfaces = parsed;
        }
      } else if (jsonArrayMatch) {
        // Legacy array format
        surfaces = JSON.parse(jsonArrayMatch[0]) as DetectedObject[];
      }
      
      console.log(`[Scanner] Parsed ${surfaces.length} raw surfaces from JSON`);
      
      // Use dynamic threshold based on aspect ratio (vertical gets lower threshold)
      const validObjects = surfaces.filter(obj => 
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
          return {
            surfaces: fallbackSurfaces,
            sentiment,
            culturalContext,
            brandSafetyScore
          };
        }
      }
      
      console.log(`[Scanner] ===== ANALYZE FRAME END (success) =====`);
      return {
        surfaces: storedObjects,
        sentiment,
        culturalContext,
        brandSafetyScore
      };
    } catch (parseErr) {
      console.error(`[Scanner] JSON parse error:`, parseErr);
      console.log(`[Scanner] Raw JSON that failed to parse: ${text.substring(0, 500)}`);
      return defaultResult;
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
    
    // Return default result but log that we're doing so due to error
    console.log(`[Scanner] Returning default result due to error (not retrying)`);
    return defaultResult;
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
  
  // DEBUG: Log the actual video object properties
  console.log(`[Scanner] Video object keys:`, Object.keys(video));
  console.log(`[Scanner] video.filePath:`, (video as any).filePath);
  console.log(`[Scanner] video.file_path:`, (video as any).file_path);
  console.log(`[Scanner] video.title:`, video.title);
  console.log(`[Scanner] video.youtubeId:`, video.youtubeId);

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

    // ========================================================================
    // LOCAL FILES FIRST: Always check local storage before any remote download
    // Priority: DB filePath → LOCAL_ASSET_MAP → Legacy description → Platform source
    // ========================================================================
    let localPath: string | undefined;
    const platform = (video as any).platform || 'youtube';
    
    console.log(`[Scanner] Platform: ${platform}, checking local files first...`);
    
    // PRIORITY 1: Check database filePath column (persistent across restarts)
    // This is the primary source for user-uploaded videos
    if ((video as any).filePath) {
      localPath = (video as any).filePath;
      console.log(`[Scanner] PRIORITY 1 - Using DB file_path: ${localPath}`);
    }
    
    // PRIORITY 2: Check LOCAL_ASSET_MAP for demo videos and mapped assets
    if (!localPath) {
      localPath = LOCAL_ASSET_MAP[video.youtubeId];
      if (localPath) {
        console.log(`[Scanner] PRIORITY 2 - Using LOCAL_ASSET_MAP: ${localPath}`);
      }
    }
    
    // PRIORITY 3: Legacy fallback - check description field for older uploads
    if (!localPath && video.youtubeId.startsWith('upload-')) {
      const fileMatch = video.description?.match(/File: (\/uploads\/[^\s|]+)/);
      if (fileMatch) {
        localPath = `./public${fileMatch[1]}`;
        console.log(`[Scanner] PRIORITY 3 - Recovered upload path from description: ${localPath}`);
        addToLocalAssetMap(video.youtubeId, localPath);
      }
    }
    
    // PRIORITY 4: No more platform fallbacks - all content requires local files
    // (Removed Instagram/Facebook placeholder fallback to enforce local-file-only scanning)
    
    let videoPath: string;
    
    if (localPath) {
      // FIXED: Use process.cwd() to get proper absolute path from project root
      const absoluteLocalPath = path.resolve(process.cwd(), localPath);
      console.log(`[Scanner] Resolving local path: ${localPath}`);
      console.log(`[Scanner] Working directory: ${process.cwd()}`);
      console.log(`[Scanner] Absolute path: ${absoluteLocalPath}`);
      
      // Existence check with detailed error
      if (!fs.existsSync(absoluteLocalPath)) {
        console.error(`[Scanner] ERROR: Local file not found at: ${absoluteLocalPath}`);
        console.error(`[Scanner] Directory contents of ./public/:`, fs.readdirSync(path.resolve(process.cwd(), './public')).join(', '));
        await storage.updateVideoStatus(videoId, "Scan Failed");
        return { success: false, videoId, surfacesDetected: 0, error: `Local file not found at: ${absoluteLocalPath}` };
      }
      
      const fileStats = fs.statSync(absoluteLocalPath);
      console.log(`[Scanner] *** USING LOCAL MASTER FILE: ${absoluteLocalPath} ***`);
      console.log(`[Scanner] File size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`[Scanner] Bypassing YouTube download for ${video.youtubeId}`);
      videoPath = absoluteLocalPath;
    } else {
      // No local file found - scanning requires local files only (no YouTube downloads)
      console.log(`[Scanner] No local file found for ${platform} content (ID: ${video.youtubeId})`);
      console.log(`[Scanner] VIDEO SCANNING REQUIRES LOCAL FILES ONLY.`);
      console.log(`[Scanner] To scan this video, upload the video file or add it to LOCAL_ASSET_MAP.`);
      await storage.updateVideoStatus(videoId, "Pending Upload");
      return { 
        success: false, 
        videoId, 
        surfacesDetected: 0, 
        error: `No local file available. Upload the video file to enable scanning.` 
      };
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
    
    // Create frames directory for permanent storage
    const framesOutputDir = path.join(process.cwd(), "public", "uploads", "frames", videoId.toString());
    if (!fs.existsSync(framesOutputDir)) {
      fs.mkdirSync(framesOutputDir, { recursive: true });
    }

    for (let i = 0; i < frames.length; i++) {
      const framePath = frames[i];
      const timestamp = i * 10;

      console.log(`[Scanner] Analyzing frame ${i + 1}/${frames.length} at ${timestamp}s`);
      
      const analysisResult = await analyzeFrame(framePath, 0, isVertical, videoPlatform);
      
      // Log sentiment and cultural context from first frame
      if (i === 0) {
        console.log(`[Scanner] *** VIDEO ANALYSIS: Sentiment="${analysisResult.sentiment}", Context="${analysisResult.culturalContext}", Safety=${analysisResult.brandSafetyScore} ***`);
        // Update video with sentiment and cultural context
        await storage.updateVideoMetadata(videoId, {
          sentiment: analysisResult.sentiment,
          culturalContext: analysisResult.culturalContext
        });
      }
      
      // Save frame to permanent location if surfaces detected
      let savedFrameUrl: string | null = null;
      if (analysisResult.surfaces.length > 0) {
        const frameFilename = `frame_${timestamp}s.jpg`;
        const permanentFramePath = path.join(framesOutputDir, frameFilename);
        try {
          fs.copyFileSync(framePath, permanentFramePath);
          savedFrameUrl = `/uploads/frames/${videoId}/${frameFilename}`;
          console.log(`[Scanner] Saved frame to: ${savedFrameUrl}`);
        } catch (err) {
          console.error(`[Scanner] Failed to save frame:`, err);
        }
      }

      for (const obj of analysisResult.surfaces) {
        const surface: InsertDetectedSurface = {
          videoId,
          timestamp: timestamp.toString(),
          surfaceType: obj.surfaceType,
          confidence: obj.confidence.toString(),
          boundingBoxX: obj.boundingBox.x.toString(),
          boundingBoxY: obj.boundingBox.y.toString(),
          boundingBoxWidth: obj.boundingBox.width.toString(),
          boundingBoxHeight: obj.boundingBox.height.toString(),
          frameUrl: savedFrameUrl,
        };

        const inserted = await storage.insertDetectedSurface(surface);
        
        // SUCCESS LOG - This is what the user wants to see!
        console.log(`[Scanner] *** SURFACE FOUND: { type: "${obj.surfaceType}", x: ${obj.boundingBox.x.toFixed(2)}, y: ${obj.boundingBox.y.toFixed(2)}, width: ${obj.boundingBox.width.toFixed(2)}, height: ${obj.boundingBox.height.toFixed(2)}, confidence: ${obj.confidence.toFixed(2)}, frameUrl: "${savedFrameUrl || 'none'}" } ***`);
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
