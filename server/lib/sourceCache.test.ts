// The source cache has two contracts that must not bleed into each other.
// Render pipelines BLOCK until the whole file exists; the in-app player must
// NEVER wait on a download. On 2026-09-09 the player's route used the blocking
// path and held a browser on a silent connection for minutes. These tests pin
// both contracts, with the platform download replaced by a gate the test opens.

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getSourcePath,
  getPinnedSourcePath,
  peekSourcePath,
  warmSource,
  __setSourceCacheTestHooks,
} from "./sourceCache";

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(10);
  }
}

const video = (id: number): any => ({ id, platform: "youtube", youtubeId: `yt${id}`, userId: 1, filePath: null });

/** Each download call pushes a gate the test resolves true (lands) or false (fails). */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srccache-test-"));
  const gates: Array<Deferred<boolean>> = [];
  __setSourceCacheTestHooks({
    cacheDir: dir,
    download: async (_video, tempPath) => {
      const gate = deferred<boolean>();
      gates.push(gate);
      const ok = await gate.promise;
      if (ok) fs.writeFileSync(tempPath, "video-bytes");
      return ok;
    },
  });
  return { dir, gates };
}

afterEach(() => __setSourceCacheTestHooks(null));

test("getPinnedSourcePath still blocks until the download lands", async () => {
  const s = setup();
  const pinDir = fs.mkdtempSync(path.join(os.tmpdir(), "srccache-pin-"));
  let settled = false;
  const pinned = getPinnedSourcePath(video(1), pinDir).then(
    (p) => { settled = true; return p; },
    (e) => { settled = true; throw e; },
  );

  await sleep(80);
  assert.equal(settled, false, "a render pipeline must not settle — with a path or an error — before the file exists");
  assert.equal(s.gates.length, 1);

  s.gates[0].resolve(true);
  assert.ok(fs.existsSync(await pinned), "the pinned path exists once it resolves");
});

test("concurrent blocking callers share one download", async () => {
  const s = setup();
  const a = getSourcePath(video(2));
  const b = getSourcePath(video(2));
  assert.equal(s.gates.length, 1, "two callers, one download");
  s.gates[0].resolve(true);
  assert.equal(await a, await b);
});

test("warmSource never waits: preparing now, one download, ready once it lands", async () => {
  const s = setup();
  const v = video(3);

  assert.equal(warmSource(v), "preparing", "a miss answers immediately");
  assert.equal(s.gates.length, 1);
  assert.equal(warmSource(v), "preparing");
  assert.equal(s.gates.length, 1, "a second warm joins the running download");

  s.gates[0].resolve(true);
  await until(() => warmSource(v) === "ready");
  assert.ok(peekSourcePath(v), "peek returns the landed file");
  assert.equal(s.gates.length, 1, "polling to ready never started another download");
});

test("a failed warm reports failure, but a blocking caller still retries", async () => {
  const s = setup();
  const v = video(4);

  warmSource(v);
  s.gates[0].resolve(false);
  await until(() => typeof warmSource(v) === "object");

  const w = warmSource(v);
  assert.ok(typeof w === "object" && typeof w.failed === "string", "polls see the failure instead of spinning");
  assert.equal(s.gates.length, 1, "a remembered failure does not start another doomed pull");

  const blocking = getSourcePath(v);
  assert.equal(s.gates.length, 2, "getSourcePath ignores the failure memo and downloads again");
  s.gates[1].resolve(true);
  assert.ok(fs.existsSync(await blocking));
});

test("peekSourcePath never starts a download", () => {
  const s = setup();
  assert.equal(peekSourcePath(video(5)), null);
  assert.equal(s.gates.length, 0);
});
