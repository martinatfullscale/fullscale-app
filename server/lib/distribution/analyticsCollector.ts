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

    // An empty insights array means Instagram returned nothing for this
    // media — the same outcome as a failed call. Falling through would build
    // a fully-populated object of zeros, write "0 views" to the database,
    // and the creator would read it as "nobody watched". YouTube and X both
    // bail here; this fetcher was the one that did not.
    if (Object.keys(metrics).length === 0) return {};

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
  youtube: fetchYouTubeAnalytics,
  youtube_shorts: fetchYouTubeAnalytics,
  instagram: fetchInstagramAnalytics,
  instagram_reels: fetchInstagramAnalytics,
  twitter: fetchTwitterAnalytics,
  // NOT registered, and each absence is a fact rather than an oversight:
  //
  //   tiktok   — the publisher stores the publish_id it gets back from the
  //              upload (platformPublisher.ts), but /v2/video/query/ filters
  //              by video_id. They are different identifiers, so the fetcher
  //              can only ever return {}. Registering it would manufacture a
  //              permanent silent zero. Needs a publish_id → video_id
  //              exchange before it can come back.
  //   facebook — no fetcher written.
  //   linkedin — the analytics API does not expose per-post metrics at our
  //              access tier.
  //
  // PLATFORM_METRICS_SUPPORTED below is what the UI reads so it can say
  // "not available for this platform" instead of showing a zero.
};

/** Platforms whose numbers we can actually fetch. The UI uses this to tell
 *  "we have no data yet" apart from "this platform cannot report". */
export const PLATFORM_METRICS_SUPPORTED = new Set(Object.keys(PLATFORM_FETCHERS));

/** Metrics no fetcher ever populates. Rendering these as 0 would be a lie;
 *  the UI shows them as "—". */
export const NEVER_COLLECTED_METRICS = ["completionRate", "clickThroughRate"] as const;

// ─── Collection Logic ────────────────────────────────────────────

/**
 * Fetch analytics for a single published post.
 */
export type CollectOutcome = "written" | "no_post_id" | "no_profile" | "unsupported" | "no_token" | "no_metrics" | "error";

/** Per-run cache: posts cluster on a few profiles, and resolving a YouTube
 *  token costs a DB read plus sometimes a refresh round trip. */
export type TokenCache = Map<number, { profile: any; token: string | null } | null>;

