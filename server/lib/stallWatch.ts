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
 * It measures the THREE independent ways one request ruins the others:
 *   - the single thread being held (synchronous work)
 *   - the connection pool being drained (contention)
 *   - latency x N (an N+1: many sequential round trips)
 *
 * The third was added after a real 7.6s request sailed past the first two
 * silently — the loop was free and the pool sat idle the entire time, because
 * its cost was neither. Measuring only the first two is how that request stayed
 * invisible through several rounds of diagnosis.
 */

import type { Request, Response, NextFunction } from "express";
import { AsyncLocalStorage } from "async_hooks";
import { poolStats, pool } from "../db";

/**
 * Per-request database round-trip accounting.
 *
 * The first version of this file measured only two things: the event loop
 * being held, and the pool being drained. A real 7.6s request then sailed past
 * BOTH alarms silently — because its cost was neither. It was ~7 sequential
 * awaits, each paying a full round trip to a remote Postgres. Every query
 * completed and released its connection before the next began, so the pool
 * read idle the whole time and the loop was never blocked for even 500ms.
 *
 * Latency x N is a third, independent failure mode, and it is the one that was
 * actually happening. Counting queries per request makes it obvious on sight:
 * "4113ms queries:27" is an N+1, and no amount of staring at CPU or pool
 * graphs would ever have said so.
 */
interface ReqDb { queries: number; dbMs: number }
const dbStore = new AsyncLocalStorage<ReqDb>();

let patched = false;
function patchPoolCounter(): void {
  if (patched) return;
  patched = true;
  const orig = (pool as any).query.bind(pool);
  (pool as any).query = function (...args: any[]) {
    const store = dbStore.getStore();
    if (!store) return orig(...args);
    const t0 = Date.now();
    const done = () => { store.queries += 1; store.dbMs += Date.now() - t0; };
    try {
      const out = orig(...args);
      if (out && typeof out.then === "function") {
        return out.then(
          (r: any) => { done(); return r; },
          (e: any) => { done(); throw e; },
        );
      }
      done();
      return out;
    } catch (e) { done(); throw e; }
  };
}

/** Requests still in flight, so a stall can name what was running during it. */
const inFlight = new Map<number, { method: string; path: string; startedAt: number }>();

/**
 * Requests whose client has gone but whose handler is still running.
 *
 * The 2026-09-09 outage hid its culprit here. This middleware used to delete a
 * request from `inFlight` the moment its socket closed, so a scan the browser
 * gave up on at 30s vanished from every [Stall] line while it ran four more
 * minutes — forking a TensorFlow child and pulling a whole video. The lines
 * blamed the oldest SURVIVING request instead, which was idle, waiting on a
 * child process. An abandoned handler is still consuming the machine, so it
 * stays on the list until it actually finishes.
 */
const abandoned = new Map<number, { method: string; path: string; startedAt: number; abandonedAt: number }>();

/** Promise-backed work with no request attached, such as a background download. */
const background = new Map<number, { label: string; startedAt: number }>();

/** Per-response end hook, so a streaming handler can report its own finish. */
const handlerEnds = new WeakMap<object, () => void>();

let seq = 0;

/** Anything slower than this gets a line. Tuned to be quiet when healthy. */
const SLOW_REQUEST_MS = 2_000;
/** Loop delay above this means something synchronous held the thread. */
const LOOP_BLOCK_MS = 500;
/** A handler that never finishes must not grow the abandoned list without bound. */
const ABANDONED_MAX = 100;
/** An abandoned entry older than this is dropped and reported as never settling. */
const ABANDONED_MAX_AGE_MS = 60 * 60 * 1000;
/** Once abandoned work has run this long with no client, say so periodically. */
const ABANDONED_SUMMARY_AFTER_MS = 30_000;

