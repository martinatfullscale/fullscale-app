/**
 * Clip Editor — the editing surface for an editorial clip.
 *
 * Before this, an editorial clip had exactly one control: a 9:16 / 16:9
 * toggle. Trim was fixed at whatever the narrative analysis chose, captions
 * were burned in unconditionally, and the caption style was hardcoded to
 * "highlight" on every render — so a creator could not change anything about
 * a clip except its shape.
 *
 * Everything here maps to a parameter the render pipeline already accepted or
 * now accepts, and every value is persisted on the clip so a later re-render
 * reproduces the creator's choices instead of reverting to pipeline defaults.
 *
 * One honest limitation, surfaced in the UI rather than hidden: re-trimming an
 * assembled multi-beat clip collapses it to a single range. The beats are a
 * narrative structure the analysis chose; a new trim can't preserve them.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Scissors, Type, Loader2, RotateCcw, AlertTriangle, Music, Film,
  Gauge, AudioLines, Anchor, Plus, Trash2, Upload,
} from "lucide-react";

// ── The edit stack, as the server's EditStack shape ──────────────────────

interface SpeedRampUI { start: number; end: number; rate: number }
interface TextOverlayUI {
  start: number; end: number; text: string;
  x: number; y: number; size: number;
  color: string; background: string | null;
  weight: "regular" | "bold"; align: "left" | "center" | "right";
}
interface BrollCutUI {
  assetId: number; start: number; end: number;
  fit: "cover" | "contain"; scale: number; x: number; y: number; muted: boolean;
}
export interface EditStackUI {
  stabilization?: { enabled: boolean; strength: number } | null;
  silenceCut?: { enabled: boolean; thresholdDb: number; minDurationSec: number; paddingSec: number } | null;
  speedRamps?: SpeedRampUI[];
  textOverlays?: TextOverlayUI[];
  broll?: BrollCutUI[];
  music?: { assetId: number; volume: number; ducking: boolean; duckAmountDb: number; fadeInSec: number; fadeOutSec: number } | null;
}

interface MediaAssetRow {
  id: number; kind: string; name: string; url: string; durationSec: string | null;
}

export interface ClipEditSettings {
  clipStart: number;
  clipEnd: number;
  aspect: "9:16" | "16:9";
  captionsEnabled: boolean;
  captionStyle: "highlight" | "brand_callout" | "narrative";
  sizeScale: number;
  positionRatio: number;
  wordsPerPhrase: number;
  outline: number;
  accentHex: string;
  /** The full stack — b-roll, music, ducking, speed, silence, stabilization. */
  edits: EditStackUI;
}

interface Props {
  clip: {
    id: number;
    clipStart: number;
    clipEnd: number;
    duration: number;
    aspectRatio?: string | null;
    captionsEnabled?: boolean | null;
    captionStyle?: string | null;
    captionSettings?: Record<string, number | string | undefined> | null;
    segments?: Array<{ start: number; end: number; role?: string }> | null;
    edits?: EditStackUI | null;
    silenceAnalysis?: { spans: Array<{ start: number; end: number }>; totalSilentSec: number } | null;
    renderWarnings?: string[] | null;
  };
  /** Source video length in seconds, when known — bounds the trim. */
  sourceDurationSec?: number;
  onApply: (settings: ClipEditSettings) => Promise<void>;
  onClose: () => void;
}

const STYLE_LABELS: Record<ClipEditSettings["captionStyle"], { name: string; hint: string }> = {
  highlight: { name: "Highlight", hint: "Word-by-word, 4 per line — the punchy default" },
  brand_callout: { name: "Brand callout", hint: "Tighter phrasing, warm gold accent" },
  narrative: { name: "Narrative", hint: "Longer lines, no per-word pop, gentle fade" },
};

const ACCENTS = ["#FFE500", "#FFC221", "#22D3EE", "#F472B6", "#4ADE80", "#FFFFFF"];

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
};

