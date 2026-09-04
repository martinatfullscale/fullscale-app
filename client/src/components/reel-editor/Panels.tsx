import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play, Pause, Plus, Scissors, Search, SkipBack } from "lucide-react";
import { AiStillPanel, StockPanel, WebcamPanel } from "./BinPanels";
import {
  dur, fmtT, KIND_COLOR, KIND_LABEL, REEL_ASPECT,
  type BinSource, type ReelItem, type SourceKind,
} from "./types";

/**
 * Every monitor shows the same box.
 *
 * Both monitors used to be a flex-filled black panel with `object-contain`
 * inside, so a 16:9 source and a 9:16 program letterboxed to different
 * shapes in differently-sized panels — the source never looked like what the
 * reel would look like. This is the reel's actual output frame; footage of
 * any shape is fitted into it, which is exactly what the render does.
 */
function OutputFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-0 grid place-items-center bg-[#07070a] p-2">
      <div className="relative h-full bg-black border border-border/60" style={{ aspectRatio: String(REEL_ASPECT) }}>
        {children}
      </div>
    </div>
  );
}

/**
 * The upper row: bin · source monitor · program monitor · inspector.
 *
 * Two of these did not exist before. The old builder had no way to see a
 * source before committing it to the timeline (you dropped a block and
 * dragged its edge blind, with no frame feedback), and no way to play the
 * assembly at all — the reel was invisible until the render came back.
 */

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-primary">{children}</span>
  );
}

function PanelHead({ kicker, children }: { kicker: string; children?: React.ReactNode }) {
  return (
    <div className="shrink-0 flex items-baseline gap-2 px-3 py-2 border-b border-border/40">
      <Kicker>{kicker}</Kicker>
      {children}
    </div>
  );
}

// ── Bin ──────────────────────────────────────────────────────────────────

const FILTERS: Array<{ id: "all" | SourceKind; label: string }> = [
  { id: "all", label: "All" },
  { id: "library", label: "Library" },
  { id: "moment", label: "Moments" },
  { id: "upload", label: "Uploads" },
  { id: "webcam", label: "Webcam" },
  { id: "stock", label: "Stock" },
  { id: "ai", label: "AI stills" },
];

