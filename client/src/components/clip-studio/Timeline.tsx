import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFilmstrip } from "./useFilmstrip";
import {
  baseSegments, fmtTime, fmtShort,
  type Selection, type StudioEdits,
} from "./types";

/**
 * The timeline — the object the editor is built around.
 *
 * What was here before was a scrubber wearing a timeline's clothes: a 40px
 * strip with coloured regions painted on it, one tiled thumbnail as a
 * backdrop, and a click handler that seeked. Nothing on it could be grabbed.
 *
 * The track model is exactly what the filtergraph can render and no more:
 *
 *   V2  text          rasterized PNG overlays, N of them, cap 12
 *   V1  b-roll        overlay nodes gated by enable='between(t,…)', cap 8
 *   V0  base          the clip. Fixed source. Splittable, retimeable, trimmable.
 *   A1  bed           one music track, with ducking
 *
 * There are deliberately no blend modes, no opacity, no keyframes and no
 * in-clip transitions: the chain has no nodes for them, and drawing a control
 * that cannot render is worse than not drawing it.
 *
 * A NOTE ON WHAT A SPLIT IS. Razoring V0 pushes a time onto `edits.splits`.
 * That alone renders nothing — it is a boundary. It earns its keep by giving
 * the inspector a segment to hang a speed ramp or a deletion on, both of
 * which the renderer does read. Striking words in the transcript reaches the
 * same segment list from the other direction.
 *
 * LAYOUT. The label column is a SIBLING of the scroll container, not padding
 * inside it. An earlier pass used `paddingLeft: 76` on the scroller, which
 * meant getBoundingClientRect().left pointed 76px to the left of where the
 * content actually began: every pointer→time conversion was off by two
 * seconds at typical zoom, so clicking the drawn playhead moved it. The
 * playhead lives INSIDE the scrolled content for the same reason — reading
 * scrollLeft during render gave a line that froze while the tracks scrolled.
 */

const LABEL_W = 76;
const H = { ruler: 20, v2: 30, v1: 44, v0: 58, a1: 26 } as const;
const GAP = 6;
const MIN_BLOCK_SEC = 0.3;   // the server drops anything shorter
const SNAP_PX = 7;

export interface TimelineProps {
  duration: number;
  playhead: number;
  edits: StudioEdits;
  silence: { spans: Array<{ start: number; end: number }> } | null | undefined;
  /** Rendered clip, for the filmstrip. Null before the first render. */
  filmSrc: string | null | undefined;
  /** media_assets.id → display name, for block labels. */
  assetNames: Map<number, string>;
  selection: Selection;
  razorArmed: boolean;
  snapOn: boolean;
  zoom: number;
  /** Layer tracks are unavailable on an assembled clip — see the 1d gate. */
  layersLocked: boolean;
  /** Trim is unavailable on an assembled clip: clip time is not source time. */
  trimLocked: boolean;
  /** The pending trim, clip-relative, so V0 can dim what is being cut away. */
  trim: { start: number; end: number } | null;
  onSeek: (t: number) => void;
  onSelect: (s: Selection) => void;
  /** A committed change. `token` groups a drag into one undo entry. */
  onEdits: (next: (prev: StudioEdits) => StudioEdits, label: string, token?: string) => void;
  onSplit: (t: number) => void;
  /**
   * A trim handle moved. `edge` is explicit rather than inferred from the
   * numbers: an earlier shape passed (startAt, endDelta) and the receiver
   * guessed the edge, so dragging the RIGHT handle exactly to the clip's end
   * produced endDelta === 0 and read as a left-edge drag, silently resetting
   * the start trim to zero.
   */
  onTrim: (edge: "left" | "right", atSec: number, token: string) => void;
  /** An asset dropped from the bin onto V1. */
  onDropAsset: (assetId: number, at: number) => void;
}

let dragSeq = 0;

