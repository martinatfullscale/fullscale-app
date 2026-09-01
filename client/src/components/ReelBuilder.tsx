import { useState, useEffect, useCallback, useRef } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Loader2, Film, Plus, ChevronLeft, ChevronRight, Trash2, Sparkles, CheckCircle, AlertCircle, Scissors,
  Upload, Video, Circle, Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

/**
 * Reel Builder — assemble one reel from clips across the creator's videos on a
 * horizontal TIMELINE: blocks are dragged to reorder and their edges dragged to
 * trim. The backend (POST /api/remix/reel) cuts each block from its own source
 * video and crossfades them together. Clips can be hand-picked (left) or found
 * by AI across the whole library (prompt-driven). This timeline is the surface
 * that upload, webcam capture, and AI generation will drop into next.
 */

interface ReelClip {
  clipId: number;
  clipSource: "remix" | "editorial";
  videoId: number;
  videoTitle: string;
  title: string | null;
  clipStart: number;
  clipEnd: number;
  duration: number;
  thumbnailPath: string | null;
  hasSegments: boolean;
}

/**
 * One block on the timeline. Unified across a picked clip and an AI-found
 * moment: both carry a source video and an available [boundStart, boundEnd]
 * range, with [trimStart, trimEnd] the current in/out the creator has trimmed
 * to. An untrimmed clip publishes by id (so an assembled clip keeps its beats);
 * anything trimmed publishes as a raw {videoId,start,end} range.
 */
interface ReelItem {
  id: string;
  source: "clip" | "moment" | "asset"; // asset = uploaded file or webcam recording
  clipId?: number;
  clipSource?: "remix" | "editorial";
  assetId?: number;
  videoId: number; // 0 for asset items (no library video behind them)
  videoTitle: string;
  label: string;
  thumbnailPath?: string | null;
  boundStart: number;
  boundEnd: number;
  trimStart: number;
  trimEnd: number;
  isAssembled?: boolean;
  isImage?: boolean; // AI-generated (or uploaded) still, held for its duration
}

/** Distinct-source key so an asset and a video don't collide in counts. */
const srcKey = (it: ReelItem) => (it.source === "asset" ? `a:${it.assetId}` : `v:${it.videoId}`);

const PLATFORMS = [
  { id: "tiktok", label: "TikTok" },
  { id: "youtube_shorts", label: "YouTube" },
  { id: "instagram_reels", label: "Instagram" },
];

// Timeline scale. Blocks are width ∝ duration, floored so short clips stay grabbable.
const PX_PER_SEC = 8;
const MIN_BLOCK_W = 64;
const MIN_DUR = 1;

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};
const clipKey = (c: { clipSource: string; clipId: number }) => `${c.clipSource}:${c.clipId}`;
const dur = (it: ReelItem) => it.trimEnd - it.trimStart;
const isTrimmed = (it: ReelItem) => it.trimStart !== it.boundStart || it.trimEnd !== it.boundEnd;

let __rid = 0;
const newId = () => `it${++__rid}`;

