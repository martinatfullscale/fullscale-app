/**
 * Clip Studio — the editor, rebuilt around the video instead of around forms.
 *
 * The previous version was a stack of sliders with no picture in it, which is
 * unusable for the obvious reason: you cannot judge a cut you cannot see. The
 * feedback was "there is no way to tell how to edit this well", and it was
 * correct. This is the OpusClip shape, and the shape is the point:
 *
 *   ┌──────────────┬────────────────────────┐
 *   │ context      │   THE VIDEO            │   left panel switches tools,
 *   │ panel        │   (plays, scrubs,      │   the video never leaves
 *   │ (transcript, │    shows captions)     │
 *   │  b-roll,     │                        │
 *   │  captions,   ├────────────────────────┤
 *   │  design)     │   timeline + playhead  │
 *   └──────────────┴────────────────────────┘
 *
 * THE TRANSCRIPT IS THE EDIT SURFACE. You do not drag a start-time slider to
 * remove a stumble; you strike the words, and the words carry exact
 * timestamps from Whisper's word-level output. That is what makes the edit
 * legible — the creator reads what they said and deletes what they didn't
 * mean. Struck words compile to `wordCuts`, which feed the same segment
 * timeline as silence removal, so audio and video stay locked by construction.
 *
 * LIVE PREVIEW. Most of the stack CAN be previewed in the browser, and is:
 * playback skips over cut spans as it reaches them, speed ramps drive
 * video.playbackRate, b-roll composites as a second video element, and
 * captions render from the transcript. What you see is what the render will
 * produce.
 *
 * Two things are honestly approximate and labelled as such in the UI, because
 * they need real pixel processing that only ffmpeg can do:
 *   - stabilization: not previewable at all
 *   - caption typography: HTML text, not the ASS renderer's exact metrics
 * Everything else is the actual edit, played back.
 */
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fetchWithTimeout } from "@/lib/queryClient";

const UPLOAD_TIMEOUT_MS = 30 * 60_000; // files, not JSON — see AdminPlacements

import {
  X as XIcon, Play, Pause, Loader2, Type, Film, Music, Sparkles,
  Scissors, Undo2, Wand2, Search, Upload, Trash2, AlertTriangle, Gauge,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────────

interface Word { word: string; start: number; end: number; confidence?: number }
interface Segment { start: number; end: number; text: string; speaker?: string; words?: Word[] }

export interface WordCut { start: number; end: number; text?: string; reason?: "filler" | "manual" }

export interface StudioEdits {
  wordCuts?: WordCut[];
  silenceCut?: { enabled: boolean; thresholdDb: number; minDurationSec: number; paddingSec: number } | null;
  speedRamps?: Array<{ start: number; end: number; rate: number }>;
  textOverlays?: Array<Record<string, unknown>>;
  broll?: Array<{
    assetId: number; start: number; end: number; fit: string;
    scale: number; x: number; y: number; muted: boolean;
    /** Ken Burns for stills — a static full-frame image reads as a freeze. */
    motion?: "push" | "pull" | "none";
  }>;
  music?: { assetId: number; volume: number; ducking: boolean; duckAmountDb: number; fadeInSec: number; fadeOutSec: number } | null;
  stabilization?: { enabled: boolean; strength: number } | null;
}

interface AssetRow { id: number; kind: string; name: string; url: string; durationSec: string | null }

interface ClipShape {
  id: number;
  clipStart: number;
  clipEnd: number;
  duration: number;
  suggestedTitle?: string | null;
  aspectRatio?: string | null;
  exportPath?: string | null;
  thumbnailPath?: string | null;
  renderStatus?: string | null;
  captionsEnabled?: boolean | null;
  captionStyle?: string | null;
  captionSettings?: Record<string, any> | null;
  segments?: Array<{ start: number; end: number; role?: string }> | null;
  edits?: StudioEdits | null;
  silenceAnalysis?: { spans: Array<{ start: number; end: number }>; totalSilentSec: number } | null;
  renderWarnings?: string[] | null;
}

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
  }) => Promise<void>;
}

// Whisper transcribes these verbatim; they are what a creator strikes first.
const FILLERS = new Set(["um", "uh", "erm", "hmm", "mm-hmm", "mmhmm", "ah", "eh", "like", "so", "actually", "basically", "literally"]);
const normalize = (w: string) => w.toLowerCase().replace(/[^a-z-]/g, "");

const fmtTime = (s: number) => {
  const m = Math.floor(Math.max(0, s) / 60);
  const sec = Math.max(0, s) % 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
};

type Tool = "transcript" | "captions" | "broll" | "audio" | "motion";

