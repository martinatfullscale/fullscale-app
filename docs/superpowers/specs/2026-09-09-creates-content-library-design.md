# FullScale Creates — content library

**Date:** 2026-09-09
**Status:** approved, implementation starting with the probe stage

## Problem

The Creates page showcases nine Vimeo videos from `vimeo.com/whtwrks`, hardcoded in
`VIDEO_SHOWCASE` at `client/src/pages/FullScaleCreates.tsx:22`. The real portfolio — 162
finished pieces, ~9.6 GB of masters — lives on an external drive and is not on the site at
all.

We want that portfolio hosted on FullScale infrastructure: twelve chosen pieces featured on
the Creates page, the remaining 150 browsable behind a "see more".

## Source material

`/Volumes/Crucial X10/FullScale Content/` — 162 video files after de-duplication.

Twelve are named `Video to Feature - N - <original name>` for N in 1..12. Those are the
featured set and their number is the display order.

Nine byte-identical duplicates (confirmed by full MD5, 454 MB) were moved to
`_duplicates/` on 2026-09-09. The library is the 162 files remaining at the top level.
`_duplicates/` is excluded from every stage.

Masters are not web deliverables: six are 2160p, the largest single file is 273 MB, and the
featured twelve alone are ~1 GB.

## Decisions

**Hosting: self-host on GCS Object Storage.** Chosen over Vimeo and over a managed video CDN
because the content should live on FullScale infrastructure rather than a third party.

**Upload path: presign + direct PUT.** `server/lib/objectStorage.ts:6` authenticates through
the Replit sidecar at `127.0.0.1:1106`, which does not exist outside Replit — so a local
machine cannot write to the bucket directly. `POST /api/upload/presign`
(`server/routes.ts:6716`) issues a signed URL from inside the deployment; the local machine
then PUTs straight to Google. Bytes never transit the Replit container.

**Manifest: static JSON at `client/public/creates-library.json`.** Not bundled — the client
is a single ~2.8 MB chunk and 162 entries do not belong in it; this is the same reasoning
that put the i18n catalogs in `client/public/locales/`. Not a database table — that means a
new table and a migration, and a skipped migration step took the Reel Builder down on
2026-09-09. If updating without a deploy is wanted later, the manifest moves to Object
Storage and the fetch URL changes; nothing else does.

**"See more" is its own route, `/creates/work`.** 150 videos is a page, not an accordion, and
a route is linkable.

**Transcode target: 1080p max, H.264, CRF 23, AAC 128k, `+faststart`.** `+faststart` moves
the moov atom to the head of the file so playback begins before the download finishes;
without it a 40 MB clip buffers to completion before the first frame. Hardware encoding via
`h264_videotoolbox` where available — for showreel playback the quality difference against
libx264 is not visible, and it turns a multi-hour job into roughly forty minutes.

## Pipeline

Four stages, each independently runnable, each writing an artifact the next stage reads. Run
locally against the external drive.

### Stage 1 — probe (`scripts/creates-library/probe.mjs`)

Reads the source directory. For each video, ffprobes duration, dimensions, codec and size,
derives a display title and a brand from the filename, and assigns a stable slug.

Writes `scripts/creates-library/manifest.draft.json`.

Title derivation is a heuristic over filenames like
`bet_x_nissan__the_pull_up__v1 (1080p).mp4` → `BET × Nissan — The Pull Up`. It strips the
resolution suffix, the `_v1`/`_fc1` version tokens and the `Video to Feature - N - ` prefix;
maps `__` to an em-dash phrase break and `_` to a space; title-cases with a small-word
exception list; and upper-cases a known-acronym list (BET, MTV, VMA, JPMC, QVC, NCA&T, TV,
R&B, UK, US, HBC). It will get most right and some wrong.

The draft is reviewed by hand before anything is transcoded. This is the only manual stage
and it is what decides whether the gallery reads as curated or as scraped.

### Stage 2 — transcode (`scripts/creates-library/transcode.mjs`)

Reads the reviewed manifest. For each entry, writes to a local output directory:

