/**
 * Buying credits — Stripe Checkout, hosted.
 *
 * HOSTED CHECKOUT, NOT ELEMENTS. Card details never touch this app, so PCI
 * scope stays at SAQ-A, and Stripe handles 3-D Secure, SCA, wallets, tax and
 * receipts. It also means the PUBLISHABLE key is not needed at all: the
 * session is created server-side and the browser is redirected to a Stripe
 * URL. One fewer secret to configure and one fewer to leak.
 *
 * THE WEBHOOK IS THE SOURCE OF TRUTH, NOT THE SUCCESS REDIRECT. Anyone can
 * open the success URL directly; it proves nothing about payment. Credits are
 * granted only when Stripe tells us, over a signature-verified webhook.
 *
 * FULFILMENT IS IDEMPOTENT BY CONSTRUCTION. Stripe delivers webhooks
 * at-least-once — redelivered on any non-2xx, on timeout, and on manual retry
 * from the dashboard. credit_purchases has a UNIQUE index on the session id,
 * so the second attempt fails the insert, and that failure is the signal to
 * skip the grant. Checking "have I seen this?" then granting would race
 * against a concurrent redelivery.
 */

import Stripe from "stripe";
import { storage } from "../storage";
import { keyValue, hasKey, KEY_ALIASES } from "./envKeys";

export interface CreditPack {
  id: string;
  credits: number;
  /** In cents. Server-side ONLY — a client-supplied price is a free money bug. */
  priceCents: number;
  label: string;
  /** Marketing line; also the honest per-credit rate. */
  perCreditNote: string;
  popular?: boolean;
}

/**
 * Packs. Prices are the ones the margin model was checked against — the
 * deepest discount ($0.111/credit) is what the floor in aiGeneration.ts
 * assumes, so changing THIS table without re-running marginReport() can
 * silently push a model underwater.
 */
export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", credits: 100, priceCents: 1500, label: "100 credits", perCreditNote: "$0.15 each" },
  { id: "creator", credits: 300, priceCents: 3900, label: "300 credits", perCreditNote: "$0.13 each — best for regular use", popular: true },
  { id: "studio",  credits: 800, priceCents: 8900, label: "800 credits", perCreditNote: "$0.11 each — lowest rate" },
];

export function packById(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

let cached: Stripe | null = null;
function stripeClient(): Stripe | null {
  if (cached) return cached;
  const key = keyValue(KEY_ALIASES.stripeSecret);
  if (!key) return null;
  // No explicit apiVersion: the installed SDK pins the version it was built
  // for, which is the version this code's types describe. Naming a version
  // here that disagrees with the SDK's types is how you get objects that
  // typecheck but arrive with different fields at runtime.
  cached = new Stripe(key);
  return cached;
}

export function checkoutAvailable(): { ok: boolean; detail: string } {
  const hasSecret = hasKey(KEY_ALIASES.stripeSecret);
  const hasHook = hasKey(KEY_ALIASES.stripeWebhook);
  if (!hasSecret) {
    return { ok: false, detail: "STRIPE_SECRET_KEY is not set in this environment." };
  }
  if (!hasHook) {
    // Deliberately blocks purchase rather than allowing one we cannot fulfil:
    // without the webhook secret we can take the money and never grant the
    // credits, which is the worst possible failure mode here.
    return { ok: false, detail: "STRIPE_WEBHOOK_SECRET is not set — purchases are disabled until it is, because credits are granted by webhook and an unverifiable webhook cannot be trusted." };
  }
  return { ok: true, detail: "Checkout is live." };
}

/**
 * Create a Checkout Session for a pack.
 *
 * The price is looked up from CREDIT_PACKS by id — the client sends only the
 * pack id, never an amount. Accepting a client-supplied price is the classic
 * way to sell 800 credits for one cent.
 */
export async function createCheckoutSession(args: {
  userId: string;
  userEmail?: string | null;
  packId: string;
  origin: string;
}): Promise<{ ok: true; url: string; sessionId: string } | { ok: false; error: string }> {
  const gate = checkoutAvailable();
  if (!gate.ok) return { ok: false, error: gate.detail };

  const stripe = stripeClient();
  if (!stripe) return { ok: false, error: "Payments are not configured." };

  const pack = packById(args.packId);
  if (!pack) return { ok: false, error: "Unknown credit pack." };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // Prefilling the email means the receipt reaches them and Stripe can
      // match a returning customer without us storing a customer id yet.
      customer_email: args.userEmail || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: pack.priceCents,
          product_data: {
            name: `FullScale — ${pack.label}`,
            description: "Credits for AI cutaway generation. Images are 1 credit; a 5-second AI video is 10.",
          },
        },
      }],
      // metadata is what the webhook reads to know WHO to credit. It must
      // carry everything fulfilment needs, because the webhook arrives with
      // no session of its own.
      metadata: {
        kind: "credit_pack",
        userId: args.userId,
        packId: pack.id,
        credits: String(pack.credits),
      },
      success_url: `${args.origin}/settings?tab=credits&purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${args.origin}/settings?tab=credits&purchase=cancelled`,
      // Expire abandoned sessions rather than leaving payable links alive.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    if (!session.url) return { ok: false, error: "Stripe did not return a checkout URL." };

    // Recorded as pending BEFORE the redirect, so an abandoned or failed
    // checkout is visible rather than invisible. Fulfilment flips it.
    await storage.createCreditPurchase({
      userId: args.userId,
      stripeSessionId: session.id,
      packId: pack.id,
      credits: pack.credits,
      amountPaidCents: pack.priceCents,
      currency: "usd",
      status: "pending",
    } as any).catch((err: any) => {
      // A pending-row failure must not block the purchase — the webhook
      // upserts on the same unique key and can still fulfil.
      console.warn(`[Credits] Could not pre-record purchase ${session.id}: ${err?.message}`);
    });

    return { ok: true, url: session.url, sessionId: session.id };
  } catch (err: any) {
    console.error("[Credits] Session creation failed:", err?.message);
    return { ok: false, error: err?.message || "Could not start checkout." };
  }
}

