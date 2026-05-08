// IG and FB Graph API return thumbnail URLs on their own CDN
// (cdninstagram.com / fbcdn.net) that are signed and expire — usually within
// hours to a few days. Storing those raw URLs in video_index means the library
// shows "No thumbnail" the next day when the browser's <img> request 401s.
//
// Fix: at import (and on every sync) we download the bytes once and re-upload
// to our own object storage, then store *our* serve URL in the DB. That URL
// never expires.
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { uploadBufferToStorage, uploadFileToStorage } from "./objectStorage";
import { db } from "../db";
import { videoIndex } from "@shared/schema";
import { eq, and } from "drizzle-orm";

// Domains we know are signed/expiring CDN URLs that need re-caching.
const EXPIRING_HOSTS = [
  "cdninstagram.com",
  "fbcdn.net",
  "fbsbx.com",
];

export function isExpiringSocialUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return EXPIRING_HOSTS.some((host) => url.includes(host));
}

// Fetch a remote image and stash it in our bucket. Returns our serve URL on
// success, null on failure — callers should NOT fall back to the original
// remote URL on null because the whole point is that URL is unreliable.
export async function cacheRemoteThumbnail(
  remoteUrl: string,
  objectKey: string,
): Promise<string | null> {
  try {
    const res = await fetch(remoteUrl, {
      headers: { "User-Agent": "Mozilla/5.0 fullscale-thumb-cacher" },
    });
    if (!res.ok) {
      console.warn(
        `[SocialThumb] HTTP ${res.status} for ${remoteUrl.slice(0, 100)}`,
      );
      return null;
    }
    const contentType = res.headers.get("content-type") || "image/jpeg";
    // Guard against the IG `media_url` bug: for VIDEO/REELS, media_url is the
    // MP4, not an image. We never want to cache that as a thumbnail.
    if (!contentType.startsWith("image/")) {
      console.warn(
        `[SocialThumb] skip non-image content-type ${contentType} for ${remoteUrl.slice(0, 100)}`,
      );
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      console.warn(`[SocialThumb] empty body for ${remoteUrl.slice(0, 100)}`);
      return null;
    }
    return await uploadBufferToStorage(buf, objectKey, contentType);
  } catch (err: any) {
    console.warn(`[SocialThumb] cache failed: ${err.message}`);
    return null;
  }
}

