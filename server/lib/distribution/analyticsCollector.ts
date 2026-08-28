/**
 * Analytics Collector — Fetch Performance Metrics from Social Platforms
 *
 * Periodically pulls engagement data (views, likes, comments, shares) from
 * each platform's API and stores it in the clip_analytics table.
 *
 * Also computes aggregate metrics for the distribution dashboard:
 * - Total reach across platforms
 * - Best performing clips
 * - Brand exposure minutes
 * - Engagement rates by platform
 */

import { storage } from "../../storage";
import { getAdapter } from "./platformPublisher";
import { GRAPH_API_VERSION } from "../socialAnalytics";
import type { ClipAnalytics, PublishedPost } from "../../../shared/schema";

export interface AggregateMetrics {
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  totalReach: number;
  avgEngagementRate: number;
  avgCompletionRate: number;
  brandExposureMinutes: number;
  platformBreakdown: Record<string, PlatformMetrics>;
  topClips: Array<{
    clipId: number;
    platform: string;
    views: number;
    engagementRate: number;
  }>;
}

export interface PlatformMetrics {
  platform: string;
  postsCount: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  avgEngagementRate: number;
}

// ─── Platform-Specific Analytics Fetchers ────────────────────────

async function fetchTikTokAnalytics(
  postId: string,
  accessToken: string
): Promise<Partial<ClipAnalytics>> {
  try {
    const res = await fetch(
      `https://open.tiktokapis.com/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filters: { video_ids: [postId] },
        }),
      }
    );

    if (!res.ok) return {};
    const data = await res.json();
    const video = data.data?.videos?.[0];
    if (!video) return {};

    const views = video.view_count || 0;
    const likes = video.like_count || 0;
    const comments = video.comment_count || 0;
    const shares = video.share_count || 0;

    return {
      views,
      likes,
      comments,
      shares,
      engagementRate: views > 0 ? (likes + comments + shares) / views : 0,
    };
  } catch {
    return {};
  }
}

async function fetchYouTubeAnalytics(
  postId: string,
  accessToken: string
): Promise<Partial<ClipAnalytics>> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${postId}`,
      { headers: { "Authorization": `Bearer ${accessToken}` } }
    );

    if (!res.ok) return {};
    const data = await res.json();
    const stats = data.items?.[0]?.statistics;
    if (!stats) return {};

    const views = parseInt(stats.viewCount) || 0;
    const likes = parseInt(stats.likeCount) || 0;
    const comments = parseInt(stats.commentCount) || 0;

    return {
      views,
      likes,
      comments,
      shares: 0, // YouTube doesn't expose share count
      engagementRate: views > 0 ? (likes + comments) / views : 0,
    };
  } catch {
    return {};
  }
}

async function fetchInstagramAnalytics(
  postId: string,
  accessToken: string
): Promise<Partial<ClipAnalytics>> {
  try {
    // `plays` and `impressions` were removed from ALL Graph API versions on
    // 2025-04-21 — `views` is the unified replacement. Published clips are
    // Reels, so also pull watch-time; if the media type doesn't support the
    // Reels metrics the whole call errors, hence the base-set fallback.
    const base = "views,likes,comments,shares,reach,saved";
    let res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${postId}/insights?metric=${base},ig_reels_avg_watch_time,ig_reels_video_view_total_time&access_token=${accessToken}`
    );
    if (!res.ok) {
      res = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${postId}/insights?metric=${base}&access_token=${accessToken}`
      );
    }

    if (!res.ok) return {};
    const data = await res.json();
    const metrics: Record<string, number> = {};

    for (const item of data.data || []) {
      metrics[item.name] = item.values?.[0]?.value ?? item.total_value?.value ?? 0;
    }

    const views = metrics.views || 0;
    const likes = metrics.likes || 0;
    const comments = metrics.comments || 0;
    const shares = metrics.shares || 0;
    const saves = metrics.saved || 0;
    const reach = metrics.reach || 0;
    const totalWatchMs = metrics.ig_reels_video_view_total_time || 0;

    return {
      views,
      likes,
      comments,
      shares,
      saves,
      reach,
      impressions: views,
      watchTimeSeconds: Math.round(totalWatchMs / 1000),
      // completionRate from avg watch time needs the clip duration — the
      // caller stores watchTimeSeconds; avg per view is derivable as
      // watchTimeSeconds/views downstream.
      engagementRate: views > 0 ? (likes + comments + shares + saves) / views : 0,
    };
  } catch {
    return {};
  }
}

