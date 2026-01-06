import { useState, useEffect } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Video, Youtube, CheckCircle, Unlink, TrendingUp, Gavel, BarChart3, Loader2, ToggleLeft, ToggleRight } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { useHybridMode } from "@/hooks/use-hybrid-mode";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { UploadModal } from "@/components/UploadModal";
import { useLocation } from "wouter";
import { Switch } from "@/components/ui/switch";

const ADMIN_EMAILS = [
  "martin@gofullscale.co",
  "martin@whtwrks.com",
  "martincekechukwu@gmail.com",
];

interface YoutubeStatus {
  connected: boolean;
  channelId?: string;
  channelTitle?: string;
}

interface YoutubeChannel {
  connected: boolean;
  channelId?: string;
  title?: string;
  description?: string;
  profilePictureUrl?: string;
  subscriberCount?: string;
  videoCount?: string;
  viewCount?: string;
}

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
  adOpportunities?: number;
}

interface VideoIndexResponse {
  videos: IndexedVideo[];
  total: number;
}

const demoCampaigns = [
  { brand: "Sony", content: "Vlog #42", status: "Active", amount: "$2,400", statusColor: "bg-emerald-500/20 text-emerald-400" },
  { brand: "Nike", content: "Training Montage", status: "Bidding", amount: "$850", statusColor: "bg-orange-500/20 text-orange-400" },
  { brand: "Squarespace", content: "Tech Review", status: "Paid", amount: "$1,200", statusColor: "bg-blue-500/20 text-blue-400" },
  { brand: "Coca-Cola", content: "Summer Vlog", status: "Pending", amount: "$3,100", statusColor: "bg-yellow-500/20 text-yellow-400" },
];

const chartData = [
  { month: "Aug", height: "45%", revenue: "$8.2k" },
  { month: "Sep", height: "72%", revenue: "$12.4k" },
  { month: "Oct", height: "58%", revenue: "$9.8k" },
  { month: "Nov", height: "85%", revenue: "$14.1k" },
  { month: "Dec", height: "68%", revenue: "$11.6k" },
];

// Simulation mode data for investor pitches
const simulationStats = {
  revenue: "$14,850",
  revenueGrowth: "+18% this month",
  activeBids: "12",
  avgCpm: "$35.00",
  inventoryIndex: "98%",
};

// Real mode placeholder data (to be replaced with actual API data when available)
const realModeStats = {
  revenue: "$0",
  revenueGrowth: "Connect to track",
  activeBids: "0",
  avgCpm: "--",
  inventoryIndex: "--",
};

