#!/usr/bin/env node
// Stage 1 of the Creates content-library pipeline: read the source directory,
// ffprobe every video, derive a display title, and write a DRAFT manifest for
// a human to correct.
//
// The titles this produces are a starting point, not an answer. Filenames like
// `bet_x_nissan__the_pull_up__v1 (1080p).mp4` carry real structure, so most come
// out right — but the heuristic cannot know that `thd` means The Home Depot or
// that `se_x_bet_r7.m4v` was ever a finished piece. Read the draft before
// anything gets transcoded; that review is what makes the gallery look curated.
//
//   node scripts/creates-library/probe.mjs [sourceDir]
//
// Writes scripts/creates-library/manifest.draft.json

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_SOURCE = "/Volumes/Crucial X10/FullScale Content";
const OUT = path.join(HERE, "manifest.draft.json");
const OVERRIDES = path.join(HERE, "overrides.json");
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);

// ── Title derivation ────────────────────────────────────────────────────────

// Tokens that stay upper-case. Matched case-insensitively against whole words
// only, so "us" inside "focus" is untouched.
const ACRONYMS = new Set([
  "bet", "mtv", "vma", "vmas", "jpmc", "jpm", "qvc", "tv", "hbc", "us", "uk",
  "nca&t", "naacp", "abff", "ep", "cta", "ceo", "d2c", "hd", "sd", "rb",
]);

// Left lower-case unless first or last word.
const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of",
  "on", "or", "the", "to", "vs", "with",
]);

// Brands whose canonical casing the heuristic cannot guess. Keyed by the
// normalized token as it appears in filenames.
const BRAND_CASING = {
  "bet": "BET", "mtv": "MTV", "jpmc": "JPMC", "jpm": "JPM", "qvc": "QVC",
  "naacp": "NAACP", "abff": "ABFF", "lego": "LEGO", "thd": "The Home Depot",
  "hu": "Howard University", "ww": "WW", "whtwrks": "WHTWRKS",
  "disneypixar": "Disney/Pixar", "mcdonalds": "McDonald's",
  "dennys": "Denny's", "loreal": "L'Oréal", "l'oréal": "L'Oréal",
  "vegansmart": "VeganSmart", "cerave": "CeraVe", "linkedin": "LinkedIn",
  "deleon": "DeLeón", "moet": "Moët", "smirnoff": "Smirnoff",
  "seagrams": "Seagram's", "nike": "Nike", "walmart": "Walmart",
  "walgreens": "Walgreens", "doritos": "Doritos", "cadillac": "Cadillac",
  "nissan": "Nissan", "vaseline": "Vaseline", "gilead": "Gilead",
  "smashbox": "Smashbox", "toms": "TOMS", "keds": "Keds", "chase": "Chase",
  "martell": "Martell", "nowness": "NOWNESS", "rockstar": "Rockstar",
};