/** Verify a webhook payload. Returns the event or an error to 400 with. */
export function verifyWebhook(rawBody: Buffer | string, signature: string): { ok: true; event: Stripe.Event } | { ok: false; error: string } {
  const stripe = stripeClient();
  const secret = keyValue(KEY_ALIASES.stripeWebhook);
  if (!stripe || !secret) return { ok: false, error: "Payments not configured" };
  try {
    return { ok: true, event: stripe.webhooks.constructEvent(rawBody, signature, secret) };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Invalid signature" };
  }
}

/**
 * Grant the credits for a completed session, exactly once.
 *
 * Returns `alreadyFulfilled` rather than throwing on a duplicate, because a
 * redelivered webhook is normal traffic, not an error — and returning 500
 * would make Stripe retry it forever.
 */
export async function fulfilCheckout(webhookSession: Stripe.Checkout.Session): Promise<{
  fulfilled: boolean; alreadyFulfilled: boolean; reason?: string;
}> {
  // ── DO NOT TRUST THE WEBHOOK PAYLOAD'S SHAPE ──────────────────────
  //
  // Stripe serializes each event in the API version pinned to the webhook
  // DESTINATION, which defaults to the account's version — and an account
  // created years ago carries an old one. Checkout Sessions post-date many
  // of those versions entirely, so fields this code depends on
  // (payment_status, amount_total) can be absent or differently shaped, and
  // fulfilment would silently never fire.
  //
  // Re-fetching by id with OUR SDK returns the object in the version this
  // code was written against, whatever the destination is pinned to. The
  // webhook's job is to tell us WHICH session changed; the authoritative
  // state comes from the API. This also closes a replay gap: a stale
  // payload cannot assert a payment that has since been refunded.
  const stripe = stripeClient();
  if (!stripe) return { fulfilled: false, alreadyFulfilled: false, reason: "payments not configured" };

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(webhookSession.id);
  } catch (err: any) {
    // A retrieve failure is transient (network, rate limit) — surface it so
    // the caller 500s and Stripe redelivers, rather than silently dropping a
    // real payment.
    throw new Error(`Could not re-fetch session ${webhookSession.id}: ${err?.message}`);
  }

  if (session.metadata?.kind !== "credit_pack") {
    return { fulfilled: false, alreadyFulfilled: false, reason: "not a credit purchase" };
  }
  // Only a PAID session grants anything. `complete` with payment_status
  // 'unpaid' happens on async payment methods that can still fail.
  if (session.payment_status !== "paid") {
    return { fulfilled: false, alreadyFulfilled: false, reason: `payment_status=${session.payment_status}` };
  }

  const userId = String(session.metadata.userId ?? "");
  const credits = parseInt(String(session.metadata.credits ?? "0"));
  const packId = String(session.metadata.packId ?? "unknown");
  if (!userId || !Number.isFinite(credits) || credits <= 0) {
    return { fulfilled: false, alreadyFulfilled: false, reason: "missing or invalid metadata" };
  }

  // THE IDEMPOTENCY GATE. Marking fulfilled is a conditional update that only
  // matches a row still pending, so concurrent redeliveries cannot both win.
  const claimed = await storage.claimCreditPurchase(session.id, {
    stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
    // Trust Stripe's number over our pack table: if a price changed between
    // session creation and payment, what they PAID is the truth.
    amountPaidCents: session.amount_total ?? undefined,
    currency: session.currency ?? undefined,
    userId,
    packId,
    credits,
  });

  if (!claimed) {
    console.log(`[Credits] Session ${session.id} already fulfilled — skipping duplicate grant`);
    return { fulfilled: false, alreadyFulfilled: true };
  }

  const balance = await storage.grantCredits(userId, credits, "purchase", `Stripe ${session.id}`);
  console.log(`[Credits] Granted ${credits} to ${userId} for ${session.id} → balance ${balance}`);
  return { fulfilled: true, alreadyFulfilled: false };
}
