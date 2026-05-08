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

  // Drag interaction state
  const [dragMode, setDragMode] = useState<DragMode>("none");
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragStartTransform, setDragStartTransform] = useState<PlacementTransform>(DEFAULT_TRANSFORM);

  // Save state
  const [isSaving, setIsSaving] = useState(false);
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

  // Fetch video details to get file path for playback
  const { data: videoDetails } = useQuery<{ filePath: string | null }>({
    queryKey: [`/api/video/${videoId}/details`],
    queryFn: async () => {
      const res = await fetch(`/api/video/${videoId}/details`);
      if (!res.ok) return { filePath: null };
      return res.json();
    },
    enabled: open,
  });
  const videoSrc = resolveVideoSrc(videoDetails?.filePath);

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

          // Scene-change detection: if position is null, surface is not visible at this time
          if (!pos) {
            bx = -9999; by = -9999; bw = 0; bh = 0;
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

      // Draw product if loaded (always renders regardless of toggle)
      const prodImg = productImgRef.current;
      if (prodImg && prodImg.complete && bw > 0 && bh > 0) {
        drawProduct(ctx, prodImg, bx, by, bw, bh, transform, blend);

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
  }, [selectedSurface, transform, blend, isVideoMode, motionData, showBoundingBox]);

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
      toast({
        title: "Placement saved",
        description: propagated > 0
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
  }, [selectedSurface, productImage, videoId, selectedCatalogProduct, transform, blend, toast]);

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

                        // Compute the product's actual normalized bbox after
                        // applying user transforms. This mirrors drawProduct's
                        // canvas math so the server places the product where
                        // it currently sits on the canvas, not where the raw
                        // surface bbox is. Without this, harmonize was
                        // resizing + recentering to the surface bbox and
                        // ignoring the user's adjustments.
                        const surfaceX = selectedSurface.boundingBoxX;
                        const surfaceY = selectedSurface.boundingBoxY;
                        const surfaceW = selectedSurface.boundingBoxWidth;
                        const surfaceH = selectedSurface.boundingBoxHeight;
                        const productImg = productImgRef.current;
                        const canvas = canvasRef.current;
                        let productPlacementBbox = null;
                        if (productImg && canvas && surfaceW > 0 && surfaceH > 0) {
                          const prodAspect = productImg.naturalWidth / productImg.naturalHeight;
                          const surfaceAspectInBbox = surfaceW / surfaceH;
                          // Same aspect-fit logic as drawProduct (line 388),
                          // but in normalized coordinates instead of pixels.
                          let drawW: number, drawH: number;
                          if (prodAspect > surfaceAspectInBbox) {
                            drawW = surfaceW * transform.scale;
                            drawH = (surfaceW / prodAspect) * transform.scale;
                          } else {
                            drawH = surfaceH * transform.scale;
                            drawW = (surfaceH * prodAspect) * transform.scale;
                          }
                          // transform.offsetX/Y are in canvas pixels — convert
                          // to normalized scene space using canvas dimensions.
                          const offsetXNorm = transform.offsetX / Math.max(1, canvas.width);
                          const offsetYNorm = transform.offsetY / Math.max(1, canvas.height);
                          const centerXNorm = surfaceX + surfaceW / 2 + offsetXNorm;
                          const centerYNorm = surfaceY + surfaceH / 2 + offsetYNorm;
                          productPlacementBbox = {
                            x: Math.max(0, Math.min(1, centerXNorm - drawW / 2)),
                            y: Math.max(0, Math.min(1, centerYNorm - drawH / 2)),
                            width: Math.max(0.01, Math.min(1, drawW)),
                            height: Math.max(0.01, Math.min(1, drawH)),
                          };
                        }

                        try {
                          const res = await fetch("/api/placement/harmonize", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            credentials: "include",
                            body: JSON.stringify({
                              surfaceId: selectedSurface.id,
                              productImageUrl: productImage,
                              productPlacementBbox,
                              mode: "procedural",
                            }),
                          });
                          const data = await res.json();
                          if (!res.ok || !data.success) {
                            throw new Error(data.error || "Harmonization failed");
                          }
                          setHarmonizeFlatUrl(data.flatCompositeUrl || null);
                          setHarmonizeResultUrl(data.imageUrl || null);
                          // Seed the live overlay AND enable it so the canvas
                          // shows the harmonized result immediately. The user
                          // can disable via the "Remove Harmonize" button to
                          // adjust placement, then re-harmonize.
                          setLiveHarmonizedUrl(data.imageUrl || null);
                          if (data.imageUrl) setHarmonizeEnabled(true);
                        } catch (err: any) {
                          setHarmonizeError(err.message || "Harmonization failed");
                        } finally {
                          setIsHarmonizing(false);
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

                        const surfaceX = selectedSurface.boundingBoxX;
                        const surfaceY = selectedSurface.boundingBoxY;
                        const surfaceW = selectedSurface.boundingBoxWidth;
                        const surfaceH = selectedSurface.boundingBoxHeight;
                        const productImg = productImgRef.current;
                        const canvas = canvasRef.current;
                        let productPlacementBbox = null;
                        if (productImg && canvas && surfaceW > 0 && surfaceH > 0) {
                          const prodAspect = productImg.naturalWidth / productImg.naturalHeight;
                          const surfaceAspectInBbox = surfaceW / surfaceH;
                          let drawW: number, drawH: number;
                          if (prodAspect > surfaceAspectInBbox) {
                            drawW = surfaceW * transform.scale;
                            drawH = (surfaceW / prodAspect) * transform.scale;
                          } else {
                            drawH = surfaceH * transform.scale;
                            drawW = (surfaceH * prodAspect) * transform.scale;
                          }
                          const offsetXNorm = transform.offsetX / Math.max(1, canvas.width);
                          const offsetYNorm = transform.offsetY / Math.max(1, canvas.height);
                          const centerXNorm = surfaceX + surfaceW / 2 + offsetXNorm;
                          const centerYNorm = surfaceY + surfaceH / 2 + offsetYNorm;
                          productPlacementBbox = {
                            x: Math.max(0, Math.min(1, centerXNorm - drawW / 2)),
                            y: Math.max(0, Math.min(1, centerYNorm - drawH / 2)),
                            width: Math.max(0.01, Math.min(1, drawW)),
                            height: Math.max(0.01, Math.min(1, drawH)),
                          };
                        }

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
                        } catch (err: any) {
                          setHarmonizeError(err.message || "3D Harmonization failed");
                        } finally {
                          setIsHarmonizing(false);
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
                        <Loader2 className="w-3 h-3 animate-spin text-emerald-300" />
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

                {/* Surface selector strip */}
                {surfacesWithFrames.length > 1 && (
                  <div className="mt-3 p-2 bg-black/30 rounded-lg">
                    <p className="text-xs text-muted-foreground mb-2">Select surface:</p>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {surfacesWithFrames.map((surface) => (
                        <button
                          key={surface.id}
                          onClick={() => {
                            setSelectedSurface(surface);
                            // Reset transform for new surface
                            setTransform({ ...DEFAULT_TRANSFORM });
                            // Auto-populate blend from lighting data
                            setBlend(getAutoBlendDefaults(surface));
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
                          <span className="absolute bottom-0 left-0 right-0 bg-black/70 text-[8px] text-white text-center py-0.5">
                            {surface.surfaceType}
                          </span>
                        </button>
                      ))}
                    </div>
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
              {isHarmonizing && (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
                  <p className="text-sm text-muted-foreground">Compositing + harmonizing…</p>
                </div>
              )}

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
                      <span className="text-sm font-medium text-white">Harmonized</span>
                      <Badge className="text-[10px] bg-emerald-500/20 text-emerald-300 border-emerald-500/40">
                        scene-aware
                      </Badge>
                    </div>
                    {harmonizeResultUrl ? (
                      <img
                        src={harmonizeResultUrl}
                        alt="Harmonized composite"
                        className="w-full rounded-lg border border-emerald-500/40"
                      />
                    ) : (
                      <div className="w-full aspect-video rounded-lg border border-white/10 bg-zinc-800 flex items-center justify-center text-xs text-muted-foreground">
                        Not available
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground mt-1.5">
                      Color cast + brightness matched to scene; contact shadow added. Scene pixels outside the bbox are unchanged.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
