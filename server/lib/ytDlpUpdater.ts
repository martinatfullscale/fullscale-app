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

// yt-dlp ships several distribution flavors. The plain `yt-dlp` is a Python
// zipapp that requires python3 on the host. Replit's Nix container *should*
// have python3 but the probe failed in production (cached binary failed
// --version probe = couldn't execute). Switching to `yt-dlp_linux` — a
// PyInstaller bundle with Python embedded (~30MB), no host Python needed.
// Linux x86_64 is what Replit runs on.
const DOWNLOAD_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

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

// The standalone yt-dlp_linux is a ~30MB PyInstaller bundle that cold-starts
// an embedded Python interpreter; --version can take well over 5s on a small
// instance's first run. A too-short timeout made the probe fail, which threw
// away the FRESH binary and fell back to the stale system yt-dlp that can't
// parse current YouTube ("Requested format is not available").
const PROBE_TIMEOUT_MS = 30000;

async function probeVersion(binPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let resolved = false;
    const done = (val: string | null) => { if (!resolved) { resolved = true; resolve(val); } };
    let proc;
    try {
      proc = spawn(binPath, ["--version"]);
    } catch (e: any) {
      console.warn(`[yt-dlp] probeVersion spawn threw for ${binPath}: ${e.message}`);
      return done(null);
    }
    proc.stdout.on("data", d => { out += d.toString(); });
    proc.stderr.on("data", d => { err += d.toString(); });
    proc.on("close", code => {
      if (code === 0) return done(out.trim());
      console.warn(`[yt-dlp] probeVersion failed for ${binPath} (exit ${code}): ${err.trim().slice(0, 300) || "(no stderr)"}`);
      done(null);
    });
    proc.on("error", e => {
      console.warn(`[yt-dlp] probeVersion error for ${binPath}: ${e.message}`);
      done(null);
    });
    setTimeout(() => {
      console.warn(`[yt-dlp] probeVersion timeout for ${binPath} after ${PROBE_TIMEOUT_MS / 1000}s`);
      try { proc.kill(); } catch {}
      done(null);
    }, PROBE_TIMEOUT_MS);
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
    // A large, present binary is trusted even if --version doesn't return in
    // time: the system yt-dlp we'd otherwise fall back to is KNOWN too old to
    // parse current YouTube, so a slow-but-real fresh binary always beats it.
    const looksReal = () => {
      try { return fs.statSync(CACHE_PATH).size > 10_000_000; } catch { return false; }
    };
    try {
      if (!isFresh()) {
        await downloadLatest();
      }
      let version = await probeVersion(CACHE_PATH);
      if (!version && !looksReal()) {
        // Only re-download when the cached file is missing/undersized (a
        // corrupt partial) — not merely because the probe was slow.
        console.warn(`[yt-dlp] Cached binary missing/undersized; re-downloading...`);
        try { fs.unlinkSync(CACHE_PATH); } catch {}
        await downloadLatest();
        version = await probeVersion(CACHE_PATH);
      }
      if (version) {
        console.log(`[yt-dlp] Using cached binary version ${version} at ${CACHE_PATH}`);
        cachedPath = CACHE_PATH;
        return CACHE_PATH;
      }
      if (looksReal()) {
        // Probe timed out but the binary is a full-size fresh download —
        // trust it over the stale system binary.
        console.warn(`[yt-dlp] Probe inconclusive but binary is full-size; using ${CACHE_PATH} anyway`);
        cachedPath = CACHE_PATH;
        return CACHE_PATH;
      }
      throw new Error("Fresh binary unusable (undersized and unprobeable)");
    } catch (err: any) {
      console.warn(`[yt-dlp] Update failed (${err.message}); falling back to system yt-dlp`);
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
