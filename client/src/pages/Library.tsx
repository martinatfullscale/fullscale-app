import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Upload, Eye, CheckCircle, Loader2, AlertTriangle, X, Shield, Sun, Tag, Box, DollarSign, Sparkles, RefreshCw, Play } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { useHybridMode } from "@/hooks/use-hybrid-mode";
import { usePitchMode } from "@/contexts/pitch-mode-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { UploadModal } from "@/components/UploadModal";

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
  createdAt: string;
  updatedAt: string;
  adOpportunities: number;
}

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
    boundingBox: { top: "55%", left: "50%", width: "40%", height: "35%" }
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
    boundingBox: { top: "60%", left: "20%", width: "45%", height: "30%" }
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
    boundingBox: { top: "50%", left: "30%", width: "40%", height: "35%" }
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
    boundingBox: { top: "30%", left: "60%", width: "35%", height: "50%" }
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
    boundingBox: { top: "45%", left: "25%", width: "50%", height: "40%" }
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
    boundingBox: { top: "40%", left: "15%", width: "45%", height: "45%" }
  },
];

function AiOverlayIcon({ status }: { status: string }) {
  if (status === "ready") return <CheckCircle className="w-3 h-3 text-emerald-400" />;
  if (status === "scanning") return <Loader2 className="w-3 h-3 text-yellow-400 animate-spin" />;
  if (status === "pending") return <AlertTriangle className="w-3 h-3 text-zinc-400" />;
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
}

