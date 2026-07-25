/**
 * Stream-URL resolution for OAuth-based, download-free scanning.
 *
 * The scanner's job is to sample a handful of frames from a creator's video and
 * run surface detection on them. It does NOT need the whole file on disk. This
 * module resolves a direct, seekable CDN URL for a video via the creator's
 * OAuth credentials, so ffmpeg can HTTP-range-seek into it and pull only the
 * frames we sample — no full download, no upload, nothing persisted.
 *
 *   - YouTube: `yt-dlp -g` resolves the direct googlevideo CDN URL using the
 *     creator's stored OAuth token (bypasses datacenter bot-detection). The URL
 *     is a time-limited (~6h) progressive/http stream that supports range
 *     requests, which is exactly what ffmpeg needs to seek.
 *   - Instagram/Facebook: the Graph API returns `media_url` / `source` — already
 *     a direct CDN mp4 — for the creator's own Business/Creator media.
 *
 * All returned URLs are seekable http(s). The caller feeds them straight to
 * ffmpeg with `-ss <t> -i <url>`.
 */

import { spawn } from "child_process";
import { getYtDlpPath } from "./ytDlpUpdater";
import { applyYtDlpAuthArgs, YT_MOBILE_SAFARI_USER_AGENT } from "./scanner";

export interface StreamSource {
  url: string;
  /** Headers ffmpeg should send when fetching the URL (e.g. matching User-Agent). */
  headers?: Record<string, string>;
}

/**
 * Resolve a direct, seekable CDN URL for a YouTube video WITHOUT downloading it.
 * Prefers a progressive/http mp4 ≤720p (video-only is fine — frame extraction
 * needs no audio, and lower resolution is plenty for surface detection while
 * keeping per-frame range reads small).
 */
export async function resolveYoutubeStreamUrl(
  youtubeId: string,
  oauthToken?: string,
): Promise<StreamSource | null> {
  const ytDlpBin = await getYtDlpPath();
  return new Promise((resolve) => {
    const args = [
      "-g", // print direct URL(s), do not download
      // Prefer a single seekable progressive https stream ≤720p. Format 18 is
      // the classic 360p progressive mp4 that's almost always present and
      // trivially seekable; fall back through higher-res / any best.
      "-f",
        "bv*[height<=720][ext=mp4][protocol^=https]/" +
        "b[height<=720][ext=mp4][protocol^=https]/" +
        "18/" +
        "best[ext=mp4]/" +
        "best",
      "--no-playlist",
      "--no-warnings",
      "--no-check-certificate",
      "--extractor-args", "youtube:player_client=tv_embedded,mweb,web_safari,android_vr",
      "--user-agent", YT_MOBILE_SAFARI_USER_AGENT,
    ];
    if (oauthToken) {
      args.push("--add-header", `Authorization:Bearer ${oauthToken}`);
    }
    applyYtDlpAuthArgs(args, "stream-url resolve"); // cookies/proxy from env
    args.push(`https://www.youtube.com/watch?v=${youtubeId}`);

    let stdout = "";
    let stderr = "";
    const proc = spawn(ytDlpBin, args);
    const tm = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      console.warn(`[StreamResolver] yt-dlp -g timed out for ${youtubeId}`);
      resolve(null);
    }, 45_000);
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      clearTimeout(tm);
      if (code !== 0) {
        console.warn(`[StreamResolver] yt-dlp -g failed (${code}) for ${youtubeId}: ${stderr.slice(-200)}`);
        return resolve(null);
      }
      // -g prints one URL per selected stream (a merged selector prints video
      // then audio). We only need video, so take the first line.
      const urls = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (urls.length === 0) {
        console.warn(`[StreamResolver] yt-dlp -g returned no URL for ${youtubeId}`);
        return resolve(null);
      }
      console.log(`[StreamResolver] Resolved YouTube stream URL for ${youtubeId} (${urls.length} stream(s))`);
      resolve({ url: urls[0], headers: { "User-Agent": YT_MOBILE_SAFARI_USER_AGENT } });
    });
    proc.on("error", (err) => {
      clearTimeout(tm);
      console.warn(`[StreamResolver] yt-dlp spawn error for ${youtubeId}: ${err.message}`);
      resolve(null);
    });
  });
}

/**
 * Resolve a direct CDN URL for an Instagram or Facebook video via the Graph API
 * using the creator's Page/User access token. IG exposes `media_url`; FB Pages
 * expose `source`. Both are seekable CDN mp4s for the creator's own media.
 */
export async function resolveGraphStreamUrl(
  mediaId: string,
  platform: "instagram" | "facebook",
  token: string,
): Promise<StreamSource | null> {
  const id = mediaId.replace(/^(instagram|facebook):/, "");
  const field = platform === "facebook" ? "source" : "media_url";
  const url = `https://graph.facebook.com/v25.0/${id}?fields=${field},media_type&access_token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    if (data?.error) {
      console.warn(`[StreamResolver] Graph API error for ${platform} ${id}: ${data.error.message}`);
      return null;
    }
    const cdn = data[field] || data.media_url || data.source;
    if (!cdn) {
      console.warn(`[StreamResolver] ${platform} ${id} has no ${field} (media_type: ${data.media_type || "unknown"})`);
      return null;
    }
    console.log(`[StreamResolver] Resolved ${platform} stream URL for ${id}`);
    return { url: cdn };
  } catch (e: any) {
    console.warn(`[StreamResolver] ${platform} resolve failed for ${id}: ${e.message}`);
    return null;
  }
}
