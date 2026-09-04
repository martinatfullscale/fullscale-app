import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { ArrowLeft, Loader2, MousePointer2, Scissors, Type as TypeIcon } from "lucide-react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useJobPoll } from "@/hooks/use-job-poll";
import { useHistory } from "@/components/clip-studio/useHistory";
import ReelTimeline from "@/components/reel-editor/ReelTimeline";
import { Bin, Inspector, ProgramMonitor, SourceMonitor } from "@/components/reel-editor/Panels";
import {
  dur, end, fmtT, lift, MIN_ITEM_SEC, newItemId, normalise, overwriteInsert,
  rippleDelete, rippleInsert, splitAt, totalOf, tracksFor, v0Of,
  type BinSource, type ReelItem, type Track,
} from "@/components/reel-editor/types";

/**
 * Reel Editor — /library/reels/:reelId/edit
 *
 * A ROUTE, not a modal. The old builder held the whole composition in
 * `useState` inside a modal, so closing it threw the work away: no draft, no
 * autosave, no deep link, no browser back. For anyone assembling more than
 * three or four blocks that was a bigger felt gap than the missing razor.
 *
 * WHAT RENDERS TODAY vs WHAT NEEDS THE ENGINE is drawn on the page rather than
 * left for someone to discover. V0 is a real sequence the reel route already
 * renders one plan segment at a time; V1/V2/A1 are hatched placeholders,
 * because clipStitcher is a sequential concat/xfade with one input per segment
 * and no overlay node anywhere. Designing them now costs nothing and lets the
 * engine work be costed against an agreed shape; pretending they work would
 * cost a creator their afternoon.
 */

const DRAFT_VER = 1;
const draftKey = (id: string) => `fullscale.reel-draft.v${DRAFT_VER}.${id}`;

interface ApiClip {
  clipId: number; clipSource: "remix" | "editorial"; videoId: number; videoTitle: string;
  title: string | null; clipStart: number; clipEnd: number; duration: number;
  thumbnailPath: string | null; exportPath?: string | null; hasSegments: boolean;
}
interface ApiAsset { id: number; kind: string; name: string; url: string; durationSec: string | null; fileSizeBytes?: number | null }

