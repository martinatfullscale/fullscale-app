/**
 * Creator Intelligence — the OPERATOR's roster + full drill-down (admin-gated).
 *
 * The deep end of the analytics split: the creator-facing /analytics page is
 * deliberately an overview, while THIS view carries the minutiae — full
 * demographic breakdowns, complete per-post tables with watch time, story
 * metrics, trend history, and each creator's placement pipeline. Used to
 * deliver the marketplace service (brand matching, placement pricing).
 * FullScale-internal — never shown in Meta App Review screencasts.
 */

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, ShieldAlert, Database, Users, Eye, Megaphone,
  ChevronDown, ChevronRight, Instagram, Facebook,
} from "lucide-react";
import {
  fmt, TrendBars, DemoBars, MediaTable, StoriesStrip,
  type SocialAccountAnalytics,
} from "@/components/AnalyticsBits";

interface CreatorRow {
  userId: string;
  name: string;
  email: string | null;
  platforms: string[];
  followers: number;
  views24h: number;
  reach24h: number;
  interactions24h: number;
  engagementRate: number;
  topCountry: string | null;
  topAge: string | null;
  placements: { pending: number; active: number; live: number };
  lastSyncedAt: string | null;
}

interface CreatorDetail {
  creator: { userId: string; name: string; email: string | null };
  accounts: SocialAccountAnalytics[];
  placements: Array<{
    id: number; status: string; videoId: number; brandProductId: number | null;
    placementFeeCents: number | null; creatorPayoutCents: number | null; createdAt: string | null;
  }>;
}

const DEMO_SECTIONS: Array<{ key: string; label: string }> = [
  { key: "follower_demographics.country", label: "Followers by country" },
  { key: "follower_demographics.city", label: "Followers by city" },
  { key: "follower_demographics.age", label: "Followers by age" },
  { key: "follower_demographics.gender", label: "Followers by gender" },
  { key: "engaged_audience_demographics.country", label: "Engaged audience by country" },
  { key: "engaged_audience_demographics.age", label: "Engaged audience by age" },
];

