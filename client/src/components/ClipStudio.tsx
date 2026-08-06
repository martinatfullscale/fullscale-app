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
 * PREVIEW HONESTY. The player shows the last RENDERED clip. Pending edits are
 * drawn over the timeline as cut markers rather than faked in the video,
 * because we cannot apply an ffmpeg filtergraph in the browser and a preview
 * that silently lied about the output would be worse than no preview. The
 * duration readout updates live so the effect of a cut is still immediate.
 */
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fetchWithTimeout } from "@/lib/queryClient";
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
  broll?: Array<{ assetId: number; start: number; end: number; fit: string; scale: number; x: number; y: number; muted: boolean }>;
  music?: { assetId: number; volume: number; ducking: boolean; duckAmountDb: number; fadeInSec: number; fadeOutSec: number } | null;
  stabilization?: { enabled: boolean; strength: number } | null;
}

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

  // ── Player wiring ──────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setT(v.currentTime);
    const onEnd = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnd);
    return () => { v.removeEventListener("timeupdate", onTime); v.removeEventListener("ended", onEnd); };
  }, [clip.exportPath]);

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
                <video
                  ref={videoRef}
                  key={clip.exportPath}
                  src={clip.exportPath}
                  poster={clip.thumbnailPath || undefined}
                  playsInline
                  className={`max-h-full rounded-lg bg-black ${aspect === "9:16" ? "aspect-[9/16]" : "aspect-video"}`}
                  onClick={togglePlay}
                />
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

interface AssetRow { id: number; kind: string; name: string; url: string; durationSec: string | null }

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
  const res = await fetch(`/api/media-assets?kind=${kind}`, { method: "POST", credentials: "include", body: form });
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
  onChange: (b: NonNullable<StudioEdits["broll"]>) => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const { data } = useAssets(["broll_video", "broll_image"]);
  const assets = data?.assets ?? [];
  const [filter, setFilter] = useState("");
  const shown = assets.filter((a) => a.name.toLowerCase().includes(filter.toLowerCase()));

  const addAt = (assetId: number) => {
    const start = Math.min(props.playhead, Math.max(0, props.duration - 3));
    props.onChange([
      ...props.cuts,
      { assetId, start, end: Math.min(props.duration, start + 3), fit: "cover", scale: 1, x: 1, y: 0, muted: true },
    ]);
  };

  return (
    <div className="space-y-3">
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
          {assets.length === 0 ? "No b-roll uploaded yet." : "Nothing matches that filter."}
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
                >
                  {c.scale >= 1 ? "full" : "PiP"}
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
