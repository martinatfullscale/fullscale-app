/**
 * Stream-URL resolution for OAuth-based, download-free scanning.
 *
 * The scanner's job is to sample a handful of frames from a creator's video and
 * run surface detection on them. It does NOT need the whole file on disk. This
 * module resolves a direct, seekable CDN URL for a video via the creator's
 * OAuth credentials, so ffmpeg can HTTP-range-seek into it and pull only the
 * frames we sample — no full download, no upload, nothing persisted.
 *
 *   - YouTube: `yt-dlp -g` resolves the direct googlevideo CDN URL, anonymous
 *     first with the creator's stored OAuth token as fallback. The URL is a
 *     time-limited (~6h) progressive/http stream that supports range requests,
 *     which is exactly what ffmpeg needs to seek.
 *   - Instagram/Facebook: the Graph API returns `media_url` / `source` — already
 *     a direct CDN mp4 — for the creator's own Business/Creator media.
 *
 * All returned URLs are seekable http(s). The caller feeds them straight to
 * ffmpeg with `-ss <t> -i <url>` (plus `-http_proxy` when `httpProxy` is set).
 */

import { spawn } from "child_process";
import { getYtDlpPath } from "./ytDlpUpdater";
import { applyYtDlpAuthArgs, YT_MOBILE_SAFARI_USER_AGENT } from "./scanner";

export interface StreamSource {
  url: string;
  /** Headers ffmpeg should send when fetching the URL (e.g. matching User-Agent). */
  headers?: Record<string, string>;
  /**
   * http(s) proxy the URL was resolved through. googlevideo URLs are locked to
   * the IP that resolved them, so when yt-dlp went through YTDLP_PROXY, ffmpeg
   * must fetch through the same egress (`-http_proxy <value>` before `-i`) or
   * every range read 403s from our own IP.
   */
  httpProxy?: string;
}

/**
 * Resolve a direct, seekable CDN URL for a YouTube video WITHOUT downloading it.
 * Prefers a progressive/http mp4 ≤720p (video-only is fine — frame extraction
 * needs no audio, and lower resolution is plenty for surface detection while
 * keeping per-frame range reads small). Resolves anonymously first, retrying
 * with the OAuth bearer only if the anonymous attempt fails.
 */
