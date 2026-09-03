# Design brief — Story Clip Editor

**For:** Claude Design
**Replaces:** `client/src/components/ClipStudio.tsx` (2,265 lines)
**Mounted from:** `client/src/pages/ClipsAndReels.tsx:525`, `client/src/components/EditorialClips.tsx:1140`
**Target feel:** CapCut / Instagram Edits — a timeline you scrub, cut and stack, not a form you fill in.

---

## 1. The one-sentence problem

A creator opens a story clip expecting an editor and gets a settings panel. There is a video, there are six tabs of controls, and there is a thin strip under the player that looks like a timeline but is only a scrubber. Nothing on screen can be grabbed, split, dragged or stacked. The word people reach for is "it doesn't feel like CapCut," and they are right — it isn't one.

---

## 2. What is actually there today (verified, with line numbers)

Read this section before designing anything. Several of the obvious assumptions are wrong in both directions.

### The shape of the thing

`ClipStudio` is a full-screen modal (not a route — no deep link, no browser back) that edits **exactly one** editorial clip. Its whole contract is five props in, one payload out:

```ts
interface Props {                                    // ClipStudio.tsx:113
  clip: ClipShape; videoId: number; onClose: () => void;
  onApply: (payload: {
    aspect: "9:16" | "16:9"; captionsEnabled: boolean;
    captionStyle: string; captionSettings: Record<string, number | string>;
    edits: StudioEdits;
  }) => Promise<void>;
}
```

Everything a creator can change lives in one flat object with eight optional fields — no tracks, no layers, no z-order:

```ts
interface StudioEdits {                              // ClipStudio.tsx:75
  wordCuts?: WordCut[];
  silenceCut?: { enabled; thresholdDb; minDurationSec; paddingSec } | null;
  speedRamps?: Array<{ start; end; rate }>;
  captionEdits?: Array<{ start; end; text }>;
  textOverlays?: TextOverlayEdit[];
  broll?: Array<{ assetId; start; end; fit; scale; x; y; muted; motion? }>;
  music?: { assetId; volume; ducking; duckAmountDb; fadeInSec; fadeOutSec } | null;
  stabilization?: { enabled; strength } | null;
}
```

The six tools (`Transcript | Captions | Text | B-Roll | Audio | Motion`, `ClipStudio.tsx:135`) are mutually exclusive left-panel tabs. Switching tools changes the form; the video and the strip never change.

### Uploading own footage — the complaint is half wrong, and the half that's right is worse

**It is possible.** `<UploadButton kind="broll_video" accept="video/*,image/*" label="Upload footage or a still" />` at `ClipStudio.tsx:1746`, plus a music upload at `:1832`. Both hit `POST /api/media-assets`.

**Why nobody finds it:** the B-Roll panel opens on the *Stock* tab — `useState<"mine"|"stock"|"ai">("stock")` at `:1376` — and the tab order is `["stock", "ai", "mine"]` with the creator's own files last, behind a label that names storage ("Uploads") rather than the action.

**The part that is a real bug, not a UX miss:** on an **assembled** story clip — one carrying ≥2 narrative beats, which is what the editorial pipeline produces by default — the entire edit stack is silently dropped at render:

```ts
// server/lib/remix/editorialAutoPipeline.ts:1088
if (validClipSegments(clip)) {
  warnings.push("Edits (b-roll, music, speed, silence removal, stabilization) apply to single-range clips only — …");
  return { graph: null, warnings };
}
```

So a creator uploads footage into a story clip, **sees it in the preview**, and gets nothing in the export. The UI surfaces this only as small amber print after the fact (`ClipStudio.tsx:895`). Fixing the perception problem without fixing this makes it worse — more people will hit it.

**And the placed footage can't be aimed.** `BrollCut` has `start`/`end` on the *output* timeline but no `srcStart`/`srcEnd` (`editStack.ts:68`). You cannot choose which part of your own 90-second file gets used — always the head. The client preview *does* offset it (`ClipStudio.tsx:405`), so the preview and the render disagree about which frames play. Insertion is a fixed 3-second block at the playhead (`addAt`, `:1533`), and after insertion there is no drag and no resize — only full-frame/PiP, a Ken Burns cycle, and delete.

### Cutting — inverted from what you'd expect

- **Can** cut into the middle: striking transcript words and removing silence compile through `compileTimeline()` into real `TimelineSegment[] { srcStart, srcEnd, rate }` and render as trim/atrim + setpts/atempo + concat, so audio and video stay locked (`editStack.ts:135`, `:392`). **The razor already exists in the engine** — it is just spelled "delete these words."
- **Cannot** trim the ends: `apply()` (`:476`) sends no `clipStart`/`clipEnd` at all. The server's trim branch at `routes.ts:15175` has no caller anywhere in the client.

### Layers — they exist, and they're better than the UI admits

The editorial render chain is a real composite:

```
[0:v] stabilize → retime(segments) → b-roll overlay(s) → product sprites → crop/scale → text PNGs → captions → [vout]
[0:a] retime → duck → mix(music bed) → [aout]              // editStack.ts:13
```

B-roll cuts are ffmpeg `overlay` nodes gated by `enable='between(t,start,end)'` (`editStack.ts:501`) — **N of them stack**. Text overlays are rasterized PNGs composited after the crop (`:529`), one node each. Music is a full bed model with sidechain ducking.

**What the engine cannot do:** change the base clip's duration, replace the base footage, or anchor a layer to anything but the one base clip's timeline.

### Everything else the tools can't do

