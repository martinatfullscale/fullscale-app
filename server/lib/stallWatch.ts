/**
 * Stall instrumentation.
 *
 * Three outages this week presented identically — "the page spins and the
 * whole site stops" — and each time the endpoint at fault had to be GUESSED
 * from the page the user happened to be on. Two of those guesses were wrong.
 * The page you are looking at is rarely the page at fault: a request blocked
 * behind a 120s background poll or a render loop looks exactly like a request
 * that is itself slow.
 *
 * This makes the process say what is actually happening, so the next report is
 * a log line instead of a hypothesis:
 *
 *   [Stall] EVENT LOOP BLOCKED 3204ms — nothing else ran. in-flight: GET /api/x (3.2s)
 *   [Stall] SLOW GET /api/admin/placements 8140ms  pool{total:10 idle:0 waiting:7}
 *   [Stall] POOL SATURATED — 7 waiting on 10 connections
 *
 * Deliberately cheap: one 500ms timer and two counters. It measures the two
 * things that actually cause this failure mode — the single thread being held,
 * and the connection pool being drained — because those are what make ONE slow
 * request take down every unrelated one.
 */

import type { Request, Response, NextFunction } from "express";
import { poolStats } from "../db";

/** Requests still in flight, so a stall can name what was running during it. */
const inFlight = new Map<number, { method: string; path: string; startedAt: number }>();
let seq = 0;

/** Anything slower than this gets a line. Tuned to be quiet when healthy. */
const SLOW_REQUEST_MS = 2_000;
/** Loop delay above this means something synchronous held the thread. */
const LOOP_BLOCK_MS = 500;

function fmtPool(): string {
  try {
    const s = poolStats();
    return `pool{total:${s.total} idle:${s.idle} waiting:${s.waiting}/${s.max}}`;
  } catch {
    return "pool{unavailable}";
  }
}

function describeInFlight(now: number): string {
  if (inFlight.size === 0) return "nothing in flight";
  return Array.from(inFlight.values())
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, 5)
    .map((r) => `${r.method} ${r.path} (${((now - r.startedAt) / 1000).toFixed(1)}s)`)
    .join(", ");
}

/**
 * Event-loop lag monitor.
 *
 * A timer set for 500ms that fires at 4000ms proves the thread was held for
 * 3.5s — that is a SYNCHRONOUS block (a big JSON.parse, a decrypt loop, an
 * fs.*Sync), not slow I/O. Async waiting never shows up here, which is what
 * makes this the one signal that separates the two.
 */
export function startStallWatch(): void {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - 500;
    last = now;
    if (lag > LOOP_BLOCK_MS) {
      console.warn(
        `[Stall] EVENT LOOP BLOCKED ${lag}ms — nothing else ran. ${fmtPool()} | in-flight: ${describeInFlight(now)}`,
      );
    }
  }, 500);
  timer.unref?.();

  // A saturated pool starves every request in the process, including the
  // session lookup, so it reads as a total outage from the browser.
  const poolTimer = setInterval(() => {
    try {
      const s = poolStats();
      if (s.waiting > 0) {
        console.warn(
          `[Stall] POOL SATURATED — ${s.waiting} waiting on ${s.max} connections | in-flight: ${describeInFlight(Date.now())}`,
        );
      }
    } catch { /* pool not ready */ }
  }, 5_000);
  poolTimer.unref?.();

  console.log("[Stall] watching event-loop lag and pool saturation");
}

/** Per-request timing. Register EARLY so it wraps everything downstream. */
export function stallWatchMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Static assets and the polling health checks would drown the signal.
  const p = req.path;
  if (!p.startsWith("/api/") || p === "/api/health") return next();

  const id = ++seq;
  const startedAt = Date.now();
  inFlight.set(id, { method: req.method, path: p, startedAt });

  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    inFlight.delete(id);
    const ms = Date.now() - startedAt;
    if (ms >= SLOW_REQUEST_MS) {
      console.warn(`[Stall] SLOW ${req.method} ${p} ${ms}ms ${fmtPool()}`);
    }
  };

  // 'close' fires when the client disconnects mid-flight — the case that
  // matters most here, because an abandoned request is invisible to 'finish'
  // and is exactly what a browser timeout produces.
  res.on("finish", done);
  res.on("close", () => {
    if (!settled) {
      const ms = Date.now() - startedAt;
      console.warn(`[Stall] ABANDONED ${req.method} ${p} after ${ms}ms (client gave up) ${fmtPool()}`);
    }
    done();
  });

  next();
}
