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
export function serveStatic(app: Express) {
  // Verify build exists
  if (!fs.existsSync(distPath)) {
    console.error(`[Static] ERROR: Build directory not found: ${distPath}`);
    console.error("[Static] The client build must complete before the server starts");
    throw new Error(`Build directory not found: ${distPath}`);
  }
  
  if (!fs.existsSync(indexPath)) {
    console.error(`[Static] ERROR: index.html not found: ${indexPath}`);
    throw new Error(`index.html not found: ${indexPath}`);
  }
  
  console.log(`[Static] Serving static files from: ${distPath}`);

  // Serve static files with aggressive caching headers
  // Vite adds content hashes to filenames, so we can cache forever
  app.use(express.static(distPath, {
    maxAge: '7d',
    etag: true,
    lastModified: true,
    immutable: true,
  }));

  // SPA fallback - serve index.html for all non-API routes
  app.use("*", (_req, res) => {
    res.sendFile(indexPath);
  });
}
