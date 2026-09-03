import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch, useLocation } from "wouter";
import {
  Clapperboard, Play, Pencil, Send, Download, MoreHorizontal, Film, Sparkles, Scissors,
  Loader2, AlertTriangle, Search, Plus, Trash2, ExternalLink, CheckCircle2, Layers, RefreshCw, X,
} from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { fetchWithTimeout } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import ClipStudio from "@/components/ClipStudio";
import DistributionDashboard from "@/components/DistributionDashboard";
import ReelBuilder, { type ReelClip } from "@/components/ReelBuilder";
import RemixStudio from "@/components/RemixStudio";

/**
 * Clips & Reels — the home for everything FullScale cut for a creator.
 *
 * Until this page existed the flagship output had no address: story clips
 * lived behind a per-video modal in the Library grid, reels only appeared
 * inside the Reel Builder's picker, and every "your clips are ready"
 * notification landed on a thumbnail wall. This is the receipt: one feed,
 * across videos, with the state of each item and the next action on it.
 */

type Kind = "editorial" | "remix" | "reel";
type Status = "ready" | "rendering" | "pending" | "failed" | "needs_review";

interface PostMetrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  engagementRate: number | null;
  watchTimeSeconds: number | null;
  fetchedAt: string | null;
}

interface PublishedRef {
  postId: number;
  platform: string;
  postUrl: string | null;
  status: string;
  publishedAt: string | null;
  error: string | null;
  /** null until the capture job has polled the platform. Never rendered as 0. */
  metrics: PostMetrics | null;
  /** false when the platform has no metrics API we can use at all. */
  metricsSupported: boolean;
}

interface ClipItem {
  key: string;
  kind: Kind;
  id: number;
  clipSource: "editorial" | "remix" | null;
  publishId: number | null;
  videoId: number;
  videoTitle: string;
  videoThumbnail: string | null;
  title: string;
  thumbnailPath: string | null;
  mediaUrl: string | null;
  downloadUrl: string | null;
  duration: number;
  clipStart: number;
  clipEnd: number;
  aspectRatio: string | null;
  platformTarget: string | null;
  status: Status;
  error: string | null;
  score: number | null;
  tier: string | null;
  topicTags: string[];
  segmentsCount: number;
  createdAt: string | null;
  completedAt: string | null;
  published: PublishedRef[];
  row?: any;
}

interface ClipsFeed {
  items: ClipItem[];
  truncated?: boolean;
  videos: Array<{ id: number; title: string }>;
  counts: { total: number; ready: number; rendering: number; failed: number; published: number };
}

type KindFilter = "all" | Kind;
type StatusFilter = "all" | Status | "published";
type SortKey = "newest" | "score" | "longest";

const KIND_LABEL: Record<Kind, string> = { editorial: "Story clip", remix: "Remix clip", reel: "Reel" };
const KIND_ICON: Record<Kind, typeof Film> = { editorial: Sparkles, remix: Scissors, reel: Film };
const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube", youtube_shorts: "YouTube", tiktok: "TikTok", instagram: "Instagram",
  instagram_reels: "Instagram", facebook: "Facebook", twitter: "X", linkedin: "LinkedIn",
};

const fmtDuration = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
};
const fmtDate = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const fmtScore = (score: number | null): string | null => {
  if (score == null || !Number.isFinite(score)) return null;
  return String(Math.round(score <= 1 ? score * 100 : score));
};
const isLive = (p: PublishedRef) => p.status === "published" || p.status === "dry_run";

/** Human age of a capture, or null when we have no timestamp. */
const metricsAge = (iso: string | null): string | null => {
  if (!iso) return null;
  const hrs = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (!Number.isFinite(hrs) || hrs < 0) return null;
  if (hrs < 1) return "just now";
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
};

/** A capture older than this is shown muted — it is history, not status. */
const isStale = (iso: string | null): boolean =>
  !!iso && Date.now() - new Date(iso).getTime() > 48 * 3_600_000;

const compactNum = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

/** Why a number is missing, said out loud. A blank chip that never explains
 *  itself is how "0 views" gets read as "nobody watched". */