export default function Dashboard() {
  const { user } = useAuth();
  const { mode, isAuthenticated: isGoogleAuthenticated, googleUser } = useHybridMode();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [, setLocation] = useLocation();
  const [isSimulatingConnect, setIsSimulatingConnect] = useState(false);
  const [simulatedConnected, setSimulatedConnected] = useState(false);
  const [simulationModeOverride, setSimulationModeOverride] = useState(false);

  const isDemoMode = mode === "demo";
  const isRealMode = mode === "real";
  
  // Admin check - only these users can toggle simulation mode
  const currentUserEmail = googleUser?.email || user?.email || "";
  const isAdmin = ADMIN_EMAILS.includes(currentUserEmail.toLowerCase());
  
  // Simulation mode: admin override forces demo view even when authenticated
  const showSimulationData = simulationModeOverride;
  
  // Choose which stats to display based on simulation mode
  const displayStats = showSimulationData ? simulationStats : realModeStats;

  const { data: youtubeStatus, isLoading: isCheckingYoutube } = useQuery<YoutubeStatus>({
    queryKey: ["/api/auth/youtube/status"],
    queryFn: async () => {
      const res = await fetch("/api/auth/youtube/status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch YouTube status");
      return res.json();
    },
    enabled: isRealMode,
  });

  const { data: channelData, isLoading: isLoadingChannel } = useQuery<YoutubeChannel>({
    queryKey: ["/api/youtube/channel"],
    queryFn: async () => {
      const res = await fetch("/api/youtube/channel", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch channel data");
      return res.json();
    },
    enabled: isRealMode && !!youtubeStatus?.connected,
  });

  const { data: videoIndexData, isLoading: isLoadingVideoIndex } = useQuery<VideoIndexResponse>({
    queryKey: ["/api/video-index/with-opportunities"],
    queryFn: async () => {
      const res = await fetch("/api/video-index/with-opportunities", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch video index");
      return res.json();
    },
    enabled: isRealMode && !!youtubeStatus?.connected,
    refetchInterval: 5000,
  });

  const indexedVideos = videoIndexData?.videos || [];

  const scanMutation = useMutation({
    mutationFn: async (videoId: number) => {
      const res = await fetch(`/api/video-scan/${videoId}`, { 
        method: "POST", 
        credentials: "include" 
      });
      if (!res.ok) throw new Error("Failed to start scan");
      return res.json();
    },
    onSuccess: (_, videoId) => {
      toast({ title: "Scan Started", description: "Analyzing video for ad opportunities..." });
      queryClient.invalidateQueries({ queryKey: ["/api/video-index/with-opportunities"] });
    },
    onError: () => {
      toast({ title: "Scan Failed", description: "Could not start video analysis.", variant: "destructive" });
    },
  });

  const batchScanMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/video-scan/batch", { 
        method: "POST", 
        credentials: "include" 
      });
      if (!res.ok) throw new Error("Failed to start batch scan");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Batch Scan Started", description: "Analyzing pending videos for ad opportunities..." });
    },
    onError: () => {
      toast({ title: "Scan Failed", description: "Could not start batch scan.", variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/auth/youtube", { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Failed to disconnect");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/youtube/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/youtube/channel"] });
      queryClient.invalidateQueries({ queryKey: ["/api/youtube/videos"] });
      toast({ title: "YouTube Disconnected", description: "Your channel has been unlinked." });
    },
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("youtube_connected") === "true") {
      toast({ title: "YouTube Connected!", description: "Your channel is now linked." });
      // Clean URL while staying on dashboard
      window.history.replaceState({}, "", "/dashboard");
      queryClient.invalidateQueries({ queryKey: ["/api/auth/youtube/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/youtube/channel"] });
      queryClient.invalidateQueries({ queryKey: ["/api/youtube/videos"] });
    }
    if (params.get("youtube_error")) {
      const errorMsg = decodeURIComponent(params.get("youtube_error") || "An error occurred.");
      toast({ title: "Connection Failed", description: errorMsg, variant: "destructive" });
      // Clean URL while staying on dashboard
      window.history.replaceState({}, "", "/dashboard");
    }
  }, [toast, queryClient]);

  const handleConnect = () => {
    // If not logged in via Google OAuth, redirect to Google login first
    if (!isGoogleAuthenticated) {
      window.location.href = "/api/auth/google";
      return;
    }
    window.location.href = "/api/auth/youtube";
  };

  const handleSimulatedConnect = () => {
    setIsSimulatingConnect(true);
    setTimeout(() => {
      setIsSimulatingConnect(false);
      setSimulatedConnected(true);
      toast({
        title: "Success",
        description: "Imported 45 Videos from YouTube.",
      });
    }, 2500);
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate();
  };

  const videoCount = channelData?.videoCount ? parseInt(channelData.videoCount, 10) : 0;
  const isConnected = youtubeStatus?.connected || false;
  const hasRealData = isRealMode && isConnected && videoCount > 0;
  const showDemoMode = isDemoMode || !hasRealData;
  
  const displayName = isRealMode && googleUser?.name 
    ? googleUser.name.split(" ")[0] 
    : user?.firstName || "Creator";

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <Sidebar />
      <TopBar />

      <main className="ml-64 p-8 max-w-7xl mx-auto relative">
        {/* Admin-only Simulation Toggle */}
        {isAdmin && (
          <div className="absolute top-8 right-8 flex items-center gap-3 z-20">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card border border-border">
              <span className="text-xs text-muted-foreground">Real Data</span>
              <Switch
                checked={simulationModeOverride}
                onCheckedChange={setSimulationModeOverride}
                data-testid="switch-simulation-mode"
              />
              <span className="text-xs text-muted-foreground">Pitch Mode</span>
            </div>
            {simulationModeOverride && (
              <div className="px-3 py-1 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-400 text-xs font-bold uppercase tracking-wider">
                Simulation
              </div>
            )}
          </div>
        )}
        
        {/* Demo Mode badge for non-authenticated users */}
        {!isAdmin && showDemoMode && (
          <div className="absolute top-8 right-8 px-3 py-1 rounded-full bg-primary/20 border border-primary/40 text-primary text-xs font-bold uppercase tracking-wider z-10">
            Demo Mode
          </div>
        )}

        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <p className="text-xs uppercase tracking-widest text-muted-foreground mb-2 font-medium">The Command Center</p>
          <h1 className="text-3xl font-bold font-display mb-2" data-testid="text-welcome">
            Welcome back, {displayName}
          </h1>
          <p className="text-muted-foreground">Here's what's happening with your content today.</p>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8"
        >
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Revenue</p>
            </div>
            <p className="text-3xl font-bold text-emerald-400" data-testid="text-revenue">{displayStats.revenue}</p>
            <p className="text-xs text-emerald-400/80 mt-1">{displayStats.revenueGrowth}</p>
          </div>
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <Gavel className="w-4 h-4 text-orange-400" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Active Bids</p>
            </div>
            <p className="text-3xl font-bold text-white" data-testid="text-bids">{displayStats.activeBids}</p>
            {showSimulationData && (
              <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400 text-xs font-medium">Hot</span>
            )}
          </div>
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="w-4 h-4 text-blue-400" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Avg. CPM</p>
            </div>
            <p className="text-3xl font-bold text-white" data-testid="text-cpm">{displayStats.avgCpm}</p>
            {showSimulationData && (
              <p className="text-xs text-muted-foreground/60 mt-1">Industry avg: $22</p>
            )}
          </div>
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <Video className="w-4 h-4 text-primary" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Inventory Index</p>
            </div>
            <p className="text-3xl font-bold text-white" data-testid="text-inventory">{displayStats.inventoryIndex}</p>
            <p className="text-xs text-muted-foreground/60 mt-1">{showSimulationData ? "Scanned" : "Videos indexed"}</p>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            {showSimulationData ? (
              <>
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="bg-white/5 rounded-xl p-6 border border-white/5"
                >
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-semibold text-white">Revenue Velocity</p>
                    <span className="text-xs text-emerald-400 font-medium">Last 5 months</span>
                  </div>
                  <div className="flex items-end gap-1 md:gap-2" style={{ height: '200px' }}>
                    {chartData.map((bar) => (
                      <div key={bar.month} className="flex-1 flex flex-col items-center group relative h-full">
                        <div className="absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 bg-white text-black text-xs font-semibold rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none">
                          {bar.revenue}
                        </div>
                        <div className="flex-1 w-full flex items-end">
                          <div 
                            className="w-full bg-gradient-to-t from-primary/50 via-primary to-red-400 rounded-t-sm transition-all duration-300 group-hover:from-primary/70 group-hover:via-primary group-hover:to-red-300 cursor-pointer min-h-[4px]" 
                            style={{ height: bar.height }}
                          />
                        </div>
                        <span className="text-[10px] md:text-xs text-muted-foreground mt-2 shrink-0">{bar.month}</span>
                      </div>
                    ))}
                  </div>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="bg-white/5 rounded-xl border border-white/5 overflow-hidden"
                >
                  <div className="px-6 py-4 border-b border-white/5">
                    <p className="text-sm font-semibold text-white">Active Brand Campaigns</p>
                  </div>
                  <div className="divide-y divide-white/5">
                    {demoCampaigns.map((campaign, idx) => (
                      <div key={idx} className="px-6 py-4 flex flex-wrap items-center justify-between gap-3" data-testid={`row-campaign-${idx}`}>
                        <div className="flex items-center gap-3">
                          <span className="font-semibold text-white">{campaign.brand}</span>
                          <span className="text-muted-foreground text-sm">{campaign.content}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={`px-2 py-0.5 rounded-full ${campaign.statusColor} text-xs font-medium`}>
                            {campaign.status}
                          </span>
                          <span className="font-semibold text-white">{campaign.amount}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              </>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="bg-white/5 rounded-xl p-8 border border-white/5 text-center"
              >
                <BarChart3 className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-white mb-2">Revenue Analytics Coming Soon</h3>
                <p className="text-muted-foreground text-sm mb-4">
                  Connect your YouTube channel to start tracking monetization opportunities and brand campaigns.
                </p>
                {!isConnected && (
                  <button
                    onClick={handleConnect}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors inline-flex items-center gap-2"
                    data-testid="button-connect-youtube-chart"
                  >
                    <Youtube className="w-4 h-4" />
                    Connect YouTube
                  </button>
                )}
              </motion.div>
            )}
          </div>

          <div className="space-y-6">
            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3 }}
              className="bg-card rounded-2xl p-6 border border-border"
            >
              <h3 className="font-semibold mb-4">Quick Actions</h3>
              <div className="space-y-3">
                {(isDemoMode ? !simulatedConnected : !isConnected) && (
                  <button
                    onClick={isDemoMode ? handleSimulatedConnect : handleConnect}
                    disabled={isSimulatingConnect}
                    data-testid="button-connect-youtube"
                    className={`w-full text-left px-4 py-3 rounded-xl text-white text-sm font-medium transition-all flex items-center gap-2 ${
                      isSimulatingConnect 
                        ? "bg-yellow-600 cursor-not-allowed" 
                        : "bg-red-600 hover:bg-red-700"
                    }`}
                  >
                    {isSimulatingConnect ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Connecting to Google API...
                      </>
                    ) : (
                      <>
                        <Youtube className="w-4 h-4" />
                        Connect YouTube
                      </>
                    )}
                  </button>
                )}
                {(isDemoMode && simulatedConnected) && (
                  <button
                    disabled
                    data-testid="button-youtube-synced"
                    className="w-full text-left px-4 py-3 rounded-xl bg-emerald-600/20 text-emerald-400 text-sm font-medium flex items-center gap-2 border border-emerald-500/30"
                  >
                    <CheckCircle className="w-4 h-4" />
                    Channel Synced: @MartinCreators
                  </button>
                )}
                {(isRealMode && isConnected) && (
                  <button
                    disabled
                    data-testid="button-youtube-synced-real"
                    className="w-full text-left px-4 py-3 rounded-xl bg-emerald-600/20 text-emerald-400 text-sm font-medium flex items-center gap-2 border border-emerald-500/30"
                  >
                    <CheckCircle className="w-4 h-4" />
                    Channel Synced: {channelData?.title || youtubeStatus?.channelTitle || "YouTube"}
                  </button>
                )}
                <button 
                  onClick={() => setUploadModalOpen(true)}
                  className="w-full text-left px-4 py-3 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium transition-colors"
                  data-testid="button-upload-manual-dashboard"
                >
                  Upload Manual Asset
                </button>
                <button className="w-full text-left px-4 py-3 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium transition-colors">
                  Configure Webhooks
                </button>
                <button className="w-full text-left px-4 py-3 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium transition-colors">
                  View API Documentation
                </button>
              </div>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 }}
              className="bg-gradient-to-br from-card to-secondary/30 rounded-2xl p-6 border border-border shadow-lg"
            >
              <div className="flex items-center gap-4 mb-4">
                {((isDemoMode && simulatedConnected) || (isRealMode && isConnected && channelData?.profilePictureUrl)) ? (
                  (isDemoMode && simulatedConnected) ? (
                    <div className="w-12 h-12 bg-emerald-600/20 rounded-xl flex items-center justify-center">
                      <CheckCircle className="w-6 h-6 text-emerald-400" />
                    </div>
                  ) : (
                    <Avatar className="w-12 h-12">
                      <AvatarImage 
                        src={channelData?.profilePictureUrl} 
                        alt={channelData?.title}
                        data-testid="img-channel-avatar"
                      />
                      <AvatarFallback>
                        <Youtube className="w-6 h-6 text-red-500" />
                      </AvatarFallback>
                    </Avatar>
                  )
                ) : (
                  <div className="w-12 h-12 bg-red-600/10 rounded-xl flex items-center justify-center text-red-500">
                    <Youtube className="w-6 h-6" />
                  </div>
                )}
                <div className="flex-1">
                  <h3 className="text-lg font-bold font-display" data-testid="text-channel-title">
                    {(isDemoMode && simulatedConnected) 
                      ? "@MartinCreators" 
                      : (isRealMode && isConnected) 
                        ? (channelData?.title || youtubeStatus?.channelTitle || "YouTube Connected") 
                        : "Channel Status"
                    }
                  </h3>
                  {((isDemoMode && simulatedConnected) || (isRealMode && isConnected)) ? (
                    <div className="flex items-center gap-1 text-xs text-emerald-500">
                      <CheckCircle className="w-3 h-3" />
                      <span>Channel linked</span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Not connected</p>
                  )}
                </div>
              </div>
              
              {((isDemoMode && simulatedConnected) || (isRealMode && isConnected)) ? (
                <>
                  <p className="text-sm text-muted-foreground mb-6">
                    {isDemoMode && simulatedConnected 
                      ? "Your channel with 125,400 subscribers is connected. 45 videos imported."
                      : `Your channel with ${channelData?.subscriberCount ? parseInt(channelData.subscriberCount).toLocaleString() : "0"} subscribers is connected.${indexedVideos.length > 0 ? ` ${indexedVideos.length} videos indexed.` : ""}`
                    }
                  </p>
                  <button
                    onClick={isDemoMode ? () => setSimulatedConnected(false) : handleDisconnect}
                    disabled={disconnectMutation.isPending}
                    data-testid="button-disconnect-youtube"
                    className="w-full py-3 px-4 bg-destructive/10 hover:bg-destructive/20 text-destructive font-semibold rounded-xl border border-destructive/20 transition-all duration-200 flex items-center justify-center gap-2"
                  >
                    {disconnectMutation.isPending ? (
                      <>
                        <span className="w-4 h-4 border-2 border-destructive/30 border-t-destructive rounded-full animate-spin" />
                        Disconnecting...
                      </>
                    ) : (
                      <>
                        <Unlink className="w-4 h-4" />
                        Disconnect Channel
                      </>
                    )}
                  </button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {isDemoMode 
                    ? "Connect your YouTube channel to see the demo import flow."
                    : "Connect your YouTube channel to import your real videos and metrics."
                  }
                </p>
              )}
            </motion.div>
          </div>
        </div>

        {/* My Library Section - Shows indexed high-value videos */}
        {(isRealMode && isConnected) && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="mt-8 bg-white/5 rounded-xl border border-white/5 overflow-hidden"
          >
            <div className="px-6 py-4 border-b border-white/5 flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-white">My Library</p>
                <p className="text-xs text-muted-foreground">High-value videos ready for monetization</p>
              </div>
              <div className="flex items-center gap-3">
                {indexedVideos.some(v => v.status === "Pending Scan") && (
                  <button
                    onClick={() => batchScanMutation.mutate()}
                    disabled={batchScanMutation.isPending}
                    className="px-3 py-1 text-xs font-medium bg-primary/20 text-primary rounded-full hover:bg-primary/30 transition-colors"
                    data-testid="button-scan-all"
                  >
                    {batchScanMutation.isPending ? "Scanning..." : "Scan All Pending"}
                  </button>
                )}
                {indexedVideos.length > 0 && (
                  <span className="px-2 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-medium">
                    {indexedVideos.length} videos
                  </span>
                )}
              </div>
            </div>
            
            {isLoadingVideoIndex ? (
              <div className="p-8 flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-muted-foreground text-sm">Indexing your videos...</span>
              </div>
            ) : indexedVideos.length === 0 ? (
              <div className="p-8 text-center">
                <Video className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground text-sm">
                  No high-value videos found yet. We're looking for videos with 5,000+ views from the last 2 years.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
                {indexedVideos.slice(0, 6).map((video) => (
                  <div
                    key={video.id}
                    className="bg-white/5 rounded-lg overflow-hidden border border-white/10 hover:border-white/20 transition-colors"
                    data-testid={`card-video-${video.id}`}
                  >
                    {video.thumbnailUrl && (
                      <div className="aspect-video relative">
                        <img
                          src={video.thumbnailUrl}
                          alt={video.title}
                          className="w-full h-full object-cover"
                        />
                        {video.isEvergreen && (
                          <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-emerald-500/90 text-white text-xs font-medium">
                            Evergreen
                          </span>
                        )}
                        <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-black/70 text-white text-xs">
                          {video.viewCount.toLocaleString()} views
                        </span>
                      </div>
                    )}
                    <div className="p-3">
                      <h4 className="text-sm font-medium text-white line-clamp-2 mb-1">{video.title}</h4>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">{video.category || "General"}</span>
                        <div className="flex items-center gap-2">
                          {video.status === "Indexed" && (video.adOpportunities ?? 0) > 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/20 text-blue-400" data-testid={`badge-opportunities-${video.id}`}>
                              {video.adOpportunities} Ad Spots
                            </span>
                          )}
                          {video.status === "Pending Scan" ? (
                            <button
                              onClick={() => scanMutation.mutate(video.id)}
                              disabled={scanMutation.isPending}
                              className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors"
                              data-testid={`button-scan-${video.id}`}
                            >
                              Scan
                            </button>
                          ) : (
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              video.status === "Scan Failed"
                                ? "bg-red-500/20 text-red-400"
                                : "bg-emerald-500/20 text-emerald-400"
                            }`}>
                              {video.status}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            
            {indexedVideos.length > 6 && (
              <div className="px-6 py-3 border-t border-white/5 text-center">
                <button
                  onClick={() => setLocation("/library")}
                  className="text-sm text-primary hover:text-primary/80 font-medium"
                  data-testid="button-view-all-library"
                >
                  View all {indexedVideos.length} videos
                </button>
              </div>
            )}
          </motion.div>
        )}
      </main>

      <UploadModal 
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onUploadComplete={() => {
          toast({
            title: "Upload Complete",
            description: "Demo_Upload.mp4 has been added to your Library.",
          });
          setLocation("/library");
        }}
      />
    </div>
  );
}
