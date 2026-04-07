import { useState, useRef, useCallback, useEffect } from "react";
import { Upload, FileVideo, Loader2, CheckCircle, AlertCircle, Download, Play, Rocket, ShoppingCart, Users, Megaphone } from "lucide-react";

type PipelineStatus = "idle" | "uploading" | "queued" | "processing" | "parsing" | "extracting" | "generating" | "adding-voice" | "assembling" | "complete" | "failed";

type DeckIntent = "investor-pitch" | "sales-deck" | "team-update" | "marketing";

const DECK_INTENTS: { value: DeckIntent; label: string; description: string; icon: typeof Rocket }[] = [
  { value: "investor-pitch", label: "Investor Pitch", description: "Fast, confident — built to raise", icon: Rocket },
  { value: "sales-deck", label: "Sales Deck", description: "Persuasive — show the solution", icon: ShoppingCart },
  { value: "team-update", label: "Team Update", description: "Clear, measured — status report", icon: Users },
  { value: "marketing", label: "Marketing", description: "Energetic — tell your story", icon: Megaphone },
];

const STAGE_LABELS: Record<string, string> = {
  idle: "Ready",
  uploading: "Uploading...",
  queued: "Queued",
  processing: "Processing...",
  parsing: "Parsing document...",
  extracting: "Extracting story...",
  generating: "Generating visuals...",
  "adding-voice": "Adding voice narration...",
  assembling: "Assembling video...",
  complete: "Complete!",
  failed: "Failed",
};

const STAGE_ORDER: PipelineStatus[] = [
  "parsing",
  "extracting",
  "generating",
  "adding-voice",
  "assembling",
  "complete",
];

function StudioUsageBadge() {
  const [usage, setUsage] = useState<{ videosGenerated: number; videosLimit: number; tier: string } | null>(null);
  useEffect(() => {
    fetch("/api/studio/me")
      .then(r => r.json())
      .then(data => {
        if (data.usage && data.subscription) {
          setUsage({
            videosGenerated: data.usage.videosGenerated,
            videosLimit: data.usage.videosLimit,
            tier: data.subscription.tier,
          });
        }
      })
      .catch(() => {});
  }, []);

  if (!usage) return null;
  const remaining = Math.max(0, usage.videosLimit - usage.videosGenerated);
  const isUnlimited = usage.videosLimit >= 1000;

  return (
    <div className="text-center mb-8">
      <span className="inline-block bg-purple-900/30 border border-purple-800/50 text-purple-300 text-sm px-4 py-1.5 rounded-full">
        {isUnlimited
          ? `Unlimited videos (${usage.tier})`
          : `${remaining} of ${usage.videosLimit} videos remaining this month`}
      </span>
    </div>
  );
}

