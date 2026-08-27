import { useState, useEffect, useRef } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TopBar } from "@/components/TopBar";
import { User, CreditCard, Bell, CheckCircle, ExternalLink, Save, Link2, Loader2, ChevronDown, RefreshCw, Trash2, Star, Mic, Globe, Coins } from "lucide-react";
import CreditsPanel from "@/components/CreditsPanel";
import { SiInstagram, SiFacebook, SiX, SiTiktok, SiYoutube, SiTwitch, SiLinkedin } from "react-icons/si";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const UPLOAD_TIMEOUT_MS = 30 * 60_000; // files, not JSON — see AdminPlacements


type TabType = "profile" | "creator" | "payouts" | "credits" | "notifications" | "integrations";

const tabs = [
  { id: "profile" as const, label: "General Profile", icon: User },
  { id: "creator" as const, label: "Creator Profile", icon: Star },
  { id: "integrations" as const, label: "Social Integrations", icon: Link2 },
  { id: "credits" as const, label: "Credits", icon: Coins },
  { id: "payouts" as const, label: "Payouts & Billing", icon: CreditCard },
  { id: "notifications" as const, label: "Notification Preferences", icon: Bell },
];

interface SocialConnection {
  id: string;
  name: string;
  icon: typeof SiInstagram;
  color: string;
  bgColor: string;
  status: "disconnected" | "connecting" | "connected";
  followers?: string;
  handle?: string;
}

interface PlatformAuthStatus {
  twitch: { configured: boolean; connected: boolean };
  facebook: { configured: boolean; connected: boolean; pageName?: string; followers?: number };
  instagram: { configured: boolean; connected: boolean; handle?: string; followers?: number };
}

interface FacebookSource {
  id: string;
  name: string;
  type: "personal" | "page";
  followers?: number;
  profilePicture?: string;
  instagramAccount?: { id: string; username: string; followers: number } | null;
}

interface FacebookSourcesResponse {
  sources: FacebookSource[];
  currentSelection: {
    facebookSourceId: string | null;
    facebookSourceType: "personal" | "page";
    instagramBusinessId: string | null;
  };
}

