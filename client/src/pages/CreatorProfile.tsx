import { useState } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Play, Eye, Target, CheckCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import fullscaleLogo from "@assets/fullscale-logo_1767679525676.png";

interface CreatorData {
  creator: {
    name: string;
    email: string;
    slug: string;
  };
  videos: {
    id: number;
    title: string;
    thumbnail: string | null;
    platform: string;
    viewCount: number;
    surfaceCount: number;
    surfaces: any[];
  }[];
}

export default function CreatorProfile() {
  const { slug } = useParams<{ slug: string }>();
  const { toast } = useToast();
  const [selectedVideo, setSelectedVideo] = useState<CreatorData["videos"][0] | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
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

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-8">
        <img src={fullscaleLogo} alt="FullScale" className="h-12 mb-8" />
        <h1 className="text-2xl font-bold text-foreground mb-2">Creator Not Found</h1>
        <p className="text-muted-foreground">The creator profile you're looking for doesn't exist.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <img src={fullscaleLogo} alt="FullScale" className="h-8" />
          <Badge variant="secondary" className="text-xs">Creator Profile</Badge>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-12">
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-foreground mb-2" data-testid="text-creator-name">
            {data.creator.name}
          </h1>
          <p className="text-muted-foreground">
            {data.videos.length} video{data.videos.length !== 1 ? "s" : ""} available for brand placements
          </p>
        </div>

        {data.videos.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center">
              <p className="text-muted-foreground">No videos available for placements yet.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {data.videos.map((video) => (
              <Card key={video.id} className="overflow-hidden hover-elevate" data-testid={`card-video-${video.id}`}>
                <div className="relative aspect-video bg-muted">
                  {video.thumbnail ? (
                    <img
                      src={video.thumbnail}
                      alt={video.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Play className="h-12 w-12 text-muted-foreground" />
                    </div>
                  )}
                  <Badge
                    className="absolute top-2 right-2"
                    variant="secondary"
                  >
                    {video.platform}
                  </Badge>
                </div>
                <CardContent className="p-4">
                  <h3 className="font-semibold text-foreground line-clamp-2 mb-3" data-testid={`text-video-title-${video.id}`}>
                    {video.title}
                  </h3>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
                    <span className="flex items-center gap-1">
                      <Eye className="h-4 w-4" />
                      {video.viewCount.toLocaleString()} views
                    </span>
                    <span className="flex items-center gap-1">
                      <Target className="h-4 w-4" />
                      {video.surfaceCount} ad spot{video.surfaceCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <Button
                    className="w-full"
                    onClick={() => {
                      setSelectedVideo(video);
                      setIsModalOpen(true);
                    }}
                    data-testid={`button-request-placement-${video.id}`}
                  >
                    Request Placement
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

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
                  The creator will be in touch with you soon.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button onClick={closeModal} data-testid="button-close-success">Done</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Request Placement</DialogTitle>
                <DialogDescription>
                  {selectedVideo && (
                    <span>Request an ad placement in "{selectedVideo.title}"</span>
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
                  <Button type="button" variant="outline" onClick={closeModal} data-testid="button-cancel">
                    Cancel
                  </Button>
                  <Button type="submit" disabled={placementMutation.isPending} data-testid="button-submit">
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

      <footer className="border-t mt-20 py-8 text-center text-sm text-muted-foreground">
        <p>Powered by <a href="/" className="text-primary hover:underline">FullScale</a></p>
      </footer>
    </div>
  );
}
