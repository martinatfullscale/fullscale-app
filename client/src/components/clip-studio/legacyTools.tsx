/**
 * The tool panels the Story Clip Editor mounts — transcript, captions, stock
 * search, AI generation, upload and the webcam recorder.
 *
 * These were the bottom two-thirds of the old ClipStudio.tsx. The editor's
 * SHELL was rebuilt around a timeline (see ClipStudio.tsx and the components
 * beside this file); these panels were not, because there was nothing wrong
 * with them — stock search, the cutaway suggester, AI generation and the
 * upload path all work, and rewriting working machinery to move it is how you
 * break it. They are exported here and composed by the new shell.
 *
 * What DID change: the six panels are no longer mutually exclusive modes.
 * Transcript and Captions are document-level panels; Stock and Generate are
 * sources inside the media bin; Text, B-Roll, Audio and Motion became
 * properties of whatever is selected on the timeline (see Inspectors.tsx).
 * TextTool, AudioTool and MotionTool are kept here for reference and are no
 * longer mounted — the inspectors replaced them.
 */
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fetchWithTimeout } from "@/lib/queryClient";

/** Words that make a useless stock query. Kept short on purpose — the seed is
 *  a starting point the creator edits, not a search engine. */
const STOP_WORDS = new Set([
  "this", "that", "there", "these", "those", "with", "from", "have", "been",
  "were", "what", "when", "where", "which", "would", "could", "should", "about",
  "them", "they", "their", "your", "just", "like", "really", "going", "gonna",
  "know", "think", "thing", "things", "into", "than", "then", "very", "much",
]);


const UPLOAD_TIMEOUT_MS = 30 * 60_000; // files, not JSON — see AdminPlacements

import {
  X as XIcon, Play, Pause, Loader2, Type, Film, Music, Sparkles,
  Scissors, Undo2, Wand2, Search, Upload, Trash2, AlertTriangle, Gauge,
  Text as TextIcon, Plus, Camera,
} from "lucide-react";

import type { Word, Segment, WordCut, TextOverlayEdit, StudioEdits, AssetRow } from "./types";
import { fmtTime } from "./types";
export type { Word, Segment, WordCut, TextOverlayEdit, StudioEdits, AssetRow };