export default function ReelBuilder({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [clips, setClips] = useState<ReelClip[]>([]);
  const [order, setOrder] = useState<ReelItem[]>([]);
  const [platform, setPlatform] = useState("tiktok");
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [title, setTitle] = useState("");
  const [building, setBuilding] = useState(false);
  const [finding, setFinding] = useState(false);
  const [storyPrompt, setStoryPrompt] = useState("");
  const [narrativeArc, setNarrativeArc] = useState<string | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [result, setResult] = useState<{ status: "building" | "completed" | "failed"; thumbnailPath?: string | null; error?: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const selected = new Set(
    order.filter((i) => i.source === "clip").map((i) => `${i.clipSource}:${i.clipId}`),
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout("/api/remix/reel/clips", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      setClips(res.ok ? (data.clips ?? []) : []);
    } catch {
      setClips([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) {
      load();
      setOrder([]); setResult(null); setTitle(""); setNarrativeArc(null);
      setBuilding(false); setFinding(false); setStoryPrompt("");
      setUploading(false); setRecorderOpen(false);
      setAiOpen(false); setAiPrompt(""); setAiGenerating(false);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [open, load]);

  const clipToItem = (c: ReelClip): ReelItem => ({
    id: newId(), source: "clip", clipId: c.clipId, clipSource: c.clipSource,
    videoId: c.videoId, videoTitle: c.videoTitle, label: c.title || `${c.videoTitle} clip`,
    thumbnailPath: c.thumbnailPath, boundStart: c.clipStart, boundEnd: c.clipEnd,
    trimStart: c.clipStart, trimEnd: c.clipEnd, isAssembled: c.hasSegments,
  });

  const toggleClip = (c: ReelClip) => setOrder((o) => {
    const k = `${c.clipSource}:${c.clipId}`;
    return o.some((x) => x.source === "clip" && `${x.clipSource}:${x.clipId}` === k)
      ? o.filter((x) => !(x.source === "clip" && `${x.clipSource}:${x.clipId}` === k))
      : [...o, clipToItem(c)];
  });
  const removeAt = (i: number) => setOrder((o) => o.filter((_, idx) => idx !== i));
  const nudge = (i: number, dir: -1 | 1) => setOrder((o) => {
    const j = i + dir;
    if (j < 0 || j >= o.length) return o;
    const next = [...o];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const reorder = (from: number, to: number) => setOrder((o) => {
    if (from === to || from < 0 || to < 0 || from >= o.length || to >= o.length) return o;
    const next = [...o];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  });

  // Trim by dragging a block edge. Window listeners so the drag continues even
  // when the pointer leaves the narrow handle. Clamped to the block's available
  // source range and a 1s minimum.
  const beginTrim = (e: React.PointerEvent, index: number, edge: "left" | "right") => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const it = order[index];
    const s0 = it.trimStart, e0 = it.trimEnd;
    const onMove = (ev: PointerEvent) => {
      const dSec = (ev.clientX - startX) / PX_PER_SEC;
      setOrder((o) => o.map((x, idx) => {
        if (idx !== index) return x;
        if (edge === "left") {
          return { ...x, trimStart: Math.min(Math.max(x.boundStart, s0 + dSec), x.trimEnd - MIN_DUR) };
        }
        return { ...x, trimEnd: Math.max(Math.min(x.boundEnd, e0 + dSec), x.trimStart + MIN_DUR) };
      }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const findStory = async () => {
    setFinding(true);
    try {
      const res = await fetchWithTimeout("/api/remix/library-thread", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ query: storyPrompt.trim() || undefined }),
      }, 120_000);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't analyze your library");
      const moments: ReelItem[] = (data.segments ?? []).map((s: any) => ({
        id: newId(), source: "moment" as const,
        videoId: s.videoId, videoTitle: s.videoTitle, label: s.reason || `${s.videoTitle} moment`,
        boundStart: s.start, boundEnd: s.end, trimStart: s.start, trimEnd: s.end,
      }));
      if (moments.length < 2) throw new Error("The analysis didn't find a strong cross-video thread.");
      setOrder(moments);
      setNarrativeArc(data.narrativeArc || null);
      if (data.suggestedTitle && !title) setTitle(data.suggestedTitle);
      toast({ title: "Found a story", description: `${moments.length} moments across your videos — trim and reorder, then build.` });
    } catch (err: any) {
      toast({ title: "Couldn't find a story", description: err.message, variant: "destructive" });
    }
    setFinding(false);
  };

  // Upload a video file (chosen file or a webcam recording) as a media asset,
  // then drop it onto the timeline as an "asset" block.
  const uploadClip = async (file: File, label: string) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetchWithTimeout("/api/media-assets?kind=broll_video", {
        method: "POST", credentials: "include", body: form,
      }, 5 * 60_000);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.asset) throw new Error(data.error || "Upload failed");
      const a = data.asset;
      const d = Number(a.durationSec) || 0;
      const end = d > 0 ? d : 5;
      setOrder((o) => [...o, {
        id: newId(), source: "asset", assetId: a.id, videoId: 0,
        videoTitle: label, label: a.name || label, thumbnailPath: a.thumbnailPath ?? null,
        boundStart: 0, boundEnd: end, trimStart: 0, trimEnd: end,
      }]);
      toast({ title: `Added ${label.toLowerCase()}`, description: a.name || "" });
    } catch (err: any) {
      toast({ title: "Couldn't add clip", description: err.message, variant: "destructive" });
    }
    setUploading(false);
  };

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (f) uploadClip(f, "Upload");
  };

  // Generate an AI image from a prompt and drop it on the timeline as a still
  // held for a few seconds (with a slow zoom at render). Images are the fast,
  // inline, default generation; animating a still into video is the next step.
  const generateAi = async () => {
    const p = aiPrompt.trim();
    if (p.length < 3) return;
    setAiGenerating(true);
    try {
      const res = await fetchWithTimeout("/api/ai/generation", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ modelId: "image-fast", prompt: p, aspectRatio: "9:16" }),
      }, 60_000);
      const data = await res.json().catch(() => ({}));
      if (res.status === 402 || data.needsCredits) {
        toast({ title: "Out of AI credits", description: data.error || "Today's free images are used. Add credits to keep generating.", variant: "destructive" });
        return;
      }
      if (!res.ok || !data.assetId) throw new Error(data.error || "Generation failed");
      setOrder((o) => [...o, {
        id: newId(), source: "asset", assetId: data.assetId, videoId: 0, isImage: true,
        videoTitle: "AI", label: p.slice(0, 60), thumbnailPath: data.url ?? null,
        boundStart: 0, boundEnd: 30, trimStart: 0, trimEnd: 4,
      }]);
      setAiPrompt("");
      toast({ title: "AI image added", description: "Held 4s on the timeline — drag its right edge to hold it longer." });
    } catch (err: any) {
      toast({ title: "Couldn't generate", description: err.message, variant: "destructive" });
    }
    setAiGenerating(false);
  };

  const totalDuration = order.reduce((s, it) => s + dur(it), 0);
  const sourceCount = new Set(order.map(srcKey)).size;

  const build = async () => {
    if (order.length < 2) return;
    setBuilding(true);
    setResult({ status: "building" });
    try {
      const res = await fetchWithTimeout("/api/remix/reel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          items: order.map((it) =>
            it.source === "asset"
              ? { assetId: it.assetId, start: it.trimStart, end: it.trimEnd, label: it.label }
              : it.source === "clip" && !isTrimmed(it)
                ? { clipId: it.clipId, clipSource: it.clipSource }
                : { videoId: it.videoId, start: it.trimStart, end: it.trimEnd, reason: it.label }),
          platformTarget: platform,
          captionsEnabled,
          title: title || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.planId) throw new Error(data.error || "Could not start the reel");
      toast({ title: "Building your reel", description: `${data.segmentCount} segments from ${data.sourceCount} video${data.sourceCount === 1 ? "" : "s"}` });

      const poll = setInterval(async () => {
        try {
          const pr = await fetchWithTimeout(`/api/remix/stitch-plans/${data.planId}`, { credentials: "include" });
          if (!pr.ok) return;
          const plan = await pr.json();
          if (plan.status === "completed" || plan.status === "failed") {
            clearInterval(poll);
            pollRef.current = null;
            setBuilding(false);
            if (plan.status === "completed") {
              setResult({ status: "completed", thumbnailPath: plan.thumbnailPath });
              toast({ title: "Reel ready", description: "Your reel is in your library." });
            } else {
              setResult({ status: "failed", error: plan.errorMessage });
              toast({ title: "Reel failed", description: plan.errorMessage || "Generation failed", variant: "destructive" });
            }
          }
        } catch { /* transient */ }
      }, 3000);
      pollRef.current = poll;
    } catch (err: any) {
      setBuilding(false);
      setResult({ status: "failed", error: err.message });
      toast({ title: "Couldn't build reel", description: err.message, variant: "destructive" });
    }
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.97, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 12 }}
          className="relative w-full max-w-5xl h-[88vh] bg-gray-900 border border-white/10 rounded-2xl overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Hidden picker for uploads */}
          <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={onFilePicked} />
          {recorderOpen && (
            <WebcamRecorder
              onClose={() => setRecorderOpen(false)}
              onCapture={(file) => { setRecorderOpen(false); uploadClip(file, "Recording"); }}
            />
          )}

          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10">
            <div className="flex items-center gap-2">
              <Film className="w-4 h-4 text-purple-400" />
              <h2 className="text-sm font-semibold text-white">Reel Builder</h2>
              <span className="text-[11px] text-gray-500">— assemble a reel across your videos</span>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
          </div>

          {result?.status === "completed" ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
              <CheckCircle className="w-12 h-12 text-emerald-400" />
              <p className="text-white font-medium">Your reel is ready</p>
              {result.thumbnailPath && <img src={result.thumbnailPath} alt="" className="max-h-64 rounded-lg border border-white/10" />}
              <p className="text-sm text-gray-400">It's saved in your library as a clip — publish it like any other.</p>
              <Button onClick={onClose} className="bg-purple-600 hover:bg-purple-500">Done</Button>
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Top: picker (left) + compose (right) */}
              <div className="flex-1 flex min-h-0">
                {/* Left: available clips */}
                <div className="w-[42%] border-r border-white/10 flex flex-col min-h-0">
                  <div className="px-4 py-2 text-[11px] uppercase tracking-wider text-gray-500 border-b border-white/5">Your clips</div>
                  <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
                    {loading ? (
                      <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-purple-400" /></div>
                    ) : clips.length === 0 ? (
                      <p className="text-xs text-gray-500 text-center py-10">No clips yet. Generate clips in a video's Remix Studio first.</p>
                    ) : (
                      clips.map((c) => {
                        const isSel = selected.has(clipKey(c));
                        return (
                          <button
                            key={clipKey(c)}
                            onClick={() => toggleClip(c)}
                            className={`w-full flex items-center gap-3 p-2 rounded-lg border text-left transition-colors ${
                              isSel ? "bg-purple-500/15 border-purple-500/50" : "bg-gray-800/50 border-gray-700 hover:border-gray-500"
                            }`}
                            data-testid={`reel-clip-${clipKey(c)}`}
                          >
                            <div className="w-14 h-10 rounded bg-gray-800 flex-none overflow-hidden flex items-center justify-center">
                              {c.thumbnailPath ? <img src={c.thumbnailPath} alt="" className="w-full h-full object-cover" /> : <Film className="w-4 h-4 text-gray-600" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-xs text-white truncate">{c.title || `${c.videoTitle} clip`}</p>
                              <p className="text-[11px] text-gray-500 truncate">{c.videoTitle} · {fmt(c.duration)}{c.hasSegments ? " · assembled" : ""}</p>
                            </div>
                            {isSel ? <CheckCircle className="w-4 h-4 text-purple-400 flex-none" /> : <Plus className="w-4 h-4 text-gray-500 flex-none" />}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Right: compose */}
                <div className="w-[58%] flex flex-col min-h-0 overflow-y-auto">
                  {/* AI thread, prompt-driven */}
                  <div className="p-3 space-y-1.5 border-b border-white/5">
                    <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Or let AI find it</div>
                    <input
                      value={storyPrompt}
                      onChange={(e) => setStoryPrompt(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !finding) findStory(); }}
                      placeholder="What kind of reel? e.g. me smiling, best advice, funniest moments"
                      className="w-full bg-gray-800 text-white text-[11px] rounded-md px-2.5 py-2 border border-violet-500/30 focus:border-violet-500 focus:outline-none placeholder:text-gray-600"
                      data-testid="story-prompt"
                    />
                    <button
                      onClick={findStory}
                      disabled={finding}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-violet-500/40 bg-violet-500/10 text-[11px] font-medium text-violet-200 hover:bg-violet-500/20 disabled:opacity-50"
                      data-testid="find-story"
                    >
                      {finding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                      {finding ? "Reading your videos…" : storyPrompt.trim() ? "Find these moments" : "Find a story across my videos"}
                    </button>
                    {narrativeArc && order.some((i) => i.source === "moment") && (
                      <p className="text-[11px] text-violet-300/80 italic leading-snug">{narrativeArc}</p>
                    )}
                  </div>

                  {/* Output settings */}
                  <div className="p-3 space-y-2.5">
                    <div className="text-[11px] uppercase tracking-wider text-gray-500">Output</div>
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Reel title (optional)"
                      className="w-full bg-gray-800 text-white text-xs rounded-md px-3 py-2 border border-gray-700 focus:border-purple-500 focus:outline-none"
                    />
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex rounded-md border border-gray-700 overflow-hidden">
                        {PLATFORMS.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => setPlatform(p.id)}
                            className={`px-2.5 py-1 text-[11px] ${platform === p.id ? "bg-purple-500/25 text-purple-200" : "text-gray-400 hover:text-white"}`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={() => setCaptionsEnabled((v) => !v)}
                        className={`text-[11px] px-2.5 py-1 rounded-md border ${captionsEnabled ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" : "bg-gray-800 text-gray-400 border-gray-700"}`}
                      >
                        Captions {captionsEnabled ? "on" : "off"}
                      </button>
                    </div>
                    <Button
                      onClick={build}
                      disabled={order.length < 2 || building}
                      className="w-full bg-purple-600 hover:bg-purple-500 text-white font-semibold"
                      data-testid="build-reel"
                    >
                      {building
                        ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Building reel…</>
                        : <><Sparkles className="w-4 h-4 mr-2" /> Build reel{order.length >= 2 ? ` · ${fmt(totalDuration)}` : ""}</>}
                    </Button>
                    {order.length === 1 && <p className="text-[11px] text-gray-600 text-center">Add at least one more clip.</p>}
                    {result?.status === "failed" && (
                      <p className="flex items-center gap-1.5 text-[11px] text-red-400"><AlertCircle className="w-3 h-3" /> {result.error || "Failed"}</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Bottom: the timeline */}
              <div className="border-t border-white/10 bg-black/30 flex-none">
                <div className="px-4 py-1.5 flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="uppercase tracking-wider text-gray-500">Timeline</span>
                    <button
                      onClick={() => fileRef.current?.click()}
                      disabled={uploading}
                      className="flex items-center gap-1 px-2 py-1 rounded-md border border-gray-700 text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-50"
                      data-testid="reel-upload"
                    >
                      {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />} Upload
                    </button>
                    <button
                      onClick={() => setRecorderOpen(true)}
                      className="flex items-center gap-1 px-2 py-1 rounded-md border border-gray-700 text-gray-300 hover:border-gray-500 hover:text-white"
                      data-testid="reel-record"
                    >
                      <Video className="w-3 h-3" /> Record
                    </button>
                    <button
                      onClick={() => setAiOpen((v) => !v)}
                      className={`flex items-center gap-1 px-2 py-1 rounded-md border ${aiOpen ? "border-violet-500/60 bg-violet-500/15 text-violet-200" : "border-violet-500/40 text-violet-300 hover:bg-violet-500/10"}`}
                      data-testid="reel-ai"
                    >
                      <Sparkles className="w-3 h-3" /> AI
                    </button>
                  </div>
                  {order.length > 0
                    ? <span className="text-gray-500">{order.length} clip{order.length === 1 ? "" : "s"} · {fmt(totalDuration)} · {sourceCount} source{sourceCount === 1 ? "" : "s"}</span>
                    : <span className="text-gray-600">add clips · drag edges to trim</span>}
                </div>
                {aiOpen && (
                  <div className="px-3 pb-2 flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-violet-400 flex-none" />
                    <input
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !aiGenerating) generateAi(); }}
                      placeholder="Describe an image to generate — e.g. a city skyline at dusk, cinematic"
                      className="flex-1 bg-gray-800 text-white text-[11px] rounded-md px-2.5 py-1.5 border border-violet-500/30 focus:border-violet-500 focus:outline-none placeholder:text-gray-600"
                      data-testid="ai-prompt"
                    />
                    <button
                      onClick={generateAi}
                      disabled={aiGenerating || aiPrompt.trim().length < 3}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-medium disabled:opacity-50"
                      data-testid="ai-generate"
                    >
                      {aiGenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      {aiGenerating ? "Generating…" : "Generate"}
                    </button>
                  </div>
                )}
                <div className="h-[132px] overflow-x-auto overflow-y-hidden px-3 pb-3">
                  {order.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-xs text-gray-600 border border-dashed border-gray-700 rounded-lg">
                      Pick clips on the left, or find a story with AI — they land here as a timeline you can trim and reorder.
                    </div>
                  ) : (
                    <div className="h-full flex items-stretch gap-1">
                      {order.map((it, i) => {
                        const w = Math.max(MIN_BLOCK_W, dur(it) * PX_PER_SEC);
                        return (
                          <div
                            key={it.id}
                            draggable
                            onDragStart={() => setDragIdx(i)}
                            onDragEnd={() => setDragIdx(null)}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => { e.preventDefault(); if (dragIdx !== null) reorder(dragIdx, i); setDragIdx(null); }}
                            style={{ width: w }}
                            className={`group relative flex-none h-full rounded-lg overflow-hidden border cursor-grab active:cursor-grabbing ${
                              dragIdx === i ? "border-purple-400 opacity-60" : it.source === "moment" ? "border-violet-500/40" : "border-gray-700"
                            }`}
                            data-testid={`timeline-block-${i}`}
                          >
                            {/* Backdrop */}
                            {it.thumbnailPath
                              ? <img src={it.thumbnailPath} alt="" className="absolute inset-0 w-full h-full object-cover opacity-40" />
                              : <div className={`absolute inset-0 ${it.source === "moment" ? "bg-gradient-to-br from-violet-600/30 to-gray-800" : "bg-gray-800"}`} />}
                            <div className="absolute inset-0 bg-black/30" />

                            {/* Label */}
                            <div className="absolute inset-x-0 top-0 p-1.5">
                              <p className="text-[10px] font-medium text-white leading-tight line-clamp-2">
                                {it.source === "moment" && <span className="text-violet-300">✦ </span>}{it.label}
                              </p>
                            </div>
                            <div className="absolute inset-x-0 bottom-0 p-1.5 flex items-center justify-between">
                              <span className="text-[10px] font-mono text-white/90">{fmt(dur(it))}</span>
                              {isTrimmed(it) && <Scissors className="w-2.5 h-2.5 text-amber-300" />}
                            </div>

                            {/* Trim handles. A still has no in-point — only its
                                hold duration matters — so the left edge is hidden
                                for image blocks; drag the right edge to hold it
                                longer. */}
                            {!it.isImage && (
                              <div
                                onPointerDown={(e) => beginTrim(e, i, "left")}
                                onDragStart={(e) => e.preventDefault()}
                                className="absolute inset-y-0 left-0 w-2 bg-purple-400/0 hover:bg-purple-400/70 cursor-col-resize"
                                title="Drag to trim the start"
                              />
                            )}
                            <div
                              onPointerDown={(e) => beginTrim(e, i, "right")}
                              onDragStart={(e) => e.preventDefault()}
                              className="absolute inset-y-0 right-0 w-2 bg-purple-400/0 hover:bg-purple-400/70 cursor-col-resize"
                              title="Drag to trim the end"
                            />

                            {/* Hover toolbar: nudge + remove (reliable reorder alongside drag) */}
                            <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onPointerDown={(e) => e.stopPropagation()} onClick={() => nudge(i, -1)} disabled={i === 0} className="w-4 h-4 flex items-center justify-center rounded bg-black/70 text-white/80 hover:text-white disabled:opacity-30"><ChevronLeft className="w-3 h-3" /></button>
                              <button onPointerDown={(e) => e.stopPropagation()} onClick={() => nudge(i, 1)} disabled={i === order.length - 1} className="w-4 h-4 flex items-center justify-center rounded bg-black/70 text-white/80 hover:text-white disabled:opacity-30"><ChevronRight className="w-3 h-3" /></button>
                              <button onPointerDown={(e) => e.stopPropagation()} onClick={() => removeAt(i)} className="w-4 h-4 flex items-center justify-center rounded bg-black/70 text-white/80 hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * Webcam recorder overlay. Opens the laptop camera, records with MediaRecorder,
 * and hands the parent a video File to upload. Self-contained: it acquires the
 * stream on mount and tears every track down on unmount, so the camera light
 * never lingers after the overlay closes.
 */
function WebcamRecorder({ onClose, onCapture }: { onClose: () => void; onCapture: (file: File) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
        setReady(true);
      } catch (err: any) {
        setError(err?.name === "NotAllowedError" ? "Camera access was blocked. Allow it in your browser and try again." : (err?.message || "Couldn't open the camera."));
      }
    })();
    return () => {
      cancelled = true;
      recorderRef.current?.state === "recording" && recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const start = () => {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    // Prefer mp4 when the browser offers it; fall back to webm (both ffmpeg-readable).
    const mime = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].find((m) => (window as any).MediaRecorder?.isTypeSupported?.(m)) || "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (ev) => { if (ev.data.size > 0) chunksRef.current.push(ev.data); };
    rec.onstop = () => {
      const type = rec.mimeType || "video/webm";
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(chunksRef.current, { type });
      onCapture(new File([blob], `recording-${Date.now()}.${ext}`, { type }));
    };
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
    setElapsed(0);
  };
  const stop = () => { recorderRef.current?.state === "recording" && recorderRef.current.stop(); setRecording(false); };

  return (
    <div className="absolute inset-0 z-10 bg-black/90 flex flex-col items-center justify-center p-6" onClick={(e) => e.stopPropagation()}>
      <button onClick={() => { stop(); onClose(); }} className="absolute top-4 right-4 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
      {error ? (
        <div className="text-center max-w-sm">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-sm text-gray-300">{error}</p>
          <Button onClick={onClose} className="mt-4 bg-gray-700 hover:bg-gray-600">Close</Button>
        </div>
      ) : (
        <>
          <div className="relative rounded-xl overflow-hidden border border-white/10 bg-black">
            <video ref={videoRef} muted playsInline className="max-h-[52vh] w-auto" style={{ transform: "scaleX(-1)" }} />
            {recording && (
              <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2 py-1 rounded-full bg-red-600/90 text-white text-[11px] font-medium">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> {fmt(elapsed)}
              </div>
            )}
          </div>
          <div className="mt-5 flex items-center gap-3">
            {!recording ? (
              <button onClick={start} disabled={!ready} className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-red-600 hover:bg-red-500 text-white font-medium disabled:opacity-50">
                <Circle className="w-4 h-4 fill-white" /> {ready ? "Start recording" : "Starting camera…"}
              </button>
            ) : (
              <button onClick={stop} className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-gray-900 font-medium">
                <Square className="w-4 h-4 fill-gray-900" /> Stop &amp; add to reel
              </button>
            )}
          </div>
          <p className="text-[11px] text-gray-500 mt-3">Records with sound. It's added to your timeline when you stop.</p>
        </>
      )}
    </div>
  );
}
