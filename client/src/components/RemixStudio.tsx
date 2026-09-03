import { useState, useEffect, useCallback, useRef } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
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
import { useJobPoll } from "@/hooks/use-job-poll";
import EditorialClips from "@/components/EditorialClips";
import RemixCopilot from "@/components/RemixCopilot";
import DistributionDashboard from "@/components/DistributionDashboard";

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

// Auto-Remix and Highlight Reel are HIDDEN, not removed — product call
// (2026-08-05): story clips are the one path until they're perfect.
// All state, polling and render code stays live behind this flag so
// re-enabling is a one-line change and in-flight jobs still resolve.
const SHOW_LEGACY_TABS = false;
const isTerminalStatus = (status?: string | null) =>
  !!status && TERMINAL_STATUSES.includes(status);

export default function RemixStudio({ videoId, open, onClose }: RemixStudioProps) {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<RemixJob[]>([]);
  const [clips, setClips] = useState<GeneratedClip[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);

  // Config state
  const [platforms, setPlatforms] = useState<string[]>(["tiktok", "youtube_shorts"]);
  const [maxClips, setMaxClips] = useState(5);
  const [remixKeywords, setRemixKeywords] = useState("");
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
  // Which store the target lives in; editorial targets carry the full row
  // (Apply actions need its bounds since RemixStudio doesn't hold that list)
  const [copilotClipType, setCopilotClipType] = useState<"remix" | "editorial">("remix");
  const [copilotEditorialClip, setCopilotEditorialClip] = useState<any | null>(null);
  const [editorialRefreshKey, setEditorialRefreshKey] = useState(0);
  const [showDistribution, setShowDistribution] = useState(false);
  const [publishTarget, setPublishTarget] = useState<{ id: number; clipSource: "remix" | "editorial" } | null>(null);

  // Load existing jobs, clips, and stitch plans
  const loadData = useCallback(async (): Promise<GeneratedClip[]> => {
    setIsLoading(true);
    let loadedClips: GeneratedClip[] = [];
    try {
      const [jobsRes, clipsRes, stitchRes] = await Promise.all([
        fetchWithTimeout(`/api/remix/video/${videoId}/jobs`, { credentials: "include" }),
        fetchWithTimeout(`/api/remix/clips/${videoId}`, { credentials: "include" }),
        fetchWithTimeout(`/api/remix/${videoId}/stitch-plans`, { credentials: "include" }),
      ]);
      if (jobsRes.ok) setJobs(await jobsRes.json());
      if (clipsRes.ok) {
        loadedClips = await clipsRes.json();
        setClips(loadedClips);
        // Auto-set copilot clip ID to latest clip if not already set
        if (loadedClips.length > 0) {
          setCopilotClipId(prev => {
            if (prev == null) setCopilotClipType("remix");
            return prev ?? loadedClips[loadedClips.length - 1].id;
          });
        }
      }
      if (stitchRes.ok) setStitchPlans(await stitchRes.json());
    } catch (err) {
      console.error("Failed to load remix data:", err);
    }
    setIsLoading(false);
    return loadedClips;
  }, [videoId]);

  // Re-renders run in the background and usually outlast a single fixed
  // wait — reload on a backoff schedule and retarget the copilot to the
  // newest clip once it lands.
  const scheduleReloads = useCallback(() => {
    const delays = [3000, 8000, 15000, 30000];
    // The clips endpoint returns newest-first, so "newest" = max id, and we
    // only retarget when a clip NEWER than the first reload's newest appears
    // — otherwise a manual click-to-select made in the interim would be
    // stomped 30s later.
    let baselineMaxId: number | null = null;
    delays.forEach((ms, i) => {
      setTimeout(async () => {
        const loaded = await loadData();
        const maxId = loaded.reduce((m, c) => Math.max(m, c.id), 0);
        if (i === 0) {
          baselineMaxId = maxId;
        } else if (i === delays.length - 1 && baselineMaxId !== null && maxId > baselineMaxId) {
          setCopilotClipId(maxId);
        }
      }, ms);
    });
  }, [loadData]);

  // Handle co-pilot suggestion application (Phase 4)
  const handleApplySuggestion = useCallback((suggestion: any) => {
    const { type, data } = suggestion;

    // Editorial-tab targets: Apply maps to editorial equivalents. Trim and
    // hook create a NEW rendered story clip at the suggested bounds;
    // platform_switch re-renders in the mapped aspect. Video-scoped actions
    // (add_placement, generate_asset) fall through to the shared cases.
    if (copilotClipType === "editorial" && ["trim", "hook_improvement", "caption_edit", "platform_switch"].includes(type)) {
      const eClip = copilotEditorialClip;
      if (!eClip) {
        toast({ title: "No story clip selected", description: "Select an story clip first.", variant: "destructive" });
        return;
      }
      if (type === "trim" || type === "hook_improvement") {
        // Assembled clips: clipStart/clipEnd is the source ENVELOPE (min/max
        // across non-contiguous beats) and the copilot only sees envelope
        // times — posting them as a contiguous range would render the whole
        // span including the material the assembly cut out. Same guard as
        // onGenerateClip below.
        if (Array.isArray(eClip.segments) && eClip.segments.length > 1) {
          toast({
            title: "Assembled clip",
            description: "Trim suggestions can't be applied to a multi-beat narrative clip yet — use platform re-targeting, or generate a fresh cut from search.",
          });
          return;
        }
        const newStart = type === "trim" ? data.newStart : data.alternativeStart;
        const newEnd = type === "trim" ? data.newEnd : eClip.clipEnd;
        if (typeof newStart !== "number" || typeof newEnd !== "number" || newEnd <= newStart) {
          toast({ title: "Cannot apply", description: "Suggestion has no usable time range", variant: "destructive" });
          return;
        }
        fetchWithTimeout(`/api/videos/${videoId}/editorial-clip/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            clipStart: newStart,
            clipEnd: newEnd,
            suggestedTitle: `${eClip.suggestedTitle || "Clip"} (${type === "trim" ? "trimmed" : "new hook"})`,
            topicTags: eClip.topicTags || [],
            reasoning: suggestion.reason,
            scores: eClip.scores || null,
            compositeScore: eClip.finalScore || 0.7,
          }),
        }).then(async (res) => {
          if (res.ok) {
            // Retarget the copilot to the NEW clip — otherwise "tighten it
            // more" keeps re-cutting from the original bounds.
            const json = await res.json().catch(() => null);
            if (json?.clip?.id) {
              setCopilotClipId(json.clip.id);
              setCopilotEditorialClip(json.clip);
            }
            toast({ title: "New cut rendering", description: "A new story clip with the suggested bounds is rendering — the copilot now targets it." });
            setEditorialRefreshKey((k) => k + 1);
          } else {
            toast({ title: "Apply failed", description: "Could not create the new cut", variant: "destructive" });
          }
        });
        return;
      }
      if (type === "platform_switch") {
        const target = String(data.betterPlatform || "");
        const aspect = ["youtube", "twitter", "linkedin"].includes(target) ? "16:9" : "9:16";
        fetchWithTimeout(`/api/editorial-clips/${eClip.id}/rerender`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ aspect }),
        }).then((res) => {
          if (res.ok) {
            toast({ title: `Re-rendering as ${aspect}`, description: `Re-targeting for ${target}` });
            setEditorialRefreshKey((k) => k + 1);
          } else if (res.status === 404) {
            // Re-analysis deletes and re-mints clip rows — the target is gone.
            setCopilotClipId(undefined);
            setCopilotEditorialClip(null);
            toast({ title: "Clip no longer exists", description: "It was replaced (e.g. by re-analysis). Pick a new copilot target from the list.", variant: "destructive" });
            setEditorialRefreshKey((k) => k + 1);
          } else {
            toast({ title: "Re-render failed", description: "Try again when the clip finishes rendering", variant: "destructive" });
          }
        });
        return;
      }
      // caption_edit: editorial renders always burn the karaoke style
      toast({ title: "Captions on story clips", description: "Editorial clips use the word-highlight caption style automatically; style variants apply to Auto-Remix clips." });
      return;
    }

    switch (type) {
      case "trim":
      case "hook_improvement": {
        if (!copilotClipId) {
          toast({ title: "No clip selected", description: "Generate or select a clip first to apply this suggestion.", variant: "destructive" });
          break;
        }
        const newStart = type === "trim" ? data.newStart : data.alternativeStart;
        const newEnd = type === "trim" ? data.newEnd : undefined;
        fetchWithTimeout(`/api/remix/clips/${copilotClipId}/re-render`, {
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
            scheduleReloads();
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
        fetchWithTimeout(`/api/remix/clips/${copilotClipId}/re-render`, {
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
            scheduleReloads();
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
        fetchWithTimeout(`/api/remix/clips/${copilotClipId}/re-render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            platformTarget: data.betterPlatform,
          }),
        }).then((res) => {
          if (res.ok) {
            toast({ title: "Re-rendering", description: `Re-targeting clip for ${data.betterPlatform}` });
            scheduleReloads();
          } else {
            toast({ title: "Re-render failed", description: "Could not switch platform. Try again.", variant: "destructive" });
          }
        });
        break;
      }
      case "add_placement": {
        if (!data?.surfaceId || !data?.productId) {
          toast({ title: "Placement suggestion", description: suggestion.reason || "Suggestion lacks a surface/product to auto-apply" });
          break;
        }
        (async () => {
          try {
            const catRes = await fetchWithTimeout("/api/brand-products/catalog", { credentials: "include" });
            const catalog = catRes.ok ? await catRes.json() : [];
            const product = (catalog || []).find((p: any) => p.id === data.productId);
            if (!product?.imageUrl) {
              toast({ title: "Cannot apply placement", description: `Product #${data.productId} has no image in the catalog`, variant: "destructive" });
              return;
            }
            const res = await fetchWithTimeout("/api/placements", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                videoId,
                surfaceId: data.surfaceId,
                productId: data.productId,
                productImageUrl: product.imageUrl,
                transform: { offsetX: 0, offsetY: 0, scale: 1, rotation: 0, flipH: false },
                blend: { opacity: 100, blendMode: "source-over", shadowEnabled: true, shadowBlur: 12, shadowOffsetX: 0, shadowOffsetY: 8, shadowColor: "rgba(0,0,0,0.5)", featherRadius: 2, brightness: 0, contrast: 0 },
              }),
            });
            if (res.ok) {
              toast({ title: "Placement saved", description: `${data.productName || "Product"} placed on surface #${data.surfaceId} — fine-tune in the Placement editor` });
            } else {
              const err = await res.json().catch(() => ({}));
              toast({ title: "Placement failed", description: err.error || "Could not save placement", variant: "destructive" });
            }
          } catch {
            toast({ title: "Placement failed", description: "Network error", variant: "destructive" });
          }
        })();
        break;
      }
      case "generate_asset": {
        const surfaceId = data?.targetSurface;
        const productId = data?.productId;
        if (!surfaceId || !productId) {
          toast({ title: "Asset suggestion", description: `${suggestion.reason} (needs a target surface + product to auto-generate)` });
          break;
        }
        toast({ title: "Generating asset", description: "AI asset generation started — this can take ~30s" });
        fetchWithTimeout("/api/generate/product-asset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ videoId, surfaceId, brandProductId: productId }),
        })
          .then(async (res) => {
            if (res.ok) {
              toast({ title: "Asset generated", description: "Product asset created for the target surface" });
            } else {
              const err = await res.json().catch(() => ({}));
              toast({ title: "Asset generation failed", description: err.error || "Generation failed", variant: "destructive" });
            }
          })
          .catch(() => toast({ title: "Asset generation failed", description: "Network error", variant: "destructive" }));
        break;
      }
      case "stitch": {
        // The copilot's highlight-reel proposal — the embodiment of the
        // "assembled narrative" promise. Its Apply button used to fall through
        // to `default` and do nothing but toast. The beats it returns
        // (additionalSegments) already carry the {start,end} the /stitch
        // endpoint needs, so this drives the exact endpoint + poll the manual
        // Highlight Reel tab uses.
        const beats = Array.isArray(data?.additionalSegments) ? data.additionalSegments : [];
        const valid = beats.filter(
          (s: any) => typeof s?.start === "number" && typeof s?.end === "number" && s.end > s.start,
        );
        if (valid.length < 2) {
          toast({ title: "Not enough segments", description: "This highlight-reel suggestion needs at least two valid beats.", variant: "destructive" });
          break;
        }
        setIsStitching(true);
        fetchWithTimeout(`/api/remix/${videoId}/stitch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            segments: valid,
            transitions: data?.suggestedTransition ?? "crossfade",
            platformTarget: stitchPlatform,
            captionsEnabled,
          }),
        })
          .then(async (res) => {
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.error || "Stitch failed");
            toast({ title: "Building highlight reel", description: `Plan #${body.planId} — stitching ${valid.length} beats` });
            // Tracked by the shared stitch job poll (cleans up on close).
            setStitchJobId(body.planId);
          })
          .catch((err: any) => {
            setIsStitching(false);
            toast({ title: "Stitch failed", description: err?.message || "Network error", variant: "destructive" });
          });
        break;
      }
      default:
        toast({ title: "Suggestion noted", description: suggestion.reason });
    }
  }, [copilotClipId, copilotClipType, copilotEditorialClip, toast, loadData, scheduleReloads, videoId, stitchPlatform, captionsEnabled]);

  useEffect(() => {
    if (open) loadData();
    // NO interval cleanup here. `pollInterval` is not in this effect's dep
    // list, so the returned closure captured whatever the handle was on the
    // render this effect last ran — closing and reopening the studio mid-job
    // cleared the WRONG interval and the poll never came back, leaving the
    // job frozen at whatever step it was on when you looked away. The poll
    // effect below owns its own interval and clears it correctly.
  }, [open, loadData]);

  // If the jobs list already shows this job as finished (e.g. it completed
  // while the studio was closed), stop treating it as active.
  useEffect(() => {
    if (!activeJobId) return;
    const job = jobs.find((j) => j.id === activeJobId);
    if (job && isTerminalStatus(job.status)) setActiveJobId(null);
  }, [jobs, activeJobId]);

  // Stitch (highlight reel) completion — one poll for both the copilot and
  // manual paths. The two bare setInterval loops this replaces were never
  // cleared, so closing the studio mid-stitch leaked them.
  const [stitchJobId, setStitchJobId] = useState<number | null>(null);
  useJobPoll<{ errorMessage?: string | null }>(stitchJobId ? { kind: "stitch", id: stitchJobId } : null, {
    intervalMs: 3000,
    maxMs: 30 * 60_000,
    onTerminal: async (view) => {
      setStitchJobId(null);
      setIsStitching(false);
      await loadData();
      toast(
        view.state === "succeeded"
          ? { title: "Highlight Reel Ready", description: "Your stitched clip has been generated" }
          : { title: "Stitch Failed", description: view.error || "Generation failed", variant: "destructive" },
      );
    },
    onTimeout: () => {
      setStitchJobId(null);
      setIsStitching(false);
      toast({ title: "Still stitching", description: "Check Clips & Reels in a few minutes." });
    },
  });

  // Poll active job
  useEffect(() => {
    if (!activeJobId) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetchWithTimeout(`/api/remix/jobs/${activeJobId}`, { credentials: "include" });
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
            // Completion used to be silent — the only evidence was a badge in
            // a collapsed list, which is why "it said complete" and "I see no
            // output" were both true at once.
            const produced = data.clips?.length ?? 0;
            if (data.job.status === "completed" && produced > 0) {
              if (SHOW_LEGACY_TABS) setActiveTab("auto");
              toast({
                title: `${produced} clip${produced === 1 ? "" : "s"} ready`,
                description: "Job #" + data.job.id + " finished — they're in the Auto-Remix tab.",
              });
            } else if (data.job.status === "failed") {
              if (SHOW_LEGACY_TABS) setActiveTab("auto");
              toast({
                title: `Job #${data.job.id} produced no clips`,
                description: data.job.errorMessage || "The render step failed. Details are on the job below.",
                variant: "destructive",
              });
            }
          }
        }
      } catch {}
    }, 3000);

    return () => clearInterval(interval);
  }, [activeJobId]);

  const startRemix = async () => {
    setIsStarting(true);
    const attemptStart = async () => {
      const res = await fetchWithTimeout(`/api/remix/${videoId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          platformTargets: platforms,
          maxClips,
          captionsEnabled,
          editorialMode: true,
          ...(remixKeywords.trim() ? { keywords: remixKeywords.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        const err: any = new Error(data.error || "Failed to start remix");
        err.status = res.status;
        err.body = data;
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

        const analyzeRes = await fetchWithTimeout(`/api/scenes/${videoId}/analyze`, {
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
      if (err?.status === 409 && err?.body?.activeJobId) {
        // A remix is already running (started elsewhere, or before a reload).
        // Adopt it instead of reporting an error the creator cannot act on.
        setActiveJobId(err.body.activeJobId);
        toast({ title: "Remix already running", description: `Job #${err.body.activeJobId} is in progress — tracking it here.` });
      } else {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    }
    setIsStarting(false);
  };

  const approveClip = async (clipId: number) => {
    try {
      const res = await fetchWithTimeout(`/api/remix/clips/${clipId}/approve`, {
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
      const res = await fetchWithTimeout(`/api/remix/clips/${clipId}/reject`, {
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
      const res = await fetchWithTimeout(`/api/remix/${videoId}/narrative-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ targetDuration: 110, segmentCount: 5 }),
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
      const res = await fetchWithTimeout(`/api/remix/${videoId}/stitch`, {
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
      // Tracked by the shared stitch job poll (cleans up on close).
      setStitchJobId(data.planId);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setIsStitching(false);
    }
  };

  // Re-render clip (Phase 2C)
  const reRenderClip = async (clipId: number, mods: { newStart?: number; newEnd?: number; captionsEnabled?: boolean; captionStyle?: string; platformTarget?: string }) => {
    try {
      const res = await fetchWithTimeout(`/api/remix/clips/${clipId}/re-render`, {
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

            {/* Tab Switcher — Story clips vs Auto-Remix */}
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
                Story clips
              </button>
              {SHOW_LEGACY_TABS && (
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
              )}
              {SHOW_LEGACY_TABS && (
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
              )}
            </div>

            {/* Story clips Tab — transcript-first viral clip identification */}
            {/* Always rendered, hidden via CSS to preserve state across tab switches */}
            <div className={activeTab === "editorial" ? "block" : "hidden"}>
              <p className="text-xs text-gray-500 mb-3">
                AI-identified viral moments ranked by editorial quality. Click "Generate" to create a clip from any moment.
              </p>
              <EditorialClips
                videoId={videoId}
                key={editorialRefreshKey}
                mode="remix"
                // A rendered clip had no route to publishing from here — the
                // Distribution hub lived elsewhere and did not list editorial
                // clips at all. This opens it directly on this video.
                onPublishClip={(clip) => {
                  // Carry the clip through so the hub opens on Publish with
                  // THIS clip selected, not on an unselected overview.
                  setPublishTarget(clip.id ? { id: clip.id, clipSource: "editorial" } : null);
                  setShowDistribution(true);
                }}
                onSelectForCopilot={(clip: any) => {
                  if (!clip?.id) {
                    toast({ title: "Clip not saved yet", description: "Only saved clips can be copilot targets." });
                    return;
                  }
                  setCopilotClipId(clip.id);
                  setCopilotClipType("editorial");
                  setCopilotEditorialClip(clip);
                  toast({ title: "Copilot target set", description: `"${clip.suggestedTitle || `Clip #${clip.id}`}" — ask the copilot or apply its suggestions.` });
                }}
                onGenerateClip={(clip) => {
                  // Renders go through the EDITORIAL pipeline and land on the
                  // story clip row itself. This used to start an Auto-Remix
                  // job whose output lived in a different table shown in a
                  // different (now hidden) tab — which is how "generate" could
                  // succeed while the creator saw nothing appear here.
                  const clipId = (clip as any).id;
                  const req = clipId
                    ? fetchWithTimeout(`/api/editorial-clips/${clipId}/rerender`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        credentials: "include",
                        body: JSON.stringify({ aspect: (clip as any).aspectRatio === "16:9" ? "16:9" : "9:16" }),
                      })
                    : fetchWithTimeout(`/api/videos/${videoId}/editorial-clip/render`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        credentials: "include",
                        body: JSON.stringify({
                          clipStart: clip.clipStart,
                          clipEnd: clip.clipEnd,
                          suggestedTitle: clip.suggestedTitle,
                          topicTags: clip.topicTags,
                          reasoning: clip.reasoning,
                          scores: clip.scores,
                          compositeScore: clip.finalScore,
                          segments: (clip as any).segments ?? undefined,
                        }),
                      });
                  toast({
                    title: "Rendering clip",
                    description: `"${clip.suggestedTitle || "Clip"}" — it appears in this list when ready.`,
                  });
                  req
                    .then(async (res) => {
                      if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        toast({ title: "Render failed", description: err.error || "Try again", variant: "destructive" });
                        return;
                      }
                      setEditorialRefreshKey((k) => k + 1);
                    })
                    .catch((err) => {
                      toast({ title: "Render failed", description: err.message, variant: "destructive" });
                    });
                }}
              />
            </div>

            {/* Auto-Remix Tab — existing config + generation flow */}
            {SHOW_LEGACY_TABS && (
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

                  {/* Theme / keywords — steers the AI toward specific storylines */}
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Theme or keywords (optional)</label>
                    <input
                      type="text"
                      value={remixKeywords}
                      onChange={(e) => setRemixKeywords(e.target.value)}
                      placeholder="e.g. money advice, the childhood story, funniest moments"
                      maxLength={200}
                      data-testid="remix-keywords-input"
                      className="w-full bg-gray-700 text-white text-sm rounded-lg px-3 py-2 border border-gray-600 placeholder:text-gray-500 focus:border-purple-500 focus:outline-none"
                    />
                    <p className="text-[11px] text-gray-500 mt-1">
                      The AI finds beats in the transcript matching your theme and builds clips around them. Leave blank for the best overall moments.
                    </p>
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
                        await fetchWithTimeout(`/api/remix/jobs/${id}/cancel`, {
                          method: "POST",
                          credentials: "include",
                        });
                      } catch {}
                      setActiveJobId(null);
                      // Refresh so the jobs array picks up the terminal
                      // "cancelled" status — otherwise the stale non-terminal
                      // snapshot keeps activeJob truthy until remount.
                      await loadData();
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
                      isSelected={copilotClipId === clip.id}
                      onSelect={() => { setCopilotClipId(clip.id); setCopilotClipType("remix"); setCopilotEditorialClip(null); }}
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
                    <div key={job.id} className="bg-gray-800/50 rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge className={`${job.status === "completed" ? "bg-green-500/20 text-green-400" : job.status === "cancelled" ? "bg-gray-500/20 text-gray-400" : "bg-red-500/20 text-red-400"}`}>
                            {job.status}
                          </Badge>
                          <span className="text-sm text-gray-400">
                            Job #{job.id} — {job.platformTargets?.join(", ")}
                          </span>
                          {job.status === "completed" && (
                            <span className="text-xs text-gray-500">
                              {job.clipCount ?? 0} clip{(job.clipCount ?? 0) === 1 ? "" : "s"}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-gray-500">
                          {new Date(job.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      {job.errorMessage && (
                        <p className="text-xs text-red-300/80 mt-2 leading-snug">{job.errorMessage}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Empty state.
                The `jobs.length === 0` term used to be part of this guard, so
                the moment any job row existed BOTH result surfaces were hidden
                — a finished job with zero clips rendered literally nothing and
                the tab looked like it had never been used. */}
            {!isLoading && clips.length === 0 && !isProcessing && (() => {
              const lastTerminal = jobs.filter((j) => isTerminalStatus(j.status))[0];
              if (!lastTerminal) {
                return (
                  <div className="text-center py-12">
                    <Scissors className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                    <p className="text-gray-400 mb-1">No clips generated yet</p>
                    <p className="text-xs text-gray-500">
                      Select your target platforms above and click "Start Auto-Remix" to generate clips
                    </p>
                  </div>
                );
              }
              return (
                <div className="text-center py-10 px-6 border border-red-500/20 bg-red-500/5 rounded-lg">
                  <AlertCircle className="w-10 h-10 text-red-400/70 mx-auto mb-3" />
                  <p className="text-gray-200 mb-1 font-medium">
                    Job #{lastTerminal.id} finished without producing any clips
                  </p>
                  {lastTerminal.errorMessage ? (
                    <p className="text-xs text-red-300/90 max-w-md mx-auto leading-relaxed">
                      {lastTerminal.errorMessage}
                    </p>
                  ) : (
                    <p className="text-xs text-gray-400 max-w-md mx-auto leading-relaxed">
                      No reason was recorded. Re-run the remix — the pipeline now writes the
                      failure onto the job.
                    </p>
                  )}
                  <p className="text-[11px] text-gray-500 mt-3">
                    Clips from the transcript pipeline live in the <strong>Story clips</strong> tab,
                    not here — check there if you were expecting those.
                  </p>
                </div>
              );
            })()}
            </>
            </div>
            )}{/* end auto-remix tab */}

            {/* Highlight Reel Tab — Phase 2B multi-segment stitching */}
            {SHOW_LEGACY_TABS && (
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
              </div>
            )}{/* end highlight reel tab */}
          </div>

          {/* AI Co-Pilot Side Panel — always visible */}
          <div className="w-[380px] flex-shrink-0 h-full overflow-hidden">
            <RemixCopilot
              videoId={videoId}
              clipId={copilotClipId}
              clipType={copilotClipType}
              clipLabel={(() => {
                if (copilotClipType === "editorial") {
                  const e = copilotEditorialClip;
                  return e ? `Editorial · ${e.suggestedTitle || `#${e.id}`}` : undefined;
                }
                const target = clips.find(c => c.id === copilotClipId);
                if (!target) return undefined;
                const platform = target.platformTarget || "clip";
                return `Clip #${target.id} · ${platform} · ${(target.clipStart ?? 0).toFixed(0)}–${(target.clipEnd ?? 0).toFixed(0)}s`;
              })()}
              open={true}
              onClose={() => {}}
              onApplySuggestion={handleApplySuggestion}
              inline={true}
            />
          </div>

          </div>{/* end two-panel layout */}
        </motion.div>

        {/* Distribution, opened by a clip's Publish button. Mounted here so the
            creator never has to leave the studio to send a finished clip. */}
        <DistributionDashboard
          videoId={videoId}
          open={showDistribution}
          initialClip={publishTarget}
          onClose={() => { setShowDistribution(false); setPublishTarget(null); }}
        />
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
                  const res = await fetchWithTimeout(`/api/remix/stitch-plans/${plan.id}`, {
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

/**
 * TrimTimeline — visual trim editing (Timeline UI v1). A draggable range
 * over a window of the source: grab the start/end handles or the body to
 * move the whole selection. Fine-tuning stays on the ±0.5s steppers below.
 */
function TrimTimeline({
  windowStart,
  windowEnd,
  start,
  end,
  originalStart,
  originalEnd,
  onChange,
}: {
  windowStart: number;
  windowEnd: number;
  start: number;
  end: number;
  originalStart: number;
  originalEnd: number;
  onChange: (start: number, end: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: "start" | "end" | "move"; grabOffset: number } | null>(null);

  const span = Math.max(1, windowEnd - windowStart);
  const pct = (t: number) => ((t - windowStart) / span) * 100;
  const timeAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return start;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return windowStart + frac * span;
  };

  const beginDrag = (mode: "start" | "end" | "move") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Capture the pointer so the drag survives leaving the window, and end on
    // pointercancel too — a scroll-stolen touch otherwise leaks the window
    // listeners and the selection keeps tracking a pointer that's gone.
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    dragRef.current = { mode, grabOffset: timeAt(e.clientX) - start };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const t = timeAt(ev.clientX);
      if (d.mode === "start") {
        onChange(Math.min(Math.max(windowStart, t), end - 1), end);
      } else if (d.mode === "end") {
        onChange(start, Math.max(Math.min(windowEnd, t), start + 1));
      } else {
        const dur = end - start;
        let ns = t - d.grabOffset;
        ns = Math.max(windowStart, Math.min(ns, windowEnd - dur));
        onChange(ns, ns + dur);
      }
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // Tick marks every ~10s, denser for short windows
  const tickStep = span > 120 ? 30 : span > 40 ? 10 : 5;
  const ticks: number[] = [];
  for (let t = Math.ceil(windowStart / tickStep) * tickStep; t <= windowEnd; t += tickStep) ticks.push(t);

  return (
    <div className="select-none" data-testid="trim-timeline">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-gray-500">Drag handles to trim · drag middle to move</span>
        <span className="text-[10px] text-purple-300 font-medium">{(end - start).toFixed(1)}s selected</span>
      </div>
      <div ref={barRef} className="relative h-9 rounded-md bg-gray-900/80 border border-gray-700/60 overflow-hidden cursor-crosshair touch-none">
        {/* Original clip range (ghost) */}
        <div
          className="absolute top-0 bottom-0 bg-gray-600/20 pointer-events-none"
          style={{ left: `${pct(originalStart)}%`, width: `${Math.max(0, pct(originalEnd) - pct(originalStart))}%` }}
        />
        {/* Selection */}
        <div
          className="absolute top-0 bottom-0 bg-purple-500/30 border-x-2 border-purple-400 cursor-grab active:cursor-grabbing"
          style={{ left: `${pct(start)}%`, width: `${Math.max(0.5, pct(end) - pct(start))}%` }}
          onPointerDown={beginDrag("move")}
        />
        {/* Handles */}
        <div
          className="absolute top-0 bottom-0 w-3 -ml-1.5 cursor-ew-resize z-10 flex items-center justify-center"
          style={{ left: `${pct(start)}%` }}
          onPointerDown={beginDrag("start")}
          data-testid="trim-handle-start"
        >
          <div className="w-1 h-5 rounded bg-purple-300" />
        </div>
        <div
          className="absolute top-0 bottom-0 w-3 -ml-1.5 cursor-ew-resize z-10 flex items-center justify-center"
          style={{ left: `${pct(end)}%` }}
          onPointerDown={beginDrag("end")}
          data-testid="trim-handle-end"
        >
          <div className="w-1 h-5 rounded bg-purple-300" />
        </div>
        {/* Ticks */}
        {ticks.map((t) => (
          <div key={t} className="absolute bottom-0 h-2 w-px bg-gray-600 pointer-events-none" style={{ left: `${pct(t)}%` }} />
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-gray-600 mt-0.5">
        <span>{windowStart.toFixed(0)}s</span>
        <span className="text-purple-300">{start.toFixed(1)}s → {end.toFixed(1)}s</span>
        <span>{windowEnd.toFixed(0)}s</span>
      </div>
    </div>
  );
}

function ClipCard({
  clip,
  isSelected,
  onSelect,
  onApprove,
  onReject,
  onReRender,
}: {
  clip: GeneratedClip;
  isSelected?: boolean;
  onSelect?: () => void;
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
  // Editorial rows in the union list share ids with remix rows; the download
  // endpoint needs ?source=editorial to pick the right table.
  const downloadHref = `/api/remix/clips/${clip.id}/download${(clip as any).clipSource === "editorial" ? "?source=editorial" : ""}`;
  const clipSrc = clip.exportPath
    ? clip.exportPath.startsWith("/storage/")
      ? clip.exportPath
      : downloadHref
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
      onClick={onSelect}
      className={`bg-gray-800/60 rounded-xl border overflow-hidden relative ${onSelect ? "cursor-pointer" : ""} ${
        isSelected ? "border-violet-500 ring-1 ring-violet-500/50" : "border-gray-700/50"
      }`}
      data-testid={`clip-card-${clip.id}`}
    >
      {isSelected && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-600 text-white text-[10px] font-medium shadow">
          <Sparkles className="w-3 h-3" /> Copilot target
        </div>
      )}
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
                href={downloadHref}
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
            {/* Visual timeline trim (v1) — steppers below remain for fine-tuning */}
            <TrimTimeline
              windowStart={Math.max(0, clip.clipStart - 30)}
              windowEnd={clip.clipEnd + 30}
              start={editStart}
              end={editEnd}
              originalStart={clip.clipStart}
              originalEnd={clip.clipEnd}
              onChange={(ns, ne) => {
                setEditStart(Math.round(ns * 10) / 10);
                setEditEnd(Math.round(ne * 10) / 10);
              }}
            />

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