function titleCase(words) {
  return words
    .map((w, i, arr) => {
      const bare = w.replace(/[^a-z0-9&'’]/gi, "").toLowerCase();
      if (BRAND_CASING[bare]) return BRAND_CASING[bare];
      if (ACRONYMS.has(bare)) return w.toUpperCase();
      // Possessives: "vma's" is the acronym VMA plus a suffix, and matching the
      // whole token against the acronym list misses every one of them.
      const poss = bare.match(/^(.+?)['’]s$/);
      if (poss && (BRAND_CASING[poss[1]] || ACRONYMS.has(poss[1]))) {
        return (BRAND_CASING[poss[1]] || poss[1].toUpperCase()) + "'s";
      }
      if (i !== 0 && i !== arr.length - 1 && SMALL_WORDS.has(bare)) return bare;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/**
 * Filename → { title, brand, featuredRank }.
 *
 * Order matters: the featured prefix comes off before anything else, and the
 * resolution/version suffixes come off before separators are interpreted, or
 * `_v1` becomes the word "v1" in the middle of a title.
 */
export function deriveTitle(filename) {
  let s = filename.replace(/\.(mp4|mov|m4v)$/i, "");

  // "Video to Feature - 6- machine_gun_kelly..." — the space before the second
  // dash is inconsistent in the source, so both forms are matched.
  let featuredRank = null;
  const feat = s.match(/^Video to Feature\s*-\s*(\d{1,2})\s*-\s*/i);
  if (feat) {
    featuredRank = Number(feat[1]);
    s = s.slice(feat[0].length);
  }

  // Trailing "(1080p)", "(Original)", "(1)" and stacked combinations.
  s = s.replace(/\s*\((?:\d{3,4}p|Original|\d)\)\s*/gi, " ").trim();
  // A stray ".mp4"/".mov" mid-name — several sources were renamed carelessly.
  s = s.replace(/\.(mp4|mov|m4v)(?=[_\s]|$)/gi, " ");
  // Version/finalcut tokens and delivery-format suffixes, at the end only.
  // "-hd"/"-sd" ride directly on the last word (`warby_parker-hd`), so they get
  // their own pass rather than sharing the separator class.
  s = s.replace(/[_\s-]+(v\d+|fc\d+|final|r\d+)\s*$/gi, "");
  s = s.replace(/-(hd|sd)\s*$/gi, "");
  // Dangling separators the strips above can leave behind.
  s = s.replace(/[_\s-]+$/g, "");

  // Plus signs come from web-download filenames and are word separators.
  s = s.replace(/\+/g, " ");
  // "__" is a phrase break in this corpus ("bet_x_nissan__the_pull_up").
  s = s.replace(/_{2,}/g, " — ").replace(/_/g, " ");
  // A hyphen with spaces around it is a separator, not a compound word.
  s = s.replace(/\s+-\s+/g, " — ");
  // Fully hyphenated names ("whtwrks-2025-sizzle-reel-30s-20250227") have no
  // other separator to work with, so hyphens are all they have. Only applied
  // when nothing else broke the name up, to protect real compounds.
  if (!/\s/.test(s) && (s.match(/-/g) || []).length >= 2) s = s.replace(/-/g, " ");
  s = s.replace(/\s{2,}/g, " ").trim();

  // "brand x brand" → "brand × brand", only between words.
  s = s.replace(/(\S)\s+x\s+(\S)/gi, "$1 × $2");

  const words = s.split(" ").filter(Boolean);
  let title = titleCase(words);
  // titleCase runs per word, so an em-dash standing alone gets capitalized into
  // nothing harmful, but tidy the spacing it leaves.
  title = title.replace(/\s*—\s*/g, " — ").replace(/\s{2,}/g, " ").trim();
  // Two separators in a row ("walmart__-_juneteenth" → "— -") read as damage.
  title = title.replace(/—\s*[-–—]/g, "—").replace(/[-–]\s*—/g, "—");
  title = title.replace(/^\s*[—-]\s*|\s*[—-]\s*$/g, "").trim();

  const first = (words[0] || "").replace(/[^a-z0-9&'’]/gi, "").toLowerCase();
  const brand = BRAND_CASING[first] || (ACRONYMS.has(first) ? first.toUpperCase() : null);

  return { title, brand, featuredRank };
}

/**
 * The stable identifier for a piece: object key, filename, and URL.
 *
 * Derived from the SOURCE FILENAME, never from the title. A title is editable
 * display text — the moment someone fixes a typo in it, a title-derived slug
 * would change, orphaning every transcoded file and every uploaded object key
 * and breaking any link already shared. The source filename is the one thing
 * this pipeline never rewrites.
 */
export function slugify(sourceFile, taken) {
  let base = sourceFile
    .replace(/\.(mp4|mov|m4v)$/i, "")
    // Featured pieces are just renamed library files; keying on the prefix
    // would change the id if the featured set is reshuffled.
    .replace(/^Video to Feature\s*-\s*\d{1,2}\s*-\s*/i, "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
  if (!base) base = "untitled";
  // Distinct files can still normalize to the same string — two encodes of one
  // spot differing only by a stripped version token. Suffix rather than
  // silently overwrite an object key.
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  taken.add(slug);
  return slug;
}

// ── Probe ───────────────────────────────────────────────────────────────────

async function ffprobe(file) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name:format=duration,size",
    "-of", "json",
    file,
  ], { maxBuffer: 1024 * 1024 });
  const j = JSON.parse(stdout);
  const st = (j.streams && j.streams[0]) || {};
  const fm = j.format || {};
  return {
    width: st.width ?? null,
    height: st.height ?? null,
    codec: st.codec_name ?? null,
    durationSec: fm.duration ? Number(Number(fm.duration).toFixed(2)) : null,
    sizeBytes: fm.size ? Number(fm.size) : null,
  };
}

async function main() {
  const sourceDir = process.argv[2] || DEFAULT_SOURCE;

  let entries;
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    console.error(`Cannot read source directory: ${sourceDir}\n  ${err.message}`);
    process.exit(1);
  }

  // Top level only — `_duplicates/` is a sibling directory and is skipped by
  // isFile(), which is the whole reason the dupes were moved rather than deleted.
  const files = entries
    .filter((e) => e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  // Human corrections. Applied on every run so re-probing never destroys them —
  // the draft manifest is a build artifact, overrides.json is the source of truth
  // for anything a person decided.
  let overrides = {};
  try {
    overrides = JSON.parse(await fs.readFile(OVERRIDES, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  console.log(`Probing ${files.length} videos in ${sourceDir}\n`);

  const taken = new Set();
  const videos = [];
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const name = files[i];
    const full = path.join(sourceDir, name);
    const derived = deriveTitle(name);
    const ov = overrides[name] || {};

    const title = ov.title ?? derived.title;
    const brand = ov.brand ?? derived.brand;
    // `??` would keep a rank when the override says null, which is exactly how a
    // piece gets un-featured — so this one asks whether the key is present.
    const featuredRank = "featuredRank" in ov ? ov.featuredRank : derived.featuredRank;
    const slug = slugify(name, taken);

    const row = { slug, title, brand, featuredRank, sourceFile: name };
    try {
      Object.assign(row, await ffprobe(full));
    } catch (err) {
      row.probeError = err.message.split("\n")[0].slice(0, 200);
      failed++;
    }
    videos.push(row);

    const mark = row.probeError ? "!" : featuredRank ? String(featuredRank).padStart(2) : "  ";
    process.stdout.write(
      `${String(i + 1).padStart(3)}/${files.length} ${mark}  ${row.title}\n`,
    );
  }

  // Featured first in rank order, then everything else alphabetically. This is
  // the order a reviewer wants to read, and stage 4 re-sorts for the page.
  videos.sort((a, b) => {
    if (a.featuredRank && b.featuredRank) return a.featuredRank - b.featuredRank;
    if (a.featuredRank) return -1;
    if (b.featuredRank) return 1;
    return a.title.localeCompare(b.title);
  });

  // Renumber contiguously. Dropping a piece from the featured set leaves a hole
  // in the source numbering, and a hole would render as a gap in the grid order.
  const featured = videos.filter((v) => v.featuredRank != null);
  featured.forEach((v, i) => { v.featuredRank = i + 1; });
  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceDir,
    count: videos.length,
    featuredCount: featured.length,
    videos,
  };
  await fs.writeFile(OUT, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(`\nWrote ${OUT}`);
  console.log(`  ${videos.length} videos, ${featured.length} featured, ${failed} probe failures`);

  // Post-renumber this should be unfalsifiable, so a failure here means the sort
  // and the renumber disagree — worth shouting about rather than shipping.
  const ranks = featured.map((v) => v.featuredRank);
  const contiguous = ranks.every((r, i) => r === i + 1);
  if (!contiguous) console.log(`  WARNING: featured ranks are not 1..${featured.length}: ${ranks.join(", ")}`);

  const unknownOverrides = Object.keys(overrides)
    .filter((k) => !k.startsWith("_") && !files.includes(k));
  if (unknownOverrides.length) {
    console.log(`  WARNING: ${unknownOverrides.length} override key(s) match no file:`);
    for (const k of unknownOverrides) console.log(`    ${k}`);
  }

  const totalBytes = videos.reduce((n, v) => n + (v.sizeBytes || 0), 0);
  const totalSec = videos.reduce((n, v) => n + (v.durationSec || 0), 0);
  console.log(`  ${(totalBytes / 1e9).toFixed(1)} GB, ${(totalSec / 60).toFixed(0)} minutes of runtime`);
  console.log(`\nReview the titles in that file before running transcode.`);
}

// Only run when invoked directly, so the derivation helpers can be unit-tested.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