const metricsTitle = (p: PublishedRef): string => {
  if (!p.postUrl && !p.metrics) return "Published";
  if (!p.metricsSupported) return `${PLATFORM_LABEL[p.platform] ?? p.platform} doesn't report per-post numbers to us — open the post to see them.`;
  if (!p.metrics) return "Published. Numbers arrive after the next stats check (within a few hours).";
  const bits: string[] = [];
  if (p.metrics.views != null) bits.push(`${p.metrics.views.toLocaleString()} views`);
  if (p.metrics.likes != null) bits.push(`${p.metrics.likes.toLocaleString()} likes`);
  if (p.metrics.comments != null) bits.push(`${p.metrics.comments.toLocaleString()} comments`);
  if (p.metrics.engagementRate != null) bits.push(`${(p.metrics.engagementRate * 100).toFixed(1)}% engagement`);
  // When the number was captured. Collection is every 6 hours and stops
  // silently if a token lapses, so a figure with no age reads as current
  // when it may be weeks old.
  const age = metricsAge(p.metrics.fetchedAt);
  if (age) bits.push(`as of ${age}`);
  return bits.length ? bits.join(" · ") : "Published";
};

export default function ClipsAndReels() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const search = useSearch();
  const [, setLocation] = useLocation();

  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [videoFilter, setVideoFilter] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  // Keyed with a nonce so clicking the same notification twice re-highlights
  // and re-scrolls (a plain string would compare equal and do nothing).
  const [highlight, setHighlight] = useState<{ key: string; nonce: number } | null>(null);
  const highlightKey = highlight?.key ?? null;

  // Modals / editors
  const [playing, setPlaying] = useState<ClipItem | null>(null);
  const [studioItem, setStudioItem] = useState<ClipItem | null>(null);
  const [publishTarget, setPublishTarget] = useState<{ videoId: number; id: number; clipSource: "remix" | "editorial" } | null>(null);
  const [reelSeed, setReelSeed] = useState<ReelClip[] | null>(null);
  const [reelOpen, setReelOpen] = useState(false);
  const [remixVideoId, setRemixVideoId] = useState<number | null>(null);
  const [seededSearch, setSeededSearch] = useState<{ query: string; excludeRanges?: Array<{ start: number; end: number }> } | null>(null);

  const { data, isLoading, error } = useQuery<ClipsFeed>({
    queryKey: ["/api/clips"],
    // The app-wide default is staleTime: Infinity, which is right for most
    // lists and wrong for a receipt: this feed exists to show work that
    // finished while the page was closed, so every mount must ask the server.
    // Cached data still paints first — no skeleton flash.
    staleTime: 0,
    // Keep the feed live while anything renders or publishes; go quiet when
    // nothing does. Both are bounded by the server's stale sweeps.
    refetchInterval: (q) => {
      const items = q.state.data?.items ?? [];
      const live = items.some((i) => i.status === "rendering" || i.published.some((p) => p.status === "publishing"));
      return live ? 5000 : false;
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/clips"] });

  // Deep links: ?video=ID filters, ?clip=editorial:ID / ?reel=ID land ON the
  // item, ?tab=reels|story|remix picks a kind. Read through wouter's search so
  // a bell click re-fires even though wouter changes the URL without
  // remounting. The params are stripped after handling, which empties
  // `search` — that is when the guard resets, so the SAME link clicked again
  // is a new click, not a duplicate.
  const handledSearch = useRef<string | null>(null);
  const highlightNonce = useRef(0);
  useEffect(() => {
    if (!search) { handledSearch.current = null; return; }
    if (handledSearch.current === search) return;
    handledSearch.current = search;
    // A link means "something just finished" — never trust the cached feed.
    queryClient.invalidateQueries({ queryKey: ["/api/clips"] });
    const params = new URLSearchParams(search);
    const video = Number(params.get("video"));
    if (Number.isFinite(video) && video > 0) setVideoFilter(video);
    const tab = params.get("tab");
    if (tab === "reels") setKind("reel");
    else if (tab === "story") setKind("editorial");
    else if (tab === "remix") setKind("remix");
    const clip = params.get("clip");
    const reel = params.get("reel");
    const land = (k: string) => setHighlight({ key: k, nonce: ++highlightNonce.current });
    if (clip && /^(editorial|remix):\d+$/.test(clip)) land(clip);
    else if (reel && /^\d+$/.test(reel)) { land(`reel:${reel}`); setKind("all"); }
    const url = new URL(window.location.href);
    ["video", "tab", "clip", "reel"].forEach((k) => url.searchParams.delete(k));
    window.history.replaceState({}, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const items = data?.items ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = items.filter((i) => {
      if (kind !== "all" && i.kind !== kind) return false;
      if (videoFilter != null && i.videoId !== videoFilter) return false;
      if (status === "published") { if (!i.published.some(isLive)) return false; }
      else if (status !== "all" && i.status !== status) return false;
      if (q && !`${i.title} ${i.videoTitle}`.toLowerCase().includes(q)) return false;
      return true;
    });
    if (sort === "score") out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    else if (sort === "longest") out.sort((a, b) => b.duration - a.duration);
    return out;
  }, [items, kind, status, videoFilter, query, sort]);

  // If the highlighted item is hidden by the current filters, drop the
  // filters that hide it — the link said "this one".
  useEffect(() => {
    if (!highlight || items.length === 0) return;
    const target = items.find((i) => i.key === highlight.key);
    if (!target) return;
    if (kind !== "all" && target.kind !== kind) setKind("all");
    if (videoFilter != null && target.videoId !== videoFilter) setVideoFilter(null);
    if (status !== "all") setStatus("all");
    if (query.trim()) setQuery("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.key, highlight?.nonce, items.length]);

  const rendering = items.filter((i) => i.status === "rendering");
  const hasAnyFilter = kind !== "all" || status !== "all" || videoFilter != null || query.trim() !== "";
  const clearFilters = () => { setKind("all"); setStatus("all"); setVideoFilter(null); setQuery(""); };

  // ── Actions ─────────────────────────────────────────────────────
  // Reels are deliberately NOT addable to another reel: the reel route sources
  // every segment from a library VIDEO by time range, and a reel's range is
  // output-relative — it would cut the first N seconds of the anchor video,
  // not the reel. Until the route can source from a rendered file, hide it.
  const toReelClip = (i: ClipItem): ReelClip | null => {
    if (i.kind === "reel") return null;
    return { clipId: i.id, clipSource: i.kind === "editorial" ? "editorial" : "remix", videoId: i.videoId, videoTitle: i.videoTitle, title: i.title, clipStart: i.clipStart, clipEnd: i.clipEnd, duration: i.duration, thumbnailPath: i.thumbnailPath, hasSegments: i.segmentsCount >= 2 };
  };
  const addToReel = (i: ClipItem) => {
    const rc = toReelClip(i);
    if (!rc) return;
    setReelSeed([rc]);
    setReelOpen(true);
  };
  // "Find more like this": open the source video's studio with a transcript
  // search already running on what this clip is ABOUT. Deliberately framed as
  // similarity, not success — nothing here knows the clip performed well.
  const findMoreLikeThis = (i: ClipItem) => {
    // "Story clip" is the server's fallback title for a clip with no
    // suggested title, so it is not a seed — searching for it would return
    // whatever Claude free-associates from two generic words.
    const usableTitle = i.title && i.title !== "Story clip" ? i.title : null;
    const seed = (i.topicTags && i.topicTags.length > 0) ? i.topicTags.slice(0, 4).join(", ") : usableTitle;
    if (!seed) {
      toast({ title: "Nothing to search on", description: "This clip has no topic tags or title to work from." });
      return;
    }
    // An assembled clip's clipStart/clipEnd is the ENVELOPE around its beats,
    // not the material — excluding it would blacklist most of the transcript.
    // The beats themselves are the right exclusion.
    const segs: Array<{ start: number; end: number }> | undefined =
      Array.isArray(i.row?.segments) && i.row.segments.length > 0
        ? i.row.segments
            .map((s: any) => ({ start: Number(s.start), end: Number(s.end) }))
            .filter((s: any) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
        : Number.isFinite(i.clipStart) && Number.isFinite(i.clipEnd) && i.clipEnd > i.clipStart
          ? [{ start: i.clipStart, end: i.clipEnd }]
          : undefined;
    setSeededSearch({ query: seed, excludeRanges: segs });
    setRemixVideoId(i.videoId);
  };

  // Render (a pending story clip) or retry (a failed one) — same route.
  const renderClip = async (i: ClipItem) => {
    if (i.kind !== "editorial") return;
    try {
      const res = await fetchWithTimeout(`/api/editorial-clips/${i.id}/rerender`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ aspect: i.aspectRatio === "16:9" ? "16:9" : "9:16" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not start the render");
      toast({ title: "Rendering", description: "The clip refreshes here when the cut is ready." });
      refresh();
    } catch (err: any) {
      toast({ title: "Render failed to start", description: err.message, variant: "destructive" });
    }
  };
  const deleteReel = async (i: ClipItem) => {
    if (i.kind !== "reel") return;
    if (!window.confirm(`Delete "${i.title}"? This removes the reel from FullScale.`)) return;
    try {
      const res = await fetchWithTimeout(`/api/remix/stitch-plans/${i.id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Delete failed");
      toast({ title: "Reel deleted" });
      refresh();
    } catch (err: any) {
      toast({ title: "Couldn't delete", description: err.message, variant: "destructive" });
    }
  };

  const counts = data?.counts;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar />
      <main className="p-8 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Clapperboard className="w-5 h-5 text-primary" />
              <h1 className="text-2xl font-bold font-display">Clips &amp; Reels</h1>
            </div>
            <p className="text-muted-foreground text-sm max-w-2xl">
              Everything FullScale cut for you, across all your videos. Edit a cut, publish it, or drop it into a reel.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setLocation("/library")} data-testid="button-clips-library">
              <Scissors className="w-4 h-4 mr-1.5" /> Find more in a video
            </Button>
            <Button size="sm" onClick={() => { setReelSeed(null); setReelOpen(true); }} data-testid="button-clips-build-reel">
              <Layers className="w-4 h-4 mr-1.5" /> Build a reel
            </Button>
          </div>
        </div>

        {/* Counts — clickable, they double as status filters */}
        {counts && counts.total > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-5" data-testid="clips-counts">
            <CountChip label="Ready" value={counts.ready} active={status === "ready"} tone="emerald" onClick={() => setStatus(status === "ready" ? "all" : "ready")} />
            <CountChip label="Rendering" value={counts.rendering} active={status === "rendering"} tone="amber" onClick={() => setStatus(status === "rendering" ? "all" : "rendering")} spinning={counts.rendering > 0} />
            <CountChip label="Published" value={counts.published} active={status === "published"} tone="sky" onClick={() => setStatus(status === "published" ? "all" : "published")} />
            {counts.failed > 0 && (
              <CountChip label="Failed" value={counts.failed} active={status === "failed"} tone="red" onClick={() => setStatus(status === "failed" ? "all" : "failed")} />
            )}
          </div>
        )}

        {/* In-flight strip — the work is visible while it happens */}
        {rendering.length > 0 && (
          <div className="mb-5 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 flex items-start gap-3" data-testid="clips-rendering-strip">
            <Loader2 className="w-4 h-4 mt-0.5 text-amber-400 animate-spin shrink-0" />
            <div className="text-sm">
              <div className="font-medium text-amber-200">Rendering {rendering.length} {rendering.length === 1 ? "item" : "items"}</div>
              <div className="text-amber-200/70 truncate max-w-3xl">
                {rendering.slice(0, 4).map((r) => r.title).join(" · ")}{rendering.length > 4 ? ` · +${rendering.length - 4} more` : ""}
              </div>
            </div>
          </div>
        )}

        {/* Toolbar */}
        {items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-6">
            <div className="inline-flex rounded-lg border border-border bg-card p-0.5" role="tablist" aria-label="Kind">
              {([["all", "All"], ["editorial", "Story clips"], ["reel", "Reels"], ["remix", "Remix clips"]] as Array<[KindFilter, string]>).map(([k, label]) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={kind === k}
                  onClick={() => setKind(k)}
                  className={cn(
                    "px-3 py-1.5 text-xs rounded-md transition-colors",
                    kind === k ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:text-foreground",
                  )}
                  data-testid={`tab-clips-${k}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <Select value={videoFilter == null ? "all" : String(videoFilter)} onValueChange={(v) => setVideoFilter(v === "all" ? null : Number(v))}>
              <SelectTrigger className="w-[220px] h-8 text-xs" data-testid="select-clips-video">
                <SelectValue placeholder="All videos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All videos</SelectItem>
                {(data?.videos ?? []).map((v) => (
                  <SelectItem key={v.id} value={String(v.id)}>{v.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles" className="h-8 pl-8 w-[200px] text-xs" data-testid="input-clips-search" />
            </div>
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger className="w-[140px] h-8 text-xs" data-testid="select-clips-sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="score">Best score</SelectItem>
                <SelectItem value="longest">Longest</SelectItem>
              </SelectContent>
            </Select>
            {hasAnyFilter && (
              <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={clearFilters}>
                <X className="w-3.5 h-3.5 mr-1" /> Clear
              </Button>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {filtered.length} of {items.length}{data?.truncated ? "+" : ""}
            </span>
          </div>
        )}

        {/* Body */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-border bg-card overflow-hidden animate-pulse">
                <div className="aspect-video bg-muted" />
                <div className="p-3 space-y-2"><div className="h-3 bg-muted rounded w-3/4" /><div className="h-3 bg-muted rounded w-1/2" /></div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-sm">
            <div className="flex items-center gap-2 text-red-300 font-medium mb-1"><AlertTriangle className="w-4 h-4" /> Couldn't load your clips</div>
            <p className="text-muted-foreground mb-3">{(error as Error).message}</p>
            <Button size="sm" variant="outline" onClick={refresh}><RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Try again</Button>
          </div>
        ) : items.length === 0 ? (
          <EmptyFeed onBuildReel={() => { setReelSeed(null); setReelOpen(true); }} onScan={() => setLocation("/library?scan=first")} />
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center">
            <p className="text-sm text-muted-foreground mb-3">Nothing matches those filters.</p>
            <Button size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4" data-testid="clips-grid">
            {filtered.map((item) => (
              <ClipCard
                key={item.key}
                item={item}
                highlighted={highlightKey === item.key}
                highlightNonce={highlight?.nonce ?? 0}
                onPlay={item.mediaUrl ? () => setPlaying(item) : undefined}
                onEdit={item.kind === "editorial" && item.status === "ready" && item.row ? () => setStudioItem(item) : undefined}
                onPublish={item.status === "ready" && item.publishId && item.clipSource ? () => setPublishTarget({ videoId: item.videoId, id: item.publishId!, clipSource: item.clipSource! }) : undefined}
                onAddToReel={item.kind !== "reel" ? () => addToReel(item) : undefined}
                onOpenStudio={() => { setSeededSearch(null); setRemixVideoId(item.videoId); }}
                onFindMore={item.kind === "editorial" ? () => findMoreLikeThis(item) : undefined}
                onRender={item.kind === "editorial" && (item.status === "failed" || item.status === "pending") ? () => renderClip(item) : undefined}
                onDelete={item.kind === "reel" ? () => deleteReel(item) : undefined}
              />
            ))}
          </div>
        )}
      </main>

      {/* Player */}
      <Dialog open={!!playing} onOpenChange={(o) => { if (!o) setPlaying(null); }}>
        <DialogContent className="max-w-3xl bg-black border-border p-0 overflow-hidden">
          {playing && (
            <>
              <DialogHeader className="px-4 pt-4 pb-2">
                <DialogTitle className="text-sm font-medium text-white truncate">{playing.title}</DialogTitle>
              </DialogHeader>
              <video
                key={playing.mediaUrl ?? playing.key}
                src={playing.mediaUrl ?? undefined}
                poster={playing.thumbnailPath ?? undefined}
                controls
                autoPlay
                playsInline
                className="w-full max-h-[70vh] bg-black"
                data-testid="video-clip-player"
              />
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Editor — the same ClipStudio the Remix Studio mounts */}
      {studioItem && studioItem.row && (
        <ClipStudio
          clip={studioItem.row}
          videoId={studioItem.videoId}
          onClose={() => setStudioItem(null)}
          onApply={async (payload) => {
            const res = await fetchWithTimeout(`/api/editorial-clips/${studioItem.id}/rerender`, {
              method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
              body: JSON.stringify(payload),
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok) {
              toast({ title: "Re-rendering your edit", description: "The clip refreshes here when the new cut is ready." });
              refresh();
            } else {
              toast({ title: "Re-render failed", description: body.error || "Try again", variant: "destructive" });
            }
          }}
        />
      )}

      {/* Publish — opens on the Publish tab with this clip selected. Kept
          MOUNTED (open=false) like the Library does, so the hub's publish
          job poll survives closing it and the "Published!" notice still
          arrives; the feed's own poll keeps the card's pill honest. */}
      <DistributionDashboard
        videoId={publishTarget?.videoId ?? 0}
        open={!!publishTarget}
        initialClip={publishTarget ? { id: publishTarget.id, clipSource: publishTarget.clipSource } : null}
        onClose={() => { setPublishTarget(null); refresh(); }}
      />

      <ReelBuilder open={reelOpen} initialClips={reelSeed} onClose={() => { setReelOpen(false); setReelSeed(null); refresh(); }} />

      {remixVideoId != null && (
        <RemixStudio
          videoId={remixVideoId}
          open={true}
          initialSearch={seededSearch}
          // Clear the seed the moment it is dispatched. The studio remounts
          // its clips panel on every copilot apply and re-render, and a seed
          // that outlived the first dispatch re-fired the whole (paid,
          // 60-second) search each time.
          onSeedConsumed={() => setSeededSearch(null)}
          onClose={() => { setRemixVideoId(null); setSeededSearch(null); refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Pieces ───────────────────────────────────────────────────────

function CountChip({ label, value, active, tone, onClick, spinning }: {
  label: string; value: number; active: boolean; tone: "emerald" | "amber" | "sky" | "red"; onClick: () => void; spinning?: boolean;
}) {
  const tones: Record<string, string> = {
    emerald: "border-emerald-500/30 text-emerald-300 bg-emerald-500/10",
    amber: "border-amber-500/30 text-amber-300 bg-amber-500/10",
    sky: "border-sky-500/30 text-sky-300 bg-sky-500/10",
    red: "border-red-500/30 text-red-300 bg-red-500/10",
  };
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
        active ? tones[tone] : "border-border text-muted-foreground hover:text-foreground",
      )}
      aria-pressed={active}
      data-testid={`chip-clips-${label.toLowerCase()}`}
    >
      {spinning && <Loader2 className="w-3 h-3 animate-spin" />}
      <span className="font-semibold tabular-nums">{value}</span> {label}
    </button>
  );
}

function EmptyFeed({ onBuildReel, onScan }: { onBuildReel: () => void; onScan: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/40 p-12 text-center max-w-2xl mx-auto" data-testid="clips-empty">
      <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4">
        <Clapperboard className="w-6 h-6" />
      </div>
      <h2 className="text-lg font-semibold mb-1">Nothing cut yet</h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">
        Scan a video and FullScale finds its story moments and renders each one as a playable clip. Reels you build land here too.
      </p>
      <div className="flex items-center justify-center gap-2">
        <Button onClick={onScan} data-testid="button-clips-empty-scan"><Sparkles className="w-4 h-4 mr-1.5" /> Scan a video</Button>
        <Button variant="outline" onClick={onBuildReel}><Layers className="w-4 h-4 mr-1.5" /> Build a reel</Button>
      </div>
    </div>
  );
}

function StatusPill({ status, error }: { status: Status; error: string | null }) {
  if (status === "ready") return null;
  if (status === "rendering") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-300 px-2 py-0.5 text-[11px] font-medium">
        <Loader2 className="w-3 h-3 animate-spin" /> Rendering
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 text-red-300 px-2 py-0.5 text-[11px] font-medium" title={error ?? undefined}>
        <AlertTriangle className="w-3 h-3" /> Failed
      </span>
    );
  }
  if (status === "needs_review") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 text-amber-200 px-2 py-0.5 text-[11px] font-medium" title="Rendered, but the quality check flagged it — review it in Remix Studio before publishing.">
        Needs review
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/20 text-zinc-300 px-2 py-0.5 text-[11px] font-medium">
      Not rendered
    </span>
  );
}

function ClipCard({ item, highlighted, highlightNonce, onPlay, onEdit, onPublish, onAddToReel, onOpenStudio, onFindMore, onRender, onDelete }: {
  item: ClipItem;
  highlighted: boolean;
  highlightNonce: number;
  onPlay?: () => void;
  onEdit?: () => void;
  onPublish?: () => void;
  onAddToReel?: () => void;
  onOpenStudio: () => void;
  onFindMore?: () => void;
  onRender?: () => void;
  onDelete?: () => void;
}) {
  const KindIcon = KIND_ICON[item.kind];
  const live = item.published.filter(isLive);
  const publishing = item.published.some((p) => p.status === "publishing");
  const score = fmtScore(item.score);
  const primary = onRender
    ? { label: item.status === "failed" ? "Retry render" : "Render", icon: item.status === "failed" ? RefreshCw : Sparkles, onClick: onRender }
    : onPublish
      ? { label: live.length > 0 ? "Publish again" : "Publish", icon: Send, onClick: onPublish }
      : null;

  // Land on this card every time it is the deep link's target (nonce changes
  // per click, so the same link twice scrolls twice).
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!highlighted || !cardRef.current) return;
    const el = cardRef.current;
    const t = setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 150);
    return () => clearTimeout(t);
  }, [highlighted, highlightNonce]);

  return (
    <div
      id={`clip-${item.key.replace(":", "-")}`}
      ref={cardRef}
      className={cn(
        "group rounded-xl border bg-card overflow-hidden flex flex-col transition-shadow",
        highlighted ? "border-primary ring-2 ring-primary/60 ring-offset-2 ring-offset-background" : "border-border hover:border-zinc-600",
      )}
      data-testid={`card-${item.key.replace(":", "-")}`}
    >
      {/* Thumbnail */}
      <button
        type="button"
        onClick={onPlay}
        disabled={!onPlay}
        className="relative aspect-video bg-black text-left disabled:cursor-default"
        aria-label={onPlay ? `Play ${item.title}` : item.title}
      >
        {item.thumbnailPath ? (
          <img src={item.thumbnailPath} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
        ) : item.videoThumbnail ? (
          <img src={item.videoThumbnail} alt="" className="absolute inset-0 w-full h-full object-cover opacity-40" loading="lazy" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-zinc-600"><KindIcon className="w-8 h-8" /></div>
        )}
        {onPlay && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors">
            <div className="w-11 h-11 rounded-full bg-white/90 text-black flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <Play className="w-5 h-5 ml-0.5" />
            </div>
          </div>
        )}
        <div className="absolute top-2 left-2 flex items-center gap-1">
          <span className="inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur px-1.5 py-0.5 text-[11px] text-white">
            <KindIcon className="w-3 h-3" /> {KIND_LABEL[item.kind]}
          </span>
          {item.segmentsCount >= 2 && item.kind !== "reel" && (
            <span className="rounded-md bg-black/60 backdrop-blur px-1.5 py-0.5 text-[11px] text-white" title={`${item.segmentsCount} beats assembled into one story`}>
              {item.segmentsCount} beats
            </span>
          )}
        </div>
        <div className="absolute top-2 right-2"><StatusPill status={item.status} error={item.error} /></div>
        <div className="absolute bottom-2 right-2 flex items-center gap-1">
          {item.aspectRatio && <span className="rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-white">{item.aspectRatio}</span>}
          {item.duration > 0 && <span className="rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-white tabular-nums">{fmtDuration(item.duration)}</span>}
        </div>
      </button>

      {/* Body */}
      <div className="p-3 flex flex-col gap-2 flex-1">
        <div className="min-w-0">
          <div className="text-sm font-medium leading-snug line-clamp-2" title={item.title}>{item.title}</div>
          <div className="text-xs text-muted-foreground truncate mt-0.5" title={item.videoTitle}>{item.videoTitle}</div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{fmtDate(item.completedAt ?? item.createdAt)}</span>
          {score && item.kind === "editorial" && (
            <span className="inline-flex items-center gap-1" title="Editorial score"><Sparkles className="w-3 h-3" /> {score}</span>
          )}
          {item.tier === "premium" && <Badge variant="outline" className="h-4 px-1 text-[10px] border-amber-500/40 text-amber-300">Premium</Badge>}
        </div>
        {item.status === "failed" && item.error && (
          <div className="text-[11px] text-red-300/90 line-clamp-2" title={item.error}>{item.error}</div>
        )}
        {item.status === "pending" && item.kind === "editorial" && (
          <div className="text-[11px] text-zinc-400">Found in the transcript, not rendered yet — press Render to make it playable.</div>
        )}
        {item.status === "needs_review" && (
          <div className="text-[11px] text-amber-200/80">The quality check flagged this cut. Open the video in Remix Studio to review it.</div>
        )}
        {(live.length > 0 || publishing) && (
          <div className="flex flex-wrap items-center gap-1">
            {publishing && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 text-sky-300 px-2 py-0.5 text-[11px]">
                <Loader2 className="w-3 h-3 animate-spin" /> Publishing
              </span>
            )}
            {live.map((p) => (
              <a
                key={p.postId}
                href={p.postUrl ?? undefined}
                target={p.postUrl ? "_blank" : undefined}
                rel="noopener noreferrer"
                className={cn("inline-flex items-center gap-1 rounded-full bg-emerald-500/10 text-emerald-300 px-2 py-0.5 text-[11px]", p.postUrl && "hover:bg-emerald-500/20")}
                title={metricsTitle(p)}
              >
                <CheckCircle2 className="w-3 h-3" /> {PLATFORM_LABEL[p.platform] ?? p.platform}{p.status === "dry_run" ? " (test)" : ""}
                {p.metrics?.views != null && (
                  <span className={cn("tabular-nums font-medium", isStale(p.metrics.fetchedAt) && "opacity-60")}>
                    · {compactNum(p.metrics.views)} views{isStale(p.metrics.fetchedAt) ? "*" : ""}
                  </span>
                )}
                {p.postUrl && <ExternalLink className="w-3 h-3 opacity-70" />}
              </a>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="mt-auto pt-1 flex items-center gap-1.5">
          {primary && (
            <Button size="sm" className="h-7 text-xs flex-1" onClick={primary.onClick} data-testid={`button-primary-${item.key.replace(":", "-")}`}>
              <primary.icon className="w-3.5 h-3.5 mr-1" /> {primary.label}
            </Button>
          )}
          {onEdit && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onEdit} title="Open in the editor">
              <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
            </Button>
          )}
          {!primary && !onEdit && onPlay && (
            <Button size="sm" variant="outline" className="h-7 text-xs flex-1" onClick={onPlay}>
              <Play className="w-3.5 h-3.5 mr-1" /> Play
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="More actions" data-testid={`button-more-${item.key.replace(":", "-")}`}>
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {item.downloadUrl && (
                <DropdownMenuItem asChild>
                  <a href={item.downloadUrl} download><Download className="w-4 h-4 mr-2" /> Download</a>
                </DropdownMenuItem>
              )}
              {onAddToReel && (
                <DropdownMenuItem onClick={onAddToReel}><Plus className="w-4 h-4 mr-2" /> Add to a reel</DropdownMenuItem>
              )}
              {onFindMore && (
                <DropdownMenuItem onClick={onFindMore}><Sparkles className="w-4 h-4 mr-2" /> Find more like this</DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onOpenStudio}><Scissors className="w-4 h-4 mr-2" /> Open video in Remix Studio</DropdownMenuItem>
              {onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onDelete} className="text-red-400 focus:text-red-300"><Trash2 className="w-4 h-4 mr-2" /> Delete reel</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
