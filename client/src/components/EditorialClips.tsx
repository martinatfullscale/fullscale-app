/**
 * EditorialClips — Reusable component displaying ranked editorial clips for a video.
 *
 * Used by:
 * - Creator Library (Insights modal) — with transcribe/analyze controls
 * - RemixStudio — with "Generate This Clip" action
 * - BrandMarketplace — read-only view with "Buy Placement" action
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Clock, TrendingUp, Tag, ChevronDown, ChevronUp, Loader2, Mic, Brain, Zap, Eye, Heart, Shield, MessageSquare, RefreshCw, Play, DollarSign, Filter, X, Wand2, AlertCircle, Search, SlidersHorizontal, PackageOpen, ScanSearch, Send } from "lucide-react";
import ClipPlacementPreview from "@/components/ClipPlacementPreview";
import ClipStudio from "@/components/ClipStudio";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useJobPoll } from "@/hooks/use-job-poll";

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
  // Creator edit settings, persisted so a re-render reproduces them
  captionsEnabled?: boolean | null;
  captionStyle?: string | null;
  captionSettings?: Record<string, any> | null;
  segments?: Array<{ start: number; end: number; role?: string }> | null;
  // Placement-inventory state, computed server-side from one surfaces load
  surfaceCount?: number;
  surfaceGroupCount?: number;
  videoScanned?: boolean;
  scanInFlight?: boolean;
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
  /** Subset of pendingClips actively in flight (a lone re-render). */
  renderingClips?: number;
  completedAt: string | null;
  updatedAt: string | null;
}

