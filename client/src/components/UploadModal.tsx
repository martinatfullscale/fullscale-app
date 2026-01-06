import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Upload, Terminal } from "lucide-react";

type UploadState = "dropzone" | "processing" | "complete";

interface LogEntry {
  text: string;
  delay: number;
}

const processingLogs: LogEntry[] = [
  { text: "> Initializing secure upload stream...", delay: 0 },
  { text: "> Upload Complete. Sending to /api/indexer...", delay: 1500 },
  { text: "> FFMPEG: Extracting keyframes (Batch 1/12)...", delay: 3000 },
  { text: "> VISION_MODEL: Detecting surfaces (Desk, Wall, Counter)...", delay: 4500 },
  { text: "> SUCCESS: 4 Ad Opportunities Indexed.", delay: 6000 },
];

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
  onUploadComplete?: () => void;
}

export function UploadModal({ open, onClose, onUploadComplete }: UploadModalProps) {
  const [state, setState] = useState<UploadState>("dropzone");
  const [visibleLogs, setVisibleLogs] = useState<string[]>([]);

  const resetModal = useCallback(() => {
    setState("dropzone");
    setVisibleLogs([]);
  }, []);

  useEffect(() => {
    if (!open) {
      const timer = setTimeout(resetModal, 300);
      return () => clearTimeout(timer);
    }
  }, [open, resetModal]);

  useEffect(() => {
    if (state !== "processing") return;

    const timers: NodeJS.Timeout[] = [];

    processingLogs.forEach((log, index) => {
      const timer = setTimeout(() => {
        setVisibleLogs((prev) => [...prev, log.text]);

        if (index === processingLogs.length - 1) {
          setTimeout(() => {
            setState("complete");
            onUploadComplete?.();
            setTimeout(() => {
              onClose();
            }, 800);
          }, 1200);
        }
      }, log.delay);
      timers.push(timer);
    });

    return () => {
      timers.forEach(clearTimeout);
    };
  }, [state, onClose, onUploadComplete]);

  const handleDropZoneClick = () => {
    setState("processing");
    setVisibleLogs([]);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl p-0 bg-zinc-900 border-white/10 overflow-hidden">
        {state === "dropzone" && (
          <div className="p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
                <Upload className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">Ingest New Media</h2>
                <p className="text-sm text-muted-foreground">Upload video content for AI analysis</p>
              </div>
            </div>

            <button
              onClick={handleDropZoneClick}
              className="w-full aspect-video border-2 border-dashed border-white/20 rounded-xl flex flex-col items-center justify-center gap-4 hover:border-primary/50 hover:bg-primary/5 transition-all cursor-pointer group"
              data-testid="button-dropzone"
            >
              <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                <Upload className="w-8 h-8 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
              <div className="text-center">
                <p className="text-white font-medium mb-1">Drag video file here or Click to Browse</p>
                <p className="text-sm text-muted-foreground">MP4, MOV, AVI up to 2GB</p>
              </div>
            </button>
          </div>
        )}

        {(state === "processing" || state === "complete") && (
          <div className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center">
                <Terminal className="w-4 h-4 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white font-mono">FullScale Indexer v2.4</h2>
                <p className="text-xs text-emerald-400/70 font-mono">Processing Pipeline Active</p>
              </div>
              {state === "processing" && (
                <div className="ml-auto flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs text-emerald-400 font-mono">LIVE</span>
                </div>
              )}
              {state === "complete" && (
                <div className="ml-auto flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="text-xs text-emerald-400 font-mono">COMPLETE</span>
                </div>
              )}
            </div>

            <div 
              className="bg-black rounded-lg p-4 font-mono text-sm min-h-[280px] border border-emerald-900/30"
              style={{ 
                boxShadow: 'inset 0 0 30px rgba(0, 0, 0, 0.5)',
                backgroundImage: 'linear-gradient(rgba(16, 185, 129, 0.02) 1px, transparent 1px)',
                backgroundSize: '100% 24px'
              }}
            >
              <div className="space-y-3">
                {visibleLogs.map((log, index) => (
                  <div 
                    key={index} 
                    className="flex items-start gap-2 animate-in fade-in slide-in-from-left-2 duration-300"
                  >
                    <span className="text-emerald-500/50 select-none">{String(index + 1).padStart(2, '0')}</span>
                    <span className={`${
                      log.includes("SUCCESS") 
                        ? "text-emerald-400" 
                        : log.includes("FFMPEG") || log.includes("VISION_MODEL")
                          ? "text-cyan-400"
                          : "text-emerald-500/80"
                    }`}>
                      {log}
                    </span>
                  </div>
                ))}
                {state === "processing" && visibleLogs.length < processingLogs.length && (
                  <div className="flex items-center gap-2 text-emerald-500/50">
                    <span className="animate-pulse">_</span>
                  </div>
                )}
              </div>
            </div>

            {state === "complete" && (
              <div className="mt-4 p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <span className="text-emerald-400 text-lg">+</span>
                </div>
                <div>
                  <p className="text-sm text-emerald-400 font-medium">Demo_Upload.mp4 added to Library</p>
                  <p className="text-xs text-emerald-400/60">4 placement opportunities detected</p>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
