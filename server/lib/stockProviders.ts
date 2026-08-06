/**
 * B-roll sources, behind one interface.
 *
 * Pexels was hardcoded because it was the only source. The moment a second
 * one exists — a free library to widen coverage, a paid library, or AI
 * generation — the search route, the import route, the SSRF host guard and
 * the client all need to know about it, and hardcoding means touching all
 * four every time. One registry instead.
 *
 * THE HOST ALLOWLIST IS THE SECURITY BOUNDARY. The import endpoint downloads
 * whatever URL it is handed, so "which hosts may we fetch from" must be
 * derived from the registry rather than restated per provider — a provider
 * added without its hosts is a provider whose imports fail closed, which is
 * the correct direction to fail.
 */

export type ProviderId = "pexels" | "pixabay";

export interface StockVideo {
  /** Namespaced so ids from different providers can share a list. */
  uid: string;
  provider: ProviderId;
  providerLabel: string;
  pageUrl: string;
  fileUrl: string;
  previewUrl: string;
  durationSec: number;
  width: number;
  height: number;
  author: string;
  /** Shown in the UI. Free libraries differ on whether credit is required. */
  attributionRequired: boolean;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  configured: boolean;
  /** Why it is unavailable, in words an operator can act on. */
  detail: string;
  /** Free vs paid, so the UI can group and the operator can reason about cost. */
  tier: "free" | "paid";
}

interface Provider {
  id: ProviderId;
  label: string;
  tier: "free" | "paid";
  envVar: string;
  /** Hostnames whose files this provider may serve. Exact match or subdomain. */
  hosts: string[];
  attributionRequired: boolean;
  configured(): boolean;
  missingDetail(): string;
  search(query: string, opts: { perPage: number; orientation?: "portrait" | "landscape" }):
    Promise<{ videos: StockVideo[] } | { error: string }>;
}

// ── Pexels ──────────────────────────────────────────────────────────────

function pickBestMp4(files: any[], linkKey = "link"): any | null {
  const mp4s = (files ?? []).filter((f) => String(f?.file_type ?? f?.type ?? "").includes("mp4") && f?.[linkKey]);
  if (mp4s.length === 0) return null;
  const shortEdge = (f: any) => Math.min(Number(f.width) || 0, Number(f.height) || 0);
  // Smallest file that still clears 720p: b-roll is composited under a
  // 1080x1920 crop, so 4K costs download and decode time for pixels the
  // output throws away.
  const ok = mp4s.filter((f) => shortEdge(f) >= 720).sort((a, b) => shortEdge(a) - shortEdge(b));
  return ok[0] ?? mp4s.sort((a, b) => shortEdge(b) - shortEdge(a))[0];
}

