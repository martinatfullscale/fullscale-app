// IG and FB Graph API return thumbnail URLs on their own CDN
// (cdninstagram.com / fbcdn.net) that are signed and expire — usually within
// hours to a few days. Storing those raw URLs in video_index means the library
// shows "No thumbnail" the next day when the browser's <img> request 401s.
//
// Fix: at import (and on every sync) we download the bytes once and re-upload
// to our own object storage, then store *our* serve URL in the DB. That URL
// never expires.
import { uploadBufferToStorage } from "./objectStorage";
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

// Helper for IG imports: cache thumbnail_url, ignore media_url (it's the MP4).
export async function cacheInstagramThumbnail(
  igMediaId: string,
  thumbnailUrl: string | null | undefined,
): Promise<string | null> {
  if (!thumbnailUrl) return null;
  const safeId = igMediaId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const key = `public/thumbnails/instagram/${safeId}.jpg`;
  return cacheRemoteThumbnail(thumbnailUrl, key);
}

// Helper for FB imports: same idea, FB returns thumbnails[].uri.
export async function cacheFacebookThumbnail(
  fbVideoId: string,
  thumbnailUrl: string | null | undefined,
): Promise<string | null> {
  if (!thumbnailUrl) return null;
  const safeId = fbVideoId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const key = `public/thumbnails/facebook/${safeId}.jpg`;
  return cacheRemoteThumbnail(thumbnailUrl, key);
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
  mediaList: Array<{ id: string; thumbnail_url?: string | null; thumbnails?: { data?: Array<{ uri?: string }> } }>,
): Promise<{ refreshed: number; failed: number }> {
  if (mediaList.length === 0) return { refreshed: 0, failed: 0 };

  const idPrefix = platform === "instagram" ? "instagram:" : "facebook:";
  const youtubeIds = mediaList.map((m) => `${idPrefix}${m.id}`);

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

    const remote =
      platform === "instagram"
        ? m.thumbnail_url
        : m.thumbnails?.data?.[0]?.uri;
    if (!remote) {
      // Graph API didn't give us a thumbnail this time either — skip.
      continue;
    }

    const local =
      platform === "instagram"
        ? await cacheInstagramThumbnail(m.id, remote)
        : await cacheFacebookThumbnail(m.id, remote);

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
