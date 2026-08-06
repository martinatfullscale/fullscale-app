/**
 * Stock b-roll search, via Pexels.
 *
 * Uploading your own b-roll is the wrong default for a clip editor: the whole
 * point of a b-roll cut is that it is generic filler over a talking head, and
 * asking a creator to go shoot "person typing at a desk" defeats it. Pexels'
 * library is free, licensed for commercial use with no attribution required,
 * and searchable — which is what makes the feature usable rather than
 * theoretical.
 *
 * A chosen clip is DOWNLOADED into media_assets rather than referenced by URL.
 * The render pipeline needs a local file for ffmpeg, and a hotlinked CDN URL
 * would also mean a clip's b-roll could silently change or 404 under it later.
 * Owning the bytes is the only version that reproduces.
 */

export interface StockVideo {
  id: number;
  /** Pexels page — shown so a creator can check licence/attribution. */
  pageUrl: string;
  /** Best-fit downloadable file for our use (720p-ish, mp4). */
  fileUrl: string;
  previewUrl: string;   // poster image
  durationSec: number;
  width: number;
  height: number;
  photographer: string;
}

const PEXELS_API = "https://api.pexels.com/videos/search";

export function stockSearchAvailable(): boolean {
  return !!process.env.PEXELS_API_KEY;
}

/**
 * Pick the file we actually want from Pexels' variant list.
 *
 * Their `video_files` array mixes resolutions and codecs. We want the
 * smallest mp4 that is still at least 720p on its short edge: b-roll is
 * composited under a 1080x1920 crop, so a 4K source costs download time and
 * decode time for pixels the output never keeps.
 */
function pickFile(files: any[]): any | null {
  const mp4s = (files ?? []).filter((f) => String(f?.file_type ?? "").includes("mp4") && f?.link);
  if (mp4s.length === 0) return null;
  const shortEdge = (f: any) => Math.min(Number(f.width) || 0, Number(f.height) || 0);
  const goodEnough = mp4s.filter((f) => shortEdge(f) >= 720).sort((a, b) => shortEdge(a) - shortEdge(b));
  if (goodEnough.length > 0) return goodEnough[0];
  // Nothing at 720p — take the largest available rather than nothing.
  return mp4s.sort((a, b) => shortEdge(b) - shortEdge(a))[0];
}

export async function searchStockVideos(
  query: string,
  opts: { perPage?: number; orientation?: "portrait" | "landscape" } = {},
): Promise<{ videos: StockVideo[] } | { error: string; needsKey?: boolean }> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) {
    return {
      error: "Stock search needs a PEXELS_API_KEY. It's free at pexels.com/api — add it to the environment and this starts working.",
      needsKey: true,
    };
  }
  const q = String(query ?? "").trim();
  if (!q) return { videos: [] };

  const params = new URLSearchParams({
    query: q.slice(0, 100),
    per_page: String(Math.min(24, Math.max(1, opts.perPage ?? 12))),
  });
  // Vertical clips want vertical b-roll; a landscape plate letterboxes badly
  // inside a 9:16 frame.
  if (opts.orientation) params.set("orientation", opts.orientation);

  try {
    const res = await fetch(`${PEXELS_API}?${params}`, {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) return { error: "Pexels rejected the API key — check PEXELS_API_KEY." };
    if (res.status === 429) return { error: "Pexels rate limit reached — try again in a minute." };
    if (!res.ok) return { error: `Pexels search failed (${res.status})` };

    const data: any = await res.json();
    const videos: StockVideo[] = [];
    for (const v of data?.videos ?? []) {
      const file = pickFile(v.video_files);
      if (!file) continue;
      videos.push({
        id: Number(v.id),
        pageUrl: String(v.url ?? ""),
        fileUrl: String(file.link),
        previewUrl: String(v.image ?? ""),
        durationSec: Number(v.duration) || 0,
        width: Number(file.width) || 0,
        height: Number(file.height) || 0,
        photographer: String(v.user?.name ?? "Pexels"),
      });
    }
    return { videos };
  } catch (err: any) {
    return { error: `Pexels search failed: ${err?.message ?? err}` };
  }
}

/**
 * Is this URL actually Pexels?
 *
 * This matters more than it looks: the import endpoint downloads whatever URL
 * it is handed, so a loose check turns it into a server-side request forgery
 * tool. A substring/regex test is NOT enough — `notpexels.com` and
 * `pexels.com.evil.com` both satisfy the obvious patterns. Parse the URL and
 * compare the hostname exactly, or as a true subdomain.
 */
export function isPexelsUrl(raw: string): boolean {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "pexels.com" || host.endsWith(".pexels.com");
  } catch {
    return false;
  }
}

/**
 * Fetch a chosen stock clip to a temp file so it can be uploaded into object
 * storage as a normal media asset. Size-capped: a runaway download would sit
 * on the render VM's disk. Callers MUST gate on isPexelsUrl first.
 */
export async function downloadStockVideo(
  fileUrl: string,
  destPath: string,
): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
  const MAX_BYTES = 120 * 1024 * 1024;
  try {
    const res = await fetch(fileUrl, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return { ok: false, error: `Download failed (${res.status})` };

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) {
      return { ok: false, error: `That clip is ${(declared / 1024 / 1024).toFixed(0)}MB — over the 120MB limit.` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) {
      return { ok: false, error: "That clip exceeds the 120MB limit." };
    }
    const fs = await import("fs");
    fs.writeFileSync(destPath, buf);
    return { ok: true, bytes: buf.byteLength };
  } catch (err: any) {
    return { ok: false, error: `Download failed: ${err?.message ?? err}` };
  }
}