// Fallback for when Graph API doesn't return a thumbnail_url at all (common
// for older Reels, cross-posts, some Business accounts). Pulls one frame
// from the video URL via ffmpeg's HTTP input — only enough bytes to decode
// the first keyframe at t=1s, NOT a full download. Uploads the JPG to GCS
// and returns the serve URL.
async function extractFrameFromVideoUrl(
  videoUrl: string,
  objectKey: string,
): Promise<string | null> {
  const tempPath = path.join(
    os.tmpdir(),
    `igframe_${Date.now()}_${Math.floor(Math.random() * 1e6)}.jpg`,
  );

  const ok = await new Promise<boolean>((resolve) => {
    // -ss before -i = fast input seek (downloads minimal bytes)
    // -frames:v 1   = exactly one frame
    // 480x270 max   = matches our normal thumbnail dimensions
    const ff = spawn("ffmpeg", [
      "-y",
      "-loglevel", "error",
      "-ss", "1",
      "-i", videoUrl,
      "-frames:v", "1",
      "-vf", "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2",
      "-q:v", "3",
      tempPath,
    ]);

    let stderr = "";
    ff.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    ff.on("close", (code) => {
      if (code === 0 && fs.existsSync(tempPath)) {
        resolve(true);
      } else {
        if (stderr) {
          console.warn(
            `[SocialThumb] ffmpeg frame extract failed: ${stderr.slice(-200)}`,
          );
        }
        resolve(false);
      }
    });
    ff.on("error", (err) => {
      console.warn(`[SocialThumb] ffmpeg spawn error: ${err.message}`);
      resolve(false);
    });
  });

  if (!ok) return null;

  try {
    const url = await uploadFileToStorage(tempPath, objectKey);
    return url;
  } catch (err: any) {
    console.warn(`[SocialThumb] frame upload failed: ${err.message}`);
    return null;
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
}

// Helper for IG imports.
//   1. If Graph API gave us a thumbnail_url, cache it (cheap fast path).
//   2. If it didn't, extract a frame from media_url (the MP4) — heavier but
//      reliable for Reels where IG's thumbnail field is null.
export async function cacheInstagramThumbnail(
  igMediaId: string,
  thumbnailUrl: string | null | undefined,
  videoUrl?: string | null | undefined,
): Promise<string | null> {
  const safeId = igMediaId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const key = `public/thumbnails/instagram/${safeId}.jpg`;

  if (thumbnailUrl) {
    const cached = await cacheRemoteThumbnail(thumbnailUrl, key);
    if (cached) return cached;
  }

  if (videoUrl) {
    return extractFrameFromVideoUrl(videoUrl, key);
  }

  return null;
}

// Helper for FB imports — same fallback story for fbcdn URLs.
export async function cacheFacebookThumbnail(
  fbVideoId: string,
  thumbnailUrl: string | null | undefined,
  videoUrl?: string | null | undefined,
): Promise<string | null> {
  const safeId = fbVideoId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const key = `public/thumbnails/facebook/${safeId}.jpg`;

  if (thumbnailUrl) {
    const cached = await cacheRemoteThumbnail(thumbnailUrl, key);
    if (cached) return cached;
  }

  if (videoUrl) {
    return extractFrameFromVideoUrl(videoUrl, key);
  }

  return null;
}

// Backfill: walk a user's existing IG/FB videos that still have an expiring
// CDN URL (or null) and refresh them from the freshly-fetched media list.
// `mediaList` is the array returned by the Graph API media query for the
// account being synced; we match by youtubeId (`instagram:${id}` /
// `facebook:${id}`).
//
// We refresh whenever the stored URL is null or on an expiring host, OR when
// the stored URL is already on our /storage/ path but is missing — leaving
// already-cached entries alone keeps backfill cheap on repeat syncs.
export async function refreshSocialThumbnails(
  userId: string,
  platform: "instagram" | "facebook",
  mediaList: Array<{
    id: string;
    media_url?: string | null;
    thumbnail_url?: string | null;
    source?: string | null;
    thumbnails?: { data?: Array<{ uri?: string }> };
  }>,
): Promise<{ refreshed: number; failed: number }> {
  if (mediaList.length === 0) return { refreshed: 0, failed: 0 };

  const idPrefix = platform === "instagram" ? "instagram:" : "facebook:";

  const existing = await db.query.videoIndex.findMany({
    where: and(
      eq(videoIndex.userId, userId),
      eq(videoIndex.platform, platform),
    ),
  });

  const byYtId = new Map(existing.map((v) => [v.youtubeId, v]));
  let refreshed = 0;
  let failed = 0;

  for (const m of mediaList) {
    const ytId = `${idPrefix}${m.id}`;
    const row = byYtId.get(ytId);
    if (!row) continue; // not yet imported — handled by main import path

    const stored = row.thumbnailUrl;
    // Already cached locally — leave alone.
    if (stored && stored.startsWith("/storage/")) continue;
    // Has a non-CDN, non-/storage URL we don't recognize — leave alone.
    if (stored && !isExpiringSocialUrl(stored)) continue;

    const thumbCandidate =
      platform === "instagram"
        ? m.thumbnail_url
        : m.thumbnails?.data?.[0]?.uri;
    const videoCandidate =
      platform === "instagram" ? m.media_url : m.source;

    const local =
      platform === "instagram"
        ? await cacheInstagramThumbnail(m.id, thumbCandidate, videoCandidate)
        : await cacheFacebookThumbnail(m.id, thumbCandidate, videoCandidate);

    if (local) {
      try {
        await db
          .update(videoIndex)
          .set({ thumbnailUrl: local })
          .where(eq(videoIndex.id, row.id));
        refreshed++;
      } catch (err: any) {
        console.warn(
          `[SocialThumb] DB update failed for ${ytId}: ${err.message}`,
        );
        failed++;
      }
    } else {
      failed++;
    }
  }

  if (refreshed > 0 || failed > 0) {
    console.log(
      `[SocialThumb] ${platform} backfill: ${refreshed} refreshed, ${failed} failed (of ${mediaList.length} candidates)`,
    );
  }

  return { refreshed, failed };
}
