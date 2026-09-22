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
// If the refresh fails, falls back to any intact cached binary already on
// disk (whatever its age), then to the system "yt-dlp", so the scanner
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
// Nightly builds live in a separate repo and carry extractor fixes within
// ~a day of YouTube player changes — stable releases can lag by weeks. The
// self-heal escalates to nightly only when stable came back unchanged, i.e.
// when we KNOW stable has no fix for whatever just broke.
const NIGHTLY_DOWNLOAD_URL = "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux";

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

async function downloadLatest(url: string = DOWNLOAD_URL): Promise<string> {
  console.log(`[yt-dlp] Downloading from ${url.includes("nightly") ? "NIGHTLY builds" : "GitHub releases"}...`);
  const res = await fetch(url, { redirect: "follow" });
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

// The caller needs to know WHY a probe failed, not just that it did. A
// timeout means the binary spawned and is (slowly) running — recoverable.
// A spawn error (ENOENT/ENOEXEC — wrong arch, missing dynamic loader) or an
// instant non-zero exit (glibc mismatch, exit 127) means the binary can
// never work here, no matter how many megabytes it weighs.
type ProbeResult =
  | { ok: true; version: string }
  | { ok: false; reason: "timeout" | "spawn-error" | "exit" };

/**
 * One probe at a time, per binary path.
 *
 * yt-dlp_linux is a ~38MB PyInstaller bundle: the FIRST exec unpacks an
 * embedded Python runtime into /tmp before it can print a version. Two of
 * those running concurrently on a small instance contend for the same unpack
 * and the same disk, and BOTH blow the 30s budget — observed at boot as two
 * identical "probeVersion timeout after 30s" lines at the same millisecond,
 * immediately followed by a probe that succeeded in ~4s once the unpack was
 * warm. Serializing turns two 30s failures into one short success.
 */
const probeInFlight = new Map<string, Promise<ProbeResult>>();

async function probeVersion(binPath: string): Promise<ProbeResult> {
  const running = probeInFlight.get(binPath);
  if (running) return running;
  const p = probeVersionUncached(binPath).finally(() => probeInFlight.delete(binPath));
  probeInFlight.set(binPath, p);
  return p;
}

async function probeVersionUncached(binPath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let resolved = false;
    const done = (val: ProbeResult) => { if (!resolved) { resolved = true; resolve(val); } };
    let proc;
    try {
      proc = spawn(binPath, ["--version"]);
    } catch (e: any) {
      console.warn(`[yt-dlp] probeVersion spawn threw for ${binPath}: ${e.message}`);
      return done({ ok: false, reason: "spawn-error" });
    }
    proc.stdout.on("data", d => { out += d.toString(); });
    proc.stderr.on("data", d => { err += d.toString(); });
    proc.on("close", code => {
      if (code === 0) return done({ ok: true, version: out.trim() });
      console.warn(`[yt-dlp] probeVersion failed for ${binPath} (exit ${code}): ${err.trim().slice(0, 300) || "(no stderr)"}`);
      done({ ok: false, reason: "exit" });
    });
    proc.on("error", e => {
      console.warn(`[yt-dlp] probeVersion error for ${binPath}: ${e.message}`);
      done({ ok: false, reason: "spawn-error" });
    });
    const timer = setTimeout(() => {
      console.warn(`[yt-dlp] probeVersion timeout for ${binPath} after ${PROBE_TIMEOUT_MS / 1000}s`);
      try { proc.kill(); } catch {}
      done({ ok: false, reason: "timeout" });
    }, PROBE_TIMEOUT_MS);
    // Release the timer as soon as the probe settles — otherwise a fast probe
    // still pins the child process object for the full 30s.
    proc.on("close", () => clearTimeout(timer));
    proc.on("error", () => clearTimeout(timer));
  });
}

/**
 * Force a refresh of the cached binary NOW, ignoring the weekly freshness
 * window. Exists for the stale-extractor emergency: YouTube ships player
 * changes mid-week, every request starts failing with "Requested format is
 * not available", and the correct fix is always the newest release — which
 * the weekly window would not fetch for days. Rate-limited to once per 6h
 * per process (a broken-upstream day must not hammer GitHub's release CDN).
 * Returns { path, version, changed } — changed=false means the download
 * yielded the SAME version we already had (no newer release exists yet), so
 * callers should NOT bother retrying their failed operation.
 */
