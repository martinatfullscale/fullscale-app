import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Film, Scissors, Play, Pause, Download, Send, Loader2, X,
  CheckCircle, AlertCircle, Clock, BarChart3, Sparkles,
  Tv, Smartphone, Globe, ThumbsUp, ThumbsDown, Settings,
  RefreshCw
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

interface RemixJob {
  id: number;
  videoId: number;
  status: string;
  config: {
    minClipDuration: number;
    maxClipDuration: number;
    maxClips: number;
    platformTargets: string[];
    captionsEnabled: boolean;
  } | null;
  clipCount: number | null;
  platformTargets: string[] | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface GeneratedClip {
  id: number;
  remixJobId: number;
  videoId: number;
  clipStart: number;
  clipEnd: number;
  duration: number;
  format: string | null;
  platformTarget: string | null;
  productPlacements: Array<{
    surfaceId: number;
    brandProductId: number;
    placementId: number;
  }> | null;
  captionsEnabled: boolean | null;
  qualityScore: number | null;
  exportPath: string | null;
  thumbnailPath: string | null;
  status: string | null;
  publishedAt: string | null;
  publishedPlatform: string | null;
  publishedUrl: string | null;
  createdAt: string;
}

interface RemixStudioProps {
  videoId: number;
  open: boolean;
  onClose: () => void;
}

const PLATFORM_ICONS: Record<string, any> = {
  tiktok: Smartphone,
  instagram_reels: Smartphone,
  youtube_shorts: Smartphone,
  youtube: Tv,
  twitter: Globe,
  linkedin: Globe,
};

const PLATFORM_LABELS: Record<string, string> = {
  tiktok: "TikTok",
  instagram_reels: "Instagram Reels",
  youtube_shorts: "YouTube Shorts",
  youtube: "YouTube",
  twitter: "Twitter/X",
  linkedin: "LinkedIn",
};

const STATUS_CONFIG: Record<string, { color: string; icon: any; label: string }> = {
  queued: { color: "bg-gray-500", icon: Clock, label: "Queued" },
  processing: { color: "bg-blue-500", icon: Loader2, label: "Processing" },
  step_1_identify: { color: "bg-blue-500", icon: Loader2, label: "Identifying moments" },
  step_2_extract: { color: "bg-blue-500", icon: Loader2, label: "Extracting clips" },
  step_3_analyze: { color: "bg-blue-500", icon: Loader2, label: "Analyzing" },
  step_4_insert: { color: "bg-blue-500", icon: Loader2, label: "Inserting placements" },
  step_5_format: { color: "bg-purple-500", icon: Loader2, label: "Generating clips" },
  step_7_score: { color: "bg-yellow-500", icon: BarChart3, label: "Scoring quality" },
  completed: { color: "bg-green-500", icon: CheckCircle, label: "Complete" },
  failed: { color: "bg-red-500", icon: AlertCircle, label: "Failed" },
};

export default function RemixStudio({ videoId, open, onClose }: RemixStudioProps) {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<RemixJob[]>([]);
  const [clips, setClips] = useState<GeneratedClip[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [pollInterval, setPollInterval] = useState<ReturnType<typeof setInterval> | null>(null);

  // Config state
  const [platforms, setPlatforms] = useState<string[]>(["tiktok", "youtube_shorts"]);
  const [maxClips, setMaxClips] = useState(5);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [showConfig, setShowConfig] = useState(false);

  // Load existing jobs and clips
  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [jobsRes, clipsRes] = await Promise.all([
        fetch(`/api/remix/video/${videoId}/jobs`, { credentials: "include" }),
        fetch(`/api/remix/clips/${videoId}`, { credentials: "include" }),
      ]);
      if (jobsRes.ok) setJobs(await jobsRes.json());
      if (clipsRes.ok) setClips(await clipsRes.json());
    } catch (err) {
      console.error("Failed to load remix data:", err);
    }
    setIsLoading(false);
  }, [videoId]);

  useEffect(() => {
    if (open) loadData();
    return () => { if (pollInterval) clearInterval(pollInterval); };
  }, [open, loadData]);

  // Poll active job
  useEffect(() => {
    if (!activeJobId) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/remix/jobs/${activeJobId}`, { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setJobs(prev => prev.map(j => j.id === activeJobId ? data.job : j));
          if (data.clips?.length > 0) {
            setClips(prev => {
              const existing = new Set(prev.map(c => c.id));
              const newClips = data.clips.filter((c: GeneratedClip) => !existing.has(c.id));
              return [...prev, ...newClips];
            });
          }
          if (data.job.status === "completed" || data.job.status === "failed") {
            setActiveJobId(null);
            clearInterval(interval);
            await loadData(); // Refresh all data
          }
        }
      } catch {}
    }, 3000);

    setPollInterval(interval);
    return () => clearInterval(interval);
  }, [activeJobId]);

  const startRemix = async () => {
    setIsStarting(true);
    try {
      const res = await fetch(`/api/remix/${videoId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          platformTargets: platforms,
          maxClips,
          captionsEnabled,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to start remix");
      }

      const data = await res.json();
      setActiveJobId(data.jobId);
      toast({ title: "Remix Started", description: `Job #${data.jobId} queued for processing` });
      await loadData();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
    setIsStarting(false);
  };

  const approveClip = async (clipId: number) => {
    try {
      const res = await fetch(`/api/remix/clips/${clipId}/approve`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        setClips(prev => prev.map(c => c.id === clipId ? { ...c, status: "ready" } : c));
        toast({ title: "Approved", description: "Clip marked as publish-ready" });
      }
    } catch {}
  };

  const rejectClip = async (clipId: number) => {
    try {
      const res = await fetch(`/api/remix/clips/${clipId}/reject`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        setClips(prev => prev.map(c => c.id === clipId ? { ...c, status: "rejected" } : c));
      }
    } catch {}
  };

  if (!open) return null;

  const activeJob = jobs.find(j =>
    j.status !== "completed" && j.status !== "failed"
  );
  const isProcessing = !!activeJob || !!activeJobId;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          className="bg-gray-900 rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-800">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
                <Scissors className="w-5 h-5 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">Remix Studio</h2>
                <p className="text-sm text-gray-400">Auto-generate platform-ready clips with product placements</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-5 h-5" />
            </Button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">

            {/* Config Section */}
            <div className="bg-gray-800/50 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
                  <Settings className="w-4 h-4" /> Remix Configuration
                </h3>
                <Button variant="ghost" size="sm" onClick={() => setShowConfig(!showConfig)}>
                  {showConfig ? "Hide" : "Show"}
                </Button>
              </div>

              {showConfig && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  className="space-y-4"
                >
                  {/* Platform selection */}
                  <div>
                    <label className="text-xs text-gray-400 mb-2 block">Target Platforms</label>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(PLATFORM_LABELS).map(([key, label]) => {
                        const isSelected = platforms.includes(key);
                        const Icon = PLATFORM_ICONS[key] || Globe;
                        return (
                          <button
                            key={key}
                            onClick={() => setPlatforms(prev =>
                              isSelected ? prev.filter(p => p !== key) : [...prev, key]
                            )}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                              isSelected
                                ? "bg-purple-500/30 text-purple-300 border border-purple-500/50"
                                : "bg-gray-700/50 text-gray-400 border border-gray-700 hover:border-gray-600"
                            }`}
                          >
                            <Icon className="w-3 h-3" />
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Max clips */}
                  <div className="flex items-center gap-4">
                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">Max Clips</label>
                      <select
                        value={maxClips}
                        onChange={(e) => setMaxClips(parseInt(e.target.value))}
                        className="bg-gray-700 text-white text-sm rounded-lg px-3 py-1.5 border border-gray-600"
                      >
                        {[1, 3, 5, 8, 10].map(n => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-400">Captions</label>
                      <button
                        onClick={() => setCaptionsEnabled(!captionsEnabled)}
                        className={`w-10 h-5 rounded-full transition-colors ${
                          captionsEnabled ? "bg-purple-500" : "bg-gray-600"
                        }`}
                      >
                        <div className={`w-4 h-4 rounded-full bg-white transform transition-transform ${
                          captionsEnabled ? "translate-x-5" : "translate-x-0.5"
                        }`} />
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Start Button */}
              <div className="mt-4">
                <Button
                  onClick={startRemix}
                  disabled={isStarting || isProcessing || platforms.length === 0}
                  className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white font-semibold"
                >
                  {isStarting ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Starting Remix...</>
                  ) : isProcessing ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing...</>
                  ) : (
                    <><Sparkles className="w-4 h-4 mr-2" /> Start Auto-Remix</>
                  )}
                </Button>
              </div>
            </div>

            {/* Active Job Status */}
            {(activeJob || activeJobId) && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4"
              >
                <div className="flex items-center gap-2 mb-2">
                  <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                  <span className="text-sm font-medium text-blue-300">
                    {activeJob
                      ? STATUS_CONFIG[activeJob.status]?.label || activeJob.status
                      : "Processing..."}
                  </span>
                </div>
                <div className="w-full bg-gray-700 rounded-full h-1.5">
                  <motion.div
                    className="bg-blue-500 h-1.5 rounded-full"
                    animate={{ width: getProgressWidth(activeJob?.status || "queued") }}
                    transition={{ duration: 0.5 }}
                  />
                </div>
              </motion.div>
            )}

            {/* Generated Clips */}
            {clips.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                  <Film className="w-4 h-4" /> Generated Clips ({clips.length})
                </h3>
                <div className="space-y-3">
                  {clips.map((clip) => (
                    <ClipCard
                      key={clip.id}
                      clip={clip}
                      onApprove={() => approveClip(clip.id)}
                      onReject={() => rejectClip(clip.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Past Jobs */}
            {jobs.filter(j => j.status === "completed" || j.status === "failed").length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                  <Clock className="w-4 h-4" /> Past Jobs
                </h3>
                <div className="space-y-2">
                  {jobs.filter(j => j.status === "completed" || j.status === "failed").map(job => (
                    <div key={job.id} className="bg-gray-800/50 rounded-lg p-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge className={`${job.status === "completed" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                          {job.status}
                        </Badge>
                        <span className="text-sm text-gray-400">
                          Job #{job.id} — {job.platformTargets?.join(", ")}
                        </span>
                      </div>
                      <span className="text-xs text-gray-500">
                        {new Date(job.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Empty state */}
            {!isLoading && clips.length === 0 && jobs.length === 0 && !isProcessing && (
              <div className="text-center py-12">
                <Scissors className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-400 mb-1">No clips generated yet</p>
                <p className="text-xs text-gray-500">
                  Select your target platforms above and click "Start Auto-Remix" to generate clips
                </p>
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

function ClipCard({
  clip,
  onApprove,
  onReject,
}: {
  clip: GeneratedClip;
  onApprove: () => void;
  onReject: () => void;
}) {
  const PlatformIcon = PLATFORM_ICONS[clip.platformTarget || ""] || Globe;
  const platformLabel = PLATFORM_LABELS[clip.platformTarget || ""] || clip.platformTarget;
  const qualityPct = ((clip.qualityScore || 0) * 100).toFixed(0);
  const qualityColor = (clip.qualityScore || 0) >= 0.7
    ? "text-green-400" : (clip.qualityScore || 0) >= 0.45
      ? "text-yellow-400" : "text-red-400";

  const statusBadge = clip.status === "ready"
    ? "bg-green-500/20 text-green-400"
    : clip.status === "rejected"
      ? "bg-red-500/20 text-red-400"
      : clip.status === "published"
        ? "bg-blue-500/20 text-blue-400"
        : "bg-yellow-500/20 text-yellow-400";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-gray-800/60 rounded-xl p-4 border border-gray-700/50"
    >
      <div className="flex items-start gap-4">
        {/* Thumbnail */}
        <div className="w-24 h-16 rounded-lg bg-gray-700 overflow-hidden flex-shrink-0">
          {clip.thumbnailPath ? (
            <img src={clip.thumbnailPath} alt="Clip thumbnail" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Film className="w-6 h-6 text-gray-500" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <PlatformIcon className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-sm font-medium text-white">{platformLabel}</span>
            <Badge className={statusBadge}>
              {clip.status || "pending"}
            </Badge>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span>{clip.duration.toFixed(1)}s</span>
            <span>•</span>
            <span>{clip.clipStart.toFixed(1)}s → {clip.clipEnd.toFixed(1)}s</span>
            <span>•</span>
            <span className={qualityColor}>{qualityPct}% quality</span>
            {clip.productPlacements && clip.productPlacements.length > 0 && (
              <>
                <span>•</span>
                <span>{clip.productPlacements.length} placement{clip.productPlacements.length !== 1 ? "s" : ""}</span>
              </>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {clip.status === "pending_review" && (
            <>
              <Button size="sm" variant="ghost" onClick={onApprove} className="text-green-400 hover:text-green-300 hover:bg-green-500/10">
                <ThumbsUp className="w-4 h-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={onReject} className="text-red-400 hover:text-red-300 hover:bg-red-500/10">
                <ThumbsDown className="w-4 h-4" />
              </Button>
            </>
          )}
          {clip.exportPath && (
            <a
              href={`/api/remix/clips/${clip.id}/download`}
              className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-700 transition-colors"
            >
              <Download className="w-4 h-4" />
            </a>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function getProgressWidth(status: string): string {
  const progressMap: Record<string, string> = {
    queued: "5%",
    processing: "10%",
    step_1_identify: "15%",
    step_2_extract: "25%",
    step_3_analyze: "35%",
    step_4_insert: "45%",
    step_5_format: "60%",
    step_7_score: "80%",
    completed: "100%",
    failed: "100%",
  };
  return progressMap[status] || "10%";
}
