/**
 * Tier 2: grounded open-vocabulary geometry proposals via fal.ai Florence-2.
 *
 * The scanner's box drift and label flip come from Gemini re-guessing
 * geometry on every frame. Florence-2 produces deterministic boxes for a
 * fixed phrase list, so we run it ONCE per scene class (on the class's
 * first analyzed frame — scene classes are recurring camera setups, so one
 * frame's geometry holds for the class) and feed the boxes to Gemini as
 * PROPOSALS to judge, never as truth.
 *
 * Verified by live spike (2026-08-03): the endpoint accepts ONE phrase per
 * call (a dotted multi-phrase string comes back as a single whole-image box
 * labeled with the entire string); boxes come back in PIXEL coordinates of
 * the ORIGINAL uploaded image; "not found" often surfaces as a near-full-
 * frame box, which we filter. ~3.6s/call, so phrases run concurrently.
 *
 * Fail-open everywhere: no FAL_KEY, GROUNDED_DETECTOR=0, timeouts, or the
 * process-lifetime breaker all yield null and the scan proceeds exactly as
 * before Tier 2. Cost note: ≤ PHRASES×MAX_FRAMES calls per scan (36 at
 * current settings) — per-call price unverified offline; check the fal
 * dashboard after the first scan.
 */

import * as fs from "fs";
import sharp from "sharp";
import { fal } from "@fal-ai/client";

export interface GroundedProposal {
  phrase: string;
  /** Normalized 0-1 */
  x: number;
  y: number;
  width: number;
  height: number;
}

// One call each — keep this list short and placement-relevant.
const SURFACE_PHRASES = ["wall", "table", "desk", "side table", "shelf", "couch"] as const;

const PER_CALL_TIMEOUT_MS = 20_000;
const PER_FRAME_DEADLINE_MS = 45_000;
const BREAKER_LIMIT = 3;

let consecutiveFrameFailures = 0;
let disabledReason: string | null = process.env.GROUNDED_DETECTOR === "0" ? "GROUNDED_DETECTOR=0" : null;

export function groundedDetectorAvailable(): boolean {
  return !disabledReason && !!process.env.FAL_KEY;
}

/**
 * Detect surface-phrase regions in one frame. Returns normalized proposals,
 * [] when the detector ran but found nothing usable, null when it did not
 * run (disabled, no key, breaker open, or total failure).
 */
export async function detectGroundedSurfaces(framePath: string): Promise<GroundedProposal[] | null> {
  if (!groundedDetectorAvailable()) return null;
  // HARD frame deadline: fal.storage.upload and subscribe's submit phase
  // are otherwise unbounded, and this runs inline in the frame loop. The
  // race abandons (not cancels) the work — bounded impact, breaker counts it.
  const outcome = await Promise.race([
    detectGroundedSurfacesInner(framePath),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), PER_FRAME_DEADLINE_MS + 5_000)),
  ]);
  if (outcome === "timeout") {
    recordFrameFailure("frame deadline exceeded");
    return null;
  }
  return outcome;
}

function recordFrameFailure(why: string): void {
  consecutiveFrameFailures += 1;
  console.warn(`[Grounded] Frame detection failed (${consecutiveFrameFailures}/${BREAKER_LIMIT}): ${why}`);
  if (consecutiveFrameFailures >= BREAKER_LIMIT) {
    disabledReason = `${consecutiveFrameFailures} consecutive failures`;
    console.error(`[Grounded] Detector DISABLED for this process: ${disabledReason}`);
  }
}

async function detectGroundedSurfacesInner(framePath: string): Promise<GroundedProposal[] | null> {
  const frameDeadline = Date.now() + PER_FRAME_DEADLINE_MS;
  try {
    fal.config({ credentials: process.env.FAL_KEY! });
    const meta = await sharp(framePath).metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;
    if (!imgW || !imgH) throw new Error("frame has no dimensions");

    const buf = fs.readFileSync(framePath);
    const mime = meta.format === "png" ? "image/png" : "image/jpeg";
    const imageUrl = await fal.storage.upload(new Blob([buf], { type: mime }));

    let phraseFailures = 0;
    const perPhrase = await Promise.all(
      SURFACE_PHRASES.map(async (phrase): Promise<GroundedProposal[]> => {
        const remaining = frameDeadline - Date.now();
        if (remaining < 2_000) return [];
        try {
          const res: any = await fal.subscribe("fal-ai/florence-2-large/open-vocabulary-detection", {
            input: { image_url: imageUrl, text_input: phrase },
            timeout: Math.min(PER_CALL_TIMEOUT_MS, remaining),
          } as any);
          const bboxes: any[] = res?.data?.results?.bboxes ?? [];
          return bboxes
            .map((b) => ({
              phrase,
              x: Math.max(0, Math.min(1, b.x / imgW)),
              y: Math.max(0, Math.min(1, b.y / imgH)),
              width: Math.max(0, Math.min(1, b.w / imgW)),
              height: Math.max(0, Math.min(1, b.h / imgH)),
            }))
            .filter((p) => {
              const area = p.width * p.height;
              // Near-full-frame = Florence's "not found" tell (observed in
              // the spike); sub-0.3% is noise below placement usefulness.
              return area > 0.003 && area < 0.85 && p.width > 0.02 && p.height > 0.02;
            });
        } catch (e: any) {
          phraseFailures += 1;
          console.warn(`[Grounded] "${phrase}" failed: ${e?.status ?? ""} ${e?.message ?? e}`);
          return [];
        }
      }),
    );

    // Every phrase throwing = systematic API failure (dead endpoint,
    // exhausted balance) — the dominant real failure mode, and exactly what
    // the breaker exists for. Success-with-zero-proposals stays a success.
    if (phraseFailures >= SURFACE_PHRASES.length) {
      recordFrameFailure(`all ${SURFACE_PHRASES.length} phrases failed at the API`);
      return null;
    }

    const proposals = perPhrase.flat();
    consecutiveFrameFailures = 0;
    console.log(`[Grounded] ${proposals.length} proposal(s) from ${SURFACE_PHRASES.length} phrases`);
    return proposals;
  } catch (err: any) {
    recordFrameFailure(String(err?.message || err));
    return null;
  }
}
