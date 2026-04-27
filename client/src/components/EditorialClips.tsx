/**
 * EditorialClips — Reusable component displaying ranked editorial clips for a video.
 *
 * Used by:
 * - Creator Library (Insights modal) — with transcribe/analyze controls
 * - RemixStudio — with "Generate This Clip" action
 * - BrandMarketplace — read-only view with "Buy Placement" action
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, Clock, TrendingUp, Tag, ChevronDown, ChevronUp,
  Loader2, Mic, Brain, Zap, Eye, Heart, Shield, MessageSquare,
  RefreshCw, Play, DollarSign, Filter, X, Wand2, AlertCircle, Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

// ── Types ──────────────────────────────────────────────────────────

interface RubricScores {
  hookStrength: number;
  narrativeCompleteness: number;
  emotionalArc: number;
  speakerClarity: number;
  surfaceCompatibility: number;
  culturalRelevance: number;
  replayability: number;
}

interface RankedClip {
  id?: number;
  clipStart: number;
  clipEnd: number;
  duration: number;
  editorialScore: number;
  surfaceScore: number;
  brandMatchScore: number;
  finalScore: number;
  monetizationTier: "premium" | "standard" | "organic";
  scores: RubricScores;
  surfaces: any[];
  brandMatches: any[];
  editPoints: { start: number; end: number; adjustments: string[] };
  suggestedTitle: string;
  topicTags: string[];
  reasoning: string;
  rawClipStart: number;
  rawClipEnd: number;
  // Auto-render fields (Editorial Auto-Pipeline)
  exportPath?: string | null;
  thumbnailPath?: string | null;
  aspectRatio?: string | null;
  renderStatus?: "pending" | "rendering" | "rendered" | "failed" | null;
  renderError?: string | null;
}

interface TranscriptStatus {
  status: "none" | "processing" | "completed" | "failed";
  wordCount?: number;
  segmentCount?: number;
  speakerCount?: number;
}

type EditorialStatus =
  | "none"
  | "pending"
  | "transcribing"
  | "analyzing"
  | "rendering"
  | "ready"
  | "failed";

interface EditorialStatusResponse {
  status: EditorialStatus;
  error: string | null;
  totalClips: number;
  renderedClips: number;
  failedClips: number;
  pendingClips: number;
  completedAt: string | null;
  updatedAt: string | null;
}

export interface EditorialClipsProps {
  videoId: number;
  mode: "creator" | "brand" | "remix";
  onGenerateClip?: (clip: RankedClip) => void;
  onBuyPlacement?: (clip: RankedClip) => void;
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function getViralColor(score: number): string {
  if (score >= 0.85) return "text-green-400";
  if (score >= 0.70) return "text-emerald-400";
  if (score >= 0.55) return "text-yellow-400";
  return "text-orange-400";
}

function getViralBg(score: number): string {
  if (score >= 0.85) return "bg-green-500/20 border-green-500/30";
  if (score >= 0.70) return "bg-emerald-500/20 border-emerald-500/30";
  if (score >= 0.55) return "bg-yellow-500/20 border-yellow-500/30";
  return "bg-orange-500/20 border-orange-500/30";
}

function getTierBadge(tier: string): { label: string; className: string } {
  switch (tier) {
    case "premium":
      return { label: "Premium", className: "bg-green-500/20 text-green-400 border-green-500/30" };
    case "standard":
      return { label: "Standard", className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" };
    default:
      return { label: "Organic", className: "bg-gray-500/20 text-gray-400 border-gray-500/30" };
  }
}

// ── Score Bar Component ────────────────────────────────────────────

function ScoreBar({ label, value, icon: Icon }: { label: string; value: number; icon: any }) {
  const pct = Math.round(value * 100);
  const barColor = value >= 0.8 ? "bg-green-500" : value >= 0.6 ? "bg-yellow-500" : "bg-orange-500";

  return (
    <div className="flex items-center gap-2">
      <Icon className="w-3 h-3 text-gray-500 flex-shrink-0" />
      <span className="text-xs text-gray-500 w-20 flex-shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-400 w-8 text-right">{pct}%</span>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────

export default function EditorialClips({ videoId, mode, onGenerateClip, onBuyPlacement }: EditorialClipsProps) {
  const { toast } = useToast();

  const [transcriptStatus, setTranscriptStatus] = useState<TranscriptStatus>({ status: "none" });
  const [clips, setClips] = useState<RankedClip[]>([]);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [isLoadingAnalysis, setIsLoadingAnalysis] = useState(false);
  const [isLoadingSavedClips, setIsLoadingSavedClips] = useState(true);
  const [analysisComplete, setAnalysisComplete] = useState(false);
  const [expandedClip, setExpandedClip] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<"score" | "time" | "duration">("score");
  const [tierFilter, setTierFilter] = useState<"all" | "premium" | "standard" | "organic">("all");
  const [playingClip, setPlayingClip] = useState<RankedClip | null>(null);
  const [autoStatus, setAutoStatus] = useState<EditorialStatusResponse | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<RankedClip[] | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Helpers ────────────────────────────────────────────────────
  const refetchClips = useCallback(async () => {
    try {
      const res = await fetch(`/api/scenes/${videoId}/editorial-clips`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.clips)) {
          setClips(data.clips);
          setAnalysisComplete(data.clips.length > 0);
        }
      }
    } catch {
      /* non-fatal */
    }
  }, [videoId]);

  const fetchAutoStatus = useCallback(async (): Promise<EditorialStatusResponse | null> => {
    try {
      const res = await fetch(`/api/videos/${videoId}/editorial-status`, { credentials: "include" });
      if (!res.ok) return null;
      return (await res.json()) as EditorialStatusResponse;
    } catch {
      return null;
    }
  }, [videoId]);

  // ── Poll editorial auto-pipeline while in-flight ─────────────────
  useEffect(() => {
    let cancelled = false;

    async function tick() {
      const status = await fetchAutoStatus();
      if (cancelled) return;
      if (!status) {
        pollTimerRef.current = setTimeout(tick, 10_000);
        return;
      }
      setAutoStatus(status);

      const inFlight = ["pending", "transcribing", "analyzing", "rendering"].includes(status.status);
      if (inFlight) {
        // Refetch clips every poll so newly-rendered ones appear progressively
        await refetchClips();
        pollTimerRef.current = setTimeout(tick, 5_000);
      } else if (status.status === "ready" || status.status === "failed") {
        await refetchClips();
      }
    }

    tick();

    return () => {
      cancelled = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [videoId, fetchAutoStatus, refetchClips]);

  const handleRegenerate = useCallback(async () => {
    setIsRegenerating(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/editorial-auto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) throw new Error("Failed to start pipeline");
      toast({
        title: "Story-clips regenerating",
        description: "We'll find 10+ new moments and render each as a playable clip.",
      });
      // Update local status optimistically so the banner shows immediately
      setAutoStatus({
        status: "pending",
        error: null,
        totalClips: 0,
        renderedClips: 0,
        failedClips: 0,
        pendingClips: 0,
        completedAt: null,
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
    setIsRegenerating(false);
  }, [videoId, toast]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/editorial-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ query: searchQuery.trim(), maxClips: 10 }),
      });
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      setSearchResults(
        (data.clips || []).map((c: any) => ({
          ...c,
          duration: c.clipEnd - c.clipStart,
          editorialScore: c.compositeScore ?? 0,
          surfaceScore: 0,
          brandMatchScore: 0,
          finalScore: c.compositeScore ?? 0,
          monetizationTier: "organic" as const,
          surfaces: [],
          brandMatches: [],
          editPoints: { start: c.clipStart, end: c.clipEnd, adjustments: [] },
          rawClipStart: c.clipStart,
          rawClipEnd: c.clipEnd,
        }))
      );
      toast({
        title: `Found ${data.clips?.length || 0} clips`,
        description: `Matching "${searchQuery.trim()}"`,
      });
    } catch (err: any) {
      toast({ title: "Search failed", description: err.message, variant: "destructive" });
    }
    setIsSearching(false);
  }, [videoId, searchQuery, toast]);

  // ── Load saved clips + transcript status on mount ─────────────────
  useEffect(() => {
    let cancelled = false;

    async function loadSavedData() {
      // Load both transcript status and saved editorial clips in parallel
      try {
        const [transcriptRes, clipsRes] = await Promise.all([
          fetch(`/api/video/${videoId}/transcript`, { credentials: "include" }),
          fetch(`/api/scenes/${videoId}/editorial-clips`, { credentials: "include" }),
        ]);

        if (cancelled) return;

        // Process transcript
        if (transcriptRes.ok) {
          const data = await transcriptRes.json();
          if (data.status === "completed") {
            setTranscriptStatus({
              status: "completed",
              wordCount: data.wordCount,
              segmentCount: data.segmentCount,
              speakerCount: data.speakerMap ? Object.keys(data.speakerMap).length : 0,
            });
          } else if (data.status === "processing") {
            setTranscriptStatus({ status: "processing" });
          } else if (data.status === "failed") {
            setTranscriptStatus({ status: "failed" });
          } else {
            setTranscriptStatus({ status: "none" });
          }
        }

        // Process saved editorial clips
        if (clipsRes.ok) {
          const data = await clipsRes.json();
          if (data.clips && data.clips.length > 0) {
            setClips(data.clips);
            setAnalysisComplete(true);
          }
        }
      } catch {
        // Non-fatal — component will still work for fresh analysis
      }

      if (!cancelled) setIsLoadingSavedClips(false);
    }

    loadSavedData();
    return () => { cancelled = true; };
  }, [videoId]);

  // ── Transcribe Video ─────────────────────────────────────────────
  const handleTranscribe = async () => {
    setIsLoadingTranscript(true);
    setTranscriptStatus({ status: "processing" });
    try {
      const res = await fetch(`/api/video/${videoId}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ language: "en" }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: "Transcription started", description: "Processing audio with Deepgram..." });
        // Start polling
        const pollTranscript = async () => {
          const checkRes = await fetch(`/api/video/${videoId}/transcript`, { credentials: "include" });
          if (checkRes.ok) {
            const checkData = await checkRes.json();
            if (checkData.status === "completed") {
              setTranscriptStatus({
                status: "completed",
                wordCount: checkData.wordCount,
                segmentCount: checkData.segmentCount,
                speakerCount: checkData.speakerMap ? Object.keys(checkData.speakerMap).length : 0,
              });
              setIsLoadingTranscript(false);
              toast({ title: "Transcription complete", description: `${checkData.wordCount} words, ${checkData.segmentCount} segments` });
              return;
            } else if (checkData.status === "failed") {
              setTranscriptStatus({ status: "failed" });
              setIsLoadingTranscript(false);
              toast({ title: "Transcription failed", description: checkData.errorMessage, variant: "destructive" });
              return;
            }
          }
          setTimeout(pollTranscript, 3000);
        };
        setTimeout(pollTranscript, 5000);
      } else {
        throw new Error(data.error || "Transcription failed");
      }
    } catch (err: any) {
      setTranscriptStatus({ status: "failed" });
      setIsLoadingTranscript(false);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  // ── Analyze Clips ────────────────────────────────────────────────
  const handleAnalyze = async () => {
    setIsLoadingAnalysis(true);
    try {
      const res = await fetch(`/api/scenes/${videoId}/editorial-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ maxClips: 10 }),
      });
      const data = await res.json();
      if (res.ok && data.rankedClips) {
        setClips(data.rankedClips);
        setAnalysisComplete(true);
        // Clips are now saved to the DB by the server — no sessionStorage needed
        toast({
          title: `Found ${data.rankedClips.length} viral clips`,
          description: `${data.moments?.length || 0} moments analyzed`,
        });
      } else {
        throw new Error(data.error || "No clips found");
      }
    } catch (err: any) {
      toast({ title: "Analysis failed", description: err.message, variant: "destructive" });
    }
    setIsLoadingAnalysis(false);
  };

  // ── Sort & Filter ────────────────────────────────────────────────
  const sortedClips = [...clips]
    .filter((c) => tierFilter === "all" || c.monetizationTier === tierFilter)
    .sort((a, b) => {
      if (sortBy === "time") return a.clipStart - b.clipStart;
      if (sortBy === "duration") return b.duration - a.duration;
      return b.finalScore - a.finalScore;
    });

  // ── Tier counts ──────────────────────────────────────────────────
  const tierCounts = {
    premium: clips.filter((c) => c.monetizationTier === "premium").length,
    standard: clips.filter((c) => c.monetizationTier === "standard").length,
    organic: clips.filter((c) => c.monetizationTier === "organic").length,
  };

  // ── Render ───────────────────────────────────────────────────────

  // Brand mode: read-only — brands can only view clips the creator has already generated
  const isBrandMode = mode === "brand";

  // Auto-pipeline banner state
  const inFlight = autoStatus && ["pending", "transcribing", "analyzing", "rendering"].includes(autoStatus.status);
  const autoFailed = autoStatus?.status === "failed";
  const hasUnrenderedClips = autoStatus && autoStatus.pendingClips > 0 && autoStatus.status === "none";
  // Stuck detection: in-flight but DB hasn't been touched in 5+ min — server probably restarted mid-render
  const stuckMs = autoStatus?.updatedAt ? Date.now() - new Date(autoStatus.updatedAt).getTime() : 0;
  const isStuck = Boolean(inFlight && stuckMs > 5 * 60 * 1000 && (autoStatus?.pendingClips ?? 0) > 0);
  // Also offer resume if status is "ready" or "failed" but some clips never finished rendering
  const hasOrphanedClips = Boolean(
    autoStatus &&
      (autoStatus.status === "ready" || autoStatus.status === "failed") &&
      autoStatus.pendingClips > 0
  );
  const canResume = isStuck || hasOrphanedClips;
  const showAutoBanner = inFlight || autoFailed || hasUnrenderedClips || canResume || (autoStatus?.status === "ready" && clips.length > 0);

  const stageLabel: Record<string, string> = {
    pending: "Queued…",
    transcribing: "Transcribing audio…",
    analyzing: "Analyzing for story moments…",
    rendering: "Rendering playable clips…",
    ready: "Story-clips ready",
    failed: "Pipeline failed",
  };
  const stageProgress: Record<string, number> = {
    pending: 5,
    transcribing: 25,
    analyzing: 55,
    rendering: 80,
    ready: 100,
    failed: 100,
  };

  return (
    <div className="space-y-4">
      {/* Auto-Pipeline Banner (Feature A) — shows for all modes when there's auto-pipeline state */}
      {showAutoBanner && autoStatus && (
        <div
          className={`rounded-xl p-4 border ${
            autoFailed
              ? "bg-red-500/10 border-red-500/30"
              : hasUnrenderedClips
              ? "bg-yellow-500/10 border-yellow-500/30"
              : inFlight
              ? "bg-emerald-500/10 border-emerald-500/30"
              : "bg-emerald-500/5 border-emerald-500/20"
          }`}
        >
          <div className="flex items-center gap-3">
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                autoFailed ? "bg-red-500/20" : "bg-emerald-500/20"
              }`}
            >
              {inFlight ? (
                <Loader2 className="w-4 h-4 text-emerald-400 animate-spin" />
              ) : autoFailed ? (
                <AlertCircle className="w-4 h-4 text-red-400" />
              ) : (
                <Wand2 className="w-4 h-4 text-emerald-400" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white">
                  Auto Story-Clips
                </span>
                <span className={`text-xs ${autoFailed ? "text-red-400" : hasUnrenderedClips ? "text-yellow-400" : "text-emerald-400"}`}>
                  {hasUnrenderedClips
                    ? `${autoStatus.pendingClips} clip${autoStatus.pendingClips !== 1 ? "s" : ""} awaiting render`
                    : (stageLabel[autoStatus.status] ?? autoStatus.status)}
                </span>
              </div>
              {inFlight && (
                <div className="mt-1.5 h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                    style={{ width: `${stageProgress[autoStatus.status] ?? 5}%` }}
                  />
                </div>
              )}
              {autoStatus.renderedClips > 0 && (
                <p className="text-xs text-gray-400 mt-1">
                  {autoStatus.renderedClips} rendered · {autoStatus.totalClips} total
                  {autoStatus.failedClips > 0 && ` · ${autoStatus.failedClips} failed`}
                </p>
              )}
              {autoFailed && autoStatus.error && (
                <p className="text-xs text-red-300 mt-1 line-clamp-2">{autoStatus.error}</p>
              )}
            </div>
            {!isBrandMode && inFlight && !isStuck && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await fetch(`/api/videos/${videoId}/editorial-cancel`, {
                      method: "POST",
                      credentials: "include",
                    });
                    toast({ title: "Cancelling pipeline..." });
                  } catch {}
                }}
                className="text-red-400 hover:text-red-300 text-xs"
              >
                <X className="w-3 h-3 mr-1" />
                Cancel
              </Button>
            )}
            {!isBrandMode && canResume && (
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    const res = await fetch(`/api/videos/${videoId}/editorial-resume`, {
                      method: "POST",
                      credentials: "include",
                    });
                    if (res.ok) {
                      const data = await res.json();
                      toast({
                        title: "Resuming render",
                        description: `Picking up ${data.toRender ?? "remaining"} unrendered clips. Already-rendered clips kept.`,
                      });
                      // Kick a fresh poll
                      const next = await fetchAutoStatus();
                      if (next) setAutoStatus(next);
                    } else {
                      const err = await res.json().catch(() => ({}));
                      toast({
                        title: "Resume failed",
                        description: err.error || "Could not resume render",
                        variant: "destructive",
                      });
                    }
                  } catch (e: any) {
                    toast({ title: "Resume failed", description: e.message, variant: "destructive" });
                  }
                }}
                className="bg-amber-600 hover:bg-amber-500 text-white text-xs"
                data-testid="button-editorial-resume"
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                Resume {isStuck ? "(stuck)" : "Render"}
              </Button>
            )}
            {!isBrandMode && !inFlight && (
              <Button
                size="sm"
                variant={hasUnrenderedClips ? "default" : "ghost"}
                onClick={handleRegenerate}
                disabled={isRegenerating}
                className={hasUnrenderedClips
                  ? "bg-emerald-600 hover:bg-emerald-500 text-white text-xs"
                  : "text-gray-300 hover:text-white text-xs"
                }
              >
                <RefreshCw className={`w-3 h-3 mr-1 ${isRegenerating ? "animate-spin" : ""}`} />
                {hasUnrenderedClips ? "Render Clips" : "Regenerate"}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Search Bar — find clips by topic/keyword */}
      {!isBrandMode && (transcriptStatus.status === "completed" || analysisComplete) && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              placeholder="Search for a story or topic (e.g. 'family trauma', 'funny moments')..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="w-full bg-gray-800/60 border border-gray-700/50 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30"
            />
          </div>
          <Button
            size="sm"
            onClick={handleSearch}
            disabled={isSearching || !searchQuery.trim()}
            className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-4"
          >
            {isSearching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3 mr-1" />}
            Search
          </Button>
          {searchResults !== null && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setSearchResults(null); setSearchQuery(""); }}
              className="text-gray-400 hover:text-white text-xs"
            >
              Clear
            </Button>
          )}
        </div>
      )}

      {/* Search Results — shown when search returns clips */}
      {searchResults !== null && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-medium text-white">
              {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for "{searchQuery}"
            </span>
            <span className="text-xs text-gray-500">· Click "Add" to render and save to your library</span>
          </div>
          {searchResults.length === 0 && (
            <p className="text-xs text-gray-400 pl-6">No clips found matching this query. Try different keywords.</p>
          )}
          {searchResults.map((clip, idx) => (
            <SearchResultCard
              key={`search-${clip.clipStart}-${clip.clipEnd}-${idx}`}
              clip={clip}
              rank={idx + 1}
              videoId={videoId}
              onAdded={async (newClipId) => {
                toast({
                  title: "Clip saved",
                  description: "Rendering in the background \u2014 will appear in your library shortly.",
                });
                // Refresh main clips list so user sees the new pending/rendering clip
                await refetchClips();
                // Optimistically remove from search results
                setSearchResults((prev) => prev?.filter((c) => c !== clip) ?? null);
              }}
            />
          ))}
        </div>
      )}

      {/* Transcript Status Bar — only shown for creators/remix, never for brands */}
      {!isBrandMode && (
        <div className="bg-gray-800/60 rounded-xl p-4 border border-gray-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Mic className="w-4 h-4 text-purple-400" />
              <div>
                <span className="text-sm font-medium text-white">Transcript</span>
                {transcriptStatus.status === "completed" && (
                  <span className="text-xs text-gray-400 ml-2">
                    {transcriptStatus.wordCount} words | {transcriptStatus.segmentCount} segments | {transcriptStatus.speakerCount} speakers
                  </span>
                )}
                {transcriptStatus.status === "processing" && (
                  <span className="text-xs text-yellow-400 ml-2">Processing...</span>
                )}
                {transcriptStatus.status === "failed" && (
                  <span className="text-xs text-red-400 ml-2">Failed</span>
                )}
                {transcriptStatus.status === "none" && !isLoadingSavedClips && (
                  <span className="text-xs text-gray-500 ml-2">Not yet transcribed</span>
                )}
              </div>
            </div>

            {transcriptStatus.status === "none" && !isLoadingSavedClips && (
              <Button
                size="sm"
                onClick={handleTranscribe}
                disabled={isLoadingTranscript}
                className="bg-purple-600 hover:bg-purple-500 text-white text-xs"
              >
                {isLoadingTranscript ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Mic className="w-3 h-3 mr-1" />}
                Transcribe
              </Button>
            )}
            {transcriptStatus.status === "processing" && (
              <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
            )}
            {isLoadingSavedClips && (
              <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
            )}
            {transcriptStatus.status === "completed" && !analysisComplete && !isLoadingSavedClips && (
              <Button
                size="sm"
                onClick={handleAnalyze}
                disabled={isLoadingAnalysis}
                className="bg-blue-600 hover:bg-blue-500 text-white text-xs"
              >
                {isLoadingAnalysis ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Brain className="w-3 h-3 mr-1" />}
                Find Viral Clips
              </Button>
            )}
            {transcriptStatus.status === "completed" && analysisComplete && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleAnalyze}
                disabled={isLoadingAnalysis}
                className="text-gray-400 hover:text-white text-xs"
              >
                <RefreshCw className={`w-3 h-3 mr-1 ${isLoadingAnalysis ? "animate-spin" : ""}`} />
                Re-analyze
              </Button>
            )}
            {transcriptStatus.status === "failed" && (
              <Button
                size="sm"
                onClick={handleTranscribe}
                disabled={isLoadingTranscript}
                className="bg-red-600 hover:bg-red-500 text-white text-xs"
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                Retry
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Brand mode: loading state while checking for creator-generated clips */}
      {isBrandMode && isLoadingSavedClips && (
        <div className="bg-gray-800/60 rounded-xl p-6 border border-gray-700/50 text-center">
          <Loader2 className="w-6 h-6 text-purple-400 animate-spin mx-auto mb-2" />
          <p className="text-sm text-gray-400">Loading viral clips...</p>
        </div>
      )}

      {/* Brand mode: empty state when creator hasn't generated clips yet */}
      {isBrandMode && !isLoadingSavedClips && !analysisComplete && (
        <div className="bg-gray-800/60 rounded-xl p-6 border border-gray-700/50 text-center">
          <Sparkles className="w-8 h-8 text-gray-600 mx-auto mb-3" />
          <p className="text-sm text-gray-400 font-medium">No viral clips available yet</p>
          <p className="text-xs text-gray-500 mt-1">The creator hasn't generated editorial clips for this video yet.</p>
        </div>
      )}

      {/* Loading Analysis — only for creators actively running analysis */}
      {!isBrandMode && isLoadingAnalysis && (
        <div className="bg-gray-800/60 rounded-xl p-8 border border-gray-700/50 text-center">
          <Loader2 className="w-8 h-8 text-blue-400 animate-spin mx-auto mb-3" />
          <p className="text-sm text-white font-medium">Analyzing transcript for viral moments...</p>
          <p className="text-xs text-gray-400 mt-1">Claude is scoring clips on 7 editorial dimensions</p>
        </div>
      )}

      {/* Clips Results */}
      {analysisComplete && clips.length > 0 && !isLoadingAnalysis && (
        <>
          {/* Header + Controls */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-yellow-400" />
              <span className="text-sm font-medium text-white">
                {sortedClips.length} Viral Clip{sortedClips.length !== 1 ? "s" : ""}
              </span>
              {tierCounts.premium > 0 && (
                <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">
                  {tierCounts.premium} Premium
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-2">
              {/* Sort */}
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-300 px-2 py-1"
              >
                <option value="score">By Score</option>
                <option value="time">By Time</option>
                <option value="duration">By Duration</option>
              </select>

              {/* Tier Filter */}
              <select
                value={tierFilter}
                onChange={(e) => setTierFilter(e.target.value as any)}
                className="bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-300 px-2 py-1"
              >
                <option value="all">All Tiers</option>
                <option value="premium">Premium</option>
                <option value="standard">Standard</option>
                <option value="organic">Organic</option>
              </select>
            </div>
          </div>

          {/* Clip Cards */}
          <div className="space-y-3">
            <AnimatePresence>
              {sortedClips.map((clip, idx) => (
                <EditorialClipCard
                  key={`${clip.clipStart}-${clip.clipEnd}`}
                  clip={clip}
                  rank={idx + 1}
                  mode={mode}
                  isExpanded={expandedClip === idx}
                  onToggleExpand={() => setExpandedClip(expandedClip === idx ? null : idx)}
                  onGenerate={onGenerateClip ? () => onGenerateClip(clip) : undefined}
                  onBuy={onBuyPlacement ? () => onBuyPlacement(clip) : undefined}
                  onPlay={clip.exportPath ? () => setPlayingClip(clip) : undefined}
                />
              ))}
            </AnimatePresence>
          </div>
        </>
      )}

      {/* No clips found */}
      {analysisComplete && clips.length === 0 && !isLoadingAnalysis && (
        <div className="bg-gray-800/60 rounded-xl p-8 border border-gray-700/50 text-center">
          <Brain className="w-8 h-8 text-gray-500 mx-auto mb-3" />
          <p className="text-sm text-gray-400">No viral moments found in this video.</p>
          <p className="text-xs text-gray-500 mt-1">Try with a longer video or different content.</p>
        </div>
      )}

      {/* Play Modal — shown when user clicks a rendered clip */}
      <AnimatePresence>
        {playingClip && playingClip.exportPath && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setPlayingClip(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative max-w-md w-full bg-gray-900 rounded-2xl overflow-hidden shadow-2xl border border-gray-700"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setPlayingClip(null)}
                className="absolute top-3 right-3 z-10 w-9 h-9 rounded-full bg-black/60 hover:bg-black/80 flex items-center justify-center text-white transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>

              <video
                key={playingClip.exportPath}
                src={playingClip.exportPath}
                poster={playingClip.thumbnailPath || undefined}
                controls
                autoPlay
                playsInline
                className="w-full bg-black"
                style={{
                  aspectRatio: playingClip.aspectRatio === "16:9" ? "16/9" : "9/16",
                  maxHeight: "85vh",
                }}
              />

              <div className="p-4 space-y-2">
                <h3 className="text-base font-semibold text-white">{playingClip.suggestedTitle}</h3>
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <Clock className="w-3 h-3" />
                  <span>{formatTime(playingClip.clipStart)} – {formatTime(playingClip.clipEnd)}</span>
                  <span>·</span>
                  <span>{playingClip.duration.toFixed(0)}s</span>
                  <span>·</span>
                  <span className={getViralColor(playingClip.finalScore)}>
                    {Math.round(playingClip.finalScore * 100)}% viral
                  </span>
                </div>
                {playingClip.topicTags.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    {playingClip.topicTags.slice(0, 4).map((tag) => (
                      <span
                        key={tag}
                        className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Clip Card Component ────────────────────────────────────────────

function EditorialClipCard({
  clip,
  rank,
  mode,
  isExpanded,
  onToggleExpand,
  onGenerate,
  onBuy,
  onPlay,
}: {
  clip: RankedClip;
  rank: number;
  mode: "creator" | "brand" | "remix";
  isExpanded: boolean;
  onToggleExpand: () => void;
  onGenerate?: () => void;
  onBuy?: () => void;
  onPlay?: () => void;
}) {
  const viralPct = Math.round(clip.finalScore * 100);
  const tierBadge = getTierBadge(clip.monetizationTier);
  const isRendered = clip.renderStatus === "rendered" && !!clip.exportPath;
  const isRendering = clip.renderStatus === "rendering" || clip.renderStatus === "pending";
  const renderFailed = clip.renderStatus === "failed";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={`bg-gray-800/60 rounded-xl border ${
        isRendered ? "border-emerald-500/30" : "border-gray-700/50"
      } overflow-hidden`}
    >
      {/* Main Row */}
      <div className="p-4">
        <div className="flex items-start gap-3">
          {/* Thumbnail or Rank Badge */}
          {clip.thumbnailPath && isRendered ? (
            <button
              onClick={onPlay}
              className="relative w-16 h-20 rounded-lg overflow-hidden flex-shrink-0 group"
              aria-label="Play clip"
            >
              <img
                src={clip.thumbnailPath}
                alt={clip.suggestedTitle}
                className="w-full h-full object-cover"
                loading="lazy"
              />
              <div className="absolute inset-0 bg-black/30 group-hover:bg-black/50 flex items-center justify-center transition-colors">
                <Play className="w-5 h-5 text-white fill-white" />
              </div>
              <div className="absolute bottom-0 left-0 right-0 bg-black/70 text-white text-[10px] px-1 py-0.5 text-center font-semibold">
                #{rank}
              </div>
            </button>
          ) : (
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border ${getViralBg(clip.finalScore)}`}>
              <span className={`text-sm font-bold ${getViralColor(clip.finalScore)}`}>{rank}</span>
            </div>
          )}

          {/* Title + Meta */}
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-semibold text-white truncate">{clip.suggestedTitle}</h4>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs text-gray-400">
                <Clock className="w-3 h-3 inline mr-0.5" />
                {formatTime(clip.clipStart)} - {formatTime(clip.clipEnd)}
              </span>
              <span className="text-xs text-gray-500">({clip.duration.toFixed(0)}s)</span>
              <Badge className={`${tierBadge.className} text-xs border`}>
                {tierBadge.label}
              </Badge>
              {clip.surfaces.length > 0 && (
                <span className="text-xs text-gray-500">
                  {clip.surfaces.length} surface{clip.surfaces.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>

            {/* Topic Tags */}
            {clip.topicTags.length > 0 && (
              <div className="flex items-center gap-1 mt-2 flex-wrap">
                {clip.topicTags.slice(0, 4).map((tag) => (
                  <span
                    key={tag}
                    className="text-xs bg-gray-700/50 text-gray-400 px-2 py-0.5 rounded-full"
                  >
                    {tag}
                  </span>
                ))}
                {clip.topicTags.length > 4 && (
                  <span className="text-xs text-gray-500">+{clip.topicTags.length - 4}</span>
                )}
              </div>
            )}
          </div>

          {/* Viral Score + Actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Viral Score Circle */}
            <div className="text-center">
              <div className={`text-lg font-bold ${getViralColor(clip.finalScore)}`}>
                {viralPct}
              </div>
              <div className="text-xs text-gray-500">viral</div>
            </div>

            {/* Render status indicator */}
            {isRendering && (
              <div className="flex items-center gap-1 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-1 rounded-lg">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Rendering</span>
              </div>
            )}
            {renderFailed && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 px-2 py-1 rounded-lg">
                Render failed
              </div>
            )}

            {/* Action Buttons */}
            {isRendered && onPlay && (
              <Button
                size="sm"
                onClick={onPlay}
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs"
              >
                <Play className="w-3 h-3 mr-1 fill-white" />
                Play
              </Button>
            )}
            {mode === "remix" && onGenerate && (
              <Button
                size="sm"
                onClick={onGenerate}
                variant={isRendered ? "ghost" : "default"}
                className={isRendered ? "text-gray-400 hover:text-white text-xs" : "bg-purple-600 hover:bg-purple-500 text-white text-xs"}
              >
                <Play className="w-3 h-3 mr-1" />
                Generate
              </Button>
            )}
            {mode === "brand" && onBuy && clip.monetizationTier !== "organic" && (
              <Button
                size="sm"
                onClick={onBuy}
                className="bg-green-600 hover:bg-green-500 text-white text-xs"
              >
                <DollarSign className="w-3 h-3 mr-1" />
                Buy Placement
              </Button>
            )}

            {/* Expand */}
            <Button
              size="sm"
              variant="ghost"
              onClick={onToggleExpand}
              className="text-gray-400 hover:text-white"
            >
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Expanded Details */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-t border-gray-700/50"
          >
            <div className="p-4 space-y-3">
              {/* Score Breakdown */}
              <div>
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Score Breakdown</span>
                <div className="mt-2 space-y-1.5">
                  <ScoreBar label="Hook" value={clip.scores.hookStrength} icon={Zap} />
                  <ScoreBar label="Narrative" value={clip.scores.narrativeCompleteness} icon={MessageSquare} />
                  <ScoreBar label="Emotion" value={clip.scores.emotionalArc} icon={Heart} />
                  <ScoreBar label="Clarity" value={clip.scores.speakerClarity} icon={Mic} />
                  <ScoreBar label="Cultural" value={clip.scores.culturalRelevance} icon={Shield} />
                  <ScoreBar label="Replay" value={clip.scores.replayability} icon={Eye} />
                </div>
              </div>

              {/* Reasoning */}
              {clip.reasoning && (
                <div>
                  <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Why This Works</span>
                  <p className="text-xs text-gray-300 mt-1 leading-relaxed">{clip.reasoning}</p>
                </div>
              )}

              {/* Edit Point Adjustments */}
              {clip.editPoints.adjustments.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Edit Refinements</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {clip.editPoints.adjustments.map((adj, i) => (
                      <span key={i} className="text-xs bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-full">
                        {adj}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Search Result Card Component ─────────────────────────────────────

function SearchResultCard({
  clip,
  rank,
  videoId,
  onAdded,
}: {
  clip: RankedClip;
  rank: number;
  videoId: number;
  onAdded: (newClipId: number) => void;
}) {
  const { toast } = useToast();
  const [isAdding, setIsAdding] = useState(false);
  const viralPct = Math.round(clip.finalScore * 100);

  const handleAdd = async () => {
    setIsAdding(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/editorial-clip/render`, {
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
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to add clip");
      }
      const data = await res.json();
      onAdded(data.clip?.id);
    } catch (err: any) {
      toast({ title: "Add failed", description: err.message, variant: "destructive" });
    }
    setIsAdding(false);
  };

  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border border-gray-700/50 bg-gray-800/40 hover:bg-gray-800/60 transition-colors">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border ${getViralBg(clip.finalScore)}`}>
        <span className={`text-sm font-bold ${getViralColor(clip.finalScore)}`}>{rank}</span>
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white truncate">{clip.suggestedTitle}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="text-xs text-gray-400">
            <Clock className="w-3 h-3 inline mr-0.5" />
            {formatTime(clip.clipStart)} - {formatTime(clip.clipEnd)}
          </span>
          <span className="text-xs text-gray-500">({clip.duration.toFixed(0)}s)</span>
          <span className={`text-xs ${getViralColor(clip.finalScore)}`}>{viralPct}% viral</span>
        </div>
        {clip.topicTags.length > 0 && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {clip.topicTags.slice(0, 3).map((tag) => (
              <span key={tag} className="text-xs bg-gray-700/50 text-gray-400 px-2 py-0.5 rounded-full">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      <Button
        size="sm"
        onClick={handleAdd}
        disabled={isAdding}
        className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs flex-shrink-0"
      >
        {isAdding ? (
          <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Adding</>
        ) : (
          <><Wand2 className="w-3 h-3 mr-1" /> Add & Render</>
        )}
      </Button>
    </div>
  );
}
