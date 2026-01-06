import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Video, Youtube, CheckCircle, Unlink, Users, TrendingUp, Gavel, BarChart3, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { UploadModal } from "@/components/UploadModal";
import { useLocation } from "wouter";

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

export default function Dashboard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [, setLocation] = useLocation();
  const [isSimulatingConnect, setIsSimulatingConnect] = useState(false);
  const [simulatedConnected, setSimulatedConnected] = useState(false);

  const { data: youtubeStatus, isLoading: isCheckingYoutube } = useQuery<YoutubeStatus>({
    queryKey: ["/api/auth/youtube/status"],
    queryFn: async () => {
      const res = await fetch("/api/auth/youtube/status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch YouTube status");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: channelData, isLoading: isLoadingChannel } = useQuery<YoutubeChannel>({
    queryKey: ["/api/youtube/channel"],
    queryFn: async () => {
      const res = await fetch("/api/youtube/channel", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch channel data");
      return res.json();
    },
    enabled: !!user && !!youtubeStatus?.connected,
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
      window.history.replaceState({}, "", "/");
      queryClient.invalidateQueries({ queryKey: ["/api/auth/youtube/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/youtube/channel"] });
      queryClient.invalidateQueries({ queryKey: ["/api/youtube/videos"] });
    }
    if (params.get("youtube_error")) {
      toast({ title: "Connection Failed", description: params.get("youtube_error") || "An error occurred.", variant: "destructive" });
      window.history.replaceState({}, "", "/");
    }
  }, [toast, queryClient]);

  const handleConnect = () => {
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
  const hasRealData = isConnected && videoCount > 0;
  const showDemoMode = !hasRealData;

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <Sidebar />
      <TopBar />

      <main className="ml-64 p-8 max-w-7xl mx-auto relative">
        {showDemoMode && (
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
            Welcome back, {user?.firstName || "Creator"}
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
            <p className="text-3xl font-bold text-emerald-400" data-testid="text-revenue">$14,850</p>
            <p className="text-xs text-emerald-400/80 mt-1">+18% this month</p>
          </div>
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <Gavel className="w-4 h-4 text-orange-400" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Active Bids</p>
            </div>
            <p className="text-3xl font-bold text-white" data-testid="text-bids">12</p>
            <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400 text-xs font-medium">Hot</span>
          </div>
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="w-4 h-4 text-blue-400" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Avg. CPM</p>
            </div>
            <p className="text-3xl font-bold text-white" data-testid="text-cpm">$35.00</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Industry avg: $22</p>
          </div>
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <Video className="w-4 h-4 text-primary" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Inventory Index</p>
            </div>
            <p className="text-3xl font-bold text-white" data-testid="text-inventory">98%</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Scanned</p>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
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
                {!isConnected && !simulatedConnected && (
                  <button
                    onClick={handleSimulatedConnect}
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
                {simulatedConnected && (
                  <button
                    disabled
                    data-testid="button-youtube-synced"
                    className="w-full text-left px-4 py-3 rounded-xl bg-emerald-600/20 text-emerald-400 text-sm font-medium flex items-center gap-2 border border-emerald-500/30"
                  >
                    <CheckCircle className="w-4 h-4" />
                    Channel Synced: @MartinCreators
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
                {(isConnected && channelData?.profilePictureUrl) || simulatedConnected ? (
                  simulatedConnected ? (
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
                    {simulatedConnected ? "@MartinCreators" : isConnected ? (channelData?.title || youtubeStatus?.channelTitle || "YouTube Connected") : "Channel Status"}
                  </h3>
                  {(isConnected || simulatedConnected) ? (
                    <div className="flex items-center gap-1 text-xs text-emerald-500">
                      <CheckCircle className="w-3 h-3" />
                      <span>Channel linked</span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Not connected</p>
                  )}
                </div>
              </div>
              
              {(isConnected || simulatedConnected) ? (
                <>
                  <p className="text-sm text-muted-foreground mb-6">
                    {simulatedConnected 
                      ? "Your channel with 125,400 subscribers is connected. 45 videos imported."
                      : `Your channel with ${channelData?.subscriberCount ? parseInt(channelData.subscriberCount).toLocaleString() : "0"} subscribers is connected.`
                    }
                  </p>
                  <button
                    onClick={simulatedConnected ? () => setSimulatedConnected(false) : handleDisconnect}
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
                  Connect your YouTube channel to replace demo data with your real metrics.
                </p>
              )}
            </motion.div>
          </div>
        </div>
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