export function TranscriptTool(props: {
  loading: boolean;
  words: Word[];
  isCut: (w: Word) => boolean;
  onToggle: (w: Word) => void;
  correctionFor: (w: Word) => string | null;
  onEditWord: (w: Word, text: string) => void;
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
  const [fixMode, setFixMode] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

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
        <Button
          size="sm" variant="outline"
          onClick={() => { setFixMode((v) => !v); setEditingKey(null); }}
          className={`text-[11px] h-7 border-gray-700 ${fixMode ? "text-sky-300 border-sky-500/40" : ""}`}
          data-testid="fix-text-mode"
        >
          <Type className="w-3 h-3 mr-1" />
          {fixMode ? "Fixing text" : "Fix text"}
        </Button>
        {props.cutCount > 0 && (
          <Button size="sm" variant="ghost" onClick={props.onClearCuts} className="text-[11px] h-7 text-gray-400">
            <Undo2 className="w-3 h-3 mr-1" />
            Undo {props.cutCount}
          </Button>
        )}
      </div>

      <p className="text-[11px] text-gray-500 leading-snug">
        {fixMode
          ? "Click a word to correct how it's spelled in the caption — the audio is untouched. Useful for names and brand words."
          : "Click any word to cut it. Struck words are removed from the clip and the gap closes."}
      </p>

      <p className="text-[13px] leading-[1.9] select-none">
        {props.words.map((w, i) => {
          const cut = props.isCut(w);
          const active = i === props.activeIdx;
          const key = `${w.start}-${i}`;
          const correction = props.correctionFor(w);

          if (fixMode && editingKey === key) {
            return (
              <input
                key={key}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => { props.onEditWord(w, draft); setEditingKey(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { props.onEditWord(w, draft); setEditingKey(null); }
                  if (e.key === "Escape") setEditingKey(null);
                }}
                className="inline-block bg-gray-900 text-sky-200 text-[13px] rounded px-1 mx-0.5 border border-sky-500/60 focus:outline-none"
                style={{ width: `${Math.max(4, draft.length + 1)}ch` }}
              />
            );
          }

          return (
            <span
              key={key}
              ref={active ? props.activeRef : undefined}
              onClick={() => {
                if (fixMode) { setDraft(correction ?? w.word.trim()); setEditingKey(key); }
                else props.onToggle(w);
              }}
              onDoubleClick={() => props.onSeek(w.start)}
              title={fixMode
                ? `${w.start.toFixed(2)}s — click to correct the caption text`
                : `${w.start.toFixed(2)}s — click to ${cut ? "restore" : "cut"}, double-click to seek`}
              className={`cursor-pointer rounded px-0.5 transition-colors ${
                cut
                  ? "line-through text-gray-600 decoration-red-500/70"
                  : correction
                    ? "text-sky-200 underline decoration-sky-400/70 decoration-dotted"
                    : active
                      ? "bg-purple-500/40 text-white"
                      : "text-gray-200 hover:bg-gray-700/60"
              }`}
            >
              {correction ?? w.word}{" "}
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

export function CaptionsTool(props: {
  enabled: boolean;
  style: string;
  onToggle: () => void;
  onStyle: (s: string) => void;
  settings: Record<string, number | string>;
  onSettings: (patch: Record<string, number | string>) => void;
}) {
  const s = props.settings;
  const size = Number(s.sizeScale ?? 1);
  const pos = Number(s.positionRatio ?? 0.14);
  const accent = String(s.accentHex ?? "#FFE500");
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
        <div className="space-y-3">
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
          </div>

          {/* Size / position / colour — the renderer honors all three
              (sizeScale, positionRatio, accentHex); these are the writers. */}
          <div className="space-y-2.5 pt-1 border-t border-gray-700/60">
            <label className="block">
              <span className="flex justify-between text-[11px] text-gray-400 mb-1">
                <span>Size</span><span>{Math.round(size * 100)}%</span>
              </span>
              <input
                type="range" min={0.6} max={1.8} step={0.05} value={size}
                onChange={(e) => props.onSettings({ sizeScale: Number(e.target.value) })}
                className="w-full accent-purple-500"
                data-testid="caption-size"
              />
            </label>
            <label className="block">
              <span className="flex justify-between text-[11px] text-gray-400 mb-1">
                <span>Vertical position</span><span>{Math.round(pos * 100)}% up</span>
              </span>
              <input
                type="range" min={0.04} max={0.8} step={0.02} value={pos}
                onChange={(e) => props.onSettings({ positionRatio: Number(e.target.value) })}
                className="w-full accent-purple-500"
                data-testid="caption-position"
              />
            </label>
            <label className="flex items-center justify-between">
              <span className="text-[11px] text-gray-400">Highlight colour</span>
              <input
                type="color" value={accent}
                onChange={(e) => props.onSettings({ accentHex: e.target.value })}
                className="w-8 h-6 rounded border border-gray-700 bg-transparent cursor-pointer"
                data-testid="caption-accent"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Text / titles tool ──────────────────────────────────────────────────
//
// Writes edits.textOverlays, whose full render path already existed
// (EditStack.textOverlays → burned in after crop by buildEditGraph) with no UI
// to reach it. Shape matches the server's validator at
// /api/editorial-clips/:id/rerender exactly.

const TEXT_POSITIONS: Array<{ label: string; y: number }> = [
  { label: "Top", y: 0.12 },
  { label: "Middle", y: 0.5 },
  { label: "Lower", y: 0.82 },
];

export function TextTool(props: {
  overlays: TextOverlayEdit[];
  playhead: number;
  duration: number;
  onChange: (o: TextOverlayEdit[]) => void;
  onSeek: (sec: number) => void;
}) {
  const { overlays, onChange } = props;
  const patch = (i: number, p: Partial<TextOverlayEdit>) =>
    onChange(overlays.map((o, idx) => (idx === i ? { ...o, ...p } : o)));
  const add = () => {
    const start = Math.min(props.playhead, Math.max(0, props.duration - 1));
    onChange([
      ...overlays,
      {
        start,
        end: Math.min(props.duration, start + 3),
        text: "Your title",
        x: 0.5, y: 0.12, size: 0.07,
        color: "#ffffff", background: null,
        weight: "bold", align: "center",
      },
    ]);
  };

  return (
    <div className="space-y-3">
      <button
        onClick={add}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-dashed border-gray-600 text-[11px] text-gray-300 hover:border-gray-400"
        data-testid="add-text-overlay"
      >
        <Plus className="w-3 h-3" /> Add title / text
      </button>

      {overlays.length === 0 && (
        <p className="text-[11px] text-gray-600">
          On-screen titles, lower thirds, callouts. Each appears for the window you set and is burned into the render.
        </p>
      )}

      {overlays.map((o, i) => (
        <div key={i} className="rounded-lg border border-gray-700 bg-gray-800/50 p-2.5 space-y-2">
          <div className="flex items-start gap-2">
            <textarea
              value={o.text}
              onChange={(e) => patch(i, { text: e.target.value.slice(0, 200) })}
              rows={2}
              className="flex-1 bg-gray-900 text-white text-xs rounded p-2 border border-gray-700 focus:border-purple-500 focus:outline-none resize-none"
              placeholder="Text…"
            />
            <button
              onClick={() => onChange(overlays.filter((_, idx) => idx !== i))}
              className="text-gray-500 hover:text-red-400 p-1"
              title="Remove"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Timing */}
          <div className="flex items-center gap-2 text-[11px] text-gray-400">
            <button onClick={() => props.onSeek(o.start)} className="font-mono hover:text-white" title="Jump to start">
              {o.start.toFixed(1)}s
            </button>
            <span>→</span>
            <span className="font-mono">{o.end.toFixed(1)}s</span>
            <button
              onClick={() => patch(i, { start: Math.min(props.playhead, o.end - 0.3) })}
              className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-gray-700 hover:bg-gray-600"
              title="Set start to playhead"
            >
              Start here
            </button>
            <button
              onClick={() => patch(i, { end: Math.max(props.playhead, o.start + 0.3) })}
              className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 hover:bg-gray-600"
              title="Set end to playhead"
            >
              End here
            </button>
          </div>

          {/* Position */}
          <div className="flex gap-1">
            {TEXT_POSITIONS.map((p) => (
              <button
                key={p.label}
                onClick={() => patch(i, { y: p.y })}
                className={`flex-1 text-[10px] py-1 rounded border ${
                  Math.abs(o.y - p.y) < 0.02
                    ? "bg-purple-500/20 text-purple-200 border-purple-500/50"
                    : "bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-500"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Size / colour / plate / weight */}
          <div className="flex items-center gap-2">
            <input
              type="range" min={0.03} max={0.16} step={0.005} value={o.size}
              onChange={(e) => patch(i, { size: Number(e.target.value) })}
              className="flex-1 accent-purple-500" title="Size"
            />
            <input
              type="color" value={o.color}
              onChange={(e) => patch(i, { color: e.target.value })}
              className="w-7 h-6 rounded border border-gray-700 bg-transparent cursor-pointer" title="Text colour"
            />
            <button
              onClick={() => patch(i, { background: o.background ? null : "#000000" })}
              className={`text-[10px] px-1.5 py-1 rounded border ${
                o.background ? "bg-gray-700 text-white border-gray-600" : "bg-gray-800 text-gray-500 border-gray-700"
              }`}
              title="Background plate"
            >
              Plate
            </button>
            <button
              onClick={() => patch(i, { weight: o.weight === "bold" ? "regular" : "bold" })}
              className={`text-[10px] px-1.5 py-1 rounded border font-bold ${
                o.weight === "bold" ? "bg-gray-700 text-white border-gray-600" : "bg-gray-800 text-gray-500 border-gray-700"
              }`}
              title="Bold"
            >
              B
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Shared asset picker (b-roll + music) ────────────────────────────────

export function useAssets(kinds: string[]) {
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

export function UploadButton({ kind, accept, onDone, label }: { kind: string; accept: string; onDone: (a: AssetRow) => void; label: string }) {
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

export function BrollTool(props: {
  cuts: NonNullable<StudioEdits["broll"]>;
  duration: number;
  playhead: number;
  clipId: number;
  /** What's being said at the playhead — the seed for a generated cutaway. */
  spokenAtPlayhead: string;
  /** The clip's words, so cutaways can be proposed against what is actually said. */
  lines: Array<{ start: number; end: number; text: string }>;
  onSeek: (sec: number) => void;
  onChange: (b: NonNullable<StudioEdits["broll"]>) => void;
  queryClient: ReturnType<typeof useQueryClient>;
  /**
   * Which source this panel opens on, and whether it draws its own tab strip.
   *
   * Mounted inside the media bin these are set: the bin's filter chips ARE
   * the tab strip, so a second one inside the panel is two controls competing
   * over the same state, and picking "AI" in the bin would otherwise land on
   * this component's own default of "stock".
   */
  initialTab?: "mine" | "stock" | "ai";
  hideTabs?: boolean;
}) {
  const { data } = useAssets(["broll_video", "broll_image"]);
  const assets = data?.assets ?? [];
  const [filter, setFilter] = useState("");
  const shown = assets.filter((a) => a.name.toLowerCase().includes(filter.toLowerCase()));

  // ── Stock search ──────────────────────────────────────────────────
  // Uploading your own b-roll is the wrong default: the point of a b-roll cut
  // is generic filler over a talking head, and nobody wants to go shoot
  // "person typing at a desk".
  const [rawTab, setRawTab] = useState<"mine" | "stock" | "ai">(props.initialTab ?? "stock");
  /**
   * When the bin owns the source chips, this panel's own tab is pinned.
   *
   * importStock and the AI onGenerated both call setTab("mine") to show the
   * new file — sensible when the tab strip is visible, and a trap when it is
   * not: the search results vanished and the strip that could bring them back
   * was display:none, so there was no way out but closing the editor.
   */
  const tab = props.hideTabs ? (props.initialTab ?? "stock") : rawTab;
  const setTab = props.hideTabs ? () => {} : setRawTab;
  const [q, setQ] = useState("");
  const [stock, setStock] = useState<any[]>([]);
  // Is stock search even switched on here? Without this the panel can only
  // fail AFTER a search, and a provider that was never configured is
  // indistinguishable from a query with no results.
  const { data: stockStatus } = useQuery<{ available: boolean; detail: string; providers: any[] }>({
    queryKey: ["/api/media-assets/stock/status"],
    queryFn: async () => (await fetchWithTimeout("/api/media-assets/stock/status", { credentials: "include" })).json(),
    staleTime: 5 * 60_000,
  });

  const [searching, setSearching] = useState(false);
  const [stockErr, setStockErr] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  // Seed from the transcript at the playhead the first time the tab opens.
  // A Search button greyed out because the box is empty reads as broken —
  // "the stock button is not depressable" — and the words on screen are a
  // better starting query than a blank box anyway.
  const seeded = useRef(false);
  useEffect(() => {
    if (tab !== "stock" || seeded.current || q.trim()) return;
    seeded.current = true;
    const words = (props.spokenAtPlayhead || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
      .slice(0, 3);
    if (words.length) setQ(words.join(" "));
  }, [tab, props.spokenAtPlayhead, q]);

  const runSearch = () => runSearchWith(q);

  /** Search an explicit term, so an accepted suggestion can drive it without
   *  waiting a render for the input's state to settle. */
  const runSearchWith = async (term: string) => {
    const query = (term ?? "").trim();
    if (!query) {
      setStockErr("Type what you want to see — a place, an object, an action. Try \"city street\" or \"coffee pour\".");
      return;
    }
    setSearching(true);
    setStockErr(null);
    try {
      const res = await fetchWithTimeout(
        `/api/media-assets/stock/search?q=${encodeURIComponent(query)}`,
        { credentials: "include" },
      );
      const body = await res.json();
      if (!res.ok) { setStockErr(body.error || "Search failed"); setStock([]); return; }
      setStock(body.videos ?? []);
      if ((body.videos ?? []).length === 0) setStockErr(`Nothing found for "${query}".`);
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
      // Land it where the suggestion said, if one is driving this search.
      addAt(body.asset.id, pendingWindow ?? undefined);
      setPendingWindow(null);
      setTab("mine");
    } catch (err: any) {
      alert(err?.message || "Import failed");
    } finally {
      setImporting(null);
    }
  };

  // ── Suggested cutaways ────────────────────────────────────────────
  // The seam this editor was missing. Stock search and generation both start
  // from a blank box, which means the creator has to watch their own clip,
  // decide a visual belongs at 0:14, and invent the search terms. This reads
  // the transcript and proposes the moments WITH the query and the prompt
  // already written, each anchored to the seconds it covers.
  const [sugs, setSugs] = useState<any[] | null>(null);
  const [sugBusy, setSugBusy] = useState(false);
  const [sugNote, setSugNote] = useState<string | null>(null);

  const runSuggest = async () => {
    setSugBusy(true);
    setSugNote(null);
    try {
      const res = await fetchWithTimeout("/api/ai/suggest-cutaways", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ lines: props.lines }),
      }, 90_000);
      const body = await res.json();
      if (!res.ok) { setSugNote(body.error || "Could not read the clip."); return; }
      setSugs(body.suggestions ?? []);
      setSugNote(body.detail ?? null);
      // Say plainly when a downstream tool is off, rather than letting the
      // creator click Find/Generate into an error.
      const off: string[] = [];
      if (!body.stockLive) off.push("stock search");
      if (!body.aiLive) off.push("AI generation");
      if (off.length) {
        setSugNote((n) => [n, `Not configured on this server: ${off.join(" and ")}.`].filter(Boolean).join(" "));
      }
    } catch (err: any) {
      // A fetch that dies at the network layer surfaces as Safari's bare
      // "Load failed" / Chrome's "Failed to fetch" — seen in the wild when
      // the server was busy with a render. Name the likely cause and the
      // remedy instead of parroting the browser's shrug; the button already
      // reads "Again", so retrying is one press.
      const transportDeath = /load failed|failed to fetch|networkerror/i.test(String(err?.message ?? ""));
      setSugNote(
        transportDeath
          ? "The server dropped the connection — it may be busy rendering a clip. Press Again in a moment."
          : (err?.message || "Could not read the clip."),
      );
    } finally {
      setSugBusy(false);
    }
  };

  /** Take a suggestion into whichever tool it prefers, pre-filled. */
  const useSuggestion = (sg: any) => {
    props.onSeek(sg.tStart);
    if (sg.prefer === "ai") {
      setTab("ai");
      setPendingWindow({ start: sg.tStart, end: sg.tEnd });
      setPrefillPrompt(sg.aiPrompt);
    } else {
      setTab("stock");
      setQ(sg.stockQuery);
      setPendingWindow({ start: sg.tStart, end: sg.tEnd });
      setTimeout(() => runSearchWith(sg.stockQuery), 0);
    }
  };

  // Where an accepted suggestion should land, remembered across the search so
  // importing a result drops it at the proposed moment rather than wherever
  // the playhead happens to be.
  const [pendingWindow, setPendingWindow] = useState<{ start: number; end: number } | null>(null);
  const [prefillPrompt, setPrefillPrompt] = useState<string>("");

  const addAt = (assetId: number, at?: { start: number; end: number }) => {
    // The server keeps the first 8 cuts and drops the rest without a word, so
    // refuse the 9th here instead of letting it render in the preview, survive
    // a save, and then be missing from the export.
    if (props.cuts.length >= 8) {
      alert("A clip holds up to 8 cutaways. Remove one on the timeline to add another.");
      return;
    }
    const start = at
      ? Math.max(0, Math.min(at.start, Math.max(0, props.duration - 1)))
      : Math.min(props.playhead, Math.max(0, props.duration - 3));
    if (at) {
      props.onChange([
        ...props.cuts,
        { assetId, start, end: Math.min(props.duration, Math.max(start + 1, at.end)),
          fit: "cover", scale: 1, x: 1, y: 0, muted: true, motion: "push" },
      ]);
      return;
    }
    props.onChange([
      ...props.cuts,
      // Full frame by default — a cutaway takes over the shot. PiP is the
      // deliberate exception, not the norm.
      { assetId, start, end: Math.min(props.duration, start + 3), fit: "cover", scale: 1, x: 1, y: 0, muted: true, motion: "push" },
    ]);
  };

  return (
    <div className="space-y-3">
      {/* Review first, then suggest — the flow the editor was missing. */}
      <div className="rounded border border-purple-500/25 bg-purple-500/[0.06] p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-purple-200">Suggested cutaways</p>
            <p className="text-[10px] text-gray-500 leading-snug">
              Reads what's said and picks the moments a visual helps.
            </p>
          </div>
          <Button
            size="sm" onClick={runSuggest} disabled={sugBusy || props.lines.length === 0}
            className="h-7 text-[11px] bg-purple-600 hover:bg-purple-500 shrink-0"
            data-testid="suggest-cutaways"
          >
            {sugBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : sugs ? "Again" : "Suggest"}
          </Button>
        </div>

        {sugNote && <p className="text-[10px] text-amber-300/90 mt-1.5 leading-snug">{sugNote}</p>}

        {sugs && sugs.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {sugs.map((sg, i) => (
              <div key={i} className="rounded bg-black/30 border border-white/5 p-1.5" data-testid={`suggestion-${i}`}>
                <div className="flex items-start gap-2">
                  <button
                    onClick={() => props.onSeek(sg.tStart)}
                    className="text-[10px] font-mono text-purple-300 hover:text-purple-200 shrink-0 pt-0.5"
                    title="Jump here"
                  >
                    {Math.floor(sg.tStart / 60)}:{String(Math.floor(sg.tStart % 60)).padStart(2, "0")}
                  </button>
                  <div className="min-w-0 flex-1">
                    {sg.quote && <p className="text-[10px] text-gray-400 italic truncate">"{sg.quote}"</p>}
                    <p className="text-[10px] text-gray-500 leading-snug">{sg.why}</p>
                  </div>
                  <Button
                    size="sm" variant="outline"
                    onClick={() => useSuggestion(sg)}
                    className="h-6 text-[10px] px-2 shrink-0"
                    data-testid={`use-suggestion-${i}`}
                  >
                    {sg.prefer === "ai" ? "Generate" : "Find"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={props.hideTabs ? "hidden" : "flex gap-1 p-0.5 rounded bg-gray-800"}>
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
          prefillPrompt={prefillPrompt}
          onGenerated={(assetId) => {
            props.queryClient.invalidateQueries({ queryKey: ["/api/media-assets"] });
            // Land it at the suggested moment when a suggestion drove this.
            addAt(assetId, pendingWindow ?? undefined);
            setPendingWindow(null);
            setPrefillPrompt("");
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
            <Button
              type="submit" size="sm"
              // Only ever disabled while a search is genuinely in flight. An
              // empty box is not an error state — clicking with nothing typed
              // now explains itself rather than presenting a dead control.
              disabled={searching}
              className="h-8 text-[11px] bg-purple-600 hover:bg-purple-500"
              data-testid="stock-search"
            >
              {searching ? <Loader2 className="w-3 h-3 animate-spin" /> : "Search"}
            </Button>
          </form>

          {stockStatus && !stockStatus.available && (
            <div className="rounded border border-amber-500/25 bg-amber-500/5 p-2">
              <p className="text-[11px] text-amber-300/90 leading-snug">
                Stock search isn't configured on this server. {stockStatus.detail}
              </p>
            </div>
          )}

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

export function AudioTool(props: {
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

export function MotionTool(props: {
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
export function AiGenerateTool(props: {
  /** Pre-written prompt from an accepted cutaway suggestion. */
  prefillPrompt?: string;
  playhead: number;
  spokenAtPlayhead: string;
  clipId: number;
  onGenerated: (assetId: number) => void;
}) {
  const [prompt, setPrompt] = useState("");

  // A suggestion arrives with its prompt already written. Only overwrite what
  // the creator has not started editing — clobbering their typing would be
  // worse than not prefilling at all.
  const lastPrefill = useRef<string>("");
  useEffect(() => {
    const incoming = props.prefillPrompt ?? "";
    if (incoming && incoming !== lastPrefill.current) {
      lastPrefill.current = incoming;
      setPrompt(incoming);
    }
  }, [props.prefillPrompt]);
  const [modelId, setModelId] = useState("image-fast");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);
  // Video animates a still the creator already approved, so it needs one
  // selected. Their own generated images are the natural candidates.
  const [seedAssetId, setSeedAssetId] = useState<number | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const { data: ownAssets } = useAssets(["broll_image"]);

  const { data: opts, refetch, isError: optsError, isFetching: optsFetching } = useQuery<{
    available: boolean; detail: string | null; balance: number;
    allowance: { freeImagesPerDay: number; freeImagesUsedToday: number; freeImagesLeft: number; balance: number };
    models: Array<{
      id: string; kind: string; label: string;
      credits: number; listCredits: number; free: boolean; priceReason: string;
      typicalSeconds: number; outputSeconds: number | null; seedsFromImage: boolean; notes: string;
    }>;
  }>({
    queryKey: ["/api/ai/generation/options"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/ai/generation/options", { credentials: "include" });
      if (!res.ok) throw new Error(`options ${res.status}`);
      return res.json();
    },
    // The app-wide default is retry: false, which here meant ONE dropped
    // fetch (server busy rendering) left this panel with no models, no
    // allowance, and a Generate button disabled forever with no explanation
    // — reported as "the free images aren't pressable". Retry, and when
    // that still fails, render a Retry button instead of a dead panel.
    retry: 2,
    retryDelay: (attempt) => 1500 * (attempt + 1),
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

  // The options request failed outright (not "generation is off" — we never
  // heard). Without this branch the panel rendered with zero model buttons
  // and a permanently disabled Generate: nothing to press and nothing saying
  // why. Failure gets a face and a Retry.
  if (!opts && optsError) {
    return (
      <div className="text-center py-8 px-2">
        <Sparkles className="w-8 h-8 text-gray-700 mx-auto mb-2" />
        <p className="text-xs text-gray-400 mb-1">Couldn't load the generation options</p>
        <p className="text-[11px] text-gray-600 leading-snug mb-3">
          The server didn't answer — it may be busy rendering. Your free images are still there.
        </p>
        <Button
          size="sm"
          onClick={() => refetch()}
          disabled={optsFetching}
          className="h-7 text-[11px] bg-purple-600 hover:bg-purple-500"
          data-testid="gen-options-retry"
        >
          {optsFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : "Retry"}
        </Button>
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
