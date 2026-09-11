#!/usr/bin/env node
// Stage 4 of the Creates content-library pipeline: write the manifest the page
// reads.
//
// URLs are DERIVED, not read back from the upload. The object key is fixed by
// the presign endpoint (public/creates-library/<slug>.<ext>) and the serve URL
// is a pure rewrite of it, so the address of a piece is knowable before a byte
// moves. That decouples the deploy from the upload: this manifest can ship in
// the same build as the page, and the files can land before or after.
//
// The page must therefore tolerate a URL that 404s — see the poster fallback
// in the gallery. A missing file degrades one card; it does not blank the page.
//
//   node scripts/creates-library/publish.mjs
//
// Reads manifest.local.json, writes client/public/creates-library.json.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The DRAFT, not manifest.local.json. The draft is the source of truth for what
// belongs in the library — it is what the overrides (including `exclude`) are
// applied to. manifest.local.json is a record of one transcode run and goes
// stale the moment the library membership changes.
const DRAFT = path.join(HERE, "manifest.draft.json");
const OUT_DIR = path.join(HERE, "out");
const OUT = path.resolve(HERE, "../../client/public/creates-library.json");

const serveUrl = (slug, ext) => `/storage/creates-library/${slug}.${ext}`;

async function hasOutputs(slug) {
  try {
    const [v, p] = await Promise.all([
      fs.stat(path.join(OUT_DIR, `${slug}.mp4`)),
      fs.stat(path.join(OUT_DIR, `${slug}.jpg`)),
    ]);
    return v.size > 0 && p.size > 0;
  } catch {
    return false;
  }
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(DRAFT, "utf8"));

  // A manifest entry promises a URL. Publishing one for a piece that was never
  // transcoded ships a card that can only ever 404.
  const missing = [];
  for (const v of manifest.videos) {
    if (!v.probeError && !(await hasOutputs(v.slug))) missing.push(v);
  }
  if (missing.length) {
    console.log(`Skipping ${missing.length} with no transcoded output — run transcode.mjs:`);
    for (const v of missing.slice(0, 10)) console.log(`    ${v.title}`);
    if (missing.length > 10) console.log(`    ... and ${missing.length - 10} more`);
  }
  const missingSlugs = new Set(missing.map((v) => v.slug));

  const videos = manifest.videos
    .filter((v) => !v.probeError && !missingSlugs.has(v.slug))
    .map((v) => ({
      slug: v.slug,
      title: v.title,
      brand: v.brand ?? null,
      featuredRank: v.featuredRank ?? null,
      durationSec: v.durationSec ?? null,
      width: v.width ?? null,
      height: v.height ?? null,
      videoUrl: serveUrl(v.slug, "mp4"),
      posterUrl: serveUrl(v.slug, "jpg"),
    }))
    // Featured first in rank order, then the catalogue alphabetically. The page
    // slices on featuredRank, but a stable order means a manifest diff is
    // readable in review.
    .sort((a, b) => {
      if (a.featuredRank && b.featuredRank) return a.featuredRank - b.featuredRank;
      if (a.featuredRank) return -1;
      if (b.featuredRank) return 1;
      return a.title.localeCompare(b.title);
    });

  const featured = videos.filter((v) => v.featuredRank != null);
  const ranks = featured.map((v) => v.featuredRank);
  if (!ranks.every((r, i) => r === i + 1)) {
    console.error(`Featured ranks are not 1..${featured.length}: ${ranks.join(", ")}`);
    process.exit(1);
  }
  const slugs = new Set(videos.map((v) => v.slug));
  if (slugs.size !== videos.length) {
    console.error("Duplicate slug — two pieces would share an object key.");
    process.exit(1);
  }

  await fs.writeFile(
    OUT,
    JSON.stringify({ generatedAt: new Date().toISOString(), count: videos.length, featuredCount: featured.length, videos }, null, 2) + "\n",
    "utf8",
  );
  console.log(`Wrote ${OUT}`);
  console.log(`  ${videos.length} videos, ${featured.length} featured`);
  console.log(`  URLs assume upload.mjs has run (or will) — files land at /storage/creates-library/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
