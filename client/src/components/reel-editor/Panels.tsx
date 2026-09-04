import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Play, Pause, Plus, Scissors, Search, SkipBack } from "lucide-react";
import { AiStillPanel, StockPanel, WebcamPanel } from "./BinPanels";
import {
  dur, fmtT, fmtPrecise, KIND_COLOR, KIND_LABEL, REEL_ASPECT,
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

/**
 * THE BIN, organised by where a thing came from.
 *
 * It used to be a flat list behind nine kind chips, and the owner's complaint
 * was the right one: "there has to be a way to organize them so that a lay
 * person can find their clip and drop it in and don't have to hunt very far."
 * A flat list of 73 cards named after the video they were cut from is a hunt.
 *
 * Three sections now, which is how a creator actually thinks about their own
 * material:
 *   Your videos  the long-form sources — uploaded, or connected through OAuth
 *                — each one expanding to the clips FullScale cut from it.
 *   Uploads      files they brought in themselves, plus stills and music.
 *   Create       the tools that make a new source: stock, AI stills, webcam.
 *
 * Which pipeline made a clip is a badge on the card, not a tab. It is a useful
 * thing to notice and a useless thing to navigate by.
 */
type BinTab = "videos" | "uploads" | "create";

const TABS: Array<{ id: BinTab; label: string }> = [
  { id: "videos", label: "Your videos" },
  { id: "uploads", label: "Uploads" },
  { id: "create", label: "Create" },
];

/** Everything a creator brought in or generated, as opposed to cut. */
const UPLOAD_KINDS: SourceKind[] = ["upload", "webcam", "stock", "ai", "music"];

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
  const [tab, setTab] = useState<BinTab>("videos");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const needle = q.trim().toLowerCase();
  const hit = (s: BinSource) =>
    !needle || s.label.toLowerCase().includes(needle) || s.meta.toLowerCase().includes(needle);

  /** Source videos, each with the clips cut from it. A clip whose parent is
   *  missing — a folded-away duplicate, or a video since removed — is not
   *  dropped on the floor; it lands in a trailing group of its own. */
  const groups = useMemo(() => {
    const videos = props.sources.filter((s) => s.kind === "video");
    const clips = props.sources.filter(
      (s) => s.kind === "story" || s.kind === "library" || s.kind === "reel" || s.kind === "moment",
    );
    const byVideo = new Map<number, BinSource[]>();
    const orphans: BinSource[] = [];
    for (const c of clips) {
      if (typeof c.videoId === "number" && videos.some((v) => v.videoId === c.videoId)) {
        const arr = byVideo.get(c.videoId) ?? [];
        arr.push(c);
        byVideo.set(c.videoId, arr);
      } else orphans.push(c);
    }
    const out = videos
      .map((v) => ({ key: `v:${v.videoId}`, video: v, clips: byVideo.get(v.videoId!) ?? [] }))
      // Longest first: the long-form sources are what this section is for, and
      // a 40-second import should not sit above an hour-long episode.
      .sort((a, b) => (b.video.durationSec ?? 0) - (a.video.durationSec ?? 0));
    if (orphans.length) out.push({ key: "orphans", video: null as any, clips: orphans });
    return out;
  }, [props.sources]);

  const uploads = useMemo(
    () => props.sources.filter((s) => UPLOAD_KINDS.includes(s.kind) && hit(s)),
    [props.sources, needle],
  );

  /** Search reaches across sections, so say when the answer is in another one. */
  const matchesElsewhere = useMemo(() => {
    if (!needle) return 0;
    const here = tab === "videos"
      ? new Set(groups.flatMap((g) => [g.video?.sk, ...g.clips.map((c) => c.sk)]).filter(Boolean))
      : new Set(uploads.map((u) => u.sk));
    return props.sources.filter((s) => hit(s) && !here.has(s.sk)).length;
  }, [props.sources, needle, tab, groups, uploads]);

  const totalClips = props.sources.filter((s) => s.kind !== "video").length;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden border-r-2 border-border">
      <div className="shrink-0 px-3 pt-2.5 pb-2 flex flex-col gap-2 border-b border-border/40">
        <div className="flex items-baseline gap-2">
          <Kicker>Bin</Kicker>
          <span className="text-[11px] text-muted-foreground">
            {totalClips} clip{totalClips === 1 ? "" : "s"}
            {props.sources.some((s) => s.kind === "video") &&
              ` · ${props.sources.filter((s) => s.kind === "video").length} video${
                props.sources.filter((s) => s.kind === "video").length === 1 ? "" : "s"
              }`}
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
            placeholder="Search your clips and videos"
            className="flex-1 min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
            data-testid="reel-bin-search"
          />
        </label>

        <div className="grid grid-cols-3 gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-1.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] border transition-colors ${
                tab === t.id
                  ? "bg-foreground text-background border-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`reel-bin-tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {needle && matchesElsewhere > 0 && (
          <p className="text-[10px] text-muted-foreground">
            {matchesElsewhere} more match{matchesElsewhere === 1 ? "" : "es"} in another tab.
          </p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {props.loading ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">Loading your sources…</p>
        ) : tab === "create" ? (
          <div className="p-2 flex flex-col gap-3">
            <StockPanel onImported={props.onSourcesChanged} />
            <AiStillPanel onGenerated={props.onSourcesChanged} />
            <WebcamPanel busy={props.uploading} onCapture={props.onUpload} />
          </div>
        ) : tab === "uploads" ? (
          <div className="p-2 flex flex-col gap-1.5">
            {uploads.length === 0 ? (
              <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
                {needle
                  ? "Nothing here matches that."
                  : "Nothing uploaded yet. Use Add for a file on your machine, or the Create tab for stock, stills and webcam."}
              </p>
            ) : (
              uploads.map((s) => (
                <BinCard key={s.sk} source={s} selected={props.selectedKey === s.sk} onPick={() => props.onPick(s)} />
              ))
            )}
          </div>
        ) : (
          <div className="p-2 flex flex-col gap-2">
            {groups.length === 0 ? (
              <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
                No videos yet. Upload one, or connect a channel and it appears here with anything you cut from it.
              </p>
            ) : (
              groups.map((g) => {
                const shownClips = g.clips.filter(hit);
                const videoHit = g.video ? hit(g.video) : false;
                // A search hides a group only when nothing in it matches.
                if (needle && !videoHit && shownClips.length === 0) return null;
                const open = needle ? true : !collapsed[g.key];
                return (
                  <VideoGroup
                    key={g.key}
                    open={open}
                    onToggle={() => setCollapsed((c) => ({ ...c, [g.key]: !!open }))}
                    video={g.video}
                    clips={shownClips}
                    selectedKey={props.selectedKey}
                    onPick={props.onPick}
                  />
                );
              })
            )}
          </div>
        )}

        <p className="px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
          Hover a thumbnail to scrub it. Drag to V0 for a beat or V1 for an overlay, or open it in the source
          monitor to set in/out first.
        </p>
      </div>
    </div>
  );
}

