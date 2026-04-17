/**
 * AnalyticsOverview — Creator analytics dashboard showing platform stats + per-video metrics.
 */

import { useQuery } from "@tanstack/react-query";
import { Youtube, Eye, Video, BarChart3, Sparkles, Loader2, TrendingUp } from "lucide-react";

interface AnalyticsData {
  platformStats: Record<string, any>;
  videoMetrics: Array<{
    videoId: number;
    title: string;
    thumbnailUrl: string | null;
    platform: string;
    viewCount: number;
    status: string;
    editorialClipCount: number;
    editorialStatus: string | null;
    publishedAt: string | null;
  }>;
  summary: {
    totalVideos: number;
    totalViews: number;
    youtubeVideos: number;
    uploadedVideos: number;
    videosWithEditorial: number;
    totalEditorialClips: number;
    youtubeSubscribers: number;
    youtubeTotalViews: number;
  };
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function StatCard({ icon: Icon, label, value, subValue, color }: {
  icon: any;
  label: string;
  value: string;
  subValue?: string;
  color: string;
}) {
  return (
    <div className={`rounded-xl border p-4 ${color}`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 opacity-80" />
        <span className="text-xs font-medium opacity-80">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {subValue && <p className="text-xs opacity-60 mt-0.5">{subValue}</p>}
    </div>
  );
}

export function AnalyticsOverview() {
  const { data, isLoading } = useQuery<AnalyticsData>({
    queryKey: ["/api/analytics/overview"],
    staleTime: 30000,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="bg-zinc-900/50 rounded-2xl border border-white/10 p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  if (!data || data.summary.totalVideos === 0) {
    return (
      <div className="bg-zinc-900/50 rounded-2xl border border-white/10 p-8 text-center">
        <BarChart3 className="w-10 h-10 text-gray-600 mx-auto mb-3" />
        <p className="text-sm font-medium text-gray-400">No analytics yet</p>
        <p className="text-xs text-gray-500 mt-1">Upload videos or connect YouTube to see your stats</p>
      </div>
    );
  }

  const { summary, videoMetrics, platformStats } = data;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <TrendingUp className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-bold text-white">Analytics</h2>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Video}
          label="Total Videos"
          value={String(summary.totalVideos)}
          subValue={`${summary.youtubeVideos} YouTube · ${summary.uploadedVideos} uploaded`}
          color="bg-blue-500/10 border-blue-500/20 text-blue-400"
        />
        {summary.youtubeTotalViews > 0 && (
          <StatCard
            icon={Eye}
            label="YouTube Views"
            value={formatNumber(summary.youtubeTotalViews)}
            subValue={platformStats.youtube?.channelTitle || undefined}
            color="bg-red-500/10 border-red-500/20 text-red-400"
          />
        )}
        {summary.youtubeSubscribers > 0 && (
          <StatCard
            icon={Youtube}
            label="Subscribers"
            value={formatNumber(summary.youtubeSubscribers)}
            color="bg-red-500/10 border-red-500/20 text-red-400"
          />
        )}
        <StatCard
          icon={Sparkles}
          label="Story Clips"
          value={String(summary.totalEditorialClips)}
          subValue={`${summary.videosWithEditorial} videos processed`}
          color="bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
        />
      </div>

      {/* Per-Video Table */}
      {videoMetrics.length > 0 && (
        <div className="bg-zinc-900/50 rounded-xl border border-white/10 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5">
            <p className="text-sm font-medium text-gray-300">Top Videos</p>
          </div>
          <div className="divide-y divide-white/5">
            {videoMetrics.slice(0, 10).map((video) => (
              <div key={video.videoId} className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 transition-colors">
                {/* Thumbnail */}
                <div className="w-12 h-7 bg-black rounded overflow-hidden flex-shrink-0">
                  {video.thumbnailUrl && (
                    <img src={video.thumbnailUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                  )}
                </div>

                {/* Title */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{video.title}</p>
                  <p className="text-xs text-gray-500 capitalize">{video.platform}</p>
                </div>

                {/* Views */}
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-medium text-white">{formatNumber(video.viewCount)}</p>
                  <p className="text-xs text-gray-500">views</p>
                </div>

                {/* Editorial status */}
                <div className="w-16 text-right flex-shrink-0">
                  {video.editorialClipCount > 0 ? (
                    <span className="text-xs text-emerald-400">{video.editorialClipCount} clips</span>
                  ) : video.editorialStatus === "rendering" ? (
                    <span className="text-xs text-yellow-400">Rendering</span>
                  ) : (
                    <span className="text-xs text-gray-600">—</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
