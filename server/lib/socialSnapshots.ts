/**
 * Social insight snapshots — FullScale's own longitudinal analytics record.
 *
 * Meta only retains account-level Instagram insights ~90 days and story
 * insights 24 hours. This job runs every 12 hours, pulls the current
 * account metrics + demographics + live-story insights for every connected
 * Meta account, and appends them to social_insight_snapshots — so creator
 * history accumulates indefinitely on our side and the analytics UI can
 * chart beyond Meta's window.
 *
 * It now covers the whole 2x2 of (account | content) x (Meta | YouTube,
 * Twitch), because each platform was strong exactly where the other was
 * blind:
 *
 *   ACCOUNT level — Meta had history (their API forced us to keep our own);
 *     YouTube and Twitch channel stats were OVERWRITTEN on every refresh, so
 *     "did the channel grow while the campaign ran" had no answer.
 *   CONTENT level — YouTube had history via the 6-hourly video_stat_snapshots
 *     job; Meta per-media insights were read ON DEMAND and discarded, so a
 *     Reel's trajectory existed only for as long as a page was open.
 *
 * A pilot readout needs all four cells: content-level movement is the effect,
 * account-level movement is the confound (a creator whose whole channel
 * doubled that month did not get that lift from one placement).
 *
 * Fail-soft everywhere: a dead token or an unsupported metric skips that
 * account/metric, never the whole run.
 */

import { storage } from "../storage";
import {
  fetchInstagramAccountInsights,
  fetchInstagramStoryInsights,
  fetchInstagramAnalytics,
  fetchFacebookPageAnalytics,
  fetchFacebookPagePosts,
} from "./socialAnalytics";

const SNAPSHOT_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h — stories live 24h, so two chances per story
const FIRST_RUN_DELAY_MS = 3 * 60 * 1000;         // let boot settle first

export async function runSocialInsightSnapshots(): Promise<{ captured: number; skipped: number }> {
  let captured = 0;
  let skipped = 0;
  const accounts = await storage.getAllMetaSocialAccounts();
  console.log(`[SocialSnapshots] Snapshot cycle: ${accounts.length} Meta account(s)`);

  for (const acct of accounts) {
    try {
      const token = acct.accessToken; // decrypted by getAllMetaSocialAccounts
      if (!token) { skipped++; continue; }

      if (acct.platform === "instagram") {
        const insights = await fetchInstagramAccountInsights(acct.platformAccountId, token);
        if (!insights) { skipped++; continue; }
        const stories = await fetchInstagramStoryInsights(acct.platformAccountId, token);

        await storage.insertSocialInsightSnapshot({
          socialAccountId: acct.id,
          userId: acct.userId,
          platform: "instagram",
          platformAccountId: acct.platformAccountId,
          followers: acct.followers ?? null,
          metrics: insights.metrics,
          demographics: Object.keys(insights.demographics).length > 0 ? insights.demographics : null,
          stories: stories.length > 0 ? stories : null,
        });
        // Keep the account's live demographics fresh for the UI.
        if (Object.keys(insights.demographics).length > 0) {
          await storage.updateSocialAccountAudience(acct.id, insights.demographics);
        }
        captured++;
        captured += await captureInstagramPostSnapshots(acct, token);
      } else if (acct.platform === "facebook") {
        const page = await fetchFacebookPageAnalytics(acct.platformAccountId, token);
        if (!page) { skipped++; continue; }
        await storage.insertSocialInsightSnapshot({
          socialAccountId: acct.id,
          userId: acct.userId,
          platform: "facebook",
          platformAccountId: acct.platformAccountId,
          followers: page.fanCount ?? acct.followers ?? null,
          metrics: page.insights,
          demographics: null,
          stories: null,
        });
        captured++;
        captured += await captureFacebookPostSnapshots(acct, token);
      } else if (acct.platform === "youtube") {
        // No live API call here — the daily audience cron already refreshes
        // audience_data (90-day views, watch time, subs gained) via
        // fetchYoutubeAudience with the youtube_connections token dance,
        // which this module deliberately doesn't reimplement. The snapshot's
        // job is to give those numbers a TIME AXIS: one row per cycle, so
        // the analytics trend charts have a series to draw. Before this
        // branch, YouTube accounts were `skipped++` and the charts promised
        // "trend appears after a few snapshot cycles" forever.
        const eng = ((acct as any).audienceData?.engagement ?? {}) as Record<string, number | null>;
        await storage.insertSocialInsightSnapshot({
          socialAccountId: acct.id,
          userId: acct.userId,
          platform: "youtube",
          platformAccountId: acct.platformAccountId,
          followers: acct.followers ?? null,
          metrics: {
            // "reach" is where fetchYoutubeAudience stores 90-day channel
            // views; mirror it under "views" too because the trend series
            // reads metrics.views.
            views: eng.reach ?? 0,
            reach: eng.reach ?? 0,
            estimated_minutes_watched: eng.estimated_minutes_watched ?? 0,
            subscribers_gained: eng.subscribers_gained ?? 0,
          },
          demographics: null,
          stories: null,
        });
        captured++;
      } else {
        skipped++;
      }
      // Gentle pacing between accounts — insights calls fan out per account.
      await new Promise((r) => setTimeout(r, 750));
    } catch (err: any) {
      skipped++;
      console.warn(`[SocialSnapshots] Account ${acct.platform}/${acct.platformAccountId} failed (non-fatal): ${err?.message}`);
    }
  }

  // ── CHANNEL LEVEL for YouTube and Twitch ─────────────────────────────
  // Same table, same cadence, so the analysis layer never branches on
  // platform just to get a follower series.
  for (const [label, fn] of [
    ["YouTube", captureYoutubeChannelSnapshots],
    ["Twitch", captureTwitchChannelSnapshots],
  ] as const) {
    try {
      const r = await fn();
      captured += r.captured;
      skipped += r.skipped;
    } catch (err: any) {
      console.warn(`[SocialSnapshots] ${label} channel snapshots failed (non-fatal): ${err?.message}`);
    }
  }

  console.log(`[SocialSnapshots] Cycle done: ${captured} captured, ${skipped} skipped`);
  return { captured, skipped };
}

