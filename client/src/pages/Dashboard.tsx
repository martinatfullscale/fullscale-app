import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { MetricCard } from "@/components/MetricCard";
import { MonetizationTable } from "@/components/MonetizationTable";
import { Video, Layers, Workflow, Youtube, CheckCircle, Unlink, Users } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";

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

export default function Dashboard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

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

  const handleDisconnect = () => {
    disconnectMutation.mutate();
  };

  const videoCount = channelData?.videoCount ? parseInt(channelData.videoCount, 10) : 0;
  const viewCount = channelData?.viewCount ? parseInt(channelData.viewCount, 10) : 0;
  const subscriberCount = channelData?.subscriberCount ? parseInt(channelData.subscriberCount, 10) : 0;
  const isConnected = youtubeStatus?.connected || false;
  const isLoadingStats = isConnected && isLoadingChannel;

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <Sidebar />
      <TopBar />

      <main className="ml-64 p-8 max-w-7xl mx-auto">
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold font-display mb-2" data-testid="text-welcome">
            Welcome back, {user?.firstName || "Creator"}
          </h1>
          <p className="text-muted-foreground">Here's what's happening with your content today.</p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <MetricCard 
            title="Total Videos" 
            value={isLoadingStats ? "..." : (isConnected ? videoCount.toLocaleString() : "-")} 
            icon={<Video className="w-5 h-5" />} 
            delay={0}
            colorClass="bg-blue-500"
          />
          <MetricCard 
            title="Total Views" 
            value={isLoadingStats ? "..." : (isConnected ? viewCount.toLocaleString() : "-")} 
            icon={<Layers className="w-5 h-5" />} 
            delay={1}
            colorClass="bg-purple-500"
          />
          <MetricCard 
            title="Subscribers" 
            value={isLoadingStats ? "..." : (isConnected ? subscriberCount.toLocaleString() : "-")} 
            icon={<Users className="w-5 h-5" />} 
            delay={2}
            colorClass="bg-emerald-500"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            <MonetizationTable isConnected={isConnected} />
          </div>

          <div className="space-y-6">
            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3 }}
              className="bg-gradient-to-br from-card to-secondary/30 rounded-2xl p-6 border border-border shadow-lg"
            >
              <div className="flex items-center gap-4 mb-4">
                {isConnected && channelData?.profilePictureUrl ? (
                  <Avatar className="w-12 h-12">
                    <AvatarImage 
                      src={channelData.profilePictureUrl} 
                      alt={channelData.title}
                      data-testid="img-channel-avatar"
                    />
                    <AvatarFallback>
                      <Youtube className="w-6 h-6 text-red-500" />
                    </AvatarFallback>
                  </Avatar>
                ) : (
                  <div className="w-12 h-12 bg-red-600/10 rounded-xl flex items-center justify-center text-red-500">
                    <Youtube className="w-6 h-6" />
                  </div>
                )}
                <div className="flex-1">
                  <h3 className="text-lg font-bold font-display" data-testid="text-channel-title">
                    {isConnected ? (channelData?.title || youtubeStatus?.channelTitle || "YouTube Connected") : "Connect YouTube"}
                  </h3>
                  {isConnected && (
                    <div className="flex items-center gap-1 text-xs text-emerald-500">
                      <CheckCircle className="w-3 h-3" />
                      <span>Channel linked</span>
                    </div>
                  )}
                </div>
              </div>
              
              {isConnected ? (
                <>
                  <p className="text-sm text-muted-foreground mb-6">
                    Your channel with {channelData?.subscriberCount ? parseInt(channelData.subscriberCount).toLocaleString() : "0"} subscribers is connected.
                  </p>
                  <button
                    onClick={handleDisconnect}
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
                <>
                  <p className="text-sm text-muted-foreground mb-6">
                    Link your channel to automatically index new content and track monetization status in real-time.
                  </p>
                  <button
                    onClick={handleConnect}
                    disabled={isCheckingYoutube}
                    data-testid="button-connect-youtube"
                    className="w-full py-3 px-4 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold rounded-xl shadow-lg shadow-primary/25 transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {isCheckingYoutube ? (
                      <>
                        <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Checking...
                      </>
                    ) : (
                      "Connect Channel"
                    )}
                  </button>
                </>
              )}
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 }}
              className="bg-card rounded-2xl p-6 border border-border"
            >
              <h3 className="font-semibold mb-4">Quick Actions</h3>
              <div className="space-y-3">
                <button className="w-full text-left px-4 py-3 rounded-xl bg-secondary/30 hover:bg-secondary/60 text-sm font-medium transition-colors border border-transparent hover:border-border">
                  Upload Manual Asset
                </button>
                <button className="w-full text-left px-4 py-3 rounded-xl bg-secondary/30 hover:bg-secondary/60 text-sm font-medium transition-colors border border-transparent hover:border-border">
                  Configure Webhooks
                </button>
                <button className="w-full text-left px-4 py-3 rounded-xl bg-secondary/30 hover:bg-secondary/60 text-sm font-medium transition-colors border border-transparent hover:border-border">
                  View API Documentation
                </button>
              </div>
            </motion.div>
          </div>
        </div>
      </main>
    </div>
  );
}
