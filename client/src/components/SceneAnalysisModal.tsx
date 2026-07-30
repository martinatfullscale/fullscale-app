import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronLeft, ChevronRight, ChevronDown, Target, Clock, Eye, Sparkles, Scan, Loader2, Database, Play, Video, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PlacementPreviewModal from "./PlacementPreviewModal";
import * as tf from "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";

export interface Scene {
  id: string;
  timestamp: string;
  /** Exact frame timestamp in seconds (float). The display `timestamp` label
      is floor-truncated to M:SS, which collides when two sampled frames land
      in the same second — use this for surface↔frame matching. */
  rawTs?: number;
  imageUrl: string;
  surfaces: number;
  surfaceTypes: string[];
  context: string;
  confidence: number;
}

export interface VideoWithScenes {
  id: number;
  title: string;
  duration: string;
  viewCount: number;
  scenes: Scene[];
  filePath?: string | null;
  // Source video identifiers — used by the embedded "Watch original" player
  // for YT/IG/FB videos where we don't store the source bytes ourselves.
  youtubeId?: string | null;
  platform?: string | null;
  sourceUrl?: string | null;
}

interface DetectedObject {
  class: string;
  score: number;
  bbox: [number, number, number, number];
}

// Database surface from FullScale Edge scan
interface DatabaseSurface {
  id: number;
  videoId: number;
  timestamp: string;
  surfaceType: string;
  orientation?: string | null;
  creatorApproved?: boolean;
  confidence: string;
  boundingBoxX: string;
  boundingBoxY: string;
  boundingBoxWidth: string;
  boundingBoxHeight: string;
  frameUrl: string | null;
  sceneContext: string | null;
  surroundings: string[] | null;
  /** Canonical-surface identity stamped at scan time — every detection row
      of the same physical surface shares one id. Null on rows from scans
      that predate group stamping; those fall into the ungrouped tail. */
  surfaceGroupId?: string | null;
}

// Scene-block inventory persisted alongside the scan (video_index.scene_inventory).
// A "scene" is a recurring camera setup — the wide 3-person shot that comes
// back 40 times, the host close-up, etc. Each carries its canonical physical
// surfaces (one entry per surfaceGroupId) with occurrence counts and total
// screen time, so the review UI can show "3 surfaces across 2 scenes" instead
// of a wall of per-frame detection rows. Null for videos scanned before the
// inventory existed — the modal falls back to the flat per-row list.
interface SceneInventorySurface {
  groupId: string;
  surfaceType: string;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
  screenTimeSec: number;
  rowCount: number;
  representativeRowId: number;
  frameUrl: string | null;
}

interface SceneInventoryScene {
  sceneId: number;
  label: string;
  occurrences: number;
  totalSec: number;
  surfaces: SceneInventorySurface[];
}

interface SceneInventory {
  version: number;
  source: "sceneIndex" | "grid";
  scenes: SceneInventoryScene[];
  generatedAt: string;
}

interface SceneAnalysisModalProps {
  video: VideoWithScenes | null;
  open: boolean;
  onClose: () => void;
  adminEmail?: string;
  onPlayVideo?: () => void;
  onPlayFromTimestamp?: (timestamp: number) => void;
}

const PLACEMENT_SURFACES = [
  "laptop", "tv", "monitor", "cell phone", "keyboard", "mouse", "remote",
  "book", "bottle", "cup", "bowl", "dining table", "desk", "chair", "couch",
  "bed", "potted plant", "vase", "clock", "refrigerator", "microwave",
  "oven", "toaster", "sink", "backpack", "handbag", "suitcase", "umbrella"
];

// True when the video can be played in-app via /api/video/:id/source.
// We support local uploads + YT/IG/FB sources (downloaded on demand).
function canPlayInApp(video: VideoWithScenes | null): boolean {
  if (!video) return false;
  if (video.filePath) return true;
  const platform = video.platform?.toLowerCase();
  const ytId = video.youtubeId;
  if (platform === "youtube" && ytId && !ytId.includes(":") && !ytId.startsWith("upload-")) return true;
  if ((platform === "instagram" || platform === "facebook") && ytId) return true;
  return false;
}

