# Design brief — Reel Builder

**For:** Claude Design
**Replaces:** `client/src/components/ReelBuilder.tsx` (732 lines)
**Mounted from:** `client/src/pages/Library.tsx:2142`, `client/src/pages/ClipsAndReels.tsx:556`
**Target feel:** a Premiere-grade assembly timeline — pick fast, drop on a track, cut anywhere, stack something on top.

---

## 1. The one-sentence problem

The Reel Builder is a modal assembler wearing a timeline's clothes. Blocks sit in a flex row in array order, you can shorten them from the ends, and that is the entire edit vocabulary. You cannot cut into a block, you cannot stack anything on it, you cannot see the reel before you commit to a render, and closing the modal throws the whole composition away.

---

## 2. What is actually there today (verified, with line numbers)

### The data model is the ceiling

```ts
interface ReelItem {                                  // ReelBuilder.tsx:39
  id; source: "clip" | "moment" | "asset";
  clipId?; clipSource?; assetId?;
  videoId; videoTitle; label; thumbnailPath?;
  boundStart; boundEnd;      // the outer limits of the source range
  trimStart; trimEnd;        // the current in/out
  isAssembled?; isImage?;
}
```

**One item = one contiguous range of one source.** There is no `startAtSec`, so a block's position on the timeline is implied by its index in the array. There is no track field. There is no representation for two pieces of one source.

The whole composition is `const [order, setOrder] = useState<ReelItem[]>([])` (`:90`). **Not persisted.** Close the modal and it's gone — no draft, no autosave, no reel document. The only durable artifact is the stitch plan created at build time (`routes.ts:16572`).

### The timeline is a flex row

```tsx
<div className="h-full flex items-stretch gap-1">{order.map(...)}</div>   // :562
```

Inside a fixed `h-[132px] overflow-x-auto` container. Block width is `Math.max(64, dur(it) * 8)` — **8 px per second, fixed, no zoom**, so a 3-minute reel is 1440 px of horizontal scroll with no way to see it whole. No track header. No second row. No vertical axis at all.

### Every edit gesture that exists

| Gesture | Code |
|---|---|
| Trim from an end | `beginTrim(e, index, "left" \| "right")` — `:198`. `MIN_DUR = 1` second. |
| Reorder | HTML5 drag, or `nudge(i, ±1)` chevrons |
| Remove | `removeAt(i)` |

That's it. `"split"`, `"razor"` and `"cut at"` appear **nowhere** in the file. The `Scissors` icon imported at `:5` is used once, at `:591`, as a read-only "this block is trimmed" badge.

### No playhead, no preview, no audio