export function Bin(props: {
  sources: BinSource[];
  loading: boolean;
  selectedKey: string | null;
  onPick: (s: BinSource) => void;
  uploading: boolean;
  onUpload: (file: File) => void;
  /** Refetch after stock import / AI generation writes a media_assets row. */
  onSourcesChanged: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | SourceKind>("all");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return props.sources.filter(
      (s) =>
        (filter === "all" || s.kind === filter) &&
        (!needle || s.label.toLowerCase().includes(needle) || s.meta.toLowerCase().includes(needle)),
    );
  }, [props.sources, q, filter]);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden border-r-2 border-border">
      <div className="shrink-0 px-3 pt-2.5 pb-2 flex flex-col gap-2 border-b border-border/40">
        <div className="flex items-baseline gap-2">
          <Kicker>Bin</Kicker>
          <span className="text-[11px] text-muted-foreground">
            {shown.length} of {props.sources.length} source{props.sources.length === 1 ? "" : "s"}
          </span>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={props.uploading}
            className="ml-auto inline-flex items-center gap-1 px-1.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] bg-primary text-white disabled:opacity-50"
            data-testid="reel-bin-add"
          >
            {props.uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
            Add
          </button>
        </div>
        {/* video AND image: the render path has always handled stills (held
            1-30s with a slow zoom) but the old picker was video-only. */}
        <input
          ref={fileRef}
          type="file"
          accept="video/*,image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) props.onUpload(f);
          }}
        />
        <label className="flex items-center gap-2 px-2 h-8 border border-border focus-within:border-primary/60">
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search all sources"
            className="flex-1 min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
            data-testid="reel-bin-search"
          />
        </label>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => {
            const on = filter === f.id;
            return (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`px-1.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] border transition-colors ${
                  on ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`reel-bin-filter-${f.id}`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Three of the chips are SOURCES you act on rather than files you
            already own, so they get a panel instead of the grid. Everything
            they produce becomes a media_assets row, which is what the grid
            lists — so a stock import or a generated still simply appears
            under Yours once the bin refetches. */}
        {filter === "stock" ? (
          <StockPanel onImported={props.onSourcesChanged} />
        ) : filter === "ai" ? (
          <AiStillPanel onGenerated={props.onSourcesChanged} />
        ) : filter === "webcam" && props.sources.every((s) => s.kind !== "webcam") ? (
          <WebcamPanel busy={props.uploading} onCapture={props.onUpload} />
        ) : (
          <BinGrid {...props} shown={shown} filter={filter} q={q} />
        )}
      </div>
    </div>
  );
}

/** The grid of things the creator already owns. */
function BinGrid(props: {
  sources: BinSource[];
  loading: boolean;
  selectedKey: string | null;
  onPick: (s: BinSource) => void;
  uploading: boolean;
  onUpload: (file: File) => void;
  shown: BinSource[];
  filter: "all" | SourceKind;
  q: string;
}) {
  const { shown, filter } = props;
  return (
      <div className="p-2 flex flex-col gap-1.5">
        {props.loading ? (
          <p className="px-1 py-6 text-center text-[11px] text-muted-foreground">Loading your sources…</p>
        ) : shown.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            {filter === "moment"
              // Said plainly rather than shown as an empty grid: the AI
              // cross-video moment finder is not wired into this bin yet.
              ? "Cross-video AI moments aren't wired into this bin yet — they still live in the old builder."
              : props.sources.length === 0
                ? "Nothing in your library yet. Use Add, or try the Stock, AI stills or Webcam tabs."
                : "Nothing here matches that."}
          </p>
        ) : (
          shown.map((s) => <BinCard key={s.sk} source={s} selected={props.selectedKey === s.sk} onPick={() => props.onPick(s)} />)
        )}
        {filter === "webcam" && (
          <WebcamPanel busy={props.uploading} onCapture={props.onUpload} />
        )}
        <p className="px-0.5 py-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
          Hover a thumbnail to scrub it. Drag to V0 for a beat or V1 for an overlay, or open it in the source
          monitor to set in/out first.
        </p>
      </div>
  );
}

function BinCard({ source, selected, onPick }: { source: BinSource; selected: boolean; onPick: () => void }) {
  const vid = useRef<HTMLVideoElement>(null);
  const span = Math.max(0, source.boundEnd - source.boundStart);

  /** Hover-scrub: map cursor x across the thumbnail to a time in the source.
   *  No canvas — the <video> element seeks itself, and /storage/* serves
   *  Range requests, so this is a handful of bytes per position. */
  const scrub = (e: React.MouseEvent) => {
    const v = vid.current;
    if (!v || !span) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    try { v.currentTime = source.boundStart + p * span; } catch { /* not seekable yet */ }
  };
  const unscrub = () => {
    const v = vid.current;
    if (v) { try { v.currentTime = source.boundStart + 0.3; } catch { /* ignore */ } }
  };

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-fullscale-source", source.sk);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onPick}
      className={`grid gap-2 p-1.5 cursor-grab active:cursor-grabbing border transition-colors ${
        selected ? "bg-primary/10 border-primary/60" : "bg-card/60 border-border hover:border-border/80"
      }`}
      style={{ gridTemplateColumns: "104px 1fr" }}
      data-testid={`reel-bin-${source.sk}`}
    >
      <div
        className="relative bg-black overflow-hidden"
        style={{ aspectRatio: "16 / 9" }}
        onMouseMove={scrub}
        onMouseLeave={unscrub}
      >
        {source.url ? (
          <video
            ref={vid}
            src={`${source.url}#t=${(source.boundStart + 0.3).toFixed(2)}`}
            preload="metadata"
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        ) : source.thumbnailPath ? (
          <img src={source.thumbnailPath} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full grid place-items-center text-[9px] uppercase tracking-wide text-muted-foreground/70">
            not rendered
          </div>
        )}
        <span className="absolute left-0 top-0 w-1 h-full" style={{ background: KIND_COLOR[source.kind] }} />
        <span className="absolute left-0 bottom-0 px-1 bg-foreground text-background text-[9.5px] tabular-nums">
          {fmtT(span)}
        </span>
      </div>
      <div className="min-w-0 flex flex-col gap-0.5 pt-0.5">
        <span className="text-xs font-semibold leading-tight truncate text-foreground">{source.label}</span>
        <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{KIND_LABEL[source.kind]}</span>
        <span className="text-[10.5px] text-muted-foreground/80 truncate">{source.meta}</span>
      </div>
    </div>
  );
}

// ── Source monitor ───────────────────────────────────────────────────────

