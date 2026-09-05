// On-demand source video cache for in-app playback.
//
// We don't persist creator source videos (light-cloud model — see
// memory:creator_brand_remix_flow). But the creator + brand both need to
// actually watch the video while reviewing scan results, and we don't want
// to send them off to YouTube/IG/Facebook (their UI, their ads, their
// "watch next" engagement loop). So we pull on demand, stream from a temp
// file, and discard after a TTL.
//
// Behavior:
//   - First playback request → background download via existing helpers,
//     stream to client as bytes arrive
//   - Subsequent requests within TTL → serve cached file directly
//   - Concurrent first-requests → deduplicated via inflight map
//   - Background sweep evicts files older than TTL on a slow interval
//
// This is per-instance cache. If we scale beyond one Replit container,
// each instance maintains its own cache (acceptable — the cost of a
// re-download per pod is small relative to serving across pods).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { storage } from "../storage";
import type { VideoIndex } from "@shared/schema";
import { downloadVideo as downloadYouTubeVideo } from "./scanner";
import { downloadFacebookVideo, downloadInstagramVideo } from "./socialDownloader";
import { safeDecrypt } from "./socialAnalytics";
import { getFreshYoutubeTokenForUser } from "./youtubeAuth";
import { isYtDlpPlatform, sourceUrlForStoredId } from "./platformSources";

const CACHE_DIR = path.join(os.tmpdir(), "fullscale-source-cache");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // every 15 min
// Cap on total cache disk usage. Without this the cache could grow
// unbounded inside the 1-hour TTL window and choke /tmp on Replit deploy
// (small /tmp shared with multer disk writes, frame extraction, etc).
// When usage exceeds the cap, the sweeper evicts oldest-first until under —
// but files in active use are exempt (see the guards below), so the cap is
// soft while viewers are mid-stream and hard again once they go idle.
const CACHE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB
// Sweeper eviction guards (see sweep() pass 2). Playback hits touch mtime,
// so a recently-touched file is either mid-stream to a viewer or a download
// that just landed — evicting it converts a cache hit into a full re-pull.
const ACTIVE_EVICT_GRACE_MS = 5 * 60 * 1000;
// A single file larger than the whole cap can never bring pass 2 under the
// cap; without a longer leash it would be evicted on every sweep for as long
// as it exists. Let oversize files stay until they've been idle a while.
const OVERSIZE_EVICT_IDLE_MS = 15 * 60 * 1000;
// Playback pulls the FULL untrimmed video (no trimToSeconds), so the
// scanner's scan-sized 3-minute default timeout is far too tight — a
// long-form podcast at 720p takes well past that on Replit egress, and a
// SIGKILL mid-pull just wastes the whole transfer. Generous flat ceiling;
// the scanner's hard kill still bounds a truly hung download.
const PLAYBACK_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

const inflight = new Map<number, Promise<string>>();

function cachePath(videoId: number): string {
  return path.join(CACHE_DIR, `${videoId}.mp4`);
}

// Downloads never write the cache slot directly. They land at a partial name
// in the same directory and get renamed in only after verified success —
// isFresh() is mtime-only, so a half-written file AT the slot path would be
// served as a healthy hit (and every retry would re-touch its mtime, keeping
// the poisoned entry alive until TTL expiry). Orphaned partials from crashed
// processes are GC'd by the sweeper's TTL pass like any other file.
//
// The ".mp4" must stay the FINAL extension: yt-dlp picks the merge container
// for its bv*+ba rungs from the output filename's extension, so a name like
// "<id>.mp4.partial-N" would make it write somewhere we're not looking.
let partialSeq = 0;
function partialPath(videoId: number): string {
  return path.join(CACHE_DIR, `${videoId}.partial-${process.pid}-${++partialSeq}.mp4`);
}

// Verify a finished download and move it into the cache slot. Rename is
// atomic within a directory, so the slot only ever holds complete files —
// the mtime-only freshness check depends on that invariant.
function promotePartial(ok: boolean, temp: string, target: string, failMsg: string): string {
  let size = 0;
  try {
    size = fs.statSync(temp).size;
  } catch {
    // temp missing entirely — same as a failed download
  }
  if (!ok || size === 0) {
    try { fs.unlinkSync(temp); } catch { /* already gone */ }
    throw new Error(failMsg);
  }
  fs.renameSync(temp, target);
  return target;
}