There is exactly one `<video>` element in the file (`:709`) and it is the **webcam viewfinder**. The assembled reel is never played back before the render job is submitted. Trimming gives you a number (`fmt(dur(it))`, `:590`) — never a frame at the new in-point. The block backdrop is a static `thumbnailPath` at 40% opacity, and uploaded blocks never get one (the upload endpoint doesn't write `thumbnailPath`), so own footage shows as a grey rectangle.

Zero occurrences of volume / mute / gain / fade / ducking. Audio is decided server-side: `normalizeAudio: multiSource && !ps.isImage` (`routes.ts:16645`), no client input.

### The renderer, and what it forbids

```ts
interface StitchSegment {                             // clipStitcher.ts:20
  start; end; transitionIn: "cut" | "crossfade" | "branded_wipe";
  transitionDuration?; sourcePath?; normalizeAudio?; isImage?;
}
```

`stitchSegments()` extracts each segment to its own mp4, then either concat-demuxes (when every transition is a cut) or chains `xfade`. **Both strictly sequential.** No overlay node. No second video input. No text input. No music input. No `editStack` call anywhere on the `/api/remix/reel` path.

Transitions are nominally three; both `crossfade` and `branded_wipe` collapse to `xfade=transition=fade` at `clipStitcher.ts:450`, and the reel route hardcodes crossfade @ 0.5 s at every junction — `branded_wipe` is unreachable from the UI.

### The two things that are cheaper than they look

**(1) The razor is free on the server.** `POST /api/remix/reel` iterates `rawItems` **in order** and pushes one plan segment per item, with no dedupe, no ordering constraint and no overlap validation. `srcKey` already dedupes by `a:${assetId}` / `v:${videoId}`. **Two items pointing at the same source with different ranges render correctly today.** The blocker is entirely client-side: nothing in the UI can create the second item.

**(2) Own footage already works here.** Unlike the clip editor, the Reel Builder genuinely accepts it — five sources all land in the same flat array: picked library clip, AI-found cross-video moment, uploaded video file (`uploadClip()`, `:250`), webcam recording, AI-generated still.

### And the things that will bite a design

- **A reel needs ≥2 items** (client `:disabled`, server `routes.ts:16552`) **and at least one library-video anchor** — `stitch_plans.videoId` is a NOT NULL FK. A creator whose reel is entirely uploads and webcam takes **cannot build one**.
- **Asset items get no captions.** `if (captionsEnabled && ps.sourceVideoId != null)` (`routes.ts:16652`) — uploaded and webcam blocks are silently caption-less even with captions on.
- **The file picker is `accept="video/*"`** — a creator cannot upload a still into a reel, though the render path handles stills (1–30 s, default 4 s, slow zoom, `routes.ts:16518`).
- **Upload timeout is 5 minutes** here, hardcoded inline, vs 30 minutes in ClipStudio. The same file succeeds in one editor and fails in the other.

---

## 3. What to design

### 3.1 Picking — the first complaint

Today: a list you toggle items in and out of, then they appear in the strip in selection order. Design the picking surface as its own considered thing:

- **A browsable bin across sources** — library clips, story clips, cross-video AI moments, uploads, webcam takes, stock, AI stills — with filters and search, not four disconnected buttons.
- **Hover-scrub the thumbnails.** The `<video>` + `drawImage` seek pattern is already proven in the repo (`VideoPreviewModal.generateThumbnails`, `:88`) and `/storage/*` supports HTTP Range, so scrubbing a thumbnail on hover works with no new dependency.
- **Set in/out before it hits the timeline** — a source monitor. Today the only way to find your in-point is to drop the block and drag its edge blind, with no frame feedback.
- **Drag from bin to track.** Multi-select and drag several.

### 3.2 The timeline — the second complaint

**Give the model a time coordinate.** `ReelItem` needs `startAtSec` and `track`. Position stops being "array index" and starts being a number, which is the change that makes everything below possible.

- **A playhead** with transport, plus a **preview monitor** that actually plays the assembly. Right now nobody sees the reel until the render lands.
- **Zoom.** 8 px/sec fixed is unusable past a minute. Zoom to fit, zoom to playhead, a scale ruler in timecode.
- **Ripple vs. overwrite** as an explicit mode, and a gap model — once blocks have real start times, they can have space between them.
- **Snapping** to playhead, to block edges, to markers.
- **Per-junction transition control.** Three exist; only one is reachable and it's hardcoded at every cut. Make it a property of the junction. (Note for costing: `crossfade` and `branded_wipe` currently render identically — a real branded wipe is engine work.)

### 3.3 The razor — the fourth complaint, and the cheapest win here

**Split at playhead → two items sharing a source: `[trimStart, p]` and `[p, trimEnd]`.** The server already renders this correctly, today, with zero backend work. Design:

- The razor as a mode and as a shortcut (`S` / `Cmd+K`), with a visible cut indicator on hover before commit.
- The seam afterward — two blocks that read as *related pieces of one source*, not two unrelated clips.
- Ripple-delete a middle piece.
- Undo. There is none.

### 3.4 Layers — the fourth complaint's other half, and the expensive one

**Be straight about this in the design: the reel renderer physically cannot composite.** `clipStitcher` is sequential concat/xfade with one input per segment and no overlay node anywhere. Layers in the Reel Builder are a **render-engine change**, not a UI change. Two costable routes:

- **(a)** Route reel rendering through a generalized `editStack` — that renderer already does b-roll PiP at arbitrary scale/x/y with a time window, rasterized text PNGs, product sprites, and a ducked music bed. It is currently bound to one base clip.
- **(b)** Stitch the base sequentially as today, then run a **second overlay pass** over the concatenated output. Cheaper; can't do per-segment effects.

Design the track model for what a reel actually wants, and mark each track with which route it needs:

```
V2   [ text ] [ text ]              ← needs (a) or (b)
V1   [ overlay / PiP / logo ]       ← needs (a) or (b)
V0   █ █ ████ █ ██████ █            ← the sequence. Splittable. Renders TODAY.
A1   [ music bed ]                  ← needs (a) or (b)
```

Ship-order matters more than completeness: **V0 + razor + playhead + preview + persistence renders today with no server work.** Everything above V0 is a second phase. Design both, label the line.

### 3.5 Persistence

Losing an entire composition on modal close is, for anyone who assembles more than three or four blocks, a bigger felt gap than the razor. Design the draft: autosave, a named reel, reopen where you left off. This probably also means the Reel Builder stops being a modal and becomes a route — there is currently no deep link to an edit session and no browser-back semantics.

---

## 4. Constraints

- React 18 + Tailwind + shadcn + framer-motion + wouter. Dark theme; tokens in `client/src/index.css` — `--primary: 350 96% 43%` (oxblood), `--background: 224 71% 4%`, Outfit display / Inter body, `--radius: 0.75rem`.
- **All rendering is server-side ffmpeg.** Zero WebCodecs, zero ffmpeg.wasm, zero MP4 demuxing in the repo. Client decode is HTML5 `<video>` + canvas `drawImage`. Design within that or name the dependency explicitly.
- The reel is submitted as a job and rendered async; the UI already has a job-poll pattern (`client/src/hooks/use-job-poll.ts`, contract in `docs/ASYNC_JOBS.md`).
- Resolve the anchor rule before designing an all-uploads flow — see the NOT NULL FK note in §2.
- Ignore ownership/permissions. Out of scope by the founder's instruction.

---

## 5. Deliverables

1. Full editor layout at desktop width: bin, source monitor, program monitor, timeline, inspector.
2. The bin with cross-source filtering and hover-scrub.
3. The timeline in its states: empty, assembling, block selected, razor armed, mid-drag with snapping, zoomed out to fit a 3-minute reel.
4. The split seam treatment (§3.3).
5. The layered track model (§3.4) with each track labeled *renders today* vs *needs engine work*.
6. The persistence/draft surface, and what the Reel Builder looks like as a route rather than a modal.
7. A phase line: what ships against today's renderer, what needs the engine change.

---

## 6. Out of scope

Colour grading · multi-cam · speed ramps on reel blocks (they exist for story clips only) · nested sequences · anything requiring client-side encode · ownership and permissions.
