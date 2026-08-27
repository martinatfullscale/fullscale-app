import { useState, useEffect, useCallback, useRef } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send, X, Loader2, BarChart3, TrendingUp, Eye, Heart,
  MessageCircle, Share2, Globe, Smartphone, Tv, Calendar,
  Clock, CheckCircle, AlertCircle, RefreshCw, Link2,
  Sparkles, Download, ChevronDown, ChevronUp, Users
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

// ─── Types ──────────────────────────────────────────────────────

interface DistributionProfile {
  id: number;
  platform: string;
  accountName: string | null;
  isActive: boolean;
}

interface PublishedPost {
  id: number;
  clipId: number;
  videoId: number;
  platform: string;
  postUrl: string | null;
  caption: string | null;
  status: string;
  publishedAt: string | null;
  errorMessage: string | null;
}

interface GeneratedClip {
  id: number;
  videoId: number;
  duration: number;
  platformTarget: string | null;
  qualityScore: number | null;
  exportPath: string | null;
  thumbnailPath: string | null;
  status: string | null;
  /** Which table this id belongs to — both use serial ids, so it is ambiguous
   *  on its own. "editorial" clips come from the transcript-first editor. */
  clipSource?: "remix" | "editorial";
  title?: string | null;
  aspectRatio?: string | null;
}

interface AggregateMetrics {
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  totalReach: number;
  avgEngagementRate: number;
  avgCompletionRate: number;
  brandExposureMinutes: number;
  platformBreakdown: Record<string, {
    platform: string;
    postsCount: number;
    totalViews: number;
    totalLikes: number;
    avgEngagementRate: number;
  }>;
  topClips: Array<{
    clipId: number;
    platform: string;
    views: number;
    engagementRate: number;
  }>;
}

interface DistributionDashboardProps {
  videoId: number;
  open: boolean;
  onClose: () => void;
}

// ─── Constants ──────────────────────────────────────────────────

const PLATFORM_CONFIG: Record<string, { label: string; icon: any; color: string; bgColor: string }> = {
  tiktok: { label: "TikTok", icon: Smartphone, color: "text-pink-400", bgColor: "bg-pink-500/20" },
  instagram_reels: { label: "Instagram", icon: Smartphone, color: "text-purple-400", bgColor: "bg-purple-500/20" },
  instagram: { label: "Instagram", icon: Smartphone, color: "text-purple-400", bgColor: "bg-purple-500/20" },
  facebook: { label: "Facebook Page", icon: Users, color: "text-blue-400", bgColor: "bg-blue-600/20" },
  youtube_shorts: { label: "YouTube", icon: Tv, color: "text-red-400", bgColor: "bg-red-500/20" },
  youtube: { label: "YouTube", icon: Tv, color: "text-red-400", bgColor: "bg-red-500/20" },
  twitter: { label: "Twitter/X", icon: Globe, color: "text-blue-400", bgColor: "bg-blue-500/20" },
  linkedin: { label: "LinkedIn", icon: Users, color: "text-cyan-400", bgColor: "bg-cyan-500/20" },
};

// ─── Component ──────────────────────────────────────────────────