let snapshotTimer: ReturnType<typeof setInterval> | null = null;

export function startSocialSnapshotJob(): void {
  if (snapshotTimer) return;
  setTimeout(() => {
    runSocialInsightSnapshots().catch((err) =>
      console.warn("[SocialSnapshots] Initial run failed (non-fatal):", err?.message));
  }, FIRST_RUN_DELAY_MS);
  snapshotTimer = setInterval(() => {
    runSocialInsightSnapshots().catch((err) =>
      console.warn("[SocialSnapshots] Cycle failed (non-fatal):", err?.message));
  }, SNAPSHOT_INTERVAL_MS);
  console.log(`[SocialSnapshots] Job started (every ${SNAPSHOT_INTERVAL_MS / 3600000}h, first run in ${FIRST_RUN_DELAY_MS / 60000}min)`);
}

// ── Content level: Meta ────────────────────────────────────────────────
// Meta's per-media insights are cumulative lifetime counters, so a single
// read is a level and two reads are a rate. Only the rate is comparable
// across posts of different ages, which is why these are appended.

const META_POSTS_PER_ACCOUNT = 12; // recent window — older posts barely move

async function captureInstagramPostSnapshots(acct: any, token: string): Promise<number> {
  try {
    const stats = await fetchInstagramAnalytics(acct.platformAccountId, token, META_POSTS_PER_ACCOUNT);
    if (!stats?.recentMedia?.length) return 0;
    let n = 0;
    for (const m of stats.recentMedia) {
      // fetchInstagramAnalytics zero-fills insight fields when the metric
      // read fails, and a zero in a research dataset gets modeled while a
      // null gets excluded. Treat "no engagement signal at all" as a failed
      // read rather than as genuine zero reach.
      const insightsRead = (m.views ?? 0) > 0 || (m.reach ?? 0) > 0 || (m.totalInteractions ?? 0) > 0;
      await storage.insertSocialPostSnapshot({
        socialAccountId: acct.id,
        userId: acct.userId,
        platform: "instagram",
        platformAccountId: acct.platformAccountId,
        platformPostId: m.mediaId,
        mediaType: m.mediaType ?? null,
        permalink: m.permalink ?? null,
        postedAt: m.timestamp ? new Date(m.timestamp) : null,
        views: insightsRead ? m.views ?? null : null,
        reach: insightsRead ? m.reach ?? null : null,
        likeCount: m.likeCount ?? null,
        commentCount: m.commentsCount ?? null,
        savedCount: insightsRead ? m.saved ?? null : null,
        shareCount: insightsRead ? m.shares ?? null : null,
        totalInteractions: insightsRead ? m.totalInteractions ?? null : null,
        avgWatchTimeMs: m.avgWatchTimeMs || null,
        totalWatchTimeMs: m.totalWatchTimeMs || null,
        raw: { ...m, insightsRead },
      });
      n++;
    }
    return n;
  } catch (err: any) {
    console.warn(`[SocialSnapshots] IG post snapshots failed for ${acct.platformAccountId}: ${err?.message}`);
    return 0;
  }
}