| Tool | Real ceiling |
|---|---|
| Transcript | One word per click (no drag-select, no sentence select), no reordering, no paste-in correction. "Undo N" clears **all** word cuts — there is no undo stack anywhere in the file. Dead entirely if the video has no transcript (`:1005`). |
| Captions | 3 fixed styles, size/position sliders, accent colour. `wordsPerPhrase` and `outline` are in the payload but have **no UI writer**. No font, no per-caption positioning, no animation. |
| Text | `x` is hardcoded to 0.5 and nothing ever writes it (`:1173`) — three canned vertical positions only. No drag-on-video, no font, no fade, no rotation. |
| B-Roll | Max 8 cuts (`routes.ts:15294`). See above. |
| Audio | One music bed, max. No control over the base clip's own audio level. |

---

## 3. What to design

Design **an editor**, and let the six tools become properties of what's selected on the timeline rather than modes the whole screen enters.

### 3.1 The core move: make the timeline the object

Today the strip at `ClipStudio.tsx:834` draws cut regions in red and silence in amber and accepts click-to-scrub. That is 20% of a timeline. Design the rest:

- **A real playhead** with frame-accurate scrub, keyboard transport (space, J/K/L, ←/→ by frame, shift+← by second), and a visible current-time readout.
- **A filmstrip** under the base track. The generation pattern is already proven in the repo — `VideoPreviewModal.generateThumbnails()` (`:88`) seeks the `<video>`, awaits `seeked`, `drawImage` to a canvas, `toDataURL`. `/storage/*` serves media with full HTTP Range support (`server/index.ts:163`) so seeking works. **Do not** design around WebCodecs or ffmpeg.wasm — neither exists in this codebase and adopting either is a separate decision.
- **A razor.** It is a *labeling* change on the base track, because the engine already models the result as `TimelineSegment[]`. A split at the playhead is one more segment boundary. Keep "strike these words" as a second path to the same operation — it's genuinely good and nothing else does it.
- **Trim handles on the base clip's ends**, wired to the server branch that already exists and has never been called.

### 3.2 Tracks, honestly scoped

The engine gives you exactly this much, and no more:

```
V2   [ text ] [ text ]          ← rasterized PNG overlays, N of them
V1   [ b-roll ]   [ b-roll ]    ← overlay nodes, N of them, max 8
V0   ████████████████████████   ← the base clip. Fixed source. Splittable, retimeable.
A1   [ music bed ]              ← exactly one, with ducking
```

Design **that**, drawn as real stacked tracks. Do not design free-floating layers, blend modes, opacity, keyframes or transitions inside a story clip — the filtergraph has no nodes for them and promising them in a design costs a render-engine rewrite.

What the tracks buy immediately, all of it renderable today:
- Drag a b-roll cut along V1 and resize it (currently: fixed 3s, no drag, no resize).
- **Set an in-point on the b-roll source** — add `srcStart`/`srcEnd` to `BrollCut` and a `trim`/`setpts` on that input. This also fixes the preview-vs-render divergence.
- Drag text on V2 and drag it on the video canvas to set `x` (the field exists and is frozen at 0.5).

### 3.3 The media bin

The abstraction already exists and is shared: `media_assets` rows arrive from upload, webcam, stock import (`routes.ts:11885`) and AI generation (`aiGeneration.ts:430`) into one pool. Design it as **one bin with source filters**, not four tabs — and **default to the creator's own footage whenever they have any**. Stock-first is a deliberate choice recorded in a code comment; it is also precisely what reads as "this thing won't take my video."

Drag from bin → track. Not "click Add and it lands at the playhead for 3 seconds."

### 3.4 Say the truth about assembled clips

Whatever the visual design, the multi-beat gate must be visible **before** work is lost, not as amber small print after render. Two acceptable designs — pick one and show it:
- The layer tracks are visibly unavailable on a multi-beat clip, with a one-click **"Collapse to one range"** that makes them available.
- Or the beats are drawn as separate segments on V0 and layers attach per-beat (each beat already renders as its own mp4 at `editorialAutoPipeline.ts:1046`, so a per-beat graph is tractable — but this is the larger build).

### 3.5 Undo

There is no undo stack in 2,265 lines. Design one. `Cmd+Z` in an editor is not a feature, it is the floor.

---

## 4. Constraints

- **React 18 + Tailwind + shadcn + framer-motion + wouter.** Dark theme; tokens in `client/src/index.css` — `--primary: 350 96% 43%` (oxblood red), `--background: 224 71% 4%`, display face Outfit, body Inter, `--radius: 0.75rem`.
- **All rendering is server-side ffmpeg.** The client is preview + a JSON payload. Every interaction you design has to survive the round trip and be expressible in `StudioEdits`, or it needs a named engine change.
- **Preview fidelity is a stated requirement.** The current b-roll preview lies about which frames play. Whatever the design shows, the export must match.
- Uploads cap at 300 MB today (`routes.ts:11372`, Busboy, no mime validation). A resumable 8 MB-chunk path with a 4 GB cap already exists and is proven in production, but is hardwired to create library-video rows (`chunkedUpload.ts:45`) — moving media assets onto it is a small server change, not research.
- Ignore ownership/permissions questions. Out of scope by the founder's instruction.

---

## 5. Deliverables

1. Full-screen editor layout at desktop width — bin, canvas, tracks, inspector — with the track model of §3.2 drawn literally.
2. The timeline in its states: idle, scrubbing, block selected, razor armed, b-roll block being dragged, base clip mid-split.
3. The media bin, showing own-footage-first with source filters.
4. The multi-beat treatment from §3.4.
5. Inspector panels for the three selectable things: base segment, b-roll block, text block.
6. A named list of anything you designed that the current engine cannot render, so it can be costed rather than discovered.

---

## 6. Out of scope

Blend modes · opacity · keyframes · transitions inside a clip · multi-cam · colour grading · a second music bed · anything requiring client-side encode · ownership and permissions.
