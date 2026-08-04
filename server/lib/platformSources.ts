/**
 * Registry-lite for yt-dlp-capable video platforms (Twitch, TikTok,
 * Twitter/X — and YouTube URL parsing for the paste-to-import route).
 *
 * Conventions (matching the existing Instagram/Facebook pattern):
 * - `video_index.platform` holds the canonical platform name.
 * - `video_index.youtube_id` holds `<platform>:<nativeId>` for non-YouTube
 *   platforms; the nativeId round-trips to a watch URL via sourceUrlFor().
 * - Acquisition for these platforms is yt-dlp end-to-end (stream resolve
 *   via -g, download via the existing ladder with a sourceUrl override) —
 *   no per-platform API, no OAuth needed for public posts.
 */

export interface ParsedPlatformUrl {
  platform: "youtube" | "twitch" | "tiktok" | "twitter";
  /** Platform-native id; for prefixed platforms this goes after "<platform>:" */
  nativeId: string;
  /** Canonical watch URL rebuilt from the id */
  sourceUrl: string;
}

interface PlatformDef {
  patterns: Array<{ re: RegExp; toId: (m: RegExpMatchArray) => string }>;
  buildUrl: (nativeId: string) => string;
  /** v1 gate: reject imports longer than this at scan time (Twitch VODs) */
  maxDurationSec?: number;
}

const DEFS: Record<"twitch" | "tiktok" | "twitter", PlatformDef> = {
  twitch: {
    patterns: [
      { re: /(?:^|\/\/)(?:www\.|m\.)?twitch\.tv\/videos\/(\d+)/i, toId: (m) => `videos/${m[1]}` },
      { re: /(?:^|\/\/)clips\.twitch\.tv\/([A-Za-z0-9_-]+)/i, toId: (m) => `clip/${m[1]}` },
      { re: /(?:^|\/\/)(?:www\.|m\.)?twitch\.tv\/[^/]+\/clip\/([A-Za-z0-9_-]+)/i, toId: (m) => `clip/${m[1]}` },
    ],
    buildUrl: (id) =>
      id.startsWith("clip/")
        ? `https://clips.twitch.tv/${id.slice(5)}`
        : `https://www.twitch.tv/${id}`,
    // Twitch VODs are HLS-only and often multi-hour; the light-cloud model
    // can't absorb a 4h pull on shared /tmp. Clips + ≤1hr VODs for v1.
    maxDurationSec: 3600,
  },
  tiktok: {
    patterns: [
      { re: /(?:^|\/\/)(?:www\.|m\.)?tiktok\.com\/(@[^/?#]+\/video\/\d+)/i, toId: (m) => m[1] },
      // Share-sheet short links: vm./vt. hosts and the /t/ path form.
      // yt-dlp follows the redirect, so the code round-trips fine.
      { re: /(?:^|\/\/)(?:vm|vt)\.tiktok\.com\/([A-Za-z0-9]+)/i, toId: (m) => `vm/${m[1]}` },
      { re: /(?:^|\/\/)(?:www\.)?tiktok\.com\/t\/([A-Za-z0-9]+)/i, toId: (m) => `t/${m[1]}` },
    ],
    buildUrl: (id) =>
      id.startsWith("vm/")
        ? `https://vm.tiktok.com/${id.slice(3)}`
        : id.startsWith("t/")
        ? `https://www.tiktok.com/${id}`
        : `https://www.tiktok.com/${id}`,
  },
  twitter: {
    patterns: [
      // Notification-email form first (more specific), then profile links.
      { re: /(?:^|\/\/)(?:www\.|mobile\.)?(?:x|twitter)\.com\/(i\/web\/status\/\d+)/i, toId: (m) => m[1] },
      { re: /(?:^|\/\/)(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]+\/status\/\d+)/i, toId: (m) => m[1] },
    ],
    buildUrl: (id) => `https://x.com/${id}`,
  },
};

const YOUTUBE_PATTERNS: RegExp[] = [
  /(?:^|\/\/)(?:www\.|m\.)?youtube\.com\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})/i,
  /(?:^|\/\/)youtu\.be\/([A-Za-z0-9_-]{11})/i,
  /(?:^|\/\/)(?:www\.)?youtube\.com\/(?:shorts|live)\/([A-Za-z0-9_-]{11})/i,
];

