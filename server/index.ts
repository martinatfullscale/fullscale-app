import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic, waitForBuild } from "./static";
import { createServer } from "http";
import { db } from "./db";
import { videoIndex } from "@shared/schema";
import { seed } from "./db/seed";
import { sql } from "drizzle-orm";
import path from "path";
import fs from "fs";
import os from "os";
import { spawnSync } from "child_process";
import cookieParser from "cookie-parser";
import { objectKeyFromServeUrl, getStorageStream } from "./lib/objectStorage";
// Static imports (not createRequire) so this resolves identically whether
// esbuild bundles to ESM or CJS — the previous createRequire(import.meta.url)
// approach silently no-ops in the production CJS bundle because import.meta
// doesn't exist there.
import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
// DISABLED: TensorFlow scanner replaced by scanner_v2.ts which uses Sharp

// -----------------------------------------------------------------------
// FFMPEG/FFPROBE PATH BOOTSTRAP — must run before anything spawns a child
// process.
//
// Production incident (2026-06-11, scan of video 91070): yt-dlp errored
// "You have requested downloading the video partially, but ffmpeg is not
// installed" on the deployed instance — the Replit DEPLOYMENT's PATH does
// not include the workspace nix ffmpeg, even though `.replit` lists it.
// Every media feature spawns bare `ffmpeg`/`ffprobe` from PATH (frame
// extraction, scene index, thumbnails, transcript audio, video export,
// yt-dlp trim/merge), so on production they all failed silently — this is
// the common root cause behind "Scan Failed"/"No frames extracted" on
// uploads and "Transcript not available after pipeline run" editorial
// errors.
//
// Fix: ship ffmpeg + ffprobe as npm deps (ffmpeg-static / ffprobe-static)
// and prepend their directories to PATH at boot. Child processes inherit
// process.env, so every existing spawn("ffmpeg"), fluent-ffmpeg call, and
// yt-dlp invocation finds them with zero per-call-site changes. Prepending
// (not appending) means the bundled binaries win over any system ffmpeg,
// giving us a deterministic version in every environment.
// -----------------------------------------------------------------------
try {
  const ffmpegBin = ffmpegStaticPath as unknown as string | null;
  const ffprobeBin = (ffprobeStatic as { path?: string } | undefined)?.path;
  const extraDirs = [ffmpegBin, ffprobeBin]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map((p) => path.dirname(p));
  if (extraDirs.length > 0) {
    process.env.PATH = [...extraDirs, process.env.PATH ?? ""].join(path.delimiter);
    console.log(`[Boot] ffmpeg/ffprobe PATH bootstrap: ${extraDirs.join(", ")}`);
  } else {
    console.warn("[Boot] ffmpeg-static/ffprobe-static resolved to no binaries — relying on system PATH");
  }
} catch (err: any) {
  console.warn(`[Boot] ffmpeg PATH bootstrap failed (${err?.message}); relying on system PATH`);
}

// Verify the bootstrap produced a runnable ffmpeg — loudly, at boot. If the
// ffmpeg-static binary is missing from the deploy image, every bare
// spawn("ffmpeg") silently falls back to whatever system ffmpeg the nix env
// provides (the one that segfaults on --download-sections), and the failure
// only surfaces as cryptic mid-scan errors hours later. A 1s -version probe
// plus a PATH scan tells us immediately whether ffmpeg runs and which
// directory's binary actually wins.
try {
  const resolvedFfmpeg = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => path.join(dir, "ffmpeg"))
    .find((candidate) => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
    });
  const probe = spawnSync("ffmpeg", ["-version"], { timeout: 1000, encoding: "utf8" });
  if (probe.status === 0) {
    const versionLine = (probe.stdout || "").split("\n")[0]?.trim() || "unknown version";
    console.log(`[Boot] ffmpeg verified: ${versionLine} (resolved: ${resolvedFfmpeg ?? "unknown"})`);
  } else {
    console.error(
      `[Boot] ffmpeg -version FAILED (status=${probe.status ?? "null"}, error=${probe.error?.message ?? "none"}, ` +
      `resolved=${resolvedFfmpeg ?? "no executable ffmpeg on PATH"}) — every media feature (scans, thumbnails, ` +
      `exports, yt-dlp trims) will fail; check that ffmpeg-static shipped in the deploy image`
    );
  }
} catch (err: any) {
  console.error(`[Boot] ffmpeg boot verification errored (${err?.message}) — media features may be broken`);
}

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// CRITICAL: Set trust proxy FIRST - before ANY middleware
// This is required for secure cookies to work behind Replit's reverse proxy
app.set("trust proxy", 1);

