import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, Play, Pause, Download, Layers, Save,
  CheckCircle, Package, Eye, EyeOff, ChevronRight,
  Move, RotateCw, Maximize2, Sun, Droplets, Blend, FlipHorizontal,
  Film, Loader2, X as XIcon, Share2, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

// ============================================================================
// TYPES
// ============================================================================

interface VideoDetails {
  id: number;
  userId: string;
  youtubeId: string;
  title: string;
  description: string | null;
  filePath: string | null;
  duration: string | null;
  status: string;
  surfaceCount: number;
  thumbnailUrl: string | null;
}

interface DetectedSurface {
  id: number;
  videoId: number;
  timestamp: string;
  surfaceType: string;
  confidence: string;
  boundingBoxX: string;
  boundingBoxY: string;
  boundingBoxWidth: string;
  boundingBoxHeight: string;
  frameUrl: string | null;
  frameExists?: boolean;
  surroundings: string[] | null;
  sceneContext: string | null;
  // Scene cluster ID — surfaces sharing a sceneId are in the same physical
  // scene. Null/absent for videos scanned before scene clustering shipped.
  sceneId?: number | null;
  // Canonical physical-surface identity — one id spans every frame row of
  // the same real-world surface. Opaque string; null/absent for legacy rows.
  surfaceGroupId?: string | null;
}

interface CatalogProduct {
  id: number;
  name: string;
  imageUrl: string;
  thumbnailUrl: string | null;
  category: string | null;
  isTransparent: boolean | null;
}

interface SurfaceKeyframe {
  timestamp: number;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
}

interface SurfaceTrack {
  // Stable identity for this track: the canonical surfaceGroupId when the
  // detection has one, else a legacy `${type}:${sceneId ?? "x"}` composite.
  trackKey: string;
  surfaceType: string;
  surfaceGroupId: string | null;
  sceneId: number | null;
  // Surface row ids feeding this track, sorted by timestamp (parallel to
  // keyframes). surfaceIds[0] is the anchor surface for saves.
  surfaceIds: number[];
  keyframes: SurfaceKeyframe[];
}

// Transform controls for each product placement
interface PlacementTransform {
  offsetX: number;     // pixel offset from bounding box center
  offsetY: number;
  scale: number;       // 0.1 - 3.0 multiplier
  rotation: number;    // degrees
  flipH: boolean;      // horizontal flip
}

// Blend/integration settings per placement
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

interface ProductAssignment {
  productId: number;
  imageUrl: string;
  name: string;
  imageElement: HTMLImageElement | null;
  transform: PlacementTransform;
  blend: PlacementBlend;
}

type DragMode = "none" | "move" | "resize-tl" | "resize-tr" | "resize-bl" | "resize-br" | "rotate";
type ToolPanel = "catalog" | "transform" | "blend";

const DEFAULT_TRANSFORM: PlacementTransform = {
  offsetX: 0,
  offsetY: 0,
  scale: 1.0,
  rotation: 0,
  flipH: false,
};

const DEFAULT_BLEND: PlacementBlend = {
  opacity: 85,
  blendMode: "source-over",
  shadowEnabled: false,
  shadowBlur: 8,
  shadowOffsetX: 2,
  shadowOffsetY: 4,
  shadowColor: "rgba(0,0,0,0.5)",
  featherRadius: 0,
  brightness: 0,
  contrast: 0,
};

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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpBBox(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  t: number
) {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    w: lerp(a.w, b.w, t),
    h: lerp(a.h, b.h, t),
  };
}

function findKeyframes(keyframes: SurfaceKeyframe[], currentTime: number) {
  if (keyframes.length === 0) return { prev: null, next: null, progress: 0 };

  let prevIdx = -1;
  for (let i = 0; i < keyframes.length; i++) {
    if (keyframes[i].timestamp <= currentTime) {
      prevIdx = i;
    } else {
      break;
    }
  }

  if (prevIdx === -1) {
    if (keyframes[0].timestamp - currentTime < 1) {
      return { prev: keyframes[0], next: null, progress: 0 };
    }
    return { prev: null, next: null, progress: 0 };
  }

  const prev = keyframes[prevIdx];
  const next = prevIdx < keyframes.length - 1 ? keyframes[prevIdx + 1] : null;

  if (!next) {
    const elapsed = currentTime - prev.timestamp;
    if (elapsed <= 2) {
      return { prev, next: null, progress: 0 };
    }
    return { prev: null, next: null, progress: 0 };
  }

  const duration = next.timestamp - prev.timestamp;
  const progress = duration > 0 ? (currentTime - prev.timestamp) / duration : 0;
  return { prev, next, progress: Math.min(Math.max(progress, 0), 1) };
}

// Tracks are keyed by canonical surface identity so keyframes never merge
// across distinct physical surfaces or scenes. Legacy rows (no surfaceGroupId)
// fall back to a type+scene composite; fully-legacy videos (no sceneId either)
// collapse to `${type}:x` — the old by-type behavior.
function getTrackKey(surface: DetectedSurface): string {
  return surface.surfaceGroupId || `${surface.surfaceType}:${surface.sceneId ?? "x"}`;
}

function buildSurfaceTracks(surfaces: DetectedSurface[]): Map<string, SurfaceTrack> {
  const tracks = new Map<string, SurfaceTrack>();

  for (const surface of surfaces) {
    const key = getTrackKey(surface);
    if (!tracks.has(key)) {
      tracks.set(key, {
        trackKey: key,
        surfaceType: surface.surfaceType,
        surfaceGroupId: surface.surfaceGroupId ?? null,
        sceneId: surface.sceneId ?? null,
        surfaceIds: [],
        keyframes: [],
      });
    }
    const track = tracks.get(key)!;
    if (track.sceneId == null && surface.sceneId != null) {
      track.sceneId = surface.sceneId;
    }

    // DB stores bounding box as 0-1 normalized; render code expects 0-100 percentage
    const rawX = parseFloat(surface.boundingBoxX);
    const rawY = parseFloat(surface.boundingBoxY);
    const rawW = parseFloat(surface.boundingBoxWidth);
    const rawH = parseFloat(surface.boundingBoxHeight);
    // Auto-detect: if all values are <=1, they're 0-1 normalized → scale to 0-100
    const isNormalized = rawX <= 1 && rawY <= 1 && rawW <= 1 && rawH <= 1;
    const scale = isNormalized ? 100 : 1;

    track.surfaceIds.push(surface.id);
    track.keyframes.push({
      timestamp: parseFloat(surface.timestamp),
      bbox: {
        x: rawX * scale,
        y: rawY * scale,
        w: rawW * scale,
        h: rawH * scale,
      },
      confidence: parseFloat(surface.confidence),
    });
  }

  for (const track of Array.from(tracks.values())) {
    // Sort keyframes and surfaceIds together so they stay parallel
    const order = track.keyframes
      .map((_: unknown, i: number) => i)
      .sort((a: number, b: number) => track.keyframes[a].timestamp - track.keyframes[b].timestamp);
    track.keyframes = order.map((i: number) => track.keyframes[i]);
    track.surfaceIds = order.map((i: number) => track.surfaceIds[i]);
  }
  return tracks;
}

