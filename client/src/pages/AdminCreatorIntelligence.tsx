/**
 * Creator Intelligence — the OPERATOR's roster + full drill-down (admin-gated).
 *
 * The deep end of the analytics split: the creator-facing /analytics page is
 * deliberately an overview, while THIS view carries the minutiae — full
 * demographic breakdowns, complete per-post tables with watch time, story
 * metrics, trend history, and each creator's placement pipeline. Used to
 * deliver the marketplace service (brand matching, placement pricing).
 * The roster covers EVERY creator account on the platform — connected or not —
 * so coverage gaps are visible, not invisible.
 * FullScale-internal — never shown in Meta App Review screencasts.
 */

import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Loader2, ShieldAlert, Database, Users, Clock, Megaphone,
  ChevronDown, ChevronRight, Instagram, Facebook,
  ArrowUp, ArrowDown, ArrowUpDown,
} from "lucide-react";
import {
  fmt, TrendBars, DemoBars, MediaTable, StoriesStrip,
  type SocialAccountAnalytics,
} from "@/components/AnalyticsBits";

/** Contract (A): full-roster entry from GET /api/admin/creator-intelligence. */
interface CreatorRow {
  userId: string;
  email: string | null;
  name: string;
  joinedAt: string | null;
  coverage: { meta: boolean; youtube: boolean };
  audience: {
    followers: number | null;
    engagementRatePct: number | null;
    source: "meta" | null;
  };
  supply: {
    videosScanned: number;
    canonicalSurfaces: number;
    sceneClasses: number;
    sellableMinutes: number;
  };
  funnel: {
    surfacesApproved: number;
    brandRequests: number;
    placementsApproved: number;
    released: number;
  };
  editorial: { clipsGenerated: number; clipsRendered: number };
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
      {data.accounts.length === 0 && data.placements.length === 0 && (
        <p className="py-4 text-sm text-muted-foreground text-center">
          No connected platform data for this creator yet.
        </p>
      )}
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

/** Filled badge when connected; muted outline + "not connected" tooltip when not. */
function CoverageBadge({ label, connected }: { label: string; connected: boolean }) {
  if (connected) {
    return <Badge variant="secondary" className="text-[10px]">{label}</Badge>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* span wrapper: Badge doesn't forward refs, Radix asChild needs one */}
        <span className="inline-flex" tabIndex={0}>
          <Badge
            variant="outline"
            className="text-[10px] text-muted-foreground border-white/15 opacity-60"
            data-testid={`coverage-missing-${label.toLowerCase()}`}
          >
            {label}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p className="text-xs">{label} not connected</p>
      </TooltipContent>
    </Tooltip>
  );
}

type SortKey = "followers" | "er" | "videos" | "surfaces" | "minutes" | "clips";
type SortState = { key: SortKey; dir: "asc" | "desc" };

function sortValue(c: CreatorRow, key: SortKey): number | null {
  switch (key) {
    case "followers": return c.audience?.followers ?? null;
    case "er": return c.audience?.engagementRatePct ?? null;
    case "videos": return c.supply?.videosScanned ?? 0;
    case "surfaces": return c.supply?.canonicalSurfaces ?? 0;
    case "minutes": return c.supply?.sellableMinutes ?? 0;
    case "clips": return c.editorial?.clipsGenerated ?? 0;
  }
}

function SortableTh({
  label, k, sort, onSort,
}: {
  label: string; k: SortKey; sort: SortState; onSort: (k: SortKey) => void;
}) {
  const active = sort.key === k;
  return (
    <th className="p-3 font-medium text-right">
      <button
        type="button"
        className={`inline-flex items-center gap-1 hover:text-gray-200 ${active ? "text-gray-200" : ""}`}
        onClick={() => onSort(k)}
        data-testid={`sort-${k}`}
      >
        {label}
        {active
          ? (sort.dir === "desc" ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />)
          : <ArrowUpDown className="w-3 h-3 opacity-40" />}
      </button>
    </th>
  );
}

/** Minutes can be fractional; keep one decimal below 10, k/M formatting above. */
function fmtMinutes(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v < 10) return v.toFixed(1);
  return fmt(Math.round(v));
}

