import { useState, useEffect } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { TopBar } from "@/components/TopBar";
import { Video, Youtube, CheckCircle, Unlink, TrendingUp, Gavel, BarChart3, Loader2, ToggleLeft, ToggleRight, Link2, RefreshCw, Globe, Copy, ExternalLink } from "lucide-react";
import { SiFacebook, SiInstagram } from "react-icons/si";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { useHybridMode } from "@/hooks/use-hybrid-mode";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UploadModal } from "@/components/UploadModal";
import { YouTubeVideoPicker } from "@/components/YouTubeVideoPicker";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AnalyticsOverview } from "@/components/AnalyticsOverview";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { SceneAnalysisModal, VideoWithScenes } from "@/components/SceneAnalysisModal";
import { useLocation } from "wouter";
import { Switch } from "@/components/ui/switch";
import { usePitchMode } from "@/contexts/pitch-mode-context";

// Super admin is the only one who can toggle Demo Mode
const SUPER_ADMIN_EMAIL = "martin@gofullscale.co";

const ADMIN_EMAILS = [
  "martin@gofullscale.co",
  "martin@whtwrks.com",
  "martincekechukwu@gmail.com",
];

interface YoutubeStatus {
  connected: boolean;
  channelId?: string;
  channelTitle?: string;
}

interface YoutubeChannel {
  connected: boolean;
  channelId?: string;
  title?: string;
  description?: string;
  profilePictureUrl?: string;
  subscriberCount?: string;
  videoCount?: string;
  viewCount?: string;
}

interface IndexedVideo {
  id: number;
  userId: string;
  youtubeId: string;
  title: string;
  description: string | null;
  viewCount: number;
  thumbnailUrl: string | null;
  status: string;
  priorityScore: number;
  publishedAt: string | null;
  category: string | null;
  isEvergreen: boolean | null;
  duration: string | null;
  adOpportunities?: number;
  editorialStatus?: string | null;
}

// Returns true if a video has work in flight that the UI should poll to track.
// Used to throttle dashboard polling when everything is settled.
function isVideoInProgress(v: IndexedVideo): boolean {
  if (v.status === "Pending Scan" || v.status === "Scanning") return true;
  const ed = v.editorialStatus;
  if (ed === "queued" || ed === "transcribing" || ed === "analyzing" || ed === "rendering" || ed === "processing") return true;
  return false;
}

interface VideoIndexResponse {
  videos: IndexedVideo[];
  total: number;
}

const demoCampaigns = [
  { brand: "Sony", content: "Vlog #42", status: "Active", amount: "$2,400", statusColor: "bg-emerald-500/20 text-emerald-400" },
  { brand: "Nike", content: "Training Montage", status: "Bidding", amount: "$850", statusColor: "bg-orange-500/20 text-orange-400" },
  { brand: "Squarespace", content: "Tech Review", status: "Paid", amount: "$1,200", statusColor: "bg-blue-500/20 text-blue-400" },
  { brand: "Coca-Cola", content: "Summer Vlog", status: "Pending", amount: "$3,100", statusColor: "bg-yellow-500/20 text-yellow-400" },
];

