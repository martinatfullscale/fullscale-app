import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Search, Filter, DollarSign, Tag, Play, 
  ShoppingCart, TrendingUp, Eye, Clock,
  Briefcase, Palette, Monitor, Sparkles
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useHybridMode } from "@/hooks/use-hybrid-mode";
import { apiRequest } from "@/lib/queryClient";

interface MarketplaceOpportunity {
  id: number;
  videoId: number;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  creatorName: string;
  creatorAvatar?: string;
  viewCount: number;
  sceneValue: number;
  context: string;
  genre: string;
  sceneType: string;
  surfaces: string[];
  duration: string;
}

const DUMMY_OPPORTUNITIES: MarketplaceOpportunity[] = [
  {
    id: 1,
    videoId: 101,
    youtubeId: "demo1",
    title: "Ultimate Desk Setup Tour 2025",
    thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    creatorName: "TechVision",
    viewCount: 1250000,
    sceneValue: 85,
    context: "Workspace",
    genre: "Tech",
    sceneType: "Desk",
    surfaces: ["Monitor", "Desk", "Wall"],
    duration: "12:34",
  },
  {
    id: 2,
    videoId: 102,
    youtubeId: "demo2",
    title: "Morning Routine That Changed My Life",
    thumbnailUrl: "https://i.ytimg.com/vi/jNQXAC9IVRw/maxresdefault.jpg",
    creatorName: "LifestyleMax",
    viewCount: 890000,
    sceneValue: 65,
    context: "Lifestyle",
    genre: "Lifestyle",
    sceneType: "Interior",
    surfaces: ["Table", "Shelf", "Counter"],
    duration: "8:45",
  },
  {
    id: 3,
    videoId: 103,
    youtubeId: "demo3",
    title: "Building My Dream Gaming Setup",
    thumbnailUrl: "https://i.ytimg.com/vi/9bZkp7q19f0/maxresdefault.jpg",
    creatorName: "GamerzHQ",
    viewCount: 2100000,
    sceneValue: 120,
    context: "Gaming",
    genre: "Gaming",
    sceneType: "Desk",
    surfaces: ["Monitor", "Desk", "RGB Wall"],
    duration: "15:22",
  },
  {
    id: 4,
    videoId: 104,
    youtubeId: "demo4",
    title: "Home Office Makeover on a Budget",
    thumbnailUrl: "https://i.ytimg.com/vi/kJQP7kiw5Fk/maxresdefault.jpg",
    creatorName: "DIYCreative",
    viewCount: 675000,
    sceneValue: 55,
    context: "Office",
    genre: "DIY",
    sceneType: "Wall",
    surfaces: ["Wall", "Desk", "Bookshelf"],
    duration: "10:15",
  },
  {
    id: 5,
    videoId: 105,
    youtubeId: "demo5",
    title: "Unboxing the Latest Tech Gadgets",
    thumbnailUrl: "https://i.ytimg.com/vi/RgKAFK5djSk/maxresdefault.jpg",
    creatorName: "UnboxDaily",
    viewCount: 1450000,
    sceneValue: 95,
    context: "Product",
    genre: "Tech",
    sceneType: "Product",
    surfaces: ["Table", "Product", "Hands"],
    duration: "18:30",
  },
  {
    id: 6,
    videoId: 106,
    youtubeId: "demo6",
    title: "Cozy Reading Nook Setup",
    thumbnailUrl: "https://i.ytimg.com/vi/fJ9rUzIMcZQ/maxresdefault.jpg",
    creatorName: "BookishVibes",
    viewCount: 320000,
    sceneValue: 45,
    context: "Interior",
    genre: "Lifestyle",
    sceneType: "Interior",
    surfaces: ["Chair", "Bookshelf", "Lamp"],
    duration: "7:20",
  },
  {
    id: 7,
    videoId: 107,
    youtubeId: "demo7",
    title: "Pro Streaming Setup Breakdown",
    thumbnailUrl: "https://i.ytimg.com/vi/CevxZvSJLk8/maxresdefault.jpg",
    creatorName: "StreamerPro",
    viewCount: 980000,
    sceneValue: 110,
    context: "Workspace",
    genre: "Gaming",
    sceneType: "Desk",
    surfaces: ["Monitor", "Microphone", "Camera"],
    duration: "14:55",
  },
  {
    id: 8,
    videoId: 108,
    youtubeId: "demo8",
    title: "Minimalist Apartment Tour",
    thumbnailUrl: "https://i.ytimg.com/vi/OPf0YbXqDm0/maxresdefault.jpg",
    creatorName: "MinimalLiving",
    viewCount: 540000,
    sceneValue: 70,
    context: "Interior",
    genre: "Lifestyle",
    sceneType: "Interior",
    surfaces: ["Wall", "Furniture", "Decor"],
    duration: "11:40",
  },
];

