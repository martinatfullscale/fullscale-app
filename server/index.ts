import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic, waitForBuild } from "./static";
import { createServer } from "http";
import { db } from "./db";
import { videoIndex } from "@shared/schema";
import { seed } from "./db/seed";
import { sql } from "drizzle-orm";
import path from "path";
import cookieParser from "cookie-parser";
import { objectKeyFromServeUrl, getStorageStream } from "./lib/objectStorage";
// DISABLED: TensorFlow scanner replaced by scanner_v2.ts which uses Sharp
// import { initializeScanWorker } from "./lib/scanWorker";

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

(async () => {
  try {
    log("Starting server initialization...");
    
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
      
      // DISABLED: TensorFlow scanner replaced by scanner_v2.ts which uses Sharp
      // try {
      //   log("Initializing TensorFlow scan worker...");
      //   await initializeScanWorker();
      //   log("TensorFlow scan worker ready");
      // } catch (tfError) {
      //   log(`TensorFlow worker initialization warning: ${tfError}`);
      // }
    });

  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
})();