// Real brand-placement campaigns for the creator (replaces the pitch-mode
// demo table in real mode — previously real users had no campaigns surface
// on the dashboard at all; the data lived only in /inbox).
function RealBrandCampaigns() {
  const { toast } = useToast();
  const { data: pending } = useQuery<{ placements: any[] }>({
    queryKey: ["/api/creator/placements/inbox", "pending_creator_review"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/creator/placements/inbox?status=pending_creator_review", { credentials: "include" });
      if (!res.ok) return { placements: [] };
      return res.json();
    },
    refetchInterval: 30_000,
  });
  const { data: approved } = useQuery<{ placements: any[] }>({
    queryKey: ["/api/creator/placements/inbox", "creator_approved"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/creator/placements/inbox?status=creator_approved,pending_brand_review,brand_approved", { credentials: "include" });
      if (!res.ok) return { placements: [] };
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const rows = [
    ...(pending?.placements ?? []).map((p: any) => ({ ...p, _kind: "pending" })),
    ...(approved?.placements ?? []).map((p: any) => ({ ...p, _kind: "active" })),
  ].slice(0, 6);

  if (rows.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3 }}
      className="bg-white/5 rounded-xl border border-white/5 overflow-hidden"
    >
      <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
        <p className="text-sm font-semibold text-white">Brand Campaigns</p>
        <a href="/inbox" className="text-xs text-primary hover:underline">Open inbox →</a>
      </div>
      <div className="divide-y divide-white/5">
        {rows.map((p: any) => (
          <div key={`${p._kind}-${p.id}`} className="px-6 py-4 flex flex-wrap items-center justify-between gap-3" data-testid={`row-real-campaign-${p.id}`}>
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-semibold text-white truncate">{p.product?.name || `Product #${p.brandProductId}`}</span>
              <span className="text-muted-foreground text-sm truncate">{p.video?.title || `Video #${p.videoId}`}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                p._kind === "pending" ? "bg-amber-500/15 text-amber-400" : "bg-emerald-500/15 text-emerald-400"
              }`}>
                {p._kind === "pending" ? "Needs review" : p.status === "brand_approved" ? "Live" : "Active"}
              </span>
              {p.status === "brand_approved" && (
                <button
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                  data-testid={`release-link-${p.id}`}
                  onClick={async () => {
                    // Open synchronously so Safari doesn't popup-block the
                    // navigation that follows the awaited fetch.
                    const w = window.open("about:blank", "_blank");
                    if (w) w.opener = null;
                    try {
                      const res = await fetchWithTimeout(`/api/placements/${p.id}/release-link`, { credentials: "include" });
                      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Unavailable");
                      const rel = await res.json();
                      if (w) w.location.href = rel.url;
                      else window.open(rel.url, "_blank", "noopener");
                    } catch (err: any) {
                      w?.close();
                      toast({ title: "Release page unavailable", description: err.message, variant: "destructive" });
                    }
                  }}
                >
                  <ExternalLink className="w-3 h-3" /> Release page
                </button>
              )}
              <span className="font-semibold text-white">
                {p.creatorPayoutCents ? `$${(p.creatorPayoutCents / 100).toFixed(2)}` : ""}
              </span>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}


const chartData = [
  { month: "Aug", height: "45%", revenue: "$8.2k" },
  { month: "Sep", height: "72%", revenue: "$12.4k" },
  { month: "Oct", height: "58%", revenue: "$9.8k" },
  { month: "Nov", height: "85%", revenue: "$14.1k" },
  { month: "Dec", height: "68%", revenue: "$11.6k" },
];

// Simulation mode data for investor pitches
const simulationStats = {
  revenue: "$14,850",
  revenueGrowth: "+18% this month",
  activeBids: "12",
  avgCpm: "$35.00",
  globalReach: "12 Markets",
};

// Static demo videos for pitch mode - 12 unique creator space images (no duplicates)
// Themes: minimalist desks, empty kitchen counters, podcast studios, living rooms, gaming setups
const STATIC_DEMO_VIDEOS: IndexedVideo[] = [
  { id: 1001, userId: "demo", youtubeId: "demo-1", title: "Minimalist Desk Setup 2026", description: "The ultimate clean workspace", viewCount: 1250000, thumbnailUrl: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=640&h=360&fit=crop", status: "Scan Complete", priorityScore: 95, publishedAt: "2025-12-01", category: "Tech", isEvergreen: true, duration: "12:34", adOpportunities: 8 },
  { id: 1002, userId: "demo", youtubeId: "demo-2", title: "Modern Kitchen Counter Tour", description: "Clean countertop perfection", viewCount: 890000, thumbnailUrl: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=640&h=360&fit=crop", status: "Scan Complete", priorityScore: 78, publishedAt: "2025-11-15", category: "Lifestyle", isEvergreen: true, duration: "8:45", adOpportunities: 6 },
  { id: 1003, userId: "demo", youtubeId: "demo-3", title: "Podcast Studio Setup", description: "Professional audio space", viewCount: 2100000, thumbnailUrl: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=640&h=360&fit=crop", status: "Scan Complete", priorityScore: 92, publishedAt: "2025-10-20", category: "Tech", isEvergreen: true, duration: "15:22", adOpportunities: 11 },
  { id: 1004, userId: "demo", youtubeId: "demo-4", title: "Living Room Coffee Table Ideas", description: "Style your living space", viewCount: 675000, thumbnailUrl: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=640&h=360&fit=crop", status: "Scan Complete", priorityScore: 65, publishedAt: "2025-09-10", category: "Lifestyle", isEvergreen: true, duration: "10:15", adOpportunities: 5 },
  { id: 1005, userId: "demo", youtubeId: "demo-5", title: "Ultimate Gaming Setup Tour", description: "RGB battlestation complete", viewCount: 1450000, thumbnailUrl: "https://images.unsplash.com/photo-1616588589676-62b3bd4ff6d2?w=640&h=360&fit=crop", status: "Scan Complete", priorityScore: 88, publishedAt: "2025-08-25", category: "Gaming", isEvergreen: true, duration: "18:30", adOpportunities: 9 },
  { id: 1006, userId: "demo", youtubeId: "demo-6", title: "Home Office Transformation", description: "WFH space makeover", viewCount: 320000, thumbnailUrl: "https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=640&h=360&fit=crop", status: "Scan Complete", priorityScore: 55, publishedAt: "2025-07-18", category: "DIY", isEvergreen: true, duration: "6:30", adOpportunities: 4 },
  { id: 1007, userId: "demo", youtubeId: "demo-7", title: "Streaming Room Tour 2026", description: "Twitch setup revealed", viewCount: 540000, thumbnailUrl: "https://images.unsplash.com/photo-1603481588273-2f908a9a7a1b?w=640&h=360&fit=crop", status: "Scan Complete", priorityScore: 72, publishedAt: "2025-06-22", category: "Gaming", isEvergreen: true, duration: "14:17", adOpportunities: 9 },
  { id: 1008, userId: "demo", youtubeId: "demo-8", title: "Kitchen Island Styling", description: "Modern kitchen aesthetics", viewCount: 410000, thumbnailUrl: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=640&h=360&fit=crop", status: "Scan Complete", priorityScore: 68, publishedAt: "2025-05-30", category: "Lifestyle", isEvergreen: true, duration: "11:45", adOpportunities: 7 },
  { id: 1009, userId: "demo", youtubeId: "demo-9", title: "Cozy Reading Nook Setup", description: "Perfect book corner", viewCount: 980000, thumbnailUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=640&h=360&fit=crop", status: "Scan Complete", priorityScore: 85, publishedAt: "2025-04-15", category: "Lifestyle", isEvergreen: true, duration: "16:42", adOpportunities: 6 },
  { id: 1010, userId: "demo", youtubeId: "demo-10", title: "Clean Workspace Tour", description: "Productivity desk setup", viewCount: 275000, thumbnailUrl: "https://images.unsplash.com/photo-1593642702821-c8da6771f0c6?w=640&h=360&fit=crop", status: "Scan Complete", priorityScore: 52, publishedAt: "2025-03-28", category: "Tech", isEvergreen: true, duration: "9:18", adOpportunities: 3 },
  { id: 1011, userId: "demo", youtubeId: "demo-11", title: "Studio Apartment Tour", description: "Small space big style", viewCount: 1680000, thumbnailUrl: "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=640&h=360&fit=crop", status: "Scan Complete", priorityScore: 91, publishedAt: "2025-02-20", category: "Vlog", isEvergreen: true, duration: "13:55", adOpportunities: 10 },
  { id: 1012, userId: "demo", youtubeId: "demo-12", title: "Modern Bedroom Setup", description: "Aesthetic room design", viewCount: 520000, thumbnailUrl: "https://images.unsplash.com/photo-1616594039964-ae9021a400a0?w=640&h=360&fit=crop", status: "Scan Complete", priorityScore: 63, publishedAt: "2025-01-12", category: "Lifestyle", isEvergreen: true, duration: "11:20", adOpportunities: 5 },
];

interface MarketplaceStats {
  videosWithOpportunities: number;
  totalSurfaces: number;
  activeBids: number;
}

interface PlatformAuthStatus {
  twitch: { configured: boolean; connected: boolean };
  facebook: { configured: boolean; connected: boolean; pageName?: string; followers?: number };
  instagram: { configured: boolean; connected: boolean; handle?: string; followers?: number };
}

function formatReach(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(0)}K`;
  return count.toString();
}

// Sync button component with proper React Query mutation and toast feedback
function SyncSocialButton() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/sync/facebook-instagram', { 
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Sync failed');
      }
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: "Content synced",
        description: data.message,
      });
      // Invalidate video queries to refresh the library
      queryClient.invalidateQueries({ queryKey: ['/api/video-index'] });
      queryClient.invalidateQueries({ queryKey: ['/api/video-index/with-opportunities'] });
    },
    onError: (error: Error) => {
      toast({
        title: "Sync failed",
        description: error.message,
        variant: "destructive",
      });
    }
  });

  return (
    <Button
      onClick={() => syncMutation.mutate()}
      disabled={syncMutation.isPending}
      data-testid="button-sync-social"
      className="w-full justify-start"
    >
      <RefreshCw className={`w-4 h-4 mr-2 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
      {syncMutation.isPending ? 'Syncing...' : 'Sync Facebook & Instagram Content'}
    </Button>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { mode, isAuthenticated: isGoogleAuthenticated, googleUser } = useHybridMode();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [youtubePickerOpen, setYoutubePickerOpen] = useState(false);
  const [sceneModalOpen, setSceneModalOpen] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<VideoWithScenes | null>(null);
  const [, setLocation] = useLocation();
  const [isSimulatingConnect, setIsSimulatingConnect] = useState(false);
  const [simulatedConnected, setSimulatedConnected] = useState(false);
  
  // Use global pitch mode context for simulation toggle
  const { isPitchMode, setPitchMode } = usePitchMode();

  // Portfolio data
  const { data: userTypeData } = useQuery<{ slug?: string | null; name?: string | null }>({
    queryKey: ["/api/auth/user-type"],
  });
  const [copiedLink, setCopiedLink] = useState(false);

  const handleVideoClick = async (video: IndexedVideo) => {
    // For all videos (including pitch mode), fetch actual detected surfaces from backend
    const rawThumbnail = (video as IndexedVideo & { thumbnailUrl?: string }).thumbnailUrl || "";
    const videoThumbnail = (rawThumbnail.startsWith('http') || rawThumbnail.startsWith('/')) ? rawThumbnail : "";

    // Normalize frame URLs from DB (may have absolute Replit paths or ./public/ prefixes)
    const normalizeFrameUrl = (url: string | null | undefined): string | null => {
      if (!url) return null;
      let src = url;
      src = src.replace(/^\/home\/runner\/workspace\/public\//, '/');
      src = src.replace(/^\.\/public\//, '/');
      src = src.replace(/^public\//, '/');
      src = src.replace(/\/\//g, '/');
      if (!src.startsWith('/') && !src.startsWith('http')) src = '/' + src;
      return src;
    };

    try {
      // Owner viewing their own dashboard — show all surfaces, not just
      // creatorApproved=true. Without this, freshly scanned videos look
      // empty because every new surface defaults to unapproved.
      const res = await fetchWithTimeout(`/api/video/${video.id}/surfaces?includeUnapproved=true`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        
        interface DetectedSurface {
          id: number;
          videoId: number;
          timestamp: string;
          surfaceType: string;
          confidence: string;
          frameUrl: string | null;
          boundingBoxX: string;
          boundingBoxY: string;
          boundingBoxWidth: string;
          boundingBoxHeight: string;
        }
        
        // Transform detected surfaces to Scene format with proper type handling
        const realScenes = data.surfaces.length > 0 
          ? data.surfaces.map((surface: DetectedSurface, index: number) => {
              const confidenceNum = parseFloat(surface.confidence) || 0.8;
              const timestamp = parseFloat(surface.timestamp) || 0;
              const minutes = Math.floor(timestamp / 60);
              const seconds = Math.floor(timestamp % 60);
              const timestampStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
              
              return {
                id: `${video.id}-${index}`,
                timestamp: timestampStr,
                imageUrl: normalizeFrameUrl(surface.frameUrl) || videoThumbnail,
                surfaces: 1,
                surfaceTypes: [surface.surfaceType || "Surface"],
                context: `Detected ${surface.surfaceType || 'surface'} in video`,
                confidence: Math.round(confidenceNum * 100),
              };
            })
          : [{
              id: `${video.id}-placeholder`,
              timestamp: "00:00",
              imageUrl: videoThumbnail,
              surfaces: 0,
              surfaceTypes: ["No surfaces detected yet"],
              context: "Click 'Scan Analysis' to detect placement surfaces",
              confidence: 0,
            }];
        
        setSelectedVideo({
          id: video.id,
          title: video.title,
          duration: video.duration || "10:00",
          viewCount: video.viewCount,
          scenes: realScenes,
        });
      } else {
        // Fallback: show video info without demo data
        setSelectedVideo({
          id: video.id,
          title: video.title,
          duration: video.duration || "10:00",
          viewCount: video.viewCount,
          scenes: [{
            id: `${video.id}-placeholder`,
            timestamp: "00:00",
            imageUrl: videoThumbnail,
            surfaces: 0,
            surfaceTypes: ["Scan needed"],
            context: "Click 'Scan Analysis' to detect placement surfaces",
            confidence: 0,
          }],
        });
      }
    } catch (err) {
      console.error("[Dashboard] Failed to fetch surfaces:", err);
      // Use video thumbnail as placeholder, NOT demo data
      setSelectedVideo({
        id: video.id,
        title: video.title,
        duration: video.duration || "10:00",
        viewCount: video.viewCount,
        scenes: [{
          id: `${video.id}-placeholder`,
          timestamp: "00:00",
          imageUrl: videoThumbnail,
          surfaces: 0,
          surfaceTypes: ["Scan needed"],
          context: "Click 'Scan Analysis' to detect placement surfaces",
          confidence: 0,
        }],
      });
    }
    setSceneModalOpen(true);
  };

  // When pitch mode changes, immediately update the video data (no API delay)
  useEffect(() => {
    console.log(`[Dashboard] isPitchMode changed to: ${isPitchMode}`);
    if (isPitchMode) {
      // Immediately set demo videos in cache - no async wait needed
      queryClient.setQueryData(["dashboard-videos", true, mode], {
        videos: STATIC_DEMO_VIDEOS,
        total: STATIC_DEMO_VIDEOS.length
      });
      console.log(`[Dashboard] Set ${STATIC_DEMO_VIDEOS.length} demo videos in cache`);
    } else {
      // Invalidate cache to refetch real data
      queryClient.invalidateQueries({ queryKey: ["dashboard-videos"] });
    }
  }, [isPitchMode, queryClient, mode]);

  const isDemoMode = mode === "demo";
  // PRIORITY: isPitchMode toggle is checked FIRST - overrides authentication state
  const isRealMode = !isPitchMode && mode === "real";
  
  // Super admin check - only super admin can toggle simulation mode
  const currentUserEmail = googleUser?.email || user?.email || "";
  const isSuperAdmin = currentUserEmail.toLowerCase() === SUPER_ADMIN_EMAIL;
  const isAdmin = ADMIN_EMAILS.includes(currentUserEmail.toLowerCase());
  
  // Non-super-admins are forced to real mode (simulationModeOverride stays false)
  
  // Simulation mode: admin override forces demo view even when authenticated
  const showSimulationData = isPitchMode;

  const { data: youtubeStatus, isLoading: isCheckingYoutube } = useQuery<YoutubeStatus>({
    queryKey: ["/api/auth/youtube/status", isPitchMode],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/auth/youtube/status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch YouTube status");
      return res.json();
    },
    enabled: isRealMode,
  });

  const { data: channelData, isLoading: isLoadingChannel } = useQuery<YoutubeChannel>({
    queryKey: ["/api/youtube/channel", isPitchMode],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/youtube/channel", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch channel data");
      return res.json();
    },
    enabled: isRealMode && !!youtubeStatus?.connected,
  });

  const { data: videoIndexData, isLoading: isLoadingVideoIndex } = useQuery<VideoIndexResponse>({
    queryKey: ["dashboard-videos", isPitchMode, mode] as const,
    queryFn: async ({ queryKey }) => {
      // Extract isPitchMode from queryKey to avoid stale closure
      const [, pitchModeFromKey] = queryKey;
      
      // PITCH MODE: Return static demo data immediately (no API call)
      if (pitchModeFromKey) {
        console.log(`[Dashboard] Returning ${STATIC_DEMO_VIDEOS.length} static demo videos (pitch mode)`);
        return { videos: STATIC_DEMO_VIDEOS, total: STATIC_DEMO_VIDEOS.length };
      }
      
      // REAL MODE: Fetch from API
      const endpoint = "/api/video-index/with-opportunities";
      console.log(`[Dashboard] Fetching videos from ${endpoint}`);
      const res = await fetch(endpoint, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch video index");
      return res.json();
    },
    enabled: isPitchMode || (isRealMode && !!youtubeStatus?.connected),
    // Adaptive polling: 5s when any video has work in flight (scan/render),
    // 60s when everything is settled. Cuts idle traffic ~12× while preserving
    // responsiveness during active scans and editorial pipelines.
    refetchInterval: isPitchMode ? undefined : (query) => {
      const data = query.state.data as VideoIndexResponse | undefined;
      if (!data?.videos) return 5000;
      return data.videos.some(isVideoInProgress) ? 5000 : 60000;
    },
    staleTime: 0,
  });

  const { data: marketplaceStats } = useQuery<MarketplaceStats>({
    queryKey: ["/api/marketplace/stats", isPitchMode],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/marketplace/stats", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch marketplace stats");
      return res.json();
    },
    enabled: isRealMode && !!youtubeStatus?.connected,
    refetchInterval: 10000,
  });

  // Fetch social platform stats for Total Reach calculation
  const { data: platformStats } = useQuery<PlatformAuthStatus>({
    queryKey: ["/api/platform-auth/status"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/platform-auth/status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch platform status");
      return res.json();
    },
    refetchOnMount: true,
  });

  const indexedVideos = videoIndexData?.videos || [];
  
  // DEBUG: Log video data state
  console.log(`[Dashboard RENDER] isPitchMode: ${isPitchMode}, indexedVideos.length: ${indexedVideos.length}, videoIndexData:`, videoIndexData);
  
  // Calculate Total Reach from connected social platforms
  const calculateTotalReach = (): string => {
    let totalFollowers = 0;
    
    // Add YouTube subscribers if connected
    if (channelData?.subscriberCount) {
      totalFollowers += parseInt(channelData.subscriberCount, 10) || 0;
    }
    
    // Add Facebook followers if connected
    if (platformStats?.facebook?.followers) {
      totalFollowers += platformStats.facebook.followers;
    }
    
    // Add Instagram followers if connected
    if (platformStats?.instagram?.followers) {
      totalFollowers += platformStats.instagram.followers;
    }
    
    if (totalFollowers > 0) {
      return formatReach(totalFollowers);
    }
    
    // Fallback to video count as markets
    if (indexedVideos.length > 0) {
      return `${indexedVideos.length} Videos`;
    }
    
    return "--";
  };
  
  const realModeStats = {
    revenue: "$0",
    revenueGrowth: "Connect to track",
    activeBids: String(marketplaceStats?.activeBids || 0),
    avgCpm: "--",
    globalReach: calculateTotalReach(),
  };
  
  const displayStats = showSimulationData ? simulationStats : realModeStats;

  const scanMutation = useMutation({
    mutationFn: async (videoId: number) => {
      const res = await fetchWithTimeout(`/api/video-scan/${videoId}`, { 
        method: "POST", 
        credentials: "include" 
      });
      if (!res.ok) throw new Error("Failed to start scan");
      return res.json();
    },
    onSuccess: (_, videoId) => {
      toast({ title: "Scan Started", description: "Analyzing video for ad opportunities..." });
      queryClient.invalidateQueries({ queryKey: ["/api/video-index/with-opportunities"] });
    },
    onError: () => {
      toast({ title: "Scan Failed", description: "Could not start video analysis.", variant: "destructive" });
    },
  });

  const batchScanMutation = useMutation({
    mutationFn: async () => {
      const res = await fetchWithTimeout("/api/video-scan/batch", { 
        method: "POST", 
        credentials: "include" 
      });
      if (!res.ok) throw new Error("Failed to start batch scan");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Batch Scan Started", description: "Analyzing pending videos for ad opportunities..." });
    },
    onError: () => {
      toast({ title: "Scan Failed", description: "Could not start batch scan.", variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetchWithTimeout("/api/auth/youtube", { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Failed to disconnect");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/youtube/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/youtube/channel"] });
      queryClient.invalidateQueries({ queryKey: ["/api/youtube/videos"] });
      toast({ title: "YouTube Disconnected", description: "Your channel has been unlinked." });
    },
  });

  const syncYouTubeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetchWithTimeout("/api/youtube/sync", { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error("Failed to sync");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/youtube/videos"] });
      toast({ 
        title: "Videos Synced", 
        description: `Imported ${data.imported} videos from your YouTube channel.` 
      });
    },
    onError: () => {
      toast({ title: "Sync Failed", description: "Could not sync YouTube videos.", variant: "destructive" });
    },
  });

  // Post-connect import choice: "Import all" vs "Let me pick" — previously
  // the connect flow just toasted and the user had to find the import
  // button themselves.
  const [importChoiceOpen, setImportChoiceOpen] = useState(false);
  // The OAuth callback appends youtube_connected on EVERY round-trip,
  // reconnects included — and "Import all" resets already-scanned videos to
  // "Pending Scan". Defer the dialog until the library query settles and only
  // prompt when it's actually empty (first connect).
  const [importChoicePending, setImportChoicePending] = useState(false);

  // Facebook post-connect: the creator confirms WHICH managed Page (and its
  // linked Instagram account) to connect — never auto-picked.
  const [pageSelectOpen, setPageSelectOpen] = useState(false);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const { data: fbPages, isLoading: fbPagesLoading, isError: fbPagesError, error: fbPagesErrorObj } = useQuery<{
    currentPageId: string | null;
    pages: Array<{ pageId: string; name: string; followers: number; pictureUrl: string | null; instagram: { id: string; handle: string | null; followers: number; pictureUrl: string | null } | null }>;
    igOnly: Array<{ id: string; handle: string; followers: number; pictureUrl: string | null }>;
  }>({
    queryKey: ["/api/facebook/pages"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/facebook/pages", { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to list Pages");
      return res.json();
    },
    enabled: pageSelectOpen,
  });
  const confirmPageMutation = useMutation({
    mutationFn: async (target: { pageId?: string; igAccountId?: string }) => {
      const res = await fetchWithTimeout("/api/facebook/select-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(target),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to connect");
      return res.json();
    },
    onSuccess: (data: any) => {
      setPageSelectOpen(false);
      toast({
        title: data.page ? `Connected: ${data.page.name}` : `Connected: ${data.instagram?.handle || "Instagram"}`,
        description: data.page
          ? (data.instagram?.handle
              ? `Linked Instagram ${data.instagram.handle} is connected too — analytics will start flowing.`
              : "Page connected. No linked Instagram professional account was found on this Page.")
          : "Instagram connected. Link a Facebook Page later to add Page-level analytics.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/platform-auth/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/social-accounts"] });
    },
    onError: (err: any) => {
      toast({ title: "Couldn't connect", description: err.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("youtube_connected") === "true") {
      toast({ title: "YouTube Connected!", description: "Your channel is now linked." });
      // Clean URL while staying on dashboard
      window.history.replaceState({}, "", "/dashboard");
      queryClient.invalidateQueries({ queryKey: ["/api/auth/youtube/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/youtube/channel"] });
      queryClient.invalidateQueries({ queryKey: ["/api/youtube/videos"] });
      setImportChoicePending(true);
    }
    if (params.get("facebook_connected") === "true") {
      window.history.replaceState({}, "", "/dashboard");
      setPageSelectOpen(true);
    }
    if (params.get("youtube_error")) {
      const errorMsg = decodeURIComponent(params.get("youtube_error") || "An error occurred.");
      toast({ title: "Connection Failed", description: errorMsg, variant: "destructive" });
      // Clean URL while staying on dashboard
      window.history.replaceState({}, "", "/dashboard");
    }
  }, [toast, queryClient]);

  useEffect(() => {
    // videoIndexData === undefined means the query hasn't RUN yet (it stays
    // disabled until youtubeStatus resolves, and a disabled query reports
    // isLoading=false in react-query v5) — deciding then would re-open the
    // dialog on every reconnect. Wait for a real response; an empty library
    // comes back as {videos: []}, not undefined.
    if (!importChoicePending || isLoadingVideoIndex || videoIndexData === undefined) return;
    setImportChoicePending(false);
    if ((videoIndexData.videos || []).length === 0) {
      setImportChoiceOpen(true);
    }
    // Non-empty library: a reconnect — the Sync button covers deliberate
    // re-imports without prompting a destructive default.
  }, [importChoicePending, isLoadingVideoIndex, videoIndexData]);

  const handleConnect = () => {
    // If not logged in via Google OAuth, redirect to Google login first
    if (!isGoogleAuthenticated) {
      window.location.href = "/api/auth/google";
      return;
    }
    window.location.href = "/api/auth/youtube";
  };

  const handleSimulatedConnect = () => {
    setIsSimulatingConnect(true);
    setTimeout(() => {
      setIsSimulatingConnect(false);
      setSimulatedConnected(true);
      toast({
        title: "Success",
        description: "Imported 45 Videos from YouTube.",
      });
    }, 2500);
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate();
  };

  const videoCount = channelData?.videoCount ? parseInt(channelData.videoCount, 10) : 0;
  const isConnected = youtubeStatus?.connected || false;
  const hasRealData = isRealMode && isConnected && videoCount > 0;
  const showDemoMode = isDemoMode || !hasRealData;
  
  const displayName = isRealMode && googleUser?.name 
    ? googleUser.name.split(" ")[0] 
    : user?.firstName || "Creator";

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <TopBar />

      <main className="p-8 max-w-7xl mx-auto relative">
        {/* Super-Admin-only Simulation Toggle */}
        {isSuperAdmin && (
          <div className="absolute top-8 right-8 flex items-center gap-3 z-20">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card border border-border">
              <span className="text-xs text-muted-foreground">Real Data</span>
              <Switch
                checked={isPitchMode}
                onCheckedChange={setPitchMode}
                data-testid="switch-simulation-mode"
              />
              <span className="text-xs text-muted-foreground">Pitch Mode</span>
            </div>
            {isPitchMode && (
              <div className="px-3 py-1 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-400 text-xs font-bold uppercase tracking-wider">
                Simulation
              </div>
            )}
          </div>
        )}
        
        {/* Demo Mode badge — ONLY when demo content is actually active.
            It used to also key on !hasRealData, which stamped "DEMO MODE"
            on every freshly-approved creator's real (empty) dashboard —
            the worst possible first impression. */}
        {!isSuperAdmin && isDemoMode && (
          <div className="absolute top-8 right-8 px-3 py-1 rounded-full bg-primary/20 border border-primary/40 text-primary text-xs font-bold uppercase tracking-wider z-10">
            Demo Mode
          </div>
        )}

        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <p className="text-xs uppercase tracking-widest text-muted-foreground mb-2 font-medium">The Command Center</p>
          <h1 className="text-3xl font-bold font-display mb-2" data-testid="text-welcome">
            Welcome back, {displayName}
          </h1>
          <p className="text-muted-foreground">Here's what's happening with your content today.</p>
        </motion.div>

        <OnboardingChecklist />

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8"
        >
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Revenue</p>
            </div>
            <p className="text-3xl font-bold text-emerald-400" data-testid="text-revenue">{displayStats.revenue}</p>
            <p className="text-xs text-emerald-400/80 mt-1">{displayStats.revenueGrowth}</p>
          </div>
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <Gavel className="w-4 h-4 text-orange-400" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Active Bids</p>
            </div>
            <p className="text-3xl font-bold text-white" data-testid="text-bids">{displayStats.activeBids}</p>
            {showSimulationData && (
              <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400 text-xs font-medium">Hot</span>
            )}
          </div>
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 className="w-4 h-4 text-blue-400" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Avg. CPM</p>
            </div>
            <p className="text-3xl font-bold text-white" data-testid="text-cpm">{displayStats.avgCpm}</p>
            {showSimulationData && (
              <p className="text-xs text-muted-foreground/60 mt-1">Industry avg: $22</p>
            )}
          </div>
          <div className="bg-white/5 rounded-xl p-5 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <Video className="w-4 h-4 text-primary" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Reach</p>
            </div>
            <p className="text-3xl font-bold text-white" data-testid="text-inventory">{displayStats.globalReach}</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              {showSimulationData 
                ? "Active in US, MENA, APAC" 
                : (platformStats?.facebook?.connected || platformStats?.instagram?.connected 
                    ? "Combined social followers" 
                    : "Connect accounts to track")}
            </p>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            {showSimulationData ? (
              <>
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="bg-white/5 rounded-xl p-6 border border-white/5"
                >
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-semibold text-white">Revenue Velocity</p>
                    <span className="text-xs text-emerald-400 font-medium">Last 5 months</span>
                  </div>
                  <div className="flex items-end gap-1 md:gap-2" style={{ height: '200px' }}>
                    {chartData.map((bar) => (
                      <div key={bar.month} className="flex-1 flex flex-col items-center group relative h-full">
                        <div className="absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 bg-white text-black text-xs font-semibold rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none">
                          {bar.revenue}
                        </div>
                        <div className="flex-1 w-full flex items-end">
                          <div 
                            className="w-full bg-gradient-to-t from-primary/50 via-primary to-red-400 rounded-t-sm transition-all duration-300 group-hover:from-primary/70 group-hover:via-primary group-hover:to-red-300 cursor-pointer min-h-[4px]" 
                            style={{ height: bar.height }}
                          />
                        </div>
                        <span className="text-[10px] md:text-xs text-muted-foreground mt-2 shrink-0">{bar.month}</span>
                      </div>
                    ))}
                  </div>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="bg-white/5 rounded-xl border border-white/5 overflow-hidden"
                >
                  <div className="px-6 py-4 border-b border-white/5">
                    <p className="text-sm font-semibold text-white">Active Brand Campaigns</p>
                  </div>
                  <div className="divide-y divide-white/5">
                    {demoCampaigns.map((campaign, idx) => (
                      <div key={idx} className="px-6 py-4 flex flex-wrap items-center justify-between gap-3" data-testid={`row-campaign-${idx}`}>
                        <div className="flex items-center gap-3">
                          <span className="font-semibold text-white">{campaign.brand}</span>
                          <span className="text-muted-foreground text-sm">{campaign.content}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={`px-2 py-0.5 rounded-full ${campaign.statusColor} text-xs font-medium`}>
                            {campaign.status}
                          </span>
                          <span className="font-semibold text-white">{campaign.amount}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              </>
            ) : (
              <>
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                >
                  <AnalyticsOverview />
                </motion.div>
                <RealBrandCampaigns />
              </>
            )}
          </div>

          <div className="space-y-6">
            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3 }}
              className="bg-card rounded-2xl p-6 border border-border"
            >
              <h3 className="font-semibold mb-4">Quick Actions</h3>
              <div className="space-y-3">
                {(isDemoMode ? !simulatedConnected : !isConnected) && (
                  <Button
                    onClick={isDemoMode ? handleSimulatedConnect : handleConnect}
                    disabled={isSimulatingConnect}
                    data-testid="button-connect-youtube"
                    variant={isSimulatingConnect ? "secondary" : "destructive"}
                    className="w-full justify-start"
                  >
                    {isSimulatingConnect ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Connecting to Google API...
                      </>
                    ) : (
                      <>
                        <Youtube className="w-4 h-4 mr-2" />
                        Connect YouTube
                      </>
                    )}
                  </Button>
                )}
                {(isDemoMode && simulatedConnected) && (
                  <Button
                    disabled
                    data-testid="button-youtube-synced"
                    variant="outline"
                    className="w-full justify-start text-emerald-400 border-emerald-500/30"
                  >
                    <CheckCircle className="w-4 h-4 mr-2" />
                    Channel Synced: @MartinCreators
                  </Button>
                )}
                {(isRealMode && isConnected) && (
                  <>
                    <Button
                      disabled
                      data-testid="button-youtube-synced-real"
                      variant="outline"
                      className="w-full justify-start text-emerald-400 border-emerald-500/30"
                    >
                      <CheckCircle className="w-4 h-4 mr-2" />
                      Channel Synced: {channelData?.title || youtubeStatus?.channelTitle || "YouTube"}
                    </Button>
                    <Button
                      onClick={() => setYoutubePickerOpen(true)}
                      variant="outline"
                      className="w-full justify-start text-white border-red-500/30 hover:bg-red-500/10"
                    >
                      <Youtube className="w-4 h-4 mr-2 text-red-500" />
                      Browse & Import Videos
                    </Button>
                  </>
                )}
                <Button 
                  onClick={() => setUploadModalOpen(true)}
                  className="w-full justify-start"
                  data-testid="button-upload-manual-dashboard"
                >
                  Upload Manual Asset
                </Button>
                <p className="text-[11px] text-muted-foreground/80 leading-relaxed pt-2">
                  <a
                    href="/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground underline underline-offset-2"
                    data-testid="link-privacy-policy"
                  >
                    *View our privacy policy
                  </a>
                </p>
              </div>
            </motion.div>

            {/* My Portfolio */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.32 }}
              className="bg-card rounded-2xl p-6 border border-border"
            >
              <div className="flex items-center gap-2 mb-4">
                <Globe className="w-4 h-4 text-primary" />
                <h3 className="font-semibold">My Portfolio</h3>
              </div>
              {userTypeData?.slug ? (
                <div className="space-y-3">
                  <div className="bg-muted/50 rounded-lg px-3 py-2 text-sm text-muted-foreground font-mono truncate">
                    /c/{userTypeData.slug}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => setLocation(`/c/${userTypeData.slug}`)}
                      className="flex-1"
                      data-testid="button-view-portfolio"
                    >
                      <ExternalLink className="w-4 h-4 mr-2" />
                      View
                    </Button>
                    <Button
                      variant="outline"
                      onClick={async () => {
                        const fullUrl = `${window.location.origin}/c/${userTypeData.slug}`;
                        await navigator.clipboard.writeText(fullUrl);
                        setCopiedLink(true);
                        toast({ title: "Portfolio link copied!", description: fullUrl });
                        setTimeout(() => setCopiedLink(false), 3000);
                      }}
                      data-testid="button-copy-portfolio-link"
                    >
                      <Copy className="w-4 h-4 mr-1" />
                      {copiedLink ? "Copied!" : "Copy Link"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">Set up your public creator portfolio to share with brands.</p>
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => setLocation("/settings")}
                    data-testid="button-setup-portfolio"
                  >
                    <Globe className="w-4 h-4 mr-2" />
                    Set Up Portfolio
                  </Button>
                </div>
              )}
            </motion.div>

            {/* Social Connect Shortcuts */}
            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.35 }}
              className="bg-card rounded-2xl p-6 border border-border"
            >
              <div className="flex items-center gap-2 mb-4">
                <Link2 className="w-4 h-4 text-primary" />
                <h3 className="font-semibold">Connect Platforms</h3>
              </div>
              <div className="space-y-3">
                <Button
                  onClick={() => window.location.href = "/auth/facebook"}
                  data-testid="button-connect-facebook"
                  className="w-full justify-start bg-[#1877F2] text-white border-[#1877F2]"
                >
                  <SiFacebook className="w-4 h-4 mr-2" />
                  Connect Facebook Page
                </Button>
                <Button
                  onClick={() => window.location.href = "/auth/facebook"}
                  data-testid="button-connect-instagram"
                  className="w-full justify-start bg-gradient-to-r from-[#833AB4] via-[#E1306C] to-[#F77737] text-white border-transparent"
                >
                  <SiInstagram className="w-4 h-4 mr-2" />
                  Connect Instagram Business
                </Button>
                <SyncSocialButton />
                <Button
                  onClick={() => setLocation("/settings")}
                  data-testid="button-manage-connections"
                  variant="ghost"
                  className="w-full justify-start"
                >
                  <Link2 className="w-4 h-4 mr-2" />
                  Manage All Connections
                </Button>
              </div>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 }}
              className="bg-gradient-to-br from-card to-secondary/30 rounded-2xl p-6 border border-border shadow-lg"
            >
              <div className="flex items-center gap-4 mb-4">
                {((isDemoMode && simulatedConnected) || (isRealMode && isConnected && channelData?.profilePictureUrl)) ? (
                  (isDemoMode && simulatedConnected) ? (
                    <div className="w-12 h-12 bg-emerald-600/20 rounded-xl flex items-center justify-center">
                      <CheckCircle className="w-6 h-6 text-emerald-400" />
                    </div>
                  ) : (
                    <Avatar className="w-12 h-12">
                      <AvatarImage 
                        src={channelData?.profilePictureUrl} 
                        alt={channelData?.title}
                        data-testid="img-channel-avatar"
                      />
                      <AvatarFallback>
                        <Youtube className="w-6 h-6 text-red-500" />
                      </AvatarFallback>
                    </Avatar>
                  )
                ) : (
                  <div className="w-12 h-12 bg-red-600/10 rounded-xl flex items-center justify-center text-red-500">
                    <Youtube className="w-6 h-6" />
                  </div>
                )}
                <div className="flex-1">
                  <h3 className="text-lg font-bold font-display" data-testid="text-channel-title">
                    {(isDemoMode && simulatedConnected) 
                      ? "@MartinCreators" 
                      : (isRealMode && isConnected) 
                        ? (channelData?.title || youtubeStatus?.channelTitle || "YouTube Connected") 
                        : "Channel Status"
                    }
                  </h3>
                  {((isDemoMode && simulatedConnected) || (isRealMode && isConnected)) ? (
                    <div className="flex items-center gap-1 text-xs text-emerald-500">
                      <CheckCircle className="w-3 h-3" />
                      <span>Channel linked</span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Not connected</p>
                  )}
                </div>
              </div>
              
              {((isDemoMode && simulatedConnected) || (isRealMode && isConnected)) ? (
                <>
                  <p className="text-sm text-muted-foreground mb-4">
                    {isDemoMode && simulatedConnected 
                      ? "Your channel with 125,400 subscribers is connected. 45 videos imported."
                      : `Your channel with ${channelData?.subscriberCount ? parseInt(channelData.subscriberCount).toLocaleString() : "0"} subscribers is connected.${indexedVideos.length > 0 ? ` ${indexedVideos.length} videos indexed.` : ""}`
                    }
                  </p>
                  <div className="flex flex-col gap-2">
                    <Button
                      variant="outline"
                      onClick={() => syncYouTubeMutation.mutate()}
                      disabled={syncYouTubeMutation.isPending || isDemoMode}
                      data-testid="button-sync-youtube"
                      className="w-full"
                    >
                      {syncYouTubeMutation.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin mr-2" />
                          Syncing Videos...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="w-4 h-4 mr-2" />
                          Sync Videos
                        </>
                      )}
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={isDemoMode ? () => setSimulatedConnected(false) : handleDisconnect}
                      disabled={disconnectMutation.isPending}
                      data-testid="button-disconnect-youtube"
                      className="w-full"
                    >
                      {disconnectMutation.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin mr-2" />
                          Disconnecting...
                        </>
                      ) : (
                        <>
                          <Unlink className="w-4 h-4 mr-2" />
                          Disconnect Channel
                        </>
                      )}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {isDemoMode 
                    ? "Connect your YouTube channel to see the demo import flow."
                    : "Connect your YouTube channel to import your real videos and metrics."
                  }
                </p>
              )}
            </motion.div>
          </div>
        </div>

        {/* My Library Section - Shows indexed high-value videos (or demo videos in Pitch Mode) */}
        {(isPitchMode || (isRealMode && isConnected)) && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="mt-8 bg-white/5 rounded-xl border border-white/5 overflow-hidden"
          >
            <div className="px-6 py-4 border-b border-white/5 flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-white">My Library</p>
                <p className="text-xs text-muted-foreground">High-value videos ready for monetization</p>
              </div>
              <div className="flex items-center gap-3">
                {indexedVideos.some(v => v.status === "Pending Scan") && (
                  <Button
                    onClick={() => batchScanMutation.mutate()}
                    disabled={batchScanMutation.isPending}
                    variant="secondary"
                    size="sm"
                    data-testid="button-scan-all"
                  >
                    {batchScanMutation.isPending ? "Scanning..." : "Scan All Pending"}
                  </Button>
                )}
                {indexedVideos.length > 0 && (
                  <span className="px-2 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-medium">
                    {indexedVideos.length} videos
                  </span>
                )}
              </div>
            </div>
            
            {isLoadingVideoIndex ? (
              <div className="p-8 flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-muted-foreground text-sm">Indexing your videos...</span>
              </div>
            ) : indexedVideos.length === 0 ? (
              <div className="p-8 text-center">
                <Video className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground text-sm">
                  No videos found yet. Sync your YouTube channel to import your videos.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4 max-h-[600px] overflow-y-auto">
                {indexedVideos.map((video) => {
                  // Fallbacks for demo videos (support both camelCase and snake_case)
                  const thumbnailUrl = (video as any).thumbnailUrl || (video as any).thumbnail_url || "";
                  const viewCount = (video as any).viewCount ?? (video as any).view_count ?? 0;
                  const adOpportunities = (video as any).adOpportunities ?? (video as any).opportunities_count ?? 0;
                  const status = (video as any).status || (video as any).scan_status || "Ready";
                  
                  return (
                  <div
                    key={video.id}
                    onClick={() => handleVideoClick(video)}
                    className="bg-white/5 rounded-lg overflow-hidden border border-white/10 hover:border-white/20 transition-colors cursor-pointer hover-elevate"
                    data-testid={`card-video-${video.id}`}
                  >
                    {thumbnailUrl && (
                      <div className="aspect-video relative">
                        <img
                          src={thumbnailUrl}
                          alt={video.title}
                          className="w-full h-full object-cover"
                        />
                        {video.isEvergreen && (
                          <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-emerald-500/90 text-white text-xs font-medium">
                            Evergreen
                          </span>
                        )}
                        <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-black/70 text-white text-xs">
                          {viewCount.toLocaleString()} views
                        </span>
                      </div>
                    )}
                    <div className="p-3">
                      <h4 className="text-sm font-medium text-white line-clamp-2 mb-1">{video.title}</h4>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">{video.category || "General"}</span>
                        <div className="flex items-center gap-2">
                          {adOpportunities > 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/20 text-blue-400" data-testid={`badge-opportunities-${video.id}`}>
                              {adOpportunities} Ad Spots
                            </span>
                          )}
                          {status === "Pending Scan" ? (
                            <Button
                              onClick={(e) => {
                                e.stopPropagation();
                                scanMutation.mutate(video.id);
                              }}
                              disabled={scanMutation.isPending}
                              variant="secondary"
                              size="sm"
                              data-testid={`button-scan-${video.id}`}
                            >
                              Scan
                            </Button>
                          ) : (
                            <Badge variant={status === "Scan Failed" ? "destructive" : "outline"} className={status === "Scan Failed" ? "" : "text-emerald-400 border-emerald-500/30"}>
                              {status}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
            
            {indexedVideos.length > 6 && (
              <div className="px-6 py-3 border-t border-white/5 text-center">
                <Button
                  onClick={() => setLocation("/library")}
                  variant="ghost"
                  data-testid="button-view-all-library"
                >
                  View all {indexedVideos.length} videos
                </Button>
              </div>
            )}
          </motion.div>
        )}
      </main>

      <UploadModal 
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onUploadComplete={() => {
          toast({
            title: "Upload Complete",
            description: "Demo_Upload.mp4 has been added to your Library.",
          });
          setLocation("/library");
        }}
      />

      <SceneAnalysisModal
        video={selectedVideo}
        open={sceneModalOpen}
        onClose={() => setSceneModalOpen(false)}
      />

      <Dialog open={importChoiceOpen} onOpenChange={setImportChoiceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bring in your videos</DialogTitle>
            <DialogDescription>
              We found your channel. Import everything recent, or hand-pick which videos FullScale should work with.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setImportChoiceOpen(false);
                setYoutubePickerOpen(true);
              }}
              data-testid="button-import-pick"
            >
              Let me pick
            </Button>
            <Button
              onClick={() => {
                setImportChoiceOpen(false);
                syncYouTubeMutation.mutate();
              }}
              disabled={syncYouTubeMutation.isPending}
              data-testid="button-import-all"
            >
              {syncYouTubeMutation.isPending ? "Importing…" : "Import all recent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <YouTubeVideoPicker
        open={youtubePickerOpen}
        onClose={() => setYoutubePickerOpen(false)}
        onImportComplete={(count) => {
          queryClient.invalidateQueries({ queryKey: ["/api/youtube/videos"] });
          toast({ title: `${count} videos imported`, description: "Head to your Library to scan them." });
          setYoutubePickerOpen(false);
        }}
      />

      {/* Facebook Page confirmation — the creator picks which managed Page
          (and its linked IG account) to connect. Never auto-selected. */}
      <Dialog open={pageSelectOpen} onOpenChange={setPageSelectOpen}>
        <DialogContent data-testid="dialog-page-select">
          <DialogHeader>
            <DialogTitle>Choose the Page to connect</DialogTitle>
            <DialogDescription>
              These are the Facebook Pages you manage. Pick the one linked to the
              Instagram account you create with — FullScale will use it for your
              analytics and publishing.
            </DialogDescription>
          </DialogHeader>

          {fbPagesLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading your Pages…</div>
          ) : fbPagesError ? (
            <div className="py-6 text-sm text-red-400">
              Couldn't load your Pages{(fbPagesErrorObj as any)?.message ? `: ${(fbPagesErrorObj as any).message}` : "."}
              {" "}Reconnect Facebook and try again.
            </div>
          ) : fbPages && fbPages.pages.length === 0 && (fbPages.igOnly?.length ?? 0) > 0 ? (
            /* IG accounts shared, no Page assets — connect Instagram directly */
            <div className="space-y-2">
              <p className="text-xs text-amber-400/90 mb-1">
                You shared Instagram accounts but no Facebook Page. You can connect
                Instagram now — Page-level analytics stay off until you reconnect and
                select a Page ("Edit previous settings" in Facebook's dialog).
              </p>
              {fbPages.igOnly.map((ig) => {
                const chosen = (selectedPageId ?? fbPages.igOnly[0]?.id) === ig.id;
                return (
                  <button
                    key={ig.id}
                    onClick={() => setSelectedPageId(ig.id)}
                    data-testid={`ig-option-${ig.id}`}
                    className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                      chosen ? "border-primary bg-primary/10" : "border-white/10 hover:bg-white/5"
                    }`}
                  >
                    {ig.pictureUrl ? (
                      <img src={ig.pictureUrl} alt="" className="w-10 h-10 rounded-full object-cover" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-white/10" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{ig.handle}</p>
                      <p className="text-xs text-muted-foreground">
                        {ig.followers.toLocaleString()} followers · Instagram only
                      </p>
                    </div>
                    {chosen && <CheckCircle className="w-4 h-4 text-primary shrink-0" />}
                  </button>
                );
              })}
            </div>
          ) : !fbPages || fbPages.pages.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">
              No managed Facebook Pages were found on this account. FullScale needs a
              Page linked to an Instagram professional (Business or Creator) account —
              create or link one on Facebook, then reconnect.
            </div>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {fbPages.pages.map((p) => {
                const chosen = (selectedPageId ?? fbPages.currentPageId ?? fbPages.pages[0]?.pageId) === p.pageId;
                return (
                  <button
                    key={p.pageId}
                    onClick={() => setSelectedPageId(p.pageId)}
                    data-testid={`page-option-${p.pageId}`}
                    className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                      chosen ? "border-primary bg-primary/10" : "border-white/10 hover:bg-white/5"
                    }`}
                  >
                    {p.pictureUrl ? (
                      <img src={p.pictureUrl} alt="" className="w-10 h-10 rounded-full object-cover" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-white/10" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{p.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.followers.toLocaleString()} followers
                        {p.instagram?.handle
                          ? ` · linked to ${p.instagram.handle} (${p.instagram.followers.toLocaleString()})`
                          : " · no linked Instagram account"}
                      </p>
                    </div>
                    {chosen && <CheckCircle className="w-4 h-4 text-primary shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setPageSelectOpen(false)} data-testid="button-page-cancel">
              Not now
            </Button>
            <Button
              disabled={
                confirmPageMutation.isPending || fbPagesLoading || !fbPages ||
                (fbPages.pages.length === 0 && (fbPages.igOnly?.length ?? 0) === 0)
              }
              onClick={() => {
                if (!fbPages) return;
                if (fbPages.pages.length > 0) {
                  const pageId = selectedPageId ?? fbPages.currentPageId ?? fbPages.pages[0]?.pageId;
                  if (pageId) confirmPageMutation.mutate({ pageId });
                } else {
                  const igAccountId = selectedPageId ?? fbPages.igOnly?.[0]?.id;
                  if (igAccountId) confirmPageMutation.mutate({ igAccountId });
                }
              }}
              data-testid="button-page-confirm"
            >
              {confirmPageMutation.isPending
                ? "Connecting…"
                : fbPages && fbPages.pages.length === 0 && (fbPages.igOnly?.length ?? 0) > 0
                  ? "Connect Instagram"
                  : "Connect this Page"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
