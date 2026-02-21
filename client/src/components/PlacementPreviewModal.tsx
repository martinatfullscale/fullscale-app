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
  Play,
  Pause,
  Film,
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
 * Client-side template matching for surface tracking.
 * Captures a small grayscale patch from the reference frame around the surface,
 * then searches for it in subsequent frames to estimate camera motion.
 * Returns the (dx, dy) offset in normalized coordinates (0-1).
 */
function captureReferencePatch(
  videoEl: HTMLVideoElement,
  canvasW: number,
  canvasH: number,
  bboxX: number, bboxY: number, bboxW: number, bboxH: number,
  searchCanvas: HTMLCanvasElement
): ImageData | null {
  try {
    searchCanvas.width = canvasW;
    searchCanvas.height = canvasH;
    const ctx = searchCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(videoEl, 0, 0, canvasW, canvasH);

    // Sample a patch centered on the bbox — use a region slightly larger than the bbox
    // to capture surrounding context (edges of furniture, etc.) for better matching
    const patchMargin = 0.3; // 30% extra margin around bbox
    const px = Math.max(0, Math.floor(bboxX - bboxW * patchMargin));
    const py = Math.max(0, Math.floor(bboxY - bboxH * patchMargin));
    const pw = Math.min(canvasW - px, Math.floor(bboxW * (1 + patchMargin * 2)));
    const ph = Math.min(canvasH - py, Math.floor(bboxH * (1 + patchMargin * 2)));

    if (pw <= 4 || ph <= 4) return null;

    // Sample at lower resolution for speed (every 2nd pixel)
    return ctx.getImageData(px, py, pw, ph);
  } catch {
    return null;
  }
}

/**
 * Find the best match for the reference patch in the current frame.
 * Uses Sum of Absolute Differences (SAD) on grayscale, sampled sparsely for speed.
 * Returns offset from reference position in canvas pixel coordinates,
 * plus a confidence score (0-1) indicating match quality.
 *
 * Key improvement: returns `confidence` so the caller can decide what to do
 * when the match degrades (hold last good offset vs. blend).
 */
