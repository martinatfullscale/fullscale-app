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
import { Button } from "@/components/ui/button";
import { Scissors, Type, Loader2, RotateCcw, AlertTriangle } from "lucide-react";

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
  });
  const [busy, setBusy] = useState(false);

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
