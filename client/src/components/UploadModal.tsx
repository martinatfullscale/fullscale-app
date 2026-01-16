import { useState, useEffect, useCallback, useRef } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Upload, Terminal, X, FileVideo, CheckCircle2, AlertCircle } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { queryClient } from "@/lib/queryClient";

type UploadState = "dropzone" | "selected" | "uploading" | "processing" | "complete" | "error";

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
  onUploadComplete?: () => void;
}

export function UploadModal({ open, onClose, onUploadComplete }: UploadModalProps) {
  const [state, setState] = useState<UploadState>("dropzone");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processingLogs, setProcessingLogs] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetModal = useCallback(() => {
    setState("dropzone");
    setSelectedFile(null);
    setTitle("");
    setUploadProgress(0);
    setProcessingLogs([]);
    setErrorMessage("");
  }, []);

  useEffect(() => {
    if (!open) {
      const timer = setTimeout(resetModal, 300);
      return () => clearTimeout(timer);
    }
  }, [open, resetModal]);

  const handleFileSelect = (file: File) => {
    const allowedTypes = [".mp4", ".mov", ".webm", ".avi"];
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
    
    if (!allowedTypes.includes(ext)) {
      setErrorMessage("Only video files (MP4, MOV, WebM, AVI) are allowed");
      setState("error");
      return;
    }

    if (file.size > 500 * 1024 * 1024) {
      setErrorMessage("File size must be under 500MB");
      setState("error");
      return;
    }

    setSelectedFile(file);
    setTitle(file.name.replace(/\.[^/.]+$/, ""));
    setState("selected");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleUpload = async () => {
    if (!selectedFile) return;

    setState("uploading");
    setProcessingLogs(["> Initializing secure upload stream..."]);

    const formData = new FormData();
    formData.append("video", selectedFile);
    formData.append("title", title || selectedFile.name);

    try {
      const xhr = new XMLHttpRequest();
      
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          setUploadProgress(percent);
          if (percent === 100) {
            setProcessingLogs(prev => [...prev, "> Upload complete. Processing..."]);
            setState("processing");
          }
        }
      };

      xhr.onload = () => {
        if (xhr.status === 200) {
          const response = JSON.parse(xhr.responseText);
          setProcessingLogs(prev => [
            ...prev,
            `> Video saved: ${response.video.title}`,
            `> Video ID: ${response.video.id}`,
            "> Ready for AI scanning!",
            "> SUCCESS: Video added to library."
          ]);
          setState("complete");
          
          queryClient.invalidateQueries({ queryKey: ["videos"] });
          
          setTimeout(() => {
            onUploadComplete?.();
            onClose();
          }, 1500);
        } else {
          const error = JSON.parse(xhr.responseText);
          setErrorMessage(error.error || "Upload failed");
          setState("error");
        }
      };

      xhr.onerror = () => {
        setErrorMessage("Network error during upload");
        setState("error");
      };

      xhr.open("POST", "/api/upload");
      xhr.withCredentials = true;
      xhr.send(formData);
    } catch (error: any) {
      setErrorMessage(error.message || "Upload failed");
      setState("error");
    }
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
                <h2 className="text-xl font-bold text-white">Upload Video</h2>
                <p className="text-sm text-muted-foreground">Upload video content for AI analysis</p>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.webm,.avi,video/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
              data-testid="input-file"
            />

            <button
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              className="w-full aspect-video border-2 border-dashed border-white/20 rounded-xl flex flex-col items-center justify-center gap-4 hover:border-primary/50 hover:bg-primary/5 transition-all cursor-pointer group"
              data-testid="button-dropzone"
            >
              <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                <Upload className="w-8 h-8 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
              <div className="text-center">
                <p className="text-white font-medium mb-1">Drag video file here or Click to Browse</p>
                <p className="text-sm text-muted-foreground">MP4, MOV, WebM, AVI up to 500MB</p>
              </div>
            </button>
          </div>
        )}

        {state === "selected" && selectedFile && (
          <div className="p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
                <FileVideo className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">Confirm Upload</h2>
                <p className="text-sm text-muted-foreground">Review details before uploading</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-white/5 rounded-lg border border-white/10">
                <div className="flex items-center gap-3">
                  <FileVideo className="w-8 h-8 text-primary" />
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium truncate">{selectedFile.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
                    </p>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="icon"
                    onClick={() => {
                      setSelectedFile(null);
                      setState("dropzone");
                    }}
                    data-testid="button-remove-file"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              <div>
                <label className="text-sm text-muted-foreground mb-2 block">Video Title</label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Enter video title"
                  className="bg-white/5 border-white/10"
                  data-testid="input-title"
                />
              </div>

              <div className="flex gap-3">
                <Button 
                  variant="outline" 
                  className="flex-1"
                  onClick={() => {
                    setSelectedFile(null);
                    setState("dropzone");
                  }}
                  data-testid="button-cancel"
                >
                  Cancel
                </Button>
                <Button 
                  className="flex-1 gap-2"
                  onClick={handleUpload}
                  data-testid="button-upload"
                >
                  <Upload className="w-4 h-4" />
                  Upload Video
                </Button>
              </div>
            </div>
          </div>
        )}

        {(state === "uploading" || state === "processing" || state === "complete") && (
          <div className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center">
                <Terminal className="w-4 h-4 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white font-mono">FullScale Upload</h2>
                <p className="text-xs text-emerald-400/70 font-mono">
                  {state === "uploading" ? "Uploading..." : state === "processing" ? "Processing..." : "Complete"}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${state === "complete" ? "bg-emerald-400" : "bg-emerald-400 animate-pulse"}`} />
                <span className="text-xs text-emerald-400 font-mono">
                  {state === "complete" ? "DONE" : "LIVE"}
                </span>
              </div>
            </div>

            {state === "uploading" && (
              <div className="mb-4" data-testid="upload-progress-container">
                <div className="flex justify-between text-sm text-muted-foreground mb-2">
                  <span data-testid="text-upload-filename">Uploading {selectedFile?.name}</span>
                  <span data-testid="text-upload-percent">{uploadProgress}%</span>
                </div>
                <Progress value={uploadProgress} className="h-2" data-testid="progress-upload" />
              </div>
            )}

            <div 
              className="bg-black rounded-lg p-4 font-mono text-sm min-h-[200px] border border-emerald-900/30"
              style={{ 
                boxShadow: 'inset 0 0 30px rgba(0, 0, 0, 0.5)',
                backgroundImage: 'linear-gradient(rgba(16, 185, 129, 0.02) 1px, transparent 1px)',
                backgroundSize: '100% 24px'
              }}
            >
              <div className="space-y-2">
                {processingLogs.map((log, index) => (
                  <div 
                    key={index} 
                    className="flex items-start gap-2 animate-in fade-in slide-in-from-left-2 duration-300"
                  >
                    <span className="text-emerald-500/50 select-none">{String(index + 1).padStart(2, '0')}</span>
                    <span className={`${
                      log.includes("SUCCESS") 
                        ? "text-emerald-400" 
                        : log.includes("Error") || log.includes("failed")
                          ? "text-red-400"
                          : "text-emerald-500/80"
                    }`}>
                      {log}
                    </span>
                  </div>
                ))}
                {(state === "uploading" || state === "processing") && (
                  <div className="flex items-center gap-2 text-emerald-500/50">
                    <span className="animate-pulse">_</span>
                  </div>
                )}
              </div>
            </div>

            {state === "complete" && (
              <div className="mt-4 p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20 flex items-center gap-3" data-testid="upload-complete-container">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm text-emerald-400 font-medium" data-testid="text-upload-success">{title || selectedFile?.name} added to Library</p>
                  <p className="text-xs text-emerald-400/60">Click "Scan" on the video to detect ad placements</p>
                </div>
              </div>
            )}
          </div>
        )}

        {state === "error" && (
          <div className="p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-lg bg-red-500/20 flex items-center justify-center">
                <AlertCircle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">Upload Failed</h2>
                <p className="text-sm text-red-400">{errorMessage}</p>
              </div>
            </div>

            <Button 
              className="w-full"
              onClick={resetModal}
              data-testid="button-try-again"
            >
              Try Again
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