export default function Timeline(props: TimelineProps) {
  const {
    duration, playhead, edits, silence, filmSrc, assetNames,
    selection, razorArmed, snapOn, zoom, layersLocked, trimLocked, trim,
    onSeek, onSelect, onEdits, onSplit, onTrim, onDropAsset,
  } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [laneW, setLaneW] = useState(900);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [dropT, setDropT] = useState<number | null>(null);
  const [snapGuide, setSnapGuide] = useState<{ t: number; note: string } | null>(null);

  /** Measure the scroller so px↔seconds is honest at any container width. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const read = () => setLaneW(el.clientWidth || 900);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    // Disconnect on unmount. Without this, every open/close of the modal left
    // an observer and its detached scroll container alive for the page's life.
    return () => ro.disconnect();
  }, []);

  const contentW = Math.max(laneW, laneW * zoom);
  const pxPerSec = duration > 0 ? contentW / duration : 1;
  const toPx = (t: number) => t * pxPerSec;
  const toSec = (px: number) => (pxPerSec > 0 ? px / pxPerSec : 0);

  const segments = useMemo(() => baseSegments(edits, duration), [edits, duration]);
  const broll = edits.broll ?? [];
  const texts = edits.textOverlays ?? [];

  /** Every time worth snapping to: segment edges, block edges, the playhead. */
  const snapPoints = useMemo(() => {
    const pts: Array<{ t: number; note: string }> = [
      { t: 0, note: "clip in" },
      { t: duration, note: "clip out" },
      { t: playhead, note: "playhead" },
    ];
    segments.forEach((s, i) => { if (i > 0) pts.push({ t: s.start, note: `seg ${i + 1} in` }); });
    broll.forEach((b, i) => { pts.push({ t: b.start, note: `b-roll ${i + 1} in` }); pts.push({ t: b.end, note: `b-roll ${i + 1} out` }); });
    texts.forEach((x, i) => { pts.push({ t: x.start, note: `text ${i + 1} in` }); pts.push({ t: x.end, note: `text ${i + 1} out` }); });
    return pts;
  }, [duration, playhead, segments, broll, texts]);

  const snap = useCallback(
    (t: number, exclude?: number[]): { t: number; note: string | null } => {
      if (!snapOn) return { t, note: null };
      let best: { t: number; note: string } | null = null;
      for (const p of snapPoints) {
        if (exclude?.some((e) => Math.abs(e - p.t) < 0.001)) continue;
        if (Math.abs(toPx(p.t) - toPx(t)) <= SNAP_PX) {
          if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
        }
      }
      return best ? { t: best.t, note: best.note } : { t, note: null };
    },
    [snapOn, snapPoints, pxPerSec],
  );

  /** clientX → clip seconds. The scroller's box IS the content box now. */
  const timeAt = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(duration, toSec(clientX - r.left + el.scrollLeft)));
    },
    [duration, pxPerSec],
  );

  // ── Scrub ────────────────────────────────────────────────────────────
  const beginScrub = (e: React.PointerEvent) => {
    if (razorArmed) return;
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

  // ── Block drag / resize ──────────────────────────────────────────────
  // One handler for both lanes: a block is a {start,end} pair whatever track
  // it lives on, so the geometry is identical and only the writer differs.
  const beginBlock = (
    kind: "broll" | "text",
    index: number,
    mode: "move" | "left" | "right",
  ) => (e: React.PointerEvent) => {
    if (razorArmed || layersLocked) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect({ kind, index } as Selection);
    const token = `block:${kind}:${index}:${++dragSeq}`;
    const list = kind === "broll" ? edits.broll ?? [] : edits.textOverlays ?? [];
    const it = list[index] as { start: number; end: number } | undefined;
    if (!it) return;
    const s0 = it.start;
    const e0 = it.end;
    const grab = timeAt(e.clientX) - s0;
    const own = [s0, e0];

    const move = (ev: PointerEvent) => {
      const raw = timeAt(ev.clientX);
      let start = s0;
      let end = e0;
      let note: string | null = null;
      if (mode === "left") {
        const sn = snap(raw, own);
        note = sn.note;
        start = Math.max(0, Math.min(sn.t, e0 - MIN_BLOCK_SEC));
      } else if (mode === "right") {
        const sn = snap(raw, own);
        note = sn.note;
        end = Math.min(duration, Math.max(sn.t, s0 + MIN_BLOCK_SEC));
      } else {
        const len = e0 - s0;
        const sn = snap(raw - grab, own);
        note = sn.note;
        start = Math.max(0, Math.min(sn.t, duration - len));
        end = start + len;
      }
      setSnapGuide(note ? { t: mode === "right" ? end : start, note } : null);
      onEdits(
        (p) => {
          if (kind === "broll") {
            const next = [...(p.broll ?? [])];
            const cur = next[index];
            if (!cur) return p;
            /**
             * Keep the source range as long as the block.
             *
             * The overlay stream is only `srcEnd − srcStart` seconds long, but
             * its enable window is `end − start`. Let those diverge and ffmpeg
             * runs out of b-roll partway through and passes the BASE video
             * through instead — the cutaway vanishes mid-block while the
             * editor still draws it as one continuous piece. Growing the block
             * grows the source range with it.
             */
            let { srcStart, srcEnd } = cur;
            if (Number.isFinite(Number(srcStart)) && Number.isFinite(Number(srcEnd))) {
              srcEnd = Number(srcStart) + (end - start);
            }
            next[index] = { ...cur, start, end, srcStart, srcEnd };
            return { ...p, broll: next };
          }
          const next = [...(p.textOverlays ?? [])];
          if (!next[index]) return p;
          next[index] = { ...next[index], start, end };
          return { ...p, textOverlays: next };
        },
        mode === "move"
          ? `Move ${kind === "broll" ? "b-roll" : "text"} → ${fmtTime(start)}`
          : `Resize ${kind === "broll" ? "b-roll" : "text"} · ${(end - start).toFixed(1)}s`,
        token,
      );
    };
    const up = () => {
      setSnapGuide(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // ── Trim handles on V0's ends ────────────────────────────────────────
  const beginTrim = (edge: "left" | "right") => (e: React.PointerEvent) => {
    if (razorArmed || trimLocked) return;
    e.preventDefault();
    e.stopPropagation();
    const token = `trim:${edge}:${++dragSeq}`;
    const move = (ev: PointerEvent) => onTrim(edge, timeAt(ev.clientX), token);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // ── Filmstrip ────────────────────────────────────────────────────────
  const frameCount = Math.max(4, Math.min(60, Math.round(contentW / 78)));
  const film = useFilmstrip(filmSrc, duration, frameCount);

  // ── Ruler ticks ──────────────────────────────────────────────────────
  const tickStep = useMemo(() => {
    const raw = 92 / pxPerSec;                          // ~92px between labels
    for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) if (s >= raw) return s;
    return 600;
  }, [pxPerSec]);
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let t = 0; t <= duration + 0.001; t += tickStep) out.push(Number(t.toFixed(3)));
    return out;
  }, [duration, tickStep]);

  const lane = "relative rounded-md bg-[#080d16] border border-[#121a25]";

  return (
    <div className="flex select-none" data-testid="clip-timeline">
      {/* ── Labels: a sibling of the scroller, so they never enter its
             coordinate space and never scroll away. ── */}
      <div className="shrink-0 flex flex-col" style={{ width: LABEL_W, gap: GAP }}>
        <div style={{ height: H.ruler }} />
        <TrackLabel h={H.v2} dot="#fbbf24" name="V2" kind="text" dim={layersLocked} />
        <TrackLabel h={H.v1} dot="#818cf8" name="V1" kind="b-roll" dim={layersLocked} />
        <TrackLabel h={H.v0} dot="#94a3b8" name="V0" kind="base" />
        <TrackLabel h={H.a1} dot="#34d399" name="A1" kind="bed" dim={layersLocked} />
      </div>

      <div ref={scrollRef} className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden">
        <div className="relative flex flex-col" style={{ width: contentW, gap: GAP }}>
          {/* ── Ruler ── */}
          <div className="relative cursor-text" style={{ height: H.ruler }} onPointerDown={beginScrub} data-testid="timeline-ruler">
            <div className="absolute inset-x-0 bottom-0 h-1.5 border-b border-white/10" />
            {ticks.map((t) => (
              <div key={t} className="absolute bottom-0" style={{ left: toPx(t) }}>
                <div className="absolute bottom-0 w-px h-1.5 bg-white/25" />
                <span className="absolute bottom-2.5 left-0 text-[9px] font-mono text-muted-foreground/70 tabular-nums">{fmtShort(t)}</span>
              </div>
            ))}
          </div>

          {/* ── V2 text ── */}
          <Lane height={H.v2} locked={layersLocked} className={lane} onBackground={() => onSelect(null)}>
            {texts.map((x, i) => (
              <Block
                key={`tx${i}`}
                left={toPx(x.start)}
                width={Math.max(6, toPx(x.end - x.start))}
                selected={selection?.kind === "text" && selection.index === i}
                tone="amber"
                label={x.text || "text"}
                onPointerDown={beginBlock("text", i, "move")}
                onLeft={beginBlock("text", i, "left")}
                onRight={beginBlock("text", i, "right")}
                testId={`timeline-text-${i}`}
              />
            ))}
          </Lane>

          {/* ── V1 b-roll ── */}
          <Lane
            height={H.v1}
            locked={layersLocked}
            className={lane}
            onBackground={() => onSelect(null)}
            onDragOver={(e) => {
              if (layersLocked) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDropT(timeAt(e.clientX));
            }}
            onDragLeave={() => setDropT(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDropT(null);
              if (layersLocked) return;
              const id = Number(e.dataTransfer.getData("application/x-fullscale-asset"));
              if (Number.isFinite(id) && id > 0) onDropAsset(id, snap(timeAt(e.clientX)).t);
            }}
            testId="timeline-lane-v1"
          >
            {broll.map((b, i) => (
              <Block
                key={`br${i}`}
                left={toPx(b.start)}
                width={Math.max(6, toPx(b.end - b.start))}
                selected={selection?.kind === "broll" && selection.index === i}
                tone="indigo"
                label={assetNames.get(b.assetId) ?? `asset ${b.assetId}`}
                sublabel={Number.isFinite(Number(b.srcStart)) ? `from ${fmtShort(Number(b.srcStart))}` : undefined}
                onPointerDown={beginBlock("broll", i, "move")}
                onLeft={beginBlock("broll", i, "left")}
                onRight={beginBlock("broll", i, "right")}
                testId={`timeline-broll-${i}`}
              />
            ))}
            {dropT !== null && (
              <div className="absolute inset-y-0 w-0.5 bg-emerald-400 pointer-events-none" style={{ left: toPx(dropT) }} />
            )}
          </Lane>

          {/* ── V0 base ── */}
          <div
            className={`${lane} ${razorArmed ? "border-primary/60 border-[1.5px]" : ""}`}
            style={{ height: H.v0, cursor: razorArmed ? "crosshair" : "default" }}
            onPointerMove={(e) => razorArmed && setHoverT(timeAt(e.clientX))}
            onPointerLeave={() => setHoverT(null)}
            onClick={(e) => {
              if (razorArmed) { onSplit(timeAt(e.clientX)); return; }
              const t = timeAt(e.clientX);
              const seg = segments.find((s) => t >= s.start && t < s.end);
              onSelect(seg ? { kind: "segment", index: seg.index } : null);
            }}
            data-testid="timeline-lane-v0"
          >
            <div className="absolute inset-y-[3px] left-[3px] right-[3px] rounded-[5px] overflow-hidden bg-[#141b26] flex">
              {film.frames.length > 0 ? (
                film.frames.map((f, i) =>
                  f ? (
                    <img key={i} src={f} alt="" draggable={false} className="h-full object-cover shrink-0" style={{ width: (contentW - 6) / film.frames.length }} />
                  ) : (
                    <div key={i} className="h-full shrink-0 bg-gradient-to-b from-[#26303f] to-[#141b26]" style={{ width: (contentW - 6) / film.frames.length }} />
                  ),
                )
              ) : (
                <div className="w-full h-full bg-gradient-to-b from-[#26303f] to-[#141b26]" />
              )}
            </div>

            {/* Removed spans: struck words in red, silence hatched amber. */}
            {(edits.wordCuts ?? []).map((c, i) => (
              <div
                key={`wc${i}`}
                className="absolute inset-y-[3px] bg-primary/40 border-x border-primary/70 pointer-events-none"
                style={{ left: toPx(c.start), width: Math.max(2, toPx(c.end - c.start)) }}
                title={c.text ? `cut: ${c.text}` : "cut"}
              />
            ))}
            {edits.silenceCut?.enabled &&
              (silence?.spans ?? []).map((s, i) => (
                <div
                  key={`sl${i}`}
                  className="absolute inset-y-[3px] pointer-events-none border-x border-amber-500/50"
                  style={{
                    left: toPx(s.start),
                    width: Math.max(2, toPx(s.end - s.start)),
                    backgroundImage: "repeating-linear-gradient(135deg, rgba(245,158,11,0.35) 0 4px, rgba(245,158,11,0.08) 4px 8px)",
                  }}
                  title="silence removed"
                />
              ))}

            {/* Trimmed-away head and tail, dimmed rather than hidden. */}
            {trim && trim.start > 0.01 && (
              <div className="absolute inset-y-[3px] left-[3px] bg-black/70 pointer-events-none border-r border-white/40" style={{ width: Math.max(0, toPx(trim.start) - 3) }} />
            )}
            {trim && trim.end < duration - 0.01 && (
              <div className="absolute inset-y-[3px] right-[3px] bg-black/70 pointer-events-none border-l border-white/40" style={{ width: Math.max(0, toPx(duration - trim.end) - 3) }} />
            )}

            {segments.map((s, i) =>
              i === 0 ? null : (
                <div key={`sb${i}`} className="absolute inset-y-0 w-0.5 bg-primary pointer-events-none" style={{ left: toPx(s.start) }} />
              ),
            )}
            {segments.map((s) => (
              <div
                key={`sl${s.index}`}
                className={`absolute inset-y-[3px] pointer-events-none rounded-[3px] ${
                  selection?.kind === "segment" && selection.index === s.index ? "ring-2 ring-white/80 ring-inset" : ""
                }`}
                style={{ left: toPx(s.start), width: Math.max(2, toPx(s.end - s.start)) }}
              >
                {toPx(s.end - s.start) > 74 && (
                  <span className="absolute left-1.5 top-1 text-[9px] font-mono text-white/70 tabular-nums drop-shadow">
                    seg {s.index + 1}
                    {Math.abs(s.rate - 1) > 0.01 ? ` · ${s.rate.toFixed(2)}×` : ""}
                    {s.removed ? " · removed" : ""}
                  </span>
                )}
              </div>
            ))}

            {/* Trim handles — the white end caps. These write clipStart /
                clipEnd to the server branch that already existed and had
                never once been called from the client. */}
            {!trimLocked && (
              <>
                <div
                  onPointerDown={beginTrim("left")}
                  className="absolute inset-y-[3px] w-[11px] rounded-l-[5px] bg-white/90 hover:bg-white cursor-ew-resize flex items-center justify-center"
                  style={{ left: Math.max(3, toPx(trim?.start ?? 0)) }}
                  title="Trim the clip's start"
                  data-testid="timeline-trim-start"
                >
                  <span className="w-px h-4 bg-[#0a0e17]" />
                </div>
                <div
                  onPointerDown={beginTrim("right")}
                  className="absolute inset-y-[3px] w-[11px] rounded-r-[5px] bg-white/90 hover:bg-white cursor-ew-resize flex items-center justify-center"
                  style={{ left: Math.min(contentW - 14, toPx(trim?.end ?? duration) - 11) }}
                  title="Trim the clip's end"
                  data-testid="timeline-trim-end"
                >
                  <span className="w-px h-4 bg-[#0a0e17]" />
                </div>
              </>
            )}

            {razorArmed && hoverT !== null && (
              <>
                <div className="absolute inset-y-0 border-l-[1.5px] border-dashed border-[#ff5a72] pointer-events-none" style={{ left: toPx(hoverT) }} />
                <div
                  className="absolute -top-6 px-1.5 py-0.5 rounded bg-primary text-white text-[10px] font-mono whitespace-nowrap pointer-events-none -translate-x-1/2 z-30"
                  style={{ left: toPx(hoverT) }}
                >
                  split {fmtTime(hoverT)}
                </div>
              </>
            )}
          </div>

          {/* ── A1 bed ── */}
          <Lane height={H.a1} locked={layersLocked} className={lane} onBackground={() => onSelect(null)}>
            {edits.music && (
              <div
                onClick={(e) => { e.stopPropagation(); onSelect({ kind: "music" }); }}
                className={`absolute inset-y-[3px] left-[3px] right-[3px] rounded-[5px] flex items-center gap-2 px-2 overflow-hidden cursor-pointer border ${
                  selection?.kind === "music" ? "bg-emerald-500/20 border-emerald-400" : "bg-emerald-500/10 border-emerald-500/35 hover:border-emerald-400/60"
                }`}
                data-testid="timeline-music"
              >
                <span className="text-[11px] text-emerald-200 whitespace-nowrap truncate">
                  {assetNames.get(edits.music.assetId) ?? "music bed"}
                </span>
                <span className="flex-1 h-2.5 min-w-0" style={{ backgroundImage: "repeating-linear-gradient(90deg, rgba(52,211,153,0.5) 0 2px, transparent 2px 6px)" }} />
                {edits.music.ducking && (
                  <span className="text-[9px] font-mono text-emerald-400 whitespace-nowrap">duck −{edits.music.duckAmountDb} dB</span>
                )}
              </div>
            )}
          </Lane>

          {/* ── Playhead ── inside the scrolled content, so it tracks the
                 tracks instead of needing a scroll subscription to keep up. */}
          <div className="absolute top-0 bottom-0 w-px bg-primary pointer-events-none z-20" style={{ left: toPx(playhead) }}>
            <div className="absolute -left-[6px] top-0 w-[13px] h-[13px] bg-primary" style={{ clipPath: "polygon(0 0,100% 0,50% 100%)" }} />
          </div>

          {snapGuide && (
            <div className="absolute top-0 bottom-0 w-px bg-emerald-400 pointer-events-none z-20" style={{ left: toPx(snapGuide.t) }}>
              <div className="absolute top-0 left-1.5 px-1.5 py-0.5 rounded bg-[#0d2a22] border border-emerald-500/50 text-emerald-300 text-[10px] font-mono whitespace-nowrap">
                snap → {snapGuide.note}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TrackLabel({ h, dot, name, kind, dim }: { h: number; dot: string; name: string; kind: string; dim?: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 font-mono text-[10px] ${dim ? "opacity-35" : ""}`} style={{ height: h }}>
      <span className="w-1.5 h-1.5 shrink-0" style={{ background: dot }} />
      <span className="text-foreground/80">{name}</span>
      <span className="text-muted-foreground/60">{kind}</span>
    </div>
  );
}

function Lane(props: {
  height: number;
  locked?: boolean;
  className: string;
  children?: React.ReactNode;
  onBackground?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
  testId?: string;
}) {
  return (
    <div
      className={props.className}
      style={{
        height: props.height,
        opacity: props.locked ? 0.4 : 1,
        // A locked lane still SHOWS what it holds — the point of the
        // assembled-clip treatment is that you can see what you are being
        // denied, not that the track disappears.
        backgroundImage: props.locked
          ? "repeating-linear-gradient(135deg, rgba(148,163,184,0.07) 0 5px, transparent 5px 10px)"
          : undefined,
      }}
      onClick={props.onBackground}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
      data-testid={props.testId}
    >
      {props.children}
    </div>
  );
}

function Block(props: {
  left: number;
  width: number;
  selected: boolean;
  tone: "indigo" | "amber";
  label: string;
  sublabel?: string;
  onPointerDown: (e: React.PointerEvent) => void;
  onLeft: (e: React.PointerEvent) => void;
  onRight: (e: React.PointerEvent) => void;
  testId: string;
}) {
  const tone =
    props.tone === "indigo"
      ? { bg: "linear-gradient(135deg,#333c60,#1e2540)", border: props.selected ? "#818cf8" : "rgba(129,140,248,0.45)", text: "#c7d2fe", handle: "#818cf8" }
      : { bg: "rgba(245,158,11,0.16)", border: props.selected ? "#fbbf24" : "rgba(245,158,11,0.45)", text: "#fcd34d", handle: "#fbbf24" };
  return (
    <div
      onPointerDown={props.onPointerDown}
      onClick={(e) => e.stopPropagation()}
      className="absolute top-[3px] bottom-[3px] rounded-[5px] flex items-center px-2 overflow-hidden cursor-grab active:cursor-grabbing"
      style={{
        left: props.left,
        width: props.width,
        background: tone.bg,
        border: `${props.selected ? 1.5 : 1}px solid ${tone.border}`,
        boxShadow: props.selected ? `0 0 0 3px ${tone.handle}28` : undefined,
      }}
      data-testid={props.testId}
    >
      <span className="text-[11px] whitespace-nowrap truncate" style={{ color: tone.text }}>
        {props.label}
        {props.sublabel && <span className="ml-1.5 font-mono text-[9px] opacity-70">{props.sublabel}</span>}
      </span>
      {/* Both edges resize; the body drags. Only shown when selected so an
          unselected lane does not look like a row of grab handles. */}
      {props.selected && props.width > 18 && (
        <>
          <span onPointerDown={props.onLeft} className="absolute left-0 inset-y-0 w-[7px] rounded-l-[4px] cursor-ew-resize" style={{ background: tone.handle }} />
          <span onPointerDown={props.onRight} className="absolute right-0 inset-y-0 w-[7px] rounded-r-[4px] cursor-ew-resize" style={{ background: tone.handle }} />
        </>
      )}
    </div>
  );
}
