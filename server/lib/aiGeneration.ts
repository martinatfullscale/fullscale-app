/**
 * AI-generated b-roll — the paid tier.
 *
 * B-roll here is STORY footage: a podcast cuts away to something illustrating
 * the point being made. That framing decides the whole design, because the
 * unit that matters is "a 3-second cutaway", and there are two very different
 * ways to make one:
 *
 *   A generated STILL with a slow push/pan costs roughly a fifth of a cent and
 *   returns in seconds. A generated VIDEO costs one to two orders of magnitude
 *   more and takes minutes. For a cutaway that is on screen for three seconds
 *   under a talking head, the still is usually indistinguishable — which makes
 *   it both the better default AND the one with real margin at a price a
 *   creator will pay.
 *
 * So both exist, images are the default, and the price difference is stated in
 * the UI rather than hidden behind a single "generate" button.
 *
 * COST IS RECORDED PER GENERATION, not inferred from a monthly invoice.
 * ai_generations carries our cost and the credits charged on the same row —
 * without that, per-unit margin is unrecoverable once the provider bills in
 * aggregate.
 *
 * The model registry below is deliberately data, not code paths: swapping to a
 * cheaper or better model is a table edit, and every price here is a CONFIGURED
 * value that must be reconciled against the provider's actual billing rather
 * than trusted as fact.
 */

import { storage } from "../storage";
import { keyValue, hasKey, KEY_ALIASES } from "./envKeys";

export type GenKind = "image" | "video";

export interface GenModel {
  id: string;
  /** fal model id. */
  falModel: string;
  kind: GenKind;
  label: string;
  /** Total cost to US of ONE generation, in ten-thousandths of a cent
   *  (1 = $0.000001). Not per-second or per-megapixel — those are internal
   *  details of how a provider bills, and pricing a product on them is how
   *  you ship a tier whose cost you cannot predict. VERIFY against real fal
   *  invoices before selling; this is configuration, not fact. */
  costMicros: number;
  /** Credits charged. Weighted per model — a single flat credit across image
   *  and video is arbitraged instantly by anyone who always picks video. */
  creditsPerGeneration: number;
  /** Typical wall-clock. Under ~15s can be inline; minutes must be a job. */
  typicalLatencyMs: number;
  /** Video only: seconds produced. Providers sell a MINIMUM clip length —
   *  budget on it, because you cannot buy less. */
  outputSeconds?: number;
  /** Exact pixel dimensions we request. Load-bearing for image models billed
   *  per megapixel — see the note on the image model below. */
  width?: number;
  height?: number;
  /** Video models that animate a still rather than generating from text. */
  seedsFromImage?: boolean;
  notes: string;
}

/**
 * Prices below are CONFIGURATION and must be reconciled with fal's current
 * published rates before this tier is sold. They are set conservatively (i.e.
 * assuming we pay more rather than less) so a mis-set value errs toward
 * under-charging us rather than over-charging a creator.
 */
export const GEN_MODELS: GenModel[] = [
  {
    id: "image-fast",
    falModel: "fal-ai/flux-2/flash",
    kind: "image",
    label: "Cutaway image",
    // ── THE RESOLUTION IS A COST DECISION, NOT A QUALITY ONE ──
    // This model bills per megapixel, ROUNDED UP. 720x1280 is exactly 9:16
    // and 0.92 MP, so it bills in the 1-MP bucket. 1080x1920 is 2.07 MP and
    // bills in the 2- or 3-MP bucket depending on how the provider defines a
    // megapixel — i.e. 2–3x the cost, for a frame that receives a ~2% Ken
    // Burns push and is on screen for three seconds. Nobody can see the
    // difference; the P&L can.
    width: 720,
    height: 1280,
    costMicros: 5_000,               // ~$0.005 — 1 MP bucket
    creditsPerGeneration: 1,
    typicalLatencyMs: 4_000,
    notes: "Sub-second model. The right default — a still with a slow push reads as well as video in a 3s cutaway.",
  },
  {
    id: "image-sharp",
    falModel: "fal-ai/flux-2/flash",
    kind: "image",
    label: "Cutaway image — sharp",
    // 1008x1792 is exactly 9:16 and 1.81 MP, so it lands in the 2-MP bucket
    // under EITHER megapixel definition. Deliberate: it makes the cost
    // predictable rather than dependent on the provider's rounding.
    width: 1008,
    height: 1792,
    costMicros: 10_000,              // ~$0.010 — 2 MP bucket
    creditsPerGeneration: 2,
    typicalLatencyMs: 6_000,
    notes: "Higher resolution, for a cutaway that holds on screen longer.",
  },
  {
    id: "video-short",
    falModel: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    kind: "video",
    label: "Animate into 5s video",
    // IMAGE-TO-VIDEO, not text-to-video. The seed is a still the creator has
    // already looked at and accepted, which means: they never spend video
    // money on a composition they'd reject, 9:16 comes free from the input
    // image, and the upgrade is a click on an asset already in the timeline.
    seedsFromImage: true,
    outputSeconds: 5,                // the provider's MINIMUM — cannot buy 3s
    costMicros: 350_000,             // ~$0.35 for the 5s minimum
    creditsPerGeneration: 10,
    typicalLatencyMs: 180_000,
    notes: "Real motion — worth it when the movement IS the subject (traffic, water, crowds). Runs in the background for a few minutes.",
  },
];

