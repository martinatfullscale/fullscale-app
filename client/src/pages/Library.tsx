import { useState, useEffect } from "react";
import { TopBar } from "@/components/TopBar";
import { Upload, Eye, CheckCircle, Loader2, AlertTriangle, X, Shield, Sun, Tag, Box, DollarSign, Sparkles, RefreshCw, Play, Globe } from "lucide-react";
import { SiInstagram, SiYoutube, SiTwitch, SiFacebook } from "react-icons/si";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { useHybridMode } from "@/hooks/use-hybrid-mode";
import { usePitchMode } from "@/contexts/pitch-mode-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { UploadModal } from "@/components/UploadModal";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SceneAnalysisModal, DEMO_VIDEO_SCENES, VideoWithScenes } from "@/components/SceneAnalysisModal";

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
  isEvergreen: boolean | null;
  duration: string | null;
  platform?: string;
  brandName?: string;
  createdAt: string;
  updatedAt: string;
  adOpportunities: number;
}

type PlatformFilter = "all" | "youtube" | "instagram" | "twitch" | "facebook";

interface VideoIndexResponse {
  videos: IndexedVideo[];
  total: number;
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
  
  if (dbStatus === "indexed" || dbStatus === "scan failed" || dbStatus === "ready (0 spots)") {
    return {
      status: "No Surfaces - Retry",
      statusColor: "bg-amber-500/20 text-amber-400",
      statusDot: "bg-amber-500",
      aiStatus: "retry",
      aiText: "0 Found - Retry"
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
  const thumbnailUrl = (video as any).thumbnailUrl || (video as any).thumbnail_url || "";
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
      title: "Placement Saved",
      description: "This surface has been approved for brand placement.",
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

function EmptyLibrary({ onSync, isSyncing }: { onSync: () => void; isSyncing: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-8">
      <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mb-6">
        <Play className="w-10 h-10 text-muted-foreground" />
      </div>
      <h2 className="text-2xl font-bold text-white mb-2">Your Library is Empty</h2>
      <p className="text-muted-foreground text-center max-w-md mb-8">
        Sync your YouTube channel to import your high-value videos and discover monetization opportunities.
      </p>
      <Button 
        size="lg" 
        className="gap-2" 
        onClick={onSync}
        disabled={isSyncing}
        data-testid="button-sync-channel"
      >
        {isSyncing ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <RefreshCw className="w-5 h-5" />
        )}
        {isSyncing ? "Syncing Channel..." : "Sync YouTube Channel"}
      </Button>
    </div>
  );
}

export default function Library() {
  const { user } = useAuth();
  const { mode } = useHybridMode();
  const { isPitchMode } = usePitchMode();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedVideo, setSelectedVideo] = useState<DisplayVideo | null>(null);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [sceneModalOpen, setSceneModalOpen] = useState(false);
  const [sceneVideo, setSceneVideo] = useState<VideoWithScenes | null>(null);
  
  const handleVideoClick = (video: DisplayVideo) => {
    const videoId = video.id || 1001;
    const scenes = DEMO_VIDEO_SCENES[videoId] || DEMO_VIDEO_SCENES[1001];
    const viewCount = parseInt(video.views.replace(/[^0-9]/g, '')) || 0;
    setSceneVideo({
      id: videoId,
      title: video.title,
      duration: "10:00",
      viewCount: viewCount,
      scenes: scenes,
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
  
  const { data: videoData, isLoading: isLoadingVideos, isError: isVideosError } = useQuery<VideoIndexResponse>({
    queryKey: ["videos", isPitchMode, mode] as const,
    queryFn: async ({ queryKey }) => {
      // Extract isPitchMode and mode from queryKey to avoid stale closure
      const [, pitchModeFromKey, modeFromKey] = queryKey;
      const endpoint = pitchModeFromKey ? "/api/demo/videos" : (modeFromKey === "real" ? "/api/video-index/with-opportunities" : "/api/demo/videos");
      console.log(`[Library] Fetching videos from ${endpoint} (isPitchMode from key: ${pitchModeFromKey})`);
      const res = await fetch(endpoint, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch videos");
      const data = await res.json();
      console.log(`[Library] Videos fetched: ${data.videos?.length} items`);
      return data;
    },
    retry: 2,
    staleTime: 0,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/video-index/refresh", { 
        method: "POST",
        credentials: "include" 
      });
      if (!res.ok) throw new Error("Failed to sync channel");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Channel Synced",
        description: `Indexed ${data.indexed || 0} high-value videos from your channel.`,
      });
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
      console.log(`[FRONTEND] Sending POST to /api/video-scan/${videoId}`);
      
      setScanningVideoIds(prev => new Set(prev).add(videoId));
      
      // Immediately update UI to show "Scanning..." status and clear any failed state
      queryClient.setQueryData(["/api/video-index/with-opportunities"], (oldData: VideoIndexResponse | undefined) => {
        if (!oldData?.videos) return oldData;
        return {
          ...oldData,
          videos: oldData.videos.map((v: IndexedVideo) => 
            v.id === videoId ? { ...v, status: "Scanning", adOpportunities: 0 } : v
          )
        };
      });
      
      console.log(`[FRONTEND] UI updated to Scanning state, making fetch call...`);
      
      const res = await fetch(`/api/video-scan/${videoId}`, { 
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
          const res = await fetch("/api/video-index/with-opportunities", { credentials: "include" });
          if (!res.ok) return;
          const data = await res.json();
          
          queryClient.setQueryData(["videos", "auth"], data);
          
          const video = data.videos?.find((v: IndexedVideo) => v.id === videoId);
          
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
                description: `Found ${video.adOpportunities} ad placement surfaces. Click the video to view details.`,
              });
            } else if (video.status?.toLowerCase() === "scan failed") {
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
      
      setTimeout(() => {
        clearInterval(pollInterval);
        setScanningVideoIds(prev => {
          const next = new Set(prev);
          next.delete(videoId);
          return next;
        });
      }, 120000);
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

  const batchScanMutation = useMutation({
    mutationFn: async (limit: number) => {
      const res = await fetch(`/api/video-scan/batch?limit=${limit}`, { 
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

  // Unified video data - comes from either auth or demo endpoint based on mode
  const videos = videoData?.videos || [];
  const displayVideos: DisplayVideo[] = videos.map(formatIndexedVideo);
  
  // Filter videos by platform
  const filteredDisplayVideos = displayVideos.filter((video) => {
    if (platformFilter === "all") return true;
    return video.platform === platformFilter;
  });
  
  // Platform counts for tabs
  const youtubeCount = displayVideos.filter(v => v.platform === "youtube").length;
  const instagramCount = displayVideos.filter(v => v.platform === "instagram").length;
  const twitchCount = displayVideos.filter(v => v.platform === "twitch").length;
  const facebookCount = displayVideos.filter(v => v.platform === "facebook").length;
  
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
            {isRealMode && videos.length > 0 && (
              <Button 
                variant="outline" 
                className="gap-2" 
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                data-testid="button-refresh-library"
              >
                {syncMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                Refresh
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
              <TabsTrigger value="facebook" className="gap-2 data-[state=active]:bg-blue-500/20" data-testid="tab-facebook">
                <SiFacebook className="w-4 h-4 text-blue-500" />
                Facebook ({facebookCount})
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
        </div>

        {isLoadingVideos ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : isRealMode && (videos.length === 0 || isVideosError) ? (
          <EmptyLibrary onSync={() => syncMutation.mutate()} isSyncing={syncMutation.isPending} />
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
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-red-600 flex items-center justify-center">
                        <SiYoutube className="w-3.5 h-3.5 text-white" />
                      </div>
                    )}
                  </div>
                )}
                <div className={video.platform === "instagram" ? "aspect-[9/16] relative overflow-hidden" : "aspect-video relative overflow-hidden"}>
                  <img 
                    src={video.image} 
                    alt={video.title}
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                  <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/50 backdrop-blur-sm">
                    <AiOverlayIcon status={video.aiStatus} />
                    <span className="text-xs text-white/90 font-medium">{video.aiText}</span>
                  </div>
                  {/* TODO: RESUME VISION HANDSHAKE HERE
                      Deep Vision scanner handshake is currently silent.
                      YouTube indexing works, but scanVideoForSurfaces needs debugging.
                      See PROJECT_TODO.md and server/lib/scanner.ts for context.
                  */}
                  {isRealMode && video.id && (
                    <>
                      {(video.aiStatus === "pending" || video.aiStatus === "retry" || scanningVideoIds.has(video.id)) && (
                        <div 
                          className="absolute top-2 right-2 z-20"
                          onClick={(e) => {
                            e.stopPropagation();
                            console.log(`[FRONTEND] Scan button div clicked for video ID: ${video.id}`);
                            console.log(`[FRONTEND] Is already scanning: ${scanningVideoIds.has(video.id || 0)}`);
                            if (video.id && !scanningVideoIds.has(video.id)) {
                              console.log(`[FRONTEND] Calling scanVideoMutation.mutate(${video.id})`);
                              scanVideoMutation.mutate(video.id);
                            } else {
                              console.log(`[FRONTEND] Mutation NOT called - already scanning or no video ID`);
                            }
                          }}
                        >
                          <Button 
                            size="sm" 
                            variant={video.aiStatus === "retry" ? "default" : "secondary"} 
                            className="gap-1.5" 
                            data-testid={`button-scan-${video.id}`}
                            disabled={scanningVideoIds.has(video.id)}
                          >
                            {scanningVideoIds.has(video.id) ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Scanning...
                              </>
                            ) : video.aiStatus === "retry" ? (
                              <>
                                <RefreshCw className="w-3 h-3" />
                                Re-Scan
                              </>
                            ) : (
                              <>
                                <Play className="w-3 h-3" />
                                Scan
                              </>
                            )}
                          </Button>
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
                  <h3 className="font-semibold text-white mb-1 truncate">{video.title}</h3>
                  <p className="text-sm text-muted-foreground mb-2">{video.views}</p>
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className={`w-2 h-2 rounded-full ${video.statusDot}`}></span>
                    <span className={`px-2 py-0.5 rounded-full ${video.statusColor} text-xs font-medium`}>
                      {video.status}
                    </span>
                    {/* Global reach badge - shows MENA for Dubai/Saudi content */}
                    <span className="px-2 py-0.5 rounded-full bg-primary/20 text-primary text-xs font-medium flex items-center gap-1">
                      <Globe className="w-3 h-3" />
                      {video.title.toLowerCase().includes('dubai') || video.title.toLowerCase().includes('saudi') ? 'MENA' : 'Global'}
                    </span>
                  </div>
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
    </div>
  );
}
