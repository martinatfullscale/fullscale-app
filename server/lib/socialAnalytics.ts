/**
 * Social Analytics — fetch view + engagement metrics from connected platforms.
 *
 * Sources:
 *   - YouTube Data API (scope: youtube.readonly) — video stats, channel stats
 *   - Instagram Graph API (scope: instagram_basic + instagram_manage_insights)
 *     — media list + per-media insights (views, reach, watch time, engagement)
 *   - Facebook Graph API (scope: pages_read_engagement + read_insights)
 *     — Page followers + Page-level insights
 *
 * METRIC MIGRATION (2025 deprecations, verified 2026-07): `impressions` and
 * `plays` were removed from ALL API versions on 2025-04-21 — the unified
 * `views` metric replaces both. `profile_views`/`website_clicks` died Jan
 * 2025 (→ profile_links_taps). Requesting a dead metric errors the WHOLE
 * insights call, so nothing here may reference them.
 *
 * Each fetcher is fail-safe: returns null on error rather than throwing,
 * so the analytics endpoint can degrade gracefully if any one platform breaks.
 */

import { decrypt } from "../encryption";

export const GRAPH_API_VERSION = "v25.0";
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
  views: number;                // unified metric (replaced impressions+plays, Apr 2025)
  reach: number;
  /** @deprecated alias of views — kept so existing consumers keep rendering */
  impressions: number;
  /** @deprecated alias of views — kept so existing consumers keep rendering */
  plays: number;
  avgWatchTimeMs: number;       // REELS only (ig_reels_avg_watch_time)
  totalWatchTimeMs: number;     // REELS only (ig_reels_video_view_total_time)
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

    // Per-media insights on the CURRENT metric set. `views` replaced
    // impressions+plays; Reels additionally expose watch-time metrics.
    // Unsupported metrics error the whole call, so Reels fields are only
    // requested for Reels, with a base-set retry as the safety net.
    const baseFields = ["views", "reach", "saved", "shares", "total_interactions"];
    const reelFields = ["ig_reels_avg_watch_time", "ig_reels_video_view_total_time"];
    const recentMedia: InstagramMediaInsight[] = [];
    for (const m of (mediaList.data ?? []).slice(0, recentMediaCount)) {
      const isReel = m.media_type === "VIDEO" || m.media_type === "REELS";
      let views = 0, reach = 0, saved = 0, shares = 0, totalInteractions = 0;
      let avgWatchTimeMs = 0, totalWatchTimeMs = 0;
      try {
        const readInsights = async (fields: string[]) => {
          const insightsUrl = `${GRAPH_BASE}/${m.id}/insights?metric=${fields.join(",")}&access_token=${encodeURIComponent(pageAccessToken)}`;
          const insightsRes = await fetch(insightsUrl);
          if (!insightsRes.ok) return false;
          const insightsData: any = await insightsRes.json();
          for (const metric of insightsData.data ?? []) {
            const value = metric.values?.[0]?.value ?? 0;
            switch (metric.name) {
              case "views": views = value; break;
              case "reach": reach = value; break;
              case "saved": saved = value; break;
              case "shares": shares = value; break;
              case "total_interactions": totalInteractions = value; break;
              case "ig_reels_avg_watch_time": avgWatchTimeMs = value; break;
              case "ig_reels_video_view_total_time": totalWatchTimeMs = value; break;
            }
          }
          return true;
        };
        const ok = await readInsights(isReel ? [...baseFields, ...reelFields] : baseFields);
        if (!ok && isReel) await readInsights(baseFields); // watch-time unsupported on this media — take the base set
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
        views,
        reach,
        impressions: views,
        plays: views,
        avgWatchTimeMs,
        totalWatchTimeMs,
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

// ── Instagram account-level insights + demographics ───────────────────────

export interface InstagramAccountInsights {
  /** Interaction metrics for the last 24h window (metric_type=total_value). */
  metrics: Record<string, number>;   // views, reach, accounts_engaged, total_interactions, likes, comments, shares, saves, replies, profile_links_taps, follows_and_unfollows
  /** follower_demographics / engaged_audience_demographics by breakdown. */
  demographics: Record<string, Array<{ dimension: string; value: number }>>;
}

const IG_ACCOUNT_METRICS = [
  "views", "reach", "accounts_engaged", "total_interactions",
  "likes", "comments", "shares", "saves", "replies",
  "profile_links_taps", "follows_and_unfollows",
];
const IG_DEMOGRAPHIC_BREAKDOWNS = ["age", "gender", "country", "city"] as const;

/**
 * Account-level IG insights. Meta only retains these 90 days back, so the
 * snapshot job persists them — FullScale's own history is the long-term
 * record. Demographics need >=100 followers (Meta returns an error below
 * that; fail-soft). Requires instagram_manage_insights.
 */
export async function fetchInstagramAccountInsights(
  igBusinessAccountId: string,
  pageAccessToken: string,
  opts: { includeDemographics?: boolean } = {},
): Promise<InstagramAccountInsights | null> {
  try {
    const metrics: Record<string, number> = {};
    const url = `${GRAPH_BASE}/${igBusinessAccountId}/insights?metric=${IG_ACCOUNT_METRICS.join(",")}&metric_type=total_value&period=day&access_token=${encodeURIComponent(pageAccessToken)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data: any = await res.json();
      for (const metric of data.data ?? []) {
        metrics[metric.name] = metric.total_value?.value ?? metric.values?.[0]?.value ?? 0;
      }
    } else {
      // One dead/unsupported metric fails the whole call — retry one-by-one
      // so a future deprecation degrades a metric, not the account.
      for (const name of IG_ACCOUNT_METRICS) {
        try {
          const single = await fetch(`${GRAPH_BASE}/${igBusinessAccountId}/insights?metric=${name}&metric_type=total_value&period=day&access_token=${encodeURIComponent(pageAccessToken)}`);
          if (single.ok) {
            const data: any = await single.json();
            const m = data.data?.[0];
            if (m) metrics[m.name] = m.total_value?.value ?? m.values?.[0]?.value ?? 0;
          }
        } catch { /* skip metric */ }
      }
    }

    const demographics: InstagramAccountInsights["demographics"] = {};
    if (opts.includeDemographics !== false) {
      for (const metricName of ["follower_demographics", "engaged_audience_demographics"]) {
        for (const breakdown of IG_DEMOGRAPHIC_BREAKDOWNS) {
          try {
            const dUrl = `${GRAPH_BASE}/${igBusinessAccountId}/insights?metric=${metricName}&metric_type=total_value&period=lifetime&timeframe=this_month&breakdown=${breakdown}&access_token=${encodeURIComponent(pageAccessToken)}`;
            const dRes = await fetch(dUrl);
            if (!dRes.ok) continue; // <100 followers / <100 engagements → skip
            const dData: any = await dRes.json();
            const results = dData.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
            if (results.length > 0) {
              demographics[`${metricName}.${breakdown}`] = results.map((r: any) => ({
                dimension: (r.dimension_values ?? []).join("/"),
                value: r.value ?? 0,
              }));
            }
          } catch { /* demographics are best-effort */ }
        }
      }
    }

    return { metrics, demographics };
  } catch (err: any) {
    console.error("[SocialAnalytics] fetchInstagramAccountInsights error:", err.message);
    return null;
  }
}

export interface InstagramStoryInsight {
  storyId: string;
  timestamp: string;
  metrics: Record<string, number>;   // views, reach, replies, shares, total_interactions, profile_visits
}

/**
 * Insights for currently-live stories. Story insights EXPIRE 24h after
 * publish, so this must run on a sub-24h cadence — the snapshot job calls
 * it every cycle and persists whatever is still live.
 */
export async function fetchInstagramStoryInsights(
  igBusinessAccountId: string,
  pageAccessToken: string,
): Promise<InstagramStoryInsight[]> {
  const out: InstagramStoryInsight[] = [];
  try {
    const storiesRes = await fetch(`${GRAPH_BASE}/${igBusinessAccountId}/stories?fields=id,timestamp&access_token=${encodeURIComponent(pageAccessToken)}`);
    if (!storiesRes.ok) return out;
    const stories: any = await storiesRes.json();
    for (const s of stories.data ?? []) {
      try {
        const iRes = await fetch(`${GRAPH_BASE}/${s.id}/insights?metric=views,reach,replies,shares,total_interactions,profile_visits&access_token=${encodeURIComponent(pageAccessToken)}`);
        if (!iRes.ok) continue; // stories with <5 viewers error — skip
        const iData: any = await iRes.json();
        const metrics: Record<string, number> = {};
        for (const metric of iData.data ?? []) {
          metrics[metric.name] = metric.values?.[0]?.value ?? metric.total_value?.value ?? 0;
        }
        out.push({ storyId: s.id, timestamp: s.timestamp, metrics });
      } catch { /* per-story best-effort */ }
    }
  } catch (err: any) {
    console.warn("[SocialAnalytics] fetchInstagramStoryInsights error:", err.message);
  }
  return out;
}

// ── Facebook Page ─────────────────────────────────────────────────────────

export interface FacebookPageStats {
  pageId: string;
  pageName: string | null;
  fanCount: number;            // followers
  pageEngagement: number | null;
  /** Page-level insights (requires read_insights; empty without it). */
  insights: Record<string, number>;
}

// Post-2025/2026 deprecation survivors (page_fans*/page_impressions* families
// are dead; page_media_view + page_follows are the canonical replacements).
const FB_PAGE_METRICS = [
  "page_media_view", "page_total_media_view_unique",
  "page_follows", "page_daily_follows_unique", "page_daily_unfollows_unique",
  "page_post_engagements", "page_total_actions",
  "page_views_total", "page_video_views",
];

/**
 * Fetch Facebook Page stats. Follower fields need pages_read_engagement;
 * the /insights edge additionally needs read_insights + a Page token from
 * a user with the ANALYZE task — insights fail soft to {} without them.
 */
export async function fetchFacebookPageAnalytics(
  pageId: string,
  pageAccessToken: string,
): Promise<FacebookPageStats | null> {
  try {
    const url = `${GRAPH_BASE}/${pageId}?fields=name,fan_count,followers_count&access_token=${encodeURIComponent(pageAccessToken)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[SocialAnalytics] FB page fetch failed: ${res.status}`);
      return null;
    }
    const data: any = await res.json();

    const insights: Record<string, number> = {};
    try {
      const iRes = await fetch(`${GRAPH_BASE}/${pageId}/insights?metric=${FB_PAGE_METRICS.join(",")}&period=day&access_token=${encodeURIComponent(pageAccessToken)}`);
      if (iRes.ok) {
        const iData: any = await iRes.json();
        for (const metric of iData.data ?? []) {
          const latest = metric.values?.[metric.values.length - 1]?.value;
          insights[metric.name] = typeof latest === "number" ? latest : 0;
        }
      } else {
        // Combined call failed (likely one deprecated/unsupported metric or
        // missing read_insights) — try individually so survivors still land.
        for (const name of FB_PAGE_METRICS) {
          try {
            const single = await fetch(`${GRAPH_BASE}/${pageId}/insights?metric=${name}&period=day&access_token=${encodeURIComponent(pageAccessToken)}`);
            if (single.ok) {
              const sData: any = await single.json();
              const m = sData.data?.[0];
              const latest = m?.values?.[m.values.length - 1]?.value;
              if (typeof latest === "number") insights[name] = latest;
            }
          } catch { /* skip metric */ }
        }
      }
    } catch { /* insights are additive — page stats still return */ }

    return {
      pageId,
      pageName: data.name ?? null,
      fanCount: data.followers_count ?? data.fan_count ?? 0,
      pageEngagement: insights.page_post_engagements ?? null,
      insights,
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
