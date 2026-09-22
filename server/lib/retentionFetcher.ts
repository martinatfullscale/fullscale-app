/**
 * Audience retention curves + per-video demographics from YouTube Analytics.
 *
 * This is the measurement the CV-impact study actually turns on: for each
 * point in a video, what fraction of viewers were still watching. Join that
 * against a placement's timestamp and you can ask whether viewers linger,
 * drop, or rewind at the seconds a product is on screen.
 *
 * Nothing new had to be authorized — `yt-analytics.readonly` has been in the
 * OAuth scope list since launch; the report was simply never requested.
 *
 * Closes data-dictionary gaps 3 and 4 for YouTube.
 */

import { storage } from "../storage";
import { getFreshYoutubeTokenForUser } from "./youtubeAuth";

export interface RetentionPoint {
  ratio: number;                        // 0.0 → 1.0 through the video
  watchRatio: number;                   // fraction of viewers still watching
  relativePerformance?: number | null;  // vs. similar YouTube videos
}

async function ytAnalytics(url: string, accessToken: string): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, data: { error: { message: err?.message } } };
  }
}

/**
 * Fetch the retention curve for one video. Returns null when the report is
 * unavailable — a video below YouTube's reporting threshold, too new, or not
 * owned by the token's channel. That's a normal state, not an error.
 */
export async function fetchRetentionCurve(
  platformPostId: string,
  accessToken: string,
  opts: { startDate?: string; endDate?: string } = {},
): Promise<{ curve: RetentionPoint[]; startDate: string; endDate: string } | null> {
  const endDate = opts.endDate ?? new Date().toISOString().slice(0, 10);
  const startDate = opts.startDate ?? new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

  const url =
    `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE` +
    `&startDate=${startDate}&endDate=${endDate}` +
    `&dimensions=elapsedVideoTimeRatio` +
    `&metrics=audienceWatchRatio,relativeRetentionPerformance` +
    `&filters=video%3D%3D${encodeURIComponent(platformPostId)}`;

  const res = await ytAnalytics(url, accessToken);
  if (!res.ok) {
    console.warn(`[Retention] ${platformPostId}: report failed (${res.status}) ${res.data?.error?.message ?? ""}`);
    return null;
  }
  const rows: any[] = Array.isArray(res.data?.rows) ? res.data.rows : [];
  if (rows.length === 0) return null; // below threshold / no data yet

  const curve: RetentionPoint[] = rows
    .map((r) => ({
      ratio: typeof r[0] === "number" ? r[0] : Number(r[0]),
      watchRatio: typeof r[1] === "number" ? r[1] : Number(r[1]),
      relativePerformance: typeof r[2] === "number" ? r[2] : null,
    }))
    .filter((p) => Number.isFinite(p.ratio) && Number.isFinite(p.watchRatio))
    .sort((a, b) => a.ratio - b.ratio);

  return curve.length > 0 ? { curve, startDate, endDate } : null;
}

/** Per-video ageGroup × gender. Same threshold caveat as the curve. */
export async function fetchVideoDemographics(
  platformPostId: string,
  accessToken: string,
  opts: { startDate?: string; endDate?: string } = {},
): Promise<{
  ageDistribution: Record<string, number>;
  genderDistribution: Record<string, number>;
  raw: any;
  startDate: string;
  endDate: string;
} | null> {
  const endDate = opts.endDate ?? new Date().toISOString().slice(0, 10);
  const startDate = opts.startDate ?? new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

  const url =
    `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE` +
    `&startDate=${startDate}&endDate=${endDate}` +
    `&dimensions=ageGroup,gender&metrics=viewerPercentage` +
    `&filters=video%3D%3D${encodeURIComponent(platformPostId)}`;

  const res = await ytAnalytics(url, accessToken);
  if (!res.ok || !Array.isArray(res.data?.rows) || res.data.rows.length === 0) return null;

  const age: Record<string, number> = {};
  const gender: Record<string, number> = {};
  for (const row of res.data.rows) {
    const ageGroup = String(row[0] ?? "").replace(/^age/, "");
    const g = String(row[1] ?? "").toLowerCase();
    const pct = typeof row[2] === "number" ? row[2] : 0;
    if (ageGroup) age[ageGroup] = (age[ageGroup] ?? 0) + pct;
    if (g) gender[g] = (gender[g] ?? 0) + pct;
  }
  const normalize = (d: Record<string, number>) => {
    const total = Object.values(d).reduce((a, b) => a + b, 0);
    if (total <= 0) return d;
    return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Math.round((v / total) * 1000) / 1000]));
  };
  return {
    ageDistribution: normalize(age),
    genderDistribution: normalize(gender),
    raw: res.data.rows,
    startDate,
    endDate,
  };
}