let lastForceRefreshAt = 0;
let forceRefreshInFlight: Promise<{ path: string; version: string | null; changed: boolean } | null> | null = null;
export async function forceRefreshYtDlp(): Promise<{ path: string; version: string | null; changed: boolean } | null> {
  if (process.platform !== "linux") return null;
  // Single-flight: concurrent ladders (scan + playback pull) must SHARE one
  // refresh and both get its result — with a bare rate limiter the second
  // caller got an instant null and fell through to ytdl-core while the
  // refresh it needed was still downloading.
  if (forceRefreshInFlight) return forceRefreshInFlight;
  const now = Date.now();
  if (now - lastForceRefreshAt < 6 * 60 * 60 * 1000) {
    console.log(`[yt-dlp] Force-refresh skipped (rate-limited; last attempt ${Math.round((now - lastForceRefreshAt) / 60000)}min ago)`);
    return null;
  }
  lastForceRefreshAt = now;
  forceRefreshInFlight = (async () => {
    const looksReal = () => {
      try { return fs.statSync(CACHE_PATH).size > 10_000_000; } catch { return false; }
    };
    const before = await probeVersion(CACHE_PATH);
    try {
      console.warn(`[yt-dlp] FORCE-REFRESH: current binary${before.ok ? ` (${before.version})` : ""} appears extractor-stale — pulling latest release`);
      await downloadLatest();
      const after = await probeVersion(CACHE_PATH);
      if (after.ok) {
        cachedPath = CACHE_PATH;
        const changed = !before.ok || before.version !== after.version;
        if (changed) {
          console.log(`[yt-dlp] Force-refresh: now on ${after.version}`);
          return { path: CACHE_PATH, version: after.version, changed: true };
        }
        // Stable had no fix — escalate to the nightly channel, which ships
        // extractor patches within a day of YouTube changes.
        console.log(`[yt-dlp] Force-refresh: stable unchanged (${after.version}) — escalating to nightly builds`);
        try {
          await downloadLatest(NIGHTLY_DOWNLOAD_URL);
          const nightly = await probeVersion(CACHE_PATH);
          if (nightly.ok && nightly.version !== after.version) {
            cachedPath = CACHE_PATH;
            console.log(`[yt-dlp] Force-refresh: now on NIGHTLY ${nightly.version}`);
            return { path: CACHE_PATH, version: nightly.version, changed: true };
          }
          if (!nightly.ok && nightly.reason === "timeout" && looksReal()) {
            cachedPath = CACHE_PATH;
            console.warn(`[yt-dlp] Nightly probe timed out but binary is full-size — trusting it`);
            return { path: CACHE_PATH, version: null, changed: true };
          }
          if (nightly.ok) {
            console.log(`[yt-dlp] Nightly matches stable (${nightly.version}) — no fix upstream anywhere yet`);
            return { path: CACHE_PATH, version: nightly.version, changed: false };
          }
          console.warn(`[yt-dlp] Nightly binary unusable (${nightly.reason}); re-fetching stable`);
          await downloadLatest();
          return { path: CACHE_PATH, version: after.version, changed: false };
        } catch (nightlyErr: any) {
          console.warn(`[yt-dlp] Nightly escalation failed (${nightlyErr?.message || nightlyErr}); staying on stable ${after.version}`);
          return { path: CACHE_PATH, version: after.version, changed: false };
        }
      }
      if (after.reason === "timeout" && looksReal()) {
        // Same cold-start reality getYtDlpPath already trusts: a freshly
        // downloaded PyInstaller binary self-extracts on first run and can
        // blow the probe budget on a busy VM. Full-size + fresh download =
        // usable; version unknown, so assume changed and let the (rate-
        // limited) retry ladder find out.
        console.warn(`[yt-dlp] Force-refresh probe timed out but binary is full-size — trusting it (version unknown)`);
        cachedPath = CACHE_PATH;
        return { path: CACHE_PATH, version: null, changed: true };
      }
      console.warn(`[yt-dlp] Force-refresh produced an unusable binary (${after.reason}); keeping prior behavior`);
      return null;
    } catch (err: any) {
      console.warn(`[yt-dlp] Force-refresh failed (${err?.message || err}); keeping cached binary`);
      return null;
    } finally {
      forceRefreshInFlight = null;
    }
  })();
  return forceRefreshInFlight;
}