async function captureFacebookPostSnapshots(acct: any, token: string): Promise<number> {
  try {
    const posts = await fetchFacebookPagePosts(acct.platformAccountId, token, META_POSTS_PER_ACCOUNT);
    let n = 0;
    for (const p of posts) {
      await storage.insertSocialPostSnapshot({
        socialAccountId: acct.id,
        userId: acct.userId,
        platform: "facebook",
        platformAccountId: acct.platformAccountId,
        platformPostId: p.postId,
        // Don't infer type from post_video_views: it is also null when
        // read_insights is missing, which would relabel every video a POST.
        mediaType: null,
        permalink: p.permalink,
        postedAt: p.createdTime ? new Date(p.createdTime) : null,
        // FB post_impressions counts deliveries, not plays. Kept in `views`
        // for one comparable column across Meta surfaces, with the raw
        // payload preserving which metric it actually came from.
        views: p.videoViews ?? p.impressions ?? null,
        reach: p.reach,
        likeCount: p.reactions,
        commentCount: p.comments,
        savedCount: null,          // no FB equivalent
        shareCount: p.shares,
        totalInteractions: null,   // IG-only metric
        avgWatchTimeMs: null,
        totalWatchTimeMs: null,
        raw: { ...p, viewsSource: p.videoViews !== null ? "post_video_views" : "post_impressions" },
      });
      n++;
    }
    return n;
  } catch (err: any) {
    console.warn(`[SocialSnapshots] FB post snapshots failed for ${acct.platformAccountId}: ${err?.message}`);
    return 0;
  }
}

// ── Account level: YouTube and Twitch ──────────────────────────────────

/**
 * YouTube channel snapshot: subscribers, lifetime views, upload count.
 * Uses the creator's existing OAuth token — no new consent, no new scope.
 */
async function captureYoutubeChannelSnapshots(): Promise<{ captured: number; skipped: number }> {
  let captured = 0;
  let skipped = 0;
  const keys = await storage.getYoutubeConnectionKeys().catch(() => [] as string[]);
  if (keys.length === 0) return { captured, skipped };
  console.log(`[SocialSnapshots] YouTube channel cycle: ${keys.length} connection(s)`);

  const { getFreshYoutubeTokenForUser } = await import("./youtubeAuth");
  for (const key of keys) {
    try {
      const token = await getFreshYoutubeTokenForUser(key).catch(() => null);
      if (!token) { skipped++; continue; }
      const res = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) { skipped++; continue; }
      const data: any = await res.json();
      const ch = data?.items?.[0];
      if (!ch?.id) { skipped++; continue; }
      const stats = ch.statistics ?? {};
      // hiddenSubscriberCount channels return no subscriberCount at all —
      // null, not zero, or the growth series reads as a collapse.
      const subs = stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount);

      await storage.insertSocialInsightSnapshot({
        socialAccountId: null,
        userId: key,
        platform: "youtube",
        platformAccountId: String(ch.id),
        followers: Number.isFinite(subs as number) ? (subs as number) : null,
        metrics: {
          subscriberCount: Number.isFinite(subs as number) ? subs : null,
          subscriberCountHidden: !!stats.hiddenSubscriberCount,
          viewCount: Number.isFinite(Number(stats.viewCount)) ? Number(stats.viewCount) : null,
          videoCount: Number.isFinite(Number(stats.videoCount)) ? Number(stats.videoCount) : null,
          channelTitle: ch.snippet?.title ?? null,
        },
        demographics: null,
        stories: null,
      } as any);
      captured++;
      await new Promise((r) => setTimeout(r, 400));
    } catch (err: any) {
      skipped++;
      console.warn(`[SocialSnapshots] YouTube channel snapshot failed for ${key}: ${err?.message}`);
    }
  }
  return { captured, skipped };
}

