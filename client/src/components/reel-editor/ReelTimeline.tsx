import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dur, end, fmtClock, fmtT, isJunction, KIND_COLOR, snapTime,
  MAX_REEL_SEC, MIN_ITEM_SEC, TRACK_NAME, TRACK_PHASE, TRACK_ROLE,
  type BinSource, type ReelItem, type Track, type Transition,
} from "./types";

/**
 * The reel timeline — four tracks on a real time axis.
 *
 * What this replaces was a flex row: blocks laid out by array index, 8px per
 * second fixed, no zoom, no playhead, no preview, and one gesture (drag an
 * edge). A block's position on screen was its position in a list, which is
 * why the builder could not express a gap, a split, or a second track.
 *
 *   V2  text        ┐
 *   V1  overlay/PiP ├─ hatched: clipStitcher has no overlay node. Drawn so the
 *   A1  music bed   ┘  shape is agreed before the engine work is costed.
 *   V0  sequence    ── renders today, one plan segment per item, in order.
 *
 * The razor is the cheap win and the reason V0 is first-class: POST
 * /api/remix/reel iterates items in order with no dedupe and no ordering
 * constraint, so two items pointing at one source with different ranges
 * already render correctly. Splitting is a client-side change with zero
 * backend work — the blocker was only ever that no UI could create the
 * second item.
 */

const GUTTER = 148;
const RULER_H = 26;
const LANE_H: Record<Track, number> = { V2: 44, V1: 44, V0: 64, A1: 40 };
const ORDER: Track[] = ["V2", "V1", "V0", "A1"];

export interface ReelTimelineProps {
  items: ReelItem[];
  sources: Map<string, BinSource>;
  total: number;
  playhead: number;
  pps: number;
  tool: "select" | "razor";
  snap: boolean;
  selectedId: string | null;
  onSeek: (t: number) => void;
  onSelect: (id: string | null) => void;
  /** A committed change. `token` groups a drag into one undo entry. */
  onItems: (next: (prev: ReelItem[]) => ReelItem[], label: string, token?: string) => void;
  onSplit: (id: string, at: number) => void;
  onDropSource: (sk: string, at: number, track: Track) => void;
  onScrollerReady: (el: HTMLDivElement | null) => void;
}

let dragSeq = 0;

