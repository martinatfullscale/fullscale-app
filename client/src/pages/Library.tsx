import { useState, useEffect, useRef } from "react";
import { TopBar } from "@/components/TopBar";
import { Upload, Eye, CheckCircle, Loader2, AlertTriangle, X, Shield, Sun, Tag, Box, DollarSign, Sparkles, RefreshCw, Play, Globe, HardDrive, Scan, Video, Wand2, Trash2, Pencil, Brain, Scissors, Send } from "lucide-react";
import { useLocation, useSearch } from "wouter";
import { SiInstagram, SiYoutube, SiTwitch, SiFacebook, SiTiktok, SiX } from "react-icons/si";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { useHybridMode } from "@/hooks/use-hybrid-mode";
import { usePitchMode } from "@/contexts/pitch-mode-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchWithTimeout } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { UploadModal, CONTENT_CATEGORIES, SUBCATEGORIES } from "@/components/UploadModal";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SceneAnalysisModal, VideoWithScenes } from "@/components/SceneAnalysisModal";
import NarrativeInsights from "@/components/NarrativeInsights";
import EditorialClips from "@/components/EditorialClips";
import RemixStudio from "@/components/RemixStudio";
import ReelBuilder from "@/components/ReelBuilder";
import DistributionDashboard from "@/components/DistributionDashboard";
import { VideoPreviewModal } from "@/components/VideoPreviewModal";

interface IndexedVideo {
  id: number;
  userId: string;
  youtubeId: string;
  title: string;
  description: string | null;
  viewCount: number;
  thumbnailUrl: string | null;
  status: string;
  priorityScore: number;
  publishedAt: string | null;
  category: string | null;
  subcategory?: string | null;
  isEvergreen: boolean | null;
  duration: string | null;
  platform?: string;
  brandName?: string;
  createdAt: string;
  updatedAt: string;
  adOpportunities: number;
  filePath?: string | null;
  /** Scene-inventory rollup from the server: canonical surfaces × recurring
   *  scenes. Null for videos scanned before the inventory existed — the
   *  card falls back to the raw adOpportunities count. */
  sceneSummary?: { sceneCount: number; surfaceCount: number; trackedMinutes: number } | null;
}

type PlatformFilter = "all" | "youtube" | "instagram" | "twitch" | "tiktok" | "twitter" | "facebook" | "fullscale";

interface VideoIndexResponse {
  videos: IndexedVideo[];
  total: number;
  /** Echoed by the server when ?as=<email> was honored. Null when the
   *  admin is viewing their own library. Drives the "Viewing as" banner. */
  viewingAs?: string | null;
}

const demoVideoData = [
  { 
    title: "Tech Setup Review", 
    views: "1.5M Views", 
    status: "Ready (3 Spots)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "3 Scenes Indexed",
    detectedObjects: ["Monitor", "Keyboard", "Mouse", "Empty Desk Space"],
    context: "Tech / Home Office",
    brandSafety: 99,
    cpm: 48,
    opportunity: "Perfect for: Peripheral Placement or Drinkware",
    surfaceLabel: "Available Surface: Desk Mat",
    boundingBox: { top: "55%", left: "50%", width: "40%", height: "35%" },
    sentiment: "Educational",
    culturalContext: "Western Home Office"
  },
  { 
    title: "Cooking Vlog", 
    views: "890k Views", 
    status: "Ready (2 Spots)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "2 Scenes Indexed",
    detectedObjects: ["Counter", "Cutting Board", "Kitchen Appliances", "Empty Counter Space"],
    context: "Lifestyle / Cooking",
    brandSafety: 98,
    cpm: 42,
    opportunity: "Perfect for: Kitchen Gadgets or Food Products",
    surfaceLabel: "Available Surface: Counter",
    boundingBox: { top: "60%", left: "20%", width: "45%", height: "30%" },
    sentiment: "Uplifting",
    culturalContext: "American Kitchen"
  },
  { 
    title: "Podcast Episode #42", 
    views: "450k Views", 
    status: "Scanning (78%)", 
    statusColor: "bg-yellow-500/20 text-yellow-400",
    statusDot: "bg-yellow-500",
    image: "https://images.unsplash.com/photo-1590602847861-f357a9332bbc?w=800&h=450&fit=crop",
    aiStatus: "scanning",
    aiText: "Processing...",
    detectedObjects: ["Microphone", "Headphones", "Table", "Acoustic Panels"],
    context: "Entertainment / Podcast",
    brandSafety: 97,
    cpm: 38,
    opportunity: "Perfect for: Audio Equipment or Beverages",
    surfaceLabel: "Available Surface: Table",
    boundingBox: { top: "50%", left: "30%", width: "40%", height: "35%" },
    sentiment: "Serious",
    culturalContext: "Podcast Studio"
  },
  { 
    title: "Home Workout", 
    views: "2.1M Views", 
    status: "Ready (4 Spots)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "4 Scenes Indexed",
    detectedObjects: ["Yoga Mat", "Weights", "Wall Space", "Floor Area"],
    context: "Fitness / Wellness",
    brandSafety: 100,
    cpm: 52,
    opportunity: "Perfect for: Fitness Equipment or Apparel",
    surfaceLabel: "Available Surface: Floor/Wall",
    boundingBox: { top: "30%", left: "60%", width: "35%", height: "50%" },
    sentiment: "Uplifting",
    culturalContext: "Home Gym"
  },
  { 
    title: "Remote Work Vlog", 
    views: "680k Views", 
    status: "Bidding Active ($320)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1521017432531-fbd92d768814?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "2 Scenes Indexed",
    detectedObjects: ["Laptop", "Coffee Cup", "Notebook", "Cafe Table"],
    context: "Lifestyle / Remote Work",
    brandSafety: 95,
    cpm: 36,
    opportunity: "Perfect for: Laptop Accessories or Coffee Brands",
    surfaceLabel: "Available Surface: Table",
    boundingBox: { top: "45%", left: "25%", width: "50%", height: "40%" },
    sentiment: "Educational",
    culturalContext: "Urban Cafe"
  },
  { 
    title: "DIY Workshop", 
    views: "320k Views", 
    status: "Brand Safety Review", 
    statusColor: "bg-yellow-500/20 text-yellow-400",
    statusDot: "bg-yellow-500",
    image: "https://images.unsplash.com/photo-1530124566582-a618bc2615dc?w=800&h=450&fit=crop",
    aiStatus: "scanning",
    aiText: "Processing...",
    detectedObjects: ["Workbench", "Tools", "Storage Wall", "Project Area"],
    context: "DIY / Crafts",
    brandSafety: 88,
    cpm: 32,
    opportunity: "Perfect for: Tool Brands or Hardware",
    surfaceLabel: "Available Surface: Workbench",
    boundingBox: { top: "40%", left: "15%", width: "45%", height: "45%" },
    sentiment: "Educational",
    culturalContext: "American Garage Workshop"
  },
];

function AiOverlayIcon({ status }: { status: string }) {
  if (status === "ready") return <CheckCircle className="w-3 h-3 text-emerald-400" />;
  if (status === "scanning") return <Loader2 className="w-3 h-3 text-yellow-400 animate-spin" />;
  if (status === "pending") return <AlertTriangle className="w-3 h-3 text-zinc-400" />;
  if (status === "retry") return <RefreshCw className="w-3 h-3 text-amber-400" />;
  if (status === "issue") return <AlertTriangle className="w-3 h-3 text-red-400" />;
  return null;
}

type DemoVideoType = typeof demoVideoData[0];

interface DisplayVideo {
  id?: number;
  title: string;
  views: string;
  status: string;
  statusColor: string;
  statusDot: string;
  image: string;
  aiStatus: string;
  aiText: string;
  detectedObjects: string[];
  context: string;
  brandSafety: number;
  cpm: number;
  opportunity: string;
  surfaceLabel: string;
  boundingBox: { top: string; left: string; width: string; height: string };
  platform: string;
  brandName?: string;
  sentiment?: string;
  culturalContext?: string;
  hasLocalFile: boolean;
  filePath?: string | null;
  thumbnailUrl?: string | null;
  category?: string;
  subcategory?: string | null;
  youtubeId?: string | null;
  sourceUrl?: string | null;
  sceneSummary?: { sceneCount: number; surfaceCount: number; trackedMinutes: number } | null;
}

function getVideoStatusInfo(video: IndexedVideo): { status: string; statusColor: string; statusDot: string; aiStatus: string; aiText: string } {
  const dbStatus = ((video as any).status || (video as any).scan_status || "")?.toLowerCase() || "";
  const adOpportunities = (video as any).adOpportunities ?? (video as any).opportunities_count ?? 0;
  
  if (dbStatus === "scanning" || dbStatus.includes("scanning") || dbStatus === "pending") {
    return {
      status: "Scanning...",
      statusColor: "bg-yellow-500/20 text-yellow-400",
      statusDot: "bg-yellow-500",
      aiStatus: "scanning",
      aiText: "Processing..."
    };
  }

  // Scene-inventory rollup is the honest count when the scan produced one:
  // canonical physical surfaces across recurring scene classes, not the
  // per-frame detection rows that inflate with sampling density. Null on
  // videos scanned before the inventory existed — those fall through to
  // the raw adOpportunities count below.
  const sceneSummary = (video as any).sceneSummary ?? null;
  if (sceneSummary && sceneSummary.surfaceCount > 0) {
    return {
      status: `${sceneSummary.surfaceCount} surface${sceneSummary.surfaceCount !== 1 ? "s" : ""} · ${sceneSummary.sceneCount} scene${sceneSummary.sceneCount !== 1 ? "s" : ""}`,
      statusColor: "bg-emerald-500/20 text-emerald-400",
      statusDot: "bg-emerald-500",
      aiStatus: "ready",
      aiText: `${sceneSummary.sceneCount} Scene${sceneSummary.sceneCount !== 1 ? "s" : ""} Indexed`
    };
  }

  if (adOpportunities > 0) {
    return {
      status: `Ready (${adOpportunities} Spots)`,
      statusColor: "bg-emerald-500/20 text-emerald-400",
      statusDot: "bg-emerald-500",
      aiStatus: "ready",
      aiText: `${adOpportunities} Surfaces Found`
    };
  }
  
  if (dbStatus.startsWith("ready")) {
    const spotMatch = dbStatus.match(/\((\d+)\s*spots?\)/i);
    const spots = spotMatch ? parseInt(spotMatch[1]) : 0;
    return {
      status: `Ready (${spots} Spots)`,
      statusColor: spots > 0 ? "bg-emerald-500/20 text-emerald-400" : "bg-zinc-500/20 text-zinc-400",
      statusDot: spots > 0 ? "bg-emerald-500" : "bg-zinc-500",
      aiStatus: "ready",
      aiText: `${spots} Surfaces Found`
    };
  }
  
  // Whole scan-failure family (— Cancelled / — Interrupted / — Source
  // Unavailable / — Reconnect …) maps to a retryable state so the creator
  // can rescan instead of the row falling through to "Pending Scan".
  if (dbStatus === "indexed" || dbStatus.startsWith("scan failed") || dbStatus === "ready (0 spots)") {
    const failDetail = dbStatus.startsWith("scan failed —") || dbStatus.startsWith("scan failed -")
      ? (video as any).status.split(/—|-/).slice(1).join("-").trim()
      : "";
    return {
      status: failDetail ? `Scan Failed — Retry` : "No Surfaces - Retry",
      statusColor: "bg-amber-500/20 text-amber-400",
      statusDot: "bg-amber-500",
      aiStatus: "retry",
      aiText: failDetail || "0 Found - Retry"
    };
  }
  
  return {
    status: "Pending Scan",
    statusColor: "bg-zinc-500/20 text-zinc-400",
    statusDot: "bg-zinc-500",
    aiStatus: "pending",
    aiText: "Awaiting Scan"
  };
}

