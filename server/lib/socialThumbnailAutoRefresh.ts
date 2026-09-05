// Auto-refresh stale IG/FB thumbnails on library load.
//
// Why this exists: IG/FB Graph API thumbnails are signed CDN URLs that expire
// after hours-to-days. The user shouldn't have to manually click a sync button
// to keep thumbnails working — the library should self-heal. This helper fires
// in the background after /api/video-index returns, so the page loads
// immediately and the next React Query refetch picks up the cached thumbs.
//
// Cooldown: per-user, 1 hour. Stops repeated page loads from slamming Graph
// API. The cooldown is in-memory (resets on restart) which is fine — first
// load after a restart paying for one refresh is acceptable.
import { db } from "../db";
import { videoIndex, socialAccounts } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { decrypt } from "../encryption";
import { fetchInstagramMedia, fetchFacebookPageVideos, fetchPersonalProfileVideos } from "./platformAuth";
import { refreshSocialThumbnails, isExpiringSocialUrl } from "./socialThumbnails";

const COOLDOWN_MS = 60 * 60 * 1000;
const lastRefreshByUser = new Map<string, number>();

// In-flight guard so two concurrent requests for the same user don't both
// kick off a refresh.
const inFlight = new Set<string>();

function safeDecrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

export function maybeRefreshSocialThumbnailsInBackground(userId: string): void {
  if (!userId) return;

  const now = Date.now();
  const last = lastRefreshByUser.get(userId);
  if (last && now - last < COOLDOWN_MS) return;
  if (inFlight.has(userId)) return;

  // Fire and forget — caller has already responded.
  inFlight.add(userId);
  lastRefreshByUser.set(userId, now);

  refreshUserThumbnails(userId)
    .catch((err) => {
      console.warn(`[SocialThumbAuto] user ${userId} refresh failed:`, err.message);
    })
    .finally(() => {
      inFlight.delete(userId);
    });
}

async function refreshUserThumbnails(userId: string): Promise<void> {
  // Quick check: do we even have stale thumbnails for this user? If
  // everything is already on /storage/, skip the work entirely.
  const userVideos = await db.query.videoIndex.findMany({
    where: eq(videoIndex.userId, userId),
  });

  const stale = userVideos.filter(
    (v) =>
      (v.platform === "instagram" || v.platform === "facebook") &&
      (!v.thumbnailUrl || isExpiringSocialUrl(v.thumbnailUrl)),
  );
  if (stale.length === 0) return;

  const igStale = stale.filter((v) => v.platform === "instagram").length;
  const fbStale = stale.filter((v) => v.platform === "facebook").length;
  console.log(
    `[SocialThumbAuto] user ${userId}: ${igStale} stale IG, ${fbStale} stale FB — refreshing in background`,
  );

  // Pull connected social accounts to find tokens + account IDs.
  const accounts = await db.query.socialAccounts.findMany({
    where: eq(socialAccounts.userId, userId),
  });

  // Instagram refresh
  if (igStale > 0) {
    const igAccounts = accounts.filter((a) => a.platform === "instagram");
    for (const acc of igAccounts) {
      const token = safeDecrypt(acc.accessToken);
      if (!token) continue;
      try {
        const media = await fetchInstagramMedia(acc.platformAccountId, token);
        if (media.length > 0) {
          await refreshSocialThumbnails(userId, "instagram", media);
        }
      } catch (err: any) {
        console.warn(`[SocialThumbAuto] IG fetch failed for ${acc.platformAccountId}: ${err.message}`);
      }
    }
  }

  // Facebook refresh — pages and personal profile.
  if (fbStale > 0) {
    const fbAccounts = accounts.filter((a) => a.platform === "facebook");
    for (const acc of fbAccounts) {
      const token = safeDecrypt(acc.accessToken);
      if (!token) continue;
      try {
        const videos = acc.accountType === "personal"
          ? await fetchPersonalProfileVideos(token)
          : await fetchFacebookPageVideos(acc.platformAccountId, token);
        if (videos.length > 0) {
          await refreshSocialThumbnails(userId, "facebook", videos);
        }
      } catch (err: any) {
        console.warn(`[SocialThumbAuto] FB fetch failed for ${acc.platformAccountId}: ${err.message}`);
      }
    }
  }
}
