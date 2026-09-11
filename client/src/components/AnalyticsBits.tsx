/**
 * Shared analytics rendering pieces. Used at two depths:
 *   - CreatorAnalytics (/analytics): overview tier — creator-facing value.
 *   - AdminCreatorIntelligence (/admin/creators): full tier — operator detail.
 */

export interface SocialAccountAnalytics {
  id: string;
  platform: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  followers: number;
  lastCapturedAt: string | null;
  metrics: Record<string, number>;
  demographics: Record<string, Array<{ dimension: string; value: number }>>;
  stories: Array<{ storyId: string; timestamp: string; metrics: Record<string, number> }>;
  series: Array<{ capturedAt: string; followers: number | null; views: number; reach: number; interactions: number }>;
  recentMedia: Array<{
    mediaId: string; mediaType: string; permalink: string | null; thumbnailUrl: string | null;
    caption: string | null; timestamp: string; views: number; reach: number;
    avgWatchTimeMs: number; totalWatchTimeMs: number; likeCount: number;
    commentsCount: number; saved: number; shares: number; totalInteractions: number;
  }>;
}

export function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Dependency-free sparkline: scaled bars from a numeric series. */
export function TrendBars({ points, testId }: { points: number[]; testId: string }) {
  if (points.length < 2) return <p className="text-xs text-muted-foreground">Trend appears after a few snapshot cycles.</p>;
  const max = Math.max(...points, 1);
  return (
    <div className="flex items-end gap-0.5 h-14" data-testid={testId}>
      {points.slice(-40).map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-sm bg-primary/60 min-w-[2px]"
          style={{ height: `${Math.max(4, (v / max) * 100)}%` }}
          title={String(v)}
        />
      ))}
    </div>
  );
}

export function DemoBars({ rows, testId }: { rows: Array<{ dimension: string; value: number }>; testId: string }) {
  const top = [...rows].sort((a, b) => b.value - a.value).slice(0, 6);
  const total = rows.reduce((n, r) => n + r.value, 0) || 1;
  return (
    <div className="space-y-1.5" data-testid={testId}>
      {top.map((r) => (
        <div key={r.dimension} className="flex items-center gap-2 text-xs">
          <span className="w-20 truncate text-muted-foreground">{r.dimension}</span>
          <div className="flex-1 h-2 rounded bg-white/5 overflow-hidden">
            <div className="h-full bg-primary/70" style={{ width: `${Math.max(3, (r.value / total) * 100)}%` }} />
          </div>
          <span className="w-12 text-right text-gray-300">{((r.value / total) * 100).toFixed(0)}%</span>
        </div>
      ))}
    </div>
  );
}

/** Top value of a demographics breakdown, as "US · 42%". */
export function topOf(rows: Array<{ dimension: string; value: number }> | undefined): string | null {
  if (!rows || rows.length === 0) return null;
  const total = rows.reduce((n, r) => n + r.value, 0) || 1;
  const top = rows.reduce((a, b) => (b.value > a.value ? b : a));
  return `${top.dimension} · ${((top.value / total) * 100).toFixed(0)}%`;
}

export function MediaTable({
  media, full, testIdPrefix,
}: {
  media: SocialAccountAnalytics["recentMedia"]; full: boolean; testIdPrefix: string;
}) {
  if (media.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground text-left">
            <th className="pb-2 pr-3 font-medium">Post</th>
            <th className="pb-2 pr-3 font-medium text-right">Views</th>
            <th className="pb-2 pr-3 font-medium text-right">Likes</th>
            {full && <th className="pb-2 pr-3 font-medium text-right">Reach</th>}
            {full && <th className="pb-2 pr-3 font-medium text-right">Comments</th>}
            {full && <th className="pb-2 pr-3 font-medium text-right">Saves</th>}
            {full && <th className="pb-2 pr-3 font-medium text-right">Shares</th>}
            {full && <th className="pb-2 font-medium text-right">Avg watch</th>}
          </tr>
        </thead>
        <tbody>
          {media.map((m) => (
            <tr key={m.mediaId} className="border-t border-white/5" data-testid={`${testIdPrefix}-${m.mediaId}`}>
              <td className="py-2 pr-3">
                <a href={m.permalink ?? undefined} target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:underline">
                  {m.thumbnailUrl && <img src={m.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover" />}
                  <span className="max-w-[220px] truncate text-gray-300">{m.caption?.slice(0, 60) || m.mediaType}</span>
                </a>
              </td>
              <td className="py-2 pr-3 text-right text-white">{fmt(m.views)}</td>
              <td className="py-2 pr-3 text-right">{fmt(m.likeCount)}</td>
              {full && <td className="py-2 pr-3 text-right">{fmt(m.reach)}</td>}
              {full && <td className="py-2 pr-3 text-right">{fmt(m.commentsCount)}</td>}
              {full && <td className="py-2 pr-3 text-right">{fmt(m.saved)}</td>}
              {full && <td className="py-2 pr-3 text-right">{fmt(m.shares)}</td>}
              {full && (
                <td className="py-2 text-right">
                  {m.avgWatchTimeMs > 0 ? `${(m.avgWatchTimeMs / 1000).toFixed(1)}s` : "—"}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StoriesStrip({ stories }: { stories: SocialAccountAnalytics["stories"] }) {
  if (stories.length === 0) return null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {stories.map((s) => (
        <div key={s.storyId} className="rounded-lg border border-white/10 p-3 text-xs space-y-1">
          <p className="text-muted-foreground">{new Date(s.timestamp).toLocaleTimeString()}</p>
          <p className="text-white">{fmt(s.metrics.views)} views · {fmt(s.metrics.reach)} reach</p>
          <p className="text-muted-foreground">{fmt(s.metrics.replies)} replies · {fmt(s.metrics.shares)} shares</p>
        </div>
      ))}
    </div>
  );
}
