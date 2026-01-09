import { useState, useEffect } from "react";
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useHybridMode } from "@/hooks/use-hybrid-mode";
import { usePitchMode } from "@/contexts/pitch-mode-context";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";

const SUPER_ADMIN_EMAIL = "martin@gofullscale.co";

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

// Static demo opportunities for pitch mode - 20 items, loaded synchronously
const STATIC_DEMO_OPPORTUNITIES: MarketplaceOpportunity[] = [
  { id: 1, videoId: 101, youtubeId: "demo1", title: "Ultimate Desk Setup Tour 2025", thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", creatorName: "TechVision", viewCount: 1250000, sceneValue: 85, context: "Workspace", genre: "Tech", sceneType: "Desk", surfaces: ["Monitor", "Desk", "Wall"], duration: "12:34" },
  { id: 2, videoId: 102, youtubeId: "demo2", title: "Morning Routine That Changed My Life", thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", creatorName: "LifestyleMax", viewCount: 890000, sceneValue: 65, context: "Lifestyle", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Table", "Shelf", "Counter"], duration: "8:45" },
  { id: 3, videoId: 103, youtubeId: "demo3", title: "Building My Dream Gaming Setup", thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", creatorName: "GamerzHQ", viewCount: 2100000, sceneValue: 120, context: "Gaming", genre: "Gaming", sceneType: "Desk", surfaces: ["Monitor", "Desk", "RGB Wall"], duration: "15:22" },
  { id: 4, videoId: 104, youtubeId: "demo4", title: "Home Office Makeover on a Budget", thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", creatorName: "DIYCreative", viewCount: 675000, sceneValue: 55, context: "Office", genre: "DIY", sceneType: "Wall", surfaces: ["Wall", "Desk", "Bookshelf"], duration: "10:15" },
  { id: 5, videoId: 105, youtubeId: "demo5", title: "Unboxing the Latest Tech Gadgets", thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", creatorName: "UnboxDaily", viewCount: 1450000, sceneValue: 95, context: "Product", genre: "Tech", sceneType: "Product", surfaces: ["Table", "Product", "Hands"], duration: "18:30" },
  { id: 6, videoId: 106, youtubeId: "demo6", title: "Cozy Reading Nook Setup", thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", creatorName: "BookishVibes", viewCount: 320000, sceneValue: 45, context: "Interior", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Chair", "Bookshelf", "Lamp"], duration: "7:20" },
  { id: 7, videoId: 107, youtubeId: "demo7", title: "Pro Streaming Setup Breakdown", thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", creatorName: "StreamerPro", viewCount: 980000, sceneValue: 110, context: "Workspace", genre: "Gaming", sceneType: "Desk", surfaces: ["Monitor", "Microphone", "Camera"], duration: "14:55" },
  { id: 8, videoId: 108, youtubeId: "demo8", title: "Minimalist Apartment Tour", thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", creatorName: "MinimalLiving", viewCount: 540000, sceneValue: 70, context: "Interior", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Wall", "Furniture", "Decor"], duration: "11:40" },
  { id: 9, videoId: 109, youtubeId: "demo9", title: "MacBook Pro M5 Full Review", thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", creatorName: "TechReviews", viewCount: 1850000, sceneValue: 150, context: "Product", genre: "Tech", sceneType: "Product", surfaces: ["Laptop", "Desk", "Screen"], duration: "22:15" },
  { id: 10, videoId: 110, youtubeId: "demo10", title: "Studio Lighting Guide for Creators", thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", creatorName: "CreatorAcademy", viewCount: 445000, sceneValue: 75, context: "Education", genre: "Education", sceneType: "Interior", surfaces: ["Lights", "Wall", "Equipment"], duration: "16:30" },
  { id: 11, videoId: 111, youtubeId: "demo11", title: "iPhone 17 vs Samsung Galaxy S26", thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", creatorName: "PhoneArena", viewCount: 2300000, sceneValue: 180, context: "Comparison", genre: "Tech", sceneType: "Product", surfaces: ["Phones", "Table", "Hands"], duration: "25:40" },
  { id: 12, videoId: 112, youtubeId: "demo12", title: "Budget Gaming PC Build 2026", thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", creatorName: "PCBuilder", viewCount: 1120000, sceneValue: 135, context: "Build", genre: "Gaming", sceneType: "Desk", surfaces: ["Components", "Desk", "Tools"], duration: "28:55" },
  { id: 13, videoId: 113, youtubeId: "demo13", title: "Work From Home Productivity Tips", thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", creatorName: "ProductivityPro", viewCount: 678000, sceneValue: 60, context: "Workspace", genre: "Education", sceneType: "Desk", surfaces: ["Monitor", "Desk", "Accessories"], duration: "14:20" },
  { id: 14, videoId: 114, youtubeId: "demo14", title: "DIY Smart Home Setup Under $500", thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", creatorName: "SmartHomeDIY", viewCount: 890000, sceneValue: 95, context: "Smart Home", genre: "DIY", sceneType: "Interior", surfaces: ["Devices", "Wall", "Hub"], duration: "19:45" },
  { id: 15, videoId: 115, youtubeId: "demo15", title: "Aesthetic Room Makeover 2026", thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", creatorName: "RoomInspo", viewCount: 1560000, sceneValue: 125, context: "Interior", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Furniture", "Decor", "Lighting"], duration: "17:30" },
  { id: 16, videoId: 116, youtubeId: "demo16", title: "Mechanical Keyboard Sound Test", thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", creatorName: "KeyboardEnthusiast", viewCount: 720000, sceneValue: 80, context: "ASMR", genre: "Tech", sceneType: "Product", surfaces: ["Keyboard", "Desk", "Switches"], duration: "12:10" },
  { id: 17, videoId: 117, youtubeId: "demo17", title: "Cable Management Masterclass", thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", creatorName: "CleanSetup", viewCount: 456000, sceneValue: 55, context: "Tutorial", genre: "DIY", sceneType: "Desk", surfaces: ["Cables", "Desk", "Accessories"], duration: "11:25" },
  { id: 18, videoId: 118, youtubeId: "demo18", title: "Best Monitors for Content Creation", thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", creatorName: "DisplayMasters", viewCount: 934000, sceneValue: 110, context: "Comparison", genre: "Tech", sceneType: "Product", surfaces: ["Monitors", "Desk", "Wall"], duration: "21:50" },
  { id: 19, videoId: 119, youtubeId: "demo19", title: "Day in the Life: Content Creator", thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", creatorName: "CreatorLife", viewCount: 1340000, sceneValue: 90, context: "Vlog", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Camera", "Room", "Equipment"], duration: "15:40" },
  { id: 20, videoId: 120, youtubeId: "demo20", title: "Ultimate Webcam Comparison 2026", thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", creatorName: "WebcamReview", viewCount: 567000, sceneValue: 70, context: "Comparison", genre: "Tech", sceneType: "Product", surfaces: ["Webcams", "Desk", "Screen"], duration: "18:20" },
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
  const { googleUser, mode } = useHybridMode();
  const { isPitchMode, setPitchMode } = usePitchMode();
  const { user } = useAuth();
  
  // Super admin check for pitch mode toggle
  const currentUserEmail = googleUser?.email || user?.email || "";
  const isSuperAdmin = currentUserEmail.toLowerCase() === SUPER_ADMIN_EMAIL;
  
  const [searchQuery, setSearchQuery] = useState("");
  const [genreFilter, setGenreFilter] = useState("All");
  const [budgetFilter, setBudgetFilter] = useState("All");
  const [sceneTypeFilter, setSceneTypeFilter] = useState("All");
  const [buyingId, setBuyingId] = useState<number | null>(null);

  // PRIORITY: isPitchMode toggle is checked FIRST - overrides authentication state
  const isAuthenticated = !!googleUser;

  // When pitch mode changes, immediately update the data (no API delay)
  useEffect(() => {
    console.log(`[BrandMarketplace] isPitchMode changed to: ${isPitchMode}`);
    if (isPitchMode) {
      // Immediately set demo opportunities in cache - no async wait needed
      queryClient.setQueryData(["opportunities", true, isAuthenticated], {
        opportunities: STATIC_DEMO_OPPORTUNITIES,
        total: STATIC_DEMO_OPPORTUNITIES.length
      });
      console.log(`[BrandMarketplace] Set ${STATIC_DEMO_OPPORTUNITIES.length} demo opportunities in cache`);
    } else {
      // Invalidate cache to refetch real data
      queryClient.invalidateQueries({ queryKey: ["opportunities"] });
    }
  }, [isPitchMode, queryClient, isAuthenticated]);
  
  const { data: discoveryData, isLoading: isLoadingOpportunities } = useQuery<DiscoveryResponse>({
    queryKey: ["opportunities", isPitchMode, isAuthenticated] as const,
    queryFn: async ({ queryKey }) => {
      // Extract isPitchMode from queryKey to avoid stale closure
      const [, pitchModeFromKey, authFromKey] = queryKey;
      
      // PITCH MODE: Return static demo data immediately (no API call)
      if (pitchModeFromKey) {
        console.log(`[BrandMarketplace] Returning ${STATIC_DEMO_OPPORTUNITIES.length} static demo opportunities (pitch mode)`);
        return { opportunities: STATIC_DEMO_OPPORTUNITIES, total: STATIC_DEMO_OPPORTUNITIES.length };
      }
      
      // REAL MODE: Fetch from API
      const endpoint = authFromKey ? "/api/brand/discovery" : "/api/demo/brand-discovery";
      console.log(`[BrandMarketplace] Fetching opportunities from ${endpoint}`);
      const res = await fetch(endpoint, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch opportunities");
      const data = await res.json();
      console.log(`[BrandMarketplace] Response: ${data.opportunities?.length || 0} opportunities`);
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
  console.log("[BrandMarketplace] isPitchMode:", isPitchMode, "opportunities.length:", allOpportunities.length, "isLoading:", isLoadingOpportunities);

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
            <div className="flex items-center gap-3">
              {/* Pitch Mode Toggle - Only for super admin */}
              {isSuperAdmin && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary/50 border border-border">
                  <span className="text-xs text-muted-foreground">Real Data</span>
                  <Switch
                    checked={isPitchMode}
                    onCheckedChange={setPitchMode}
                    className="data-[state=checked]:bg-primary"
                    data-testid="switch-pitch-mode"
                  />
                  <span className="text-xs text-muted-foreground">Pitch Mode</span>
                </div>
              )}
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
                      src={(opportunity as any).thumbnailUrl || (opportunity as any).thumbnail_url || `https://picsum.photos/seed/${opportunity.id}/640/360`}
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
                        {formatViewCount((opportunity as any).viewCount || (opportunity as any).view_count || 0)}
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
                      <span className="text-xs text-muted-foreground">by {(opportunity as any).creatorName || (opportunity as any).creator_name || "Creator"}</span>
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
