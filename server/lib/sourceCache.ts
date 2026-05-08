// On-demand source video cache for in-app playback.
//
// We don't persist creator source videos (light-cloud model — see
// memory:creator_brand_remix_flow). But the creator + brand both need to
// actually watch the video while reviewing scan results, and we don't want
// to send them off to YouTube/IG/Facebook (their UI, their ads, their
// "watch next" engagement loop). So we pull on demand, stream from a temp
// file, and discard after a TTL.
//
// Behavior:
//   - First playback request → background download via existing helpers,
//     stream to client as bytes arrive
//   - Subsequent requests within TTL → serve cached file directly
//   - Concurrent first-requests → deduplicated via inflight map
//   - Background sweep evicts files older than TTL on a slow interval
//
// This is per-instance cache. If we scale beyond one Replit container,
// each instance maintains its own cache (acceptable — the cost of a
// re-download per pod is small relative to serving across pods).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { storage } from "../storage";
import type { VideoIndex } from "@shared/schema";
import { downloadVideo as downloadYouTubeVideo } from "./scanner";
import { downloadFacebookVideo, downloadInstagramVideo } from "./socialDownloader";
import { safeDecrypt } from "./socialAnalytics";
import { getFreshYoutubeTokenForUser } from "./youtubeAuth";

const CACHE_DIR = path.join(os.tmpdir(), "fullscale-source-cache");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // every 15 min
// Hard cap on total cache disk usage. Without this the cache could grow
// unbounded inside the 1-hour TTL window and choke /tmp on Replit deploy
// (small /tmp shared with multer disk writes, frame extraction, etc).
// When usage exceeds the cap, the sweeper evicts oldest-first until under.
const CACHE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

const inflight = new Map<number, Promise<string>>();

function cachePath(videoId: number): string {
  return path.join(CACHE_DIR, `${videoId}.mp4`);
}

function isFresh(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

// Resolves the local path to a playable mp4 for the given video, downloading
// from the source platform if not already cached. Returns the local path.
export async function getSourcePath(video: VideoIndex): Promise<string> {
  // Locally-uploaded videos: serve straight from filePath, no cache needed.
  if ((video as any).filePath) {
    const direct = path.resolve(process.cwd(), (video as any).filePath);
    if (fs.existsSync(direct)) return direct;
  }

  const target = cachePath(video.id);
  if (fs.existsSync(target) && isFresh(target)) {
    // Touch mtime to extend TTL on active playback.
    fs.utimesSync(target, new Date(), new Date());
    return target;
  }

  if (inflight.has(video.id)) {
    return inflight.get(video.id)!;
  }

  const promise = (async () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const platform = (video as any).platform;
    const ytId = video.youtubeId;

    if (platform === "youtube" && ytId && !ytId.includes(":") && !ytId.startsWith("upload-")) {
      // Use the creator's stored OAuth token to bypass YT bot detection.
      // For full-video player downloads (no trim), authenticated requests
      // are critical — long, anonymous downloads are the most likely to
      // hit "Sign in to confirm you're not a bot."
      const oauthToken = await getFreshYoutubeTokenForUser(video.userId).catch(() => null);
      const ok = await downloadYouTubeVideo(ytId, target, { oauthToken: oauthToken || undefined });
      if (!ok || !fs.existsSync(target)) throw new Error(`YouTube download failed for ${ytId}`);
      return target;
    }

    if ((platform === "instagram" || platform === "facebook") && ytId) {
      const user = await storage.getUserById(video.userId);
      const fbToken = safeDecrypt(user?.facebookAccessToken);
      if (!fbToken) throw new Error(`No Facebook token for user ${video.userId}`);

      const ok = platform === "facebook"
        ? await downloadFacebookVideo(ytId, fbToken, target)
        : await downloadInstagramVideo(ytId, fbToken, target);
      if (!ok || !fs.existsSync(target)) throw new Error(`${platform} download failed for ${ytId}`);
      return target;
    }

    throw new Error(`Cannot resolve source for video ${video.id} (platform=${platform})`);
  })();

  inflight.set(video.id, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(video.id);
  }
}

function sweep() {
  if (!fs.existsSync(CACHE_DIR)) return;

  // Pass 1: evict by TTL.
  let removedTtl = 0;
  for (const file of fs.readdirSync(CACHE_DIR)) {
    const full = path.join(CACHE_DIR, file);
    try {
      const stat = fs.statSync(full);
      if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
        fs.unlinkSync(full);
        removedTtl++;
      }
    } catch {
      // ignore — file may have been deleted between readdir and stat
    }
  }

  // Pass 2: enforce total-size cap. Survey what's left, sort oldest first,
  // unlink until under the cap.
  let totalBytes = 0;
  const survivors: { path: string; size: number; mtimeMs: number }[] = [];
  for (const file of fs.readdirSync(CACHE_DIR)) {
    const full = path.join(CACHE_DIR, file);
    try {
      const stat = fs.statSync(full);
      totalBytes += stat.size;
      survivors.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {}
  }

  let removedSize = 0;
  if (totalBytes > CACHE_MAX_BYTES) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const s of survivors) {
      if (totalBytes <= CACHE_MAX_BYTES) break;
      try {
        fs.unlinkSync(s.path);
        totalBytes -= s.size;
        removedSize++;
      } catch {}
    }
  }

  if (removedTtl > 0 || removedSize > 0) {
    console.log(`[Source Cache] Swept ${removedTtl} expired + ${removedSize} oldest-for-size — now ${(totalBytes / 1024 / 1024).toFixed(1)} MB / ${(CACHE_MAX_BYTES / 1024 / 1024).toFixed(0)} MB cap`);
  }
}

// Run an initial sweep at startup so a previous process's leftovers don't
// linger past the size cap before the first interval fires.
setTimeout(sweep, 5_000).unref();
setInterval(sweep, SWEEP_INTERVAL_MS).unref();
