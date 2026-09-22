/**
 * Placement offsets are pixels on the editor canvas the creator dragged on, and
 * that canvas is sized to the browser window. The size was never recorded, so
 * every renderer guessed: the Saved Placements export and the clip pipeline
 * assumed 1920×1080, the export route fell back to 640×360. One saved row could
 * land in a different spot depending on which path rendered it.
 *
 * A saved transform now carries canvasWidth/canvasHeight. Rows saved before it
 * don't, and nothing can recover the window they were made in: renderers keep
 * their old assumption for those, and measurement should treat them as unknown.
 */

export interface CanvasDims {
  canvasWidth: number;
  canvasHeight: number;
}

/** Past any real editor canvas. A value beyond it is a bad payload, not a size. */
const MAX_CANVAS_PX = 16384;

const isCanvasPx = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= MAX_CANVAS_PX;

/** The canvas a transform's offsets were authored on, or null when it wasn't recorded. */
export function readCanvasDims(transform: unknown): CanvasDims | null {
  if (!transform || typeof transform !== "object") return null;
  const { canvasWidth, canvasHeight } = transform as { canvasWidth?: unknown; canvasHeight?: unknown };
  return isCanvasPx(canvasWidth) && isCanvasPx(canvasHeight) ? { canvasWidth, canvasHeight } : null;
}

/**
 * The transform as it should be stored: the canvas size kept only when both
 * numbers are usable and removed otherwise, so a bad value never reaches a
 * division in a renderer.
 */
export function sanitizeCanvasDims<T extends object>(transform: T): T {
  const dims = readCanvasDims(transform);
  const rest: Record<string, unknown> = { ...(transform as Record<string, unknown>) };
  delete rest.canvasWidth;
  delete rest.canvasHeight;
  return (dims ? { ...rest, ...dims } : rest) as T;
}

/**
 * Multipliers that turn a transform's offsets into pixels of the rendered frame.
 * `fallback` is the renderer's old assumption, used only for rows that don't say.
 */
export function offsetScale(
  transform: unknown,
  frame: { width: number; height: number },
  fallback: CanvasDims,
): { scaleX: number; scaleY: number; canvasKnown: boolean } {
  const recorded = readCanvasDims(transform);
  const canvas = recorded ?? fallback;
  return {
    scaleX: frame.width / canvas.canvasWidth,
    scaleY: frame.height / canvas.canvasHeight,
    canvasKnown: recorded !== null,
  };
}
