/**
 * Brand Clips Browser — the brand-side discovery surface.
 *
 * Shows rendered editorial clips across all creators on the platform. Brands
 * browse, click into a clip to preview it, and request placement on surfaces
 * inside that specific clip. Clip-scoped placement (not source-video-scoped)
 * because clips are the platform-ready narrative units that brands actually
 * care about.
 *
 * Pricing note (no charge during early access): per the current plan, brands
 * can request placements freely. Once we move to paid, this page is where the
 * tier limits/credits would be enforced.
 */
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Search, Sparkles, Clock, Send, Film, Image as ImageIcon } from "lucide-react";
import { BrandPlacementRequestModal } from "@/components/BrandPlacementRequestModal";

interface BrowsableEditorialClip {
  id: number;
  videoId: number;
  userId: string | number;
  clipStart: number;
  clipEnd: number;
  duration: number;
  finalScore: number | null;
  monetizationTier: string | null;
  suggestedTitle: string | null;
  topicTags: string[] | null;
  exportPath: string | null;
  thumbnailPath: string | null;
  aspectRatio: string | null;
  videoTitle: string | null;
  videoThumbnailUrl: string | null;
  creatorUserId: string;
}

export default function BrandClipsBrowser() {
  const [searchQuery, setSearchQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<string | null>(null);
  const [requestingClip, setRequestingClip] = useState<BrowsableEditorialClip | null>(null);

  const { data, isLoading } = useQuery<{ clips: BrowsableEditorialClip[]; count: number }>({
    queryKey: ["/api/brand/clips"],
  });

  const filteredClips = useMemo(() => {
    let clips = data?.clips ?? [];
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      clips = clips.filter(
        (c) =>
          c.suggestedTitle?.toLowerCase().includes(q) ||
          c.videoTitle?.toLowerCase().includes(q) ||
          c.topicTags?.some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (tierFilter) {
      clips = clips.filter((c) => c.monetizationTier === tierFilter);
    }
    return clips;
  }, [data, searchQuery, tierFilter]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const clips = data?.clips ?? [];
  const totalClips = clips.length;

  return (
    <div className="container mx-auto px-4 md:px-6 py-8 max-w-7xl">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-12 h-12 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center">
            <Film className="w-6 h-6 text-purple-400" />
          </div>
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-clips-browser-title">
              Browse Creator Clips
            </h1>
            <p className="text-sm md:text-base text-muted-foreground">
              Auto-generated editorial clips ready for product placement. Pick one, choose a surface, request placement.
            </p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search clips by title, video, or topic..."
            className="pl-9"
            data-testid="input-clip-search"
          />
        </div>
        <div className="flex gap-2">
          {[
            { key: null, label: "All" },
            { key: "premium", label: "Premium" },
            { key: "standard", label: "Standard" },
            { key: "organic", label: "Organic" },
          ].map((tier) => (
            <Button
              key={tier.label}
              variant={tierFilter === tier.key ? "default" : "outline"}
              size="sm"
              onClick={() => setTierFilter(tier.key)}
              data-testid={`button-filter-${tier.label.toLowerCase()}`}
            >
              {tier.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex items-center justify-between mb-4 text-sm text-muted-foreground">
        <span>
          {filteredClips.length} {filteredClips.length === 1 ? "clip" : "clips"}
          {filteredClips.length !== totalClips && ` of ${totalClips}`}
        </span>
        <Badge variant="outline" className="border-emerald-500/40 text-emerald-300">
          <Sparkles className="w-3 h-3 mr-1" />
          Free during early access
        </Badge>
      </div>

      {/* Clips grid */}
      {filteredClips.length === 0 ? (
        <Card className="border-dashed border-border/50">
          <CardContent className="py-16 text-center">
            <Film className="w-12 h-12 mx-auto mb-4 text-muted-foreground/40" />
            <h2 className="text-lg font-semibold mb-2">No clips match your filters</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {totalClips === 0
                ? "No editorial clips have been rendered yet. Once creators upload videos, their auto-generated clips will appear here."
                : "Try a different search term or clear the tier filter."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredClips.map((clip) => (
            <ClipCard
              key={clip.id}
              clip={clip}
              onRequestPlacement={() => setRequestingClip(clip)}
            />
          ))}
        </div>
      )}

      {/* Placement request modal */}
      {requestingClip && (
        <BrandPlacementRequestModal
          editorialClipId={requestingClip.id}
          videoId={requestingClip.videoId}
          videoTitle={requestingClip.videoTitle || "Untitled"}
          videoThumbnailUrl={requestingClip.videoThumbnailUrl}
          clipDuration={requestingClip.duration}
          clipSuggestedTitle={requestingClip.suggestedTitle}
          open={requestingClip !== null}
          onClose={() => setRequestingClip(null)}
        />
      )}
    </div>
  );
}

function ClipCard({
  clip,
  onRequestPlacement,
}: {
  clip: BrowsableEditorialClip;
  onRequestPlacement: () => void;
}) {
  const [previewing, setPreviewing] = useState(false);

  const tierColor: Record<string, string> = {
    premium: "border-amber-500/40 text-amber-300 bg-amber-500/10",
    standard: "border-blue-500/40 text-blue-300 bg-blue-500/10",
    organic: "border-emerald-500/40 text-emerald-300 bg-emerald-500/10",
  };

  return (
    <Card
      className="group overflow-hidden border-border/50 hover:border-purple-500/40 transition-all"
      data-testid={`card-clip-${clip.id}`}
    >
      <div className="relative aspect-[9/16] bg-black overflow-hidden">
        {clip.exportPath && previewing ? (
          <video
            src={clip.exportPath}
            autoPlay
            muted
            loop
            playsInline
            controls={false}
            className="w-full h-full object-cover"
            onMouseLeave={() => setPreviewing(false)}
          />
        ) : clip.thumbnailPath ? (
          <img
            src={clip.thumbnailPath}
            alt={clip.suggestedTitle || "Clip"}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            loading="lazy"
            onMouseEnter={() => setPreviewing(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageIcon className="w-12 h-12 text-muted-foreground/40" />
          </div>
        )}

        {/* Tier badge */}
        {clip.monetizationTier && (
          <div className="absolute top-2 left-2">
            <Badge
              variant="outline"
              className={`text-[10px] uppercase font-semibold ${tierColor[clip.monetizationTier] || ""}`}
            >
              {clip.monetizationTier}
            </Badge>
          </div>
        )}

        {/* Duration */}
        <div className="absolute bottom-2 right-2">
          <Badge variant="outline" className="text-[10px] bg-black/60 border-white/20 text-white">
            <Clock className="w-2.5 h-2.5 mr-1" />
            {clip.duration.toFixed(0)}s
          </Badge>
        </div>

        {/* Score */}
        {clip.finalScore !== null && (
          <div className="absolute top-2 right-2">
            <Badge variant="outline" className="text-[10px] bg-black/60 border-purple-400/40 text-purple-300">
              {(clip.finalScore * 100).toFixed(0)}
            </Badge>
          </div>
        )}
      </div>

      <CardContent className="p-3 space-y-2.5">
        <div>
          <p className="text-xs text-muted-foreground/60 line-clamp-1 mb-0.5">
            From: {clip.videoTitle || "Untitled"}
          </p>
          <p className="text-sm font-medium leading-tight line-clamp-2 min-h-[2.5rem]">
            {clip.suggestedTitle || `Clip ${clip.id}`}
          </p>
        </div>

        {clip.topicTags && clip.topicTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {clip.topicTags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="outline" className="text-[10px] py-0 px-1.5 capitalize">
                {tag}
              </Badge>
            ))}
            {clip.topicTags.length > 3 && (
              <span className="text-[10px] text-muted-foreground">+{clip.topicTags.length - 3}</span>
            )}
          </div>
        )}

        <Button
          onClick={onRequestPlacement}
          className="w-full bg-purple-600 hover:bg-purple-500 text-white"
          size="sm"
          data-testid={`button-request-placement-${clip.id}`}
        >
          <Send className="w-3.5 h-3.5 mr-1.5" />
          Request Placement
        </Button>
      </CardContent>
    </Card>
  );
}
