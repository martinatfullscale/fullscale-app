import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  // Use process.cwd() for bundled CJS compatibility (distPath is at root/dist/public)
  const distPath = path.resolve(process.cwd(), "dist", "public");
  const indexPath = path.resolve(distPath, "index.html");
  
  // Check if build exists - log warning but don't crash
  if (!fs.existsSync(distPath)) {
    console.error(`[Static] Build directory not found: ${distPath}`);
    console.error("[Static] Server will continue but pages may not load");
    // Serve a fallback response instead of crashing
    app.use("*", (_req, res) => {
      res.status(503).send("Application is starting... please refresh in a moment.");
    });
    return;
  }
  
  if (!fs.existsSync(indexPath)) {
    console.error(`[Static] index.html not found at: ${indexPath}`);
    console.error("[Static] Build may be incomplete");
  } else {
    console.log(`[Static] Serving static files from: ${distPath}`);
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(503).send("Application is loading... please refresh.");
    }
  });
}