function CreatorDetailPanel({ userId }: { userId: string }) {
  const { data, isLoading, isError } = useQuery<CreatorDetail>({
    queryKey: ["/api/admin/creator-intelligence", userId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/creator-intelligence/${encodeURIComponent(userId)}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to load detail");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="py-8 text-center">
        <Loader2 className="w-5 h-5 animate-spin text-primary mx-auto" />
      </div>
    );
  }
  if (isError || !data) {
    return <p className="py-6 text-sm text-red-400 text-center">Couldn't load this creator's detail.</p>;
  }

  return (
    <div className="space-y-6 p-4 bg-black/20">
      {data.accounts.map((acct) => {
        const viewSeries = acct.series.map((s) => s.views);
        const followerSeries = acct.series.map((s) => s.followers ?? 0).filter((v) => v > 0);
        const demoSections = DEMO_SECTIONS
          .map((d) => ({ ...d, rows: acct.demographics[d.key] ?? [] }))
          .filter((d) => d.rows.length > 0);
        return (
          <div key={acct.id} data-testid={`detail-account-${acct.platform}`}>
            <p className="font-medium text-white flex items-center gap-2 mb-3">
              {acct.platform === "instagram" ? <Instagram className="w-4 h-4" /> : <Facebook className="w-4 h-4" />}
              {acct.handle || acct.displayName || acct.platform}
              <span className="text-xs text-muted-foreground font-normal">{fmt(acct.followers)} followers</span>
              {acct.lastCapturedAt && (
                <span className="text-xs text-muted-foreground font-normal">
                  · synced {new Date(acct.lastCapturedAt).toLocaleString()}
                </span>
              )}
            </p>

            {/* Full metric row */}
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground mb-3">
              {Object.entries(acct.metrics).map(([k, v]) => (
                <span key={k}>
                  {k.replace(/_/g, " ")}: <span className="text-gray-200">{fmt(v as number)}</span>
                </span>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
              <Card>
                <CardContent className="p-4">
                  <h4 className="text-xs font-semibold mb-2">Views trend</h4>
                  <TrendBars points={viewSeries} testId={`detail-trend-views-${acct.id}`} />
                  {followerSeries.length >= 2 && (
                    <>
                      <h4 className="text-xs font-semibold mt-3 mb-2">Followers trend</h4>
                      <TrendBars points={followerSeries} testId={`detail-trend-followers-${acct.id}`} />
                    </>
                  )}
                </CardContent>
              </Card>
              {demoSections.length > 0 && (
                <Card>
                  <CardContent className="p-4 space-y-4">
                    {demoSections.map((d) => (
                      <div key={d.key}>
                        <h4 className="text-xs font-semibold mb-2">{d.label}</h4>
                        <DemoBars rows={d.rows} testId={`detail-demo-${d.key}-${acct.id}`} />
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </div>

            {acct.recentMedia.length > 0 && (
              <Card className="mb-4">
                <CardContent className="p-4">
                  <h4 className="text-xs font-semibold mb-2">Post performance (full)</h4>
                  <MediaTable media={acct.recentMedia} full={true} testIdPrefix={`detail-media-${acct.id}`} />
                </CardContent>
              </Card>
            )}

            {acct.stories.length > 0 && (
              <Card className="mb-4">
                <CardContent className="p-4">
                  <h4 className="text-xs font-semibold mb-2">Live stories (24h window)</h4>
                  <StoriesStrip stories={acct.stories} />
                </CardContent>
              </Card>
            )}
          </div>
        );
      })}

      {data.placements.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h4 className="text-xs font-semibold mb-2">Placement history</h4>
            <div className="space-y-1">
              {data.placements.map((p) => (
                <div key={p.id} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    #{p.id} · video {p.videoId} · {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : ""}
                  </span>
                  <span className="flex items-center gap-3">
                    <Badge variant="outline" className="text-[10px]">{p.status.replace(/_/g, " ")}</Badge>
                    {p.creatorPayoutCents ? (
                      <span className="text-emerald-400">${(p.creatorPayoutCents / 100).toFixed(2)}</span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function AdminCreatorIntelligence() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data, isLoading, isError, error } = useQuery<{
    creators: CreatorRow[];
    totals: { creators: number; followers: number; views24h: number; livePlacements: number };
  }>({
    queryKey: ["/api/admin/creator-intelligence"],
    queryFn: async () => {
      const res = await fetch("/api/admin/creator-intelligence", { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to load");
      return res.json();
    },
    refetchInterval: 5 * 60_000,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="container mx-auto px-4 py-16 max-w-lg text-center">
        <ShieldAlert className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="font-medium text-gray-200">{(error as any)?.message || "Not available"}</p>
        <p className="text-sm text-muted-foreground mt-1">This view is restricted to FullScale admins.</p>
      </div>
    );
  }

  const creators = data?.creators ?? [];
  const totals = data?.totals;

  return (
    <div className="container mx-auto px-4 md:px-6 py-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Database className="w-6 h-6 text-primary" /> Creator Intelligence
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connected creators, their audiences, and how they're interacting with brands.
          Click a row for the full drill-down.
        </p>
      </div>

      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[
            { label: "Creators", value: fmt(totals.creators), icon: Users },
            { label: "Total audience", value: fmt(totals.followers), icon: Users },
            { label: "Views (24h)", value: fmt(totals.views24h), icon: Eye },
            { label: "Live placements", value: fmt(totals.livePlacements), icon: Megaphone },
          ].map((t) => (
            <Card key={t.label}>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <t.icon className="w-3.5 h-3.5" /> {t.label}
                </p>
                <p className="text-xl font-bold text-white mt-1">{t.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {creators.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            No creators with connected Meta accounts yet. Data appears as creators
            connect Facebook/Instagram and the snapshot job runs.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm" data-testid="creator-intel-table">
              <thead>
                <tr className="text-xs text-muted-foreground text-left border-b border-white/10">
                  <th className="p-3 font-medium w-6"></th>
                  <th className="p-3 font-medium">Creator</th>
                  <th className="p-3 font-medium">Platforms</th>
                  <th className="p-3 font-medium text-right">Followers</th>
                  <th className="p-3 font-medium text-right">Views 24h</th>
                  <th className="p-3 font-medium text-right">Reach 24h</th>
                  <th className="p-3 font-medium text-right">Eng. rate</th>
                  <th className="p-3 font-medium">Top geo</th>
                  <th className="p-3 font-medium">Top age</th>
                  <th className="p-3 font-medium text-center">Placements (p/a/live)</th>
                  <th className="p-3 font-medium text-right">Synced</th>
                </tr>
              </thead>
              <tbody>
                {creators.map((c) => (
                  <Fragment key={c.userId}>
                    <tr
                      className="border-b border-white/5 hover:bg-white/[0.02] cursor-pointer"
                      data-testid={`creator-row-${c.userId}`}
                      onClick={() => setExpanded(expanded === c.userId ? null : c.userId)}
                    >
                      <td className="p-3 text-muted-foreground">
                        {expanded === c.userId ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </td>
                      <td className="p-3">
                        <p className="font-medium text-white">{c.name}</p>
                        {c.email && c.email !== c.name && (
                          <p className="text-xs text-muted-foreground">{c.email}</p>
                        )}
                      </td>
                      <td className="p-3">
                        <div className="flex gap-1">
                          {c.platforms.map((p) => (
                            <Badge key={p} variant="secondary" className="text-[10px] capitalize">{p}</Badge>
                          ))}
                        </div>
                      </td>
                      <td className="p-3 text-right text-white">{fmt(c.followers)}</td>
                      <td className="p-3 text-right">{fmt(c.views24h)}</td>
                      <td className="p-3 text-right">{fmt(c.reach24h)}</td>
                      <td className="p-3 text-right">
                        {c.engagementRate > 0 ? `${(c.engagementRate * 100).toFixed(1)}%` : "—"}
                      </td>
                      <td className="p-3">{c.topCountry || "—"}</td>
                      <td className="p-3">{c.topAge || "—"}</td>
                      <td className="p-3 text-center">
                        <span className="text-amber-400">{c.placements.pending}</span>
                        {" / "}
                        <span className="text-sky-400">{c.placements.active}</span>
                        {" / "}
                        <span className="text-emerald-400">{c.placements.live}</span>
                      </td>
                      <td className="p-3 text-right text-xs text-muted-foreground">
                        {c.lastSyncedAt ? new Date(c.lastSyncedAt).toLocaleDateString() : "never"}
                      </td>
                    </tr>
                    {expanded === c.userId && (
                      <tr>
                        <td colSpan={11} className="p-0">
                          <CreatorDetailPanel userId={c.userId} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
