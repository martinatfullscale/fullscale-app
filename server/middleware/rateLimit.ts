/**
 * Minimal in-memory rate limiter. Single-instance Replit deploy, so a local
 * Map is sufficient (no Redis/distributed store needed). Dependency-free to
 * avoid adding a package that must be installed on the deploy host.
 *
 * Sliding-window-ish: fixed windows keyed by IP + route bucket. Not perfectly
 * accurate at window boundaries, but adequate to blunt credential stuffing and
 * compute-cost abuse, which is the goal.
 */

import type { Request, Response, NextFunction } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, Bucket>();

// Periodic sweep so the Map doesn't grow unbounded. Runs every 5 min.
let sweepStarted = false;
function startSweep() {
  if (sweepStarted) return;
  sweepStarted = true;
  setInterval(() => {
    const now = Date.now();
    Array.from(store.entries()).forEach(([key, bucket]) => {
      if (bucket.resetAt <= now) store.delete(key);
    });
  }, 5 * 60 * 1000).unref?.();
}

function clientIp(req: Request): string {
  // trust proxy is set (Replit), so req.ip reflects X-Forwarded-For.
  return req.ip || req.socket.remoteAddress || "unknown";
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  bucket: string; // logical name so different routes get separate counters
}

export function rateLimit(opts: RateLimitOptions) {
  startSweep();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = `${opts.bucket}:${clientIp(req)}`;
    let entry = store.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      store.set(key, entry);
    }

    entry.count += 1;

    const remaining = Math.max(0, opts.max - entry.count);
    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > opts.max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
    }

    next();
  };
}

// Preset buckets for the sensitive surfaces flagged in the security review.
export const authLimiter = rateLimit({ bucket: "auth", windowMs: 60_000, max: 10 });      // login/register: 10/min/IP
export const scanLimiter = rateLimit({ bucket: "scan", windowMs: 60_000, max: 20 });      // scan: 20/min/IP (each hits a paid model)
export const uploadLimiter = rateLimit({ bucket: "upload", windowMs: 60_000, max: 30 });  // upload: 30/min/IP