export default function ClipStudio({ clip, videoId, onClose, onApply }: Props) {
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [tool, setTool] = useState<Tool>("transcript");
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);            // player time, clip-relative
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const cs = clip.captionSettings ?? {};
  const [captionsEnabled, setCaptionsEnabled] = useState(clip.captionsEnabled !== false);
  const [captionStyle, setCaptionStyle] = useState(String(clip.captionStyle || "highlight"));
  const [aspect, setAspect] = useState<"9:16" | "16:9">(clip.aspectRatio === "16:9" ? "16:9" : "9:16");
  const [edits, setEdits] = useState<StudioEdits>({
    wordCuts: clip.edits?.wordCuts ?? [],
    silenceCut: clip.edits?.silenceCut ?? null,
    speedRamps: clip.edits?.speedRamps ?? [],
    textOverlays: clip.edits?.textOverlays ?? [],
    broll: clip.edits?.broll ?? [],
    music: clip.edits?.music ?? null,
    stabilization: clip.edits?.stabilization ?? null,
  });
  const [silenceInfo, setSilenceInfo] = useState<{ spans: number; totalSilentSec: number } | null>(
    clip.silenceAnalysis ? { spans: clip.silenceAnalysis.spans.length, totalSilentSec: clip.silenceAnalysis.totalSilentSec } : null,
  );

  const hasBeats = Array.isArray(clip.segments) && clip.segments.length > 1;

  // Asset urls for the b-roll preview layer. Loaded here (not in the tool
  // panel) because the preview must work whichever tool is open.
  const { data: brollAssetData } = useQuery<{ assets: AssetRow[] }>({
    queryKey: ["/api/media-assets", "broll_video,broll_image"],
    queryFn: async () => {
      const [v, i] = await Promise.all([
        fetchWithTimeout("/api/media-assets?kind=broll_video", { credentials: "include" }).then((r) => r.json()),
        fetchWithTimeout("/api/media-assets?kind=broll_image", { credentials: "include" }).then((r) => r.json()),
      ]);
      return { assets: [...(v.assets ?? []), ...(i.assets ?? [])] };
    },
  });
  const brollUrlById = useMemo(
    () => new Map((brollAssetData?.assets ?? []).map((a) => [a.id, a.url])),
    [brollAssetData],
  );

  // ── Transcript, sliced to this clip and rebased to clip-relative time ──
  const { data: transcript, isLoading: loadingTranscript } = useQuery<{ segments: Segment[] }>({
    queryKey: ["/api/video", videoId, "transcript"],
    queryFn: async () => {
      const res = await fetchWithTimeout(`/api/video/${videoId}/transcript`, { credentials: "include" });
      if (!res.ok) throw new Error("No transcript for this video yet");
      return res.json();
    },
  });

  const clipWords = useMemo<Word[]>(() => {
    const segs = transcript?.segments ?? [];
    const out: Word[] = [];
    for (const seg of segs) {
      const words = seg.words?.length
        ? seg.words
        // A segment with no word timings still contributes: spread its text
        // evenly across its own span so the creator can still strike phrases.
        : seg.text.trim().split(/\s+/).filter(Boolean).map((w, i, arr) => {
            const span = (seg.end - seg.start) / Math.max(1, arr.length);
            return { word: w, start: seg.start + i * span, end: seg.start + (i + 1) * span };
          });
      for (const w of words) {
        if (w.end <= clip.clipStart || w.start >= clip.clipEnd) continue;
        out.push({
          ...w,
          start: Math.max(0, w.start - clip.clipStart),
          end: Math.min(clip.duration, w.end - clip.clipStart),
        });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }, [transcript, clip.clipStart, clip.clipEnd, clip.duration]);

  const cuts = edits.wordCuts ?? [];
  const isCut = useCallback(
    (w: Word) => cuts.some((c) => w.start >= c.start - 0.01 && w.end <= c.end + 0.01),
    [cuts],
  );

  const fillerWords = useMemo(
    () => clipWords.filter((w) => FILLERS.has(normalize(w.word)) && !isCut(w)),
    [clipWords, isCut],
  );

  // Live output duration: the clip minus everything removed. This is the
  // number that tells the creator their edit did something.
  const removedSec = useMemo(() => {
    const spans = [...cuts];
    if (edits.silenceCut?.enabled && clip.silenceAnalysis?.spans) {
      const pad = edits.silenceCut.paddingSec ?? 0;
      for (const s of clip.silenceAnalysis.spans) spans.push({ start: s.start + pad, end: s.end - pad });
    }
    const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
    let total = 0;
    let cursor = -1;
    for (const s of sorted) {
      const from = Math.max(s.start, cursor);
      if (s.end > from) { total += s.end - from; cursor = s.end; }
    }
    return total;
  }, [cuts, edits.silenceCut, clip.silenceAnalysis]);
  const outDuration = Math.max(0, clip.duration - removedSec);

  const toggleWord = (w: Word) => {
    const existing = cuts.find((c) => w.start >= c.start - 0.01 && w.end <= c.end + 0.01);
    if (existing) {
      setEdits((p) => ({ ...p, wordCuts: (p.wordCuts ?? []).filter((c) => c !== existing) }));
    } else {
      setEdits((p) => ({
        ...p,
        wordCuts: [...(p.wordCuts ?? []), { start: w.start, end: w.end, text: w.word, reason: "manual" }],
      }));
    }
  };

  const removeAllFillers = () => {
    setEdits((p) => ({
      ...p,
      wordCuts: [
        ...(p.wordCuts ?? []),
        ...fillerWords.map((w) => ({ start: w.start, end: w.end, text: w.word, reason: "filler" as const })),
      ],
    }));
  };

  const analyzeSilence = async () => {
    setAnalyzing(true);
    try {
      const res = await fetchWithTimeout(`/api/editorial-clips/${clip.id}/analyze-silence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      }, 120_000);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      setSilenceInfo({ spans: data.spans.length, totalSilentSec: data.totalSilentSec });
      setEdits((p) => ({
        ...p,
        silenceCut: { enabled: true, thresholdDb: data.thresholdDb, minDurationSec: data.minDurationSec, paddingSec: 0.15 },
      }));
    } catch (err: any) {
      alert(err?.message || "Silence analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Live preview ───────────────────────────────────────────────────
  // Every removal, merged and sorted once. Playback consults this to jump
  // over cuts, which is what makes the preview the actual edit rather than a
  // description of one.
  const previewCuts = useMemo(() => {
    const spans = [...cuts.map((c) => ({ start: c.start, end: c.end }))];
    if (edits.silenceCut?.enabled && clip.silenceAnalysis?.spans) {
      const pad = edits.silenceCut.paddingSec ?? 0;
      for (const s of clip.silenceAnalysis.spans) {
        const st = s.start + pad;
        const en = s.end - pad;
        if (en > st) spans.push({ start: st, end: en });
      }
    }
    const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const s of sorted) {
      const last = merged[merged.length - 1];
      if (last && s.start <= last.end + 0.02) last.end = Math.max(last.end, s.end);
      else merged.push({ ...s });
    }
    return merged;
  }, [cuts, edits.silenceCut, clip.silenceAnalysis]);

  const rampAt = useCallback(
    (time: number) => (edits.speedRamps ?? []).find((r) => time >= r.start && time < r.end)?.rate ?? 1,
    [edits.speedRamps],
  );

  const brollAt = useCallback(
    (time: number) => (edits.broll ?? []).find((b) => time >= b.start && time < b.end) ?? null,
    [edits.broll],
  );

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      const now = v.currentTime;
      // Skip a cut the moment playback reaches it. This IS the preview of a
      // cut — the gap closes exactly the way the render will close it.
      const inCut = previewCuts.find((c) => now >= c.start - 0.03 && now < c.end - 0.03);
      if (inCut) {
        if (inCut.end >= clip.duration - 0.05) { v.pause(); setPlaying(false); }
        else v.currentTime = inCut.end;
        setT(inCut.end);
        return;
      }
      // Speed ramps are just playbackRate over their span.
      const rate = rampAt(now);
      if (Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
      setT(now);
    };
    const onEnd = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnd);
    return () => { v.removeEventListener("timeupdate", onTime); v.removeEventListener("ended", onEnd); };
  }, [clip.exportPath, previewCuts, rampAt, clip.duration]);

  // The b-roll layer follows the main video's clock.
  const brollRef = useRef<HTMLVideoElement>(null);
  const activeBroll = brollAt(t);
  useEffect(() => {
    const b = brollRef.current;
    if (!b || !activeBroll) return;
    const local = Math.max(0, t - activeBroll.start);
    if (Math.abs(b.currentTime - local) > 0.3) b.currentTime = local;
    if (playing && b.paused) b.play().catch(() => {});
    if (!playing && !b.paused) b.pause();
  }, [t, playing, activeBroll]);

  // Caption line under the playhead, straight from the transcript — the same
  // words the ASS renderer will burn in.
  const captionLine = useMemo(() => {
    if (!captionsEnabled) return null;
    const perPhrase = Number(cs.wordsPerPhrase ?? 4);
    const visible = clipWords.filter((w) => !isCut(w));
    const idx = visible.findIndex((w) => t >= w.start && t < w.end);
    if (idx < 0) return null;
    const from = Math.floor(idx / perPhrase) * perPhrase;
    return {
      words: visible.slice(from, from + perPhrase),
      activeIdx: idx - from,
    };
  }, [captionsEnabled, clipWords, isCut, t, cs.wordsPerPhrase]);

  const seek = (sec: number) => {
    const v = videoRef.current;
    setT(sec);
    if (v) v.currentTime = sec;
  };
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
  };

  // The word under the playhead — drives the transcript's follow-along.
  const activeWordIdx = useMemo(
    () => clipWords.findIndex((w) => t >= w.start && t < w.end),
    [clipWords, t],
  );
  // The words around the playhead — what a generated cutaway should be ABOUT.
  const spokenAtPlayhead = useMemo(() => {
    const window = clipWords.filter((w) => w.start >= t - 4 && w.end <= t + 4);
    return window.map((w) => w.word).join(" ").trim();
  }, [clipWords, t]);

  const activeRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (playing) activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeWordIdx, playing]);

  const apply = async () => {
    setBusy(true);
    try {
      await onApply({
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
        edits,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const dirty =
    JSON.stringify(edits) !== JSON.stringify({
      wordCuts: clip.edits?.wordCuts ?? [],
      silenceCut: clip.edits?.silenceCut ?? null,
      speedRamps: clip.edits?.speedRamps ?? [],
      textOverlays: clip.edits?.textOverlays ?? [],
      broll: clip.edits?.broll ?? [],
      music: clip.edits?.music ?? null,
      stabilization: clip.edits?.stabilization ?? null,
    }) ||
    captionsEnabled !== (clip.captionsEnabled !== false) ||
    captionStyle !== String(clip.captionStyle || "highlight") ||
    aspect !== (clip.aspectRatio === "16:9" ? "16:9" : "9:16");

  const TOOLS: Array<{ id: Tool; label: string; icon: any }> = [
    { id: "transcript", label: "Transcript", icon: Type },
    { id: "captions", label: "Captions", icon: Sparkles },
    { id: "broll", label: "B-Roll", icon: Film },
    { id: "audio", label: "Audio", icon: Music },
    { id: "motion", label: "Motion", icon: Gauge },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-6xl h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid={`clip-studio-${clip.id}`}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-800 shrink-0">
          <p className="text-sm font-semibold truncate flex-1">{clip.suggestedTitle || `Clip #${clip.id}`}</p>
          <div className="flex items-center gap-1">
            {(["9:16", "16:9"] as const).map((a) => (
              <button
                key={a}
                onClick={() => setAspect(a)}
                className={`px-2 py-1 rounded text-[11px] font-medium border transition-colors ${
                  aspect === a ? "bg-purple-500/25 text-purple-200 border-purple-500/50" : "bg-gray-800 text-gray-400 border-gray-700"
                }`}
                data-testid={`studio-aspect-${a}-${clip.id}`}
              >
                {a}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            disabled={busy || !dirty}
            onClick={apply}
            className="bg-purple-600 hover:bg-purple-500 text-white text-xs"
            data-testid={`studio-apply-${clip.id}`}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
            {dirty ? "Save & re-render" : "No changes"}
          </Button>
          <button onClick={onClose} className="text-gray-400 hover:text-white" data-testid="studio-close">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* ── Left: tool panel ── */}
          <div className="w-[340px] shrink-0 border-r border-gray-800 flex flex-col min-h-0">
            <div className="flex items-center gap-0.5 p-1.5 border-b border-gray-800 shrink-0">
              {TOOLS.map((tl) => {
                const Icon = tl.icon;
                return (
                  <button
                    key={tl.id}
                    onClick={() => setTool(tl.id)}
                    className={`flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded text-[10px] transition-colors ${
                      tool === tl.id ? "bg-purple-600/25 text-purple-200" : "text-gray-500 hover:text-gray-300"
                    }`}
                    data-testid={`studio-tool-${tl.id}`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {tl.label}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 overflow-y-auto p-3 min-h-0">
              {tool === "transcript" && (
                <TranscriptTool
                  loading={loadingTranscript}
                  words={clipWords}
                  isCut={isCut}
                  onToggle={toggleWord}
                  onSeek={seek}
                  activeIdx={activeWordIdx}
                  activeRef={activeRef}
                  fillerCount={fillerWords.length}
                  onRemoveFillers={removeAllFillers}
                  cutCount={cuts.length}
                  onClearCuts={() => setEdits((p) => ({ ...p, wordCuts: [] }))}
                  silenceInfo={silenceInfo}
                  silenceOn={!!edits.silenceCut?.enabled}
                  analyzing={analyzing}
                  onAnalyzeSilence={analyzeSilence}
                  onToggleSilence={() =>
                    setEdits((p) => ({
                      ...p,
                      silenceCut: p.silenceCut?.enabled
                        ? null
                        : { enabled: true, thresholdDb: -35, minDurationSec: 0.6, paddingSec: 0.15 },
                    }))
                  }
                />
              )}
              {tool === "captions" && (
                <CaptionsTool
                  enabled={captionsEnabled}
                  style={captionStyle}
                  onToggle={() => setCaptionsEnabled((v) => !v)}
                  onStyle={setCaptionStyle}
                />
              )}
              {tool === "broll" && (
                <BrollTool
                  cuts={edits.broll ?? []}
                  duration={clip.duration}
                  playhead={t}
                  clipId={clip.id}
                  spokenAtPlayhead={spokenAtPlayhead}
                  onChange={(broll) => setEdits((p) => ({ ...p, broll }))}
                  queryClient={queryClient}
                />
              )}
              {tool === "audio" && (
                <AudioTool
                  music={edits.music ?? null}
                  onChange={(music) => setEdits((p) => ({ ...p, music }))}
                  queryClient={queryClient}
                />
              )}
              {tool === "motion" && (
                <MotionTool
                  stabilization={edits.stabilization ?? null}
                  ramps={edits.speedRamps ?? []}
                  duration={clip.duration}
                  playhead={t}
                  onChange={(patch) => setEdits((p) => ({ ...p, ...patch }))}
                />
              )}
            </div>
          </div>

          {/* ── Right: the video, then the timeline ── */}
          <div className="flex-1 flex flex-col min-h-0 bg-black/30">
            <div className="flex-1 flex items-center justify-center p-4 min-h-0">
              {clip.exportPath ? (
                <div
                  className={`relative max-h-full rounded-lg overflow-hidden bg-black ${aspect === "9:16" ? "aspect-[9/16]" : "aspect-video"}`}
                  style={{ height: "100%", containerType: "inline-size" }}
                >
                  <video
                    ref={videoRef}
                    key={clip.exportPath}
                    src={clip.exportPath}
                    poster={clip.thumbnailPath || undefined}
                    playsInline
                    className="w-full h-full object-contain"
                    onClick={togglePlay}
                  />

                  {/* B-roll layer — a real second video, composited exactly
                      where the render will composite it. */}
                  {activeBroll && brollUrlById.get(activeBroll.assetId) && (
                    <video
                      ref={brollRef}
                      key={`broll-${activeBroll.assetId}-${activeBroll.start}`}
                      src={brollUrlById.get(activeBroll.assetId)}
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

                  {/* Captions — the same words, the same phrase grouping and
                      the same word-by-word highlight the ASS renderer uses.
                      Typography is HTML, so treat the LOOK as approximate. */}
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
                          <span
                            key={i}
                            style={{
                              color: i === captionLine.activeIdx
                                ? String(cs.accentHex ?? "#FFE500")
                                : "#ffffff",
                            }}
                          >
                            {w.word}{" "}
                          </span>
                        ))}
                      </p>
                    </div>
                  )}

                  {/* Live badges for what the preview cannot show truthfully. */}
                  <div className="absolute top-2 left-2 flex flex-col gap-1 pointer-events-none">
                    {rampAt(t) !== 1 && (
                      <span className="px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-purple-200">
                        {rampAt(t).toFixed(2)}x speed
                      </span>
                    )}
                    {edits.stabilization?.enabled && (
                      <span className="px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-gray-300">
                        stabilize on — applied at render
                      </span>
                    )}
                    {edits.music && (
                      <span className="px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-gray-300">
                        music bed — added at render
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-center px-6">
                  <Film className="w-10 h-10 text-gray-700 mx-auto mb-3" />
                  <p className="text-sm text-gray-300 mb-1">This clip hasn't been rendered yet</p>
                  <p className="text-xs text-gray-500 max-w-xs mx-auto">
                    Make your edits and hit Save &amp; re-render — the result appears here.
                  </p>
                </div>
              )}
            </div>

            {/* Transport + timeline */}
            <div className="border-t border-gray-800 p-3 shrink-0 space-y-2">
              <div className="flex items-center gap-3">
                <button
                  onClick={togglePlay}
                  disabled={!clip.exportPath}
                  className="text-gray-200 hover:text-white disabled:opacity-30"
                  data-testid={`studio-play-${clip.id}`}
                >
                  {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                </button>
                <span className="text-xs tabular-nums text-gray-300">{fmtTime(t)}</span>
                <span className="text-[11px] text-gray-600">/ {fmtTime(clip.duration)}</span>
                <div className="ml-auto flex items-center gap-2">
                  {removedSec > 0.05 && (
                    <Badge variant="outline" className="text-[10px] text-amber-300 border-amber-500/30">
                      −{removedSec.toFixed(1)}s cut
                    </Badge>
                  )}
                  <span className="text-xs tabular-nums text-emerald-300">
                    → {fmtTime(outDuration)}
                  </span>
                </div>
              </div>

              {/* Timeline: clip span with cut markers drawn on it. Clicking
                  scrubs; the marked regions are what will be removed. */}
              <div
                className="relative h-10 rounded bg-gray-800 overflow-hidden cursor-pointer"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  seek(((e.clientX - rect.left) / rect.width) * clip.duration);
                }}
                data-testid={`studio-timeline-${clip.id}`}
              >
                {clip.thumbnailPath && (
                  <div
                    className="absolute inset-0 opacity-25"
                    style={{
                      backgroundImage: `url(${clip.thumbnailPath})`,
                      backgroundSize: "auto 100%",
                      backgroundRepeat: "repeat-x",
                    }}
                  />
                )}
                {cuts.map((c, i) => (
                  <div
                    key={`c${i}`}
                    className="absolute inset-y-0 bg-red-500/45 border-x border-red-400/70"
                    style={{
                      left: `${(c.start / clip.duration) * 100}%`,
                      width: `${Math.max(0.4, ((c.end - c.start) / clip.duration) * 100)}%`,
                    }}
                    title={`cut: ${c.text ?? ""}`}
                  />
                ))}
                {edits.silenceCut?.enabled &&
                  (clip.silenceAnalysis?.spans ?? []).map((s, i) => (
                    <div
                      key={`s${i}`}
                      className="absolute inset-y-0 bg-amber-500/30"
                      style={{
                        left: `${(s.start / clip.duration) * 100}%`,
                        width: `${Math.max(0.3, ((s.end - s.start) / clip.duration) * 100)}%`,
                      }}
                      title="silence"
                    />
                  ))}
                {(edits.broll ?? []).map((b, i) => (
                  <div
                    key={`b${i}`}
                    className="absolute bottom-0 h-1.5 bg-sky-400/80"
                    style={{
                      left: `${(b.start / clip.duration) * 100}%`,
                      width: `${Math.max(0.4, ((b.end - b.start) / clip.duration) * 100)}%`,
                    }}
                    title="b-roll"
                  />
                ))}
                <div
                  className="absolute inset-y-0 w-0.5 bg-white pointer-events-none"
                  style={{ left: `${(t / clip.duration) * 100}%` }}
                />
              </div>

              {hasBeats && (
                <p className="text-[11px] text-amber-300/80 leading-snug flex gap-1.5">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
                  Assembled from {clip.segments!.length} narrative beats — cuts, b-roll, music and
                  motion apply to single-range clips. Everything else here works.
                </p>
              )}
              {(clip.renderWarnings?.length ?? 0) > 0 && (
                <div className="space-y-0.5">
                  {clip.renderWarnings!.map((w, i) => (
                    <p key={i} className="text-[11px] text-amber-300/80 leading-snug">{w}</p>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Transcript tool: the primary edit surface ───────────────────────────

function TranscriptTool(props: {
  loading: boolean;
  words: Word[];
  isCut: (w: Word) => boolean;
  onToggle: (w: Word) => void;
  onSeek: (s: number) => void;
  activeIdx: number;
  activeRef: React.RefObject<HTMLSpanElement>;
  fillerCount: number;
  onRemoveFillers: () => void;
  cutCount: number;
  onClearCuts: () => void;
  silenceInfo: { spans: number; totalSilentSec: number } | null;
  silenceOn: boolean;
  analyzing: boolean;
  onAnalyzeSilence: () => void;
  onToggleSilence: () => void;
}) {
  if (props.loading) {
    return <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-purple-400" /></div>;
  }
  if (props.words.length === 0) {
    return (
      <div className="text-center py-10 px-2">
        <Type className="w-8 h-8 text-gray-700 mx-auto mb-2" />
        <p className="text-xs text-gray-400 mb-1">No transcript for this range</p>
        <p className="text-[11px] text-gray-600">
          Transcript-based editing needs the video transcribed. It runs automatically after import.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Button
          size="sm" variant="outline"
          disabled={props.fillerCount === 0}
          onClick={props.onRemoveFillers}
          className="text-[11px] h-7 border-gray-700"
          data-testid="remove-fillers"
        >
          <Wand2 className="w-3 h-3 mr-1" />
          Remove {props.fillerCount} filler{props.fillerCount === 1 ? "" : "s"}
        </Button>
        <Button
          size="sm" variant="outline"
          disabled={props.analyzing}
          onClick={props.silenceInfo ? props.onToggleSilence : props.onAnalyzeSilence}
          className={`text-[11px] h-7 border-gray-700 ${props.silenceOn ? "text-emerald-300 border-emerald-500/40" : ""}`}
          data-testid="silence-action"
        >
          {props.analyzing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Scissors className="w-3 h-3 mr-1" />}
          {props.analyzing
            ? "Analyzing…"
            : props.silenceInfo
              ? `${props.silenceOn ? "Keeping" : "Cut"} ${props.silenceInfo.totalSilentSec.toFixed(1)}s silence`
              : "Find silence"}
        </Button>
        {props.cutCount > 0 && (
          <Button size="sm" variant="ghost" onClick={props.onClearCuts} className="text-[11px] h-7 text-gray-400">
            <Undo2 className="w-3 h-3 mr-1" />
            Undo {props.cutCount}
          </Button>
        )}
      </div>

      <p className="text-[11px] text-gray-500 leading-snug">
        Click any word to cut it. Struck words are removed from the clip and the gap closes.
      </p>

      <p className="text-[13px] leading-[1.9] select-none">
        {props.words.map((w, i) => {
          const cut = props.isCut(w);
          const active = i === props.activeIdx;
          return (
            <span
              key={`${w.start}-${i}`}
              ref={active ? props.activeRef : undefined}
              onClick={() => props.onToggle(w)}
              onDoubleClick={() => props.onSeek(w.start)}
              title={`${w.start.toFixed(2)}s — click to ${cut ? "restore" : "cut"}, double-click to seek`}
              className={`cursor-pointer rounded px-0.5 transition-colors ${
                cut
                  ? "line-through text-gray-600 decoration-red-500/70"
                  : active
                    ? "bg-purple-500/40 text-white"
                    : "text-gray-200 hover:bg-gray-700/60"
              }`}
            >
              {w.word}{" "}
            </span>
          );
        })}
      </p>
    </div>
  );
}

// ── Captions ────────────────────────────────────────────────────────────

const STYLE_LABELS: Record<string, string> = {
  highlight: "Highlight — word-by-word pop",
  brand_callout: "Brand callout — tighter, gold",
  narrative: "Narrative — longer lines, fade",
};

function CaptionsTool(props: { enabled: boolean; style: string; onToggle: () => void; onStyle: (s: string) => void }) {
  return (
    <div className="space-y-3">
      <button
        onClick={props.onToggle}
        className={`w-full px-3 py-2 rounded-md text-xs font-medium border transition-colors ${
          props.enabled ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-gray-800 text-gray-400 border-gray-700"
        }`}
        data-testid="studio-captions-toggle"
      >
        Captions {props.enabled ? "on" : "off"}
      </button>
      {props.enabled && (
        <div className="space-y-1.5">
          {Object.entries(STYLE_LABELS).map(([k, label]) => (
            <button
              key={k}
              onClick={() => props.onStyle(k)}
              className={`w-full text-left px-3 py-2 rounded-md text-[11px] border transition-colors ${
                props.style === k
                  ? "bg-purple-500/20 text-purple-200 border-purple-500/50"
                  : "bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-500"
              }`}
            >
              {label}
            </button>
          ))}
          <p className="text-[11px] text-gray-600 pt-1">
            Size, position and colour live in the clip's Edit panel — this picks the look.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Shared asset picker (b-roll + music) ────────────────────────────────

function useAssets(kinds: string[]) {
  return useQuery<{ assets: AssetRow[] }>({
    queryKey: ["/api/media-assets", kinds.join(",")],
    queryFn: async () => {
      const results = await Promise.all(
        kinds.map((k) =>
          fetchWithTimeout(`/api/media-assets?kind=${k}`, { credentials: "include" }).then((r) => r.json()),
        ),
      );
      return { assets: results.flatMap((r) => r.assets ?? []) };
    },
  });
}

async function uploadAsset(file: File, kind: string): Promise<AssetRow> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetchWithTimeout(`/api/media-assets?kind=${kind}`, { method: "POST", credentials: "include", body: form }, UPLOAD_TIMEOUT_MS);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Upload failed");
  return (await res.json()).asset;
}

function UploadButton({ kind, accept, onDone, label }: { kind: string; accept: string; onDone: (a: AssetRow) => void; label: string }) {
  const [busy, setBusy] = useState(false);
  const id = `up-${kind}-${label.replace(/\s/g, "")}`;
  return (
    <>
      <label
        htmlFor={id}
        className="cursor-pointer flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-dashed border-gray-600 text-[11px] text-gray-300 hover:border-gray-400"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
        {busy ? "Uploading…" : label}
      </label>
      <input
        id={id} type="file" accept={accept} className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setBusy(true);
          try { onDone(await uploadAsset(f, f.type.startsWith("image/") ? "broll_image" : kind)); }
          catch (err: any) { alert(err?.message || "Upload failed"); }
          finally { setBusy(false); }
        }}
      />
    </>
  );
}

function BrollTool(props: {
  cuts: NonNullable<StudioEdits["broll"]>;
  duration: number;
  playhead: number;
  clipId: number;
  /** What's being said at the playhead — the seed for a generated cutaway. */
  spokenAtPlayhead: string;
  onChange: (b: NonNullable<StudioEdits["broll"]>) => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const { data } = useAssets(["broll_video", "broll_image"]);
  const assets = data?.assets ?? [];
  const [filter, setFilter] = useState("");
  const shown = assets.filter((a) => a.name.toLowerCase().includes(filter.toLowerCase()));

  // ── Stock search ──────────────────────────────────────────────────
  // Uploading your own b-roll is the wrong default: the point of a b-roll cut
  // is generic filler over a talking head, and nobody wants to go shoot
  // "person typing at a desk".
  const [tab, setTab] = useState<"mine" | "stock" | "ai">("stock");
  const [q, setQ] = useState("");
  const [stock, setStock] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [stockErr, setStockErr] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  const runSearch = async () => {
    if (!q.trim()) return;
    setSearching(true);
    setStockErr(null);
    try {
      const res = await fetchWithTimeout(
        `/api/media-assets/stock/search?q=${encodeURIComponent(q.trim())}`,
        { credentials: "include" },
      );
      const body = await res.json();
      if (!res.ok) { setStockErr(body.error || "Search failed"); setStock([]); return; }
      setStock(body.videos ?? []);
      if ((body.videos ?? []).length === 0) setStockErr(`Nothing found for "${q.trim()}".`);
    } catch (err: any) {
      setStockErr(err?.message || "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const importStock = async (v: any) => {
    setImporting(v.uid);
    try {
      const res = await fetchWithTimeout("/api/media-assets/stock/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fileUrl: v.fileUrl, name: q.trim() || "Stock clip",
          durationSec: v.durationSec, photographer: v.author, pageUrl: v.pageUrl,
        }),
      }, 180_000);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Import failed");
      props.queryClient.invalidateQueries({ queryKey: ["/api/media-assets"] });
      addAt(body.asset.id);
      setTab("mine");
    } catch (err: any) {
      alert(err?.message || "Import failed");
    } finally {
      setImporting(null);
    }
  };

  const addAt = (assetId: number) => {
    const start = Math.min(props.playhead, Math.max(0, props.duration - 3));
    props.onChange([
      ...props.cuts,
      // Full frame by default — a cutaway takes over the shot. PiP is the
      // deliberate exception, not the norm.
      { assetId, start, end: Math.min(props.duration, start + 3), fit: "cover", scale: 1, x: 1, y: 0, muted: true, motion: "push" },
    ]);
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1 p-0.5 rounded bg-gray-800">
        {(["stock", "ai", "mine"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex-1 py-1 rounded text-[11px] transition-colors ${
              tab === k ? "bg-purple-600/30 text-purple-200" : "text-gray-500 hover:text-gray-300"
            }`}
            data-testid={`broll-tab-${k}`}
          >
            {k === "stock" ? "Stock" : k === "ai" ? "Generate" : `Uploads${assets.length ? ` (${assets.length})` : ""}`}
          </button>
        ))}
      </div>

      {tab === "ai" ? (
        <AiGenerateTool
          playhead={props.playhead}
          spokenAtPlayhead={props.spokenAtPlayhead}
          clipId={props.clipId}
          onGenerated={(assetId) => {
            props.queryClient.invalidateQueries({ queryKey: ["/api/media-assets"] });
            addAt(assetId);
            setTab("mine");
          }}
        />
      ) : tab === "stock" ? (
        <>
          <form
            onSubmit={(e) => { e.preventDefault(); runSearch(); }}
            className="flex gap-1.5"
          >
            <div className="relative flex-1">
              <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="city street, laptop, coffee…"
                className="w-full h-8 pl-7 pr-2 rounded bg-gray-800 border border-gray-700 text-[11px]"
                data-testid="stock-query"
              />
            </div>
            <Button type="submit" size="sm" disabled={searching || !q.trim()} className="h-8 text-[11px] bg-purple-600 hover:bg-purple-500">
              {searching ? <Loader2 className="w-3 h-3 animate-spin" /> : "Search"}
            </Button>
          </form>

          {stockErr && (
            <div className="rounded border border-amber-500/25 bg-amber-500/5 p-2">
              <p className="text-[11px] text-amber-300/90 leading-snug">{stockErr}</p>
              {/* The env-var case has a specific, checkable cause — say it,
                  rather than leaving "search failed" to be interpreted. */}
              {/PEXELS_API_KEY/i.test(stockErr) && (
                <p className="text-[10px] text-gray-500 leading-snug mt-1">
                  A secret added to the Replit workspace isn't automatically available to a
                  Deployment — check it's set there too, then redeploy.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            {stock.map((v) => (
              <button
                key={v.uid}
                onClick={() => importStock(v)}
                disabled={importing !== null}
                className="relative rounded overflow-hidden border border-gray-700 hover:border-purple-500/60 disabled:opacity-50 group"
                title={`Insert at ${fmtTime(props.playhead)} — ${v.providerLabel}, by ${v.author}`}
                data-testid={`stock-result-${v.uid}`}
              >
                <img src={v.previewUrl} alt="" className="w-full aspect-video object-cover" loading="lazy" />
                <span className="absolute top-1 left-1 bg-black/70 text-[8px] text-gray-300 px-1 rounded">
                  {v.providerLabel}
                </span>
                <span className="absolute bottom-0 inset-x-0 bg-black/70 text-[9px] text-gray-300 px-1 py-0.5 truncate">
                  {importing === v.uid ? "Importing…" : `${Math.round(v.durationSec)}s · ${v.author}`}
                </span>
                {v.pageUrl && (
                  <a
                    href={v.pageUrl} target="_blank" rel="noreferrer noopener"
                    onClick={(e) => e.stopPropagation()}
                    className="absolute top-1 right-1 bg-black/70 text-[8px] text-purple-200 px-1 rounded hover:text-white"
                    title={`View source on ${v.providerLabel}`}
                  >
                    source
                  </a>
                )}
              </button>
            ))}
          </div>

          {stock.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] text-gray-600 leading-snug">
                Clicking imports the file into your assets and drops it at the playhead.
              </p>
              {/* Credit + source link. This is an API-guideline obligation and
                  a SEPARATE thing from the content licence — the licence says
                  attribution isn't required for the footage; the API terms
                  require crediting the photographer and linking the source
                  wherever results are shown. */}
              <p className="text-[10px] text-gray-600 leading-snug">
                Footage from{" "}
                <a href="https://www.pexels.com" target="_blank" rel="noreferrer noopener"
                   className="text-purple-300 hover:underline">Pexels</a>
                {" "}and{" "}
                <a href="https://pixabay.com" target="_blank" rel="noreferrer noopener"
                   className="text-purple-300 hover:underline">Pixabay</a>.
                Each result credits its creator; click through from the tile for the source.
              </p>
              <p className="text-[10px] text-gray-600 leading-snug">
                B-roll is story footage — a cutaway illustrating what's being said. Brand
                placements stay on your own footage: a full-frame cutaway automatically
                hides any placement while it's on screen.
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          <UploadButton
            kind="broll_video" accept="video/*,image/*" label="Upload footage or a still"
            onDone={(a) => { props.queryClient.invalidateQueries({ queryKey: ["/api/media-assets"] }); addAt(a.id); }}
          />
          <div className="relative">
            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter your library…"
              className="w-full h-8 pl-7 pr-2 rounded bg-gray-800 border border-gray-700 text-[11px]"
            />
          </div>

          {shown.length === 0 ? (
            <p className="text-[11px] text-gray-600 py-4 text-center">
              {assets.length === 0 ? "Nothing uploaded yet — try Search stock." : "Nothing matches that filter."}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-1.5">
              {shown.map((a) => (
                <button
                  key={a.id}
                  onClick={() => addAt(a.id)}
                  className="rounded border border-gray-700 p-1.5 text-left hover:border-purple-500/60"
                  title={`Insert at ${fmtTime(props.playhead)}`}
                >
                  <p className="text-[10px] truncate text-gray-300">{a.name}</p>
                  {a.durationSec && <p className="text-[9px] text-gray-600">{Math.round(Number(a.durationSec))}s</p>}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {props.cuts.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <p className="text-[11px] text-gray-400">In this clip</p>
          {props.cuts.map((c, i) => {
            const a = assets.find((x) => x.id === c.assetId);
            return (
              <div key={i} className="flex items-center gap-2 rounded border border-gray-700/60 px-2 py-1.5">
                <span className="text-[11px] truncate flex-1 text-gray-300">{a?.name ?? `#${c.assetId}`}</span>
                <span className="text-[10px] text-gray-500 tabular-nums shrink-0">
                  {c.start.toFixed(1)}–{c.end.toFixed(1)}s
                </span>
                <button
                  onClick={() => props.onChange(props.cuts.map((x, j) => (j === i ? { ...x, scale: x.scale >= 1 ? 0.4 : 1 } : x)))}
                  className="text-[9px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-400 shrink-0"
                  title={c.scale >= 1 ? "Full-frame cutaway — tap for picture-in-picture" : "Picture-in-picture — tap for full frame"}
                >
                  {c.scale >= 1 ? "full frame" : "PiP"}
                </button>
                {/* Stills need a move or they read as a freeze. Video already
                    moves, so the control is simply unused there. */}
                <button
                  onClick={() => props.onChange(props.cuts.map((x, j) => (j === i
                    ? { ...x, motion: x.motion === "push" ? "pull" : x.motion === "pull" ? "none" : "push" }
                    : x)))}
                  className="text-[9px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-400 shrink-0"
                  title="Ken Burns move, for still images"
                >
                  {c.motion === "none" ? "static" : c.motion === "pull" ? "pull out" : "push in"}
                </button>
                <button onClick={() => props.onChange(props.cuts.filter((_, j) => j !== i))} className="text-gray-500 hover:text-red-400 shrink-0">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AudioTool(props: {
  music: StudioEdits["music"];
  onChange: (m: StudioEdits["music"]) => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const { data } = useAssets(["music"]);
  const assets = data?.assets ?? [];
  const m = props.music;
  return (
    <div className="space-y-3">
      <UploadButton
        kind="music" accept="audio/*" label="Upload a music bed"
        onDone={(a) => {
          props.queryClient.invalidateQueries({ queryKey: ["/api/media-assets"] });
          props.onChange({ assetId: a.id, volume: 0.2, ducking: true, duckAmountDb: 12, fadeInSec: 1, fadeOutSec: 2 });
        }}
      />
      <div className="space-y-1">
        {assets.map((a) => (
          <button
            key={a.id}
            onClick={() =>
              props.onChange(
                m?.assetId === a.id
                  ? null
                  : { assetId: a.id, volume: m?.volume ?? 0.2, ducking: m?.ducking ?? true, duckAmountDb: m?.duckAmountDb ?? 12, fadeInSec: m?.fadeInSec ?? 1, fadeOutSec: m?.fadeOutSec ?? 2 },
              )
            }
            className={`w-full text-left px-2.5 py-1.5 rounded text-[11px] border transition-colors ${
              m?.assetId === a.id ? "bg-purple-500/20 text-purple-200 border-purple-500/50" : "bg-gray-800 text-gray-400 border-gray-700"
            }`}
          >
            {a.name}
          </button>
        ))}
        {assets.length === 0 && <p className="text-[11px] text-gray-600 py-3 text-center">No music uploaded yet.</p>}
      </div>

      {m && (
        <div className="space-y-2 pt-1">
          <Slider label="Bed volume" value={m.volume} min={0} max={1} step={0.05}
            display={`${Math.round(m.volume * 100)}%`}
            onChange={(v) => props.onChange({ ...m, volume: v })} />
          <button
            onClick={() => props.onChange({ ...m, ducking: !m.ducking })}
            className={`w-full px-2.5 py-1.5 rounded text-[11px] border ${
              m.ducking ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-gray-800 text-gray-400 border-gray-700"
            }`}
          >
            Duck under speech {m.ducking ? "on" : "off"}
          </button>
          <Slider label="Fade in" value={m.fadeInSec} min={0} max={5} step={0.5} display={`${m.fadeInSec.toFixed(1)}s`}
            onChange={(v) => props.onChange({ ...m, fadeInSec: v })} />
          <Slider label="Fade out" value={m.fadeOutSec} min={0} max={5} step={0.5} display={`${m.fadeOutSec.toFixed(1)}s`}
            onChange={(v) => props.onChange({ ...m, fadeOutSec: v })} />
        </div>
      )}
    </div>
  );
}

function MotionTool(props: {
  stabilization: StudioEdits["stabilization"];
  ramps: NonNullable<StudioEdits["speedRamps"]>;
  duration: number;
  playhead: number;
  onChange: (p: Partial<StudioEdits>) => void;
}) {
  const st = props.stabilization;
  return (
    <div className="space-y-3">
      <button
        onClick={() => props.onChange({ stabilization: st?.enabled ? null : { enabled: true, strength: 5 } })}
        className={`w-full px-3 py-2 rounded-md text-xs font-medium border transition-colors ${
          st?.enabled ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-gray-800 text-gray-400 border-gray-700"
        }`}
        data-testid="studio-stabilize"
      >
        Stabilize {st?.enabled ? "on" : "off"}
      </button>
      {st?.enabled && (
        <Slider label="Strength" value={st.strength} min={1} max={10} step={1} display={String(st.strength)}
          onChange={(v) => props.onChange({ stabilization: { enabled: true, strength: v } })} />
      )}

      <div className="pt-1 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-gray-400">Speed ramps</span>
          <Button
            size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-purple-300"
            onClick={() => props.onChange({
              speedRamps: [...props.ramps, {
                start: props.playhead,
                end: Math.min(props.duration, props.playhead + 3),
                rate: 1.5,
              }],
            })}
          >
            Add at playhead
          </Button>
        </div>
        {props.ramps.map((r, i) => (
          <div key={i} className="rounded border border-gray-700/60 p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 tabular-nums flex-1">
                {r.start.toFixed(1)}–{r.end.toFixed(1)}s
              </span>
              <button
                onClick={() => props.onChange({ speedRamps: props.ramps.filter((_, j) => j !== i) })}
                className="text-gray-500 hover:text-red-400"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            <Slider label="Speed" value={r.rate} min={0.25} max={4} step={0.05} display={`${r.rate.toFixed(2)}x`}
              onChange={(v) => props.onChange({ speedRamps: props.ramps.map((x, j) => (j === i ? { ...x, rate: v } : x)) })} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Slider(props: {
  label: string; value: number; min: number; max: number; step: number; display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <label className="text-[11px] text-gray-400">{props.label}</label>
        <span className="text-[11px] text-gray-500 tabular-nums">{props.display}</span>
      </div>
      <input
        type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full accent-purple-500"
      />
    </div>
  );
}

/**
 * AI-generated cutaways — the paid tier.
 *
 * Two deliberate product choices visible here:
 *
 * 1. IMAGES ARE THE DEFAULT, not video. A cutaway is on screen for two or
 *    three seconds under a talking head; a generated still with a slow push
 *    is usually indistinguishable from generated video at a fraction of the
 *    cost and seconds instead of minutes. The video option exists, priced
 *    honestly, for when motion actually matters.
 *
 * 2. THE PROMPT IS SEEDED FROM WHAT THEY'RE SAYING. The transcript is right
 *    there, so "use what's being said" turns the spoken line into a scene
 *    description. Feeding a model the raw sentence produces literal, useless
 *    results — the derivation keeps the concrete nouns and drops the
 *    scaffolding a speaker uses to think.
 */
function AiGenerateTool(props: {
  playhead: number;
  spokenAtPlayhead: string;
  clipId: number;
  onGenerated: (assetId: number) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState("image-fast");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);
  // Video animates a still the creator already approved, so it needs one
  // selected. Their own generated images are the natural candidates.
  const [seedAssetId, setSeedAssetId] = useState<number | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const { data: ownAssets } = useAssets(["broll_image"]);

  const { data: opts, refetch } = useQuery<{
    available: boolean; detail: string | null; balance: number;
    allowance: { freeImagesPerDay: number; freeImagesUsedToday: number; freeImagesLeft: number; balance: number };
    models: Array<{
      id: string; kind: string; label: string;
      credits: number; listCredits: number; free: boolean; priceReason: string;
      typicalSeconds: number; outputSeconds: number | null; seedsFromImage: boolean; notes: string;
    }>;
  }>({
    queryKey: ["/api/ai/generation/options"],
    queryFn: async () => (await fetchWithTimeout("/api/ai/generation/options", { credentials: "include" })).json(),
  });

  const model = opts?.models.find((m) => m.id === modelId);
  const affordable = model?.free || (opts?.balance ?? 0) >= (model?.credits ?? 0);
  const allowance = opts?.allowance;
  // The paywall moment: free images spent, on an image model. This is where
  // the upgrade prompt earns its keep — against work they can already see.
  const atImageCap = !!model && model.kind === "image" && !model.free;

  const seedFromTranscript = async () => {
    if (!props.spokenAtPlayhead) return;
    const res = await fetchWithTimeout("/api/ai/prompt-from-transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ text: props.spokenAtPlayhead }),
    });
    const body = await res.json();
    if (body.prompt) { setPrompt(body.prompt); setSeeded(true); }
  };

  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetchWithTimeout("/api/ai/generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          modelId, prompt,
          promptSource: seeded ? "transcript" : "manual",
          editorialClipId: props.clipId,
          seedAssetId,
        }),
        // Video generation runs for minutes; the request has to outlast it.
      }, (model?.typicalSeconds ?? 30) * 1000 * 3 + 60_000);
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setErr(body.error || "Generation failed");
        if (res.status === 402) setShowUpgrade(true);
        await refetch();
        return;
      }
      await refetch();
      props.onGenerated(body.assetId);
    } catch (e: any) {
      setErr(e?.message || "Generation failed");
    } finally {
      setBusy(false);
    }
  };

  if (opts && !opts.available) {
    return (
      <div className="text-center py-8 px-2">
        <Sparkles className="w-8 h-8 text-gray-700 mx-auto mb-2" />
        <p className="text-xs text-gray-400 mb-1">AI generation isn't switched on here</p>
        <p className="text-[11px] text-gray-600 leading-snug">{opts.detail}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Allowance first — a creator should know what's free before choosing. */}
      {allowance && (
        <div className="rounded border border-gray-700/60 p-2 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-gray-400">Free images today</span>
            <span className="text-[11px] tabular-nums text-emerald-300">
              {allowance.freeImagesLeft} / {allowance.freeImagesPerDay}
            </span>
          </div>
          <div className="h-1 rounded-full bg-gray-800 overflow-hidden">
            <div
              className="h-full bg-emerald-500/70"
              style={{ width: `${(allowance.freeImagesLeft / Math.max(1, allowance.freeImagesPerDay)) * 100}%` }}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-gray-500">Credits</span>
            <span className="text-[11px] tabular-nums text-gray-300">{allowance.balance}</span>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {(opts?.models ?? []).map((m) => (
          <button
            key={m.id}
            onClick={() => setModelId(m.id)}
            className={`w-full text-left px-2.5 py-2 rounded-md border transition-colors ${
              modelId === m.id
                ? "bg-purple-500/20 text-purple-200 border-purple-500/50"
                : "bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-500"
            }`}
            data-testid={`gen-model-${m.id}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium">{m.label}</span>
              <span className={`text-[10px] shrink-0 ${m.free ? "text-emerald-300" : "text-gray-500"}`}>
                {m.free
                  ? `Free · ~${m.typicalSeconds}s`
                  : `${m.credits} credit${m.credits === 1 ? "" : "s"} · ~${m.typicalSeconds}s`}
              </span>
            </div>
            <p className="text-[10px] text-gray-500 mt-0.5 leading-snug">{m.notes}</p>
          </button>
        ))}
      </div>

      {model?.seedsFromImage && (
        <div className="space-y-1 rounded border border-purple-500/25 bg-purple-500/5 p-2">
          <label className="text-[11px] text-purple-200">Which image should move?</label>
          <select
            value={seedAssetId ?? ""}
            onChange={(e) => setSeedAssetId(e.target.value ? Number(e.target.value) : null)}
            className="w-full h-8 px-1.5 rounded bg-gray-800 border border-gray-700 text-[11px] text-gray-300"
            data-testid="gen-seed"
          >
            <option value="">Choose a still…</option>
            {(ownAssets?.assets ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.name.slice(0, 44)}</option>
            ))}
          </select>
          <p className="text-[10px] text-gray-500 leading-snug">
            Video starts from a still you've already seen — so you never spend video credits
            on a composition you'd reject.
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-gray-400">
            {model?.seedsFromImage ? "How should it move?" : "What should the cutaway show?"}
          </label>
          {props.spokenAtPlayhead && (
            <button
              onClick={seedFromTranscript}
              className="text-[10px] text-purple-300 hover:text-purple-200"
              data-testid="seed-from-transcript"
            >
              Use what's being said
            </button>
          )}
        </div>
        <textarea
          value={prompt}
          onChange={(e) => { setPrompt(e.target.value); setSeeded(false); }}
          rows={3}
          placeholder="a quiet city street at dawn, shot on film…"
          className="w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-700 text-[11px] resize-none"
          data-testid="gen-prompt"
        />
      </div>

      {/* The paywall, in context. It appears where the intent is, against a
          prompt they've already written — not on a separate screen. */}
      {(showUpgrade || (atImageCap && (allowance?.balance ?? 0) < (model?.credits ?? 1))) && (
        <div className="rounded border border-purple-500/40 bg-purple-500/10 p-2.5 space-y-1.5">
          <p className="text-[11px] font-medium text-purple-200">
            {model?.kind === "video" ? "AI video runs on credits" : "You've used today's free images"}
          </p>
          <p className="text-[10px] text-gray-400 leading-snug">
            {model?.kind === "video"
              ? "Video generation is metered — each 5-second clip costs 10 credits. Images stay free, 5 a day."
              : `Your ${allowance?.freeImagesPerDay} free images reset tomorrow. Credits cover more today, and unlock AI video.`}
          </p>
          <Button
            size="sm"
            onClick={() => window.open("/settings?tab=credits", "_blank")}
            className="w-full bg-purple-600 hover:bg-purple-500 text-white text-[11px] h-7"
            data-testid="gen-upgrade"
          >
            Get credits
          </Button>
        </div>
      )}

      {err && <p className="text-[11px] text-amber-300/90 leading-snug">{err}</p>}

      <Button
        onClick={generate}
        disabled={busy || prompt.trim().length < 3 || !affordable || (!!model?.seedsFromImage && !seedAssetId)}
        className="w-full bg-purple-600 hover:bg-purple-500 text-white text-xs"
        data-testid="gen-run"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
        {busy
          ? `Generating… (~${model?.typicalSeconds ?? 30}s)`
          : !affordable
            ? `Needs ${model?.credits} credits`
            : model?.free
              ? "Generate — free"
              : `Generate for ${model?.credits} credit${model?.credits === 1 ? "" : "s"}`}
      </Button>

      <p className="text-[10px] text-gray-600 leading-snug">
        Lands in your uploads and drops at the playhead as a full-frame cutaway with a slow
        push. Failed generations never cost you — credits are refunded, and a free image
        doesn't count against your daily five.
      </p>
    </div>
  );
}
