#!/usr/bin/env node
// Stage 3 of the Creates content-library pipeline: push the transcoded files to
// Object Storage.
//
// Bytes go from this machine straight to Google. Object Storage authenticates
// through a Replit sidecar on 127.0.0.1 that does not exist outside the
// deployment, so the deployment signs the URL and this script PUTs to it — the
// 3.3GB never transits the container.
//
//   FS_COOKIE='connect.sid=...' node scripts/creates-library/upload.mjs [--host https://gofullscale.co] [--only <slug>]
//
// FS_COOKIE is your logged-in session, copied from DevTools → Application →
// Cookies. The presign endpoint is admin-gated and there is no other way for a
// local script to prove it is you. Nothing is stored; it lives in the process.
//
// Reads manifest.local.json, writes manifest.uploaded.json. Idempotent: an
// entry that already carries a confirmed URL is skipped, so an interrupted run
// resumes.

import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCAL = path.join(HERE, "manifest.local.json");
const OUT = path.join(HERE, "manifest.uploaded.json");
const OUT_DIR = path.join(HERE, "out");

const args = process.argv.slice(2);
const HOST = args.includes("--host") ? args[args.indexOf("--host") + 1] : "https://gofullscale.co";
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const JOBS = args.includes("--jobs") ? Math.max(1, Number(args[args.indexOf("--jobs") + 1])) : 3;
const COOKIE = process.env.FS_COOKIE;

if (!COOKIE) {
  console.error(
    "FS_COOKIE is not set.\n\n" +
    "  1. Open https://gofullscale.co logged in as an admin\n" +
    "  2. DevTools → Application → Cookies → copy the session cookie\n" +
    "  3. FS_COOKIE='connect.sid=s%3A...' node scripts/creates-library/upload.mjs\n",
  );
  process.exit(1);
}

async function presign(slug, kind) {
  const res = await fetch(`${HOST}/api/admin/creates-library/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: COOKIE },
    body: JSON.stringify({ slug, kind }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`presign ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * PUT the whole file into a resumable-upload session in one request.
 *
 * A resumable session URL accepts a single complete PUT — no chunking needed —
 * but it does need an explicit Content-Length, and Node will not infer one from
 * a stream. duplex:"half" is required to send a stream body at all.
 */
async function put(signedUrl, filePath, contentType) {
  const { size } = await fs.stat(filePath);
  const res = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(size) },
    body: createReadStream(filePath),
    duplex: "half",
  });
  if (!res.ok && res.status !== 308) {
    const body = await res.text();
    throw new Error(`PUT ${res.status}: ${body.slice(0, 200)}`);
  }
  return size;
}

async function uploadOne(video) {
  const jobs = [
    { kind: "video", file: path.join(OUT_DIR, `${video.slug}.mp4`), key: "videoUrl" },
    { kind: "poster", file: path.join(OUT_DIR, `${video.slug}.jpg`), key: "posterUrl" },
  ];
  const out = {};
  let bytes = 0;
  for (const j of jobs) {
    if (video[j.key]) { out[j.key] = video[j.key]; continue; } // already up
    await fs.access(j.file); // throws if the transcode never produced it
    const { signedUrl, serveUrl, contentType } = await presign(video.slug, j.kind);
    bytes += await put(signedUrl, j.file, contentType);
    out[j.key] = serveUrl;
  }
  return { ...out, bytes };
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(LOCAL, "utf8"));

  // Resume from a previous run's output when there is one.
  let prior = {};
  try {
    const p = JSON.parse(await fs.readFile(OUT, "utf8"));
    for (const v of p.videos) if (v.videoUrl) prior[v.slug] = v;
  } catch { /* first run */ }

  let queue = manifest.videos.map((v) => ({ ...v, ...(prior[v.slug] || {}) }));
  const all = queue;
  if (ONLY) queue = queue.filter((v) => v.slug === ONLY);
  const todo = queue.filter((v) => !v.videoUrl || !v.posterUrl);

  console.log(`${HOST} — ${todo.length} to upload, ${queue.length - todo.length} already there\n`);
  if (!todo.length) console.log("Nothing to do.");

  const done = new Map();
  const failures = [];
  let n = 0;
  let cursor = 0;
  let totalBytes = 0;

  async function worker() {
    while (cursor < todo.length) {
      const v = todo[cursor++];
      const i = ++n;
      try {
        const r = await uploadOne(v);
        done.set(v.slug, r);
        totalBytes += r.bytes;
        console.log(`${String(i).padStart(3)}/${todo.length} ok   ${(r.bytes / 1e6).toFixed(1).padStart(6)}MB  ${v.title.slice(0, 46)}`);
      } catch (err) {
        failures.push({ slug: v.slug, title: v.title, error: err.message });
        console.log(`${String(i).padStart(3)}/${todo.length} FAIL              ${v.title.slice(0, 46)}`);
        // A 403 means the cookie is wrong or expired; every subsequent attempt
        // will fail the same way, so stop rather than printing 157 identical
        // failures.
        if (/presign 40[13]/.test(err.message)) { cursor = todo.length; }
      }
    }
  }
  await Promise.all(Array.from({ length: JOBS }, worker));

  const videos = all.map((v) => {
    const r = done.get(v.slug);
    return r ? { ...v, videoUrl: r.videoUrl, posterUrl: r.posterUrl } : v;
  });
  await fs.writeFile(OUT, JSON.stringify({ ...manifest, uploadedAt: new Date().toISOString(), videos }, null, 2) + "\n", "utf8");

  const up = videos.filter((v) => v.videoUrl && v.posterUrl).length;
  console.log(`\nWrote ${OUT}`);
  console.log(`  ${up}/${videos.length} fully uploaded, ${(totalBytes / 1e9).toFixed(2)} GB sent this run`);
  for (const f of failures) console.log(`  FAILED ${f.slug}: ${f.error}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
