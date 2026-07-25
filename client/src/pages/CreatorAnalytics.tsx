/**
 * Creator Analytics — the creator's own social performance, rendered.
 *
 * This is the surface the Meta App Review screencasts show for
 * instagram_manage_insights and read_insights: the person who granted the
 * permissions sees their own account insights, audience demographics,
 * per-post performance, and follower/views trends (fed by FullScale's
 * snapshot history, which outlives Meta's 90-day retention).
 */

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2, BarChart3, Instagram, Facebook, Eye, Users, Heart,
  TrendingUp, Clock, Link2,
} from "lucide-react";
import { Link } from "wouter";

interface SocialAccountAnalytics {
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

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Dependency-free sparkline: scaled bars from a numeric series. */
function TrendBars({ points, testId }: { points: number[]; testId: string }) {
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

function DemoBars({ rows, testId }: { rows: Array<{ dimension: string; value: number }>; testId: string }) {
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

const KPI_DEFS: Array<{ key: string; fbKey?: string; label: string; icon: any }> = [
  { key: "views", fbKey: "page_media_view", label: "Views (24h)", icon: Eye },
  { key: "reach", fbKey: "page_total_media_view_unique", label: "Reach (24h)", icon: Users },
  { key: "total_interactions", fbKey: "page_post_engagements", label: "Interactions", icon: Heart },
  { key: "accounts_engaged", fbKey: "page_total_actions", label: "Engaged", icon: TrendingUp },
];

export default function CreatorAnalytics() {
  const { data, isLoading, isError } = useQuery<{ accounts: SocialAccountAnalytics[] }>({
    queryKey: ["/api/analytics/social"],
    queryFn: async () => {
      const res = await fetch("/api/analytics/social", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load analytics");
      return res.json();
    },
    refetchInterval: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const accounts = data?.accounts ?? [];

  return (
    <div className="container mx-auto px-4 md:px-6 py-8 max-w-6xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <BarChart3 className="w-6 h-6 text-primary" /> Audience Analytics
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Your Instagram and Facebook performance — views, reach, audience demographics,
          and per-post metrics. FullScale archives these daily, so your history keeps
          growing past Meta's 90-day window.
        </p>
      </div>

      {isError || accounts.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center">
            <Link2 className="w-10 h-10 text-gray-600 mx-auto mb-3" />
            <p className="font-medium text-gray-300">
              {isError ? "Couldn't load analytics" : "No connected Meta accounts yet"}
            </p>
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              Connect Facebook and confirm your Page — analytics start flowing within a few minutes.
            </p>
            <Link href="/dashboard">
              <Button variant="outline" size="sm">Go to Dashboard</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {accounts.map((acct) => {
            const followerSeries = acct.series.map((s) => s.followers ?? 0).filter((v) => v > 0);
            const viewSeries = acct.series.map((s) => s.views);
            const ageRows = acct.demographics["follower_demographics.age"] ?? [];
            const genderRows = acct.demographics["follower_demographics.gender"] ?? [];
            const countryRows = acct.demographics["follower_demographics.country"] ?? [];
            const hasDemographics = ageRows.length > 0 || genderRows.length > 0 || countryRows.length > 0;
            return (
              <div key={acct.id} data-testid={`analytics-account-${acct.platform}`}>
                {/* Account header */}
                <div className="flex items-center gap-3 mb-4">
                  {acct.avatarUrl ? (
                    <img src={acct.avatarUrl} alt="" className="w-11 h-11 rounded-full object-cover" />
                  ) : (
                    <div className="w-11 h-11 rounded-full bg-white/10 flex items-center justify-center">
                      {acct.platform === "instagram" ? <Instagram className="w-5 h-5" /> : <Facebook className="w-5 h-5" />}
                    </div>
                  )}
                  <div>
                    <p className="font-semibold text-white flex items-center gap-2">
                      {acct.handle || acct.displayName || acct.platform}
                      <Badge variant="secondary" className="text-[10px] capitalize">{acct.platform}</Badge>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {fmt(acct.followers)} followers
                      {acct.lastCapturedAt && (
                        <> · <Clock className="w-3 h-3 inline -mt-0.5" /> synced {new Date(acct.lastCapturedAt).toLocaleString()}</>
                      )}
                    </p>
                  </div>
                </div>

                {/* KPI tiles */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  {KPI_DEFS.map((kpi) => {
                    const value = acct.metrics[kpi.key] ?? (kpi.fbKey ? acct.metrics[kpi.fbKey] : undefined);
                    const Icon = kpi.icon;
                    return (
                      <Card key={kpi.key}>
                        <CardContent className="p-4">
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Icon className="w-3.5 h-3.5" /> {kpi.label}
                          </p>
                          <p className="text-xl font-bold text-white mt-1">{fmt(value)}</p>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
                  {/* Trends */}
                  <Card>
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold mb-3">Views per snapshot</h3>
                      <TrendBars points={viewSeries} testId={`trend-views-${acct.platform}`} />
                      {followerSeries.length >= 2 && (
                        <>
                          <h3 className="text-sm font-semibold mt-4 mb-3">Followers</h3>
                          <TrendBars points={followerSeries} testId={`trend-followers-${acct.platform}`} />
                        </>
                      )}
                    </CardContent>
                  </Card>

                  {/* Demographics */}
                  <Card>
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold mb-3">Audience</h3>
                      {!hasDemographics ? (
                        <p className="text-xs text-muted-foreground">
                          Demographics appear once your account passes 100 followers and the
                          first snapshot lands.
                        </p>
                      ) : (
                        <div className="space-y-4">
                          {countryRows.length > 0 && (
                            <div>
                              <p className="text-xs text-muted-foreground mb-1.5">Top countries</p>
                              <DemoBars rows={countryRows} testId={`demo-country-${acct.platform}`} />
                            </div>
                          )}
                          {ageRows.length > 0 && (
                            <div>
                              <p className="text-xs text-muted-foreground mb-1.5">Age</p>
                              <DemoBars rows={ageRows} testId={`demo-age-${acct.platform}`} />
                            </div>
                          )}
                          {genderRows.length > 0 && (
                            <div>
                              <p className="text-xs text-muted-foreground mb-1.5">Gender</p>
                              <DemoBars rows={genderRows} testId={`demo-gender-${acct.platform}`} />
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* Recent media performance */}
                {acct.recentMedia.length > 0 && (
                  <Card>
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold mb-3">Recent posts</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-xs text-muted-foreground text-left">
                              <th className="pb-2 pr-3 font-medium">Post</th>
                              <th className="pb-2 pr-3 font-medium text-right">Views</th>
                              <th className="pb-2 pr-3 font-medium text-right">Reach</th>
                              <th className="pb-2 pr-3 font-medium text-right">Likes</th>
                              <th className="pb-2 pr-3 font-medium text-right">Comments</th>
                              <th className="pb-2 pr-3 font-medium text-right">Saves</th>
                              <th className="pb-2 font-medium text-right">Avg watch</th>
                            </tr>
                          </thead>
                          <tbody>
                            {acct.recentMedia.map((m) => (
                              <tr key={m.mediaId} className="border-t border-white/5" data-testid={`media-row-${m.mediaId}`}>
                                <td className="py-2 pr-3">
                                  <a
                                    href={m.permalink ?? undefined}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="flex items-center gap-2 hover:underline"
                                  >
                                    {m.thumbnailUrl && (
                                      <img src={m.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover" />
                                    )}
                                    <span className="max-w-[220px] truncate text-gray-300">
                                      {m.caption?.slice(0, 60) || m.mediaType}
                                    </span>
                                  </a>
                                </td>
                                <td className="py-2 pr-3 text-right text-white">{fmt(m.views)}</td>
                                <td className="py-2 pr-3 text-right">{fmt(m.reach)}</td>
                                <td className="py-2 pr-3 text-right">{fmt(m.likeCount)}</td>
                                <td className="py-2 pr-3 text-right">{fmt(m.commentsCount)}</td>
                                <td className="py-2 pr-3 text-right">{fmt(m.saved)}</td>
                                <td className="py-2 text-right">
                                  {m.avgWatchTimeMs > 0 ? `${(m.avgWatchTimeMs / 1000).toFixed(1)}s` : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Live stories */}
                {acct.stories.length > 0 && (
                  <Card className="mt-4">
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold mb-3">Live stories (24h window)</h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {acct.stories.map((s) => (
                          <div key={s.storyId} className="rounded-lg border border-white/10 p-3 text-xs space-y-1">
                            <p className="text-muted-foreground">{new Date(s.timestamp).toLocaleTimeString()}</p>
                            <p className="text-white">{fmt(s.metrics.views)} views · {fmt(s.metrics.reach)} reach</p>
                            <p className="text-muted-foreground">{fmt(s.metrics.replies)} replies · {fmt(s.metrics.shares)} shares</p>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