export default function ReelTimeline(props: ReelTimelineProps) {
  const {
    items, sources, total, playhead, pps, tool, snap, selectedId,
    onSeek, onSelect, onItems, onSplit, onDropSource, onScrollerReady,
  } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [guide, setGuide] = useState<number | null>(null);
  const [razorX, setRazorX] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [dropTrack, setDropTrack] = useState<Track | null>(null);

  const canvasW = Math.max(900, (total + 12) * pps);
  const toPx = (t: number) => t * pps;

  const setScroller = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    onScrollerReady(el);
  }, [onScrollerReady]);

  /** clientX → seconds. The scroller's box is the canvas box. */
  const timeAt = useCallback((clientX: number) => {
    const el = scrollRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + el.scrollLeft) / Math.max(1, pps));
  }, [pps]);

  const v0 = useMemo(() => items.filter((i) => i.track === "V0").sort((a, b) => a.at - b.at), [items]);

  /** Ruler ticks: a step that keeps labels ~80px apart at any zoom. */
  const step = useMemo(() => {
    for (const s of [1, 2, 5, 10, 30, 60, 120]) if (s * pps >= 80) return s;
    return 300;
  }, [pps]);
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let t = 0; t * pps <= canvasW; t += step) out.push(t);
    return out;
  }, [canvasW, pps, step]);

  // ── Scrub on the ruler ───────────────────────────────────────────────
  const beginScrub = (e: React.PointerEvent) => {
    e.preventDefault();
    onSeek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => onSeek(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // ── Drag a block along the timeline ──────────────────────────────────
  const beginMove = (it: ReelItem) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(it.id);
    if (tool === "razor") return;
    const token = `move:${it.id}:${++dragSeq}`;
    const grab = timeAt(e.clientX) - it.at;
    const len = dur(it);
    /** Did the pointer actually travel? A click that only selects must not
     *  land on the undo stack — every mutation runs through normalise, which
     *  returns a fresh array, so "no change" is not caught by identity. */
    let moved = false;

    const move = (ev: PointerEvent) => {
      const raw = Math.max(0, timeAt(ev.clientX) - grab);
      // Both head and tail are tested; whichever snaps wins, so a block can
      // be butted up against the one before it OR the one after it.
      const head = snap ? snapTime(raw, items, playhead, pps, it.id) : { t: raw, snapped: false };
      const tail = snap ? snapTime(raw + len, items, playhead, pps, it.id) : { t: raw + len, snapped: false };
      let at = raw;
      let g: number | null = null;
      if (head.snapped && (!tail.snapped || Math.abs(head.t - raw) <= Math.abs(tail.t - (raw + len)))) {
        at = head.t; g = head.t;
      } else if (tail.snapped) {
        at = Math.max(0, tail.t - len); g = tail.t;
      }
      if (!moved && Math.abs(at - it.at) < 1e-4) return;
      moved = true;
      setGuide(g);
      onItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, at } : x)), `Move ${label(it)} → ${fmtT(at)}`, token);
    };
    const up = () => {
      setGuide(null);
      // Re-run the reducer once on release so the sequence rule settles — but
      // only if something actually moved.
      if (moved) onItems((prev) => prev, `Move ${label(it)}`, token);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /**
   * Shorten or lengthen a block that is ALREADY on the timeline, by dragging
   * its edge.
   *
   * This existed in the old modal (ReelBuilder's beginTrim) and was dropped in
   * the migration to this route, which left razor-then-ripple-delete as the
   * only way to shorten anything — it cannot shave less than a razor's width
   * off an end and can never give length back. With long-form sources that is
   * not a rough edge: a 65-minute video drops as a block spanning the whole
   * reel, and without this there is no gesture that can make it smaller.
   */
  const beginTrim = (it: ReelItem, edge: "in" | "out") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(it.id);
    if (tool === "razor") return;
    const token = `trim:${it.id}:${edge}:${++dragSeq}`;
    const src = sources.get(it.sk);
    const lo = src ? Math.max(0, src.boundStart) : 0;
    // A still has no real out-point — it is held for as long as you want it —
    // so it may be stretched past the 4s the bin gave it.
    const hi = src ? (src.isImage ? MAX_REEL_SEC : Math.max(lo, src.boundEnd)) : MAX_REEL_SEC;
    const t0 = timeAt(e.clientX);
    const in0 = it.in, out0 = it.out, at0 = it.at;
    let moved = false;

    const move = (ev: PointerEvent) => {
      const raw = (edge === "in" ? in0 : out0) + (timeAt(ev.clientX) - t0);
      const snapped = snap ? snapTime(raw, items, playhead, pps, it.id) : { t: raw, snapped: false };
      const want = snapped.t;
      if (!moved && Math.abs(want - (edge === "in" ? in0 : out0)) < 1e-3) return;
      moved = true;
      setGuide(snapped.snapped ? snapped.t : null);
      onItems((prev) => prev.map((x) => {
        if (x.id !== it.id) return x;
        if (edge === "in") {
          const nIn = Math.min(Math.max(want, lo), out0 - MIN_ITEM_SEC);
          // Off V0 a block holds its position, so pulling the head in has to
          // walk `at` forward by the same amount or the content slides. On V0
          // the sequence recomputes `at` anyway.
          const nAt = it.track === "V0" ? at0 : Math.max(0, at0 + (nIn - in0));
          return { ...x, in: nIn, at: nAt };
        }
        return { ...x, out: Math.max(Math.min(want, hi), in0 + MIN_ITEM_SEC) };
      }), `Trim ${label(it)}`, token);
    };
    const up = () => {
      setGuide(null);
      if (moved) onItems((prev) => prev, `Trim ${label(it)}`, token);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const label = (it: ReelItem) => sources.get(it.sk)?.label ?? it.sk;

  /** Cycle the transition into a block. Only shown at a real butt joint. */
  const cycle = (it: ReelItem) => {
    const nextOf: Record<Transition, Transition> = { cut: "crossfade", crossfade: "branded_wipe", branded_wipe: "cut" };
    const to = nextOf[it.tin ?? "cut"];
    onItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, tin: to } : x)), `Transition · ${to.replace("_", " ")}`);
  };

  // Clear the razor ghost when the tool is put away, so it does not linger.
  useEffect(() => { if (tool !== "razor") setRazorX(null); }, [tool]);

  return (
    <div className="flex-1 min-h-0 flex" data-testid="reel-timeline">
      {/* ── Gutter ── */}
      <div className="shrink-0 border-r-2 border-border" style={{ width: GUTTER }}>
        <div
          className="flex items-center px-3 border-b border-border/40 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground"
          style={{ height: RULER_H }}
        >
          Timecode
        </div>
        {ORDER.map((tr) => (
          <div
            key={tr}
            className="flex items-center gap-2 px-3 border-b border-border/40"
            style={{ height: LANE_H[tr] }}
          >
            <div className="min-w-0">
              <div className="font-display text-[13px] font-extrabold leading-none text-foreground">{TRACK_NAME[tr]}</div>
              <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">{TRACK_ROLE[tr]}</div>
            </div>
            <span
              className={`ml-auto shrink-0 px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.06em] ${
                TRACK_PHASE[tr] === "today"
                  ? "border border-primary/45 bg-primary/15 text-primary"
                  : "border border-border text-muted-foreground/70"
              }`}
              title={
                TRACK_PHASE[tr] === "today"
                  ? tr === "V0"
                    ? "Rendered by the stitcher, one plan segment per block"
                    : "Composited by the overlay pass over the finished reel"
                  : "Needs engine work"
              }
            >
              {TRACK_PHASE[tr] === "today" ? "renders today" : "needs engine"}
            </span>
          </div>
        ))}
      </div>

      {/* ── Canvas ── */}
      <div ref={setScroller} className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden">
        <div className="relative" style={{ width: canvasW }}>
          {/* Ruler */}
          <div
            className="relative bg-secondary/40 border-b border-border/40 cursor-ew-resize"
            style={{ height: RULER_H }}
            onPointerDown={beginScrub}
            data-testid="reel-ruler"
          >
            {ticks.map((t) => (
              <div key={t} className="absolute top-0 bottom-0" style={{ left: toPx(t) }}>
                <div className="absolute inset-y-0 w-px bg-border" />
                <span className="absolute left-1 top-1 font-mono text-[9.5px] tabular-nums text-muted-foreground">
                  {fmtClock(t)}
                </span>
              </div>
            ))}
          </div>

          {/* Lanes */}
          {ORDER.map((tr) => {
            const laneItems = items.filter((i) => i.track === tr);
            const engine = TRACK_PHASE[tr] === "engine";
            return (
              <div
                key={tr}
                className="relative border-b border-border/40"
                style={{
                  height: LANE_H[tr],
                  background: engine ? "hsl(var(--secondary) / 0.18)" : "hsl(var(--secondary) / 0.45)",
                }}
                onClick={(e) => {
                  if (tool === "razor") return;
                  onSelect(null);
                  onSeek(timeAt(e.clientX));
                }}
                onPointerMove={(e) => { if (tool === "razor" && tr === "V0") setRazorX(timeAt(e.clientX)); }}
                onPointerLeave={() => tr === "V0" && setRazorX(null)}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  setDropTrack(tr);
                  setDropAt(snap ? snapTime(timeAt(e.clientX), items, playhead, pps).t : timeAt(e.clientX));
                }}
                onDragLeave={() => { setDropAt(null); setDropTrack(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropAt(null);
                  setDropTrack(null);
                  const sk = e.dataTransfer.getData("application/x-fullscale-source");
                  if (sk) onDropSource(sk, snap ? snapTime(timeAt(e.clientX), items, playhead, pps).t : timeAt(e.clientX), tr);
                }}
                data-testid={`reel-lane-${tr}`}
              >
                {laneItems.length === 0 && (
                  <div className="absolute inset-2 border-2 border-dashed border-border/60 flex items-center justify-center pointer-events-none">
                    <span className="text-[11px] text-muted-foreground/80 px-3 text-center truncate">
                      {tr === "V0"
                        ? "V0 is empty — drag a bin item here, or set in/out in the source monitor and press Insert."
                        : tr === "V1"
                          ? "Drag a clip or still here for a picture-in-picture over the reel."
                          : tr === "V2"
                            ? "Add text from the toolbar."
                            : "Drag a music track here for a bed under the whole reel."}
                    </span>
                  </div>
                )}

                {laneItems.map((it) => (
                  <Block
                    key={it.id}
                    item={it}
                    source={sources.get(it.sk)}
                    laneH={LANE_H[tr]}
                    pps={pps}
                    engine={engine}
                    selected={selectedId === it.id}
                    razorArmed={tool === "razor" && tr === "V0"}
                    onPointerDown={beginMove(it)}
                    onTrim={(edge) => beginTrim(it, edge)}
                    onRazor={(x) => onSplit(it.id, x)}
                    timeAt={timeAt}
                  />
                ))}

                {dropTrack === tr && dropAt !== null && (
                  <div className="absolute inset-y-0 w-0.5 bg-emerald-400 pointer-events-none" style={{ left: toPx(dropAt) }} />
                )}

                {/* Junction markers sit above the V0 lane, one per butt joint. */}
                {tr === "V0" &&
                  v0.map((it, i) => {
                    if (i === 0) return null;
                    const prev = v0[i - 1];
                    if (!isJunction(end(prev), it.at)) return null;
                    return (
                      <JunctionMarker
                        key={`j${it.id}`}
                        left={toPx(it.at)}
                        transition={it.tin ?? "cut"}
                        onClick={(e) => { e.stopPropagation(); cycle(it); }}
                      />
                    );
                  })}

                {tr === "V0" && tool === "razor" && razorX !== null && (
                  <div
                    className="absolute inset-y-0 border-l-2 border-dashed border-primary pointer-events-none"
                    style={{ left: toPx(razorX), zIndex: 7 }}
                  />
                )}
              </div>
            );
          })}

          {/* Snap guide */}
          {guide !== null && (
            <div className="absolute top-0 bottom-0 w-0.5 bg-emerald-400 pointer-events-none" style={{ left: toPx(guide), zIndex: 6 }} />
          )}

          {/* Playhead — full height, including the ruler */}
          <div className="absolute top-0 bottom-0 w-0.5 bg-foreground pointer-events-none" style={{ left: toPx(playhead), zIndex: 8 }}>
            <div className="absolute -left-[6px] top-0 w-[14px] h-[10px] bg-foreground" />
          </div>
        </div>
      </div>
    </div>
  );
}

