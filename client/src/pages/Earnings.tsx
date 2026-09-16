import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  DollarSign, Info, ChevronDown, ChevronUp, Clock, CheckCircle2, XCircle,
  AlertTriangle, RefreshCw, FlaskConical, ExternalLink,
} from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Earnings — what the creator's placements are worth, and what is actually
 * true about getting paid.
 *
 * /earnings used to render the Dashboard a second time. The temptation in
 * replacing it is to build a wallet: a balance, a next-payout date, a monthly
 * chart. None of that exists in the data. The fee rubric is real and every
 * placement carries a real 70% creator share, but `charge_status` has never
 * advanced past "pending", nothing records that a brand was charged, and no
 * payout rail exists. So this page reports ACCRUED VALUE and says so, once,
 * plainly, at the top — rather than implying money is on its way.
 */

interface EarningRow {
  id: number;
  bucket: "offered" | "accrued" | "closed";
  status: string;
  videoId: number;
  videoTitle: string;
  videoThumbnail: string | null;
  productName: string | null;
  productImageUrl: string | null;
  creatorPayoutCents: number;
  placementFeeCents: number;
  platformTakeCents: number;
  isTestPlacement: boolean;
  durationTerm: string;
  durationDays: number;
  expiresAt: string | null;
  negotiatedNote: string | null;
  pricing: Record<string, any> | null;
  pricingOverride: "custom" | "test" | null;
  offeredAt: string | null;
  decidedAt: string | null;
}

interface EarningsResponse {
  rows: EarningRow[];
  totals: { offeredCents: number; accruedCents: number; closedCents: number; testPlacements: number };
  payout: { available: boolean; note: string };
}

/** Must match Dashboard's usdFromCents — the two surfaces print the same figure. */
const usd = (cents: number): string =>
  (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });

const STATUS_LABEL: Record<string, string> = {
  pending_creator_review: "Awaiting your decision",
  creator_approved: "You approved",
  pending_brand_review: "With the brand",
  brand_approved: "Brand approved",
  creator_rejected: "You declined",
  brand_withdrawn: "Brand withdrew",
  expired: "Term ended",
};

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

const TERM_LABEL: Record<string, string> = {
  single: "One-off",
  "1-month": "1 month",
  "3-month": "3 months",
  "6-month": "6 months",
  "12-month": "12 months",
};

