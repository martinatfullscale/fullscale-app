/**
 * Creator Analytics — OVERVIEW tier, the creator-facing value surface.
 *
 * Deliberately a clean summary (followers, core KPIs, trends, an audience
 * snapshot, top posts) rather than an exhaustive drill-down — the deep
 * per-creator analysis lives on the admin side. This page is what the Meta
 * App Review screencasts for instagram_manage_insights / read_insights show:
 * the person who granted the permissions seeing their own performance.
 */

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2, BarChart3, Instagram, Facebook, Eye, Users, Heart,
  TrendingUp, Clock, Link2, Globe2,
} from "lucide-react";
import { Link } from "wouter";
import { fmt, TrendBars, topOf, MediaTable, type SocialAccountAnalytics } from "@/components/AnalyticsBits";

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
    <div className="container mx-auto px-4 md:px-6 py-8 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <BarChart3 className="w-6 h-6 text-primary" /> Your Performance
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Followers, reach, and engagement across your connected accounts —
          the numbers brands see when they consider your content for placements.
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
            const viewSeries = acct.series.map((s) => s.views);
            const followerSeries = acct.series.map((s) => s.followers ?? 0).filter((v) => v > 0);
            const topCountry = topOf(acct.demographics["follower_demographics.country"]);
            const topAge = topOf(acct.demographics["follower_demographics.age"]);
            const topGender = topOf(acct.demographics["follower_demographics.gender"]);
            const audienceChips = [
              topCountry && { label: "Top country", value: topCountry },
              topAge && { label: "Top age", value: topAge },
              topGender && { label: "Gender", value: topGender },
            ].filter(Boolean) as Array<{ label: string; value: string }>;
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

                  {/* Audience snapshot — headline stats, not the full breakdown */}
                  <Card>
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                        <Globe2 className="w-4 h-4" /> Audience snapshot
                      </h3>
                      {audienceChips.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Audience details appear once your account passes 100 followers
                          and the first sync lands.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {audienceChips.map((c) => (
                            <div key={c.label} className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">{c.label}</span>
                              <span className="text-white font-medium">{c.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* Top posts — compact */}
                {acct.recentMedia.length > 0 && (
                  <Card>
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold mb-3">Top recent posts</h3>
                      <MediaTable media={acct.recentMedia} full={false} testIdPrefix="media-row" />
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
