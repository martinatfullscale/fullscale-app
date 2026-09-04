/**
 * The reel editor's data model.
 *
 * THE ONE CHANGE THAT UNLOCKS EVERYTHING: an item carries `at` (its start on
 * the timeline) and `track`. Position stops being "index in the array" and
 * becomes a number.
 *
 * The old model was `ReelItem[]` laid out by DOM order in a flex row, which
 * is why the builder could not express a gap, an overlap, a second track, or
 * two pieces of one source. Everything the redesign adds — razor, ripple,
 * snapping, a playhead, layers — is downstream of having a time coordinate.
 *
 * What renders TODAY is V0 only: POST /api/remix/reel iterates the items in
 * order and emits one plan segment each, sequentially. That is also why the
 * normaliser below is not optional — a sequence track that renders as one
 * segment per item cannot contain overlaps, so the invariant is enforced in
 * the reducer rather than hoped for in the view.
 */

export type Track = "V0" | "V1" | "V2" | "A1";
export type Transition = "cut" | "crossfade" | "branded_wipe";
export type SourceKind = "library" | "moment" | "upload" | "webcam" | "stock" | "ai" | "music";

/** A thing that can go on the timeline, from any of the six sources. */
export interface BinSource {
  /** Distinct-source key, matching the server's own: a:<assetId> | v:<videoId>. */
  sk: string;
  kind: SourceKind;
  label: string;
  /** Second line on the card — "cross-video · 0.91 confidence", "118 MB". */
  meta: string;
  /** Something playable, for hover-scrub and the source monitor. */
  url: string | null;
  /** The usable span of this source, in ITS OWN time. */
  boundStart: number;
  boundEnd: number;
  videoId?: number;
  assetId?: number;
  /**
   * Where this source's time zero sits in the SOURCE VIDEO's time.
   *
   * A rendered clip's file starts at 0, but the reel route cuts a videoId
   * item out of the original video by time range — so a block covering the
   * first 6 seconds of a clip that begins 12s into its video has to publish
   * as 12→18, not 0→6. Zero for assets, which are their own file.
   */
  srcOffset: number;
  /** Set for a picked library clip, so an untrimmed one can publish by id and
   *  keep its narrative beats instead of collapsing to a flat range. */
  clipId?: number;
  clipSource?: "remix" | "editorial";
  hasSegments?: boolean;
  /** A still is held for a window rather than played. */
  isImage?: boolean;
  thumbnailPath?: string | null;
}

export interface ReelItem {
  id: string;
  /** srcKey — ties the block back to its BinSource. */
  sk: string;
  track: Track;
  /** Start on the OUTPUT timeline, seconds. */
  at: number;
  /** Source range, in the source's own time. */
  in: number;
  out: number;
  /** Transition INTO this block. Only meaningful at a butt joint. */
  tin?: Transition;
  /** Split-group identity: both halves of a razor cut share `gid`. Written
   *  explicitly rather than inferred from adjacency, so the seam survives a
   *  later move. */
  gid?: string;
  piece?: number;
  /** V2 placeholder copy. Renders nothing today — see the phase line. */
  text?: string;
}

export const MIN_ITEM_SEC = 0.5;
export const MIN_SPLIT_OFFSET = 0.4;

/**
 * A reel is a SHORT-FORM format, and the cap is the product decision that
 * keeps it one.
 *
 * Without a ceiling this becomes a general-purpose long-video editor, which
 * is not what it is for and not what the render path is tuned for. Three
 * minutes is above every short-form platform's own limit, so the cap never
 * bites a legitimate reel. Enforced in the reducer, so no path can author
 * past it, and again on the server.
 */
export const MAX_REEL_SEC = 180;

/** The output frame everything is fitted into. Portrait short-form. */
export const REEL_ASPECT = 9 / 16;

export const dur = (it: ReelItem) => Math.max(0, it.out - it.in);
export const end = (it: ReelItem) => it.at + dur(it);

