/**
 * Creator Intelligence — the OPERATOR's roster (admin-gated).
 *
 * Every connected creator's audience size, engagement, top demographics, and
 * placement activity in one reviewable table: how creators and brands are
 * actually interacting on the platform. This view is FullScale-internal —
 * it is NOT the surface shown in Meta App Review screencasts (that's the
 * creator-facing /analytics page).
 */

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldAlert, Database, Users, Eye, Megaphone } from "lucide-react";

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

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function AdminCreatorIntelligence() {
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
                  <tr key={c.userId} className="border-b border-white/5 hover:bg-white/[0.02]" data-testid={`creator-row-${c.userId}`}>
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
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