const pexels: Provider = {
  id: "pexels",
  label: "Pexels",
  tier: "free",
  envVar: "PEXELS_API_KEY",
  hosts: ["pexels.com"],
  attributionRequired: false,
  configured: () => !!process.env.PEXELS_API_KEY,
  missingDetail: () =>
    "PEXELS_API_KEY is not set in this environment. It's free at pexels.com/api — note that a secret added to the Replit workspace is NOT automatically present in a Deployment.",
  async search(query, opts) {
    const params = new URLSearchParams({
      query: query.slice(0, 100),
      per_page: String(opts.perPage),
    });
    if (opts.orientation) params.set("orientation", opts.orientation);
    try {
      const res = await fetch(`https://api.pexels.com/videos/search?${params}`, {
        headers: { Authorization: process.env.PEXELS_API_KEY! },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401) return { error: "Pexels rejected the API key." };
      if (res.status === 429) return { error: "Pexels rate limit reached — the free tier is shared across everyone using this app." };
      if (!res.ok) return { error: `Pexels search failed (${res.status})` };
      const data: any = await res.json();
      const videos: StockVideo[] = [];
      for (const v of data?.videos ?? []) {
        const file = pickBestMp4(v.video_files);
        if (!file) continue;
        videos.push({
          uid: `pexels:${v.id}`,
          provider: "pexels",
          providerLabel: "Pexels",
          pageUrl: String(v.url ?? ""),
          fileUrl: String(file.link),
          previewUrl: String(v.image ?? ""),
          durationSec: Number(v.duration) || 0,
          width: Number(file.width) || 0,
          height: Number(file.height) || 0,
          author: String(v.user?.name ?? "Pexels"),
          attributionRequired: false,
        });
      }
      return { videos };
    } catch (err: any) {
      return { error: `Pexels search failed: ${err?.message ?? err}` };
    }
  },
};

// ── Pixabay ─────────────────────────────────────────────────────────────
// A second FREE library rather than a paid one, deliberately: it roughly
// doubles searchable coverage for zero marginal cost and no commercial
// agreement, which is the cheapest real upgrade available. Its library is
// genuinely different from Pexels rather than a mirror.

const pixabay: Provider = {
  id: "pixabay",
  label: "Pixabay",
  tier: "free",
  envVar: "PIXABAY_API_KEY",
  hosts: ["pixabay.com", "cdn.pixabay.com"],
  attributionRequired: false,
  configured: () => !!process.env.PIXABAY_API_KEY,
  missingDetail: () =>
    "PIXABAY_API_KEY is not set. It's free at pixabay.com/api/docs — adding it roughly doubles the searchable library at no cost.",
  async search(query, opts) {
    const params = new URLSearchParams({
      key: process.env.PIXABAY_API_KEY!,
      q: query.slice(0, 100),
      per_page: String(Math.max(3, opts.perPage)), // Pixabay rejects per_page < 3
      safesearch: "true",
    });
    try {
      const res = await fetch(`https://pixabay.com/api/videos/?${params}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 400) return { error: "Pixabay rejected the request — check PIXABAY_API_KEY." };
      if (res.status === 429) return { error: "Pixabay rate limit reached — try again shortly." };
      if (!res.ok) return { error: `Pixabay search failed (${res.status})` };
      const data: any = await res.json();
      const videos: StockVideo[] = [];
      for (const hit of data?.hits ?? []) {
        // Pixabay returns a keyed object of renditions, not an array.
        const variants = Object.values(hit?.videos ?? {}) as any[];
        const file = pickBestMp4(variants.map((v) => ({ ...v, file_type: "mp4" })), "url");
        if (!file?.url) continue;
        videos.push({
          uid: `pixabay:${hit.id}`,
          provider: "pixabay",
          providerLabel: "Pixabay",
          pageUrl: String(hit.pageURL ?? ""),
          fileUrl: String(file.url),
          previewUrl: file.thumbnail
            ? String(file.thumbnail)
            // Pixabay does not always return a poster; derive one from the
            // video id rather than showing an empty tile.
            : `https://i.vimeocdn.com/video/${hit.picture_id}_295x166.jpg`,
          durationSec: Number(hit.duration) || 0,
          width: Number(file.width) || 0,
          height: Number(file.height) || 0,
          author: String(hit.user ?? "Pixabay"),
          attributionRequired: false,
        });
      }
      return { videos };
    } catch (err: any) {
      return { error: `Pixabay search failed: ${err?.message ?? err}` };
    }
  },
};

const PROVIDERS: Provider[] = [pexels, pixabay];

// ── Response cache ──────────────────────────────────────────────────────
//
// NOT an optimization — a licence term. Pixabay's API terms REQUIRE that
// responses be cached for 24 hours, so shipping without one was a breach.
// Pexels recommends the same. It is also the single largest multiplier on a
// shared free quota, because b-roll queries repeat heavily across a creator
// base: "city street" gets typed by everyone.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const searchCache = new Map<string, { at: number; videos: StockVideo[]; errors: string[] }>();

function cacheKey(q: string, orientation?: string): string {
  return `${q.trim().toLowerCase().replace(/\s+/g, " ")}|${orientation ?? "any"}`;
}

