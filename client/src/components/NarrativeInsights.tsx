import { useState } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { motion, AnimatePresence } from "framer-motion";
import {
  Brain, Sparkles, Tag, Target, ThumbsUp, Loader2, X,
  ArrowRight, Zap, CheckCircle, AlertCircle, BarChart3
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

interface SceneAnalysisResult {
  id: number;
  videoId: number;
  surfaceId: number | null;
  frameStart: number;
  frameEnd: number | null;
  narrativeContext: string | null;
  emotionalTone: string | null;
  culturalTags: string[] | null;
  placementViability: number | null;
  suggestedCategories: string[] | null;
  reasoning: string | null;
}

interface BrandMatch {
  id: number;
  sceneAnalysisId: number;
  brandProductId: number;
  compatibilityScore: number | null;
  reasoning: string | null;
  suggestedPlacementStyle: string | null;
  approved: boolean | null;
  approvedBy: string | null;
}

interface NarrativeInsightsProps {
  videoId: number;
  open: boolean;
  onClose: () => void;
}

const toneColors: Record<string, string> = {
  enthusiastic: "bg-orange-500/20 text-orange-300",
  serious: "bg-blue-500/20 text-blue-300",
  casual: "bg-green-500/20 text-green-300",
  educational: "bg-purple-500/20 text-purple-300",
  humorous: "bg-yellow-500/20 text-yellow-300",
  intimate: "bg-pink-500/20 text-pink-300",
  inspirational: "bg-amber-500/20 text-amber-300",
  neutral: "bg-gray-500/20 text-gray-300",
};

function viabilityColor(score: number): string {
  if (score >= 0.8) return "text-green-400";
  if (score >= 0.6) return "text-yellow-400";
  if (score >= 0.4) return "text-orange-400";
  return "text-red-400";
}

export default function NarrativeInsights({ videoId, open, onClose }: NarrativeInsightsProps) {
  const { toast } = useToast();
  const [analyses, setAnalyses] = useState<SceneAnalysisResult[]>([]);
  const [brandMatches, setBrandMatches] = useState<Record<number, BrandMatch[]>>({});
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isMatching, setIsMatching] = useState<number | null>(null);
  const [isAutoPlacing, setIsAutoPlacing] = useState(false);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);

  const runAnalysis = async () => {
    setIsAnalyzing(true);
    try {
      // First check if analysis already exists
      const existingRes = await fetchWithTimeout(`/api/scenes/${videoId}/analysis`, { credentials: "include" });
      if (existingRes.ok) {
        const existing = await existingRes.json();
        if (existing.length > 0) {
          setAnalyses(existing);
          setHasAnalyzed(true);
          setIsAnalyzing(false);
          return;
        }
      }

      // Run new analysis
      const res = await fetchWithTimeout(`/api/scenes/${videoId}/analyze`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).error || "Analysis failed");
      const data = await res.json();
      setAnalyses(data.results || []);
      setHasAnalyzed(true);
      toast({ title: `Analyzed ${data.analyzed} scenes`, description: "Narrative intelligence ready" });
    } catch (err: any) {
      toast({ title: "Analysis failed", description: err.message, variant: "destructive" });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const matchBrands = async (sceneId: number) => {
    setIsMatching(sceneId);
    try {
      const res = await fetchWithTimeout(`/api/scenes/${sceneId}/match-brands`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).error || "Matching failed");
      const data = await res.json();
      setBrandMatches(prev => ({ ...prev, [sceneId]: data.matches }));
      toast({ title: `Found ${data.matches.length} brand matches` });
    } catch (err: any) {
      toast({ title: "Brand matching failed", description: err.message, variant: "destructive" });
    } finally {
      setIsMatching(null);
    }
  };

  const approveBrandMatch = async (sceneId: number, matchId: number) => {
    try {
      const res = await fetchWithTimeout(`/api/scenes/${sceneId}/matches/${matchId}/approve`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Approval failed");
      const updated = await res.json();
      setBrandMatches(prev => ({
        ...prev,
        [sceneId]: (prev[sceneId] || []).map(m => m.id === matchId ? updated : m),
      }));
    } catch (err: any) {
      toast({ title: "Approval failed", description: err.message, variant: "destructive" });
    }
  };

  const autoPlaceAll = async () => {
    setIsAutoPlacing(true);
    try {
      const res = await fetchWithTimeout(`/api/scenes/${videoId}/auto-place`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).error || "Auto-placement failed");
      const data = await res.json();
      toast({
        title: `Created ${data.created} placements`,
        description: "Auto-placements from approved brand matches",
      });
    } catch (err: any) {
      toast({ title: "Auto-placement failed", description: err.message, variant: "destructive" });
    } finally {
      setIsAutoPlacing(false);
    }
  };

  const approvedCount = Object.values(brandMatches).flat().filter(m => m.approved).length;

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          className="bg-gray-900 rounded-xl w-full max-w-4xl max-h-[85vh] overflow-hidden flex flex-col"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-700">
            <div className="flex items-center gap-3">
              <Brain className="w-5 h-5 text-purple-400" />
              <h2 className="text-lg font-semibold text-white">Narrative Insights</h2>
              {hasAnalyzed && (
                <Badge variant="outline" className="text-purple-300 border-purple-500/30">
                  {analyses.length} scenes analyzed
                </Badge>
              )}
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Initial state — run analysis */}
            {!hasAnalyzed && !isAnalyzing && (
              <div className="text-center py-12">
                <Brain className="w-12 h-12 text-purple-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-white mb-2">AI Narrative Analysis</h3>
                <p className="text-gray-400 mb-6 max-w-md mx-auto">
                  Analyze detected surfaces with Claude AI to understand narrative context,
                  emotional tone, cultural relevance, and brand compatibility.
                </p>
                <Button onClick={runAnalysis} className="bg-purple-600 hover:bg-purple-700">
                  <Sparkles className="w-4 h-4 mr-2" />
                  Analyze Scenes
                </Button>
              </div>
            )}

            {/* Loading */}
            {isAnalyzing && (
              <div className="text-center py-12">
                <Loader2 className="w-8 h-8 text-purple-400 animate-spin mx-auto mb-4" />
                <p className="text-gray-300">Analyzing narrative context with Claude AI...</p>
                <p className="text-gray-500 text-sm mt-2">This may take 30-60 seconds</p>
              </div>
            )}

            {/* Results */}
            {hasAnalyzed && analyses.length > 0 && (
              <div className="space-y-4">
                {analyses.map((analysis) => (
                  <div key={analysis.id} className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <BarChart3 className="w-4 h-4 text-gray-400" />
                        <span className="text-sm text-gray-400">
                          {analysis.frameStart}s{analysis.frameEnd ? ` - ${analysis.frameEnd}s` : ''}
                        </span>
                        {analysis.emotionalTone && (
                          <Badge className={toneColors[analysis.emotionalTone.toLowerCase()] || toneColors.neutral}>
                            {analysis.emotionalTone}
                          </Badge>
                        )}
                      </div>
                      {analysis.placementViability != null && (
                        <span className={`text-sm font-mono font-bold ${viabilityColor(analysis.placementViability)}`}>
                          {(analysis.placementViability * 100).toFixed(0)}% viable
                        </span>
                      )}
                    </div>

                    {analysis.narrativeContext && (
                      <p className="text-white text-sm mb-2">{analysis.narrativeContext}</p>
                    )}

                    {analysis.reasoning && (
                      <p className="text-gray-400 text-xs mb-3">{analysis.reasoning}</p>
                    )}

                    {/* Tags row */}
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {(analysis.culturalTags || []).map((tag, i) => (
                        <Badge key={i} variant="outline" className="text-xs text-cyan-300 border-cyan-500/30">
                          <Tag className="w-3 h-3 mr-1" />
                          {tag}
                        </Badge>
                      ))}
                      {(analysis.suggestedCategories || []).map((cat, i) => (
                        <Badge key={`cat-${i}`} variant="outline" className="text-xs text-amber-300 border-amber-500/30">
                          <Target className="w-3 h-3 mr-1" />
                          {cat}
                        </Badge>
                      ))}
                    </div>

                    {/* Brand matching section */}
                    <div className="border-t border-gray-700 pt-3 mt-3">
                      {!brandMatches[analysis.id] ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => matchBrands(analysis.id)}
                          disabled={isMatching === analysis.id}
                          className="text-purple-300 border-purple-500/30 hover:bg-purple-500/10"
                        >
                          {isMatching === analysis.id ? (
                            <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                          ) : (
                            <Zap className="w-3 h-3 mr-2" />
                          )}
                          Auto-Match Brands
                        </Button>
                      ) : (
                        <div className="space-y-2">
                          <span className="text-xs text-gray-400 font-medium">Brand Matches:</span>
                          {brandMatches[analysis.id].length === 0 ? (
                            <p className="text-xs text-gray-500">No compatible brands found</p>
                          ) : (
                            brandMatches[analysis.id].map((match) => (
                              <div key={match.id} className="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className={`text-xs font-mono font-bold ${viabilityColor(match.compatibilityScore || 0)}`}>
                                      {((match.compatibilityScore || 0) * 100).toFixed(0)}%
                                    </span>
                                    <span className="text-xs text-gray-300">Product #{match.brandProductId}</span>
                                    {match.suggestedPlacementStyle && (
                                      <Badge variant="outline" className="text-[10px] text-gray-400 border-gray-600">
                                        {match.suggestedPlacementStyle}
                                      </Badge>
                                    )}
                                  </div>
                                  {match.reasoning && (
                                    <p className="text-[10px] text-gray-500 mt-1">{match.reasoning}</p>
                                  )}
                                </div>
                                {match.approved ? (
                                  <CheckCircle className="w-4 h-4 text-green-400 ml-2 flex-shrink-0" />
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => approveBrandMatch(analysis.id, match.id)}
                                    className="text-green-400 hover:text-green-300 h-7 px-2"
                                  >
                                    <ThumbsUp className="w-3 h-3 mr-1" />
                                    Approve
                                  </Button>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {hasAnalyzed && analyses.length === 0 && (
              <div className="text-center py-12">
                <AlertCircle className="w-8 h-8 text-yellow-400 mx-auto mb-3" />
                <p className="text-gray-300">No scenes could be analyzed.</p>
                <p className="text-gray-500 text-sm">Make sure the video has been scanned and has detected surfaces.</p>
              </div>
            )}
          </div>

          {/* Footer actions */}
          {hasAnalyzed && analyses.length > 0 && (
            <div className="border-t border-gray-700 p-4 flex items-center justify-between">
              <span className="text-sm text-gray-400">
                {approvedCount > 0 ? `${approvedCount} brand match${approvedCount > 1 ? 'es' : ''} approved` : 'Approve brand matches to auto-place'}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={runAnalysis}
                  disabled={isAnalyzing}
                  className="text-gray-300"
                >
                  Re-analyze
                </Button>
                <Button
                  onClick={autoPlaceAll}
                  disabled={isAutoPlacing || approvedCount === 0}
                  className="bg-green-600 hover:bg-green-700"
                >
                  {isAutoPlacing ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <ArrowRight className="w-4 h-4 mr-2" />
                  )}
                  Apply All ({approvedCount})
                </Button>
              </div>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
