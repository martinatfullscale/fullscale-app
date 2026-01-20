import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic, waitForBuild } from "./static";
import { createServer } from "http";
import { db } from "./db";
import { videoIndex } from "@shared/schema";
import { seed } from "./db/seed";
import { sql } from "drizzle-orm";
import path from "path";

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

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Serve static files from public directory with HIGH PRIORITY caching
// Videos and images get long cache times to avoid blocking slow API calls
const projectRoot = process.cwd();
app.use(express.static(path.join(projectRoot, "public"), {
  maxAge: '7d',           // Cache video/image assets for 7 days
  etag: true,             // Enable ETag for cache validation
  lastModified: true,     // Include Last-Modified header
  immutable: true,        // Assets are immutable (use versioning if changed)
  index: false,           // Don't serve index.html from public
}));

// Serve attached assets with same high-priority caching
app.use('/attached_assets', express.static(path.join(projectRoot, "attached_assets"), {
  maxAge: '7d',
  etag: true,
  lastModified: true,
  immutable: true,
}));

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
      serveStatic(app);
    } else {
      log("Development mode: setting up Vite...");
      const { setupVite } = await import("./vite");
      await setupVite(httpServer, app);
    }
    
    // ============================================
    // PHASE 6: Start listening - ONLY when everything is ready
    // ============================================
    const port = parseInt(process.env.PORT || "5000", 10);
    
    await new Promise<void>((resolve) => {
      httpServer.listen(
        { port, host: "0.0.0.0", reusePort: true },
        () => {
          log(`Server listening on port ${port}`);
          resolve();
        },
      );
    });
    
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
    });

  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
})();