// Process-level safety net: never let an unhandled promise rejection or
// an uncaught exception take down the server. The deploy auto-restarts
// after a crash but every restart costs ~10s of downtime + interrupts
// in-flight work. Log loudly instead so we can fix the root cause.
process.on("unhandledRejection", (reason: any, promise) => {
  console.error("[process] UNHANDLED REJECTION:", reason?.message || reason);
  if (reason?.stack) console.error(reason.stack);
});
process.on("uncaughtException", (err: any) => {
  console.error("[process] UNCAUGHT EXCEPTION:", err?.message || err);
  if (err?.stack) console.error(err.stack);
});

// ============================================
// HIGHEST PRIORITY: Static assets before EVERYTHING
// This ensures logo and videos load regardless of auth/session state
// ============================================
const projectRoot = process.cwd();

// Serve public directory assets (videos, images) with CORS headers for canvas compositing.
// These filenames are not content-hashed, so we cache short and require revalidation —
// otherwise updates to og:image, favicon, marketing videos, etc. are invisible for days.
app.use(express.static(path.join(projectRoot, "public"), {
  maxAge: '1h',
  etag: true,
  lastModified: true,
  index: false,
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));

// Serve attached assets (logo, generated images/videos)
app.use('/attached_assets', express.static(path.join(projectRoot, "attached_assets"), {
  maxAge: '1h',
  etag: true,
  lastModified: true,
}));

app.get('/storage/*', async (req, res) => {
  try {
    // Finished renders are NOT public assets: this route has no session
    // (registered before session middleware) and serves with CORS * and a
    // 7-day cache, so /storage/exports/export_<id>.mp4 was anonymously
    // enumerable. Exports are served exclusively through the ownership-
    // gated /api/exports/:id/download.
    if (req.path.startsWith('/storage/exports/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    const objectKey = objectKeyFromServeUrl(req.path);
    const { file } = getStorageStream(objectKey);
    const [metadata] = await file.getMetadata();
    const fileSize = parseInt(String(metadata.size || 0));
    const contentType = metadata.contentType || 'application/octet-stream';

    // Parse Range header for video seeking support (critical for scrubbing)
    const rangeHeader = req.headers.range;

    if (rangeHeader && fileSize > 0) {
      // Range: bytes=START-END
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
        const clampedEnd = Math.min(end, fileSize - 1);

        if (start > clampedEnd) {
          res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
          return;
        }

        const chunkSize = clampedEnd - start + 1;
        res.status(206).set({
          'Content-Type': contentType,
          'Content-Length': chunkSize.toString(),
          'Content-Range': `bytes ${start}-${clampedEnd}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=604800',
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        });

        const stream = file.createReadStream({ start, end: clampedEnd });
        stream.on('error', (err: any) => {
          console.error('[Storage] Range stream error:', err.message);
          if (!res.headersSent) res.status(404).json({ error: 'File not found' });
        });
        stream.pipe(res);
        return;
      }
    }

    // No Range header — stream entire file (but still advertise Range support)
    res.set({
      'Content-Type': contentType,
      'Content-Length': fileSize.toString(),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=604800',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });

    const stream = file.createReadStream();
    stream.on('error', (err: any) => {
      console.error('[Storage] Stream error:', err.message);
      if (!res.headersSent) res.status(404).json({ error: 'File not found' });
    });
    stream.pipe(res);
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(404).json({ error: 'File not found' });
    }
  }
});

// ============================================
// Body parsing middleware (after static files)
// ============================================
app.use(
  express.json({
    limit: '10mb', // Placements send base64 product images as data URLs
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Cookie parser for reading OAuth state cookies
app.use(cookieParser());

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (reqPath.startsWith("/api")) {
      let logLine = `${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      log(logLine);
    }
  });

  next();
});

// Track server readiness
let serverReady = false;

// Loading page middleware - serve loading.html during cold start
app.use((req, res, next) => {
  // Allow health checks and static assets through
  if (req.path === '/health' || req.path === '/ready' || 
      req.path.startsWith('/attached_assets') || 
      req.path.startsWith('/thumbnails') ||
      req.path.endsWith('.png') || req.path.endsWith('.jpg') || 
      req.path.endsWith('.mp4') || req.path.endsWith('.css') || 
      req.path.endsWith('.js')) {
    return next();
  }
  // If server not ready, serve loading page
  if (!serverReady) {
    return res.sendFile(path.join(process.cwd(), 'public', 'loading.html'));
  }
  next();
});

// -----------------------------------------------------------------------
// STALE TEMP-ARTIFACT JANITOR
//
// Scans, editorial pipelines, and remix renders stage large working copies
// (up to a full ~1GB creator source each) in job-scoped temp dirs and
// delete them in in-process finally blocks — a guarantee that only holds
// while the process survives. On the Replit reserved VM /tmp persists
// across restarts, so an OOM-kill or redeploy mid-job orphans the copy;
// pin dirs are hard links, so sourceCache's own sweeper unlinking its
// cache entry does NOT free those bytes. Enough orphans and the scanner's
// 100MB disk preflight starts hard-failing every scan.
//
// This sweep removes stale entries from:
//   - os.tmpdir() entries prefixed scan- (covers scan-v2- and the legacy
//     scanner-v1 scan-<id>-<ts> dirs) / dense-scan- / detect-, after 2h
//     (well past the longest legitimate scan; scans cap ~10min). Prefix-
//     matched because tmpdir is shared with the yt-dlp binary cache,
//     cookie jar, and fullscale-source-cache — none of which may ever be
//     touched here; sourceCache runs its own sweeper.
//   - everything under /tmp/storage-downloads, after 2h.
//   - everything under the job-exclusive roots /tmp/editorial-source,
//     /tmp/editorial-renders, /tmp/remix-videos, after 6h. These stage
//     their files once at job start, so the top-level mtime is the job
//     START time — and a many-clip render run (15-min-per-clip ffmpeg
//     ceiling, no overall cap) can legitimately still be reading its
//     staged source well past 2h.
// -----------------------------------------------------------------------
const TEMP_SWEEP_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const TEMP_SWEEP_RENDER_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const TEMP_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function sweepStaleTempArtifacts(): Promise<void> {
  const now = Date.now();
  const removed: string[] = [];
  const targets: Array<{ root: string; maxAgeMs: number; match: (name: string) => boolean }> = [
    { root: os.tmpdir(), maxAgeMs: TEMP_SWEEP_MAX_AGE_MS, match: (n) => n.startsWith("scan-") || n.startsWith("dense-scan-") || n.startsWith("detect-") },
    { root: "/tmp/editorial-source", maxAgeMs: TEMP_SWEEP_RENDER_MAX_AGE_MS, match: () => true },
    { root: "/tmp/editorial-renders", maxAgeMs: TEMP_SWEEP_RENDER_MAX_AGE_MS, match: () => true },
    { root: "/tmp/remix-videos", maxAgeMs: TEMP_SWEEP_RENDER_MAX_AGE_MS, match: () => true },
    { root: "/tmp/storage-downloads", maxAgeMs: TEMP_SWEEP_MAX_AGE_MS, match: () => true },
  ];
  for (const { root, maxAgeMs, match } of targets) {
    const cutoff = now - maxAgeMs;
    let names: string[];
    try {
      names = await fs.promises.readdir(root);
    } catch {
      continue; // Root doesn't exist yet — nothing has been staged there
    }
    for (const name of names) {
      if (!match(name)) continue;
      const full = path.join(root, name);
      try {
        const stat = await fs.promises.stat(full);
        if (stat.mtimeMs >= cutoff) continue; // Possibly a live job — leave it
        await fs.promises.rm(full, { recursive: true, force: true });
        removed.push(full);
      } catch {
        // Entry vanished mid-sweep (the job's own cleanup won the race) — fine
      }
    }
  }
  if (removed.length > 0) {
    console.log(`[TempSweep] Removed ${removed.length} stale temp artifact(s): ${removed.join(", ")}`);
  }
}

(async () => {
  try {
    // Which code is actually running? Replit stamps a per-deployment id on
    // every log line that resembles a git SHA but isn't one; this is the
    // real build commit, injected by script/build.ts at bundle time.
    log(`Starting server initialization... (build ${process.env.BUILD_COMMIT || "dev"})`);
    
    // ============================================
    // PHASE 1: Health endpoint (for load balancer)
    // ============================================
    app.get("/health", (_req, res) => {
      res.status(200).json({ status: "ok", timestamp: Date.now() });
    });
    
    // Readiness endpoint - only returns 200 when fully ready
    app.get("/ready", (_req, res) => {
      if (serverReady) {
        res.status(200).json({ status: "ready", timestamp: Date.now() });
      } else {
        res.status(503).json({ status: "starting", timestamp: Date.now() });
      }
    });

    // ============================================
    // PHASE 2: Pre-warm database connection
    // ============================================
    log("Pre-warming database connection...");
    try {
      const result = await db.select({ count: sql<number>`count(*)` }).from(videoIndex);
      const videoCount = Number(result[0]?.count || 0);
      log(`Database ready: ${videoCount} videos found`);
    } catch (dbError) {
      log(`Database pre-warm warning: ${dbError}`);
      // Continue anyway - DB might be empty but that's OK
    }

    // ============================================
    // PHASE 3: Wait for client build in production
    // ============================================
    if (process.env.NODE_ENV === "production") {
      log("Production mode: waiting for client build...");
      const buildReady = await waitForBuild(30000); // Wait up to 30 seconds
      if (buildReady) {
        log("Client build ready");
      } else {
        log("Warning: Client build not found after 30s, continuing anyway");
      }
    }

    // ============================================
    // PHASE 4: Register all routes (includes auth pre-warming)
    // ============================================
    await registerRoutes(httpServer, app);
    log("Routes registered successfully");

    // Warm up yt-dlp binary in the background (downloads latest if cached
    // copy is stale). Non-blocking — server keeps starting while this runs.
    // First-scan latency is meaningfully better when the warm-up has run.
    import("./lib/ytDlpUpdater").then(m => m.ensureYtDlpReady()).catch(err =>
      console.warn("[startup] yt-dlp warm-up failed (non-fatal):", err?.message)
    );

    // Configure GCS bucket CORS once per process so direct-to-storage uploads
    // (large-file path via resumable session URLs) don't fail the browser's
    // preflight. Idempotent and cheap; non-blocking on failure since the
    // server-side fallback (multer) still works without it.
    import("./lib/objectStorage").then(m => m.ensureBucketCors())
      .then(cfg => console.log(`[startup] GCS bucket CORS configured for direct uploads (origins: ${cfg.origin.join(", ")})`))
      .catch(err =>
        console.warn("[startup] GCS bucket CORS setup failed (non-fatal — direct uploads may CORS-error until manual fix):", err?.message)
      );

    // Error handler
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";
      res.status(status).json({ message });
      console.error("Server error:", err);
    });

    // ============================================
    // PHASE 5: Setup static file serving
    // ============================================
    if (process.env.NODE_ENV === "production") {
      log("Setting up static file serving...");
      log(`Current working directory: ${process.cwd()}`);
      try {
        serveStatic(app);
        log("Static file serving configured successfully");
      } catch (staticError) {
        log(`ERROR setting up static files: ${staticError}`);
        throw staticError;
      }
    } else {
      log("Development mode: setting up Vite...");
      const { setupVite } = await import("./vite");
      await setupVite(httpServer, app);
    }
    
    // ============================================
    // PHASE 6: Start listening - ONLY when everything is ready
    // Includes EADDRINUSE retry logic for Replit restarts
    // ============================================
    const port = parseInt(process.env.PORT || "5000", 10);
    const MAX_LISTEN_RETRIES = 10;
    const RETRY_DELAY_MS = 3000; // 3 seconds between retries

    for (let attempt = 1; attempt <= MAX_LISTEN_RETRIES; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: NodeJS.ErrnoException) => {
            httpServer.removeListener("error", onError);
            reject(err);
          };
          httpServer.once("error", onError);
          httpServer.listen(
            { port, host: "0.0.0.0", reusePort: true },
            () => {
              httpServer.removeListener("error", onError);
              log(`Server listening on port ${port}`);
              resolve();
            },
          );
        });
        break; // Successfully bound — exit retry loop
      } catch (listenErr: any) {
        if (listenErr.code === "EADDRINUSE" && attempt < MAX_LISTEN_RETRIES) {
          log(`Port ${port} in use (attempt ${attempt}/${MAX_LISTEN_RETRIES}). Retrying in ${RETRY_DELAY_MS / 1000}s...`);
          // Try to force-close before retrying
          try { httpServer.close(); } catch (_) {}
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        } else {
          throw listenErr; // Non-recoverable or retries exhausted
        }
      }
    }
    
    // Mark server as fully ready AFTER listening
    serverReady = true;
    log("Server fully ready and accepting traffic");

    // Deploy-replacement handshake. Replit stops the outgoing process with
    // SIGTERM — but two modules register SIGTERM listeners (the yt-dlp
    // process-group reaper, glbRenderer's puppeteer cleanup), and ANY
    // registered listener suppresses Node's default terminate action. On a
    // reserved VM that means the old process lingers holding this port,
    // the replacement exhausts its EADDRINUSE retry budget above, and the
    // deploy reports "app failed to start". This is the one authoritative
    // shutdown owner: release the port immediately, let the other
    // listeners' best-effort cleanup fire, then exit unconditionally.
    let shuttingDown = false;
    const shutdownAndExit = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`${signal} received — releasing port ${port} and exiting`);
      try { httpServer.close(() => process.exit(0)); } catch { process.exit(0); }
      // close() waits for open keep-alive connections — don't. The
      // replacement process needs this port inside its retry window.
      setTimeout(() => process.exit(0), 2_500).unref();
    };
    process.on("SIGTERM", () => shutdownAndExit("SIGTERM"));
    process.on("SIGINT", () => shutdownAndExit("SIGINT"));
    
    // ============================================
    // PHASE 7: Background tasks (non-blocking)
    // ============================================
    setImmediate(async () => {
      try {
        const result = await db.select({ count: sql<number>`count(*)` }).from(videoIndex);
        const videoCount = Number(result[0]?.count || 0);
        if (videoCount === 0) {
          log("Database empty - seeding demo data in background...");
          await seed();
          log("Demo data seeded successfully");
        }
      } catch (dbError) {
        log(`Database seeding warning: ${dbError}`);
      }

      // Publishing scheduler — fires user-scheduled posts when due (60s poll).
      // Kill switch: SCHEDULER_ENABLED=false.
      if (process.env.SCHEDULER_ENABLED !== "false") {
        try {
          const { startScheduler } = await import("./lib/distribution/scheduler");
          startScheduler();
          log("Publishing scheduler started");
        } catch (schedulerError) {
          log(`Publishing scheduler failed to start: ${schedulerError}`);
        }
      } else {
        log("Publishing scheduler disabled via SCHEDULER_ENABLED=false");
      }

      // Social insight snapshots — Meta only retains account insights ~90
      // days (stories 24h); this 12h job appends them to our own table so
      // creator history accumulates. Kill switch: SNAPSHOTS_ENABLED=false.
      if (process.env.SNAPSHOTS_ENABLED !== "false") {
        try {
          const { startSocialSnapshotJob } = await import("./lib/socialSnapshots");
          startSocialSnapshotJob();
        } catch (snapErr) {
          log(`Social snapshot job failed to start: ${snapErr}`);
        }
      }

      // DISABLED: TensorFlow scanner replaced by scanner_v2.ts which uses Sharp
      // try {
      //   log("Initializing TensorFlow scan worker...");
      //   await initializeScanWorker();
      //   log("TensorFlow scan worker ready");
      // } catch (tfError) {
      //   log(`TensorFlow worker initialization warning: ${tfError}`);
      // }
    });

    // Stale temp-artifact janitor (see sweepStaleTempArtifacts above).
    // Deferred 60s so boot-critical I/O finishes first, then every 6h.
    // unref'd so the timers never hold the process open.
    const firstSweep = setTimeout(() => {
      sweepStaleTempArtifacts().catch((err: any) =>
        console.warn("[TempSweep] sweep failed (non-fatal):", err?.message || err)
      );
      const recurring = setInterval(() => {
        sweepStaleTempArtifacts().catch((err: any) =>
          console.warn("[TempSweep] sweep failed (non-fatal):", err?.message || err)
        );
      }, TEMP_SWEEP_INTERVAL_MS);
      recurring.unref();
    }, 60_000);
    firstSweep.unref();

  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
})();
