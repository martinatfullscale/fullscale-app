import { useQuery } from "@tanstack/react-query";
import { useMonetizationItems } from "@/hooks/use-monetization";
import { format } from "date-fns";
import { motion } from "framer-motion";
import { Loader2, MoreHorizontal, Clock, Youtube, CheckCircle2, XCircle } from "lucide-react";

interface YouTubeVideo {
  id: string;
  title: string;
  thumbnailUrl: string;
  publishedAt: string;
  description: string;
}

interface VideosResponse {
  connected: boolean;
  videos: YouTubeVideo[];
}

interface Props {
  isConnected: boolean;
}

export function MonetizationTable({ isConnected }: Props) {
  const { data: youtubeData, isLoading: isLoadingYoutube, isError: isYoutubeError } = useQuery<VideosResponse>({
    queryKey: ["/api/youtube/videos"],
    queryFn: async () => {
      const res = await fetch("/api/youtube/videos", { credentials: "include" });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to fetch videos");
      }
      return res.json();
    },
    enabled: isConnected,
    retry: 1,
  });

  const { data: monetizationItems, isLoading: isLoadingMonetization } = useMonetizationItems();

  const youtubeVideos = youtubeData?.videos || [];
  const isActuallyConnected = youtubeData?.connected ?? false;

  const getStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case 'monetized':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
            <CheckCircle2 className="w-3.5 h-3.5" /> Monetized
          </span>
        );
      case 'pending':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20">
            <Clock className="w-3.5 h-3.5" /> Pending
          </span>
        );
      case 'rejected':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-red-500/10 text-red-500 border border-red-500/20">
            <XCircle className="w-3.5 h-3.5" /> Rejected
          </span>
        );
      default:
        return <span className="text-muted-foreground text-sm">{status}</span>;
    }
  };

  const isLoading = isConnected ? isLoadingYoutube : isLoadingMonetization;

  if (isLoading) {
    return (
      <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
        <div className="p-6 border-b border-border">
          <h3 className="font-display font-bold text-lg">
            {isConnected ? "Recent Videos" : "Monetization Status"}
          </h3>
        </div>
        <div className="w-full h-64 flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
        </div>
      </div>
    );
  }

  if (isConnected && isYoutubeError) {
    return (
      <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
        <div className="p-6 border-b border-border">
          <h3 className="font-display font-bold text-lg">Recent Videos</h3>
        </div>
        <div className="p-12 text-center">
          <p className="text-muted-foreground">Unable to load videos. Please try reconnecting your YouTube channel.</p>
        </div>
      </div>
    );
  }

  if (isConnected && isActuallyConnected) {
    return (
      <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
        <div className="p-6 border-b border-border flex justify-between items-center gap-4">
          <h3 className="font-display font-bold text-lg">Recent Videos</h3>
          <span className="text-sm text-muted-foreground">{youtubeVideos.length} videos</span>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-secondary/30 text-left">
                <th className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Video</th>
                <th className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Title</th>
                <th className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Published</th>
                <th className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                <th className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {youtubeVideos.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                    No videos found on your channel yet.
                  </td>
                </tr>
              ) : (
                youtubeVideos.map((video, index) => (
                  <motion.tr 
                    key={video.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.05 }}
                    className="hover:bg-secondary/20 transition-colors group"
                    data-testid={`row-video-${video.id}`}
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="h-10 w-16 bg-secondary rounded-lg overflow-hidden border border-border relative">
                        {video.thumbnailUrl ? (
                          <img 
                            src={video.thumbnailUrl} 
                            alt={video.title} 
                            className="w-full h-full object-cover" 
                            data-testid={`img-thumbnail-${video.id}`}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-secondary">
                            <span className="text-xs text-muted-foreground">No img</span>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div 
                        className="text-sm font-medium text-foreground max-w-xs truncate"
                        data-testid={`text-title-${video.id}`}
                      >
                        {video.title}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-muted-foreground" data-testid={`text-date-${video.id}`}>
                        {video.publishedAt ? format(new Date(video.publishedAt), 'MMM d, yyyy') : 'N/A'}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20">
                        <Clock className="w-3.5 h-3.5" /> Pending Review
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <button 
                        className="text-muted-foreground hover:text-foreground p-2 rounded-lg hover:bg-secondary transition-colors"
                        data-testid={`button-actions-${video.id}`}
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                    </td>
                  </motion.tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
      <div className="p-6 border-b border-border flex justify-between items-center gap-4">
        <h3 className="font-display font-bold text-lg">Monetization Status</h3>
        <button className="text-sm text-primary hover:text-primary/80 font-medium">View All</button>
      </div>
      
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-secondary/30 text-left">
              <th className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Video</th>
              <th className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Title</th>
              <th className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Date</th>
              <th className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
              <th className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {!monetizationItems || monetizationItems.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center">
                  <div className="w-12 h-12 bg-red-600/10 rounded-xl flex items-center justify-center mb-4 mx-auto text-red-500">
                    <Youtube className="w-6 h-6" />
                  </div>
                  <p className="text-muted-foreground">Connect your YouTube channel to see your real videos here.</p>
                </td>
              </tr>
            ) : (
              monetizationItems.map((item, index) => (
                <motion.tr 
                  key={item.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="hover:bg-secondary/20 transition-colors group"
                  data-testid={`row-monetization-${item.id}`}
                >
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="h-10 w-16 bg-secondary rounded-lg overflow-hidden border border-border relative">
                      {item.thumbnailUrl ? (
                        <img src={item.thumbnailUrl} alt={item.title} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-secondary">
                          <span className="text-xs text-muted-foreground">No img</span>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm font-medium text-foreground max-w-xs truncate">{item.title}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-muted-foreground">
                      {item.date ? format(new Date(item.date), 'MMM d, yyyy') : 'N/A'}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {getStatusBadge(item.status)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <button className="text-muted-foreground hover:text-foreground p-2 rounded-lg hover:bg-secondary transition-colors">
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                  </td>
                </motion.tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
