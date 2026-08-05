/**
 * Per-post metrics for the non-YouTube platforms — the outcome side of the
 * measurement spine for Twitch, TikTok and X.
 *
 * Each platform reaches a different distance, and the differences are real
 * rather than incidental, so the result type carries a REASON when a metric
 * can't be fetched. A silent zero in a research dataset is worse than a gap:
 * a gap gets excluded, a zero gets modeled.
 *
 *   TWITCH  — works with no creator OAuth at all. Helix returns view_count
 *             for public VODs and clips against an APP token
 *             (client_credentials on TWITCH_CLIENT_ID/SECRET). Views only:
 *             no likes, no comments, no retention. Note VOD view counts are
 *             lifetime counters that Twitch expires with the VOD itself
 *             (14/60 days by account tier) — clips are the durable series.
 *
 *   X       — scopes (tweet.read) and the public_metrics shape already exist;
 *             needs the creator to have completed the distribution OAuth AND
 *             an API tier that permits the read. Returns a distinguishable
 *             reason when either is missing.
 *
 *   TIKTOK  — Display API video/query returns view/like/comment/share, but
 *             requires the `video.list` scope AND ownership of the video.
 *             URL-paste import does not establish ownership, so this only
 *             ever works for a connected creator's own posts.
 */

import { storage } from "../storage";
import { nativeIdForStoredId, type NativeMetricsId } from "./platformSources";

export interface PlatformMetrics {
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  platformPostId: string;
  raw: any;
}

export type MetricsResult =
  | { ok: true; metrics: PlatformMetrics }
  | { ok: false; reason: string; needs?: "credentials" | "creator_oauth" | "api_tier" | "reimport" };

// ── Twitch: app access token (client_credentials), cached ───────────────

let twitchAppToken: { token: string; expiresAt: number } | null = null;

export async function getTwitchAppToken(): Promise<string | null> {
  const id = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (twitchAppToken && twitchAppToken.expiresAt > Date.now() + 60_000) return twitchAppToken.token;
  try {
    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[PlatformMetrics] Twitch app token failed (${res.status})`);
      return null;
    }
    const data: any = await res.json();
    if (!data?.access_token) return null;
    twitchAppToken = {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(60, Number(data.expires_in ?? 3600)) * 1000,
    };
    return twitchAppToken.token;
  } catch (err: any) {
    console.warn(`[PlatformMetrics] Twitch app token error: ${err?.message}`);
    return null;
  }
}

async function fetchTwitch(native: NativeMetricsId): Promise<MetricsResult> {
  if (native.kind !== "twitch_video" && native.kind !== "twitch_clip") {
    return { ok: false, reason: "not a Twitch id" };
  }
  const token = await getTwitchAppToken();
  if (!token) {
    return {
      ok: false,
      reason: "TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not configured — Twitch metrics need an app token (no creator OAuth required)",
      needs: "credentials",
    };
  }
  const isClip = native.kind === "twitch_clip";
  const url = isClip
    ? `https://api.twitch.tv/helix/clips?id=${encodeURIComponent(native.id)}`
    : `https://api.twitch.tv/helix/videos?id=${encodeURIComponent(native.id)}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": process.env.TWITCH_CLIENT_ID! },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { ok: false, reason: `Twitch Helix ${res.status}` };
    }
    const data: any = await res.json();
    const item = data?.data?.[0];
    if (!item) {
      return {
        ok: false,
        // Twitch expires VODs by account tier; the row is gone, not zero.
        reason: isClip
          ? "clip not found (deleted or unlisted)"
          : "VOD not found — Twitch expires VODs after the retention window (14/60 days by tier)",
      };
    }
    return {
      ok: true,
      metrics: {
        viewCount: typeof item.view_count === "number" ? item.view_count : Number(item.view_count) || null,
        likeCount: null,        // Helix exposes none of these
        commentCount: null,
        shareCount: null,
        platformPostId: native.id,
        raw: item,
      },
    };
  } catch (err: any) {
    return { ok: false, reason: `Twitch request failed: ${err?.message}` };
  }
}

// ── X / TikTok: creator tokens live on distribution_profiles ────────────

async function resolveDistributionToken(
  userId: string,
  platform: "tiktok" | "twitter",
): Promise<{ token: string | null; reason?: string }> {
  const label = platform === "twitter" ? "X" : "TikTok";
  try {
    const { stableUserIntId } = await import("./stableUserId");
    const { resolvePublishAccessToken } = await import("./distribution/platformPublisher");
    // distribution_profiles keys users by a stable INT derived from the
    // varchar id the rest of the app uses — a real id-space seam.
    const intId = stableUserIntId(userId);
    const profiles = await storage.getDistributionProfiles(intId).catch(() => []);
    const profile = profiles.find((p: any) => p.platform === platform);
    if (!profile) {
      return { token: null, reason: `creator has not connected ${label} (distribution OAuth) — metrics need their token` };
    }
    // Goes through the publisher's resolver so a rotated/expired token is
    // refreshed rather than silently failing the call.
    const token = await resolvePublishAccessToken(profile as any).catch(() => null);
    if (!token) {
      return { token: null, reason: `${label} token could not be refreshed — the creator needs to reconnect` };
    }
    return { token };
  } catch (err: any) {
    return { token: null, reason: `token resolution failed: ${err?.message}` };
  }
}

async function fetchX(native: NativeMetricsId, userId: string): Promise<MetricsResult> {
  if (native.kind !== "x_tweet") return { ok: false, reason: "not an X id" };
  const { token, reason } = await resolveDistributionToken(userId, "twitter");
  if (!token) return { ok: false, reason: reason!, needs: "creator_oauth" };
  try {
    const res = await fetch(
      `https://api.twitter.com/2/tweets/${encodeURIComponent(native.id)}?tweet.fields=public_metrics,created_at`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (res.status === 403 || res.status === 429) {
      return {
        ok: false,
        // X gates read access behind paid tiers; this is a billing state,
        // not a bug, and should read that way in the ops surface.
        reason: `X API returned ${res.status} — read access requires a paid API tier`,
        needs: "api_tier",
      };
    }
    if (!res.ok) return { ok: false, reason: `X API ${res.status}` };
    const data: any = await res.json();
    const m = data?.data?.public_metrics;
    if (!m) return { ok: false, reason: "no public_metrics on the response" };
    return {
      ok: true,
      metrics: {
        viewCount: typeof m.impression_count === "number" ? m.impression_count : null,
        likeCount: typeof m.like_count === "number" ? m.like_count : null,
        commentCount: typeof m.reply_count === "number" ? m.reply_count : null,
        shareCount: typeof m.retweet_count === "number" ? m.retweet_count : null,
        platformPostId: native.id,
        raw: data.data,
      },
    };
  } catch (err: any) {
    return { ok: false, reason: `X request failed: ${err?.message}` };
  }
}

