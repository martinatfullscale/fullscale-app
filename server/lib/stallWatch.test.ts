// On 2026-09-09 every [Stall] line blamed an idle /source request, because the
// middleware dropped a request from its in-flight list the moment the client
// left — so the orphaned scan actually burning the machine was invisible. These
// tests pin the fix: abandoned work stays listed until it truly finishes, and
// the list stays bounded when something never finishes at all.

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { Readable, pipeline as streamPipeline } from "node:stream";
import express from "express";

import {
  stallWatchMiddleware,
  release,
  __stallWatchStateForTest,
  __stallWatchTestHooks,
} from "./stallWatch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(10);
  }
}

function captureWarn() {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.warn = orig; } };
}

async function serve(handler: express.RequestHandler) {
  const app = express();
  app.use(stallWatchMiddleware);
  app.get("/api/x", handler);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port as number;
  return {
    url: `http://127.0.0.1:${port}/api/x`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("an abandoned handler stays listed until it actually finishes", async () => {
  const cap = captureWarn();
  const s = await serve(async (_req, res) => {
    await sleep(1200);
    res.json({ ok: true });
  });
  try {
    const req = http.get(s.url);
    req.on("error", () => {});
    await sleep(300);
    req.destroy();

    await until(() => __stallWatchStateForTest().abandoned === 1);
    assert.match(
      __stallWatchTestHooks.describeInFlight(Date.now()),
      /GET \/api\/x \([\d.]+s, abandoned, still running\)/,
      "the abandoned request is named in stall lines, not hidden",
    );

    await until(() => __stallWatchStateForTest().abandoned === 0);
  } finally {
    cap.restore();
    await s.close();
  }
  assert.equal(cap.lines.filter((l) => l.includes("ABANDONED GET /api/x after")).length, 1);
  assert.equal(cap.lines.filter((l) => l.includes("ABANDONED handler finished GET /api/x")).length, 1);
});

test("a normal request leaves nothing behind and logs nothing twice", async () => {
  const cap = captureWarn();
  const s = await serve((_req, res) => { res.json({ ok: true }); });
  try {
    await new Promise<void>((r) => http.get(s.url, (resp) => { resp.resume(); resp.on("end", () => r()); }));
    await until(() => __stallWatchStateForTest().inFlight === 0);
  } finally {
    cap.restore();
    await s.close();
  }
  assert.equal(__stallWatchStateForTest().abandoned, 0);
  assert.equal(cap.lines.filter((l) => l.includes("ABANDONED")).length, 0);
});

test("a stream whose client leaves is released by its pipeline callback", async () => {
  const cap = captureWarn();
  const s = await serve((_req, res) => {
    const slow = new Readable({ read() {} });
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    streamPipeline(slow, res, () => release(res));
    let n = 0;
    const t = setInterval(() => {
      slow.push("x".repeat(4096));
      if (++n > 60) { clearInterval(t); slow.push(null); }
    }, 20);
  });
  try {
    const req = http.get(s.url, (resp) => { resp.on("data", () => {}); });
    req.on("error", () => {});
    await sleep(150);
    req.destroy();
    await until(() => {
      const st = __stallWatchStateForTest();
      return st.inFlight === 0 && st.abandoned === 0;
    });
  } finally {
    cap.restore();
    await s.close();
  }
});

test("the abandoned list is capped, evicting the oldest", () => {
  const cap = captureWarn();
  const now = Date.now();
  try {
    for (let i = 0; i < 101; i++) {
      __stallWatchTestHooks.recordAbandoned(900_000 + i, { method: "GET", path: `/api/cap${i}`, startedAt: now, abandonedAt: now });
    }
    assert.equal(__stallWatchStateForTest().abandoned, 100);
    assert.ok(cap.lines.some((l) => l.includes("dropping oldest") && l.includes("/api/cap0 ")));
  } finally {
    __stallWatchTestHooks.sweepAbandoned(now + 2 * 60 * 60 * 1000);
    cap.restore();
  }
  assert.equal(__stallWatchStateForTest().abandoned, 0);
});

test("an abandoned handler that never settles is dropped after an hour", () => {
  const cap = captureWarn();
  const now = Date.now();
  try {
    __stallWatchTestHooks.recordAbandoned(950_001, { method: "POST", path: "/api/stuck", startedAt: now, abandonedAt: now });
    __stallWatchTestHooks.sweepAbandoned(now + 30 * 60 * 1000);
    assert.equal(__stallWatchStateForTest().abandoned, 1, "still kept at 30 minutes");
    __stallWatchTestHooks.sweepAbandoned(now + 61 * 60 * 1000);
  } finally {
    cap.restore();
  }
  assert.equal(__stallWatchStateForTest().abandoned, 0);
  assert.ok(cap.lines.some((l) => l.includes("never settled POST /api/stuck")));
});