export default function StudioUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [deckIntent, setDeckIntent] = useState<DeckIntent>("investor-pitch");
  const [status, setStatus] = useState<PipelineStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && isValidFile(droppedFile)) {
      setFile(droppedFile);
      setError(null);
    } else {
      setError("Only PDF and PPTX files are accepted.");
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected && isValidFile(selected)) {
      setFile(selected);
      setError(null);
    } else if (selected) {
      setError("Only PDF and PPTX files are accepted.");
    }
  }, []);

  const isValidFile = (f: File) => {
    const ext = f.name.toLowerCase();
    return ext.endsWith(".pdf") || ext.endsWith(".pptx");
  };

  const handleUpload = async () => {
    if (!file) return;

    setStatus("uploading");
    setError(null);
    setProgress(0);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("deckIntent", deckIntent);

      const response = await fetch("/api/studio/generate", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Upload failed");
      }

      const data = await response.json();
      const videoId = data.video?.id;
      if (!videoId) throw new Error("No video ID returned");
      setJobId(String(videoId));
      setStatus("queued");

      // Start polling
      startPolling(String(videoId));
    } catch (err: any) {
      setStatus("failed");
      setError(err.message || "Upload failed");
    }
  };

  const startPolling = (id: string) => {
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/studio/videos/${id}`);
        if (!response.ok) return;

        const data = await response.json();
        const video = data.video;
        if (!video) return;

        // Map server status to client status (server uses "completed", client uses "complete")
        const clientStatus = video.status === "completed" ? "complete" : video.status;
        setStatus(clientStatus as PipelineStatus);
        setProgress(video.progress || 0);

        if (video.title || video.sceneCount) {
          setMetadata({
            title: video.title,
            sceneCount: video.sceneCount,
            durationSeconds: video.durationSeconds,
          });
        }

        // Treat as completed if status says so, OR if outputUrl is set (race condition workaround)
        if (video.status === "completed" || (video.outputUrl && video.completedAt)) {
          setStatus("complete" as PipelineStatus);
          setProgress(100);
          setVideoUrl(`/api/studio/videos/${id}/download`);
          stopPolling();
        } else if (video.status === "failed") {
          setError(video.errorMessage || "Pipeline failed");
          stopPolling();
        }
      } catch {
        // Ignore polling errors
      }
    }, 3000);
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    return () => stopPolling();
  }, []);

  const resetState = () => {
    setFile(null);
    setStatus("idle");
    setProgress(0);
    setJobId(null);
    setError(null);
    setVideoUrl(null);
    setMetadata(null);
    stopPolling();
  };

  const currentStageIndex = STAGE_ORDER.indexOf(status);
  // Server sends global progress (0-100) directly — use it when status is "processing"
  const overallProgress = status === "complete" ? 100
    : status === "failed" ? 0
    : status === "processing" ? progress
    : currentStageIndex >= 0
    ? Math.round(((currentStageIndex + (progress / 100)) / STAGE_ORDER.length) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-[#0a0a1a] text-white">
      <div className="max-w-3xl mx-auto px-6 py-16">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold mb-3">
            FullScale <span className="text-purple-400">Studio</span>
          </h1>
          <p className="text-gray-400 text-lg">
            Turn your pitch deck into a narrated video in minutes.
          </p>
        </div>

        {/* Usage meter — fetched from /api/studio/me */}
        <StudioUsageBadge />

        {/* Upload zone */}
        {status === "idle" && (
          <div
            className="border-2 border-dashed border-gray-700 rounded-xl p-16 text-center cursor-pointer hover:border-purple-500/50 transition-colors"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleFileDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.pptx"
              onChange={handleFileSelect}
              className="hidden"
            />

            {file ? (
              <div onClick={(e) => e.stopPropagation()}>
                <FileVideo className="w-12 h-12 text-purple-400 mx-auto mb-4" />
                <p className="text-lg font-medium mb-1">{file.name}</p>
                <p className="text-gray-400 text-sm mb-4">
                  {(file.size / (1024 * 1024)).toFixed(1)} MB &middot;{" "}
                  {file.name.endsWith(".pdf") ? "PDF" : "PPTX"}
                </p>

                {/* Deck Intent Selector */}
                <div className="mb-6">
                  <p className="text-sm text-gray-400 mb-3">What's this deck for?</p>
                  <div className="grid grid-cols-2 gap-2 max-w-md mx-auto">
                    {DECK_INTENTS.map((intent) => {
                      const Icon = intent.icon;
                      const isSelected = deckIntent === intent.value;
                      return (
                        <button
                          key={intent.value}
                          onClick={() => setDeckIntent(intent.value)}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-sm transition-all ${
                            isSelected
                              ? "border-purple-500 bg-purple-900/30 text-white"
                              : "border-gray-700 bg-gray-900/30 text-gray-400 hover:border-gray-500"
                          }`}
                        >
                          <Icon className={`w-4 h-4 flex-shrink-0 ${isSelected ? "text-purple-400" : "text-gray-500"}`} />
                          <div>
                            <div className="font-medium">{intent.label}</div>
                            <div className="text-xs text-gray-500">{intent.description}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <button
                  onClick={handleUpload}
                  className="bg-purple-600 hover:bg-purple-500 text-white font-semibold px-8 py-3 rounded-lg transition-colors"
                >
                  Generate Video
                </button>
              </div>
            ) : (
              <div>
                <Upload className="w-12 h-12 text-gray-500 mx-auto mb-4" />
                <p className="text-lg font-medium mb-1">
                  Drop your PDF or PPTX here
                </p>
                <p className="text-gray-400 text-sm">
                  or click to browse &middot; Max 50MB
                </p>
              </div>
            )}
          </div>
        )}

        {/* Progress state */}
        {status !== "idle" && status !== "complete" && status !== "failed" && (
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-8">
            <div className="flex items-center justify-between mb-6">
              <span className="text-lg font-medium">
                {status === "processing"
                  ? STAGE_LABELS[STAGE_ORDER[progress < 5 ? 0 : progress < 25 ? 1 : progress < 55 ? 2 : progress < 85 ? 3 : 4]] || "Processing..."
                  : STAGE_LABELS[status] || status}
              </span>
              <span className="text-gray-400 text-sm">{overallProgress}%</span>
            </div>

            {/* Progress bar */}
            <div className="w-full bg-gray-800 rounded-full h-2 mb-8">
              <div
                className="bg-purple-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${overallProgress}%` }}
              />
            </div>

            {/* Stage indicators */}
            <div className="space-y-3">
              {STAGE_ORDER.slice(0, -1).map((stage, i) => {
                // Map server "processing" progress (0-100) to pipeline stage index
                const processingStageIndex = status === "processing"
                  ? (progress < 5 ? 0 : progress < 25 ? 1 : progress < 55 ? 2 : progress < 85 ? 3 : 4)
                  : currentStageIndex;
                const isActive = status === "processing" ? processingStageIndex === i : stage === status;
                const isDone = status === "processing" ? processingStageIndex > i : currentStageIndex > i;
                return (
                  <div
                    key={stage}
                    className={`flex items-center gap-3 text-sm ${
                      isActive
                        ? "text-purple-300"
                        : isDone
                        ? "text-green-400"
                        : "text-gray-600"
                    }`}
                  >
                    {isDone ? (
                      <CheckCircle className="w-4 h-4" />
                    ) : isActive ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <div className="w-4 h-4 rounded-full border border-gray-700" />
                    )}
                    {STAGE_LABELS[stage]}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Complete state */}
        {status === "complete" && videoUrl && (
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-8 text-center">
            <CheckCircle className="w-16 h-16 text-green-400 mx-auto mb-4" />
            <h2 className="text-2xl font-bold mb-2">Video Ready</h2>
            {metadata && (
              <p className="text-gray-400 mb-6">
                {metadata.sceneCount} scenes &middot;{" "}
                ~{Math.round((metadata.estimatedDurationSeconds || 0) / 60)} min
              </p>
            )}

            {/* Video player */}
            <div className="bg-black rounded-lg overflow-hidden mb-6">
              <video
                controls
                className="w-full"
                src={videoUrl}
              >
                Your browser does not support video playback.
              </video>
            </div>

            <div className="flex gap-4 justify-center">
              <a
                href={videoUrl}
                download
                className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white font-semibold px-6 py-3 rounded-lg transition-colors"
              >
                <Download className="w-4 h-4" />
                Download MP4
              </a>
              <button
                onClick={resetState}
                className="inline-flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-white font-semibold px-6 py-3 rounded-lg transition-colors"
              >
                Create Another
              </button>
            </div>
          </div>
        )}

        {/* Error state */}
        {status === "failed" && (
          <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-8 text-center">
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">Pipeline Failed</h2>
            <p className="text-red-300/80 mb-6">{error || "An unknown error occurred."}</p>
            <button
              onClick={resetState}
              className="bg-gray-800 hover:bg-gray-700 text-white font-semibold px-6 py-3 rounded-lg transition-colors"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Error toast */}
        {error && status === "idle" && (
          <p className="text-red-400 text-sm text-center mt-4">{error}</p>
        )}
      </div>
    </div>
  );
}
