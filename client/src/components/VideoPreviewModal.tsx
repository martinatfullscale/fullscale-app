import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Play, Pause, Volume2, VolumeX, Loader2, Scan, CheckCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface VideoPreviewModalProps {
  video: {
    id: number;
    title: string;
    filePath?: string | null;
    thumbnailUrl?: string | null;
    status?: string;
    platform?: string;
  } | null;
  open: boolean;
  onClose: () => void;
  isScanning?: boolean;
}

export function VideoPreviewModal({ video, open, onClose, isScanning = false }: VideoPreviewModalProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [isGeneratingThumbnails, setIsGeneratingThumbnails] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (open && video?.filePath && videoRef.current) {
      setIsPlaying(false);
      setCurrentTime(0);
      setThumbnails([]);
    }
  }, [open, video?.id]);

  const getVideoSrc = () => {
    if (!video?.filePath) return null;
    let path = video.filePath;
    if (path.startsWith("/home/runner/workspace/public/")) {
      path = "/" + path.replace("/home/runner/workspace/public/", "");
    } else if (path.startsWith("./public/")) {
      path = path.replace("./public", "");
    } else if (path.startsWith("public/")) {
      path = "/" + path.replace("public/", "");
    }
    return path;
  };

  const videoSrc = getVideoSrc();

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    videoRef.current.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    setCurrentTime(videoRef.current.currentTime);
  };

  const handleLoadedMetadata = () => {
    if (!videoRef.current) return;
    setDuration(videoRef.current.duration);
  };

  const generateThumbnails = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    
    setIsGeneratingThumbnails(true);
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const thumbs: string[] = [];
    const intervals = [0.1, 0.25, 0.5, 0.75, 0.9];
    
    for (const interval of intervals) {
      const targetTime = video.duration * interval;
      video.currentTime = targetTime;
      
      await new Promise<void>((resolve) => {
        const handleSeeked = () => {
          canvas.width = 320;
          canvas.height = 180;
          ctx.drawImage(video, 0, 0, 320, 180);
          thumbs.push(canvas.toDataURL("image/jpeg", 0.8));
          video.removeEventListener("seeked", handleSeeked);
          resolve();
        };
        video.addEventListener("seeked", handleSeeked);
      });
    }
    
    setThumbnails(thumbs);
    setIsGeneratingThumbnails(false);
    video.currentTime = 0;
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getStatusBadge = () => {
    if (isScanning) {
      return (
        <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 gap-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          Scanning...
        </Badge>
      );
    }
    if (video?.status === "completed" || video?.status === "Scan Complete") {
      return (
        <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 gap-1">
          <CheckCircle className="w-3 h-3" />
          Scan Complete
        </Badge>
      );
    }
    return (
      <Badge className="bg-zinc-500/20 text-zinc-400 border-zinc-500/30 gap-1">
        <Clock className="w-3 h-3" />
        Pending
      </Badge>
    );
  };

  if (!open || !video) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          className="relative w-full max-w-4xl mx-4 bg-zinc-900 rounded-xl overflow-hidden shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between p-4 border-b border-zinc-800">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-white">{video.title}</h2>
              {getStatusBadge()}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="text-zinc-400 hover:text-white"
              data-testid="button-close-preview"
            >
              <X className="w-5 h-5" />
            </Button>
          </div>

          <div className="relative aspect-video bg-black">
            {videoSrc ? (
              <>
                <video
                  ref={videoRef}
                  src={videoSrc}
                  className="w-full h-full object-contain"
                  onTimeUpdate={handleTimeUpdate}
                  onLoadedMetadata={handleLoadedMetadata}
                  onEnded={() => setIsPlaying(false)}
                  muted={isMuted}
                  playsInline
                  data-testid="video-preview-player"
                />
                <canvas ref={canvasRef} className="hidden" />
                
                <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent">
                  <div className="flex items-center gap-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={togglePlay}
                      className="text-white hover:bg-white/20"
                      data-testid="button-play-pause"
                    >
                      {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={toggleMute}
                      className="text-white hover:bg-white/20"
                      data-testid="button-mute"
                    >
                      {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                    </Button>
                    <div className="flex-1 h-1 bg-zinc-600 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-red-500 transition-all"
                        style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-sm text-white/80 font-mono">
                      {formatTime(currentTime)} / {formatTime(duration)}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-full">
                <div className="text-center text-zinc-500">
                  <Play className="w-16 h-16 mx-auto mb-2 opacity-50" />
                  <p>No local file available</p>
                  <p className="text-sm">Upload a video to preview</p>
                </div>
              </div>
            )}
          </div>

          {videoSrc && (
            <div className="p-4 border-t border-zinc-800">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-zinc-300">Video Frames</h3>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={generateThumbnails}
                  disabled={isGeneratingThumbnails}
                  className="gap-2"
                  data-testid="button-generate-thumbnails"
                >
                  {isGeneratingThumbnails ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Extracting...
                    </>
                  ) : (
                    <>
                      <Scan className="w-3 h-3" />
                      Extract Frames
                    </>
                  )}
                </Button>
              </div>
              
              {thumbnails.length > 0 ? (
                <div className="grid grid-cols-5 gap-2">
                  {thumbnails.map((thumb, i) => (
                    <div 
                      key={i} 
                      className="aspect-video rounded-md overflow-hidden bg-zinc-800 cursor-pointer hover:ring-2 hover:ring-red-500 transition-all"
                      onClick={() => {
                        if (videoRef.current && duration) {
                          const intervals = [0.1, 0.25, 0.5, 0.75, 0.9];
                          videoRef.current.currentTime = duration * intervals[i];
                        }
                      }}
                    >
                      <img 
                        src={thumb} 
                        alt={`Frame ${i + 1}`} 
                        className="w-full h-full object-cover"
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-5 gap-2">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div 
                      key={i} 
                      className="aspect-video rounded-md bg-zinc-800 flex items-center justify-center"
                    >
                      <span className="text-xs text-zinc-600">Frame {i}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
