import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Film, Scissors, Play, Pause, Download, Send, Loader2, X,
  CheckCircle, AlertCircle, Clock, BarChart3, Sparkles,
  Tv, Smartphone, Globe, ThumbsUp, ThumbsDown, Settings,
  RefreshCw, Brain, Volume2, VolumeX, Maximize2,
  Layers, ChevronDown, ChevronUp, Pencil, RotateCcw, Minus, Plus, Trash2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import EditorialClips from "@/components/EditorialClips";
import RemixCopilot from "@/components/RemixCopilot";

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

interface NarrativeSegment {
  start: number;
  end: number;
  role: "hook" | "development" | "climax" | "payoff" | "bridge";
  narrativePurpose: string;
  connectionToNext?: string;
  suggestedTransition: "cut" | "crossfade" | "branded_wipe";
  enabled: boolean;
}

interface NarrativeThreadResult {
  segments: NarrativeSegment[];
  narrativeArc: string;
  totalDuration: number;
  suggestedTitle: string;
}

interface StitchPlan {
  id: number;
  videoId: number;
  status: string;
  narrativeArc: string | null;
  suggestedTitle: string | null;
  segments: NarrativeSegment[] | null;
  totalDuration: number | null;
  outputPath: string | null;
  thumbnailPath: string | null;
  generatedClipId: number | null;
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
  cancelled: { color: "bg-gray-500", icon: AlertCircle, label: "Cancelled" },
};