function trackPatchInFrame(
  videoEl: HTMLVideoElement,
  canvasW: number,
  canvasH: number,
  refData: ImageData,
  refX: number, refY: number,
  searchCanvas: HTMLCanvasElement,
  searchRadius: number = 120 // generous search radius for camera pans
): { dx: number; dy: number; confidence: number; frameData?: ImageData } {
  try {
    searchCanvas.width = canvasW;
    searchCanvas.height = canvasH;
    const ctx = searchCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { dx: 0, dy: 0, confidence: 0 };

    ctx.drawImage(videoEl, 0, 0, canvasW, canvasH);

    const pw = refData.width;
    const ph = refData.height;

    // Search area: reference position ± searchRadius, biased toward last known offset
    const searchLeft = Math.max(0, refX - searchRadius);
    const searchTop = Math.max(0, refY - searchRadius);
    const searchRight = Math.min(canvasW - pw, refX + searchRadius);
    const searchBottom = Math.min(canvasH - ph, refY + searchRadius);

    if (searchRight <= searchLeft || searchBottom <= searchTop) return { dx: 0, dy: 0, confidence: 0 };

    // Get full search area pixels in one call (much faster than many small getImageData calls)
    const searchW = searchRight - searchLeft + pw;
    const searchH = searchBottom - searchTop + ph;
    const searchData = ctx.getImageData(searchLeft, searchTop, searchW, searchH);

    const refPx = refData.data;
    const searchPx = searchData.data;

    let bestDx = 0, bestDy = 0, bestSAD = Infinity;
    // Two-pass search: coarse (step=6) then fine (step=2) around best coarse match
    const coarseStep = 6;
    const sampleStep = 4; // Sample every 4th pixel in patch (denser than before for better accuracy)

    // Coarse pass
    for (let sy = 0; sy <= searchBottom - searchTop; sy += coarseStep) {
      for (let sx = 0; sx <= searchRight - searchLeft; sx += coarseStep) {
        let sad = 0;
        let samples = 0;

        for (let py2 = 0; py2 < ph; py2 += sampleStep) {
          for (let px2 = 0; px2 < pw; px2 += sampleStep) {
            const refIdx = (py2 * pw + px2) * 4;
            const searchIdx = ((sy + py2) * searchW + (sx + px2)) * 4;

            const refGray = (refPx[refIdx] + refPx[refIdx + 1] + refPx[refIdx + 2]) / 3;
            const srcGray = (searchPx[searchIdx] + searchPx[searchIdx + 1] + searchPx[searchIdx + 2]) / 3;
            sad += Math.abs(refGray - srcGray);
            samples++;
          }
        }

        sad /= samples;

        if (sad < bestSAD) {
          bestSAD = sad;
          bestDx = sx;
          bestDy = sy;
        }
      }
    }

    // Fine pass: refine around the coarse best match
    const fineStep = 2;
    const fineRadius = coarseStep + 2;
    const fineLeft = Math.max(0, bestDx - fineRadius);
    const fineTop = Math.max(0, bestDy - fineRadius);
    const fineRight = Math.min(searchRight - searchLeft, bestDx + fineRadius);
    const fineBottom = Math.min(searchBottom - searchTop, bestDy + fineRadius);

    for (let sy = fineTop; sy <= fineBottom; sy += fineStep) {
      for (let sx = fineLeft; sx <= fineRight; sx += fineStep) {
        let sad = 0;
        let samples = 0;

        for (let py2 = 0; py2 < ph; py2 += sampleStep) {
          for (let px2 = 0; px2 < pw; px2 += sampleStep) {
            const refIdx = (py2 * pw + px2) * 4;
            const searchIdx = ((sy + py2) * searchW + (sx + px2)) * 4;

            const refGray = (refPx[refIdx] + refPx[refIdx + 1] + refPx[refIdx + 2]) / 3;
            const srcGray = (searchPx[searchIdx] + searchPx[searchIdx + 1] + searchPx[searchIdx + 2]) / 3;
            sad += Math.abs(refGray - srcGray);
            samples++;
          }
        }

        sad /= samples;

        if (sad < bestSAD) {
          bestSAD = sad;
          bestDx = sx;
          bestDy = sy;
        }
      }
    }

    const finalDx = bestDx + searchLeft - refX;
    const finalDy = bestDy + searchTop - refY;

    // Convert SAD to confidence: 0 SAD = 1.0 confidence, 60+ SAD = 0.0
    // SAD of 20 = excellent match (~0.67), SAD of 40 = mediocre (~0.33)
    const confidence = Math.max(0, Math.min(1, 1 - bestSAD / 60));

    // Also grab the current frame data at the matched position so caller can
    // update reference patch when confidence is high
    let frameData: ImageData | undefined;
    if (confidence > 0.6) {
      const matchX = bestDx + searchLeft;
      const matchY = bestDy + searchTop;
      if (matchX >= 0 && matchY >= 0 && matchX + pw <= canvasW && matchY + ph <= canvasH) {
        frameData = ctx.getImageData(matchX, matchY, pw, ph);
      }
    }

    return { dx: finalDx, dy: finalDy, confidence, frameData };
  } catch {
    return { dx: 0, dy: 0, confidence: 0 };
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

  // Video export state
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportJobId, setExportJobId] = useState<number | null>(null);
  const [exportOutputUrl, setExportOutputUrl] = useState<string | null>(null);

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const frameImgRef = useRef<HTMLImageElement | null>(null);
  const productImgRef = useRef<HTMLImageElement | null>(null);
  const animFrameRef = useRef<number>(0);
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  // Client-side surface tracking state
  // Captures a reference patch from the first frame and tracks it via template matching
  const trackingRef = useRef<{
    referenceData: ImageData | null;   // Pixel patch from reference frame around surface
    refCenterX: number;                // Top-left X of reference patch in canvas pixels
    refCenterY: number;                // Top-left Y of reference patch in canvas pixels
    patchWidth: number;                // Patch size in canvas pixels
    patchHeight: number;
    lastOffsetX: number;               // Current tracked offset in canvas pixels
    lastOffsetY: number;
    lastGoodOffsetX: number;           // Last offset with high confidence (held when tracking degrades)
    lastGoodOffsetY: number;
    searchCanvas: HTMLCanvasElement;    // Off-screen canvas for pixel sampling
    initialized: boolean;
    frameCounter: number;              // Only run tracking every Nth frame
    refUpdateCounter: number;          // Counter for adaptive reference updates
    consecutiveLowConf: number;        // How many frames in a row had low confidence
    lastConfidence: number;            // Most recent confidence score
  }>({
    referenceData: null,
    refCenterX: 0,
    refCenterY: 0,
    patchWidth: 0,
    patchHeight: 0,
    lastOffsetX: 0,
    lastOffsetY: 0,
    lastGoodOffsetX: 0,
    lastGoodOffsetY: 0,
    searchCanvas: typeof document !== "undefined" ? document.createElement("canvas") : null as any,
    initialized: false,
    frameCounter: 0,
    refUpdateCounter: 0,
    consecutiveLowConf: 0,
    lastConfidence: 1,
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

  // Trigger dense scan when user first enters video playback mode
  const triggerDenseScan = useCallback(async () => {
    if (isDenseScanning || denseScanDone) return;

    // Check if we already have enough keyframes for the selected surface
    const surfaceType = selectedSurface?.surfaceType;
    const existingKfs = surfaceType ? denseKeyframesData?.keyframes?.[surfaceType] : null;
    if (existingKfs && existingKfs.length >= 10) {
      setDenseScanDone(true);
      return;
    }

    setIsDenseScanning(true);
    try {
      console.log(`[PlacementPreview] Triggering dense scan for video ${videoId}...`);
      const res = await fetch(`/api/video/${videoId}/dense-scan`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        console.log(`[PlacementPreview] Dense scan result:`, data);
        // Refetch keyframes now that dense scan is complete
        await refetchKeyframes();
      }
      setDenseScanDone(true);
    } catch (err) {
      console.error("[PlacementPreview] Dense scan failed:", err);
    } finally {
      setIsDenseScanning(false);
    }
  }, [videoId, isDenseScanning, denseScanDone, selectedSurface?.surfaceType, denseKeyframesData, refetchKeyframes]);

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
      // Reset video playback + dense scan state
      setIsVideoMode(false);
      setIsDenseScanning(false);
      setDenseScanDone(false);
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

  // Apply initialPlacement when modal opens with pre-loaded data (re-edit flow)
  useEffect(() => {
    if (!open || !initialPlacement) return;
    setProductImage(initialPlacement.productImageUrl);
    setTransform({ ...initialPlacement.transform });
    setBlend({ ...initialPlacement.blend });
    setToolPanel("transform");
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
        // CLIENT-SIDE VISUAL TRACKING — template matching on the surface region
        // Strategy: capture a reference patch from the first frame, then search for it
        // in each subsequent frame. When confidence is high, smoothly blend offsets.
        // When confidence drops, HOLD the last good position (don't snap back to zero).
        // Periodically update the reference patch so it adapts to gradual scene changes.
        const tracking = trackingRef.current;

        // Step 1: Capture reference patch from the first frame if not done yet
        if (!tracking.initialized && videoEl.currentTime < 0.5) {
          const refPatch = captureReferencePatch(
            videoEl, canvas.width, canvas.height,
            baseBX, baseBY, baseBW, baseBH,
            tracking.searchCanvas
          );
          if (refPatch) {
            tracking.referenceData = refPatch;
            const patchMargin = 0.3;
            tracking.refCenterX = Math.max(0, Math.floor(baseBX - baseBW * patchMargin));
            tracking.refCenterY = Math.max(0, Math.floor(baseBY - baseBH * patchMargin));
            tracking.patchWidth = refPatch.width;
            tracking.patchHeight = refPatch.height;
            tracking.lastOffsetX = 0;
            tracking.lastOffsetY = 0;
            tracking.lastGoodOffsetX = 0;
            tracking.lastGoodOffsetY = 0;
            tracking.refUpdateCounter = 0;
            tracking.consecutiveLowConf = 0;
            tracking.lastConfidence = 1;
            tracking.initialized = true;
          }
        }

        // Step 2: Track the reference patch in the current frame
        // Run template matching every 2nd frame (more responsive than every 3rd)
        if (tracking.initialized && tracking.referenceData) {
          tracking.frameCounter++;
          if (tracking.frameCounter % 2 === 0) {
            // Search centered on last known offset position (not always from reference origin)
            // This gives us a moving search window that follows the surface
            const searchFromX = tracking.refCenterX + Math.round(tracking.lastOffsetX);
            const searchFromY = tracking.refCenterY + Math.round(tracking.lastOffsetY);

            const { dx, dy, confidence, frameData } = trackPatchInFrame(
              videoEl, canvas.width, canvas.height,
              tracking.referenceData,
              searchFromX, searchFromY,
              tracking.searchCanvas,
              120 // generous search radius for camera pans
            );

            // Actual offset from the ORIGINAL reference position
            const newOffsetX = tracking.lastOffsetX + dx;
            const newOffsetY = tracking.lastOffsetY + dy;

            tracking.lastConfidence = confidence;

            if (confidence > 0.35) {
              // Good match — smooth blend toward the new offset
              // Higher confidence → more responsive (less smoothing)
              const alpha = 0.3 + confidence * 0.4; // 0.44 to 0.70
              tracking.lastOffsetX = tracking.lastOffsetX * (1 - alpha) + newOffsetX * alpha;
              tracking.lastOffsetY = tracking.lastOffsetY * (1 - alpha) + newOffsetY * alpha;
              tracking.consecutiveLowConf = 0;

              // Save as last good offset
              tracking.lastGoodOffsetX = tracking.lastOffsetX;
              tracking.lastGoodOffsetY = tracking.lastOffsetY;

              // Adaptive reference update: every ~45 matched frames, refresh the
              // reference patch from the current frame so it stays relevant as
              // lighting/perspective changes gradually.
              tracking.refUpdateCounter++;
              if (tracking.refUpdateCounter >= 45 && confidence > 0.55 && frameData) {
                tracking.referenceData = frameData;
                // Update reference position to match current tracked position
                tracking.refCenterX = searchFromX;
                tracking.refCenterY = searchFromY;
                tracking.lastOffsetX = 0;
                tracking.lastOffsetY = 0;
                tracking.lastGoodOffsetX = 0;
                tracking.lastGoodOffsetY = 0;
                tracking.refUpdateCounter = 0;
              }
            } else {
              // Low confidence — HOLD the last good offset instead of decaying to zero.
              // This prevents the bbox from snapping back to original position
              // when the scene temporarily changes (motion blur, occlusion, etc.)
              tracking.consecutiveLowConf++;
              tracking.lastOffsetX = tracking.lastGoodOffsetX;
              tracking.lastOffsetY = tracking.lastGoodOffsetY;

              // If we've lost tracking for a long time (60+ low-conf frames in a row),
              // try re-capturing a reference patch from the current frame
              if (tracking.consecutiveLowConf > 60) {
                const newRef = captureReferencePatch(
                  videoEl, canvas.width, canvas.height,
                  baseBX + tracking.lastGoodOffsetX,
                  baseBY + tracking.lastGoodOffsetY,
                  baseBW, baseBH,
                  tracking.searchCanvas
                );
                if (newRef) {
                  tracking.referenceData = newRef;
                  const patchMargin = 0.3;
                  tracking.refCenterX = Math.max(0, Math.floor(
                    (baseBX + tracking.lastGoodOffsetX) - baseBW * patchMargin
                  ));
                  tracking.refCenterY = Math.max(0, Math.floor(
                    (baseBY + tracking.lastGoodOffsetY) - baseBH * patchMargin
                  ));
                  tracking.lastOffsetX = 0;
                  tracking.lastOffsetY = 0;
                  tracking.lastGoodOffsetX = 0;
                  tracking.lastGoodOffsetY = 0;
                  tracking.refUpdateCounter = 0;
                  tracking.consecutiveLowConf = 0;
                }
              }
            }
          }

          // Apply total offset = baseBX is the original position, plus tracked offset
          // When reference has been updated, lastGoodOffset is relative to the updated ref,
          // so we reconstruct the absolute position differently:
          // absolute = refCenterX (current reference origin) + lastOffset + patch margin shift
          const patchMargin = 0.3;
          const marginX = baseBW * patchMargin;
          const marginY = baseBH * patchMargin;
          bx = tracking.refCenterX + tracking.lastOffsetX + marginX;
          by = tracking.refCenterY + tracking.lastOffsetY + marginY;
        } else {
          bx = baseBX;
          by = baseBY;
        }
        bw = baseBW;
        bh = baseBH;
      } else {
        // Static mode — use the surface's original position
        bx = baseBX;
        by = baseBY;
        bw = baseBW;
        bh = baseBH;
      }

      const hasProduct = !!productImgRef.current;

      // Bounding box outline
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

      // Draw product if loaded
      const prodImg = productImgRef.current;
      if (prodImg && prodImg.complete && bw > 0 && bh > 0) {
        drawProduct(ctx, prodImg, bx, by, bw, bh, transform, blend);

        // Draw resize handles + rotation handle
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

      // "Drop product here" text if no product
      if (!hasProduct) {
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
  }, [selectedSurface, transform, blend, isVideoMode]);

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
      // Enter video mode — reset tracking state and start from beginning
      const tracking = trackingRef.current;
      tracking.initialized = false;
      tracking.referenceData = null;
      tracking.lastOffsetX = 0;
      tracking.lastOffsetY = 0;
      tracking.lastGoodOffsetX = 0;
      tracking.lastGoodOffsetY = 0;
      tracking.frameCounter = 0;
      tracking.refUpdateCounter = 0;
      tracking.consecutiveLowConf = 0;
      tracking.lastConfidence = 1;

      setIsVideoMode(true);
      triggerDenseScan(); // Fire-and-forget: generates dense keyframes in background (for export)
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
  }, [isVideoMode, isVideoPlaying, triggerDenseScan]);

  const stopVideoPlayback = useCallback(() => {
    const videoEl = videoRef.current;
    if (videoEl) {
      videoEl.pause();
      videoEl.currentTime = 0;
    }
    setIsVideoMode(false);
    setIsVideoPlaying(false);
    setVideoCurrentTime(0);
    // Reset visual tracking
    const tracking = trackingRef.current;
    tracking.initialized = false;
    tracking.referenceData = null;
    tracking.lastOffsetX = 0;
    tracking.lastOffsetY = 0;
    tracking.lastGoodOffsetX = 0;
    tracking.lastGoodOffsetY = 0;
    tracking.frameCounter = 0;
    tracking.refUpdateCounter = 0;
    tracking.consecutiveLowConf = 0;
    tracking.lastConfidence = 1;
  }, []);

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
        const err = await res.json().catch(() => ({ error: "Export failed" }));
        throw new Error(err.error || "Export failed to start");
      }

      const { exportId } = await res.json();
      setExportJobId(exportId);
      setExportStatus("processing");
      toast({ title: "Video export started", description: "This may take a few minutes..." });
    } catch (err: any) {
      setIsExporting(false);
      setExportStatus("failed");
      toast({ title: "Export failed", description: err.message, variant: "destructive" });
    }
  }, [selectedSurface, productImage, transform, blend, videoId, toast]);

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
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        throw new Error(err.error || "Failed to save placement");
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
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
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
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-white/10">
              <div>
                <h2 className="text-lg font-bold text-white">Placement Preview</h2>
                <p className="text-sm text-muted-foreground line-clamp-1">{videoTitle}</p>
              </div>
              <div className="flex items-center gap-3">
                {hasProduct && (
                  <>
                    <Button
                      size="sm"
                      variant={saveSuccess ? "default" : "secondary"}
                      className={cn("gap-2", saveSuccess && "bg-emerald-600 hover:bg-emerald-700")}
                      onClick={savePlacement}
                      disabled={isSaving}
                    >
                      {isSaving ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : saveSuccess ? (
                        <CheckCircle className="w-4 h-4" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      {isSaving ? "Saving..." : saveSuccess ? "Saved" : "Save"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="gap-2"
                      onClick={downloadPreview}
                    >
                      <Download className="w-4 h-4" />
                      Export Frame
                    </Button>
                    {videoSrc && (
                      exportStatus === "complete" && exportOutputUrl ? (
                        <a href={`/api/exports/${exportJobId}/download`} download>
                          <Button size="sm" className="gap-2 bg-emerald-600 hover:bg-emerald-700">
                            <Download className="w-4 h-4" />
                            Download MP4
                          </Button>
                        </a>
                      ) : isExporting ? (
                        <Button size="sm" className="gap-2" disabled>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Exporting {exportProgress}%
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          className="gap-2 bg-green-600 hover:bg-green-700"
                          onClick={handleVideoExport}
                          disabled={exportStatus === "failed"}
                        >
                          <Film className="w-4 h-4" />
                          Export Video
                        </Button>
                      )
                    )}
                  </>
                )}
                <button
                  onClick={onClose}
                  className="p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex flex-col lg:flex-row overflow-hidden" style={{ height: "calc(90vh - 60px)" }}>
              {/* Main canvas area */}
              <div className="flex-1 min-w-0 flex flex-col p-4">
                <div
                  ref={canvasContainerRef}
                  className="relative flex-1 bg-black rounded-lg overflow-hidden flex items-center justify-center"
                  style={{ minHeight: "300px" }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
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
                  />

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
                    <div className="absolute bottom-3 left-3 right-3 flex items-center gap-2 z-10">
                      <Button
                        size="sm"
                        variant={isVideoPlaying ? "default" : "secondary"}
                        className="gap-1.5 h-8 px-3 bg-black/70 hover:bg-black/90 border border-white/20 text-white"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleVideoPlayback();
                        }}
                      >
                        {isVideoPlaying ? (
                          <><Pause className="w-3.5 h-3.5" /> Pause</>
                        ) : (
                          <><Play className="w-3.5 h-3.5" /> {isVideoMode ? "Resume" : "Play Video"}</>
                        )}
                      </Button>
                      {isVideoMode && (
                        <>
                          {/* Seek bar */}
                          <input
                            type="range"
                            min={0}
                            max={videoDuration || 1}
                            step={0.1}
                            value={videoCurrentTime}
                            onChange={(e) => {
                              const time = parseFloat(e.target.value);
                              if (videoRef.current) {
                                videoRef.current.currentTime = time;
                                setVideoCurrentTime(time);
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 h-1 accent-primary cursor-pointer"
                          />
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
                  <div className="mt-2 text-center">
                    <p className="text-[10px] text-muted-foreground">
                      {isDenseScanning
                        ? "Generating surface tracking data... Product will track with camera once complete."
                        : isVideoMode
                        ? "Playing video with camera-tracking placement — product follows the surface"
                        : "Drag to move | Corner handles to resize | Orange dot to rotate | Play to preview tracking"
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
              <div className="lg:w-80 flex-shrink-0 bg-gradient-to-b from-card to-secondary/20 border-l border-white/10 flex flex-col overflow-hidden">
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
    </AnimatePresence>
  );
}