function JunctionMarker({ left, transition, onClick }: { left: number; transition: Transition; onClick: (e: React.MouseEvent) => void }) {
  const face =
    transition === "cut"
      ? { glyph: "|", cls: "bg-card border-border text-foreground", title: "Cut" }
      : transition === "crossfade"
        ? { glyph: "◇", cls: "bg-primary border-primary text-white", title: "Crossfade · 0.5s" }
        : {
            glyph: "▶",
            cls: "border-primary text-primary",
            title: "Branded wipe — needs engine work (renders as a fade today)",
          };
  return (
    <button
      onClick={onClick}
      title={`${face.title} — click to cycle`}
      className={`absolute grid place-items-center border text-[10px] leading-none font-bold ${face.cls}`}
      style={{
        left: left - 9,
        top: -9,
        width: 18,
        height: 18,
        zIndex: 5,
        backgroundImage:
          transition === "branded_wipe"
            ? "repeating-linear-gradient(135deg, hsl(var(--primary)/0.45) 0 3px, transparent 3px 6px)"
            : undefined,
      }}
      data-testid="reel-junction"
    >
      {face.glyph}
    </button>
  );
}

function Block(props: {
  item: ReelItem;
  source?: BinSource;
  laneH: number;
  pps: number;
  engine: boolean;
  selected: boolean;
  razorArmed: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onTrim: (edge: "in" | "out") => (e: React.PointerEvent) => void;
  onRazor: (t: number) => void;
  timeAt: (clientX: number) => number;
}) {
  const { item, source, laneH, pps, engine, selected, razorArmed } = props;
  const stripe = KIND_COLOR[source?.kind ?? "library"];
  const width = Math.max(14, dur(item) * pps);
  const isPiece = !!item.gid && !!item.piece;

  return (
    <div
      onPointerDown={props.onPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        if (razorArmed) props.onRazor(props.timeAt(e.clientX));
      }}
      className={`absolute overflow-hidden ${razorArmed ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
      style={{
        left: item.at * pps,
        width,
        top: 5,
        height: laneH - 10,
        background: engine ? undefined : "hsl(var(--card))",
        backgroundImage: engine
          ? "repeating-linear-gradient(135deg, hsl(var(--muted-foreground)/0.18) 0 6px, transparent 6px 12px)"
          : undefined,
        border: `1px solid ${selected ? "hsl(var(--primary))" : "hsl(var(--border))"}`,
        outline: selected ? "2px solid hsl(var(--primary))" : undefined,
        outlineOffset: -2,
        boxShadow: selected ? "0 0 0 3px hsl(var(--primary)/0.22)" : undefined,
      }}
      data-testid={`reel-block-${item.id}`}
    >
      {/* No preview frame behind the block, deliberately. It was one live
          HTMLVideoElement per block, unvirtualised and re-rendered during
          playback, and it made a busy timeline unreadable — the name is what
          you scan for. The stripe carries which family it came from. */}
      <span className="absolute left-0 inset-y-0 w-1 pointer-events-none" style={{ background: stripe }} />

      {/* Trim handles. Hidden on a block too narrow to hold them without
          covering the whole thing — use the razor there instead. */}
      {!engine && width >= 28 && (
        <>
          <span
            onPointerDown={props.onTrim("in")}
            title="Drag to trim the start"
            className="absolute left-0 inset-y-0 w-2 z-20 cursor-col-resize hover:bg-primary/40"
            data-testid={`reel-trim-in-${item.id}`}
          />
          <span
            onPointerDown={props.onTrim("out")}
            title="Drag to trim the end"
            className="absolute right-0 inset-y-0 w-2 z-20 cursor-col-resize hover:bg-primary/40"
            data-testid={`reel-trim-out-${item.id}`}
          />
        </>
      )}

      <div className="absolute inset-x-0 top-0 flex items-center gap-1.5 px-1.5 py-0.5 bg-background/85 pointer-events-none">
        <span className="text-[10.5px] font-semibold truncate text-foreground">
          {item.track === "V2" ? item.text || "text" : source?.label ?? item.sk}
        </span>
        <span className="ml-auto font-mono text-[9.5px] tabular-nums text-muted-foreground shrink-0">
          {fmtT(dur(item))}
        </span>
      </div>

      {/* Split seam: two pieces of one source must read as related. */}
      {isPiece && (
        <>
          <span className="absolute bottom-0.5 left-1.5 px-1 text-[8.5px] font-semibold uppercase bg-primary/15 border border-primary/45 text-primary pointer-events-none">
            piece {item.piece}
          </span>
          {item.piece === 2 && (
            <>
              <span className="absolute left-0 inset-y-0 border-l-2 border-dashed border-primary pointer-events-none" />
              <span
                className="absolute left-0 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ width: 0, height: 0, borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "7px solid hsl(var(--primary))" }}
              />
            </>
          )}
          {item.piece === 1 && (
            <span
              className="absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ width: 0, height: 0, borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderRight: "7px solid hsl(var(--primary))" }}
            />
          )}
        </>
      )}
    </div>
  );
}
