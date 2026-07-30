/**
 * Data Inventory — the provenance ledger for data licensing (admin-gated).
 *
 * Answers one question for the operator: what data do we hold, where did it
 * come from, and what are we allowed to do with it? Three provenance tiers:
 *   - First-party (ours): FullScale-generated — licensable with creator consent.
 *   - Platform-licensed (theirs): Meta/Google-bound — display only, never exported.
 *   - Derived (aggregate-only): cohort-level rollups — the only exportable shape.
 * FullScale-internal — never shown in Meta App Review screencasts.
 */

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, ShieldAlert, Boxes, Layers, Lock, Sigma, FileDown, Scale,
  type LucideIcon,
} from "lucide-react";
import { fmt } from "@/components/AnalyticsBits";

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

export default function AdminDataInventory() {
  const { data, isLoading, isError, error } = useQuery<DataInventoryResponse>({
    queryKey: ["/api/admin/data-inventory"],
    queryFn: async () => {
      const res = await fetch("/api/admin/data-inventory", { credentials: "include" });
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