/**
 * Twitch channel snapshot: follower total + broadcaster identity.
 *
 * Runs on the APP token (client_credentials), so it needs no creator OAuth —
 * the same reason Twitch view counts already work. Broadcaster ids are
 * resolved from the creator's imported Twitch content, because FullScale
 * stores no Twitch account link yet. That means the channel snapshotted is
 * whoever BROADCAST the imported VOD, which is the creator only when the
 * content is genuinely theirs — attributed to the importing user and marked
 * `ownershipVerified: false` so the analysis never silently assumes it.
 */
async function captureTwitchChannelSnapshots(): Promise<{ captured: number; skipped: number }> {
  let captured = 0;
  let skipped = 0;
  const samples = await storage.getTwitchContentSamples(5).catch(() => [] as Array<{ userId: string; storedId: string }>);
  if (samples.length === 0) return { captured, skipped };

  const { getTwitchAppToken } = await import("./platformMetrics");
  const { nativeIdForStoredId } = await import("./platformSources");
  const token = await getTwitchAppToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!token || !clientId) {
    console.warn("[SocialSnapshots] Twitch channel snapshots skipped — TWITCH_CLIENT_ID/SECRET not configured");
    return { captured, skipped: samples.length };
  }
  const headers = { Authorization: `Bearer ${token}`, "Client-Id": clientId };
  console.log(`[SocialSnapshots] Twitch channel cycle: resolving from ${samples.length} imported item(s)`);

  // Resolve distinct broadcasters first so a creator with five VODs from the
  // same channel produces one snapshot, not five.
  const broadcasters = new Map<string, string>(); // broadcasterId -> importing userId
  for (const sample of samples) {
    try {
      const native = nativeIdForStoredId("twitch", sample.storedId);
      let url: string | null = null;
      if (native.kind === "twitch_video") url = `https://api.twitch.tv/helix/videos?id=${encodeURIComponent(native.id)}`;
      else if (native.kind === "twitch_clip") url = `https://api.twitch.tv/helix/clips?id=${encodeURIComponent(native.id)}`;
      if (!url) { skipped++; continue; }
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) { skipped++; continue; }
      const data: any = await res.json();
      // Helix names the owner `user_id` on videos and `broadcaster_id` on clips.
      const bid = data?.data?.[0]?.user_id ?? data?.data?.[0]?.broadcaster_id;
      if (!bid) { skipped++; continue; }
      if (!broadcasters.has(String(bid))) broadcasters.set(String(bid), sample.userId);
      await new Promise((r) => setTimeout(r, 250));
    } catch {
      skipped++;
    }
  }

  for (const [broadcasterId, userId] of Array.from(broadcasters.entries())) {
    try {
      const userRes = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(broadcasterId)}`, {
        headers, signal: AbortSignal.timeout(15_000),
      });
      if (!userRes.ok) { skipped++; continue; }
      const u: any = (await userRes.json())?.data?.[0];
      if (!u) { skipped++; continue; }

      let followers: number | null = null;
      const fRes = await fetch(
        `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=1`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (fRes.ok) {
        const f: any = await fRes.json();
        followers = typeof f?.total === "number" ? f.total : null;
      }

      await storage.insertSocialInsightSnapshot({
        socialAccountId: null,
        userId,
        platform: "twitch",
        platformAccountId: broadcasterId,
        followers,
        metrics: {
          followers,
          displayName: u.display_name ?? null,
          login: u.login ?? null,
          broadcasterType: u.broadcaster_type ?? null,
          // Twitch retired the lifetime channel view counter in 2022 —
          // absent by their design, not by our omission.
          profileViewCount: null,
          ownershipVerified: false,
        },
        demographics: null,
        stories: null,
      } as any);
      captured++;
      await new Promise((r) => setTimeout(r, 300));
    } catch (err: any) {
      skipped++;
      console.warn(`[SocialSnapshots] Twitch channel snapshot failed for ${broadcasterId}: ${err?.message}`);
    }
  }
  return { captured, skipped };
}