// A job in any of these states is finished — nothing is running on the server.
// "cancelled" MUST be here: without it a cancelled job reads as still-active and
// permanently disables the Auto-Remix tab for that video.
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
const isTerminalStatus = (status?: string | null) =>
  !!status && TERMINAL_STATUSES.includes(status);

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
  const [activeTab, setActiveTab] = useState<"editorial" | "auto" | "highlight">("editorial");

  // Highlight Reel state (Phase 2B)
  const [narrativeThread, setNarrativeThread] = useState<NarrativeThreadResult | null>(null);
  const [isAnalyzingThread, setIsAnalyzingThread] = useState(false);
  const [isStitching, setIsStitching] = useState(false);
  const [stitchPlans, setStitchPlans] = useState<StitchPlan[]>([]);
  const [editableSegments, setEditableSegments] = useState<NarrativeSegment[]>([]);
  const [stitchPlatform, setStitchPlatform] = useState("tiktok");

  // AI Co-Pilot state (Phase 4)
  const [copilotClipId, setCopilotClipId] = useState<number | undefined>(undefined);

  // Load existing jobs, clips, and stitch plans
  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [jobsRes, clipsRes, stitchRes] = await Promise.all([
        fetch(`/api/remix/video/${videoId}/jobs`, { credentials: "include" }),
        fetch(`/api/remix/clips/${videoId}`, { credentials: "include" }),
        fetch(`/api/remix/${videoId}/stitch-plans`, { credentials: "include" }),
      ]);
      if (jobsRes.ok) setJobs(await jobsRes.json());
      if (clipsRes.ok) {
        const loadedClips = await clipsRes.json();
        setClips(loadedClips);
        // Auto-set copilot clip ID to latest clip if not already set
        if (loadedClips.length > 0) {
          setCopilotClipId(prev => prev ?? loadedClips[loadedClips.length - 1].id);
        }
      }
      if (stitchRes.ok) setStitchPlans(await stitchRes.json());
    } catch (err) {
      console.error("Failed to load remix data:", err);
    }
    setIsLoading(false);
  }, [videoId]);

  // Handle co-pilot suggestion application (Phase 4)
  const handleApplySuggestion = useCallback((suggestion: any) => {
    const { type, data } = suggestion;
    switch (type) {
      case "trim":
      case "hook_improvement": {
        if (!copilotClipId) {
          toast({ title: "No clip selected", description: "Generate or select a clip first to apply this suggestion.", variant: "destructive" });
          break;
        }
        const newStart = type === "trim" ? data.newStart : data.alternativeStart;
        const newEnd = type === "trim" ? data.newEnd : undefined;
        fetch(`/api/remix/clips/${copilotClipId}/re-render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            newStart,
            ...(newEnd !== undefined ? { newEnd } : {}),
          }),
        }).then((res) => {
          if (res.ok) {
            toast({ title: "Re-rendering", description: "Clip is being re-rendered with suggested changes" });
            setTimeout(loadData, 3000);
          } else {
            toast({ title: "Re-render failed", description: "Could not apply suggestion. Try again.", variant: "destructive" });
          }
        });
        break;
      }
      case "caption_edit": {
        if (!copilotClipId) {
          toast({ title: "No clip selected", description: "Generate or select a clip first to apply this suggestion.", variant: "destructive" });
          break;
        }
        fetch(`/api/remix/clips/${copilotClipId}/re-render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            captionsEnabled: true,
            captionStyle: data.suggestedStyle,
          }),
        }).then((res) => {
          if (res.ok) {
            toast({ title: "Re-rendering", description: `Applying ${data.suggestedStyle} caption style` });
            setTimeout(loadData, 3000);
          } else {
            toast({ title: "Re-render failed", description: "Could not apply caption style. Try again.", variant: "destructive" });
          }
        });
        break;
      }
      case "platform_switch": {
        if (!copilotClipId) {
          toast({ title: "No clip selected", description: "Generate or select a clip first to apply this suggestion.", variant: "destructive" });
          break;
        }
        fetch(`/api/remix/clips/${copilotClipId}/re-render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            platformTarget: data.betterPlatform,
          }),
        }).then((res) => {
          if (res.ok) {
            toast({ title: "Re-rendering", description: `Re-targeting clip for ${data.betterPlatform}` });
            setTimeout(loadData, 3000);
          } else {
            toast({ title: "Re-render failed", description: "Could not switch platform. Try again.", variant: "destructive" });
          }
        });
        break;
      }
      case "add_placement": {
        toast({
          title: "Placement suggestion",
          description: data.productName
            ? `${data.productName} can be placed on surface #${data.surfaceId} at ${data.placementTimestamp?.toFixed(1) || 0}s`
            : suggestion.reason,
        });
        break;
      }
      default:
        toast({ title: "Suggestion noted", description: suggestion.reason });
    }
  }, [copilotClipId, toast, loadData]);

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
              // Auto-set copilot clip to newest clip
              if (newClips.length > 0) {
                setCopilotClipId(newClips[newClips.length - 1].id);
              }
              return [...prev, ...newClips];
            });
          }
          if (isTerminalStatus(data.job.status)) {
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
    const attemptStart = async () => {
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
        const err: any = new Error(data.error || "Failed to start remix");
        err.status = res.status;
        throw err;
      }
      return res.json();
    };

    try {
      let data;
      try {
        data = await attemptStart();
      } catch (err: any) {
        // If the remix needs scene analysis, auto-run it and retry.
        const needsAnalysis =
          err?.status === 400 &&
          typeof err?.message === "string" &&
          /scene anal/i.test(err.message);

        if (!needsAnalysis) throw err;

        toast({
          title: "Preparing video...",
          description: "Running AI scene analysis first. This takes 1-3 minutes.",
        });

        const analyzeRes = await fetch(`/api/scenes/${videoId}/analyze`, {
          method: "POST",
          credentials: "include",
        });
        if (!analyzeRes.ok) {
          const aErr = await analyzeRes.json().catch(() => ({}));
          throw new Error(aErr.error || "Scene analysis failed. Try running a scan first from the Library.");
        }
        const analyzeData = await analyzeRes.json();
        toast({
          title: "Scene analysis complete",
          description: `${analyzeData.analyzed || 0} frames analyzed. Starting remix...`,
        });

        // Retry the remix
        data = await attemptStart();
      }

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

  // Narrative thread analysis (Phase 2B)
  const analyzeNarrativeThread = async () => {
    setIsAnalyzingThread(true);
    try {
      const res = await fetch(`/api/remix/${videoId}/narrative-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ targetDuration: 90, segmentCount: 4 }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Analysis failed");
      }
      const result = await res.json();
      setNarrativeThread(result);
      setEditableSegments(result.segments.map((seg: any) => ({ ...seg, enabled: true })));
      toast({ title: "Thread Identified", description: `"${result.suggestedTitle}" — ${result.segments.length} segments` });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
    setIsAnalyzingThread(false);
  };

  const startStitch = async () => {
    if (editableSegments.filter(s => s.enabled).length < 2) {
      toast({ title: "Error", description: "Need at least 2 enabled segments", variant: "destructive" });
      return;
    }
    setIsStitching(true);
    try {
      const enabledSegments = editableSegments.filter(s => s.enabled);
      const res = await fetch(`/api/remix/${videoId}/stitch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          segments: enabledSegments,
          transitions: "crossfade",
          platformTarget: stitchPlatform,
          captionsEnabled,
          narrativeArc: narrativeThread?.narrativeArc,
          suggestedTitle: narrativeThread?.suggestedTitle,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Stitch failed");
      }
      const data = await res.json();
      toast({ title: "Stitching Started", description: `Plan #${data.planId} — generating highlight reel` });
      // Poll for completion
      const pollStitch = setInterval(async () => {
        try {
          const planRes = await fetch(`/api/remix/stitch-plans/${data.planId}`, { credentials: "include" });
          if (planRes.ok) {
            const plan = await planRes.json();
            if (plan.status === "completed" || plan.status === "failed") {
              clearInterval(pollStitch);
              setIsStitching(false);
              await loadData();
              if (plan.status === "completed") {
                toast({ title: "Highlight Reel Ready", description: "Your stitched clip has been generated" });
              } else {
                toast({ title: "Stitch Failed", description: plan.errorMessage || "Generation failed", variant: "destructive" });
              }
            }
          }
        } catch {}
      }, 3000);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setIsStitching(false);
    }
  };

  // Re-render clip (Phase 2C)
  const reRenderClip = async (clipId: number, mods: { newStart?: number; newEnd?: number; captionsEnabled?: boolean; captionStyle?: string; platformTarget?: string }) => {
    try {
      const res = await fetch(`/api/remix/clips/${clipId}/re-render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(mods),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Re-render failed");
      }
      toast({ title: "Re-rendering", description: "Generating updated clip..." });
      // Poll for new clips after a delay
      setTimeout(() => loadData(), 5000);
      setTimeout(() => loadData(), 10000);
      setTimeout(() => loadData(), 20000);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  // Lock body scroll when modal is open to prevent background from scrolling
  useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = original; };
  }, [open]);

  if (!open) return null;

  const activeJob = jobs.find(j => !isTerminalStatus(j.status));
  const isProcessing = !!activeJob || !!activeJobId;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 overflow-hidden touch-none"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        onTouchMove={(e) => e.stopPropagation()}
      >
        <motion.div
          className="bg-gray-900 rounded-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col"
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

          {/* Two-panel layout: Main content + Co-Pilot side panel */}
          <div className="flex-1 flex overflow-hidden">

          {/* Main Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6 border-r border-gray-800">

            {/* Tab Switcher — Editorial Clips vs Auto-Remix */}
            <div className="flex items-center gap-2 bg-gray-800/50 rounded-lg p-1">
              <button
                onClick={() => setActiveTab("editorial")}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  activeTab === "editorial"
                    ? "bg-purple-600 text-white"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                <Brain className="w-4 h-4" />
                Editorial Clips
              </button>
              <button
                onClick={() => setActiveTab("auto")}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  activeTab === "auto"
                    ? "bg-pink-600 text-white"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                <Scissors className="w-4 h-4" />
                Auto-Remix
              </button>
              <button
                onClick={() => setActiveTab("highlight")}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  activeTab === "highlight"
                    ? "bg-amber-600 text-white"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                <Layers className="w-4 h-4" />
                Highlight Reel
              </button>
            </div>

            {/* Editorial Clips Tab — transcript-first viral clip identification */}
            {/* Always rendered, hidden via CSS to preserve state across tab switches */}
            <div className={activeTab === "editorial" ? "block" : "hidden"}>
              <p className="text-xs text-gray-500 mb-3">
                AI-identified viral moments ranked by editorial quality. Click "Generate" to create a clip from any moment.
              </p>
              <EditorialClips
                videoId={videoId}
                mode="remix"
                onGenerateClip={(clip) => {
                  toast({
                    title: "Generating clip",
                    description: `"${clip.suggestedTitle}" (${clip.clipStart.toFixed(1)}s - ${clip.clipEnd.toFixed(1)}s)`,
                  });
                  // Start a remix job targeting this specific clip's time range
                  fetch(`/api/remix/${videoId}/start`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({
                      platformTargets: platforms,
                      maxClips: 1,
                      captionsEnabled,
                      clipRange: {
                        start: clip.clipStart,
                        end: clip.clipEnd,
                      },
                    }),
                  })
                    .then(async (res) => {
                      if (res.ok) {
                        const data = await res.json();
                        setActiveJobId(data.jobId);
                        setActiveTab("auto"); // Switch to auto tab to see progress
                        toast({ title: "Remix Started", description: `Generating clip from editorial moment` });
                        await loadData();
                      } else {
                        const err = await res.json();
                        toast({ title: "Error", description: err.error || "Failed to start remix", variant: "destructive" });
                      }
                    })
                    .catch((err) => {
                      toast({ title: "Error", description: err.message, variant: "destructive" });
                    });
                }}
              />
            </div>

            {/* Auto-Remix Tab — existing config + generation flow */}
            <div className={activeTab === "auto" ? "block" : "hidden"}>
            <>
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
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                    <span className="text-sm font-medium text-blue-300">
                      {activeJob
                        ? STATUS_CONFIG[activeJob.status]?.label || activeJob.status
                        : "Processing..."}
                    </span>
                  </div>
                  <button
                    onClick={async () => {
                      const id = activeJobId || activeJob?.id;
                      if (!id) return;
                      try {
                        await fetch(`/api/remix/jobs/${id}/cancel`, {
                          method: "POST",
                          credentials: "include",
                        });
                      } catch {}
                      setActiveJobId(null);
                    }}
                    className="text-xs text-blue-300/70 hover:text-red-400 border border-blue-500/30 hover:border-red-500/50 rounded px-2 py-0.5 transition-colors"
                    data-testid="button-remix-cancel"
                  >
                    Cancel
                  </button>
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {clips.map((clip) => (
                    <ClipCard
                      key={clip.id}
                      clip={clip}
                      onApprove={() => approveClip(clip.id)}
                      onReject={() => rejectClip(clip.id)}
                      onReRender={reRenderClip}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Past Jobs */}
            {jobs.filter(j => isTerminalStatus(j.status)).length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                  <Clock className="w-4 h-4" /> Past Jobs
                </h3>
                <div className="space-y-2">
                  {jobs.filter(j => isTerminalStatus(j.status)).map(job => (
                    <div key={job.id} className="bg-gray-800/50 rounded-lg p-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge className={`${job.status === "completed" ? "bg-green-500/20 text-green-400" : job.status === "cancelled" ? "bg-gray-500/20 text-gray-400" : "bg-red-500/20 text-red-400"}`}>
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
            </>
            </div>{/* end auto-remix tab */}

            {/* Highlight Reel Tab — Phase 2B multi-segment stitching */}
            <div className={`space-y-4 ${activeTab === "highlight" ? "block" : "hidden"}`}>
                <p className="text-xs text-gray-500">
                  AI identifies a narrative thread across your content and stitches non-contiguous moments into a highlight reel.
                </p>

                {/* Analyze button */}
                {!narrativeThread && (
                  <Button
                    onClick={analyzeNarrativeThread}
                    disabled={isAnalyzingThread}
                    className="w-full bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white font-semibold"
                  >
                    {isAnalyzingThread ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analyzing Narrative Thread...</>
                    ) : (
                      <><Brain className="w-4 h-4 mr-2" /> Find Narrative Thread</>
                    )}
                  </Button>
                )}

                {/* Thread results */}
                {narrativeThread && (
                  <div className="space-y-4">
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
                      <h4 className="text-sm font-semibold text-amber-300 mb-1">
                        {narrativeThread.suggestedTitle}
                      </h4>
                      <p className="text-xs text-gray-400">{narrativeThread.narrativeArc}</p>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-xs text-amber-400">
                          {editableSegments.filter(s => s.enabled).length} segments
                        </span>
                        <span className="text-xs text-gray-500">
                          {editableSegments.filter(s => s.enabled).reduce((sum, s) => sum + (s.end - s.start), 0).toFixed(1)}s total
                        </span>
                      </div>
                    </div>

                    {/* Segment cards */}
                    <div className="space-y-2">
                      {editableSegments.map((seg, i) => {
                        const roleColors: Record<string, string> = {
                          hook: "bg-red-500/20 text-red-400",
                          development: "bg-blue-500/20 text-blue-400",
                          climax: "bg-purple-500/20 text-purple-400",
                          payoff: "bg-green-500/20 text-green-400",
                          bridge: "bg-gray-500/20 text-gray-400",
                        };
                        return (
                          <div
                            key={i}
                            className={`rounded-lg border p-3 transition-all ${
                              seg.enabled
                                ? "bg-gray-800/60 border-gray-700/50"
                                : "bg-gray-800/20 border-gray-800 opacity-50"
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                <Badge className={roleColors[seg.role] || roleColors.development}>
                                  {seg.role}
                                </Badge>
                                <span className="text-xs text-gray-400">
                                  {seg.start.toFixed(1)}s - {seg.end.toFixed(1)}s
                                  <span className="text-gray-600 ml-1">
                                    ({(seg.end - seg.start).toFixed(1)}s)
                                  </span>
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                {i > 0 && (
                                  <select
                                    value={seg.suggestedTransition}
                                    onChange={(e) => {
                                      const updated = [...editableSegments];
                                      updated[i] = { ...updated[i], suggestedTransition: e.target.value as any };
                                      setEditableSegments(updated);
                                    }}
                                    className="bg-gray-700 text-gray-300 text-[10px] rounded px-1.5 py-0.5 border border-gray-600"
                                  >
                                    <option value="crossfade">Crossfade</option>
                                    <option value="cut">Hard Cut</option>
                                  </select>
                                )}
                                <button
                                  onClick={() => {
                                    const updated = [...editableSegments];
                                    updated[i] = { ...updated[i], enabled: !updated[i].enabled };
                                    setEditableSegments(updated);
                                  }}
                                  className={`w-8 h-4 rounded-full transition-colors ${
                                    seg.enabled ? "bg-amber-500" : "bg-gray-600"
                                  }`}
                                >
                                  <div className={`w-3 h-3 rounded-full bg-white transform transition-transform ${
                                    seg.enabled ? "translate-x-4" : "translate-x-0.5"
                                  }`} />
                                </button>
                              </div>
                            </div>
                            <p className="text-xs text-gray-400">{seg.narrativePurpose}</p>
                            {seg.connectionToNext && (
                              <p className="text-[10px] text-gray-600 mt-1 italic">
                                Next: {seg.connectionToNext}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Platform + generate */}
                    <div className="flex items-center gap-3">
                      <select
                        value={stitchPlatform}
                        onChange={(e) => setStitchPlatform(e.target.value)}
                        className="bg-gray-700 text-white text-sm rounded-lg px-3 py-2 border border-gray-600"
                      >
                        {Object.entries(PLATFORM_LABELS).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                      <Button
                        onClick={startStitch}
                        disabled={isStitching || editableSegments.filter(s => s.enabled).length < 2}
                        className="flex-1 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white font-semibold"
                      >
                        {isStitching ? (
                          <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Stitching...</>
                        ) : (
                          <><Layers className="w-4 h-4 mr-2" /> Generate Highlight Reel</>
                        )}
                      </Button>
                    </div>

                    {/* Re-analyze button */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setNarrativeThread(null); setEditableSegments([]); }}
                      className="text-gray-500 hover:text-gray-300 text-xs"
                    >
                      <RefreshCw className="w-3 h-3 mr-1" /> Re-analyze
                    </Button>
                  </div>
                )}

                {/* Past stitch plans */}
                {stitchPlans.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                      <Layers className="w-4 h-4" /> Highlight Reels ({stitchPlans.length})
                    </h3>
                    <div className="space-y-3">
                      {stitchPlans.map(plan => (
                        <HighlightReelCard
                          key={plan.id}
                          plan={plan}
                          onDelete={(planId) => {
                            setStitchPlans(prev => prev.filter(p => p.id !== planId));
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>{/* end highlight reel tab */}
          </div>

          {/* AI Co-Pilot Side Panel — always visible */}
          <div className="w-[380px] flex-shrink-0 h-full overflow-hidden">
            <RemixCopilot
              videoId={videoId}
              clipId={copilotClipId}
              open={true}
              onClose={() => {}}
              onApplySuggestion={handleApplySuggestion}
              inline={true}
            />
          </div>

          </div>{/* end two-panel layout */}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

function HighlightReelCard({ plan, onDelete }: { plan: StitchPlan; onDelete?: (planId: number) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { toast } = useToast();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [showPlayer, setShowPlayer] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);

  const videoSrc = plan.generatedClipId
    ? `/api/remix/clips/${plan.generatedClipId}/download`
    : null;

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    setCurrentTime(videoRef.current.currentTime);
    setDuration(videoRef.current.duration || 0);
    setProgress((videoRef.current.currentTime / (videoRef.current.duration || 1)) * 100);
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    videoRef.current.currentTime = pct * videoRef.current.duration;
  };

  return (
    <div className="bg-gray-800/50 rounded-xl border border-gray-700/50 overflow-hidden">
      {/* Video player area */}
      {plan.status === "completed" && videoSrc && showPlayer && (
        <div className="relative bg-black aspect-video">
          <video
            ref={videoRef}
            src={videoSrc}
            muted={isMuted}
            onTimeUpdate={handleTimeUpdate}
            onEnded={() => { setIsPlaying(false); setProgress(0); setCurrentTime(0); }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onLoadedMetadata={() => { if (videoRef.current) setDuration(videoRef.current.duration); }}
            className="w-full h-full object-contain"
            playsInline
            preload="metadata"
          />
          {/* Controls overlay */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3">
            <div
              className="w-full h-1 bg-gray-600 rounded-full mb-2 cursor-pointer group"
              onClick={handleProgressClick}
            >
              <div
                className="h-full bg-amber-500 rounded-full relative group-hover:bg-amber-400 transition-colors"
                style={{ width: `${progress}%` }}
              >
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button onClick={togglePlay} className="text-white hover:text-amber-300 transition-colors">
                  {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                </button>
                <button onClick={() => setIsMuted(!isMuted)} className="text-white/70 hover:text-white transition-colors">
                  {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                </button>
                <span className="text-xs text-gray-400">
                  {formatDuration(currentTime)} / {formatDuration(duration)}
                </span>
              </div>
              <button
                onClick={() => { setShowPlayer(false); setIsPlaying(false); videoRef.current?.pause(); }}
                className="text-white/70 hover:text-white text-xs"
              >
                Collapse
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Info section */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2">
            <Badge className={
              plan.status === "completed" ? "bg-green-500/20 text-green-400" :
              plan.status === "failed" ? "bg-red-500/20 text-red-400" :
              plan.status === "generating" ? "bg-blue-500/20 text-blue-400" :
              "bg-amber-500/20 text-amber-400"
            }>
              {plan.status === "generating" && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              {plan.status}
            </Badge>
            <span className="text-sm font-medium text-white">{plan.suggestedTitle || "Untitled Reel"}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">
              {plan.totalDuration ? `${plan.totalDuration.toFixed(0)}s` : ""}
            </span>
            <button
              className="text-gray-500 hover:text-red-400 transition-colors p-1 rounded hover:bg-red-500/10"
              title="Delete highlight reel"
              disabled={isDeleting}
              onClick={async () => {
                if (!confirm("Delete this highlight reel?")) return;
                setIsDeleting(true);
                try {
                  const res = await fetch(`/api/remix/stitch-plans/${plan.id}`, {
                    method: "DELETE",
                    credentials: "include",
                  });
                  if (res.ok) {
                    toast({ title: "Highlight reel deleted" });
                    onDelete?.(plan.id);
                  } else {
                    throw new Error("Failed to delete");
                  }
                } catch {
                  toast({ title: "Delete failed", variant: "destructive" });
                  setIsDeleting(false);
                }
              }}
            >
              {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {plan.narrativeArc && (
          <p className="text-xs text-gray-500 mb-3">{plan.narrativeArc}</p>
        )}

        {/* Action buttons */}
        {plan.status === "completed" && videoSrc && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowPlayer(!showPlayer);
                if (!showPlayer) {
                  // Auto-play when opening
                  setTimeout(() => videoRef.current?.play(), 100);
                } else {
                  videoRef.current?.pause();
                  setIsPlaying(false);
                }
              }}
              className="flex-1 text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 text-xs"
            >
              <Play className="w-3.5 h-3.5 mr-1.5" />
              {showPlayer ? "Hide Player" : "Play Reel"}
            </Button>
            <a
              href={`/api/remix/clips/${plan.generatedClipId}/download`}
              download
              className="flex-1"
            >
              <Button
                size="sm"
                variant="ghost"
                className="w-full text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 text-xs"
              >
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Download
              </Button>
            </a>
          </div>
        )}

        {plan.status === "generating" && (
          <div className="flex items-center gap-2 text-xs text-blue-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Stitching segments into highlight reel...</span>
          </div>
        )}

        {plan.status === "failed" && (
          <p className="text-xs text-red-400">Generation failed. Try generating again.</p>
        )}
      </div>
    </div>
  );
}

function ClipCard({
  clip,
  onApprove,
  onReject,
  onReRender,
}: {
  clip: GeneratedClip;
  onApprove: () => void;
  onReject: () => void;
  onReRender?: (clipId: number, mods: any) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [showPlayer, setShowPlayer] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [editStart, setEditStart] = useState(clip.clipStart);
  const [editEnd, setEditEnd] = useState(clip.clipEnd);
  const [editCaptions, setEditCaptions] = useState(clip.captionsEnabled ?? true);
  const [editCaptionStyle, setEditCaptionStyle] = useState<string>("highlight");
  const [editPlatform, setEditPlatform] = useState(clip.platformTarget || "tiktok");
  const [isReRendering, setIsReRendering] = useState(false);

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

  // Resolve clip source URL: Object Storage paths served via /storage/* proxy,
  // otherwise use the download endpoint as a stream fallback
  const clipSrc = clip.exportPath
    ? clip.exportPath.startsWith("/storage/")
      ? clip.exportPath
      : `/api/remix/clips/${clip.id}/download`
    : null;

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const pct = (videoRef.current.currentTime / videoRef.current.duration) * 100;
    setProgress(pct);
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    videoRef.current.currentTime = pct * videoRef.current.duration;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-gray-800/60 rounded-xl border border-gray-700/50 overflow-hidden"
    >
      {/* Video Player / Thumbnail area */}
      {clipSrc && showPlayer ? (
        <div className="relative bg-black aspect-video">
          <video
            ref={videoRef}
            src={clipSrc}
            muted={isMuted}
            onTimeUpdate={handleTimeUpdate}
            onEnded={() => { setIsPlaying(false); setProgress(0); }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            className="w-full h-full object-contain"
            playsInline
            preload="metadata"
          />

          {/* Video controls overlay */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3">
            {/* Progress bar */}
            <div
              className="w-full h-1 bg-gray-600 rounded-full mb-2 cursor-pointer group"
              onClick={handleProgressClick}
            >
              <div
                className="h-full bg-purple-500 rounded-full relative group-hover:bg-purple-400 transition-colors"
                style={{ width: `${progress}%` }}
              >
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button onClick={togglePlay} className="text-white hover:text-purple-300 transition-colors">
                  {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                </button>
                <button onClick={() => setIsMuted(!isMuted)} className="text-white/70 hover:text-white transition-colors">
                  {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                </button>
              </div>
              <button
                onClick={() => { setShowPlayer(false); setIsPlaying(false); videoRef.current?.pause(); }}
                className="text-white/70 hover:text-white text-xs"
              >
                Collapse
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Thumbnail with play overlay */
        <div
          className={`relative h-40 bg-gray-900 flex items-center justify-center ${clipSrc ? "cursor-pointer group" : ""}`}
          onClick={() => clipSrc && setShowPlayer(true)}
        >
          {clip.thumbnailPath ? (
            <img src={clip.thumbnailPath} alt="Clip thumbnail" className="w-full h-full object-cover" />
          ) : (
            <Film className="w-10 h-10 text-gray-600" />
          )}
          {clipSrc && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="w-12 h-12 rounded-full bg-purple-600/90 flex items-center justify-center">
                <Play className="w-6 h-6 text-white ml-0.5" />
              </div>
            </div>
          )}
          {/* Platform badge on thumbnail */}
          <div className="absolute top-2 left-2">
            <Badge className="bg-gray-900/80 text-gray-200 text-[10px] border-0">
              <PlatformIcon className="w-3 h-3 mr-1" />
              {platformLabel}
            </Badge>
          </div>
        </div>
      )}

      {/* Info + Actions bar */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Badge className={statusBadge}>
              {clip.status || "pending"}
            </Badge>
            <span className={`text-xs font-medium ${qualityColor}`}>{qualityPct}% quality</span>
          </div>
          <span className="text-xs text-gray-500">{clip.duration.toFixed(1)}s</span>
        </div>

        <div className="flex items-center gap-3 text-xs text-gray-400 mb-3">
          <span>{clip.clipStart.toFixed(1)}s → {clip.clipEnd.toFixed(1)}s</span>
          {clip.productPlacements && clip.productPlacements.length > 0 && (
            <>
              <span>•</span>
              <span>{clip.productPlacements.length} placement{clip.productPlacements.length !== 1 ? "s" : ""}</span>
            </>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {clipSrc && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowPlayer(!showPlayer)}
                className="flex-1 text-purple-400 hover:text-purple-300 hover:bg-purple-500/10 text-xs"
              >
                <Play className="w-3.5 h-3.5 mr-1.5" />
                {showPlayer ? "Hide Player" : "Play Clip"}
              </Button>
              <a
                href={`/api/remix/clips/${clip.id}/download`}
                download
                className="flex-1"
              >
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 text-xs"
                >
                  <Download className="w-3.5 h-3.5 mr-1.5" />
                  Download
                </Button>
              </a>
            </>
          )}
          {onReRender && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowEditor(!showEditor)}
              className="text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 text-xs"
            >
              <Pencil className="w-3.5 h-3.5 mr-1" />
              Edit
            </Button>
          )}
          {clip.status === "pending_review" && (
            <>
              <Button size="sm" variant="ghost" onClick={onApprove} className="text-green-400 hover:text-green-300 hover:bg-green-500/10">
                <ThumbsUp className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={onReject} className="text-red-400 hover:text-red-300 hover:bg-red-500/10">
                <ThumbsDown className="w-3.5 h-3.5" />
              </Button>
            </>
          )}
        </div>

        {/* Edit panel (Phase 2C) */}
        {showEditor && onReRender && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            className="mt-3 pt-3 border-t border-gray-700/50 space-y-3"
          >
            {/* Trim controls */}
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="text-[10px] text-gray-500 block mb-1">Start (s)</label>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditStart(Math.max(0, editStart - 0.5))}
                    className="text-gray-400 hover:text-white p-0.5"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <input
                    type="number"
                    step="0.5"
                    value={editStart.toFixed(1)}
                    onChange={(e) => setEditStart(parseFloat(e.target.value) || 0)}
                    className="w-16 bg-gray-700 text-white text-xs rounded px-2 py-1 border border-gray-600 text-center"
                  />
                  <button
                    onClick={() => setEditStart(editStart + 0.5)}
                    className="text-gray-400 hover:text-white p-0.5"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-gray-500 block mb-1">End (s)</label>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditEnd(Math.max(editStart + 1, editEnd - 0.5))}
                    className="text-gray-400 hover:text-white p-0.5"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <input
                    type="number"
                    step="0.5"
                    value={editEnd.toFixed(1)}
                    onChange={(e) => setEditEnd(parseFloat(e.target.value) || 0)}
                    className="w-16 bg-gray-700 text-white text-xs rounded px-2 py-1 border border-gray-600 text-center"
                  />
                  <button
                    onClick={() => setEditEnd(editEnd + 0.5)}
                    className="text-gray-400 hover:text-white p-0.5"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>

            {/* Trim change indicator */}
            {(editStart !== clip.clipStart || editEnd !== clip.clipEnd) && (
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-gray-600">Original: {clip.clipStart.toFixed(1)}s-{clip.clipEnd.toFixed(1)}s</span>
                <span className="text-amber-400">
                  {editStart < clip.clipStart ? `+${(clip.clipStart - editStart).toFixed(1)}s earlier` : editStart > clip.clipStart ? `-${(editStart - clip.clipStart).toFixed(1)}s trimmed` : ""}
                  {editEnd !== clip.clipEnd ? ` / end ${editEnd > clip.clipEnd ? `+${(editEnd - clip.clipEnd).toFixed(1)}s` : `-${(clip.clipEnd - editEnd).toFixed(1)}s`}` : ""}
                </span>
              </div>
            )}

            {/* Caption + platform controls */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-gray-500">Captions</label>
                <button
                  onClick={() => setEditCaptions(!editCaptions)}
                  className={`w-8 h-4 rounded-full transition-colors ${editCaptions ? "bg-purple-500" : "bg-gray-600"}`}
                >
                  <div className={`w-3 h-3 rounded-full bg-white transform transition-transform ${editCaptions ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </div>
              {editCaptions && (
                <select
                  value={editCaptionStyle}
                  onChange={(e) => setEditCaptionStyle(e.target.value)}
                  className="bg-gray-700 text-gray-300 text-[10px] rounded px-2 py-1 border border-gray-600"
                >
                  <option value="highlight">Highlight</option>
                  <option value="brand_callout">Brand Callout</option>
                  <option value="narrative">Narrative</option>
                </select>
              )}
              <select
                value={editPlatform}
                onChange={(e) => setEditPlatform(e.target.value)}
                className="bg-gray-700 text-gray-300 text-[10px] rounded px-2 py-1 border border-gray-600"
              >
                {Object.entries(PLATFORM_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>

            {/* Re-render button */}
            <Button
              size="sm"
              onClick={async () => {
                setIsReRendering(true);
                await onReRender(clip.id, {
                  newStart: editStart !== clip.clipStart ? editStart : undefined,
                  newEnd: editEnd !== clip.clipEnd ? editEnd : undefined,
                  captionsEnabled: editCaptions,
                  captionStyle: editCaptionStyle,
                  platformTarget: editPlatform !== clip.platformTarget ? editPlatform : undefined,
                });
                setIsReRendering(false);
                setShowEditor(false);
              }}
              disabled={isReRendering}
              className="w-full bg-amber-600 hover:bg-amber-500 text-white text-xs"
            >
              {isReRendering ? (
                <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Re-rendering...</>
              ) : (
                <><RotateCcw className="w-3 h-3 mr-1" /> Re-render Clip</>
              )}
            </Button>
          </motion.div>
        )}
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
