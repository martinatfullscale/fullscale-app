// Shared behaviour for teaching a surface — the drag-to-draw state machine and
// the save.
//
// This lives outside both modals because the two places a creator would want to
// draw a box (reviewing a scan, and placing a product) need identical semantics
// and very different layouts. Duplicating the pointer maths would let them
// drift, and the two most subtle parts — normalizing at RELEASE time so a later
// window resize can't skew the saved box, and the stray-click floor that has to
// match the server's — are exactly the kind of thing that drifts silently.
//
// Presentation stays with each caller. This owns state, coordinates, and IO.

import { useCallback, useRef, useState } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

/** A drawn teach bbox: display px (relative to the frame image's rendered box)
 *  for the overlay + form anchor, plus the 0-1 normalization captured at
 *  release time so a later window resize can't skew what gets saved. */
export interface TeachRect {
  x: number;
  y: number;
  w: number;
  h: number;
  wrapW: number;
  wrapH: number;
  norm: { x: number; y: number; w: number; h: number };
}

/** The scanner's canonical surface vocabulary (scanner_v2 detection prompt) —
 *  what a creator can teach. Values go to the endpoint verbatim. */
export const TEACH_SURFACE_TYPES = [
  "desk", "table", "shelf", "counter", "nightstand", "side_table",
  "coffee_table", "studio_desk", "floor", "rug", "couch", "wall", "door", "window",
] as const;

export const teachTypeLabel = (t: string): string => {
  const spaced = t.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** Same rule as the scanner's inferOrientation: walls/doors/windows are
 *  vertical, everything else is horizontal. */
export const teachOrientationFor = (t: string): "horizontal" | "vertical" =>
  t === "wall" || t === "door" || t === "window" ? "vertical" : "horizontal";

/** A real surface box is at least this fraction of the frame in both
 *  dimensions. Must stay in step with the server's own floor
 *  (server/routes.ts, the teach handler's bboxOk check) — the client draws
 *  first, so a looser client floor produces a 400 the creator can't act on. */
const MIN_BOX_FRACTION = 0.015;

export interface UseTeachSurfaceArgs {
  /**
   * Viewport rect of the area that displays the frame, edge to edge.
   *
   * A provider rather than an element ref because the two callers show the
   * frame differently: the scan-review modal renders an <img>, while the
   * placement editor draws into a <canvas> that is sized to the frame's exact
   * aspect ratio and filled corner to corner. Both hand back a rect whose
   * width and height ARE the frame — anything that letterboxes would have to
   * subtract its bars here, or the normalization silently skews.
   */
  getFrameRect: () => DOMRect | null;
  videoId: number | null | undefined;
  /** Scene class of the displayed frame. Null disables teaching: the endpoint
   *  keys on it and there is nothing sensible to guess. */
  sceneId: number | null;
  /** Seconds into the video for the displayed frame. Sent so the server stamps
   *  the box on the frame it was drawn against rather than a shot midpoint. */
  timestamp: number;
  onTaught?: () => void | Promise<void>;
}

export function useTeachSurface({
  getFrameRect, videoId, sceneId, timestamp, onTaught,
}: UseTeachSurfaceArgs) {
  const { toast } = useToast();
  const [armed, setArmed] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [rect, setRect] = useState<TeachRect | null>(null);
  const [type, setType] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);

  // The save reads state that may change while the request is in flight.
  const savingRef = useRef(false);

  const reset = useCallback(() => {
    setArmed(false);
    setDrag(null);
    setRect(null);
    setType("");
  }, []);

  const frameBox = getFrameRect;

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!armed || rect || isSaving) return;
    const box = frameBox();
    if (!box || box.width <= 0 || box.height <= 0) return;
    e.preventDefault();
    // Pointer capture keeps the drag alive when the cursor leaves the frame.
    e.currentTarget.setPointerCapture(e.pointerId);
    const x = Math.max(0, Math.min(e.clientX - box.left, box.width));
    const y = Math.max(0, Math.min(e.clientY - box.top, box.height));
    setDrag({ x0: x, y0: y, x1: x, y1: y });
  }, [armed, rect, isSaving, frameBox]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const box = frameBox();
    if (!box) return;
    const x = Math.max(0, Math.min(e.clientX - box.left, box.width));
    const y = Math.max(0, Math.min(e.clientY - box.top, box.height));
    setDrag((prev) => (prev ? { ...prev, x1: x, y1: y } : prev));
  }, [drag, frameBox]);

  const onPointerUp = useCallback(() => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    const box = frameBox();
    if (!box || box.width <= 0 || box.height <= 0) return;
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0);
    const h = Math.abs(d.y1 - d.y0);
    // Stray-click guard: anything smaller never opens the form.
    if (w < box.width * MIN_BOX_FRACTION || h < box.height * MIN_BOX_FRACTION) return;
    setRect({
      x, y, w, h,
      wrapW: box.width,
      wrapH: box.height,
      // Normalize now, not at save time: the window can resize between the two.
      norm: {
        x: Math.max(0, Math.min(1, x / box.width)),
        y: Math.max(0, Math.min(1, y / box.height)),
        w: Math.max(0, Math.min(1, w / box.width)),
        h: Math.max(0, Math.min(1, h / box.height)),
      },
    });
  }, [drag, frameBox]);

  const canSave = Boolean(videoId && sceneId != null && rect && type && !isSaving);

  const save = useCallback(async () => {
    if (!videoId || sceneId == null || !rect || !type) return;
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      const res = await fetchWithTimeout(`/api/video/${videoId}/scenes/${sceneId}/teach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          surfaceType: type,
          orientation: teachOrientationFor(type),
          bbox: rect.norm,
          // The frame this box was drawn against. A bbox only means anything
          // relative to a specific frame.
          timestamp,
        }),
      });
      if (!res.ok) {
        let msg = `Teach failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch { /* non-JSON error body — keep the status message */ }
        throw new Error(msg);
      }
      toast({ title: "Taught — this set will track it from now on" });
      reset();
      await onTaught?.();
    } catch (err) {
      toast({
        title: "Couldn't teach surface",
        description: err instanceof Error ? err.message : "Request failed",
        variant: "destructive",
      });
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [videoId, sceneId, rect, type, timestamp, toast, reset, onTaught]);

  return {
    armed, setArmed,
    drag, rect, type, setType,
    isSaving, canSave,
    reset, save,
    onPointerDown, onPointerMove, onPointerUp,
  };
}
