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
}

const PLACEMENT_SURFACES = [
  "laptop", "tv", "monitor", "cell phone", "keyboard", "mouse", "remote",
  "book", "bottle", "cup", "bowl", "dining table", "desk", "chair", "couch",
  "bed", "potted plant", "vase", "clock", "refrigerator", "microwave",
  "oven", "toaster", "sink", "backpack", "handbag", "suitcase", "umbrella"
];

export function SceneAnalysisModal({ video, open, onClose, adminEmail, onPlayVideo }: SceneAnalysisModalProps) {
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
  
  // Priority: Database surfaces (Gemini AI) > TensorFlow detections > Demo data
  const displaySurfaces = hasDbSurfaces && currentDbSurfaces.length > 0
    ? currentDbSurfaces.map((s) => `${s.surfaceType} (${Math.round(parseFloat(s.confidence) * 100)}%)`)
    : hasScanned 
      ? detections.map((d) => `${d.class} (${Math.round(d.score * 100)}%)`)
      : currentScene.surfaceTypes;

  const displayCount = hasDbSurfaces && currentDbSurfaces.length > 0
    ? currentDbSurfaces.length
    : hasScanned ? detections.length : currentScene.surfaces;
    
  const displayConfidence = hasDbSurfaces && currentDbSurfaces.length > 0
    ? Math.round(currentDbSurfaces.reduce((sum, s) => sum + parseFloat(s.confidence), 0) / currentDbSurfaces.length * 100)
    : hasScanned 
      ? detections.length > 0 
        ? Math.round(detections.reduce((sum, d) => sum + d.score, 0) / detections.length * 100)
        : 0
      : currentScene.confidence;
  
  // Data source indicator
  const dataSource = hasDbSurfaces && currentDbSurfaces.length > 0 
    ? "gemini" 
    : hasScanned 
      ? "tensorflow" 
      : "demo";

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
            className="relative w-full max-w-5xl bg-card border border-white/10 rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {video?.filePath && onPlayVideo && (
              <Button
                size="sm"
                onClick={() => {
                  onClose();
                  onPlayVideo();
                }}
                className="absolute top-4 right-16 z-20 gap-1.5 bg-emerald-600"
                data-testid="button-play-video"
              >
                <Play className="w-4 h-4" />
                Play Video
              </Button>
            )}
            <button
              onClick={onClose}
              className="absolute top-4 right-4 z-20 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
              data-testid="button-modal-close"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex flex-col lg:flex-row">
              <div className="flex-1 relative">
                <div className="aspect-video relative overflow-hidden bg-black">
                  <img
                    ref={imageRef}
                    src={currentScene.imageUrl}
                    alt={`Scene at ${currentScene.timestamp}`}
                    className="w-full h-full object-cover"
                    crossOrigin="anonymous"
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
                        Gemini AI
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

              <div className="lg:w-80 p-6 bg-gradient-to-b from-card to-secondary/20 border-l border-white/10">
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

