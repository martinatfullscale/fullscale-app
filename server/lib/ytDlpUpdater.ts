// Self-updating yt-dlp binary. The Nix-installed yt-dlp from stable-24_11
// is too old to handle YouTube's current player — nsig extraction fails,
// only storyboard formats are exposed, and downloads die with "Requested
// format is not available." yt-dlp upstream ships fixes within days but
// Nix can't keep up.
//
// Solution: pull the latest standalone yt-dlp binary from GitHub at server
// startup, cache to a writable path, and point our spawn calls at it.
// The binary is a self-contained Python zip-app — no pip, no PATH editing.
//
// Falls back to the system "yt-dlp" if the download fails so the scanner
// never breaks worse than its previous baseline.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

const CACHE_PATH = path.join(os.tmpdir(), "yt-dlp-latest");
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const DOWNLOAD_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

let cachedPath: string | null = null;
let updateInFlight: Promise<string> | null = null;

function isFresh(): boolean {
  try {
    const stat = fs.statSync(CACHE_PATH);
    return Date.now() - stat.mtimeMs < STALE_AFTER_MS && stat.size > 1_000_000; // > 1MB sanity
  } catch {
    return false;
  }
}

async function downloadLatest(): Promise<string> {
  console.log(`[yt-dlp] Downloading latest from GitHub releases...`);
  const res = await fetch(DOWNLOAD_URL, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`yt-dlp download failed: HTTP ${res.status}`);
  }
  const tmpPath = `${CACHE_PATH}.partial`;
  // Use Node's stream pipeline to avoid loading 10MB into RAM
  const { pipeline } = await import("stream/promises");
  const { Readable } = await import("stream");
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmpPath));
  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, CACHE_PATH);
  const sizeMB = (fs.statSync(CACHE_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`[yt-dlp] Downloaded ${sizeMB}MB to ${CACHE_PATH}`);
  return CACHE_PATH;
}

async function probeVersion(binPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(binPath, ["--version"]);
    let out = "";
    proc.stdout.on("data", d => { out += d.toString(); });
    proc.on("close", code => resolve(code === 0 ? out.trim() : null));
    proc.on("error", () => resolve(null));
    setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 5000);
  });
}

/**
 * Returns the path to a usable yt-dlp binary. Uses a cached recent download
 * if available, otherwise pulls latest from GitHub. Falls back to system
 * "yt-dlp" on any failure.
 */
export async function getYtDlpPath(): Promise<string> {
  if (cachedPath && isFresh()) return cachedPath;

  if (updateInFlight) return updateInFlight;

  updateInFlight = (async () => {
    try {
      if (!isFresh()) {
        await downloadLatest();
      }
      const version = await probeVersion(CACHE_PATH);
      if (version) {
        console.log(`[yt-dlp] Using cached binary version ${version} at ${CACHE_PATH}`);
        cachedPath = CACHE_PATH;
        return CACHE_PATH;
      }
      throw new Error("Cached binary failed --version probe");
    } catch (err: any) {
      console.warn(`[yt-dlp] Update failed (${err.message}); falling back to system yt-dlp`);
      // Fall through to system binary
      const sysVersion = await probeVersion("yt-dlp");
      if (sysVersion) {
        console.log(`[yt-dlp] Using system binary version ${sysVersion}`);
      }
      cachedPath = "yt-dlp";
      return "yt-dlp";
    } finally {
      updateInFlight = null;
    }
  })();

  return updateInFlight;
}

/**
 * Eager warm-up — call once at server startup so the first scan doesn't
 * pay the download latency.
 */
export async function ensureYtDlpReady(): Promise<void> {
  try {
    await getYtDlpPath();
  } catch (err: any) {
    console.error(`[yt-dlp] Warm-up failed:`, err?.message || err);
  }
}