function formatIndexedVideo(video: IndexedVideo): DisplayVideo {
  const statusInfo = getVideoStatusInfo(video);
  const viewCount = (video as any).viewCount ?? (video as any).view_count ?? 0;
  const rawThumbnailUrl = (video as any).thumbnailUrl || (video as any).thumbnail_url || "";
  const filePath = (video as any).filePath || (video as any).file_path || null;
  const fileExists = (video as any).fileExists ?? false;
  // For local files, prefer the extracted frame (correct orientation) over YouTube thumbnail
  // YouTube thumbnails are always 16:9 landscape regardless of actual video orientation
  const hasLocalFile = !!(filePath && fileExists);
  // Object Storage frames use /storage/ prefix, legacy local frames use /uploads/
  const extractedFrame = `/storage/uploads/frames/${video.id}/frame_0s.jpg`;
  const legacyFrame = `/uploads/frames/${video.id}/frame_0s.jpg`;
  const thumbnailUrl = hasLocalFile
    ? extractedFrame
    : (rawThumbnailUrl && (rawThumbnailUrl.startsWith('http') || rawThumbnailUrl.startsWith('/')))
      ? rawThumbnailUrl
      : extractedFrame;
  const platform = (video as any).platform || "youtube";
  const brandName = (video as any).brandName || (video as any).brand_name || "";
  const sentiment = (video as any).sentiment || (video as any).sentiment || "";
  const culturalContext = (video as any).culturalContext || (video as any).cultural_context || "";

  return {
    id: video.id,
    title: video.title,
    views: `${viewCount.toLocaleString()} Views`,
    ...statusInfo,
    image: thumbnailUrl,
    detectedObjects: [],
    context: video.category || "",
    brandSafety: 0,
    cpm: 0,
    opportunity: "",
    surfaceLabel: "",
    boundingBox: { top: "0%", left: "0%", width: "0%", height: "0%" },
    platform,
    brandName,
    sentiment,
    culturalContext,
    hasLocalFile: fileExists,
    filePath,
    thumbnailUrl,
    category: video.category || undefined,
    subcategory: video.subcategory || undefined,
    // Carry the platform identifiers through so the scene modal's "Watch on
    // YouTube/Instagram/Facebook" embed button has what it needs.
    youtubeId: (video as any).youtubeId || (video as any).youtube_id || null,
    sourceUrl: (video as any).sourceUrl || (video as any).source_url || null,
    // Scene rollup rides along so the click handler can recognize a
    // completed scan even when the status badge shows the inventory
    // counts instead of the legacy "Ready (N Spots)" text.
    sceneSummary: (video as any).sceneSummary ?? null,
  };
}

interface DetectedSurface {
  id: number;
  videoId: number;
  timestamp: string;
  surfaceType: string;
  confidence: string;
  boundingBoxX: string;
  boundingBoxY: string;
  boundingBoxWidth: string;
  boundingBoxHeight: string;
}

const CPM_BY_SURFACE: Record<string, number> = {
  "Desk": 25,
  "Table": 22,
  "Laptop": 30,
  "Monitor": 28,
  "Wall": 15,
  "Bottle": 35,
};

const BRAND_SAFETY_BY_SURFACE: Record<string, number> = {
  "Desk": 92,
  "Table": 88,
  "Laptop": 95,
  "Monitor": 90,
  "Wall": 85,
  "Bottle": 80,
};

function AnalysisModal({ video, open, onClose }: { video: DisplayVideo | null; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  
  const { data: surfacesData, isLoading } = useQuery<{ surfaces: DetectedSurface[]; count: number }>({
    queryKey: ['/api/video', video?.id, 'surfaces'],
    enabled: open && !!video?.id,
  });

  if (!video) return null;

  const surfaces = surfacesData?.surfaces || [];
  const detectedTypes = Array.from(new Set(surfaces.map(s => s.surfaceType)));
  
  const avgCpm = detectedTypes.length > 0 
    ? Math.round(detectedTypes.reduce((sum, t) => sum + (CPM_BY_SURFACE[t] || 20), 0) / detectedTypes.length)
    : 0;
  
  const avgBrandSafety = detectedTypes.length > 0
    ? Math.round(detectedTypes.reduce((sum, t) => sum + (BRAND_SAFETY_BY_SURFACE[t] || 85), 0) / detectedTypes.length)
    : 0;

  const firstSurface = surfaces[0];
  const boundingBox = firstSurface ? {
    top: `${parseFloat(firstSurface.boundingBoxY) * 100}%`,
    left: `${parseFloat(firstSurface.boundingBoxX) * 100}%`,
    width: `${parseFloat(firstSurface.boundingBoxWidth) * 100}%`,
    height: `${parseFloat(firstSurface.boundingBoxHeight) * 100}%`,
  } : { top: "0%", left: "0%", width: "0%", height: "0%" };

  const handleApprove = () => {
    toast({
      title: "Surface Approved",
      description: "This surface is now visible to brands as a placement option.",
    });
    onClose();
  };

  const safetyColor = avgBrandSafety >= 90 ? "text-emerald-400" : avgBrandSafety >= 70 ? "text-yellow-400" : "text-red-400";

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl p-0 bg-zinc-900 border-white/10 overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-2">
          <div className="relative aspect-video md:aspect-auto md:h-full bg-black">
            <img 
              src={video.image} 
              alt={video.title}
              className="w-full h-full object-cover"
            />
            {firstSurface && (
              <div 
                className="absolute border-2 border-emerald-400 rounded-sm"
                style={{
                  top: boundingBox.top,
                  left: boundingBox.left,
                  width: boundingBox.width,
                  height: boundingBox.height,
                  boxShadow: '0 0 0 2px rgba(16, 185, 129, 0.2), inset 0 0 20px rgba(16, 185, 129, 0.1)'
                }}
              >
                <div className="absolute -top-6 left-0 bg-emerald-500/90 text-white text-xs font-mono px-2 py-0.5 rounded-sm whitespace-nowrap">
                  {firstSurface.surfaceType}
                </div>
                <div className="absolute inset-0 bg-emerald-400/5" />
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-4">
              <p className="text-white/70 text-xs font-mono">
                {firstSurface ? `frame @ ${firstSurface.timestamp}s` : "No surfaces detected"}
              </p>
            </div>
          </div>

          <div className="p-6 space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">AI Vision Analysis</p>
                <h2 className="text-xl font-bold text-white">Scene Analysis</h2>
                <p className="text-sm text-muted-foreground mt-1">{video.title}</p>
              </div>
              <Button 
                size="icon" 
                variant="ghost" 
                onClick={onClose}
                data-testid="button-close-modal"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                    <div className="flex items-center gap-2 mb-1">
                      <Shield className="w-4 h-4 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground font-mono uppercase">Brand Safety</span>
                    </div>
                    <p className={`text-lg font-bold font-mono ${safetyColor}`}>
                      {avgBrandSafety > 0 ? `${avgBrandSafety}% Safe` : "N/A"}
                    </p>
                  </div>
                  <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                    <div className="flex items-center gap-2 mb-1">
                      <Sun className="w-4 h-4 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground font-mono uppercase">Surfaces</span>
                    </div>
                    <p className="text-lg font-bold font-mono text-white">{surfaces.length} Found</p>
                  </div>
                </div>

                <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                  <div className="flex items-center gap-2 mb-2">
                    <Tag className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground font-mono uppercase">Context</span>
                  </div>
                  <p className="text-white font-mono">{video.context || "Video Content"}</p>
                </div>

                <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                  <div className="flex items-center gap-2 mb-2">
                    <Box className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground font-mono uppercase">Detected Objects</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {detectedTypes.length > 0 ? (
                      detectedTypes.map((obj, idx) => (
                        <span key={idx} className="px-2 py-1 bg-white/10 rounded text-xs font-mono text-white/80">
                          {obj}
                        </span>
                      ))
                    ) : video.aiStatus === "pending" ? (
                      <span className="text-xs text-muted-foreground">No objects detected. Run a scan first.</span>
                    ) : (
                      <span className="text-xs text-yellow-400">No surfaces found in this scene. Try a different timestamp or video.</span>
                    )}
                  </div>
                </div>

                <div className="bg-emerald-500/10 rounded-lg p-3 border border-emerald-500/20">
                  <div className="flex items-center gap-2 mb-1">
                    <DollarSign className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs text-emerald-400 font-mono uppercase">Opportunity</span>
                  </div>
                  <p className="text-white font-mono text-sm">
                    {detectedTypes.length > 0 ? `${detectedTypes.join(", ")} placement available` : "Scan video to find opportunities"}
                  </p>
                  <p className="text-emerald-400 font-mono text-sm mt-1">
                    {avgCpm > 0 ? `CPM $${avgCpm}` : "CPM TBD"}
                  </p>
                </div>
              </div>
            )}

            <Button 
              className="w-full gap-2" 
              onClick={handleApprove}
              disabled={surfaces.length === 0}
              data-testid="button-approve-placement"
            >
              <CheckCircle className="w-4 h-4" />
              Approve Placement
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Empty state that knows whether YouTube is connected.
 *
 * The old version offered one button — "Sync YouTube Channel" — which cannot
 * succeed for a creator who hasn't connected YouTube, and hid the two paths
 * that DO work for them (paste a link, upload a file) even though both are on
 * the page. Unconnected creators get three equal doors; connected ones get Sync.
 */
