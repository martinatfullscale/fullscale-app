/**
 * Audience response — what happens, and what people SAY, when a brand
 * integration appears.
 *
 * Two halves:
 *
 *   QUANTITATIVE — per-day views/likes/comments/shares from YouTube
 *   Analytics. Unlike the 6-hourly counter snapshots (which only start
 *   accumulating once we begin polling), this report is RETROACTIVE to
 *   publish date, so a before/after comparison around a placement's go-live
 *   works on day one instead of after weeks of waiting.
 *
 *   QUALITATIVE — comment text via commentThreads, classified for sentiment
 *   and whether the comment references the placed product at all. That
 *   second flag is what separates "the audience reacted to the integration"
 *   from "the audience reacted to the video".
 *
 * YouTube-only by necessity: Instagram/Facebook comment text needs an App
 * Review permission, TikTok exposes no comment list to this integration, X
 * needs a paid tier, and Twitch has no comment concept at all.
 */

import { storage } from "../storage";
import { getFreshYoutubeTokenForUser } from "./youtubeAuth";

async function ytFetch(url: string, token: string): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, data: { error: { message: err?.message } } };
  }
}

// ── Quantitative: per-day series ────────────────────────────────────────

export async function fetchDailyMetrics(
  platformPostId: string,
  token: string,
  startDate: string,
  endDate: string,
): Promise<Array<{ day: string; views: number; likes: number; comments: number; shares: number; minutes: number; avgDuration: number }> | null> {
  const url =
    `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE` +
    `&startDate=${startDate}&endDate=${endDate}&dimensions=day` +
    `&metrics=views,likes,comments,shares,estimatedMinutesWatched,averageViewDuration` +
    `&filters=video%3D%3D${encodeURIComponent(platformPostId)}&sort=day`;
  const res = await ytFetch(url, token);
  if (!res.ok || !Array.isArray(res.data?.rows)) return null;
  return res.data.rows.map((r: any[]) => ({
    day: String(r[0]),
    views: Number(r[1]) || 0,
    likes: Number(r[2]) || 0,
    comments: Number(r[3]) || 0,
    shares: Number(r[4]) || 0,
    minutes: Number(r[5]) || 0,
    avgDuration: Number(r[6]) || 0,
  }));
}

// ── Qualitative: comments ───────────────────────────────────────────────