/**
 * Minimum credits a model may be sold for and still clear the margin floor.
 *
 * Priced against the DEEPEST pack discount, because that is the price a
 * heavy user actually pays and therefore the one margin has to survive.
 * Any new model must be weighted with this, or whoever always picks the
 * most expensive option arbitrages a flat credit price.
 */
export const DEEPEST_CREDIT_PRICE_USD = 0.111;   // 800 credits for $89
export const MARGIN_FLOOR = 0.68;                // 68% gross

export function minimumCreditsFor(costMicros: number): number {
  const costUsd = costMicros / 1_000_000;
  return Math.ceil(costUsd / ((1 - MARGIN_FLOOR) * DEEPEST_CREDIT_PRICE_USD));
}

/** Margin check for the configured registry — surfaced to admins so a
 *  mispriced model is visible rather than discovered in a monthly invoice. */
export function marginReport(): Array<{
  id: string; costUsd: number; credits: number; minCredits: number;
  revenueAtDeepestUsd: number; grossMarginPct: number; ok: boolean;
}> {
  return GEN_MODELS.map((m) => {
    const costUsd = m.costMicros / 1_000_000;
    const revenue = m.creditsPerGeneration * DEEPEST_CREDIT_PRICE_USD;
    return {
      id: m.id,
      costUsd,
      credits: m.creditsPerGeneration,
      minCredits: minimumCreditsFor(m.costMicros),
      revenueAtDeepestUsd: Number(revenue.toFixed(4)),
      grossMarginPct: Number((((revenue - costUsd) / revenue) * 100).toFixed(1)),
      ok: m.creditsPerGeneration >= minimumCreditsFor(m.costMicros),
    };
  });
}

/**
 * FREE DAILY IMAGE ALLOWANCE — the conversion mechanic, not a giveaway.
 *
 * A creator who has never generated an image does not want one, so paywalling
 * the first generation paywalls the demo. Five images a day costs us ~$0.025
 * at full burn — roughly $0.75 per creator per month if they max it every
 * single day, which nobody does. The upgrade prompt then fires at the cap, in
 * the editor, at the moment of intent, against work they can already see.
 *
 * VIDEO IS NEVER FREE. At ~$0.35 a clip it is 70x an image; one free video a
 * day per creator would cost more than the entire image allowance for a month.
 * Video is what the credits are FOR.
 */
export const DAILY_FREE_IMAGES = 5;

export interface Allowance {
  freeImagesPerDay: number;
  freeImagesUsedToday: number;
  freeImagesLeft: number;
  balance: number;
}

export async function getAllowance(userId: string): Promise<Allowance> {
  const [used, balance] = await Promise.all([
    storage.countFreeImagesUsedToday(userId),
    storage.getCreditBalance(userId),
  ]);
  return {
    freeImagesPerDay: DAILY_FREE_IMAGES,
    freeImagesUsedToday: used,
    freeImagesLeft: Math.max(0, DAILY_FREE_IMAGES - used),
    balance,
  };
}

/** What one generation will actually cost this creator right now. */
export async function priceFor(userId: string, model: GenModel): Promise<{
  credits: number; free: boolean; reason: string;
}> {
  if (model.kind !== "image") {
    return { credits: model.creditsPerGeneration, free: false, reason: "AI video is credit-only." };
  }
  const a = await getAllowance(userId);
  if (a.freeImagesLeft > 0) {
    return { credits: 0, free: true, reason: `${a.freeImagesLeft} of ${DAILY_FREE_IMAGES} free images left today.` };
  }
  return {
    credits: model.creditsPerGeneration,
    free: false,
    reason: `Today's ${DAILY_FREE_IMAGES} free images are used — this one costs credits.`,
  };
}

export function modelById(id: string): GenModel | undefined {
  return GEN_MODELS.find((m) => m.id === id);
}

export function generationAvailable(): boolean {
  return hasKey(KEY_ALIASES.fal);
}

/** Total cost of one generation. Already whole-generation, not per-unit. */
export function costMicrosFor(model: GenModel): number {
  return model.costMicros;
}