export default function ClipEditorPanel({ clip, sourceDurationSec, onApply, onClose }: Props) {
  const cs = clip.captionSettings ?? {};
  const [s, setS] = useState<ClipEditSettings>({
    clipStart: clip.clipStart,
    clipEnd: clip.clipEnd,
    aspect: (clip.aspectRatio === "16:9" ? "16:9" : "9:16"),
    captionsEnabled: clip.captionsEnabled !== false,
    captionStyle: (["highlight", "brand_callout", "narrative"].includes(String(clip.captionStyle))
      ? clip.captionStyle
      : "highlight") as ClipEditSettings["captionStyle"],
    sizeScale: Number(cs.sizeScale ?? 1),
    positionRatio: Number(cs.positionRatio ?? 0.14),
    wordsPerPhrase: Number(cs.wordsPerPhrase ?? 4),
    outline: Number(cs.outline ?? 3),
    accentHex: String(cs.accentHex ?? "#FFE500"),
    edits: {
      stabilization: clip.edits?.stabilization ?? null,
      silenceCut: clip.edits?.silenceCut ?? null,
      speedRamps: clip.edits?.speedRamps ?? [],
      textOverlays: clip.edits?.textOverlays ?? [],
      broll: clip.edits?.broll ?? [],
      music: clip.edits?.music ?? null,
    },
  });
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [silenceResult, setSilenceResult] = useState<{ spans: number; totalSilentSec: number } | null>(
    clip.silenceAnalysis ? { spans: clip.silenceAnalysis.spans.length, totalSilentSec: clip.silenceAnalysis.totalSilentSec } : null,
  );
  const queryClient = useQueryClient();

  // The creator's uploaded ingredients — b-roll and music live in
  // media_assets, deliberately outside the video library.
  const { data: musicAssets } = useQuery<{ assets: MediaAssetRow[] }>({
    queryKey: ["/api/media-assets", "music"],
    queryFn: async () => (await fetch("/api/media-assets?kind=music", { credentials: "include" })).json(),
  });
  const { data: brollAssets } = useQuery<{ assets: MediaAssetRow[] }>({
    queryKey: ["/api/media-assets", "broll"],
    queryFn: async () => {
      const [v, i] = await Promise.all([
        fetch("/api/media-assets?kind=broll_video", { credentials: "include" }).then((r) => r.json()),
        fetch("/api/media-assets?kind=broll_image", { credentials: "include" }).then((r) => r.json()),
      ]);
      return { assets: [...(v.assets ?? []), ...(i.assets ?? [])] };
    },
  });

  const uploadAsset = async (file: File, kind: string) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/media-assets?kind=${kind}`, {
      method: "POST", credentials: "include", body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Upload failed");
    }
    await queryClient.invalidateQueries({ queryKey: ["/api/media-assets"] });
    return (await res.json()).asset as MediaAssetRow;
  };

  const analyzeSilenceNow = async () => {
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/editorial-clips/${clip.id}/analyze-silence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          thresholdDb: s.edits.silenceCut?.thresholdDb,
          minDurationSec: s.edits.silenceCut?.minDurationSec,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Analysis failed");
      }
      const data = await res.json();
      setSilenceResult({ spans: data.spans.length, totalSilentSec: data.totalSilentSec });
    } finally {
      setAnalyzing(false);
    }
  };

  const setEdits = (patch: Partial<EditStackUI>) =>
    setS((prev) => ({ ...prev, edits: { ...prev.edits, ...patch } }));

  const set = <K extends keyof ClipEditSettings>(k: K, v: ClipEditSettings[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));

  // Trim bounds: the source when we know it, otherwise a generous window
  // around the original range so the sliders stay usable.
  const maxSec = sourceDurationSec && sourceDurationSec > 0
    ? sourceDurationSec
    : Math.max(clip.clipEnd + 60, clip.clipEnd * 1.5);
  const newDuration = Math.max(0, s.clipEnd - s.clipStart);
  const trimmed = s.clipStart !== clip.clipStart || s.clipEnd !== clip.clipEnd;
  const hasBeats = Array.isArray(clip.segments) && clip.segments.length > 1;

  const reset = () =>
    setS({
      clipStart: clip.clipStart,
      clipEnd: clip.clipEnd,
      aspect: (clip.aspectRatio === "16:9" ? "16:9" : "9:16"),
      captionsEnabled: clip.captionsEnabled !== false,
      captionStyle: "highlight",
      sizeScale: 1,
      positionRatio: 0.14,
      wordsPerPhrase: 4,
      outline: 3,
      accentHex: "#FFE500",
      edits: { stabilization: null, silenceCut: null, speedRamps: [], textOverlays: [], broll: [], music: null },
    });

  const apply = async () => {
    setBusy(true);
    try {
      await onApply(s);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const Row = ({ label, value, children }: { label: string; value: string; children: React.ReactNode }) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-[11px] text-gray-400">{label}</label>
        <span className="text-[11px] text-gray-500 tabular-nums">{value}</span>
      </div>
      {children}
    </div>
  );

  return (
    <div className="border-t border-gray-700/50 bg-gray-900/60 p-4 space-y-5" data-testid={`clip-editor-${clip.id}`}>
      {/* ── Trim ── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Scissors className="w-3.5 h-3.5 text-purple-400" />
          <h4 className="text-xs font-semibold text-gray-200">Trim</h4>
          <span className="text-[11px] text-gray-500 ml-auto tabular-nums">
            {fmt(s.clipStart)} → {fmt(s.clipEnd)} · {newDuration.toFixed(1)}s
          </span>
        </div>

        {/* Range bar: the original span in grey, the new selection highlighted */}
        <div className="relative h-2 rounded-full bg-gray-800 overflow-hidden">
          <div
            className="absolute inset-y-0 bg-purple-500/70"
            style={{
              left: `${(s.clipStart / maxSec) * 100}%`,
              width: `${(Math.max(0, newDuration) / maxSec) * 100}%`,
            }}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Row label="Start" value={`${s.clipStart.toFixed(1)}s`}>
            <input
              type="range" min={0} max={maxSec} step={0.1}
              value={s.clipStart}
              onChange={(e) => set("clipStart", Math.min(Number(e.target.value), s.clipEnd - 1))}
              className="w-full accent-purple-500"
              data-testid={`trim-start-${clip.id}`}
            />
          </Row>
          <Row label="End" value={`${s.clipEnd.toFixed(1)}s`}>
            <input
              type="range" min={0} max={maxSec} step={0.1}
              value={s.clipEnd}
              onChange={(e) => set("clipEnd", Math.max(Number(e.target.value), s.clipStart + 1))}
              className="w-full accent-purple-500"
              data-testid={`trim-end-${clip.id}`}
            />
          </Row>
        </div>

        {trimmed && hasBeats && (
          <p className="text-[11px] text-amber-300/90 flex items-start gap-1.5 leading-snug">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            This clip is assembled from {clip.segments!.length} narrative beats. Re-trimming
            collapses it to one continuous range — the beat structure can't survive a new cut.
          </p>
        )}
      </section>

      {/* ── Shape ── */}
      <section className="space-y-2">
        <h4 className="text-xs font-semibold text-gray-200">Shape</h4>
        <div className="flex gap-2">
          {(["9:16", "16:9"] as const).map((a) => (
            <button
              key={a}
              onClick={() => set("aspect", a)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                s.aspect === a
                  ? "bg-purple-500/25 text-purple-200 border-purple-500/50"
                  : "bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-500"
              }`}
              data-testid={`aspect-${a}-${clip.id}`}
            >
              {a} {a === "9:16" ? "vertical" : "wide"}
            </button>
          ))}
        </div>
      </section>

      {/* ── Captions ── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Type className="w-3.5 h-3.5 text-purple-400" />
          <h4 className="text-xs font-semibold text-gray-200">Captions</h4>
          <button
            onClick={() => set("captionsEnabled", !s.captionsEnabled)}
            className={`ml-auto px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
              s.captionsEnabled
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                : "bg-gray-800 text-gray-400 border-gray-700"
            }`}
            data-testid={`captions-toggle-${clip.id}`}
          >
            {s.captionsEnabled ? "On" : "Off"}
          </button>
        </div>

        {s.captionsEnabled && (
          <>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(STYLE_LABELS) as Array<ClipEditSettings["captionStyle"]>).map((k) => (
                <button
                  key={k}
                  onClick={() => set("captionStyle", k)}
                  title={STYLE_LABELS[k].hint}
                  className={`px-2 py-1.5 rounded-md text-[11px] border text-left transition-colors ${
                    s.captionStyle === k
                      ? "bg-purple-500/20 text-purple-200 border-purple-500/50"
                      : "bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-500"
                  }`}
                  data-testid={`caption-style-${k}-${clip.id}`}
                >
                  {STYLE_LABELS[k].name}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-500">{STYLE_LABELS[s.captionStyle].hint}</p>

            <div className="grid grid-cols-2 gap-3">
              <Row label="Size" value={`${Math.round(s.sizeScale * 100)}%`}>
                <input
                  type="range" min={0.5} max={2} step={0.05}
                  value={s.sizeScale}
                  onChange={(e) => set("sizeScale", Number(e.target.value))}
                  className="w-full accent-purple-500"
                />
              </Row>
              <Row label="Height from bottom" value={`${Math.round(s.positionRatio * 100)}%`}>
                <input
                  type="range" min={0.02} max={0.45} step={0.01}
                  value={s.positionRatio}
                  onChange={(e) => set("positionRatio", Number(e.target.value))}
                  className="w-full accent-purple-500"
                />
              </Row>
              <Row label="Words per line" value={String(s.wordsPerPhrase)}>
                <input
                  type="range" min={1} max={12} step={1}
                  value={s.wordsPerPhrase}
                  onChange={(e) => set("wordsPerPhrase", Number(e.target.value))}
                  className="w-full accent-purple-500"
                />
              </Row>
              <Row label="Outline" value={String(s.outline)}>
                <input
                  type="range" min={0} max={8} step={1}
                  value={s.outline}
                  onChange={(e) => set("outline", Number(e.target.value))}
                  className="w-full accent-purple-500"
                />
              </Row>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] text-gray-400">Highlight colour</label>
              <div className="flex gap-1.5">
                {ACCENTS.map((hex) => (
                  <button
                    key={hex}
                    onClick={() => set("accentHex", hex)}
                    aria-label={`Accent ${hex}`}
                    className={`w-6 h-6 rounded-full border-2 transition-transform ${
                      s.accentHex.toLowerCase() === hex.toLowerCase()
                        ? "border-white scale-110"
                        : "border-transparent hover:scale-105"
                    }`}
                    style={{ backgroundColor: hex }}
                    data-testid={`accent-${hex.slice(1)}-${clip.id}`}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── Pace: silence removal + speed ramps ── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Gauge className="w-3.5 h-3.5 text-purple-400" />
          <h4 className="text-xs font-semibold text-gray-200">Pace</h4>
          <button
            onClick={() => setEdits({
              silenceCut: s.edits.silenceCut?.enabled
                ? null
                : { enabled: true, thresholdDb: -35, minDurationSec: 0.6, paddingSec: 0.15 },
            })}
            className={`ml-auto px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
              s.edits.silenceCut?.enabled
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                : "bg-gray-800 text-gray-400 border-gray-700"
            }`}
            data-testid={`silence-toggle-${clip.id}`}
          >
            Silence removal {s.edits.silenceCut?.enabled ? "on" : "off"}
          </button>
        </div>

        {s.edits.silenceCut?.enabled && (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-3">
              <Row label="Threshold" value={`${s.edits.silenceCut.thresholdDb}dB`}>
                <input type="range" min={-50} max={-20} step={1} value={s.edits.silenceCut.thresholdDb}
                  onChange={(e) => setEdits({ silenceCut: { ...s.edits.silenceCut!, thresholdDb: Number(e.target.value) } })}
                  className="w-full accent-purple-500" />
              </Row>
              <Row label="Min gap" value={`${s.edits.silenceCut.minDurationSec.toFixed(1)}s`}>
                <input type="range" min={0.2} max={2} step={0.1} value={s.edits.silenceCut.minDurationSec}
                  onChange={(e) => setEdits({ silenceCut: { ...s.edits.silenceCut!, minDurationSec: Number(e.target.value) } })}
                  className="w-full accent-purple-500" />
              </Row>
              <Row label="Breathing room" value={`${s.edits.silenceCut.paddingSec.toFixed(2)}s`}>
                <input type="range" min={0} max={0.5} step={0.05} value={s.edits.silenceCut.paddingSec}
                  onChange={(e) => setEdits({ silenceCut: { ...s.edits.silenceCut!, paddingSec: Number(e.target.value) } })}
                  className="w-full accent-purple-500" />
              </Row>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={analyzeSilenceNow} disabled={analyzing}
                className="text-xs border-gray-700" data-testid={`analyze-silence-${clip.id}`}>
                {analyzing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <AudioLines className="w-3 h-3 mr-1" />}
                {silenceResult ? "Re-analyze" : "Find the dead air"}
              </Button>
              {silenceResult && (
                <span className="text-[11px] text-gray-400">
                  {silenceResult.spans} gap{silenceResult.spans === 1 ? "" : "s"} · {silenceResult.totalSilentSec.toFixed(1)}s removable
                </span>
              )}
              {!silenceResult && (
                <span className="text-[11px] text-amber-300/80">Analyze first — the render only cuts measured gaps.</span>
              )}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[11px] text-gray-400">Speed ramps</label>
            <Button size="sm" variant="ghost" className="text-[11px] text-purple-300 h-6 px-2"
              onClick={() => setEdits({
                speedRamps: [...(s.edits.speedRamps ?? []), { start: 0, end: Math.min(5, newDuration), rate: 1.5 }],
              })}
              data-testid={`add-ramp-${clip.id}`}>
              <Plus className="w-3 h-3 mr-0.5" /> Add
            </Button>
          </div>
          {(s.edits.speedRamps ?? []).map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
              <Row label="From" value={`${r.start.toFixed(1)}s`}>
                <input type="range" min={0} max={newDuration} step={0.1} value={r.start}
                  onChange={(e) => {
                    const ramps = [...s.edits.speedRamps!];
                    ramps[i] = { ...r, start: Math.min(Number(e.target.value), r.end - 0.2) };
                    setEdits({ speedRamps: ramps });
                  }} className="w-full accent-purple-500" />
              </Row>
              <Row label="To" value={`${r.end.toFixed(1)}s`}>
                <input type="range" min={0} max={newDuration} step={0.1} value={r.end}
                  onChange={(e) => {
                    const ramps = [...s.edits.speedRamps!];
                    ramps[i] = { ...r, end: Math.max(Number(e.target.value), r.start + 0.2) };
                    setEdits({ speedRamps: ramps });
                  }} className="w-full accent-purple-500" />
              </Row>
              <Row label="Speed" value={`${r.rate.toFixed(2)}x`}>
                <input type="range" min={0.25} max={4} step={0.05} value={r.rate}
                  onChange={(e) => {
                    const ramps = [...s.edits.speedRamps!];
                    ramps[i] = { ...r, rate: Number(e.target.value) };
                    setEdits({ speedRamps: ramps });
                  }} className="w-full accent-purple-500" />
              </Row>
              <button onClick={() => setEdits({ speedRamps: s.edits.speedRamps!.filter((_, j) => j !== i) })}
                className="text-gray-500 hover:text-red-400 pb-1" aria-label="Remove ramp">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <p className="text-[10px] text-gray-600">
            Times are in the finished clip. Audio keeps pitch; silence cuts and ramps stay in sync by design.
          </p>
        </div>
      </section>

      {/* ── Music bed + ducking ── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Music className="w-3.5 h-3.5 text-purple-400" />
          <h4 className="text-xs font-semibold text-gray-200">Music</h4>
          <AssetControl
            kind="music"
            assets={musicAssets?.assets ?? []}
            selectedId={s.edits.music?.assetId ?? null}
            onPick={(id) => setEdits({
              music: id == null ? null : {
                assetId: id,
                volume: s.edits.music?.volume ?? 0.2,
                ducking: s.edits.music?.ducking ?? true,
                duckAmountDb: s.edits.music?.duckAmountDb ?? 12,
                fadeInSec: s.edits.music?.fadeInSec ?? 1,
                fadeOutSec: s.edits.music?.fadeOutSec ?? 2,
              },
            })}
            onUpload={(f) => uploadAsset(f, "music")}
          />
        </div>
        {s.edits.music && (
          <div className="grid grid-cols-2 gap-3">
            <Row label="Bed volume" value={`${Math.round(s.edits.music.volume * 100)}%`}>
              <input type="range" min={0} max={1} step={0.05} value={s.edits.music.volume}
                onChange={(e) => setEdits({ music: { ...s.edits.music!, volume: Number(e.target.value) } })}
                className="w-full accent-purple-500" />
            </Row>
            <Row label={s.edits.music.ducking ? "Duck under speech" : "Ducking off"} value={`${s.edits.music.duckAmountDb}dB`}>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEdits({ music: { ...s.edits.music!, ducking: !s.edits.music!.ducking } })}
                  className={`px-2 py-0.5 rounded text-[10px] border shrink-0 ${
                    s.edits.music.ducking
                      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                      : "bg-gray-800 text-gray-400 border-gray-700"
                  }`}
                >
                  {s.edits.music.ducking ? "On" : "Off"}
                </button>
                <input type="range" min={6} max={24} step={1} value={s.edits.music.duckAmountDb}
                  disabled={!s.edits.music.ducking}
                  onChange={(e) => setEdits({ music: { ...s.edits.music!, duckAmountDb: Number(e.target.value) } })}
                  className="w-full accent-purple-500 disabled:opacity-40" />
              </div>
            </Row>
            <Row label="Fade in" value={`${s.edits.music.fadeInSec.toFixed(1)}s`}>
              <input type="range" min={0} max={5} step={0.5} value={s.edits.music.fadeInSec}
                onChange={(e) => setEdits({ music: { ...s.edits.music!, fadeInSec: Number(e.target.value) } })}
                className="w-full accent-purple-500" />
            </Row>
            <Row label="Fade out" value={`${s.edits.music.fadeOutSec.toFixed(1)}s`}>
              <input type="range" min={0} max={5} step={0.5} value={s.edits.music.fadeOutSec}
                onChange={(e) => setEdits({ music: { ...s.edits.music!, fadeOutSec: Number(e.target.value) } })}
                className="w-full accent-purple-500" />
            </Row>
          </div>
        )}
      </section>

      {/* ── B-roll ── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Film className="w-3.5 h-3.5 text-purple-400" />
          <h4 className="text-xs font-semibold text-gray-200">B-roll</h4>
          <AssetControl
            kind="broll_video"
            assets={brollAssets?.assets ?? []}
            selectedId={null}
            pickLabel="Add cut"
            onPick={(id) => {
              if (id == null) return;
              setEdits({
                broll: [...(s.edits.broll ?? []), {
                  assetId: id, start: 0, end: Math.min(3, newDuration),
                  fit: "cover", scale: 1, x: 1, y: 0, muted: true,
                }],
              });
            }}
            onUpload={(f) => uploadAsset(f, f.type.startsWith("image/") ? "broll_image" : "broll_video")}
          />
        </div>
        {(s.edits.broll ?? []).map((c, i) => {
          const asset = (brollAssets?.assets ?? []).find((a) => a.id === c.assetId);
          return (
            <div key={i} className="rounded border border-gray-700/60 p-2 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-gray-300 truncate flex-1">{asset?.name ?? `asset #${c.assetId}`}</span>
                <button
                  onClick={() => {
                    const cuts = [...s.edits.broll!];
                    cuts[i] = { ...c, scale: c.scale >= 1 ? 0.4 : 1 };
                    setEdits({ broll: cuts });
                  }}
                  className="px-2 py-0.5 rounded text-[10px] border bg-gray-800 text-gray-300 border-gray-700"
                >
                  {c.scale >= 1 ? "Full frame" : "Picture-in-picture"}
                </button>
                <button onClick={() => setEdits({ broll: s.edits.broll!.filter((_, j) => j !== i) })}
                  className="text-gray-500 hover:text-red-400" aria-label="Remove b-roll">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Row label="From" value={`${c.start.toFixed(1)}s`}>
                  <input type="range" min={0} max={newDuration} step={0.1} value={c.start}
                    onChange={(e) => {
                      const cuts = [...s.edits.broll!];
                      cuts[i] = { ...c, start: Math.min(Number(e.target.value), c.end - 0.3) };
                      setEdits({ broll: cuts });
                    }} className="w-full accent-purple-500" />
                </Row>
                <Row label="To" value={`${c.end.toFixed(1)}s`}>
                  <input type="range" min={0} max={newDuration} step={0.1} value={c.end}
                    onChange={(e) => {
                      const cuts = [...s.edits.broll!];
                      cuts[i] = { ...c, end: Math.max(Number(e.target.value), c.start + 0.3) };
                      setEdits({ broll: cuts });
                    }} className="w-full accent-purple-500" />
                </Row>
              </div>
            </div>
          );
        })}
      </section>

      {/* ── Text on video ── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Type className="w-3.5 h-3.5 text-purple-400" />
          <h4 className="text-xs font-semibold text-gray-200">Text on video</h4>
          <Button size="sm" variant="ghost" className="ml-auto text-[11px] text-purple-300 h-6 px-2"
            onClick={() => setEdits({
              textOverlays: [...(s.edits.textOverlays ?? []), {
                start: 0, end: Math.min(3, newDuration), text: "",
                x: 0.5, y: 0.12, size: 0.06,
                color: "#ffffff", background: null, weight: "bold", align: "center",
              }],
            })}
            data-testid={`add-text-${clip.id}`}>
            <Plus className="w-3 h-3 mr-0.5" /> Add
          </Button>
        </div>
        {(s.edits.textOverlays ?? []).map((t, i) => (
          <div key={i} className="rounded border border-gray-700/60 p-2 space-y-2">
            <div className="flex items-center gap-2">
              <input
                value={t.text}
                onChange={(e) => {
                  const list = [...s.edits.textOverlays!];
                  list[i] = { ...t, text: e.target.value.slice(0, 200) };
                  setEdits({ textOverlays: list });
                }}
                placeholder="Headline…"
                className="flex-1 h-8 px-2 rounded bg-gray-800 border border-gray-700 text-xs"
              />
              <select
                value={t.y <= 0.2 ? "top" : t.y >= 0.6 ? "lower" : "center"}
                onChange={(e) => {
                  const y = e.target.value === "top" ? 0.08 : e.target.value === "center" ? 0.45 : 0.72;
                  const list = [...s.edits.textOverlays!];
                  list[i] = { ...t, y };
                  setEdits({ textOverlays: list });
                }}
                className="h-8 px-1 rounded bg-gray-800 border border-gray-700 text-[11px] text-gray-300"
              >
                <option value="top">Top</option>
                <option value="center">Center</option>
                <option value="lower">Lower third</option>
              </select>
              <button
                onClick={() => {
                  const list = [...s.edits.textOverlays!];
                  list[i] = { ...t, background: t.background ? null : "#000000" };
                  setEdits({ textOverlays: list });
                }}
                className={`px-2 py-0.5 rounded text-[10px] border shrink-0 ${
                  t.background ? "bg-gray-700 text-white border-gray-500" : "bg-gray-800 text-gray-400 border-gray-700"
                }`}
                title="Background plate"
              >
                Plate
              </button>
              <button onClick={() => setEdits({ textOverlays: s.edits.textOverlays!.filter((_, j) => j !== i) })}
                className="text-gray-500 hover:text-red-400" aria-label="Remove text">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Row label="From" value={`${t.start.toFixed(1)}s`}>
                <input type="range" min={0} max={newDuration} step={0.1} value={t.start}
                  onChange={(e) => {
                    const list = [...s.edits.textOverlays!];
                    list[i] = { ...t, start: Math.min(Number(e.target.value), t.end - 0.3) };
                    setEdits({ textOverlays: list });
                  }} className="w-full accent-purple-500" />
              </Row>
              <Row label="To" value={`${t.end.toFixed(1)}s`}>
                <input type="range" min={0} max={newDuration} step={0.1} value={t.end}
                  onChange={(e) => {
                    const list = [...s.edits.textOverlays!];
                    list[i] = { ...t, end: Math.max(Number(e.target.value), t.start + 0.3) };
                    setEdits({ textOverlays: list });
                  }} className="w-full accent-purple-500" />
              </Row>
              <Row label="Size" value={`${Math.round(t.size * 100)}%`}>
                <input type="range" min={0.03} max={0.15} step={0.01} value={t.size}
                  onChange={(e) => {
                    const list = [...s.edits.textOverlays!];
                    list[i] = { ...t, size: Number(e.target.value) };
                    setEdits({ textOverlays: list });
                  }} className="w-full accent-purple-500" />
              </Row>
            </div>
          </div>
        ))}
      </section>

      {/* ── Stabilize ── */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Anchor className="w-3.5 h-3.5 text-purple-400" />
          <h4 className="text-xs font-semibold text-gray-200">Stabilize</h4>
          <button
            onClick={() => setEdits({
              stabilization: s.edits.stabilization?.enabled ? null : { enabled: true, strength: 5 },
            })}
            className={`ml-auto px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
              s.edits.stabilization?.enabled
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                : "bg-gray-800 text-gray-400 border-gray-700"
            }`}
            data-testid={`stabilize-toggle-${clip.id}`}
          >
            {s.edits.stabilization?.enabled ? "On" : "Off"}
          </button>
        </div>
        {s.edits.stabilization?.enabled && (
          <Row label="Strength" value={String(s.edits.stabilization.strength)}>
            <input type="range" min={1} max={10} step={1} value={s.edits.stabilization.strength}
              onChange={(e) => setEdits({ stabilization: { enabled: true, strength: Number(e.target.value) } })}
              className="w-full accent-purple-500" />
          </Row>
        )}
      </section>

      {/* What the last render could NOT do — a dropped effect must never be
          mistaken for an applied one. */}
      {(clip.renderWarnings?.length ?? 0) > 0 && (
        <div className="rounded border border-amber-500/25 bg-amber-500/5 p-2.5 space-y-1">
          {clip.renderWarnings!.map((w, i) => (
            <p key={i} className="text-[11px] text-amber-300/90 leading-snug flex gap-1.5">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />{w}
            </p>
          ))}
        </div>
      )}

      {hasBeats && (
        <p className="text-[11px] text-amber-300/80 leading-snug">
          This is an assembled narrative clip — pace, music, b-roll, text and stabilization
          apply to single-range clips. Re-trim it to one range to unlock them.
        </p>
      )}

      {/* ── Apply ── */}
      <div className="flex items-center gap-2 pt-1">
        <Button
          onClick={apply}
          disabled={busy || newDuration < 1}
          className="bg-purple-600 hover:bg-purple-500 text-white text-xs"
          data-testid={`apply-edit-${clip.id}`}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
          Re-render with these settings
        </Button>
        <Button onClick={reset} variant="ghost" size="sm" className="text-gray-400 text-xs">
          <RotateCcw className="w-3 h-3 mr-1" />
          Reset
        </Button>
        <Button onClick={onClose} variant="ghost" size="sm" className="text-gray-400 text-xs ml-auto">
          Close
        </Button>
      </div>
      <p className="text-[11px] text-gray-500 leading-snug">
        Re-rendering replaces this clip's output. Any brand placement already framed on it is
        re-composited with your saved positioning.
      </p>
    </div>
  );
}