/** Parse a pasted URL into platform + native id. Null = unrecognized. */
export function parsePlatformUrl(rawUrl: string): ParsedPlatformUrl | null {
  const url = String(rawUrl ?? "").trim();
  if (!url || url.length > 2048) return null;
  for (const re of YOUTUBE_PATTERNS) {
    const m = url.match(re);
    if (m) return { platform: "youtube", nativeId: m[1], sourceUrl: `https://www.youtube.com/watch?v=${m[1]}` };
  }
  for (const [platform, def] of Object.entries(DEFS) as Array<["twitch" | "tiktok" | "twitter", PlatformDef]>) {
    for (const { re, toId } of def.patterns) {
      const m = url.match(re);
      if (m) {
        const nativeId = toId(m);
        return { platform, nativeId, sourceUrl: def.buildUrl(nativeId) };
      }
    }
  }
  return null;
}

/** Platforms whose whole acquisition path is generic yt-dlp. */
export function isYtDlpPlatform(platform: string | null | undefined): platform is "twitch" | "tiktok" | "twitter" {
  return platform === "twitch" || platform === "tiktok" || platform === "twitter";
}

/** Stored id ("twitch:videos/123") → watch URL, or null if malformed. */
export function sourceUrlForStoredId(platform: string, storedId: string): string | null {
  if (!isYtDlpPlatform(platform)) return null;
  const prefix = `${platform}:`;
  const nativeId = storedId.startsWith(prefix) ? storedId.slice(prefix.length) : storedId;
  if (!nativeId) return null;
  return DEFS[platform].buildUrl(nativeId);
}

export function storedIdFor(platform: string, nativeId: string): string {
  return platform === "youtube" ? nativeId : `${platform}:${nativeId}`;
}

/** Scan-time duration gate for the platform (null = no gate). */
export function platformMaxDurationSec(platform: string): number | null {
  return isYtDlpPlatform(platform) ? DEFS[platform].maxDurationSec ?? null : null;
}

/**
 * Recover the PLATFORM-NATIVE id a metrics API expects from our stored id.
 *
 * This is the primitive the measurement spine was missing. Our stored form
 * ("twitch:videos/123", "tiktok:@user/video/7312…") is built for round-
 * tripping to a watch URL; every platform's metrics API wants something
 * narrower, and each wants a different shape:
 *   - Twitch: numeric VOD id → /helix/videos, clip slug → /helix/clips
 *     (different endpoints, so the kind must be carried, not just the id)
 *   - TikTok Display API: the bare numeric video id
 *   - X v2: the bare numeric tweet id
 *
 * Returns an explicit `unresolvable` kind rather than null so callers can
 * report WHY a video has no metrics instead of silently skipping it. The
 * TikTok short-link forms (vm./t.) genuinely carry no numeric id — they
 * only resolve by following a redirect, which we don't persist at import.
 */
export type NativeMetricsId =
  | { kind: "youtube_video"; id: string }
  | { kind: "twitch_video"; id: string }
  | { kind: "twitch_clip"; id: string }
  | { kind: "tiktok_video"; id: string }
  | { kind: "x_tweet"; id: string }
  | { kind: "unresolvable"; reason: string };

export function nativeIdForStoredId(platform: string, storedId: string): NativeMetricsId {
  const raw = String(storedId ?? "").trim();
  if (!raw) return { kind: "unresolvable", reason: "empty id" };

  if (platform === "youtube") {
    return raw.includes(":")
      ? { kind: "unresolvable", reason: "not a bare YouTube id" }
      : { kind: "youtube_video", id: raw };
  }

  const prefix = `${platform}:`;
  const native = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;

  if (platform === "twitch") {
    if (native.startsWith("clip/")) return { kind: "twitch_clip", id: native.slice(5) };
    const m = native.match(/^videos\/(\d+)$/);
    if (m) return { kind: "twitch_video", id: m[1] };
    return { kind: "unresolvable", reason: `unrecognized Twitch id form "${native}"` };
  }

  if (platform === "tiktok") {
    const m = native.match(/\/video\/(\d+)/);
    if (m) return { kind: "tiktok_video", id: m[1] };
    if (native.startsWith("vm/") || native.startsWith("t/")) {
      return {
        kind: "unresolvable",
        reason: "TikTok share-link import (vm./t.) carries no numeric video id — re-import from the full @user/video/… URL to enable metrics",
      };
    }
    return { kind: "unresolvable", reason: `unrecognized TikTok id form "${native}"` };
  }

  if (platform === "twitter") {
    const m = native.match(/status\/(\d+)/);
    if (m) return { kind: "x_tweet", id: m[1] };
    return { kind: "unresolvable", reason: `unrecognized X id form "${native}"` };
  }

  return { kind: "unresolvable", reason: `no metrics fetcher for platform "${platform}"` };
}

/** Stored ids can contain "/" (tiktok @user/video/123) — never use them raw
 *  as filenames. */
export function safeFileStem(storedId: string): string {
  return storedId.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120);
}
