/**
 * Story Clip Editor — the timeline is the object.
 *
 * What was here was a single-clip PARAMETER EDITOR with a video in it: six
 * mutually exclusive tool tabs writing into one flat object, and a 40px strip
 * under the player that looked like a timeline but was only a scrubber.
 * Nothing on screen could be grabbed, split or stacked, which is why the
 * feedback was "it doesn't look like CapCut or Instagram Edits."
 *
 *   ┌─────────┬──────────────────────┬───────────┐
 *   │  BIN    │       CANVAS         │ INSPECTOR │  the six tools became
 *   │ one     │  video + overlays    │ follows   │  properties of the
 *   │ pool    │  + transport         │ selection │  selection, not modes
 *   ├─────────┴──────────────────────┴───────────┤
 *   │ V2 text · V1 b-roll · V0 base · A1 bed     │  a real timeline
 *   └────────────────────────────────────────────┘
 *
 * THE TRACK MODEL IS EXACTLY WHAT THE FILTERGRAPH CAN RENDER. B-roll and text
 * are overlay nodes gated by enable='between(t,…)'; the base is one fixed
 * source that can be split, retimed and trimmed; there is one music bed. No
 * blend modes, no opacity, no keyframes, no in-clip transitions — the chain
 * has no nodes for them, and a control that cannot render is worse than no
 * control. What this design does ask of the engine is listed in
 * docs/BRIEF_STORY_CLIP_EDITOR.md §1f; the three small ones shipped with it.
 *
 * THREE THINGS THIS FIXES THAT WERE ACTUALLY BROKEN
 *   1. Uploaded footage now has a source in/out. The render used to always
 *      play the head of the file while the preview seeked to t − cut.start,
 *      so preview and export showed different frames.
 *   2. An assembled clip says so BEFORE the work is lost. The whole edit
 *      stack is dropped at render for a multi-beat clip; that used to surface
 *      as amber small print after the fact.
 *   3. There is an undo stack. What stood in for one was a button that
 *      cleared every word cut at once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, Camera, ChevronsLeft, ChevronsRight, Loader2, Pause, Play,
  Redo2, Scissors, Sparkles, Type as TypeIcon, Undo2, X as XIcon, ZoomIn, ZoomOut,
} from "lucide-react";
import { fetchWithTimeout } from "@/lib/queryClient";
import Timeline from "./clip-studio/Timeline";
import MediaBin from "./clip-studio/MediaBin";
import { BaseSegmentInspector, BrollInspector, EmptyInspector, MusicInspector, TextInspector } from "./clip-studio/Inspectors";
import { newGestureToken, useHistory } from "./clip-studio/useHistory";
import { BrollTool, CaptionsTool, TranscriptTool, useAssets } from "./clip-studio/legacyTools";
import {
  baseGainOf, baseSegments, CAPS, fmtTime, isAssembled, removedSpans,
  type AssetRow, type BrollEdit, type ClipShape, type Segment, type Selection,
  type StudioEdits, type TextOverlayEdit, type Word,
} from "./clip-studio/types";

export type { StudioEdits, WordCut, TextOverlayEdit } from "./clip-studio/types";

const FILLERS = new Set(["um", "uh", "erm", "hmm", "mm-hmm", "mmhmm", "ah", "eh", "like", "so", "actually", "basically", "literally"]);
const normalize = (w: string) => w.toLowerCase().replace(/[^a-z-]/g, "");
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

interface Props {
  clip: ClipShape;
  videoId: number;
  onClose: () => void;
  onApply: (payload: {
    aspect: "9:16" | "16:9";
    captionsEnabled: boolean;
    captionStyle: string;
    captionSettings: Record<string, number | string>;
    edits: StudioEdits;
    /** Set only by the trim handles and by Collapse — omitted otherwise, so a
     *  normal save never touches the clip's bounds. */
    clipStart?: number;
    clipEnd?: number;
  }) => Promise<void>;
}