export const DEMO_VIDEO_SCENES: Record<number, Scene[]> = {
  1001: [
    { id: "1001-1", timestamp: "00:05", imageUrl: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Monitor", "Desk", "Wall", "Shelf"], context: "Wide shot of minimalist workspace showing clean desk setup with monitor and wall decor area", confidence: 96 },
    { id: "1001-2", timestamp: "00:32", imageUrl: "https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Desk Mat", "Keyboard", "Accessories"], context: "Close-up of desk accessories and peripherals with clear product placement space", confidence: 92 },
    { id: "1001-3", timestamp: "01:15", imageUrl: "https://images.unsplash.com/photo-1593642702821-c8da6771f0c6?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Screen", "Background"], context: "Screen recording segment with visible background area", confidence: 88 },
    { id: "1001-4", timestamp: "02:48", imageUrl: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Laptop", "Table", "Hands"], context: "Product demonstration showing laptop and workspace", confidence: 94 },
  ],
  1002: [
    { id: "1002-1", timestamp: "00:12", imageUrl: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&h=450&fit=crop", surfaces: 5, surfaceTypes: ["Counter", "Appliances", "Cabinet", "Backsplash", "Island"], context: "Kitchen overview showing multiple surface areas for product integration", confidence: 97 },
    { id: "1002-2", timestamp: "00:45", imageUrl: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Island", "Stools", "Lighting"], context: "Kitchen island close-up with seating area", confidence: 91 },
    { id: "1002-3", timestamp: "01:30", imageUrl: "https://images.unsplash.com/photo-1556909172-54557c7e4fb7?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Countertop", "Utensils"], context: "Cooking preparation area with clear counter space", confidence: 89 },
  ],
  1003: [
    { id: "1003-1", timestamp: "00:08", imageUrl: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Microphone", "Desk", "Wall", "Monitor"], context: "Professional podcast setup with prominent equipment display", confidence: 98 },
    { id: "1003-2", timestamp: "01:20", imageUrl: "https://images.unsplash.com/photo-1478737270239-2f02b77fc618?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Audio Interface", "Headphones", "Cables"], context: "Audio equipment close-up showing technical gear", confidence: 95 },
    { id: "1003-3", timestamp: "03:45", imageUrl: "https://images.unsplash.com/photo-1590602847861-f357a9332bbc?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Background Wall", "Lighting"], context: "Background shot showing wall space for branding", confidence: 87 },
  ],
  1004: [
    { id: "1004-1", timestamp: "00:15", imageUrl: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Coffee Table", "Sofa", "Rug", "Wall Art"], context: "Living room wide shot with prominent coffee table", confidence: 95 },
    { id: "1004-2", timestamp: "00:48", imageUrl: "https://images.unsplash.com/photo-1583847268964-b28dc8f51f92?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Table Surface", "Decor", "Books"], context: "Coffee table styling close-up", confidence: 93 },
    { id: "1004-3", timestamp: "02:10", imageUrl: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Shelving", "Decorative Items"], context: "Shelf styling with accessory display area", confidence: 90 },
  ],
  1005: [
    { id: "1005-1", timestamp: "00:10", imageUrl: "https://images.unsplash.com/photo-1616588589676-62b3bd4ff6d2?w=800&h=450&fit=crop", surfaces: 5, surfaceTypes: ["Monitor", "Desk", "RGB Wall", "Keyboard", "Mouse"], context: "Ultimate gaming battlestation overview", confidence: 99 },
    { id: "1005-2", timestamp: "01:35", imageUrl: "https://images.unsplash.com/photo-1612287230202-1ff1d85d1bdf?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Headset", "Controller", "Stand"], context: "Gaming accessories close-up display", confidence: 94 },
    { id: "1005-3", timestamp: "03:20", imageUrl: "https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Chair", "Floor Mat"], context: "Gaming chair and floor setup", confidence: 88 },
  ],
  1006: [
    { id: "1006-1", timestamp: "00:05", imageUrl: "https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Desk", "Bookshelf", "Window"], context: "Home office transformation overview", confidence: 93 },
    { id: "1006-2", timestamp: "00:40", imageUrl: "https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Wall", "Lighting"], context: "Office wall decor and lighting setup", confidence: 89 },
  ],
  1007: [
    { id: "1007-1", timestamp: "00:08", imageUrl: "https://images.unsplash.com/photo-1603481588273-2f908a9a7a1b?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Camera", "Microphone", "Lights", "Green Screen"], context: "Streaming studio full setup", confidence: 97 },
    { id: "1007-2", timestamp: "02:15", imageUrl: "https://images.unsplash.com/photo-1587825140708-dfaf72ae4b04?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Webcam", "Monitor", "Desk"], context: "Close-up of streaming equipment", confidence: 94 },
    { id: "1007-3", timestamp: "04:30", imageUrl: "https://images.unsplash.com/photo-1616588589676-62b3bd4ff6d2?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Background", "Panels"], context: "Background setup and acoustic panels", confidence: 91 },
  ],
  1008: [
    { id: "1008-1", timestamp: "00:12", imageUrl: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Kitchen Island", "Stools", "Pendant Lights", "Backsplash"], context: "Modern kitchen island focal point", confidence: 96 },
    { id: "1008-2", timestamp: "01:05", imageUrl: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Counter", "Appliances", "Storage"], context: "Kitchen counter workspace", confidence: 92 },
  ],
  1009: [
    { id: "1009-1", timestamp: "00:20", imageUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Reading Chair", "Bookshelf", "Lamp", "Side Table"], context: "Cozy reading nook complete setup", confidence: 95 },
    { id: "1009-2", timestamp: "01:45", imageUrl: "https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Books", "Decor"], context: "Bookshelf styling details", confidence: 90 },
  ],
  1010: [
    { id: "1010-1", timestamp: "00:08", imageUrl: "https://images.unsplash.com/photo-1593642702821-c8da6771f0c6?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Monitor", "Desk", "Accessories"], context: "Clean workspace essentials overview", confidence: 94 },
    { id: "1010-2", timestamp: "00:55", imageUrl: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Laptop", "Stand"], context: "Laptop setup details", confidence: 91 },
  ],
  1011: [
    { id: "1011-1", timestamp: "00:15", imageUrl: "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800&h=450&fit=crop", surfaces: 5, surfaceTypes: ["Living Area", "Kitchen", "Bedroom", "Windows", "Art"], context: "Studio apartment full overview", confidence: 98 },
    { id: "1011-2", timestamp: "02:30", imageUrl: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Shelving", "Storage", "Decor"], context: "Space-saving storage solutions", confidence: 93 },
    { id: "1011-3", timestamp: "05:15", imageUrl: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Seating", "Table"], context: "Dining and living space", confidence: 90 },
  ],
  1012: [
    { id: "1012-1", timestamp: "00:10", imageUrl: "https://images.unsplash.com/photo-1616594039964-ae9021a400a0?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Bed", "Nightstand", "Wall", "Lighting"], context: "Aesthetic bedroom full reveal", confidence: 96 },
    { id: "1012-2", timestamp: "01:25", imageUrl: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Dresser", "Mirror"], context: "Bedroom vanity area", confidence: 91 },
  ],
};