export async function resolveYoutubeStreamUrl(
  youtubeId: string,
  oauthToken?: string,
): Promise<StreamSource | null> {
  // When YTDLP_PROXY is set, applyYtDlpAuthArgs routes the resolve through it
  // and the googlevideo URL comes back locked to the proxy's egress IP — so
  // ffmpeg must fetch through the same proxy. ffmpeg only tunnels via http(s)
  // CONNECT; a socks:// proxy would make every resolved URL unreachable from
  // ffmpeg, so skip the stream path entirely (before spending a yt-dlp
  // round-trip against YouTube) and let the download ladder handle it — yt-dlp
  // speaks socks natively there.
  const proxy = process.env.YTDLP_PROXY?.trim() || undefined;
  if (proxy && !/^https?:\/\//i.test(proxy)) {
    console.warn(
      `[StreamResolver] YTDLP_PROXY is ${proxy.split("://")[0]}:// — ffmpeg can only tunnel http(s) proxies, ` +
      `so a proxy-locked stream URL would be unreachable; skipping stream resolve for ${youtubeId} (download ladder handles socks)`,
    );
    return null;
  }

  const ytDlpBin = await getYtDlpPath();

  const runResolve = (useToken: boolean): Promise<string | null> =>
    new Promise((resolve) => {
      const args = [
        "-g", // print direct URL(s), do not download
        // Prefer a single seekable progressive https stream ≤720p. Format 18 is
        // the classic 360p progressive mp4 that's almost always present and
        // trivially seekable (inherently progressive https). Every rung keeps
        // the https-progressive constraint: YouTube HLS formats also list as
        // ext=mp4, and an .m3u8 manifest turns ffmpeg's dense pass into
        // hundreds of per-segment fetches where the -reconnect flags don't
        // apply (segment 403 → partial grid). Better to fail the resolve and
        // let the download ladder take HLS-only videos — it has an explicit
        // HLS fallback (see the Boris Kodjoe war story in scanner.ts).
        "-f",
          "bv*[height<=720][ext=mp4][protocol^=https]/" +
          "b[height<=720][ext=mp4][protocol^=https]/" +
          "18/" +
          "best[ext=mp4][protocol^=https]/" +
          "b[protocol^=https]",
        "--no-playlist",
        "--no-warnings",
        "--extractor-args", "youtube:player_client=tv_embedded,mweb,web_safari,android_vr",
        "--user-agent", YT_MOBILE_SAFARI_USER_AGENT,
      ];
      // TLS verification stays ON unless explicitly opted out: this process
      // sends the cookie jar and (on retry) the creator's bearer token, and
      // with a proxy in the path an unverified TLS hop is exactly where those
      // would leak.
      if (process.env.YTDLP_INSECURE_TLS === "1") {
        args.push("--no-check-certificate");
      }
      if (useToken && oauthToken) {
        args.push("--add-header", `Authorization:Bearer ${oauthToken}`);
      }
      applyYtDlpAuthArgs(args, "stream-url resolve"); // cookies/proxy from env
      args.push(`https://www.youtube.com/watch?v=${youtubeId}`);

      let stdout = "";
      let stderr = "";
      // detached: own process group, so the timeout kill takes the real
      // Python child forked by the PyInstaller onefile bootloader with it
      // (SIGKILL to the bootloader alone is unforwardable).
      const proc = spawn(ytDlpBin, args, { detached: true });
      const tm = setTimeout(() => {
        try {
          if (proc.pid) process.kill(-proc.pid, "SIGKILL");
          else proc.kill("SIGKILL");
        } catch {
          try { proc.kill("SIGKILL"); } catch {}
        }
        console.warn(`[StreamResolver] yt-dlp -g${useToken ? " [OAuth]" : ""} timed out for ${youtubeId}`);
        resolve(null);
      }, 45_000);
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        clearTimeout(tm);
        if (code !== 0) {
          console.warn(`[StreamResolver] yt-dlp -g${useToken ? " [OAuth]" : ""} failed (${code}) for ${youtubeId}: ${stderr.slice(-200)}`);
          return resolve(null);
        }
        // -g prints one URL per selected stream (a merged selector prints video
        // then audio). We only need video, so take the first line.
        const urls = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        if (urls.length === 0) {
          console.warn(`[StreamResolver] yt-dlp -g returned no URL for ${youtubeId}`);
          return resolve(null);
        }
        // Belt-and-suspenders on top of the https-progressive selector: if a
        // manifest URL slipped through anyway, reject it — ffmpeg's per-segment
        // fetches have none of our reconnect resilience and a mid-grid segment
        // 403 silently yields a thin scan.
        if (urls[0].includes(".m3u8") || urls[0].includes("/manifest/")) {
          console.warn(`[StreamResolver] Resolved URL for ${youtubeId} is an HLS/DASH manifest; rejecting so the download ladder handles it`);
          return resolve(null);
        }
        console.log(`[StreamResolver] Resolved YouTube stream URL for ${youtubeId}${useToken ? " [OAuth]" : ""} (${urls.length} stream(s))`);
        resolve(urls[0]);
      });
      proc.on("error", (err) => {
        clearTimeout(tm);
        console.warn(`[StreamResolver] yt-dlp spawn error for ${youtubeId}: ${err.message}`);
        resolve(null);
      });
    });

  // Anonymous first, OAuth as fallback — same ordering as downloadVideo's
  // cascade and the duration probe (flipped 2026-06-11): requests carrying the
  // creator's bearer token got a DEGRADED format list ("Requested format is
  // not available", video 1AQcoTanaYg) while the identical anonymous request
  // succeeded. Two attempts max keeps the resolve wall-clock bounded.
  let url = await runResolve(false);
  if (url === null && oauthToken) {
    url = await runResolve(true);
  }
  if (url === null) return null;

  // Cheap 1-byte validation before handing the URL to ffmpeg: googlevideo URLs
  // can resolve fine yet still 403 on fetch (stale token, bot-scored egress).
  // Catching that here costs one ranged GET instead of a doomed ffmpeg pass.
  // Skipped when a proxy is in play — the URL is IP-locked to the proxy
  // egress, so a direct fetch from this process would 403 even when the URL
  // is perfectly usable through the proxy.
  if (!proxy) {
    try {
      const probe = await fetch(url, {
        headers: {
          "User-Agent": YT_MOBILE_SAFARI_USER_AGENT,
          "Range": "bytes=0-0",
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!probe.ok) {
        console.warn(`[StreamResolver] Resolved URL for ${youtubeId} failed validation (HTTP ${probe.status}); falling back to download ladder`);
        return null;
      }
      // Cancel rather than consume: if the CDN ignored the Range header and
      // sent a 200, consuming would buffer the whole video.
      try { await probe.body?.cancel(); } catch {}
    } catch (e: any) {
      console.warn(`[StreamResolver] Resolved URL validation for ${youtubeId} errored: ${e.message}; falling back to download ladder`);
      return null;
    }
  }

  return {
    url,
    headers: { "User-Agent": YT_MOBILE_SAFARI_USER_AGENT },
    ...(proxy ? { httpProxy: proxy } : {}),
  };
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
    // Hard 15s cap (vs the YouTube resolve's 45s): a Graph tarpit that sends
    // headers then dribbles body bytes would otherwise stall r.json() forever,
    // pinning the scan's single-flight lock until a process restart.
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
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