export async function fetchComments(
  platformPostId: string,
  token: string,
  maxComments = 200,
): Promise<Array<{ id: string; author: string; text: string; likeCount: number; publishedAt: string }> | null> {
  const out: Array<{ id: string; author: string; text: string; likeCount: number; publishedAt: string }> = [];
  let pageToken: string | undefined;
  // 1 quota unit per 100 comments — negligible against the 10k/day default.
  while (out.length < maxComments) {
    const url =
      `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&order=relevance` +
      `&videoId=${encodeURIComponent(platformPostId)}&maxResults=100` +
      (pageToken ? `&pageToken=${pageToken}` : "");
    const res = await ytFetch(url, token);
    if (!res.ok) {
      // 403 here usually means comments are disabled on the video — a real
      // state, not a failure.
      if (res.status === 403) return [];
      return out.length > 0 ? out : null;
    }
    for (const item of res.data?.items ?? []) {
      const top = item?.snippet?.topLevelComment?.snippet;
      if (!top?.textDisplay) continue;
      out.push({
        id: String(item.id),
        author: String(top.authorDisplayName ?? "").slice(0, 200),
        text: String(top.textOriginal ?? top.textDisplay).slice(0, 4000),
        likeCount: Number(top.likeCount) || 0,
        publishedAt: String(top.publishedAt ?? ""),
      });
      if (out.length >= maxComments) break;
    }
    pageToken = res.data?.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/**
 * Classify a batch of comments: sentiment, and whether the comment
 * references the placed product. Batched into one model call per ~40
 * comments to keep cost negligible.
 */
export async function classifyComments(
  comments: Array<{ id: number; text: string }>,
  productName: string | null,
): Promise<Map<number, { sentiment: string; mentionsBrand: boolean }>> {
  const out = new Map<number, { sentiment: string; mentionsBrand: boolean }>();
  if (comments.length === 0) return out;

  const { geminiGenerate } = await import("../scanner_v2");
  const BATCH = 40;
  for (let i = 0; i < comments.length; i += BATCH) {
    const batch = comments.slice(i, i + BATCH);
    const numbered = batch.map((c, n) => `${n}: ${c.text.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
    const productClause = productName
      ? `The video contains a placed product: "${productName}". Set mentions_brand true when the comment refers to that product, its brand, or to product placement/sponsorship in the video.`
      : `Set mentions_brand true when the comment refers to a product shown in the video, a brand, or to product placement/sponsorship.`;
    const prompt = `Classify each viewer comment on a video.

${productClause}

Return ONLY a JSON array, one object per comment, in the same order:
[{"i": 0, "sentiment": "positive|neutral|negative|mixed", "mentions_brand": true|false}]

Comments:
${numbered}`;

    try {
      const res: any = await geminiGenerate({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      const text = res?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const json = text.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        const idx = Number(entry?.i);
        const target = batch[idx];
        if (!target) continue;
        const sentiment = ["positive", "neutral", "negative", "mixed"].includes(entry?.sentiment)
          ? entry.sentiment
          : "neutral";
        out.set(target.id, { sentiment, mentionsBrand: entry?.mentions_brand === true });
      }
    } catch (err: any) {
      console.warn(`[AudienceResponse] Comment batch classification failed (non-fatal): ${err?.message}`);
    }
  }
  return out;
}

// ── The job ─────────────────────────────────────────────────────────────

export async function runAudienceResponseCapture(): Promise<{ days: number; comments: number; classified: number; skipped: number }> {
  let days = 0;
  let comments = 0;
  let classified = 0;
  let skipped = 0;

  const videoIds = await storage.getVideoIdsUnderMeasurement();
  if (videoIds.length === 0) {
    console.log("[AudienceResponse] No videos under measurement");
    return { days: 0, comments: 0, classified: 0, skipped: 0 };
  }

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
      if (platform !== "youtube" || !nativeId || nativeId.includes(":")) { skipped++; continue; }

      const userId = String((video as any).userId);
      if (!tokenCache.has(userId)) {
        tokenCache.set(userId, await getFreshYoutubeTokenForUser(userId).catch(() => null));
      }
      const token = tokenCache.get(userId);
      if (!token) { skipped++; continue; }

      // Per-day series, retroactive — 180 days covers any realistic
      // before/after window around a placement going live.
      const endDate = new Date().toISOString().slice(0, 10);
      const startDate = new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 10);
      const daily = await fetchDailyMetrics(nativeId, token, startDate, endDate);
      if (daily) {
        for (const d of daily) {
          await storage.upsertVideoDailyMetric({
            videoId: id,
            userId,
            platform: "youtube",
            platformPostId: nativeId,
            day: d.day,
            views: d.views,
            likes: d.likes,
            comments: d.comments,
            shares: d.shares,
            estimatedMinutesWatched: String(d.minutes),
            averageViewDuration: String(d.avgDuration),
          } as any);
          days++;
        }
      }

      // Comments — only for videos that actually carry a live placement,
      // since the question is about response to the integration.
      const exposure = await storage.getPlacementExposureForVideo(id).catch(() => undefined);
      if (exposure) {
        const fetched = await fetchComments(nativeId, token, 200);
        if (fetched && fetched.length > 0) {
          const liveAt = exposure.liveAt ? new Date(exposure.liveAt as any).getTime() : null;
          const rows = fetched.map((c) => ({
            videoId: id,
            userId,
            platform: "youtube",
            platformCommentId: c.id,
            authorDisplayName: c.author,
            text: c.text,
            likeCount: c.likeCount,
            publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
            afterPlacementLive:
              liveAt && c.publishedAt ? new Date(c.publishedAt).getTime() >= liveAt : null,
          }));
          comments += await storage.insertContentComments(rows as any);
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (err: any) {
      skipped++;
      console.warn(`[AudienceResponse] Video ${id} failed (non-fatal): ${err?.message}`);
    }
  }

  // Classify whatever is pending, in one pass.
  try {
    const pending = await storage.getUnclassifiedComments(200);
    if (pending.length > 0) {
      const verdicts = await classifyComments(
        pending.map((c) => ({ id: c.id, text: c.text })),
        null,
      );
      for (const [id, v] of Array.from(verdicts.entries())) {
        await storage.applyCommentClassification(id, v).catch(() => {});
        classified++;
      }
    }
  } catch (err: any) {
    console.warn(`[AudienceResponse] Classification pass failed (non-fatal): ${err?.message}`);
  }

  console.log(`[AudienceResponse] Cycle done: ${days} day-row(s), ${comments} new comment(s), ${classified} classified, ${skipped} skipped`);
  return { days, comments, classified, skipped };
}

const CYCLE_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 15 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startAudienceResponseJob(): void {
  if (timer) return;
  setTimeout(() => {
    runAudienceResponseCapture().catch((err) =>
      console.warn("[AudienceResponse] Initial run failed (non-fatal):", err?.message));
  }, FIRST_RUN_DELAY_MS);
  timer = setInterval(() => {
    runAudienceResponseCapture().catch((err) =>
      console.warn("[AudienceResponse] Cycle failed (non-fatal):", err?.message));
  }, CYCLE_MS);
  timer.unref?.();
  console.log(`[AudienceResponse] Capture job started (daily, first run in ${FIRST_RUN_DELAY_MS / 60000}min)`);
}
