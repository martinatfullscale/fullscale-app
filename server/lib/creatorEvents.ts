/**
 * Creator event emission — one call site per meaningful creator decision.
 *
 * Deliberately fire-and-forget and never throwing: a failure to record
 * behavior must never fail the action the creator was taking. A missing
 * event is a gap in the research data; a thrown error is a broken product.
 *
 * The actor/creator split matters. `creatorUserId` is always the CONTENT
 * owner (whose behavior we're describing); `actorUserId` is whoever clicked.
 * They diverge when an admin acts on a creator's behalf — which the teach
 * route explicitly permits, and which was previously recorded as creator
 * engagement.
 */

import { storage } from "../storage";

export type CreatorEventType =
  | "surface_approved"
  | "surface_unapproved"
  | "surface_rejected"
  | "surface_taught"
  | "placement_created"
  | "placement_archived"
  | "placement_went_live"
  | "brand_request_approved"
  | "brand_request_rejected"
  | "video_imported"
  | "video_trashed"
  | "scan_started";

export interface CreatorEventInput {
  creatorUserId: string;
  actorUserId?: string | null;
  actorRole?: "creator" | "admin" | "brand" | "system";
  eventType: CreatorEventType;
  videoId?: number | null;
  surfaceId?: number | null;
  surfaceGroupId?: string | null;
  placementId?: number | null;
  assignmentId?: number | null;
  brandProductId?: number | null;
  metadata?: Record<string, any> | null;
}

export function recordCreatorEvent(input: CreatorEventInput): void {
  // Infer the role rather than making every call site pass it: an actor who
  // isn't the content owner is acting on their behalf.
  const actorRole =
    input.actorRole ??
    (input.actorUserId && String(input.actorUserId) !== String(input.creatorUserId) ? "admin" : "creator");

  void storage
    .insertCreatorEvent({
      creatorUserId: String(input.creatorUserId),
      actorUserId: input.actorUserId ? String(input.actorUserId) : null,
      actorRole,
      eventType: input.eventType,
      videoId: input.videoId ?? null,
      surfaceId: input.surfaceId ?? null,
      surfaceGroupId: input.surfaceGroupId ?? null,
      placementId: input.placementId ?? null,
      assignmentId: input.assignmentId ?? null,
      brandProductId: input.brandProductId ?? null,
      metadata: input.metadata ?? null,
    } as any)
    .catch((err: any) => {
      console.warn(`[CreatorEvents] Failed to record ${input.eventType} (non-fatal): ${err?.message}`);
    });
}

/** Resolve the content owner for a video, for call sites that only hold a
 *  videoId. Returns null when the video is gone — the caller then skips the
 *  event rather than attributing it to the wrong person. */
export async function creatorForVideo(videoId: number): Promise<string | null> {
  try {
    const video = await storage.getVideoById(videoId);
    return video ? String((video as any).userId) : null;
  } catch {
    return null;
  }
}
