import { useState } from "react";
import { TopBar } from "@/components/TopBar";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { useHybridMode } from "@/hooks/use-hybrid-mode";
import { usePitchMode } from "@/contexts/pitch-mode-context";
import {
  Briefcase,
  DollarSign,
  TrendingUp,
  Monitor,
  Laptop,
  Coffee,
  Video,
  Eye,
  Loader2,
  Sparkles,
  X as XIcon,
  Package,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { MonetizationItem } from "@shared/schema";

interface VideoOpportunity {
  id: number;
  title: string;
  thumbnailUrl: string | null;
  viewCount: number;
  surfaceCount: number;
  contexts: string[];
  status: string;
}

interface MarketplaceResponse {
  opportunities: VideoOpportunity[];
  total: number;
  totalSurfaces: number;
}

// Brand color styles - generate from brand name hash
const BRAND_COLORS = [
  "bg-violet-500", "bg-cyan-500", "bg-pink-500", "bg-emerald-600",
  "bg-blue-600", "bg-teal-500", "bg-sky-400", "bg-amber-400",
  "bg-indigo-500", "bg-rose-500", "bg-purple-500", "bg-green-500",
  "bg-slate-500", "bg-fuchsia-500", "bg-yellow-500", "bg-orange-500"
];

function getBrandColor(brandName: string): string {
  let hash = 0;
  for (let i = 0; i < brandName.length; i++) {
    hash = brandName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return BRAND_COLORS[Math.abs(hash) % BRAND_COLORS.length];
}

function getStatusStyle(status: string): { statusColor: string; displayStatus: string } {
  const normalized = status.toLowerCase();
  if (normalized === "active") {
    return { statusColor: "bg-emerald-500/20 text-emerald-400", displayStatus: "Active" };
  } else if (normalized === "recruiting") {
    return { statusColor: "bg-blue-500/20 text-blue-400", displayStatus: "Recruiting" };
  } else if (normalized === "urgent") {
    return { statusColor: "bg-red-500/20 text-red-400", displayStatus: "Urgent" };
  }
  return { statusColor: "bg-gray-500/20 text-gray-400", displayStatus: status };
}

function getCategoryFromGenre(genre: string | null): string {
  if (!genre) return "General";
  const normalized = genre.toLowerCase();
  if (normalized.includes("tech") || normalized.includes("saas")) return "Tech/SaaS";
  if (normalized.includes("finance")) return "Finance";
  if (normalized.includes("lifestyle")) return "Lifestyle";
  if (normalized.includes("productivity")) return "Productivity";
  return genre;
}


const demoOpportunities: VideoOpportunity[] = [
  {
    id: 1,
    title: "My Ultimate Desk Setup 2025",
    thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    viewCount: 245000,
    surfaceCount: 8,
    contexts: ["Workspace", "Interior"],
    status: "Ready (8 Spots)"
  },
  {
    id: 2,
    title: "Day in the Life of a Content Creator",
    thumbnailUrl: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
    viewCount: 128000,
    surfaceCount: 5,
    contexts: ["Lifestyle", "Workspace"],
    status: "Ready (5 Spots)"
  },
  {
    id: 3,
    title: "Studio Tour - Behind the Scenes",
    thumbnailUrl: "https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg",
    viewCount: 89000,
    surfaceCount: 12,
    contexts: ["Workspace", "Product Placement"],
    status: "Ready (12 Spots)"
  },
];

function getContextIcon(context: string) {
  switch (context.toLowerCase()) {
    case "workspace":
      return <Laptop className="w-3 h-3" />;
    case "lifestyle":
      return <Coffee className="w-3 h-3" />;
    case "office":
      return <Briefcase className="w-3 h-3" />;
    case "interior":
      return <Monitor className="w-3 h-3" />;
    default:
      return <Video className="w-3 h-3" />;
  }
}

function formatViews(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M views`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(0)}K views`;
  }
  return `${count} views`;
}

export default function Opportunities() {
  const { mode } = useHybridMode();
  const { isPitchMode } = usePitchMode();
  const isRealMode = mode === "real" && !isPitchMode;

  const { data, isLoading } = useQuery<MarketplaceResponse>({
    queryKey: ["/api/marketplace/opportunities"],
    enabled: isRealMode,
  });

  const { data: dbCampaigns, isLoading: campaignsLoading } = useQuery<MonetizationItem[]>({
    queryKey: ["/api/monetization/items"],
  });

  const [selectedOffer, setSelectedOffer] = useState<any | null>(null);

  const brandOffers = (dbCampaigns || []).map((item) => {
    const { statusColor, displayStatus } = getStatusStyle(item.status);
    return {
      bidId: item.id,
      videoId: item.videoId,
      brand: item.brandName || "Unknown Brand",
      brandColor: getBrandColor(item.brandName || "Unknown"),
      campaign: item.title,
      targetSurfaces: item.sceneType ? [item.sceneType] : ["Various"],
      bidAmount: item.bidAmount ? `$${Number(item.bidAmount).toLocaleString()}` : "$0",
      rawBidAmount: item.bidAmount,
      status: displayStatus,
      rawStatus: item.status,
      statusColor,
      description: `${item.brandName} is looking for creators in the ${item.genre || "general"} space`,
      category: getCategoryFromGenre(item.genre || null),
      sceneType: item.sceneType,
      genre: item.genre,
      thumbnailUrl: item.thumbnailUrl,
      reviewNote: (item as any).reviewNote || null,
    };
  });

  const opportunities = isRealMode ? (data?.opportunities || []) : demoOpportunities;
  const totalSurfaces = isRealMode ? (data?.totalSurfaces || 0) : 25;

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <TopBar />

      <main className="p-8">
        <div className="max-w-7xl mx-auto">
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8"
          >
            <div className="flex items-center gap-3 mb-2">
              <Sparkles className="w-8 h-8 text-primary" />
              <h1 className="text-3xl font-bold font-display" data-testid="text-opportunities-title">
                Opportunities Hub
              </h1>
            </div>
            <p className="text-muted-foreground">
              Videos open for business - connect with brands looking for product placement
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="grid grid-cols-3 gap-4 mb-8"
          >
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <Video className="w-4 h-4 text-primary" />
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Open Inventory</p>
              </div>
              <p className="text-3xl font-bold text-white" data-testid="text-inventory-count">
                {opportunities.length}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Videos with opportunities</p>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <Eye className="w-4 h-4 text-blue-400" />
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Surfaces</p>
              </div>
              <p className="text-3xl font-bold text-white" data-testid="text-surfaces-count">
                {totalSurfaces}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Ad placement spots</p>
            </Card>
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Active Bids</p>
              </div>
              <p className="text-3xl font-bold text-emerald-400" data-testid="text-bids-count">
                {brandOffers.length}
              </p>
              <p className="text-xs text-muted-foreground mt-1">From brand partners</p>
            </Card>
          </motion.div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="lg:col-span-2"
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Your Open Inventory</h2>
                <Badge variant="secondary" className="text-xs">
                  {opportunities.length} videos
                </Badge>
              </div>

              {isLoading && isRealMode ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="w-8 h-8 text-primary animate-spin" />
                </div>
              ) : opportunities.length === 0 ? (
                <Card className="p-12 text-center">
                  <Video className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No Opportunities Yet</h3>
                  <p className="text-muted-foreground mb-4">
                    Scan your videos in the Library to detect ad placement surfaces
                  </p>
                  <Button variant="default" onClick={() => window.location.href = '/library'}>
                    Go to Library
                  </Button>
                </Card>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {opportunities.map((video, idx) => (
                    <motion.div
                      key={video.id}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.1 + idx * 0.05 }}
                    >
                      <Card 
                        className="overflow-hidden hover-elevate cursor-pointer"
                        data-testid={`card-opportunity-${video.id}`}
                      >
                        <div className="aspect-video relative">
                          <img 
                            src={video.thumbnailUrl || 'https://via.placeholder.com/320x180'} 
                            alt={video.title}
                            className="w-full h-full object-cover"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                          <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
                            <div className="flex gap-1 flex-wrap">
                              {video.contexts.map((context, i) => (
                                <Badge 
                                  key={i} 
                                  variant="secondary" 
                                  className="text-[10px] gap-1 bg-black/50 backdrop-blur-sm"
                                >
                                  {getContextIcon(context)}
                                  {context}
                                </Badge>
                              ))}
                            </div>
                            <Badge className="bg-emerald-500/80 text-white text-[10px]">
                              {video.surfaceCount} spots
                            </Badge>
                          </div>
                        </div>
                        <div className="p-4">
                          <h3 className="font-semibold text-white mb-1 truncate">{video.title}</h3>
                          <p className="text-sm text-muted-foreground">{formatViews(video.viewCount)}</p>
                        </div>
                      </Card>
                    </motion.div>
                  ))}
                </div>
              )}
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              className="lg:col-span-1"
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Live Offers</h2>
                <Badge variant="outline" className="text-xs border-emerald-500/50 text-emerald-400">
                  {brandOffers.length} active
                </Badge>
              </div>

              <div className="space-y-4 max-h-[calc(100vh-280px)] overflow-y-auto pr-2">
                {brandOffers.map((offer, idx) => (
                  <Card 
                    key={idx} 
                    className="p-4 hover-elevate cursor-pointer"
                    data-testid={`card-offer-${idx}`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${offer.brandColor || 'bg-white/10'}`}>
                          <span className="text-white font-bold text-sm">{offer.brand.charAt(0)}</span>
                        </div>
                        <div>
                          <h3 className="font-semibold text-white">{offer.brand}</h3>
                          <p className="text-xs text-muted-foreground">{offer.campaign}</p>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1 items-end">
                        <Badge className={offer.statusColor + " text-[10px]"}>
                          {offer.status}
                        </Badge>
                        <Badge variant="outline" className="text-[9px] text-muted-foreground">
                          {offer.category}
                        </Badge>
                      </div>
                    </div>
                    
                    <p className="text-sm text-muted-foreground mb-3">{offer.description}</p>
                    
                    <div className="flex flex-wrap gap-1 mb-3">
                      {offer.targetSurfaces.map((surface, i) => (
                        <Badge key={i} variant="outline" className="text-[10px]">
                          {surface}
                        </Badge>
                      ))}
                    </div>
                    
                    <div className="flex items-center justify-between pt-3 border-t border-white/5">
                      <div className="flex items-center gap-1 text-emerald-400">
                        <DollarSign className="w-4 h-4" />
                        <span className="font-bold">{offer.bidAmount}</span>
                      </div>
                      <Button
                        size="sm"
                        variant="default"
                        className="gap-1"
                        onClick={() => setSelectedOffer(offer)}
                      >
                        View Offer
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </motion.div>
          </div>
        </div>
      </main>

      {/* ── Offer Detail Dialog ── */}
      {selectedOffer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-card border border-border rounded-xl shadow-2xl p-6 w-[420px] max-w-[90vw]"
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-foreground">Brand Offer</h3>
              <button
                onClick={() => setSelectedOffer(null)}
                className="p-1 rounded hover:bg-muted transition-colors"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>

            {/* Brand info */}
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${selectedOffer.brandColor}`}>
                <span className="text-white font-bold text-lg">{selectedOffer.brand.charAt(0)}</span>
              </div>
              <div>
                <h4 className="font-semibold text-white">{selectedOffer.brand}</h4>
                <p className="text-sm text-muted-foreground">{selectedOffer.campaign}</p>
              </div>
            </div>

            {/* Offer details */}
            <div className="space-y-3 mb-5">
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <span className="text-sm text-muted-foreground">Bid Amount</span>
                <span className="text-lg font-bold text-emerald-400">{selectedOffer.bidAmount}</span>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <span className="text-sm text-muted-foreground">Target Surface</span>
                <Badge variant="outline">{selectedOffer.sceneType || "Any"}</Badge>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <span className="text-sm text-muted-foreground">Category</span>
                <Badge variant="secondary">{selectedOffer.category}</Badge>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <span className="text-sm text-muted-foreground">Status</span>
                <Badge className={selectedOffer.statusColor}>{selectedOffer.status}</Badge>
              </div>
            </div>

            {/* Thumbnail preview if available */}
            {selectedOffer.thumbnailUrl && (
              <div className="mb-5 rounded-lg overflow-hidden border border-border">
                <img
                  src={selectedOffer.thumbnailUrl}
                  alt="Video thumbnail"
                  className="w-full h-32 object-cover"
                />
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              {selectedOffer.videoId && (selectedOffer.rawStatus === "pending" || selectedOffer.rawStatus === "revision_requested") && (
                <Button
                  className="flex-1 gap-2"
                  onClick={() => {
                    window.location.href = `/remix/${selectedOffer.videoId}?bidId=${selectedOffer.bidId}&from=opportunities`;
                  }}
                >
                  <Package className="w-4 h-4" />
                  Place Product
                </Button>
              )}
              {selectedOffer.rawStatus === "placed" && (
                <div className="flex-1 text-center py-2.5 rounded-lg bg-blue-500/10 text-blue-400 text-sm font-medium">
                  Awaiting brand review
                </div>
              )}
              {selectedOffer.rawStatus === "accepted" && (
                <div className="flex-1 text-center py-2.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm font-medium">
                  Approved by brand
                </div>
              )}
              <Button
                variant="outline"
                onClick={() => setSelectedOffer(null)}
              >
                Close
              </Button>
            </div>

            {/* Revision note */}
            {selectedOffer.rawStatus === "revision_requested" && (
              <div className="mt-4 p-3 bg-orange-500/10 border border-orange-500/20 rounded-lg">
                <p className="text-xs text-orange-400 font-medium mb-1">Brand requested changes:</p>
                <p className="text-sm text-orange-300">{selectedOffer.reviewNote || "No specific note provided"}</p>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </div>
  );
}