async function fetchTwitterAnalytics(
  postId: string,
  accessToken: string
): Promise<Partial<ClipAnalytics>> {
  try {
    const res = await fetch(
      `https://api.twitter.com/2/tweets/${postId}?tweet.fields=public_metrics`,
      { headers: { "Authorization": `Bearer ${accessToken}` } }
    );

    if (!res.ok) return {};
    const data = await res.json();
    const metrics = data.data?.public_metrics;
    if (!metrics) return {};

    const views = metrics.impression_count || 0;
    const likes = metrics.like_count || 0;
    const comments = metrics.reply_count || 0;
    const shares = metrics.retweet_count || 0;

    return {
      views,
      likes,
      comments,
      shares,
      impressions: views,
      engagementRate: views > 0 ? (likes + comments + shares) / views : 0,
    };
  } catch {
    return {};
  }
}

const PLATFORM_FETCHERS: Record<string, (postId: string, token: string) => Promise<Partial<ClipAnalytics>>> = {
  tiktok: fetchTikTokAnalytics,
  youtube: fetchYouTubeAnalytics,
  youtube_shorts: fetchYouTubeAnalytics,
  instagram: fetchInstagramAnalytics,
  instagram_reels: fetchInstagramAnalytics,
  twitter: fetchTwitterAnalytics,
  // LinkedIn analytics API is very limited — skip for now
};

// ─── Collection Logic ────────────────────────────────────────────

/**
 * Fetch analytics for a single published post.
 */
export async function collectPostAnalytics(post: PublishedPost): Promise<void> {
  if (!post.platformPostId || !post.profileId) return;

  const profile = await storage.getDistributionProfile(post.profileId);
  if (!profile || !profile.accessToken) return;

  const fetcher = PLATFORM_FETCHERS[post.platform];
  if (!fetcher) return;

  try {
    const metrics = await fetcher(post.platformPostId, profile.accessToken);

    if (Object.keys(metrics).length > 0) {
      await storage.upsertClipAnalytics({
        postId: post.id,
        clipId: post.clipId,
        platform: post.platform,
        views: metrics.views || 0,
        likes: metrics.likes || 0,
        comments: metrics.comments || 0,
        shares: metrics.shares || 0,
        saves: metrics.saves || 0,
        reach: metrics.reach || 0,
        impressions: metrics.impressions || 0,
        engagementRate: metrics.engagementRate || 0,
        watchTimeSeconds: metrics.watchTimeSeconds || 0,
        completionRate: metrics.completionRate || 0,
        clickThroughRate: metrics.clickThroughRate || 0,
        fetchedAt: new Date(),
      });

      console.log(`[Analytics] Collected for post ${post.id} (${post.platform}): ${metrics.views || 0} views`);
    }
  } catch (err) {
    console.warn(`[Analytics] Failed to collect for post ${post.id}:`, err);
  }
}

/**
 * Collect analytics for all published posts of a video.
 */