function EmptyLibrary({ connected, onSync, isSyncing, onConnect, onPaste, onUpload }: {
  connected: boolean | null;
  onSync: () => void;
  isSyncing: boolean;
  onConnect: () => void;
  onPaste: () => void;
  onUpload: () => void;
}) {
  if (connected) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-8">
        <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mb-6">
          <Play className="w-10 h-10 text-muted-foreground" />
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">Your Library is Empty</h2>
        <p className="text-muted-foreground text-center max-w-md mb-8">
          Your YouTube channel is connected. Sync it to pull in your videos, or paste a link / upload a file above.
        </p>
        <Button size="lg" className="gap-2" onClick={onSync} disabled={isSyncing} data-testid="button-sync-channel">
          {isSyncing ? <Loader2 className="w-5 h-5 animate-spin" /> : <RefreshCw className="w-5 h-5" />}
          {isSyncing ? "Syncing Channel..." : "Sync YouTube Channel"}
        </Button>
      </div>
    );
  }
  const Door = ({ icon: Icon, title, body, cta, onClick, testId }: { icon: any; title: string; body: string; cta: string; onClick: () => void; testId: string }) => (
    <button
      onClick={onClick}
      className="flex flex-col items-start gap-3 p-5 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/20 text-left transition-colors"
      data-testid={testId}
    >
      <span className="w-10 h-10 rounded-lg bg-primary/15 text-primary flex items-center justify-center"><Icon className="w-5 h-5" /></span>
      <span className="font-semibold text-white">{title}</span>
      <span className="text-sm text-muted-foreground leading-snug">{body}</span>
      <span className="mt-auto text-sm font-medium text-primary">{cta} →</span>
    </button>
  );
  return (
    <div className="flex flex-col items-center justify-center py-16 px-8">
      <h2 className="text-2xl font-bold text-white mb-2">Bring in your first video</h2>
      <p className="text-muted-foreground text-center max-w-md mb-8">
        Three ways in. Once a video is here, FullScale scans it and cuts your first clips automatically.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-3xl">
        <Door icon={Video} title="Connect YouTube" body="Pull your whole channel in and keep it synced." cta="Connect" onClick={onConnect} testId="empty-connect-youtube" />
        <Door icon={Globe} title="Paste a link" body="A YouTube, TikTok, Twitch or X video URL — no account needed." cta="Paste a link" onClick={onPaste} testId="empty-paste-link" />
        <Door icon={Upload} title="Upload a file" body="An MP4 from your computer." cta="Upload" onClick={onUpload} testId="empty-upload-file" />
      </div>
    </div>
  );
}

