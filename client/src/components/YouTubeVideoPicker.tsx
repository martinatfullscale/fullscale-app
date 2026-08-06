/**
 * YouTubeVideoPicker — Browse YouTube videos and select which ones to import.
 *
 * Replaces the old "import all 50" flow with a pick-and-choose experience.
 */

import { useState, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, Youtube, Eye, Calendar, Download, CheckSquare, Square } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, fetchWithTimeout } from "@/lib/queryClient";

interface YouTubeVideo {
  youtubeId: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  viewCount: number;
  duration: string;
  alreadyImported: boolean;
}

interface YouTubeVideoPickerProps {
  open: boolean;
  onClose: () => void;
  onImportComplete?: (count: number) => void;
}

function formatDuration(iso: string): string {
  if (!iso) return "";
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return "";
  const h = match[1] ? `${match[1]}:` : "";
  const m = match[2] || "0";
  const s = (match[3] || "0").padStart(2, "0");
  return `${h}${h ? m.padStart(2, "0") : m}:${s}`;
}

function formatViews(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function YouTubeVideoPicker({ open, onClose, onImportComplete }: YouTubeVideoPickerProps) {
  const { toast } = useToast();
  const [videos, setVideos] = useState<YouTubeVideo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [totalResults, setTotalResults] = useState(0);
  const [channelTitle, setChannelTitle] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const fetchVideos = useCallback(async (pageToken?: string) => {
    setIsLoading(true);
    try {
      let url = "/api/youtube/browse?maxResults=25";
      if (pageToken) url += `&pageToken=${pageToken}`;

      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to browse videos");
      const data = await res.json();

      setVideos(prev => pageToken ? [...prev, ...data.videos] : data.videos);
      setNextPageToken(data.nextPageToken);
      setTotalResults(data.totalResults);
      if (data.channelTitle) setChannelTitle(data.channelTitle);
      setLoaded(true);
    } catch (err: any) {
      toast({ title: "Failed to load YouTube videos", description: err.message, variant: "destructive" });
    }
    setIsLoading(false);
  }, [toast]);

  // Load on open
  const handleOpen = useCallback(() => {
    if (!loaded && open) {
      fetchVideos();
    }
  }, [loaded, open, fetchVideos]);

  // Trigger load when dialog opens
  if (open && !loaded && !isLoading) {
    handleOpen();
  }

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const importable = videos.filter(v => !v.alreadyImported).map(v => v.youtubeId);
    setSelected(new Set(importable));
  };

  const deselectAll = () => setSelected(new Set());

  const handleImport = async () => {
    if (selected.size === 0) return;
    setIsImporting(true);
    try {
      const res = await fetchWithTimeout("/api/youtube/import-selected", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ videoIds: Array.from(selected) }),
      });
      if (!res.ok) throw new Error("Import failed");
      const data = await res.json();

      toast({
        title: `Imported ${data.imported} video${data.imported !== 1 ? "s" : ""}`,
        description: data.skipped > 0 ? `${data.skipped} skipped (already in library)` : undefined,
      });

      queryClient.invalidateQueries({ queryKey: ["videos"] });
      onImportComplete?.(data.imported);

      // Mark imported in local state
      setVideos(prev => prev.map(v =>
        selected.has(v.youtubeId) ? { ...v, alreadyImported: true } : v
      ));
      setSelected(new Set());
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    }
    setIsImporting(false);
  };

  const importableCount = videos.filter(v => !v.alreadyImported).length;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] p-0 bg-zinc-900 border-white/10 overflow-hidden flex flex-col">
        <DialogHeader className="p-5 pb-3 border-b border-white/10 flex-shrink-0">
          <DialogTitle className="flex items-center gap-2 text-white">
            <Youtube className="w-5 h-5 text-red-500" />
            {channelTitle ? `Import from ${channelTitle}` : "Browse YouTube Videos"}
          </DialogTitle>
          <p className="text-xs text-gray-400 mt-1">
            Select which videos to import into your library.
            {totalResults > 0 && ` ${totalResults} total videos on your channel.`}
          </p>
        </DialogHeader>

        {/* Controls */}
        <div className="px-5 py-2 border-b border-white/10 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={selectAll} className="text-xs text-gray-300">
              <CheckSquare className="w-3 h-3 mr-1" /> Select All ({importableCount})
            </Button>
            <Button size="sm" variant="ghost" onClick={deselectAll} className="text-xs text-gray-300">
              <Square className="w-3 h-3 mr-1" /> Deselect
            </Button>
          </div>
          {selected.size > 0 && (
            <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
              {selected.size} selected
            </Badge>
          )}
        </div>

        {/* Video Grid */}
        <div className="flex-1 overflow-y-auto p-5 space-y-2">
          {isLoading && videos.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-red-400 animate-spin" />
            </div>
          )}

          {videos.map(video => (
            <button
              key={video.youtubeId}
              onClick={() => !video.alreadyImported && toggleSelect(video.youtubeId)}
              disabled={video.alreadyImported}
              className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
                video.alreadyImported
                  ? "border-gray-700/30 bg-gray-800/30 opacity-50 cursor-not-allowed"
                  : selected.has(video.youtubeId)
                  ? "border-emerald-500/50 bg-emerald-500/10"
                  : "border-gray-700/50 bg-gray-800/40 hover:bg-gray-800/60"
              }`}
            >
              {/* Checkbox */}
              <div className="flex-shrink-0">
                {video.alreadyImported ? (
                  <CheckCircle2 className="w-5 h-5 text-gray-500" />
                ) : selected.has(video.youtubeId) ? (
                  <CheckSquare className="w-5 h-5 text-emerald-400" />
                ) : (
                  <Square className="w-5 h-5 text-gray-500" />
                )}
              </div>

              {/* Thumbnail */}
              {video.thumbnailUrl && (
                <div className="relative w-28 h-16 flex-shrink-0 rounded overflow-hidden bg-black">
                  <img src={video.thumbnailUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                  {video.duration && (
                    <span className="absolute bottom-0.5 right-0.5 bg-black/80 text-white text-[10px] px-1 rounded">
                      {formatDuration(video.duration)}
                    </span>
                  )}
                </div>
              )}

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{video.title}</p>
                <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                  <span className="flex items-center gap-1">
                    <Eye className="w-3 h-3" /> {formatViews(video.viewCount)}
                  </span>
                  {video.publishedAt && (
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" /> {formatDate(video.publishedAt)}
                    </span>
                  )}
                </div>
              </div>

              {/* Status */}
              {video.alreadyImported && (
                <Badge variant="outline" className="text-xs text-gray-500 border-gray-600 flex-shrink-0">
                  Already imported
                </Badge>
              )}
            </button>
          ))}

          {/* Load More */}
          {nextPageToken && (
            <div className="text-center pt-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => fetchVideos(nextPageToken)}
                disabled={isLoading}
                className="text-gray-400 hover:text-white"
              >
                {isLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                Load More Videos
              </Button>
            </div>
          )}
        </div>

        {/* Bottom Action Bar */}
        <div className="p-4 border-t border-white/10 flex items-center justify-between flex-shrink-0 bg-zinc-900">
          <Button variant="ghost" onClick={onClose} className="text-gray-400">
            Cancel
          </Button>
          <Button
            onClick={handleImport}
            disabled={selected.size === 0 || isImporting}
            className="bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            {isImporting ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <Download className="w-4 h-4 mr-2" />
            )}
            Import {selected.size > 0 ? `${selected.size} Video${selected.size !== 1 ? "s" : ""}` : "Selected"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