async function fetchTikTok(native: NativeMetricsId, userId: string): Promise<MetricsResult> {
  if (native.kind !== "tiktok_video") return { ok: false, reason: "not a TikTok id" };
  const { token, reason } = await resolveDistributionToken(userId, "tiktok");
  if (!token) return { ok: false, reason: reason!, needs: "creator_oauth" };
  try {
    // Display API. NOTE: queries by VIDEO id — deliberately not the
    // publish_id the distribution publisher stores, which is a different
    // identifier and the source of an existing bug in that path.
    const res = await fetch(
      "https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ filters: { video_ids: [native.id] } }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reason: "TikTok returned 401/403 — the connect flow requests publish scopes only; metrics need `video.list` and the creator must own the video",
        needs: "creator_oauth",
      };
    }
    if (!res.ok) return { ok: false, reason: `TikTok API ${res.status}` };
    const data: any = await res.json();
    const v = data?.data?.videos?.[0];
    if (!v) return { ok: false, reason: "video not returned — not owned by the connected account, or removed" };
    return {
      ok: true,
      metrics: {
        viewCount: typeof v.view_count === "number" ? v.view_count : null,
        likeCount: typeof v.like_count === "number" ? v.like_count : null,
        commentCount: typeof v.comment_count === "number" ? v.comment_count : null,
        shareCount: typeof v.share_count === "number" ? v.share_count : null,
        platformPostId: native.id,
        raw: v,
      },
    };
  } catch (err: any) {
    return { ok: false, reason: `TikTok request failed: ${err?.message}` };
  }
}

/**
 * Metrics for one imported video, dispatched by platform. YouTube is handled
 * by its own batched path (videos.list takes 50 ids per call) and is not
 * routed here.
 */
export async function fetchPlatformMetrics(
  platform: string,
  storedId: string,
  userId: string,
): Promise<MetricsResult> {
  const native = nativeIdForStoredId(platform, storedId);
  if (native.kind === "unresolvable") {
    return { ok: false, reason: native.reason, needs: native.reason.includes("share-link") ? "reimport" : undefined };
  }
  switch (native.kind) {
    case "twitch_video":
    case "twitch_clip":
      return fetchTwitch(native);
    case "x_tweet":
      return fetchX(native, userId);
    case "tiktok_video":
      return fetchTikTok(native, userId);
    default:
      return { ok: false, reason: `no fetcher for ${native.kind}` };
  }
}

/** Which platforms can currently produce metrics, and what's missing where
 *  they can't. Powers the ops surface so a dark platform explains itself. */
export async function platformMetricsCapability(): Promise<
  Array<{ platform: string; ready: boolean; detail: string }>
> {
  const twitchToken = await getTwitchAppToken();
  return [
    {
      platform: "youtube",
      ready: true,
      detail: "Views, retention curves and per-video demographics via the creator's connected channel",
    },
    {
      platform: "twitch",
      ready: !!twitchToken,
      detail: twitchToken
        ? "View counts for public VODs and clips (app token — no creator OAuth needed). No likes/comments/retention. VOD counts expire with the VOD."
        : "Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET — no creator OAuth is required beyond that",
    },
    {
      platform: "tiktok",
      ready: false,
      detail: "Needs the `video.list` scope added to the TikTok connect flow (currently publish-only), creator re-authorization, and creator ownership of the video",
    },
    {
      platform: "twitter",
      ready: false,
      detail: "Scopes and fetcher exist; needs the creator connected via X OAuth and a paid X API tier for read access",
    },
  ];
}