/** Human-readable dollars, for admin surfaces. Never shown to creators —
 *  they see credits, which is the whole point of a credit system. */
export function micosToUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

// ── Prompt derivation ───────────────────────────────────────────────────

/**
 * Turn what is being SAID into what should be SHOWN.
 *
 * Feeding the transcript line to an image model produces literal, usually
 * useless results — "so what I think is really important here" renders as
 * nothing. A cutaway wants the concrete noun behind the sentence, expressed
 * as a scene. This is a cheap heuristic that runs with no extra model call;
 * the copilot can do better when a creator asks it to.
 */
export function promptFromTranscript(text: string): string {
  const cleaned = String(text ?? "")
    .replace(/\b(um|uh|like|you know|i mean|sort of|kind of|basically|actually|literally)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  // Keep the content words; drop the scaffolding a speaker uses to think.
  const stop = new Set([
    "the","a","an","and","or","but","so","if","then","that","this","these","those",
    "is","are","was","were","be","been","being","have","has","had","do","does","did",
    "i","you","he","she","it","we","they","me","him","her","us","them","my","your",
    "to","of","in","on","at","for","with","about","from","as","by","just","really",
    "think","going","get","got","would","could","should","can","will","what","when",
  ]);
  const keywords = cleaned
    .toLowerCase()
    .split(/[^a-z0-9'-]+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, 6);
  if (keywords.length === 0) return "";
  return `Cinematic b-roll: ${keywords.join(", ")}. Documentary style, natural lighting, shallow depth of field, no text, no logos, no recognisable faces.`;
}

// ── Generation ──────────────────────────────────────────────────────────

export interface GenerateResult {
  ok: boolean;
  generationId: number;
  assetId?: number;
  url?: string;
  error?: string;
  /** Set when the block was affordability, not a fault — the client shows the
   *  upgrade path rather than a generic failure. */
  needsCredits?: boolean;
  creditsRequired?: number;
}

/**
 * Run one generation end to end: charge credits, call the model, store the
 * asset, record cost.
 *
 * CREDITS ARE DEBITED FIRST AND REFUNDED ON FAILURE. Charging after success
 * would let a creator fire unlimited concurrent generations that all pass the
 * balance check before any of them settles — the provider bills us for every
 * one of those.
 */
export async function runGeneration(args: {
  userId: string;
  modelId: string;
  prompt: string;
  promptSource?: "manual" | "transcript";
  editorialClipId?: number | null;
  aspectRatio?: string;
  /** For image-to-video: the media asset to animate. Required by any model
   *  with seedsFromImage — animating from text would be a different (and
   *  worse) product, because the creator would be paying video prices for a
   *  composition they have not seen. */
  seedAssetId?: number | null;
}): Promise<GenerateResult> {
  const model = modelById(args.modelId);
  if (!model) return { ok: false, generationId: 0, error: `Unknown model "${args.modelId}"` };
  if (!generationAvailable()) {
    return { ok: false, generationId: 0, error: "AI generation isn't configured on this server (FAL_KEY missing)." };
  }
  const prompt = String(args.prompt ?? "").trim();
  if (prompt.length < 3) return { ok: false, generationId: 0, error: "Give it something to work with — a few words at least." };

  // Resolve the seed BEFORE charging: a missing seed is the creator's most
  // likely mistake, and charging then refunding for it is a bad first
  // experience of a paid feature.
  let seedUrl: string | undefined;
  if (model.seedsFromImage) {
    if (!args.seedAssetId) {
      return { ok: false, generationId: 0, error: "Pick an image to animate first — video starts from a still you've already approved." };
    }
    const asset = await storage.getMediaAsset(Number(args.seedAssetId));
    if (!asset || asset.deletedAt || String(asset.userId) !== String(args.userId)) {
      return { ok: false, generationId: 0, error: "That image isn't available to animate." };
    }
    const { storageServeUrl } = await import("./objectStorage");
    seedUrl = storageServeUrl(asset.storagePath);
  }

  const cost = costMicrosFor(model);

  // Price at request time, not from the client: a client-supplied "this is
  // free" would be a way to mint unlimited generations.
  const pricing = await priceFor(args.userId, model);
  const credits = pricing.credits;

  if (credits > 0) {
    const charged = await storage.spendCredits(args.userId, credits);
    if (!charged.ok) {
      return {
        ok: false,
        generationId: 0,
        error: model.kind === "video"
          ? `AI video needs ${credits} credits — you have ${charged.balance}.`
          : `Today's ${DAILY_FREE_IMAGES} free images are used. This one costs ${credits} credit${credits === 1 ? "" : "s"} and you have ${charged.balance}.`,
        needsCredits: true,
        creditsRequired: credits,
      };
    }
  }

  const gen = await storage.createAiGeneration({
    userId: args.userId,
    editorialClipId: args.editorialClipId ?? null,
    kind: model.kind,
    provider: "fal",
    model: model.falModel,
    prompt: prompt.slice(0, 2000),
    promptSource: args.promptSource ?? "manual",
    aspectRatio: args.aspectRatio ?? "9:16",
    durationSec: model.outputSeconds ? String(model.outputSeconds) : null,
    status: "running",
    costMicros: cost,
    creditsCharged: credits,
  } as any);

  const startedAt = Date.now();
  const refund = async (message: string) => {
    // A free generation paid nothing, so there is nothing to give back — and
    // granting credits here would turn a provider error into free currency.
    if (credits > 0) {
      await storage.grantCredits(args.userId, credits, "refund", `Failed generation #${gen.id}`).catch(() => {});
    }
    await storage.completeAiGeneration(gen.id, {
      status: "failed",
      errorMessage: message.slice(0, 500),
      latencyMs: Date.now() - startedAt,
    }).catch(() => {});
  };

  try {
    const { fal } = await import("@fal-ai/client");
    fal.config({ credentials: keyValue(KEY_ALIASES.fal)! });

    const input: Record<string, unknown> = { prompt };
    if (model.kind === "image") {
      // EXPLICIT pixel dimensions, not a named preset. The preset's actual
      // size is the provider's choice, and this model bills per megapixel
      // rounded up — so letting them pick the size is letting them pick our
      // unit cost. Landscape swaps the axes to stay on the same MP bucket.
      const w = model.width ?? 720;
      const h = model.height ?? 1280;
      input.image_size = args.aspectRatio === "16:9" ? { width: h, height: w } : { width: w, height: h };
      input.num_images = 1;
    } else {
      // Aspect ratio is inherited from the seed image, so it is not sent —
      // one fewer place for the output shape to disagree with the input.
      input.image_url = seedUrl;
      if (model.outputSeconds) input.duration = String(model.outputSeconds);
    }

    const result: any = await fal.subscribe(model.falModel, { input, logs: false });

    // fal returns different shapes per model family; take the first URL we can
    // find rather than assuming one.
    const url: string | undefined =
      result?.data?.images?.[0]?.url ??
      result?.data?.image?.url ??
      result?.data?.video?.url ??
      result?.images?.[0]?.url ??
      result?.video?.url;

    if (!url) {
      await refund("The model returned no output.");
      return { ok: false, generationId: gen.id, error: "The model returned no output. Your credits were refunded." };
    }

    // Store it as a normal media asset so the editor and renderer treat AI
    // b-roll exactly like any other clip — one code path downstream.
    const path = await import("path");
    const os = await import("os");
    const fs = await import("fs");
    const ext = model.kind === "image" ? "png" : "mp4";
    const tmp = path.join(os.tmpdir(), `aigen-${gen.id}.${ext}`);
    const dl = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!dl.ok) {
      await refund(`Could not download the result (${dl.status}).`);
      return { ok: false, generationId: gen.id, error: "Generated, but the download failed. Your credits were refunded." };
    }
    fs.writeFileSync(tmp, Buffer.from(await dl.arrayBuffer()));

    try {
      const { uploadFileToStorage } = await import("./objectStorage");
      const objectKey = `public/media-assets/${encodeURIComponent(args.userId)}/${Date.now()}-ai.${ext}`;
      const serveUrl = await uploadFileToStorage(tmp, objectKey);

      const asset = await storage.createMediaAsset({
        userId: args.userId,
        kind: model.kind === "image" ? "broll_image" : "broll_video",
        name: `AI: ${prompt.slice(0, 60)}`,
        storagePath: objectKey,
        mimeType: model.kind === "image" ? "image/png" : "video/mp4",
        fileSizeBytes: fs.statSync(tmp).size,
        durationSec: model.outputSeconds ? String(model.outputSeconds) : null,
      } as any);

      await storage.completeAiGeneration(gen.id, {
        status: "succeeded",
        mediaAssetId: asset.id,
        latencyMs: Date.now() - startedAt,
      });
      console.log(
        `[AiGen] #${gen.id} ${model.id} ok in ${Date.now() - startedAt}ms — cost ${micosToUsd(cost)}, charged ${credits} credit(s)`,
      );
      return { ok: true, generationId: gen.id, assetId: asset.id, url: serveUrl };
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[AiGen] #${gen.id} failed: ${msg}`);
    await refund(msg);
    return { ok: false, generationId: gen.id, error: `Generation failed: ${msg}. Your credits were refunded.` };
  }
}
