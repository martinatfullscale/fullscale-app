import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Download,
  Film,
  Loader2,
  Clock,
  Calendar,
  FileText,
  Wand2,
  AlertCircle,
  Play,
  RefreshCw,
  FolderOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

interface VideoRecord {
  id: number;
  userId: string;
  title: string | null;
  sourceFileName: string | null;
  status: string;
  progress: number;
  outputUrl: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  sceneCount: number | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface VideosResponse {
  videos: VideoRecord[];
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const statusConfig: Record<string, { label: string; color: string; bgColor: string }> = {
  completed: { label: "Ready", color: "text-green-400", bgColor: "bg-green-500/10" },
  processing: { label: "Processing", color: "text-purple-400", bgColor: "bg-purple-500/10" },
  queued: { label: "Queued", color: "text-yellow-400", bgColor: "bg-yellow-500/10" },
  failed: { label: "Failed", color: "text-red-400", bgColor: "bg-red-500/10" },
};

export default function StudioLibrary() {
  const [filter, setFilter] = useState<"all" | "completed" | "processing" | "failed">("all");

  const { data, isLoading, refetch } = useQuery<VideosResponse>({
    queryKey: ["/api/studio/videos"],
    refetchInterval: 10000, // Refresh every 10s to catch processing updates
  });

  const videos = data?.videos || [];
  const filteredVideos = filter === "all" ? videos : videos.filter((v) => v.status === filter);

  const counts = {
    all: videos.length,
    completed: videos.filter((v) => v.status === "completed").length,
    processing: videos.filter((v) => v.status === "processing" || v.status === "queued").length,
    failed: videos.filter((v) => v.status === "failed").length,
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
          <a href="/">
            <img src={logoUrl} alt="FullScale" className="h-7" />
          </a>
          <div className="flex items-center gap-3">
            <a
              href="/studio/pricing"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Pricing
            </a>
            <a href="/studio/upload">
              <Badge variant="outline" className="text-xs font-medium cursor-pointer hover:bg-white/5">
                <Wand2 className="w-3 h-3 mr-1" />
                Upload
              </Badge>
            </a>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-10">
        {/* Title */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-3">
              <FolderOpen className="w-6 h-6 text-purple-400" />
              My Videos
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              All your generated videos in one place
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => refetch()} className="gap-1.5">
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </Button>
            <a href="/studio/upload">
              <Button size="sm" className="gap-1.5 bg-purple-600 hover:bg-purple-500">
                <Wand2 className="w-3.5 h-3.5" />
                New Video
              </Button>
            </a>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 mb-6">
          {(["all", "completed", "processing", "failed"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                filter === f
                  ? "bg-purple-500/10 text-purple-300 border border-purple-500/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              )}
            >
              {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
              {counts[f] > 0 && (
                <span className="ml-1.5 text-[10px] opacity-60">({counts[f]})</span>
              )}
            </button>
          ))}
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
          </div>
        )}

        {/* Empty state */}
        {!isLoading && filteredVideos.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center py-20"
          >
            <Film className="w-12 h-12 text-white/10 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-2">
              {filter === "all" ? "No videos yet" : `No ${filter} videos`}
            </h3>
            <p className="text-sm text-muted-foreground mb-6">
              {filter === "all"
                ? "Upload a PDF or PPTX to create your first video"
                : "Try a different filter"}
            </p>
            {filter === "all" && (
              <a href="/studio/upload">
                <Button className="gap-2 bg-purple-600 hover:bg-purple-500">
                  <Wand2 className="w-4 h-4" />
                  Create Your First Video
                </Button>
              </a>
            )}
          </motion.div>
        )}

        {/* Video grid */}
        {!isLoading && filteredVideos.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredVideos.map((video, idx) => {
              const status = statusConfig[video.status] || statusConfig.failed;

              return (
                <motion.div
                  key={video.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05 }}
                >
                  <Card className="border-white/5 hover:border-white/10 transition-all group overflow-hidden">
                    {/* Thumbnail / Status area */}
                    <div className="relative h-36 bg-gradient-to-br from-purple-900/20 to-black flex items-center justify-center">
                      {video.status === "completed" ? (
                        <div className="text-center">
                          <Play className="w-10 h-10 text-white/20 mx-auto group-hover:text-purple-400 transition-colors" />
                        </div>
                      ) : video.status === "processing" || video.status === "queued" ? (
                        <div className="text-center">
                          <Loader2 className="w-8 h-8 text-purple-400 animate-spin mx-auto" />
                          <p className="text-xs text-purple-400/60 mt-2">{video.progress}%</p>
                        </div>
                      ) : (
                        <div className="text-center">
                          <AlertCircle className="w-8 h-8 text-red-400/40 mx-auto" />
                        </div>
                      )}

                      {/* Status badge */}
                      <div className="absolute top-2 right-2">
                        <Badge className={cn("text-[10px]", status.bgColor, status.color, "border-0")}>
                          {status.label}
                        </Badge>
                      </div>
                    </div>

                    <CardContent className="p-4 space-y-3">
                      {/* Title */}
                      <div>
                        <h3 className="font-medium text-sm truncate">
                          {video.title || video.sourceFileName || "Untitled Video"}
                        </h3>
                        {video.sourceFileName && video.title && (
                          <p className="text-[11px] text-muted-foreground truncate flex items-center gap-1 mt-0.5">
                            <FileText className="w-3 h-3" />
                            {video.sourceFileName}
                          </p>
                        )}
                      </div>

                      {/* Metadata */}
                      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                        {video.durationSeconds && (
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDuration(video.durationSeconds)}
                          </span>
                        )}
                        {video.sceneCount && (
                          <span className="flex items-center gap-1">
                            <Film className="w-3 h-3" />
                            {video.sceneCount} scenes
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {formatDate(video.createdAt)}
                        </span>
                      </div>

                      {/* Error message */}
                      {video.status === "failed" && video.errorMessage && (
                        <p className="text-[11px] text-red-400/70 line-clamp-2">
                          {video.errorMessage}
                        </p>
                      )}

                      {/* Processing progress bar */}
                      {(video.status === "processing" || video.status === "queued") && (
                        <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-purple-500 rounded-full transition-all duration-500"
                            style={{ width: `${video.progress}%` }}
                          />
                        </div>
                      )}

                      {/* Actions */}
                      {video.status === "completed" && (
                        <a
                          href={`/api/studio/videos/${video.id}/download`}
                          className="block"
                        >
                          <Button
                            size="sm"
                            className="w-full gap-1.5 bg-green-600 hover:bg-green-500 text-xs"
                          >
                            <Download className="w-3.5 h-3.5" />
                            Download MP4
                          </Button>
                        </a>
                      )}

                      {video.status === "failed" && (
                        <a href="/studio/upload" className="block">
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full gap-1.5 text-xs"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            Try Again
                          </Button>
                        </a>
                      )}
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