export default function AdminCreatorIntelligence() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ key: "followers", dir: "desc" });
  const { data, isLoading, isError, error } = useQuery<{ creators: CreatorRow[] }>({
    queryKey: ["/api/admin/creator-intelligence"],
    queryFn: async () => {
      const res = await fetch("/api/admin/creator-intelligence", { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to load");
      return res.json();
    },
    refetchInterval: 5 * 60_000,
    retry: false,
  });

  const creators = data?.creators ?? [];

  const sorted = useMemo(() => {
    return [...creators].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls last, whichever direction
      if (bv == null) return -1;
      return sort.dir === "desc" ? bv - av : av - bv;
    });
  }, [creators, sort]);

  const totals = useMemo(() => ({
    creators: creators.length,
    followers: creators.reduce((n, c) => n + (c.audience?.followers ?? 0), 0),
    sellableMinutes: creators.reduce((n, c) => n + (c.supply?.sellableMinutes ?? 0), 0),
    released: creators.reduce((n, c) => n + (c.funnel?.released ?? 0), 0),
  }), [creators]);

  const onSort = (k: SortKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === "desc" ? "asc" : "desc" } : { key: k, dir: "desc" }));

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

  return (
    <div className="container mx-auto px-4 md:px-6 py-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Database className="w-6 h-6 text-primary" /> Creator Intelligence
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          The full creator roster — audiences, scanned supply, and how each creator is
          interacting with brands. Click a row for the full drill-down.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Creators", value: fmt(totals.creators), icon: Users },
          { label: "Total audience", value: fmt(totals.followers), icon: Users },
          { label: "Sellable minutes", value: fmtMinutes(totals.sellableMinutes), icon: Clock },
          { label: "Released placements", value: fmt(totals.released), icon: Megaphone },
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

      {creators.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            No creator accounts yet. The roster fills in as creators sign up;
            audience metrics appear once they connect Meta or YouTube.
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
                  <th className="p-3 font-medium">Coverage</th>
                  <SortableTh label="Followers" k="followers" sort={sort} onSort={onSort} />
                  <SortableTh label="ER%" k="er" sort={sort} onSort={onSort} />
                  <SortableTh label="Videos" k="videos" sort={sort} onSort={onSort} />
                  <SortableTh label="Surfaces" k="surfaces" sort={sort} onSort={onSort} />
                  <SortableTh label="Sellable min" k="minutes" sort={sort} onSort={onSort} />
                  <th className="p-3 font-medium text-center">Funnel (appr/req/placed/rel)</th>
                  <SortableTh label="Clips (gen/rend)" k="clips" sort={sort} onSort={onSort} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => (
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
                          <CoverageBadge label="Meta" connected={!!c.coverage?.meta} />
                          <CoverageBadge label="YouTube" connected={!!c.coverage?.youtube} />
                        </div>
                      </td>
                      <td className="p-3 text-right text-white">{fmt(c.audience?.followers)}</td>
                      <td className="p-3 text-right">
                        {c.audience?.engagementRatePct != null
                          ? `${c.audience.engagementRatePct.toFixed(1)}%`
                          : "—"}
                      </td>
                      <td className="p-3 text-right">{fmt(c.supply?.videosScanned ?? 0)}</td>
                      <td className="p-3 text-right">{fmt(c.supply?.canonicalSurfaces ?? 0)}</td>
                      <td className="p-3 text-right">{fmtMinutes(c.supply?.sellableMinutes ?? 0)}</td>
                      <td className="p-3 text-center whitespace-nowrap">
                        <span className="text-gray-200">{c.funnel?.surfacesApproved ?? 0}</span>
                        {" / "}
                        <span className="text-amber-400">{c.funnel?.brandRequests ?? 0}</span>
                        {" / "}
                        <span className="text-sky-400">{c.funnel?.placementsApproved ?? 0}</span>
                        {" / "}
                        <span className="text-emerald-400">{c.funnel?.released ?? 0}</span>
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <span className="text-white">{fmt(c.editorial?.clipsGenerated ?? 0)}</span>
                        <span className="text-muted-foreground"> / {fmt(c.editorial?.clipsRendered ?? 0)}</span>
                      </td>
                    </tr>
                    {expanded === c.userId && (
                      <tr>
                        <td colSpan={10} className="p-0">
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
