/**
 * Social Analytics — fetch view + engagement metrics from connected platforms.
 *
 * Sources:
 *   - YouTube Data API (scope: youtube.readonly) — video stats, channel stats
 *   - Instagram Graph API (scope: instagram_basic + instagram_manage_insights)
 *     — media list + per-media insights (impressions, reach, plays, engagement)
 *   - Facebook Graph API (scope: pages_read_engagement) — Page fan_count + post insights
 *
 * Each fetcher is fail-safe: returns null on error rather than throwing,
 * so the analytics endpoint can degrade gracefully if any one platform breaks.
 */

import { decrypt } from "../encryption";

const GRAPH_API_VERSION = "v18.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ── Instagram ──────────────────────────────────────────────────────────────

export interface InstagramMediaInsight {
  mediaId: string;
  mediaType: string;            // IMAGE | VIDEO | CAROUSEL_ALBUM | REELS
  permalink: string | null;
  thumbnailUrl: string | null;
  caption: string | null;
  timestamp: string;
  // Insights
  impressions: number;
  reach: number;
  plays: number;                // VIDEO/REELS only
  likeCount: number;
  commentsCount: number;
  saved: number;
  shares: number;
  totalInteractions: number;
}

export interface InstagramAccountStats {
  igAccountId: string;
  username: string | null;
  followers: number;
  following: number;
  mediaCount: number;
  recentMedia: InstagramMediaInsight[];
}

/**
 * Fetch Instagram Business Account stats + recent media insights.
 * Returns null if the account isn't connected or insights call fails
 * (e.g., scope not granted).
 */
export async function fetchInstagramAnalytics(
  igBusinessAccountId: string,
  pageAccessToken: string,
  recentMediaCount: number = 10,
): Promise<InstagramAccountStats | null> {
  try {
    // Account-level: followers, following, media count, username
    const accountUrl = `${GRAPH_BASE}/${igBusinessAccountId}?fields=username,followers_count,follows_count,media_count&access_token=${encodeURIComponent(pageAccessToken)}`;
    const accountRes = await fetch(accountUrl);
    if (!accountRes.ok) {
      console.warn(`[SocialAnalytics] IG account fetch failed: ${accountRes.status}`);
      return null;
    }
    const account: any = await accountRes.json();

    // Recent media list
    const mediaUrl = `${GRAPH_BASE}/${igBusinessAccountId}/media?fields=id,media_type,permalink,thumbnail_url,caption,timestamp,like_count,comments_count&limit=${recentMediaCount}&access_token=${encodeURIComponent(pageAccessToken)}`;
    const mediaRes = await fetch(mediaUrl);
    const mediaList: any = mediaRes.ok ? await mediaRes.json() : { data: [] };

    // For each media, fetch insights (impressions, reach, plays, etc.)
    const insightFields = ["impressions", "reach", "saved", "shares", "total_interactions"];
    // VIDEO/REELS also expose `plays`
    const recentMedia: InstagramMediaInsight[] = [];
    for (const m of (mediaList.data ?? []).slice(0, recentMediaCount)) {
      const isVideo = m.media_type === "VIDEO" || m.media_type === "REELS";
      const fields = [...insightFields, ...(isVideo ? ["plays"] : [])].join(",");
      let impressions = 0, reach = 0, plays = 0, saved = 0, shares = 0, totalInteractions = 0;
      try {
        const insightsUrl = `${GRAPH_BASE}/${m.id}/insights?metric=${fields}&access_token=${encodeURIComponent(pageAccessToken)}`;
        const insightsRes = await fetch(insightsUrl);
        if (insightsRes.ok) {
          const insightsData: any = await insightsRes.json();
          for (const metric of insightsData.data ?? []) {
            const value = metric.values?.[0]?.value ?? 0;
            switch (metric.name) {
              case "impressions": impressions = value; break;
              case "reach": reach = value; break;
              case "plays": plays = value; break;
              case "saved": saved = value; break;
              case "shares": shares = value; break;
              case "total_interactions": totalInteractions = value; break;
            }
          }
        }
      } catch (err: any) {
        console.warn(`[SocialAnalytics] IG media insights fetch failed for ${m.id}: ${err.message}`);
      }
      recentMedia.push({
        mediaId: m.id,
        mediaType: m.media_type,
        permalink: m.permalink ?? null,
        thumbnailUrl: m.thumbnail_url ?? null,
        caption: m.caption ?? null,
        timestamp: m.timestamp,
        impressions,
        reach,
        plays,
        likeCount: m.like_count ?? 0,
        commentsCount: m.comments_count ?? 0,
        saved,
        shares,
        totalInteractions,
      });
    }

    return {
      igAccountId: igBusinessAccountId,
      username: account.username ?? null,
      followers: account.followers_count ?? 0,
      following: account.follows_count ?? 0,
      mediaCount: account.media_count ?? 0,
      recentMedia,
    };
  } catch (err: any) {
    console.error("[SocialAnalytics] fetchInstagramAnalytics error:", err.message);
    return null;
  }
}

// ── Facebook Page ─────────────────────────────────────────────────────────

export interface FacebookPageStats {
  pageId: string;
  pageName: string | null;
  fanCount: number;            // followers
  pageEngagement: number | null;
}

/**
 * Fetch Facebook Page stats. Requires pages_read_engagement scope.
 */
export async function fetchFacebookPageAnalytics(
  pageId: string,
  pageAccessToken: string,
): Promise<FacebookPageStats | null> {
  try {
    const url = `${GRAPH_BASE}/${pageId}?fields=name,fan_count&access_token=${encodeURIComponent(pageAccessToken)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[SocialAnalytics] FB page fetch failed: ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    return {
      pageId,
      pageName: data.name ?? null,
      fanCount: data.fan_count ?? 0,
      pageEngagement: null,  // Add page_engaged_users insight in a future iteration
    };
  } catch (err: any) {
    console.error("[SocialAnalytics] fetchFacebookPageAnalytics error:", err.message);
    return null;
  }
}

// ── YouTube ───────────────────────────────────────────────────────────────

export interface YouTubeVideoStats {
  videoId: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  publishedAt: string | null;
}

/**
 * Fetch fresh stats for a list of YouTube video IDs (max 50 per call).
 * Uses youtube.readonly scope.
 */
export async function fetchYouTubeVideoStats(
  videoIds: string[],
  accessToken: string,
): Promise<YouTubeVideoStats[]> {
  if (videoIds.length === 0) return [];
  try {
    const idsParam = videoIds.slice(0, 50).join(",");
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${idsParam}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.warn(`[SocialAnalytics] YouTube videos.list failed: ${res.status}`);
      return [];
    }
    const data: any = await res.json();
    return (data.items ?? []).map((item: any) => ({
      videoId: item.id,
      viewCount: parseInt(item.statistics?.viewCount ?? "0"),
      likeCount: parseInt(item.statistics?.likeCount ?? "0"),
      commentCount: parseInt(item.statistics?.commentCount ?? "0"),
      publishedAt: item.snippet?.publishedAt ?? null,
    }));
  } catch (err: any) {
    console.error("[SocialAnalytics] fetchYouTubeVideoStats error:", err.message);
    return [];
  }
}

/**
 * Decrypt a stored encrypted access token. Returns null if decryption fails.
 */
export function safeDecrypt(token: string | null | undefined): string | null {
  if (!token) return null;
  try {
    return decrypt(token);
  } catch (err: any) {
    console.warn("[SocialAnalytics] Token decryption failed:", err.message);
    return null;
  }
}
