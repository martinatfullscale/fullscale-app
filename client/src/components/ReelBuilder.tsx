import { useState, useEffect, useCallback } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Loader2, Film, Plus, ArrowUp, ArrowDown, Trash2, Sparkles, CheckCircle, AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

/**
 * Reel Builder — hand-pick clips from across the creator's videos and stitch
 * them into one reel. The backend (POST /api/remix/reel) cuts each picked clip
 * from its own source video and crossfades them together; this is the picker
 * and the ordered timeline that feed it.
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

const PLATFORMS = [
  { id: "tiktok", label: "TikTok" },
  { id: "youtube_shorts", label: "YouTube" },
  { id: "instagram_reels", label: "Instagram" },
];

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};
const clipKey = (c: { clipSource: string; clipId: number }) => `${c.clipSource}:${c.clipId}`;

export default function ReelBuilder({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [clips, setClips] = useState<ReelClip[]>([]);
  const [order, setOrder] = useState<ReelClip[]>([]); // the reel, in play order
  const [platform, setPlatform] = useState("tiktok");
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [title, setTitle] = useState("");
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<{ status: "building" | "completed" | "failed"; thumbnailPath?: string | null; error?: string } | null>(null);

  const selected = new Set(order.map(clipKey));

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
      setOrder([]); setResult(null); setTitle("");
    }
  }, [open, load]);

  const add = (c: ReelClip) => setOrder((o) => (o.some((x) => clipKey(x) === clipKey(c)) ? o : [...o, c]));
  const remove = (c: ReelClip) => setOrder((o) => o.filter((x) => clipKey(x) !== clipKey(c)));
  const move = (i: number, dir: -1 | 1) => setOrder((o) => {
    const j = i + dir;
    if (j < 0 || j >= o.length) return o;
    const next = [...o];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const totalDuration = order.reduce((s, c) => s + c.duration, 0);
  const sourceCount = new Set(order.map((c) => c.videoId)).size;

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
          clips: order.map((c) => ({ clipId: c.clipId, clipSource: c.clipSource })),
          platformTarget: platform,
          captionsEnabled,
          title: title || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.planId) throw new Error(data.error || "Could not start the reel");

      toast({ title: "Building your reel", description: `${data.segmentCount} segments from ${data.sourceCount} video${data.sourceCount === 1 ? "" : "s"}` });

      // Poll the stitch plan to completion.
      const poll = setInterval(async () => {
        try {
          const pr = await fetchWithTimeout(`/api/remix/stitch-plans/${data.planId}`, { credentials: "include" });
          if (!pr.ok) return;
          const plan = await pr.json();
          if (plan.status === "completed" || plan.status === "failed") {
            clearInterval(poll);
            setBuilding(false);
            if (plan.status === "completed") {
              setResult({ status: "completed", thumbnailPath: plan.thumbnailPath });
              toast({ title: "Reel ready", description: "Your cross-video reel is in your library." });
            } else {
              setResult({ status: "failed", error: plan.errorMessage });
              toast({ title: "Reel failed", description: plan.errorMessage || "Generation failed", variant: "destructive" });
            }
          }
        } catch { /* transient */ }
      }, 3000);
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
          className="relative w-full max-w-5xl h-[85vh] bg-gray-900 border border-white/10 rounded-2xl overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10">
            <div className="flex items-center gap-2">
              <Film className="w-4 h-4 text-purple-400" />
              <h2 className="text-sm font-semibold text-white">Reel Builder</h2>
              <span className="text-[11px] text-gray-500">— pick clips from any of your videos</span>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
          </div>

          {result?.status === "completed" ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
              <CheckCircle className="w-12 h-12 text-emerald-400" />
              <p className="text-white font-medium">Your reel is ready</p>
              {result.thumbnailPath && (
                <img src={result.thumbnailPath} alt="" className="max-h-64 rounded-lg border border-white/10" />
              )}
              <p className="text-sm text-gray-400">It's saved in your library as a clip — publish it like any other.</p>
              <Button onClick={onClose} className="bg-purple-600 hover:bg-purple-500">Done</Button>
            </div>
          ) : (
            <div className="flex-1 flex min-h-0">
              {/* Left: available clips */}
              <div className="w-1/2 border-r border-white/10 flex flex-col min-h-0">
                <div className="px-4 py-2 text-[11px] uppercase tracking-wider text-gray-500 border-b border-white/5">
                  Your clips
                </div>
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
                          onClick={() => (isSel ? remove(c) : add(c))}
                          className={`w-full flex items-center gap-3 p-2 rounded-lg border text-left transition-colors ${
                            isSel ? "bg-purple-500/15 border-purple-500/50" : "bg-gray-800/50 border-gray-700 hover:border-gray-500"
                          }`}
                          data-testid={`reel-clip-${clipKey(c)}`}
                        >
                          <div className="w-14 h-10 rounded bg-gray-800 flex-none overflow-hidden flex items-center justify-center">
                            {c.thumbnailPath
                              ? <img src={c.thumbnailPath} alt="" className="w-full h-full object-cover" />
                              : <Film className="w-4 h-4 text-gray-600" />}
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

              {/* Right: the reel */}
              <div className="w-1/2 flex flex-col min-h-0">
                <div className="px-4 py-2 text-[11px] uppercase tracking-wider text-gray-500 border-b border-white/5 flex items-center justify-between">
                  <span>Reel — {order.length} clip{order.length === 1 ? "" : "s"}</span>
                  {order.length > 0 && <span className="text-gray-600">{fmt(totalDuration)} · {sourceCount} source{sourceCount === 1 ? "" : "s"}</span>}
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
                  {order.length === 0 ? (
                    <p className="text-xs text-gray-500 text-center py-10">Click clips on the left to add them. Order top-to-bottom is play order.</p>
                  ) : (
                    order.map((c, i) => (
                      <div key={clipKey(c)} className="flex items-center gap-2 p-2 rounded-lg bg-gray-800/60 border border-gray-700">
                        <span className="text-[11px] font-mono text-gray-500 w-4 text-center">{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-white truncate">{c.title || `${c.videoTitle} clip`}</p>
                          <p className="text-[11px] text-gray-500 truncate">{c.videoTitle} · {fmt(c.duration)}</p>
                        </div>
                        <div className="flex items-center gap-0.5">
                          <button onClick={() => move(i, -1)} disabled={i === 0} className="p-1 text-gray-500 hover:text-white disabled:opacity-25"><ArrowUp className="w-3.5 h-3.5" /></button>
                          <button onClick={() => move(i, 1)} disabled={i === order.length - 1} className="p-1 text-gray-500 hover:text-white disabled:opacity-25"><ArrowDown className="w-3.5 h-3.5" /></button>
                          <button onClick={() => remove(c)} className="p-1 text-gray-500 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Controls */}
                <div className="border-t border-white/10 p-3 space-y-2.5">
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Reel title (optional)"
                    className="w-full bg-gray-800 text-white text-xs rounded-md px-3 py-2 border border-gray-700 focus:border-purple-500 focus:outline-none"
                  />
                  <div className="flex items-center gap-2">
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
                      : <><Sparkles className="w-4 h-4 mr-2" /> Build reel{order.length >= 2 ? ` (${order.length} clips)` : ""}</>}
                  </Button>
                  {order.length === 1 && <p className="text-[11px] text-gray-600 text-center">Add at least one more clip.</p>}
                  {result?.status === "failed" && (
                    <p className="flex items-center gap-1.5 text-[11px] text-red-400"><AlertCircle className="w-3 h-3" /> {result.error || "Failed"}</p>
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