function getVideoStatusInfo(video: IndexedVideo): { status: string; statusColor: string; statusDot: string; aiStatus: string; aiText: string } {
  const dbStatus = video.status?.toLowerCase() || "";
  
  if (dbStatus === "scanning" || dbStatus.includes("scanning")) {
    return {
      status: "Scanning...",
      statusColor: "bg-yellow-500/20 text-yellow-400",
      statusDot: "bg-yellow-500",
      aiStatus: "scanning",
      aiText: "Processing..."
    };
  }
  
  if (video.adOpportunities > 0) {
    return {
      status: `Ready (${video.adOpportunities} Spots)`,
      statusColor: "bg-emerald-500/20 text-emerald-400",
      statusDot: "bg-emerald-500",
      aiStatus: "ready",
      aiText: `${video.adOpportunities} Surfaces Found`
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
  
  if (dbStatus === "indexed" || dbStatus === "scan failed") {
    return {
      status: dbStatus === "scan failed" ? "Scan Failed" : "No Spots Found",
      statusColor: "bg-zinc-500/20 text-zinc-400",
      statusDot: "bg-zinc-500",
      aiStatus: "ready",
      aiText: "0 Surfaces Found"
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
  
  return {
    id: video.id,
    title: video.title,
    views: `${video.viewCount.toLocaleString()} Views`,
    ...statusInfo,
    image: video.thumbnailUrl || "",
    detectedObjects: [],
    context: video.category || "",
    brandSafety: 0,
    cpm: 0,
    opportunity: "",
    surfaceLabel: "",
    boundingBox: { top: "0%", left: "0%", width: "0%", height: "0%" }
  };
}

function AnalysisModal({ video, open, onClose }: { video: DisplayVideo | null; open: boolean; onClose: () => void }) {
  const { toast } = useToast();

  if (!video) return null;

  const handleApprove = () => {
    toast({
      title: "Placement Saved",
      description: "This surface has been approved for brand placement.",
    });
    onClose();
  };

  const safetyColor = video.brandSafety >= 90 ? "text-emerald-400" : video.brandSafety >= 70 ? "text-yellow-400" : "text-red-400";

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
            <div 
              className="absolute border-2 border-emerald-400 rounded-sm"
              style={{
                top: video.boundingBox.top,
                left: video.boundingBox.left,
                width: video.boundingBox.width,
                height: video.boundingBox.height,
                boxShadow: '0 0 0 2px rgba(16, 185, 129, 0.2), inset 0 0 20px rgba(16, 185, 129, 0.1)'
              }}
            >
              <div className="absolute -top-6 left-0 bg-emerald-500/90 text-white text-xs font-mono px-2 py-0.5 rounded-sm whitespace-nowrap">
                {video.surfaceLabel}
              </div>
              <div className="absolute inset-0 bg-emerald-400/5" />
            </div>
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-4">
              <p className="text-white/70 text-xs font-mono">frame_04.jpg | 00:02:34</p>
            </div>
          </div>

          <div className="p-6 space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">AI Vision Analysis</p>
                <h2 className="text-xl font-bold text-white">Scene Analysis #04</h2>
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

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                  <div className="flex items-center gap-2 mb-1">
                    <Shield className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground font-mono uppercase">Brand Safety</span>
                  </div>
                  <p className={`text-lg font-bold font-mono ${safetyColor}`}>
                    {video.brandSafety}% Safe
                  </p>
                </div>
                <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                  <div className="flex items-center gap-2 mb-1">
                    <Sun className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground font-mono uppercase">Lighting</span>
                  </div>
                  <p className="text-lg font-bold font-mono text-white">High</p>
                </div>
              </div>

              <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <Tag className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground font-mono uppercase">Context</span>
                </div>
                <p className="text-white font-mono">{video.context}</p>
              </div>

              <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <Box className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground font-mono uppercase">Detected Objects</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {video.detectedObjects.map((obj, idx) => (
                    <span key={idx} className="px-2 py-1 bg-white/10 rounded text-xs font-mono text-white/80">
                      {obj}
                    </span>
                  ))}
                </div>
              </div>

              <div className="bg-emerald-500/10 rounded-lg p-3 border border-emerald-500/20">
                <div className="flex items-center gap-2 mb-1">
                  <DollarSign className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs text-emerald-400 font-mono uppercase">Opportunity</span>
                </div>
                <p className="text-white font-mono text-sm">
                  {video.opportunity}
                </p>
                <p className="text-emerald-400 font-mono text-sm mt-1">
                  CPM ${video.cpm}
                </p>
              </div>
            </div>

            <Button 
              className="w-full gap-2" 
              onClick={handleApprove}
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
  
  const isRealMode = mode === "real" && !isPitchMode;

  const { data: videoIndexData, isLoading: isLoadingVideos, isError: isVideosError } = useQuery<VideoIndexResponse>({
    queryKey: ["/api/video-index/with-opportunities"],
    queryFn: async () => {
      const res = await fetch("/api/video-index/with-opportunities", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch videos");
      return res.json();
    },
    enabled: isRealMode,
    retry: 1,
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
      queryClient.invalidateQueries({ queryKey: ["/api/video-index/with-opportunities"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Sync Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const scanVideoMutation = useMutation({
    mutationFn: async (videoId: number) => {
      const res = await fetch(`/api/video-scan/${videoId}`, { 
        method: "POST",
        credentials: "include" 
      });
      if (!res.ok) throw new Error("Failed to start scan");
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Scan Started",
        description: "AI is analyzing your video for ad placement opportunities.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/video-index/with-opportunities"] });
    },
    onError: (error: Error) => {
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
      queryClient.invalidateQueries({ queryKey: ["/api/video-index/with-opportunities"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Batch Scan Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const realVideos = videoIndexData?.videos || [];
  const realVideosFormatted: DisplayVideo[] = realVideos.map(formatIndexedVideo);

  const displayVideos: DisplayVideo[] = isPitchMode ? demoVideoData : realVideosFormatted;
  const videoCount = isPitchMode ? 45 : realVideos.length;
  const totalOpportunities = isPitchMode ? 126 : realVideos.reduce((sum, v) => sum + v.adOpportunities, 0);

  const pendingCount = realVideos.filter(v => 
    v.status?.toLowerCase() === "pending scan" && v.adOpportunities === 0
  ).length;

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <Sidebar />
      <TopBar />

      <main className="ml-64 p-8 max-w-7xl mx-auto">
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
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isRealMode && realVideos.length > 0 && (
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

        {isLoadingVideos ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : isRealMode && (realVideos.length === 0 || isVideosError) ? (
          <EmptyLibrary onSync={() => syncMutation.mutate()} isSyncing={syncMutation.isPending} />
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
          >
            {displayVideos.map((video, idx) => (
              <div 
                key={video.id || idx} 
                className="bg-white/5 rounded-xl border border-white/5 overflow-hidden group cursor-pointer"
                data-testid={`card-video-${video.id || idx}`}
                onClick={() => setSelectedVideo(video)}
              >
                <div className="aspect-video relative overflow-hidden">
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
                  {isRealMode && video.id && video.aiStatus === "pending" && (
                    <div 
                      className="absolute top-2 right-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (video.id) scanVideoMutation.mutate(video.id);
                      }}
                    >
                      <Button size="sm" variant="secondary" className="gap-1.5" data-testid={`button-scan-${video.id}`}>
                        <Play className="w-3 h-3" />
                        Scan
                      </Button>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <Button variant="outline" size="sm" className="gap-2">
                      <Eye className="w-4 h-4" />
                      View Analysis
                    </Button>
                  </div>
                </div>
                <div className="p-4">
                  <h3 className="font-semibold text-white mb-1 truncate">{video.title}</h3>
                  <p className="text-sm text-muted-foreground mb-3">{video.views}</p>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${video.statusDot}`}></span>
                    <span className={`px-2 py-0.5 rounded-full ${video.statusColor} text-xs font-medium`}>
                      {video.status}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </motion.div>
        )}
      </main>

      <AnalysisModal 
        video={selectedVideo} 
        open={!!selectedVideo} 
        onClose={() => setSelectedVideo(null)} 
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