const GENRES = ["All", "Tech", "Gaming", "Lifestyle", "DIY", "Education"];
const BUDGETS = ["All", "Under $50", "$50-$100", "$100-$200", "Over $200"];
const SCENE_TYPES = ["All", "Desk", "Wall", "Interior", "Product"];

interface DiscoveryResponse {
  opportunities: MarketplaceOpportunity[];
  total: number;
}

export default function BrandMarketplace() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { googleUser } = useHybridMode();
  
  const [searchQuery, setSearchQuery] = useState("");
  const [genreFilter, setGenreFilter] = useState("All");
  const [budgetFilter, setBudgetFilter] = useState("All");
  const [sceneTypeFilter, setSceneTypeFilter] = useState("All");
  const [buyingId, setBuyingId] = useState<number | null>(null);

  // Unified query: use auth endpoint when authenticated, demo endpoint otherwise
  const isAuthenticated = !!googleUser;
  const endpoint = isAuthenticated ? "/api/brand/discovery" : "/api/demo/brand-discovery";
  const queryMode = isAuthenticated ? "auth" : "demo";
  
  const { data: discoveryData, isLoading: isLoadingOpportunities } = useQuery<DiscoveryResponse>({
    queryKey: ["opportunities", queryMode],
    queryFn: async () => {
      console.log(`[BrandMarketplace] Fetching opportunities from ${endpoint} (mode: ${queryMode})`);
      const res = await fetch(endpoint, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch opportunities");
      const data = await res.json();
      console.log(`[BrandMarketplace] Response structure:`, {
        hasOpportunities: !!data.opportunities,
        hasData: !!data.data,
        opportunitiesCount: data.opportunities?.length || 0,
        dataCount: data.data?.length || 0,
        total: data.total,
        keys: Object.keys(data),
      });
      console.log(`[BrandMarketplace] First opportunity sample:`, data.opportunities?.[0] || data.data?.[0] || null);
      return data;
    },
    retry: 2,
    staleTime: 0,
  });

  const buyMutation = useMutation({
    mutationFn: async (opportunity: MarketplaceOpportunity) => {
      const res = await apiRequest("POST", "/api/marketplace/buy", {
        videoId: opportunity.videoId,
        title: opportunity.title,
        thumbnailUrl: opportunity.thumbnailUrl,
        bidAmount: opportunity.sceneValue,
        sceneType: opportunity.sceneType,
        genre: opportunity.genre,
        brandEmail: googleUser?.email || "demo@brand.com",
        brandName: googleUser?.name || "Demo Brand",
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Bid Placed Successfully",
        description: "The creator will be notified of your interest.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/marketplace"] });
      setBuyingId(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Place Bid",
        description: error.message,
        variant: "destructive",
      });
      setBuyingId(null);
    },
  });

  // Unified opportunity data - comes from either auth or demo endpoint based on mode
  const allOpportunities: MarketplaceOpportunity[] = discoveryData?.opportunities || [];
  
  // Debug logging
  console.log("[BrandMarketplace] mode:", queryMode, "opportunities.length:", allOpportunities.length, "isLoading:", isLoadingOpportunities);

  const filteredOpportunities = allOpportunities.filter((opp: MarketplaceOpportunity) => {
    const matchesSearch = opp.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      opp.creatorName.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesGenre = genreFilter === "All" || opp.genre === genreFilter;
    const matchesSceneType = sceneTypeFilter === "All" || opp.sceneType === sceneTypeFilter;
    
    let matchesBudget = true;
    if (budgetFilter === "Under $50") matchesBudget = opp.sceneValue < 50;
    else if (budgetFilter === "$50-$100") matchesBudget = opp.sceneValue >= 50 && opp.sceneValue <= 100;
    else if (budgetFilter === "$100-$200") matchesBudget = opp.sceneValue > 100 && opp.sceneValue <= 200;
    else if (budgetFilter === "Over $200") matchesBudget = opp.sceneValue > 200;
    
    return matchesSearch && matchesGenre && matchesBudget && matchesSceneType;
  });

  const formatViewCount = (count: number) => {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(0)}K`;
    return count.toString();
  };

  const handleBuy = (opportunity: MarketplaceOpportunity) => {
    setBuyingId(opportunity.id);
    buyMutation.mutate(opportunity);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-50 bg-background/95 backdrop-blur-sm border-b">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center">
                <Briefcase className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h1 className="text-xl font-bold">Brand Marketplace</h1>
                <p className="text-xs text-muted-foreground">Discover premium ad placement opportunities</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="gap-1">
                <Sparkles className="w-3 h-3" />
                {filteredOpportunities.length} Opportunities
              </Badge>
              <Badge className="bg-blue-500/20 text-blue-400" data-testid="badge-showing-count">
                Showing {allOpportunities.length} items
              </Badge>
            </div>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search videos or creators..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="input-search"
              />
            </div>
            
            <Select value={genreFilter} onValueChange={setGenreFilter}>
              <SelectTrigger className="w-[140px]" data-testid="select-genre">
                <Tag className="w-4 h-4 mr-2" />
                <SelectValue placeholder="Genre" />
              </SelectTrigger>
              <SelectContent>
                {GENRES.map((genre) => (
                  <SelectItem key={genre} value={genre}>{genre}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            <Select value={budgetFilter} onValueChange={setBudgetFilter}>
              <SelectTrigger className="w-[140px]" data-testid="select-budget">
                <DollarSign className="w-4 h-4 mr-2" />
                <SelectValue placeholder="Budget" />
              </SelectTrigger>
              <SelectContent>
                {BUDGETS.map((budget) => (
                  <SelectItem key={budget} value={budget}>{budget}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            <Select value={sceneTypeFilter} onValueChange={setSceneTypeFilter}>
              <SelectTrigger className="w-[140px]" data-testid="select-scene-type">
                <Monitor className="w-4 h-4 mr-2" />
                <SelectValue placeholder="Scene Type" />
              </SelectTrigger>
              <SelectContent>
                {SCENE_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>{type}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          <AnimatePresence mode="popLayout">
            {filteredOpportunities.map((opportunity, idx) => (
              <motion.div
                key={opportunity.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ delay: idx * 0.05 }}
              >
                <Card className="group overflow-visible hover-elevate cursor-pointer" data-testid={`card-opportunity-${opportunity.id}`}>
                  <div className="aspect-video relative overflow-hidden rounded-t-md">
                    <img
                      src={opportunity.thumbnailUrl}
                      alt={opportunity.title}
                      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${opportunity.id}/640/360`;
                      }}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                    
                    <div className="absolute top-2 left-2 flex items-center gap-1.5">
                      <Badge className="bg-emerald-500/90 text-white border-0 gap-1">
                        <DollarSign className="w-3 h-3" />
                        {opportunity.sceneValue}
                      </Badge>
                    </div>
                    
                    <div className="absolute top-2 right-2">
                      <Badge variant="secondary" className="gap-1">
                        <Eye className="w-3 h-3" />
                        {formatViewCount(opportunity.viewCount)}
                      </Badge>
                    </div>
                    
                    <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-2">
                      <Badge variant="outline" className="bg-black/50 backdrop-blur-sm border-white/20 text-white">
                        {opportunity.context}
                      </Badge>
                      <span className="text-xs text-white/80 bg-black/50 px-1.5 py-0.5 rounded">
                        {opportunity.duration}
                      </span>
                    </div>
                  </div>
                  
                  <CardContent className="p-3">
                    <h3 className="font-medium text-sm line-clamp-2 mb-2" data-testid={`text-title-${opportunity.id}`}>
                      {opportunity.title}
                    </h3>
                    
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <span className="text-xs text-muted-foreground">by {opportunity.creatorName}</span>
                      <Badge variant="outline" className="text-xs">
                        {opportunity.genre}
                      </Badge>
                    </div>
                    
                    <div className="flex flex-wrap gap-1 mb-3">
                      {opportunity.surfaces.slice(0, 3).map((surface) => (
                        <Badge key={surface} variant="secondary" className="text-xs">
                          {surface}
                        </Badge>
                      ))}
                    </div>
                    
                    <Button
                      className="w-full gap-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleBuy(opportunity);
                      }}
                      disabled={buyingId === opportunity.id}
                      data-testid={`button-buy-${opportunity.id}`}
                    >
                      {buyingId === opportunity.id ? (
                        <>Processing...</>
                      ) : (
                        <>
                          <ShoppingCart className="w-4 h-4" />
                          Buy ${opportunity.sceneValue}
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        
        {filteredOpportunities.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Filter className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No opportunities found</h3>
            <p className="text-sm text-muted-foreground">Try adjusting your filters or search query</p>
          </div>
        )}
      </div>
    </div>
  );
}