function getUniqueTimestamps(surfaces: DetectedSurface[]): number[] {
  const timestamps = new Set<number>();
  for (const s of surfaces) timestamps.add(parseFloat(s.timestamp));
  return Array.from(timestamps).sort((a, b) => a - b);
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function resolveVideoSrc(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  let src = filePath;
  // Handle all possible filePath formats from DB:
  // "./public/uploads/file.mp4" → "/uploads/file.mp4"
  // "public/uploads/file.mp4" → "/uploads/file.mp4"
  // "/home/runner/workspace/public/uploads/file.mp4" → "/uploads/file.mp4"
  // "/uploads/file.mp4" → "/uploads/file.mp4" (already correct)
  // "/videos/file.mov" → "/videos/file.mov" (already correct)
  src = src.replace(/^\.\/public\//, '/');
  src = src.replace(/^public\//, '/');
  src = src.replace(/^\/home\/runner\/workspace\/public\//, '/');
  // Fix any double slashes
  src = src.replace(/\/\//g, '/');
  // Ensure starts with /
  if (!src.startsWith('/') && !src.startsWith('http')) {
    src = '/' + src;
  }
  return src;
}

function clamp(val: number, min: number, max: number) {
  return Math.min(Math.max(val, min), max);
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

  // Edge feathering via radial gradient clip
  if (blend.featherRadius > 0) {
    const feather = blend.featherRadius;
    const hw = drawWidth / 2;
    const hh = drawHeight / 2;
    // Create a soft-edge rectangle by drawing with decreasing alpha at edges
    // We'll use multiple draws with slight insets
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

// ============================================================================
// DRAW PRODUCT FOR EXPORT (full resolution)
// ============================================================================

function drawProductExport(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  px: number, py: number, pw: number, ph: number,
  transform: PlacementTransform,
  blend: PlacementBlend,
  scaleRatio: number, // canvas display size / export size ratio
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
// REMIX ENGINE COMPONENT
// ============================================================================

export default function RemixEngine() {
  const [, params] = useRoute("/remix/:videoId");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const videoId = params?.videoId ? parseInt(params.videoId) : null;

  // ── User role detection (brands cannot export video) ──
  const { data: userTypeData } = useQuery<{ userType?: "creator" | "brand" | null }>({
    queryKey: ["/api/auth/user-type"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/auth/user-type", { credentials: "include" });
      if (!res.ok) return { userType: null };
      return res.json();
    },
  });
  const isBrand = userTypeData?.userType === "brand";

  // ── Bid context (when creator is fulfilling a brand offer) ──
  const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const bidId = urlParams?.get("bidId") ? parseInt(urlParams.get("bidId")!) : undefined;

  // ── Clip context (creator framing a brand's product INSIDE one editorial
  // clip, rather than at the video level).
  //
  // Geometry is authored in SOURCE-video space either way — the clip renderer
  // composites overlays on the source frame and applies the 9:16 crop
  // afterwards — so this changes WHICH surfaces are offered and what the
  // saved row is tagged with, not the coordinate system.
  const clipId = urlParams?.get("clip") ? parseInt(urlParams.get("clip")!) : undefined;
  const requestedSurfaceId = urlParams?.get("surface") ? parseInt(urlParams.get("surface")!) : undefined;
  const requestedProductId = urlParams?.get("product") ? parseInt(urlParams.get("product")!) : undefined;

  const { data: clipContext } = useQuery<{
    clip: any;
    surfaces: any[];
  } | null>({
    queryKey: ["/api/editorial-clips", clipId, "placement-context"],
    queryFn: async () => {
      const [clipRes, surfRes] = await Promise.all([
        fetchWithTimeout(`/api/editorial-clips/${clipId}`, { credentials: "include" }),
        fetchWithTimeout(`/api/editorial-clips/${clipId}/surfaces`, { credentials: "include" }),
      ]);
      if (!clipRes.ok || !surfRes.ok) return null;
      const clipJson = await clipRes.json();
      const surfJson = await surfRes.json();
      return { clip: clipJson.clip ?? clipJson, surfaces: surfJson.surfaces ?? [] };
    },
    enabled: !!clipId,
  });

  const { data: bidData } = useQuery<any>({
    queryKey: ["/api/bids", bidId],
    queryFn: async () => {
      const res = await fetchWithTimeout(`/api/bids/${bidId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!bidId,
  });

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const productImagesRef = useRef<Map<number, HTMLImageElement>>(new Map());

  // Core state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<Map<string, ProductAssignment>>(new Map());
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(true);
  const [videoReady, setVideoReady] = useState(false);
  const [toolPanel, setToolPanel] = useState<ToolPanel>("catalog");

  // Video export state
  const [exportJobId, setExportJobId] = useState<number | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportOutputUrl, setExportOutputUrl] = useState<string | null>(null);

  // Drag interaction state
  const [dragMode, setDragMode] = useState<DragMode>("none");
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragStartTransform, setDragStartTransform] = useState<PlacementTransform>(DEFAULT_TRANSFORM);

  // ============================================================================
  // DATA FETCHING
  // ============================================================================

  const { data: video, isLoading: videoLoading } = useQuery<VideoDetails>({
    queryKey: ["/api/video", videoId, "details"],
    queryFn: async () => {
      const res = await fetchWithTimeout(`/api/video/${videoId}/details`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch video");
      return res.json();
    },
    enabled: !!videoId,
  });

  const { data: surfacesData } = useQuery<{ surfaces: DetectedSurface[]; count: number }>({
    queryKey: ["/api/video", videoId, "surfaces"],
    enabled: !!videoId,
  });

  const { data: catalogProducts } = useQuery<CatalogProduct[]>({
    queryKey: ["/api/brand-products/catalog"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/brand-products/catalog", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  // Fetch saved placements for this video
  const { data: savedPlacements } = useQuery<any[]>({
    queryKey: ["/api/video", videoId, "placements"],
    queryFn: async () => {
      const res = await fetchWithTimeout(`/api/video/${videoId}/placements`, { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return data.placements || [];
    },
    enabled: !!videoId,
  });

  // ============================================================================
  // DERIVED DATA
  // ============================================================================

  // In clip mode only the fixtures visible inside the clip are offerable —
  // framing a product on a surface the cut never shows produces a placement
  // that renders nowhere.
  const surfaces = useMemo(() => {
    const all = surfacesData?.surfaces || [];
    if (!clipId || !clipContext?.surfaces?.length) return all;
    const allowed = new Set(clipContext.surfaces.map((s: any) => s.id));
    const scoped = all.filter((s: any) => allowed.has(s.id));
    return scoped.length > 0 ? scoped : all;
  }, [surfacesData?.surfaces, clipId, clipContext?.surfaces]);
  const surfaceTracks = useMemo(() => buildSurfaceTracks(surfaces), [surfaces]);
  const sceneTimestamps = useMemo(() => getUniqueTimestamps(surfaces), [surfaces]);
  const videoSrc = useMemo(() => resolveVideoSrc(video?.filePath), [video?.filePath]);
  const [videoError, setVideoError] = useState<string | null>(null);
  // Track keys ordered by type then first appearance, so a video with one
  // surface per type keeps the familiar alphabetical order
  const trackKeys = useMemo(
    () =>
      Array.from(surfaceTracks.values())
        .sort(
          (a, b) =>
            a.surfaceType.localeCompare(b.surfaceType) ||
            (a.keyframes[0]?.timestamp ?? 0) - (b.keyframes[0]?.timestamp ?? 0) ||
            a.trackKey.localeCompare(b.trackKey)
        )
        .map(t => t.trackKey),
    [surfaceTracks]
  );

  // Land the creator on the fixture the brand actually requested, rather than
  // making them find it among every surface in the video.
  const clipModeRef = useRef(false);
  useEffect(() => {
    if (!requestedSurfaceId || clipModeRef.current) return;
    for (const track of Array.from(surfaceTracks.values())) {
      if (track.surfaceIds.includes(requestedSurfaceId)) {
        setSelectedTrack(track.trackKey);
        clipModeRef.current = true;
        break;
      }
    }
  }, [requestedSurfaceId, surfaceTracks]);

  // Display labels: bare type when unique, scene-qualified when the same type
  // appears on multiple tracks
  const trackLabels = useMemo(() => {
    const typeCounts = new Map<string, number>();
    for (const track of Array.from(surfaceTracks.values())) {
      typeCounts.set(track.surfaceType, (typeCounts.get(track.surfaceType) || 0) + 1);
    }
    const labels = new Map<string, string>();
    const used = new Map<string, number>();
    for (const key of trackKeys) {
      const track = surfaceTracks.get(key)!;
      let label = track.surfaceType;
      if ((typeCounts.get(track.surfaceType) || 0) > 1) {
        label = track.sceneId != null
          ? `${track.surfaceType} · scene ${track.sceneId}`
          : track.surfaceType;
        const n = (used.get(label) || 0) + 1;
        used.set(label, n);
        if (n > 1 || (track.sceneId == null && (typeCounts.get(track.surfaceType) || 0) > 1)) {
          label = `${label} (${n})`;
        }
      }
      labels.set(key, label);
    }
    return labels;
  }, [surfaceTracks, trackKeys]);

  const selectedAssignment = selectedTrack ? assignments.get(selectedTrack) : undefined;

  // Auto-select first track
  useEffect(() => {
    if (trackKeys.length > 0 && !selectedTrack) {
      setSelectedTrack(trackKeys[0]);
    }
  }, [trackKeys, selectedTrack]);

  // Auto-load saved placements into assignments when data arrives
  useEffect(() => {
    if (!savedPlacements || savedPlacements.length === 0 || !surfacesData?.surfaces) return;
    // Only load once (don't overwrite user's manual changes)
    if (assignments.size > 0) return;

    const surfaceMap = new Map<number, DetectedSurface>();
    for (const s of surfacesData.surfaces) {
      surfaceMap.set(s.id, s);
    }

    // Group placements by track (one per track, newest wins)
    const byTrack = new Map<string, any>();
    for (const p of savedPlacements) {
      const surface = surfaceMap.get(p.surfaceId);
      if (!surface) continue;
      const trackKey = getTrackKey(surface);
      // Keep the newest placement per track
      if (!byTrack.has(trackKey) || new Date(p.createdAt) > new Date(byTrack.get(trackKey).createdAt)) {
        byTrack.set(trackKey, p);
      }
    }

    if (byTrack.size === 0) return;

    // Preload product images and populate assignments
    const loadAll = async () => {
      const newAssignments = new Map<string, ProductAssignment>();
      for (const [trackKey, placement] of Array.from(byTrack.entries())) {
        try {
          const img = new Image();
          img.crossOrigin = "anonymous";
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("Image load failed"));
            img.src = placement.productImageUrl;
          });
          productImagesRef.current.set(placement.productId || -1, img);
          newAssignments.set(trackKey, {
            productId: placement.productId || -1,
            imageUrl: placement.productImageUrl,
            name: `Saved Placement`,
            imageElement: img,
            transform: placement.transform || { ...DEFAULT_TRANSFORM },
            blend: placement.blend ? {
              opacity: placement.blend.opacity ?? 90,
              blendMode: (placement.blend.blendMode ?? "source-over") as GlobalCompositeOperation,
              shadowEnabled: placement.blend.shadowEnabled ?? true,
              shadowBlur: placement.blend.shadowBlur ?? 8,
              shadowOffsetX: placement.blend.shadowOffsetX ?? 2,
              shadowOffsetY: placement.blend.shadowOffsetY ?? 4,
              shadowColor: placement.blend.shadowColor ?? "rgba(0,0,0,0.4)",
              featherRadius: placement.blend.featherRadius ?? 0,
              brightness: placement.blend.brightness ?? 0,
              contrast: placement.blend.contrast ?? 0,
            } : { ...DEFAULT_BLEND },
          });
        } catch (err) {
          console.warn(`[RemixEngine] Failed to load saved placement for ${trackKey}:`, err);
        }
      }
      if (newAssignments.size > 0) {
        setAssignments(newAssignments);
        console.log(`[RemixEngine] Auto-loaded ${newAssignments.size} saved placement(s)`);
      }
    };
    loadAll();
  }, [savedPlacements, surfacesData?.surfaces]);

  // ============================================================================
  // PRODUCT IMAGE PRELOADING
  // ============================================================================

  const preloadProductImage = useCallback((product: CatalogProduct): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const existing = productImagesRef.current.get(product.id);
      if (existing && existing.complete) { resolve(existing); return; }
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { productImagesRef.current.set(product.id, img); resolve(img); };
      img.onerror = reject;
      img.src = product.imageUrl;
    });
  }, []);

  // ============================================================================
  // CANVAS RENDER LOOP
  // ============================================================================

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const videoEl = videoRef.current;
    if (!canvas || !videoEl || !videoReady) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = videoEl.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }

    const t = videoEl.currentTime;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Max gap between keyframes to render through. If the time gap between prev
    // and next keyframe exceeds this, we assume a camera cut happened and don't
    // interpolate/render during the gap (prevents products appearing in close-ups).
    const MAX_INTERPOLATION_GAP = 4; // seconds

    for (const [surfaceType, track] of Array.from(surfaceTracks.entries())) {
      const { prev, next, progress } = findKeyframes(track.keyframes, t);
      if (!prev) continue;

      // Skip rendering if we're in a gap between distant keyframes (camera cut)
      if (next && (next.timestamp - prev.timestamp) > MAX_INTERPOLATION_GAP) {
        // Only render if we're within MAX_INTERPOLATION_GAP/2 of either keyframe
        const distToPrev = t - prev.timestamp;
        const distToNext = next.timestamp - t;
        if (distToPrev > MAX_INTERPOLATION_GAP / 2 && distToNext > MAX_INTERPOLATION_GAP / 2) {
          continue; // In the middle of a gap — skip this track entirely for this frame
        }
      }
      // If no next keyframe, only render within MAX_INTERPOLATION_GAP of the last one
      if (!next && (t - prev.timestamp) > MAX_INTERPOLATION_GAP) {
        continue;
      }

      const bbox = next && (next.timestamp - prev.timestamp) <= MAX_INTERPOLATION_GAP
        ? lerpBBox(prev.bbox, next.bbox, progress)
        : prev.bbox;
      const px = (bbox.x / 100) * canvas.width;
      const py = (bbox.y / 100) * canvas.height;
      const pw = (bbox.w / 100) * canvas.width;
      const ph = (bbox.h / 100) * canvas.height;

      // Bounding box outlines
      if (showBoundingBoxes) {
        const isSelected = surfaceType === selectedTrack;
        const hasProduct = assignments.has(surfaceType);

        ctx.strokeStyle = hasProduct
          ? "rgba(16, 185, 129, 0.8)"
          : isSelected
            ? "rgba(139, 92, 246, 0.8)"
            : "rgba(255, 255, 255, 0.4)";
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.setLineDash(hasProduct ? [] : [6, 4]);
        ctx.strokeRect(px, py, pw, ph);
        ctx.setLineDash([]);

        // Label
        ctx.font = "bold 11px Inter, system-ui, sans-serif";
        const label = surfaceType;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = hasProduct
          ? "rgba(16, 185, 129, 0.9)"
          : isSelected ? "rgba(139, 92, 246, 0.9)" : "rgba(255, 255, 255, 0.6)";
        ctx.fillRect(px, py - 18, tw + 10, 18);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, px + 5, py - 5);

        // Resize handles for selected + assigned surface
        if (isSelected && hasProduct) {
          const handleSize = 8;
          ctx.fillStyle = "rgba(139, 92, 246, 0.9)";
          // Corners
          ctx.fillRect(px - handleSize / 2, py - handleSize / 2, handleSize, handleSize);
          ctx.fillRect(px + pw - handleSize / 2, py - handleSize / 2, handleSize, handleSize);
          ctx.fillRect(px - handleSize / 2, py + ph - handleSize / 2, handleSize, handleSize);
          ctx.fillRect(px + pw - handleSize / 2, py + ph - handleSize / 2, handleSize, handleSize);
          // Rotation handle
          ctx.beginPath();
          ctx.arc(px + pw / 2, py - 20, 5, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(251, 146, 60, 0.9)";
          ctx.fill();
        }
      }

      // Product overlay
      const assignment = assignments.get(surfaceType);
      if (assignment?.imageElement?.complete) {
        drawProduct(ctx, assignment.imageElement, px, py, pw, ph, assignment.transform, assignment.blend);
      }
    }

    animFrameRef.current = requestAnimationFrame(renderFrame);
  }, [surfaceTracks, assignments, showBoundingBoxes, selectedTrack, videoReady]);

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(renderFrame);
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, [renderFrame]);

  // ============================================================================
  // CANVAS MOUSE INTERACTION (drag to move/resize/rotate products)
  // ============================================================================

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!selectedTrack || !assignments.has(selectedTrack)) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const track = surfaceTracks.get(selectedTrack);
    if (!track) return;

    const videoEl = videoRef.current;
    if (!videoEl) return;

    const { prev, next, progress } = findKeyframes(track.keyframes, videoEl.currentTime);
    if (!prev) return;

    const bbox = next ? lerpBBox(prev.bbox, next.bbox, progress) : prev.bbox;
    const px = (bbox.x / 100) * canvas.width;
    const py = (bbox.y / 100) * canvas.height;
    const pw = (bbox.w / 100) * canvas.width;
    const ph = (bbox.h / 100) * canvas.height;

    const assignment = assignments.get(selectedTrack)!;
    const handleSize = 12;

    // Check rotation handle (circle above center)
    const rotCx = px + pw / 2;
    const rotCy = py - 20;
    if (Math.hypot(mx - rotCx, my - rotCy) < handleSize) {
      setDragMode("rotate");
      setDragStart({ x: mx, y: my });
      setDragStartTransform({ ...assignment.transform });
      e.preventDefault();
      return;
    }

    // Check corner handles
    const corners = [
      { mode: "resize-tl" as DragMode, x: px, y: py },
      { mode: "resize-tr" as DragMode, x: px + pw, y: py },
      { mode: "resize-bl" as DragMode, x: px, y: py + ph },
      { mode: "resize-br" as DragMode, x: px + pw, y: py + ph },
    ];
    for (const c of corners) {
      if (Math.abs(mx - c.x) < handleSize && Math.abs(my - c.y) < handleSize) {
        setDragMode(c.mode);
        setDragStart({ x: mx, y: my });
        setDragStartTransform({ ...assignment.transform });
        e.preventDefault();
        return;
      }
    }

    // Check inside bounding box = move
    if (mx >= px && mx <= px + pw && my >= py && my <= py + ph) {
      setDragMode("move");
      setDragStart({ x: mx, y: my });
      setDragStartTransform({ ...assignment.transform });
      e.preventDefault();
    }
  }, [selectedTrack, assignments, surfaceTracks]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragMode === "none" || !selectedTrack) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const dx = mx - dragStart.x;
    const dy = my - dragStart.y;

    setAssignments(prev => {
      const next = new Map(prev);
      const a = next.get(selectedTrack);
      if (!a) return prev;

      const newTransform = { ...a.transform };

      if (dragMode === "move") {
        newTransform.offsetX = dragStartTransform.offsetX + dx;
        newTransform.offsetY = dragStartTransform.offsetY + dy;
      } else if (dragMode.startsWith("resize")) {
        // Scale based on drag distance
        const dist = Math.hypot(dx, dy);
        const sign = (dx + dy) > 0 ? 1 : -1;
        newTransform.scale = clamp(dragStartTransform.scale + sign * dist * 0.005, 0.1, 4.0);
      } else if (dragMode === "rotate") {
        // Rotation based on horizontal drag
        newTransform.rotation = dragStartTransform.rotation + dx * 0.5;
      }

      next.set(selectedTrack, { ...a, transform: newTransform });
      return next;
    });
  }, [dragMode, dragStart, dragStartTransform, selectedTrack]);

  const handleCanvasMouseUp = useCallback(() => {
    setDragMode("none");
  }, []);

  // ============================================================================
  // VIDEO EVENT HANDLERS
  // ============================================================================

  const handleTimeUpdate = useCallback(() => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
      setVideoReady(true);
    }
  }, []);

  const handlePlayPause = useCallback(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (videoEl.paused) { videoEl.play(); setIsPlaying(true); }
    else { videoEl.pause(); setIsPlaying(false); }
  }, []);

  const handleSeek = useCallback((time: number) => {
    if (videoRef.current) { videoRef.current.currentTime = time; setCurrentTime(time); }
  }, []);

  const handleSeekBar = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    handleSeek(parseFloat(e.target.value));
  }, [handleSeek]);

  // ============================================================================
  // PRODUCT ASSIGNMENT
  // ============================================================================

  const assignProduct = useCallback(async (product: CatalogProduct) => {
    if (!selectedTrack) {
      toast({ title: "Select a surface first", description: "Click a surface pill below the video." });
      return;
    }
    try {
      const img = await preloadProductImage(product);
      setAssignments(prev => {
        const next = new Map(prev);
        next.set(selectedTrack, {
          productId: product.id,
          imageUrl: product.imageUrl,
          name: product.name,
          imageElement: img,
          transform: { ...DEFAULT_TRANSFORM },
          blend: { ...DEFAULT_BLEND },
        });
        return next;
      });
      setToolPanel("transform"); // Auto-switch to transform panel
      toast({ title: "Product placed", description: `${product.name} → ${selectedTrack}. Drag on video to reposition.` });
    } catch {
      toast({ title: "Failed to load product image", variant: "destructive" });
    }
  }, [selectedTrack, preloadProductImage, toast]);

  const removeAssignment = useCallback((surfaceType: string) => {
    setAssignments(prev => { const next = new Map(prev); next.delete(surfaceType); return next; });
  }, []);

  // ============================================================================
  // TRANSFORM / BLEND UPDATERS
  // ============================================================================

  const updateTransform = useCallback((key: keyof PlacementTransform, value: number | boolean) => {
    if (!selectedTrack) return;
    setAssignments(prev => {
      const next = new Map(prev);
      const a = next.get(selectedTrack);
      if (!a) return prev;
      next.set(selectedTrack, {
        ...a,
        transform: { ...a.transform, [key]: value },
      });
      return next;
    });
  }, [selectedTrack]);

  const updateBlend = useCallback((key: keyof PlacementBlend, value: number | boolean | string) => {
    if (!selectedTrack) return;
    setAssignments(prev => {
      const next = new Map(prev);
      const a = next.get(selectedTrack);
      if (!a) return prev;
      next.set(selectedTrack, {
        ...a,
        blend: { ...a.blend, [key]: value },
      });
      return next;
    });
  }, [selectedTrack]);

  const resetTransform = useCallback(() => {
    if (!selectedTrack) return;
    setAssignments(prev => {
      const next = new Map(prev);
      const a = next.get(selectedTrack);
      if (!a) return prev;
      next.set(selectedTrack, { ...a, transform: { ...DEFAULT_TRANSFORM } });
      return next;
    });
  }, [selectedTrack]);

  const resetBlend = useCallback(() => {
    if (!selectedTrack) return;
    setAssignments(prev => {
      const next = new Map(prev);
      const a = next.get(selectedTrack);
      if (!a) return prev;
      next.set(selectedTrack, { ...a, blend: { ...DEFAULT_BLEND } });
      return next;
    });
  }, [selectedTrack]);

  // ============================================================================
  // SAVE PLACEMENT FOR BRAND REVIEW (when fulfilling a bid)
  // ============================================================================

  const [savingForBrand, setSavingForBrand] = useState(false);

  const handleSaveForBrandReview = useCallback(async () => {
    if (!videoId || !selectedTrack || assignments.size === 0) return;
    setSavingForBrand(true);

    try {
      // Save each assignment as a placement linked to the bid
      for (const [surfaceType, assignment] of Array.from(assignments.entries())) {
        const track = surfaceTracks.get(surfaceType);
        if (!track) continue;

        const anchorSurface = surfacesData?.surfaces?.find(
          (s: any) => s.surfaceType === surfaceType || `${s.surfaceType} (${s.id})` === surfaceType
        );
        if (!anchorSurface) continue;

        const res = await fetchWithTimeout("/api/placements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            videoId,
            surfaceId: anchorSurface.id,
            productId: assignment.productId || null,
            productImageUrl: assignment.imageUrl,
            transform: assignment.transform,
            blend: assignment.blend,
            role: "creator",
            bidId: bidId || undefined,
            ...(clipId ? { editorialClipId: clipId } : {}),
          }),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to save placement");
        }

        const data = await res.json();
        if (data.reviewSlug) {
          toast({
            title: "Placement submitted for brand review",
            description: `${bidData?.brandName || "Brand"} will be notified to review your placement.`,
          });
        }
        break; // Save the first assignment linked to bid — additional placements are propagated server-side
      }
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    }
    setSavingForBrand(false);
  }, [videoId, selectedTrack, assignments, surfaceTracks, surfacesData, bidId, bidData, toast]);

  // ============================================================================
  // EXPORT
  // ============================================================================

  const handleExport = useCallback(() => {
    const videoEl = videoRef.current;
    const canvas = canvasRef.current;
    if (!videoEl || !canvas) return;

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = videoEl.videoWidth;
    exportCanvas.height = videoEl.videoHeight;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(videoEl, 0, 0, exportCanvas.width, exportCanvas.height);

    const scaleX = exportCanvas.width / canvas.width;
    const scaleY = exportCanvas.height / canvas.height;

    for (const [surfaceType, assignment] of Array.from(assignments.entries())) {
      const track = surfaceTracks.get(surfaceType);
      if (!track || !assignment.imageElement) continue;

      const { prev, next, progress } = findKeyframes(track.keyframes, videoEl.currentTime);
      if (!prev) continue;

      const bbox = next ? lerpBBox(prev.bbox, next.bbox, progress) : prev.bbox;
      const px = (bbox.x / 100) * exportCanvas.width;
      const py = (bbox.y / 100) * exportCanvas.height;
      const pw = (bbox.w / 100) * exportCanvas.width;
      const ph = (bbox.h / 100) * exportCanvas.height;

      drawProductExport(ctx, assignment.imageElement, px, py, pw, ph, assignment.transform, assignment.blend, scaleX);
    }

    const link = document.createElement("a");
    link.download = `remix-${video?.title || "export"}-${formatTime(videoEl.currentTime).replace(":", "m")}s.jpg`;
    link.href = exportCanvas.toDataURL("image/jpeg", 0.92);
    link.click();
    toast({ title: "Screenshot exported" });
  }, [assignments, surfaceTracks, video?.title, toast]);

  // ── Video Export (Server-Side FFmpeg) ──

  const handleVideoExport = useCallback(async () => {
    if (!videoId || assignments.size === 0) return;

    // Capture canvas display dimensions so server can scale offsets correctly
    const canvas = canvasRef.current;
    const canvasDisplayWidth = canvas?.width || 640;
    const canvasDisplayHeight = canvas?.height || 360;

    const placementData = [];
    for (const [surfaceType, assignment] of Array.from(assignments.entries())) {
      const track = surfaceTracks.get(surfaceType);
      if (!track || !assignment.imageElement) continue;

      // Send product aspect ratio so server can match client-side fitting
      const prodAspect = assignment.imageElement.naturalWidth / assignment.imageElement.naturalHeight;

      placementData.push({
        surfaceType,
        productImageUrl: assignment.imageUrl,
        transform: assignment.transform,
        blend: assignment.blend,
        keyframes: track.keyframes,
        productAspectRatio: prodAspect,
      });
    }

    if (placementData.length === 0) {
      toast({ title: "No placements to export", variant: "destructive" });
      return;
    }

    try {
      setExportDialogOpen(true);
      setExportStatus("queued");
      setExportProgress(0);
      setExportOutputUrl(null);

      const res = await fetchWithTimeout(`/api/video/${videoId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          placements: placementData,
          canvasWidth: canvasDisplayWidth,
          canvasHeight: canvasDisplayHeight,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Export failed to start");
      }

      const { exportId } = await res.json();
      setExportJobId(exportId);
      setExportStatus("processing");
      toast({ title: "Video export started", description: "This may take a few minutes..." });
    } catch (err: any) {
      setExportStatus("failed");
      toast({ title: "Export failed", description: err.message, variant: "destructive" });
    }
  }, [videoId, assignments, surfaceTracks, toast]);

  // Poll for export progress
  useEffect(() => {
    if (!exportJobId || !exportDialogOpen) return;
    if (exportStatus === "complete" || exportStatus === "failed") return;

    const interval = setInterval(async () => {
      try {
        const res = await fetchWithTimeout(`/api/exports/${exportJobId}`, { credentials: "include" });
        if (!res.ok) return;

        const data = await res.json();
        setExportProgress(data.progress || 0);
        setExportStatus(data.status);

        if (data.status === "complete") {
          setExportOutputUrl(data.outputUrl);
          toast({ title: "Video export complete!", description: "Your remixed video is ready to download." });
          clearInterval(interval);
        } else if (data.status === "failed") {
          toast({ title: "Export failed", description: data.error || "Unknown error", variant: "destructive" });
          clearInterval(interval);
        }
      } catch {
        // Silently retry on next interval
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [exportJobId, exportDialogOpen, exportStatus, toast]);

  // ============================================================================
  // SAVE ALL PLACEMENTS
  // ============================================================================

  const [isSaving, setIsSaving] = useState(false);

  const handleSaveAll = useCallback(async () => {
    if (assignments.size === 0 || !videoId) return;
    setIsSaving(true);

    let saved = 0;
    let totalPropagated = 0;

    try {
      for (const [surfaceType, assignment] of Array.from(assignments.entries())) {
        const track = surfaceTracks.get(surfaceType);
        if (!track || track.keyframes.length === 0) continue;

        // Find the first surface ID for this track from the raw surfaces data
        const matchingSurface = surfaces.find(s => s.surfaceType === surfaceType);
        if (!matchingSurface) continue;

        const res = await fetchWithTimeout("/api/placements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            videoId: parseInt(String(videoId)),
            surfaceId: matchingSurface.id,
            productId: assignment.productId > 0 ? assignment.productId : null,
            productImageUrl: assignment.imageUrl,
            transform: assignment.transform,
            blend: assignment.blend,
            ...(clipId ? { editorialClipId: clipId } : {}),
          }),
        });

        if (res.ok) {
          const result = await res.json();
          saved++;
          totalPropagated += result.propagatedCount || 0;
        } else {
          console.warn(`[RemixEngine] Failed to save placement for ${surfaceType}`);
        }
      }

      if (saved > 0) {
        toast({
          title: `Saved ${saved} placement${saved > 1 ? 's' : ''}`,
          description: totalPropagated > 0
            ? `Auto-applied to ${totalPropagated} matching scene(s) for scene persistence.`
            : "Placements persisted. They'll auto-load next time you open Remix Engine.",
        });
      } else {
        toast({ title: "No placements saved", description: "Could not match any assignments to surfaces.", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  }, [assignments, surfaceTracks, surfaces, videoId, toast]);

  // ============================================================================
  // LOADING / ERROR STATES
  // ============================================================================

  if (!videoId) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Invalid video ID</p>
      </div>
    );
  }

  if (videoLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading Remix Engine...</div>
      </div>
    );
  }

  if (!video) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center flex-col gap-4">
        <p className="text-muted-foreground">Video not found</p>
        <button onClick={() => setLocation("/library")} className="text-primary hover:underline">
          ← Back to Library
        </button>
      </div>
    );
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Clip-scoped framing banner.
          The creator got here from a brand's request on ONE editorial clip.
          Only the fixtures that clip actually shows are offered, and the saved
          placement is tagged with the clip so the re-render uses this exact
          framing instead of guessing which saved row was meant. */}
      {clipId && clipContext?.clip && (
        <div className="bg-primary/10 border-b border-primary/25 px-6 py-2.5 flex items-center gap-3 flex-wrap">
          <Sparkles className="w-4 h-4 text-primary shrink-0" />
          <p className="text-xs">
            <span className="font-medium">Placing into a clip.</span>{" "}
            {clipContext.clip.suggestedTitle
              ? <>“{clipContext.clip.suggestedTitle}” — </>
              : null}
            {Number(clipContext.clip.clipStart ?? 0).toFixed(1)}s–
            {Number(clipContext.clip.clipEnd ?? 0).toFixed(1)}s
            {clipContext.clip.aspectRatio ? ` · ${clipContext.clip.aspectRatio}` : ""}.
            Only the {clipContext.surfaces.length} surface
            {clipContext.surfaces.length === 1 ? "" : "s"} visible in this cut can be used.
          </p>
          <span className="text-[11px] text-muted-foreground">
            Position it where you want it, then Save — the clip re-renders with your framing.
          </span>
        </div>
      )}

      {/* Header */}
      <div className="sticky top-0 z-30 bg-card/95 backdrop-blur-sm border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setLocation("/library")}
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Library
          </button>
          <div className="h-5 w-px bg-border" />
          <div>
            <h1 className="text-sm font-semibold">{video.title}</h1>
            <p className="text-xs text-muted-foreground">
              Remix Engine · {surfaces.length} surfaces · {assignments.size} placement{assignments.size !== 1 ? "s" : ""}
              {clipId && clipContext?.clip && (
                <> · framing for clip #{clipId}</>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowBoundingBoxes(!showBoundingBoxes)}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
              showBoundingBoxes ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
            )}
          >
            {showBoundingBoxes ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            Boxes
          </button>

          <button
            onClick={handleSaveAll}
            disabled={assignments.size === 0 || isSaving}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {isSaving ? "Saving..." : "Save Placements"}
          </button>

          <button
            onClick={handleExport}
            disabled={assignments.size === 0}
            className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export Frame
          </button>

          {/* Video export — only available to creators, not brands */}
          {!isBrand && (
            <button
              onClick={handleVideoExport}
              disabled={assignments.size === 0}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Film className="w-3.5 h-3.5" />
              Export Video
            </button>
          )}

          {/* Submit to brand — shown when fulfilling a bid */}
          {bidId && !isBrand && (
            <button
              onClick={handleSaveForBrandReview}
              disabled={assignments.size === 0 || savingForBrand}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {savingForBrand ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
              Submit to Brand
            </button>
          )}
        </div>
      </div>

      {/* Bid context banner — when creator is fulfilling a brand offer */}
      {bidId && bidData && !isBrand && (
        <div className="bg-blue-500/10 border-b border-blue-500/20 px-6 py-2 flex items-center gap-3">
          <Package className="w-4 h-4 text-blue-400" />
          <span className="text-sm text-blue-300">
            Placing product for <strong className="text-blue-200">{bidData.brandName || "brand"}</strong>'s offer
            {bidData.bidAmount && <span className="text-blue-400 ml-1">(${Number(bidData.bidAmount).toLocaleString()})</span>}
          </span>
          {bidData.status === "revision_requested" && bidData.reviewNote && (
            <span className="text-xs text-orange-400 ml-4">
              Revision requested: {bidData.reviewNote}
            </span>
          )}
        </div>
      )}

      {/* Main content */}
      <div className="flex h-[calc(100vh-57px)]">
        {/* Video area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Video + canvas container */}
          <div className="flex-1 flex items-center justify-center bg-black/90 p-4 relative">
            <div ref={containerRef} className="relative max-w-full max-h-full">
              {videoSrc && !videoError ? (
                <>
                  <video
                    ref={videoRef}
                    src={videoSrc}
                    className="max-w-full max-h-[calc(100vh-220px)] rounded-lg"
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                    onError={(e) => {
                      console.error("[RemixEngine] Video load error:", e.currentTarget.error?.message);
                      setVideoError(e.currentTarget.error?.message || "Video format not supported");
                    }}
                    playsInline
                    preload="auto"
                  />
                  <canvas
                    ref={canvasRef}
                    className={cn(
                      "absolute top-0 left-0 w-full h-full rounded-lg",
                      dragMode !== "none" ? "cursor-grabbing" : "cursor-crosshair"
                    )}
                    onMouseDown={handleCanvasMouseDown}
                    onMouseMove={handleCanvasMouseMove}
                    onMouseUp={handleCanvasMouseUp}
                    onMouseLeave={handleCanvasMouseUp}
                  />
                </>
              ) : (
                <div className="w-[640px] h-[360px] bg-zinc-900 rounded-lg flex items-center justify-center">
                  <div className="text-center">
                    <p className="text-zinc-400 text-sm font-medium mb-1">
                      {videoError ? "Video playback error" : "No video file available"}
                    </p>
                    {videoError && (
                      <p className="text-zinc-500 text-xs">{videoError}</p>
                    )}
                    {videoSrc && (
                      <p className="text-zinc-600 text-xs mt-2">Source: {videoSrc}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Controls bar */}
          <div className="bg-card border-t border-border px-6 py-3 space-y-2.5">
            {/* Playback controls */}
            <div className="flex items-center gap-4">
              <button
                onClick={handlePlayPause}
                className="w-9 h-9 rounded-full bg-primary/10 hover:bg-primary/20 flex items-center justify-center transition-colors"
              >
                {isPlaying ? <Pause className="w-4 h-4 text-primary" /> : <Play className="w-4 h-4 text-primary ml-0.5" />}
              </button>

              <span className="text-xs text-muted-foreground tabular-nums w-20">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              <input
                type="range" min={0} max={duration || 0} step={0.1} value={currentTime}
                onChange={handleSeekBar}
                className="flex-1 h-1.5 accent-primary cursor-pointer"
              />
            </div>

            {/* Surface hotkeys + Scene markers */}
            <div className="flex items-center gap-6 flex-wrap">
              {/* Surface-type hotkey buttons — jump to first frame with that surface */}
              {trackKeys.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">Jump to:</span>
                  <div className="flex flex-wrap gap-1">
                    {trackKeys.map((name) => {
                      const track = surfaceTracks.get(name);
                      const firstTs = track?.keyframes[0]?.timestamp ?? 0;
                      const hasAssignment = assignments.has(name);
                      return (
                        <button
                          key={`jump-${name}`}
                          onClick={() => { handleSeek(firstTs); setSelectedTrack(name); }}
                          className={cn(
                            "px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all border",
                            hasAssignment
                              ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
                              : "border-primary/30 bg-primary/10 text-primary hover:bg-primary/20"
                          )}
                        >
                          {name} ({formatTime(firstTs)})
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Scene timestamp markers */}
              {sceneTimestamps.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">Scenes:</span>
                  <div className="flex flex-wrap gap-1">
                    {sceneTimestamps.map((ts) => (
                      <button
                        key={ts}
                        onClick={() => handleSeek(ts)}
                        className={cn(
                          "px-2 py-0.5 rounded text-[10px] font-medium transition-all",
                          Math.abs(currentTime - ts) < 1
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted/60 text-muted-foreground hover:bg-muted"
                        )}
                      >
                        {formatTime(ts)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {trackKeys.length > 0 && (
                <div className="flex items-center gap-2">
                  <Layers className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <div className="flex flex-wrap gap-1">
                    {trackKeys.map((name) => {
                      const isSelected = name === selectedTrack;
                      const hasAssignment = assignments.has(name);
                      return (
                        <button
                          key={name}
                          onClick={() => setSelectedTrack(name)}
                          className={cn(
                            "flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all border",
                            isSelected
                              ? "border-primary bg-primary/10 text-primary"
                              : hasAssignment
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                                : "border-border bg-muted/40 text-muted-foreground hover:bg-muted"
                          )}
                        >
                          {hasAssignment && <CheckCircle className="w-3 h-3" />}
                          {name}
                          {hasAssignment && (
                            <button
                              onClick={(e) => { e.stopPropagation(); removeAssignment(name); }}
                              className="ml-0.5 text-[10px] opacity-50 hover:opacity-100"
                            >✕</button>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right panel */}
        <div className="w-80 bg-card border-l border-border flex flex-col shrink-0">
          {/* Panel tabs */}
          <div className="flex border-b border-border">
            {[
              { id: "catalog" as ToolPanel, icon: Package, label: "Catalog" },
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

          {/* Panel content */}
          <div className="flex-1 overflow-y-auto">
            {/* ============ CATALOG PANEL ============ */}
            {toolPanel === "catalog" && (
              <div className="p-3">
                {selectedTrack ? (
                  <div className="px-2 py-1.5 mb-3 bg-primary/5 rounded-lg border border-primary/20">
                    <p className="text-xs text-primary font-medium">Placing on: {selectedTrack}</p>
                  </div>
                ) : (
                  <div className="px-2 py-1.5 mb-3 bg-muted/30 rounded-lg">
                    <p className="text-xs text-muted-foreground">Select a surface below the video</p>
                  </div>
                )}

                {(!catalogProducts || catalogProducts.length === 0) ? (
                  <div className="text-center py-8">
                    <Package className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                    <div className="text-xs text-muted-foreground space-y-1">
                                  <p className="font-medium text-foreground">No brands available yet</p>
                                  <p className="leading-snug">
                                    You'll see brands that selected you, brands open to any creator,
                                    and any partnership you upload yourself.
                                  </p>
                                </div>
                    <p className="text-[10px] text-muted-foreground/60 mt-1">Upload at /brand-products</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {catalogProducts.map((product) => {
                      const isAssignedToSelected = selectedTrack
                        ? assignments.get(selectedTrack)?.productId === product.id : false;
                      return (
                        <button
                          key={product.id}
                          onClick={() => assignProduct(product)}
                          className={cn(
                            "group relative rounded-lg border overflow-hidden transition-all hover:ring-2 hover:ring-primary/50",
                            isAssignedToSelected ? "border-emerald-500 ring-2 ring-emerald-500/30" : "border-border"
                          )}
                        >
                          <div className="aspect-square bg-[repeating-conic-gradient(#1a1a1a_0%_25%,#222_0%_50%)] bg-[length:16px_16px] flex items-center justify-center p-2">
                            <img
                              src={product.thumbnailUrl || product.imageUrl}
                              alt={product.name}
                              className="max-w-full max-h-full object-contain"
                            />
                          </div>
                          <div className="px-2 py-1.5 bg-card">
                            <p className="text-[10px] font-medium truncate">{product.name}</p>
                          </div>
                          {isAssignedToSelected && (
                            <div className="absolute top-1 right-1">
                              <CheckCircle className="w-4 h-4 text-emerald-400 drop-shadow-md" />
                            </div>
                          )}
                          {product.isTransparent && (
                            <div className="absolute top-1 left-1 bg-black/60 rounded px-1 py-0.5">
                              <span className="text-[8px] text-emerald-400 font-medium">PNG</span>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ============ TRANSFORM PANEL ============ */}
            {toolPanel === "transform" && (
              <div className="p-4 space-y-5">
                {!selectedAssignment ? (
                  <div className="text-center py-8">
                    <Move className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">
                      {selectedTrack ? "Assign a product first" : "Select a surface first"}
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
                        Drag on the video to reposition. Drag corners to resize. Drag the orange dot to rotate.
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
                            type="range" min={-200} max={200} value={selectedAssignment.transform.offsetX}
                            onChange={e => updateTransform("offsetX", parseInt(e.target.value))}
                            className="w-full h-1 accent-primary"
                          />
                          <span className="text-[10px] text-muted-foreground tabular-nums block text-center">
                            {selectedAssignment.transform.offsetX}px
                          </span>
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] text-muted-foreground">Y Offset</span>
                          <input
                            type="range" min={-200} max={200} value={selectedAssignment.transform.offsetY}
                            onChange={e => updateTransform("offsetY", parseInt(e.target.value))}
                            className="w-full h-1 accent-primary"
                          />
                          <span className="text-[10px] text-muted-foreground tabular-nums block text-center">
                            {selectedAssignment.transform.offsetY}px
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
                          {(selectedAssignment.transform.scale * 100).toFixed(0)}%
                        </span>
                      </div>
                      <input
                        type="range" min={10} max={400} value={selectedAssignment.transform.scale * 100}
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
                          {selectedAssignment.transform.rotation.toFixed(0)}°
                        </span>
                      </div>
                      <input
                        type="range" min={-180} max={180} value={selectedAssignment.transform.rotation}
                        onChange={e => updateTransform("rotation", parseInt(e.target.value))}
                        className="w-full h-1.5 accent-primary"
                      />
                    </div>

                    {/* Flip */}
                    <button
                      onClick={() => updateTransform("flipH", !selectedAssignment.transform.flipH)}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium w-full transition-colors border",
                        selectedAssignment.transform.flipH
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
                {!selectedAssignment ? (
                  <div className="text-center py-8">
                    <Blend className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">
                      {selectedTrack ? "Assign a product first" : "Select a surface first"}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Integration</h3>
                      <button onClick={resetBlend} className="text-[10px] text-primary hover:underline">Reset</button>
                    </div>

                    {/* Opacity */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Opacity</span>
                        <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                          {selectedAssignment.blend.opacity}%
                        </span>
                      </div>
                      <input
                        type="range" min={5} max={100} value={selectedAssignment.blend.opacity}
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
                        value={selectedAssignment.blend.blendMode}
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
                        onClick={() => updateBlend("shadowEnabled", !selectedAssignment.blend.shadowEnabled)}
                        className={cn(
                          "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium w-full transition-colors border",
                          selectedAssignment.blend.shadowEnabled
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-muted"
                        )}
                      >
                        <Droplets className="w-3.5 h-3.5" />
                        Drop Shadow
                      </button>

                      {selectedAssignment.blend.shadowEnabled && (
                        <div className="space-y-2 pl-2 border-l-2 border-primary/20 ml-2">
                          <label className="space-y-1">
                            <span className="text-[10px] text-muted-foreground">Blur: {selectedAssignment.blend.shadowBlur}px</span>
                            <input
                              type="range" min={0} max={40} value={selectedAssignment.blend.shadowBlur}
                              onChange={e => updateBlend("shadowBlur", parseInt(e.target.value))}
                              className="w-full h-1 accent-primary"
                            />
                          </label>
                          <div className="grid grid-cols-2 gap-2">
                            <label className="space-y-1">
                              <span className="text-[10px] text-muted-foreground">X: {selectedAssignment.blend.shadowOffsetX}</span>
                              <input
                                type="range" min={-20} max={20} value={selectedAssignment.blend.shadowOffsetX}
                                onChange={e => updateBlend("shadowOffsetX", parseInt(e.target.value))}
                                className="w-full h-1 accent-primary"
                              />
                            </label>
                            <label className="space-y-1">
                              <span className="text-[10px] text-muted-foreground">Y: {selectedAssignment.blend.shadowOffsetY}</span>
                              <input
                                type="range" min={-20} max={20} value={selectedAssignment.blend.shadowOffsetY}
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
                          {selectedAssignment.blend.featherRadius}px
                        </span>
                      </div>
                      <input
                        type="range" min={0} max={20} value={selectedAssignment.blend.featherRadius}
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
                        <span className="text-[10px] text-muted-foreground">Brightness: {selectedAssignment.blend.brightness > 0 ? "+" : ""}{selectedAssignment.blend.brightness}</span>
                        <input
                          type="range" min={-50} max={50} value={selectedAssignment.blend.brightness}
                          onChange={e => updateBlend("brightness", parseInt(e.target.value))}
                          className="w-full h-1 accent-primary"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-[10px] text-muted-foreground">Contrast: {selectedAssignment.blend.contrast > 0 ? "+" : ""}{selectedAssignment.blend.contrast}</span>
                        <input
                          type="range" min={-50} max={50} value={selectedAssignment.blend.contrast}
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

          {/* Assignment summary */}
          {assignments.size > 0 && (
            <div className="px-4 py-3 border-t border-border">
              <p className="text-[10px] text-muted-foreground font-medium mb-2">
                PLACEMENTS ({assignments.size})
              </p>
              <div className="space-y-1.5">
                {Array.from(assignments.entries()).map(([surfaceType, assignment]) => (
                  <div key={surfaceType} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{surfaceType}</span>
                    <span className="text-foreground font-medium truncate ml-2 max-w-[120px]">
                      {assignment.name}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Video Export Progress Dialog ── */}
      {exportDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-xl shadow-2xl p-6 w-96 max-w-[90vw]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-foreground">
                {exportStatus === "complete" ? "Export Complete" :
                 exportStatus === "failed" ? "Export Failed" :
                 "Exporting Video..."}
              </h3>
              {(exportStatus === "complete" || exportStatus === "failed") && (
                <button
                  onClick={() => {
                    setExportDialogOpen(false);
                    setExportJobId(null);
                    setExportStatus(null);
                    setExportProgress(0);
                    setExportOutputUrl(null);
                  }}
                  className="p-1 rounded hover:bg-muted transition-colors"
                >
                  <XIcon className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Progress bar */}
            {exportStatus !== "failed" && (
              <div className="mb-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                  <span>
                    {exportProgress < 10 ? "Extracting frames..." :
                     exportProgress < 90 ? "Compositing products..." :
                     exportProgress < 100 ? "Encoding MP4..." :
                     "Done!"}
                  </span>
                  <span className="tabular-nums font-medium">{exportProgress}%</span>
                </div>
                <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
                  <div
                    className="bg-green-500 h-full rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${exportProgress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Status-specific content */}
            {exportStatus === "processing" || exportStatus === "queued" ? (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span>This may take a few minutes for longer videos...</span>
              </div>
            ) : exportStatus === "complete" && exportOutputUrl ? (
              <div className="space-y-3">
                <p className="text-sm text-green-500 font-medium">
                  <CheckCircle className="w-4 h-4 inline mr-1.5" />
                  Your remixed video is ready!
                </p>
                <div className="flex gap-2">
                  <a
                    href={`/api/exports/${exportJobId}/download`}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    Download
                  </a>
                  <button
                    onClick={async () => {
                      try {
                        const res = await fetchWithTimeout("/api/share", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          credentials: "include",
                          body: JSON.stringify({
                            exportId: exportJobId,
                            videoId: video?.id,
                            title: video?.title || "Remixed Video",
                          }),
                        });
                        if (!res.ok) throw new Error("Failed to create share link");
                        const { slug } = await res.json();
                        const fullUrl = `${window.location.origin}/s/${slug}`;
                        await navigator.clipboard.writeText(fullUrl);
                        toast({ title: "Share link copied!", description: fullUrl });
                      } catch (err: any) {
                        toast({ title: "Share failed", description: err.message, variant: "destructive" });
                      }
                    }}
                    className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                  >
                    <Share2 className="w-4 h-4" />
                    Share
                  </button>
                </div>
              </div>
            ) : exportStatus === "failed" ? (
              <div className="space-y-3">
                <p className="text-sm text-red-500">
                  Export failed. Please try again.
                </p>
                <button
                  onClick={() => {
                    setExportDialogOpen(false);
                    setExportJobId(null);
                    setExportStatus(null);
                  }}
                  className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-muted hover:bg-muted/80 transition-colors"
                >
                  Close
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