function formatFollowers(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(0)}K`;
  return count.toString();
}

const initialSocialConnections: SocialConnection[] = [
  { id: "instagram", name: "Instagram Professional", icon: SiInstagram, color: "#E4405F", bgColor: "bg-gradient-to-br from-[#833AB4] via-[#E4405F] to-[#FCAF45]", status: "disconnected" },
  { id: "facebook", name: "Facebook Page", icon: SiFacebook, color: "#1877F2", bgColor: "bg-[#1877F2]", status: "disconnected" },
  { id: "twitch", name: "Twitch Channel", icon: SiTwitch, color: "#9146FF", bgColor: "bg-[#9146FF]", status: "disconnected" },
  { id: "x", name: "X (Twitter)", icon: SiX, color: "#000000", bgColor: "bg-black", status: "disconnected" },
  { id: "tiktok", name: "TikTok", icon: SiTiktok, color: "#000000", bgColor: "bg-gradient-to-br from-[#00F2EA] to-[#FF0050]", status: "disconnected" },
  { id: "youtube", name: "YouTube", icon: SiYoutube, color: "#FF0000", bgColor: "bg-[#FF0000]", status: "disconnected" },
  { id: "linkedin", name: "LinkedIn", icon: SiLinkedin, color: "#0A66C2", bgColor: "bg-[#0A66C2]", status: "disconnected" },
];

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Deep-linkable: the in-editor paywall sends creators straight here with
  // ?tab=credits, and Stripe returns to the same URL after checkout.
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    const t = typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("tab")
      : null;
    const valid: TabType[] = ["profile", "creator", "payouts", "credits", "notifications", "integrations"];
    return valid.includes(t as TabType) ? (t as TabType) : "profile";
  });
  const [socialConnections, setSocialConnections] = useState<SocialConnection[]>(initialSocialConnections);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  
  // Facebook/Instagram source selection state
  const [facebookSources, setFacebookSources] = useState<FacebookSource[]>([]);
  const [selectedFacebookSource, setSelectedFacebookSource] = useState<string>("");
  const [selectedInstagramSource, setSelectedInstagramSource] = useState<string>("");
  const [isLoadingSources, setIsLoadingSources] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isFacebookConnected, setIsFacebookConnected] = useState(false);
  
  const [profile, setProfile] = useState({
    fullName: "Martin Creators",
    channelName: "Martin's Tech",
    email: "martin@creators.com",
  });

  const [notifications, setNotifications] = useState(() => {
    const defaults = { newBrandOffer: true, videoAnalysisComplete: true, weeklyRevenueReport: false };
    try {
      const saved = localStorage.getItem("fs-notification-prefs");
      if (saved) return { ...defaults, ...JSON.parse(saved) };
    } catch { /* corrupted prefs fall back to defaults */ }
    return defaults;
  });

  // Real pending payouts: the creator's 70% share of approved placements.
  // (The old Payouts tab showed a hardcoded $4,250 balance and a fake
  // connected Chase account to every real user.)
  const { data: approvedPlacements } = useQuery<{ placements: Array<{ creatorPayoutCents?: number | null }> }>({
    queryKey: ["/api/creator/placements/inbox", "creator_approved", "payouts"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/creator/placements/inbox?status=creator_approved,pending_brand_review,brand_approved", { credentials: "include" });
      if (!res.ok) return { placements: [] };
      return res.json();
    },
    enabled: activeTab === "payouts",
  });
  const pendingPayoutCents = (approvedPlacements?.placements ?? []).reduce(
    (sum, p) => sum + (p.creatorPayoutCents || 0), 0
  );

  // Creator profile state
  const [creatorProfile, setCreatorProfile] = useState({
    slug: "",
    bio: "",
    headline: "",
    podcastName: "",
    podcastUrl: "",
    websiteUrl: "",
    cardImageUrl: "" as string | null | "",
  });
  const [isSavingCreatorProfile, setIsSavingCreatorProfile] = useState(false);
  const [creatorProfileLoaded, setCreatorProfileLoaded] = useState(false);
  const [isUploadingCardImage, setIsUploadingCardImage] = useState(false);
  const cardImageInputRef = useRef<HTMLInputElement | null>(null);

  // Load creator profile when tab is opened
  useEffect(() => {
    if (activeTab === "creator" && !creatorProfileLoaded) {
      const loadProfile = async () => {
        try {
          const res = await fetchWithTimeout("/api/auth/user-type", { credentials: "include" });
          if (!res.ok) return;
          const data = await res.json();
          if (data.email) {
            // Try fetching the creator by their slug or email-based slug
            const slug = data.email.split("@")[0].toLowerCase();
            const profileRes = await fetchWithTimeout(`/api/public/creator/${slug}`);
            if (profileRes.ok) {
              const profileData = await profileRes.json();
              setCreatorProfile({
                slug: profileData.creator.slug || slug,
                bio: profileData.creator.bio || "",
                headline: profileData.creator.headline || "",
                podcastName: profileData.creator.podcastName || "",
                podcastUrl: profileData.creator.podcastUrl || "",
                websiteUrl: profileData.creator.websiteUrl || "",
                cardImageUrl: profileData.creator.cardImageUrl || "",
              });
            }
          }
          setCreatorProfileLoaded(true);
        } catch (err) {
          console.error("Failed to load creator profile:", err);
          setCreatorProfileLoaded(true);
        }
      };
      loadProfile();
    }
  }, [activeTab, creatorProfileLoaded]);

  const handleSaveCreatorProfile = async () => {
    setIsSavingCreatorProfile(true);
    try {
      const res = await fetchWithTimeout("/api/creator/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(creatorProfile),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }
      toast({ title: "Profile saved", description: "Your creator profile has been updated." });
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSavingCreatorProfile(false);
    }
  };

  // Upload featured creator card image. The endpoint persists it onto the
  // profile immediately, so we just refresh local state on success — no
  // separate save click needed.
  const handleCardImageUpload = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({
        title: "Wrong file type",
        description: "Pick a PNG, JPG, or WebP image.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Card image must be under 10MB.",
        variant: "destructive",
      });
      return;
    }
    setIsUploadingCardImage(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetchWithTimeout("/api/creator/card-image", {
        method: "POST",
        credentials: "include",
        body: fd,
      }, UPLOAD_TIMEOUT_MS);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Upload failed");
      }
      const data = await res.json();
      setCreatorProfile((p) => ({ ...p, cardImageUrl: data.cardImageUrl }));
      toast({
        title: "Card image updated",
        description: "Your featured creator card now uses this image.",
      });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setIsUploadingCardImage(false);
      if (cardImageInputRef.current) cardImageInputRef.current.value = "";
    }
  };

  const handleClearCardImage = async () => {
    try {
      const res = await fetchWithTimeout("/api/creator/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cardImageUrl: "" }),
      });
      if (!res.ok) throw new Error("Failed to clear card image");
      setCreatorProfile((p) => ({ ...p, cardImageUrl: "" }));
      toast({
        title: "Card image cleared",
        description: "Card will fall back to your first video frame.",
      });
    } catch (err: any) {
      toast({ title: "Clear failed", description: err.message, variant: "destructive" });
    }
  };

  // Fetch real platform connection status on mount
  useEffect(() => {
    async function fetchPlatformStatus() {
      try {
        // Fetch platform auth status (Twitch, Facebook, Instagram) plus
        // distribution publishing profiles (TikTok, X, LinkedIn)
        const [platformResponse, youtubeResponse, distributionResponse] = await Promise.all([
          fetchWithTimeout("/api/platform-auth/status", { credentials: "include" }),
          fetchWithTimeout("/api/youtube/videos", { credentials: "include" }),
          fetchWithTimeout("/api/distribution/profiles", { credentials: "include" }),
        ]);

        let updates: Partial<Record<string, Partial<SocialConnection>>> = {};

        // TikTok / X / LinkedIn connect via distribution profiles
        if (distributionResponse.ok) {
          const profiles: Array<{ platform: string; accountName?: string | null; isActive?: boolean | null }> =
            await distributionResponse.json();
          for (const [connId, platform] of [["tiktok", "tiktok"], ["x", "twitter"], ["linkedin", "linkedin"]] as const) {
            const match = (profiles || []).find(p => p.platform === platform && p.isActive !== false);
            updates[connId] = match
              ? { status: "connected" as const, handle: match.accountName || undefined }
              : { status: "disconnected" as const, handle: undefined, followers: undefined };
          }
        }
        
        if (platformResponse.ok) {
          const data: PlatformAuthStatus = await platformResponse.json();
          
          if (data.facebook.connected) {
            updates.facebook = {
              status: "connected" as const,
              handle: data.facebook.pageName || "Facebook Page",
              followers: data.facebook.followers ? formatFollowers(data.facebook.followers) : undefined,
            };
          } else {
            updates.facebook = { status: "disconnected" as const, handle: undefined, followers: undefined };
          }
          
          if (data.instagram.connected) {
            updates.instagram = {
              status: "connected" as const,
              handle: data.instagram.handle || "@instagram",
              followers: data.instagram.followers ? formatFollowers(data.instagram.followers) : undefined,
            };
          } else {
            updates.instagram = { status: "disconnected" as const, handle: undefined, followers: undefined };
          }
          
          if (data.twitch.connected) {
            updates.twitch = { status: "connected" as const };
          } else {
            updates.twitch = { status: "disconnected" as const };
          }
        }
        
        // Check YouTube connection status
        if (youtubeResponse.ok) {
          const ytData = await youtubeResponse.json();
          if (ytData.connected) {
            updates.youtube = { status: "connected" as const };
          } else {
            updates.youtube = { status: "disconnected" as const, handle: undefined, followers: undefined };
          }
        } else {
          updates.youtube = { status: "disconnected" as const, handle: undefined, followers: undefined };
        }
        
        // Apply all updates
        setSocialConnections(prev => prev.map(conn => {
          if (updates[conn.id]) {
            return { ...conn, ...updates[conn.id] };
          }
          return conn;
        }));
      } catch (error) {
        console.error("Failed to fetch platform status:", error);
      } finally {
        setIsLoadingStatus(false);
      }
    }
    
    fetchPlatformStatus();
  }, []);

  // Fetch Facebook sources when Facebook is connected
  const fetchFacebookSources = async () => {
    setIsLoadingSources(true);
    try {
      const response = await fetchWithTimeout("/api/facebook/sources");
      if (response.ok) {
        const data: FacebookSourcesResponse = await response.json();
        setFacebookSources(data.sources);
        setIsFacebookConnected(true);
        
        // Set current selection
        if (data.currentSelection.facebookSourceId) {
          setSelectedFacebookSource(data.currentSelection.facebookSourceId);
        } else if (data.sources.length > 0) {
          // Default to personal profile if available
          const personalSource = data.sources.find(s => s.type === "personal");
          setSelectedFacebookSource(personalSource?.id || data.sources[0].id);
        }
        
        if (data.currentSelection.instagramBusinessId) {
          setSelectedInstagramSource(data.currentSelection.instagramBusinessId);
        }
      }
    } catch (error) {
      console.error("Failed to fetch Facebook sources:", error);
    } finally {
      setIsLoadingSources(false);
    }
  };

  // Fetch sources when integrations tab is opened and Facebook is connected
  useEffect(() => {
    if (activeTab === "integrations") {
      const fbConnection = socialConnections.find(c => c.id === "facebook");
      if (fbConnection?.status === "connected") {
        fetchFacebookSources();
      }
    }
  }, [activeTab, socialConnections]);

  // Save selected sources
  const handleSaveSourceSelection = async () => {
    try {
      const selectedSource = facebookSources.find(s => s.id === selectedFacebookSource);
      const response = await fetchWithTimeout("/api/facebook/select-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facebookSourceId: selectedFacebookSource,
          facebookSourceType: selectedSource?.type || "personal",
          instagramBusinessId: (selectedInstagramSource && selectedInstagramSource !== "none") ? selectedInstagramSource : null,
        }),
      });
      
      if (response.ok) {
        toast({
          title: "Source Selection Saved",
          description: "Your Facebook/Instagram source preferences have been saved.",
        });
      } else {
        const data = await response.json();
        toast({
          title: "Save Failed",
          description: data.error || "Failed to save source selection. Please try again.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Failed to save source selection:", error);
      toast({
        title: "Error",
        description: "Failed to save source selection. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Sync Facebook/Instagram content
  const handleSyncContent = async () => {
    setIsSyncing(true);
    try {
      const response = await fetchWithTimeout("/api/sync/facebook-instagram", { method: "POST" });
      const data = await response.json();
      
      if (response.ok) {
        toast({
          title: "Content Synced",
          description: data.message || `Imported ${data.facebookVideos || 0} Facebook videos and ${data.instagramVideos || 0} Instagram videos.`,
        });
      } else {
        toast({
          title: "Sync Error",
          description: data.error || "Failed to sync content. Please try again.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Failed to sync content:", error);
      toast({
        title: "Error",
        description: "Failed to sync content. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  // Meta bounced the creator back because the app is not currently accepting
  // logins. Without this they see Facebook's own "Feature Unavailable" screen,
  // which never mentions FullScale and offers only a Reload that fails the
  // same way — so it reads as our bug rather than a review state.
  const connectResult =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("connect")
      : null;
  const metaUnavailable = connectResult === "meta_unavailable";

  // Instagram Login outcomes. Worth naming individually: "you declined" and
  // "it broke" and "sign in first" are three different things, and one generic
  // failure message for all three sends people to support for a problem they
  // could have solved themselves.
  const IG_MESSAGES: Record<string, { title: string; body: string; tone: "ok" | "warn" }> = {
    ig_success: {
      title: "Instagram connected",
      body: "Your account is linked. Follower counts and insights will populate within a few minutes.",
      tone: "ok",
    },
    ig_declined: {
      title: "Instagram connection cancelled",
      body: "You closed Instagram's permission screen. Nothing changed — try again whenever you're ready.",
      tone: "warn",
    },
    ig_signin_first: {
      title: "Sign in to FullScale first",
      body: "We couldn't tell which account to attach Instagram to. Sign in, then connect.",
      tone: "warn",
    },
    ig_not_configured: {
      title: "Instagram Login isn't switched on here",
      body: "This server is missing its Instagram app credentials. Nothing is wrong with your account.",
      tone: "warn",
    },
    yt_signin_first: {
      title: "Sign in with Google first",
      body: "Connecting YouTube needs an active Google sign-in on FullScale. Sign in, then connect — the consent screen will follow.",
      tone: "warn",
    },
    ig_failed: {
      title: "Instagram connection didn't complete",
      body: "Instagram returned an error. If your account is Personal, switch it to a Creator or Business account in the Instagram app — Settings → Account type — then try again. It's free and keeps your posts and followers.",
      tone: "warn",
    },
  };
  const igMessage = connectResult ? IG_MESSAGES[connectResult] : undefined;

  const handleConnectSocial = async (id: string) => {
    const connection = socialConnections.find((c) => c.id === id);
    if (!connection) return;

    if (connection.status === "connected") {
      // Call the actual disconnect API
      try {
        let endpoint = "";
        if (id === "facebook" || id === "instagram") {
          endpoint = "/api/auth/facebook";
        } else if (id === "twitch") {
          endpoint = "/api/auth/twitch";
        } else if (id === "youtube") {
          endpoint = "/api/auth/youtube";
        } else if (id === "tiktok" || id === "x" || id === "linkedin") {
          // These connect via distribution profiles — delete the profile row
          const platform = id === "x" ? "twitter" : id;
          const profRes = await fetchWithTimeout("/api/distribution/profiles", { credentials: "include" });
          if (profRes.ok) {
            const profiles = await profRes.json();
            const match = (profiles || []).find((p: any) => p.platform === platform);
            if (match) {
              const delRes = await fetchWithTimeout(`/api/distribution/profiles/${match.id}`, { method: "DELETE", credentials: "include" });
              if (!delRes.ok) throw new Error("Failed to disconnect");
            }
          }
        }

        if (endpoint) {
          const response = await fetch(endpoint, { method: "DELETE", credentials: "include" });
          if (!response.ok) {
            throw new Error("Failed to disconnect");
          }
        }

        // Update local state after successful disconnect
        setSocialConnections((prev) =>
          prev.map((c) => {
            // Disconnecting Facebook also disconnects Instagram
            if (id === "facebook" && c.id === "instagram") {
              return { ...c, status: "disconnected" as const, handle: undefined, followers: undefined };
            }
            if (c.id === id) {
              return { ...c, status: "disconnected" as const, handle: undefined, followers: undefined };
            }
            return c;
          })
        );
        
        // Clear Facebook-related state when disconnecting Facebook/Instagram
        if (id === "facebook" || id === "instagram") {
          setIsFacebookConnected(false);
          setFacebookSources([]);
          setSelectedFacebookSource("");
          setSelectedInstagramSource("");
        }

        // Invalidate every cached query that reads connection-derived state.
        // Without this, Dashboard, MonetizationTable, library views, etc. keep
        // showing the platform as connected (and stale videos that this very
        // disconnect just deleted server-side via deleteVideoIndex) until the
        // user hard-refreshes. Cast to any because invalidateQueries' typed
        // overload requires a single key per call but accepts an array shape.
        const keysToInvalidate = [
          ["/api/platform-auth/status"],
          ["/api/auth/youtube/status"],
          ["/api/youtube/channel"],
          ["/api/youtube/videos"],
          ["/api/video-index"],
          ["/api/video-index/with-opportunities"],
          ["/api/social-accounts"],
        ];
        keysToInvalidate.forEach(key => queryClient.invalidateQueries({ queryKey: key }));

        toast({
          title: `${connection.name} Disconnected`,
          description: `Your ${connection.name} account has been disconnected.`,
        });
      } catch (error) {
        toast({
          title: "Disconnect Failed",
          description: "Failed to disconnect account. Please try again.",
          variant: "destructive",
        });
      }
      return;
    }

    // Real OAuth flows for Twitch and Facebook
    if (id === "twitch") {
      window.location.href = "/auth/twitch";
      return;
    }
    if (id === "facebook" || id === "instagram") {
      window.location.href = "/auth/facebook";
      return;
    }
    if (id === "youtube") {
      // /api/auth/youtube, NOT /api/auth/google.
      //
      // These are different flows and only one of them connects a channel:
      //   /api/auth/google  — SIGN IN. access_type=online, prompt=select_account,
      //                       and only the login scopes. No YouTube scopes are
      //                       requested, so no consent screen appears and no
      //                       refresh token is issued — the "connection" cannot
      //                       outlive its first access token.
      //   /api/auth/youtube — CONNECT. access_type=offline, prompt=consent, and
      //                       the three YouTube scopes.
      //
      // Settings pointed at the first one, which is why reconnecting here never
      // showed the consent form while reconnecting from the Dashboard did.
      window.location.href = "/api/auth/youtube";
      return;
    }

    // Real OAuth flows for distribution publishing platforms
    if (id === "tiktok") {
      window.location.href = "/auth/tiktok";
      return;
    }
    if (id === "x") {
      window.location.href = "/auth/twitter";
      return;
    }
    if (id === "linkedin") {
      window.location.href = "/auth/linkedin";
      return;
    }

    toast({
      title: `${connection.name} not available`,
      description: "This platform connection isn't supported yet.",
      variant: "destructive",
    });
  };

  // Refresh follower counts + audience analytics from the platforms. The
  // server endpoints existed but no UI ever called them — stats only
  // updated at connect time or via cron.
  const [isRefreshingStats, setIsRefreshingStats] = useState(false);
  const handleRefreshStats = async () => {
    setIsRefreshingStats(true);
    try {
      const [analyticsRes, accountsRes] = await Promise.all([
        fetchWithTimeout("/api/analytics/refresh", { method: "POST", credentials: "include" }),
        fetchWithTimeout("/api/social-accounts/refresh-all", { method: "POST", credentials: "include" }),
      ]);
      if (analyticsRes.ok || accountsRes.ok) {
        toast({ title: "Stats refreshed", description: "Follower counts and audience data updated from the platforms." });
        queryClient.invalidateQueries({ queryKey: ["/api/platform-auth/status"] });
        queryClient.invalidateQueries({ queryKey: ["/api/analytics/overview"] });
        queryClient.invalidateQueries({ queryKey: ["/api/social-accounts"] });
      } else {
        const err = await analyticsRes.json().catch(() => ({}));
        toast({ title: "Refresh failed", description: err.error || "Could not refresh stats", variant: "destructive" });
      }
    } catch {
      toast({ title: "Refresh failed", description: "Network error", variant: "destructive" });
    } finally {
      setIsRefreshingStats(false);
    }
  };

  const handleSave = () => {
    // Preferences persist per-device until a server-side prefs store exists.
    // The old handler saved nothing and claimed success.
    try {
      localStorage.setItem("fs-notification-prefs", JSON.stringify(notifications));
      toast({ title: "Preferences saved", description: "Notification preferences saved on this device." });
    } catch {
      toast({ title: "Save failed", description: "Could not persist preferences in this browser.", variant: "destructive" });
    }
  };

  const [isClearingLibrary, setIsClearingLibrary] = useState(false);
  
  const handleClearLibrary = async () => {
    if (!confirm("Are you sure you want to clear all videos from your library? This cannot be undone.")) {
      return;
    }
    
    setIsClearingLibrary(true);
    try {
      const response = await fetchWithTimeout("/api/video-index/clear-all", { 
        method: "DELETE", 
        credentials: "include" 
      });
      if (!response.ok) {
        throw new Error("Failed to clear library");
      }
      toast({
        title: "Library Cleared",
        description: "All videos have been removed from your library.",
      });
    } catch (error) {
      toast({
        title: "Clear Failed",
        description: "Failed to clear library. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsClearingLibrary(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <TopBar />

      <main className="p-8 max-w-6xl mx-auto">
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-3xl font-bold font-display mb-2" data-testid="text-settings-title">
            Settings
          </h1>
          <p className="text-muted-foreground">Manage your account preferences and integrations</p>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="flex gap-8"
        >
          <div className="w-64 shrink-0">
            <nav className="space-y-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  data-testid={`tab-${tab.id}`}
                  className={`w-full text-left px-4 py-3 rounded-lg flex items-center gap-3 transition-colors ${
                    activeTab === tab.id
                      ? "bg-primary/10 text-primary border border-primary/20"
                      : "text-muted-foreground hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <tab.icon className="w-4 h-4" />
                  <span className="text-sm font-medium">{tab.label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="flex-1">
            {activeTab === "profile" && (
              <motion.div
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white/5 rounded-xl border border-white/5 p-6"
              >
                <h2 className="text-xl font-semibold text-white mb-6">General Profile</h2>
                
                <div className="flex items-center gap-6 mb-8">
                  <Avatar className="w-20 h-20 border-2 border-primary/30">
                    <AvatarFallback className="bg-primary/20 text-primary text-2xl font-bold">
                      MC
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm text-white font-medium">Profile picture</p>
                    <p className="text-xs text-muted-foreground mt-1">Synced from your Google account</p>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="fullName" className="text-white">Full Name</Label>
                    <Input
                      id="fullName"
                      value={profile.fullName}
                      onChange={(e) => setProfile({ ...profile, fullName: e.target.value })}
                      className="bg-black/30 border-white/10 text-white"
                      data-testid="input-full-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="channelName" className="text-white">Channel Name</Label>
                    <Input
                      id="channelName"
                      value={profile.channelName}
                      onChange={(e) => setProfile({ ...profile, channelName: e.target.value })}
                      className="bg-black/30 border-white/10 text-white"
                      data-testid="input-channel-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-white">Email Address</Label>
                    <Input
                      id="email"
                      type="email"
                      value={profile.email}
                      onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                      className="bg-black/30 border-white/10 text-white"
                      data-testid="input-email"
                    />
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === "creator" && (
              <motion.div
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white/5 rounded-xl border border-white/5 p-6"
              >
                <h2 className="text-xl font-semibold text-white mb-2">Creator Profile</h2>
                <p className="text-muted-foreground text-sm mb-6">
                  Customize your public profile page and media kit — visible at <span className="text-primary font-mono">/c/{creatorProfile.slug || "your-slug"}</span>
                </p>

                <div className="space-y-6">
                  {/* Featured creator card image — what brands see in the
                      marketplace. Upload directly here; saves immediately,
                      no separate "Save profile" click required. */}
                  <div className="space-y-2">
                    <Label className="text-white flex items-center gap-2">
                      <Star className="w-3.5 h-3.5" />
                      Featured Creator Card Image
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      The image brands see on the marketplace card. Upload your
                      logo or a brand-aligned image. 16:9 ratio renders best
                      (will be letterboxed on dark background otherwise).
                      Defaults to your first video's thumbnail when blank.
                    </p>
                    <div className="flex gap-3 items-start">
                      <div className="w-48 aspect-video rounded-lg overflow-hidden border border-white/10 bg-black/40 flex-shrink-0">
                        {creatorProfile.cardImageUrl ? (
                          <img
                            src={creatorProfile.cardImageUrl}
                            alt="Card preview"
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground text-center px-2">
                            Card preview
                            <br />
                            (no image yet)
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-2">
                        <input
                          ref={cardImageInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => handleCardImageUpload(e.target.files?.[0] ?? null)}
                        />
                        <Button
                          type="button"
                          onClick={() => cardImageInputRef.current?.click()}
                          disabled={isUploadingCardImage}
                          variant="outline"
                          size="sm"
                          className="gap-2"
                        >
                          {isUploadingCardImage ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Save className="w-3.5 h-3.5" />
                          )}
                          {creatorProfile.cardImageUrl ? "Replace image" : "Upload image"}
                        </Button>
                        {creatorProfile.cardImageUrl && (
                          <Button
                            type="button"
                            onClick={handleClearCardImage}
                            disabled={isUploadingCardImage}
                            variant="ghost"
                            size="sm"
                            className="gap-2 text-muted-foreground"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Clear
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="slug" className="text-white flex items-center gap-2">
                      <Globe className="w-3.5 h-3.5" />
                      Profile URL Slug
                    </Label>
                    <Input
                      id="slug"
                      value={creatorProfile.slug}
                      onChange={(e) => setCreatorProfile({ ...creatorProfile, slug: e.target.value })}
                      placeholder="your-name"
                      className="bg-black/30 border-white/10 text-white"
                    />
                    <p className="text-xs text-muted-foreground">Your profile will be at fullscale.com/c/{creatorProfile.slug || "..."}</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="headline" className="text-white">Headline</Label>
                    <Input
                      id="headline"
                      value={creatorProfile.headline}
                      onChange={(e) => setCreatorProfile({ ...creatorProfile, headline: e.target.value })}
                      placeholder="e.g., Sports Podcast Host & Content Creator"
                      className="bg-black/30 border-white/10 text-white"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="bio" className="text-white">Bio</Label>
                    <textarea
                      id="bio"
                      value={creatorProfile.bio}
                      onChange={(e) => setCreatorProfile({ ...creatorProfile, bio: e.target.value })}
                      placeholder="Tell brands about yourself, your content style, and audience..."
                      rows={4}
                      className="w-full rounded-md bg-black/30 border border-white/10 text-white px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>

                  <div className="border-t border-white/10 pt-6">
                    <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                      <Mic className="w-4 h-4" />
                      Podcast Info
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="podcastName" className="text-white">Podcast Name</Label>
                        <Input
                          id="podcastName"
                          value={creatorProfile.podcastName}
                          onChange={(e) => setCreatorProfile({ ...creatorProfile, podcastName: e.target.value })}
                          placeholder="My Podcast"
                          className="bg-black/30 border-white/10 text-white"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="podcastUrl" className="text-white">Podcast URL</Label>
                        <Input
                          id="podcastUrl"
                          value={creatorProfile.podcastUrl}
                          onChange={(e) => setCreatorProfile({ ...creatorProfile, podcastUrl: e.target.value })}
                          placeholder="https://podcasts.apple.com/..."
                          className="bg-black/30 border-white/10 text-white"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-white/10 pt-6">
                    <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                      <ExternalLink className="w-4 h-4" />
                      Links
                    </h3>
                    <div className="space-y-2">
                      <Label htmlFor="websiteUrl" className="text-white">Website URL</Label>
                      <Input
                        id="websiteUrl"
                        value={creatorProfile.websiteUrl}
                        onChange={(e) => setCreatorProfile({ ...creatorProfile, websiteUrl: e.target.value })}
                        placeholder="https://yourwebsite.com"
                        className="bg-black/30 border-white/10 text-white"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-4">
                    {creatorProfile.slug && (
                      <a
                        href={`/c/${creatorProfile.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline flex items-center gap-1"
                      >
                        Preview Profile <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    <Button
                      onClick={handleSaveCreatorProfile}
                      disabled={isSavingCreatorProfile}
                      className="gap-2"
                    >
                      {isSavingCreatorProfile ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      Save Creator Profile
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === "integrations" && (
              <motion.div
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white/5 rounded-xl border border-white/5 p-6"
              >
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-xl font-semibold text-white">Social Integrations</h2>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefreshStats}
                    disabled={isRefreshingStats}
                    className="gap-1.5"
                    data-testid="button-refresh-stats"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingStats ? "animate-spin" : ""}`} />
                    {isRefreshingStats ? "Refreshing…" : "Refresh stats"}
                  </Button>
                </div>
                <p className="text-muted-foreground text-sm mb-2">Connect your social accounts to unlock multi-platform monetization</p>
                {igMessage && (
                  <div className={`mb-3 rounded-lg border p-3 ${
                    igMessage.tone === "ok"
                      ? "border-emerald-500/30 bg-emerald-500/5"
                      : "border-amber-500/30 bg-amber-500/5"
                  }`}>
                    <p className="text-sm font-medium">{igMessage.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{igMessage.body}</p>
                  </div>
                )}
                {metaUnavailable && (
                  <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                    <p className="text-sm font-medium">Facebook and Instagram connections are paused</p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                      Meta is reviewing our app's access to Page and Instagram insights. Connecting
                      is switched off until that clears, so you don't land on an error page. Nothing
                      is wrong with your account — YouTube and Twitch still connect normally, and
                      we'll turn this back on as soon as review completes.
                    </p>
                  </div>
                )}
                <div className="mb-6 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200/90 leading-relaxed">
                  <span className="font-medium text-emerald-300">Your content stays yours.</span>{" "}
                  We use read-only access to identify placement opportunities — we never post on your behalf,
                  re-publish your videos, or share your content with anyone without your explicit approval.
                  Disconnect anytime.{" "}
                  <a
                    href="/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2 hover:text-emerald-100"
                  >
                    *View our privacy policy
                  </a>
                </div>

                <div className="space-y-4">
                  {socialConnections.map((connection) => (
                    <div
                      key={connection.id}
                      className="bg-black/30 rounded-lg p-4 border border-white/5 flex flex-wrap items-center justify-between gap-4"
                      data-testid={`connection-${connection.id}`}
                    >
                      <div className="flex items-center gap-4">
                        <div className={`w-12 h-12 ${connection.bgColor} rounded-xl flex items-center justify-center`}>
                          <connection.icon className="w-6 h-6 text-white" />
                        </div>
                        <div>
                          <p className="text-white font-medium">{connection.name}</p>
                          {connection.status === "connected" ? (
                            <p className="text-sm text-muted-foreground">
                              {connection.handle} • {connection.followers} followers
                            </p>
                          ) : (
                            <p className="text-sm text-muted-foreground">Not connected</p>
                          )}
                        </div>
                      </div>
                      
                      <Button
                        variant={connection.status === "connected" ? "outline" : "default"}
                        onClick={() => handleConnectSocial(connection.id)}
                        disabled={connection.status === "connecting"}
                        className={`min-w-[120px] gap-2 ${
                          connection.status === "connected"
                            ? "border-emerald-500/30 text-emerald-400"
                            : ""
                        }`}
                        data-testid={`button-connect-${connection.id}`}
                      >
                        {connection.status === "connecting" ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Connecting...
                          </>
                        ) : connection.status === "connected" ? (
                          <>
                            <CheckCircle className="w-4 h-4" />
                            Connected
                          </>
                        ) : (
                          <>
                            <Link2 className="w-4 h-4" />
                            Connect
                          </>
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
                
                <div className="mt-6 p-4 rounded-lg bg-primary/10 border border-primary/20">
                  <p className="text-sm text-primary">
                    Connecting multiple platforms increases your earning potential by 40% on average.
                    Brands prefer creators with diverse audiences.
                  </p>
                </div>
                
                {/* Linked Accounts Card */}
                {socialConnections.filter(c => c.status === "connected").length > 0 && (
                  <div className="mt-6 bg-black/30 rounded-xl border border-white/5 p-6">
                    <h3 className="text-lg font-semibold text-white mb-4">Linked Accounts</h3>
                    <div className="space-y-3">
                      {socialConnections.filter(c => c.status === "connected").map((connection) => (
                        <div
                          key={connection.id}
                          className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/5"
                          data-testid={`linked-${connection.id}`}
                        >
                          <div className={`w-8 h-8 ${connection.bgColor} rounded-lg flex items-center justify-center`}>
                            <connection.icon className="w-4 h-4 text-white" />
                          </div>
                          <div className="flex-1">
                            <p className="text-sm font-medium text-white">{connection.name}</p>
                            <p className="text-xs text-muted-foreground">{connection.handle}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-medium text-emerald-400">{connection.followers}</p>
                            <p className="text-xs text-muted-foreground">followers</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Instagram Business Connection Card - Always visible */}
                <div className="mt-6 bg-black/30 rounded-xl border border-white/5 p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 bg-gradient-to-br from-[#833AB4] via-[#E4405F] to-[#FCAF45] rounded-lg flex items-center justify-center">
                      <SiInstagram className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-white">Instagram Business</h3>
                      <p className="text-sm text-muted-foreground">Import videos and reels from your Instagram account</p>
                    </div>
                  </div>
                  
                  {isFacebookConnected && facebookSources.some(s => s.instagramAccount) ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-emerald-400">
                        <CheckCircle className="w-4 h-4" />
                        <span className="text-sm">Instagram Business connected</span>
                      </div>
                      <div className="space-y-2">
                        {facebookSources.filter(s => s.instagramAccount).map(source => (
                          <div key={source.instagramAccount!.id} className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/5">
                            <SiInstagram className="w-5 h-5 text-[#E4405F]" />
                            <div className="flex-1">
                              <p className="text-sm font-medium text-white">@{source.instagramAccount!.username}</p>
                              <p className="text-xs text-muted-foreground">Linked to {source.name}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-sm font-medium text-white">{formatFollowers(source.instagramAccount!.followers)}</p>
                              <p className="text-xs text-muted-foreground">followers</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : isFacebookConnected ? (
                    <div className="space-y-3">
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4">
                        <p className="text-sm text-amber-200 mb-2">
                          No Instagram Business account found linked to your Facebook Pages.
                        </p>
                        <p className="text-xs text-muted-foreground">
                          To import Instagram content, your Instagram account must be a Business or Creator account 
                          linked to a Facebook Page you manage.
                        </p>
                      </div>
                      <a 
                        href="https://business.facebook.com/settings/instagram-account-linking" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-sm text-[#E4405F] hover:underline"
                      >
                        <ExternalLink className="w-4 h-4" />
                        Link Instagram in Meta Business Suite
                      </a>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        Connect your Facebook Page first, then link your Instagram Business account to import content.
                      </p>
                      <Button
                        onClick={() => handleConnectSocial("facebook")}
                        className="w-full bg-gradient-to-r from-[#833AB4] via-[#E4405F] to-[#FCAF45] hover:opacity-90"
                        data-testid="button-connect-instagram-via-facebook"
                      >
                        <SiFacebook className="w-4 h-4 mr-2" />
                        Connect Facebook to Enable Instagram
                      </Button>
                    </div>
                  )}
                </div>

                {/* Facebook/Instagram Source Selection */}
                {isFacebookConnected && facebookSources.length > 0 && (
                  <div className="mt-6 bg-black/30 rounded-xl border border-white/5 p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="text-lg font-semibold text-white">Import Sources</h3>
                        <p className="text-sm text-muted-foreground">Choose which profiles to import videos from</p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSyncContent}
                        disabled={isSyncing}
                        data-testid="button-sync-content"
                        className="gap-2"
                      >
                        {isSyncing ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Syncing...
                          </>
                        ) : (
                          <>
                            <RefreshCw className="w-4 h-4" />
                            Sync Now
                          </>
                        )}
                      </Button>
                    </div>
                    
                    <div className="space-y-4">
                      {/* Facebook Source Selection */}
                      <div className="space-y-2">
                        <Label className="text-white flex items-center gap-2">
                          <SiFacebook className="w-4 h-4 text-[#1877F2]" />
                          Facebook Source
                        </Label>
                        <Select
                          value={selectedFacebookSource}
                          onValueChange={setSelectedFacebookSource}
                        >
                          <SelectTrigger className="bg-black/30 border-white/10 text-white" data-testid="select-facebook-source">
                            <SelectValue placeholder="Select a Facebook profile or page" />
                          </SelectTrigger>
                          <SelectContent>
                            {facebookSources.map((source) => (
                              <SelectItem key={source.id} value={source.id}>
                                <div className="flex items-center gap-2">
                                  <span>{source.name}</span>
                                  <Badge variant="outline" className="text-xs">
                                    {source.type === "personal" ? "Personal" : "Page"}
                                  </Badge>
                                  {source.followers && (
                                    <span className="text-xs text-muted-foreground">
                                      {formatFollowers(source.followers)} followers
                                    </span>
                                  )}
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          Your personal profile videos and any Page videos you manage will be imported
                        </p>
                      </div>

                      {/* Instagram Source Selection */}
                      <div className="space-y-2">
                        <Label className="text-white flex items-center gap-2">
                          <SiInstagram className="w-4 h-4 text-[#E4405F]" />
                          Instagram Business Account
                        </Label>
                        {facebookSources.some(s => s.instagramAccount) ? (
                          <>
                            <Select
                              value={selectedInstagramSource}
                              onValueChange={setSelectedInstagramSource}
                            >
                              <SelectTrigger className="bg-black/30 border-white/10 text-white" data-testid="select-instagram-source">
                                <SelectValue placeholder="Select an Instagram account" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">No Instagram account</SelectItem>
                                {facebookSources
                                  .filter(s => s.instagramAccount)
                                  .map((source) => (
                                    <SelectItem key={source.instagramAccount!.id} value={source.instagramAccount!.id}>
                                      <div className="flex items-center gap-2">
                                        <span>@{source.instagramAccount!.username}</span>
                                        <span className="text-xs text-muted-foreground">
                                          (linked to {source.name})
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                          {formatFollowers(source.instagramAccount!.followers)} followers
                                        </span>
                                      </div>
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                              Instagram Business accounts are linked through Facebook Pages
                            </p>
                          </>
                        ) : (
                          <div className="bg-black/20 border border-white/10 rounded-lg p-4">
                            <p className="text-sm text-muted-foreground mb-2">
                              No Instagram Business accounts found linked to your Facebook Pages.
                            </p>
                            <p className="text-xs text-muted-foreground">
                              To import Instagram content, you need an Instagram Business or Creator account 
                              linked to one of your Facebook Pages. You can set this up in 
                              <a 
                                href="https://business.facebook.com/settings/instagram-account-linking" 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-[#E4405F] hover:underline ml-1"
                              >
                                Meta Business Suite
                              </a>.
                            </p>
                          </div>
                        )}
                      </div>

                      <Button
                        onClick={handleSaveSourceSelection}
                        className="w-full mt-2"
                        data-testid="button-save-sources"
                      >
                        <Save className="w-4 h-4 mr-2" />
                        Save Source Selection
                      </Button>
                    </div>
                  </div>
                )}

                {/* Loading state for sources */}
                {isLoadingSources && (
                  <div className="mt-6 bg-black/30 rounded-xl border border-white/5 p-6 flex items-center justify-center">
                    <Loader2 className="w-6 h-6 animate-spin text-primary mr-3" />
                    <span className="text-muted-foreground">Loading available sources...</span>
                  </div>
                )}

                {/* Data Management Section */}
                <div className="mt-8 bg-black/30 rounded-xl border border-destructive/20 p-6">
                  <h3 className="text-lg font-semibold text-white mb-2">Data Management</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Clear orphaned videos from your library. Use this if you see videos that shouldn't be there after disconnecting platforms.
                  </p>
                  <Button
                    variant="destructive"
                    onClick={handleClearLibrary}
                    disabled={isClearingLibrary}
                    data-testid="button-clear-library"
                    className="gap-2"
                  >
                    {isClearingLibrary ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Clearing...
                      </>
                    ) : (
                      <>
                        <Trash2 className="w-4 h-4" />
                        Clear Library
                      </>
                    )}
                  </Button>
                </div>
              </motion.div>
            )}

            {activeTab === "payouts" && (
              <motion.div
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                className="space-y-6"
              >
                <div className="bg-white/5 rounded-xl border border-white/5 p-6">
                  <h2 className="text-xl font-semibold text-white mb-6">Payout Configuration</h2>
                  
                  <div className="bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 rounded-xl p-6 border border-emerald-500/20 mb-6">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <p className="text-sm text-emerald-400/80 font-mono uppercase tracking-wider mb-1">Pending Payouts</p>
                        <p className="text-4xl font-bold text-emerald-400" data-testid="text-balance">
                          ${(pendingPayoutCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Your 70% share of approved brand placements
                        </p>
                      </div>
                      <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">
                        Accruing
                      </Badge>
                    </div>
                  </div>

                  <div className="border-t border-white/5 pt-6">
                    <h3 className="text-lg font-semibold text-white mb-4">Stripe Connect</h3>
                    
                    <div className="bg-black/30 rounded-lg p-4 border border-white/5">
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-[#635BFF]/20 rounded-lg flex items-center justify-center">
                            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
                              <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" fill="#635BFF"/>
                            </svg>
                          </div>
                          <div>
                            <p className="text-white font-medium">Stripe Connect</p>
                            <p className="text-sm text-muted-foreground">
                              Payout onboarding isn't live yet — accrued payouts will transfer once it is.
                            </p>
                          </div>
                        </div>
                        <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30">
                          Coming soon
                        </Badge>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === "credits" && <CreditsPanel />}

            {activeTab === "notifications" && (
              <motion.div
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white/5 rounded-xl border border-white/5 p-6"
              >
                <h2 className="text-xl font-semibold text-white mb-6">Notification Preferences</h2>
                
                <div className="space-y-6">
                  <div className="flex items-center justify-between py-3 border-b border-white/5">
                    <div>
                      <p className="text-white font-medium">New Brand Offer Received</p>
                      <p className="text-sm text-muted-foreground">Get notified when brands make offers on your content</p>
                    </div>
                    <Switch
                      checked={notifications.newBrandOffer}
                      onCheckedChange={(checked) => setNotifications({ ...notifications, newBrandOffer: checked })}
                      data-testid="switch-brand-offer"
                    />
                  </div>
                  
                  <div className="flex items-center justify-between py-3 border-b border-white/5">
                    <div>
                      <p className="text-white font-medium">Video Analysis Complete</p>
                      <p className="text-sm text-muted-foreground">Get notified when AI finishes analyzing your videos</p>
                    </div>
                    <Switch
                      checked={notifications.videoAnalysisComplete}
                      onCheckedChange={(checked) => setNotifications({ ...notifications, videoAnalysisComplete: checked })}
                      data-testid="switch-video-analysis"
                    />
                  </div>
                  
                  <div className="flex items-center justify-between py-3">
                    <div>
                      <p className="text-white font-medium">Weekly Revenue Report</p>
                      <p className="text-sm text-muted-foreground">Receive a summary of your earnings every Monday</p>
                    </div>
                    <Switch
                      checked={notifications.weeklyRevenueReport}
                      onCheckedChange={(checked) => setNotifications({ ...notifications, weeklyRevenueReport: checked })}
                      data-testid="switch-weekly-report"
                    />
                  </div>
                </div>
              </motion.div>
            )}

            <div className="flex justify-end mt-6">
              <Button onClick={handleSave} className="gap-2" data-testid="button-save-settings">
                <Save className="w-4 h-4" />
                Save Changes
              </Button>
            </div>
          </div>
        </motion.div>
      </main>
    </div>
  );
}