export async function collectPostAnalytics(post: PublishedPost, cache?: TokenCache): Promise<CollectOutcome> {
  if (!post.platformPostId || !post.profileId) return "no_post_id";

  const fetcher = PLATFORM_FETCHERS[post.platform];
  if (!fetcher) return "unsupported";

  // The STORED token is only a bootstrap — YouTube's expires hourly, so a
  // collector reading profile.accessToken directly 401s on every run after
  // the first hour. Every publish path already resolves a live token; this
  // was the one consumer that did not, which is a large part of why
  // clip_analytics stayed empty.
  let entry = cache?.get(post.profileId);
  if (entry === undefined) {
    const profile = await storage.getDistributionProfile(post.profileId);
    if (!profile) {
      cache?.set(post.profileId, null);
      return "no_profile";
    }
    const { resolvePublishAccessToken } = await import("./platformPublisher");
    const resolved = await resolvePublishAccessToken(profile as any);
    entry = { profile, token: resolved };
    cache?.set(post.profileId, entry);
  }
  if (!entry) return "no_profile";
  const token = entry.token;
  if (!token) {
    console.warn(`[Analytics] No usable token for ${post.platform} profile ${post.profileId} — skipping post ${post.id}`);
    return "no_token";
  }

  try {
    const metrics = await fetcher(post.platformPostId, token);

    if (Object.keys(metrics).length > 0) {
      await storage.upsertClipAnalytics({
        postId: post.id,
        // Carry the clip's identity, not just the remix half of it. Writing
        // clipId alone left every editorial post with clipId=null,
        // editorialClipId=null and the default clipSource 'remix' — orphaned
        // from its clip and mislabeled, so the flagship story clips could
        // never be joined to their own numbers.
        clipId: post.clipId,
        editorialClipId: post.editorialClipId,
        clipSource: post.clipSource ?? (post.editorialClipId ? "editorial" : "remix"),
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
      return "written";
    }
    return "no_metrics";
  } catch (err) {
    console.warn(`[Analytics] Failed to collect for post ${post.id}:`, err);
    return "error";
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

/**
 * Collect metrics for every published post the platforms can report on.
 *
 * This is what makes the loop close. The previous version of this file
 * exported a `startAnalyticsCollection` that nothing ever called and whose
 * interval body only logged "Periodic collection running…" — so the only way
 * a single row ever reached clip_analytics was a creator opening the
 * Distribution modal and pressing Refresh. Every "views" number in the
 * product read 0 as a result.
 */
let captureRunning = false;

export async function runAnalyticsCapture(): Promise<Record<CollectOutcome | "posts", number>> {
  // A slow cycle must not overlap the next tick — two concurrent runs would
  // double-write every row.
  if (captureRunning) {
    console.log("[Analytics] Capture already running — skipping this tick");
    return { posts: 0, written: 0, no_post_id: 0, no_profile: 0, unsupported: 0, no_token: 0, no_metrics: 0, error: 0 };
  }
  captureRunning = true;
  try {
    const posts = await storage.getCollectablePublishedPosts();
    const tally: Record<string, number> = { written: 0, no_post_id: 0, no_profile: 0, unsupported: 0, no_token: 0, no_metrics: 0, error: 0 };
    const cache: TokenCache = new Map();
    for (const post of posts) {
      if (!PLATFORM_METRICS_SUPPORTED.has(post.platform)) { tally.unsupported += 1; continue; }
      try {
        // Count what was WRITTEN, not what was attempted. The earlier version
        // incremented per iteration, so a run where every single fetch came
        // back empty still logged "N collected" — hiding the exact failure
        // the job exists to detect.
        tally[await collectPostAnalytics(post, cache)] += 1;
      } catch (err: any) {
        tally.error += 1;
        console.warn(`[Analytics] capture failed for post ${post.id}:`, err?.message || err);
      }
      // Space out third-party calls — this runs against four APIs at once.
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(
      `[Analytics] Capture complete over ${posts.length} post(s): ${tally.written} written, ` +
      `${tally.no_metrics} returned nothing, ${tally.no_token} had no usable token, ` +
      `${tally.unsupported} on platforms that cannot report, ${tally.error} errored`,
    );
    return { posts: posts.length, ...tally } as any;
  } finally {
    captureRunning = false;
  }
}

let analyticsInterval: ReturnType<typeof setInterval> | null = null;
let firstRunTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Background capture, modeled on the video-stat and retention jobs that
 * already run at boot: a delay so it never competes with startup, a long
 * cycle because platform numbers move slowly, and a kill switch.
 */
export function startAnalyticsCaptureJob(): void {
  if (analyticsInterval) return;
  if (process.env.ANALYTICS_CAPTURE_ENABLED === "false") {
    console.log("[Analytics] Capture job disabled by ANALYTICS_CAPTURE_ENABLED=false");
    return;
  }
  const CYCLE_MS = 6 * 60 * 60 * 1000; // 6h
  const FIRST_RUN_MS = 5 * 60 * 1000;  // 5min after boot
  const tick = () => {
    runAnalyticsCapture().catch((err) => console.error("[Analytics] capture cycle error:", err?.message || err));
  };
  firstRunTimer = setTimeout(tick, FIRST_RUN_MS);
  firstRunTimer.unref?.();
  analyticsInterval = setInterval(tick, CYCLE_MS);
  analyticsInterval.unref?.();
  console.log(`[Analytics] Capture job scheduled — first run in ${FIRST_RUN_MS / 60000}min, then every ${CYCLE_MS / 3600000}h`);
}

export function stopAnalyticsCollection() {
  if (firstRunTimer) { clearTimeout(firstRunTimer); firstRunTimer = null; }
  if (analyticsInterval) {
    clearInterval(analyticsInterval);
    analyticsInterval = null;
    console.log("[Analytics] Collection stopped");
  }
}