export function SourceMonitor(props: {
  source: BinSource | null;
  srcIn: number;
  srcOut: number;
  onRange: (a: number, b: number) => void;
  onInsert: () => void;
  canInsert: boolean;
}) {
  const { source, srcIn, srcOut } = props;
  const vid = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);

  const lo = source?.boundStart ?? 0;
  const hi = source?.boundEnd ?? 0;
  const span = Math.max(0.001, hi - lo);
  const pct = (v: number) => ((v - lo) / span) * 100;

  useEffect(() => { setT(srcIn); setPlaying(false); }, [source?.sk]);

  /** Play the marked range only, then stop — the point of a source monitor. */
  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      setT(v.currentTime);
      if (!v.paused && v.currentTime >= srcOut - 0.03) { v.pause(); setPlaying(false); v.currentTime = srcIn; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [srcIn, srcOut, source?.sk]);

  const seek = (sec: number) => {
    const v = vid.current;
    const c = Math.max(lo, Math.min(hi, sec));
    setT(c);
    if (v) { try { v.currentTime = c; } catch { /* not ready */ } }
  };

  const atBar = (clientX: number) => {
    const el = bar.current;
    if (!el) return lo;
    const r = el.getBoundingClientRect();
    return lo + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * span;
  };

  /** Every setter clamps. A range under 0.5s is refused rather than stored —
   *  normalise would drop it later and the block would vanish on save. */
  const setIn = (v: number) => props.onRange(Math.max(lo, Math.min(v, srcOut - 0.5)), srcOut);
  const setOut = (v: number) => props.onRange(srcIn, Math.min(hi, Math.max(v, srcIn + 0.5)));

  const dragHandle = (which: "in" | "out") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev: PointerEvent) => (which === "in" ? setIn(atBar(ev.clientX)) : setOut(atBar(ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden border-r border-border/40">
      <PanelHead kicker="Source">
        <span className="text-[11.5px] font-semibold truncate text-foreground">
          {source ? `${source.label} · ${KIND_LABEL[source.kind]}` : "Nothing loaded"}
        </span>
      </PanelHead>

      <OutputFrame>
        {source?.url ? (
          <>
            <video ref={vid} src={source.url} muted playsInline className="absolute inset-0 w-full h-full object-contain" />
            <span className="absolute left-2 top-2 px-1.5 py-0.5 bg-black/65 text-[10px] uppercase tracking-[0.08em] text-white tabular-nums">
              {fmtT(t)} / {fmtT(hi)}
            </span>
          </>
        ) : (
          <p className="absolute inset-0 grid place-items-center px-4 text-center text-[11px] text-muted-foreground">
            {source ? "This clip hasn't been rendered yet, so there's nothing to scrub." : "Pick something from the bin."}
          </p>
        )}
      </OutputFrame>

      <div className="shrink-0 px-3 pt-2 pb-2.5 flex flex-col gap-2 bg-card/40 border-t border-border/40">
        {/* The bar had no label at all, which is why it read as "a red thing
            over the video". It is the in/out selection: the tinted band is
            what gets inserted. */}
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            In / out — the part that gets inserted
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/70">drag the handles</span>
        </div>
        <div
          ref={bar}
          onPointerDown={(e) => seek(atBar(e.clientX))}
          className="relative h-[26px] bg-secondary border border-border cursor-pointer"
          data-testid="reel-source-bar"
        >
          {source && (
            <>
              <div
                className="absolute inset-y-0 bg-primary/20 border-x-2 border-primary"
                style={{ left: `${pct(srcIn)}%`, width: `${Math.max(0, pct(srcOut) - pct(srcIn))}%` }}
              />
              <div onPointerDown={dragHandle("in")} className="absolute -inset-y-[3px] w-[9px] -ml-1 bg-primary cursor-ew-resize" style={{ left: `${pct(srcIn)}%` }} />
              <div onPointerDown={dragHandle("out")} className="absolute -inset-y-[3px] w-[9px] -ml-[5px] bg-primary cursor-ew-resize" style={{ left: `${pct(srcOut)}%` }} />
              <div className="absolute inset-y-0 w-0.5 bg-foreground pointer-events-none" style={{ left: `${pct(t)}%` }} />
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-[11px]">
          <button
            onClick={() => {
              const v = vid.current;
              if (!v) return;
              if (v.paused) { if (v.currentTime < srcIn || v.currentTime >= srcOut) v.currentTime = srcIn; v.play().catch(() => {}); setPlaying(true); }
              else { v.pause(); setPlaying(false); }
            }}
            disabled={!source?.url}
            className="px-2.5 py-1.5 border border-border text-[11px] font-semibold hover:bg-white/5 disabled:opacity-40 inline-flex items-center gap-1.5"
            data-testid="reel-source-play"
          >
            {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {playing ? "Pause" : "Play in→out"}
          </button>
          <button onClick={() => setIn(t)} disabled={!source} className="px-2.5 py-1.5 border border-border text-[11px] hover:bg-white/5 disabled:opacity-40">
            Set in · I
          </button>
          <button onClick={() => setOut(t)} disabled={!source} className="px-2.5 py-1.5 border border-border text-[11px] hover:bg-white/5 disabled:opacity-40">
            Set out · O
          </button>
          <span className="ml-auto font-mono text-[10.5px] tabular-nums text-muted-foreground">
            in {fmtT(srcIn)} · out {fmtT(srcOut)} · {fmtT(srcOut - srcIn)}
          </span>
        </div>

        <button
          onClick={props.onInsert}
          disabled={!props.canInsert}
          className="w-full text-left px-3 py-2 bg-foreground text-background text-xs font-extrabold disabled:opacity-35"
          data-testid="reel-insert"
        >
          Insert at playhead → V0
        </button>
      </div>
    </div>
  );
}

// ── Program monitor ──────────────────────────────────────────────────────

export function ProgramMonitor(props: {
  videoRef: React.RefObject<HTMLVideoElement>;
  activeLabel: string | null;
  /** A V2 block covering the playhead, so the monitor can show the intent. */
  overlayText: string | null;
  playhead: number;
  total: number;
  playing: boolean;
  onPlayPause: () => void;
  onHome: () => void;
  onEdge: (dir: -1 | 1) => void;
}) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden border-r border-border/40">
      <PanelHead kicker="Program">
        <span className="text-[11.5px] font-semibold truncate text-foreground">{props.activeLabel ?? "—"}</span>
        <span className="ml-auto font-mono text-[10.5px] tabular-nums text-muted-foreground shrink-0">
          {fmtT(props.playhead)} / {fmtT(props.total)}
        </span>
      </PanelHead>

      <OutputFrame>
        <video ref={props.videoRef} muted playsInline className="absolute inset-0 w-full h-full object-contain" data-testid="reel-program-video" />
        {!props.activeLabel && (
          <span className="absolute inset-0 grid place-items-center text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Gap — no source at playhead
          </span>
        )}
        {/* What is on screen right now, and whether it is running. Without
            this the monitor was a black rectangle with no way to tell a
            paused reel from an empty one. */}
        {props.activeLabel && (
          <span className="absolute left-2 top-2 px-1.5 py-0.5 bg-black/65 text-[10px] text-white flex items-center gap-1.5 max-w-[85%]">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${props.playing ? "bg-emerald-400" : "bg-white/40"}`} />
            <span className="truncate">{props.playing ? "Playing" : "Paused"} · {props.activeLabel}</span>
          </span>
        )}
        {props.overlayText && (
          <>
            <span className="absolute left-3 bottom-3 font-display text-[26px] font-extrabold text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)] pointer-events-none">
              {props.overlayText}
            </span>
            {/* Said out loud, because it is a lie about the renderer: the reel
                path has no overlay node, so this text is a mock of intent. */}
            <span className="absolute right-2 top-2 px-1.5 py-0.5 border border-amber-500/50 bg-amber-500/15 text-amber-300 text-[9px] uppercase tracking-[0.1em]">
              V1/V2 simulated · needs engine
            </span>
          </>
        )}
      </OutputFrame>

      <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-card/40 border-t border-border/40">
        <button onClick={props.onHome} className="p-1.5 border border-border hover:bg-white/5" title="Back to start">
          <SkipBack className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={props.onPlayPause}
          className="px-3 py-1.5 bg-primary text-white text-[11px] font-extrabold inline-flex items-center gap-1.5"
          data-testid="reel-play"
        >
          {props.playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          {props.playing ? "Pause" : "Play"}
        </button>
        <button onClick={() => props.onEdge(-1)} className="px-2 py-1.5 border border-border text-[11px] hover:bg-white/5">◂ edge</button>
        <button onClick={() => props.onEdge(1)} className="px-2 py-1.5 border border-border text-[11px] hover:bg-white/5">edge ▸</button>
        <span className="ml-auto font-mono text-[9.5px] text-muted-foreground/70 hidden 2xl:inline">
          space play · S razor · V select · ⌘Z undo · ⌫ delete
        </span>
      </div>
    </div>
  );
}

// ── Inspector ────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-border/30">
      <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground shrink-0">{label}</span>
      <span className="text-[11.5px] font-semibold tabular-nums text-foreground text-right truncate">{value}</span>
    </div>
  );
}

export function Inspector(props: {
  item: ReelItem | null;
  source: BinSource | null;
  pieceCount: number;
  onSplit: () => void;
  onRippleDelete: () => void;
  onLift: () => void;
}) {
  const { item, source } = props;
  if (!item) {
    return (
      <div className="flex flex-col h-full min-h-0 overflow-hidden">
        <PanelHead kicker="Inspector" />
        <p className="p-4 text-[11px] leading-relaxed text-muted-foreground">
          Nothing selected. Click a block on the timeline, or pick a bin item to load the source monitor.
        </p>
      </div>
    );
  }

  /** The server only builds caption groups for video-backed segments:
   *  `if (captionsEnabled && ps.sourceVideoId != null)`. An uploaded or webcam
   *  block is silently caption-less, so the inspector says so rather than
   *  letting it be discovered in the export. */
  const captions = source?.videoId != null ? "burned in" : "none — asset item";

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <PanelHead kicker="Inspector" />
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2.5">
        <div>
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            {item.track} · {source ? KIND_LABEL[source.kind] : "unknown source"}
          </div>
          <div className="font-display text-base font-extrabold leading-tight mt-0.5 text-foreground">
            {item.track === "V2" ? item.text || "Text" : source?.label ?? item.sk}
          </div>
        </div>

        {source?.url && (
          <div className="bg-black overflow-hidden" style={{ aspectRatio: "16 / 9" }}>
            <video src={`${source.url}#t=${item.in.toFixed(2)}`} preload="metadata" muted playsInline className="w-full h-full object-cover" />
          </div>
        )}

        <div className="h-0.5 bg-border" />

        <div className="flex flex-col">
          <Row label="Track" value={item.track} />
          <Row label="Source in / out" value={`${fmtT(item.in)} – ${fmtT(item.out)}`} />
          <Row label="Timeline at" value={fmtT(item.at)} />
          <Row label="Duration" value={fmtT(dur(item))} />
          <Row label="Transition in" value={(item.tin ?? "cut").replace("_", " ")} />
          <Row label="Captions" value={captions} />
        </div>

        {item.gid && item.piece && (
          <p className="text-[11px] leading-relaxed text-foreground/85 border-l-4 border-primary bg-primary/10 px-2.5 py-2">
            Piece {item.piece} of {props.pieceCount} from one source. Two items, same source key, different ranges —
            the reel route already renders this, so there is no server work behind the razor.
          </p>
        )}

        <div className="flex flex-col gap-1.5 pt-1">
          <button onClick={props.onSplit} className="text-left px-2.5 py-1.5 border border-border text-[11.5px] hover:bg-white/5 inline-flex items-center gap-2" data-testid="reel-inspector-split">
            <Scissors className="w-3.5 h-3.5" />
            Split at playhead · S
          </button>
          <button onClick={props.onRippleDelete} className="text-left px-2.5 py-1.5 border border-primary/40 text-[11.5px] text-primary hover:bg-primary/10" data-testid="reel-inspector-ripple-delete">
            Ripple delete · ⇧⌫
          </button>
          <button onClick={props.onLift} className="text-left px-2.5 py-1.5 border border-border text-[11.5px] hover:bg-white/5" data-testid="reel-inspector-lift">
            Lift (leave gap) · ⌫
          </button>
        </div>

        <p
          className={`text-[10.5px] leading-relaxed px-2.5 py-2 ${
            item.track === "V0"
              ? "border-l-4 border-primary bg-primary/10 text-foreground/85"
              : "border-l-4 border-indigo-400 bg-indigo-400/10 text-foreground/85"
          }`}
        >
          {item.track === "V0"
            ? "Stitched first — one plan segment for this block, in order, with the junction transition above."
            : "Composited in a second pass over the finished reel, so it is anchored to the reel and not to any one segment."}
        </p>
      </div>
    </div>
  );
}
