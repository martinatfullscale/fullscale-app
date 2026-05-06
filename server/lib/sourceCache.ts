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
  let removed = 0;
  for (const file of fs.readdirSync(CACHE_DIR)) {
    const full = path.join(CACHE_DIR, file);
    try {
      const stat = fs.statSync(full);
      if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      // ignore — file may have been deleted between readdir and stat
    }
  }
  if (removed > 0) console.log(`[Source Cache] Swept ${removed} expired files`);
}

setInterval(sweep, SWEEP_INTERVAL_MS).unref();