export async function collectVideoAnalytics(videoId: number): Promise<void> {
  const posts = await storage.getPublishedPostsByVideo(videoId);
  const published = posts.filter(p => p.status === "published" && p.platformPostId);

  console.log(`[Analytics] Collecting for ${published.length} published posts of video ${videoId}`);

  for (const post of published) {
    await collectPostAnalytics(post);
    // Small delay between API calls
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * Compute aggregate metrics for a video across all platforms.
 */
export async function computeAggregateMetrics(videoId: number): Promise<AggregateMetrics> {
  const analytics = await storage.getAnalyticsSummaryByVideo(videoId);
  const posts = await storage.getPublishedPostsByVideo(videoId);
  const clips = await storage.getClipsByVideo(videoId);

  // Initialize
  const metrics: AggregateMetrics = {
    totalViews: 0,
    totalLikes: 0,
    totalComments: 0,
    totalShares: 0,
    totalReach: 0,
    avgEngagementRate: 0,
    avgCompletionRate: 0,
    brandExposureMinutes: 0,
    platformBreakdown: {},
    topClips: [],
  };

  if (analytics.length === 0) return metrics;

  // Get the latest analytics entry per post (most recent fetchedAt)
  const latestByPost = new Map<number, typeof analytics[0]>();
  for (const a of analytics) {
    const existing = latestByPost.get(a.postId);
    if (!existing || (a.fetchedAt && existing.fetchedAt && a.fetchedAt > existing.fetchedAt)) {
      latestByPost.set(a.postId, a);
    }
  }

  const latestAnalytics = Array.from(latestByPost.values());

  // Aggregate
  const platformData = new Map<string, { views: number; likes: number; comments: number; shares: number; count: number; rates: number[] }>();

  for (const a of latestAnalytics) {
    metrics.totalViews += a.views || 0;
    metrics.totalLikes += a.likes || 0;
    metrics.totalComments += a.comments || 0;
    metrics.totalShares += a.shares || 0;
    metrics.totalReach += a.reach || 0;

    // Platform breakdown
    const pd = platformData.get(a.platform) || { views: 0, likes: 0, comments: 0, shares: 0, count: 0, rates: [] };
    pd.views += a.views || 0;
    pd.likes += a.likes || 0;
    pd.comments += a.comments || 0;
    pd.shares += a.shares || 0;
    pd.count++;
    if (a.engagementRate) pd.rates.push(a.engagementRate);
    platformData.set(a.platform, pd);
  }

  // Platform breakdown
  for (const [platform, data] of platformData) {
    metrics.platformBreakdown[platform] = {
      platform,
      postsCount: data.count,
      totalViews: data.views,
      totalLikes: data.likes,
      totalComments: data.comments,
      totalShares: data.shares,
      avgEngagementRate: data.rates.length > 0
        ? data.rates.reduce((a, b) => a + b, 0) / data.rates.length
        : 0,
    };
  }

  // Average engagement rate
  const allRates = latestAnalytics.map(a => a.engagementRate || 0).filter(r => r > 0);
  metrics.avgEngagementRate = allRates.length > 0
    ? allRates.reduce((a, b) => a + b, 0) / allRates.length
    : 0;

  // Completion rate
  const completionRates = latestAnalytics.map(a => a.completionRate || 0).filter(r => r > 0);
  metrics.avgCompletionRate = completionRates.length > 0
    ? completionRates.reduce((a, b) => a + b, 0) / completionRates.length
    : 0;

  // Brand exposure: total clip duration * views
  const clipDurations = new Map(clips.map(c => [c.id, c.duration]));
  for (const a of latestAnalytics) {
    const post = posts.find(p => p.id === a.postId);
    if (post) {
      // clipId is nullable now: an editorial post records editorialClipId
      // instead, so a post can legitimately carry either. Duration is only
      // tracked for remix clips, so an editorial post contributes 0 rather
      // than keying the map on null.
      const duration = post.clipId != null ? (clipDurations.get(post.clipId) || 0) : 0;
      metrics.brandExposureMinutes += ((a.views || 0) * duration) / 60;
    }
  }

  // Top clips by views
  const clipViewMap = new Map<number, { views: number; platform: string; rate: number }>();
  for (const a of latestAnalytics) {
    const post = posts.find(p => p.id === a.postId);
    // A post now points at EITHER clip table; key the top-clips map on
    // whichever id it actually carries.
    const clipKey = post ? (post.clipId ?? post.editorialClipId) : null;
    if (post && clipKey != null) {
      const existing = clipViewMap.get(clipKey);
      if (!existing || (a.views || 0) > existing.views) {
        clipViewMap.set(clipKey, {
          views: a.views || 0,
          platform: a.platform,
          rate: a.engagementRate || 0,
        });
      }
    }
  }

  metrics.topClips = Array.from(clipViewMap.entries())
    .sort((a, b) => b[1].views - a[1].views)
    .slice(0, 5)
    .map(([clipId, data]) => ({
      clipId,
      platform: data.platform,
      views: data.views,
      engagementRate: data.rate,
    }));

  return metrics;
}

// ─── Scheduled Collection ────────────────────────────────────────

let analyticsInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic analytics collection (every 30 minutes by default).
 */
export function startAnalyticsCollection(intervalMs: number = 30 * 60 * 1000) {
  if (analyticsInterval) return;

  console.log(`[Analytics] Starting collection with ${intervalMs / 1000}s interval`);
  analyticsInterval = setInterval(async () => {
    try {
      // Collect for all recent published posts
      // In production, you'd track which videos need collection
      console.log("[Analytics] Periodic collection running...");
    } catch (err) {
      console.error("[Analytics] Periodic collection error:", err);
    }
  }, intervalMs);
}

export function stopAnalyticsCollection() {
  if (analyticsInterval) {
    clearInterval(analyticsInterval);
    analyticsInterval = null;
    console.log("[Analytics] Collection stopped");
  }
}