function fmtPool(): string {
  try {
    const s = poolStats();
    return `pool{total:${s.total} idle:${s.idle} waiting:${s.waiting}/${s.max}}`;
  } catch {
    return "pool{unavailable}";
  }
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function describeInFlight(now: number): string {
  const rows: Array<{ t: number; s: string }> = [];
  inFlight.forEach((r) => rows.push({ t: r.startedAt, s: `${r.method} ${r.path} (${secs(now - r.startedAt)})` }));
  abandoned.forEach((r) => rows.push({ t: r.startedAt, s: `${r.method} ${r.path} (${secs(now - r.startedAt)}, abandoned, still running)` }));
  background.forEach((b) => rows.push({ t: b.startedAt, s: `background ${b.label} (${secs(now - b.startedAt)})` }));
  if (rows.length === 0) return "nothing in flight";
  return rows
    .sort((a, b) => a.t - b.t)
    .slice(0, 8)
    .map((r) => r.s)
    .join(", ");
}

function recordAbandoned(
  id: number,
  entry: { method: string; path: string; startedAt: number; abandonedAt: number },
): void {
  abandoned.set(id, entry);
  while (abandoned.size > ABANDONED_MAX) {
    const oldestId = abandoned.keys().next().value as number;
    const oldest = abandoned.get(oldestId)!;
    abandoned.delete(oldestId);
    console.warn(
      `[Stall] ABANDONED list full (${ABANDONED_MAX}) — dropping oldest: ${oldest.method} ${oldest.path} (${secs(Date.now() - oldest.startedAt)})`,
    );
  }
}

function sweepAbandoned(now: number): void {
  let lingering = 0;
  abandoned.forEach((e, id) => {
    const age = now - e.abandonedAt;
    if (age > ABANDONED_MAX_AGE_MS) {
      abandoned.delete(id);
      console.warn(
        `[Stall] ABANDONED handler never settled ${e.method} ${e.path} — dropped after ${Math.round((now - e.startedAt) / 60_000)}m`,
      );
    } else if (age > ABANDONED_SUMMARY_AFTER_MS) {
      lingering++;
    }
  });
  if (lingering > 0) {
    console.warn(`[Stall] ${lingering} abandoned handler(s) still running with no client | ${describeInFlight(now)}`);
  }
}

/**
 * Track promise-backed work that has no request of its own, so it appears in
 * the in-flight list for as long as it runs. Cleared when the promise settles.
 */
export function trackBackground(label: string, work: Promise<unknown>): void {
  const id = ++seq;
  background.set(id, { label, startedAt: Date.now() });
  const clear = () => { background.delete(id); };
  work.then(clear, clear);
}

/**
 * Tell the watcher a streaming handler's work is over. A piped response whose
 * client disconnected never calls res.end, so without this an abandoned stream
 * would sit on the list until the age sweep dropped it.
 */
export function release(res: Response): void {
  const end = handlerEnds.get(res);
  if (end) {
    try { end(); } catch { /* instrumentation must never throw into a handler */ }
  }
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

  const abandonedTimer = setInterval(() => {
    try { sweepAbandoned(Date.now()); } catch { /* the watcher must never take the process down */ }
  }, 60_000);
  abandonedTimer.unref?.();

  console.log("[Stall] watching event-loop lag and pool saturation");
}

/** Per-request timing. Register EARLY so it wraps everything downstream. */
export function stallWatchMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Static assets and the polling health checks would drown the signal.
  const p = req.path;
  if (!p.startsWith("/api/") || p === "/api/health") return next();

  const id = ++seq;
  const startedAt = Date.now();
  const method = req.method;
  inFlight.set(id, { method, path: p, startedAt });
  const db: ReqDb = { queries: 0, dbMs: 0 };

  const logSlow = (ms: number) => {
    if (ms < SLOW_REQUEST_MS) return;
    // queries:N alongside the wall clock is what identifies an N+1. If dbMs
    // is most of ms and queries is large, the request is not slow — it is
    // slow N times, and batching is the fix rather than optimising any one
    // query.
    const perQuery = db.queries ? Math.round(db.dbMs / db.queries) : 0;
    console.warn(
      `[Stall] SLOW ${method} ${p} ${ms}ms queries:${db.queries} dbMs:${db.dbMs} (~${perQuery}ms each) ${fmtPool()}`,
    );
    if (db.queries >= 10) {
      console.warn(
        `[Stall]   ^ ${db.queries} round trips in one request — this is an N+1. Batch it; the pool and event loop will both look healthy while this happens.`,
      );
    }
  };

  let settled = false;
  let isAbandoned = false;

  const done = () => {
    if (settled) return;
    settled = true;
    inFlight.delete(id);
    logSlow(Date.now() - startedAt);
  };

  // The handler reached its end — through res.end, or release() from a
  // streaming handler. For a live request that is simply `done`. For one whose
  // client already left, it is the moment the abandoned work actually stops.
  const onHandlerEnd = () => {
    if (isAbandoned) {
      isAbandoned = false;
      abandoned.delete(id);
      console.warn(`[Stall] ABANDONED handler finished ${method} ${p} — ran ${secs(Date.now() - startedAt)} in total`);
      return;
    }
    done();
  };
  handlerEnds.set(res, onHandlerEnd);

  // Node does not emit 'finish' once the client is gone, so the only reliable
  // signal that an abandoned handler finished is its own call to end().
  const origEnd = res.end;
  (res as any).end = function (this: any, ...args: any[]) {
    try { onHandlerEnd(); } catch { /* never throw from instrumentation */ }
    return (origEnd as any).apply(this, args);
  };

  res.on("finish", done);
  // 'close' fires when the client disconnects mid-flight — the case that
  // matters most here, because an abandoned request is invisible to 'finish'
  // and is exactly what a browser timeout produces.
  res.on("close", () => {
    if (settled) return;
    const ms = Date.now() - startedAt;
    console.warn(`[Stall] ABANDONED ${method} ${p} after ${ms}ms (client gave up) ${fmtPool()}`);
    settled = true;
    inFlight.delete(id);
    logSlow(ms);
    isAbandoned = true;
    recordAbandoned(id, { method, path: p, startedAt, abandonedAt: Date.now() });
  });

  // Everything downstream runs inside the query-accounting context.
  patchPoolCounter();
  dbStore.run(db, () => next());
}

/** Test-only: sizes of the three tracking maps. */
export function __stallWatchStateForTest(): { inFlight: number; abandoned: number; background: number } {
  return { inFlight: inFlight.size, abandoned: abandoned.size, background: background.size };
}

/** Test-only: the bounded-memory paths, driven directly instead of by timers. */
export const __stallWatchTestHooks = { recordAbandoned, sweepAbandoned, describeInFlight };