export interface EditorialClipsProps {
  videoId: number;
  mode: "creator" | "brand" | "remix";
  /** Run this transcript search as soon as the component mounts — how
   *  "Find more like this" arrives from Clips & Reels. */
  initialSearch?: { query: string; excludeRanges?: Array<{ start: number; end: number }> } | null;
  /** Called once the seeded search has been dispatched. */
  onSeedConsumed?: () => void;
  onGenerateClip?: (clip: RankedClip) => void;
  onBuyPlacement?: (clip: RankedClip) => void;
  /** Remix-tab: make this clip the AI copilot's target */
  onSelectForCopilot?: (clip: RankedClip) => void;
  /** Open the Distribution hub on this clip. Only offered once it has rendered. */
  onPublishClip?: (clip: RankedClip) => void;
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

export default function EditorialClips({ videoId, mode, initialSearch, onSeedConsumed, onGenerateClip, onBuyPlacement, onSelectForCopilot, onPublishClip }: EditorialClipsProps) {
  const { toast } = useToast();

  const [transcriptStatus, setTranscriptStatus] = useState<TranscriptStatus>({ status: "none" });
  const [clips, setClips] = useState<RankedClip[]>([]);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [isLoadingAnalysis, setIsLoadingAnalysis] = useState(false);
  const [isLoadingSavedClips, setIsLoadingSavedClips] = useState(true);
  // Source length bounds the trim sliders. Absent (0) = unknown; the editor
  // falls back to a window around the clip rather than guessing a hard cap.
  const [sourceDurationSec, setSourceDurationSec] = useState<number>(0);
  // Placement preview modal + clips currently scanning (optimistic — the
  // list endpoint confirms via scanInFlight on the next refetch).
  const [previewClip, setPreviewClip] = useState<RankedClip | null>(null);
  const [studioClip, setStudioClip] = useState<RankedClip | null>(null);
  const [scanningClips, setScanningClips] = useState<Set<number>>(new Set());

  const scanClip = useCallback(async (clipId: number) => {
    setScanningClips((prev) => new Set(prev).add(clipId));
    try {
      const res = await fetchWithTimeout(`/api/editorial-clips/${clipId}/scan`, { method: "POST", credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) {
        toast({
          title: body.mode === "full_scan" ? "Scanning source video" : "Scanning clip range",
          description: body.message || "Surfaces appear here when the scan finishes.",
        });
      } else if (res.status === 409) {
        toast({ title: "Already scanning", description: "This clip's scan is still running." });
      } else {
        setScanningClips((prev) => { const nx = new Set(prev); nx.delete(clipId); return nx; });
        toast({ title: "Scan failed", description: body.error || "Try again", variant: "destructive" });
      }
    } catch (err: any) {
      setScanningClips((prev) => { const nx = new Set(prev); nx.delete(clipId); return nx; });
      toast({ title: "Scan failed", description: err.message, variant: "destructive" });
    }
  }, [toast]);

  // While anything is scanning OR rendering, poll the clip list so rows land
  // as the server writes them. Rendering is read off the rows themselves
  // (renderStatus === "rendering"), so every path that starts a render — the
  // aspect picker, the editor's Apply, the copilot, a remount — is tracked
  // without anyone remembering to start a poll. The stale-render sweep
  // guarantees a stranded row settles to "failed", so this cannot spin forever.
  const renderingIds = clips
    .filter((c) => c.renderStatus === "rendering" && (c as any).id)
    .map((c) => (c as any).id as number);
  const renderingKey = renderingIds.join(",");
  useEffect(() => {
    if (scanningClips.size === 0 && renderingIds.length === 0) return;
    const iv = setInterval(() => { refetchClips(); }, renderingIds.length > 0 ? 5000 : 10000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanningClips.size, renderingKey]);

  // The receipt: say so when a RE-render lands (or fails) instead of letting
  // the card silently swap its thumbnail. Only re-renders: a clip that still
  // carries an exportPath when it enters "rendering" had a finished cut (the
  // old one survives until the new one lands); a pipeline first render does
  // not, and the pipeline banner already announces those.
  const renderingSinceRef = useRef<Map<number, boolean>>(new Map());
  useEffect(() => {
    const nowIds = new Set(renderingIds);
    const known = renderingSinceRef.current;
    for (const id of renderingIds) {
      if (known.has(id)) continue;
      const row = clips.find((c) => (c as any).id === id) as any;
      known.set(id, !!row?.exportPath);
    }
    for (const id of Array.from(known.keys())) {
      if (nowIds.has(id)) continue;
      const hadCut = known.get(id);
      known.delete(id);
      if (!hadCut) continue;
      const row = clips.find((c) => (c as any).id === id) as any;
      if (!row) continue;
      if (row.renderStatus === "rendered") {
        toast({ title: "New cut ready", description: row.suggestedTitle ? `"${String(row.suggestedTitle).slice(0, 60)}" re-rendered.` : "Your clip re-rendered." });
      } else if (row.renderStatus === "failed") {
        toast({ title: "Re-render failed", description: row.renderError || "Try again", variant: "destructive" });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderingKey]);

  useEffect(() => {
    if (scanningClips.size === 0) return;
    setScanningClips((prev) => {
      const nx = new Set<number>();
      for (const id of Array.from(prev)) {
        const row = clips.find((c) => (c as any).id === id) as any;
        // Keep the flag while the server reports in-flight OR hasn't
        // reported yet; drop it once the server says the scan ended.
        if (!row || row.scanInFlight !== false) nx.add(id);
      }
      return nx.size === prev.size ? prev : nx;
    });
  }, [clips]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(`/api/video/${videoId}/details`, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();
        const raw = String(data?.video?.duration ?? data?.duration ?? "").trim();
        if (!raw || cancelled) return;
        const secs = /^\d+(\.\d+)?$/.test(raw)
          ? parseFloat(raw)
          : raw.split(":").map(Number).reduce((a, p) => (Number.isFinite(p) ? a * 60 + p : a), 0);
        if (Number.isFinite(secs) && secs > 0) setSourceDurationSec(secs);
      } catch { /* trim just falls back to a relative window */ }
    })();
    return () => { cancelled = true; };
  }, [videoId]);
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
  // Last pipeline status this poll observed — a transition out of in-flight
  // is the moment to announce the result.
  const lastStatusRef = useRef<string | null>(null);
  // Bumped to restart the poll after Regenerate/Resume. The poll self-reschedules
  // only while a pipeline is in flight, so once it settles on "ready"/"failed" it
  // stops with no pending timer; starting new server work does not on its own wake
  // it, which left the banner stuck at "Queued…" and new clips never appearing.
  const [pollNonce, setPollNonce] = useState(0);

  // ── Helpers ────────────────────────────────────────────────────
  const refetchClips = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`/api/scenes/${videoId}/editorial-clips`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.clips)) {
          setClips(data.clips);
          // Monotonic: a refetch can confirm an analysis happened, never
          // un-happen it (a zero-result run must still read as complete).
          setAnalysisComplete((prev) => prev || data.clips.length > 0);
        }
      }
    } catch {
      /* non-fatal */
    }
  }, [videoId]);

  const fetchAutoStatus = useCallback(async (): Promise<EditorialStatusResponse | null> => {
    try {
      const res = await fetchWithTimeout(`/api/videos/${videoId}/editorial-status`, { credentials: "include" });
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

      const IN_FLIGHT = ["pending", "transcribing", "analyzing", "rendering"];
      const inFlight = IN_FLIGHT.includes(status.status);
      const wasInFlight = lastStatusRef.current !== null && IN_FLIGHT.includes(lastStatusRef.current);
      lastStatusRef.current = status.status;
      if (inFlight) {
        // Refetch clips every poll so newly-rendered ones appear progressively
        await refetchClips();
        pollTimerRef.current = setTimeout(tick, 5_000);
      } else if (status.status === "ready" || status.status === "failed") {
        await refetchClips();
        if (wasInFlight && !cancelled) {
          // The receipt for a run this component watched settle — including a
          // zero-result one, which used to vanish without a trace.
          setAnalysisComplete(true);
          if (status.status === "ready") {
            const n = status.renderedClips > 0 ? status.renderedClips : status.totalClips;
            toast(
              status.totalClips > 0
                ? {
                    title: `${n} story clip${n === 1 ? "" : "s"} ${status.renderedClips > 0 ? "ready" : "found"}`,
                    description: status.renderedClips > 0 ? "Rendered and ready to publish." : "Render them to make them playable.",
                  }
                : { title: "No story moments found", description: "Claude couldn't find a self-contained story in this transcript." },
            );
          } else if (status.error === "Cancelled by user") {
            toast({ title: "Stopped", description: "Story-clips cancelled." });
          } else {
            toast({ title: "Story-clips failed", description: status.error || "Try again", variant: "destructive" });
          }
        }
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
  }, [videoId, pollNonce, fetchAutoStatus, refetchClips]);

  const handleRegenerate = useCallback(async () => {
    setIsRegenerating(true);
    try {
      const res = await fetchWithTimeout(`/api/videos/${videoId}/editorial-auto`, {
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
      setPollNonce(n => n + 1); // restart the poll so the new run is tracked
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
    setIsRegenerating(false);
  }, [videoId, toast]);

  // Search runs off the request (202 + job); the poll below collects it.
  const toSearchClip = (c: any): RankedClip => ({
    ...c,
    duration: Array.isArray(c.segments) && c.segments.length > 1
      ? c.segments.reduce((sum: number, s: any) => sum + (s.end - s.start), 0)
      : c.clipEnd - c.clipStart,
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
  });
  const [searchJob, setSearchJob] = useState<{ id: string; query: string } | null>(null);
  useJobPoll<{ clips: any[]; count: number }>(searchJob ? { kind: "search", id: searchJob.id } : null, {
    intervalMs: 2500,
    maxMs: 6 * 60_000,
    onTerminal: (view) => {
      const query = searchJob?.query ?? "";
      setSearchJob(null);
      setIsSearching(false);
      if (view.state === "succeeded") {
        const found = view.result?.clips ?? [];
        setSearchResults(found.map(toSearchClip));
        toast({ title: `Found ${found.length} clips`, description: `Matching "${query}"` });
      } else {
        toast({ title: "Search failed", description: view.error || "Try again", variant: "destructive" });
      }
    },
    onTimeout: () => {
      setSearchJob(null);
      setIsSearching(false);
      toast({ title: "Search is taking too long", description: "Try again in a moment.", variant: "destructive" });
    },
  });

  const runSearch = useCallback(async (
    rawQuery: string,
    excludeRanges?: Array<{ start: number; end: number }>,
  ) => {
    const q = rawQuery.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    setIsSearching(true);
    let accepted = false;
    try {
      const res = await fetchWithTimeout(`/api/videos/${videoId}/editorial-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        // excludeRanges keeps "find more like this" from handing back the
        // very clip the creator asked for more of.
        body: JSON.stringify({ query: q, maxClips: 10, ...(excludeRanges?.length ? { excludeRanges } : {}) }),
      }, 60_000);
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // Informational, not a failure — the other analysis will finish.
        toast({ title: "Already analyzing", description: data.error || "Another analysis is running on this video — try the search again in a moment." });
        return;
      }
      if (!res.ok) throw new Error(data.error || "Search failed");
      if (res.status === 202 && data.job?.id) {
        accepted = true;
        setSearchJob({ id: String(data.job.id), query: q });
        return;
      }
      // Legacy synchronous shape.
      setSearchResults((data.clips || []).map(toSearchClip));
      toast({ title: `Found ${data.clips?.length || 0} clips`, description: `Matching "${q}"` });
    } catch (err: any) {
      toast({ title: "Search failed", description: err.message, variant: "destructive" });
    } finally {
      if (!accepted) setIsSearching(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, toast]);

  const handleSearch = useCallback(() => runSearch(searchQuery), [runSearch, searchQuery]);

  // "Find more like this" from Clips & Reels: land with the box filled in and
  // the search already running, so the creator sees the work start rather
  // than a pre-typed query waiting for another click.
  // NOTE: this component is mounted with a `key` that RemixStudio bumps on
  // every copilot apply and re-render, so a ref-based "already ran" guard
  // dies with the component and the search fires again. The parent owns
  // consumption instead: we tell it the moment we dispatch, and it drops the
  // seed so the next mount receives null.
  useEffect(() => {
    if (!initialSearch?.query) return;
    setSearchQuery(initialSearch.query);
    runSearch(initialSearch.query, initialSearch.excludeRanges);
    onSeedConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSearch?.query]);

  // ── Load saved clips + transcript status on mount ─────────────────
  useEffect(() => {
    let cancelled = false;

    async function loadSavedData() {
      // Load both transcript status and saved editorial clips in parallel
      try {
        const [transcriptRes, clipsRes] = await Promise.all([
          fetchWithTimeout(`/api/video/${videoId}/transcript`, { credentials: "include" }),
          fetchWithTimeout(`/api/scenes/${videoId}/editorial-clips`, { credentials: "include" }),
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
      const res = await fetchWithTimeout(`/api/video/${videoId}/transcribe`, {
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
          const checkRes = await fetchWithTimeout(`/api/video/${videoId}/transcript`, { credentials: "include" });
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
      // The analysis runs off the request now (202 + job). The auto-pipeline
      // banner and its poll track it, and the clip list reloads with rows
      // that have ids when it settles.
      const res = await fetchWithTimeout(`/api/scenes/${videoId}/editorial-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ maxClips: 10 }),
      }, 60_000);
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast({ title: "Already analyzing", description: data.error || "Give it a moment — results will appear when it finishes." });
        setPollNonce((n) => n + 1); // track the run that IS going
        return;
      }
      if (!res.ok) throw new Error(data.error || "Analysis failed to start");
      if (res.status === 202 || data.pending) {
        toast({
          title: "Finding viral clips",
          description: "Claude is reading the transcript — this takes a minute or two. Clips appear here as soon as it finishes.",
        });
        setAutoStatus((prev) => ({
          status: "analyzing",
          error: null,
          totalClips: prev?.totalClips ?? 0,
          renderedClips: prev?.renderedClips ?? 0,
          failedClips: prev?.failedClips ?? 0,
          pendingClips: prev?.pendingClips ?? 0,
          renderingClips: prev?.renderingClips ?? 0,
          completedAt: null,
          updatedAt: new Date().toISOString(),
        }));
        setPollNonce((n) => n + 1);
        return;
      }
      // Legacy synchronous shape.
      if (data.rankedClips) {
        setClips(data.rankedClips);
        setAnalysisComplete(true);
        toast({
          title: `Found ${data.rankedClips.length} viral clips`,
          description: `${data.moments?.length || 0} moments analyzed`,
        });
      } else {
        throw new Error(data.error || "No clips found");
      }
    } catch (err: any) {
      toast({ title: "Analysis failed", description: err.message, variant: "destructive" });
    } finally {
      setIsLoadingAnalysis(false);
    }
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
  // Clips left unrendered on a settled video. Subtract the ones actively
  // rendering (a lone re-render on a "ready" video) — offering Resume for
  // those would start a second ffmpeg on the same clip. Failed clips count:
  // Resume retries them.
  const strandedClips = autoStatus
    ? Math.max(0, autoStatus.pendingClips - (autoStatus.renderingClips ?? 0)) + (autoStatus.failedClips ?? 0)
    : 0;
  const hasOrphanedClips = Boolean(
    autoStatus &&
      (autoStatus.status === "ready" || autoStatus.status === "failed") &&
      strandedClips > 0
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
                    await fetchWithTimeout(`/api/videos/${videoId}/editorial-cancel`, {
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
                    const res = await fetchWithTimeout(`/api/videos/${videoId}/editorial-resume`, {
                      method: "POST",
                      credentials: "include",
                    });
                    if (res.ok) {
                      const data = await res.json();
                      toast({
                        title: "Resuming render",
                        description: `Picking up ${data.toRender ?? "remaining"} unrendered clips. Already-rendered clips kept.`,
                      });
                      // Kick a fresh poll — and restart the polling loop, which
                      // otherwise stays stopped after a settled run.
                      const next = await fetchAutoStatus();
                      if (next) setAutoStatus(next);
                      setPollNonce(n => n + 1);
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
                disabled={isLoadingAnalysis || Boolean(inFlight) || isSearching}
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
                disabled={isLoadingAnalysis || Boolean(inFlight) || isSearching}
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
          <p className="text-xs text-gray-500 mt-1">The creator hasn't generated story clips for this video yet.</p>
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
                  onCopilot={onSelectForCopilot ? () => onSelectForCopilot(clip) : undefined}
                  onBuy={onBuyPlacement ? () => onBuyPlacement(clip) : undefined}
                  onPlay={clip.exportPath ? () => setPlayingClip(clip) : undefined}
                  onPreviewPlacement={(clip as any).id ? () => setPreviewClip(clip) : undefined}
                  onScan={(clip as any).id ? () => scanClip((clip as any).id) : undefined}
                  isScanning={(clip as any).id ? scanningClips.has((clip as any).id) : false}
                  onOpenStudio={(clip as any).id ? () => setStudioClip(clip) : undefined}
                  onPublish={(clip as any).id && onPublishClip ? () => onPublishClip(clip) : undefined}
                  onRerenderAspect={(clip as any).id ? async (aspect) => {
                    const res = await fetchWithTimeout(`/api/editorial-clips/${(clip as any).id}/rerender`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      credentials: "include",
                      body: JSON.stringify({ aspect }),
                    });
                    if (res.ok) {
                      toast({ title: `Re-rendering as ${aspect}`, description: "The clip will refresh here when the new cut is ready." });
                      await refetchClips();
                    } else {
                      const err = await res.json().catch(() => ({}));
                      toast({ title: "Re-render failed", description: err.error || "Try again", variant: "destructive" });
                    }
                  } : undefined}
                />
              ))}
            </AnimatePresence>
          </div>
        </>
      )}

      {/* The editor: video at the centre, transcript as the edit surface */}
      {studioClip && (studioClip as any).id && (
        <ClipStudio
          clip={studioClip as any}
          videoId={videoId}
          onClose={() => setStudioClip(null)}
          onApply={async (payload) => {
            const res = await fetchWithTimeout(`/api/editorial-clips/${(studioClip as any).id}/rerender`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify(payload),
            });
            if (res.ok) {
              toast({ title: "Re-rendering your edit", description: "The clip refreshes here when the new cut is ready." });
              await refetchClips();
            } else {
              const err = await res.json().catch(() => ({}));
              toast({ title: "Re-render failed", description: err.error || "Try again", variant: "destructive" });
            }
          }}
        />
      )}

      {/* Placement preview — source-space frames + product sprites */}
      {previewClip && (previewClip as any).id && (
        <ClipPlacementPreview
          clipId={(previewClip as any).id}
          videoId={videoId}
          clipTitle={previewClip.suggestedTitle}
          onClose={() => setPreviewClip(null)}
          onScan={() => scanClip((previewClip as any).id)}
          scanInFlight={scanningClips.has((previewClip as any).id) || !!(previewClip as any).scanInFlight}
        />
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
  onCopilot,
  onRerenderAspect,
  onOpenStudio,
  onPublish,
  onPreviewPlacement,
  onScan,
  isScanning,
}: {
  clip: RankedClip;
  rank: number;
  mode: "creator" | "brand" | "remix";
  isExpanded: boolean;
  onToggleExpand: () => void;
  onGenerate?: () => void;
  onBuy?: () => void;
  onPlay?: () => void;
  onCopilot?: () => void;
  onRerenderAspect?: (aspect: "9:16" | "16:9") => void;
  onOpenStudio?: () => void;
  /** Open the Distribution hub focused on this clip. */
  onPublish?: () => void;
  onPreviewPlacement?: () => void;
  onScan?: () => void;
  isScanning?: boolean;
}) {

  const viralPct = Math.round(clip.finalScore * 100);
  const tierBadge = getTierBadge(clip.monetizationTier);
  const isRendered = clip.renderStatus === "rendered" && !!clip.exportPath;
  const isRendering = clip.renderStatus === "rendering" || clip.renderStatus === "pending";
  const renderFailed = clip.renderStatus === "failed";

  /**
   * Exactly one solid button per row, derived from state.
   *
   * The row used to render up to eleven controls at identical weight, so it
   * never said what to do next — the emptiness around them was the space left
   * over when nothing was allowed to be bigger than anything else. What the
   * creator should do is entirely determined by where the clip is: an unrendered
   * clip needs a render, a failed one needs a retry, a finished one needs
   * publishing. So derive it rather than showing every possibility at once.
   *
   * A clip mid-render gets NO primary at all. There is nothing useful to press
   * while the job runs, and offering a bright button next to a progress bar
   * invites a second click on work already in flight.
   */
  /** Tier 2, hoisted: the segmented group needs these three times over —
   *  to decide whether it exists at all, per button, and for the divider. */
  const showEdit = !!onOpenStudio && mode !== "brand" && !!(clip as any).id;
  const showCopilot = mode === "remix" && !!onCopilot;

  const primaryAction: { label: string; icon: typeof Send; onClick: () => void; className: string } | null =
    mode === "brand"
      ? (onBuy && clip.monetizationTier !== "organic"
          ? { label: "Buy placement", icon: DollarSign, onClick: onBuy, className: "bg-green-600 hover:bg-green-500 border-green-500" }
          : null)
      : isRendering
        ? null
        : isRendered && onPublish && (clip as any).id
          ? { label: "Publish", icon: Send, onClick: onPublish, className: "bg-emerald-600 hover:bg-emerald-500 border-emerald-500" }
          // Rendering stays gated on remix mode. The parent passes onGenerate
          // whenever it has a handler at all, so testing the prop alone would
          // put a Generate button in creator mode where the old row
          // deliberately showed none.
          : renderFailed && onGenerate && mode === "remix"
            ? { label: "Retry render", icon: RefreshCw, onClick: onGenerate, className: "bg-purple-600 hover:bg-purple-500 border-purple-500" }
            : onGenerate && mode === "remix"
              ? { label: "Generate", icon: Play, onClick: onGenerate, className: "bg-purple-600 hover:bg-purple-500 border-purple-500" }
              : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={`bg-gray-800/60 rounded-xl border ${
        isRendered ? "border-emerald-500/30" : "border-gray-700/50"
      } overflow-hidden`}
    >
      {/* Main Row.
          Redesigned from three hierarchies explored in Claude Design; this is
          option 1a, "Split — identity left, action ladder right".

          The problem it solves: eleven controls at identical weight, so the row
          never said what to do next, and the wide empty gaps were what was left
          over when nothing was allowed to dominate. Now there are three tiers —
          one derived primary CTA, Edit/Copilot as a segmented pair, and the
          monetisation controls demoted to small unfilled chips — and the
          thumbnail absorbs the space by becoming the play target rather than
          sitting next to a Play button. */}
      <div className="p-3.5">
        <div className="flex items-start gap-3 sm:gap-4">
          {/* Preview. Not a button beside the row — the row's image IS the
              play control, which removes one control from the bar entirely.
              9:16 because that is what these clips actually are. */}
          <button
            type="button"
            onClick={isRendered ? onPlay : undefined}
            disabled={!isRendered || !onPlay}
            aria-label={isRendered ? `Play ${clip.suggestedTitle}` : "Not rendered yet"}
            className={`relative flex-none w-16 h-24 sm:w-[88px] sm:h-[132px] rounded-lg overflow-hidden border group ${
              renderFailed
                ? "border-red-500/40 bg-red-500/5"
                : isRendered
                  ? "border-white/10 cursor-pointer"
                  : "border-gray-700/60 bg-gray-800/40 cursor-default"
            }`}
            data-testid={`thumb-${(clip as any).id ?? rank}`}
          >
            {clip.thumbnailPath && isRendered && (
              <img
                src={clip.thumbnailPath}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
            )}

            <span className="absolute top-1 left-1 text-[10px] font-semibold font-mono text-white bg-black/65 px-1.5 py-0.5 rounded">
              #{rank}
            </span>

            {isRendered && (
              <>
                <span className="absolute bottom-1 right-1 text-[10px] font-medium font-mono text-white bg-black/65 px-1.5 py-0.5 rounded">
                  {clip.duration.toFixed(0)}s
                </span>
                <span className="absolute inset-0 flex items-center justify-center bg-black/25 group-hover:bg-black/40 transition-colors">
                  <span className="w-9 h-9 rounded-full bg-emerald-600/90 flex items-center justify-center shadow-lg">
                    <Play className="w-3.5 h-3.5 text-white fill-white ml-0.5" />
                  </span>
                </span>
              </>
            )}
            {isRendering && (
              <span className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
              </span>
            )}
            {renderFailed && (
              <span className="absolute inset-0 flex items-center justify-center">
                <AlertCircle className="w-6 h-6 text-red-400" />
              </span>
            )}
            {!isRendered && !isRendering && !renderFailed && (
              <span className="absolute inset-0 flex items-center justify-center px-1 text-center text-[9px] leading-tight text-gray-500 uppercase tracking-wide">
                No render yet
              </span>
            )}
          </button>

          {/* Identity and actions. Stacks below 640px so the action column
              wraps under the metadata instead of squeezing the title. */}
          <div className="flex-1 min-w-0 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0 flex-1 flex flex-col gap-1.5">
              {/* Identity line. suggestedTitle is the row's name — it already
                  existed on every clip and was never rendered, which is why
                  the list read as "Clip #130 · 1460–1520s" and was impossible
                  to scan. */}
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="flex items-baseline gap-1 flex-none">
                  <span className={`text-2xl font-bold font-mono leading-none ${isRendered ? "text-emerald-400" : getViralColor(clip.finalScore)}`}>
                    {viralPct}
                  </span>
                  <span className="text-[9px] font-semibold font-mono uppercase tracking-wider text-gray-500">viral</span>
                </span>
                <span className="w-px h-5 bg-white/10 flex-none" />
                <h4 className="text-[15px] font-bold text-white truncate min-w-0" title={clip.suggestedTitle}>
                  {clip.suggestedTitle}
                </h4>
              </div>

              {/* Meta line */}
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <span className="font-mono text-gray-400">
                  {Array.isArray((clip as any).segments) && (clip as any).segments.length > 1
                    ? `Assembled · ${(clip as any).segments.length} beats`
                    : `${formatTime(clip.clipStart)}–${formatTime(clip.clipEnd)}`}
                </span>
                <span className="text-gray-600">·</span>
                <span className="font-mono text-gray-400">{clip.duration.toFixed(0)}s</span>
                <span className="text-gray-600">·</span>
                <Badge className={`${tierBadge.className} text-[10px] border py-0`}>{tierBadge.label}</Badge>
                {clip.surfaces.length > 0 && (
                  <span className="text-gray-500">
                    {clip.surfaces.length} surface{clip.surfaces.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {/* Render state as content, not as a badge in the action bar.
                  A failed render carries renderError, which nothing displayed
                  anywhere — the creator saw "Render failed" and had no idea
                  why or what to change. */}
              {isRendering && (
                <div className="flex items-center gap-2 mt-0.5">
                  <div className="h-1 flex-1 max-w-[220px] rounded-full bg-gray-700/60 overflow-hidden">
                    <div className="h-full w-1/3 bg-purple-500 animate-pulse rounded-full" />
                  </div>
                  <span className="text-[11px] font-mono text-purple-300">
                    Rendering {(clip as any).aspectRatio || "9:16"}
                  </span>
                </div>
              )}
              {renderFailed && (
                <div className="mt-0.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5">
                  <span className="text-[10px] font-semibold font-mono uppercase tracking-wide text-red-400">Render failed</span>
                  {clip.renderError && (
                    <p className="text-[11px] text-red-200/80 leading-snug mt-0.5">{clip.renderError}</p>
                  )}
                </div>
              )}

              {/* Tags. Three plus an overflow count — four wrapped to a second
                  line on the narrower title column. */}
              {clip.topicTags.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                  {clip.topicTags.slice(0, 3).map((tag) => (
                    <span key={tag} className="text-[11px] text-gray-400 bg-white/5 px-2 py-0.5 rounded">
                      {tag}
                    </span>
                  ))}
                  {clip.topicTags.length > 3 && (
                    <span className="text-[11px] text-gray-500">+{clip.topicTags.length - 3}</span>
                  )}
                </div>
              )}
            </div>

            {/* Action ladder */}
            <div className="flex-none flex flex-col gap-2 sm:items-end">
              <div className="flex items-center gap-2 flex-wrap">
                {/* Tier 2: Edit and Copilot read as siblings of each other and
                    subordinate to the primary, so they share one bordered
                    group rather than floating as two more peers. */}
                {(showEdit || showCopilot) && (
                  <div className="flex items-stretch border border-gray-700 rounded-lg overflow-hidden">
                    {showEdit && onOpenStudio && (
                      <button
                        type="button"
                        onClick={onOpenStudio}
                        title="Open the editor: transcript, captions, b-roll, audio, motion"
                        className="px-3 py-1.5 text-xs font-semibold text-gray-300 hover:bg-white/5 hover:text-white transition-colors"
                        data-testid={`button-edit-${(clip as any).id ?? rank}`}
                      >
                        <SlidersHorizontal className="w-3 h-3 inline mr-1.5 -mt-px" />
                        Edit
                      </button>
                    )}
                    {showEdit && showCopilot && (
                      <span className="w-px bg-gray-700" />
                    )}
                    {showCopilot && onCopilot && (
                      <button
                        type="button"
                        onClick={onCopilot}
                        title="Make this clip the AI copilot's target"
                        className="px-3 py-1.5 text-xs font-semibold text-violet-300 hover:bg-violet-500/10 hover:text-violet-200 transition-colors"
                        data-testid={`button-copilot-${(clip as any).id ?? rank}`}
                      >
                        <Sparkles className="w-3 h-3 inline mr-1.5 -mt-px" />
                        Copilot
                      </button>
                    )}
                  </div>
                )}

                {/* Tier 1: the one solid button. */}
                {primaryAction && (
                  <Button
                    size="sm"
                    onClick={primaryAction.onClick}
                    className={`${primaryAction.className} text-white text-xs font-bold border`}
                    data-testid={`button-primary-${(clip as any).id ?? rank}`}
                  >
                    <primaryAction.icon className="w-3.5 h-3.5 mr-1.5" />
                    {primaryAction.label}
                  </Button>
                )}

                <button
                  type="button"
                  onClick={onToggleExpand}
                  aria-label={isExpanded ? "Hide score breakdown" : "Show score breakdown"}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-white hover:bg-white/5 transition-colors"
                >
                  {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
              </div>

              {/* Tier 3: aspect, placement, scan. Small and unfilled — real
                  controls, but never competing with the primary. */}
              <div className="flex items-center gap-2 flex-wrap sm:justify-end">
                {isRendered && onRerenderAspect && mode !== "brand" && (
                  <div className="flex border border-gray-700 rounded-md overflow-hidden" data-testid={`aspect-picker-${(clip as any).id ?? rank}`}>
                    {(["9:16", "16:9"] as const).map((aspect) => {
                      const active = ((clip as any).aspectRatio || "9:16") === aspect;
                      return (
                        <button
                          key={aspect}
                          type="button"
                          onClick={() => !active && onRerenderAspect(aspect)}
                          title={active ? `Current output is ${aspect}` : `Re-render as ${aspect}`}
                          className={`px-2 py-0.5 text-[11px] font-semibold font-mono transition-colors ${
                            active
                              ? "bg-purple-500/20 text-purple-300 cursor-default"
                              : "text-gray-500 hover:text-gray-200 hover:bg-white/5"
                          }`}
                        >
                          {aspect}
                        </button>
                      );
                    })}
                  </div>
                )}

                {onPreviewPlacement && (clip as any).id && (
                  <button
                    type="button"
                    onClick={onPreviewPlacement}
                    title="Where a brand's product sits in this clip"
                    className="flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-emerald-500/30 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/10 transition-colors"
                    data-testid={`button-preview-placement-${(clip as any).id ?? rank}`}
                  >
                    <PackageOpen className="w-3 h-3" />
                    Placement
                    {typeof (clip as any).surfaceGroupCount === "number" && (clip as any).surfaceGroupCount > 0 && (
                      <span className="font-mono text-gray-500">{(clip as any).surfaceGroupCount}</span>
                    )}
                  </button>
                )}

                {onScan && mode !== "brand" && (clip as any).id && (
                  (isScanning || (clip as any).scanInFlight) ? (
                    <span className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] text-purple-300" title="Scanning for placement surfaces">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Scanning…
                    </span>
                  ) : ((clip as any).surfaceCount ?? 0) === 0 ? (
                    <button
                      type="button"
                      onClick={onScan}
                      title={(clip as any).videoScanned === false
                        ? "Source video was never scanned — no placement inventory exists yet"
                        : "Nothing found in this range — run a denser scan"}
                      className="flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-amber-500/30 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/10 transition-colors"
                      data-testid={`button-scan-${(clip as any).id ?? rank}`}
                    >
                      <ScanSearch className="w-3 h-3" />
                      {(clip as any).videoScanned === false ? "Scan video" : "Scan range"}
                    </button>
                  ) : null
                )}

                {isRendering && (
                  <span className="text-[11px] text-gray-600">actions unlock when the file lands</span>
                )}
              </div>
            </div>
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
      const res = await fetchWithTimeout(`/api/videos/${videoId}/editorial-clip/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          clipStart: clip.clipStart,
          clipEnd: clip.clipEnd,
          // Assembled search results carry beats — without them the server
          // renders the whole contiguous envelope including the tangent.
          segments: (clip as any).segments,
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
            {Array.isArray((clip as any).segments) && (clip as any).segments.length > 1
              ? `Assembled · ${(clip as any).segments.length} beats`
              : `${formatTime(clip.clipStart)} - ${formatTime(clip.clipEnd)}`}
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