export default function ClipStudio({ clip, videoId, onClose, onApply }: Props) {
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const brollRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  /** The transcript's follow-along anchor. Declared here, not in the panel's
   *  JSX branch — a hook inside a conditional render is a hook that stops
   *  being called the moment the panel closes. */
  const activeWordRef = useRef<HTMLSpanElement>(null);

  const assembled = isAssembled(clip);
  const beatCount = clip.segments?.length ?? 0;
  /**
   * What "collapse" actually produces.
   *
   * For an assembled clip `duration` is the SUM of the beats while clipStart
   * and clipEnd are their outer bounds, so collapsing to one continuous range
   * gives clipEnd − clipStart — which puts the material BETWEEN the beats
   * back in. That is genuinely what "one continuous range" means, and it is
   * also a surprise if nobody says the number, so the button says it.
   */
  const collapsedDuration = Math.max(0, Number(clip.clipEnd) - Number(clip.clipStart));
  const collapseAdds = collapsedDuration - Number(clip.duration);

  // ── State ───────────────────────────────────────────────────────────
  const history = useHistory<StudioEdits>({
    wordCuts: clip.edits?.wordCuts ?? [],
    silenceCut: clip.edits?.silenceCut ?? null,
    speedRamps: clip.edits?.speedRamps ?? [],
    captionEdits: clip.edits?.captionEdits ?? [],
    textOverlays: clip.edits?.textOverlays ?? [],
    broll: clip.edits?.broll ?? [],
    music: clip.edits?.music ?? null,
    stabilization: clip.edits?.stabilization ?? null,
    baseAudioLevel: clip.edits?.baseAudioLevel ?? null,
    splits: clip.edits?.splits ?? [],
  });
  const edits = history.state;

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [collapsing, setCollapsing] = useState(false);
  const [settingCover, setSettingCover] = useState(false);
  const [coverOverride, setCoverOverride] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [razor, setRazor] = useState(false);
  const [snapOn, setSnapOn] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [panel, setPanel] = useState<"none" | "transcript" | "captions" | "history">("none");
  const [keepBeats, setKeepBeats] = useState(false);
  /** Trim, clip-relative. Only sent when the handles were actually moved. */
  const [trim, setTrim] = useState<{ start: number; end: number } | null>(null);

  const cs0 = (clip.captionSettings ?? {}) as Record<string, any>;
  const [cs, setCs] = useState<Record<string, number | string>>({
    sizeScale: Number(cs0.sizeScale ?? 1),
    positionRatio: Number(cs0.positionRatio ?? 0.14),
    wordsPerPhrase: Number(cs0.wordsPerPhrase ?? 4),
    outline: Number(cs0.outline ?? 3),
    accentHex: String(cs0.accentHex ?? "#FFE500"),
  });
  const [captionsEnabled, setCaptionsEnabled] = useState(clip.captionsEnabled !== false);
  const [captionStyle, setCaptionStyle] = useState(String(clip.captionStyle || "highlight"));
  const [aspect, setAspect] = useState<"9:16" | "16:9">(clip.aspectRatio === "16:9" ? "16:9" : "9:16");
  const [silenceInfo, setSilenceInfo] = useState<{ spans: number; totalSilentSec: number } | null>(
    clip.silenceAnalysis ? { spans: clip.silenceAnalysis.spans.length, totalSilentSec: clip.silenceAnalysis.totalSilentSec } : null,
  );

  /**
   * Layers are unavailable on an assembled clip, and the editor says so up
   * front rather than after the render throws the work away. `keepBeats`
   * lets someone dismiss the banner and keep working on what still applies —
   * captions and aspect render either way.
   */
  const layersLocked = assembled;
  /**
   * Trim is unavailable on an assembled clip, and this is not cosmetic.
   * The editor's timeline runs 0..duration where duration is the SUM of the
   * beats, but clipStart/clipEnd are the outer bounds of a span with gaps in
   * it — so clipStart + trim.start points at the wrong source second. On a
   * clip with beats [100,110],[200,210],[300,310] a 5s trim off the tail
   * would render source 100–125 and throw the other two beats away.
   */
  const trimLocked = assembled;

  // ── Data ────────────────────────────────────────────────────────────
  const { data: assetData, isLoading: loadingAssets } = useAssets(["broll_video", "broll_image", "music"]);
  const assets: AssetRow[] = assetData?.assets ?? [];
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const assetNames = useMemo(() => new Map(assets.map((a) => [a.id, a.name])), [assets]);

  const { data: transcript, isLoading: loadingTranscript } = useQuery<{ segments: Segment[] }>({
    queryKey: ["/api/video", videoId, "transcript"],
    queryFn: async () => {
      const res = await fetchWithTimeout(`/api/video/${videoId}/transcript`, { credentials: "include" });
      if (!res.ok) throw new Error("No transcript for this video yet");
      return res.json();
    },
  });

  /** The transcript sliced to this clip and rebased to clip-relative time. */
  const clipWords = useMemo<Word[]>(() => {
    const out: Word[] = [];
    for (const seg of transcript?.segments ?? []) {
      const words = seg.words?.length
        ? seg.words
        : seg.text.trim().split(/\s+/).filter(Boolean).map((w, i, arr) => {
            const span = (seg.end - seg.start) / Math.max(1, arr.length);
            return { word: w, start: seg.start + i * span, end: seg.start + (i + 1) * span };
          });
      for (const w of words) {
        if (w.end <= clip.clipStart || w.start >= clip.clipEnd) continue;
        out.push({ ...w, start: Math.max(0, w.start - clip.clipStart), end: Math.min(clip.duration, w.end - clip.clipStart) });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }, [transcript, clip.clipStart, clip.clipEnd, clip.duration]);

  const clipLines = useMemo(
    () =>
      (transcript?.segments ?? [])
        .filter((sg) => sg.end > clip.clipStart && sg.start < clip.clipEnd)
        .map((sg) => ({
          start: Math.max(0, sg.start - clip.clipStart),
          end: Math.min(clip.duration, sg.end - clip.clipStart),
          text: sg.text,
        }))
        .filter((l) => l.end > l.start),
    [transcript, clip.clipStart, clip.clipEnd, clip.duration],
  );

  // ── Derived ─────────────────────────────────────────────────────────
  const cuts = edits.wordCuts ?? [];
  const isCut = useCallback(
    (w: { start: number; end: number }) => cuts.some((c) => w.start >= c.start - 0.01 && w.end <= c.end + 0.01),
    [cuts],
  );
  const fillerWords = useMemo(() => clipWords.filter((w) => FILLERS.has(normalize(w.word)) && !isCut(w)), [clipWords, isCut]);
  const segments = useMemo(() => baseSegments(edits, clip.duration), [edits, clip.duration]);
  /**
   * Ramps whose bounds line up with no segment.
   *
   * baseSegments only claims a ramp when BOTH ends match within 0.05s, so a
   * ramp saved by the old editor — which wrote [playhead, playhead+3] with no
   * relation to any boundary — shows as 1.00x on the chips, is un-clearable,
   * and still renders. The inspector surfaces these rather than pretending
   * they are not there.
   */
  const orphanRamps = useMemo(
    () =>
      (edits.speedRamps ?? []).filter(
        (r) => !segments.some((sg) => Math.abs(sg.start - r.start) < 0.05 && Math.abs(sg.end - r.end) < 0.05),
      ),
    [edits.speedRamps, segments],
  );
  const previewCuts = useMemo(() => removedSpans(edits, clip.silenceAnalysis), [edits, clip.silenceAnalysis]);
  const removedSec = useMemo(() => previewCuts.reduce((n, s) => n + (s.end - s.start), 0), [previewCuts]);
  const outDuration = Math.max(0, (trim ? trim.end - trim.start : clip.duration) - removedSec);

  const rampAt = useCallback(
    (time: number) => (edits.speedRamps ?? []).find((r) => time >= r.start && time < r.end)?.rate ?? 1,
    [edits.speedRamps],
  );
  const brollAt = useCallback(
    (time: number) => (edits.broll ?? []).find((b) => time >= b.start && time < b.end) ?? null,
    [edits.broll],
  );
  const activeBroll = brollAt(t);

  // ── Edit helpers ────────────────────────────────────────────────────
  const patch = useCallback(
    (fn: (p: StudioEdits) => StudioEdits, label: string, token?: string) => history.set(fn, label, token),
    [history],
  );

  const toggleWord = (w: Word) => {
    const existing = cuts.find((c) => w.start >= c.start - 0.01 && w.end <= c.end + 0.01);
    patch(
      (p) =>
        existing
          ? { ...p, wordCuts: (p.wordCuts ?? []).filter((c) => c !== existing) }
          : { ...p, wordCuts: [...(p.wordCuts ?? []), { start: w.start, end: w.end, text: w.word, reason: "manual" as const }] },
      existing ? `Restore "${w.word}"` : `Strike "${w.word}"`,
    );
  };

  const split = (at: number) => {
    // Refuse a cut that would produce no second piece. baseSegments drops
    // anything within 0.05s of an end and the validator drops a 0 outright,
    // so a split at the very edge used to be stored, drawn nowhere, and then
    // occupy one of the 16 slots forever.
    if (!(at > 0.1 && at < clip.duration - 0.1)) return;
    if ((edits.splits ?? []).length >= CAPS.splits) return;
    if ((edits.splits ?? []).some((s) => Math.abs(s - at) < 0.1)) return;
    patch((p) => ({ ...p, splits: [...(p.splits ?? []), Number(at.toFixed(2))].sort((a, b) => a - b) }), `Split at ${fmtTime(at)}`);
    setRazor(false);
  };

  const addText = () => {
    if ((edits.textOverlays ?? []).length >= CAPS.textOverlays) return;
    const start = Math.min(t, Math.max(0, clip.duration - 2));
    const block: TextOverlayEdit = {
      start, end: Math.min(clip.duration, start + 3), text: "New text",
      x: 0.5, y: 0.82, size: 0.06, color: "#ffffff", background: null, weight: "bold", align: "center",
    };
    patch((p) => ({ ...p, textOverlays: [...(p.textOverlays ?? []), block] }), "Add text");
    setSelection({ kind: "text", index: (edits.textOverlays ?? []).length });
  };

  /**
   * Place an asset on V1. The length comes from the SOURCE, not from a fixed
   * three seconds — the old addAt() always dropped a 3s block whatever you
   * gave it, which is why a two-second cutaway had to be hand-trimmed and a
   * thirty-second one silently lost twenty-seven.
   */
  const placeAsset = (assetId: number, at: number) => {
    const asset = assetById.get(assetId);
    /**
     * An audio file is a bed, not a cutaway.
     *
     * The bin shows music in the same grid as footage, and clicking a track
     * is the obvious gesture for "use this underneath". Without this branch
     * the mp3 went onto V1 as b-roll, rendered nothing, and handed ffmpeg an
     * audio file as a video overlay input.
     */
    if (asset?.kind === "music") {
      patch(
        (p) => ({
          ...p,
          music: p.music?.assetId === assetId
            ? p.music
            : { assetId, volume: 0.2, ducking: true, duckAmountDb: 12, fadeInSec: 1, fadeOutSec: 2 },
        }),
        `Music bed: ${asset.name}`,
      );
      setSelection({ kind: "music" });
      return;
    }
    if ((edits.broll ?? []).length >= CAPS.broll) return;
    const srcLen = Number(asset?.durationSec);
    const wanted = asset?.kind === "broll_image" ? 4 : Number.isFinite(srcLen) && srcLen > 0 ? Math.min(srcLen, 12) : 3;
    const start = Math.max(0, Math.min(at, Math.max(0, clip.duration - 0.5)));
    const end = Math.min(clip.duration, start + Math.max(0.5, wanted));
    const cut: BrollEdit = {
      assetId, start, end,
      ...(asset?.kind !== "broll_image" && Number.isFinite(srcLen) && srcLen > 0
        ? { srcStart: 0, srcEnd: Math.min(srcLen, end - start) }
        : {}),
      fit: "cover", scale: 1, x: 1, y: 0, muted: true, motion: "push",
    };
    patch((p) => ({ ...p, broll: [...(p.broll ?? []), cut] }), `Add ${asset?.name ?? "b-roll"} at ${fmtTime(start)}`);
    setSelection({ kind: "broll", index: (edits.broll ?? []).length });
  };

  const uploadAsset = async (file: File, kind: "broll_video" | "broll_image" | "music") => {
    // The file itself is always worth keeping — it lands in the library
    // either way. What must not happen on an assembled clip is auto-attaching
    // it as a bed the render will silently drop.
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetchWithTimeout(`/api/media-assets?kind=${kind}`, {
        method: "POST", body: fd, credentials: "include",
      }, UPLOAD_TIMEOUT_MS);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed");
      await queryClient.invalidateQueries({ queryKey: ["/api/media-assets"] });
      if (kind === "music" && data.asset?.id && !layersLocked) {
        patch(
          (p) => ({ ...p, music: { assetId: data.asset.id, volume: 0.2, ducking: true, duckAmountDb: 12, fadeInSec: 1, fadeOutSec: 2 } }),
          `Add music bed ${file.name}`,
        );
      }
    } catch (err: any) {
      alert(err?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const analyzeSilence = async () => {
    setAnalyzing(true);
    try {
      const res = await fetchWithTimeout(`/api/editorial-clips/${clip.id}/analyze-silence`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({}),
      }, 120_000);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      setSilenceInfo({ spans: data.spans.length, totalSilentSec: data.totalSilentSec });
      patch(
        (p) => ({ ...p, silenceCut: { enabled: true, thresholdDb: data.thresholdDb, minDurationSec: data.minDurationSec, paddingSec: 0.15 } }),
        `Remove ${Number(data.totalSilentSec).toFixed(1)}s of silence`,
      );
    } catch (err: any) {
      alert(err?.message || "Silence analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Playback ────────────────────────────────────────────────────────
  // The playhead runs on rAF, not on `timeupdate`. Browsers fire timeupdate
  // about four times a second, which is fine for a text readout and visibly
  // steppy for a playhead crossing a timeline.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      const now = v.currentTime;
      const inCut = previewCuts.find((c) => now >= c.start - 0.03 && now < c.end - 0.03);
      if (inCut) {
        if (inCut.end >= clip.duration - 0.05) { v.pause(); setPlaying(false); }
        else v.currentTime = inCut.end;
        setT(inCut.end);
      } else {
        const rate = rampAt(now);
        if (Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
        setT(now);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onEnd = () => setPlaying(false);
    v.addEventListener("ended", onEnd);
    return () => { cancelAnimationFrame(raf); v.removeEventListener("ended", onEnd); };
  }, [clip.exportPath, previewCuts, rampAt, clip.duration]);

  /**
   * The b-roll layer follows the main clock — and now reads the SAME source
   * in-point the render does. It used to seek to `t - cut.start`, i.e. always
   * from the head, while the filtergraph fed the overlay its own unshifted
   * timeline: two different sets of frames for the same edit.
   */
  useEffect(() => {
    const b = brollRef.current;
    if (!b || !activeBroll) return;
    const from = Number.isFinite(Number(activeBroll.srcStart)) ? Number(activeBroll.srcStart) : 0;
    const local = from + Math.max(0, t - activeBroll.start);
    if (Math.abs(b.currentTime - local) > 0.3) b.currentTime = local;
    if (playing && b.paused) b.play().catch(() => {});
    if (!playing && !b.paused) b.pause();
  }, [t, playing, activeBroll]);

  /** Keep the spoken word in view while playing. The old editor did this and
   *  the rewrite kept the ref but lost the effect, so the transcript panel —
   *  the whole point of which is following along — stopped scrolling. */
  useEffect(() => {
    if (playing && panel === "transcript") {
      activeWordRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [t, playing, panel]);

  const seek = useCallback((sec: number) => {
    const clamped = Math.max(0, Math.min(clip.duration, sec));
    setT(clamped);
    const v = videoRef.current;
    if (v) v.currentTime = clamped;
  }, [clip.duration]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); setPlaying(true); } else { v.pause(); setPlaying(false); }
  }, []);

  // ── Keyboard ────────────────────────────────────────────────────────
  // The editor had no shortcuts at all. Transport plus undo is the floor;
  // anything typed into a field or textarea is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) history.redo(); else history.undo();
        return;
      }
      if (meta && e.key.toLowerCase() === "k") { e.preventDefault(); setRazor((r) => !r); return; }
      if (meta) return;
      switch (e.key) {
        case " ": e.preventDefault(); togglePlay(); break;
        case "Escape":
          if (razor) { setRazor(false); e.preventDefault(); }
          else if (panel !== "none") { setPanel("none"); e.preventDefault(); }
          break;
        case "j": seek(t - 2); break;
        case "k": togglePlay(); break;
        case "l": seek(t + 2); break;
        case "s": setRazor((r) => !r); break;
        case "ArrowLeft": e.preventDefault(); seek(t - (e.shiftKey ? 1 : 1 / 30)); break;
        case "ArrowRight": e.preventDefault(); seek(t + (e.shiftKey ? 1 : 1 / 30)); break;
        case "Home": e.preventDefault(); seek(0); break;
        case "End": e.preventDefault(); seek(clip.duration); break;
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t, razor, panel, seek, togglePlay, history, clip.duration]);

  // ── Canvas overlays ─────────────────────────────────────────────────
  const captionLine = useMemo(() => {
    if (!captionsEnabled) return null;
    const perPhrase = Number(cs.wordsPerPhrase ?? 4);
    const visible = clipWords.filter((w) => !isCut(w));
    const idx = visible.findIndex((w) => t >= w.start && t < w.end);
    if (idx < 0) return null;
    const from = Math.floor(idx / perPhrase) * perPhrase;
    return { words: visible.slice(from, from + perPhrase), activeIdx: idx - from };
  }, [captionsEnabled, clipWords, isCut, t, cs.wordsPerPhrase]);

  /** Drag a text block on the video — the control that unfreezes x. */
  const dragText = (index: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelection({ kind: "text", index });
    const box = canvasRef.current?.getBoundingClientRect();
    if (!box) return;
    const token = newGestureToken("canvas-text");
    const move = (ev: PointerEvent) => {
      const x = Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width));
      const y = Math.max(0, Math.min(1, (ev.clientY - box.top) / box.height));
      patch(
        (p) => {
          const next = [...(p.textOverlays ?? [])];
          if (!next[index]) return p;
          next[index] = { ...next[index], x, y };
          return { ...p, textOverlays: next };
        },
        `Move text → ${x.toFixed(2)} / ${y.toFixed(2)}`,
        token,
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const setCover = async () => {
    if (!clip.exportPath) return;
    setSettingCover(true);
    try {
      const res = await fetchWithTimeout(`/api/editorial-clips/${clip.id}/cover`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ atSec: t }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.thumbnailPath) {
        setCoverOverride(`${data.thumbnailPath}${data.thumbnailPath.includes("?") ? "&" : "?"}v=${Date.now()}`);
      }
    } finally {
      setSettingCover(false);
    }
  };

  // ── Save ────────────────────────────────────────────────────────────
  /**
   * Dirty was permanently TRUE: the baseline it compared against omitted
   * captionEdits while the live object always carried the key, so the two
   * JSON strings could never match and the button never once said "No
   * changes". Comparing the same key set fixes it.
   */
  const baseline = useMemo(
    () =>
      JSON.stringify({
        wordCuts: clip.edits?.wordCuts ?? [],
        silenceCut: clip.edits?.silenceCut ?? null,
        speedRamps: clip.edits?.speedRamps ?? [],
        captionEdits: clip.edits?.captionEdits ?? [],
        textOverlays: clip.edits?.textOverlays ?? [],
        broll: clip.edits?.broll ?? [],
        music: clip.edits?.music ?? null,
        stabilization: clip.edits?.stabilization ?? null,
        baseAudioLevel: clip.edits?.baseAudioLevel ?? null,
        splits: clip.edits?.splits ?? [],
      }),
    [clip.edits],
  );
  const dirty =
    JSON.stringify(edits) !== baseline ||
    !!trim ||
    captionsEnabled !== (clip.captionsEnabled !== false) ||
    captionStyle !== String(clip.captionStyle || "highlight") ||
    aspect !== (clip.aspectRatio === "16:9" ? "16:9" : "9:16");

  const buildPayload = (over?: { clipStart?: number; clipEnd?: number; edits?: StudioEdits }) => ({
    aspect,
    captionsEnabled,
    captionStyle,
    captionSettings: {
      sizeScale: Number(cs.sizeScale ?? 1),
      positionRatio: Number(cs.positionRatio ?? 0.14),
      wordsPerPhrase: Number(cs.wordsPerPhrase ?? 4),
      outline: Number(cs.outline ?? 3),
      accentHex: String(cs.accentHex ?? "#FFE500"),
    },
    edits: over?.edits ?? edits,
    ...(over?.clipStart !== undefined ? { clipStart: over.clipStart } : {}),
    ...(over?.clipEnd !== undefined ? { clipEnd: over.clipEnd } : {}),
  });

  const apply = async () => {
    setBusy(true);
    try {
      if (trim) {
        // A trim re-cuts the clip, so every edit time — which is relative to
        // the clip's start — has to move with it, and anything now outside
        // the new bounds has to go. Doing this at save rather than live keeps
        // the timeline honest: until the re-render lands, the clip really is
        // still the old length.
        const shift = trim.start;
        const len = trim.end - trim.start;
        /**
         * `min` is per-kind, deliberately. A single 0.3s floor across every
         * list threw away every struck filler word: "um" is typically 0.2s,
         * so trimming a clip silently un-struck every filler the creator had
         * removed and the re-render put them all back in. Blocks really do
         * have a 0.3s server floor; word cuts and caption fixes do not.
         */
        const inRange = <T extends { start: number; end: number }>(min: number) => (x: T): T | null => {
          const s = Math.max(0, x.start - shift);
          const e = Math.min(len, x.end - shift);
          return e - s >= min ? ({ ...x, start: s, end: e } as T) : null;
        };
        const TINY = 0.01;
        const shifted: StudioEdits = {
          ...edits,
          wordCuts: (edits.wordCuts ?? []).map(inRange(TINY)).filter(Boolean) as StudioEdits["wordCuts"],
          speedRamps: (edits.speedRamps ?? []).map(inRange(0.2)).filter(Boolean) as StudioEdits["speedRamps"],
          captionEdits: (edits.captionEdits ?? []).map(inRange(TINY)).filter(Boolean) as StudioEdits["captionEdits"],
          textOverlays: (edits.textOverlays ?? []).map(inRange(0.3)).filter(Boolean) as StudioEdits["textOverlays"],
          broll: (edits.broll ?? []).map(inRange(0.3)).filter(Boolean) as StudioEdits["broll"],
          splits: (edits.splits ?? []).map((s) => s - shift).filter((s) => s > 0.1 && s < len - 0.1),
          // The stored silence analysis is measured from the OLD clipStart and
          // the server does not re-base it, so keeping it on would remove
          // spans several seconds away from the real pauses. Dropping it is
          // the honest outcome; the banner tells the creator to re-run it.
          silenceCut: null,
        };
        await onApply(buildPayload({
          clipStart: clip.clipStart + trim.start,
          clipEnd: clip.clipStart + trim.end,
          edits: shifted,
        }));
      } else {
        await onApply(buildPayload());
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Collapse an assembled clip to one continuous range.
   *
   * No new endpoint: the rerender route's trim branch already nulls
   * `segments` whenever it is given clipStart/clipEnd, and that branch had
   * simply never been reachable from any client.
   */
  const collapse = async () => {
    setCollapsing(true);
    try {
      await onApply(buildPayload({ clipStart: clip.clipStart, clipEnd: clip.clipEnd }));
      onClose();
    } finally {
      setCollapsing(false);
    }
  };

  // ── Inspector ───────────────────────────────────────────────────────
  const inspector = (() => {
    if (selection?.kind === "segment") {
      const seg = segments[selection.index];
      if (!seg) return <EmptyInspector locked={layersLocked} />;
      return (
        <BaseSegmentInspector
          segment={seg}
          total={segments.length}
          edits={edits}
          locked={layersLocked}
          orphanRamps={orphanRamps}
          onClearOrphanRamps={() =>
            patch(
              (p) => ({ ...p, speedRamps: (p.speedRamps ?? []).filter((r) => !orphanRamps.includes(r)) }),
              `Clear ${orphanRamps.length} stray speed ramp${orphanRamps.length === 1 ? "" : "s"}`,
            )
          }
          words={clipWords}
          isCut={isCut}
          onToggleWord={(w) => toggleWord(w as Word)}
          onRate={(rate) =>
            patch((p) => {
              const rest = (p.speedRamps ?? []).filter((r) => !(Math.abs(r.start - seg.start) < 0.05 && Math.abs(r.end - seg.end) < 0.05));
              if (Math.abs(rate - 1) < 0.01) return { ...p, speedRamps: rest };
              if (rest.length >= CAPS.speedRamps) return p;
              return { ...p, speedRamps: [...rest, { start: seg.start, end: seg.end, rate }] };
            }, `Segment ${seg.index + 1} at ${rate.toFixed(2)}×`)
          }
          onRemoveSegment={() =>
            patch(
              (p) => ({ ...p, wordCuts: [...(p.wordCuts ?? []), { start: seg.start, end: seg.end, reason: "manual" as const, text: `segment ${seg.index + 1}` }] }),
              `Remove segment ${seg.index + 1}`,
            )
          }
          onRestoreSegment={() =>
            patch(
              (p) => ({ ...p, wordCuts: (p.wordCuts ?? []).filter((c) => !(c.start <= seg.start + 0.05 && c.end >= seg.end - 0.05)) }),
              `Restore segment ${seg.index + 1}`,
            )
          }
          onSplitAtPlayhead={() => split(t)}
          onStabilize={(v) => patch((p) => ({ ...p, stabilization: v }), v ? "Stabilize on" : "Stabilize off")}
          onStabilizeStrength={(strength, token) =>
            patch((p) => ({ ...p, stabilization: { enabled: true, strength } }), `Stabilize strength ${strength}`, token)
          }
          onBaseAudio={(level, token) =>
            patch(
              (p) => ({ ...p, baseAudioLevel: Math.abs(level - 1) < 0.01 ? null : level }),
              Math.abs(level - 1) < 0.01 ? "Clip audio unchanged" : `Clip audio ${level.toFixed(2)}×`,
              token,
            )
          }
        />
      );
    }
    if (selection?.kind === "broll") {
      const cut = (edits.broll ?? [])[selection.index];
      if (!cut) return <EmptyInspector locked={layersLocked} />;
      const asset = assetById.get(cut.assetId);
      const dur = Number(asset?.durationSec);
      return (
        <BrollInspector
          cut={cut}
          index={selection.index}
          count={(edits.broll ?? []).length}
          assetName={asset?.name ?? `asset ${cut.assetId}`}
          assetDuration={Number.isFinite(dur) && dur > 0 ? dur : 0}
          isImage={asset?.kind === "broll_image"}
          onPatch={(p2, label, token) =>
            patch((p) => {
              const next = [...(p.broll ?? [])];
              if (!next[selection.index]) return p;
              next[selection.index] = { ...next[selection.index], ...p2 };
              return { ...p, broll: next };
            }, label, token)
          }
          onDuplicate={() =>
            patch((p) => {
              if ((p.broll ?? []).length >= CAPS.broll) return p;
              const len = cut.end - cut.start;
              const start = Math.min(clip.duration - 0.5, cut.end + 0.2);
              return { ...p, broll: [...(p.broll ?? []), { ...cut, start, end: Math.min(clip.duration, start + len) }] };
            }, "Duplicate b-roll")
          }
          onDelete={() => {
            patch((p) => ({ ...p, broll: (p.broll ?? []).filter((_, i) => i !== selection.index) }), "Delete b-roll");
            setSelection(null);
          }}
        />
      );
    }
    if (selection?.kind === "text") {
      const o = (edits.textOverlays ?? [])[selection.index];
      if (!o) return <EmptyInspector locked={layersLocked} />;
      return (
        <TextInspector
          overlay={o}
          index={selection.index}
          count={(edits.textOverlays ?? []).length}
          onPatch={(p2, label, token) =>
            patch((p) => {
              const next = [...(p.textOverlays ?? [])];
              if (!next[selection.index]) return p;
              next[selection.index] = { ...next[selection.index], ...p2 };
              return { ...p, textOverlays: next };
            }, label, token)
          }
          onDuplicate={() =>
            patch((p) => {
              if ((p.textOverlays ?? []).length >= CAPS.textOverlays) return p;
              const len = o.end - o.start;
              const start = Math.min(clip.duration - 0.5, o.end + 0.2);
              return { ...p, textOverlays: [...(p.textOverlays ?? []), { ...o, start, end: Math.min(clip.duration, start + len) }] };
            }, "Duplicate text")
          }
          onDelete={() => {
            patch((p) => ({ ...p, textOverlays: (p.textOverlays ?? []).filter((_, i) => i !== selection.index) }), "Delete text");
            setSelection(null);
          }}
        />
      );
    }
    if (selection?.kind === "music" && edits.music) {
      return (
        <MusicInspector
          music={edits.music}
          assetName={assetNames.get(edits.music.assetId) ?? "music bed"}
          onPatch={(p2, label, token) => patch((p) => ({ ...p, music: p.music ? { ...p.music, ...p2 } : p.music }), label, token)}
          onDelete={() => {
            patch((p) => ({ ...p, music: null }), "Remove music bed");
            setSelection(null);
          }}
        />
      );
    }
    return <EmptyInspector locked={layersLocked} />;
  })();

  const counts = `${segments.length} segment${segments.length === 1 ? "" : "s"} · ${(edits.broll ?? []).length} b-roll · ${(edits.textOverlays ?? []).length} text · ${edits.music ? 1 : 0} bed`;

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-3" onClick={onClose}>
      <div
        className="w-full max-w-[1480px] h-[95vh] rounded-xl border border-white/10 bg-[#080b16] shadow-2xl shadow-black/60 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid={`clip-studio-${clip.id}`}
      >
        {/* ── Header ── */}
        <div className="h-[60px] shrink-0 flex items-center justify-between gap-4 px-4 border-b border-white/10 bg-[#05070f]">
          <div className="flex items-center gap-3.5 min-w-0">
            <button
              onClick={onClose}
              className="h-8 px-2.5 rounded-lg border border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25 inline-flex items-center gap-2 text-[13px] shrink-0"
              data-testid="studio-close"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Clips
            </button>
            <div className="min-w-0">
              <p className="font-display text-[15px] font-semibold text-foreground truncate">
                {clip.suggestedTitle || `Clip #${clip.id}`}
              </p>
              <p className="font-mono text-[11px] text-muted-foreground/70 tabular-nums">
                clip {clip.id} · video {videoId} · {fmtTime(clip.duration)}
              </p>
            </div>
            {assembled && (
              <span className="shrink-0 h-6 px-2 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px] font-medium inline-flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3" />
                Assembled · {beatCount} beats
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <div className="flex h-8 rounded-lg border border-white/10 overflow-hidden">
              {(["9:16", "16:9"] as const).map((a) => (
                <button
                  key={a}
                  onClick={() => setAspect(a)}
                  className={`px-3 text-xs transition-colors ${aspect === a ? "bg-primary text-white font-semibold" : "text-muted-foreground hover:text-foreground"}`}
                  data-testid={`studio-aspect-${a}-${clip.id}`}
                >
                  {a}
                </button>
              ))}
            </div>
            <div className="flex items-center h-8 px-1 gap-0.5 rounded-lg border border-white/10">
              <button
                onClick={history.undo}
                disabled={!history.canUndo}
                title="Undo (⌘Z)"
                className="h-6 px-2 rounded inline-flex items-center gap-1.5 text-foreground disabled:text-muted-foreground/30 hover:bg-white/5"
                data-testid="studio-undo"
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span className="font-mono text-[11px] tabular-nums">{history.depth}</span>
              </button>
              <span className="w-px h-4 bg-white/10" />
              <button
                onClick={history.redo}
                disabled={!history.canRedo}
                title="Redo (⇧⌘Z)"
                className="h-6 px-2 rounded text-foreground disabled:text-muted-foreground/30 hover:bg-white/5"
                data-testid="studio-redo"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <button
              onClick={onClose}
              className="h-8 px-3.5 rounded-lg border border-white/10 text-[13px] text-muted-foreground hover:text-foreground hover:border-white/25"
            >
              Discard
            </button>
            <button
              onClick={apply}
              disabled={busy || !dirty}
              className="h-8 px-4 rounded-lg bg-primary text-white text-[13px] font-semibold hover:bg-primary/90 disabled:opacity-40 inline-flex items-center gap-2"
              data-testid={`studio-apply-${clip.id}`}
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {dirty ? "Apply & render" : "No changes"}
            </button>
          </div>
        </div>

        {/* ── Assembled-clip gate ── */}
        {assembled && !keepBeats && (
          <div className="shrink-0 px-4 py-3 border-b border-amber-500/25 bg-amber-500/[0.07] flex gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-display text-sm font-semibold text-amber-200">
                This clip is assembled from {beatCount} beats
              </p>
              <p className="text-xs leading-relaxed text-foreground/80 mt-1 max-w-4xl">
                B-roll, text, music, speed and silence removal render on single-range clips only — added here they
                would show in the preview and be absent from the export. Captions and aspect keep working either way.
              </p>
              {collapseAdds > 0.2 && (
                <p className="text-xs leading-relaxed text-amber-200/85 mt-1.5 max-w-4xl">
                  Collapsing runs {fmtTime(clip.clipStart)} straight through to {fmtTime(clip.clipEnd)}, so the{" "}
                  {collapseAdds.toFixed(1)}s between the beats comes back and the clip becomes{" "}
                  {collapsedDuration.toFixed(1)}s. You can cut it down again on the timeline afterwards.
                </p>
              )}
              <div className="flex gap-2 mt-2.5">
                <button
                  onClick={collapse}
                  disabled={collapsing}
                  className="h-[30px] px-3 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-2"
                  data-testid="studio-collapse"
                >
                  {collapsing && <Loader2 className="w-3 h-3 animate-spin" />}
                  Collapse to one range{collapseAdds > 0.2 ? ` · ${collapsedDuration.toFixed(1)}s` : ""}
                </button>
                <button
                  onClick={() => setKeepBeats(true)}
                  className="h-[30px] px-3 rounded-lg border border-white/15 text-xs text-foreground/85 hover:border-white/30"
                  data-testid="studio-keep-beats"
                >
                  Keep {beatCount} beats
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Middle ── */}
        <div className="flex-1 flex min-h-0">
          <div className="w-[300px] shrink-0 border-r border-white/10 min-h-0">
            <MediaBin
              assets={assets}
              loading={loadingAssets}
              lockedReason={layersLocked ? "Layer tracks are unavailable until this clip is collapsed to one range." : null}
              uploading={uploading}
              onUpload={uploadAsset}
              onPlace={(id) => placeAsset(id, t)}
              stockPanel={
                <BrollTool
                  /* Distinct keys, deliberately. Both panels sit at the same
                     slot in the bin's tree, so without them React reconciles
                     one BrollTool into the other, keeps its state, and
                     `initialTab` — which only seeds useState once — never
                     applies again: picking Stock after AI kept showing AI. */
                  key="bin-stock"
                  cuts={edits.broll ?? []}
                  duration={clip.duration}
                  playhead={t}
                  clipId={clip.id}
                  spokenAtPlayhead={clipWords.filter((w) => w.start >= t - 4 && w.end <= t + 4).map((w) => w.word).join(" ").trim()}
                  lines={clipLines}
                  onSeek={seek}
                  onChange={(b) => patch((p) => ({ ...p, broll: b }), "B-roll from stock")}
                  queryClient={queryClient}
                  initialTab="stock"
                  hideTabs
                />
              }
              aiPanel={
                <BrollTool
                  key="bin-ai"
                  cuts={edits.broll ?? []}
                  duration={clip.duration}
                  playhead={t}
                  clipId={clip.id}
                  spokenAtPlayhead={clipWords.filter((w) => w.start >= t - 4 && w.end <= t + 4).map((w) => w.word).join(" ").trim()}
                  lines={clipLines}
                  onSeek={seek}
                  onChange={(b) => patch((p) => ({ ...p, broll: b }), "B-roll from AI")}
                  queryClient={queryClient}
                  initialTab="ai"
                  hideTabs
                />
              }
            />
          </div>

          {/* Canvas */}
          <div className="flex-1 flex flex-col items-center min-h-0 bg-[#05070f] p-4">
            {clip.exportPath ? (
              <div
                ref={canvasRef}
                className={`relative rounded-[10px] overflow-hidden bg-black border border-white/10 ${aspect === "9:16" ? "aspect-[9/16]" : "aspect-video"}`}
                style={{ height: "100%", maxWidth: "100%", containerType: "inline-size" }}
              >
                <video
                  ref={videoRef}
                  key={clip.exportPath}
                  src={clip.exportPath}
                  poster={coverOverride || clip.thumbnailPath || undefined}
                  playsInline
                  className="w-full h-full object-contain"
                  onClick={togglePlay}
                />

                {activeBroll && assetById.get(activeBroll.assetId)?.url && (
                  <video
                    ref={brollRef}
                    key={`broll-${activeBroll.assetId}-${activeBroll.start}-${activeBroll.srcStart ?? 0}`}
                    src={assetById.get(activeBroll.assetId)!.url}
                    muted
                    playsInline
                    className="absolute object-cover pointer-events-none"
                    style={
                      activeBroll.scale >= 0.999
                        ? { inset: 0, width: "100%", height: "100%" }
                        : {
                            width: `${activeBroll.scale * 100}%`,
                            height: `${activeBroll.scale * 100}%`,
                            left: `${activeBroll.x * (1 - activeBroll.scale) * 100}%`,
                            top: `${activeBroll.y * (1 - activeBroll.scale) * 100}%`,
                            borderRadius: 6,
                          }
                    }
                  />
                )}

                {captionLine && captionLine.words.length > 0 && (
                  <div
                    className="absolute left-0 right-0 flex justify-center px-4 pointer-events-none"
                    style={{ bottom: `${Number(cs.positionRatio ?? 0.14) * 100}%` }}
                  >
                    <p
                      className="text-center font-bold leading-tight"
                      style={{
                        fontSize: `clamp(12px, ${Number(cs.sizeScale ?? 1) * 5.5}cqw, 42px)`,
                        textShadow: "0 2px 6px rgba(0,0,0,.85), 0 0 2px rgba(0,0,0,1)",
                      }}
                    >
                      {captionLine.words.map((w, i) => (
                        <span key={i} style={{ color: i === captionLine.activeIdx ? String(cs.accentHex ?? "#FFE500") : "#ffffff" }}>
                          {w.word}{" "}
                        </span>
                      ))}
                    </p>
                  </div>
                )}

                {(edits.textOverlays ?? []).map((o, i) => {
                  if (!(t >= o.start && t <= o.end) || !o.text?.trim()) return null;
                  const sel = selection?.kind === "text" && selection.index === i;
                  return (
                    <div
                      key={i}
                      onPointerDown={dragText(i)}
                      className="absolute cursor-move"
                      style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%`, transform: "translate(-50%, -50%)", textAlign: o.align }}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          color: o.color,
                          fontWeight: o.weight === "bold" ? 800 : 500,
                          fontSize: `clamp(10px, ${o.size * 90}cqw, 60px)`,
                          lineHeight: 1.1,
                          padding: o.background ? "0.1em 0.3em" : 0,
                          background: o.background ?? "transparent",
                          textShadow: o.background ? "none" : "0 2px 6px rgba(0,0,0,.85), 0 0 2px rgba(0,0,0,1)",
                          outline: sel ? "1px dashed #fbbf24" : undefined,
                          outlineOffset: 3,
                        }}
                      >
                        {o.text}
                      </span>
                    </div>
                  );
                })}

                {/* What the preview cannot show truthfully, said out loud. */}
                <div className="absolute top-2 left-2 flex flex-col gap-1 pointer-events-none">
                  {rampAt(t) !== 1 && (
                    <span className="px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-primary-foreground/90">{rampAt(t).toFixed(2)}× speed</span>
                  )}
                  {edits.stabilization?.enabled && (
                    <span className="px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-muted-foreground">stabilize — applied at render</span>
                  )}
                  {edits.music && (
                    <span className="px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-muted-foreground">music bed — mixed at render</span>
                  )}
                  {baseGainOf(edits) !== null && (
                    <span className="px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-muted-foreground">
                      clip audio {baseGainOf(edits)!.toFixed(2)}× — applied at render
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
                <p className="text-sm text-foreground/85 mb-1">This clip hasn't been rendered yet</p>
                <p className="text-xs text-muted-foreground max-w-xs">
                  The timeline still works — make your edits and hit Apply &amp; render, and the result appears here.
                </p>
              </div>
            )}

            {/* Transport */}
            <div className="w-full pt-3.5 flex items-center justify-center gap-5 shrink-0">
              <div className="flex items-center gap-1.5">
                <button onClick={() => seek(t - 2)} title="Back 2s (J)" className="w-[30px] h-[30px] rounded-lg border border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25 flex items-center justify-center">
                  <ChevronsLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={togglePlay}
                  disabled={!clip.exportPath}
                  title="Play / pause (space)"
                  className="w-[38px] h-[38px] rounded-[10px] bg-primary text-white flex items-center justify-center disabled:opacity-30"
                  data-testid={`studio-play-${clip.id}`}
                >
                  {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                </button>
                <button onClick={() => seek(t + 2)} title="Forward 2s (L)" className="w-[30px] h-[30px] rounded-lg border border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25 flex items-center justify-center">
                  <ChevronsRight className="w-4 h-4" />
                </button>
              </div>
              <span className="font-mono text-[15px] tabular-nums text-foreground">
                {fmtTime(t)}
                <span className="text-muted-foreground/60"> / {fmtTime(clip.duration)}</span>
              </span>
              <button
                onClick={setCover}
                disabled={!clip.exportPath || settingCover}
                className="h-[30px] px-2.5 rounded-lg border border-white/10 text-[11px] text-muted-foreground hover:text-foreground hover:border-white/25 inline-flex items-center gap-1.5 disabled:opacity-30"
                data-testid="set-cover"
              >
                {settingCover ? <Loader2 className="w-3 h-3 animate-spin" /> : <Camera className="w-3 h-3" />}
                Set as cover
              </button>
              <span className="font-mono text-[10px] text-muted-foreground/50 hidden xl:flex items-center gap-2.5">
                <span>J K L</span><span>◂ ▸ frame</span><span>⇧◂ ▸ sec</span><span>space</span>
              </span>
              <span className="ml-auto font-mono text-xs tabular-nums text-emerald-300">→ {fmtTime(outDuration)}</span>
            </div>
          </div>

          {/* Inspector, or a full-height panel when one is open */}
          <div className="w-[330px] shrink-0 border-l border-white/10 bg-[#05070f] flex flex-col min-h-0">
            {panel === "transcript" ? (
              <PanelShell title="Transcript" onClose={() => setPanel("none")}>
                <TranscriptTool
                  loading={loadingTranscript}
                  words={clipWords}
                  isCut={isCut}
                  onToggle={toggleWord}
                  correctionFor={(w) => (edits.captionEdits ?? []).find((c) => Math.abs(c.start - w.start) < 0.05)?.text ?? null}
                  onEditWord={(w, text) => {
                    const trimmed = text.trim();
                    patch((p) => {
                      const rest = (p.captionEdits ?? []).filter((c) => Math.abs(c.start - w.start) >= 0.05);
                      if (!trimmed || trimmed === w.word.trim()) return { ...p, captionEdits: rest };
                      return { ...p, captionEdits: [...rest, { start: w.start, end: w.end, text: trimmed }] };
                    }, `Fix "${w.word}"`);
                  }}
                  onSeek={seek}
                  activeIdx={clipWords.findIndex((w) => t >= w.start && t < w.end)}
                  activeRef={activeWordRef}
                  fillerCount={fillerWords.length}
                  onRemoveFillers={() =>
                    patch(
                      (p) => ({ ...p, wordCuts: [...(p.wordCuts ?? []), ...fillerWords.map((w) => ({ start: w.start, end: w.end, text: w.word, reason: "filler" as const }))] }),
                      `Remove ${fillerWords.length} fillers`,
                    )
                  }
                  cutCount={cuts.length}
                  onClearCuts={() => patch((p) => ({ ...p, wordCuts: [] }), "Clear all word cuts")}
                  silenceInfo={silenceInfo}
                  silenceOn={!!edits.silenceCut?.enabled}
                  analyzing={analyzing}
                  onAnalyzeSilence={analyzeSilence}
                  onToggleSilence={() =>
                    patch(
                      (p) => ({ ...p, silenceCut: p.silenceCut?.enabled ? null : { enabled: true, thresholdDb: -35, minDurationSec: 0.6, paddingSec: 0.15 } }),
                      edits.silenceCut?.enabled ? "Keep silence" : "Cut silence",
                    )
                  }
                />
              </PanelShell>
            ) : panel === "captions" ? (
              <PanelShell title="Captions" onClose={() => setPanel("none")}>
                <CaptionsTool
                  enabled={captionsEnabled}
                  style={captionStyle}
                  onToggle={() => setCaptionsEnabled((v) => !v)}
                  onStyle={setCaptionStyle}
                  settings={cs}
                  onSettings={(patchCs) => setCs((p) => ({ ...p, ...patchCs }))}
                />
              </PanelShell>
            ) : panel === "history" ? (
              <PanelShell title="History" onClose={() => setPanel("none")}>
                {history.entries.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">Nothing to undo yet.</p>
                ) : (
                  <ol className="flex flex-col gap-1">
                    {history.entries.map((e, i) => (
                      <li key={i} className="flex items-center gap-2 text-[11px] text-foreground/80">
                        <span className="font-mono text-muted-foreground/60 tabular-nums w-6 text-right">{history.depth - i}</span>
                        {e.label}
                      </li>
                    ))}
                  </ol>
                )}
                <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/70">
                  One entry per action, coalescing during a drag. ⌘Z / ⇧⌘Z.
                </p>
              </PanelShell>
            ) : (
              inspector
            )}
          </div>
        </div>

        {/* ── Timeline ── */}
        <div className="shrink-0 border-t-2 border-white/10 bg-[#040610]">
          <div className="h-11 flex items-center justify-between gap-3 px-4 border-b border-white/5">
            <div className="flex items-center gap-2">
              <ToolBtn
                on={razor}
                onClick={() => setRazor((r) => !r)}
                icon={<Scissors className="w-3.5 h-3.5" />}
                label="Razor"
                kbd="⌘K"
                testId="studio-razor"
              />
              <ToolBtn on={snapOn} onClick={() => setSnapOn((s) => !s)} label="Snap" testId="studio-snap" />
              <ToolBtn
                onClick={addText}
                disabled={layersLocked || (edits.textOverlays ?? []).length >= CAPS.textOverlays}
                icon={<TypeIcon className="w-3.5 h-3.5" />}
                label="Add text"
                testId="studio-add-text"
              />
              <ToolBtn
                onClick={silenceInfo ? () => patch((p) => ({ ...p, silenceCut: p.silenceCut?.enabled ? null : { enabled: true, thresholdDb: -35, minDurationSec: 0.6, paddingSec: 0.15 } }), edits.silenceCut?.enabled ? "Keep silence" : "Cut silence") : analyzeSilence}
                on={!!edits.silenceCut?.enabled}
                disabled={analyzing}
                icon={analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}
                label={silenceInfo ? `${edits.silenceCut?.enabled ? "Keeping" : "Cut"} ${silenceInfo.totalSilentSec.toFixed(1)}s silence` : "Remove silence"}
                testId="studio-silence"
              />
              <ToolBtn onClick={() => setPanel((p) => (p === "transcript" ? "none" : "transcript"))} on={panel === "transcript"} label="Transcript" testId="studio-transcript" />
              <ToolBtn onClick={() => setPanel((p) => (p === "captions" ? "none" : "captions"))} on={panel === "captions"} icon={<Sparkles className="w-3.5 h-3.5" />} label="Captions" testId="studio-captions" />
            </div>

            <div className="flex items-center gap-3.5">
              <button
                onClick={() => setPanel((p) => (p === "history" ? "none" : "history"))}
                className="font-mono text-[10px] text-muted-foreground/70 hover:text-foreground"
                data-testid="studio-history"
              >
                {counts}
              </button>
              <div className="flex items-center gap-2">
                <button onClick={() => setZoom((z) => Math.max(1, z - 0.5))} className="text-muted-foreground hover:text-foreground" title="Zoom out">
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <input
                  type="range" min={1} max={8} step={0.5} value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="w-[90px] h-[3px] appearance-none rounded bg-white/10 accent-muted-foreground cursor-pointer"
                  title="Zoom"
                  data-testid="studio-zoom"
                />
                <button onClick={() => setZoom((z) => Math.min(8, z + 0.5))} className="text-muted-foreground hover:text-foreground" title="Zoom in">
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          <div className="px-4 pt-2.5 pb-4">
            <Timeline
              duration={clip.duration}
              playhead={t}
              edits={edits}
              silence={clip.silenceAnalysis}
              filmSrc={clip.exportPath}
              assetNames={assetNames}
              selection={selection}
              razorArmed={razor}
              snapOn={snapOn}
              zoom={zoom}
              layersLocked={layersLocked}
              trimLocked={trimLocked}
              trim={trim}
              onSeek={seek}
              onSelect={setSelection}
              onEdits={patch}
              onSplit={split}
              onTrim={(edge, atSec) =>
                setTrim((prev) => {
                  const cur = prev ?? { start: 0, end: clip.duration };
                  // The server refuses a trim under a second, so the handles
                  // stop a second apart rather than letting someone build a
                  // payload it will reject.
                  return edge === "left"
                    ? { ...cur, start: Math.max(0, Math.min(atSec, cur.end - 1)) }
                    : { ...cur, end: Math.min(clip.duration, Math.max(atSec, cur.start + 1)) };
                })
              }
              onDropAsset={placeAsset}
            />

            {trim && (
              <p className="mt-2 text-[11px] text-amber-300/85 flex items-center gap-2">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                Trimmed to {fmtTime(trim.start)} – {fmtTime(trim.end)}. Applying re-cuts the clip and shifts every
                edit with it; anything outside the new bounds is dropped, and silence removal switches off because
                the stored analysis is measured from the old start — re-run it afterwards.
                <button onClick={() => setTrim(null)} className="underline hover:text-amber-200">Undo trim</button>
              </p>
            )}
            {(clip.renderWarnings?.length ?? 0) > 0 && (
              <div className="mt-2 space-y-0.5">
                {clip.renderWarnings!.map((w, i) => (
                  <p key={i} className="text-[11px] text-amber-300/70 leading-snug">{w}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolBtn(props: {
  on?: boolean; disabled?: boolean; onClick: () => void;
  icon?: React.ReactNode; label: string; kbd?: string; testId?: string;
}) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      className={`h-7 px-2.5 rounded-[7px] inline-flex items-center gap-1.5 text-xs transition-colors disabled:opacity-35 ${
        props.on
          ? "bg-primary/15 border border-primary/45 text-primary font-semibold"
          : "border border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25"
      }`}
      data-testid={props.testId}
    >
      {props.icon}
      {props.label}
      {props.kbd && <span className="font-mono text-[10px] opacity-60">{props.kbd}</span>}
    </button>
  );
}

function PanelShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div className="p-3.5 border-b border-white/10 flex items-center justify-between shrink-0">
        <span className="font-display text-sm font-semibold text-foreground">{title}</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground" data-testid="panel-close">
          <XIcon className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3.5 min-h-0">{children}</div>
    </>
  );
}