export default function ReelEditor() {
  const params = useParams();
  const reelId = String(params.reelId ?? "new");
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const programRef = useRef<HTMLVideoElement>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // ── Sources ─────────────────────────────────────────────────────────
  const [sources, setSources] = useState<BinSource[]>([]);
  const [loadingBin, setLoadingBin] = useState(true);
  const [uploading, setUploading] = useState(false);
  /** Bumped after an upload so the bin refetches. */
  const [reloadAssets, setReloadAssets] = useState(0);
  const sourceMap = useMemo(() => new Map(sources.map((s) => [s.sk, s])), [sources]);

  useEffect(() => {
    let dead = false;
    (async () => {
      setLoadingBin(true);
      const out: BinSource[] = [];
      try {
        const res = await fetchWithTimeout("/api/remix/reel/clips", { credentials: "include" });
        const data = await res.json().catch(() => ({}));
        for (const c of (data.clips ?? []) as ApiClip[]) {
          out.push({
            // One entry per CLIP, keyed by the clip so two clips from one
            // video are two bin cards. The srcKey the server dedupes by is
            // still v:<videoId>, which is what the build payload sends.
            sk: `c:${c.clipSource}:${c.clipId}`,
            kind: "library",
            label: c.title || `${c.videoTitle} · ${fmtT(c.clipStart)}`,
            meta: `${c.videoTitle}${c.hasSegments ? " · assembled" : ""}`,
            url: c.exportPath || null,
            // A rendered clip's file starts at 0, not at the clip's position
            // in the source video — the range has to be expressed in the
            // file's own time or the monitor scrubs off the end.
            boundStart: 0,
            boundEnd: Math.max(MIN_ITEM_SEC, Number(c.duration) || c.clipEnd - c.clipStart),
            // The clip's own start inside its source video. The bin and the
            // monitors work in the rendered file's time; the build payload has
            // to be in the source video's.
            srcOffset: Number(c.clipStart) || 0,
            videoId: c.videoId,
            clipId: c.clipId,
            clipSource: c.clipSource,
            hasSegments: c.hasSegments,
            thumbnailPath: c.thumbnailPath,
          });
        }
      } catch { /* an empty bin is a valid state */ }
      try {
        const res = await fetchWithTimeout("/api/media-assets", { credentials: "include" });
        const data = await res.json().catch(() => ({}));
        for (const a of (data.assets ?? []) as ApiAsset[]) {
          const isMusic = a.kind === "music";
          const isImage = a.kind === "broll_image";
          const d = Number(a.durationSec);
          const webcam = /webcam|recording/i.test(a.name || "");
          const mb = a.fileSizeBytes ? ` · ${(a.fileSizeBytes / 1048576).toFixed(0)} MB` : "";
          out.push({
            sk: `a:${a.id}`,
            kind: isMusic ? "music" : isImage ? "ai" : webcam ? "webcam" : "upload",
            label: a.name,
            meta: `${isMusic ? "audio" : isImage ? "still" : "clip"}${mb}`,
            url: isImage || isMusic ? null : a.url,
            boundStart: 0,
            boundEnd: isImage ? 4 : Number.isFinite(d) && d > 0 ? d : 6,
            srcOffset: 0,                                   // an asset is its own file
            assetId: a.id,
            isImage,
          });
        }
      } catch { /* ditto */ }
      if (!dead) { setSources(out); setLoadingBin(false); }
    })();
    return () => { dead = true; };
  }, [reloadAssets]);

  // ── Editor state ────────────────────────────────────────────────────
  const history = useHistory<ReelItem[]>([]);
  const items = history.state;
  const [name, setName] = useState("Untitled reel");
  const [sel, setSel] = useState<string | null>(null);
  const [tool, setTool] = useState<"select" | "razor">("select");
  const [mode, setMode] = useState<"ripple" | "overwrite">("ripple");
  const [snap, setSnap] = useState(true);
  const [pps, setPps] = useState(46);
  const [ph, setPh] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [binSel, setBinSel] = useState<string | null>(null);
  const [srcIn, setSrcIn] = useState(0);
  const [srcOut, setSrcOut] = useState(6);
  const [saved, setSaved] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [restored, setRestored] = useState(false);

  const total = useMemo(() => totalOf(items), [items]);
  const selected = useMemo(() => items.find((i) => i.id === sel) ?? null, [items, sel]);
  const binSource = binSel ? sourceMap.get(binSel) ?? null : null;

  /** Every mutation goes through here, so normalise cannot be skipped. */
  const mutate = useCallback(
    (fn: (prev: ReelItem[]) => ReelItem[], label: string, token?: string) => {
      history.set((prev) => normalise(fn(prev), sourceMap), label, token);
    },
    [history, sourceMap],
  );

  // ── Draft: restore once the bin is loaded, so normalise has durations ──
  useEffect(() => {
    if (loadingBin || restored) return;
    setRestored(true);
    try {
      const raw = localStorage.getItem(draftKey(reelId));
      if (!raw) return;
      const payload = JSON.parse(raw);
      // Version-stamped and validated on read. A draft that references a
      // source whose duration has since changed is clamped, not trusted.
      if (payload?.ver !== DRAFT_VER || !Array.isArray(payload.items)) return;
      const clean = normalise(payload.items as ReelItem[], sourceMap);
      history.reset(clean);
      if (typeof payload.name === "string") setName(payload.name);
      if (Number.isFinite(payload.ph)) setPh(Number(payload.ph));
      if (clean.length) setSaved("Draft restored");
    } catch { /* a corrupt draft is not worth a crash */ }
  }, [loadingBin, restored, reelId, sourceMap, history]);

  /** Autosave: on every change, and on a 4s heartbeat while idle. */
  useEffect(() => {
    if (!restored) return;
    const write = () => {
      try {
        localStorage.setItem(draftKey(reelId), JSON.stringify({ ver: DRAFT_VER, items, name, ph }));
        // Don't claim a save on an empty timeline — "Saved 8:42 PM" over a
        // blank editor reads as though work was captured when there is none.
        if (items.length) {
          setSaved(`Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
        }
      } catch { /* quota, private mode — the editor still works */ }
    };
    const t = setTimeout(write, 400);
    const beat = setInterval(write, 4000);
    return () => { clearTimeout(t); clearInterval(beat); };
  }, [items, name, ph, reelId, restored]);

  // ── Insert ──────────────────────────────────────────────────────────
  const insert = useCallback(
    (src: BinSource, at: number, from: number, to: number, track: Track = "V0") => {
      // A source can only land where it makes sense: audio on A1, footage on
      // V0 or V1. Refusing with a reason beats silently dropping the gesture.
      const allowed = tracksFor(src.kind);
      if (!allowed.includes(track)) {
        toast({
          title: `${src.label} can't go on ${track}`,
          description: `Drop it on ${allowed.join(" or ")} instead.`,
        });
        return;
      }
      const block: ReelItem = {
        id: newItemId(),
        sk: src.sk,
        track,
        at: Math.max(0, at),
        in: from,
        out: to,
        tin: "cut",
      };
      mutate(
        // Ripple and overwrite are sequence semantics — they belong to V0.
        // An overlay is placed where it is dropped and layers over whatever
        // is underneath, which is the whole point of a layer.
        (prev) =>
          track === "V0"
            ? mode === "ripple" ? rippleInsert(prev, block) : overwriteInsert(prev, block)
            : [...prev, block],
        `Insert ${src.label} on ${track}`,
      );
      setSel(block.id);
    },
    [mutate, mode, toast],
  );

  /** V2 text. There is no source for it, so it is created rather than dropped. */
  const addText = useCallback(() => {
    const at = Math.max(0, Math.min(ph, Math.max(0, total - 1)));
    const block: ReelItem = {
      id: newItemId(),
      sk: "text",
      track: "V2",
      at,
      in: 0,
      out: 3,
      text: "New text",
    };
    mutate((prev) => [...prev, block], "Add text");
    setSel(block.id);
  }, [mutate, ph, total]);

  /**
   * Bring a file in from here. The old modal could upload and record; this
   * route could do neither, which would have been a downgrade. 30 minutes,
   * matching ClipStudio — the old builder's inline 5-minute timeout meant the
   * same file succeeded in one editor and failed in the other.
   */
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const kind = file.type.startsWith("image/") ? "broll_image" : "broll_video";
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetchWithTimeout(`/api/media-assets?kind=${kind}`, { method: "POST", body: fd, credentials: "include" }, 30 * 60_000);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setReloadAssets((n) => n + 1);
      toast({ title: "Added to the bin", description: file.name });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message ?? "Try again", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const pickBin = (s: BinSource) => {
    setBinSel(s.sk);
    setSrcIn(s.boundStart);
    setSrcOut(Math.min(s.boundEnd, s.boundStart + 6));
  };

  // ── Program playback ────────────────────────────────────────────────
  // One <video>, driven by a rAF loop that walks the V0 sequence. A gap plays
  // as black rather than skipping, because a gap is a real thing the timeline
  // can express and the export will contain.
  const activeBlock = useMemo(() => v0Of(items).find((i) => ph >= i.at - 1e-6 && ph < end(i) - 1e-6) ?? null, [items, ph]);
  const activeSrc = activeBlock ? sourceMap.get(activeBlock.sk) ?? null : null;
  const loadedFor = useRef<string | null>(null);
  const lastWall = useRef<number>(0);

  useEffect(() => {
    const v = programRef.current;
    if (!v) return;
    let raf = 0;
    lastWall.current = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.25, (now - lastWall.current) / 1000);
      lastWall.current = now;
      const blocks = v0Of(items);
      const cur = blocks.find((i) => ph >= i.at - 1e-6 && ph < end(i) - 1e-6) ?? null;

      if (!cur) {
        if (loadedFor.current !== null) { v.pause(); v.removeAttribute("src"); loadedFor.current = null; }
        if (playing) {
          const next = ph + dt;
          if (next >= total - 1e-3) { setPh(total); setPlaying(false); }
          else setPh(next);
        }
      } else {
        const src = sourceMap.get(cur.sk);
        const key = `${cur.id}:${src?.url ?? ""}`;
        if (loadedFor.current !== key) {
          loadedFor.current = key;
          if (src?.url) {
            v.src = src.url;
            const onMeta = () => {
              try { v.currentTime = Math.max(0, ph - cur.at + cur.in); } catch { /* ignore */ }
              if (playing) v.play().catch(() => {});
              v.removeEventListener("loadedmetadata", onMeta);
            };
            v.addEventListener("loadedmetadata", onMeta);
          } else {
            v.removeAttribute("src");
          }
        } else if (playing && src?.url) {
          if (v.paused) v.play().catch(() => {});
          if (v.currentTime >= cur.out - 0.03) {
            const idx = blocks.findIndex((b) => b.id === cur.id);
            const nxt = blocks[idx + 1];
            if (nxt) setPh(nxt.at);
            else { setPh(total); setPlaying(false); }
          } else {
            setPh(cur.at + (v.currentTime - cur.in));
          }
        } else if (!playing && !v.paused) {
          v.pause();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [items, ph, playing, total, sourceMap]);

  /** A manual seek must move the loaded video too, not just the number. */
  const seek = useCallback((t: number) => {
    const clamped = Math.max(0, Math.min(Math.max(total, 0.01), t));
    setPh(clamped);
    const v = programRef.current;
    const cur = v0Of(items).find((i) => clamped >= i.at - 1e-6 && clamped < end(i) - 1e-6);
    if (v && cur && loadedFor.current?.startsWith(`${cur.id}:`)) {
      try { v.currentTime = Math.max(0, clamped - cur.at + cur.in); } catch { /* ignore */ }
    }
  }, [items, total]);

  const jumpEdge = (dir: -1 | 1) => {
    const edges = Array.from(new Set(v0Of(items).flatMap((i) => [i.at, end(i)]))).sort((a, b) => a - b);
    const next = dir === 1 ? edges.find((e) => e > ph + 1e-3) : [...edges].reverse().find((e) => e < ph - 1e-3);
    seek(next ?? (dir === 1 ? total : 0));
  };

  // ── Timeline actions ────────────────────────────────────────────────
  const doSplit = useCallback((id: string, at: number) => {
    mutate((prev) => splitAt(prev, id, at), `Split at ${fmtT(at)}`);
    setTool("select");
  }, [mutate]);

  const doDelete = useCallback((ripple: boolean) => {
    if (!sel) return;
    mutate((prev) => (ripple ? rippleDelete(prev, sel) : lift(prev, sel)), ripple ? "Ripple delete" : "Lift block");
    setSel(null);
  }, [sel, mutate]);

  const fitZoom = () => {
    const el = scrollerRef.current;
    if (!el || total <= 0) return;
    setPps(Math.max(2, Math.min(60, (el.clientWidth - 40) / (total + 2))));
  };
  const toPlayhead = () => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(0, ph * pps - el.clientWidth / 2), behavior: "smooth" });
  };

  // ── Keyboard ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) history.redo(); else history.undo();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      switch (e.key) {
        case " ": e.preventDefault(); setPlaying((p) => !p); break;
        case "s": case "S":
          // Arms the razor; when already armed, splits the selection at the
          // playhead so the keyboard path does not need the mouse.
          if (tool === "razor" && sel) doSplit(sel, ph); else setTool("razor");
          break;
        case "v": case "V": setTool("select"); break;
        case "i": case "I": if (binSource) setSrcIn(Math.max(binSource.boundStart, Math.min(ph, srcOut - 0.5))); break;
        case "o": case "O": if (binSource) setSrcOut(Math.min(binSource.boundEnd, Math.max(ph, srcIn + 0.5))); break;
        case "Backspace": case "Delete":
          e.preventDefault();
          doDelete(mode === "ripple" || e.shiftKey);
          break;
        case "ArrowLeft": e.preventDefault(); seek(ph - (e.shiftKey ? 1 : 0.1)); break;
        case "ArrowRight": e.preventDefault(); seek(ph + (e.shiftKey ? 1 : 0.1)); break;
        case "Escape": setTool("select"); break;
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, sel, ph, mode, binSource, srcIn, srcOut, doSplit, doDelete, seek, history]);

  // ── Build ───────────────────────────────────────────────────────────
  const v0 = v0Of(items);
  /**
   * The only real gate is 2+ blocks on V0.
   *
   * An earlier version also demanded a library clip, on the theory that
   * `stitch_plans.videoId` being NOT NULL made an all-uploads reel
   * impossible. It does not: the server falls back to ANY video the creator
   * owns (routes.ts, anchorVideoId) because the column is bookkeeping — the
   * comment there says so, and the rendered file never reads it. So the
   * button was refusing builds the server would have accepted. It now blocks
   * only when the creator's library is genuinely empty, which is the one case
   * the server also refuses.
   */
  const ownsAnyVideo = sources.some((s) => s.videoId != null);
  const buildBlocked = v0.length < 2 ? "needs 2+ blocks" : !ownsAnyVideo ? "needs a scanned video" : null;

  const [stitchJob, setStitchJob] = useState<{ id: number } | null>(null);
  useJobPoll<{ thumbnailPath?: string | null; errorMessage?: string | null }>(
    stitchJob ? { kind: "stitch", id: stitchJob.id } : null,
    {
      intervalMs: 3000,
      maxMs: 30 * 60_000,
      onTerminal: (view) => {
        setStitchJob(null);
        setBuilding(false);
        if (view.state === "succeeded") {
          toast({ title: "Reel is ready", description: "It's in Clips & Reels." });
          navigate("/clips");
        } else {
          toast({ title: "Reel failed", description: view.result?.errorMessage || view.error || "Try again", variant: "destructive" });
        }
      },
      onTimeout: () => { setStitchJob(null); setBuilding(false); },
    },
  );

  const build = async () => {
    if (buildBlocked) return;
    setBuilding(true);
    try {
      const payload = v0.map((it) => {
        const s = sourceMap.get(it.sk);
        if (!s) return null;
        if (s.assetId != null) return { assetId: s.assetId, start: it.in, end: it.out, label: s.label };
        // An UNTRIMMED library clip publishes by id so an assembled clip keeps
        // its narrative beats; anything trimmed has to publish as a raw range.
        const untouched = Math.abs(it.in - s.boundStart) < 0.05 && Math.abs(it.out - s.boundEnd) < 0.05;
        if (untouched && s.clipId != null && s.clipSource) return { clipId: s.clipId, clipSource: s.clipSource };
        // Shift into the source video's time. Without this a block covering
        // the first 6s of a clip that starts 12s in would render the first 6s
        // of the whole video — the right length of entirely the wrong footage.
        return {
          videoId: s.videoId,
          start: it.in + s.srcOffset,
          end: it.out + s.srcOffset,
          reason: s.label,
        };
      }).filter(Boolean);

      /**
       * The overlay tracks, in the shape the server's compositor reads.
       *
       * Times go up on the AUTHORED clock (the naive sum of V0 durations,
       * which is what this timeline draws). The server remaps them onto the
       * finished file, which is shorter by every crossfade's overlap — doing
       * that here would mean duplicating the stitcher's transition maths in
       * the browser and keeping the two in step forever.
       */
      const overlayItems = items.filter((i) => i.track !== "V0");
      const pip = overlayItems.filter((i) => i.track === "V1");
      const texts = overlayItems.filter((i) => i.track === "V2");
      const bed = overlayItems.find((i) => i.track === "A1");
      const overlays = {
        broll: pip
          .map((i) => {
            const s = sourceMap.get(i.sk);
            if (!s?.assetId) return null;      // only media assets can be composited
            return {
              assetId: s.assetId, start: i.at, end: i.at + dur(i),
              srcStart: i.in, srcEnd: i.out,
              fit: "cover", scale: 0.4, x: 0.06, y: 0.06, muted: true, motion: "none",
            };
          })
          .filter(Boolean),
        textOverlays: texts.map((i) => ({
          start: i.at, end: i.at + dur(i), text: i.text ?? "",
          x: 0.5, y: 0.82, size: 0.06, color: "#ffffff", background: null,
          weight: "bold", align: "center",
        })),
        music: bed && sourceMap.get(bed.sk)?.assetId
          ? { assetId: sourceMap.get(bed.sk)!.assetId, volume: 0.2, ducking: true, duckAmountDb: 12, fadeInSec: 1, fadeOutSec: 2 }
          : undefined,
      };
      const hasOverlays = overlays.broll.length > 0 || overlays.textOverlays.length > 0 || !!overlays.music;

      const res = await fetchWithTimeout("/api/remix/reel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          items: payload,
          platformTarget: "tiktok",
          captionsEnabled: true,
          title: name || undefined,
          ...(hasOverlays ? { overlays } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.planId) throw new Error(data.error || "Could not start the reel");
      toast({ title: "Building your reel", description: `${data.segmentCount} segments from ${data.sourceCount} source${data.sourceCount === 1 ? "" : "s"}` });
      setStitchJob({ id: data.planId });
    } catch (err: any) {
      setBuilding(false);
      toast({ title: "Couldn't build reel", description: err?.message ?? "Try again", variant: "destructive" });
    }
  };

  const overlayText = useMemo(() => {
    const t = items.find((i) => i.track === "V2" && ph >= i.at && ph < end(i));
    return t?.text ?? null;
  }, [items, ph]);

  const pieceCount = useMemo(
    () => (selected?.gid ? items.filter((i) => i.gid === selected.gid).length : 0),
    [items, selected],
  );

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground" style={{ minWidth: 1360, overflowX: "auto" }}>
      {/* ── Header ── */}
      <div className="shrink-0 flex items-center gap-4 px-4 py-2.5 border-b-2 border-border bg-card/40">
        <button onClick={() => navigate("/clips")} className="p-1.5 border border-border hover:bg-white/5" title="Back to Clips & Reels">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="font-display text-[17px] font-extrabold tracking-[-0.02em]">REEL BUILDER</span>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>/library</span><span>/reels</span><span className="text-muted-foreground/50">/</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-[230px] px-2 py-1.5 text-[13px] font-semibold bg-background border border-border text-foreground outline-none focus:border-primary/60"
            data-testid="reel-name"
          />
          <span className="px-1.5 py-1 text-[11px] uppercase tracking-[0.08em] text-muted-foreground border border-border bg-secondary/40" data-testid="reel-saved">
            {saved ?? (items.length ? "Saving…" : "Empty draft")}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={history.undo}
            disabled={!history.canUndo}
            className="px-2.5 py-1.5 text-xs font-semibold border border-border hover:bg-white/5 disabled:opacity-35"
            data-testid="reel-undo"
          >
            Undo ({history.depth})
          </button>
          <button
            onClick={() => {
              mutate((prev) => prev.filter((i) => i.track !== "V0"), "Clear draft");
              setSel(null);
            }}
            className="px-2.5 py-1.5 text-xs font-semibold border border-border hover:bg-white/5"
            data-testid="reel-clear"
          >
            Clear draft
          </button>
          <button
            onClick={build}
            disabled={!!buildBlocked || building}
            className="px-3.5 py-2 text-xs font-extrabold bg-primary text-white disabled:opacity-40 inline-flex items-center gap-2"
            data-testid="reel-build"
          >
            {building && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {buildBlocked ? `Build reel — ${buildBlocked}` : `Build reel · ${v0.length} segments`}
          </button>
        </div>
      </div>

      {/* ── Upper row ── */}
      <div
        className="shrink-0 grid border-b-2 border-border"
        style={{ gridTemplateColumns: "300px minmax(320px,1fr) minmax(360px,1.15fr) 290px", height: 392 }}
      >
        <Bin sources={sources} loading={loadingBin} selectedKey={binSel} onPick={pickBin} uploading={uploading} onUpload={upload} />
        <SourceMonitor
          source={binSource}
          srcIn={srcIn}
          srcOut={srcOut}
          onRange={(a, b) => { setSrcIn(a); setSrcOut(b); }}
          canInsert={!!binSource && srcOut - srcIn >= MIN_ITEM_SEC}
          onInsert={() => binSource && insert(binSource, ph, srcIn, srcOut)}
        />
        <ProgramMonitor
          videoRef={programRef}
          activeLabel={activeSrc?.label ?? null}
          overlayText={overlayText}
          playhead={ph}
          total={total}
          playing={playing}
          onPlayPause={() => setPlaying((p) => !p)}
          onHome={() => seek(0)}
          onEdge={jumpEdge}
        />
        <Inspector
          item={selected}
          source={selected ? sourceMap.get(selected.sk) ?? null : null}
          pieceCount={pieceCount}
          onSplit={() => selected && doSplit(selected.id, ph)}
          onRippleDelete={() => doDelete(true)}
          onLift={() => doDelete(false)}
        />
      </div>

      {/* ── Toolbar ── */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border/40 bg-card/20">
        <div className="flex border border-border">
          <button
            onClick={() => setTool("select")}
            className={`px-2.5 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5 ${tool === "select" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
            data-testid="reel-tool-select"
          >
            <MousePointer2 className="w-3.5 h-3.5" /> Select · V
          </button>
          <button
            onClick={() => setTool("razor")}
            className={`px-2.5 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5 ${tool === "razor" ? "bg-primary text-white" : "text-muted-foreground hover:text-foreground"}`}
            data-testid="reel-tool-razor"
          >
            <Scissors className="w-3.5 h-3.5" /> Razor · S
          </button>
        </div>
        <div className="flex border border-border">
          {(["ripple", "overwrite"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2.5 py-1.5 text-[11px] font-semibold capitalize ${mode === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
              data-testid={`reel-mode-${m}`}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={addText}
          className="px-2.5 py-1.5 text-[11px] font-semibold border border-border text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5"
          data-testid="reel-add-text"
        >
          <TypeIcon className="w-3.5 h-3.5" /> Add text
        </button>
        <button
          onClick={() => setSnap((s) => !s)}
          className={`px-2.5 py-1.5 text-[11px] font-semibold border ${snap ? "border-primary/45 bg-primary/15 text-primary" : "border-border text-muted-foreground"}`}
          data-testid="reel-snap"
        >
          Snapping {snap ? "on" : "off"}
        </button>

        <div className="ml-auto flex items-center gap-3">
          <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">{Math.round(pps)} px/s</span>
          <input
            type="range" min={2} max={60} step={1} value={pps}
            onChange={(e) => setPps(Number(e.target.value))}
            className="w-[120px] h-1 appearance-none rounded bg-white/10 accent-primary cursor-pointer"
            data-testid="reel-zoom"
          />
          <button onClick={fitZoom} className="px-2 py-1.5 text-[11px] border border-border hover:bg-white/5">Fit</button>
          <button onClick={toPlayhead} className="px-2 py-1.5 text-[11px] border border-border hover:bg-white/5">To playhead</button>
          <span className="text-[11.5px] font-semibold tabular-nums">Total {fmtT(total)}</span>
        </div>
      </div>

      {/* ── Timeline ── */}
      <div className="flex-1 min-h-[300px] flex">
        <ReelTimeline
          items={items}
          sources={sourceMap}
          total={total}
          playhead={ph}
          pps={pps}
          tool={tool}
          snap={snap}
          selectedId={sel}
          onSeek={seek}
          onSelect={setSel}
          onItems={mutate}
          onSplit={doSplit}
          onDropSource={(sk, at, track) => {
            const s = sourceMap.get(sk);
            if (!s) return;
            // A bed runs the length of the reel by default; an overlay is a
            // short beat over it.
            const len = track === "A1" ? Math.max(1, total || 6) : Math.min(s.boundEnd - s.boundStart, 6);
            insert(s, track === "A1" ? 0 : at, s.boundStart, s.boundStart + len, track);
          }}
          onScrollerReady={(el) => { scrollerRef.current = el; }}
        />
      </div>

      {/* ── Phase line ── */}
      <div className="shrink-0 grid grid-cols-2 border-t-2 border-border">
        <div className="p-3 border-r-2 border-border">
          <p className="text-[10px] uppercase tracking-[0.1em] text-primary font-semibold mb-1">How this renders</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            V0 is stitched first — one plan segment per block, in order, with the junction transition above. V1, V2
            and A1 are then composited in a second pass over that finished file, so an overlay is anchored to the
            reel rather than to any one segment.
          </p>
        </div>
        <div className="p-3">
          <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground font-semibold mb-1">Still honest about</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            A branded wipe renders as a plain fade — the stitcher maps both to xfade. Overlays are laid out against
            the sum of the blocks and remapped onto the finished reel, which is shorter by each crossfade's overlap;
            the program monitor shows the longer, un-crossfaded clock.
          </p>
        </div>
      </div>
    </div>
  );
}