- `<slug>.mp4` — scaled so the long edge is at most 1920, even dimensions, H.264, CRF 23
  (or videotoolbox equivalent), AAC 128k, `+faststart`
- `<slug>.jpg` — poster frame at 10% of duration, long edge 1280

Idempotent: an output that already exists and is newer than its source is skipped, so the
stage can be interrupted and resumed.

### Stage 3 — upload (`scripts/creates-library/upload.mjs`)

For each output file: request a signed URL from `POST /api/upload/presign`, PUT the bytes,
confirm. Object keys are `creates-library/<slug>.mp4` and `creates-library/<slug>.jpg`.
Records the resulting public path on each manifest entry.

Idempotent: entries that already carry a confirmed URL are skipped.

### Stage 4 — publish (`scripts/creates-library/publish.mjs`)

Writes the final `client/public/creates-library.json` — the manifest minus local paths and
probe scratch. Committed to the repo.

## Manifest shape

```jsonc
{
  "generatedAt": "2026-09-09T00:00:00.000Z",
  "count": 162,
  "videos": [
    {
      "slug": "bet-x-nissan-the-pull-up",
      "title": "BET × Nissan — The Pull Up",
      "brand": "BET",
      "featuredRank": null,        // 1..12 for the featured set, null otherwise
      "durationSec": 91.3,
      "width": 1920,
      "height": 1080,
      "videoUrl": "/storage/creates-library/bet-x-nissan-the-pull-up.mp4",
      "posterUrl": "/storage/creates-library/bet-x-nissan-the-pull-up.jpg"
    }
  ]
}
```

`sourceFile`, `sizeBytes` and `codec` exist in the draft and local manifests for the
pipeline's own use and are stripped by stage 4.

## Page changes

**`client/src/pages/FullScaleCreates.tsx`**

`VIDEO_SHOWCASE` (nine Vimeo entries, `:22`) is deleted. The showcase section at `:269`
renders the twelve entries with `featuredRank` set, ordered by rank, fetched from the
manifest. The existing lightbox and `activeVideo` state are kept; the player element changes
from a Vimeo embed to a `<video controls poster={posterUrl}>`.

A "See more work" block is added below the showcase, linking to `/creates/work`.

**`client/src/pages/CreatesWork.tsx`** (new)

A poster grid of all 162, newest-first by default, with the same lightbox. Route registered
in `client/src/App.tsx` alongside the existing `/creates` entry.

**`client/src/content/creates.en.ts` and `creates.ar.ts`**

`showcase.descriptions` is an array zipped positionally to the showcase videos
(`FullScaleCreates.tsx:102`). Both locales currently hold nine. Both need twelve, or the
last three cards render without a description.

Back-catalogue titles stay in English in both locales. They are brand and campaign names —
the same rule already applied to proper nouns elsewhere in the localized pages.

## Error handling

- A video whose ffprobe fails is recorded in the draft with `"probeError"` and excluded from
  later stages rather than aborting the run.
- A failed transcode leaves no partial output: ffmpeg writes to `<slug>.mp4.partial` and the
  file is renamed only on a zero exit code.
- A failed upload leaves the manifest entry without a URL, so a re-run retries exactly that
  entry.
- The page treats a missing manifest as an empty showcase and renders the rest of the page —
  a fetch failure must not blank the Creates page.
- `<video>` elements get an `onError` that falls back to the poster, so one bad object key
  degrades one card.

## Testing

- Probe: run against a fixture directory of five files with known durations; assert derived
  slugs are unique and stable across runs, and that `Video to Feature - N -` maps to
  `featuredRank: N`.
- Transcode: assert the output's `moov` atom precedes `mdat` (the `+faststart` guarantee),
  that the long edge is ≤1920, and that a poster exists and is non-empty.
- Publish: assert every entry has both URLs and that exactly twelve have a `featuredRank`,
  numbered 1..12 with no gaps.
- Page: the showcase renders twelve cards in rank order; a manifest fetch failure renders
  the page without the showcase rather than throwing.

## Out of scope

Editing the library from the admin UI, per-video analytics, search and filtering on
`/creates/work`, and captions or transcripts. The manifest shape leaves room for all of
them.
