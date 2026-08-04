/**
 * Per-video audience time series — the OUTCOME side of the measurement design.
 *
 * video_index.view_count is overwritten on every refresh, so it can only ever
 * answer "how many views now". Causal comparison needs trajectories: view
 * velocity before and after a placement went live, and the counterfactual
 * slope during control periods. This job APPENDS a row per video per cycle
 * instead of overwriting, so those slopes exist to be measured.
 *
 * Scope is deliberately narrow: videos under measurement (carrying a fixture
 * with a treatment window or a recorded exposure). Polling a creator's whole
 * back-catalogue every cycle would burn quota for data no one is analyzing.
 *
 * Closes data-dictionary gap 7 for YouTube. Other platforms fall through
 * until their per-post fetchers are wired.
 */

import { storage } from "../storage";
import { getFreshYoutubeTokenForUser } from "./youtubeAuth";
import { fetchYouTubeVideoStats } from "./socialAnalytics";

const CYCLE_MS = 6 * 60 * 60 * 1000;      // 4x/day — enough to see velocity
const FIRST_RUN_DELAY_MS = 3 * 60 * 1000; // let boot settle

export async function runVideoStatSnapshots(): Promise<{ captured: number; skipped: number }> {
  let captured = 0;
  let skipped = 0;

  const videoIds = await storage.getVideoIdsUnderMeasurement();
  if (videoIds.length === 0) {
    console.log("[VideoStats] No videos under measurement — nothing to poll");
    return { captured: 0, skipped: 0 };
  }
  console.log(`[VideoStats] Cycle: ${videoIds.length} video(s) under measurement`);

  // YouTube batches (videos.list takes 50 ids per call); every other
  // platform is fetched per-video through the dispatcher.
  const byUser = new Map<string, Array<{ id: number; platform: string; nativeId: string }>>();
  const others: Array<{ id: number; platform: string; storedId: string; userId: string }> = [];
  for (const id of videoIds) {
    const video = await storage.getVideoById(id).catch(() => undefined);
    if (!video) { skipped++; continue; }
    const platform = String((video as any).platform ?? "");
    const storedId = String((video as any).youtubeId ?? "");
    const userId = String((video as any).userId);
    if (!storedId) { skipped++; continue; }
    if (platform === "youtube" && !storedId.includes(":")) {
      const arr = byUser.get(userId) ?? [];
      arr.push({ id, platform, nativeId: storedId });
      byUser.set(userId, arr);
    } else {
      others.push({ id, platform, storedId, userId });
    }
  }

  for (const [userId, videos] of Array.from(byUser.entries())) {
    try {
      const token = await getFreshYoutubeTokenForUser(userId).catch(() => null);
      if (!token) {
        skipped += videos.length;
        continue;
      }
      // videos.list takes 50 ids per call.
      for (let i = 0; i < videos.length; i += 50) {
        const batch = videos.slice(i, i + 50);
        const stats = await fetchYouTubeVideoStats(batch.map((v) => v.nativeId), token);
        const byNative = new Map(stats.map((st: any) => [String(st.videoId ?? st.id), st]));
        for (const v of batch) {
          const st: any = byNative.get(v.nativeId);
          if (!st) { skipped++; continue; }
          await storage.insertVideoStatSnapshot({
            videoId: v.id,
            userId,
            platform: "youtube",
            platformPostId: v.nativeId,
            viewCount: typeof st.viewCount === "number" ? st.viewCount : Number(st.viewCount) || null,
            likeCount: typeof st.likeCount === "number" ? st.likeCount : Number(st.likeCount) || null,
            commentCount: typeof st.commentCount === "number" ? st.commentCount : Number(st.commentCount) || null,
            raw: st ?? null,
          } as any);
          captured++;
        }
        await new Promise((r) => setTimeout(r, 500)); // gentle pacing
      }
    } catch (err: any) {
      skipped += videos.length;
      console.warn(`[VideoStats] User ${userId} batch failed (non-fatal): ${err?.message}`);
    }
  }

  // ── Twitch / TikTok / X ────────────────────────────────────────────
  // Each returns a REASON when it can't fetch (missing credentials, no
  // creator OAuth, paid tier, unresolvable id) so a dark platform explains
  // itself in the logs rather than looking like zero engagement.
  const reasonCounts = new Map<string, number>();
  for (const v of others) {
    try {
      const { fetchPlatformMetrics } = await import("./platformMetrics");
      const result = await fetchPlatformMetrics(v.platform, v.storedId, v.userId);
      if (!result.ok) {
        skipped++;
        reasonCounts.set(result.reason, (reasonCounts.get(result.reason) ?? 0) + 1);
        continue;
      }
      const m = result.metrics;
      await storage.insertVideoStatSnapshot({
        videoId: v.id,
        userId: v.userId,
        platform: v.platform,
        platformPostId: m.platformPostId,
        viewCount: m.viewCount,
        likeCount: m.likeCount,
        commentCount: m.commentCount,
        raw: { ...m.raw, shareCount: m.shareCount ?? null },
      } as any);
      captured++;
      await new Promise((r) => setTimeout(r, 350));
    } catch (err: any) {
      skipped++;
      console.warn(`[VideoStats] ${v.platform} video ${v.id} failed (non-fatal): ${err?.message}`);
    }
  }
  for (const [reason, n] of Array.from(reasonCounts.entries())) {
    console.log(`[VideoStats] ${n} video(s) skipped — ${reason}`);
  }

  console.log(`[VideoStats] Cycle done: ${captured} snapshot(s) captured, ${skipped} skipped`);
  return { captured, skipped };
}

/**
 * Close treatment windows whose deal term has expired. Without this a
 * finished campaign reads as TREATED forever and every later second of that
 * fixture is misclassified — the schema documented `expired` as an end
 * reason that nothing ever wrote.
 */
export async function sweepExpiredAssignments(): Promise<number> {
  try {
    const { storage: st } = await import("../storage");
    const expired = await st.getExpiredOpenAssignments();
    let closed = 0;
    for (const a of expired) {
      const n = await st.closeFixtureAssignment({ assignmentId: a.assignmentId! }, "expired").catch(() => 0);
      if (n) {
        closed += n;
        // Expired treatment → the fixture returns to observed-untreated.
        await st.openControlPeriod({
          userId: a.userId,
          surfaceGroupId: a.surfaceGroupId,
          videoId: a.videoId,
        }).catch(() => null);
      }
    }
    if (closed > 0) console.log(`[Measurement] Expiry sweep: closed ${closed} treatment window(s), reopened control`);
    return closed;
  } catch (err: any) {
    console.warn(`[Measurement] Expiry sweep failed (non-fatal): ${err?.message}`);
    return 0;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startVideoStatSeriesJob(): void {
  if (timer) return;
  const cycle = async () => {
    // Sweep first: an expired window must not attribute this cycle's
    // audience movement to a treatment that already ended.
    await sweepExpiredAssignments();
    await runVideoStatSnapshots();
  };
  setTimeout(() => {
    cycle().catch((err) => console.warn("[VideoStats] Initial run failed (non-fatal):", err?.message));
  }, FIRST_RUN_DELAY_MS);
  timer = setInterval(() => {
    cycle().catch((err) => console.warn("[VideoStats] Cycle failed (non-fatal):", err?.message));
  }, CYCLE_MS);
  timer.unref?.();
  console.log(`[VideoStats] Time-series job started (every ${CYCLE_MS / 3600000}h, first run in ${FIRST_RUN_DELAY_MS / 60000}min)`);
}
