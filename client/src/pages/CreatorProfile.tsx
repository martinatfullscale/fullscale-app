import { useState } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Play,
  Eye,
  Target,
  CheckCircle,
  Video,
  Layers,
  Clock,
  ArrowRight,
  Sparkles,
  Mic,
  Globe,
  ExternalLink,
  Mail,
  X,
} from "lucide-react";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import fullscaleLogo from "@assets/fullscale-logo_1767679525676.png";

interface Surface {
  id: number;
  timestamp: number;
  surfaceType: string;
  confidence: number;
  frameUrl: string | null;
  sceneContext: string | null;
  boundingBoxX: number;
  boundingBoxY: number;
  boundingBoxWidth: number;
  boundingBoxHeight: number;
}

interface VideoData {
  id: number;
  title: string;
  thumbnail: string | null;
  videoUrl: string | null;
  filePath: string | null;
  platform: string;
  viewCount: number;
  surfaceCount: number;
  surfaceTypes: string[];
  surfaces: Surface[];
  category: string | null;
  duration: number | null;
}

// Normalize filePath to a browser-playable URL (same logic as VideoPreviewModal)
function normalizeVideoSrc(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  let src = filePath;
  src = src.replace(/^\/home\/runner\/workspace\/public\//, '/');
  src = src.replace(/^\.\/public\//, '/');
  src = src.replace(/^public\//, '/');
  src = src.replace(/\/\//g, '/');
  if (!src.startsWith('/') && !src.startsWith('http')) src = '/' + src;
  return src;
}

interface SocialStats {
  youtube?: {
    subscribers: number;
    totalViews: number;
    channelTitle: string | null;
    channelId: string | null;
  };
  instagram?: {
    followers: number;
    handle: string | null;
  };
  facebook?: {
    followers: number;
    pageName: string | null;
  };
}

interface CreatorData {
  creator: {
    name: string;
    email: string;
    slug: string;
    profileImage: string | null;
    bio: string | null;
    headline: string | null;
    podcastName: string | null;
    podcastUrl: string | null;
    websiteUrl: string | null;
    userType: string;
  };
  stats: {
    totalVideos: number;
    totalViews: number;
    totalSurfaces: number;
    surfaceTypes: string[];
    categories: string[];
  };
  socialStats: SocialStats | null;
  videos: VideoData[];
}

function formatNumber(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return num.toLocaleString();
}

function getInitials(name: string): string {
  // Strip parentheses and non-letter chars, then take first letter of each word
  return name
    .replace(/[^a-zA-Z\s]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export default function CreatorProfile() {
  const { slug } = useParams<{ slug: string }>();
  const { toast } = useToast();
  const [selectedVideo, setSelectedVideo] = useState<VideoData | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoData | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const [formData, setFormData] = useState({
    brandName: "",
    brandEmail: "",
    message: "",
  });
  const [submitted, setSubmitted] = useState(false);

  const { data, isLoading, error } = useQuery<CreatorData>({
    queryKey: ["/api/public/creator", slug],
    queryFn: async () => {
      const res = await fetch(`/api/public/creator/${slug}`);
      if (!res.ok) throw new Error("Creator not found");
      return res.json();
    },
    enabled: !!slug,
  });

  const placementMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await apiRequest("POST", "/api/public/placement-request", payload);
      return res.json();
    },
    onSuccess: () => {
      setSubmitted(true);
    },
    onError: (err: any) => {
      toast({
        title: "Error",
        description: err.message || "Failed to send request",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVideo || !data) return;

    placementMutation.mutate({
      videoId: selectedVideo.id,
      brandName: formData.brandName,
      brandEmail: formData.brandEmail,
      message: formData.message,
    });
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setSelectedVideo(null);
    setFormData({ brandName: "", brandEmail: "", message: "" });
    setSubmitted(false);
  };

  const openPlacementRequest = (video: VideoData) => {
    setSelectedVideo(video);
    setIsModalOpen(true);
  };

  const openSurfacePreview = (video: VideoData) => {
    setPreviewVideo(video);
    setIsPreviewOpen(true);
  };

  // --- Loading state ---
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading portfolio...</p>
        </div>
      </div>
    );
  }

  // --- Error / not found ---
  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-8">
        <img src={fullscaleLogo} alt="FullScale" className="h-12 mb-8" />
        <h1 className="text-2xl font-bold text-foreground mb-2">Creator Not Found</h1>
        <p className="text-muted-foreground">
          The creator profile you're looking for doesn't exist.
        </p>
      </div>
    );
  }

  const { creator, stats, socialStats, videos } = data;

  // Platform filter state. Tabs: all / youtube / instagram / facebook / fullscale (uploads).
  // Counts are derived from videos so we always show the live tally per source.
  const platformCounts = videos.reduce<Record<string, number>>((acc, v) => {
    const key = (v.platform || "fullscale").toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const filteredVideos = platformFilter === "all"
    ? videos
    : videos.filter(v => (v.platform || "fullscale").toLowerCase() === platformFilter);

  return (
    <div className="min-h-screen bg-background">
      {/* ── Sticky header ── */}
      <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <img src={fullscaleLogo} alt="FullScale" className="h-7" />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              onClick={() => {
                const el = document.getElementById("video-portfolio");
                el?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              View Portfolio
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => {
                // Go back to marketplace, or browser history if available
                if (window.history.length > 1) {
                  window.history.back();
                } else {
                  window.location.href = "/marketplace";
                }
              }}
              title="Close"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* ── Hero section ── */}
      <section className="relative overflow-hidden">
        {/* Subtle gradient backdrop */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-primary/3" />
        <div className="relative max-w-6xl mx-auto px-6 pt-16 pb-12">
          <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
            {/* Avatar */}
            <Avatar className="h-24 w-24 border-4 border-background shadow-lg">
              <AvatarImage src={creator.profileImage || undefined} alt={creator.name} />
              <AvatarFallback className="text-2xl font-bold bg-primary/10 text-primary">
                {getInitials(creator.name)}
              </AvatarFallback>
            </Avatar>

            {/* Name + bio */}
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1">
                <h1
                  className="text-3xl md:text-4xl font-bold text-foreground tracking-tight"
                  data-testid="text-creator-name"
                >
                  {creator.name}
                </h1>
                <Badge variant="secondary" className="text-xs capitalize">
                  {creator.userType}
                </Badge>
              </div>
              {creator.headline && (
                <p className="text-primary font-medium text-base mb-2">{creator.headline}</p>
              )}
              {creator.bio ? (
                <p className="text-muted-foreground text-lg max-w-2xl">{creator.bio}</p>
              ) : (
                <p className="text-muted-foreground text-lg">
                  Content creator with {stats.totalVideos} video
                  {stats.totalVideos !== 1 ? "s" : ""} available for brand placements
                </p>
              )}
              {/* Quick links */}
              <div className="flex items-center gap-3 mt-3 flex-wrap">
                {creator.podcastName && (
                  <a
                    href={creator.podcastUrl || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Mic className="h-3.5 w-3.5" />
                    {creator.podcastName}
                  </a>
                )}
                {creator.websiteUrl && (
                  <a
                    href={creator.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Globe className="h-3.5 w-3.5" />
                    Website
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>

            {/* CTA buttons */}
            <div className="hidden md:flex flex-col gap-2">
              {videos.length > 0 && (
                <Button
                  size="lg"
                  className="gap-2"
                  onClick={() => {
                    const el = document.getElementById("video-portfolio");
                    el?.scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  Browse Videos
                  <ArrowRight className="h-4 w-4" />
                </Button>
              )}
              <Button
                size="lg"
                variant="outline"
                className="gap-2"
                onClick={() => {
                  // Open placement request with first available video
                  if (videos.length > 0) {
                    openPlacementRequest(videos[0]);
                  }
                }}
              >
                <Mail className="h-4 w-4" />
                Get in Touch
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats bar ── */}
      <section className="border-y bg-card/50">
        <div className="max-w-6xl mx-auto px-6 py-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div className="text-center">
              <div className="flex items-center justify-center gap-2 mb-1">
                <Video className="h-4 w-4 text-primary" />
                <span className="text-2xl font-bold text-foreground">{stats.totalVideos}</span>
              </div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Videos</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-2 mb-1">
                <Eye className="h-4 w-4 text-primary" />
                <span className="text-2xl font-bold text-foreground">
                  {formatNumber(stats.totalViews)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Views</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-2 mb-1">
                <Target className="h-4 w-4 text-primary" />
                <span className="text-2xl font-bold text-foreground">{stats.totalSurfaces}</span>
              </div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Ad Surfaces</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-2 mb-1">
                <Layers className="h-4 w-4 text-primary" />
                <span className="text-2xl font-bold text-foreground">
                  {stats.surfaceTypes.length || 1}
                </span>
              </div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Surface Types</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Social stats row ── */}
      {socialStats && Object.keys(socialStats).length > 0 && (
        <section className="bg-card/30">
          <div className="max-w-6xl mx-auto px-6 py-4">
            <div className="flex items-center justify-center gap-6 flex-wrap">
              {socialStats.youtube && (
                <a
                  href={socialStats.youtube.channelId
                    ? `https://youtube.com/channel/${socialStats.youtube.channelId}`
                    : "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2.5 px-4 py-2 rounded-full bg-red-500/10 hover:bg-red-500/20 transition-colors"
                >
                  <svg className="h-4 w-4 text-red-500" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                  </svg>
                  <span className="text-sm font-medium text-foreground">
                    {formatNumber(socialStats.youtube.subscribers)}
                  </span>
                  <span className="text-xs text-muted-foreground">subscribers</span>
                </a>
              )}
              {socialStats.instagram && (
                <a
                  href={socialStats.instagram.handle
                    ? `https://instagram.com/${socialStats.instagram.handle.replace("@", "")}`
                    : "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2.5 px-4 py-2 rounded-full bg-pink-500/10 hover:bg-pink-500/20 transition-colors"
                >
                  <svg className="h-4 w-4 text-pink-500" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" />
                  </svg>
                  <span className="text-sm font-medium text-foreground">
                    {formatNumber(socialStats.instagram.followers)}
                  </span>
                  <span className="text-xs text-muted-foreground">followers</span>
                </a>
              )}
              {socialStats.facebook && (
                <div className="flex items-center gap-2.5 px-4 py-2 rounded-full bg-blue-500/10">
                  <svg className="h-4 w-4 text-blue-500" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
                  </svg>
                  <span className="text-sm font-medium text-foreground">
                    {formatNumber(socialStats.facebook.followers)}
                  </span>
                  <span className="text-xs text-muted-foreground">followers</span>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── Podcast section (if applicable) ── */}
      {creator.podcastName && (
        <section className="border-b bg-gradient-to-r from-primary/5 to-transparent">
          <div className="max-w-6xl mx-auto px-6 py-8">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Mic className="h-7 w-7 text-primary" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-foreground">{creator.podcastName}</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {creator.headline || `Podcast by ${creator.name}`}
                </p>
              </div>
              {creator.podcastUrl && (
                <a
                  href={creator.podcastUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Listen Now
                  </Button>
                </a>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── Video portfolio grid ── */}
      <main className="max-w-6xl mx-auto px-6 py-12" id="video-portfolio">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl font-bold text-foreground">Video Portfolio</h2>
            <p className="text-muted-foreground text-sm mt-1">
              Browse available videos and request ad placements
            </p>
          </div>
          {stats.surfaceTypes.length > 0 && (
            <div className="hidden md:flex items-center gap-2">
              {stats.surfaceTypes.map((type) => (
                <Badge key={type} variant="outline" className="text-xs">
                  {type}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {videos.length === 0 ? (
          <Card>
            <CardContent className="py-20 text-center">
              <Video className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-lg font-medium text-foreground mb-1">No videos yet</p>
              <p className="text-muted-foreground">
                This creator hasn't uploaded any videos for placements yet.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Platform filter tabs — mirrors the library tabs so brand viewers
                can quickly scope to one source (YouTube / IG / Uploads). */}
            <div className="flex flex-wrap gap-2 mb-6">
              {[
                { key: "all", label: "All", count: videos.length },
                { key: "youtube", label: "YouTube", count: platformCounts.youtube || 0 },
                { key: "instagram", label: "Instagram", count: platformCounts.instagram || 0 },
                { key: "facebook", label: "Facebook", count: platformCounts.facebook || 0 },
                { key: "fullscale", label: "Uploads", count: platformCounts.fullscale || 0 },
              ]
                .filter(tab => tab.key === "all" || tab.count > 0)
                .map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setPlatformFilter(tab.key)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      platformFilter === tab.key
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                    }`}
                    data-testid={`filter-${tab.key}`}
                  >
                    {tab.label} ({tab.count})
                  </button>
                ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredVideos.map((video) => (
              <Card
                key={video.id}
                className="overflow-hidden group border border-border/50 hover:border-primary/30 transition-all duration-300 hover:shadow-lg"
                data-testid={`card-video-${video.id}`}
              >
                {/* Video / Thumbnail */}
                <div className="relative aspect-video bg-black overflow-hidden">
                  {(video.videoUrl || video.filePath) ? (
                    <video
                      src={video.videoUrl || normalizeVideoSrc(video.filePath) || ""}
                      poster={video.thumbnail || undefined}
                      controls
                      preload="metadata"
                      playsInline
                      muted
                      className="w-full h-full object-contain"
                      onLoadedMetadata={(e) => {
                        const vid = e.currentTarget;
                        if (vid.currentTime === 0) vid.currentTime = 0.5;
                      }}
                      onError={(e) => {
                        const videoEl = e.currentTarget;
                        const fallbackSrc = normalizeVideoSrc(video.filePath);
                        if (fallbackSrc && videoEl.src !== window.location.origin + fallbackSrc) {
                          videoEl.src = fallbackSrc;
                        }
                      }}
                    />
                  ) : video.thumbnail ? (
                    <img
                      src={video.thumbnail}
                      alt={video.title}
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                        const parent = (e.target as HTMLImageElement).parentElement;
                        if (parent) {
                          const fallback = document.createElement("div");
                          fallback.className =
                            "w-full h-full flex items-center justify-center bg-muted absolute inset-0";
                          fallback.innerHTML =
                            '<svg class="h-12 w-12 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
                          parent.appendChild(fallback);
                        }
                      }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Play className="h-12 w-12 text-muted-foreground" />
                    </div>
                  )}

                  {/* Platform badge */}
                  <Badge className="absolute top-3 right-3 text-xs capitalize" variant="secondary">
                    {video.platform}
                  </Badge>

                  {/* Surface count overlay */}
                  {video.surfaceCount > 0 && (
                    <div className="absolute bottom-3 left-3 flex items-center gap-1.5 bg-black/70 text-white text-xs px-2.5 py-1 rounded-full backdrop-blur-sm">
                      <Target className="h-3 w-3" />
                      {video.surfaceCount} ad spot{video.surfaceCount !== 1 ? "s" : ""}
                    </div>
                  )}
                </div>

                {/* Content */}
                <CardContent className="p-5">
                  <h3
                    className="font-semibold text-foreground line-clamp-2 mb-3 text-base"
                    data-testid={`text-video-title-${video.id}`}
                  >
                    {video.title}
                  </h3>

                  {/* Stats row */}
                  <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
                    <span className="flex items-center gap-1.5">
                      <Eye className="h-3.5 w-3.5" />
                      {formatNumber(video.viewCount)} views
                    </span>
                    {video.duration && (
                      <span className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5" />
                        {Math.floor(video.duration / 60)}:{String(video.duration % 60).padStart(2, "0")}
                      </span>
                    )}
                  </div>

                  {/* Surface type tags */}
                  {video.surfaceTypes && video.surfaceTypes.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {video.surfaceTypes.map((type) => (
                        <Badge key={type} variant="outline" className="text-xs font-normal">
                          {type}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <Separator className="mb-4" />

                  {/* Action buttons */}
                  <div className="flex gap-2">
                    {video.surfaces && video.surfaces.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 text-xs"
                        onClick={() => openSurfacePreview(video)}
                        data-testid={`button-view-surfaces-${video.id}`}
                      >
                        <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                        View Surfaces
                      </Button>
                    )}
                    <Button
                      size="sm"
                      className="flex-1 text-xs"
                      onClick={() => openPlacementRequest(video)}
                      data-testid={`button-request-placement-${video.id}`}
                    >
                      Request Placement
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            </div>
          </>
        )}
      </main>

      {/* ── Surface Preview Modal ── */}
      <Dialog open={isPreviewOpen} onOpenChange={() => setIsPreviewOpen(false)}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Ad Surfaces Detected</DialogTitle>
            <DialogDescription>
              {previewVideo && (
                <span>
                  {previewVideo.surfaceCount} surface
                  {previewVideo.surfaceCount !== 1 ? "s" : ""} found in "
                  {previewVideo.title}"
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {previewVideo && (
            <div className="space-y-4 mt-2">
              {previewVideo.surfaces
                .filter((s) => s.frameUrl)
                .map((surface, idx) => (
                  <div
                    key={surface.id}
                    className="rounded-lg border overflow-hidden"
                  >
                    <div className="relative aspect-video bg-muted">
                      <img
                        src={surface.frameUrl!}
                        alt={`Surface at ${surface.timestamp}s`}
                        className="w-full h-full object-contain"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                      {/* Bounding box overlay */}
                      <div
                        className="absolute border-2 border-primary/80 bg-primary/10 rounded-sm"
                        style={{
                          left: `${surface.boundingBoxX}%`,
                          top: `${surface.boundingBoxY}%`,
                          width: `${surface.boundingBoxWidth}%`,
                          height: `${surface.boundingBoxHeight}%`,
                        }}
                      />
                    </div>
                    <div className="px-4 py-3 bg-card flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Badge variant="secondary" className="text-xs">
                          {surface.surfaceType}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          at {Math.floor(surface.timestamp / 60)}:
                          {String(Math.floor(surface.timestamp) % 60).padStart(2, "0")}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {Math.round(surface.confidence * 100)}% confidence
                      </span>
                    </div>
                  </div>
                ))}

              {previewVideo.surfaces.filter((s) => s.frameUrl).length === 0 && (
                <div className="py-12 text-center text-muted-foreground">
                  <p>Surface frames are being processed. Check back soon.</p>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="mt-4">
            <Button
              variant="outline"
              onClick={() => setIsPreviewOpen(false)}
            >
              Close
            </Button>
            {previewVideo && (
              <Button onClick={() => {
                setIsPreviewOpen(false);
                openPlacementRequest(previewVideo);
              }}>
                Request Placement
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Placement Request Modal ── */}
      <Dialog open={isModalOpen} onOpenChange={closeModal}>
        <DialogContent className="sm:max-w-md">
          {submitted ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-green-500" />
                  Request Sent!
                </DialogTitle>
                <DialogDescription>
                  Your placement request has been sent. The creator will review it and get back to
                  you soon.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button onClick={closeModal} data-testid="button-close-success">
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Request Placement</DialogTitle>
                <DialogDescription>
                  {selectedVideo && (
                    <span>
                      Request an ad placement in "{selectedVideo.title}"
                      {selectedVideo.surfaceCount > 0 && (
                        <span className="ml-1">
                          ({selectedVideo.surfaceCount} available surface
                          {selectedVideo.surfaceCount !== 1 ? "s" : ""})
                        </span>
                      )}
                    </span>
                  )}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-foreground">Brand Name *</label>
                  <Input
                    value={formData.brandName}
                    onChange={(e) => setFormData({ ...formData, brandName: e.target.value })}
                    placeholder="Your company name"
                    required
                    data-testid="input-brand-name"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground">Email *</label>
                  <Input
                    type="email"
                    value={formData.brandEmail}
                    onChange={(e) => setFormData({ ...formData, brandEmail: e.target.value })}
                    placeholder="your@email.com"
                    required
                    data-testid="input-brand-email"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground">Message (optional)</label>
                  <Textarea
                    value={formData.message}
                    onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                    placeholder="Tell the creator about your brand and placement needs..."
                    rows={3}
                    data-testid="input-message"
                  />
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={closeModal}
                    data-testid="button-cancel"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={placementMutation.isPending}
                    data-testid="button-submit"
                  >
                    {placementMutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Sending...
                      </>
                    ) : (
                      "Send Request"
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Footer ── */}
      <footer className="border-t mt-16 py-8">
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Powered by{" "}
            <a href="/" className="text-primary font-medium hover:underline">
              FullScale
            </a>
          </p>
          <img src={fullscaleLogo} alt="FullScale" className="h-5 opacity-40" />
        </div>
      </footer>
    </div>
  );
}
