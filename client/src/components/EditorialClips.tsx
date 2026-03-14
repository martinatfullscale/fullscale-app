/**
 * EditorialClips — Reusable component displaying ranked editorial clips for a video.
 *
 * Used by:
 * - Creator Library (Insights modal) — with transcribe/analyze controls
 * - RemixStudio — with "Generate This Clip" action
 * - BrandMarketplace — read-only view with "Buy Placement" action
 */

import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, Clock, TrendingUp, Tag, ChevronDown, ChevronUp,
  Loader2, Mic, Brain, Zap, Eye, Heart, Shield, MessageSquare,
  RefreshCw, Play, DollarSign, Filter,
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
}

interface TranscriptStatus {
  status: "none" | "processing" | "completed" | "failed";
  wordCount?: number;
  segmentCount?: number;
  speakerCount?: number;
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

  return (
    <div className="space-y-4">
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
}: {
  clip: RankedClip;
  rank: number;
  mode: "creator" | "brand" | "remix";
  isExpanded: boolean;
  onToggleExpand: () => void;
  onGenerate?: () => void;
  onBuy?: () => void;
}) {
  const viralPct = Math.round(clip.finalScore * 100);
  const tierBadge = getTierBadge(clip.monetizationTier);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={`bg-gray-800/60 rounded-xl border border-gray-700/50 overflow-hidden`}
    >
      {/* Main Row */}
      <div className="p-4">
        <div className="flex items-start gap-3">
          {/* Rank Badge */}
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border ${getViralBg(clip.finalScore)}`}>
            <span className={`text-sm font-bold ${getViralColor(clip.finalScore)}`}>{rank}</span>
          </div>

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

            {/* Action Buttons */}
            {mode === "remix" && onGenerate && (
              <Button
                size="sm"
                onClick={onGenerate}
                className="bg-purple-600 hover:bg-purple-500 text-white text-xs"
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
