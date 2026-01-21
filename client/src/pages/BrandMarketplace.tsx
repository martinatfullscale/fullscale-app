import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Search, Filter, DollarSign, Tag, Play, 
  ShoppingCart, TrendingUp, Eye, Clock,
  Briefcase, Palette, Monitor, Sparkles, X, Globe, ExternalLink
} from "lucide-react";
import { SiYoutube, SiTwitch, SiFacebook } from "react-icons/si";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  platform?: string;
  platforms?: string[];
}

// Static demo opportunities for pitch mode - 20 items with unique creator space images
const STATIC_DEMO_OPPORTUNITIES: MarketplaceOpportunity[] = [
  { id: 1, videoId: 101, youtubeId: "demo1", title: "Ultimate Desk Setup Tour 2026", thumbnailUrl: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=640&h=360&fit=crop", creatorName: "TechVision", viewCount: 1250000, sceneValue: 85, context: "Workspace", genre: "Tech", sceneType: "Desk", surfaces: ["Monitor", "Desk", "Wall"], duration: "12:34", platform: "youtube", platforms: ["youtube"] },
  { id: 2, videoId: 102, youtubeId: "demo2", title: "Morning Kitchen Routine", thumbnailUrl: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=640&h=360&fit=crop", creatorName: "LifestyleMax", viewCount: 890000, sceneValue: 65, context: "Kitchen", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Counter", "Shelf", "Appliances"], duration: "8:45", platform: "youtube", platforms: ["youtube", "facebook"] },
  { id: 3, videoId: 103, youtubeId: "demo3", title: "Pro Podcast Studio Setup", thumbnailUrl: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=640&h=360&fit=crop", creatorName: "AudioPro", viewCount: 2100000, sceneValue: 120, context: "Studio", genre: "Tech", sceneType: "Desk", surfaces: ["Microphone", "Wall", "Monitor"], duration: "15:22", platform: "youtube", platforms: ["youtube", "twitch"] },
  { id: 4, videoId: 104, youtubeId: "demo4", title: "Living Room Coffee Table Styling", thumbnailUrl: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=640&h=360&fit=crop", creatorName: "InteriorDesign", viewCount: 675000, sceneValue: 55, context: "Living Room", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Coffee Table", "Sofa", "Decor"], duration: "10:15", platform: "facebook", platforms: ["facebook"] },
  { id: 5, videoId: 105, youtubeId: "demo5", title: "Ultimate Gaming Battlestation", thumbnailUrl: "https://images.unsplash.com/photo-1616588589676-62b3bd4ff6d2?w=640&h=360&fit=crop", creatorName: "GamerzHQ", viewCount: 1450000, sceneValue: 95, context: "Gaming", genre: "Gaming", sceneType: "Desk", surfaces: ["Monitor", "Keyboard", "RGB Wall"], duration: "18:30", platform: "twitch", platforms: ["twitch", "youtube"] },
  { id: 6, videoId: 106, youtubeId: "demo6", title: "Home Office Transformation", thumbnailUrl: "https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=640&h=360&fit=crop", creatorName: "WFHPro", viewCount: 320000, sceneValue: 45, context: "Office", genre: "DIY", sceneType: "Wall", surfaces: ["Desk", "Bookshelf", "Wall Art"], duration: "7:20", platform: "youtube", platforms: ["youtube"] },
  { id: 7, videoId: 107, youtubeId: "demo7", title: "Twitch Stream VOD - 3 Hours", thumbnailUrl: "https://images.unsplash.com/photo-1603481588273-2f908a9a7a1b?w=640&h=360&fit=crop", creatorName: "StreamerPro", viewCount: 980000, sceneValue: 110, context: "Streaming", genre: "Gaming", sceneType: "Desk", surfaces: ["Camera", "Microphone", "Lights"], duration: "3:14:55", platform: "twitch", platforms: ["twitch"] },
  { id: 8, videoId: 108, youtubeId: "demo8", title: "Modern Kitchen Island Tour", thumbnailUrl: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=640&h=360&fit=crop", creatorName: "HomeCooking", viewCount: 540000, sceneValue: 70, context: "Kitchen", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Island", "Stools", "Appliances"], duration: "11:40", platform: "youtube", platforms: ["youtube"] },
  { id: 9, videoId: 109, youtubeId: "demo9", title: "Cozy Reading Corner Setup", thumbnailUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=640&h=360&fit=crop", creatorName: "BookishVibes", viewCount: 1850000, sceneValue: 150, context: "Living Room", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Chair", "Bookshelf", "Lamp"], duration: "22:15", platform: "youtube", platforms: ["youtube", "facebook"] },
  { id: 10, videoId: 110, youtubeId: "demo10", title: "Clean Workspace Essentials", thumbnailUrl: "https://images.unsplash.com/photo-1593642702821-c8da6771f0c6?w=640&h=360&fit=crop", creatorName: "MinimalDesk", viewCount: 445000, sceneValue: 75, context: "Workspace", genre: "Tech", sceneType: "Desk", surfaces: ["Monitor", "Desk", "Accessories"], duration: "16:30", platform: "youtube", platforms: ["youtube"] },
  { id: 11, videoId: 111, youtubeId: "demo11", title: "Facebook Live Replay - Home Tour", thumbnailUrl: "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=640&h=360&fit=crop", creatorName: "ApartmentLife", viewCount: 2300000, sceneValue: 180, context: "Apartment", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Living Area", "Bedroom", "Kitchen"], duration: "1:25:40", platform: "facebook", platforms: ["facebook"] },
  { id: 12, videoId: 112, youtubeId: "demo12", title: "Aesthetic Bedroom Makeover", thumbnailUrl: "https://images.unsplash.com/photo-1616594039964-ae9021a400a0?w=640&h=360&fit=crop", creatorName: "RoomInspo", viewCount: 1120000, sceneValue: 135, context: "Bedroom", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Bed", "Nightstand", "Wall"], duration: "28:55", platform: "youtube", platforms: ["youtube"] },
  { id: 13, videoId: 113, youtubeId: "demo13", title: "Productivity Desk Setup", thumbnailUrl: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=640&h=360&fit=crop", creatorName: "ProductivityPro", viewCount: 678000, sceneValue: 60, context: "Workspace", genre: "Education", sceneType: "Desk", surfaces: ["Laptop", "Desk", "Accessories"], duration: "14:20", platform: "youtube", platforms: ["youtube"] },
  { id: 14, videoId: 114, youtubeId: "demo14", title: "Smart Home Control Center", thumbnailUrl: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=640&h=360&fit=crop", creatorName: "SmartHomeDIY", viewCount: 890000, sceneValue: 95, context: "Smart Home", genre: "DIY", sceneType: "Interior", surfaces: ["Hub", "Wall", "Devices"], duration: "19:45", platform: "facebook", platforms: ["facebook", "youtube"] },
  { id: 15, videoId: 115, youtubeId: "demo15", title: "Influencer Content Studio", thumbnailUrl: "https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=640&h=360&fit=crop", creatorName: "ContentCreator", viewCount: 1560000, sceneValue: 125, context: "Studio", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Ring Light", "Camera", "Backdrop"], duration: "17:30", platform: "youtube", platforms: ["youtube", "twitch", "facebook"] },
  { id: 16, videoId: 116, youtubeId: "demo16", title: "Mechanical Keyboard Showcase", thumbnailUrl: "https://images.unsplash.com/photo-1595225476474-87563907a212?w=640&h=360&fit=crop", creatorName: "KeyboardEnthusiast", viewCount: 720000, sceneValue: 80, context: "Product", genre: "Tech", sceneType: "Product", surfaces: ["Keyboard", "Desk Mat", "Switches"], duration: "12:10", platform: "youtube", platforms: ["youtube"] },
  { id: 17, videoId: 117, youtubeId: "demo17", title: "Twitch IRL Stream - Gaming Cafe", thumbnailUrl: "https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=640&h=360&fit=crop", creatorName: "CleanSetup", viewCount: 456000, sceneValue: 55, context: "IRL Stream", genre: "Gaming", sceneType: "Interior", surfaces: ["Gaming Setup", "Desk", "Accessories"], duration: "2:11:25", platform: "twitch", platforms: ["twitch"] },
  { id: 18, videoId: 118, youtubeId: "demo18", title: "4K Monitor Comparison", thumbnailUrl: "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?w=640&h=360&fit=crop", creatorName: "DisplayMasters", viewCount: 934000, sceneValue: 110, context: "Comparison", genre: "Tech", sceneType: "Product", surfaces: ["Monitors", "Desk", "Wall"], duration: "21:50", platform: "youtube", platforms: ["youtube", "twitch"] },
  { id: 19, videoId: 119, youtubeId: "demo19", title: "Day in My Creative Life", thumbnailUrl: "https://images.unsplash.com/photo-1600494603989-9650cf6ddd3d?w=640&h=360&fit=crop", creatorName: "CreatorLife", viewCount: 1340000, sceneValue: 90, context: "Vlog", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Camera", "Room", "Equipment"], duration: "15:40", platform: "youtube", platforms: ["youtube"] },
  { id: 20, videoId: 120, youtubeId: "demo20", title: "Webcam Setup for Streamers", thumbnailUrl: "https://images.unsplash.com/photo-1587825140708-dfaf72ae4b04?w=640&h=360&fit=crop", creatorName: "WebcamReview", viewCount: 567000, sceneValue: 70, context: "Comparison", genre: "Tech", sceneType: "Product", surfaces: ["Webcams", "Desk", "Screen"], duration: "18:20", platform: "youtube", platforms: ["youtube", "twitch"] },
];

const PLATFORMS = ["All", "YouTube", "Twitch", "Facebook"];

const GENRES = ["All", "Tech", "Gaming", "Lifestyle", "DIY", "Education", "Entertainment", "Fashion", "Beauty", "Fitness", "Food", "Travel", "Vlog", "Productivity", "Finance", "Sports", "Music", "Art", "Science", "Health"];
const BUDGETS = ["All", "Under $50", "$50-$100", "$100-$200", "Over $200"];
const SCENE_TYPES = ["All", "Desk", "Wall", "Interior", "Product"];

interface BrandCategory {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  brandCount: number;
}

const BRAND_CATEGORIES: BrandCategory[] = [
  { id: "tech", name: "Technology", description: "Electronics & Software", imageUrl: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=400&h=250&fit=crop", brandCount: 156 },
  { id: "gaming", name: "Gaming Hardware", description: "Consoles, PCs & Peripherals", imageUrl: "https://images.unsplash.com/photo-1612287230202-1ff1d85d1bdf?w=400&h=250&fit=crop", brandCount: 89 },
  { id: "lifestyle", name: "Lifestyle", description: "Home & Living Products", imageUrl: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400&h=250&fit=crop", brandCount: 234 },
  { id: "automotive", name: "Automotive", description: "Cars, Parts & Accessories", imageUrl: "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=400&h=250&fit=crop", brandCount: 67 },
  { id: "pet", name: "Pet Care", description: "Pet Food, Toys & Supplies", imageUrl: "https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=400&h=250&fit=crop", brandCount: 112 },
  { id: "travel", name: "Travel & Leisure", description: "Hotels, Airlines & Experiences", imageUrl: "https://images.unsplash.com/photo-1488085061387-422e29b40080?w=400&h=250&fit=crop", brandCount: 78 },
  { id: "finance", name: "Financial Services", description: "Banking, Investing & Insurance", imageUrl: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=400&h=250&fit=crop", brandCount: 45 },
  { id: "beauty", name: "Beauty & Skincare", description: "Cosmetics & Personal Care", imageUrl: "https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=400&h=250&fit=crop", brandCount: 198 },
  { id: "fitness", name: "Fitness & Sports", description: "Equipment & Apparel", imageUrl: "https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=400&h=250&fit=crop", brandCount: 145 },
  { id: "food", name: "Food & Beverage", description: "CPG Food Products", imageUrl: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=400&h=250&fit=crop", brandCount: 267 },
  { id: "beverage", name: "CPG (Beverage)", description: "Drinks & Energy Products", imageUrl: "https://images.unsplash.com/photo-1544145945-f90425340c7e?w=400&h=250&fit=crop", brandCount: 134 },
  { id: "snack", name: "CPG (Snack)", description: "Snacks & Confectionery", imageUrl: "https://images.unsplash.com/photo-1621939514649-280e2ee25f60?w=400&h=250&fit=crop", brandCount: 156 },
  { id: "home-improvement", name: "Home Improvement", description: "Tools, Paint & Materials", imageUrl: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&h=250&fit=crop", brandCount: 89 },
  { id: "luxury", name: "Luxury Fashion", description: "High-End Apparel & Accessories", imageUrl: "https://images.unsplash.com/photo-1445205170230-053b83016050?w=400&h=250&fit=crop", brandCount: 56 },
  { id: "streaming", name: "Streaming Services", description: "Entertainment & Media Platforms", imageUrl: "https://images.unsplash.com/photo-1522869635100-9f4c5e86aa37?w=400&h=250&fit=crop", brandCount: 23 },
  { id: "health", name: "Health & Wellness", description: "Supplements & Medical", imageUrl: "https://images.unsplash.com/photo-1505576399279-565b52d4ac71?w=400&h=250&fit=crop", brandCount: 178 },
  { id: "fashion", name: "Fashion & Apparel", description: "Clothing & Streetwear", imageUrl: "https://images.unsplash.com/photo-1558171813-4c088753af8f?w=400&h=250&fit=crop", brandCount: 312 },
  { id: "education", name: "Education & Courses", description: "Learning Platforms & Tools", imageUrl: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=400&h=250&fit=crop", brandCount: 67 },
  { id: "software", name: "SaaS & Apps", description: "Software & Subscriptions", imageUrl: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=400&h=250&fit=crop", brandCount: 189 },
  { id: "crypto", name: "Crypto & Web3", description: "Blockchain & NFT Projects", imageUrl: "https://images.unsplash.com/photo-1639762681485-074b7f938ba0?w=400&h=250&fit=crop", brandCount: 34 },
];

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
  
  // Check for admin access - show pitch toggle if user has any admin/switch capabilities
  const { data: userTypeData } = useQuery<{ isAdmin: boolean; canSwitchRoles: boolean; email: string }>({
    queryKey: ["/api/auth/user-type"],
  });
  
  // Super admin check for pitch mode toggle - use multiple sources
  const currentUserEmail = googleUser?.email || user?.email || userTypeData?.email || "";
  const isSuperAdmin = currentUserEmail.toLowerCase() === SUPER_ADMIN_EMAIL || userTypeData?.isAdmin || userTypeData?.canSwitchRoles;
  
  const [searchQuery, setSearchQuery] = useState("");
  const [genreFilter, setGenreFilter] = useState("All");
  const [budgetFilter, setBudgetFilter] = useState("All");
  const [sceneTypeFilter, setSceneTypeFilter] = useState("All");
  const [platformFilter, setPlatformFilter] = useState("All");
  const [buyingId, setBuyingId] = useState<number | null>(null);
  const [showCategories, setShowCategories] = useState(true);
  const [activeTab, setActiveTab] = useState<"categories" | "opportunities">("categories");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedOpportunity, setSelectedOpportunity] = useState<MarketplaceOpportunity | null>(null);

  // PRIORITY: isPitchMode toggle is checked FIRST - overrides authentication state
  const isAuthenticated = !!googleUser;

  // When pitch mode changes, immediately update the data (no API delay)
  useEffect(() => {
    console.log(`[BrandMarketplace] isPitchMode changed to: ${isPitchMode}, user?.id: ${user?.id}`);
    if (isPitchMode || !user?.id) {
      // Immediately set demo opportunities in cache - no async wait needed
      queryClient.setQueryData(["opportunities", isPitchMode, user?.id], {
        opportunities: STATIC_DEMO_OPPORTUNITIES,
        total: STATIC_DEMO_OPPORTUNITIES.length
      });
      console.log(`[BrandMarketplace] Set ${STATIC_DEMO_OPPORTUNITIES.length} demo opportunities in cache`);
    } else {
      // Invalidate cache to refetch real data
      queryClient.invalidateQueries({ queryKey: ["opportunities"] });
    }
  }, [isPitchMode, queryClient, user?.id]);
  
  const { data: discoveryData, isLoading: isLoadingOpportunities } = useQuery<DiscoveryResponse>({
    queryKey: ["opportunities", isPitchMode, user?.id] as const,
    queryFn: async ({ queryKey }) => {
      // Extract values from queryKey to avoid stale closure
      const [, pitchModeFromKey, userIdFromKey] = queryKey;
      
      // PITCH MODE or NOT LOGGED IN: Return demo data
      // If Pitch Mode is ON, OR if there is no logged-in user, use the DEMO endpoint
      if (pitchModeFromKey || !userIdFromKey) {
        console.log(`[BrandMarketplace] Returning ${STATIC_DEMO_OPPORTUNITIES.length} static demo opportunities (pitchMode=${pitchModeFromKey}, userId=${userIdFromKey})`);
        return { opportunities: STATIC_DEMO_OPPORTUNITIES, total: STATIC_DEMO_OPPORTUNITIES.length };
      }
      
      // REAL MODE: User is logged in and pitch mode is OFF - fetch from real API
      const endpoint = "/api/brand/discovery";
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

  const categoryToGenreMap: Record<string, string> = {
    "tech": "Tech",
    "gaming": "Gaming",
    "lifestyle": "Lifestyle",
    "education": "Education",
    "software": "Tech",
    "streaming": "Gaming",
    "fitness": "Lifestyle",
    "beauty": "Lifestyle",
    "fashion": "Lifestyle",
    "food": "Lifestyle",
    "beverage": "Lifestyle",
    "snack": "Lifestyle",
    "health": "Lifestyle",
    "home-improvement": "DIY",
    "automotive": "Tech",
    "pet": "Lifestyle",
    "travel": "Lifestyle",
    "finance": "Education",
    "luxury": "Lifestyle",
    "crypto": "Tech",
  };

  const filteredOpportunities = allOpportunities.filter((opp: MarketplaceOpportunity) => {
    const matchesSearch = opp.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      opp.creatorName.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesGenre = genreFilter === "All" || opp.genre === genreFilter;
    const matchesSceneType = sceneTypeFilter === "All" || opp.sceneType === sceneTypeFilter;
    
    const matchesCategory = !selectedCategory || 
      opp.genre === categoryToGenreMap[selectedCategory] ||
      opp.context.toLowerCase().includes(selectedCategory.toLowerCase());
    
    // Platform filter - check both primary platform and platforms array
    let matchesPlatform = true;
    if (platformFilter !== "All") {
      const filterValue = platformFilter.toLowerCase();
      matchesPlatform = opp.platform === filterValue || 
        (opp.platforms?.includes(filterValue) ?? false);
    }
    
    let matchesBudget = true;
    if (budgetFilter === "Under $50") matchesBudget = opp.sceneValue < 50;
    else if (budgetFilter === "$50-$100") matchesBudget = opp.sceneValue >= 50 && opp.sceneValue <= 100;
    else if (budgetFilter === "$100-$200") matchesBudget = opp.sceneValue > 100 && opp.sceneValue <= 200;
    else if (budgetFilter === "Over $200") matchesBudget = opp.sceneValue > 200;
    
    return matchesSearch && matchesGenre && matchesBudget && matchesSceneType && matchesCategory && matchesPlatform;
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
              {/* Pitch Mode Toggle - Always visible for demo purposes */}
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
              <Badge variant="outline" className="gap-1">
                <Sparkles className="w-3 h-3" />
                {filteredOpportunities.length} Opportunities
              </Badge>
              <Badge className="bg-blue-500/20 text-blue-400" data-testid="badge-showing-count">
                Showing {allOpportunities.length} items
              </Badge>
            </div>
          </div>
          
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => setActiveTab("categories")}
              className={`px-4 py-2 rounded-lg font-medium text-sm transition-colors ${
                activeTab === "categories"
                  ? "bg-primary text-white"
                  : "bg-secondary/50 text-muted-foreground hover:text-white"
              }`}
              data-testid="tab-categories"
            >
              Brand Categories ({BRAND_CATEGORIES.length})
            </button>
            <button
              onClick={() => setActiveTab("opportunities")}
              className={`px-4 py-2 rounded-lg font-medium text-sm transition-colors ${
                activeTab === "opportunities"
                  ? "bg-primary text-white"
                  : "bg-secondary/50 text-muted-foreground hover:text-white"
              }`}
              data-testid="tab-opportunities"
            >
              Video Opportunities ({allOpportunities.length})
            </button>
            
            {selectedCategory && (
              <Badge 
                className="bg-primary/20 text-primary gap-1 cursor-pointer"
                onClick={() => setSelectedCategory(null)}
                data-testid="badge-selected-category"
              >
                {BRAND_CATEGORIES.find(c => c.id === selectedCategory)?.name || selectedCategory}
                <X className="w-3 h-3" />
              </Badge>
            )}
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
            
            <Select value={platformFilter} onValueChange={setPlatformFilter}>
              <SelectTrigger className="w-[140px]" data-testid="select-platform">
                <Globe className="w-4 h-4 mr-2" />
                <SelectValue placeholder="Platform" />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((platform) => (
                  <SelectItem key={platform} value={platform}>{platform}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {activeTab === "categories" && (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-white">Browse by Industry</h2>
                <p className="text-sm text-muted-foreground">Select a category to find brands looking for placements</p>
              </div>
              <Badge className="bg-primary/20 text-primary">
                {BRAND_CATEGORIES.reduce((sum, c) => sum + c.brandCount, 0).toLocaleString()} Total Brands
              </Badge>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {BRAND_CATEGORIES.map((category, idx) => (
                <motion.div
                  key={category.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.03 }}
                >
                  <Card 
                    className="group overflow-hidden cursor-pointer hover-elevate"
                    onClick={() => {
                      setSelectedCategory(category.id);
                      setActiveTab("opportunities");
                    }}
                    data-testid={`card-category-${category.id}`}
                  >
                    <div className="aspect-[16/10] relative overflow-hidden">
                      <img
                        src={category.imageUrl}
                        alt={category.name}
                        className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
                      <div className="absolute bottom-0 left-0 right-0 p-3">
                        <h3 className="font-semibold text-white text-sm mb-0.5">{category.name}</h3>
                        <p className="text-xs text-white/70 line-clamp-1">{category.description}</p>
                        <div className="flex items-center gap-1 mt-1.5">
                          <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
                            {category.brandCount} brands
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </Card>
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "opportunities" && (
        <>
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
                  <div 
                    className="aspect-video relative overflow-hidden rounded-t-md cursor-pointer"
                    onClick={() => setSelectedOpportunity(opportunity)}
                    data-testid={`thumbnail-opportunity-${opportunity.id}`}
                  >
                    <img
                      src={(opportunity as any).thumbnailUrl || (opportunity as any).thumbnail_url || `https://picsum.photos/seed/${opportunity.id}/640/360`}
                      alt={opportunity.title}
                      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${opportunity.id}/640/360`;
                      }}
                    />
                    {/* Overlay play icon on hover */}
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/30">
                      <div className="w-12 h-12 rounded-full bg-white/90 flex items-center justify-center">
                        <Play className="w-6 h-6 text-black fill-black ml-1" />
                      </div>
                    </div>
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                    
                    <div className="absolute top-2 left-2 flex items-center gap-1.5">
                      <Badge className="bg-emerald-500/90 text-white border-0 gap-1">
                        <DollarSign className="w-3 h-3" />
                        {opportunity.sceneValue}
                      </Badge>
                    </div>
                    
                    <div className="absolute top-2 right-2 flex items-center gap-1">
                      {/* Platform icons with exact brand colors */}
                      {(opportunity.platforms || [opportunity.platform]).filter(Boolean).map((p) => (
                        <div 
                          key={p} 
                          className={`w-5 h-5 rounded-full flex items-center justify-center ${
                            p === 'twitch' ? 'bg-[#9146FF]' : 
                            p === 'facebook' ? 'bg-[#1877F2]' : 
                            'bg-[#FF0000]'
                          }`}
                        >
                          {p === 'twitch' ? <SiTwitch className="w-2.5 h-2.5 text-white" /> :
                           p === 'facebook' ? <SiFacebook className="w-2.5 h-2.5 text-white" /> :
                           <SiYoutube className="w-2.5 h-2.5 text-white" />}
                        </div>
                      ))}
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
        </> 
        )}
      </div>

      {/* Video Opportunity Detail Modal */}
      <Dialog open={!!selectedOpportunity} onOpenChange={(open) => !open && setSelectedOpportunity(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="modal-opportunity-detail">
          {selectedOpportunity && (
            <>
              <DialogHeader>
                <DialogTitle className="text-xl font-bold">{selectedOpportunity.title}</DialogTitle>
              </DialogHeader>
              
              <div className="space-y-6 py-4">
                {/* Video thumbnail with platform badges */}
                <div className="aspect-video relative rounded-lg overflow-hidden bg-black">
                  <img
                    src={(selectedOpportunity as any).thumbnailUrl || (selectedOpportunity as any).thumbnail_url || `https://picsum.photos/seed/${selectedOpportunity.id}/1280/720`}
                    alt={selectedOpportunity.title}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute top-3 right-3 flex items-center gap-2">
                    {(selectedOpportunity.platforms || [selectedOpportunity.platform]).filter(Boolean).map((p) => (
                      <div 
                        key={p} 
                        className={`w-8 h-8 rounded-full flex items-center justify-center shadow-lg ${
                          p === 'twitch' ? 'bg-[#9146FF]' : 
                          p === 'facebook' ? 'bg-[#1877F2]' : 
                          'bg-[#FF0000]'
                        }`}
                      >
                        {p === 'twitch' ? <SiTwitch className="w-4 h-4 text-white" /> :
                         p === 'facebook' ? <SiFacebook className="w-4 h-4 text-white" /> :
                         <SiYoutube className="w-4 h-4 text-white" />}
                      </div>
                    ))}
                  </div>
                  <div className="absolute bottom-3 right-3 bg-black/70 px-2 py-1 rounded text-sm text-white">
                    {selectedOpportunity.duration}
                  </div>
                </div>

                {/* Creator info and stats */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-white font-bold">
                      {(selectedOpportunity.creatorName || "C").charAt(0)}
                    </div>
                    <div>
                      <p className="font-semibold">{selectedOpportunity.creatorName}</p>
                      <p className="text-sm text-muted-foreground">Creator</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Eye className="w-4 h-4" />
                      <span>{formatViewCount(selectedOpportunity.viewCount)}</span>
                    </div>
                    <Badge variant="outline">{selectedOpportunity.genre}</Badge>
                  </div>
                </div>

                {/* Placement Opportunities Section */}
                <div className="bg-card rounded-lg border p-4">
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary" />
                    Placement Opportunities
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    {selectedOpportunity.surfaces.map((surface, idx) => (
                      <div key={idx} className="flex items-center justify-between p-3 bg-background rounded-lg border">
                        <div className="flex items-center gap-2">
                          <Monitor className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm font-medium">{surface}</span>
                        </div>
                        <Badge className="bg-emerald-500/20 text-emerald-500 border-emerald-500/30">
                          Available
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Scene Context */}
                <div className="flex items-center gap-4">
                  <div className="flex-1 bg-card rounded-lg border p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Scene Context</p>
                    <p className="font-medium">{selectedOpportunity.context}</p>
                  </div>
                  <div className="flex-1 bg-card rounded-lg border p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Scene Type</p>
                    <p className="font-medium">{selectedOpportunity.sceneType}</p>
                  </div>
                </div>

                {/* Price and Buy */}
                <div className="flex items-center justify-between p-4 bg-primary/5 rounded-lg border border-primary/20">
                  <div>
                    <p className="text-sm text-muted-foreground">Placement Value</p>
                    <p className="text-3xl font-bold text-emerald-500">${selectedOpportunity.sceneValue}</p>
                  </div>
                  <Button 
                    size="lg" 
                    className="gap-2"
                    onClick={() => {
                      handleBuy(selectedOpportunity);
                      setSelectedOpportunity(null);
                    }}
                    disabled={buyingId === selectedOpportunity.id}
                    data-testid="button-buy-modal"
                  >
                    <ShoppingCart className="w-5 h-5" />
                    {buyingId === selectedOpportunity.id ? "Processing..." : "Purchase Placement"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
