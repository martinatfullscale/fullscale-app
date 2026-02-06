import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronLeft, ChevronRight, Target, Clock, Eye, Sparkles, Scan, Loader2, Database, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import * as tf from "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";

export interface Scene {
  id: string;
  timestamp: string;
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
}

interface DetectedObject {
  class: string;
  score: number;
  bbox: [number, number, number, number];
}

// Database surface from Gemini AI scan
interface DatabaseSurface {
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

export function SceneAnalysisModal({ video, open, onClose, adminEmail, onPlayVideo, onPlayFromTimestamp }: SceneAnalysisModalProps) {
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [model, setModel] = useState<cocoSsd.ObjectDetection | null>(null);
  const [isLoadingModel, setIsLoadingModel] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [detections, setDetections] = useState<DetectedObject[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  
  // Database surfaces from Gemini AI scan
  const [dbSurfaces, setDbSurfaces] = useState<DatabaseSurface[]>([]);
  const [isLoadingDbSurfaces, setIsLoadingDbSurfaces] = useState(false);
  const [hasDbSurfaces, setHasDbSurfaces] = useState(false);
  
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
      // Include admin_email for flexible auth if available
      let url = `/api/video/${videoId}/surfaces`;
      if (adminEmail) {
        url += `?admin_email=${encodeURIComponent(adminEmail)}`;
      }
      console.log(`[SceneAnalysisModal] Fetching: ${url}`);
      const res = await fetch(url, { credentials: "include" });
      console.log(`[SceneAnalysisModal] Response status: ${res.status}`);
      if (res.ok) {
        const data = await res.json();
        console.log(`[SceneAnalysisModal] Surfaces from DB:`, data);
        setDbSurfaces(data.surfaces || []);
        setHasDbSurfaces((data.surfaces || []).length > 0);
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
    
    // Get current scene's timestamp (e.g., "00:05" -> 5)
    const currentScene = video?.scenes[currentSceneIndex];
    const sceneTimestamp = currentScene?.timestamp || "00:00";
    const [mins, secs] = sceneTimestamp.split(":").map(Number);
    const sceneSeconds = (mins || 0) * 60 + (secs || 0);
    
    // Filter surfaces for this timestamp (within 5 second window)
    const sceneSurfaces = dbSurfaces.filter(s => {
      const surfaceTs = parseInt(s.timestamp) || 0;
      return Math.abs(surfaceTs - sceneSeconds) <= 5;
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

  const currentScene = video.scenes[currentSceneIndex];
  const totalScenes = video.scenes.length;

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
  
  // Get current scene's timestamp for filtering database surfaces
  const sceneTimestamp = currentScene?.timestamp || "00:00";
  const [mins, secs] = sceneTimestamp.split(":").map(Number);
  const sceneSeconds = (mins || 0) * 60 + (secs || 0);
  
  // Filter database surfaces for current timestamp (within 5 second window)
  const currentDbSurfaces = dbSurfaces.filter(s => {
    const surfaceTs = parseInt(s.timestamp) || 0;
    return Math.abs(surfaceTs - sceneSeconds) <= 5;
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
    ? "gemini" 
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
                <div className="relative overflow-hidden bg-black flex items-center justify-center" style={{ minHeight: '300px', maxHeight: '70vh' }}>
                  <img
                    ref={imageRef}
                    src={currentScene.imageUrl}
                    alt={`Scene at ${currentScene.timestamp}`}
                    className="max-w-full max-h-[70vh] object-contain"
                    data-testid="img-scene-main"
                    onLoad={() => {
                      // Draw database surfaces after image loads
                      if (hasDbSurfaces && currentDbSurfaces.length > 0) {
                        setTimeout(drawDbSurfaces, 100);
                      }
                    }}
                  />
                  
                  <canvas
                    ref={canvasRef}
                    className="absolute inset-0 w-full h-full pointer-events-none"
                    data-testid="canvas-detections"
                  />
                  
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent pointer-events-none" />
                  
                  <div className="absolute bottom-4 left-4 flex items-center gap-2">
                    <Badge className="bg-primary/90 text-white">
                      <Clock className="w-3 h-3 mr-1" />
                      {currentScene.timestamp}
                    </Badge>
                    <Badge className="bg-emerald-500/90 text-white">
                      <Target className="w-3 h-3 mr-1" />
                      {displayCount} {dataSource === "gemini" ? "Surfaces" : hasScanned ? "Detected" : "Surfaces"}
                    </Badge>
                    {dataSource === "gemini" && (
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

                <div className="p-3 bg-black/50 border-t border-white/10">
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    {video.scenes.map((scene, idx) => (
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
                        />
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
                  onClick={runDetection}
                  disabled={isLoadingModel || isScanning || !model}
                  className="w-full mb-4 gap-2"
                  data-testid="button-scan-analysis"
                >
                  {isLoadingModel ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading AI Model...
                    </>
                  ) : isScanning ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Scanning...
                    </>
                  ) : (
                    <>
                      <Scan className="w-4 h-4" />
                      {hasScanned ? "Re-Scan Scene" : "Scan Analysis"}
                    </>
                  )}
                </Button>

                {modelError && (
                  <p className="text-xs text-red-400 mb-4 text-center">{modelError}</p>
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
                      {currentScene.context}
                    </p>
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
                </div>

                <Button 
                  className="w-full mt-6"
                  data-testid="button-view-opportunities"
                >
                  View Ad Opportunities
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