export default function Library() {
  const { user } = useAuth();
  const { mode: hybridMode, isLoading: isAuthLoading } = useHybridMode();
  const { isPitchMode } = usePitchMode();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [selectedVideo, setSelectedVideo] = useState<DisplayVideo | null>(null);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  // URL-paste import (YouTube / Twitch / TikTok / X)
  const [importUrlValue, setImportUrlValue] = useState("");
  const [isImportingUrl, setIsImportingUrl] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sceneModalOpen, setSceneModalOpen] = useState(false);
  const [sceneVideo, setSceneVideo] = useState<VideoWithScenes | null>(null);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewVideo, setPreviewVideo] = useState<DisplayVideo | null>(null);
  const [previewStartTime, setPreviewStartTime] = useState(0);
  const [narrativeInsightsOpen, setNarrativeInsightsOpen] = useState(false);
  const [narrativeVideoId, setNarrativeVideoId] = useState<number | null>(null);
  const [remixStudioOpen, setRemixStudioOpen] = useState(false);
  const [reelBuilderOpen, setReelBuilderOpen] = useState(false);
  const [remixVideoId, setRemixVideoId] = useState<number | null>(null);
  const [distributionOpen, setDistributionOpen] = useState(false);
  const [distributionVideoId, setDistributionVideoId] = useState<number | null>(null);

  // ----- Admin "view as user" -----
  // Reads ?as=<email> from the URL on mount and any time the URL changes.
  // When set (and the caller is admin), the library endpoint returns that
  // user's videos instead of the caller's own. Backed by the server-side
  // override in GET /api/video-index/with-opportunities.
  const [viewAsEmail, setViewAsEmail] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const v = params.get("as");
    return v ? v.toLowerCase().trim() || null : null;
  });
  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      const v = params.get("as");
      setViewAsEmail(v ? v.toLowerCase().trim() || null : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  /** Strip ?as= from the URL and clear local state — "Return to my library". */
  const clearViewAs = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("as");
    window.history.replaceState({}, "", url.toString());
    setViewAsEmail(null);
  };
  /** Set ?as=<email> in the URL and trigger refetch. */
  const setViewAs = (email: string | null) => {
    const url = new URL(window.location.href);
    if (email) url.searchParams.set("as", email);
    else url.searchParams.delete("as");
    window.history.replaceState({}, "", url.toString());
    setViewAsEmail(email);
  };

  // Admin emails for flexible auth fallback (supports URL param bypass in dev)
  const ADMIN_EMAILS = ['martin@gofullscale.co', 'martin@whtwrks.com', 'martincekechukwu@gmail.com'];
  
  // Check for admin_email in URL (dev bypass)
  const urlParams = new URLSearchParams(window.location.search);
  const adminEmailFromUrl = urlParams.get('admin_email') || '';
  const isUrlAdminBypass = ADMIN_EMAILS.includes(adminEmailFromUrl);
  
  // Use URL admin email if present and valid, otherwise fall back to session user
  const userEmail = isUrlAdminBypass ? adminEmailFromUrl : (user?.email || '');
  const isAdminUser = ADMIN_EMAILS.includes(userEmail);
  
  // Force "real" mode if admin_email bypass is active
  const mode = isUrlAdminBypass ? "real" : hybridMode;
  
  // Debug logging for mode detection
  console.log(`[Library] ===== MODE DEBUG =====`);
  console.log(`[Library] URL: ${window.location.href}`);
  console.log(`[Library] adminEmailFromUrl: "${adminEmailFromUrl}"`);
  console.log(`[Library] isUrlAdminBypass: ${isUrlAdminBypass}`);
  console.log(`[Library] hybridMode: ${hybridMode}`);
  console.log(`[Library] FINAL mode: ${mode}`);
  console.log(`[Library] userEmail: ${userEmail}, isAdminUser: ${isAdminUser}`);
  
  const handleVideoClick = async (video: DisplayVideo) => {
    const videoId = video.id || 1001;
    const viewCount = parseInt(video.views.replace(/[^0-9]/g, '')) || 0;
    
    console.log(`[Library] ===== VIDEO CLICKED =====`);
    console.log(`[Library] Video:`, video);
    console.log(`[Library] videoId: ${videoId}, isRealMode: ${isRealMode}, isPitchMode: ${isPitchMode}, mode: ${mode}`);
    console.log(`[Library] hasLocalFile: ${video.hasLocalFile}, filePath: ${video.filePath}, status: ${video.status}`);
    
    // For scanned videos (status contains "Complete" or "Ready"), show scene analysis modal with surfaces
    // This takes priority over video preview for analyzed content.
    // sceneSummary.surfaceCount covers cards whose badge shows the inventory
    // counts ("3 surfaces · 2 scenes") — that status text contains neither
    // "Complete" nor "Ready" but the scan is very much done.
    const videoAny = video as any;
    const adOpportunityCount = videoAny.adOpportunities ?? videoAny.surfaceCount ?? videoAny.sceneSummary?.surfaceCount ?? 0;
    const hasCompletedScan = video.status?.toLowerCase().includes('complete') || 
                             video.status?.toLowerCase().includes('ready') ||
                             adOpportunityCount > 0;
    
    console.log(`[Library] hasCompletedScan: ${hasCompletedScan}, adOpportunities: ${adOpportunityCount}`);
    
    // In real mode with completed scan, show scene analysis modal
    if (isRealMode && videoId >= 50 && hasCompletedScan) {
      console.log(`[Library] Video has completed scan - showing scene analysis modal`);
    } else if (video.hasLocalFile && video.filePath && !hasCompletedScan) {
      // Only show video preview for local files that haven't been scanned yet
      console.log(`[Library] Opening video preview modal (unscanned local file)`);
      setPreviewVideo(video);
      setPreviewModalOpen(true);
      return;
    }
    
    // In real mode, fetch actual detected surfaces from the database
    console.log(`[Library] Checking real mode: isRealMode=${isRealMode}, videoId >= 50: ${videoId >= 50}`);
    if (isRealMode && videoId >= 50) {
      try {
        // Pass admin_email for flexible auth if user is admin.
        // includeUnapproved=true: when the owner is browsing their own
        // library, show ALL detected surfaces (not just creatorApproved).
        // Without this, fresh-scanned videos look empty because every new
        // surface defaults to creatorApproved=false until explicitly
        // approved via the review UI.
        const params = new URLSearchParams({ includeUnapproved: "true" });
        if (isAdminUser && userEmail) params.set("admin_email", userEmail);
        const url = `/api/video/${videoId}/surfaces?${params.toString()}`;
        console.log(`[Library] Fetching surfaces from: ${url}`);
        const res = await fetch(url, { credentials: "include" });
        console.log(`[Library] Response status: ${res.status}`);
        if (res.ok) {
          const data = await res.json();
          console.log(`[Library] Surfaces data:`, data);
          // Convert detected_surfaces to Scene format
          const surfaces = data.surfaces || [];
          const uniqueTimestamps = Array.from(new Set(surfaces.map((s: any) => s.timestamp || 0))) as number[];
          
          // Use actual video thumbnail — only use valid browser URLs (http or root-relative)
          const videoThumbnail = video.thumbnailUrl && (video.thumbnailUrl.startsWith('http') || video.thumbnailUrl.startsWith('/'))
            ? video.thumbnailUrl
            : null;
          const fallbackImage = videoThumbnail || `/uploads/frames/${videoId}/frame_0s.jpg`;

          // Normalize frame URLs from DB (may have absolute Replit paths or ./public/ prefixes)
          const normalizeFrameUrl = (url: string | null | undefined): string | null => {
            if (!url) return null;
            let src = url;
            src = src.replace(/^\/home\/runner\/workspace\/public\//, '/');
            src = src.replace(/^\.\/public\//, '/');
            src = src.replace(/^public\//, '/');
            src = src.replace(/\/\//g, '/');
            if (!src.startsWith('/') && !src.startsWith('http')) src = '/' + src;
            return src;
          };

          // Build frame URL from timestamp when DB has no frameUrl (batch/admin inserts)
          const buildFrameUrl = (ts: number): string => {
            const roundedTs = Math.floor(Number(ts));
            return `/uploads/frames/${videoId}/frame_${roundedTs}s.jpg`;
          };

          const scenes = uniqueTimestamps
            .map((ts: number, idx: number) => {
              const surfacesAtTime = surfaces.filter((s: any) => (s.timestamp || 0) === ts);
              // Only include scenes where at least one surface has a frame on disk
              const hasFrame = surfacesAtTime.some((s: any) => s.frameExists !== false);
              const surfaceTypes = Array.from(new Set(surfacesAtTime.map((s: any) => s.surfaceType || s.surface_type))) as string[];
              const avgConfidence = surfacesAtTime.reduce((sum: number, s: any) => sum + (s.confidence || 0.5), 0) / surfacesAtTime.length;

              return {
                id: `scene-${videoId}-${idx}`,
                timestamp: `${Math.floor(Number(ts) / 60)}:${String(Math.floor(Number(ts) % 60)).padStart(2, '0')}`,
                imageUrl: normalizeFrameUrl(surfacesAtTime[0]?.frameUrl || surfacesAtTime[0]?.frame_url) || buildFrameUrl(ts),
                surfaces: surfacesAtTime.length,
                surfaceTypes: surfaceTypes as string[],
                context: surfaceTypes.length > 0 ? `${surfaceTypes[0]} area` : "Workspace",
                confidence: avgConfidence,
                hasFrame,
              };
            })
            // Don't filter by hasFrame — frame files may still be accessible via URL even if
            // server-side fs.existsSync check failed (e.g., CDN, reverse proxy, timing issues).
            // The UI already handles broken images gracefully with a fallback.

          // If no surfaces, create a placeholder scene using video thumbnail
          const finalScenes = scenes.length > 0 ? scenes : [{
            id: `scene-${videoId}-0`,
            timestamp: "0:00",
            imageUrl: fallbackImage,
            surfaces: 0,
            surfaceTypes: [],
            context: "No surfaces detected yet - scan video to detect placement surfaces",
            confidence: 0,
          }];
          
          setSceneVideo({
            id: videoId,
            title: video.title,
            duration: "10:00",
            viewCount: viewCount,
            scenes: finalScenes,
            filePath: video.filePath,
            youtubeId: (video as any).youtubeId,
            platform: (video as any).platform,
            sourceUrl: (video as any).sourceUrl,
          });
          setSceneModalOpen(true);
          return;
        }
      } catch (err) {
        console.error("[Library] Failed to fetch real surfaces:", err);
      }
    }
    
    // No fallback - use empty state to trigger scan prompt in modal
    const videoThumbnailEmpty = (video.thumbnailUrl && (video.thumbnailUrl.startsWith('http') || video.thumbnailUrl.startsWith('/')))
      ? video.thumbnailUrl : null;
    const emptyScene = [{
      id: `${videoId}-empty`,
      timestamp: "00:00",
      imageUrl: videoThumbnailEmpty || `/uploads/frames/${videoId}/frame_0s.jpg`,
      surfaces: 0,
      surfaceTypes: [],
      context: "No scan data - click 'Scan with AI' to detect surfaces",
      confidence: 0,
    }];
    setSceneVideo({
      id: videoId,
      title: video.title,
      duration: "10:00",
      viewCount: viewCount,
      scenes: emptyScene,
      filePath: video.filePath,
      youtubeId: (video as any).youtubeId,
      platform: (video as any).platform,
      sourceUrl: (video as any).sourceUrl,
    });
    setSceneModalOpen(true);
  };
  
  // Invalidate video cache when pitch mode changes to force refetch
  useEffect(() => {
    console.log(`[Library] isPitchMode changed to: ${isPitchMode}, invalidating cache`);
    queryClient.invalidateQueries({ queryKey: ["videos"] });
  }, [isPitchMode, queryClient]);

  // PRIORITY: isPitchMode toggle is checked FIRST - overrides authentication state
  const isRealMode = !isPitchMode && mode === "real";
  
  // Version key to force refetch when demo data changes - increment when adding new videos
  const DEMO_DATA_VERSION = 2;
  
  // Is YouTube connected? Drives the empty state: "Sync" only makes sense
  // when it is; otherwise the creator needs the other doors (paste / upload).
  const { data: ytStatus } = useQuery<{ connected: boolean }>({
    queryKey: ["/api/auth/youtube/status"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/auth/youtube/status", { credentials: "include" });
      if (!res.ok) return { connected: false };
      return res.json();
    },
    staleTime: 60_000,
  });

  const { data: videoData, isLoading: isLoadingVideos, isError: isVideosError, error: videosError, isFetching: isFetchingVideos, refetch: refetchVideos } = useQuery<VideoIndexResponse>({
    queryKey: ["videos", isPitchMode, mode, DEMO_DATA_VERSION, isAdminUser, userEmail, viewAsEmail] as const,
    queryFn: async ({ queryKey }) => {
      // Extract isPitchMode and mode from queryKey to avoid stale closure
      const [, pitchModeFromKey, modeFromKey, , isAdmin, email, viewAs] = queryKey;

      console.log(`[Library] ===== QUERY FN DEBUG =====`);
      console.log(`[Library] queryKey:`, queryKey);
      console.log(`[Library] pitchModeFromKey: ${pitchModeFromKey}`);
      console.log(`[Library] modeFromKey: ${modeFromKey}`);
      console.log(`[Library] isAdmin: ${isAdmin}, email: ${email}, viewAs: ${viewAs ?? "(self)"}`);

      let endpoint = pitchModeFromKey ? "/api/demo/videos" : (modeFromKey === "real" ? "/api/video-index/with-opportunities" : "/api/demo/videos");

      // Build query string — preserve existing admin_email behavior + tack
      // on the new "view as user" param when set. Both are admin-only on
      // the server side.
      const params = new URLSearchParams();
      if (!pitchModeFromKey && modeFromKey === "real" && isAdmin && email) {
        params.set("admin_email", email as string);
      }
      if (!pitchModeFromKey && modeFromKey === "real" && viewAs) {
        params.set("as", viewAs as string);
      }
      const qs = params.toString();
      if (qs) endpoint += `?${qs}`;
      
      console.log(`[Library] FINAL endpoint: ${endpoint}`);
      console.log(`[Library] Expected: /api/video-index/with-opportunities?admin_email=...`);
      
      const res = await fetchWithTimeout(endpoint, { credentials: "include" });
      if (!res.ok) {
        // Keeping the server's message matters: a hardcoded string here made
        // every backend failure indistinguishable, and the render below turns
        // any error into the "connect your channel" empty state — so a broken
        // library and an empty one looked identical for the whole outage.
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Failed to load your library (${res.status})`);
      }
      const data = await res.json();
      
      console.log(`[Library] Videos fetched: ${data.videos?.length} items`);
      console.log(`[Library] First video ID: ${data.videos?.[0]?.id} (should be < 100 for real videos)`);
      
      return data;
    },
    retry: 2,
    staleTime: 0,
    // Don't fetch until auth state is resolved — prevents briefly hitting /api/demo/videos
    // when hybridMode is "demo" while auth is still loading after a hard redirect
    enabled: !isAuthLoading || isPitchMode || isUrlAdminBypass,
    // The server's /api/video-index endpoint kicks off a background IG/FB
    // thumbnail refresh on each call. Re-poll every 15s so refreshed thumbs
    // appear on the page without the user having to reload.
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetchWithTimeout("/api/video-index/refresh", {
        method: "POST",
        credentials: "include"
      });
      if (!res.ok) {
        // The server now says WHY (409 not connected / 502 token refresh
        // failed) instead of a 200 with indexed:0 that read as "no videos".
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body?.code === "not_connected"
            ? "YouTube isn't connected yet — connect it in Settings, or paste a video link above."
            : body?.code === "token_refresh_failed"
              ? "Your YouTube connection expired. Reconnect it in Settings and sync again."
              : body?.error || "Failed to sync channel",
        );
      }
      return res.json();
    },
    onSuccess: (data) => {
      const indexed = data.indexed || 0;
      if (indexed === 0) {
        // Zero indexed usually means YouTube isn't connected yet — a green
        // "success" here told new users everything worked while their
        // library stayed empty with no path forward.
        toast({
          title: "No videos found",
          description: "Connect your YouTube channel on the Dashboard first, or paste a video URL above to import one directly.",
        });
      } else {
        toast({
          title: "Channel Synced",
          description: `Indexed ${indexed} high-value videos from your channel.`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Sync Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const [scanningVideoIds, setScanningVideoIds] = useState<Set<number>>(new Set());
  
  const scanVideoMutation = useMutation({
    mutationFn: async (videoId: number) => {
      console.log(`[FRONTEND] ===== SCAN BUTTON CLICKED =====`);
      console.log(`[FRONTEND] Video ID: ${videoId}`);
      // Pass admin_email for flexible auth if user is admin
      const scanUrl = isAdminUser 
        ? `/api/video-scan/${videoId}?admin_email=${encodeURIComponent(userEmail)}`
        : `/api/video-scan/${videoId}`;
      console.log(`[FRONTEND] Sending POST to ${scanUrl}`);
      
      setScanningVideoIds(prev => new Set(prev).add(videoId));
      
      // Immediately update UI to show "Scanning..." status
      // Use invalidateQueries to force refetch with correct query key
      queryClient.setQueryData(
        ["videos", isPitchMode, mode, DEMO_DATA_VERSION, isAdminUser, userEmail],
        (oldData: VideoIndexResponse | undefined) => {
          if (!oldData?.videos) return oldData;
          return {
            ...oldData,
            videos: oldData.videos.map((v: IndexedVideo) => 
              v.id === videoId ? { ...v, status: "Scanning" } : v
            )
          };
        }
      );
      
      console.log(`[FRONTEND] UI updated to Scanning state, making fetch call...`);
      
      const res = await fetch(scanUrl, { 
        method: "POST",
        credentials: "include" 
      });
      
      console.log(`[FRONTEND] Fetch response status: ${res.status}`);
      
      if (!res.ok) {
        const errorText = await res.text();
        console.error(`[FRONTEND] Fetch failed: ${errorText}`);
        throw new Error("Failed to start scan");
      }
      
      const data = await res.json();
      console.log(`[FRONTEND] Success response:`, data);
      return data;
    },
    onSuccess: (_, videoId) => {
      toast({
        title: "Scan Started",
        description: "AI is analyzing your video. This may take 1-2 minutes depending on video length.",
      });
      
      const pollInterval = setInterval(async () => {
        try {
          const pollUrl = isAdminUser 
            ? `/api/video-index/with-opportunities?admin_email=${encodeURIComponent(userEmail)}`
            : `/api/video-index/with-opportunities`;
          const res = await fetch(pollUrl, { credentials: "include" });
          if (!res.ok) return;
          const data = await res.json();
          
          // Update cache with correct query key to match useQuery
          queryClient.setQueryData(
            ["videos", isPitchMode, mode, DEMO_DATA_VERSION, isAdminUser, userEmail],
            data
          );
          
          const video = data.videos?.find((v: IndexedVideo) => v.id === videoId);
          
          if (video && !video.status?.toLowerCase().includes("scanning")) {
            clearInterval(pollInterval);
            setScanningVideoIds(prev => {
              const next = new Set(prev);
              next.delete(videoId);
              return next;
            });
            // Invalidate BOTH the videos list AND this video's surfaces query —
            // the per-video surfaces query (`['/api/video', id, 'surfaces']`) is
            // what the SceneAnalysisModal renders, so without invalidation the
            // bbox overlays don't update until a hard refresh.
            queryClient.invalidateQueries({ queryKey: ["videos"] });
            queryClient.invalidateQueries({ queryKey: ['/api/video', videoId, 'surfaces'] });

            if (video.status?.toLowerCase().includes("ready") && video.adOpportunities > 0) {
              toast({
                title: "Scan Complete",
                description: `Found ${video.adOpportunities} ad placement surfaces. Click the video to view details.`,
              });
            } else if (video.status?.toLowerCase().startsWith("scan failed")) {
              toast({
                title: "Scan Failed",
                description: "Could not analyze this video. Please try again.",
                variant: "destructive",
              });
            } else {
              toast({
                title: "No Surfaces Found",
                description: "No suitable ad placement surfaces were detected in this video. Try a different video with visible desks, tables, or monitors.",
              });
            }
          }
        } catch (err) {
          console.error("Poll error:", err);
        }
      }, 3000);

      // 20-minute polling window (was 2min). Multi-GB uploads can take 8-15min
      // through Gemini at ~5MB/s with rate-limit backoff. The previous 2min
      // timeout left the spinner stuck on the thumbnail forever for large files;
      // user had to hard-refresh to see surfaces. 20min covers worst case.
      setTimeout(() => {
        clearInterval(pollInterval);
        setScanningVideoIds(prev => {
          const next = new Set(prev);
          next.delete(videoId);
          return next;
        });
        // Final cache invalidation in case the scan completed but the poll
        // missed the status flip (network blip, tab backgrounded, etc).
        queryClient.invalidateQueries({ queryKey: ["videos"] });
        queryClient.invalidateQueries({ queryKey: ['/api/video', videoId, 'surfaces'] });
      }, 20 * 60 * 1000);
    },
    onError: (error: Error, videoId) => {
      setScanningVideoIds(prev => {
        const next = new Set(prev);
        next.delete(videoId);
        return next;
      });
      toast({
        title: "Scan Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Deep links that land ON the thing they announce.
  //   ?video=<id>&open=clips  — from the "Your clips are ready" notification:
  //                              open Remix Studio on that video (defaults to
  //                              the clips tab) instead of the bare grid.
  //   ?scan=first             — from onboarding step 2: start scanning the
  //                              first pending video on arrival, rather than
  //                              dropping the creator here to find the button.
  // Fires once per arrival, after the library has loaded, then strips the
  // params so a refresh doesn't re-trigger.
  // Driven by wouter's search string, not window.location read once: the bell
  // navigates with setLocation, which changes the URL WITHOUT remounting this
  // page — so an effect keyed only on videoData never re-ran when a creator
  // sitting on /library clicked "Your clips are ready", and then fired later,
  // unprompted, when the 15s refetch produced a new object. Keyed on the
  // search string, each distinct deep link is handled exactly once.
  const search = useSearch();
  const handledSearch = useRef<string | null>(null);
  useEffect(() => {
    if (!videoData?.videos || !search || handledSearch.current === search) return;
    const params = new URLSearchParams(search);
    const openClips = params.get("open") === "clips";
    const videoParam = Number(params.get("video"));
    const scanFirst = params.get("scan") === "first";
    if (!openClips && !scanFirst) return;
    handledSearch.current = search;

    if (openClips && Number.isFinite(videoParam) && videoParam > 0) {
      setRemixVideoId(videoParam);
      setRemixStudioOpen(true);
    } else if (scanFirst) {
      // Same classifier the cards use, so "retry" (a failed scan) counts too —
      // the exact case onboarding sends people here for.
      const vids = videoData.videos as IndexedVideo[];
      const scanning = vids.find((v) => getVideoStatusInfo(v).aiStatus === "scanning");
      const first = vids.find((v) => ["pending", "retry"].includes(getVideoStatusInfo(v).aiStatus));
      if (first?.id) {
        scanVideoMutation.mutate(first.id);
        toast({ title: "Scanning your video", description: `Started on "${(first as any).title || "your video"}" — this takes a minute or two.` });
        setTimeout(() => document.querySelector(`[data-testid="button-scan-${first.id}"], [data-testid="button-tf-scan-${first.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 250);
      } else if (scanning) {
        toast({ title: "Already scanning", description: "Your video is being scanned now — clips appear here when it finishes." });
      } else {
        toast({ title: "Nothing to scan yet", description: "Paste a video link or upload a file above to get started." });
      }
    }

    const url = new URL(window.location.href);
    url.searchParams.delete("open"); url.searchParams.delete("video"); url.searchParams.delete("scan");
    window.history.replaceState({}, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, videoData]);

  const batchScanMutation = useMutation({
    mutationFn: async (limit: number) => {
      const batchUrl = isAdminUser 
        ? `/api/video-scan/batch?limit=${limit}&admin_email=${encodeURIComponent(userEmail)}`
        : `/api/video-scan/batch?limit=${limit}`;
      const res = await fetch(batchUrl, { 
        method: "POST",
        credentials: "include" 
      });
      if (!res.ok) throw new Error("Failed to start batch scan");
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Batch Scan Started",
        description: "AI is analyzing your pending videos for ad placement opportunities.",
      });
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Batch Scan Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Escape hatch for stuck scans: flips "Scanning" to a failed state the
  // creator can rescan from. A live scan aborts within a few frames; a dead
  // one is simply released.
  const cancelScanMutation = useMutation({
    mutationFn: async (videoId: number) => {
      const res = await fetchWithTimeout(`/api/videos/${videoId}/cancel-scan`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Cancel failed");
      return res.json();
    },
    onSuccess: (_data, videoId) => {
      setScanningVideoIds(prev => { const s = new Set(prev); s.delete(videoId); return s; });
      toast({ title: "Scan cancelled", description: "The video is released — rescan whenever you like." });
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    },
    onError: (error: Error) => {
      toast({ title: "Couldn't cancel scan", description: error.message, variant: "destructive" });
    },
  });

  // Video Surface Scan for local files (uses scanner_v2 with Sharp edge detection)
  const tfScanMutation = useMutation({
    mutationFn: async (videoId: number) => {
      console.log(`[FRONTEND] ===== SCAN BUTTON CLICKED =====`);
      console.log(`[FRONTEND] Video ID: ${videoId}`);
      const scanUrl = isAdminUser 
        ? `/api/video-scan/${videoId}?admin_email=${encodeURIComponent(userEmail)}`
        : `/api/video-scan/${videoId}`;
      console.log(`[FRONTEND] Sending POST to ${scanUrl}`);
      
      setScanningVideoIds(prev => new Set(prev).add(videoId));
      
      const res = await fetch(scanUrl, { 
        method: "POST",
        credentials: "include" 
      });
      
      if (!res.ok) {
        const errorText = await res.text();
        console.error(`[FRONTEND] Scan failed: ${errorText}`);
        throw new Error("Failed to start video scan");
      }
      
      return res.json();
    },
    onSuccess: (data, videoId) => {
      toast({
        title: "Surface Scan Started",
        description: "Analyzing your video for placement surfaces. This may take 1-2 minutes.",
      });

      // Poll for scan completion by checking actual video status
      const pollInterval = setInterval(async () => {
        try {
          const pollUrl = isAdminUser
            ? `/api/video-index/with-opportunities?admin_email=${encodeURIComponent(userEmail)}`
            : `/api/video-index/with-opportunities`;
          const res = await fetch(pollUrl, { credentials: "include" });
          if (!res.ok) return;
          const freshData = await res.json();

          queryClient.setQueryData(
            ["videos", isPitchMode, mode, DEMO_DATA_VERSION, isAdminUser, userEmail],
            freshData
          );

          const video = freshData.videos?.find((v: IndexedVideo) => v.id === videoId);

          if (video && !video.status?.toLowerCase().includes("scanning")) {
            clearInterval(pollInterval);
            setScanningVideoIds(prev => {
              const next = new Set(prev);
              next.delete(videoId);
              return next;
            });
            queryClient.invalidateQueries({ queryKey: ["videos"] });

            if (video.status?.toLowerCase().includes("ready") && video.adOpportunities > 0) {
              toast({
                title: "Scan Complete",
                description: `Found ${video.adOpportunities} placement surfaces. Click the video to view details.`,
              });
            } else if (video.status?.toLowerCase().startsWith("scan failed")) {
              toast({
                title: "Scan Failed",
                description: "Could not analyze this video. Please try again.",
                variant: "destructive",
              });
            } else {
              toast({
                title: "No Surfaces Found",
                description: "No suitable placement surfaces detected in this video.",
              });
            }
          }
        } catch (err) {
          console.error("Poll error:", err);
        }
      }, 5000);

      // Safety timeout: 3 minutes for long videos
      setTimeout(() => {
        clearInterval(pollInterval);
        setScanningVideoIds(prev => {
          const next = new Set(prev);
          next.delete(videoId);
          return next;
        });
      }, 180000);
    },
    onError: (error: Error, videoId) => {
      setScanningVideoIds(prev => {
        const next = new Set(prev);
        next.delete(videoId);
        return next;
      });
      toast({
        title: "Surface Scan Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const [deletingVideoId, setDeletingVideoId] = useState<number | null>(null);
  const [renamingVideo, setRenamingVideo] = useState<{ id: number; title: string; category?: string; subcategory?: string } | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [renameCategoryInput, setRenameCategoryInput] = useState("");
  const [renameSubcategoryInput, setRenameSubcategoryInput] = useState("");

  const deleteVideoMutation = useMutation({
    mutationFn: async (videoId: number) => {
      const deleteUrl = isAdminUser
        ? `/api/videos/${videoId}?admin_email=${encodeURIComponent(userEmail)}`
        : `/api/videos/${videoId}`;
      const res = await fetch(deleteUrl, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete video");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["videos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/discovery"] });
      toast({ title: "Moved to trash", description: `${data.trashed?.title || "Video"} moved to trash. You can restore it anytime.` });
      setDeletingVideoId(null);
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
      setDeletingVideoId(null);
    },
  });

  const renameVideoMutation = useMutation({
    mutationFn: async ({ videoId, title, category, subcategory }: { videoId: number; title?: string; category?: string; subcategory?: string }) => {
      const renameUrl = isAdminUser
        ? `/api/videos/${videoId}?admin_email=${encodeURIComponent(userEmail)}`
        : `/api/videos/${videoId}`;
      const res = await fetch(renameUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ title, category, subcategory }),
      });
      if (!res.ok) throw new Error("Failed to update video");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["videos"] });
      toast({ title: "Video updated", description: `Updated: ${data.title}${data.category ? ` (${data.category})` : ""}` });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  // Unified video data - comes from either auth or demo endpoint based on mode
  const videos = videoData?.videos || [];
  const displayVideos: DisplayVideo[] = videos.map(formatIndexedVideo);
  
  // DEBUG: Show exactly what videos are being displayed and why
  console.log(`[Library] ===== VIDEO DISPLAY DEBUG =====`);
  console.log(`[Library] isRealMode: ${isRealMode} (isPitchMode: ${isPitchMode}, mode: ${mode})`);
  console.log(`[Library] videoData exists: ${!!videoData}`);
  console.log(`[Library] videos array length: ${videos.length}`);
  console.log(`[Library] Videos being displayed:`, videos.map(v => ({ id: v.id, title: v.title, status: v.status })));
  if (videos.length > 0 && videos[0].id > 90000) {
    console.warn(`[Library] WARNING: Showing DEMO videos (IDs > 90000) instead of real videos!`);
    console.warn(`[Library] This means mode="${mode}" but demo endpoint was called`);
  }
  
  // Filter videos by platform AND search query.
  // Search matches against title, category, subcategory, and brand name —
  // case-insensitive substring. Multi-word queries match if every word
  // appears somewhere across the searchable fields (any order).
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);

  const filteredDisplayVideos = displayVideos.filter((video) => {
    if (platformFilter !== "all" && video.platform !== platformFilter) return false;
    if (queryTerms.length === 0) return true;
    const haystack = [
      video.title,
      video.context,
      video.category,
      video.subcategory,
      video.brandName,
    ].filter(Boolean).join(" ").toLowerCase();
    return queryTerms.every(term => haystack.includes(term));
  });
  
  // Platform counts for tabs
  const youtubeCount = displayVideos.filter(v => v.platform === "youtube").length;
  const instagramCount = displayVideos.filter(v => v.platform === "instagram").length;
  const twitchCount = displayVideos.filter(v => v.platform === "twitch").length;
  const tiktokCount = displayVideos.filter(v => v.platform === "tiktok").length;
  const twitterCount = displayVideos.filter(v => v.platform === "twitter").length;
  const facebookCount = displayVideos.filter(v => v.platform === "facebook").length;
  const uploadsCount = displayVideos.filter(v => v.platform === "fullscale").length;
  
  // Debug logging
  console.log("[Library] isPitchMode:", isPitchMode, "videos.length:", videos.length, "isLoading:", isLoadingVideos, "platformFilter:", platformFilter);
  
  const videoCount = videos.length;
  const totalOpportunities = videos.reduce((sum: number, v: IndexedVideo) => sum + (v.adOpportunities || 0), 0);

  const pendingCount = videos.filter((v: IndexedVideo) => 
    v.status?.toLowerCase() === "pending scan" && v.adOpportunities === 0
  ).length;

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <TopBar />

      {/* "Viewing as" banner — visible whenever an admin has opted into
          another user's library via ?as=<email>. Mirrors the server-side
          override (videoData.viewingAs is the authoritative source). Keeps
          the admin oriented and gives them a one-click "Return" path. */}
      {videoData?.viewingAs && (
        <div className="bg-amber-500/15 border-y border-amber-500/30 px-6 py-2.5 flex items-center justify-between gap-3 text-sm" data-testid="banner-viewing-as">
          <div className="text-amber-100">
            <span className="text-amber-200/70">Viewing as</span>{" "}
            <span className="font-semibold text-amber-100" data-testid="text-viewing-as-email">{videoData.viewingAs}</span>
            <span className="text-amber-200/70"> — actions you take here happen against your own account; only the displayed videos are theirs.</span>
          </div>
          <button
            onClick={clearViewAs}
            className="shrink-0 px-3 py-1 rounded-md text-xs font-medium border border-amber-400/40 text-amber-100 hover:bg-amber-400/15 transition-colors"
            data-testid="button-return-to-my-library"
          >
            Return to my library
          </button>
        </div>
      )}

      <main className="p-8 max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 flex flex-wrap items-start justify-between gap-4"
        >
          <div>
            <h1 className="text-3xl font-bold font-display mb-2" data-testid="text-library-title">
              Content Library
            </h1>
            <p className="text-muted-foreground">
              <span className="text-white font-medium">{videoCount} Videos Indexed</span> | {totalOpportunities} Ad Opportunities Found
              {isPitchMode && <span className="ml-2 text-xs text-amber-400">(Pitch Mode)</span>}
              <span className="ml-2 px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 text-xs font-medium" data-testid="badge-showing-count">
                Showing {filteredDisplayVideos.length} items
              </span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isRealMode && (
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => setReelBuilderOpen(true)}
                data-testid="button-build-reel"
              >
                <Video className="w-4 h-4" />
                Build a Reel
              </Button>
            )}
            {isRealMode && (
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => {
                  console.log('[FRONTEND] Refresh button clicked - refetching videos');
                  refetchVideos();
                }}
                disabled={isFetchingVideos}
                data-testid="button-refresh-library"
              >
                {isFetchingVideos ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                {isFetchingVideos ? "Refreshing..." : "Refresh"}
              </Button>
            )}
            {isRealMode && pendingCount > 0 && (
              <Button 
                variant="outline" 
                className="gap-2" 
                onClick={() => batchScanMutation.mutate(10)}
                disabled={batchScanMutation.isPending}
                data-testid="button-scan-all-pending"
              >
                {batchScanMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                Scan All Pending ({pendingCount})
              </Button>
            )}
            <Button className="gap-2" data-testid="button-upload-asset" onClick={() => setUploadModalOpen(true)}>
              <Upload className="w-4 h-4" />
              Upload Manual Asset
            </Button>
          </div>
        </motion.div>

        {/* Keyword search — matches title, category, subcategory, brand name */}
        <div className="mb-4">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search videos by title, category, or keyword…"
            className="max-w-xl bg-white/5 border-white/10"
            data-testid="input-library-search"
          />
          {searchQuery.trim() && (
            <p className="text-xs text-muted-foreground mt-1.5">
              {filteredDisplayVideos.length} of {displayVideos.length} videos match "{searchQuery.trim()}"
            </p>
          )}
        </div>

        {/* Platform Filter Tabs with Region Dropdown */}
        <div className="flex items-center gap-4 mb-6 flex-wrap">
          <Tabs value={platformFilter} onValueChange={(v) => setPlatformFilter(v as PlatformFilter)}>
            <TabsList className="bg-white/5 border border-white/10 flex-wrap h-auto gap-1">
              <TabsTrigger value="all" className="gap-2 data-[state=active]:bg-primary/20" data-testid="tab-all">
                All ({displayVideos.length})
              </TabsTrigger>
              <TabsTrigger value="youtube" className="gap-2 data-[state=active]:bg-red-500/20" data-testid="tab-youtube">
                <SiYoutube className="w-4 h-4 text-red-500" />
                YouTube ({youtubeCount})
              </TabsTrigger>
              <TabsTrigger value="instagram" className="gap-2 data-[state=active]:bg-pink-500/20" data-testid="tab-instagram">
                <SiInstagram className="w-4 h-4 text-pink-500" />
                Instagram ({instagramCount})
              </TabsTrigger>
              <TabsTrigger value="twitch" className="gap-2 data-[state=active]:bg-purple-500/20" data-testid="tab-twitch">
                <SiTwitch className="w-4 h-4 text-purple-500" />
                Twitch ({twitchCount})
              </TabsTrigger>
              <TabsTrigger value="tiktok" className="gap-2 data-[state=active]:bg-zinc-500/20" data-testid="tab-tiktok">
                <SiTiktok className="w-4 h-4" />
                TikTok ({tiktokCount})
              </TabsTrigger>
              <TabsTrigger value="twitter" className="gap-2 data-[state=active]:bg-sky-500/20" data-testid="tab-twitter">
                <SiX className="w-4 h-4" />
                X ({twitterCount})
              </TabsTrigger>
              <TabsTrigger value="facebook" className="gap-2 data-[state=active]:bg-blue-500/20" data-testid="tab-facebook">
                <SiFacebook className="w-4 h-4 text-blue-500" />
                Facebook ({facebookCount})
              </TabsTrigger>
              <TabsTrigger value="fullscale" className="gap-2 data-[state=active]:bg-emerald-500/20" data-testid="tab-uploads">
                <Upload className="w-4 h-4 text-emerald-500" />
                Uploads ({uploadsCount})
              </TabsTrigger>
            </TabsList>
          </Tabs>
          
          {/* Visual-only Region Filter for pitch mode */}
          <Select defaultValue="all">
            <SelectTrigger className="w-[160px] bg-white/5 border-white/10" data-testid="select-region">
              <Globe className="w-4 h-4 mr-2 text-primary" />
              <SelectValue placeholder="Region" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="north-america">North America</SelectItem>
              <SelectItem value="mena">MENA</SelectItem>
              <SelectItem value="europe">Europe</SelectItem>
            </SelectContent>
          </Select>

          {/* URL-paste import: the v1 ingest path for Twitch/TikTok/X */}
          <div className="flex items-center gap-2 flex-1 min-w-[280px] max-w-md" data-testid="import-url-bar">
            <Input
              value={importUrlValue}
              onChange={(e) => setImportUrlValue(e.target.value)}
              placeholder="Paste a YouTube, Twitch, TikTok, or X video URL…"
              className="bg-white/5 border-white/10 text-sm"
              data-testid="input-import-url"
              onKeyDown={(e) => { if (e.key === "Enter") (document.getElementById("btn-import-url") as HTMLButtonElement)?.click(); }}
            />
            <Button
              id="btn-import-url"
              size="sm"
              disabled={isImportingUrl || !importUrlValue.trim()}
              onClick={async () => {
                setIsImportingUrl(true);
                try {
                  const res = await fetchWithTimeout("/api/video/import-url", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ url: importUrlValue.trim() }),
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data?.error || "Import failed");
                  toast({ title: "Video imported", description: `${data.video?.title ?? "Imported"} — hit Scan when ready.` });
                  setImportUrlValue("");
                  queryClient.invalidateQueries({ queryKey: ["videos"] });
                } catch (err: any) {
                  toast({ title: "Import failed", description: err?.message ?? "Check the URL and try again.", variant: "destructive" });
                } finally {
                  setIsImportingUrl(false);
                }
              }}
              data-testid="button-import-url"
            >
              {isImportingUrl ? "Importing…" : "Import"}
            </Button>
          </div>
        </div>

        {isLoadingVideos ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : isRealMode && isVideosError ? (
          // An error is NOT an empty library. Showing "sync your channel" for
          // a failed request told the creator to fix the wrong thing.
          <div className="max-w-lg mx-auto text-center py-16">
            <p className="text-sm font-medium mb-1">Couldn't load your library</p>
            <p className="text-xs text-muted-foreground leading-relaxed mb-4">
              {(videosError as Error)?.message || "Unknown error"}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetchVideos()}>
              Try again
            </Button>
          </div>
        ) : isRealMode && videos.length === 0 ? (
          <EmptyLibrary
            connected={ytStatus ? !!ytStatus.connected : null}
            onSync={() => syncMutation.mutate()}
            isSyncing={syncMutation.isPending}
            onConnect={() => { window.location.href = "/api/auth/youtube"; }}
            onPaste={() => {
              const el = document.querySelector('[data-testid="import-url-bar"] input') as HTMLInputElement | null;
              el?.focus(); el?.scrollIntoView({ block: "center", behavior: "smooth" });
            }}
            onUpload={() => setUploadModalOpen(true)}
          />
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className={platformFilter === "instagram" 
              ? "grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4" 
              : "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"}
          >
            {filteredDisplayVideos.map((video, idx) => (
              <div 
                key={video.id || idx} 
                className="bg-white/5 rounded-xl border border-white/5 overflow-hidden group cursor-pointer relative"
                data-testid={`card-video-${video.id || idx}`}
                onClick={() => {
                  if (video.id && scanningVideoIds.has(video.id)) {
                    toast({
                      title: "Scan In Progress",
                      description: "Please wait for the AI analysis to complete before viewing results.",
                    });
                    return;
                  }
                  handleVideoClick(video);
                }}
              >
                {/* Local file indicator - shows when video has local file ready for scanning */}
                {video.hasLocalFile && (
                  <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
                    <div className="px-2 py-1 rounded-md bg-emerald-500/90 text-white text-xs font-medium flex items-center gap-1">
                      <HardDrive className="w-3 h-3" />
                      Local File
                    </div>
                  </div>
                )}
                {/* Delete button — visible on hover */}
                {isRealMode && video.id && (
                  <button
                    className="absolute top-2 right-10 z-20 w-7 h-7 rounded-full bg-red-600/80 hover:bg-red-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Delete video"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeletingVideoId(video.id!);
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
                {/* Platform icon overlay for All view */}
                {platformFilter === "all" && (
                  <div className="absolute top-2 right-2 z-10">
                    {video.platform === "instagram" ? (
                      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 via-pink-500 to-orange-500 flex items-center justify-center">
                        <SiInstagram className="w-3.5 h-3.5 text-white" />
                      </div>
                    ) : video.platform === "twitch" ? (
                      <div className="w-6 h-6 rounded-full bg-purple-600 flex items-center justify-center">
                        <SiTwitch className="w-3.5 h-3.5 text-white" />
                      </div>
                    ) : video.platform === "facebook" ? (
                      <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center">
                        <SiFacebook className="w-3.5 h-3.5 text-white" />
                      </div>
                    ) : video.platform === "tiktok" ? (
                      <div className="w-6 h-6 rounded-full bg-black border border-white/20 flex items-center justify-center">
                        <SiTiktok className="w-3.5 h-3.5 text-white" />
                      </div>
                    ) : video.platform === "twitter" ? (
                      <div className="w-6 h-6 rounded-full bg-black border border-white/20 flex items-center justify-center">
                        <SiX className="w-3.5 h-3.5 text-white" />
                      </div>
                    ) : video.platform === "fullscale" ? (
                      <div className="w-6 h-6 rounded-full bg-emerald-600 flex items-center justify-center">
                        <Upload className="w-3.5 h-3.5 text-white" />
                      </div>
                    ) : video.platform === "youtube" ? (
                      <div className="w-6 h-6 rounded-full bg-red-600 flex items-center justify-center">
                        <SiYoutube className="w-3.5 h-3.5 text-white" />
                      </div>
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-zinc-600 flex items-center justify-center">
                        <Video className="w-3.5 h-3.5 text-white" />
                      </div>
                    )}
                  </div>
                )}
                <div className="relative overflow-hidden bg-zinc-900 aspect-video">
                  {video.image ? (
                    <img
                      src={video.image}
                      alt={video.title}
                      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                      onError={(e) => {
                        const el = e.target as HTMLImageElement;
                        // Try legacy /uploads/ path if /storage/ path failed
                        if (el.src.includes('/storage/uploads/frames/')) {
                          el.src = el.src.replace('/storage/uploads/frames/', '/uploads/frames/');
                          return;
                        }
                        el.style.display = 'none';
                        const placeholder = el.parentElement?.querySelector('.img-placeholder');
                        if (placeholder) (placeholder as HTMLElement).style.display = 'flex';
                      }}
                    />
                  ) : null}
                  <div className={`img-placeholder absolute inset-0 items-center justify-center gap-2 text-zinc-500 ${video.image ? 'hidden' : 'flex'}`}>
                    <Video className="w-10 h-10" />
                    <span className="text-xs">No thumbnail</span>
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                  <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/50 backdrop-blur-sm">
                    <AiOverlayIcon status={video.aiStatus} />
                    <span className="text-xs text-white/90 font-medium">{video.aiText}</span>
                  </div>
                  {/* Scanning controls - local files use TensorFlow, social media shows "coming soon" */}
                  {isRealMode && video.id && (
                    <>
                      {/* Local files: Show scan/rescan button */}
                      {video.hasLocalFile && (video.aiStatus === "pending" || video.aiStatus === "retry" || video.aiStatus === "complete" || video.aiStatus === "scanning" || scanningVideoIds.has(video.id)) && (
                        <div
                          className="absolute bottom-12 right-2 z-20"
                          onClick={(e) => {
                            e.stopPropagation();
                            console.log(`[FRONTEND] Scan button clicked for video ID: ${video.id}`);
                            if (video.id && !scanningVideoIds.has(video.id)) {
                              console.log(`[FRONTEND] Calling tfScanMutation.mutate(${video.id})`);
                              tfScanMutation.mutate(video.id);
                            }
                          }}
                        >
                          <Button
                            size="sm"
                            variant="default"
                            className={`gap-1.5 ${video.aiStatus === "complete" ? "bg-blue-600 hover:bg-blue-700" : "bg-emerald-600 hover:bg-emerald-700"}`}
                            data-testid={`button-tf-scan-${video.id}`}
                            disabled={scanningVideoIds.has(video.id)}
                          >
                            {scanningVideoIds.has(video.id) ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Scanning...
                              </>
                            ) : video.aiStatus === "scanning" ? (
                              <>
                                <RefreshCw className="w-3 h-3" />
                                Re-scan
                              </>
                            ) : video.aiStatus === "complete" ? (
                              <>
                                <RefreshCw className="w-3 h-3" />
                                Re-scan
                              </>
                            ) : (
                              <>
                                <Scan className="w-3 h-3" />
                                Scan Surfaces
                              </>
                            )}
                          </Button>
                        </div>
                      )}
                      {/* Cancel scan — escape hatch when a scan is running or stuck.
                          Rendered for ALL platforms (stuck YouTube scans need it too). */}
                      {(video.aiStatus === "scanning" || scanningVideoIds.has(video.id)) && (
                        <div
                          className="absolute bottom-2 right-2 z-20"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (video.id) cancelScanMutation.mutate(video.id);
                          }}
                        >
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1 h-7 px-2 border-red-500/40 text-red-300 hover:bg-red-500/10 bg-black/40 backdrop-blur-sm"
                            data-testid={`button-cancel-scan-${video.id}`}
                            disabled={cancelScanMutation.isPending}
                          >
                            <X className="w-3 h-3" /> Cancel scan
                          </Button>
                        </div>
                      )}
                      {/* YouTube / pasted-URL video (no local file): a REAL Scan
                          button. This used to be a grey "Upload to Scan" badge
                          left over from before the scanner learned to pull
                          YouTube sources directly (f68d3a3) — so three pieces
                          of copy told the creator to "hit Scan" on a card with
                          no button, and a failed (retry) scan showed nothing
                          at all. The cloud scan (/api/video-scan/:id) handles
                          these; only the local-file variant needs the file. */}
                      {/* Only for sources the cloud scan can FETCH (YouTube /
                          pasted-URL). A local upload whose file is gone has no
                          source to pull — a green Scan there could only fail
                          with a misleading "No Surfaces Found", so it keeps an
                          honest "re-upload" badge instead. */}
                      {!video.hasLocalFile && !(video.platform === "fullscale" || String(video.youtubeId ?? "").startsWith("upload-")) && (video.aiStatus === "pending" || video.aiStatus === "retry" || scanningVideoIds.has(video.id)) && (
                        <div
                          className="absolute bottom-12 right-2 z-20"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (video.id && !scanningVideoIds.has(video.id)) scanVideoMutation.mutate(video.id);
                          }}
                        >
                          <Button
                            size="sm"
                            variant="default"
                            className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                            data-testid={`button-scan-${video.id}`}
                            disabled={scanningVideoIds.has(video.id)}
                          >
                            {scanningVideoIds.has(video.id) ? (
                              <><Loader2 className="w-3 h-3 animate-spin" /> Scanning...</>
                            ) : video.aiStatus === "retry" ? (
                              <><RefreshCw className="w-3 h-3" /> Retry scan</>
                            ) : (
                              <><Scan className="w-3 h-3" /> Scan</>
                            )}
                          </Button>
                        </div>
                      )}
                      {/* An upload whose file is no longer on disk: nothing to
                          scan from. Say so honestly rather than offering a
                          Scan that can only fail. */}
                      {!video.hasLocalFile && (video.platform === "fullscale" || String(video.youtubeId ?? "").startsWith("upload-")) && (video.aiStatus === "pending" || video.aiStatus === "retry") && (
                        <div className="absolute bottom-12 right-2 z-20">
                          <div className="px-2 py-1 rounded-md bg-zinc-700/90 text-zinc-300 text-xs font-medium flex items-center gap-1" title="The uploaded file isn't available anymore — upload it again to scan.">
                            <Upload className="w-3 h-3" />
                            File missing — re-upload
                          </div>
                        </div>
                      )}
                      {video.aiStatus === "ready" && (
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                          <Button variant="outline" size="sm" className="gap-2">
                            <Eye className="w-4 h-4" />
                            View Analysis
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                  {!isRealMode && (
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                      <Button variant="outline" size="sm" className="gap-2">
                        <Eye className="w-4 h-4" />
                        View Analysis
                      </Button>
                    </div>
                  )}
                </div>
                <div className="p-4">
                  <div className="flex items-center gap-1.5 mb-1">
                    <h3 className="font-semibold text-white truncate flex-1">{video.title}</h3>
                    {isRealMode && video.id && (
                      <button
                        className="shrink-0 w-5 h-5 rounded text-muted-foreground hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors"
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenamingVideo({ id: video.id!, title: video.title, category: video.category, subcategory: video.subcategory });
                          setRenameInput(video.title);
                          setRenameCategoryInput(video.category || "Other");
                          setRenameSubcategoryInput(video.subcategory || "none");
                        }}
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">{video.views}</p>
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className={`w-2 h-2 rounded-full ${video.statusDot}`}></span>
                    <span className={`px-2 py-0.5 rounded-full ${video.statusColor} text-xs font-medium`}>
                      {video.status}
                    </span>
                    {video.category && video.category !== "Uploaded" && video.category !== "Other" && (
                      <span className="px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-400 text-xs font-medium">
                        {video.category}
                      </span>
                    )}
                    {video.subcategory && (
                      <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 text-xs font-medium">
                        {video.subcategory}
                      </span>
                    )}
                    {/* Global reach badge - shows MENA for Dubai/Saudi content */}
                    <span className="px-2 py-0.5 rounded-full bg-primary/20 text-primary text-xs font-medium flex items-center gap-1">
                      <Globe className="w-3 h-3" />
                      {video.title.toLowerCase().includes('dubai') || video.title.toLowerCase().includes('saudi') ? 'MENA' : 'Global'}
                    </span>
                  </div>
                  {/* Action buttons — show on hover for any scanned video */}
                  {isRealMode && video.id && video.aiStatus === "ready" && (
                    <div className="flex items-center gap-1.5 mb-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        className="flex items-center gap-1 px-2 py-1 rounded-md bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 text-xs font-medium transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          setNarrativeVideoId(video.id!);
                          setNarrativeInsightsOpen(true);
                        }}
                      >
                        <Brain className="w-3 h-3" />
                        Insights
                      </button>
                      <button
                        className="flex items-center gap-1 px-2 py-1 rounded-md bg-pink-500/15 text-pink-400 hover:bg-pink-500/25 text-xs font-medium transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRemixVideoId(video.id!);
                          setRemixStudioOpen(true);
                        }}
                      >
                        <Scissors className="w-3 h-3" />
                        Remix
                      </button>
                      <button
                        className="flex items-center gap-1 px-2 py-1 rounded-md bg-green-500/15 text-green-400 hover:bg-green-500/25 text-xs font-medium transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDistributionVideoId(video.id!);
                          setDistributionOpen(true);
                        }}
                      >
                        <Send className="w-3 h-3" />
                        Distribute
                      </button>
                    </div>
                  )}
                  {/* Sentiment and Cultural Context badges */}
                  {(video.sentiment || video.culturalContext) && (
                    <div className="flex flex-col gap-1.5 text-xs">
                      {video.sentiment && video.sentiment !== "Neutral" && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted-foreground">Sentiment:</span>
                          <span className={`px-2 py-0.5 rounded-full font-medium ${
                            video.sentiment === "Educational" ? "bg-blue-500/20 text-blue-400" :
                            video.sentiment === "Uplifting" ? "bg-green-500/20 text-green-400" :
                            video.sentiment === "Serious" ? "bg-orange-500/20 text-orange-400" :
                            video.sentiment === "Chaotic" ? "bg-red-500/20 text-red-400" :
                            "bg-zinc-500/20 text-zinc-400"
                          }`}>
                            {video.sentiment}
                          </span>
                        </div>
                      )}
                      {video.culturalContext && video.culturalContext !== "General" && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted-foreground">Context:</span>
                          <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 font-medium truncate max-w-[180px]">
                            {video.culturalContext}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </motion.div>
        )}
      </main>

      <SceneAnalysisModal
        video={sceneVideo}
        open={sceneModalOpen}
        onClose={() => {
          setSceneModalOpen(false);
          setSceneVideo(null);
        }}
        adminEmail={isAdminUser ? userEmail : undefined}
        onPlayFromTimestamp={sceneVideo?.filePath ? (timestamp: number) => {
          setPreviewVideo({
            id: sceneVideo.id,
            title: sceneVideo.title,
            image: sceneVideo.scenes[0]?.imageUrl || '',
            views: sceneVideo.viewCount.toString(),
            status: "Ready",
            statusColor: "text-emerald-400",
            statusDot: "bg-emerald-400",
            platform: "youtube",
            aiStatus: "ready",
            aiText: "Scanned",
            detectedObjects: [],
            context: "",
            brandSafety: 100,
            cpm: 0,
            opportunity: "",
            surfaceLabel: "",
            boundingBox: { top: "0%", left: "0%", width: "100%", height: "100%" },
            hasLocalFile: true,
            filePath: sceneVideo.filePath,
          });
          setPreviewStartTime(timestamp);
          setPreviewModalOpen(true);
        } : undefined}
      />

      {/* Insights Modal — NarrativeInsights (surface analysis) + EditorialClips (transcript-first viral clips) */}
      {narrativeInsightsOpen && narrativeVideoId && (
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={(e) => { if (e.target === e.currentTarget) { setNarrativeInsightsOpen(false); setNarrativeVideoId(null); } }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-zinc-900 rounded-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col border border-white/10"
            >
              {/* Header */}
              <div className="flex items-center justify-between p-5 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
                    <Brain className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-white">Editorial Intelligence</h2>
                    <p className="text-xs text-muted-foreground">Transcript-based viral clip analysis + narrative surface insights</p>
                  </div>
                </div>
                <button onClick={() => { setNarrativeInsightsOpen(false); setNarrativeVideoId(null); }} className="text-zinc-400 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content — Editorial Clips first, then Narrative Insights below */}
              <div className="flex-1 overflow-y-auto p-5 space-y-6">
                {/* Editorial Clips — transcript-first viral clip identification */}
                <div>
                  <h3 className="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-yellow-400" />
                    Viral Clip Analysis
                  </h3>
                  <EditorialClips videoId={narrativeVideoId} mode="creator" />
                </div>

                {/* Separator */}
                <div className="border-t border-white/5 pt-4">
                  <h3 className="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
                    <Brain className="w-4 h-4 text-purple-400" />
                    Surface Narrative Analysis
                  </h3>
                  <p className="text-xs text-zinc-500 mb-3">
                    Per-frame surface analysis with brand matching — complements the transcript-based editorial analysis above.
                  </p>
                </div>
              </div>
            </motion.div>
          </motion.div>
        </AnimatePresence>
      )}

      <RemixStudio
        videoId={remixVideoId || 0}
        open={remixStudioOpen}
        onClose={() => {
          setRemixStudioOpen(false);
          setRemixVideoId(null);
        }}
      />

      <ReelBuilder
        open={reelBuilderOpen}
        onClose={() => setReelBuilderOpen(false)}
      />

      <DistributionDashboard
        videoId={distributionVideoId || 0}
        open={distributionOpen}
        onClose={() => {
          setDistributionOpen(false);
          setDistributionVideoId(null);
        }}
      />

      <UploadModal
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onUploadComplete={() => {
          toast({
            title: "Upload Complete",
            description: "Your asset has been uploaded successfully.",
          });
        }}
      />

      <VideoPreviewModal
        video={previewVideo ? {
          id: previewVideo.id || 0,
          title: previewVideo.title,
          filePath: previewVideo.filePath,
          thumbnailUrl: previewVideo.thumbnailUrl,
          status: previewVideo.aiStatus,
          platform: previewVideo.platform
        } : null}
        open={previewModalOpen}
        onClose={() => {
          setPreviewModalOpen(false);
          setPreviewVideo(null);
          setPreviewStartTime(0);
        }}
        isScanning={previewVideo?.id ? scanningVideoIds.has(previewVideo.id) : false}
        startTime={previewStartTime}
      />

      {/* Delete confirmation dialog */}
      <Dialog open={deletingVideoId !== null} onOpenChange={(open) => { if (!open) setDeletingVideoId(null); }}>
        <DialogContent className="sm:max-w-sm">
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Move to Trash</h3>
            <p className="text-sm text-muted-foreground">
              This video will be moved to your trash bin. You can restore it anytime or permanently delete it later.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDeletingVideoId(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteVideoMutation.isPending}
                onClick={() => {
                  if (deletingVideoId) deleteVideoMutation.mutate(deletingVideoId);
                }}
              >
                {deleteVideoMutation.isPending ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Deleting...</>
                ) : (
                  <><Trash2 className="w-3.5 h-3.5 mr-1.5" /> Move to Trash</>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit video dialog (rename + category + subcategory) */}
      <Dialog open={renamingVideo !== null} onOpenChange={(open) => { if (!open) setRenamingVideo(null); }}>
        <DialogContent className="sm:max-w-md">
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Edit Video</h3>
            <div>
              <label className="text-sm text-muted-foreground mb-1.5 block">Title</label>
              <Input
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                placeholder="Enter new title"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && renameInput.trim() && renamingVideo) {
                    renameVideoMutation.mutate({ videoId: renamingVideo.id, title: renameInput.trim(), category: renameCategoryInput, subcategory: renameSubcategoryInput || undefined });
                    setRenamingVideo(null);
                  }
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-muted-foreground mb-1.5 block">Category</label>
                <Select value={renameCategoryInput} onValueChange={setRenameCategoryInput}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {CONTENT_CATEGORIES.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm text-muted-foreground mb-1.5 block">Subcategory</label>
                <Select value={renameSubcategoryInput} onValueChange={setRenameSubcategoryInput}>
                  <SelectTrigger>
                    <SelectValue placeholder="e.g. Sports" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {SUBCATEGORIES.map((sub) => (
                      <SelectItem key={sub} value={sub}>
                        {sub}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setRenamingVideo(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={(!renameInput.trim() && !renameCategoryInput && !renameSubcategoryInput) || renameVideoMutation.isPending}
                onClick={() => {
                  if (renamingVideo) {
                    renameVideoMutation.mutate({
                      videoId: renamingVideo.id,
                      title: renameInput.trim() || undefined,
                      category: renameCategoryInput || undefined,
                      subcategory: renameSubcategoryInput === "none" ? "" : (renameSubcategoryInput || undefined),
                    });
                    setRenamingVideo(null);
                  }
                }}
              >
                {renameVideoMutation.isPending ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Saving...</>
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