export default function DistributionDashboard({ videoId, open, onClose }: DistributionDashboardProps) {
  const { toast } = useToast();
  const [tab, setTab] = useState<"overview" | "publish" | "schedule" | "analytics">("overview");
  const [profiles, setProfiles] = useState<DistributionProfile[]>([]);
  const [posts, setPosts] = useState<PublishedPost[]>([]);
  const [clips, setClips] = useState<GeneratedClip[]>([]);
  const [metrics, setMetrics] = useState<AggregateMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Publishing state
  const [selectedClipId, setSelectedClipId] = useState<number | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
  const [customCaption, setCustomCaption] = useState("");
  const [available, setAvailable] = useState<Array<{ platform: string; label: string; handle: string | null; enableVia: string }>>([]);
  /** Connected, but no publisher exists for it. Named so its absence from the
   *  list above is explained rather than looking like a missing feature. */
  const [unsupported, setUnsupported] = useState<Array<{ platform: string; label: string; reason: string }>>([]);
  const [enabling, setEnabling] = useState<string | null>(null);

  /** Turn a connected account into a publishing profile. Explicit, because a
   *  publishing profile is permission to post on someone's account. */
  const enableProfile = async (a: { platform: string; enableVia: string }) => {
    setEnabling(a.platform);
    try {
      const res = await fetchWithTimeout(a.enableVia, { method: "POST", credentials: "include" });
      if (res.ok) await loadDataRef.current?.();
      else {
        const b = await res.json().catch(() => ({}));
        console.error("[Distribution] enable failed:", b?.error);
      }
    } finally {
      setEnabling(null);
    }
  };

  const [disconnecting, setDisconnecting] = useState<number | null>(null);

  /**
   * Disconnect a platform. Confirms first when posts are queued to it, because
   * disconnecting cancels them — silently publishing to a disconnected account
   * later would be worse, but so would cancelling without saying so.
   */
  const disconnectProfile = async (p: DistributionProfile) => {
    const queued = posts.filter((x: any) => x.profileId === p.id && x.status === "scheduled").length;
    const label = p.accountName || p.platform;
    const warning = queued > 0
      ? `Disconnect ${label}?\n\n${queued} scheduled post${queued === 1 ? "" : "s"} will be cancelled. Posts already published stay in your history.`
      : `Disconnect ${label}?\n\nPosts already published stay in your history.`;
    if (!window.confirm(warning)) return;

    setDisconnecting(p.id);
    try {
      const res = await fetchWithTimeout(`/api/distribution/profiles/${p.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body?.cancelledSchedules > 0) {
          console.log(`[Distribution] cancelled ${body.cancelledSchedules} scheduled post(s)`);
        }
        await loadDataRef.current?.();
      } else {
        const b = await res.json().catch(() => ({}));
        window.alert(b?.error || "Could not disconnect that account.");
      }
    } finally {
      setDisconnecting(null);
    }
  };

  const [showCaptionPreview, setShowCaptionPreview] = useState(false);
  const [captionPreview, setCaptionPreview] = useState<{ caption: string; hashtags: string[] } | null>(null);

  const loadDataRef = useRef<null | (() => Promise<void>)>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [profilesRes, postsRes, clipsRes, metricsRes, availableRes] = await Promise.all([
        fetchWithTimeout("/api/distribution/profiles", { credentials: "include" }),
        fetchWithTimeout(`/api/distribution/posts/video/${videoId}`, { credentials: "include" }),
        fetchWithTimeout(`/api/remix/clips/${videoId}`, { credentials: "include" }),
        fetchWithTimeout(`/api/distribution/analytics/video/${videoId}`, { credentials: "include" }),
        // Accounts that are CONNECTED but have no publishing profile. Without
        // this the hub says "no social platform connected" to a creator who
        // connected one — the connection and the publishing profile live in
        // different tables and nothing bridges them automatically.
        fetchWithTimeout("/api/distribution/profiles/available", { credentials: "include" }),
      ]);

      if (profilesRes.ok) setProfiles(await profilesRes.json());
      if (availableRes.ok) {
        const a = await availableRes.json();
        setAvailable(a.available ?? []);
        setUnsupported(a.unsupported ?? []);
      }
      if (postsRes.ok) setPosts(await postsRes.json());
      if (clipsRes.ok) {
        const allClips = await clipsRes.json();
        // "rendered" is the editorial pipeline's finished state. Accept it
        // directly as well as the server's normalisation, so a mismatch on
        // either side cannot silently empty this list again.
        setClips(allClips.filter((c: GeneratedClip) =>
          c.status === "ready" || c.status === "generated" || c.status === "rendered"));
      }
      if (metricsRes.ok) setMetrics(await metricsRes.json());
    } catch (err) {
      console.error("Failed to load distribution data:", err);
    }
    setIsLoading(false);
  }, [videoId]);

  useEffect(() => {
    loadDataRef.current = loadData;
  }, [loadData]);

  useEffect(() => {
    if (open) loadData();
  }, [open, loadData]);

  const publishClip = async () => {
    if (!selectedClipId || !selectedProfileId) return;
    setIsPublishing(true);
    try {
      const res = await fetchWithTimeout("/api/distribution/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          clipId: selectedClipId,
          // Which table the id belongs to. generated_clips and editorial_clips
          // both use serial ids, so id alone is ambiguous.
          clipSource: clips.find((c: any) => c.id === selectedClipId)?.clipSource ?? "remix",
          profileId: selectedProfileId,
          caption: customCaption || undefined,
        }),
      });

      const data = await res.json();
      if (data.success) {
        toast({ title: "Published!", description: `Clip posted to ${data.post.platform}` });
        await loadData();
        setSelectedClipId(null);
        setCustomCaption("");
      } else {
        toast({ title: "Failed", description: data.error, variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
    setIsPublishing(false);
  };

  const refreshAnalytics = async () => {
    setIsRefreshing(true);
    try {
      const res = await fetchWithTimeout(`/api/distribution/analytics/video/${videoId}/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
        toast({ title: "Refreshed", description: "Analytics updated from all platforms" });
      }
    } catch {}
    setIsRefreshing(false);
  };

  const previewCaption = async (platform: string) => {
    try {
      const res = await fetchWithTimeout("/api/distribution/format-caption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          platform,
          clipId: selectedClipId,
          // Which table the id belongs to. generated_clips and editorial_clips
          // both use serial ids, so id alone is ambiguous.
          clipSource: clips.find((c: any) => c.id === selectedClipId)?.clipSource ?? "remix",
          customCaption: customCaption || undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setCaptionPreview(data);
        setShowCaptionPreview(true);
      }
    } catch {}
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          className="bg-gray-900 rounded-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col"
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-800">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-green-500 to-teal-500 flex items-center justify-center">
                <Send className="w-5 h-5 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">Distribution Hub</h2>
                <p className="text-sm text-gray-400">Publish clips and track performance across platforms</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-5 h-5" />
            </Button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-800 px-6">
            {[
              { key: "overview", label: "Overview", icon: BarChart3 },
              { key: "publish", label: "Publish", icon: Send },
              { key: "schedule", label: "Schedule", icon: Calendar },
              { key: "analytics", label: "Analytics", icon: TrendingUp },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setTab(key as any)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  tab === key
                    ? "border-green-500 text-green-400"
                    : "border-transparent text-gray-400 hover:text-gray-200"
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {isLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 text-gray-400 animate-spin" />
              </div>
            ) : (
              <>
                {tab === "overview" && (
                  <OverviewTab
                    metrics={metrics}
                    posts={posts}
                    profiles={profiles}
                    available={available}
                    unsupported={unsupported}
                    enabling={enabling}
                    onEnable={enableProfile}
                    disconnecting={disconnecting}
                    onDisconnect={disconnectProfile}
                  />
                )}
                {tab === "publish" && (
                  <PublishTab
                    clips={clips}
                    profiles={profiles}
                    selectedClipId={selectedClipId}
                    selectedProfileId={selectedProfileId}
                    customCaption={customCaption}
                    isPublishing={isPublishing}
                    captionPreview={captionPreview}
                    showCaptionPreview={showCaptionPreview}
                    onSelectClip={setSelectedClipId}
                    onSelectProfile={setSelectedProfileId}
                    onCaptionChange={setCustomCaption}
                    onPublish={publishClip}
                    onPreviewCaption={previewCaption}
                    onToggleCaptionPreview={() => setShowCaptionPreview(!showCaptionPreview)}
                  />
                )}
                {tab === "schedule" && <ScheduleTab videoId={videoId} clips={clips} profiles={profiles} />}
                {tab === "analytics" && (
                  <AnalyticsTab metrics={metrics} isRefreshing={isRefreshing} onRefresh={refreshAnalytics} />
                )}
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Tab Components ─────────────────────────────────────────────

interface AvailableAccount { platform: string; label: string; handle: string | null; enableVia: string }

function OverviewTab({
  metrics,
  posts,
  profiles,
  available,
  unsupported,
  enabling,
  onEnable,
  disconnecting,
  onDisconnect,
}: {
  metrics: AggregateMetrics | null;
  posts: PublishedPost[];
  profiles: DistributionProfile[];
  /** Connected accounts with no publishing profile yet. */
  available: AvailableAccount[];
  unsupported: Array<{ platform: string; label: string; reason: string }>;
  enabling: string | null;
  onEnable: (a: AvailableAccount) => void;
  disconnecting: number | null;
  onDisconnect: (p: DistributionProfile) => void;
}) {
  return (
    <div className="space-y-6">
      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={Eye} label="Total Views" value={formatNumber(metrics?.totalViews || 0)} color="text-blue-400" />
        <StatCard icon={Heart} label="Total Likes" value={formatNumber(metrics?.totalLikes || 0)} color="text-pink-400" />
        <StatCard icon={MessageCircle} label="Comments" value={formatNumber(metrics?.totalComments || 0)} color="text-green-400" />
        <StatCard icon={Share2} label="Shares" value={formatNumber(metrics?.totalShares || 0)} color="text-purple-400" />
      </div>

      {/* Connected Platforms */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Connected Platforms</h3>
        {profiles.length === 0 && available.length > 0 ? (
          // CONNECTED, just not enabled for publishing. Saying "no platforms
          // connected" to someone who connected one is the bug being fixed:
          // the connection and the publishing profile are different records,
          // and nothing bridged them.
          <div className="bg-gray-800/50 rounded-xl p-4">
            <p className="text-gray-300 text-sm font-medium">Ready to enable</p>
            <p className="text-gray-500 text-xs mt-0.5 mb-3">
              These accounts are connected. Turn on publishing to send clips to them.
            </p>
            <div className="space-y-2">
              {available.map((a) => (
                <div key={a.platform} className="flex items-center gap-3 bg-gray-900/60 rounded-lg px-3 py-2">
                  <Globe className="w-4 h-4 text-gray-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-200">{a.label}</p>
                    {a.handle && <p className="text-xs text-gray-500 truncate">{a.handle}</p>}
                  </div>
                  <Button
                    size="sm"
                    disabled={enabling !== null}
                    onClick={() => onEnable(a)}
                    data-testid={`enable-${a.platform}`}
                  >
                    {enabling === a.platform ? "Enabling…" : "Enable"}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : profiles.length === 0 ? (
          <div className="bg-gray-800/50 rounded-xl p-6 text-center">
            <Globe className="w-8 h-8 text-gray-600 mx-auto mb-2" />
            <p className="text-gray-400 text-sm">No platforms connected yet</p>
            <p className="text-gray-500 text-xs mt-1">Connect your social accounts in Settings to start distributing clips</p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {profiles.map(p => {
              const config = PLATFORM_CONFIG[p.platform] || { label: p.platform, icon: Globe, color: "text-gray-400", bgColor: "bg-gray-500/20" };
              const Icon = config.icon;
              return (
                <div key={p.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg ${config.bgColor}`}>
                  <Icon className={`w-4 h-4 ${config.color}`} />
                  <span className="text-sm text-gray-200">{p.accountName || config.label}</span>
                  <CheckCircle className="w-3 h-3 text-green-400" />
                  {/* Enabling a platform with no way to leave it is a trap —
                      switching platforms is a normal thing to want. */}
                  <button
                    onClick={() => onDisconnect(p)}
                    disabled={disconnecting !== null}
                    title={`Disconnect ${config.label}`}
                    className="ml-1 text-gray-500 hover:text-red-400 disabled:opacity-50 transition-colors"
                    data-testid={`disconnect-${p.platform}`}
                  >
                    {disconnecting === p.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <X className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {unsupported.length > 0 && (
          <div className="mt-2 space-y-1">
            {unsupported.map((u) => (
              <p key={u.platform} className="text-[11px] text-gray-500 leading-snug">
                <span className="text-gray-400">{u.label}:</span> {u.reason}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Recent Posts */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Recent Posts ({posts.length})</h3>
        {posts.length === 0 ? (
          <p className="text-gray-500 text-sm">No clips published yet</p>
        ) : (
          <div className="space-y-2">
            {posts.slice(0, 5).map(post => {
              const config = PLATFORM_CONFIG[post.platform] || { label: post.platform, icon: Globe, color: "text-gray-400", bgColor: "bg-gray-500/20" };
              return (
                <div key={post.id} className="bg-gray-800/50 rounded-lg p-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Badge className={config.bgColor + " " + config.color}>{config.label}</Badge>
                    <span className="text-sm text-gray-300 truncate max-w-[300px]">
                      {post.caption?.slice(0, 60) || "No caption"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className={
                      post.status === "published" ? "bg-green-500/20 text-green-400" :
                      post.status === "failed" ? "bg-red-500/20 text-red-400" :
                      "bg-yellow-500/20 text-yellow-400"
                    }>
                      {post.status}
                    </Badge>
                    {post.postUrl && (
                      <a href={post.postUrl} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-white">
                        <Link2 className="w-4 h-4" />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PublishTab({
  clips, profiles, selectedClipId, selectedProfileId, customCaption,
  isPublishing, captionPreview, showCaptionPreview,
  onSelectClip, onSelectProfile, onCaptionChange, onPublish, onPreviewCaption, onToggleCaptionPreview,
}: {
  clips: GeneratedClip[];
  profiles: DistributionProfile[];
  selectedClipId: number | null;
  selectedProfileId: number | null;
  customCaption: string;
  isPublishing: boolean;
  captionPreview: { caption: string; hashtags: string[] } | null;
  showCaptionPreview: boolean;
  onSelectClip: (id: number | null) => void;
  onSelectProfile: (id: number | null) => void;
  onCaptionChange: (v: string) => void;
  onPublish: () => void;
  onPreviewCaption: (platform: string) => void;
  onToggleCaptionPreview: () => void;
}) {
  const selectedProfile = profiles.find(p => p.id === selectedProfileId);

  return (
    <div className="space-y-6">
      {/* Step 1: Select Clip */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">1. Select a Clip</h3>
        {clips.length === 0 ? (
          <p className="text-gray-500 text-sm">No clips ready for publishing. Generate clips in Remix Studio first.</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {clips.map(clip => (
              <button
                // Both tables use serial ids, so id alone can collide.
                key={`${clip.clipSource ?? "remix"}:${clip.id}`}
                onClick={() => onSelectClip(clip.id === selectedClipId ? null : clip.id)}
                className={`relative rounded-lg overflow-hidden border-2 transition-all ${
                  clip.id === selectedClipId
                    ? "border-green-500 ring-2 ring-green-500/30"
                    : "border-gray-700 hover:border-gray-500"
                }`}
              >
                <div className="aspect-video bg-gray-800 flex items-center justify-center">
                  {clip.thumbnailPath ? (
                    <img src={clip.thumbnailPath} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Tv className="w-8 h-8 text-gray-600" />
                  )}
                </div>
                <div className="p-2 bg-gray-800/90">
                  {clip.title && (
                    <p className="text-[11px] text-gray-300 truncate text-left mb-0.5">{clip.title}</p>
                  )}
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs text-gray-400">{clip.duration?.toFixed(1)}s</span>
                    {/* Which pipeline produced this. Editorial clips come from
                        the transcript-first editor and were previously absent
                        from this list entirely. */}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      clip.clipSource === "editorial"
                        ? "bg-purple-500/20 text-purple-300"
                        : "bg-gray-700 text-gray-400"
                    }`}>
                      {clip.clipSource === "editorial" ? "Editorial" : (clip.aspectRatio || clip.platformTarget || "Remix")}
                    </span>
                  </div>
                </div>
                {clip.id === selectedClipId && (
                  <div className="absolute top-2 right-2">
                    <CheckCircle className="w-5 h-5 text-green-400" />
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Step 2: Select Platform */}
      {selectedClipId && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-3">2. Select Platform</h3>
          {profiles.length === 0 ? (
            <p className="text-gray-500 text-sm">Connect a platform account first to publish.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {profiles.map(p => {
                const config = PLATFORM_CONFIG[p.platform] || { label: p.platform, icon: Globe, color: "text-gray-400", bgColor: "bg-gray-500/20" };
                const Icon = config.icon;
                const isSelected = p.id === selectedProfileId;
                return (
                  <button
                    key={p.id}
                    onClick={() => onSelectProfile(isSelected ? null : p.id)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-all ${
                      isSelected
                        ? "border-green-500 bg-green-500/10 text-green-300"
                        : "border-gray-700 text-gray-400 hover:border-gray-500"
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="text-sm">{p.accountName || config.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Step 3: Caption */}
      {selectedClipId && selectedProfileId && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-300">3. Caption (optional)</h3>
            {selectedProfile && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onPreviewCaption(selectedProfile.platform)}
                className="text-xs text-green-400"
              >
                <Sparkles className="w-3 h-3 mr-1" /> Auto-generate
              </Button>
            )}
          </div>
          <textarea
            value={customCaption}
            onChange={(e) => onCaptionChange(e.target.value)}
            placeholder="Leave empty for AI-generated caption..."
            className="w-full bg-gray-800 text-white rounded-lg p-3 text-sm border border-gray-700 focus:border-green-500 focus:outline-none resize-none h-24"
          />

          {showCaptionPreview && captionPreview && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="mt-2 bg-gray-800/50 rounded-lg p-3 border border-gray-700"
            >
              <p className="text-sm text-gray-300">{captionPreview.caption}</p>
              <div className="flex flex-wrap gap-1 mt-2">
                {captionPreview.hashtags.map(h => (
                  <span key={h} className="text-xs text-green-400">#{h}</span>
                ))}
              </div>
            </motion.div>
          )}
        </div>
      )}

      {/* Publish Button */}
      {selectedClipId && selectedProfileId && (
        <Button
          onClick={onPublish}
          disabled={isPublishing}
          className="w-full bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-500 hover:to-teal-500 text-white font-semibold"
        >
          {isPublishing ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Publishing...</>
          ) : (
            <><Send className="w-4 h-4 mr-2" /> Publish Now</>
          )}
        </Button>
      )}
    </div>
  );
}

function ScheduleTab({
  videoId,
  clips,
  profiles,
}: {
  videoId: number;
  clips: GeneratedClip[];
  profiles: DistributionProfile[];
}) {
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<any[]>([]);
  const [selectedClip, setSelectedClip] = useState<number | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<number | null>(null);
  const [scheduledTime, setScheduledTime] = useState("");

  useEffect(() => {
    fetchWithTimeout("/api/distribution/schedules", { credentials: "include" })
      .then(r => r.ok ? r.json() : [])
      .then(setSchedules)
      .catch(() => {});
  }, []);

  const createSchedule = async () => {
    if (!selectedClip || !selectedProfile || !scheduledTime) return;
    const profile = profiles.find(p => p.id === selectedProfile);

    try {
      const res = await fetchWithTimeout("/api/distribution/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          clipId: selectedClip,
          profileId: selectedProfile,
          platform: profile?.platform || "tiktok",
          scheduledFor: new Date(scheduledTime).toISOString(),
        }),
      });
      if (res.ok) {
        const schedule = await res.json();
        setSchedules(prev => [...prev, schedule]);
        toast({ title: "Scheduled", description: `Post scheduled for ${new Date(scheduledTime).toLocaleString()}` });
        setSelectedClip(null);
        setScheduledTime("");
      }
    } catch {}
  };

  const cancelSchedule = async (id: number) => {
    try {
      await fetchWithTimeout(`/api/distribution/schedules/${id}`, { method: "DELETE", credentials: "include" });
      setSchedules(prev => prev.filter(s => s.id !== id));
    } catch {}
  };

  return (
    <div className="space-y-6">
      {/* Schedule form */}
      <div className="bg-gray-800/50 rounded-xl p-4 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <Calendar className="w-4 h-4" /> Schedule a Post
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <select
            value={selectedClip || ""}
            onChange={(e) => setSelectedClip(e.target.value ? parseInt(e.target.value) : null)}
            className="bg-gray-700 text-white text-sm rounded-lg px-3 py-2 border border-gray-600"
          >
            <option value="">Select clip...</option>
            {clips.map(c => (
              <option key={c.id} value={c.id}>Clip #{c.id} ({c.duration?.toFixed(0)}s, {c.platformTarget})</option>
            ))}
          </select>

          <select
            value={selectedProfile || ""}
            onChange={(e) => setSelectedProfile(e.target.value ? parseInt(e.target.value) : null)}
            className="bg-gray-700 text-white text-sm rounded-lg px-3 py-2 border border-gray-600"
          >
            <option value="">Select platform...</option>
            {profiles.map(p => (
              <option key={p.id} value={p.id}>
                {PLATFORM_CONFIG[p.platform]?.label || p.platform} — {p.accountName}
              </option>
            ))}
          </select>

          <input
            type="datetime-local"
            value={scheduledTime}
            onChange={(e) => setScheduledTime(e.target.value)}
            className="bg-gray-700 text-white text-sm rounded-lg px-3 py-2 border border-gray-600"
          />
        </div>

        <Button
          onClick={createSchedule}
          disabled={!selectedClip || !selectedProfile || !scheduledTime}
          size="sm"
          className="bg-green-600 hover:bg-green-500"
        >
          <Calendar className="w-4 h-4 mr-2" /> Schedule
        </Button>
      </div>

      {/* Scheduled posts */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Scheduled Posts ({schedules.length})</h3>
        {schedules.length === 0 ? (
          <p className="text-gray-500 text-sm">No scheduled posts</p>
        ) : (
          <div className="space-y-2">
            {schedules.map((s: any) => (
              <div key={s.id} className="bg-gray-800/50 rounded-lg p-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Clock className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-300">
                    Clip #{s.clipId} → {PLATFORM_CONFIG[s.platform]?.label || s.platform}
                  </span>
                  <span className="text-xs text-gray-500">
                    {new Date(s.scheduledFor).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={
                    s.status === "completed" ? "bg-green-500/20 text-green-400" :
                    s.status === "failed" ? "bg-red-500/20 text-red-400" :
                    s.status === "cancelled" ? "bg-gray-500/20 text-gray-400" :
                    "bg-yellow-500/20 text-yellow-400"
                  }>
                    {s.status}
                  </Badge>
                  {s.status === "pending" && (
                    <Button size="sm" variant="ghost" onClick={() => cancelSchedule(s.id)} className="text-red-400 text-xs">
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AnalyticsTab({
  metrics,
  isRefreshing,
  onRefresh,
}: {
  metrics: AggregateMetrics | null;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  if (!metrics) {
    return (
      <div className="text-center py-12">
        <BarChart3 className="w-12 h-12 text-gray-600 mx-auto mb-3" />
        <p className="text-gray-400">No analytics data yet</p>
        <p className="text-xs text-gray-500 mt-1">Publish clips first, then check back for performance metrics</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Refresh button */}
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={isRefreshing}>
          <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
          {isRefreshing ? "Refreshing..." : "Refresh Analytics"}
        </Button>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={Eye} label="Total Views" value={formatNumber(metrics.totalViews)} color="text-blue-400" />
        <StatCard icon={TrendingUp} label="Engagement Rate" value={`${(metrics.avgEngagementRate * 100).toFixed(1)}%`} color="text-green-400" />
        <StatCard icon={Users} label="Total Reach" value={formatNumber(metrics.totalReach)} color="text-purple-400" />
        <StatCard icon={Clock} label="Brand Exposure" value={`${metrics.brandExposureMinutes.toFixed(0)} min`} color="text-orange-400" />
      </div>

      {/* Platform Breakdown */}
      {Object.keys(metrics.platformBreakdown).length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-3">Platform Performance</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {Object.values(metrics.platformBreakdown).map((pd) => {
              const config = PLATFORM_CONFIG[pd.platform] || { label: pd.platform, icon: Globe, color: "text-gray-400", bgColor: "bg-gray-500/20" };
              const Icon = config.icon;
              return (
                <div key={pd.platform} className="bg-gray-800/50 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Icon className={`w-5 h-5 ${config.color}`} />
                    <span className="font-medium text-white">{config.label}</span>
                    <Badge className="bg-gray-700 text-gray-300">{pd.postsCount} posts</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-lg font-bold text-white">{formatNumber(pd.totalViews)}</p>
                      <p className="text-xs text-gray-500">Views</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-white">{formatNumber(pd.totalLikes)}</p>
                      <p className="text-xs text-gray-500">Likes</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-white">{(pd.avgEngagementRate * 100).toFixed(1)}%</p>
                      <p className="text-xs text-gray-500">Eng. Rate</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top Clips */}
      {metrics.topClips.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-3">Top Performing Clips</h3>
          <div className="space-y-2">
            {metrics.topClips.map((tc, i) => (
              <div key={tc.clipId} className="bg-gray-800/50 rounded-lg p-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-lg font-bold text-gray-500">#{i + 1}</span>
                  <span className="text-sm text-gray-300">Clip #{tc.clipId}</span>
                  <Badge className={PLATFORM_CONFIG[tc.platform]?.bgColor + " " + PLATFORM_CONFIG[tc.platform]?.color}>
                    {PLATFORM_CONFIG[tc.platform]?.label || tc.platform}
                  </Badge>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-gray-400"><Eye className="w-3 h-3 inline mr-1" />{formatNumber(tc.views)}</span>
                  <span className="text-green-400">{(tc.engagementRate * 100).toFixed(1)}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: string; color: string }) {
  return (
    <div className="bg-gray-800/50 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-4 h-4 ${color}`} />
        <span className="text-xs text-gray-400">{label}</span>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
