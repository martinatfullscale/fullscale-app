/**
 * Go-live capture — the blocking gap in CV-impact measurement.
 *
 * The honest distribution flow ends with the creator posting natively, so
 * nothing in-app knows a placement reached an audience. Without that event
 * there is no platform post id, so none of the analytics fetchers have
 * anything to poll and no audience metric can be attributed to a treatment.
 *
 * Asking creators to paste URLs reliably does not work. Since we already
 * hold their YouTube connection, we instead LOOK for the post: uploads that
 * appeared on their channel after their placement was marked render-ready
 * are strong candidates, and the creator confirms with one tap. Manual URL
 * entry remains as the fallback for platforms we can't poll.
 *
 * See docs/DATA_DICTIONARY.md §6 gaps 1 and 6.
 */

import { storage } from "../storage";
import { getFreshYoutubeTokenForUser } from "./youtubeAuth";

export interface GoLiveCandidate {
  platform: "youtube";
  platformPostId: string;
  postUrl: string;
  title: string;
  thumbnailUrl: string | null;
  publishedAt: string;
}

/** Parse a pasted post URL into (platform, native post id). */
export function parsePostUrl(raw: string): { platform: string; platformPostId: string | null } | null {
  const url = String(raw ?? "").trim();
  if (!url || url.length > 2048) return null;
  const yt =
    url.match(/(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/(?:shorts|live)\/)([A-Za-z0-9_-]{11})/i);
  if (yt) return { platform: "youtube", platformPostId: yt[1] };
  if (/instagram\.com\/(?:p|reel|tv)\//i.test(url)) {
    const m = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i);
    return { platform: "instagram", platformPostId: m?.[1] ?? null };
  }
  if (/tiktok\.com/i.test(url)) {
    const m = url.match(/\/video\/(\d+)/);
    return { platform: "tiktok", platformPostId: m?.[1] ?? null };
  }
  if (/(?:x|twitter)\.com/i.test(url)) {
    const m = url.match(/status\/(\d+)/);
    return { platform: "twitter", platformPostId: m?.[1] ?? null };
  }
  if (/facebook\.com/i.test(url)) return { platform: "facebook", platformPostId: null };
  return { platform: "other", platformPostId: null };
}

/**
 * Uploads on the creator's connected YouTube channel published at/after
 * `since` — the candidate set for "which post carries this placement?".
 * Returns [] rather than throwing: a missing connection is a normal state,
 * not an error worth surfacing.
 */
export async function findGoLiveCandidates(
  userId: string,
  authEmail: string | undefined,
  since: Date,
): Promise<GoLiveCandidate[]> {
  try {
    // Shared refresh path — handles expiry and the email/uuid key split.
    let accessToken = await getFreshYoutubeTokenForUser(userId).catch(() => null);
    if (!accessToken && authEmail && authEmail !== userId) {
      accessToken = await getFreshYoutubeTokenForUser(authEmail).catch(() => null);
    }
    if (!accessToken) return [];

    // publishedAfter is RFC-3339; pad backwards slightly so a post made in
    // the same minute the render finished still surfaces.
    const publishedAfter = new Date(since.getTime() - 60_000).toISOString();
    const url =
      `https://www.googleapis.com/youtube/v3/search?part=snippet&forMine=true&type=video` +
      `&order=date&maxResults=10&publishedAfter=${encodeURIComponent(publishedAfter)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[GoLive] YouTube candidate search failed (${res.status})`);
      return [];
    }
    const data: any = await res.json();
    return (data.items ?? [])
      .filter((it: any) => it?.id?.videoId)
      .map((it: any) => ({
        platform: "youtube" as const,
        platformPostId: it.id.videoId,
        postUrl: `https://www.youtube.com/watch?v=${it.id.videoId}`,
        title: it.snippet?.title ?? "Untitled",
        thumbnailUrl: it.snippet?.thumbnails?.medium?.url ?? null,
        publishedAt: it.snippet?.publishedAt ?? new Date().toISOString(),
      }));
  } catch (err: any) {
    console.warn(`[GoLive] Candidate lookup failed (non-fatal): ${err?.message}`);
    return [];
  }
}

/**
 * Record that a placement reached an audience. This is the row every
 * downstream measurement hangs off — Phase 2's retention curves join
 * against inContentStartSec, and the analytics fetchers poll platformPostId.
 */
export async function recordGoLive(args: {
  ownerUserId: string;          // the CONTENT owner, not the caller
  placement: any;               // saved_placements row
  platform: string;
  postUrl: string;
  platformPostId: string | null;
  linkSource: "creator_confirmed" | "admin";
  /** How the URL was discovered — provenance for analytic trust. */
  candidateSource?: "channel_match" | "manual";
  liveAt?: Date;
}): Promise<any> {
  const { placement } = args;

  // Fixture identity + SOURCE-VIDEO position from the anchor surface. These
  // are source coordinates: if the published asset is a trimmed clip, Phase 2
  // must map through the clip offset before joining a retention curve.
  let surfaceGroupId: string | null = null;
  let sourceStartSec: string | null = null;
  try {
    const surfaces = await storage.getDetectedSurfaces(placement.videoId);
    const surface = surfaces.find((s: any) => s.id === placement.surfaceId);
    surfaceGroupId = ((surface as any)?.surfaceGroupId as string | null) ?? null;
    const ts = surface ? parseFloat(String((surface as any).timestamp)) : NaN;
    if (Number.isFinite(ts)) sourceStartSec = String(Math.max(0, Math.round(ts)));
  } catch {
    /* identity is best-effort — the exposure row is still worth having */
  }

  // Join the exposure to the treatment window that authorized it. Without
  // assignmentId the treatment ledger and the exposure ledger can never be
  // joined, and no treated fixture could reach an audience outcome.
  let assignmentId: number | null = null;
  let brandProductId: number | null = placement.productId ?? null;
  try {
    const approved = await storage.getApprovedPlacementsForVideo(placement.videoId).catch(() => []);
    const match = (approved as any[]).find((a) => a.surfaceId === placement.surfaceId);
    if (match) {
      assignmentId = match.id;
      brandProductId = match.brandProductId ?? brandProductId;
    }
  } catch {
    /* an unmatched exposure is meaningful too — it's organic, not treated */
  }

  const row = await storage.createPlacementExposure({
    userId: String(args.ownerUserId),
    placementId: placement.id,
    assignmentId,
    surfaceGroupId,
    brandProductId,
    sourceVideoId: placement.videoId,
    platform: args.platform.slice(0, 32),
    postUrl: args.postUrl,
    platformPostId: args.platformPostId,
    liveAt: args.liveAt ?? new Date(),
    sourceStartSec,
    linkSource: args.linkSource,
    // A creator tapping a suggestion IS a confirmation — the earlier code
    // recorded their explicit tap as unconfirmed, inverting analytic trust.
    confirmedAt: new Date(),
  } as any);

  console.log(
    `[Measurement] placement_exposures: placement ${placement.id} live on ${args.platform}` +
      `${args.platformPostId ? ` (${args.platformPostId})` : ""} — fixture ${surfaceGroupId ?? "unknown"}, ` +
      `assignment ${assignmentId ?? "none (organic)"}, via ${args.candidateSource ?? "manual"}`,
  );
  return row;
}
