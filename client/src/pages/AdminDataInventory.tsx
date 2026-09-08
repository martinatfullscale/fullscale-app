/**
 * Data Inventory — the provenance ledger for data licensing (admin-gated).
 *
 * Answers one question for the operator: what data do we hold, where did it
 * come from, and what are we allowed to do with it? Three provenance tiers:
 *   - First-party (ours): FullScale-generated — licensable with creator consent.
 *   - Platform-licensed (theirs): Meta/Google-bound — display only, never exported.
 *   - Derived (aggregate-only): cohort-level rollups — the only exportable shape.
 * Also carries the one piece of state an operator can actually reach in here:
 * set memory (room models), which is held indefinitely and needs a reset valve.
 * FullScale-internal — never shown in Meta App Review screencasts.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2, ShieldAlert, Boxes, Layers, Lock, Sigma, FileDown, Scale,
  Camera, Trash2,
  type LucideIcon,
} from "lucide-react";
import { fmt } from "@/components/AnalyticsBits";
import { apiRequest, fetchWithTimeout } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface InventoryCard {
  key: string;
  title: string;
  description: string;
  table: string;
  rowCount: number;
  last30d: number | null;
  licensable: "yes" | "consent-required" | "no";
  notes: string;
}

interface DataInventoryResponse {
  firstParty: InventoryCard[];
  thirdParty: InventoryCard[];
  derived: InventoryCard[];
}

const LICENSABLE_BADGE: Record<InventoryCard["licensable"], { label: string; className: string }> = {
  yes: { label: "licensable", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" },
  "consent-required": { label: "consent required", className: "border-amber-500/40 bg-amber-500/10 text-amber-400" },
  no: { label: "never exported", className: "border-red-500/40 bg-red-500/10 text-red-400" },
};

/** Aggregated export schema (draft) — cohort-level only, no raw platform metrics. */
const EXPORT_SCHEMA_FIELDS: Array<{ field: string; type: string; note: string }> = [
  { field: "brand_category", type: "string", note: "Brand product vertical (coarse)" },
  { field: "content_category", type: "string", note: "Creator content vertical (coarse)" },
  { field: "week", type: "iso-week", note: "Reporting bucket, e.g. 2026-W31" },
  { field: "audience_cohort", type: "string", note: "Coarse audience bucket — never raw demographics" },
  { field: "placements", type: "int", note: "Placement count in this cohort × week" },
  { field: "avg_price_band", type: "string", note: "Banded placement fee — never exact amounts" },
  { field: "approval_rate", type: "float", note: "Approved ÷ requested, 0–1" },
  { field: "avg_screen_time_s", type: "float", note: "Mean sellable screen time per placement (seconds)" },
];