/**
 * Asset picker + inline upload for one kind of media ingredient.
 * A select over the creator's own uploads plus an Upload button; the
 * upload posts multipart to /api/media-assets and refreshes the list.
 */
function AssetControl({
  kind,
  assets,
  selectedId,
  onPick,
  onUpload,
  pickLabel,
}: {
  kind: string;
  assets: MediaAssetRow[];
  selectedId: number | null;
  onPick: (id: number | null) => void;
  onUpload: (file: File) => Promise<MediaAssetRow>;
  pickLabel?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const accept = kind === "music" ? "audio/*" : "video/*,image/*";
  const inputId = `asset-upload-${kind}-${Math.abs(kind.length)}`;

  return (
    <div className="ml-auto flex items-center gap-1.5">
      <select
        value={selectedId ?? ""}
        onChange={(e) => onPick(e.target.value ? Number(e.target.value) : null)}
        className="h-7 px-1.5 rounded bg-gray-800 border border-gray-700 text-[11px] text-gray-300 max-w-[160px]"
        data-testid={`asset-pick-${kind}`}
      >
        <option value="">{pickLabel ?? (kind === "music" ? "No music" : "Choose…")}</option>
        {assets.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name.slice(0, 32)}{a.durationSec ? ` (${Math.round(Number(a.durationSec))}s)` : ""}
          </option>
        ))}
      </select>
      <label
        htmlFor={inputId}
        className="cursor-pointer flex items-center gap-1 px-2 h-7 rounded border border-gray-700 bg-gray-800 text-[11px] text-gray-300 hover:border-gray-500"
        title="Upload a new file"
      >
        {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
        {uploading ? "Uploading…" : "Upload"}
      </label>
      <input
        id={inputId}
        type="file"
        accept={accept}
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setUploading(true);
          try {
            const asset = await onUpload(file);
            onPick(asset.id);
          } catch (err: any) {
            alert(err?.message || "Upload failed");
          } finally {
            setUploading(false);
          }
        }}
      />
    </div>
  );
}