/** One source video and the clips cut from it. */
function VideoGroup(props: {
  open: boolean;
  onToggle: () => void;
  video: BinSource | null;
  clips: BinSource[];
  selectedKey: string | null;
  onPick: (s: BinSource) => void;
}) {
  const { video, clips, open } = props;
  const long = (video?.durationSec ?? 0) >= 300;
  return (
    <div className="border border-border/70">
      <button
        onClick={props.onToggle}
        className="w-full flex items-center gap-2 px-2 py-1.5 bg-card/60 hover:bg-card text-left"
        data-testid={`reel-bin-group-${video ? video.videoId : "other"}`}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
              : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1">
          <span className="block text-[11.5px] font-semibold truncate text-foreground">
            {video ? video.label : "Clips from videos no longer in your library"}
          </span>
          {video && (
            <span className="block text-[10px] text-muted-foreground truncate">
              {long && <span className="text-[#a78bfa]">Long form · </span>}
              {video.meta}
              {video.unavailable && " · not pulled yet"}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {clips.length}
        </span>
      </button>

      {open && (
        <div className="p-1.5 flex flex-col gap-1.5">
          {/* The whole video as a source. Only when there is something local to
              scrub and cut — an imported row is a grouping header until it is
              pulled, and saying so beats a build error later. */}
          {video && !video.unavailable && (
            <BinCard
              source={video}
              selected={props.selectedKey === video.sk}
              onPick={() => props.onPick(video)}
            />
          )}
          {clips.length === 0 ? (
            <p className="px-1.5 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
              Nothing cut from this one yet. Use the AI reel builder, or drag the video in and cut it here.
            </p>
          ) : (
            clips.map((c) => (
              <BinCard key={c.sk} source={c} selected={props.selectedKey === c.sk} onPick={() => props.onPick(c)} />
            ))
          )}
        </div>
      )}
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
            in {fmtPrecise(srcIn)} · out {fmtPrecise(srcOut)} · {fmtT(srcOut - srcIn)}
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
          <Row label="Source in / out" value={`${fmtPrecise(item.in)} – ${fmtPrecise(item.out)}`} />
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