function isFresh(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

// Resolves the local path to a playable mp4 for the given video, downloading
// from the source platform if not already cached. Returns the local path.
export async function getSourcePath(video: VideoIndex): Promise<string> {
  const filePath = (video as any).filePath as string | null | undefined;

  // GCS-backed uploads: filePath looks like "/storage/videos/<key>". Download
  // the bytes to the on-disk cache so the player can stream from a real file.
  // This is the path used by chunked-uploads (platform="fullscale") that
  // landed in Object Storage rather than on the local workspace volume.
  if (filePath?.startsWith("/storage/")) {
    const target = cachePath(video.id);
    if (fs.existsSync(target) && isFresh(target)) {
      fs.utimesSync(target, new Date(), new Date());
      return target;
    }
    if (inflight.has(video.id)) return inflight.get(video.id)!;
    const promise = (async () => {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const objectKey = filePath.replace(/^\/storage\//, "public/");
      const { getStorageStream } = await import("./objectStorage");
      // Not downloadToTempFile: it lands at basename(objectKey), a name
      // shared by every video row referencing the same objectKey, so two
      // concurrent pulls would write (and rename) the same inode, splicing
      // bytes across videos. Pull through the File handle into this
      // attempt's unique partial name and promote like every other branch.
      const { file, stream } = getStorageStream(objectKey);
      stream.destroy(); // only the File handle is needed here
      const temp = partialPath(video.id);
      try {
        await file.download({ destination: temp });
      } catch (e) {
        try { fs.unlinkSync(temp); } catch { /* already gone */ }
        throw e;
      }
      return promotePartial(true, temp, target, `Object storage download empty for video ${video.id}`);
    })();
    inflight.set(video.id, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(video.id);
    }
  }

  // Local-disk uploads (legacy workspace videos): serve straight from filePath.
  if (filePath) {
    const direct = path.resolve(process.cwd(), filePath);
    if (fs.existsSync(direct)) return direct;
  }

  const target = cachePath(video.id);
  // Fast path. A file at the slot is complete by construction — downloads
  // land at a partial name and are renamed in only after verification — so
  // fresh-by-mtime is sufficient to serve it. While a download is in
  // flight nothing exists at the slot, and concurrent callers fall through
  // here to join the inflight promise below instead of racing the writer.
  if (fs.existsSync(target) && isFresh(target)) {
    // Touch mtime to extend TTL on active playback.
    fs.utimesSync(target, new Date(), new Date());
    return target;
  }

  if (inflight.has(video.id)) {
    return inflight.get(video.id)!;
  }

  const promise = (async () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const platform = (video as any).platform;
    const ytId = video.youtubeId;

    if (platform === "youtube" && ytId && !ytId.includes(":") && !ytId.startsWith("upload-")) {
      // Use the creator's stored OAuth token to bypass YT bot detection.
      // For full-video player downloads (no trim), authenticated requests
      // are critical — long, anonymous downloads are the most likely to
      // hit "Sign in to confirm you're not a bot."
      const oauthToken = await getFreshYoutubeTokenForUser(video.userId).catch(() => null);
      const temp = partialPath(video.id);
      const ok = await downloadYouTubeVideo(ytId, temp, {
        oauthToken: oauthToken || undefined,
        timeoutMs: PLAYBACK_DOWNLOAD_TIMEOUT_MS,
      });
      return promotePartial(ok, temp, target, `YouTube download failed for ${ytId}`);
    }

    if ((platform === "instagram" || platform === "facebook") && ytId) {
      const user = await storage.getUserById(video.userId);
      const fbToken = safeDecrypt(user?.facebookAccessToken);
      if (!fbToken) throw new Error(`No Facebook token for user ${video.userId}`);

      const temp = partialPath(video.id);
      const ok = platform === "facebook"
        ? await downloadFacebookVideo(ytId, fbToken, temp)
        : await downloadInstagramVideo(ytId, fbToken, temp);
      return promotePartial(ok, temp, target, `${platform} download failed for ${ytId}`);
    }

    // Twitch/TikTok/X: same yt-dlp ladder as YouTube, keyed on the rebuilt
    // watch URL. Without this arm, playback/editorial/remix all throw for a
    // platform whose SCAN succeeded.
    if (isYtDlpPlatform(platform) && ytId) {
      const sourceUrl = sourceUrlForStoredId(platform, ytId);
      if (sourceUrl) {
        const temp = partialPath(video.id);
        const ok = await downloadYouTubeVideo(ytId, temp, {
          sourceUrl,
          timeoutMs: PLAYBACK_DOWNLOAD_TIMEOUT_MS,
        });
        return promotePartial(ok, temp, target, `${platform} download failed for ${ytId}`);
      }
    }

    throw new Error(`Cannot resolve source for video ${video.id} (platform=${platform})`);
  })();

  inflight.set(video.id, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(video.id);
  }
}

/**
 * Resolve a source AND pin it for a long-running job. The playback cache is
 * sweep-managed (1h TTL + 500MB oldest-first size cap), so a render pipeline
 * holding the raw cache path can have the file unlinked mid-run. Pinning
 * hard-links the cache file into the caller's job-scoped dir — the inode
 * survives the sweeper's unlink — with a copy fallback across filesystems.
 * Callers own pinDir cleanup (their existing temp-scope teardown).
 */
export async function getPinnedSourcePath(video: VideoIndex, pinDir: string): Promise<string> {
  const cached = await getSourcePath(video);
  if (!cached.startsWith(CACHE_DIR)) return cached; // local file / non-swept path — nothing to pin
  fs.mkdirSync(pinDir, { recursive: true });
  const pinned = path.join(pinDir, path.basename(cached));
  if (!fs.existsSync(pinned)) {
    try {
      fs.linkSync(cached, pinned);
    } catch {
      fs.copyFileSync(cached, pinned);
    }
  }
  return pinned;
}

/**
 * Seed the cache with a source file another pipeline already downloaded —
 * the scanner's full-video pull, most importantly. One platform download
 * then serves scan + playback + editorial (each a cache hit) instead of
 * every feature paying its own pull against the source platform's rate
 * heuristics. Best-effort and never throws: hard-link (copy fallback)
 * through a partial name and promote exactly like a download would; a
 * fresh existing entry wins. Callers must only seed COMPLETE sources —
 * a trimmed or capped pull would play back as a truncated video.
 */
export function seedSourceCache(videoId: number, sourceFile: string): boolean {
  try {
    const size = fs.statSync(sourceFile).size;
    if (size === 0) return false;
    const target = cachePath(videoId);
    if (fs.existsSync(target) && isFresh(target)) return false;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const temp = partialPath(videoId);
    try {
      // Same-tmpfs link is free, and the cache's inode survives the
      // caller's temp-dir teardown; copy covers a split-filesystem layout.
      fs.linkSync(sourceFile, temp);
    } catch {
      fs.copyFileSync(sourceFile, temp);
    }
    promotePartial(true, temp, target, `seed failed for video ${videoId}`);
    console.log(`[Source Cache] Seeded video ${videoId} from an existing download (${(size / 1024 / 1024).toFixed(1)} MB)`);
    return true;
  } catch (e: any) {
    console.warn(`[Source Cache] Seed skipped for video ${videoId}: ${e?.message}`);
    return false;
  }
}

function sweep() {
  if (!fs.existsSync(CACHE_DIR)) return;

  // Pass 1: evict by TTL.
  let removedTtl = 0;
  for (const file of fs.readdirSync(CACHE_DIR)) {
    const full = path.join(CACHE_DIR, file);
    try {
      const stat = fs.statSync(full);
      if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
        fs.unlinkSync(full);
        removedTtl++;
      }
    } catch {
      // ignore — file may have been deleted between readdir and stat
    }
  }

  // Pass 2: enforce total-size cap. Survey what's left, sort oldest first,
  // unlink until under the cap.
  let totalBytes = 0;
  const survivors: { path: string; size: number; mtimeMs: number }[] = [];
  for (const file of fs.readdirSync(CACHE_DIR)) {
    const full = path.join(CACHE_DIR, file);
    try {
      const stat = fs.statSync(full);
      totalBytes += stat.size;
      survivors.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {}
  }

  let removedSize = 0;
  if (totalBytes > CACHE_MAX_BYTES) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    const now = Date.now();
    for (const s of survivors) {
      if (totalBytes <= CACHE_MAX_BYTES) break;
      const idleMs = now - s.mtimeMs;
      // Skip anything touched within the grace window: playback hits touch
      // mtime, so a fresh mtime means a viewer is actively range-streaming
      // this file (or a download just finished writing it). Unlinking it
      // mid-review forces an immediate full re-pull from the source
      // platform — for YouTube that's another large authenticated download
      // straight into their rate heuristics.
      if (idleMs < ACTIVE_EVICT_GRACE_MS) continue;
      // Oversize files (bigger than the entire cap) get a longer leash:
      // eviction can never bring them under the cap, so without this an
      // hour-long source would be evicted by every sweep and re-downloaded
      // ~1.2 GB at a time for the whole review session. Evict only once
      // idle; the TTL pass ages them out regardless.
      if (s.size > CACHE_MAX_BYTES && idleMs < OVERSIZE_EVICT_IDLE_MS) continue;
      try {
        fs.unlinkSync(s.path);
        totalBytes -= s.size;
        removedSize++;
      } catch {}
    }
  }

  if (removedTtl > 0 || removedSize > 0) {
    console.log(`[Source Cache] Swept ${removedTtl} expired + ${removedSize} oldest-for-size — now ${(totalBytes / 1024 / 1024).toFixed(1)} MB / ${(CACHE_MAX_BYTES / 1024 / 1024).toFixed(0)} MB cap`);
  }
}

// Run an initial sweep at startup so a previous process's leftovers don't
// linger past the size cap before the first interval fires.
setTimeout(sweep, 5_000).unref();
setInterval(sweep, SWEEP_INTERVAL_MS).unref();