function readCache(key: string) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { searchCache.delete(key); return null; }
  return hit;
}

function writeCache(key: string, videos: StockVideo[], errors: string[]) {
  // Oldest-out when full. A Map preserves insertion order, so the first key
  // is the oldest — no separate LRU bookkeeping needed for a cache this size.
  if (searchCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { at: Date.now(), videos, errors });
}

// ── Public surface ──────────────────────────────────────────────────────

export function providerStatuses(): ProviderStatus[] {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    tier: p.tier,
    configured: p.configured(),
    detail: p.configured() ? `${p.label} is live in this environment.` : p.missingDetail(),
  }));
}

export function anyProviderConfigured(): boolean {
  return PROVIDERS.some((p) => p.configured());
}

/**
 * Is this URL one a configured provider may serve?
 *
 * Derived from the registry, and parsed rather than pattern-matched: a
 * substring or regex test accepts `notpexels.com` and `pexels.com.evil.com`,
 * which would turn the import endpoint into a server-side request forgery
 * tool. Hostname compared exactly or as a true subdomain.
 */
export function isAllowedStockUrl(raw: string): boolean {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return PROVIDERS.some((p) =>
      p.hosts.some((h) => host === h || host.endsWith(`.${h}`)),
    );
  } catch {
    return false;
  }
}

/**
 * Search every configured provider and interleave the results, so one
 * library never buries the other. Providers fail independently — a dead
 * Pixabay key must not take Pexels results down with it.
 */
export async function searchAllProviders(
  query: string,
  opts: { perPage?: number; orientation?: "portrait" | "landscape" } = {},
): Promise<{ videos: StockVideo[]; errors: string[]; configuredCount: number; cached: boolean }> {
  const q = String(query ?? "").trim();
  const active = PROVIDERS.filter((p) => p.configured());
  if (q.length === 0 || active.length === 0) {
    return { videos: [], errors: [], configuredCount: active.length, cached: false };
  }

  const key = cacheKey(q, opts.orientation);
  const cached = readCache(key);
  if (cached) {
    return { videos: cached.videos, errors: cached.errors, configuredCount: active.length, cached: true };
  }

  // Larger pages, fewer requests: the quota is per REQUEST, and it is shared
  // across every creator using the app.
  const perPage = Math.min(40, Math.max(3, opts.perPage ?? 24));

  const results = await Promise.all(
    active.map((p) =>
      p.search(q, { perPage, orientation: opts.orientation })
        .catch((err) => ({ error: `${p.label}: ${err?.message ?? err}` })),
    ),
  );

  const perProvider: StockVideo[][] = [];
  const errors: string[] = [];
  for (const r of results) {
    if ("error" in r) errors.push(r.error);
    else perProvider.push(r.videos);
  }

  // Round-robin interleave so the first screen shows both libraries.
  const videos: StockVideo[] = [];
  const maxLen = Math.max(0, ...perProvider.map((v) => v.length));
  for (let i = 0; i < maxLen; i++) {
    for (const list of perProvider) if (list[i]) videos.push(list[i]);
  }
  // Only cache a result that actually reached at least one provider — caching
  // a total failure for 24h would hide a fixed API key.
  if (videos.length > 0 || errors.length < active.length) writeCache(key, videos, errors);
  return { videos, errors, configuredCount: active.length, cached: false };
}

/**
 * Fetch a chosen clip to a temp file. Callers MUST gate on isAllowedStockUrl
 * first — this function does not re-check, by design, so the guard lives in
 * exactly one place rather than being duplicated and drifting.
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
    if (buf.byteLength > MAX_BYTES) return { ok: false, error: "That clip exceeds the 120MB limit." };

    const fs = await import("fs");
    fs.writeFileSync(destPath, buf);
    return { ok: true, bytes: buf.byteLength };
  } catch (err: any) {
    return { ok: false, error: `Download failed: ${err?.message ?? err}` };
  }
}