/**
 * Returns the path to a usable yt-dlp binary. Uses a cached recent download
 * if available, otherwise pulls latest from GitHub. Falls back to system
 * "yt-dlp" on any failure.
 */
export async function getYtDlpPath(): Promise<string> {
  // DOWNLOAD_URL points at a Linux x86_64 ELF. On a macOS dev machine it
  // downloads fine, chmods fine, and then can never exec — so skip the whole
  // download dance off-Linux and use whatever yt-dlp is on PATH (brew keeps
  // it current locally).
  if (process.platform !== "linux") {
    if (cachedPath !== "yt-dlp") {
      console.log(`[yt-dlp] Non-Linux platform (${process.platform}); using system yt-dlp`);
      cachedPath = "yt-dlp";
    }
    return "yt-dlp";
  }

  if (cachedPath && isFresh()) return cachedPath;

  if (updateInFlight) return updateInFlight;

  updateInFlight = (async () => {
    // A large, present binary is trusted even if --version doesn't return in
    // time: the system yt-dlp we'd otherwise fall back to is KNOWN too old to
    // parse current YouTube, so a slow-but-real fresh binary always beats it.
    // That trust only applies to a TIMEOUT, though — a binary that spawns and
    // dies instantly (exec-format error, glibc mismatch, exit 127) is dead
    // regardless of size, and pinning it would kill every ladder rung at once.
    const looksReal = () => {
      try { return fs.statSync(CACHE_PATH).size > 10_000_000; } catch { return false; }
    };
    try {
      if (!isFresh()) {
        await downloadLatest();
      }
      let probe = await probeVersion(CACHE_PATH);
      if (!probe.ok && (probe.reason !== "timeout" || !looksReal())) {
        // Either the file is missing/undersized (a corrupt partial), or it
        // executed and failed / couldn't execute at all — size doesn't save
        // it. One unlink + re-download, then re-probe. Only a slow probe on
        // a full-size binary skips this.
        console.warn(`[yt-dlp] Cached binary unusable (${probe.reason}); re-downloading...`);
        try { fs.unlinkSync(CACHE_PATH); } catch {}
        await downloadLatest();
        probe = await probeVersion(CACHE_PATH);
      }
      if (probe.ok) {
        console.log(`[yt-dlp] Using cached binary version ${probe.version} at ${CACHE_PATH}`);
        cachedPath = CACHE_PATH;
        return CACHE_PATH;
      }
      if (probe.reason === "timeout" && looksReal()) {
        // Probe timed out but the binary is a full-size fresh download —
        // trust it over the stale system binary.
        console.warn(`[yt-dlp] Probe timed out but binary is full-size; using ${CACHE_PATH} anyway`);
        cachedPath = CACHE_PATH;
        return CACHE_PATH;
      }
      throw new Error(`Fresh binary unusable (probe: ${probe.reason})`);
    } catch (err: any) {
      // downloadLatest writes to .partial and only renames on success, so a
      // failed refresh never corrupts what's already at CACHE_PATH. If an
      // intact binary is sitting there — stale because GitHub 403/429'd the
      // shared egress IP mid-refresh — it still beats the system binary by
      // weeks of YouTube churn. Staleness is a reason to ATTEMPT a refresh,
      // never to disqualify a cache that provably runs.
      if (looksReal()) {
        const staleProbe = await probeVersion(CACHE_PATH);
        if (staleProbe.ok) {
          console.warn(`[yt-dlp] Update failed (${err.message}); using stale cached binary version ${staleProbe.version}`);
          cachedPath = CACHE_PATH;
          return CACHE_PATH;
        }
      }
      console.warn(`[yt-dlp] Update failed (${err.message}); falling back to system yt-dlp`);
      const sysProbe = await probeVersion("yt-dlp");
      if (sysProbe.ok) {
        console.log(`[yt-dlp] Using system binary version ${sysProbe.version}`);
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
