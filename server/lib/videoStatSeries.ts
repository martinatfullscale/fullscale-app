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

  // Group by owner so one token refresh covers all of that creator's videos,
  // and by platform because each has its own fetcher.
  const byUser = new Map<string, Array<{ id: number; platform: string; nativeId: string }>>();
  for (const id of videoIds) {
    const video = await storage.getVideoById(id).catch(() => undefined);
    if (!video) { skipped++; continue; }
    const platform = String((video as any).platform ?? "");
    const nativeId = String((video as any).youtubeId ?? "");
    if (platform !== "youtube" || !nativeId || nativeId.includes(":")) {
      // Non-YouTube platforms have no per-post series fetcher yet.
      skipped++;
      continue;
    }
    const key = String((video as any).userId);
    const arr = byUser.get(key) ?? [];
    arr.push({ id, platform, nativeId });
    byUser.set(key, arr);
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

  console.log(`[VideoStats] Cycle done: ${captured} snapshot(s) captured, ${skipped} skipped`);
  return { captured, skipped };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startVideoStatSeriesJob(): void {
  if (timer) return;
  setTimeout(() => {
    runVideoStatSnapshots().catch((err) =>
      console.warn("[VideoStats] Initial run failed (non-fatal):", err?.message));
  }, FIRST_RUN_DELAY_MS);
  timer = setInterval(() => {
    runVideoStatSnapshots().catch((err) =>
      console.warn("[VideoStats] Cycle failed (non-fatal):", err?.message));
  }, CYCLE_MS);
  timer.unref?.();
  console.log(`[VideoStats] Time-series job started (every ${CYCLE_MS / 3600000}h, first run in ${FIRST_RUN_DELAY_MS / 60000}min)`);
}