/**
 * Retention + demographics for every video under measurement. Runs daily:
 * curves move slowly, and each video costs two API calls.
 */
export async function runRetentionCapture(): Promise<{ curves: number; demos: number; skipped: number }> {
  let curves = 0;
  let demos = 0;
  let skipped = 0;

  const videoIds = await storage.getVideoIdsUnderMeasurement();
  if (videoIds.length === 0) {
    console.log("[Retention] No videos under measurement — nothing to capture");
    return { curves: 0, demos: 0, skipped: 0 };
  }
  console.log(`[Retention] Cycle: ${videoIds.length} video(s) under measurement`);

  // One projected batch instead of a full row per video. getVideoById returns
  // scene_index and scene_inventory jsonb, which the pg driver parses
  // synchronously — and this job shares the single Node thread with every HTTP
  // request, so a big measurement set stalls the whole site on a timer.
  const videoMap = await storage.getVideoSummaries(videoIds);
  const tokenCache = new Map<string, string | null>();
  for (const id of videoIds) {
    try {
      const video = videoMap.get(id);
      if (!video) { skipped++; continue; }
      const platform = String((video as any).platform ?? "");
      const nativeId = String((video as any).youtubeId ?? "");
      // Retention is a YouTube-Analytics capability; other platforms have no
      // equivalent per-post curve today.
      if (platform !== "youtube" || !nativeId || nativeId.includes(":")) { skipped++; continue; }

      const userId = String((video as any).userId);
      if (!tokenCache.has(userId)) {
        tokenCache.set(userId, await getFreshYoutubeTokenForUser(userId).catch(() => null));
      }
      const token = tokenCache.get(userId);
      if (!token) { skipped++; continue; }

      const durationSec = (() => {
        const d = (video as any).duration;
        if (typeof d === "string") {
          const m = d.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
          if (m) return (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
        }
        return null;
      })();

      const retention = await fetchRetentionCurve(nativeId, token);
      if (retention) {
        await storage.insertRetentionCurve({
          videoId: id,
          userId,
          platform: "youtube",
          platformPostId: nativeId,
          videoDurationSec: durationSec ? String(Math.round(durationSec)) : null,
          curve: retention.curve,
          startDate: retention.startDate,
          endDate: retention.endDate,
        } as any);
        curves++;
      }

      const demo = await fetchVideoDemographics(nativeId, token);
      if (demo) {
        await storage.insertVideoDemographics({
          videoId: id,
          userId,
          platform: "youtube",
          platformPostId: nativeId,
          ageDistribution: demo.ageDistribution,
          genderDistribution: demo.genderDistribution,
          raw: demo.raw,
          startDate: demo.startDate,
          endDate: demo.endDate,
        } as any);
        demos++;
      }
      if (!retention && !demo) skipped++;

      await new Promise((r) => setTimeout(r, 600)); // pacing
    } catch (err: any) {
      skipped++;
      console.warn(`[Retention] Video ${id} failed (non-fatal): ${err?.message}`);
    }
  }

  console.log(`[Retention] Cycle done: ${curves} curve(s), ${demos} demographic set(s), ${skipped} skipped`);
  return { curves, demos, skipped };
}

const CYCLE_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startRetentionCaptureJob(): void {
  if (timer) return;
  setTimeout(() => {
    runRetentionCapture().catch((err) =>
      console.warn("[Retention] Initial run failed (non-fatal):", err?.message));
  }, FIRST_RUN_DELAY_MS);
  timer = setInterval(() => {
    runRetentionCapture().catch((err) =>
      console.warn("[Retention] Cycle failed (non-fatal):", err?.message));
  }, CYCLE_MS);
  timer.unref?.();
  console.log(`[Retention] Capture job started (daily, first run in ${FIRST_RUN_DELAY_MS / 60000}min)`);
}
