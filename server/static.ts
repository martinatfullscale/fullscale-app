import express, { type Express } from "express";
import fs from "fs";
import path from "path";

const distPath = path.resolve(process.cwd(), "dist", "public");
const indexPath = path.resolve(distPath, "index.html");

/**
 * Wait for the client build to be available
 * Polls for dist/public/index.html with exponential backoff
 * @param timeoutMs Maximum time to wait in milliseconds
 * @returns true if build is ready, false if timeout
 */
export async function waitForBuild(timeoutMs: number = 30000): Promise<boolean> {
  const startTime = Date.now();
  let delay = 100; // Start with 100ms delay
  
  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(indexPath)) {
      return true;
    }
    
    // Wait with exponential backoff (max 2 seconds between checks)
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 2000);
  }
  
  return fs.existsSync(indexPath);
}

/**
 * Serve static files from the production build directory
 */
/** Last-resort shell. Served with 200 so the platform healthcheck on `/`
 *  passes and the process is allowed to stay up. */
function degradedShell(reason: string): string {
  return '<!doctype html><meta charset="utf-8"><title>FullScale</title>' +
    '<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center">' +
    '<div><p><strong>The app failed to load its client build.</strong></p>' +
    `<p style="color:#666">${reason}</p>` +
    '<p style="color:#666">The API is running. Redeploy to rebuild the client.</p></div></body>';
}

export function serveStatic(app: Express) {
  // A MISSING BUILD MUST NOT THROW.
  //
  // Throwing here aborts startup, so the process never binds a port and never
  // becomes healthy — and Replit responds by restarting it, forever. During
  // that loop the whole product is down, including the API routes that were
  // perfectly fine, because nothing is listening at all.
  //
  // A booted process that serves a blunt diagnostic page and a working API is
  // strictly better than a crash loop, and the error is still loud in the log.
  const missing = !fs.existsSync(distPath)
    ? `Build directory not found: ${distPath}`
    : !fs.existsSync(indexPath)
      ? `index.html not found: ${indexPath}`
      : null;

  if (missing) {
    console.error(`[Static] ERROR: ${missing}`);
    console.error("[Static] Serving a degraded shell so the process stays up — the client build did not ship in this deploy image.");
    app.use("*", (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.status(200).type("html").send(degradedShell(missing));
    });
    return;
  }
  
  console.log(`[Static] Serving static files from: ${distPath}`);

  // Hashed Vite assets in /assets/* are content-addressed by filename — cache forever.
  // Everything else (index.html, robots.txt, etc.) must revalidate so deploys are picked up.
  app.use(express.static(distPath, {
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  // SPA fallback - serve index.html for all non-API routes
  app.use("*", (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexPath, (err) => {
        if (!err || res.headersSent) return;
        // Deliberately NOT next(err): that lands in the 500 handler, and a 500
        // on `/` is what the platform healthcheck reads as "unhealthy" — the
        // trigger for the restart loop this file used to cause. index.html can
        // vanish mid-flight when a deploy swaps the directory underneath a
        // still-serving process, which is exactly when we least want a restart.
        console.error("[Static] Error sending index.html:", err);
        res.status(200).type("html").send(degradedShell(String((err as any)?.message ?? err)));
      });
    } catch (err) {
      console.error("[Static] Unexpected error in SPA fallback:", err);
      if (!res.headersSent) res.status(200).type("html").send(degradedShell(String(err)));
    }
  });
}
