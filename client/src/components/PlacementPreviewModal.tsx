import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Upload,
  Download,
  Save,
  Loader2,
  Image as ImageIcon,
  Target,
  Clock,
  RotateCcw,
  RotateCw,
  Package,
  CheckCircle,
  Move,
  Maximize2,
  FlipHorizontal,
  Sun,
  Droplets,
  Blend,
  Eye,
  EyeOff,
  Play,
  Pause,
  Film,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

// ============================================================================
// TYPES
// ============================================================================

interface CatalogProduct {
  id: number;
  name: string;
  imageUrl: string;
  thumbnailUrl: string | null;
  category: string | null;
  isTransparent: boolean | null;
}

interface Surface {
  id: number;
  timestamp: number;
  surfaceType: string;
  confidence: number;
  frameUrl: string | null;
  boundingBoxX: number;
  boundingBoxY: number;
  boundingBoxWidth: number;
  boundingBoxHeight: number;
  sceneContext?: string | null;
  // Lighting & camera data from Gemini AI for auto-realistic defaults
  lightingDirection?: string | null;  // left, right, top, top-left, top-right, ambient
  lightingIntensity?: number | null;  // 0.0-1.0
  cameraAngle?: string | null;       // eye-level, slightly-above, top-down, low-angle
  // Scene cluster ID — surfaces with same sceneId are in the same physical
  // scene (host shot returns 5x in a podcast). Drives same-scene placement
  // continuity in the JUMP TO row and the placement auto-loader.
  sceneId?: number | null;
  // Per-shot block ID (legacy — pre-perceptual-clustering). Still emitted
  // by the surfaces endpoint for backwards compat with the render filter.
  sceneBlockId?: number | null;
}

interface PlacementPreviewModalProps {
  open: boolean;
  onClose: () => void;
  videoId: number;
  videoTitle: string;
  surfaces: Surface[];
  initialPlacement?: {
    productImageUrl: string;
    productId: number | null;
    transform: PlacementTransform;
    blend: PlacementBlend;
    // Re-edit flow: preserve the creator's prior harmonize choice + URL
    // so the modal opens in the same visual state as last saved.
    isHarmonized?: boolean;
    harmonizedImageUrl?: string | null;
  };
}

// Transform controls for product placement
interface PlacementTransform {
  offsetX: number;     // pixel offset from bounding box center
  offsetY: number;
  scale: number;       // 0.1 - 3.0 multiplier
  rotation: number;    // degrees
  flipH: boolean;      // horizontal flip
}

// Blend/integration settings
interface PlacementBlend {
  opacity: number;          // 0-100
  blendMode: GlobalCompositeOperation;
  shadowEnabled: boolean;
  shadowBlur: number;       // 0-40
  shadowOffsetX: number;    // -20 to 20
  shadowOffsetY: number;    // -20 to 20
  shadowColor: string;
  featherRadius: number;    // 0-20 edge softness
  brightness: number;       // -50 to 50
  contrast: number;         // -50 to 50
}

type DragMode = "none" | "move" | "resize-tl" | "resize-tr" | "resize-bl" | "resize-br" | "rotate";
type ToolPanel = "product" | "transform" | "blend";

const DEFAULT_TRANSFORM: PlacementTransform = {
  offsetX: 0,
  offsetY: 0,
  scale: 0.6,  // Start at 60% for breathing room
  rotation: 0,
  flipH: false,
};

const DEFAULT_BLEND: PlacementBlend = {
  opacity: 90,
  blendMode: "source-over",
  shadowEnabled: true,
  shadowBlur: 8,
  shadowOffsetX: 2,
  shadowOffsetY: 4,
  shadowColor: "rgba(0,0,0,0.4)",
  featherRadius: 0,
  brightness: 0,
  contrast: 0,
};

/**
 * Auto-generate realistic blend defaults based on Gemini's lighting/camera analysis.
 * This makes products look natural in the scene by matching shadow direction to light source
 * and adjusting brightness/contrast to match the scene's lighting conditions.
 */
function getAutoBlendDefaults(surface: Surface): PlacementBlend {
  const blend = { ...DEFAULT_BLEND };

  // Shadow direction from lighting
  if (surface.lightingDirection) {
    blend.shadowEnabled = true;
    const dir = surface.lightingDirection.toLowerCase();

    // Shadow falls opposite to light direction
    const shadowMap: Record<string, { x: number; y: number }> = {
      "left":      { x: 4, y: 3 },     // Light from left → shadow to right
      "right":     { x: -4, y: 3 },     // Light from right → shadow to left
      "top":       { x: 0, y: 5 },      // Light from top → shadow below
      "top-left":  { x: 3, y: 4 },      // Light from top-left → shadow bottom-right
      "top-right": { x: -3, y: 4 },     // Light from top-right → shadow bottom-left
      "ambient":   { x: 1, y: 3 },      // Diffuse → subtle downward shadow
    };

    const shadow = shadowMap[dir] || shadowMap["ambient"];
    blend.shadowOffsetX = shadow.x;
    blend.shadowOffsetY = shadow.y;
  }

  // Shadow sharpness from lighting intensity
  if (surface.lightingIntensity != null) {
    const intensity = surface.lightingIntensity;
    // Bright scenes → sharper shadows (lower blur), dark scenes → softer shadows
    blend.shadowBlur = Math.round(12 - intensity * 8); // Range: 4 (bright) to 12 (dark)
    blend.shadowBlur = Math.max(2, Math.min(20, blend.shadowBlur));

    // Shadow opacity: brighter scene → more defined shadow
    const shadowAlpha = 0.2 + intensity * 0.35; // 0.2 to 0.55
    blend.shadowColor = `rgba(0,0,0,${shadowAlpha.toFixed(2)})`;

    // Brightness adjustment: match product to scene
    if (intensity > 0.7) {
      blend.brightness = 5;  // Slightly brighten product in bright scenes
    } else if (intensity < 0.3) {
      blend.brightness = -10; // Darken product in dim scenes
    }
  }

  return blend;
}

const BLEND_MODES: { value: GlobalCompositeOperation; label: string }[] = [
  { value: "source-over", label: "Normal" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "overlay", label: "Overlay" },
  { value: "soft-light", label: "Soft Light" },
  { value: "hard-light", label: "Hard Light" },
  { value: "color-dodge", label: "Color Dodge" },
  { value: "color-burn", label: "Color Burn" },
  { value: "darken", label: "Darken" },
  { value: "lighten", label: "Lighten" },
  { value: "luminosity", label: "Luminosity" },
];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function clamp(val: number, min: number, max: number) {
  return Math.min(Math.max(val, min), max);
}

/**
 * Global optical flow tracking — estimates camera motion by comparing
 * small blocks distributed across the entire frame between consecutive frames.
 *
 * Why this works better than surface-patch template matching:
 * - Template matching tries to find a specific surface (e.g. marble counter) which
 *   is often uniform/reflective and gets confused by nearby high-contrast objects (laptops).
 * - Optical flow measures HOW MUCH THE WHOLE FRAME MOVED. For camera pans/tilts,
 *   the entire frame shifts together, so the median motion vector across many blocks
 *   gives a very reliable estimate of camera movement.
 *
 * Algorithm:
 * 1. Divide frame into a grid of small blocks (e.g. 6x5 = 30 blocks)
 * 2. For each block, search for its best match in the new frame within a small radius
 * 3. Compute median dx/dy across all blocks (median rejects outliers from occluded areas)
 * 4. Apply that motion to the product position
 */
function computeOpticalFlowBlock(
  prevData: ImageData,
  currData: ImageData,
  width: number,
  height: number,
): { dx: number; dy: number; confidence: number } {
  const prevPx = prevData.data;
  const currPx = currData.data;

  // Grid of blocks for motion estimation
  const gridCols = 6;
  const gridRows = 5;
  const blockW = 24; // pixel size of each comparison block
  const blockH = 24;
  const searchR = 30; // search radius per block (pixels)
  const sampleStep = 3; // sample every 3rd pixel for speed

  const dxValues: number[] = [];
  const dyValues: number[] = [];
  const sadValues: number[] = [];

  for (let gy = 0; gy < gridRows; gy++) {
    for (let gx = 0; gx < gridCols; gx++) {
      // Block center position, distributed evenly across frame
      const cx = Math.floor(((gx + 0.5) / gridCols) * width);
      const cy = Math.floor(((gy + 0.5) / gridRows) * height);

      // Block top-left in previous frame
      const bx0 = cx - Math.floor(blockW / 2);
      const by0 = cy - Math.floor(blockH / 2);
      if (bx0 < 0 || by0 < 0 || bx0 + blockW >= width || by0 + blockH >= height) continue;

      // Search for best match in current frame
      let bestDx = 0, bestDy = 0, bestSAD = Infinity;

      // Coarse pass (step=4)
      for (let sy = -searchR; sy <= searchR; sy += 4) {
        for (let sx = -searchR; sx <= searchR; sx += 4) {
          const tx = bx0 + sx;
          const ty = by0 + sy;
          if (tx < 0 || ty < 0 || tx + blockW >= width || ty + blockH >= height) continue;

          let sad = 0;
          let n = 0;
          for (let py = 0; py < blockH; py += sampleStep) {
            for (let px = 0; px < blockW; px += sampleStep) {
              const pi = ((by0 + py) * width + (bx0 + px)) * 4;
              const ci = ((ty + py) * width + (tx + px)) * 4;
              const pg = (prevPx[pi] + prevPx[pi + 1] + prevPx[pi + 2]);
              const cg = (currPx[ci] + currPx[ci + 1] + currPx[ci + 2]);
              sad += Math.abs(pg - cg);
              n++;
            }
          }
          sad /= n;
          if (sad < bestSAD) { bestSAD = sad; bestDx = sx; bestDy = sy; }
        }
      }

      // Fine pass around coarse best
      const cdx = bestDx, cdy = bestDy;
      for (let sy = cdy - 3; sy <= cdy + 3; sy += 1) {
        for (let sx = cdx - 3; sx <= cdx + 3; sx += 1) {
          const tx = bx0 + sx;
          const ty = by0 + sy;
          if (tx < 0 || ty < 0 || tx + blockW >= width || ty + blockH >= height) continue;

          let sad = 0;
          let n = 0;
          for (let py = 0; py < blockH; py += sampleStep) {
            for (let px = 0; px < blockW; px += sampleStep) {
              const pi = ((by0 + py) * width + (bx0 + px)) * 4;
              const ci = ((ty + py) * width + (tx + px)) * 4;
              const pg = (prevPx[pi] + prevPx[pi + 1] + prevPx[pi + 2]);
              const cg = (currPx[ci] + currPx[ci + 1] + currPx[ci + 2]);
              sad += Math.abs(pg - cg);
              n++;
            }
          }
          sad /= n;
          if (sad < bestSAD) { bestSAD = sad; bestDx = sx; bestDy = sy; }
        }
      }

      dxValues.push(bestDx);
      dyValues.push(bestDy);
      sadValues.push(bestSAD);
    }
  }

  if (dxValues.length === 0) return { dx: 0, dy: 0, confidence: 0 };

  // Use median to reject outliers (e.g. occluded blocks, moving objects)
  dxValues.sort((a, b) => a - b);
  dyValues.sort((a, b) => a - b);
  sadValues.sort((a, b) => a - b);
  const mid = Math.floor(dxValues.length / 2);
  const medianDx = dxValues[mid];
  const medianDy = dyValues[mid];
  const medianSAD = sadValues[mid];

  // Confidence based on SAD and agreement between blocks
  const confidence = Math.max(0, Math.min(1, 1 - medianSAD / 200));

  return { dx: medianDx, dy: medianDy, confidence };
}

/**
 * Capture the full frame as ImageData for optical flow comparison.
 * Downscales to a fixed size for consistent and fast processing.
 */
function captureFrameForFlow(
  videoEl: HTMLVideoElement,
  flowCanvas: HTMLCanvasElement,
  flowW: number,
  flowH: number,
): ImageData | null {
  try {
    flowCanvas.width = flowW;
    flowCanvas.height = flowH;
    const ctx = flowCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(videoEl, 0, 0, flowW, flowH);
    return ctx.getImageData(0, 0, flowW, flowH);
  } catch {
    return null;
  }
}

/** Resolve video file path from DB into a usable URL */
function resolveVideoSrc(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  let src = filePath;
  src = src.replace(/^\.\/public\//, '/');
  src = src.replace(/^public\//, '/');
  src = src.replace(/^\/home\/runner\/workspace\/public\//, '/');
  src = src.replace(/\/\//g, '/');
  if (!src.startsWith('/') && !src.startsWith('http')) {
    src = '/' + src;
  }
  return src;
}

/** Apply brightness/contrast filter string for canvas */
function getFilterString(blend: PlacementBlend): string {
  const parts: string[] = [];
  if (blend.brightness !== 0) {
    parts.push(`brightness(${100 + blend.brightness}%)`);
  }
  if (blend.contrast !== 0) {
    parts.push(`contrast(${100 + blend.contrast}%)`);
  }
  return parts.length > 0 ? parts.join(" ") : "none";
}

// ============================================================================
// HARMONIZE PROGRESS ESTIMATION
// ============================================================================
//
// The harmonize endpoint returns a single response when the entire pipeline
// finishes — no SSE/streaming. We drive a determinate progress bar from
// elapsed time vs an expected duration per mode, capping at 95% so we
// never falsely claim completion. Stage labels rotate at expected
// milestones so the user has a sense of what the server is currently
// doing. If a run overshoots its expected duration, the bar crawls
// 90→95 over the next half-duration instead of getting stuck at the cap.
//
// Tuned to typical observed durations from server logs:
//   auto  (procedural):       ~12s  (bg removal → composite → lock → upload)
//   ai-3d (TRELLIS/IC-Light):  ~60s  (bg → depth → lighting → 3D composite → lock → upload)
type HarmonizeMode = "auto" | "ai-3d";

const HARMONIZE_STAGE_PLAN: Record<HarmonizeMode, { expectedMs: number; stages: Array<{ untilT: number; label: string }> }> = {
  auto: {
    expectedMs: 12_000,
    stages: [
      { untilT: 0.20, label: "Removing background" },
      { untilT: 0.70, label: "Compositing into scene" },
      { untilT: 0.90, label: "Locking product detail" },
      { untilT: 1.00, label: "Finalizing" },
    ],
  },
  "ai-3d": {
    expectedMs: 60_000,
    stages: [
      { untilT: 0.08, label: "Removing background" },
      { untilT: 0.25, label: "Analyzing scene depth" },
      { untilT: 0.40, label: "Analyzing scene lighting" },
      { untilT: 0.85, label: "Compositing 3D-aware render" },
      { untilT: 0.95, label: "Locking product detail" },
      { untilT: 1.00, label: "Finalizing" },
    ],
  },
};

function computeHarmonizeProgress(mode: HarmonizeMode | null, elapsedMs: number, doneAt100: boolean): {
  percent: number;
  label: string;
  isOvertime: boolean;
} {
  if (doneAt100) return { percent: 100, label: "Done", isOvertime: false };
  if (!mode) return { percent: 0, label: "", isOvertime: false };
  const plan = HARMONIZE_STAGE_PLAN[mode];
  const t = elapsedMs / plan.expectedMs;
  const isOvertime = t >= 1.0;
  // 0 → 90 over expected duration, then crawl 90 → 95 over the next
  // half-duration. Cap at 95 so we never preempt the real "done".
  let percent: number;
  if (t < 1.0) {
    percent = Math.max(2, Math.min(90, t * 90));
  } else {
    const overshoot = Math.min(1.0, (t - 1.0) / 0.5); // 0→1 over the next 0.5× expected
    percent = 90 + overshoot * 5;
  }
  // Find current stage label
  const tClamped = Math.min(0.999, t);
  const stage = plan.stages.find((s) => tClamped < s.untilT) || plan.stages[plan.stages.length - 1];
  const label = isOvertime ? `${stage.label} (taking longer than usual)` : stage.label;
  return { percent, label, isOvertime };
}

// ============================================================================
// HARMONIZE HISTORY — RECENT RUNS PERSISTED LOCALLY
// ============================================================================
//
// Keeps a short rolling log of successful harmonize runs in localStorage so
// the user can re-apply a previous result without paying the 12-60s server
// roundtrip again. Cap is HARMONIZE_HISTORY_LIMIT entries — newest first,
// FIFO trim. Failures are not logged (they have nothing to reuse).
//
// We store the full URL set + transform + bbox so reuse is a pure client
// op: set state, no network call. If the result URL has been GC'd from the
// bucket (signed-URL expiry, manual cleanup), the <img> just fails to
// load — the entry still functions as a transform-only recall via the
// "Reuse settings" path.
interface HarmonizeHistoryEntry {
  id: string;
  timestamp: number;
  mode: HarmonizeMode;
  surfaceId: number;
  productImageUrl: string;
  resultImageUrl: string;
  flatCompositeUrl: string | null;
  bbox: { x: number; y: number; width: number; height: number };
  transform: { scale: number; offsetX: number; offsetY: number; rotation: number; flipH: boolean };
  elapsedMs: number;
  // Coarse fingerprint of the source video / image being placed onto.
  // Used to badge "same scene" entries without requiring an exact match.
  videoFingerprint: string | null;
}

const HARMONIZE_HISTORY_KEY = "harmonize-history-v1";
const HARMONIZE_HISTORY_LIMIT = 20;

function loadHarmonizeHistory(): HarmonizeHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HARMONIZE_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: any) =>
        e &&
        typeof e.id === "string" &&
        typeof e.timestamp === "number" &&
        typeof e.resultImageUrl === "string",
    );
  } catch {
    return [];
  }
}

function saveHarmonizeHistory(entries: HarmonizeHistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      HARMONIZE_HISTORY_KEY,
      JSON.stringify(entries.slice(0, HARMONIZE_HISTORY_LIMIT)),
    );
  } catch {
    // localStorage full or disabled — silent failure, history is non-critical
  }
}

