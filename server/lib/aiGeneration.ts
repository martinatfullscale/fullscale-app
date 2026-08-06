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

export type GenKind = "image" | "video";

export interface GenModel {
  id: string;
  /** fal model id. */
  falModel: string;
  kind: GenKind;
  label: string;
  /** What this costs US. In ten-thousandths of a cent: 1 = $0.000001.
   *  For video this is per SECOND; for images, per image.
   *  VERIFY against provider billing — treat as configuration, not truth. */
  costMicrosPerUnit: number;
  /** Credits we charge the creator, per generation. */
  creditsPerGeneration: number;
  /** Typical wall-clock, which decides inline vs queued UX. */
  typicalLatencyMs: number;
  /** Video only: seconds produced per generation. */
  outputSeconds?: number;
  native916: boolean;
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
    falModel: "fal-ai/flux/schnell",
    kind: "image",
    label: "Image — fast",
    costMicrosPerUnit: 3_000,        // ~$0.003 per image
    creditsPerGeneration: 1,
    typicalLatencyMs: 3_000,
    native916: true,
    notes: "Few seconds, cheap. The default for a cutaway still.",
  },
  {
    id: "image-quality",
    falModel: "fal-ai/flux/dev",
    kind: "image",
    label: "Image — higher quality",
    costMicrosPerUnit: 25_000,       // ~$0.025 per image
    creditsPerGeneration: 3,
    typicalLatencyMs: 12_000,
    native916: true,
    notes: "Slower and sharper; worth it when the cutaway holds on screen.",
  },
  {
    id: "video-short",
    falModel: "fal-ai/kling-video/v1/standard/text-to-video",
    kind: "video",
    label: "Video — 5s clip",
    costMicrosPerUnit: 50_000,       // ~$0.05 per second
    outputSeconds: 5,
    creditsPerGeneration: 30,
    typicalLatencyMs: 150_000,
    native916: true,
    notes: "Real motion. Minutes to generate, so it runs as a background job.",
  },
];

export function modelById(id: string): GenModel | undefined {
  return GEN_MODELS.find((m) => m.id === id);
}

export function generationAvailable(): boolean {
  return !!process.env.FAL_KEY;
}

/** Total cost of one generation with this model, in ten-thousandths of a cent. */
export function costMicrosFor(model: GenModel): number {
  return model.kind === "video"
    ? model.costMicrosPerUnit * (model.outputSeconds ?? 5)
    : model.costMicrosPerUnit;
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
}): Promise<GenerateResult> {
  const model = modelById(args.modelId);
  if (!model) return { ok: false, generationId: 0, error: `Unknown model "${args.modelId}"` };
  if (!generationAvailable()) {
    return { ok: false, generationId: 0, error: "AI generation isn't configured on this server (FAL_KEY missing)." };
  }
  const prompt = String(args.prompt ?? "").trim();
  if (prompt.length < 3) return { ok: false, generationId: 0, error: "Give it something to work with — a few words at least." };

  const cost = costMicrosFor(model);
  const credits = model.creditsPerGeneration;

  const charged = await storage.spendCredits(args.userId, credits);
  if (!charged.ok) {
    return { ok: false, generationId: 0, error: `Not enough credits — this costs ${credits}, you have ${charged.balance}.` };
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
    await storage.grantCredits(args.userId, credits, "refund", `Failed generation #${gen.id}`).catch(() => {});
    await storage.completeAiGeneration(gen.id, {
      status: "failed",
      errorMessage: message.slice(0, 500),
      latencyMs: Date.now() - startedAt,
    }).catch(() => {});
  };

  try {
    const { fal } = await import("@fal-ai/client");
    fal.config({ credentials: process.env.FAL_KEY! });

    const input: Record<string, unknown> = { prompt };
    if (model.kind === "image") {
      // 9:16 is the target frame; asking for it natively beats cropping a
      // square, which reliably loses the subject.
      input.image_size = args.aspectRatio === "16:9" ? "landscape_16_9" : "portrait_16_9";
      input.num_images = 1;
    } else {
      input.aspect_ratio = args.aspectRatio === "16:9" ? "16:9" : "9:16";
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
