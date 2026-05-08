import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, Filter, DollarSign, Tag, Play,
  ShoppingCart, TrendingUp, Eye, Clock,
  Briefcase, Palette, Monitor, Sparkles, X, Globe, ExternalLink, Mic
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
import { Link } from "wouter";
import EditorialClips from "@/components/EditorialClips";

const SUPER_ADMIN_EMAIL = "martin@gofullscale.co";

interface MarketplaceOpportunity {
  id: number;
  videoId: number;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  creatorName: string;
  creatorSlug?: string | null;
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
  videoUrl?: string | null;
  filePath?: string | null;
  subcategory?: string | null;
}

interface FeaturedCreator {
  name: string;
  slug: string;
  headline: string | null;
  profileImage: string | null;
  thumbnails: string[];
  category?: string;
  /** Optional: hex gradient pair for logo-card mode when no real thumbnail
   *  exists. Server-side creators omit this; dummies set it. */
  gradient?: [string, string];
  stats: {
    totalVideos: number;
    totalViews: number;
    totalSurfaces: number;
    subscribers: number;
  };
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
  // Gaming — expanded for "Gaming Hardware" category
  { id: 21, videoId: 121, youtubeId: "demo21", title: "Gaming Setup RGB Tour", thumbnailUrl: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=640&h=360&fit=crop", creatorName: "RGBMaster", viewCount: 1890000, sceneValue: 105, context: "Gaming Setup", genre: "Gaming", sceneType: "Desk", surfaces: ["Gaming PC", "Monitors", "RGB Lighting"], duration: "14:22", platform: "twitch", platforms: ["twitch", "youtube"] },
  { id: 22, videoId: 122, youtubeId: "demo22", title: "Esports Arena Tour", thumbnailUrl: "https://images.unsplash.com/photo-1612287230202-1ff1d85d1bdf?w=640&h=360&fit=crop", creatorName: "EsportsDaily", viewCount: 2400000, sceneValue: 140, context: "Gaming Arena", genre: "Gaming", sceneType: "Interior", surfaces: ["Gaming Chairs", "Monitors", "Banners"], duration: "22:10", platform: "youtube", platforms: ["youtube", "twitch"] },
  { id: 23, videoId: 123, youtubeId: "demo23", title: "Console vs PC Showdown", thumbnailUrl: "https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=640&h=360&fit=crop", creatorName: "GameDebate", viewCount: 1350000, sceneValue: 90, context: "Gaming Comparison", genre: "Gaming", sceneType: "Product", surfaces: ["Console", "Gaming PC", "Controllers"], duration: "19:45", platform: "youtube", platforms: ["youtube"] },
  // Beauty — expanded
  { id: 24, videoId: 124, youtubeId: "demo24", title: "Full Glam Transformation", thumbnailUrl: "https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=640&h=360&fit=crop", creatorName: "GlamByLisa", viewCount: 2100000, sceneValue: 115, context: "Beauty Studio", genre: "Beauty", sceneType: "Interior", surfaces: ["Vanity", "Products", "Mirror"], duration: "16:30", platform: "youtube", platforms: ["youtube"] },
  { id: 25, videoId: 125, youtubeId: "demo25", title: "Skincare Routine Night Edition", thumbnailUrl: "https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=640&h=360&fit=crop", creatorName: "SkinCareSarah", viewCount: 890000, sceneValue: 80, context: "Beauty Bathroom", genre: "Beauty", sceneType: "Interior", surfaces: ["Counter", "Products", "Mirror"], duration: "12:15", platform: "youtube", platforms: ["youtube", "facebook"] },
  // Fitness
  { id: 26, videoId: 126, youtubeId: "demo26", title: "Home Gym Setup Tour", thumbnailUrl: "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=640&h=360&fit=crop", creatorName: "FitLife", viewCount: 1560000, sceneValue: 95, context: "Fitness Gym", genre: "Fitness", sceneType: "Interior", surfaces: ["Equipment", "Mat", "Mirror"], duration: "13:40", platform: "youtube", platforms: ["youtube"] },
  { id: 27, videoId: 127, youtubeId: "demo27", title: "Morning Yoga Flow", thumbnailUrl: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=640&h=360&fit=crop", creatorName: "YogaWithJen", viewCount: 2800000, sceneValue: 125, context: "Fitness Yoga", genre: "Fitness", sceneType: "Interior", surfaces: ["Yoga Mat", "Props", "Wall"], duration: "28:00", platform: "youtube", platforms: ["youtube", "facebook"] },
  // Food
  { id: 28, videoId: 128, youtubeId: "demo28", title: "Kitchen Gadgets Ranked", thumbnailUrl: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=640&h=360&fit=crop", creatorName: "FoodTechReview", viewCount: 1200000, sceneValue: 85, context: "Food Kitchen", genre: "Food", sceneType: "Interior", surfaces: ["Counter", "Appliances", "Gadgets"], duration: "17:50", platform: "youtube", platforms: ["youtube"] },
  { id: 29, videoId: 129, youtubeId: "demo29", title: "Meal Prep Sunday", thumbnailUrl: "https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=640&h=360&fit=crop", creatorName: "PrepWithMike", viewCount: 780000, sceneValue: 60, context: "Food Prep", genre: "Food", sceneType: "Interior", surfaces: ["Cutting Board", "Containers", "Ingredients"], duration: "21:30", platform: "youtube", platforms: ["youtube", "facebook"] },
  // Fashion
  { id: 30, videoId: 130, youtubeId: "demo30", title: "Streetwear Haul 2026", thumbnailUrl: "https://images.unsplash.com/photo-1558171813-4c088753af8f?w=640&h=360&fit=crop", creatorName: "StreetStyleKing", viewCount: 1900000, sceneValue: 110, context: "Fashion Haul", genre: "Fashion", sceneType: "Interior", surfaces: ["Closet", "Mirror", "Clothing"], duration: "15:20", platform: "youtube", platforms: ["youtube"] },
  { id: 31, videoId: 131, youtubeId: "demo31", title: "Sneaker Collection Tour", thumbnailUrl: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=640&h=360&fit=crop", creatorName: "SneakerHeadz", viewCount: 3100000, sceneValue: 160, context: "Fashion Sneakers", genre: "Fashion", sceneType: "Product", surfaces: ["Shoe Wall", "Display", "Boxes"], duration: "18:45", platform: "youtube", platforms: ["youtube", "twitch"] },
  // Travel
  { id: 32, videoId: 132, youtubeId: "demo32", title: "Bali Travel Vlog", thumbnailUrl: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=640&h=360&fit=crop", creatorName: "TravelWithTom", viewCount: 4500000, sceneValue: 180, context: "Travel Destination", genre: "Travel", sceneType: "Interior", surfaces: ["Hotel Room", "Pool", "Beach"], duration: "25:40", platform: "youtube", platforms: ["youtube", "facebook"] },
  // Automotive
  { id: 33, videoId: 133, youtubeId: "demo33", title: "Dream Garage Tour", thumbnailUrl: "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=640&h=360&fit=crop", creatorName: "AutoReviewsPro", viewCount: 1780000, sceneValue: 200, context: "Automotive Garage", genre: "Automotive", sceneType: "Interior", surfaces: ["Car Hood", "Garage Wall", "Tools"], duration: "20:15", platform: "youtube", platforms: ["youtube"] },
  // Finance / Education
  { id: 34, videoId: 134, youtubeId: "demo34", title: "Trading Setup Explained", thumbnailUrl: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=640&h=360&fit=crop", creatorName: "FinanceGuru", viewCount: 920000, sceneValue: 130, context: "Finance Trading", genre: "Finance", sceneType: "Desk", surfaces: ["Multi-Monitor", "Desk", "Whiteboard"], duration: "16:30", platform: "youtube", platforms: ["youtube"] },
  // Podcast
  { id: 35, videoId: 135, youtubeId: "demo35", title: "The Deep Dive - Episode 42", thumbnailUrl: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=640&h=360&fit=crop", creatorName: "DeepDivePod", viewCount: 560000, sceneValue: 75, context: "Podcast Studio", genre: "Podcast", sceneType: "Interior", surfaces: ["Microphone", "Acoustic Panel", "Logo Wall"], duration: "1:12:00", platform: "fullscale", platforms: ["fullscale", "youtube"] },
  { id: 36, videoId: 136, youtubeId: "demo36", title: "Tech Talk Weekly", thumbnailUrl: "https://images.unsplash.com/photo-1478737270239-2f02b77fc618?w=640&h=360&fit=crop", creatorName: "TechTalkPod", viewCount: 340000, sceneValue: 65, context: "Podcast Studio", genre: "Podcast", sceneType: "Interior", surfaces: ["Desk", "Microphone", "Camera"], duration: "0:58:00", platform: "fullscale", platforms: ["fullscale"] },
];

const PLATFORMS = ["All", "Podcasts", "YouTube", "Twitch", "Facebook"];

const GENRES = ["All", "Tech", "Gaming", "Lifestyle", "DIY", "Education", "Entertainment", "Fashion", "Beauty", "Fitness", "Food", "Travel", "Vlog", "Productivity", "Finance", "Automotive", "Podcast", "Sports", "Music", "Art", "Science", "Health"];
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
  { id: "podcasts", name: "Podcasts", description: "Podcast & Audio Content Placements", imageUrl: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=400&h=250&fit=crop", brandCount: 42 },
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
  const [subcategoryFilter, setSubcategoryFilter] = useState("All");
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

  // Fetch featured creators for the spotlight section
  const { data: featuredCreatorsData } = useQuery<{ creators: FeaturedCreator[] }>({
    queryKey: ["featured-creators"],
    queryFn: async () => {
      const res = await fetch("/api/public/featured-creators");
      if (!res.ok) throw new Error("Failed to fetch featured creators");
      return res.json();
    },
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  // Dummy featured creators — 8 slots for 2 rows of 4.
  // Each uses a per-category gradient + initials in the rendering below
  // (logo-card mode), instead of generic stock photos. Real creators uploaded
  // via the API can supply their own logo/JPEG via `thumbnails[0]` and that
  // image takes precedence over the gradient fallback.
  const DUMMY_FEATURED_CREATORS: FeaturedCreator[] = [
    {
      name: "Jaylen Carter",
      slug: "jaylen",
      headline: "Culture & Lifestyle Creator",
      category: "Lifestyle",
      profileImage: null,
      thumbnails: [],
      gradient: ["#a855f7", "#ec4899"], // purple → pink
      stats: { totalVideos: 24, totalViews: 1850000, totalSurfaces: 87, subscribers: 145000 },
    },
    {
      name: "Aisha Monet",
      slug: "aisha",
      headline: "Podcast Host · Sports & Entertainment",
      category: "Sports",
      profileImage: null,
      thumbnails: [],
      gradient: ["#f97316", "#ef4444"], // orange → red
      stats: { totalVideos: 38, totalViews: 3200000, totalSurfaces: 142, subscribers: 290000 },
    },
    {
      name: "Derek Thompson",
      slug: "derek",
      headline: "Tech Reviews & Unboxing",
      category: "Tech",
      profileImage: null,
      thumbnails: [],
      gradient: ["#0ea5e9", "#3b82f6"], // sky → blue
      stats: { totalVideos: 52, totalViews: 5400000, totalSurfaces: 210, subscribers: 420000 },
    },
    {
      name: "Nina Brooks",
      slug: "nina",
      headline: "Home & Interior Design",
      category: "Home",
      profileImage: null,
      thumbnails: [],
      gradient: ["#10b981", "#14b8a6"], // emerald → teal
      stats: { totalVideos: 31, totalViews: 2400000, totalSurfaces: 115, subscribers: 198000 },
    },
    {
      name: "Marcus Cole",
      slug: "marcus",
      headline: "Music Production & Beats",
      category: "Music",
      profileImage: null,
      thumbnails: [],
      gradient: ["#7c3aed", "#1e1b4b"], // violet → indigo-deep
      stats: { totalVideos: 67, totalViews: 8100000, totalSurfaces: 290, subscribers: 560000 },
    },
    {
      name: "Keyla Voss",
      slug: "keyla",
      headline: "Fitness & Wellness Coach",
      category: "Fitness",
      profileImage: null,
      thumbnails: [],
      gradient: ["#84cc16", "#22c55e"], // lime → green
      stats: { totalVideos: 45, totalViews: 4700000, totalSurfaces: 178, subscribers: 340000 },
    },
    {
      name: "Trey Okonkwo",
      slug: "trey",
      headline: "Auto & Motorsport",
      category: "Auto",
      profileImage: null,
      thumbnails: [],
      gradient: ["#dc2626", "#1f2937"], // red → graphite
      stats: { totalVideos: 29, totalViews: 1600000, totalSurfaces: 64, subscribers: 125000 },
    },
    {
      name: "Sasha Kim",
      slug: "sasha",
      headline: "Food & Cooking",
      category: "Food",
      profileImage: null,
      thumbnails: [],
      gradient: ["#f59e0b", "#dc2626"], // amber → red
      stats: { totalVideos: 41, totalViews: 3900000, totalSurfaces: 155, subscribers: 275000 },
    },
  ];

  // Initials for logo-card fallback ("Jaylen Carter" → "JC").
  const initialsFor = (name: string): string => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  // Deterministic gradient picker for creators without one (e.g. real-API
  // creators whose backend hasn't filled gradient yet). Uses slug hash to
  // pick from a fixed palette so the same creator always gets the same colors.
  const FALLBACK_GRADIENTS: Array<[string, string]> = [
    ["#a855f7", "#ec4899"], ["#0ea5e9", "#3b82f6"], ["#10b981", "#14b8a6"],
    ["#f97316", "#ef4444"], ["#7c3aed", "#1e1b4b"], ["#f59e0b", "#dc2626"],
    ["#84cc16", "#22c55e"], ["#06b6d4", "#6366f1"],
  ];
  const gradientFor = (creator: FeaturedCreator): [string, string] => {
    if (creator.gradient) return creator.gradient;
    let h = 0;
    for (let i = 0; i < creator.slug.length; i++) h = (h * 31 + creator.slug.charCodeAt(i)) | 0;
    return FALLBACK_GRADIENTS[Math.abs(h) % FALLBACK_GRADIENTS.length];
  };

  // Helper to format view counts
  const formatViews = (views: number) => {
    if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
    if (views >= 1000) return `${(views / 1000).toFixed(0)}K`;
    return String(views);
  };

  // Derive category from headline if not explicitly set
  const getCategory = (creator: FeaturedCreator) => {
    if (creator.category) return creator.category;
    const h = (creator.headline || "").toLowerCase();
    if (h.includes("tech")) return "Tech";
    if (h.includes("music")) return "Music";
    if (h.includes("sport")) return "Sports";
    if (h.includes("lifestyle") || h.includes("culture")) return "Lifestyle";
    if (h.includes("food") || h.includes("cook")) return "Food";
    if (h.includes("fitness") || h.includes("wellness")) return "Fitness";
    return "Creator";
  };

  // Merge real featured creators from API with dummy placeholders — 2 rows of 4 (8 total)
  const apiFeaturedCreators = featuredCreatorsData?.creators || [];
  const featuredCreators = [
    ...apiFeaturedCreators,
    ...DUMMY_FEATURED_CREATORS.filter(d => !apiFeaturedCreators.some(a => a.slug === d.slug)),
  ].slice(0, 8);

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

  const categoryToGenreMap: Record<string, string[]> = {
    "podcasts": ["Podcast"],
    "tech": ["Tech"],
    "gaming": ["Gaming"],
    "lifestyle": ["Lifestyle", "DIY", "Vlog"],
    "education": ["Education"],
    "software": ["Tech"],
    "streaming": ["Gaming", "Tech"],
    "fitness": ["Fitness", "Lifestyle"],
    "beauty": ["Beauty", "Lifestyle"],
    "fashion": ["Fashion", "Lifestyle"],
    "food": ["Food", "Lifestyle"],
    "beverage": ["Food", "Lifestyle"],
    "snack": ["Food", "Lifestyle"],
    "health": ["Fitness", "Lifestyle"],
    "home-improvement": ["DIY", "Lifestyle"],
    "automotive": ["Automotive", "Tech"],
    "pet": ["Lifestyle"],
    "travel": ["Travel", "Lifestyle"],
    "finance": ["Finance", "Education"],
    "luxury": ["Fashion", "Lifestyle"],
    "crypto": ["Tech", "Finance"],
  };

  const filteredOpportunities = allOpportunities.filter((opp: MarketplaceOpportunity) => {
    const matchesSearch = opp.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      opp.creatorName.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesGenre = genreFilter === "All" || opp.genre === genreFilter;
    const matchesSceneType = sceneTypeFilter === "All" || opp.sceneType === sceneTypeFilter;
    
    // Category matching: Podcasts requires BOTH fullscale platform AND Podcast genre
    // Other categories match by genre mapping or direct name match
    const matchesCategory = !selectedCategory ||
      (selectedCategory === "podcasts" && opp.platform === "fullscale" && opp.genre === "Podcast") ||
      (selectedCategory !== "podcasts" && (
        (categoryToGenreMap[selectedCategory]?.includes(opp.genre)) ||
        opp.genre?.toLowerCase() === selectedCategory.toLowerCase() ||
        opp.context.toLowerCase().includes(selectedCategory.toLowerCase())
      ));
    
    // Platform filter - Podcasts requires fullscale platform + Podcast genre
    let matchesPlatform = true;
    if (platformFilter !== "All") {
      if (platformFilter === "Podcasts") {
        matchesPlatform = opp.platform === "fullscale" && opp.genre === "Podcast";
      } else {
        const filterValue = platformFilter.toLowerCase();
        matchesPlatform = opp.platform === filterValue ||
          (opp.platforms?.includes(filterValue) ?? false);
      }
    }
    
    let matchesBudget = true;
    if (budgetFilter === "Under $50") matchesBudget = opp.sceneValue < 50;
    else if (budgetFilter === "$50-$100") matchesBudget = opp.sceneValue >= 50 && opp.sceneValue <= 100;
    else if (budgetFilter === "$100-$200") matchesBudget = opp.sceneValue > 100 && opp.sceneValue <= 200;
    else if (budgetFilter === "Over $200") matchesBudget = opp.sceneValue > 200;
    
    const matchesSubcategory = subcategoryFilter === "All" || opp.subcategory === subcategoryFilter;

    return matchesSearch && matchesGenre && matchesBudget && matchesSceneType && matchesCategory && matchesPlatform && matchesSubcategory;
  });

  // Derive available subcategories from the data
  const availableSubcategories = ["All", ...Array.from(new Set(allOpportunities.map(o => o.subcategory).filter(Boolean) as string[])).sort()];

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
          
          {/* Product Upload CTA */}
          <Card className="mb-4 border-emerald-500/20 bg-emerald-500/5">
            <CardContent className="py-3 px-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-white">Ready to place your product in creator videos?</p>
                <p className="text-xs text-muted-foreground">Upload product images to preview AI-powered placements</p>
              </div>
              <Button asChild size="sm" className="bg-emerald-600 hover:bg-emerald-500">
                <Link href="/brand-products">
                  <ShoppingCart className="w-3 h-3 mr-1" />
                  Product Catalog
                </Link>
              </Button>
            </CardContent>
          </Card>

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
                onClick={() => {
                  if (selectedCategory === "podcasts") setPlatformFilter("All");
                  setSelectedCategory(null);
                }}
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

            {availableSubcategories.length > 1 && (
              <Select value={subcategoryFilter} onValueChange={setSubcategoryFilter}>
                <SelectTrigger className="w-[150px]" data-testid="select-subcategory">
                  <Filter className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="Subcategory" />
                </SelectTrigger>
                <SelectContent>
                  {availableSubcategories.map((sub) => (
                    <SelectItem key={sub} value={sub}>{sub}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Featured Creators Section — always visible on both tabs */}
        {featuredCreators.length > 0 && (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-purple-400" />
                  Featured Creators
                </h2>
                <p className="text-sm text-white/60">Discover top creators with premium placement surfaces</p>
              </div>
              <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30">
                {featuredCreators.length} Creators
              </Badge>
            </div>
            {/* 2-row grid: 4 per row on desktop, 3 on tablet, 2 on mobile — shows up to 8 creators */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {featuredCreators.slice(0, 8).map((creator, idx) => (
                <motion.div
                  key={creator.slug}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.06 }}
                >
                  <Link href={`/c/${creator.slug}`}>
                    <Card className="group overflow-hidden cursor-pointer border-white/10 hover:border-purple-500/40 transition-all duration-300">
                      {/* Logo-card thumbnail. If the creator has uploaded a
                          real image (logo/JPEG/photo) it renders that.
                          Otherwise: per-creator gradient + initials, which
                          looks like a brand logo placeholder rather than a
                          generic stock photo. */}
                      <div className="relative aspect-video overflow-hidden">
                        {creator.thumbnails?.[0] ? (
                          <img
                            src={creator.thumbnails[0]}
                            alt={creator.name}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            onError={(e) => {
                              // Hide broken image so the gradient sibling shows through.
                              (e.target as HTMLImageElement).style.display = "none";
                            }}
                          />
                        ) : (
                          <div
                            className="w-full h-full flex items-center justify-center group-hover:scale-105 transition-transform duration-300"
                            style={{
                              background: `linear-gradient(135deg, ${gradientFor(creator)[0]} 0%, ${gradientFor(creator)[1]} 100%)`,
                            }}
                          >
                            <span className="text-5xl font-extrabold text-white/95 drop-shadow-md tracking-tight">
                              {initialsFor(creator.name)}
                            </span>
                          </div>
                        )}
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3">
                          <h3 className="font-semibold text-white text-sm truncate">{creator.name}</h3>
                          {creator.headline && (
                            <p className="text-[10px] text-white/70 truncate">{creator.headline}</p>
                          )}
                        </div>
                      </div>
                      {/* Category badge + view count */}
                      <div className="px-3 py-2 flex items-center justify-between">
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 bg-white/10 text-white/70 border-white/10">
                          {getCategory(creator)}
                        </Badge>
                        <span className="text-xs text-white/50 flex items-center gap-1">
                          <Eye className="w-3 h-3" />
                          {formatViews(creator.stats.totalViews)}
                        </span>
                      </div>
                    </Card>
                  </Link>
                </motion.div>
              ))}
            </div>
            <div className="border-b border-white/10 mt-6 mb-2" />
          </div>
        )}

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
                      if (category.id === "podcasts") {
                        setPlatformFilter("Podcasts");
                      }
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
                    className="relative overflow-hidden rounded-t-md cursor-pointer bg-black flex items-center justify-center"
                    style={{ minHeight: '160px' }}
                    onClick={() => setSelectedOpportunity(opportunity)}
                    data-testid={`thumbnail-opportunity-${opportunity.id}`}
                  >
                    {/* For fullscale/local videos: show video element to display actual content */}
                    {opportunity.videoUrl ? (
                      <video
                        src={opportunity.videoUrl}
                        className="w-full h-auto max-h-[240px] object-contain"
                        muted
                        playsInline
                        preload="metadata"
                        poster={(opportunity as any).thumbnailUrl || undefined}
                        onLoadedMetadata={(e) => {
                          // Seek to 1 second to show a meaningful frame
                          const vid = e.currentTarget;
                          vid.currentTime = 1;
                        }}
                      />
                    ) : (
                      <img
                        src={(opportunity as any).thumbnailUrl || (opportunity as any).thumbnail_url || `https://picsum.photos/seed/${opportunity.id}/640/360`}
                        alt={opportunity.title}
                        className="w-full h-auto max-h-[240px] object-contain"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${opportunity.id}/640/360`;
                        }}
                      />
                    )}
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
                            p === 'fullscale' ? 'bg-[#8B5CF6]' :
                            'bg-[#FF0000]'
                          }`}
                        >
                          {p === 'twitch' ? <SiTwitch className="w-2.5 h-2.5 text-white" /> :
                           p === 'facebook' ? <SiFacebook className="w-2.5 h-2.5 text-white" /> :
                           p === 'fullscale' ? <Mic className="w-2.5 h-2.5 text-white" /> :
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
                {/* Video player / thumbnail — flex container for natural aspect ratio */}
                <div className="relative rounded-lg overflow-hidden bg-black flex items-center justify-center" style={{ minHeight: '200px', maxHeight: '60vh' }}>
                  {selectedOpportunity.videoUrl ? (
                    <video
                      key={selectedOpportunity.id}
                      src={selectedOpportunity.videoUrl}
                      poster={selectedOpportunity.thumbnailUrl || undefined}
                      controls
                      className="w-full h-auto max-h-[60vh] object-contain"
                      playsInline
                      muted
                      autoPlay
                      onError={(e) => {
                        console.warn("[Marketplace] Video error:", e.currentTarget.error?.message);
                        // Hide video and show poster image instead
                        e.currentTarget.style.display = 'none';
                        const fallback = e.currentTarget.nextElementSibling as HTMLElement;
                        if (fallback) fallback.style.display = 'block';
                      }}
                    />
                  ) : null}
                  {/* Image fallback — shown if no video URL, or as hidden fallback if video fails */}
                  <img
                    src={selectedOpportunity.thumbnailUrl || `https://picsum.photos/seed/${selectedOpportunity.id}/1280/720`}
                    alt={selectedOpportunity.title}
                    className="w-full h-auto max-h-[60vh] object-contain"
                    style={{ display: selectedOpportunity.videoUrl ? 'none' : 'block' }}
                  />
                  <div className="absolute top-3 right-3 flex items-center gap-2">
                    {(selectedOpportunity.platforms || [selectedOpportunity.platform]).filter(Boolean).map((p) => (
                      <div
                        key={p}
                        className={`w-8 h-8 rounded-full flex items-center justify-center shadow-lg ${
                          p === 'twitch' ? 'bg-[#9146FF]' :
                          p === 'facebook' ? 'bg-[#1877F2]' :
                          p === 'fullscale' ? 'bg-[#8B5CF6]' :
                          'bg-[#FF0000]'
                        }`}
                      >
                        {p === 'twitch' ? <SiTwitch className="w-4 h-4 text-white" /> :
                         p === 'facebook' ? <SiFacebook className="w-4 h-4 text-white" /> :
                         p === 'fullscale' ? <Mic className="w-4 h-4 text-white" /> :
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
                      {selectedOpportunity.creatorSlug ? (
                        <Link href={`/c/${selectedOpportunity.creatorSlug}`} onClick={() => setSelectedOpportunity(null)}>
                          <p className="font-semibold text-purple-400 hover:text-purple-300 cursor-pointer transition-colors">
                            {selectedOpportunity.creatorName}
                          </p>
                        </Link>
                      ) : (
                        <p className="font-semibold">{selectedOpportunity.creatorName}</p>
                      )}
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-muted-foreground">Creator</p>
                        {selectedOpportunity.creatorSlug && (
                          <Link href={`/c/${selectedOpportunity.creatorSlug}`} onClick={() => setSelectedOpportunity(null)}>
                            <span className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer transition-colors flex items-center gap-0.5">
                              View Portfolio <ExternalLink className="w-3 h-3" />
                            </span>
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Eye className="w-4 h-4" />
                      <span>{formatViewCount(selectedOpportunity.viewCount)}</span>
                    </div>
                    <Badge variant="outline">{selectedOpportunity.genre}</Badge>
                    {selectedOpportunity.subcategory && (
                      <Badge variant="outline" className="border-purple-500/30 text-purple-400">{selectedOpportunity.subcategory}</Badge>
                    )}
                  </div>
                </div>

                {/* Placement Opportunities Section */}
                <div className="bg-card rounded-lg border p-4">
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary" />
                    Placement Opportunities
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    {/* Deduplicate surfaces — show unique types only */}
                    {Array.from(new Set(selectedOpportunity.surfaces)).map((surface, idx) => (
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

                {/* Viral Clips Section — Editorial Intelligence for brands */}
                <div className="bg-card rounded-lg border p-4">
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-primary" />
                    Viral Clips
                  </h3>
                  <p className="text-xs text-muted-foreground mb-3">
                    AI-ranked clips with viral potential — buy placements in premium moments.
                  </p>
                  <EditorialClips
                    videoId={selectedOpportunity.videoId}
                    mode="brand"
                    onBuyPlacement={(clip) => {
                      toast({
                        title: "Placement Request",
                        description: `Requesting placement in "${clip.suggestedTitle}" (${clip.monetizationTier} tier)`,
                      });
                      // Use the existing buy mutation with clip context
                      buyMutation.mutate({
                        ...selectedOpportunity,
                        sceneValue: clip.monetizationTier === "premium"
                          ? selectedOpportunity.sceneValue * 1.5
                          : selectedOpportunity.sceneValue,
                      });
                    }}
                  />
                </div>

                {/* Price and Actions */}
                <div className="flex items-center justify-between p-4 bg-primary/5 rounded-lg border border-primary/20">
                  <div>
                    <p className="text-sm text-muted-foreground">Placement Value</p>
                    <p className="text-3xl font-bold text-emerald-500">${selectedOpportunity.sceneValue}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedOpportunity.videoUrl && (
                      <Button
                        size="lg"
                        variant="outline"
                        className="gap-2"
                        onClick={() => {
                          window.location.href = `/remix/${selectedOpportunity.videoId}`;
                        }}
                        data-testid="button-place-product"
                      >
                        <Palette className="w-5 h-5" />
                        Place Product
                      </Button>
                    )}
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
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