function InventoryCardTile({ card }: { card: InventoryCard }) {
  const badge = LICENSABLE_BADGE[card.licensable];
  return (
    <Card data-testid={`inventory-card-${card.key}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium text-white truncate">{card.title}</p>
            <p className="text-[11px] font-mono text-muted-foreground truncate">{card.table}</p>
          </div>
          <Badge variant="outline" className={`text-[10px] shrink-0 ${badge.className}`}>
            {badge.label}
          </Badge>
        </div>
        <div className="mt-3 flex items-baseline gap-2 flex-wrap">
          <p
            className="text-2xl font-bold text-white"
            title={card.rowCount.toLocaleString()}
            data-testid={`inventory-count-${card.key}`}
          >
            {fmt(card.rowCount)}
          </p>
          <span className="text-xs text-muted-foreground">rows</span>
          {card.last30d != null && (
            <span className="text-xs text-emerald-400">+{fmt(card.last30d)} last 30d</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-2">{card.description}</p>
        {card.notes && (
          <p className="text-[11px] text-muted-foreground/70 mt-1.5 border-t border-white/5 pt-1.5">
            {card.notes}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function InventorySection({
  title, subtitle, icon: Icon, cards, testId,
}: {
  title: string; subtitle: string; icon: LucideIcon; cards: InventoryCard[]; testId: string;
}) {
  return (
    <section className="mb-8" data-testid={testId}>
      <h2 className="text-lg font-semibold text-white flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary" /> {title}
      </h2>
      <p className="text-xs text-muted-foreground mt-0.5 mb-3">{subtitle}</p>
      {cards.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Nothing tracked in this tier yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {cards.map((c) => <InventoryCardTile key={c.key} card={c} />)}
        </div>
      )}
    </section>
  );
}

/** Contract: one row per remembered set from GET /api/admin/room-models. */
interface RoomModelRow {
  id: number;
  userId: string;
  creatorName: string | null;
  creatorEmail: string | null;
  surfaceCount: number;
  unusableCount?: number;
  surfaceTypes: string[];
  episodeCount: number;
  exemplarCount: number;
  sourceVideoId: number | null;
  lastVideoId: number | null;
  lastVideoTitle: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Legacy rows can be email-keyed with no display name — fall back down the chain. */
function creatorLabel(m: RoomModelRow): string {
  return m.creatorName || m.creatorEmail || m.userId;
}

/** Recent memory reads better relative; anything older is just a date. */
function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return "just now"; // also absorbs clock skew between app and db
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Confirm dialogs read as prose, so the counts in them have to agree with the noun. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Set memory (room models) — the only mutable state on this page.
 *
 * A model is built once from a scan and then reused forever, so one built from a
 * degraded scan quietly poisons every later scan of that set. Nothing prunes it
 * automatically; this is the reset valve. Owns its own query so a room-model
 * outage can't take down the provenance ledger above it.
 */
function RoomModelSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery<{ models: RoomModelRow[] }>({
    queryKey: ["/api/admin/room-models"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/admin/room-models", { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to load");
      return res.json();
    },
    retry: false,
  });

  const models = data?.models ?? [];

  const forget = useMutation({
    mutationFn: async (m: RoomModelRow) => {
      const res = await apiRequest("DELETE", `/api/admin/room-models/${m.id}`);
      return res.json();
    },
    onSuccess: (_res, m) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/room-models"] });
      toast({
        title: "Set memory cleared",
        description: `${creatorLabel(m)} rediscovers this set on their next scan.`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Couldn't forget that set", description: err.message, variant: "destructive" });
    },
  });

  const forgetAll = useMutation({
    mutationFn: async () => {
      // scope=all is mandatory server-side — an unscoped DELETE is a 400, not a wipe.
      const res = await apiRequest("DELETE", "/api/admin/room-models?scope=all");
      return res.json() as Promise<{ deleted: number }>;
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/room-models"] });
      toast({
        title: "Set memory wiped",
        description: `${plural(res.deleted, "room model")} forgotten. Every set rebuilds on its creator's next scan.`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Couldn't wipe set memory", description: err.message, variant: "destructive" });
    },
  });

  const onForget = (m: RoomModelRow) => {
    const ok = confirm(
      `Forget ${creatorLabel(m)}'s set memory?\n\n` +
      `${plural(m.surfaceCount, "canonical surface")} will be dropped, and their next scan ` +
      `will rediscover this set from scratch.\n\n` +
      `Any brand placement anchored to this set loses its cross-scan link — the rebuilt ` +
      `model gets a new identity, so those placements won't re-match automatically.`
    );
    if (ok) forget.mutate(m);
  };

  const onForgetAll = () => {
    const ok = confirm(
      `Forget ALL set memory — ${plural(models.length, "room model")} across every creator?\n\n` +
      `Each set gets rediscovered from scratch on its creator's next scan, and every brand ` +
      `placement anchored to a set loses its cross-scan link.`
    );
    if (ok) forgetAll.mutate();
  };

  return (
    <section className="mb-8" data-testid="inventory-section-room-models">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Camera className="w-4 h-4 text-primary" /> Set memory (room models)
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Persistent per-set surface memory: one row per recurring camera setup, whose surfaces
            every future scan confirms instead of re-detecting. Forgetting one makes the next scan
            rediscover that set from scratch — safe, just slower and briefly less consistent.
          </p>
        </div>
        {models.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-red-500/40 text-red-400"
            onClick={onForgetAll}
            disabled={forgetAll.isPending}
            data-testid="room-models-forget-all"
          >
            {forgetAll.isPending
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Trash2 className="w-3.5 h-3.5" />}
            Forget all
          </Button>
        )}
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Loader2 className="w-5 h-5 animate-spin text-primary mx-auto" />
          </CardContent>
        </Card>
      ) : isError ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-red-400">
            {(error as any)?.message || "Couldn't load set memory."}
          </CardContent>
        </Card>
      ) : models.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No set memory yet — the next successful scan will build it.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm" data-testid="room-models-table">
              <thead>
                <tr className="text-xs text-muted-foreground text-left border-b border-white/10">
                  <th className="p-3 font-medium">Creator</th>
                  <th className="p-3 font-medium">Surfaces</th>
                  <th className="p-3 font-medium text-right">Episodes</th>
                  <th className="p-3 font-medium text-right">Exemplars</th>
                  <th className="p-3 font-medium">Last video</th>
                  <th className="p-3 font-medium">Updated</th>
                  <th className="p-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => {
                  const types = Array.from(new Set(m.surfaceTypes ?? [])); // detector labels repeat across surfaces
                  const shown = types.slice(0, 4);
                  const pending = forget.isPending && forget.variables?.id === m.id;
                  return (
                    <tr
                      key={m.id}
                      className="border-b border-white/5 last:border-0"
                      data-testid={`room-model-row-${m.id}`}
                    >
                      <td className="p-3">
                        <p className="font-medium text-white truncate max-w-[16rem]">
                          {creatorLabel(m)}
                        </p>
                        {m.creatorEmail && m.creatorEmail !== creatorLabel(m) && (
                          <p className="text-xs text-muted-foreground truncate max-w-[16rem]">
                            {m.creatorEmail}
                          </p>
                        )}
                      </td>
                      <td className="p-3">
                        <span className="text-white">{m.surfaceCount}</span>
                        {(m.unusableCount ?? 0) > 0 && (
                          <span className="ml-1.5 text-[10px] text-amber-400" title="Stored entries the scanner cannot use — this model is degraded and worth forgetting">
                            +{m.unusableCount} unusable
                          </span>
                        )}
                        <div className="flex flex-wrap gap-1 mt-1">
                          {shown.map((t) => (
                            <Badge key={t} variant="outline" className="text-[10px] font-normal">
                              {t}
                            </Badge>
                          ))}
                          {types.length > shown.length && (
                            <span className="text-[10px] text-muted-foreground self-center">
                              +{types.length - shown.length}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-3 text-right">{fmt(m.episodeCount ?? 0)}</td>
                      <td className="p-3 text-right">{fmt(m.exemplarCount ?? 0)}</td>
                      <td className="p-3">
                        <span className="text-gray-200 line-clamp-1 max-w-[18rem]">
                          {m.lastVideoTitle || (m.lastVideoId ? `video ${m.lastVideoId}` : "—")}
                        </span>
                      </td>
                      <td className="p-3 text-muted-foreground whitespace-nowrap">
                        {fmtWhen(m.updatedAt)}
                      </td>
                      <td className="p-3 text-right">
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => onForget(m)}
                          disabled={pending || forgetAll.isPending}
                          data-testid={`room-model-forget-${m.id}`}
                        >
                          {pending
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Trash2 className="w-3.5 h-3.5" />}
                          Forget
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

export default function AdminDataInventory() {
  const { data, isLoading, isError, error } = useQuery<DataInventoryResponse>({
    queryKey: ["/api/admin/data-inventory"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/admin/data-inventory", { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to load");
      return res.json();
    },
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isError || !data) {
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
          <Boxes className="w-6 h-6 text-primary" /> Data Inventory
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          What we hold, where it came from, and what we're allowed to do with it.
        </p>
      </div>

      {/* Provenance explainer — the licensing ground rules, up top. */}
      <div
        className="rounded-lg border border-primary/25 bg-primary/5 p-4 mb-8 flex gap-3"
        data-testid="inventory-explainer"
      >
        <Scale className="w-5 h-5 text-primary shrink-0 mt-0.5" />
        <div className="text-sm text-gray-300 space-y-1">
          <p className="font-medium text-white">This is the provenance ledger for data licensing.</p>
          <p className="text-xs text-muted-foreground">
            First-party data is FullScale-generated — ours to license with creator consent.
            Platform data (Meta / Google) is bound by their terms: display only, and it never
            leaves the app. Only derived, aggregate-level data is candidate for export.
          </p>
        </div>
      </div>

      <InventorySection
        title="First-party (ours)"
        subtitle="Generated by FullScale's own pipeline — licensable with creator consent."
        icon={Layers}
        cards={data.firstParty}
        testId="inventory-section-first-party"
      />
      <InventorySection
        title="Platform-licensed (theirs — display only)"
        subtitle="Synced from Meta / Google under their platform terms. Never exported, never resold."
        icon={Lock}
        cards={data.thirdParty}
        testId="inventory-section-third-party"
      />
      <InventorySection
        title="Derived (aggregate-only)"
        subtitle="Cohort-level rollups computed from the tiers above — the only exportable shape."
        icon={Sigma}
        cards={data.derived}
        testId="inventory-section-derived"
      />

      <RoomModelSection />

      {/* Aggregated export schema (draft) — static documentation, not wired. */}
      <section className="mt-2" data-testid="inventory-export-schema">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <FileDown className="w-4 h-4 text-primary" /> Aggregated export schema (draft)
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5 mb-3">
          The only shape brand-facing exports will ever take: cohort-level aggregates,
          no raw platform metrics, no per-creator or per-post rows.
        </p>
        <Card>
          <CardContent className="p-4">
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-muted-foreground text-left border-b border-white/10">
                    <th className="pb-2 pr-4 font-medium">field</th>
                    <th className="pb-2 pr-4 font-medium">type</th>
                    <th className="pb-2 font-medium font-sans">notes</th>
                  </tr>
                </thead>
                <tbody>
                  {EXPORT_SCHEMA_FIELDS.map((f) => (
                    <tr key={f.field} className="border-b border-white/5 last:border-0">
                      <td className="py-2 pr-4 text-white whitespace-nowrap">{f.field}</td>
                      <td className="py-2 pr-4 text-primary/80 whitespace-nowrap">{f.type}</td>
                      <td className="py-2 text-muted-foreground font-sans">{f.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground/70 mt-3 border-t border-white/5 pt-3">
              Exports enforce a minimum cohort size — rows below the threshold are suppressed
              before anything leaves the app. This endpoint is not yet wired; the schema above
              is the draft contract.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