export const fmtT = (s: number) => {
  const m = Math.floor(Math.max(0, s) / 60);
  const sec = Math.max(0, s) % 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
};
export const fmtClock = (s: number) => {
  const m = Math.floor(Math.max(0, s) / 60);
  const sec = Math.floor(Math.max(0, s) % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

let seq = 0;
export const newItemId = () => `ri${++seq}_${Math.floor(performance.now())}`;

export const v0Of = (items: ReelItem[]) => items.filter((i) => i.track === "V0").sort((a, b) => a.at - b.at);
export const totalOf = (items: ReelItem[]) => v0Of(items).reduce((m, i) => Math.max(m, end(i)), 0);

/**
 * Enforce the invariants, everywhere state is authored.
 *
 * Runs on every mutation, on every draft restore, and after every drag. The
 * rule that matters most is (2): the reel route emits one plan segment per
 * item in order, so two V0 items that overlap would render as a duplicated
 * stretch of footage rather than the crossfade the timeline appeared to show.
 * Clamping in the reducer is the only place that cannot be forgotten.
 *
 * `sources` is consulted so a restored draft that references a source whose
 * duration has since changed gets clamped rather than trusted.
 */
export function normalise(items: ReelItem[], sources: Map<string, BinSource>): ReelItem[] {
  const kept: ReelItem[] = [];
  for (const raw of items) {
    const src = sources.get(raw.sk);
    let it: ReelItem = { ...raw, at: Math.max(0, Number(raw.at) || 0) };
    if (src) {
      const lo = Math.max(0, src.boundStart);
      const hi = Math.max(lo, src.boundEnd);
      it.in = Math.min(Math.max(Number(it.in) || 0, lo), Math.max(lo, hi - MIN_ITEM_SEC));
      it.out = Math.min(Math.max(Number(it.out) || 0, it.in + MIN_ITEM_SEC), hi);
    } else {
      it.in = Math.max(0, Number(it.in) || 0);
      it.out = Math.max(it.in + MIN_ITEM_SEC, Number(it.out) || 0);
    }
    if (dur(it) < MIN_ITEM_SEC - 1e-6) continue;
    kept.push(it);
  }

  // V0 is a sequence: sort by start, then push each block right so it never
  // begins before the previous one ends.
  const v0 = kept.filter((i) => i.track === "V0").sort((a, b) => a.at - b.at);
  let cursor = 0;
  const withinCap: ReelItem[] = [];
  for (const it of v0) {
    if (it.at < cursor - 1e-6) it.at = cursor;
    // The cap is enforced here so no path — drop, paste, draft restore, AI
    // proposal — can author a reel past it. A block that would straddle the
    // ceiling is trimmed to it; one that starts beyond it is dropped.
    if (it.at >= MAX_REEL_SEC - MIN_ITEM_SEC) continue;
    if (end(it) > MAX_REEL_SEC) it.out = it.in + (MAX_REEL_SEC - it.at);
    if (dur(it) < MIN_ITEM_SEC - 1e-6) continue;
    withinCap.push(it);
    cursor = end(it);
  }
  // Overlay tracks are clamped to the cap too, but not sequenced — they layer.
  const rest = kept
    .filter((i) => i.track !== "V0")
    .map((i) => (end(i) > MAX_REEL_SEC ? { ...i, out: i.in + Math.max(0, MAX_REEL_SEC - i.at) } : i))
    .filter((i) => i.at < MAX_REEL_SEC && dur(i) >= MIN_ITEM_SEC - 1e-6);
  return [...withinCap, ...rest];
}

/** Times worth snapping to, in seconds. Tolerance is constant in PIXELS. */
export function snapTime(
  t: number,
  items: ReelItem[],
  playhead: number,
  pps: number,
  excludeId?: string,
): { t: number; snapped: boolean } {
  const tol = 9 / Math.max(1, pps);
  const cands = [0, playhead];
  for (const it of items) {
    if (it.id === excludeId || it.track !== "V0") continue;
    cands.push(it.at, end(it));
  }
  let best: number | null = null;
  for (const c of cands) {
    if (Math.abs(c - t) <= tol && (best === null || Math.abs(c - t) < Math.abs(best - t))) best = c;
  }
  return best === null ? { t, snapped: false } : { t: best, snapped: true };
}

/**
 * Insert onto V0, pushing everything from the insert point rightwards.
 *
 * The test is `end(i) > at`, not `i.at >= at`. With the old test, dropping at
 * 0.65s onto a block occupying 0–6 shifted nothing (that block starts at 0,
 * which is not >= 0.65), and then the sequence rule in normalise pushed the
 * NEW block past it to 6s. Dropping at the start of the reel put your clip at
 * the end of it — the "snaps into a random space" report.
 */
export function rippleInsert(items: ReelItem[], block: ReelItem): ReelItem[] {
  const len = dur(block);
  return [
    ...items.map((i) => (i.track === "V0" && end(i) > block.at + 1e-6 ? { ...i, at: i.at + len } : i)),
    block,
  ];
}

/**
 * Insert onto V0, cutting whatever is underneath.
 *
 * Fully covered items are dropped; an item overlapping the head has its `out`
 * pulled back; one overlapping the tail has both `at` and `in` pushed forward,
 * so the source stays in sync with the timeline rather than sliding.
 */
export function overwriteInsert(items: ReelItem[], block: ReelItem): ReelItem[] {
  const bStart = block.at;
  const bEnd = end(block);
  const out: ReelItem[] = [];
  for (const it of items) {
    if (it.track !== "V0") { out.push(it); continue; }
    const s = it.at;
    const e = end(it);
    if (e <= bStart + 1e-6 || s >= bEnd - 1e-6) { out.push(it); continue; }
    if (s >= bStart - 1e-6 && e <= bEnd + 1e-6) continue;               // covered
    if (s < bStart && e > bEnd) {
      // The block lands inside one item: keep the head, and add the tail back.
      const headOut = it.in + (bStart - s);
      out.push({ ...it, out: headOut });
      out.push({
        ...it,
        id: newItemId(),
        at: bEnd,
        in: it.in + (bEnd - s),
        tin: "cut",
      });
      continue;
    }
    if (s < bStart) { out.push({ ...it, out: it.in + (bStart - s) }); continue; }   // head overlap
    out.push({ ...it, at: bEnd, in: it.in + (bEnd - s) });                          // tail overlap
  }
  out.push(block);
  return out;
}

/** Remove an item and pull everything after it left by its duration. */
export function rippleDelete(items: ReelItem[], id: string): ReelItem[] {
  const target = items.find((i) => i.id === id);
  if (!target) return items;
  const len = dur(target);
  return items
    .filter((i) => i.id !== id)
    .map((i) => (i.track === "V0" && i.at >= target.at - 1e-6 ? { ...i, at: i.at - len } : i));
}

/** Remove an item and leave the hole. */
export const lift = (items: ReelItem[], id: string) => items.filter((i) => i.id !== id);

/**
 * Razor. Two items sharing one source, which the reel route already renders:
 * it iterates rawItems in order with no dedupe and no ordering constraint, and
 * srcKey dedupes by a:<id> / v:<id>. Zero backend work.
 */
export function splitAt(items: ReelItem[], id: string, cutTime: number): ReelItem[] {
  const it = items.find((x) => x.id === id);
  if (!it) return items;
  const off = cutTime - it.at;
  if (off < MIN_SPLIT_OFFSET || off > dur(it) - MIN_SPLIT_OFFSET) return items;
  const gid = it.gid ?? it.id;
  const a: ReelItem = { ...it, out: it.in + off, gid, piece: 1 };
  const b: ReelItem = {
    ...it,
    id: newItemId(),
    at: it.at + off,
    in: it.in + off,
    tin: "cut",
    gid,
    piece: 2,
  };
  return items.map((x) => (x.id === id ? a : x)).concat(b);
}

/** True at a real butt joint — not across a gap, where there is no transition. */
export const isJunction = (prevEnd: number, at: number) => Math.abs(prevEnd - at) < 0.08;

/**
 * Hand a set of picked clips to the editor route.
 *
 * "Add to reel" used to push clips straight into the modal's state. The
 * editor is a route now, so the seed travels the same way a draft does —
 * written under the route's own key and picked up by its restore path. That
 * keeps one code path for "where does the timeline come from" instead of two.
 */
export function seedReelDraft(
  reelId: string,
  clips: Array<{ clipId: number; clipSource: "remix" | "editorial"; duration: number }>,
): void {
  let at = 0;
  const items: ReelItem[] = [];
  for (const c of clips) {
    const len = Math.max(MIN_ITEM_SEC, Number(c.duration) || 0);
    items.push({ id: newItemId(), sk: `c:${c.clipSource}:${c.clipId}`, track: "V0", at, in: 0, out: len, tin: "cut" });
    at += len;
  }
  try {
    localStorage.setItem(
      `fullscale.reel-draft.v1.${reelId}`,
      JSON.stringify({ ver: 1, items, name: "Untitled reel", ph: 0 }),
    );
  } catch { /* private mode — the editor opens empty, which is recoverable */ }
}

export const KIND_LABEL: Record<SourceKind, string> = {
  library: "Library clip",
  moment: "AI moment",
  upload: "Upload",
  webcam: "Webcam",
  stock: "Stock",
  ai: "AI still",
  music: "Music",
};

/**
 * One hue per source kind. The stripe is the ONLY place kind is encoded by
 * colour, so it has to stay legible after the theme shift from the
 * prototype's light ground to the app's dark one.
 */
export const KIND_COLOR: Record<SourceKind, string> = {
  library: "#94a3b8",
  moment: "hsl(350 96% 43%)",
  upload: "#818cf8",
  webcam: "#34d399",
  stock: "#64748b",
  ai: "#f0596e",
  music: "#34d399",
};

/**
 * Every track renders now.
 *
 * V1/V2/A1 used to be drawn but dead: clipStitcher is a sequential
 * concat/xfade with no overlay node, so nothing on them could reach the
 * export. They are composited by a second ffmpeg pass over the finished reel
 * (server/lib/remix/reelOverlay.ts) which reuses the same graph builder the
 * story-clip editor has always used.
 *
 * Kept as a map rather than deleted: `branded_wipe` still renders as a plain
 * fade, so there is at least one thing left to promote, and the next track
 * added should have to declare which side it is on.
 */
export const TRACK_PHASE: Record<Track, "today" | "engine"> = {
  V0: "today",
  V1: "today",
  V2: "today",
  A1: "today",
};

export const TRACK_ROLE: Record<Track, string> = {
  V2: "text",
  V1: "overlay / PiP",
  V0: "sequence",
  A1: "music bed",
};

/** Which tracks a given source may be dropped on. */
export function tracksFor(kind: SourceKind): Track[] {
  if (kind === "music") return ["A1"];
  if (kind === "ai") return ["V0", "V1"];       // a still works as a beat or a card
  return ["V0", "V1"];
}
