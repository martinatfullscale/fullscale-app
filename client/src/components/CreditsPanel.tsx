/**
 * Credits — buy, and see what you've bought.
 *
 * Redirects to Stripe's hosted Checkout rather than collecting card details
 * here: card data never touches this app, so PCI scope stays minimal, and
 * Stripe handles 3-D Secure, wallets, tax and receipts. It also means no
 * publishable key and no Stripe.js bundle in the client.
 *
 * The success redirect is treated as a HINT, not proof. Anyone can open the
 * success URL directly; credits are granted by the signature-verified
 * webhook. So on return this polls the balance for a few seconds rather than
 * asserting the purchase landed — and says plainly if it hasn't yet, because
 * "your credits are on the way" is true and "purchase complete" might not be.
 */
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fetchWithTimeout } from "@/lib/queryClient";
import { Loader2, Sparkles, Check, AlertTriangle, Coins, Wrench } from "lucide-react";

interface Pack {
  id: string;
  credits: number;
  priceCents: number;
  label: string;
  perCreditNote: string;
  popular?: boolean;
}

interface PacksResponse {
  checkoutAvailable: boolean;
  checkoutDetail: string;
  packs: Pack[];
  allowance: { freeImagesPerDay: number; freeImagesUsedToday: number; freeImagesLeft: number; balance: number };
  purchases: Array<{
    id: number; credits: number; status: string;
    amountPaidCents: number; currency: string;
    createdAt: string | null; fulfilledAt: string | null;
  }>;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

export default function CreditsPanel() {
  const [buying, setBuying] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const purchaseState = params?.get("purchase");
  const [awaitingFulfilment, setAwaitingFulfilment] = useState(purchaseState === "success");

  const { data, isLoading, refetch } = useQuery<PacksResponse>({
    queryKey: ["/api/credits/packs"],
    queryFn: async () => (await fetchWithTimeout("/api/credits/packs", { credentials: "include" })).json(),
    // While waiting on the webhook, poll — fulfilment is usually a second or
    // two behind the redirect but is not guaranteed to beat it.
    refetchInterval: awaitingFulfilment ? 2000 : false,
  });

  // Stop polling once a fulfilled purchase appears, or after a sensible wait.
  useEffect(() => {
    if (!awaitingFulfilment) return;
    const fulfilled = (data?.purchases ?? []).some((p) => p.status === "fulfilled");
    if (fulfilled) { setAwaitingFulfilment(false); return; }
    const giveUp = setTimeout(() => setAwaitingFulfilment(false), 30_000);
    return () => clearTimeout(giveUp);
  }, [awaitingFulfilment, data?.purchases]);

  // ── Admin: grant credits without Stripe ──────────────────────────
  // Payments are gated on the webhook secret, but the credit system itself
  // is not. This lets the team hand out credits to test the generation flow,
  // comp a creator, or make good on a support issue — and it is the same
  // audited path a purchase uses, so grants appear in the ledger too.
  const { data: me } = useQuery<{ isAdmin?: boolean; email?: string }>({
    queryKey: ["/api/auth/user-type"],
  });
  const [granting, setGranting] = useState(false);
  const [grantAmount, setGrantAmount] = useState("50");
  const [grantEmail, setGrantEmail] = useState("");

  const grant = async () => {
    setGranting(true);
    setErr(null);
    try {
      const res = await fetchWithTimeout("/api/admin/credits/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          userId: grantEmail.trim() || me?.email,
          amount: parseInt(grantAmount) || 0,
          reason: "manual",
          note: "Granted from the Credits panel",
        }),
      });
      const body = await res.json();
      if (!res.ok) { setErr(body.error || "Grant failed"); return; }
      await refetch();
    } catch (e: any) {
      setErr(e?.message || "Grant failed");
    } finally {
      setGranting(false);
    }
  };

  const buy = async (packId: string) => {
    setBuying(packId);
    setErr(null);
    try {
      const res = await fetchWithTimeout("/api/credits/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ packId }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) { setErr(body.error || "Could not start checkout"); return; }
      window.location.href = body.url;
    } catch (e: any) {
      setErr(e?.message || "Could not start checkout");
    } finally {
      setBuying(null);
    }
  };

  const a = data?.allowance;

  return (
    <div className="space-y-6" data-testid="credits-panel">
      <div>
        <h2 className="text-lg font-semibold mb-1">Credits</h2>
        <p className="text-sm text-muted-foreground max-w-xl">
          Credits pay for AI cutaways in the clip editor. Images are free up to five a day —
          credits cover more than that, and unlock AI video.
        </p>
      </div>

      {purchaseState === "cancelled" && (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
          <p className="text-sm">Checkout cancelled — nothing was charged.</p>
        </div>
      )}

      {awaitingFulfilment && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 flex items-start gap-2.5">
          <Loader2 className="w-4 h-4 animate-spin text-emerald-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium">Payment received — adding your credits</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Stripe confirms the payment to us separately from this page, so this usually takes
              a second or two. Your balance updates here automatically.
            </p>
          </div>
        </div>
      )}

      {/* Balance + free allowance */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-lg border border-border/60 p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Coins className="w-3.5 h-3.5" />
            <span className="text-[11px] uppercase tracking-wider">Credit balance</span>
          </div>
          <p className="text-2xl font-bold tabular-nums">{a?.balance ?? "—"}</p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Sparkles className="w-3.5 h-3.5" />
            <span className="text-[11px] uppercase tracking-wider">Free images today</span>
          </div>
          <p className="text-2xl font-bold tabular-nums">
            {a ? `${a.freeImagesLeft} / ${a.freeImagesPerDay}` : "—"}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">Resets daily. No credits needed.</p>
        </div>
      </div>

      {data && !data.checkoutAvailable && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium">Buying credits isn't switched on here</p>
            <p className="text-xs text-muted-foreground mt-0.5">{data.checkoutDetail}</p>
          </div>
        </div>
      )}

      {/* Packs */}
      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {(data?.packs ?? []).map((p) => (
            <div
              key={p.id}
              className={`rounded-lg border p-4 flex flex-col ${
                p.popular ? "border-primary/50 bg-primary/5" : "border-border/60"
              }`}
              data-testid={`pack-${p.id}`}
            >
              {p.popular && (
                <Badge variant="outline" className="self-start mb-2 text-[10px] text-primary border-primary/40">
                  Most popular
                </Badge>
              )}
              <p className="text-sm font-semibold">{p.label}</p>
              <p className="text-2xl font-bold tabular-nums mt-1">{usd(p.priceCents)}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5 mb-3">{p.perCreditNote}</p>
              <p className="text-[11px] text-muted-foreground mb-3 leading-snug">
                ≈ {p.credits} images, or {Math.floor(p.credits / 10)} AI video cutaways
              </p>
              <Button
                className="mt-auto w-full"
                disabled={!data?.checkoutAvailable || buying !== null}
                onClick={() => buy(p.id)}
                data-testid={`buy-${p.id}`}
              >
                {buying === p.id ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
                {buying === p.id ? "Opening checkout…" : "Buy"}
              </Button>
            </div>
          ))}
        </div>
      )}

      {err && <p className="text-sm text-destructive">{err}</p>}

      {/* Admin-only. The server re-checks the allowlist — this is convenience,
          not the authorization. */}
      {me?.isAdmin && (
        <div className="rounded-lg border border-border/60 p-4">
          <div className="flex items-center gap-2 mb-1">
            <Wrench className="w-3.5 h-3.5 text-muted-foreground" />
            <p className="text-sm font-medium">Grant credits (admin)</p>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Works without Stripe — for testing the generation flow, comping a creator, or
            fixing a support issue. Grants land in the same ledger as purchases.
          </p>
          <div className="flex gap-2 flex-wrap">
            <input
              value={grantEmail}
              onChange={(e) => setGrantEmail(e.target.value)}
              placeholder={me.email ? `${me.email} (you)` : "creator@example.com"}
              className="h-9 px-3 rounded-md bg-muted/40 border border-border text-sm flex-1 min-w-[200px]"
              data-testid="grant-email"
            />
            <input
              value={grantAmount}
              onChange={(e) => setGrantAmount(e.target.value.replace(/\D/g, ""))}
              className="h-9 px-3 rounded-md bg-muted/40 border border-border text-sm w-24"
              data-testid="grant-amount"
            />
            <Button
              variant="outline"
              disabled={granting || !(parseInt(grantAmount) > 0)}
              onClick={grant}
              data-testid="grant-submit"
            >
              {granting ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
              Grant
            </Button>
          </div>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground leading-relaxed max-w-xl">
        Payment is handled by Stripe — card details never reach FullScale. A failed generation
        always refunds its credits automatically, and a free daily image that fails doesn't
        count against your five.
      </p>

      {/* Receipts */}
      {(data?.purchases?.length ?? 0) > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Purchases</h3>
          <div className="rounded-lg border border-border/60 divide-y divide-border/40">
            {data!.purchases.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2">
                {p.status === "fulfilled"
                  ? <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  : <Loader2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                <span className="text-sm flex-1">{p.credits} credits</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {usd(p.amountPaidCents)}
                </span>
                <span className="text-[11px] text-muted-foreground w-20 text-right">
                  {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : ""}
                </span>
                {p.status !== "fulfilled" && (
                  <Badge variant="outline" className="text-[10px]">{p.status}</Badge>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