function appendHarmonizeHistory(entry: HarmonizeHistoryEntry): HarmonizeHistoryEntry[] {
  const existing = loadHarmonizeHistory();
  // Dedupe: if the same surface+product+mode just ran, replace the prior
  // entry instead of stacking — keeps the log focused on "what I've
  // tried" rather than "every time I clicked the button."
  const filtered = existing.filter(
    (e) =>
      !(
        e.surfaceId === entry.surfaceId &&
        e.productImageUrl === entry.productImageUrl &&
        e.mode === entry.mode &&
        Date.now() - e.timestamp < 60_000
      ),
  );
  const next = [entry, ...filtered].slice(0, HARMONIZE_HISTORY_LIMIT);
  saveHarmonizeHistory(next);
  return next;
}

function clearHarmonizeHistory(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(HARMONIZE_HISTORY_KEY);
  } catch {}
}

// Short stable fingerprint of a video/image source URL for the "same
// scene" badge. Hash isn't cryptographic — just needs to be consistent
// across reloads for the same src.
function fingerprintVideoSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  let h = 0;
  for (let i = 0; i < src.length; i++) {
    h = (h * 31 + src.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function formatHistoryTimestamp(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ============================================================================
// COMPUTE ASPECT-CORRECT PLACEMENT BBOX (CLIENT → SERVER)
// ============================================================================
//
// Single source of truth for "what bbox do we send to a server endpoint
// that composites the product into a scene frame." Every harmonize /
// composite endpoint MUST use this — do not roll your own normalized-
// aspect math.
//
// Why this exists: surface bboxes are stored normalized 0-1 against
// DIFFERENT axes (W against frame width, H against frame height). On a
// non-square frame the ratio surfaceW/surfaceH is NOT visual aspect.
// Naive "drawW = surfaceH * prodAspect" math collapses the product
// width by frameW/frameH (e.g. 0.5625× on 9:16 → bottle reads as
// skinny). Server-side compositors use sharp's fit:"fill" deliberately
// (see harmonization.ts:443), so they stretch to whatever bbox the
// client sends — meaning aspect drift here translates 1:1 to a
// squished/stretched product in the output.
//
// This helper:
//   1. Converts surface dims to canvas pixels first → real visual aspect
//   2. Aspect-fits the product into the surface bbox (preserves prodAspect)
//   3. Applies user transform (scale, offset)
//   4. Safety-clamps the final normalized bbox so its visual aspect on
//      the actual scene frame matches the product's natural aspect
//      within 5% — guards against canvas vs frame dim drift
//
// Works for any combination of:
//   - product aspect (tall, wide, square, ultra-thin)
//   - frame aspect (9:16, 16:9, 1:1, 4:5, etc.)
//   - canvas size, surface dims, user transform
//
// Returns null if inputs are insufficient (image not loaded, zero dims).
function computeAspectCorrectPlacementBbox(args: {
  surface: {
    boundingBoxX: number;
    boundingBoxY: number;
    boundingBoxWidth: number;
    boundingBoxHeight: number;
  };
  productImg: HTMLImageElement | null;
  canvas: HTMLCanvasElement | null;
  frameSource: { width: number; height: number };
  transform: { scale: number; offsetX: number; offsetY: number };
  logTag?: string;
}): { x: number; y: number; width: number; height: number } | null {
  const { surface, productImg, canvas, frameSource, transform } = args;
  const logTag = args.logTag || "PlacementBbox";
  if (!productImg || !canvas) return null;
  if (!productImg.naturalWidth || !productImg.naturalHeight) return null;
  if (!canvas.width || !canvas.height) return null;
  const surfaceW = surface.boundingBoxWidth;
  const surfaceH = surface.boundingBoxHeight;
  if (surfaceW <= 0 || surfaceH <= 0) return null;

  const prodAspect = productImg.naturalWidth / productImg.naturalHeight;
  const surfaceVisualW = surfaceW * canvas.width;
  const surfaceVisualH = surfaceH * canvas.height;
  const surfaceVisualAspect = surfaceVisualW / surfaceVisualH;

  // Aspect-fit product into surface bbox in pixel space, then convert
  // back to normalized for the wire format.
  let visualDrawW: number, visualDrawH: number;
  if (prodAspect > surfaceVisualAspect) {
    visualDrawW = surfaceVisualW * transform.scale;
    visualDrawH = (surfaceVisualW / prodAspect) * transform.scale;
  } else {
    visualDrawH = surfaceVisualH * transform.scale;
    visualDrawW = (surfaceVisualH * prodAspect) * transform.scale;
  }
  let drawW = visualDrawW / canvas.width;
  let drawH = visualDrawH / canvas.height;

  // Safety clamp — re-derive width if visual aspect on the actual
  // scene frame has drifted >5% from the product's natural aspect.
  // If frame source dims are unknown, canvas IS the frame, so no drift.
  const frameW = frameSource.width || canvas.width;
  const frameH = frameSource.height || canvas.height;
  const visualAspectOnFrame = (drawW * frameW) / Math.max(1, drawH * frameH);
  const aspectDriftRatio = visualAspectOnFrame / prodAspect;
  if (frameW > 0 && frameH > 0 && (aspectDriftRatio < 0.95 || aspectDriftRatio > 1.05)) {
    const correctedDrawW = (drawH * frameH * prodAspect) / frameW;
    console.log(
      `[${logTag}] ⚠️  ASPECT DRIFT: visual=${visualAspectOnFrame.toFixed(3)} natural=${prodAspect.toFixed(3)} drift=${((aspectDriftRatio - 1) * 100).toFixed(1)}% → drawW ${drawW.toFixed(4)} → ${correctedDrawW.toFixed(4)}`,
    );
    drawW = correctedDrawW;
  }
  console.log(
    `[${logTag}] prodPNG ${productImg.naturalWidth}x${productImg.naturalHeight} (aspect ${prodAspect.toFixed(3)}) | canvas ${canvas.width}x${canvas.height} | frame ${frameW}x${frameH} | surface bbox ${surfaceW.toFixed(3)}x${surfaceH.toFixed(3)} | drawn bbox ${drawW.toFixed(4)}x${drawH.toFixed(4)} → frame px ${Math.round(drawW * frameW)}x${Math.round(drawH * frameH)} (visual aspect ${((drawW * frameW) / (drawH * frameH)).toFixed(3)})`,
  );

  const offsetXNorm = transform.offsetX / Math.max(1, canvas.width);
  const offsetYNorm = transform.offsetY / Math.max(1, canvas.height);
  const centerXNorm = surface.boundingBoxX + surfaceW / 2 + offsetXNorm;
  const centerYNorm = surface.boundingBoxY + surfaceH / 2 + offsetYNorm;

  // Two-sided clamp so the product cannot extend off the right/bottom
  // edge of the frame. Previously we only clamped the top-left to [0,1]
  // which let the bbox extend past the right/bottom edge (the "bottle
  // clipped at the left of the frame" bug — user dragged toward the
  // edge and we sent a bbox the server couldn't fully render).
  const finalW = Math.max(0.01, Math.min(1, drawW));
  const finalH = Math.max(0.01, Math.min(1, drawH));
  const finalX = Math.max(0, Math.min(1 - finalW, centerXNorm - finalW / 2));
  const finalY = Math.max(0, Math.min(1 - finalH, centerYNorm - finalH / 2));
  return { x: finalX, y: finalY, width: finalW, height: finalH };
}

// ============================================================================
// DRAW PRODUCT WITH FULL TRANSFORM + BLEND
// ============================================================================

function drawProduct(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  px: number, py: number, pw: number, ph: number,
  transform: PlacementTransform,
  blend: PlacementBlend,
) {
  const prodAspect = img.naturalWidth / img.naturalHeight;
  const boxAspect = pw / ph;

  let drawWidth: number, drawHeight: number;
  if (prodAspect > boxAspect) {
    drawWidth = pw * transform.scale;
    drawHeight = (pw / prodAspect) * transform.scale;
  } else {
    drawHeight = ph * transform.scale;
    drawWidth = (ph * prodAspect) * transform.scale;
  }

  // Center within bounding box + offset
  const centerX = px + pw / 2 + transform.offsetX;
  const centerY = py + ph / 2 + transform.offsetY;

  ctx.save();

  // Blend mode
  ctx.globalCompositeOperation = blend.blendMode;
  ctx.globalAlpha = blend.opacity / 100;

  // Canvas filter for brightness/contrast
  const filter = getFilterString(blend);
  if (filter !== "none") {
    ctx.filter = filter;
  }

  // Shadow
  if (blend.shadowEnabled) {
    ctx.shadowBlur = blend.shadowBlur;
    ctx.shadowColor = blend.shadowColor;
    ctx.shadowOffsetX = blend.shadowOffsetX;
    ctx.shadowOffsetY = blend.shadowOffsetY;
  }

  // Transform: translate to center, rotate, flip, then draw centered
  ctx.translate(centerX, centerY);
  ctx.rotate((transform.rotation * Math.PI) / 180);
  if (transform.flipH) ctx.scale(-1, 1);

  // Edge feathering via multi-draw with decreasing alpha at edges
  if (blend.featherRadius > 0) {
    const feather = blend.featherRadius;
    const hw = drawWidth / 2;
    const hh = drawHeight / 2;
    const steps = Math.min(feather, 8);
    const baseAlpha = ctx.globalAlpha;
    for (let i = steps; i >= 0; i--) {
      const t = i / steps;
      const inset = feather * t;
      ctx.globalAlpha = baseAlpha * (1 - t * 0.7);
      ctx.drawImage(
        img,
        -hw - inset, -hh - inset,
        drawWidth + inset * 2, drawHeight + inset * 2
      );
    }
    ctx.globalAlpha = baseAlpha;
    ctx.drawImage(img, -hw, -hh, drawWidth, drawHeight);
  } else {
    ctx.drawImage(img, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  }

  ctx.restore();
}

// Draw product for export (full resolution)
function drawProductExport(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  px: number, py: number, pw: number, ph: number,
  transform: PlacementTransform,
  blend: PlacementBlend,
  scaleRatio: number,
) {
  const prodAspect = img.naturalWidth / img.naturalHeight;
  const boxAspect = pw / ph;

  let drawWidth: number, drawHeight: number;
  if (prodAspect > boxAspect) {
    drawWidth = pw * transform.scale;
    drawHeight = (pw / prodAspect) * transform.scale;
  } else {
    drawHeight = ph * transform.scale;
    drawWidth = (ph * prodAspect) * transform.scale;
  }

  const centerX = px + pw / 2 + transform.offsetX * scaleRatio;
  const centerY = py + ph / 2 + transform.offsetY * scaleRatio;

  ctx.save();
  ctx.globalCompositeOperation = blend.blendMode;
  ctx.globalAlpha = blend.opacity / 100;

  const filter = getFilterString(blend);
  if (filter !== "none") ctx.filter = filter;

  if (blend.shadowEnabled) {
    ctx.shadowBlur = blend.shadowBlur * scaleRatio;
    ctx.shadowColor = blend.shadowColor;
    ctx.shadowOffsetX = blend.shadowOffsetX * scaleRatio;
    ctx.shadowOffsetY = blend.shadowOffsetY * scaleRatio;
  }

  ctx.translate(centerX, centerY);
  ctx.rotate((transform.rotation * Math.PI) / 180);
  if (transform.flipH) ctx.scale(-1, 1);

  ctx.drawImage(img, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function PlacementPreviewModal({
  open,
  onClose,
  videoId,
  videoTitle,
  surfaces,
  initialPlacement,
}: PlacementPreviewModalProps) {
  // Core state
  const [selectedSurface, setSelectedSurface] = useState<Surface | null>(null);
  const [productImage, setProductImage] = useState<string | null>(null);
  const [productFile, setProductFile] = useState<File | null>(null);
  const [productTab, setProductTab] = useState<"upload" | "catalog">("upload");
  const [selectedCatalogProduct, setSelectedCatalogProduct] = useState<CatalogProduct | null>(null);
  const [toolPanel, setToolPanel] = useState<ToolPanel>("product");

  // Interactive transform + blend state
  const [transform, setTransform] = useState<PlacementTransform>({ ...DEFAULT_TRANSFORM });
  const [blend, setBlend] = useState<PlacementBlend>({ ...DEFAULT_BLEND });
  const [showBoundingBox, setShowBoundingBox] = useState(true);

  // Frame-by-frame keyframes for fine-grained placement editing. When the
  // creator wants to pin the product to specific moments where motion
  // tracking drifts, they capture the current transform at the current
  // playback time. Render-time interpolation lerps between adjacent
  // keyframes so the product moves smoothly across edits.
  type Keyframe = { t: number; transform: PlacementTransform };
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);

  // Compute the effective transform at a given playback time. Returns the
  // base transform when no keyframes, the keyframe value at exact match,
  // or a linear interpolation between bracketing keyframes. Past the last
  // keyframe, holds at the last value (no extrapolation — extrapolating
  // a rotation can yield wildly off-screen products).
  const effectiveTransformAt = useCallback((t: number): PlacementTransform => {
    if (keyframes.length === 0) return transform;
    if (keyframes.length === 1) return keyframes[0].transform;
    // Sorted by t (server validates this; assume sorted on load).
    if (t <= keyframes[0].t) return keyframes[0].transform;
    if (t >= keyframes[keyframes.length - 1].t) return keyframes[keyframes.length - 1].transform;
    // Find bracketing pair.
    for (let i = 0; i < keyframes.length - 1; i++) {
      const a = keyframes[i];
      const b = keyframes[i + 1];
      if (t >= a.t && t <= b.t) {
        const span = b.t - a.t;
        const u = span > 0 ? (t - a.t) / span : 0;
        return {
          offsetX: a.transform.offsetX + (b.transform.offsetX - a.transform.offsetX) * u,
          offsetY: a.transform.offsetY + (b.transform.offsetY - a.transform.offsetY) * u,
          scale: a.transform.scale + (b.transform.scale - a.transform.scale) * u,
          rotation: a.transform.rotation + (b.transform.rotation - a.transform.rotation) * u,
          // Boolean can't lerp — snap at midpoint.
          flipH: u < 0.5 ? a.transform.flipH : b.transform.flipH,
        };
      }
    }
    return transform;
  }, [keyframes, transform]);

  // Drag interaction state
  const [dragMode, setDragMode] = useState<DragMode>("none");
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragStartTransform, setDragStartTransform] = useState<PlacementTransform>(DEFAULT_TRANSFORM);

  // Save state
  const [isSaving, setIsSaving] = useState(false);
  // Placement scope — canonical surfaceGroupIds this placement applies to.
  // Initialized to just the anchor's group whenever the anchor's identity
  // changes; the strip's checkboxes add/remove other canonical surfaces.
  // Surfaces without a groupId (legacy scans) can't be scoped — when the
  // ANCHOR lacks one the save omits the field entirely (legacy behavior).
  const [scopeGroupIds, setScopeGroupIds] = useState<Set<string>>(new Set());
  const [saveSuccess, setSaveSuccess] = useState(false);
  const { toast } = useToast();

  // Video playback state
  const [isVideoMode, setIsVideoMode] = useState(false);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Pre-computed motion tracking data from server (Gemini keyframes or static fallback)
  // When available, this gives smooth camera-locked placement
  const [motionData, setMotionData] = useState<{
    transforms: Array<{ x: number; y: number; w: number; h: number } | null>;
    fps: number;
    duration: number;
    available: boolean;
    source?: string; // "gemini-keyframes" | "static" | undefined
  } | null>(null);
  const [isMotionLoading, setIsMotionLoading] = useState(false);

  // Video export state
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportJobId, setExportJobId] = useState<number | null>(null);
  const [exportOutputUrl, setExportOutputUrl] = useState<string | null>(null);

  // Harmonization preview state — shows a before/after dialog comparing
  // the flat product overlay (current canvas behavior) with the procedurally
  // harmonized version (server-side, scene-preserving via sharp).
  const [showHarmonizeCompare, setShowHarmonizeCompare] = useState(false);
  const [isHarmonizing, setIsHarmonizing] = useState(false);
  const [harmonizeError, setHarmonizeError] = useState<string | null>(null);
  const [harmonizeFlatUrl, setHarmonizeFlatUrl] = useState<string | null>(null);
  const [harmonizeResultUrl, setHarmonizeResultUrl] = useState<string | null>(null);
  // Progress tracking — the server endpoint isn't streamed so we drive a
  // determinate bar from elapsed time vs expected duration. Caps at 95%
  // so we never falsely claim "done"; snaps to 100% on completion.
  // Stage labels rotate at expected milestones so the user sees what
  // the server is roughly doing right now.
  const [harmonizeMode, setHarmonizeMode] = useState<"auto" | "ai-3d" | null>(null);
  const [harmonizeStartedAt, setHarmonizeStartedAt] = useState<number | null>(null);
  const [harmonizeElapsedMs, setHarmonizeElapsedMs] = useState(0);
  const [harmonizeDoneAt100, setHarmonizeDoneAt100] = useState(false);
  // Rolling history of recent successful harmonize runs (localStorage-backed).
  // Lets the user re-apply a previous result without re-running the server.
  const [harmonizeHistory, setHarmonizeHistory] = useState<HarmonizeHistoryEntry[]>([]);
  useEffect(() => {
    setHarmonizeHistory(loadHarmonizeHistory());
  }, []);

  // Manual harmonize state — user explicitly clicks the Harmonize button
  // (no auto-fire). Server preserves the user's exact placement+scale
  // because we send the post-transform bbox derived from canvas state,
  // not the raw surface bbox.
  const [harmonizeEnabled, setHarmonizeEnabled] = useState(false);
  const [liveHarmonizedUrl, setLiveHarmonizedUrl] = useState<string | null>(null);
  // Track whether the user is actively dragging — we hide the harmonized
  // overlay during interaction so they can manipulate the canvas freely.
  const [isInteractingWithCanvas, setIsInteractingWithCanvas] = useState(false);
  // Track whether the cursor is hovering over the canvas. When harmonized,
  // we fade the overlay to ~25% on hover so the user can see the bbox
  // handles to grab and adjust position/scale. Without this, the opaque
  // overlay covers the handles and creators can't tell where to click.
  const [isHoveringCanvas, setIsHoveringCanvas] = useState(false);

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const frameImgRef = useRef<HTMLImageElement | null>(null);
  const productImgRef = useRef<HTMLImageElement | null>(null);
  const animFrameRef = useRef<number>(0);
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  // Client-side camera tracking state — uses global optical flow to follow camera pans
  // This measures how the ENTIRE frame shifts between consecutive video frames,
  // then applies that motion to keep the product anchored to the physical surface.
  const FLOW_W = 320; // downscaled resolution for optical flow
  const FLOW_H = 180;
  const trackingRef = useRef<{
    // Previous frame's pixel data for optical flow comparison
    prevFrameData: ImageData | null;
    // Accumulated camera offset in canvas pixel coordinates
    cumulativeOffsetX: number;
    cumulativeOffsetY: number;
    // Smoothed display position (what's actually rendered)
    displayOffsetX: number;
    displayOffsetY: number;
    // Smoothed display dimensions (prevents size jitter)
    displayOffsetW: number;
    displayOffsetH: number;
    // Velocity for spring-damped interpolation
    velocityX: number;
    velocityY: number;
    // Off-screen canvas for frame capture
    flowCanvas: HTMLCanvasElement;
    initialized: boolean;
    frameCounter: number;
  }>({
    prevFrameData: null,
    cumulativeOffsetX: 0,
    cumulativeOffsetY: 0,
    displayOffsetX: 0,
    displayOffsetY: 0,
    displayOffsetW: 0,
    displayOffsetH: 0,
    velocityX: 0,
    velocityY: 0,
    flowCanvas: typeof document !== "undefined" ? document.createElement("canvas") : null as any,
    initialized: false,
    frameCounter: 0,
  });

  // Smooths the product visibility transition when playback crosses
  // scene boundaries. Without this the product hard-pops in/out on every
  // cut, which the user described as "looks like it's being dropped in
  // each time". 200ms ease-out feels natural — long enough to read as
  // intentional, short enough to not lag the playback experience.
  const sceneTransitionRef = useRef<{
    targetOpacity: number;     // 1 if currently in scene, 0 if not
    currentOpacity: number;    // animated value, eases toward target
    lastFrameTime: number;     // for delta-time integration
  }>({
    targetOpacity: 1,
    currentOpacity: 1,
    lastFrameTime: 0,
  });

  // Fetch video details to get file path for playback + scene-cut boundaries
  // + perceptual scene index (which clusters shots that revisit the same
  // physical scene into a single sceneId).
  const { data: videoDetails } = useQuery<{
    filePath: string | null;
    sceneBoundaries?: number[] | null;
    sceneIndex?: { shots: Array<{ shotIdx: number; sceneId: number; tStart: number; tEnd: number }> } | null;
  }>({
    queryKey: [`/api/video/${videoId}/details`],
    queryFn: async () => {
      const res = await fetch(`/api/video/${videoId}/details`);
      if (!res.ok) return { filePath: null };
      return res.json();
    },
    enabled: open,
  });
  const videoSrc = resolveVideoSrc(videoDetails?.filePath);
  // Scene-cut timestamps for this video (in seconds). Used to hide the
  // placement when playback enters a different shot than the one the
  // surface was detected in. Empty/undefined → single shot, no filtering.
  const sceneBoundaries: number[] = Array.isArray(videoDetails?.sceneBoundaries)
    ? (videoDetails!.sceneBoundaries as number[]).filter(t => typeof t === "number" && Number.isFinite(t))
    : [];

  // Same scene-block math as the server side so client + server agree on
  // which shot a given timestamp belongs to.
  const sceneBlockFor = useCallback((t: number): number => {
    if (sceneBoundaries.length === 0 || t < 0) return 0;
    for (let i = 0; i < sceneBoundaries.length; i++) {
      if (t < sceneBoundaries[i]) return i;
    }
    return sceneBoundaries.length;
  }, [sceneBoundaries]);

  // Perceptual scene cluster lookup — same physical set across cuts gets
  // the same sceneId. Used so a placement on the host's coffee table at
  // :08 keeps rendering when the camera returns to the same set at :46
  // (different shot block, but same sceneId).
  const sceneIdFor = useCallback((t: number): number | null => {
    const shots = videoDetails?.sceneIndex?.shots;
    if (!Array.isArray(shots) || shots.length === 0) return null;
    for (const shot of shots) {
      if (t >= shot.tStart && t < shot.tEnd) return shot.sceneId;
    }
    return shots[shots.length - 1].sceneId;
  }, [videoDetails?.sceneIndex]);

  // The placement is bound to the surface's scene. Prefer the perceptual
  // sceneId (carries across same-scene shot returns); fall back to per-shot
  // sceneBlock for videos scanned before the scene index existed.
  const placementBlockId = selectedSurface
    ? sceneBlockFor(parseFloat(String((selectedSurface as any).timestamp ?? 0)) || 0)
    : 0;
  const placementSceneId = selectedSurface
    ? (typeof (selectedSurface as any).sceneId === "number"
        ? (selectedSurface as any).sceneId
        : sceneIdFor(parseFloat(String((selectedSurface as any).timestamp ?? 0)) || 0))
    : null;

  // Fetch dense surface keyframes for accurate motion tracking
  const { data: denseKeyframesData, refetch: refetchKeyframes } = useQuery<{
    keyframes: Record<string, Array<{
      timestamp: number;
      bbox: { x: number; y: number; w: number; h: number };
      confidence: number;
      surfaceId: number;
    }>>;
  }>({
    queryKey: [`/api/video/${videoId}/surface-keyframes`],
    queryFn: async () => {
      const res = await fetch(`/api/video/${videoId}/surface-keyframes`);
      if (!res.ok) return { keyframes: {} };
      return res.json();
    },
    enabled: open,
  });

  // Dense scan state — triggers Gemini per-frame tracking when user plays video
  const [isDenseScanning, setIsDenseScanning] = useState(false);
  const [denseScanDone, setDenseScanDone] = useState(false);

  // Trigger server-side motion analysis for smooth product placement
  // (must be defined before triggerDenseScan which calls it)
  // `force` parameter allows re-triggering after dense scan completes to get real Gemini data
  const triggerMotionTrack = useCallback(async (force = false) => {
    if (isMotionLoading) return; // Already loading
    // Skip if we already have real (non-static) data, unless forced
    if (!force && motionData && motionData.source !== "static") return;
    if (!selectedSurface) return;

    setIsMotionLoading(true);
    try {
      console.log(`[PlacementPreview] Requesting motion tracking for video ${videoId}, surface ${selectedSurface.id}${force ? " (forced re-fetch)" : ""}...`);
      const res = await fetch(`/api/video/${videoId}/motion-track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ surfaceId: selectedSurface.id }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.available && data.transforms?.length > 0) {
          setMotionData({ ...data, source: data.source || "unknown" });
          console.log(`[PlacementPreview] Got ${data.transforms.length} motion frames at ${data.fps}fps (source: ${data.source})`);
          // If we got real Gemini keyframe data, reset tracking so spring snaps to new data
          if (data.source === "gemini-keyframes") {
            const tracking = trackingRef.current;
            tracking.initialized = false;
          }
        } else {
          console.log("[PlacementPreview] Motion tracking not available, using client-side fallback");
          setMotionData({ transforms: [], fps: 30, duration: 0, available: false, source: "none" });
        }
      }
    } catch (err) {
      console.error("[PlacementPreview] Motion track request failed:", err);
      setMotionData({ transforms: [], fps: 30, duration: 0, available: false, source: "none" });
    } finally {
      setIsMotionLoading(false);
    }
  }, [videoId, isMotionLoading, motionData, selectedSurface]);

  // Trigger dense scan when user first enters video playback mode.
  // Two-phase approach for fast results:
  //   Phase 1: Quick scan at 2-second intervals (~13 Gemini calls for 25s video ≈ 1 min)
  //            → gives sparse but usable keyframes for Catmull-Rom interpolation
  //   Phase 2: Dense scan at 0.5-second intervals (runs in background after Phase 1)
  //            → refines tracking accuracy with 4x more keyframes
  const triggerDenseScan = useCallback(async () => {
    if (isDenseScanning || denseScanDone) return;

    // Check if we already have enough keyframes for the selected surface
    const surfaceType = selectedSurface?.surfaceType;
    const existingKfs = surfaceType ? denseKeyframesData?.keyframes?.[surfaceType] : null;
    if (existingKfs && existingKfs.length >= 10) {
      setDenseScanDone(true);
      // Already have good data — just make sure motion track uses it
      triggerMotionTrack(true);
      return;
    }

    setIsDenseScanning(true);
    try {
      // ── Phase 1: Quick sparse scan (interval=2s) ──
      // Gets ~13 keyframes in ~1 minute → enough for spline interpolation
      console.log(`[PlacementPreview] Phase 1: Quick scan for video ${videoId} (interval=2s)...`);
      const quickRes = await fetch(`/api/video/${videoId}/dense-scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ interval: 2.0 }),
      });
      if (quickRes.ok) {
        const quickData = await quickRes.json();
        console.log(`[PlacementPreview] Phase 1 result:`, quickData);
        await refetchKeyframes();
        // Immediately trigger motion track with sparse keyframes — gives anchored tracking fast
        triggerMotionTrack(true);
      }

      // ── Phase 2: Dense refine scan (interval=0.5s, fire-and-forget) ──
      // Runs in background to improve tracking accuracy with 4x more keyframes
      console.log(`[PlacementPreview] Phase 2: Dense scan for video ${videoId} (interval=0.5s)...`);
      const denseRes = await fetch(`/api/video/${videoId}/dense-scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ interval: 0.5 }),
      });
      if (denseRes.ok) {
        const denseData = await denseRes.json();
        console.log(`[PlacementPreview] Phase 2 result:`, denseData);
        await refetchKeyframes();
        // Re-trigger motion track with full dense keyframes for maximum accuracy
        triggerMotionTrack(true);
      }

      setDenseScanDone(true);
    } catch (err) {
      console.error("[PlacementPreview] Dense scan failed:", err);
    } finally {
      setIsDenseScanning(false);
    }
  }, [videoId, isDenseScanning, denseScanDone, selectedSurface?.surfaceType, denseKeyframesData, refetchKeyframes, triggerMotionTrack]);

  // Fetch product catalog
  const { data: catalogProducts } = useQuery<CatalogProduct[]>({
    queryKey: ["/api/brand-products/catalog"],
    queryFn: async () => {
      const res = await fetch("/api/brand-products/catalog");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open,
  });

  // Auto-select first surface with a frame and set auto-blend defaults
  useEffect(() => {
    if (open && surfaces.length > 0 && !selectedSurface) {
      const surfaceWithFrame = surfaces.find((s) => s.frameUrl);
      const surface = surfaceWithFrame || surfaces[0];
      setSelectedSurface(surface);
      // Auto-populate blend defaults from lighting data
      setBlend(getAutoBlendDefaults(surface));
    }
  }, [open, surfaces, selectedSurface]);

  // Scene persistence: auto-load existing placement when switching surfaces
  useEffect(() => {
    if (!open || !selectedSurface) return;
    const loadExistingPlacement = async () => {
      try {
        const res = await fetch(`/api/video/${videoId}/surface/${selectedSurface.id}/placement`, {
          credentials: "include",
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.placement) {
          const p = data.placement;
          // Restore product image
          if (p.productImageUrl) {
            setProductImage(p.productImageUrl);
          }
          // Restore transform
          if (p.transform) {
            setTransform({
              offsetX: p.transform.offsetX ?? 0,
              offsetY: p.transform.offsetY ?? 0,
              scale: p.transform.scale ?? 0.6,
              rotation: p.transform.rotation ?? 0,
              flipH: p.transform.flipH ?? false,
            });
          }
          // Restore blend
          if (p.blend) {
            setBlend({
              opacity: p.blend.opacity ?? 90,
              blendMode: (p.blend.blendMode ?? "source-over") as GlobalCompositeOperation,
              shadowEnabled: p.blend.shadowEnabled ?? true,
              shadowBlur: p.blend.shadowBlur ?? 8,
              shadowOffsetX: p.blend.shadowOffsetX ?? 2,
              shadowOffsetY: p.blend.shadowOffsetY ?? 4,
              shadowColor: p.blend.shadowColor ?? "rgba(0,0,0,0.4)",
              featherRadius: p.blend.featherRadius ?? 0,
              brightness: p.blend.brightness ?? 0,
              contrast: p.blend.contrast ?? 0,
            });
          }
          // Restore keyframes if any are saved on this placement.
          if (Array.isArray((p as any).keyframes)) {
            setKeyframes((p as any).keyframes);
          } else {
            setKeyframes([]);
          }
          console.log(`[PlacementPreview] Auto-loaded placement (${data.source}) for surface ${selectedSurface.id}`);
        }
      } catch (err) {
        // Non-fatal — just means no existing placement
        console.debug("[PlacementPreview] No existing placement for surface", selectedSurface.id);
      }
    };
    loadExistingPlacement();
  }, [open, selectedSurface?.id, videoId]);

  // Reset state on close
  useEffect(() => {
    if (!open) {
      setSelectedSurface(null);
      setProductImage(null);
      setProductFile(null);
      setProductTab("upload");
      setSelectedCatalogProduct(null);
      setToolPanel("product");
      setTransform({ ...DEFAULT_TRANSFORM });
      setBlend({ ...DEFAULT_BLEND });
      setKeyframes([]);
      setDragMode("none");
      setIsSaving(false);
      setSaveSuccess(false);
      frameImgRef.current = null;
      productImgRef.current = null;
      // Reset video playback + dense scan + motion tracking state
      setIsVideoMode(false);
      setIsDenseScanning(false);
      setDenseScanDone(false);
      setMotionData(null);
      setIsMotionLoading(false);
      setIsVideoPlaying(false);
      setVideoCurrentTime(0);
      setVideoDuration(0);
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.currentTime = 0;
      }
      // Reset export state
      setIsExporting(false);
      setExportProgress(0);
      setExportStatus(null);
      setExportJobId(null);
      setExportOutputUrl(null);
    }
  }, [open]);

  // Invalidate cached harmonization when inputs change. Auto-trigger
  // removed per product spec — user clicks Harmonize button to refresh
  // the result. We just clear the stale URL so the canvas shows the flat
  // overlay until they manually re-harmonize.
  useEffect(() => {
    setLiveHarmonizedUrl(null);
    if (harmonizeEnabled) setHarmonizeEnabled(false);
    // intentionally not depending on harmonizeEnabled (avoid loop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSurface?.id, productImage, transform.offsetX, transform.offsetY, transform.scale, transform.rotation]);

  // Harmonize progress timer — drives the determinate progress bar from
  // elapsed time while a harmonize request is in flight. Updates every
  // 200ms which is smooth enough for a progress bar without thrashing.
  useEffect(() => {
    if (!isHarmonizing || !harmonizeStartedAt) {
      setHarmonizeElapsedMs(0);
      return;
    }
    const tick = () => setHarmonizeElapsedMs(Date.now() - harmonizeStartedAt);
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [isHarmonizing, harmonizeStartedAt]);

  // Apply initialPlacement when modal opens with pre-loaded data (re-edit flow)
  useEffect(() => {
    if (!open || !initialPlacement) return;
    setProductImage(initialPlacement.productImageUrl);
    setTransform({ ...initialPlacement.transform });
    setBlend({ ...initialPlacement.blend });
    setToolPanel("transform");
    // Restore the creator's prior harmonize choice. If they had isHarmonized
    // saved, default the toggle to that state and seed the cached URL so the
    // overlay shows immediately without waiting for a re-fetch.
    if (typeof initialPlacement.isHarmonized === "boolean") {
      setHarmonizeEnabled(initialPlacement.isHarmonized);
    }
    if (initialPlacement.harmonizedImageUrl) {
      setLiveHarmonizedUrl(initialPlacement.harmonizedImageUrl);
    }
    // If from catalog, pre-select the catalog product
    if (initialPlacement.productId && catalogProducts) {
      const match = catalogProducts.find((p: CatalogProduct) => p.id === initialPlacement.productId);
      if (match) {
        setSelectedCatalogProduct(match);
        setProductTab("catalog");
      }
    }
  }, [open, initialPlacement]);

  // Helper to load an image as a promise
  const loadImage = useCallback((src: string): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (src.startsWith("data:")) {
        // Data URLs don't need crossOrigin
      } else if (src.startsWith("http") && !src.startsWith(window.location.origin)) {
        img.crossOrigin = "anonymous";
      }
      img.onload = () => resolve(img);
      img.onerror = (e) => {
        console.error("Image load failed:", src.substring(0, 100), e);
        reject(new Error(`Failed to load image: ${src.substring(0, 100)}`));
      };
      img.src = src;
    });
  }, []);

  // Load frame image when surface changes
  useEffect(() => {
    if (!selectedSurface?.frameUrl) {
      frameImgRef.current = null;
      return;
    }
    loadImage(selectedSurface.frameUrl).then(img => {
      frameImgRef.current = img;
    }).catch(err => {
      console.error("Failed to load frame:", err);
      frameImgRef.current = null;
    });
  }, [selectedSurface?.frameUrl, loadImage]);

  // Load product image when it changes
  useEffect(() => {
    if (!productImage) {
      productImgRef.current = null;
      return;
    }
    loadImage(productImage).then(img => {
      productImgRef.current = img;
      // Auto-switch to transform panel when product is loaded
      setToolPanel("transform");
    }).catch(err => {
      console.error("Failed to load product:", err);
      productImgRef.current = null;
    });
  }, [productImage, loadImage]);

  // ============================================================================
  // LIVE CANVAS RENDER LOOP
  // ============================================================================

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const container = canvasContainerRef.current;
    if (!canvas || !container) {
      animFrameRef.current = requestAnimationFrame(renderFrame);
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      animFrameRef.current = requestAnimationFrame(renderFrame);
      return;
    }

    // Determine frame source: video element (when playing) or static frame image
    const videoEl = videoRef.current;
    const useVideo = isVideoMode && videoEl && videoEl.readyState >= 2;
    const frameImg = frameImgRef.current;

    if (!useVideo && (!frameImg || !frameImg.complete)) {
      // Clear canvas if no frame source
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      animFrameRef.current = requestAnimationFrame(renderFrame);
      return;
    }

    // Get the natural dimensions of the source
    const sourceWidth = useVideo ? videoEl!.videoWidth : frameImg!.naturalWidth;
    const sourceHeight = useVideo ? videoEl!.videoHeight : frameImg!.naturalHeight;

    if (sourceWidth === 0 || sourceHeight === 0) {
      animFrameRef.current = requestAnimationFrame(renderFrame);
      return;
    }

    // Size canvas to container while maintaining frame aspect ratio
    const containerRect = container.getBoundingClientRect();
    const frameAspect = sourceWidth / sourceHeight;
    let displayW = containerRect.width;
    let displayH = containerRect.width / frameAspect;

    const maxH = containerRect.height || 500;
    if (displayH > maxH) {
      displayH = maxH;
      displayW = maxH * frameAspect;
    }

    if (canvas.width !== Math.round(displayW) || canvas.height !== Math.round(displayH)) {
      canvas.width = Math.round(displayW);
      canvas.height = Math.round(displayH);
    }

    // Draw frame (from video or static image)
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (useVideo) {
      ctx.drawImage(videoEl!, 0, 0, canvas.width, canvas.height);
      // Update time display
      setVideoCurrentTime(videoEl!.currentTime);
    } else {
      ctx.drawImage(frameImg!, 0, 0, canvas.width, canvas.height);
    }

    // Draw bounding box — during video playback, use client-side visual tracking
    // to follow the surface as the camera moves. The product stays "placed" on the
    // physical surface, just like a real object would.
    if (selectedSurface) {
      let bx: number, by: number, bw: number, bh: number;

      // Locked bbox dimensions from initial surface detection
      const baseBW = selectedSurface.boundingBoxWidth * canvas.width;
      const baseBH = selectedSurface.boundingBoxHeight * canvas.height;
      const baseBX = selectedSurface.boundingBoxX * canvas.width;
      const baseBY = selectedSurface.boundingBoxY * canvas.height;

      if (useVideo && videoEl) {
        const tracking = trackingRef.current;
        const hasGeminiData = motionData?.available && motionData.source === "gemini-keyframes" && motionData.transforms.length > 0;

        if (hasGeminiData) {
          // ── STRATEGY A: Pre-computed Gemini keyframe data (Anchor-Lock Mode) ──
          // Real per-frame surface positions from Gemini AI vision analysis.
          // Anchors the product to the top-right corner of the detected bbox
          // so the product stays locked to the surface throughout the scene.
          const currentTime = videoEl.currentTime;
          const frameIndex = Math.round(currentTime * motionData!.fps);
          const clampedIndex = Math.min(frameIndex, motionData!.transforms.length - 1);
          const pos = motionData!.transforms[clampedIndex];

          // Null transform = the motion track has no data for this frame —
          // NOT proof the surface is invisible. Track coverage can be
          // sparse or mis-sized (a wrong duration once nulled every frame
          // past 30s and hid the overlay for entire videos). Fall back to
          // the static detection bbox and let the scene gate below own
          // visibility — it has the actual scene data.
          if (!pos) {
            bx = baseBX; by = baseBY; bw = baseBW; bh = baseBH;
          } else {

          // Anchor-lock: track the top-right corner of the bbox as the fixed reference point
          // The product's right edge stays pinned to this anchor throughout the scene
          const anchorX = (pos.x + pos.w) * canvas.width;   // top-right X of detected bbox
          const anchorY = pos.y * canvas.height;              // top-right Y of detected bbox
          // Derive product position so its right edge aligns with the anchor
          const targetBX = anchorX - baseBW;
          const targetBY = anchorY;
          const targetBW = pos.w * canvas.width;
          const targetBH = pos.h * canvas.height;

          // Tight drift constraint: product can't wander more than 1x bbox size from original
          const maxDrift = Math.max(baseBW, baseBH) * 1.0;
          const constrainedBX = clamp(targetBX, baseBX - maxDrift, baseBX + maxDrift);
          const constrainedBY = clamp(targetBY, baseBY - maxDrift, baseBY + maxDrift);

          if (!tracking.initialized) {
            // Snap to initial position on first frame (no spring lag)
            tracking.displayOffsetX = constrainedBX;
            tracking.displayOffsetY = constrainedBY;
            tracking.displayOffsetW = targetBW;
            tracking.displayOffsetH = targetBH;
            tracking.cumulativeOffsetX = constrainedBX;
            tracking.cumulativeOffsetY = constrainedBY;
            tracking.velocityX = 0;
            tracking.velocityY = 0;
            tracking.initialized = true;
          }
          tracking.cumulativeOffsetX = constrainedBX;
          tracking.cumulativeOffsetY = constrainedBY;

          // Very stiff spring for Gemini data — server already smoothed, just snap to it
          const stiffness = 0.7;
          const damping = 0.5;
          const forceX = (tracking.cumulativeOffsetX - tracking.displayOffsetX) * stiffness;
          const forceY = (tracking.cumulativeOffsetY - tracking.displayOffsetY) * stiffness;
          tracking.velocityX = tracking.velocityX * damping + forceX;
          tracking.velocityY = tracking.velocityY * damping + forceY;

          // Velocity deadzone: eliminate micro-jitter when nearly at rest
          if (Math.abs(tracking.velocityX) < 0.5) tracking.velocityX = 0;
          if (Math.abs(tracking.velocityY) < 0.5) tracking.velocityY = 0;

          tracking.displayOffsetX += tracking.velocityX;
          tracking.displayOffsetY += tracking.velocityY;

          // Also smooth width/height to prevent size jitter
          const dimStiffness = 0.8;
          tracking.displayOffsetW = (tracking.displayOffsetW || targetBW) + (targetBW - (tracking.displayOffsetW || targetBW)) * dimStiffness;
          tracking.displayOffsetH = (tracking.displayOffsetH || targetBH) + (targetBH - (tracking.displayOffsetH || targetBH)) * dimStiffness;

          bx = tracking.displayOffsetX;
          by = tracking.displayOffsetY;
          bw = tracking.displayOffsetW;
          bh = tracking.displayOffsetH;
          }
        } else {
          // ── STRATEGY B: Global Optical Flow (camera motion estimation) ──
          // Measures how the ENTIRE frame shifts between consecutive video frames.
          // Works reliably for camera pans/tilts because the whole scene moves together.
          // The product stays anchored to the surface by compensating for camera motion.
          tracking.frameCounter++;

          // Run optical flow every 3rd frame for good balance of accuracy vs performance
          if (tracking.frameCounter % 3 === 0) {
            const currFrameData = captureFrameForFlow(videoEl, tracking.flowCanvas, FLOW_W, FLOW_H);

            if (currFrameData && tracking.prevFrameData) {
              const { dx, dy, confidence } = computeOpticalFlowBlock(
                tracking.prevFrameData,
                currFrameData,
                FLOW_W,
                FLOW_H,
              );

              if (confidence > 0.25) {
                // Scale flow dx/dy from flow resolution to canvas resolution
                const scaleX = canvas.width / FLOW_W;
                const scaleY = canvas.height / FLOW_H;
                // Optical flow dx/dy = where previous frame's content appears in current frame.
                // If camera pans left → scene moves right → dx is positive → product moves right.
                tracking.cumulativeOffsetX += dx * scaleX;
                tracking.cumulativeOffsetY += dy * scaleY;
              }

              tracking.prevFrameData = currFrameData;
            } else if (currFrameData && !tracking.prevFrameData) {
              // First frame — just capture, no motion yet
              tracking.prevFrameData = currFrameData;
              // Initialize display position to current base position so spring doesn't jump
              tracking.displayOffsetX = baseBX;
              tracking.displayOffsetY = baseBY;
              tracking.initialized = true;
            }
          }

          // Stiff spring-damped interpolation for stable display
          const stiffness = 0.35;
          const damping = 0.82;
          const targetX = baseBX + tracking.cumulativeOffsetX;
          const targetY = baseBY + tracking.cumulativeOffsetY;
          const forceX = (targetX - tracking.displayOffsetX) * stiffness;
          const forceY = (targetY - tracking.displayOffsetY) * stiffness;
          tracking.velocityX = tracking.velocityX * damping + forceX;
          tracking.velocityY = tracking.velocityY * damping + forceY;

          // Velocity deadzone: eliminate micro-jitter
          if (Math.abs(tracking.velocityX) < 0.3) tracking.velocityX = 0;
          if (Math.abs(tracking.velocityY) < 0.3) tracking.velocityY = 0;

          tracking.displayOffsetX += tracking.velocityX;
          tracking.displayOffsetY += tracking.velocityY;

          if (!tracking.initialized) {
            // Before first flow computation, use static position
            bx = baseBX;
            by = baseBY;
          } else {
            bx = tracking.displayOffsetX;
            by = tracking.displayOffsetY;
          }
          bw = baseBW;
          bh = baseBH;
        }
      } else {
        // Static mode — use the surface's original position
        bx = baseBX;
        by = baseBY;
        bw = baseBW;
        bh = baseBH;
      }

      const hasProduct = !!productImgRef.current;

      // Bounding box outline (hidden when toggle is off)
      if (showBoundingBox) {
        ctx.strokeStyle = hasProduct ? "rgba(16, 185, 129, 0.6)" : "rgba(139, 92, 246, 0.8)";
        ctx.lineWidth = 2;
        ctx.setLineDash(hasProduct ? [4, 4] : [6, 4]);
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);

        // Surface label
        if (!hasProduct) {
          ctx.font = "bold 11px Inter, system-ui, sans-serif";
          const label = selectedSurface.surfaceType;
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(139, 92, 246, 0.85)";
          ctx.fillRect(bx, by - 18, tw + 10, 18);
          ctx.fillStyle = "#fff";
          ctx.fillText(label, bx + 5, by - 5);
        }
      }

      // Scene gate: during playback, hide the placement when the current
      // playhead is in a different SCENE than the surface was detected in.
      // PREDICTIVE LOOK-AHEAD: peek 150ms ahead and gate on the FUTURE
      // playhead's sceneId. This makes the 200ms fade-out start BEFORE
      // the actual cut, so the product is fully invisible by the time
      // the cut paints. Was previously gating on currentTime only, which
      // means the fade started AT the cut and the product remained
      // visible for ~100ms past the cut while easing to opacity 0.
      const LOOK_AHEAD_MS = 150;
      let inOriginalShot: boolean;
      if (useVideo && placementSceneId !== null) {
        const lookAheadT = videoEl!.currentTime + LOOK_AHEAD_MS / 1000;
        const playbackSceneId = sceneIdFor(lookAheadT);
        if (playbackSceneId !== null) {
          inOriginalShot = playbackSceneId === placementSceneId;
        } else {
          // Optimistic fallback: scene data not loaded → assume same scene.
          // Better to briefly show a stale placement than to flash hide it.
          inOriginalShot = true;
        }
      } else {
        // Same predictive look-ahead for the legacy shot-block path.
        // videoEl can be unmounted in static mode (no videoSrc) — a bare
        // dereference here threw mid-rAF and killed the product draw.
        const tNow = videoRef.current?.currentTime ?? 0;
        const tForGate = useVideo ? tNow + LOOK_AHEAD_MS / 1000 : tNow;
        const playbackBlockId = useVideo ? sceneBlockFor(tForGate) : placementBlockId;
        inOriginalShot = playbackBlockId === placementBlockId;
      }

      // Smooth opacity transition between in-scene/out-of-scene states.
      // Updates targetOpacity from the gate decision, then eases the
      // currentOpacity toward it using delta-time integration so the
      // transition feels consistent regardless of frame rate.
      const ts = sceneTransitionRef.current;
      const newTarget = inOriginalShot ? 1 : 0;
      if (ts.targetOpacity !== newTarget) {
        ts.targetOpacity = newTarget;
      }
      const now = performance.now();
      const dt = ts.lastFrameTime ? Math.min(0.1, (now - ts.lastFrameTime) / 1000) : 0;
      ts.lastFrameTime = now;
      // 200ms total transition — easing rate computed so opacity
      // changes by 1.0 in 0.2 seconds = rate of 5/sec.
      const FADE_RATE_PER_SEC = 5;
      const delta = (ts.targetOpacity - ts.currentOpacity) * FADE_RATE_PER_SEC * dt;
      ts.currentOpacity = Math.max(0, Math.min(1, ts.currentOpacity + delta));
      const sceneOpacity = ts.currentOpacity;

      // "Placement hidden" badge — fades in inversely with the product
      // (when product is fully invisible, badge is fully visible). Same
      // 200ms ease so they cross over smoothly.
      const badgeOpacity = 1 - sceneOpacity;
      if (useVideo && badgeOpacity > 0.05 && hasProduct) {
        const badgeText = "Placement hidden — different scene";
        ctx.font = "11px Inter, system-ui, sans-serif";
        const tw = ctx.measureText(badgeText).width;
        const padX = 10, padY = 6;
        const badgeW = tw + padX * 2;
        const badgeH = 22;
        const badgeX = canvas.width - badgeW - 12;
        const badgeY = 12;
        ctx.fillStyle = `rgba(0, 0, 0, ${0.75 * badgeOpacity})`;
        ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
        ctx.fillStyle = `rgba(251, 191, 36, ${0.95 * badgeOpacity})`;
        ctx.fillText(badgeText, badgeX + padX, badgeY + padY + 9);
      }

      // Draw product if loaded AND scene-fade hasn't fully hidden it.
      // Use sceneOpacity (0..1, eased) to crossfade smoothly across cuts
      // — pure on/off pop felt like the product was being "dropped in
      // each time" per the user's report. We draw whenever opacity > 0.05
      // (avoids paying the draw cost when essentially invisible) and
      // wrap drawProduct in a globalAlpha so the existing blend logic
      // is preserved without a parameter-passing rewrite.
      const prodImg = productImgRef.current;
      if (prodImg && prodImg.complete && bw > 0 && bh > 0 && sceneOpacity > 0.05) {
        ctx.save();
        ctx.globalAlpha = sceneOpacity;
        // Use keyframe-interpolated transform during playback so frame-by-
        // frame edits actually take effect. When paused (or when there are
        // no keyframes) this reduces to the base `transform` constant.
        const renderTransform = useVideo
          ? effectiveTransformAt(videoEl!.currentTime)
          : transform;
        drawProduct(ctx, prodImg, bx, by, bw, bh, renderTransform, blend);
        ctx.restore();

        // Draw resize handles + rotation handle (hidden when toggle is off)
        if (showBoundingBox) {
          const handleSize = 8;
          ctx.fillStyle = "rgba(139, 92, 246, 0.9)";

          // Corner handles
          const corners = [
            { x: bx, y: by },
            { x: bx + bw, y: by },
            { x: bx, y: by + bh },
            { x: bx + bw, y: by + bh },
          ];
          for (const c of corners) {
            ctx.fillRect(c.x - handleSize / 2, c.y - handleSize / 2, handleSize, handleSize);
          }

          // Rotation handle (orange dot above center)
          ctx.beginPath();
          ctx.arc(bx + bw / 2, by - 22, 6, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(251, 146, 60, 0.9)";
          ctx.fill();
          ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // Line from top-center to rotation handle
          ctx.beginPath();
          ctx.moveTo(bx + bw / 2, by);
          ctx.lineTo(bx + bw / 2, by - 16);
          ctx.strokeStyle = "rgba(251, 146, 60, 0.5)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // "Drop product here" text if no product (hidden when toggle is off)
      if (!hasProduct && showBoundingBox) {
        ctx.fillStyle = "rgba(139, 92, 246, 0.15)";
        ctx.fillRect(bx, by, bw, bh);

        ctx.font = "12px Inter, system-ui, sans-serif";
        ctx.fillStyle = "rgba(139, 92, 246, 0.8)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Drop product here", bx + bw / 2, by + bh / 2);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }
    }

    animFrameRef.current = requestAnimationFrame(renderFrame);
  }, [selectedSurface, transform, blend, isVideoMode, motionData, showBoundingBox, sceneBlockFor, placementBlockId, sceneIdFor, placementSceneId, keyframes, effectiveTransformAt]);

  // Start/stop render loop
  useEffect(() => {
    if (open) {
      animFrameRef.current = requestAnimationFrame(renderFrame);
    }
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [open, renderFrame]);

  // ============================================================================
  // VIDEO PLAYBACK CONTROLS
  // ============================================================================

  const toggleVideoPlayback = useCallback(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    if (!isVideoMode) {
      // Enter video mode — reset optical flow tracking state
      const tracking = trackingRef.current;
      tracking.initialized = false;
      tracking.prevFrameData = null;
      tracking.cumulativeOffsetX = 0;
      tracking.cumulativeOffsetY = 0;
      tracking.displayOffsetX = 0;
      tracking.displayOffsetY = 0;
      tracking.displayOffsetW = 0;
      tracking.displayOffsetH = 0;
      tracking.velocityX = 0;
      tracking.velocityY = 0;
      tracking.frameCounter = 0;

      setIsVideoMode(true);
      triggerDenseScan(); // Fire-and-forget: generates dense keyframes in background (for export)
      triggerMotionTrack(); // Fire-and-forget: runs vidstab analysis for smooth placement preview
      videoEl.currentTime = 0;
      videoEl.play().then(() => {
        setIsVideoPlaying(true);
      }).catch(err => {
        console.error("[PlacementPreview] Video play failed:", err);
      });
    } else if (isVideoPlaying) {
      videoEl.pause();
      setIsVideoPlaying(false);
    } else {
      videoEl.play().then(() => {
        setIsVideoPlaying(true);
      }).catch(err => {
        console.error("[PlacementPreview] Video play failed:", err);
      });
    }
  }, [isVideoMode, isVideoPlaying, triggerDenseScan, triggerMotionTrack]);

  const stopVideoPlayback = useCallback(() => {
    const videoEl = videoRef.current;
    if (videoEl) {
      videoEl.pause();
      videoEl.currentTime = 0;
    }
    setIsVideoMode(false);
    setIsVideoPlaying(false);
    setVideoCurrentTime(0);
    // Reset optical flow tracking
    const tracking = trackingRef.current;
    tracking.initialized = false;
    tracking.prevFrameData = null;
    tracking.cumulativeOffsetX = 0;
    tracking.cumulativeOffsetY = 0;
    tracking.displayOffsetX = 0;
    tracking.displayOffsetY = 0;
    tracking.displayOffsetW = 0;
    tracking.displayOffsetH = 0;
    tracking.velocityX = 0;
    tracking.velocityY = 0;
    tracking.frameCounter = 0;
  }, []);

  // ============================================================================
  // KEYBOARD SHORTCUTS FOR VIDEO PLAYBACK
  // ============================================================================

  useEffect(() => {
    if (!isVideoMode) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const videoEl = videoRef.current;
      if (!videoEl) return;

      // Ignore if user is typing in an input
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          if (isVideoPlaying) {
            videoEl.pause();
            setIsVideoPlaying(false);
          } else {
            videoEl.play().then(() => setIsVideoPlaying(true)).catch(() => {});
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          {
            const step = e.shiftKey ? 1 : 5;
            const newTime = Math.max(0, videoEl.currentTime - step);
            videoEl.currentTime = newTime;
            setVideoCurrentTime(newTime);
            // Reset tracking so product snaps to correct position
            const tracking = trackingRef.current;
            tracking.initialized = false;
            tracking.prevFrameData = null;
            tracking.velocityX = 0;
            tracking.velocityY = 0;
          }
          break;
        case "ArrowRight":
          e.preventDefault();
          {
            const step = e.shiftKey ? 1 : 5;
            const newTime = Math.min(videoDuration, videoEl.currentTime + step);
            videoEl.currentTime = newTime;
            setVideoCurrentTime(newTime);
            const tracking = trackingRef.current;
            tracking.initialized = false;
            tracking.prevFrameData = null;
            tracking.velocityX = 0;
            tracking.velocityY = 0;
          }
          break;
        case "Home":
        case "0":
          e.preventDefault();
          videoEl.currentTime = 0;
          setVideoCurrentTime(0);
          {
            const tracking = trackingRef.current;
            tracking.initialized = false;
            tracking.prevFrameData = null;
            tracking.velocityX = 0;
            tracking.velocityY = 0;
          }
          break;
        case "End":
          e.preventDefault();
          videoEl.currentTime = videoDuration;
          setVideoCurrentTime(videoDuration);
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isVideoMode, isVideoPlaying, videoDuration]);

  // ============================================================================
  // VIDEO EXPORT
  // ============================================================================

  const handleVideoExport = useCallback(async () => {
    if (!selectedSurface || !productImage) return;

    // Send the user's placed position as a fallback keyframe.
    // The server will run denseScanRange() to get per-frame surface tracking data
    // so the product follows the surface as the camera moves.
    const surfaceType = selectedSurface.surfaceType;
    const rawX = selectedSurface.boundingBoxX;
    const rawY = selectedSurface.boundingBoxY;
    const rawW = selectedSurface.boundingBoxWidth;
    const rawH = selectedSurface.boundingBoxHeight;
    const isNormalized = rawX <= 1 && rawY <= 1 && rawW <= 1 && rawH <= 1;
    const scale = isNormalized ? 100 : 1;

    const keyframes = [{
      timestamp: 0,
      bbox: {
        x: rawX * scale,
        y: rawY * scale,
        w: rawW * scale,
        h: rawH * scale,
      },
      confidence: selectedSurface.confidence,
    }];
    console.log(`[PlacementPreview] Exporting "${surfaceType}" — server will run dense tracking`);

    // Get product aspect ratio
    const prodImg = productImgRef.current;
    const productAspectRatio = prodImg ? prodImg.naturalWidth / prodImg.naturalHeight : 1;

    // Canvas dimensions for server-side scaling
    const canvas = canvasRef.current;
    const canvasWidth = canvas?.width || 640;
    const canvasHeight = canvas?.height || 360;

    const placementData = [{
      surfaceType,
      // Anchor surface identity — the server keys harmonized-composite
      // substitution on this (product image alone is ambiguous when the
      // same product sits on two surfaces).
      surfaceId: selectedSurface.id,
      productImageUrl: productImage,
      transform,
      blend,
      keyframes,
      productAspectRatio,
      // Send pre-computed motion-track data so export uses identical positions as preview
      motionTrackData: motionData?.available && motionData.transforms.length > 0 ? {
        transforms: motionData.transforms,
        fps: motionData.fps,
        duration: motionData.duration,
      } : null,
    }];

    try {
      setIsExporting(true);
      setExportStatus("queued");
      setExportProgress(0);
      setExportOutputUrl(null);

      const res = await fetch(`/api/video/${videoId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          placements: placementData,
          canvasWidth,
          canvasHeight,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        let errMsg = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(errBody);
          errMsg = parsed.error || parsed.message || errMsg;
        } catch {
          errMsg = errBody.length > 0 ? `${errMsg}: ${errBody.substring(0, 200)}` : errMsg;
        }
        throw new Error(errMsg);
      }

      const { exportId } = await res.json();
      setExportJobId(exportId);
      setExportStatus("processing");
      toast({ title: "Video export started", description: "This may take a few minutes..." });
    } catch (err: any) {
      setIsExporting(false);
      setExportStatus("failed");
      console.error("[PlacementPreview] Export failed:", err);
      toast({ title: "Export failed", description: err.message || "Unknown error", variant: "destructive" });
    }
  }, [selectedSurface, productImage, transform, blend, videoId, motionData, toast]);

  // Poll export progress
  useEffect(() => {
    if (!exportJobId || !isExporting) return;
    if (exportStatus === "complete" || exportStatus === "failed") return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/exports/${exportJobId}`, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();

        setExportProgress(data.progress || 0);
        setExportStatus(data.status);

        if (data.status === "complete") {
          setExportOutputUrl(data.outputUrl);
          setIsExporting(false);
          toast({ title: "Video export complete!", description: "Your video with product placement is ready to download." });
          clearInterval(interval);
        } else if (data.status === "failed") {
          setIsExporting(false);
          toast({ title: "Export failed", description: data.error || "Unknown error", variant: "destructive" });
          clearInterval(interval);
        }
      } catch (err) {
        console.error("[PlacementPreview] Export poll error:", err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [exportJobId, isExporting, exportStatus, toast]);

  // ============================================================================
  // CANVAS MOUSE INTERACTION
  // ============================================================================

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!selectedSurface || !productImgRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setIsInteractingWithCanvas(true);

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    const bx = selectedSurface.boundingBoxX * canvas.width;
    const by = selectedSurface.boundingBoxY * canvas.height;
    const bw = selectedSurface.boundingBoxWidth * canvas.width;
    const bh = selectedSurface.boundingBoxHeight * canvas.height;

    const handleSize = 14;

    // Check rotation handle (orange dot above center)
    const rotCx = bx + bw / 2;
    const rotCy = by - 22;
    if (Math.hypot(mx - rotCx, my - rotCy) < handleSize) {
      setDragMode("rotate");
      setDragStart({ x: mx, y: my });
      setDragStartTransform({ ...transform });
      e.preventDefault();
      return;
    }

    // Check corner handles
    const corners: { mode: DragMode; x: number; y: number }[] = [
      { mode: "resize-tl", x: bx, y: by },
      { mode: "resize-tr", x: bx + bw, y: by },
      { mode: "resize-bl", x: bx, y: by + bh },
      { mode: "resize-br", x: bx + bw, y: by + bh },
    ];
    for (const c of corners) {
      if (Math.abs(mx - c.x) < handleSize && Math.abs(my - c.y) < handleSize) {
        setDragMode(c.mode);
        setDragStart({ x: mx, y: my });
        setDragStartTransform({ ...transform });
        e.preventDefault();
        return;
      }
    }

    // Check inside bounding box = move
    if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
      setDragMode("move");
      setDragStart({ x: mx, y: my });
      setDragStartTransform({ ...transform });
      e.preventDefault();
    }
  }, [selectedSurface, transform]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragMode === "none") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    const dx = mx - dragStart.x;
    const dy = my - dragStart.y;

    setTransform(prev => {
      const newTransform = { ...prev };

      if (dragMode === "move") {
        newTransform.offsetX = dragStartTransform.offsetX + dx;
        newTransform.offsetY = dragStartTransform.offsetY + dy;
      } else if (dragMode.startsWith("resize")) {
        const dist = Math.hypot(dx, dy);
        const sign = (dx + dy) > 0 ? 1 : -1;
        newTransform.scale = clamp(dragStartTransform.scale + sign * dist * 0.005, 0.1, 4.0);
      } else if (dragMode === "rotate") {
        newTransform.rotation = dragStartTransform.rotation + dx * 0.5;
      }

      return newTransform;
    });
  }, [dragMode, dragStart, dragStartTransform]);

  const handleCanvasMouseUp = useCallback(() => {
    setDragMode("none");
    setIsInteractingWithCanvas(false);
  }, []);

  // ============================================================================
  // TRANSFORM / BLEND UPDATERS
  // ============================================================================

  const updateTransform = useCallback((key: keyof PlacementTransform, value: number | boolean) => {
    setTransform(prev => ({ ...prev, [key]: value }));
  }, []);

  const updateBlend = useCallback((key: keyof PlacementBlend, value: number | boolean | string) => {
    setBlend(prev => ({ ...prev, [key]: value }));
  }, []);

  const resetTransform = useCallback(() => {
    setTransform({ ...DEFAULT_TRANSFORM });
  }, []);

  const resetBlend = useCallback(() => {
    setBlend({ ...DEFAULT_BLEND });
  }, []);

  // ============================================================================
  // FILE UPLOAD HANDLERS
  // ============================================================================

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        alert("Please upload an image file (PNG, JPG, etc.)");
        return;
      }
      setProductFile(file);
      setTransform({ ...DEFAULT_TRANSFORM });
      setBlend({ ...DEFAULT_BLEND });
      const reader = new FileReader();
      reader.onload = () => {
        setProductImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    },
    []
  );

  // Re-apply a previously logged harmonize entry. Pure client op — sets
  // the result URLs + transform back into local state. No server call.
  // The "Reuse settings" path restores only the transform (useful when the
  // result image has 404'd from the bucket).
  const reuseHarmonizeEntry = useCallback(
    (entry: HarmonizeHistoryEntry, opts: { transformOnly?: boolean } = {}) => {
      setTransform({
        scale: entry.transform.scale,
        offsetX: entry.transform.offsetX,
        offsetY: entry.transform.offsetY,
        rotation: entry.transform.rotation,
        flipH: entry.transform.flipH,
      });
      if (!opts.transformOnly) {
        setHarmonizeFlatUrl(entry.flatCompositeUrl);
        setHarmonizeResultUrl(entry.resultImageUrl);
        setLiveHarmonizedUrl(entry.resultImageUrl);
        setHarmonizeEnabled(true);
        setHarmonizeError(null);
        setShowHarmonizeCompare(true);
        toast({
          title: "Reused previous harmonize",
          description: `${entry.mode === "ai-3d" ? "3D" : "Procedural"} • ${formatHistoryTimestamp(entry.timestamp)}`,
        });
      } else {
        toast({
          title: "Reused placement settings",
          description: "Transform restored — click Harmonize to regenerate.",
        });
      }
    },
    [toast],
  );

  const removeHarmonizeEntry = useCallback((id: string) => {
    setHarmonizeHistory((prev) => {
      const next = prev.filter((e) => e.id !== id);
      saveHarmonizeHistory(next);
      return next;
    });
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    setProductFile(file);
    setTransform({ ...DEFAULT_TRANSFORM });
    setBlend({ ...DEFAULT_BLEND });
    const reader = new FileReader();
    reader.onload = () => {
      setProductImage(reader.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  const selectCatalogProduct = useCallback((product: CatalogProduct) => {
    setSelectedCatalogProduct(product);
    setProductImage(product.imageUrl);
    setProductFile(null);
    setTransform({ ...DEFAULT_TRANSFORM });
    setBlend({ ...DEFAULT_BLEND });
  }, []);

  // Auto-select a product so the preview shows SOMETHING brand-shaped
  // immediately. Without this the modal opened with productImage=null and
  // drew only the "Drop product here" ghost — read by users as "the
  // placement doesn't work". An explicit initialPlacement or a saved
  // placement still wins (their effects overwrite this selection).
  // (Lives below selectCatalogProduct: the dep array evaluates at render
  // time, so referencing the const above it is a TDZ crash.)
  useEffect(() => {
    if (open && !productImage && !initialPlacement && catalogProducts && catalogProducts.length > 0) {
      selectCatalogProduct(catalogProducts[0]);
    }
  }, [open, productImage, initialPlacement, catalogProducts, selectCatalogProduct]);

  const resetPreview = () => {
    setProductImage(null);
    setProductFile(null);
    setSelectedCatalogProduct(null);
    setTransform({ ...DEFAULT_TRANSFORM });
    setBlend({ ...DEFAULT_BLEND });
    setToolPanel("product");
    productImgRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ============================================================================
  // EXPORT
  // ============================================================================

  const downloadPreview = useCallback(() => {
    const frameImg = frameImgRef.current;
    const prodImg = productImgRef.current;
    if (!frameImg || !selectedSurface) return;

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = frameImg.naturalWidth;
    exportCanvas.height = frameImg.naturalHeight;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return;

    // Draw full-res frame
    ctx.drawImage(frameImg, 0, 0, exportCanvas.width, exportCanvas.height);

    // Draw product if placed
    if (prodImg && prodImg.complete) {
      const bx = selectedSurface.boundingBoxX * exportCanvas.width;
      const by = selectedSurface.boundingBoxY * exportCanvas.height;
      const bw = selectedSurface.boundingBoxWidth * exportCanvas.width;
      const bh = selectedSurface.boundingBoxHeight * exportCanvas.height;

      // Calculate scale ratio between display canvas and export canvas
      const displayCanvas = canvasRef.current;
      const scaleRatio = displayCanvas ? exportCanvas.width / displayCanvas.width : 1;

      drawProductExport(ctx, prodImg, bx, by, bw, bh, transform, blend, scaleRatio);
    }

    try {
      const link = document.createElement("a");
      link.download = `placement-preview-${videoId}-${selectedSurface?.id || "surface"}.jpg`;
      link.href = exportCanvas.toDataURL("image/jpeg", 0.92);
      link.click();
    } catch (err) {
      console.error("Export failed:", err);
    }
  }, [selectedSurface, transform, blend, videoId]);

  // ============================================================================
  // SAVE PLACEMENT
  // ============================================================================

  const anchorGroupId = (selectedSurface as any)?.surfaceGroupId as string | undefined | null;
  useEffect(() => {
    setScopeGroupIds(new Set(anchorGroupId ? [anchorGroupId] : []));
  }, [anchorGroupId]);

  const savePlacement = useCallback(async () => {
    if (!selectedSurface || !productImage) return;
    setIsSaving(true);
    setSaveSuccess(false);
    try {
      const res = await fetch("/api/placements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          videoId,
          surfaceId: selectedSurface.id,
          productId: selectedCatalogProduct?.id || null,
          productImageUrl: productImage,
          transform,
          blend,
          // Persist the creator's harmonize choice + the URL for the brand
          // preview. Render pipeline (Commit 3) will regenerate harmonization
          // per-frame when isHarmonized=true; this URL is the still preview.
          isHarmonized: harmonizeEnabled,
          harmonizedImageUrl: harmonizeEnabled ? liveHarmonizedUrl : null,
          // Frame-by-frame keyframes — only sent when the creator added
          // any. Empty array → backend stores null which falls back to
          // the constant `transform` at render time.
          keyframes: keyframes.length > 0 ? keyframes : null,
          // Explicit scope — exactly the canonical surfaces this placement
          // applies to. Omitted (legacy) when the anchor has no groupId.
          ...(anchorGroupId
            ? { appliesToGroupIds: Array.from(new Set([anchorGroupId, ...Array.from(scopeGroupIds)])) }
            : {}),
        }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        let errMsg = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(errBody);
          errMsg = parsed.error || parsed.message || errMsg;
        } catch {
          errMsg = errBody.length > 0 ? `${errMsg}: ${errBody.substring(0, 200)}` : errMsg;
        }
        throw new Error(errMsg);
      }
      const result = await res.json().catch(() => ({}));
      setSaveSuccess(true);
      const propagated = result.propagatedCount || 0;
      const scopeCount = anchorGroupId ? new Set([anchorGroupId, ...Array.from(scopeGroupIds)]).size : 0;
      toast({
        title: "Placement saved",
        description: anchorGroupId
          ? `Applies to exactly ${scopeCount} surface${scopeCount === 1 ? "" : "s"} — nowhere else.`
          : propagated > 0
          ? `Saved and auto-applied to ${propagated} matching scene${propagated > 1 ? 's' : ''} across the video.`
          : "Your placement has been saved and can be viewed in Saved Placements.",
      });
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      console.error("[PlacementPreview] Save failed:", err);
      toast({ title: "Save failed", description: err.message || "Unknown error", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  }, [selectedSurface, productImage, videoId, selectedCatalogProduct, transform, blend, toast, anchorGroupId, scopeGroupIds]);

  const surfacesWithFrames = surfaces.filter((s) => s.frameUrl);
  const hasProduct = !!productImage;

  if (!open) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="relative w-full max-w-6xl max-h-[90vh] bg-card border border-white/10 rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header — responsive: stacks on narrow screens */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between px-3 sm:px-6 py-2 sm:py-3 border-b border-white/10 gap-2">
              <div className="min-w-0">
                <h2 className="text-base sm:text-lg font-bold text-white truncate">Placement Preview</h2>
                <p className="text-xs sm:text-sm text-muted-foreground line-clamp-1">{videoTitle}</p>
              </div>
              <div className="flex items-center gap-1.5 sm:gap-3 flex-wrap shrink-0">
                <Button
                  size="sm"
                  variant="secondary"
                  className="gap-1.5 text-xs sm:text-sm h-8"
                  onClick={() => setShowBoundingBox(!showBoundingBox)}
                  title={showBoundingBox ? "Hide bounding box" : "Show bounding box"}
                >
                  {showBoundingBox ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  <span className="hidden sm:inline">{showBoundingBox ? "Hide" : "Show"} Box</span>
                </Button>
                {hasProduct && (
                  <>
                    <Button
                      size="sm"
                      variant={saveSuccess ? "default" : "secondary"}
                      className={cn("gap-1.5 text-xs sm:text-sm h-8", saveSuccess && "bg-emerald-600 hover:bg-emerald-700")}
                      onClick={savePlacement}
                      disabled={isSaving}
                    >
                      {isSaving ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : saveSuccess ? (
                        <CheckCircle className="w-3.5 h-3.5" />
                      ) : (
                        <Save className="w-3.5 h-3.5" />
                      )}
                      <span className="hidden sm:inline">{isSaving ? "Saving..." : saveSuccess ? "Saved" : "Save"}</span>
                      <span className="sm:hidden">{isSaving ? "..." : saveSuccess ? "✓" : "Save"}</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="gap-1.5 text-xs sm:text-sm h-8"
                      onClick={downloadPreview}
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Export Frame</span>
                    </Button>
                    {/* Harmonize: server-side compositing with scene-aware
                        lighting + contact shadow. Flat overlay (canvas) stays
                        as the baseline; this opens a side-by-side dialog. */}
                    {/* Remove Harmonize — visible when a harmonized result is
                        active. Lets the creator disable the harmonized overlay
                        so they can adjust position/scale on the flat canvas,
                        then re-click Harmonize to refresh, then Save to commit.
                        Round-trip flow: harmonize → review → remove → adjust
                        → harmonize → save. */}
                    {(harmonizeEnabled || liveHarmonizedUrl) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 text-xs sm:text-sm h-8 border-amber-600/50 text-amber-300 hover:bg-amber-950/40 hover:text-amber-200"
                        onClick={() => {
                          setHarmonizeEnabled(false);
                          setLiveHarmonizedUrl(null);
                          setHarmonizeError(null);
                        }}
                        data-testid="button-remove-harmonize"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Remove Harmonize</span>
                        <span className="sm:hidden">Revert</span>
                      </Button>
                    )}
                    {/* Two harmonize buttons:
                        - "Harmonize" (procedural, ~2s): scene-matched
                          brightness + contact shadow on the flat product
                          image. Fast iteration.
                        - "3D Harmonize" (ai-3d, ~30-90s): runs the product
                          image through TRELLIS to generate a 3D-aware render,
                          then layers procedural lighting on top. Use when
                          you want the product to read as a 3D object that
                          belongs in the room rather than a flat sticker. */}
                    <Button
                      size="sm"
                      variant="secondary"
                      className="gap-1.5 text-xs sm:text-sm h-8"
                      disabled={!selectedSurface || !productImage || isHarmonizing}
                      onClick={async () => {
                        if (!selectedSurface || !productImage) return;
                        setIsHarmonizing(true);
                        setHarmonizeError(null);
                        setHarmonizeFlatUrl(null);
                        setHarmonizeResultUrl(null);
                        setShowHarmonizeCompare(true);
                        // Progress bar bookkeeping — start timer at click,
                        // clear the prior "done" state.
                        setHarmonizeMode("auto");
                        setHarmonizeStartedAt(Date.now());
                        setHarmonizeDoneAt100(false);

                        // Build the bbox we send to the harmonize endpoint.
                        // Routed through the shared helper so this can never
                        // drift from the 3D Harmonize path or any future
                        // composite-by-bbox endpoint.
                        const productPlacementBbox = computeAspectCorrectPlacementBbox({
                          surface: selectedSurface,
                          productImg: productImgRef.current,
                          canvas: canvasRef.current,
                          frameSource: {
                            width: videoRef.current?.videoWidth || frameImgRef.current?.naturalWidth || 0,
                            height: videoRef.current?.videoHeight || frameImgRef.current?.naturalHeight || 0,
                          },
                          transform,
                          logTag: "Harmonize/client",
                        });

                        try {
                          const res = await fetch("/api/placement/harmonize", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            credentials: "include",
                            body: JSON.stringify({
                              surfaceId: selectedSurface.id,
                              productImageUrl: productImage,
                              productPlacementBbox,
                              // Default to "flat" — the bare composite the
                              // user already sees in the placement preview.
                              // No brightness/tint/shadow processing. User
                              // testing showed flat looks BETTER than any
                              // procedural or generative path so far (the
                              // procedural added a visible dark rectangle,
                              // generative regenerated wrong content).
                              // The 3D Harmonize button is the experimental
                              // AI path until Kontext is debugged.
                              mode: "flat",
                            }),
                          });
                          const data = await res.json();
                          if (!res.ok || !data.success) {
                            throw new Error(data.error || "Harmonization failed");
                          }
                          setHarmonizeFlatUrl(data.flatCompositeUrl || null);
                          setHarmonizeResultUrl(data.imageUrl || null);
                          // Seed the live overlay AND enable it so the canvas
                          // shows the harmonized result immediately.
                          setLiveHarmonizedUrl(data.imageUrl || null);
                          if (data.imageUrl) setHarmonizeEnabled(true);
                          // Append to rolling history so the user can re-apply
                          // this exact result later without rerunning.
                          if (data.imageUrl && productPlacementBbox) {
                            const next = appendHarmonizeHistory({
                              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                              timestamp: Date.now(),
                              mode: "auto",
                              surfaceId: selectedSurface.id,
                              productImageUrl: productImage,
                              resultImageUrl: data.imageUrl,
                              flatCompositeUrl: data.flatCompositeUrl || null,
                              bbox: productPlacementBbox,
                              transform: {
                                scale: transform.scale,
                                offsetX: transform.offsetX,
                                offsetY: transform.offsetY,
                                rotation: transform.rotation,
                                flipH: transform.flipH,
                              },
                              elapsedMs: typeof data.elapsedMs === "number" ? data.elapsedMs : 0,
                              videoFingerprint: fingerprintVideoSrc(videoSrc),
                            });
                            setHarmonizeHistory(next);
                          }
                          // Surface fallback warnings — the user asked for
                          // generative but Kontext failed; toast lets them
                          // know the better path didn't run and what they
                          // see is the procedural fallback.
                          if (data.fellBack && data.warning) {
                            toast({
                              title: "Fell back to procedural",
                              description: data.warning,
                              variant: "destructive",
                            });
                          } else if (data.mode === "generative") {
                            toast({
                              title: "Generative harmonize complete",
                              description: `FLUX Kontext, ${(data.elapsedMs / 1000).toFixed(1)}s`,
                            });
                          }
                        } catch (err: any) {
                          setHarmonizeError(err.message || "Harmonization failed");
                        } finally {
                          // Briefly show 100% so the bar visibly completes
                          // before the result panel takes over.
                          setHarmonizeDoneAt100(true);
                          setIsHarmonizing(false);
                          setHarmonizeStartedAt(null);
                          window.setTimeout(() => setHarmonizeMode(null), 600);
                        }
                      }}
                      data-testid="button-harmonize"
                    >
                      {isHarmonizing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      <span className="hidden sm:inline">{isHarmonizing ? "Harmonizing…" : "Harmonize"}</span>
                    </Button>
                    {/* 3D Harmonize: TRELLIS image→3D mesh + procedural lighting.
                        Slower (~30-90s) but produces a 3D-aware product render
                        that reads as belonging in the scene rather than pasted on. */}
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 text-xs sm:text-sm h-8 border-violet-500/50 text-violet-300 hover:bg-violet-950/40 hover:text-violet-200"
                      disabled={!selectedSurface || !productImage || isHarmonizing}
                      onClick={async () => {
                        if (!selectedSurface || !productImage) return;
                        setIsHarmonizing(true);
                        setHarmonizeError(null);
                        setHarmonizeFlatUrl(null);
                        setHarmonizeResultUrl(null);
                        setShowHarmonizeCompare(true);
                        // 3D mode has a much longer expected duration — the
                        // progress bar tunes its pace from this mode tag.
                        setHarmonizeMode("ai-3d");
                        setHarmonizeStartedAt(Date.now());
                        setHarmonizeDoneAt100(false);

                        // 3D Harmonize bbox — same shared helper as the
                        // regular Harmonize button. Single source of truth
                        // so neither path can drift from the other again.
                        const productPlacementBbox = computeAspectCorrectPlacementBbox({
                          surface: selectedSurface,
                          productImg: productImgRef.current,
                          canvas: canvasRef.current,
                          frameSource: {
                            width: videoRef.current?.videoWidth || frameImgRef.current?.naturalWidth || 0,
                            height: videoRef.current?.videoHeight || frameImgRef.current?.naturalHeight || 0,
                          },
                          transform,
                          logTag: "Harmonize3D/client",
                        });

                        try {
                          const res = await fetch("/api/placement/harmonize", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            credentials: "include",
                            body: JSON.stringify({
                              surfaceId: selectedSurface.id,
                              productImageUrl: productImage,
                              productPlacementBbox,
                              mode: "ai-3d",
                            }),
                          });
                          const data = await res.json();
                          if (!res.ok || !data.success) {
                            throw new Error(data.error || "3D Harmonization failed");
                          }
                          setHarmonizeFlatUrl(data.flatCompositeUrl || null);
                          setHarmonizeResultUrl(data.imageUrl || null);
                          setLiveHarmonizedUrl(data.imageUrl || null);
                          if (data.imageUrl) setHarmonizeEnabled(true);
                          // Append to rolling history — same shape as the
                          // regular Harmonize button, just mode="ai-3d".
                          if (data.imageUrl && productPlacementBbox) {
                            const next = appendHarmonizeHistory({
                              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                              timestamp: Date.now(),
                              mode: "ai-3d",
                              surfaceId: selectedSurface.id,
                              productImageUrl: productImage,
                              resultImageUrl: data.imageUrl,
                              flatCompositeUrl: data.flatCompositeUrl || null,
                              bbox: productPlacementBbox,
                              transform: {
                                scale: transform.scale,
                                offsetX: transform.offsetX,
                                offsetY: transform.offsetY,
                                rotation: transform.rotation,
                                flipH: transform.flipH,
                              },
                              elapsedMs: typeof data.elapsedMs === "number" ? data.elapsedMs : 0,
                              videoFingerprint: fingerprintVideoSrc(videoSrc),
                            });
                            setHarmonizeHistory(next);
                          }
                        } catch (err: any) {
                          setHarmonizeError(err.message || "3D Harmonization failed");
                        } finally {
                          setHarmonizeDoneAt100(true);
                          setIsHarmonizing(false);
                          setHarmonizeStartedAt(null);
                          window.setTimeout(() => setHarmonizeMode(null), 600);
                        }
                      }}
                      data-testid="button-harmonize-3d"
                      title="Generate a 3D mesh of the product (TRELLIS) and composite it with scene lighting. Takes ~30-90s but reads as a real 3D object in the room."
                    >
                      {isHarmonizing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      <span className="hidden sm:inline">{isHarmonizing ? "3D…" : "3D Harmonize"}</span>
                    </Button>
                    {videoSrc && (
                      exportStatus === "complete" && exportOutputUrl ? (
                        <a href={`/api/exports/${exportJobId}/download`} download>
                          <Button size="sm" className="gap-1.5 text-xs sm:text-sm h-8 bg-emerald-600 hover:bg-emerald-700">
                            <Download className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Download MP4</span>
                            <span className="sm:hidden">MP4</span>
                          </Button>
                        </a>
                      ) : isExporting ? (
                        <Button size="sm" className="gap-1.5 text-xs h-8" disabled>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          {exportProgress}%
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          className="gap-1.5 text-xs sm:text-sm h-8 bg-green-600 hover:bg-green-700"
                          onClick={handleVideoExport}
                          disabled={exportStatus === "failed"}
                        >
                          <Film className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Export Video</span>
                          <span className="sm:hidden">Video</span>
                        </Button>
                      )
                    )}
                  </>
                )}
                <button
                  onClick={onClose}
                  className="p-1.5 sm:p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
                >
                  <X className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>
              </div>
            </div>

            <div className="flex flex-col md:flex-row overflow-hidden" style={{ height: "calc(90vh - 70px)" }}>
              {/* Main canvas area */}
              <div className="flex-1 min-w-0 flex flex-col p-2 sm:p-4">
                <div
                  ref={canvasContainerRef}
                  className="relative flex-1 bg-black rounded-lg overflow-hidden flex items-center justify-center"
                  style={{ minHeight: "200px" }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
                  onMouseEnter={() => setIsHoveringCanvas(true)}
                  onMouseLeave={() => setIsHoveringCanvas(false)}
                >
                  <canvas
                    ref={canvasRef}
                    className={cn(
                      "max-w-full max-h-full rounded-lg",
                      hasProduct && dragMode !== "none" ? "cursor-grabbing" :
                      hasProduct ? "cursor-crosshair" : "cursor-default"
                    )}
                    onMouseDown={handleCanvasMouseDown}
                    onMouseMove={handleCanvasMouseMove}
                    onMouseUp={handleCanvasMouseUp}
                    onMouseLeave={handleCanvasMouseUp}
                    style={isVideoMode ? { pointerEvents: "none" } : undefined}
                  />

                  {/* Live-harmonized overlay. When the toggle is on AND we have
                      a fresh harmonized result AND the user isn't actively
                      dragging, show this image stretched to match the canvas.
                      We deliberately let it sit OVER the canvas (not replace it)
                      so the underlying canvas still receives interaction
                      events for drag/scale/rotate — pointer-events:none on the
                      overlay routes clicks to the canvas underneath.
                      Three opacity tiers so the user can both SEE the
                      harmonized result and FIND the bbox handles:
                        • full opacity when idle (mouse not over canvas)
                        • ~25% on hover (handles + bbox visible underneath)
                        • 0 during active drag (clean adjustment) */}
                  {harmonizeEnabled && liveHarmonizedUrl && !isVideoMode && (
                    <img
                      src={liveHarmonizedUrl}
                      alt="Harmonized placement preview"
                      className={cn(
                        "absolute inset-0 m-auto max-w-full max-h-full rounded-lg pointer-events-none transition-opacity duration-150",
                        isInteractingWithCanvas || dragMode !== "none" ? "opacity-0" :
                        isHoveringCanvas ? "opacity-25" : "opacity-100",
                      )}
                      style={{ objectFit: "contain" }}
                      data-testid="img-harmonized-overlay"
                    />
                  )}

                  {/* Hover hint when harmonized — tells the creator they can
                      drag/scale to adjust, then re-harmonize. */}
                  {harmonizeEnabled && liveHarmonizedUrl && !isVideoMode && isHoveringCanvas && dragMode === "none" && (
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 pointer-events-none rounded-md bg-black/70 backdrop-blur px-3 py-1 text-xs text-zinc-200">
                      Drag the box to adjust — re-click <span className="text-emerald-300 font-medium">Harmonize</span> to refresh
                    </div>
                  )}

                  {/* Subtle harmonize-status pill in the bottom-left of the
                      canvas. Tells the user what they're looking at without
                      taking up button-bar space. */}
                  {hasProduct && (
                    <div className="absolute bottom-2 left-2 z-10 flex items-center gap-2 rounded-md bg-black/70 backdrop-blur px-2 py-1">
                      <button
                        type="button"
                        onClick={() => setHarmonizeEnabled(v => !v)}
                        className={cn(
                          "flex items-center gap-1.5 text-xs font-medium transition-colors",
                          harmonizeEnabled ? "text-emerald-300" : "text-zinc-400 hover:text-zinc-200"
                        )}
                        data-testid="button-toggle-live-harmonize"
                      >
                        <Sparkles className="w-3 h-3" />
                        {harmonizeEnabled ? "Harmonized" : "Flat"}
                      </button>
                      {harmonizeEnabled && isHarmonizing && (
                        <div className="flex items-center gap-1.5 text-emerald-300">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span className="text-[10px] tabular-nums">
                            {Math.round(
                              computeHarmonizeProgress(harmonizeMode, harmonizeElapsedMs, harmonizeDoneAt100).percent,
                            )}%
                          </span>
                        </div>
                      )}
                      {harmonizeEnabled && harmonizeError && (
                        <span className="text-xs text-red-300" title={harmonizeError}>!</span>
                      )}
                    </div>
                  )}

                    {/* Hidden video element for playback mode */}
                  {videoSrc && (
                    <video
                      ref={videoRef}
                      src={videoSrc}
                      className="hidden"
                      muted
                      playsInline
                      onLoadedMetadata={(e) => {
                        setVideoDuration((e.target as HTMLVideoElement).duration);
                      }}
                      onEnded={() => {
                        setIsVideoPlaying(false);
                      }}
                      onError={() => {
                        console.error("[PlacementPreview] Video failed to load:", videoSrc);
                      }}
                    />
                  )}

                  {/* Video playback controls overlay */}
                  {hasProduct && videoSrc && (
                    <div className="absolute bottom-0 left-0 right-0 flex items-center gap-1.5 sm:gap-2 z-20 px-3 py-2.5 bg-gradient-to-t from-black/80 via-black/50 to-transparent" style={{ pointerEvents: "auto" }}>
                      <Button
                        size="sm"
                        variant={isVideoPlaying ? "default" : "secondary"}
                        className="gap-1 sm:gap-1.5 h-7 sm:h-8 px-2 sm:px-3 text-xs bg-black/70 hover:bg-black/90 border border-white/20 text-white"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleVideoPlayback();
                        }}
                      >
                        {isVideoPlaying ? (
                          <><Pause className="w-3 h-3 sm:w-3.5 sm:h-3.5" /> <span className="hidden sm:inline">Pause</span></>
                        ) : (
                          <><Play className="w-3 h-3 sm:w-3.5 sm:h-3.5" /> <span className="hidden sm:inline">{isVideoMode ? "Resume" : "Play Video"}</span></>
                        )}
                      </Button>
                      {isVideoMode && (
                        <>
                          {/* Custom seek bar — wide hit area, visible track, drag support */}
                          <div
                            className="flex-1 relative h-8 flex items-center cursor-pointer group"
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                              const time = pct * (videoDuration || 1);
                              if (videoRef.current) {
                                videoRef.current.currentTime = time;
                                setVideoCurrentTime(time);
                                // Reset tracking state so product snaps to correct position
                                const tracking = trackingRef.current;
                                tracking.initialized = false;
                                tracking.prevFrameData = null;
                                tracking.cumulativeOffsetX = 0;
                                tracking.cumulativeOffsetY = 0;
                                tracking.displayOffsetX = 0;
                                tracking.displayOffsetY = 0;
                                tracking.displayOffsetW = 0;
                                tracking.displayOffsetH = 0;
                                tracking.velocityX = 0;
                                tracking.velocityY = 0;
                              }
                            }}
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              const bar = e.currentTarget;
                              const seek = (ev: MouseEvent) => {
                                const rect = bar.getBoundingClientRect();
                                const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
                                const time = pct * (videoDuration || 1);
                                if (videoRef.current) {
                                  videoRef.current.currentTime = time;
                                  setVideoCurrentTime(time);
                                }
                              };
                              const up = () => {
                                window.removeEventListener("mousemove", seek);
                                window.removeEventListener("mouseup", up);
                                // Reset tracking after drag
                                const tracking = trackingRef.current;
                                tracking.initialized = false;
                                tracking.prevFrameData = null;
                                tracking.velocityX = 0;
                                tracking.velocityY = 0;
                              };
                              window.addEventListener("mousemove", seek);
                              window.addEventListener("mouseup", up);
                            }}
                          >
                            {/* Track background */}
                            <div className="absolute left-0 right-0 h-2 bg-white/30 rounded-full group-hover:h-3 transition-all">
                              {/* Progress fill */}
                              <div
                                className="h-full bg-purple-500 rounded-full relative"
                                style={{ width: `${videoDuration ? (videoCurrentTime / videoDuration) * 100 : 0}%` }}
                              >
                                {/* Thumb indicator — always visible */}
                                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg border-2 border-purple-500 transition-transform group-hover:scale-110" />
                              </div>
                            </div>
                          </div>
                          <span className="text-[10px] text-white/70 tabular-nums min-w-[60px] text-right">
                            {Math.floor(videoCurrentTime / 60)}:{String(Math.floor(videoCurrentTime % 60)).padStart(2, "0")}
                            {" / "}
                            {Math.floor(videoDuration / 60)}:{String(Math.floor(videoDuration % 60)).padStart(2, "0")}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1.5 text-white/60 hover:text-white"
                            onClick={(e) => {
                              e.stopPropagation();
                              stopVideoPlayback();
                            }}
                            title="Stop and return to frame view"
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </>
                      )}
                    </div>
                  )}

                  {/* Overlay hint when no frame */}
                  {!selectedSurface?.frameUrl && !isVideoMode && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="text-center text-muted-foreground">
                        <ImageIcon className="w-12 h-12 mx-auto mb-2 opacity-50" />
                        <p>Select a surface to preview</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Frame-by-frame keyframe timeline. Visible during video
                    playback when a product is loaded. Lets the creator pin
                    the product to specific moments for accuracy when motion
                    tracking drifts. Diamond markers represent keyframes;
                    drag to reposition in time, click to seek. */}
                {isVideoMode && videoDuration > 0 && productImage && (
                  <div className="mt-3 p-3 bg-black/30 rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-muted-foreground">
                        Frame-by-frame edit
                        {keyframes.length > 0 && (
                          <span className="ml-1 text-white/70">
                            · {keyframes.length} keyframe{keyframes.length !== 1 ? "s" : ""}
                          </span>
                        )}
                      </p>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-6 text-[10px] px-2 gap-1"
                          onClick={() => {
                            // Capture current transform at current playback time
                            const t = videoCurrentTime;
                            const exists = keyframes.find((k) => Math.abs(k.t - t) < 0.05);
                            if (exists) {
                              // Update existing keyframe at this time
                              setKeyframes((prev) =>
                                prev.map((k) =>
                                  Math.abs(k.t - t) < 0.05
                                    ? { t, transform: { ...transform } }
                                    : k,
                                ).sort((a, b) => a.t - b.t),
                              );
                              toast({ title: "Keyframe updated", description: `at ${t.toFixed(2)}s` });
                            } else {
                              setKeyframes((prev) =>
                                [...prev, { t, transform: { ...transform } }].sort((a, b) => a.t - b.t),
                              );
                              toast({ title: "Keyframe added", description: `at ${t.toFixed(2)}s` });
                            }
                          }}
                        >
                          + Keyframe
                        </Button>
                        {keyframes.length > 0 && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 text-[10px] px-2 text-muted-foreground"
                            onClick={() => {
                              setKeyframes([]);
                              toast({ title: "Keyframes cleared" });
                            }}
                          >
                            Clear
                          </Button>
                        )}
                      </div>
                    </div>
                    {/* Timeline strip */}
                    <div
                      className="relative h-6 bg-black/40 rounded cursor-pointer overflow-hidden"
                      onClick={(e) => {
                        if (!videoRef.current) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const u = (e.clientX - rect.left) / rect.width;
                        const t = Math.max(0, Math.min(videoDuration, u * videoDuration));
                        videoRef.current.currentTime = t;
                        setVideoCurrentTime(t);
                      }}
                    >
                      {/* Playhead */}
                      <div
                        className="absolute top-0 bottom-0 w-px bg-white/80 pointer-events-none"
                        style={{ left: `${(videoCurrentTime / videoDuration) * 100}%` }}
                      />
                      {/* Keyframe diamond markers */}
                      {keyframes.map((kf, i) => (
                        <div
                          key={i}
                          className="absolute top-1/2 w-3 h-3 bg-amber-400 rotate-45 -translate-x-1/2 -translate-y-1/2 ring-1 ring-black/60 hover:bg-amber-300 cursor-pointer"
                          style={{ left: `${(kf.t / videoDuration) * 100}%` }}
                          onClick={(e) => {
                            e.stopPropagation();
                            // Single click = seek to this keyframe
                            if (videoRef.current) {
                              videoRef.current.currentTime = kf.t;
                              setVideoCurrentTime(kf.t);
                            }
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            // Double click = delete this keyframe
                            setKeyframes((prev) => prev.filter((_, j) => j !== i));
                            toast({ title: "Keyframe removed", description: `at ${kf.t.toFixed(2)}s` });
                          }}
                          title={`Keyframe @ ${kf.t.toFixed(2)}s — click to seek, double-click to delete`}
                        />
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1 leading-tight">
                      Pause, drag the product into position, then click <span className="text-amber-400">+ Keyframe</span> to pin
                      it. Playback interpolates between keyframes for smooth motion. Click a diamond to seek; double-click to delete.
                    </p>
                  </div>
                )}

                {/* Surface selector strip */}
                {surfacesWithFrames.length > 1 && (
                  <div className="mt-3 p-2 bg-black/30 rounded-lg">
                    <p className="text-xs text-muted-foreground mb-2">Select surface:</p>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {surfacesWithFrames.map((surface) => (
                        <button
                          key={surface.id}
                          onClick={() => {
                            // Same-scene jump: keep product + transform so
                            // an unsaved drop at :08 still shows on :46.
                            // Different-scene jump: clear EVERYTHING — the
                            // user is now editing a placement in a different
                            // physical scene, the old product/transform/blend
                            // don't apply. Without this clear the product
                            // visually re-renders on the new surface's bbox
                            // (looks like the product "moved" — the
                            // user's exact complaint).
                            const prevSceneId = (selectedSurface as any)?.sceneId;
                            const nextSceneId = (surface as any)?.sceneId;
                            const sameScene =
                              typeof prevSceneId === "number" &&
                              typeof nextSceneId === "number" &&
                              prevSceneId === nextSceneId;

                            setSelectedSurface(surface);
                            if (!sameScene) {
                              setProductImage(null);
                              setProductFile(null);
                              setSelectedCatalogProduct(null);
                              productImgRef.current = null;
                              setTransform({ ...DEFAULT_TRANSFORM });
                              setBlend(getAutoBlendDefaults(surface));
                            }
                            // The loadExistingPlacement effect runs next
                            // (driven by selectedSurface.id change) and
                            // restores any saved scene_match for the new
                            // surface — so a previously SAVED placement on
                            // this scene reloads automatically.
                          }}
                          className={`relative flex-shrink-0 w-20 h-14 rounded-md overflow-hidden border-2 transition-all ${
                            selectedSurface?.id === surface.id
                              ? "border-primary ring-2 ring-primary/30"
                              : "border-white/20 hover:border-white/40"
                          }`}
                        >
                          <img
                            src={surface.frameUrl!}
                            alt={`Surface ${surface.surfaceType}`}
                            className="w-full h-full object-cover"
                          />
                          {/* Scope checkbox — is this canonical surface in
                              the placement's applies-to list? The anchor's
                              own group is always included (disabled+checked);
                              legacy surfaces without a groupId can't be
                              scoped. stopPropagation so toggling doesn't
                              also switch the editing anchor. */}
                          {(() => {
                            const gid = (surface as any).surfaceGroupId as string | undefined | null;
                            const isAnchorGroup = !!gid && gid === anchorGroupId;
                            const checked = !!gid && (scopeGroupIds.has(gid) || isAnchorGroup);
                            return (
                              <span
                                role="checkbox"
                                aria-checked={checked}
                                title={!gid ? "Legacy detection — cannot be scoped" : isAnchorGroup ? "Anchor surface — always included" : checked ? "Included in placement scope" : "Excluded from placement scope"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!gid || isAnchorGroup) return;
                                  setScopeGroupIds((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(gid)) next.delete(gid);
                                    else next.add(gid);
                                    return next;
                                  });
                                }}
                                className={`absolute top-1 right-1 w-3.5 h-3.5 rounded-sm border flex items-center justify-center text-[9px] leading-none ${
                                  !gid
                                    ? "border-white/20 bg-black/40 text-transparent cursor-not-allowed"
                                    : checked
                                    ? "border-emerald-400 bg-emerald-500/90 text-black"
                                    : "border-white/50 bg-black/50 text-transparent"
                                } ${isAnchorGroup ? "opacity-70" : "cursor-pointer"}`}
                                data-testid={`scope-checkbox-${surface.id}`}
                              >
                                ✓
                              </span>
                            );
                          })()}
                          {/* Scene indicator dot — color cycles per sceneId
                              so the user can see at a glance which thumbs
                              belong to the same physical scene. Click into
                              same-color dots = placement persists. Click
                              into a different color = product clears (the
                              "different scene" rule the data layer
                              enforces). */}
                          {typeof (surface as any).sceneId === "number" && (
                            <span
                              className="absolute top-1 left-1 w-2.5 h-2.5 rounded-full ring-1 ring-black/60"
                              style={{
                                backgroundColor: [
                                  "#a78bfa", // purple — scene 0
                                  "#34d399", // green  — scene 1
                                  "#fbbf24", // amber  — scene 2
                                  "#f87171", // red    — scene 3
                                  "#60a5fa", // blue   — scene 4
                                  "#f472b6", // pink   — scene 5
                                ][((surface as any).sceneId as number) % 6],
                              }}
                              title={`Scene ${(surface as any).sceneId}`}
                            />
                          )}
                          <span className="absolute bottom-0 left-0 right-0 bg-black/70 text-[8px] text-white text-center py-0.5">
                            {surface.surfaceType}
                          </span>
                        </button>
                      ))}
                    </div>
                    {anchorGroupId && (
                      <p className="text-[10px] text-muted-foreground mt-1.5">
                        Product applies to {new Set([anchorGroupId, ...Array.from(scopeGroupIds)]).size} checked surface{new Set([anchorGroupId, ...Array.from(scopeGroupIds)]).size === 1 ? "" : "s"} — check others to include them, e.g. the same table in another scene.
                      </p>
                    )}
                  </div>
                )}

                {/* Interaction hint */}
                {hasProduct && (
                  <div className="mt-2 text-center px-2">
                    <p className="text-[10px] text-muted-foreground">
                      {isDenseScanning
                        ? "Analyzing video frames... Product tracking will improve once complete."
                        : isVideoMode && motionData?.source === "gemini-keyframes"
                        ? "Playing with AI surface tracking — product follows the physical surface"
                        : isVideoMode
                        ? "Playing with camera motion tracking — product follows camera movement"
                        : "Drag to move | Corner handles to resize | Orange dot to rotate | Play to preview"
                      }
                    </p>
                    {isDenseScanning && (
                      <div className="flex items-center justify-center gap-1.5 mt-1">
                        <Loader2 className="w-3 h-3 animate-spin text-primary" />
                        <span className="text-[10px] text-primary">Scanning frames for surface tracking...</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Right panel — Tool panels */}
              <div className="md:w-72 lg:w-80 flex-shrink-0 bg-gradient-to-b from-card to-secondary/20 border-t md:border-t-0 md:border-l border-white/10 flex flex-col overflow-hidden max-h-[40vh] md:max-h-none">
                {/* Panel tabs */}
                <div className="flex border-b border-white/10">
                  {[
                    { id: "product" as ToolPanel, icon: Package, label: "Product" },
                    { id: "transform" as ToolPanel, icon: Move, label: "Transform" },
                    { id: "blend" as ToolPanel, icon: Blend, label: "Blend" },
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setToolPanel(tab.id)}
                      className={cn(
                        "flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors border-b-2",
                        toolPanel === tab.id
                          ? "border-primary text-primary"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <tab.icon className="w-3.5 h-3.5" />
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-y-auto">
                  {/* ============ PRODUCT PANEL ============ */}
                  {toolPanel === "product" && (
                    <div className="p-4 space-y-4">
                      {/* Surface info */}
                      {selectedSurface && (
                        <div className="p-3 rounded-xl bg-white/5 border border-white/10">
                          <div className="flex items-center gap-2 mb-2">
                            <Target className="w-4 h-4 text-primary" />
                            <span className="text-sm font-medium text-white">Selected Surface</span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <Badge variant="secondary" className="text-xs">
                              {selectedSurface.surfaceType}
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              <Clock className="w-3 h-3 mr-1" />
                              {Math.floor(selectedSurface.timestamp / 60)}:
                              {String(Math.floor(selectedSurface.timestamp) % 60).padStart(2, "0")}
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              {Math.round(selectedSurface.confidence * 100)}%
                            </Badge>
                          </div>
                          {selectedSurface.sceneContext && (
                            <p className="text-xs text-muted-foreground mt-2">
                              {selectedSurface.sceneContext}
                            </p>
                          )}
                        </div>
                      )}

                      {/* Product image — tabbed: Upload / Catalog */}
                      <div>
                        <label className="text-sm font-medium text-white mb-2 block">
                          Product Image
                        </label>

                        {/* Tab switcher */}
                        <div className="flex rounded-lg bg-black/30 p-0.5 mb-3">
                          <button
                            onClick={() => setProductTab("upload")}
                            className={`flex-1 text-xs py-1.5 px-2 rounded-md transition-colors flex items-center justify-center gap-1.5 ${
                              productTab === "upload"
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:text-white"
                            }`}
                          >
                            <Upload className="w-3 h-3" />
                            Upload
                          </button>
                          <button
                            onClick={() => setProductTab("catalog")}
                            className={`flex-1 text-xs py-1.5 px-2 rounded-md transition-colors flex items-center justify-center gap-1.5 ${
                              productTab === "catalog"
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:text-white"
                            }`}
                          >
                            <Package className="w-3 h-3" />
                            Catalog
                            {catalogProducts && catalogProducts.length > 0 && (
                              <span className="text-[9px] bg-white/20 rounded-full px-1.5">
                                {catalogProducts.length}
                              </span>
                            )}
                          </button>
                        </div>

                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*"
                          onChange={handleFileUpload}
                          className="hidden"
                        />

                        {/* Selected product preview */}
                        {productImage ? (
                          <div className="relative">
                            <div className="w-full h-24 rounded-lg overflow-hidden border border-white/10 bg-black/30">
                              <img
                                src={productImage}
                                alt="Product"
                                className="w-full h-full object-contain"
                              />
                            </div>
                            {selectedCatalogProduct && (
                              <p className="text-[10px] text-muted-foreground mt-1 truncate">
                                {selectedCatalogProduct.name}
                              </p>
                            )}
                            <div className="flex gap-2 mt-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="flex-1 text-xs"
                                onClick={() => {
                                  if (productTab === "upload") {
                                    fileInputRef.current?.click();
                                  } else {
                                    resetPreview();
                                  }
                                }}
                              >
                                Change
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-xs text-red-400 hover:text-red-300"
                                onClick={resetPreview}
                              >
                                <RotateCcw className="w-3 h-3 mr-1" />
                                Reset
                              </Button>
                            </div>
                          </div>
                        ) : productTab === "upload" ? (
                          <div
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={handleDrop}
                            onClick={() => fileInputRef.current?.click()}
                            className="w-full h-28 rounded-lg border-2 border-dashed border-white/20 hover:border-primary/50 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors bg-black/20"
                          >
                            <Upload className="w-5 h-5 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">
                              Drop or click to upload
                            </span>
                            <span className="text-[10px] text-muted-foreground/60">
                              PNG, JPG, SVG
                            </span>
                          </div>
                        ) : (
                          <div className="max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-black/20">
                            {!catalogProducts || catalogProducts.length === 0 ? (
                              <div className="p-4 text-center">
                                <Package className="w-6 h-6 text-muted-foreground mx-auto mb-1.5" />
                                <p className="text-xs text-muted-foreground">No products in catalog</p>
                                <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                                  Brands can upload products in Product Catalog
                                </p>
                              </div>
                            ) : (
                              <div className="grid grid-cols-3 gap-1.5 p-1.5">
                                {catalogProducts.map((product) => (
                                  <button
                                    key={product.id}
                                    onClick={() => selectCatalogProduct(product)}
                                    className={`relative aspect-square rounded-md overflow-hidden border-2 transition-all ${
                                      selectedCatalogProduct?.id === product.id
                                        ? "border-primary ring-1 ring-primary/30"
                                        : "border-white/10 hover:border-white/30"
                                    }`}
                                    title={product.name}
                                  >
                                    <img
                                      src={product.thumbnailUrl || product.imageUrl}
                                      alt={product.name}
                                      className="w-full h-full object-contain bg-white/5 p-1"
                                    />
                                    {product.isTransparent && (
                                      <CheckCircle className="absolute top-0.5 right-0.5 w-3 h-3 text-green-400" />
                                    )}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* How it works */}
                      {!productImage && (
                        <div className="p-3 rounded-xl bg-white/5 border border-white/10">
                          <h4 className="text-xs font-medium text-white mb-2">How it works</h4>
                          <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
                            <li>Select an ad surface from the video</li>
                            <li>Upload your product or brand image</li>
                            <li>Drag to reposition, resize, and rotate</li>
                            <li>Adjust blend, shadow, and lighting</li>
                            <li>Export the final mockup</li>
                          </ol>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ============ TRANSFORM PANEL ============ */}
                  {toolPanel === "transform" && (
                    <div className="p-4 space-y-5">
                      {!hasProduct ? (
                        <div className="text-center py-8">
                          <Move className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                          <p className="text-xs text-muted-foreground">
                            Upload a product first
                          </p>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center justify-between">
                            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Transform</h3>
                            <button onClick={resetTransform} className="text-[10px] text-primary hover:underline">Reset</button>
                          </div>

                          {/* Tip */}
                          <div className="px-3 py-2 rounded-lg bg-primary/5 border border-primary/10">
                            <p className="text-[10px] text-primary/80">
                              Drag on the canvas to reposition. Drag corners to resize. Drag the orange dot to rotate.
                            </p>
                          </div>

                          {/* Position offset */}
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Move className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="text-xs text-muted-foreground">Position</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <label className="space-y-1">
                                <span className="text-[10px] text-muted-foreground">X Offset</span>
                                <input
                                  type="range" min={-300} max={300} value={transform.offsetX}
                                  onChange={e => updateTransform("offsetX", parseInt(e.target.value))}
                                  className="w-full h-1 accent-primary"
                                />
                                <span className="text-[10px] text-muted-foreground tabular-nums block text-center">
                                  {Math.round(transform.offsetX)}px
                                </span>
                              </label>
                              <label className="space-y-1">
                                <span className="text-[10px] text-muted-foreground">Y Offset</span>
                                <input
                                  type="range" min={-300} max={300} value={transform.offsetY}
                                  onChange={e => updateTransform("offsetY", parseInt(e.target.value))}
                                  className="w-full h-1 accent-primary"
                                />
                                <span className="text-[10px] text-muted-foreground tabular-nums block text-center">
                                  {Math.round(transform.offsetY)}px
                                </span>
                              </label>
                            </div>
                          </div>

                          {/* Scale */}
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Maximize2 className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="text-xs text-muted-foreground">Scale</span>
                              <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                                {(transform.scale * 100).toFixed(0)}%
                              </span>
                            </div>
                            <input
                              type="range" min={10} max={400} value={transform.scale * 100}
                              onChange={e => updateTransform("scale", parseInt(e.target.value) / 100)}
                              className="w-full h-1.5 accent-primary"
                            />
                          </div>

                          {/* Rotation */}
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <RotateCw className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="text-xs text-muted-foreground">Rotation</span>
                              <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                                {transform.rotation.toFixed(0)}°
                              </span>
                            </div>
                            <input
                              type="range" min={-180} max={180} value={transform.rotation}
                              onChange={e => updateTransform("rotation", parseInt(e.target.value))}
                              className="w-full h-1.5 accent-primary"
                            />
                          </div>

                          {/* Flip */}
                          <button
                            onClick={() => updateTransform("flipH", !transform.flipH)}
                            className={cn(
                              "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium w-full transition-colors border",
                              transform.flipH
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border text-muted-foreground hover:bg-muted"
                            )}
                          >
                            <FlipHorizontal className="w-3.5 h-3.5" />
                            Flip Horizontal
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {/* ============ BLEND PANEL ============ */}
                  {toolPanel === "blend" && (
                    <div className="p-4 space-y-5">
                      {!hasProduct ? (
                        <div className="text-center py-8">
                          <Blend className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                          <p className="text-xs text-muted-foreground">
                            Upload a product first
                          </p>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center justify-between">
                            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Integration</h3>
                            <button onClick={resetBlend} className="text-[10px] text-primary hover:underline">Reset</button>
                          </div>

                          {/* Scene analysis info badge */}
                          {selectedSurface?.lightingDirection && (
                            <div className="px-3 py-2 rounded-lg bg-emerald-500/5 border border-emerald-500/15">
                              <p className="text-[10px] text-emerald-400/80 font-medium mb-1">Auto-tuned from scene analysis</p>
                              <div className="flex flex-wrap gap-1.5">
                                <span className="text-[9px] bg-emerald-500/10 text-emerald-400/70 px-1.5 py-0.5 rounded">
                                  Light: {selectedSurface.lightingDirection}
                                </span>
                                {selectedSurface.lightingIntensity != null && (
                                  <span className="text-[9px] bg-emerald-500/10 text-emerald-400/70 px-1.5 py-0.5 rounded">
                                    Intensity: {Math.round(selectedSurface.lightingIntensity * 100)}%
                                  </span>
                                )}
                                {selectedSurface.cameraAngle && (
                                  <span className="text-[9px] bg-emerald-500/10 text-emerald-400/70 px-1.5 py-0.5 rounded">
                                    Camera: {selectedSurface.cameraAngle}
                                  </span>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Opacity */}
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="text-xs text-muted-foreground">Opacity</span>
                              <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                                {blend.opacity}%
                              </span>
                            </div>
                            <input
                              type="range" min={5} max={100} value={blend.opacity}
                              onChange={e => updateBlend("opacity", parseInt(e.target.value))}
                              className="w-full h-1.5 accent-primary"
                            />
                          </div>

                          {/* Blend mode */}
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Blend className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="text-xs text-muted-foreground">Blend Mode</span>
                            </div>
                            <select
                              value={blend.blendMode}
                              onChange={e => updateBlend("blendMode", e.target.value)}
                              className="w-full px-3 py-2 rounded-lg bg-muted border border-border text-xs text-foreground"
                            >
                              {BLEND_MODES.map(bm => (
                                <option key={bm.value} value={bm.value}>{bm.label}</option>
                              ))}
                            </select>
                          </div>

                          {/* Shadow */}
                          <div className="space-y-2">
                            <button
                              onClick={() => updateBlend("shadowEnabled", !blend.shadowEnabled)}
                              className={cn(
                                "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium w-full transition-colors border",
                                blend.shadowEnabled
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-border text-muted-foreground hover:bg-muted"
                              )}
                            >
                              <Droplets className="w-3.5 h-3.5" />
                              Drop Shadow
                            </button>

                            {blend.shadowEnabled && (
                              <div className="space-y-2 pl-2 border-l-2 border-primary/20 ml-2">
                                <label className="space-y-1">
                                  <span className="text-[10px] text-muted-foreground">Blur: {blend.shadowBlur}px</span>
                                  <input
                                    type="range" min={0} max={40} value={blend.shadowBlur}
                                    onChange={e => updateBlend("shadowBlur", parseInt(e.target.value))}
                                    className="w-full h-1 accent-primary"
                                  />
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                  <label className="space-y-1">
                                    <span className="text-[10px] text-muted-foreground">X: {blend.shadowOffsetX}</span>
                                    <input
                                      type="range" min={-20} max={20} value={blend.shadowOffsetX}
                                      onChange={e => updateBlend("shadowOffsetX", parseInt(e.target.value))}
                                      className="w-full h-1 accent-primary"
                                    />
                                  </label>
                                  <label className="space-y-1">
                                    <span className="text-[10px] text-muted-foreground">Y: {blend.shadowOffsetY}</span>
                                    <input
                                      type="range" min={-20} max={20} value={blend.shadowOffsetY}
                                      onChange={e => updateBlend("shadowOffsetY", parseInt(e.target.value))}
                                      className="w-full h-1 accent-primary"
                                    />
                                  </label>
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Edge Feathering */}
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">Edge Feather</span>
                              <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                                {blend.featherRadius}px
                              </span>
                            </div>
                            <input
                              type="range" min={0} max={20} value={blend.featherRadius}
                              onChange={e => updateBlend("featherRadius", parseInt(e.target.value))}
                              className="w-full h-1.5 accent-primary"
                            />
                          </div>

                          {/* Brightness / Contrast */}
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Sun className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="text-xs text-muted-foreground">Lighting</span>
                            </div>
                            <label className="space-y-1">
                              <span className="text-[10px] text-muted-foreground">
                                Brightness: {blend.brightness > 0 ? "+" : ""}{blend.brightness}
                              </span>
                              <input
                                type="range" min={-50} max={50} value={blend.brightness}
                                onChange={e => updateBlend("brightness", parseInt(e.target.value))}
                                className="w-full h-1 accent-primary"
                              />
                            </label>
                            <label className="space-y-1">
                              <span className="text-[10px] text-muted-foreground">
                                Contrast: {blend.contrast > 0 ? "+" : ""}{blend.contrast}
                              </span>
                              <input
                                type="range" min={-50} max={50} value={blend.contrast}
                                onChange={e => updateBlend("contrast", parseInt(e.target.value))}
                                className="w-full h-1 accent-primary"
                              />
                            </label>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* Harmonization compare dialog — opens on Harmonize button click,
          shows flat composite vs harmonized result side-by-side. */}
      {showHarmonizeCompare && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-4"
          onClick={() => setShowHarmonizeCompare(false)}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="bg-zinc-900 border border-white/10 rounded-xl max-w-6xl w-full max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-400" />
                <h3 className="text-base font-semibold text-white">Placement comparison</h3>
              </div>
              <button
                onClick={() => setShowHarmonizeCompare(false)}
                className="p-1.5 rounded-full bg-black/50 hover:bg-black/70 text-white"
                data-testid="button-close-harmonize"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4">
              {isHarmonizing && (() => {
                const { percent, label, isOvertime } = computeHarmonizeProgress(
                  harmonizeMode,
                  harmonizeElapsedMs,
                  harmonizeDoneAt100,
                );
                const elapsedSec = (harmonizeElapsedMs / 1000).toFixed(1);
                const expectedSec = harmonizeMode
                  ? Math.round(HARMONIZE_STAGE_PLAN[harmonizeMode].expectedMs / 1000)
                  : null;
                return (
                  <div className="flex flex-col items-center justify-center py-12 gap-4 max-w-md mx-auto">
                    <div className="flex items-center gap-2 text-emerald-300">
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span className="text-sm font-medium">
                        {harmonizeMode === "ai-3d" ? "3D Harmonize" : "Harmonize"}
                      </span>
                    </div>
                    <Progress
                      value={percent}
                      className={cn(
                        "h-2 w-full",
                        isOvertime ? "[&>div]:bg-amber-400" : "[&>div]:bg-emerald-400",
                      )}
                      data-testid="harmonize-progress"
                    />
                    <div className="flex items-center justify-between w-full text-xs text-muted-foreground">
                      <span data-testid="harmonize-stage">{label || "Starting…"}</span>
                      <span className="tabular-nums">
                        {Math.round(percent)}%
                        {expectedSec !== null && (
                          <span className="text-muted-foreground/60 ml-2">
                            {elapsedSec}s / ~{expectedSec}s
                          </span>
                        )}
                      </span>
                    </div>
                    {isOvertime && (
                      <p className="text-[11px] text-amber-300/80 text-center">
                        Taking longer than usual — still running, hang tight.
                      </p>
                    )}
                  </div>
                );
              })()}

              {!isHarmonizing && harmonizeError && (
                <div className="py-8 px-4 rounded-lg bg-red-500/10 border border-red-500/40">
                  <p className="text-sm text-red-300">Harmonization failed: {harmonizeError}</p>
                  <p className="text-xs text-muted-foreground mt-2">
                    The flat overlay on the main canvas is unaffected — this is a preview tool only.
                  </p>
                </div>
              )}

              {!isHarmonizing && !harmonizeError && (harmonizeFlatUrl || harmonizeResultUrl) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-white">Flat overlay</span>
                      <Badge variant="outline" className="text-[10px]">baseline</Badge>
                    </div>
                    {harmonizeFlatUrl ? (
                      <img
                        src={harmonizeFlatUrl}
                        alt="Flat composite"
                        className="w-full rounded-lg border border-white/10"
                      />
                    ) : (
                      <div className="w-full aspect-video rounded-lg border border-white/10 bg-zinc-800 flex items-center justify-center text-xs text-muted-foreground">
                        Not available
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground mt-1.5">
                      Product pasted at bbox without lighting adjustment.
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-white">Saved composite</span>
                      <Badge className="text-[10px] bg-emerald-500/20 text-emerald-300 border-emerald-500/40">
                        what brands see
                      </Badge>
                    </div>
                    {harmonizeResultUrl ? (
                      <img
                        src={harmonizeResultUrl}
                        alt="Saved composite"
                        className="w-full rounded-lg border border-emerald-500/40"
                      />
                    ) : (
                      <div className="w-full aspect-video rounded-lg border border-white/10 bg-zinc-800 flex items-center justify-center text-xs text-muted-foreground">
                        Not available
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground mt-1.5">
                      The flat composite — same image rendered in the preview.
                      Click "3D Harmonize" (purple) to try the experimental AI
                      path that generates scene-native pixels.
                    </p>
                  </div>
                </div>
              )}

              {/* Recent harmonize history — local-only rolling log so the
                  user can re-apply a prior result without burning another
                  12-60s server roundtrip. Same-context entries get badges
                  so the most relevant runs surface visually. */}
              {!isHarmonizing && harmonizeHistory.length > 0 && (
                <div className="mt-6 pt-4 border-t border-white/10">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-white">
                        Recent harmonizes
                      </span>
                      <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                        {harmonizeHistory.length}
                      </Badge>
                    </div>
                    <button
                      onClick={() => {
                        clearHarmonizeHistory();
                        setHarmonizeHistory([]);
                        toast({ title: "Cleared harmonize history" });
                      }}
                      className="text-[10px] text-muted-foreground hover:text-white transition-colors"
                      data-testid="button-clear-harmonize-history"
                    >
                      Clear
                    </button>
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
                    {harmonizeHistory.map((entry) => {
                      const sameSurface = selectedSurface?.id === entry.surfaceId;
                      const sameProduct = productImage === entry.productImageUrl;
                      const sameScene =
                        entry.videoFingerprint != null &&
                        entry.videoFingerprint === fingerprintVideoSrc(videoSrc);
                      return (
                        <div
                          key={entry.id}
                          className="group relative flex-shrink-0 w-28 rounded-md border border-white/10 bg-zinc-900/60 overflow-hidden hover:border-emerald-400/60 transition-colors"
                          data-testid={`history-entry-${entry.id}`}
                        >
                          <button
                            onClick={() => reuseHarmonizeEntry(entry)}
                            className="block w-full"
                            title={`Reuse: ${entry.mode === "ai-3d" ? "3D Harmonize" : "Harmonize"} • ${formatHistoryTimestamp(entry.timestamp)}`}
                          >
                            <div className="aspect-video bg-black flex items-center justify-center">
                              <img
                                src={entry.resultImageUrl}
                                alt={`Harmonize from ${formatHistoryTimestamp(entry.timestamp)}`}
                                className="w-full h-full object-cover"
                                loading="lazy"
                                onError={(e) => {
                                  // Result image was GC'd — show a fallback
                                  // tile so the entry still functions for
                                  // transform recall.
                                  (e.currentTarget as HTMLImageElement).style.display = "none";
                                  (e.currentTarget.nextSibling as HTMLElement | null)?.classList.remove("hidden");
                                }}
                              />
                              <span className="hidden text-[10px] text-muted-foreground px-2 text-center">
                                Image expired
                              </span>
                            </div>
                            <div className="p-1.5 flex flex-col gap-1">
                              <div className="flex items-center justify-between gap-1">
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "text-[9px] h-3.5 px-1 leading-none",
                                    entry.mode === "ai-3d"
                                      ? "border-violet-400/50 text-violet-300"
                                      : "border-emerald-400/50 text-emerald-300",
                                  )}
                                >
                                  {entry.mode === "ai-3d" ? "3D" : "Auto"}
                                </Badge>
                                <span className="text-[9px] text-muted-foreground">
                                  {formatHistoryTimestamp(entry.timestamp)}
                                </span>
                              </div>
                              {(sameSurface || sameProduct || sameScene) && (
                                <div className="flex flex-wrap gap-0.5">
                                  {sameSurface && (
                                    <span className="text-[8px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300 leading-none">
                                      surface
                                    </span>
                                  )}
                                  {sameProduct && (
                                    <span className="text-[8px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300 leading-none">
                                      product
                                    </span>
                                  )}
                                  {sameScene && !sameSurface && (
                                    <span className="text-[8px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300 leading-none">
                                      scene
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </button>
                          <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                reuseHarmonizeEntry(entry, { transformOnly: true });
                              }}
                              className="p-0.5 rounded bg-black/60 hover:bg-black/90 text-white"
                              title="Restore transform only (re-run server)"
                            >
                              <RotateCcw className="w-2.5 h-2.5" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                removeHarmonizeEntry(entry.id);
                              }}
                              className="p-0.5 rounded bg-black/60 hover:bg-red-600 text-white"
                              title="Remove from history"
                            >
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Click a tile to re-apply that result instantly. Hover for
                    "transform only" (re-run with the same placement) or remove.
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
