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
} from "lucide-react";
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
  platform: string;
  viewCount: number;
  surfaceCount: number;
  surfaceTypes: string[];
  surfaces: Surface[];
  category: string | null;
  duration: number | null;
}

interface CreatorData {
  creator: {
    name: string;
    email: string;
    slug: string;
    profileImage: string | null;
    bio: string | null;
    userType: string;
  };
  stats: {
    totalVideos: number;
    totalViews: number;
    totalSurfaces: number;
    surfaceTypes: string[];
    categories: string[];
  };
  videos: VideoData[];
}

function formatNumber(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return num.toLocaleString();
}

function getInitials(name: string): string {
  return name
    .split(" ")
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

  const { creator, stats, videos } = data;

  return (
    <div className="min-h-screen bg-background">
      {/* ── Sticky header ── */}
      <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <img src={fullscaleLogo} alt="FullScale" className="h-7" />
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
              <div className="flex items-center gap-3 mb-2">
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
              {creator.bio ? (
                <p className="text-muted-foreground text-lg max-w-2xl">{creator.bio}</p>
              ) : (
                <p className="text-muted-foreground text-lg">
                  Content creator with {stats.totalVideos} video
                  {stats.totalVideos !== 1 ? "s" : ""} available for brand placements
                </p>
              )}
            </div>

            {/* CTA */}
            {videos.length > 0 && (
              <Button
                size="lg"
                className="hidden md:flex gap-2"
                onClick={() => {
                  const el = document.getElementById("video-portfolio");
                  el?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                Browse Videos
                <ArrowRight className="h-4 w-4" />
              </Button>
            )}
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {videos.map((video) => (
              <Card
                key={video.id}
                className="overflow-hidden group border border-border/50 hover:border-primary/30 transition-all duration-300 hover:shadow-lg"
                data-testid={`card-video-${video.id}`}
              >
                {/* Thumbnail */}
                <div className="relative aspect-video bg-muted overflow-hidden">
                  {video.thumbnail ? (
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
