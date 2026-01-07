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
  Sparkles
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SiSony, SiNike, SiSquarespace } from "react-icons/si";

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

const brandOffers = [
  {
    brand: "Sony",
    icon: SiSony,
    campaign: "Alpha Creator Series",
    targetSurfaces: ["Desk", "Monitor", "Laptop"],
    bidAmount: "$2,400",
    status: "Active",
    statusColor: "bg-emerald-500/20 text-emerald-400",
    description: "Looking for tech workspace setups for camera placement"
  },
  {
    brand: "Nike",
    icon: SiNike,
    campaign: "Just Do It 2025",
    targetSurfaces: ["Wall", "Shelf", "Table"],
    bidAmount: "$1,800",
    status: "New",
    statusColor: "bg-blue-500/20 text-blue-400",
    description: "Lifestyle content with visible shoe displays or athletic gear"
  },
  {
    brand: "Squarespace",
    icon: SiSquarespace,
    campaign: "Build Your Presence",
    targetSurfaces: ["Monitor", "Laptop", "Desk"],
    bidAmount: "$1,200",
    status: "Hot",
    statusColor: "bg-orange-500/20 text-orange-400",
    description: "Tech tutorials showing website creation workflows"
  },
];

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

              <div className="space-y-4">
                {brandOffers.map((offer, idx) => (
                  <Card 
                    key={idx} 
                    className="p-4 hover-elevate cursor-pointer"
                    data-testid={`card-offer-${idx}`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center">
                          <offer.icon className="w-5 h-5 text-white" />
                        </div>
                        <div>
                          <h3 className="font-semibold text-white">{offer.brand}</h3>
                          <p className="text-xs text-muted-foreground">{offer.campaign}</p>
                        </div>
                      </div>
                      <Badge className={offer.statusColor + " text-[10px]"}>
                        {offer.status}
                      </Badge>
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
                      <Button size="sm" variant="default" className="gap-1">
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
    </div>
  );
}
