import { Eye, MousePointerClick, MessageSquare, Info, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What a placement actually did — the same panel for the creator and the brand.
 *
 * One component, one server computation, so the two sides can never quote
 * different numbers to each other. The brand gets the shape of the audience
 * response; the comment text stays with the creator (the server decides that,
 * not this file — `audience.samples` simply arrives undefined for a brand).
 *
 * The hard part here is not the layout, it is refusing to overclaim:
 *
 *  - Views are the WHOLE VIDEO's daily views from YouTube Analytics. We
 *    cannot measure views of a placement — nobody can — so the label says
 *    what the number is and the panel never shortens it to "your views".
 *  - A missing number renders as "—" with a reason, never as 0. A zero here
 *    reads as "nobody watched", which is a different and usually false claim.
 *  - Conversions are absent entirely. Nothing in the system can record one
 *    today, so a permanent 0 would say "nothing converted" when the truth is
 *    "nothing is being reported".
 */

export interface PlacementResultView {
  placementId: number | null;
  assignmentId: number | null;
  videoId: number;
  videoTitle: string;
  videoThumbnail: string | null;
  platform: string;
  postUrl: string | null;
  liveAt: string | null;
  views: {
    basis: string;
    /** Which platform the view numbers came from — not always the platform
     *  the clip was posted to. null when we have no view source at all. */
    sourcePlatform: string | null;
    sinceLive: number | null;
    priorWindow: number | null;
    windowDays: number;
  };
  clicks: number | null;
  trackingLinkUrl: string | null;
  audience: {
    total: number;
    classified: number;
    sentiment: { positive: number; neutral: number; negative: number; mixed: number };
    brandMentions: number;
    afterPlacement: number;
    samples?: Array<{ text: string; sentiment: string | null; likeCount: number | null }>;
  } | null;
  state: "ready" | "partial" | "accumulating";
  /** Things that will resolve with time. */
  blocking: string[];
  /** Settled facts that never will. Rendered without a spinner. */
  permanent: string[];
}

const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube", youtube_shorts: "YouTube", tiktok: "TikTok", instagram: "Instagram",
  instagram_reels: "Instagram", facebook: "Facebook", twitter: "X", linkedin: "LinkedIn", other: "their channel",
};

const compact = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

function Metric({ icon: Icon, label, value, hint, tone }: {
  icon: any; label: string; value: string; hint: string; tone?: "emerald" | "sky" | "zinc";
}) {
  const toneClass = tone === "emerald" ? "text-emerald-400" : tone === "sky" ? "text-sky-400" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card/60 p-3" title={hint}>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className={cn("text-xl font-semibold tabular-nums", toneClass)}>{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{hint}</div>
    </div>
  );
}

export function PlacementResults({ result, audience: showAudience = true }: {
  result: PlacementResultView;
  /** Brand view hides comment text; the counts still show. */
  audience?: boolean;
}) {
  const v = result.views;
  const delta = v.sinceLive != null && v.priorWindow != null ? v.sinceLive - v.priorWindow : null;
  const deltaPct = delta != null && v.priorWindow ? Math.round((delta / v.priorWindow) * 100) : null;

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4 space-y-3" data-testid={`placement-results-${result.placementId ?? result.assignmentId}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm">
          <span className="font-medium">Live on {PLATFORM_LABEL[result.platform] ?? result.platform}</span>
          <span className="text-muted-foreground"> since {fmtDate(result.liveAt)}</span>
        </div>
        {result.postUrl && (
          <a
            href={result.postUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            See the post <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Metric
          icon={Eye}
          // The label names the SOURCE of the number. These are the creator's
          // whole-video daily views from YouTube Analytics; nothing can
          // measure views of a placement, and a tile headed "Views" sitting
          // under "Live on TikTok" would imply we had.
          label={v.sourcePlatform === "youtube" ? "Source video views" : "Views"}
          value={v.sinceLive != null ? compact(v.sinceLive) : "—"}
          tone="emerald"
          hint={
            v.sourcePlatform !== "youtube"
              ? "We can only read day-by-day views for YouTube source videos."
              : v.sinceLive == null
                ? "Needs a day of history from the connected channel."
                : `The creator's whole video, not the placement alone, over ${v.windowDays} day${v.windowDays === 1 ? "" : "s"} since it went live.`
          }
        />
        <Metric
          icon={Eye}
          label="Prior period"
          value={v.priorWindow != null ? compact(v.priorWindow) : "—"}
          hint={
            v.priorWindow == null
              ? "Not enough history before it went live to compare against."
              : deltaPct != null
                ? `${deltaPct >= 0 ? "+" : ""}${deltaPct}% versus the same ${v.windowDays} day${v.windowDays === 1 ? "" : "s"} before.`
                : `The same ${v.windowDays} day${v.windowDays === 1 ? "" : "s"} before it went live.`
          }
        />
        <Metric
          icon={MousePointerClick}
          label="Link clicks"
          value={result.clicks != null ? compact(result.clicks) : "—"}
          tone="sky"
          hint={
            result.clicks == null
              ? "No tracking link was posted with this video."
              : "Clicks on the tracking link the creator posted."
          }
        />
      </div>

      {showAudience && result.audience && (
        <div className="rounded-lg border border-border bg-card/60 p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground uppercase tracking-wider mb-2">
            {/* Whole-video comments, all time — not comments about the
                placement, which nothing can isolate. The "after it went live"
                line below is the only placement-relative figure here. */}
            <MessageSquare className="w-3 h-3" /> Comments on the video
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full bg-emerald-500/10 text-emerald-300 px-2 py-0.5">
              {result.audience.sentiment.positive} positive
            </span>
            <span className="rounded-full bg-zinc-500/15 text-zinc-300 px-2 py-0.5">
              {result.audience.sentiment.neutral} neutral
            </span>
            <span className="rounded-full bg-red-500/10 text-red-300 px-2 py-0.5">
              {result.audience.sentiment.negative} negative
            </span>
            {result.audience.brandMentions > 0 && (
              <span className="rounded-full bg-violet-500/10 text-violet-300 px-2 py-0.5">
                {result.audience.brandMentions} mention the brand
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            {result.audience.afterPlacement} of {result.audience.total} comments were posted after this went live.
            {result.audience.classified < result.audience.total && (
              <> Sentiment is from the {result.audience.classified.toLocaleString()} classified so far.</>
            )}
          </p>
          {result.audience.samples && result.audience.samples.length > 0 && (
            <ul className="mt-2 space-y-1">
              {result.audience.samples.slice(0, 3).map((s, i) => (
                <li key={i} className="text-xs text-muted-foreground border-l-2 border-border pl-2 line-clamp-2">
                  “{s.text}”
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* A spinner promises the number is on its way. Only the transient
          reasons get one; a settled fact ("no tracking link was posted")
          gets stated once and left alone. */}
      {result.blocking.length > 0 && (
        <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 mt-0.5 shrink-0 animate-spin" />
          <span>{result.blocking.join(" ")}</span>
        </div>
      )}
      {(result.permanent ?? []).length > 0 && (
        <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{result.permanent.join(" ")}</span>
        </div>
      )}
    </div>
  );
}