// Frame URLs from the DB may carry absolute Replit paths or ./public/
// prefixes from older scans — normalize to a browser-servable root path.
function normalizeFrameUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let src = url;
  src = src.replace(/^\/home\/runner\/workspace\/public\//, '/');
  src = src.replace(/^\.\/public\//, '/');
  src = src.replace(/^public\//, '/');
  src = src.replace(/\/\//g, '/');
  if (!src.startsWith('/') && !src.startsWith('http')) src = '/' + src;
  return src;
}

// Screen-time label for scene/surface headers: "23.4 min" above a minute,
// plain seconds below it.
function formatScreenTime(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return "0s";
  return totalSec >= 60 ? `${(totalSec / 60).toFixed(1)} min` : `${Math.round(totalSec)}s`;
}

export function SceneAnalysisModal({ video, open, onClose, adminEmail, onPlayVideo, onPlayFromTimestamp }: SceneAnalysisModalProps) {
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [model, setModel] = useState<cocoSsd.ObjectDetection | null>(null);
  const [isLoadingModel, setIsLoadingModel] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [detections, setDetections] = useState<DetectedObject[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  // Database surfaces from FullScale Edge scan
  const [dbSurfaces, setDbSurfaces] = useState<DatabaseSurface[]>([]);
  const [isLoadingDbSurfaces, setIsLoadingDbSurfaces] = useState(false);
  const [hasDbSurfaces, setHasDbSurfaces] = useState(false);
  // Scene-block inventory from the same surfaces response. Follows the
  // exact staleness semantics of dbSurfaces: always overwritten together
  // on a successful fetch, null whenever the scan didn't produce one.
  const [sceneInventory, setSceneInventory] = useState<SceneInventory | null>(null);
  // Which canonical surfaces have their per-frame detection rows expanded.
  // Collapsed by default: the sidebar is narrow, and the surface card plus
  // its approve-all action is the primary review unit — the frame rows are
  // drill-down detail.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroupExpanded = (groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  // Server-side rescan state
  const [isServerScanning, setIsServerScanning] = useState(false);
  const [serverScanError, setServerScanError] = useState<string | null>(null);
  const [isPlacementPreviewOpen, setIsPlacementPreviewOpen] = useState(false);

  // Frame loading state — tracks whether the main frame image has loaded
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameError, setFrameError] = useState(false);
  // Toggles between scene-frame view and the in-app video player streamed
  // via /api/video/:id/source. First playback triggers a backend yt-dlp
  // pull to a per-instance cache; subsequent plays within the TTL are
  // instant. We surface the loading state to the user as a progress bar.
  const [showEmbedPlayer, setShowEmbedPlayer] = useState(false);
  const [playerLoadProgress, setPlayerLoadProgress] = useState(0); // 0–100
  const [playerCanPlay, setPlayerCanPlay] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);

  // Local scenes state — starts from video.scenes, rebuilt after server rescan
  const [localScenes, setLocalScenes] = useState<Scene[]>(video?.scenes || []);

  // Sync localScenes when video prop changes or modal opens
  useEffect(() => {
    if (video?.scenes && video.scenes.length > 0) {
      setLocalScenes(video.scenes);
      setCurrentSceneIndex(0);
      setFrameLoaded(false);
      setFrameError(false);
    }
  }, [video?.id, video?.scenes, open]);

  // Rebuild localScenes from freshly-fetched dbSurfaces. The video.scenes
  // prop comes from Library at click time, which may be stale (e.g.,
  // built when the user was unauthenticated and got 0 surfaces). Once the
  // modal's own fetchDatabaseSurfaces returns real data, regenerate
  // scenes by timestamp clusters so navigation arrows actually move
  // through frames with content instead of one stale fallback scene.
  useEffect(() => {
    if (!video?.id) return;
    if (dbSurfaces.length === 0) return;
    const newScenes = buildScenesFromSurfaces(dbSurfaces, video.id);
    if (newScenes.length === 0) return;
    setLocalScenes(newScenes);
    // Reset index if out of range; otherwise preserve user's navigation.
    setCurrentSceneIndex(prev => prev >= newScenes.length ? 0 : prev);
    // The rebuilt scene usually has the string-identical imageUrl (same
    // endpoint feeds Library's builder), so the mounted <img> keeps its key
    // AND src — React never remounts it and no new 'load' event can fire.
    // Resetting frameLoaded=false here would then hide an already-loaded
    // frame forever (onLoad is the only true-setter): the black-view bug.
    // If the img is already complete, keep it visible and paint the fresh
    // bboxes; only reset when a genuinely new load is coming.
    const img = imageRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      setFrameLoaded(true);
      setTimeout(() => drawDbSurfaces(), 100);
    } else {
      setFrameLoaded(false);
      setFrameError(false);
    }
  }, [dbSurfaces, video?.id]);
  
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Fetch database surfaces when modal opens
  useEffect(() => {
    if (open && video?.id) {
      fetchDbSurfaces(video.id);
    }
  }, [open, video?.id]);

  useEffect(() => {
    if (open && !model && !isLoadingModel) {
      loadModel();
    }
  }, [open]);

  useEffect(() => {
    setDetections([]);
    setHasScanned(false);
    setFrameLoaded(false);
    setFrameError(false);
    clearCanvas();
    // Redraw database surfaces when scene changes
    if (hasDbSurfaces && dbSurfaces.length > 0) {
      drawDbSurfaces();
    }
  }, [currentSceneIndex]);
  
  // Fetch surfaces from database API
  const fetchDbSurfaces = async (videoId: number) => {
    console.log(`[SceneAnalysisModal] ===== FETCHING SURFACES =====`);
    console.log(`[SceneAnalysisModal] Video ID: ${videoId}`);
    console.log(`[SceneAnalysisModal] Video object:`, video);
    console.log(`[SceneAnalysisModal] adminEmail prop:`, adminEmail);
    setIsLoadingDbSurfaces(true);
    try {
      // includeUnapproved=true: this modal is the creator's review surface,
      // so we want every detected surface (approved + pending) with its
      // approval state visible. The endpoint enforces that this only returns
      // unapproved data when the requester owns the video.
      const params = new URLSearchParams({ includeUnapproved: "true" });
      if (adminEmail) params.set("admin_email", adminEmail);
      const url = `/api/video/${videoId}/surfaces?${params.toString()}`;
      console.log(`[SceneAnalysisModal] Fetching: ${url}`);
      const res = await fetch(url, { credentials: "include" });
      console.log(`[SceneAnalysisModal] Response status: ${res.status}`);
      if (res.ok) {
        const data = await res.json();
        console.log(`[SceneAnalysisModal] Surfaces from DB:`, data);
        setDbSurfaces(data.surfaces || []);
        setHasDbSurfaces((data.surfaces || []).length > 0);
        setSceneInventory(data.sceneInventory ?? null);
        console.log(`[SceneAnalysisModal] Loaded ${data.surfaces?.length || 0} surfaces, hasDbSurfaces: ${(data.surfaces || []).length > 0}`);
      } else {
        const errText = await res.text();
        console.error(`[SceneAnalysisModal] Failed to fetch: ${res.status}`, errText);
      }
    } catch (err) {
      console.error("[SceneAnalysisModal] Failed to fetch surfaces:", err);
    } finally {
      setIsLoadingDbSurfaces(false);
    }
  };

  // Approve every frame of a canonical surface at once. Deliberately goes
  // through the same per-row PATCH endpoint as the individual toggles —
  // approval stays a per-row fact server-side, this is purely a client
  // convenience. Optimistic like the single-row toggle; any row whose
  // PATCH fails reverts individually so partial success sticks.
  const approveGroupRows = async (rows: DatabaseSurface[]) => {
    const pending = rows.filter(r => !r.creatorApproved);
    if (pending.length === 0) return;
    const pendingIds = new Set(pending.map(r => r.id));
    setDbSurfaces(prev => prev.map(x =>
      pendingIds.has(x.id) ? { ...x, creatorApproved: true } : x
    ));
    const results = await Promise.allSettled(pending.map(r =>
      fetch(`/api/surface/${r.id}/approval`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ approved: true }),
      }).then(res => {
        if (!res.ok) throw new Error("approval failed");
      })
    ));
    const failedIds = new Set(
      pending.filter((_, i) => results[i].status === "rejected").map(r => r.id)
    );
    if (failedIds.size > 0) {
      setDbSurfaces(prev => prev.map(x =>
        failedIds.has(x.id) ? { ...x, creatorApproved: false } : x
      ));
    }
  };

  // Helper: build scenes from surfaces data (same logic as Library.tsx handleVideoClick)
  const buildScenesFromSurfaces = (surfaces: any[], videoId: number): Scene[] => {
    const buildFrameUrl = (ts: number): string => {
      const roundedTs = Math.floor(Number(ts));
      return `/uploads/frames/${videoId}/frame_${roundedTs}s.jpg`;
    };

    const uniqueTimestamps = Array.from(new Set(surfaces.map((s: any) => s.timestamp || 0))) as number[];
    return uniqueTimestamps
      .map((ts: number, idx: number) => {
        const surfacesAtTime = surfaces.filter((s: any) => (s.timestamp || 0) === ts);
        const hasFrame = surfacesAtTime.some((s: any) => s.frameExists !== false);
        const surfaceTypes = Array.from(new Set(surfacesAtTime.map((s: any) => s.surfaceType || s.surface_type))) as string[];
        const avgConfidence = surfacesAtTime.reduce((sum: number, s: any) => sum + (parseFloat(s.confidence) || 0.5), 0) / surfacesAtTime.length;

        return {
          id: `scene-${videoId}-${idx}`,
          timestamp: `${Math.floor(Number(ts) / 60)}:${String(Math.floor(Number(ts) % 60)).padStart(2, '0')}`,
          rawTs: Number(ts) || 0,
          imageUrl: normalizeFrameUrl(surfacesAtTime[0]?.frameUrl || surfacesAtTime[0]?.frame_url) || buildFrameUrl(ts),
          surfaces: surfacesAtTime.length,
          surfaceTypes: surfaceTypes as string[],
          context: surfaceTypes.length > 0 ? `${surfaceTypes[0]} area` : "Workspace",
          confidence: avgConfidence,
          hasFrame,
        };
      });
      // Don't filter by hasFrame — frame URL may still be accessible even if server
      // fs.existsSync check returned false. UI handles broken images with fallback.
  };

  // Server-side rescan: re-extract frames + detect surfaces, then rebuild scenes
  const triggerServerRescan = async () => {
    if (!video?.id) return;

    setIsServerScanning(true);
    setServerScanError(null);

    try {
      // Use admin-scan endpoint (synchronous, returns when scan completes)
      const res = await fetch(`/api/admin-scan/${video.id}`, {
        method: "POST",
        credentials: "include",
      });

      if (!res.ok) {
        // Server now returns a JSON { error } on scan failure (incl. 422 when
        // the scan ran but produced no usable source/surfaces). Surface the
        // real, actionable message instead of raw response text.
        let msg = `Scan failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {
          const t = await res.text().catch(() => "");
          if (t) msg = t;
        }
        throw new Error(msg);
      }

      const scanResult = await res.json();
      console.log(`[SceneAnalysisModal] Server scan complete:`, scanResult);

      // Refetch surfaces from the API
      const surfacesRes = await fetch(`/api/video/${video.id}/surfaces`, { credentials: "include" });
      if (surfacesRes.ok) {
        const data = await surfacesRes.json();
        const surfaces = data.surfaces || [];
        setDbSurfaces(surfaces);
        setHasDbSurfaces(surfaces.length > 0);
        setSceneInventory(data.sceneInventory ?? null);

        // Rebuild scenes from fresh surface data
        const newScenes = buildScenesFromSurfaces(surfaces, video.id);
        if (newScenes.length > 0) {
          setLocalScenes(newScenes);
          setCurrentSceneIndex(0);
        } else {
          // Fallback: single scene from thumbnail
          setLocalScenes([{
            id: `scene-${video.id}-0`,
            timestamp: "0:00",
            imageUrl: `/uploads/frames/${video.id}/frame_0s.jpg`,
            surfaces: scanResult.result?.surfacesDetected || 0,
            surfaceTypes: [],
            context: "Scan complete",
            confidence: 0,
          }]);
          setCurrentSceneIndex(0);
        }
      }
    } catch (err) {
      console.error("[SceneAnalysisModal] Server rescan failed:", err);
      setServerScanError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setIsServerScanning(false);
    }
  };

  // Draw bounding boxes from database surfaces
  const drawDbSurfaces = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    
    // Match canvas to image display size
    const rect = image.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Get current scene's exact frame timestamp. Fall back to parsing the
    // M:SS label for scenes built before rawTs existed (e.g. Library prop).
    const currentScene = localScenes[currentSceneIndex];
    const sceneTimestamp = currentScene?.timestamp || "00:00";
    const [mins, secs] = sceneTimestamp.split(":").map(Number);
    const sceneSeconds = currentScene?.rawTs ?? ((mins || 0) * 60 + (secs || 0));

    // Draw ONLY surfaces detected on THIS frame. A wide window here overlaid
    // other frames' surfaces onto the current image (floor boxes from a 0:34
    // wide shot painted over a 0:29 close-up).
    const sceneSurfaces = dbSurfaces.filter(s => {
      const surfaceTs = parseFloat(s.timestamp) || 0;
      return Math.abs(surfaceTs - sceneSeconds) < 0.75;
    });
    
    if (sceneSurfaces.length === 0) return;
    
    // Draw each surface bounding box
    sceneSurfaces.forEach((surface, idx) => {
      const x = parseFloat(surface.boundingBoxX) * canvas.width;
      const y = parseFloat(surface.boundingBoxY) * canvas.height;
      const w = parseFloat(surface.boundingBoxWidth) * canvas.width;
      const h = parseFloat(surface.boundingBoxHeight) * canvas.height;
      const confidence = Math.round(parseFloat(surface.confidence) * 100);
      
      // Bright colors for visibility
      const colors = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
      const color = colors[idx % colors.length];
      
      // Draw box
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);
      
      // Draw label background
      const label = `${surface.surfaceType} (${confidence}%)`;
      ctx.font = "bold 14px Inter, sans-serif";
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 24, textWidth + 12, 24);
      
      // Draw label text
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, x + 6, y - 7);
    });
  }, [dbSurfaces, currentSceneIndex, video]);

  const loadModel = async () => {
    setIsLoadingModel(true);
    setModelError(null);
    try {
      await tf.ready();
      const loadedModel = await cocoSsd.load({
        base: "lite_mobilenet_v2"
      });
      setModel(loadedModel);
      console.log("[AI] COCO-SSD model loaded successfully");
    } catch (error) {
      console.error("[AI] Failed to load model:", error);
      setModelError("Failed to load AI model. Please try again.");
    } finally {
      setIsLoadingModel(false);
    }
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  const runDetection = useCallback(async () => {
    if (!model || !imageRef.current) {
      console.log("[AI] Model or image not ready");
      return;
    }

    setIsScanning(true);
    clearCanvas();

    try {
      const img = imageRef.current;
      
      await new Promise<void>((resolve) => {
        if (img.complete) {
          resolve();
        } else {
          img.onload = () => resolve();
        }
      });

      const predictions = await model.detect(img);
      console.log("[AI] Detections:", predictions);

      const detected: DetectedObject[] = predictions.map((pred) => ({
        class: pred.class,
        score: pred.score,
        bbox: pred.bbox as [number, number, number, number]
      }));

      setDetections(detected);
      setHasScanned(true);

      drawBoundingBoxes(detected, img);
    } catch (error) {
      console.error("[AI] Detection failed:", error);
    } finally {
      setIsScanning(false);
    }
  }, [model]);

  const drawBoundingBoxes = (objects: DetectedObject[], img: HTMLImageElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const displayWidth = img.clientWidth;
    const displayHeight = img.clientHeight;
    const naturalWidth = img.naturalWidth;
    const naturalHeight = img.naturalHeight;

    canvas.width = displayWidth;
    canvas.height = displayHeight;

    const scaleX = displayWidth / naturalWidth;
    const scaleY = displayHeight / naturalHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const colors = [
      "#10B981", "#3B82F6", "#8B5CF6", "#F59E0B", "#EF4444",
      "#06B6D4", "#EC4899", "#84CC16", "#F97316", "#6366F1"
    ];

    objects.forEach((obj, index) => {
      const [x, y, width, height] = obj.bbox;
      const scaledX = x * scaleX;
      const scaledY = y * scaleY;
      const scaledWidth = width * scaleX;
      const scaledHeight = height * scaleY;

      const color = colors[index % colors.length];
      const confidencePercent = Math.round(obj.score * 100);

      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(scaledX, scaledY, scaledWidth, scaledHeight);

      ctx.fillStyle = color;
      ctx.globalAlpha = 0.2;
      ctx.fillRect(scaledX, scaledY, scaledWidth, scaledHeight);
      ctx.globalAlpha = 1.0;

      const label = `${obj.class} ${confidencePercent}%`;
      ctx.font = "bold 14px Inter, sans-serif";
      const textMetrics = ctx.measureText(label);
      const textHeight = 20;
      const padding = 6;

      const labelX = scaledX;
      const labelY = scaledY > textHeight + padding ? scaledY - 4 : scaledY + scaledHeight + textHeight + padding;

      ctx.fillStyle = color;
      ctx.fillRect(
        labelX,
        labelY - textHeight,
        textMetrics.width + padding * 2,
        textHeight + 4
      );

      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(label, labelX + padding, labelY - 4);
    });
  };

  if (!video || !open) return null;

  const totalScenes = localScenes.length;
  const safeIndex = totalScenes > 0 ? Math.min(currentSceneIndex, totalScenes - 1) : 0;
  const currentScene = totalScenes > 0 ? localScenes[Math.max(0, safeIndex)] : null;

  const goToPrevious = () => {
    setCurrentSceneIndex((prev) => (prev > 0 ? prev - 1 : totalScenes - 1));
  };

  const goToNext = () => {
    setCurrentSceneIndex((prev) => (prev < totalScenes - 1 ? prev + 1 : 0));
  };

  const goToScene = (index: number) => {
    setCurrentSceneIndex(index);
  };

  const placementSurfaces = detections.filter((d) => 
    PLACEMENT_SURFACES.includes(d.class.toLowerCase())
  );
  
  // Get current scene's exact frame timestamp for filtering database surfaces
  const sceneTimestamp = currentScene?.timestamp || "00:00";
  const [mins, secs] = sceneTimestamp.split(":").map(Number);
  const sceneSeconds = currentScene?.rawTs ?? ((mins || 0) * 60 + (secs || 0));

  // Only the surfaces detected on the displayed frame — keeps the sidebar
  // count/types in lockstep with the boxes actually drawn on the image
  const currentDbSurfaces = dbSurfaces.filter(s => {
    const surfaceTs = parseFloat(s.timestamp) || 0;
    return Math.abs(surfaceTs - sceneSeconds) < 0.75;
  });
  
  // Priority: Database surfaces (real scan) > TensorFlow live detections > NO FALLBACK (show empty state)
  // NEVER use demo/placeholder data - only show real scan results
  const displaySurfaces = hasDbSurfaces && currentDbSurfaces.length > 0
    ? currentDbSurfaces.map((s) => `${s.surfaceType} (${Math.round(parseFloat(s.confidence) * 100)}%)`)
    : hasScanned && detections.length > 0
      ? detections.map((d) => `${d.class} (${Math.round(d.score * 100)}%)`)
      : ["No surfaces detected - run scan"];

  const displayCount = hasDbSurfaces && currentDbSurfaces.length > 0
    ? currentDbSurfaces.length
    : hasScanned ? detections.length : 0;
    
  const displayConfidence = hasDbSurfaces && currentDbSurfaces.length > 0
    ? Math.round(currentDbSurfaces.reduce((sum, s) => sum + parseFloat(s.confidence), 0) / currentDbSurfaces.length * 100)
    : hasScanned && detections.length > 0
      ? Math.round(detections.reduce((sum, d) => sum + d.score, 0) / detections.length * 100)
      : 0;
  
  // Data source indicator - NO demo fallback
  const dataSource = hasDbSurfaces && currentDbSurfaces.length > 0
    ? "fullscale"
    : hasScanned && detections.length > 0
      ? "tensorflow"
      : "none";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={onClose}
          data-testid="modal-scene-analysis"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="relative w-full max-w-5xl max-h-[90vh] bg-card border border-white/10 rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {video?.filePath && (onPlayVideo || onPlayFromTimestamp) && (
              <Button
                size="sm"
                onClick={() => {
                  onClose();
                  if (onPlayFromTimestamp) {
                    onPlayFromTimestamp(sceneSeconds);
                  } else if (onPlayVideo) {
                    onPlayVideo();
                  }
                }}
                className="absolute top-4 right-16 z-20 gap-1.5 bg-emerald-600"
                data-testid="button-play-from-here"
              >
                <Play className="w-4 h-4" />
                Play from {currentScene?.timestamp}
              </Button>
            )}
            <button
              onClick={onClose}
              className="absolute top-4 right-4 z-20 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
              data-testid="button-modal-close"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex flex-col lg:flex-row overflow-hidden">
              <div className="flex-1 min-w-0 relative overflow-hidden">
                {/* In-app playback toggle. Pulls the source via
                    /api/video/:id/source (downloaded on demand to a per-instance
                    temp cache, never persisted). Replaces the frame stack +
                    bounding-box overlays with a native <video> player so
                    creators stay in our UI — no leaving to YouTube/IG/FB. */}
                {canPlayInApp(video) && (
                  <Button
                    size="sm"
                    variant={showEmbedPlayer ? "default" : "secondary"}
                    onClick={() => setShowEmbedPlayer(s => !s)}
                    className="absolute top-4 left-4 z-20 gap-1.5"
                    data-testid="button-toggle-inapp-player"
                  >
                    <Play className="w-4 h-4" />
                    {showEmbedPlayer ? "Show scan view" : "Watch video"}
                  </Button>
                )}

                <div className="relative overflow-hidden bg-black flex items-center justify-center" style={{ minHeight: '300px', maxHeight: '70vh' }}>
                  {/* In-app player — streams from our backend. First load may
                      take a few seconds while the source downloads to /tmp;
                      subsequent loads within the cache TTL are instant.
                      Surface buffering progress so the user knows what's
                      happening instead of staring at a black box. */}
                  {showEmbedPlayer && video?.id && canPlayInApp(video) && (
                    <div className="relative w-full" style={{ background: "#000" }}>
                      <video
                        src={`/api/video/${video.id}/source`}
                        controls
                        autoPlay
                        playsInline
                        preload="auto"
                        className="w-full max-h-[70vh] object-contain"
                        data-testid="video-inapp-player"
                        onProgress={(e) => {
                          // HTMLMediaElement.buffered: TimeRanges of buffered segments.
                          // Take the end of the last buffered range as % of duration.
                          const v = e.currentTarget;
                          if (v.duration > 0 && v.buffered.length > 0) {
                            const bufferedEnd = v.buffered.end(v.buffered.length - 1);
                            const pct = Math.min(100, Math.round((bufferedEnd / v.duration) * 100));
                            setPlayerLoadProgress(pct);
                          }
                        }}
                        onCanPlay={() => setPlayerCanPlay(true)}
                        onError={(e) => {
                          const v = e.currentTarget;
                          const err = v.error;
                          setPlayerError(err ? `Code ${err.code}: ${err.message || "playback error"}` : "Failed to load video");
                        }}
                        onWaiting={() => setPlayerCanPlay(false)}
                        onPlaying={() => setPlayerCanPlay(true)}
                      />

                      {/* Loading overlay — visible until we have enough buffered to play */}
                      {!playerCanPlay && !playerError && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 pointer-events-none">
                          <Loader2 className="w-8 h-8 animate-spin text-emerald-400" />
                          <div className="text-sm text-white">Loading video…</div>
                          <div className="text-xs text-zinc-400">
                            {playerLoadProgress > 0 ? `${playerLoadProgress}% buffered` : "Fetching from source"}
                          </div>
                        </div>
                      )}

                      {/* Error overlay */}
                      {playerError && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/85 p-4 text-center">
                          <Video className="w-8 h-8 text-red-400" />
                          <div className="text-sm text-white">Couldn't load video</div>
                          <div className="text-xs text-red-300 max-w-md">{playerError}</div>
                        </div>
                      )}

                      {/* Persistent buffer-progress bar at the bottom — shows
                          download progress beyond what's already played, so
                          users can see how much is ready to seek to. */}
                      {!playerError && playerLoadProgress > 0 && playerLoadProgress < 100 && (
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-800/80 pointer-events-none">
                          <div
                            className="h-full bg-emerald-500/70 transition-[width] duration-300"
                            style={{ width: `${playerLoadProgress}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Layer 1: For local videos, always show <video> as the reliable base layer */}
                  {!showEmbedPlayer && video?.filePath && (
                    <video
                      key={`video-base-${video.id}-${currentSceneIndex}`}
                      src={video.filePath.replace(/^\/home\/runner\/workspace\/public\//, '/').replace(/^\.\/public\//, '/').replace(/^public\//, '/').replace(/\/\//g, '/')}
                      className={`max-w-full max-h-[70vh] object-contain ${frameLoaded ? 'hidden' : ''}`}
                      muted
                      playsInline
                      preload="metadata"
                      onLoadedMetadata={(e) => {
                        const vid = e.currentTarget;
                        const [m, s] = (currentScene?.timestamp || '0:00').split(':').map(Number);
                        vid.currentTime = (m || 0) * 60 + (s || 0);
                      }}
                    />
                  )}

                  {/* Layer 2: Frame image (preferred when available — enables bounding box overlays).
                      The wrapper shrink-wraps to the image so the absolutely-positioned canvas
                      covers exactly the video content — NOT the container's letterbox bars.
                      (Previously the canvas stretched across the full container, so normalized
                      bbox coords spilled into the black bars on vertical video.) */}
                  {!showEmbedPlayer && (
                    <div className="relative max-w-full">
                    <img
                      ref={imageRef}
                      key={`frame-${video?.id}-${currentSceneIndex}`}
                      src={currentScene?.imageUrl || ''}
                      alt={`Scene at ${currentScene?.timestamp || '0:00'}`}
                      className={`max-w-full max-h-[70vh] object-contain ${frameLoaded ? '' : (video?.filePath ? 'absolute opacity-0' : '')}`}
                      data-testid="img-scene-main"
                      onLoad={() => {
                        setFrameLoaded(true);
                        setFrameError(false);
                        // Draw database surfaces after image loads
                        if (hasDbSurfaces && currentDbSurfaces.length > 0) {
                          setTimeout(drawDbSurfaces, 100);
                        }
                      }}
                      onError={(e) => {
                        const img = e.currentTarget;
                        const currentSrc = img.src;
                        // Retry 1: Try on-demand frame generation endpoint
                        if (video?.id && currentScene?.timestamp && !currentSrc.includes('/api/video/')) {
                          const [m, s] = (currentScene.timestamp || '0:00').split(':').map(Number);
                          const ts = (m || 0) * 60 + (s || 0);
                          img.src = `/api/video/${video.id}/frame/${ts}`;
                          return;
                        }
                        // All retries failed — keep video fallback visible
                        setFrameError(true);
                        if (!video?.filePath) {
                          // No video file available either — show static fallback
                          img.style.display = 'none';
                        }
                      }}
                    />
                    <canvas
                      ref={canvasRef}
                      className="absolute inset-0 w-full h-full pointer-events-none"
                      data-testid="canvas-detections"
                    />
                    </div>
                  )}

                  {/* Layer 3: Static fallback only if no video file AND frame failed */}
                  {!showEmbedPlayer && frameError && !video?.filePath && (
                    <div className="w-full flex items-center justify-center bg-zinc-900 text-zinc-500" style={{ minHeight: '300px' }}>
                      <div className="text-center">
                        <Video className="w-12 h-12 mx-auto mb-2 opacity-50" />
                        <p className="text-sm">Frame not available</p>
                        <p className="text-xs mt-1">{currentScene?.timestamp || '0:00'}</p>
                      </div>
                    </div>
                  )}
                  
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent pointer-events-none" />
                  
                  <div className="absolute bottom-4 left-4 flex items-center gap-2">
                    <Badge className="bg-primary/90 text-white">
                      <Clock className="w-3 h-3 mr-1" />
                      {currentScene?.timestamp || '0:00'}
                    </Badge>
                    <Badge className="bg-emerald-500/90 text-white">
                      <Target className="w-3 h-3 mr-1" />
                      {displayCount} {dataSource === "fullscale" ? "Surfaces" : hasScanned ? "Detected" : "Surfaces"}
                    </Badge>
                    {dataSource === "fullscale" && (
                      <Badge className="bg-purple-500/90 text-white">
                        <Database className="w-3 h-3 mr-1" />
                        FullScale Edge
                      </Badge>
                    )}
                    {dataSource === "tensorflow" && (
                      <Badge className="bg-blue-500/90 text-white">
                        AI Scanned
                      </Badge>
                    )}
                    {isLoadingDbSurfaces && (
                      <Badge className="bg-yellow-500/90 text-white">
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                        Loading...
                      </Badge>
                    )}
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={goToPrevious}
                    className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white rounded-full h-10 w-10"
                    data-testid="button-scene-prev"
                  >
                    <ChevronLeft className="w-6 h-6" />
                  </Button>
                  
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={goToNext}
                    className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white rounded-full h-10 w-10"
                    data-testid="button-scene-next"
                  >
                    <ChevronRight className="w-6 h-6" />
                  </Button>
                </div>

                <div className="p-3 bg-black/50 border-t border-white/10 space-y-2">
                  {/* Surface-type hotkey buttons — jump to first scene with that surface */}
                  {(() => {
                    const surfaceTypeSet = new Set<string>();
                    localScenes.forEach(s => s.surfaceTypes?.forEach((t: string) => surfaceTypeSet.add(t)));
                    const types = Array.from(surfaceTypeSet);
                    if (types.length === 0) return null;
                    return (
                      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                        <span className="text-[9px] text-zinc-400 shrink-0 uppercase tracking-wider">Jump to:</span>
                        {types.map(type => {
                          const sceneIdx = localScenes.findIndex(s => s.surfaceTypes?.includes(type));
                          return (
                            <button
                              key={type}
                              onClick={() => sceneIdx >= 0 && goToScene(sceneIdx)}
                              className="px-2 py-0.5 rounded-md text-[10px] font-semibold border border-primary/40 bg-primary/15 text-primary hover:bg-primary/25 transition-all whitespace-nowrap"
                            >
                              {type}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    {localScenes.map((scene, idx) => (
                      <button
                        key={scene.id}
                        onClick={() => goToScene(idx)}
                        className={`relative flex-shrink-0 w-16 h-10 rounded-md overflow-hidden border-2 transition-all ${
                          idx === currentSceneIndex
                            ? "border-primary ring-2 ring-primary/30"
                            : "border-white/20 hover:border-white/40"
                        }`}
                        data-testid={`thumbnail-scene-${idx}`}
                      >
                        <img
                          src={scene.imageUrl}
                          alt={`Scene ${idx + 1}`}
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            const img = e.currentTarget;
                            img.style.display = 'none';
                            const fallback = img.nextElementSibling as HTMLElement;
                            if (fallback) fallback.style.display = 'flex';
                          }}
                        />
                        <div className="w-full h-full bg-zinc-800 items-center justify-center hidden" style={{ display: 'none' }}>
                          <span className="text-[8px] text-zinc-400">{scene.timestamp}</span>
                        </div>
                        <span className="absolute bottom-0 left-0 right-0 bg-black/70 text-[8px] text-white text-center py-0.5">
                          {scene.timestamp}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground text-center mt-2">
                    Scene {currentSceneIndex + 1} of {totalScenes}
                  </p>
                </div>
              </div>

              <div className="lg:w-80 flex-shrink-0 p-6 bg-gradient-to-b from-card to-secondary/20 border-l border-white/10 overflow-y-auto max-h-[90vh]">
                <h3 className="text-lg font-bold text-white mb-1 line-clamp-2" data-testid="text-video-title">
                  {video.title}
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  {video.viewCount.toLocaleString()} views
                </p>

                <Button
                  onClick={triggerServerRescan}
                  disabled={isServerScanning}
                  className="w-full mb-4 gap-2 bg-primary hover:bg-primary/90"
                  data-testid="button-scan-analysis"
                >
                  {isServerScanning ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Scanning Video...
                    </>
                  ) : (
                    <>
                      <Scan className="w-4 h-4" />
                      {hasDbSurfaces ? "Re-Scan Video" : "Scan with FullScale Edge"}
                    </>
                  )}
                </Button>

                {serverScanError && (
                  <p className="text-xs text-red-400 mb-4 text-center">{serverScanError}</p>
                )}

                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <div className="flex items-center gap-2 mb-2">
                      <Target className="w-4 h-4 text-primary" />
                      <span className="text-sm font-medium text-white">
                        {hasScanned ? "Objects Detected" : "Surfaces Found"}
                      </span>
                    </div>
                    <p className="text-2xl font-bold text-primary mb-2" data-testid="text-surfaces-count">
                      {displayCount}
                    </p>
                    <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                      {displaySurfaces.map((surface, idx) => (
                        <Badge 
                          key={idx} 
                          variant="secondary" 
                          className="text-xs"
                          data-testid={`badge-surface-${idx}`}
                        >
                          {surface}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  {hasScanned && placementSurfaces.length > 0 && (
                    <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
                      <div className="flex items-center gap-2 mb-2">
                        <Sparkles className="w-4 h-4 text-emerald-400" />
                        <span className="text-sm font-medium text-white">Potential Placements</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {placementSurfaces.map((surface, idx) => (
                          <Badge 
                            key={idx} 
                            className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 text-xs"
                            data-testid={`badge-placement-${idx}`}
                          >
                            {surface.class}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <div className="flex items-center gap-2 mb-2">
                      <Sparkles className="w-4 h-4 text-emerald-400" />
                      <span className="text-sm font-medium text-white">Scene Context</span>
                    </div>
                    <p className="text-sm text-muted-foreground" data-testid="text-scene-context">
                      {currentScene?.context || 'Scan video to detect surfaces'}
                    </p>
                    {/* Show surroundings from enriched data */}
                    {hasDbSurfaces && currentDbSurfaces.length > 0 && (() => {
                      const surroundings = currentDbSurfaces
                        .flatMap((s: any) => s.surroundings || [])
                        .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
                      return surroundings.length > 0 ? (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {surroundings.slice(0, 8).map((item: string, idx: number) => (
                            <Badge
                              key={idx}
                              variant="outline"
                              className="text-[10px] text-emerald-300 border-emerald-500/30"
                            >
                              {item}
                            </Badge>
                          ))}
                        </div>
                      ) : null;
                    })()}
                  </div>

                  <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <div className="flex items-center gap-2 mb-2">
                      <Eye className="w-4 h-4 text-blue-400" />
                      <span className="text-sm font-medium text-white">
                        {hasScanned ? "AI Detection Confidence" : "AI Confidence"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-white/10 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 rounded-full transition-all duration-500"
                          style={{ width: `${displayConfidence}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium text-white" data-testid="text-confidence">
                        {displayConfidence}%
                      </span>
                    </div>
                  </div>

                  {/* Surface Timeline — shows when the surface is visible */}
                  {hasDbSurfaces && dbSurfaces.filter(s => s.surfaceType !== "Filtered").length > 0 && (() => {
                    const validSurfs = dbSurfaces.filter(s => s.surfaceType !== "Filtered");
                    const timestamps = validSurfs.map(s => parseInt(s.timestamp) || 0).sort((a, b) => a - b);
                    const startTs = timestamps[0];
                    const endTs = timestamps[timestamps.length - 1] + 2; // Add frame interval
                    const surfaceType = validSurfs[0]?.surfaceType || "Surface";
                    // Parse temporal range from sceneContext if available
                    const contextMatch = validSurfs[0]?.sceneContext?.match(/Visible: (\d+)s - (\d+)s \((\d+)s\)/);
                    const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

                    return (
                      <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
                        <div className="flex items-center gap-2 mb-2">
                          <Clock className="w-4 h-4 text-emerald-400" />
                          <span className="text-sm font-medium text-white">Surface Timeline</span>
                        </div>
                        <div className="text-sm text-emerald-300 mb-1">
                          <span className="font-semibold">{surfaceType}</span>
                        </div>
                        <div className="text-xs text-emerald-400/80 space-y-0.5">
                          <div>Appears: <span className="font-mono text-emerald-300">{formatTime(startTs)}</span></div>
                          <div>Ends: <span className="font-mono text-emerald-300">{formatTime(endTs)}</span></div>
                          <div>Duration: <span className="font-mono text-emerald-300">{endTs - startTs}s</span> across <span className="font-mono text-emerald-300">{timestamps.length}</span> frames</div>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Surfaces review — scene-block inventory when the scan
                    produced one (canonical surfaces grouped by recurring
                    scene class), otherwise the flat all-surfaces list.
                    Either way every detection row is visible and clickable
                    to jump to its scene. Surfaces default to hidden from
                    brands; creator approves to expose. */}
                {hasDbSurfaces && dbSurfaces.length > 0 && (() => {
                  const sortedSurfaces = [...dbSurfaces].sort(
                    (a, b) => parseFloat(a.timestamp) - parseFloat(b.timestamp)
                  );
                  // Map surface timestamp → scene index so clicking jumps cleanly
                  const tsToSceneIdx = new Map<number, number>();
                  localScenes.forEach((scene, idx) => {
                    const [m, s] = (scene.timestamp || "0:00").split(":").map(Number);
                    const sec = (m || 0) * 60 + (s || 0);
                    tsToSceneIdx.set(sec, idx);
                  });
                  const currentSceneTs = (() => {
                    const scene = localScenes[currentSceneIndex];
                    if (!scene) return -1;
                    const [m, s] = scene.timestamp.split(":").map(Number);
                    return (m || 0) * 60 + (s || 0);
                  })();

                  // One detection row with its approve/reject controls. Shared
                  // between the scene-block view (nested under each canonical
                  // surface) and the legacy flat list — behavior is identical
                  // in both, only the grouping around the rows differs.
                  const renderSurfaceRow = (s: DatabaseSurface) => {
                          const isApproved = !!s.creatorApproved;
                          const orientation = (s as any).orientation === "vertical" ? "vertical" : "horizontal";
                          const confPct = Math.round(parseFloat(s.confidence) * 100);
                          const ts = parseFloat(s.timestamp) || 0;
                          const tsLabel = `${Math.floor(ts / 60)}:${String(Math.floor(ts % 60)).padStart(2, "0")}`;
                          const isCurrentScene = Math.abs(ts - currentSceneTs) < 1;
                          // Find nearest scene index for jump-on-click
                          let nearestIdx = 0;
                          let nearestDist = Infinity;
                          tsToSceneIdx.forEach((idx, sceneTs) => {
                            const d = Math.abs(sceneTs - ts);
                            if (d < nearestDist) { nearestDist = d; nearestIdx = idx; }
                          });
                          return (
                            <div
                              key={s.id}
                              className={`flex items-center justify-between gap-3 p-2 rounded-lg border transition-colors cursor-pointer hover:bg-white/5 ${
                                isApproved
                                  ? "bg-emerald-500/10 border-emerald-500/40"
                                  : "bg-zinc-800/50 border-zinc-700"
                              } ${isCurrentScene ? "ring-1 ring-primary/60" : ""}`}
                              onClick={(e) => {
                                // Don't jump if the user clicked the Approve button
                                if ((e.target as HTMLElement).closest("button")) return;
                                setCurrentSceneIndex(nearestIdx);
                                setFrameLoaded(false);
                              }}
                              data-testid={`surface-row-${s.id}`}
                            >
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                <Badge
                                  variant="outline"
                                  className={`text-[10px] uppercase ${
                                    orientation === "vertical"
                                      ? "border-blue-500/40 text-blue-300"
                                      : "border-amber-500/40 text-amber-300"
                                  }`}
                                >
                                  {orientation}
                                </Badge>
                                <span className="text-sm font-medium text-white truncate">{s.surfaceType}</span>
                                <span className="text-xs text-muted-foreground font-mono">{tsLabel}</span>
                                <span className="text-xs text-muted-foreground">{confPct}%</span>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <Button
                                  size="sm"
                                  variant={isApproved ? "default" : "secondary"}
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    const next = !isApproved;
                                    setDbSurfaces(prev => prev.map(x =>
                                      x.id === s.id ? { ...x, creatorApproved: next } : x
                                    ));
                                    try {
                                      const res = await fetch(`/api/surface/${s.id}/approval`, {
                                        method: "PATCH",
                                        headers: { "Content-Type": "application/json" },
                                        credentials: "include",
                                        body: JSON.stringify({ approved: next }),
                                      });
                                      if (!res.ok) throw new Error("approval failed");
                                    } catch {
                                      setDbSurfaces(prev => prev.map(x =>
                                        x.id === s.id ? { ...x, creatorApproved: !next } : x
                                      ));
                                    }
                                  }}
                                  data-testid={`button-approve-surface-${s.id}`}
                                >
                                  {isApproved ? "Approved" : "Approve"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 w-8 p-0 text-zinc-400 hover:text-red-400 hover:bg-red-500/10"
                                  title="Reject — remove this detection (wrong label or duplicate)"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    const removed = s;
                                    // Optimistic removal — scenes/counts rebuild from dbSurfaces
                                    setDbSurfaces(prev => prev.filter(x => x.id !== s.id));
                                    try {
                                      const res = await fetch(`/api/surface/${s.id}/reject`, {
                                        method: "POST",
                                        credentials: "include",
                                      });
                                      if (!res.ok) throw new Error("reject failed");
                                    } catch {
                                      setDbSurfaces(prev => [...prev, removed]);
                                    }
                                  }}
                                  data-testid={`button-reject-surface-${s.id}`}
                                >
                                  <X className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                          );
                  };

                  // Scene-block view — authoritative whenever the scan produced
                  // an inventory. One section per recurring scene class, each
                  // listing its canonical physical surfaces; the per-frame
                  // detection rows nest under the surface they belong to so
                  // approval stays per-row.
                  // Zero-surface scene classes still render (below) with an
                  // empty state — a recurring camera setup where every
                  // candidate died in consensus is actionable information
                  // ("rescan may find more"), not noise. Only the ENTRY
                  // decision (inventory view vs legacy flat list) keys on
                  // surface-bearing scenes.
                  const allInvScenes = sceneInventory?.scenes || [];
                  const invScenes = (sceneInventory?.scenes || []).filter(
                    sc => Array.isArray(sc.surfaces) && sc.surfaces.length > 0
                  );
                  if (invScenes.length > 0) {
                    const rowsByGroup = new Map<string, DatabaseSurface[]>();
                    sortedSurfaces.forEach(s => {
                      if (!s.surfaceGroupId) return;
                      const list = rowsByGroup.get(s.surfaceGroupId);
                      if (list) list.push(s);
                      else rowsByGroup.set(s.surfaceGroupId, [s]);
                    });
                    const inventoryGroupIds = new Set<string>();
                    invScenes.forEach(sc => sc.surfaces.forEach(surf => inventoryGroupIds.add(surf.groupId)));
                    // Rows the inventory doesn't claim — legacy rows without a
                    // groupId, or groups pruned after the inventory was built —
                    // still need review controls, so they get a tail section
                    // instead of silently disappearing.
                    const ungroupedRows = sortedSurfaces.filter(
                      s => !s.surfaceGroupId || !inventoryGroupIds.has(s.surfaceGroupId)
                    );
                    const totalCanonical = invScenes.reduce((sum, sc) => sum + sc.surfaces.length, 0);

                    return (
                      <div className="rounded-xl bg-white/5 border border-white/10">
                        <div className="p-3 border-b border-white/10 sticky top-0 bg-zinc-900/95 z-10">
                          <span className="text-sm font-medium text-white block">
                            Scene inventory
                            <span className="text-muted-foreground font-normal"> · {totalCanonical} surface{totalCanonical !== 1 ? "s" : ""} · {allInvScenes.length} scene{allInvScenes.length !== 1 ? "s" : ""}</span>
                          </span>
                          <span className="text-[11px] text-muted-foreground block mt-0.5">Approve to expose to brands · ✕ removes bad detections</span>
                        </div>
                        <div className="max-h-96 overflow-y-auto p-2 space-y-4">
                          {allInvScenes.map((scene) => (
                            <div key={scene.sceneId} data-testid={`scene-block-${scene.sceneId}`}>
                              <div className="px-1 mb-1.5">
                                <div className="flex items-center gap-1.5">
                                  <Layers className="w-3.5 h-3.5 text-primary shrink-0" />
                                  <span className="text-sm font-semibold text-white whitespace-nowrap">{scene.label}</span>
                                  <span className="text-[11px] text-muted-foreground whitespace-nowrap truncate">
                                    {scene.occurrences} shot{scene.occurrences !== 1 ? "s" : ""} · {formatScreenTime(scene.totalSec)}
                                  </span>
                                </div>
                              </div>
                              {scene.surfaces.length === 0 && (
                                <div className="rounded-lg border border-dashed border-white/10 bg-zinc-900/40 p-2.5 text-[11px] text-muted-foreground">
                                  No approved surfaces yet — a rescan may find more in this scene.
                                </div>
                              )}
                              <div className="space-y-2">
                                {scene.surfaces.map((surf) => {
                                  const groupRows = rowsByGroup.get(surf.groupId) || [];
                                  const unapprovedCount = groupRows.filter(r => !r.creatorApproved).length;
                                  const thumbUrl = normalizeFrameUrl(surf.frameUrl);
                                  const isExpanded = expandedGroups.has(surf.groupId);
                                  return (
                                    <div
                                      key={surf.groupId}
                                      className="rounded-lg border border-white/10 bg-zinc-900/60 overflow-hidden"
                                      data-testid={`surface-group-${surf.groupId}`}
                                    >
                                      <div className="p-2 space-y-1.5">
                                        <div className="flex items-center gap-2">
                                          {thumbUrl && (
                                            <img
                                              src={thumbUrl}
                                              alt={surf.surfaceType}
                                              className="w-14 h-9 rounded object-cover shrink-0 border border-white/10"
                                              onError={(e) => { e.currentTarget.style.display = "none"; }}
                                            />
                                          )}
                                          <span className="text-sm font-medium text-white truncate min-w-0 flex-1">{surf.surfaceType}</span>
                                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/10 text-white/70 shrink-0">
                                            {Math.round(surf.confidence * 100)}%
                                          </span>
                                        </div>
                                        <div className="text-[11px] text-muted-foreground truncate">
                                          {formatScreenTime(surf.screenTimeSec)} on screen · {surf.rowCount} frame{surf.rowCount !== 1 ? "s" : ""}
                                        </div>
                                        {groupRows.length > 0 && (
                                          <div className="flex items-center gap-1.5">
                                            <Button
                                              size="sm"
                                              variant={unapprovedCount === 0 ? "outline" : "secondary"}
                                              className="h-7 px-2.5 text-xs flex-1 min-w-0"
                                              disabled={unapprovedCount === 0}
                                              onClick={() => approveGroupRows(groupRows)}
                                              data-testid={`button-approve-group-${surf.groupId}`}
                                            >
                                              {unapprovedCount === 0 ? "Approved ✓" : `Approve all (${unapprovedCount})`}
                                            </Button>
                                            <Button
                                              size="sm"
                                              variant="ghost"
                                              className="h-7 px-2 text-xs text-muted-foreground shrink-0 gap-1"
                                              onClick={() => toggleGroupExpanded(surf.groupId)}
                                              data-testid={`button-expand-group-${surf.groupId}`}
                                            >
                                              {isExpanded
                                                ? <ChevronDown className="w-3.5 h-3.5" />
                                                : <ChevronRight className="w-3.5 h-3.5" />}
                                              {groupRows.length}
                                            </Button>
                                          </div>
                                        )}
                                      </div>
                                      {groupRows.length > 0 && isExpanded && (
                                        <div className="px-2 pb-2 pt-1.5 space-y-1.5 border-t border-white/10 bg-black/20">
                                          {groupRows.map(renderSurfaceRow)}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                          {ungroupedRows.length > 0 && (
                            <div data-testid="section-ungrouped-detections">
                              <div className="px-1 mb-1.5">
                                <span className="text-sm font-semibold text-white block">Ungrouped detections</span>
                                <span className="text-[11px] text-muted-foreground block">
                                  {ungroupedRows.length} row{ungroupedRows.length !== 1 ? "s" : ""} without a canonical surface
                                </span>
                              </div>
                              <div className="space-y-1.5">
                                {ungroupedRows.map(renderSurfaceRow)}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }

                  // Legacy flat list — videos scanned before the inventory existed.
                  return (
                    <div className="rounded-xl bg-white/5 border border-white/10">
                      <div className="flex items-center justify-between p-4 border-b border-white/10 sticky top-0 bg-zinc-900/95 z-10">
                        <span className="text-sm font-medium text-white">
                          All detected surfaces ({dbSurfaces.length})
                        </span>
                        <span className="text-xs text-muted-foreground">Approve to expose to brands · ✕ removes bad detections</span>
                      </div>
                      <div className="max-h-80 overflow-y-auto p-2 space-y-1.5">
                        {sortedSurfaces.map(renderSurfaceRow)}
                      </div>
                    </div>
                  );
                })()}

                {hasDbSurfaces && dbSurfaces.length > 0 && (
                  <Button
                    className="w-full mt-6 gap-2"
                    onClick={() => setIsPlacementPreviewOpen(true)}
                    data-testid="button-preview-placement"
                  >
                    <Layers className="w-4 h-4" />
                    Preview Placement
                  </Button>
                )}

              </div>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* Placement Preview Modal */}
      {video && (
        <PlacementPreviewModal
          open={isPlacementPreviewOpen}
          onClose={() => setIsPlacementPreviewOpen(false)}
          videoId={video.id}
          videoTitle={video.title}
          surfaces={dbSurfaces.map(s => ({
            id: s.id,
            timestamp: parseInt(s.timestamp) || 0,
            surfaceType: s.surfaceType,
            confidence: parseFloat(s.confidence) || 0,
            frameUrl: s.frameUrl,
            boundingBoxX: parseFloat(s.boundingBoxX) || 0,
            boundingBoxY: parseFloat(s.boundingBoxY) || 0,
            boundingBoxWidth: parseFloat(s.boundingBoxWidth) || 0,
            boundingBoxHeight: parseFloat(s.boundingBoxHeight) || 0,
            sceneContext: (s as any).sceneContext || null,
            lightingDirection: (s as any).lightingDirection || null,
            lightingIntensity: (s as any).lightingIntensity ? parseFloat((s as any).lightingIntensity) : null,
            cameraAngle: (s as any).cameraAngle || null,
          }))}
        />
      )}
    </AnimatePresence>
  );
}