export default function Earnings() {
  const [, setLocation] = useLocation();
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data, isLoading, error, refetch } = useQuery<EarningsResponse>({
    queryKey: ["/api/creator/earnings"],
    staleTime: 0,
  });

  const rows = data?.rows ?? [];
  const totals = data?.totals;
  const byBucket = (b: EarningRow["bucket"]) => rows.filter((r) => r.bucket === b);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar />
      <main className="p-8 max-w-4xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <DollarSign className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold font-display">Earnings</h1>
        </div>
        <p className="text-muted-foreground text-sm mb-6 max-w-2xl">
          What your placements are worth. Every figure here is your 70% share of a brand's placement fee,
          priced when the brand made the request.
        </p>

        {/* The one thing this page must not be coy about. */}
        {data && !data.payout.available && (
          <div className="mb-6 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 flex items-start gap-3" data-testid="earnings-payout-notice">
            <Info className="w-4 h-4 mt-0.5 text-amber-400 shrink-0" />
            <div className="text-sm">
              <div className="font-medium text-amber-200">No payouts have been made yet</div>
              <p className="text-amber-200/75">{data.payout.note}</p>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-20 rounded-xl border border-border bg-card animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-sm">
            <div className="flex items-center gap-2 text-red-300 font-medium mb-1">
              <AlertTriangle className="w-4 h-4" /> Couldn't load your earnings
            </div>
            <p className="text-muted-foreground mb-3">{(error as Error).message}</p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card/40 p-12 text-center">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4">
              <DollarSign className="w-6 h-6" />
            </div>
            <h2 className="text-lg font-semibold mb-1">Nothing to show yet</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">
              When a brand requests a placement on one of your videos, the offer and your share appear here.
            </p>
            <Button onClick={() => setLocation("/opportunities")}>See opportunities</Button>
          </div>
        ) : (
          <>
            {/* Totals. Three numbers, each named for exactly what it is. */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
              <TotalTile
                label="Accrued"
                sub="Placements you've approved"
                value={usd(totals?.accruedCents ?? 0)}
                tone="emerald"
                testid="tile-accrued"
              />
              <TotalTile
                label="Offered"
                sub="Waiting on your decision"
                value={usd(totals?.offeredCents ?? 0)}
                tone="sky"
                testid="tile-offered"
              />
              <TotalTile
                label="Not proceeding"
                sub="Declined, withdrawn or ended"
                value={usd(totals?.closedCents ?? 0)}
                tone="zinc"
                testid="tile-closed"
              />
            </div>

            {totals && totals.testPlacements > 0 && (
              <p className="text-xs text-muted-foreground mb-6 flex items-center gap-1.5">
                <FlaskConical className="w-3.5 h-3.5" />
                {totals.testPlacements} test placement{totals.testPlacements === 1 ? " is" : "s are"} listed below and excluded from every total.
              </p>
            )}

            <Section
              title="Accrued"
              hint="You approved these. The amount is committed but not yet payable."
              rows={byBucket("accrued")}
              expanded={expanded}
              onToggle={setExpanded}
            />
            <Section
              title="Offers awaiting you"
              hint="Nothing accrues until you approve."
              rows={byBucket("offered")}
              expanded={expanded}
              onToggle={setExpanded}
              action={{ label: "Review in your Inbox", onClick: () => setLocation("/inbox") }}
            />
            <Section
              title="Not proceeding"
              hint="Declined, withdrawn by the brand, or the term ended."
              rows={byBucket("closed")}
              expanded={expanded}
              onToggle={setExpanded}
              muted
            />
          </>
        )}
      </main>
    </div>
  );
}

function TotalTile({ label, sub, value, tone, testid }: {
  label: string; sub: string; value: string; tone: "emerald" | "sky" | "zinc"; testid: string;
}) {
  const tones = {
    emerald: "text-emerald-400 border-emerald-500/20 bg-emerald-500/5",
    sky: "text-sky-400 border-sky-500/20 bg-sky-500/5",
    zinc: "text-zinc-400 border-border bg-card",
  } as const;
  return (
    <div className={cn("rounded-xl border p-4", tones[tone])} data-testid={testid}>
      <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">{label}</p>
      <p className={cn("text-2xl font-bold tabular-nums", tones[tone].split(" ")[0])}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{sub}</p>
    </div>
  );
}

function Section({ title, hint, rows, expanded, onToggle, action, muted }: {
  title: string;
  hint: string;
  rows: EarningRow[];
  expanded: number | null;
  onToggle: (id: number | null) => void;
  action?: { label: string; onClick: () => void };
  muted?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-sm font-semibold">{title} <span className="text-muted-foreground font-normal">({rows.length})</span></h2>
        {action && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={action.onClick}>
            {action.label} <ExternalLink className="w-3 h-3 ml-1" />
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-3">{hint}</p>
      <div className="space-y-2">
        {rows.map((r) => (
          <EarningCard key={r.id} row={r} expanded={expanded === r.id} onToggle={() => onToggle(expanded === r.id ? null : r.id)} muted={muted} />
        ))}
      </div>
    </section>
  );
}

function EarningCard({ row, expanded, onToggle, muted }: {
  row: EarningRow; expanded: boolean; onToggle: () => void; muted?: boolean;
}) {
  const statusIcon = row.bucket === "accrued" ? CheckCircle2 : row.bucket === "offered" ? Clock : XCircle;
  const StatusIcon = statusIcon;
  const canExplain = !!row.pricing || !!row.pricingOverride || !!row.negotiatedNote;

  return (
    <div className={cn("rounded-xl border border-border bg-card overflow-hidden", muted && "opacity-70")} data-testid={`earning-${row.id}`}>
      <div className="p-3 flex items-center gap-3">
        <div className="w-16 h-10 rounded-md bg-black/40 overflow-hidden shrink-0">
          {row.videoThumbnail && <img src={row.videoThumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate" title={row.videoTitle}>{row.videoTitle}</div>
          <div className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
            <StatusIcon className="w-3 h-3" />
            {STATUS_LABEL[row.status] ?? row.status}
            {row.productName && <>· {row.productName}</>}
            {row.durationTerm !== "single" && <>· {TERM_LABEL[row.durationTerm] ?? row.durationTerm}</>}
            {row.isTestPlacement && (
              <Badge variant="outline" className="h-4 px-1 text-[10px] border-amber-500/40 text-amber-300">Test</Badge>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={cn("text-base font-semibold tabular-nums", row.bucket === "accrued" ? "text-emerald-400" : row.bucket === "offered" ? "text-sky-400" : "text-muted-foreground line-through")}>
            {usd(row.creatorPayoutCents)}
          </div>
          <div className="text-[11px] text-muted-foreground">{fmtDate(row.decidedAt ?? row.offeredAt)}</div>
        </div>
        {canExplain && (
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={onToggle} aria-label="How was this priced?">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-border px-3 py-3 text-xs space-y-2 bg-black/20">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Brand pays</span>
            <span className="tabular-nums">{usd(row.placementFeeCents)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">FullScale fee</span>
            <span className="tabular-nums">−{usd(row.platformTakeCents)}</span>
          </div>
          <div className="flex items-center justify-between font-medium">
            <span>Your share</span>
            <span className="tabular-nums">{usd(row.creatorPayoutCents)}</span>
          </div>

          {row.pricingOverride === "custom" ? (
            <p className="pt-2 text-muted-foreground border-t border-border">
              This fee was set directly rather than by the standard rate.
              {row.negotiatedNote && <> Note from the brand: “{row.negotiatedNote}”</>}
            </p>
          ) : row.pricingOverride === "test" ? (
            <p className="pt-2 text-muted-foreground border-t border-border">
              A test placement. It carries no fee and is excluded from your totals.
            </p>
          ) : row.pricing ? (
            <div className="pt-2 border-t border-border space-y-1 text-muted-foreground">
              <div className="font-medium text-foreground">How this was priced</div>
              {typeof row.pricing.expectedImpressions === "number" && (
                <div className="flex justify-between"><span>Expected impressions</span><span className="tabular-nums">{row.pricing.expectedImpressions.toLocaleString()}</span></div>
              )}
              {typeof row.pricing.baseCpmUsd === "number" && (
                <div className="flex justify-between"><span>Base rate (CPM)</span><span className="tabular-nums">${row.pricing.baseCpmUsd}</span></div>
              )}
              {Object.entries(row.pricing)
                .filter(([k, v]) => k.endsWith("Multiplier") && typeof v === "number")
                .map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <span>{k.replace(/Multiplier$/, "").replace(/([A-Z])/g, " $1").toLowerCase()}</span>
                    <span className="tabular-nums">×{v as number}</span>
                  </div>
                ))}
              {/* When a floor or ceiling clamped the result, the multiplier
                  chain above does NOT produce the fee shown at the top. Say
                  so instead of leaving the reader to fail the arithmetic. */}
              {typeof row.pricing.rawCalculatedCents === "number" && row.pricing.rawCalculatedCents !== row.placementFeeCents && (
                <div className="flex justify-between pt-1 border-t border-border/50">
                  <span>{row.pricing.rawCalculatedCents < row.placementFeeCents ? "Minimum fee applied" : "Capped at the maximum"}</span>
                  <span className="tabular-nums">calculated {usd(row.pricing.rawCalculatedCents)}</span>
                </div>
              )}
              {row.expiresAt && (
                <div className="flex justify-between"><span>Term ends</span><span>{fmtDate(row.expiresAt)}</span></div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
