import { useState, useRef, useCallback, useEffect } from "react";
import { Upload, FileVideo, Loader2, CheckCircle, AlertCircle, Download, Play, Rocket, ShoppingCart, Users, Megaphone } from "lucide-react";

type PipelineStatus = "idle" | "uploading" | "extracting" | "script_ready" | "queued" | "processing" | "parsing" | "generating" | "adding-voice" | "assembling" | "complete" | "failed";

interface StoryScene {
  sceneNumber: number;
  sourcePages: number[];
  sceneTitle: string;
  narration: string;
  visualFocus: string;
  slideCategory: string;
  treatment?: "seedance" | "kenburns" | "static_highlight";
  narrationStyle?: "punch" | "explain";
  estimatedDurationSeconds: number;
  ycFrameworkRole?: string;
  keyPhrase?: string;
  highlightRegion?: { x: number; y: number; width: number; height: number };
}

interface StoryScript {
  documentTitle: string;
  totalScenes: number;
  scenes: StoryScene[];
  totalDurationSeconds?: number;
}

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
  const [storyScript, setStoryScript] = useState<StoryScript | null>(null);
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

  // Stage 1: Extract story (fast, cheap) — for user review
  const handleExtract = async () => {
    if (!file) return;

    setStatus("extracting");
    setError(null);
    setProgress(0);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("deckIntent", deckIntent);

      const response = await fetch("/api/studio/extract", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Extract failed");
      }

      const data = await response.json();
      const videoId = data.video?.id;
      if (!videoId) throw new Error("No video ID returned");
      setJobId(String(videoId));
      setStoryScript(data.storyScript);
      setStatus("script_ready");
    } catch (err: any) {
      setStatus("failed");
      setError(err.message || "Extract failed");
    }
  };

  // Stage 2: Generate video from the (possibly edited) story script
  const handleGenerateFromScript = async () => {
    if (!storyScript || !jobId) return;

    setStatus("queued");
    setProgress(25);
    setError(null);

    try {
      const response = await fetch(`/api/studio/videos/${jobId}/generate-from-script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyScript }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Generate failed");
      }

      startPolling(jobId);
    } catch (err: any) {
      setStatus("failed");
      setError(err.message || "Generate failed");
    }
  };

  const updateSceneNarration = (sceneIdx: number, newNarration: string) => {
    if (!storyScript) return;
    const newScript = { ...storyScript };
    newScript.scenes = [...storyScript.scenes];
    newScript.scenes[sceneIdx] = { ...newScript.scenes[sceneIdx], narration: newNarration };
    setStoryScript(newScript);
  };

  const skipScene = (sceneIdx: number) => {
    if (!storyScript) return;
    const newScript = { ...storyScript };
    newScript.scenes = storyScript.scenes.filter((_, i) => i !== sceneIdx);
    newScript.scenes.forEach((s, i) => { s.sceneNumber = i + 1; });
    newScript.totalScenes = newScript.scenes.length;
    setStoryScript(newScript);
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
    setStoryScript(null);
    stopPolling();
  };

  const cancelUpload = async () => {
    if (!jobId) return;
    try {
      await fetch(`/api/studio/videos/${jobId}/cancel`, { method: "POST" });
    } catch (err) {
      // Non-fatal — still stop polling
    }
    stopPolling();
    setStatus("failed");
    setError("Cancelled by user");
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
                  onClick={handleExtract}
                  className="bg-purple-600 hover:bg-purple-500 text-white font-semibold px-8 py-3 rounded-lg transition-colors"
                >
                  Extract Story →
                </button>
                <p className="text-gray-500 text-xs mt-2">
                  Review the narration before we generate the video.
                </p>
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
                <p className="text-purple-400/70 text-xs mt-4 max-w-md mx-auto">
                  Tip: Decks with 10 slides or fewer produce the punchiest videos.
                  Longer decks will be condensed to the 10 strongest slides.
                  Videos are capped at 2 minutes for maximum impact.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Extracting state — show a simple loading message */}
        {status === "extracting" && (
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-8 text-center">
            <Loader2 className="w-12 h-12 text-purple-400 mx-auto mb-4 animate-spin" />
            <h3 className="text-lg font-medium mb-2">Reading your deck...</h3>
            <p className="text-gray-400 text-sm max-w-md mx-auto">
              Analyzing each slide and writing your narration. This usually takes 30-60 seconds.
            </p>
          </div>
        )}

        {/* Script review state */}
        {status === "script_ready" && storyScript && (
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-6 md:p-8">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold">Review your script</h2>
                <p className="text-sm text-gray-400">
                  {storyScript.scenes.length} scenes &middot;{" "}
                  {storyScript.scenes.reduce((s, sc) => s + sc.estimatedDurationSeconds, 0)}s total
                </p>
              </div>
              <button
                onClick={() => { setStatus("idle"); setStoryScript(null); setJobId(null); }}
                className="text-xs text-gray-400 hover:text-white border border-gray-700 rounded-md px-3 py-1"
              >
                Start over
              </button>
            </div>

            <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
              {storyScript.scenes.map((scene, idx) => (
                <div key={scene.sceneNumber} className="bg-gray-950/50 border border-gray-800 rounded-lg p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-gray-500">#{scene.sceneNumber}</span>
                      <span className="text-sm font-medium text-white">{scene.sceneTitle}</span>
                      <span className="text-[10px] uppercase tracking-wider text-purple-300 bg-purple-900/30 border border-purple-800/50 rounded px-2 py-0.5">
                        {scene.treatment === "seedance" ? "AI Motion"
                          : scene.treatment === "kenburns" ? "Ken Burns"
                          : scene.treatment === "static_highlight" ? "Highlight"
                          : scene.slideCategory}
                      </span>
                      {scene.ycFrameworkRole && (
                        <span className="text-[10px] uppercase tracking-wider text-gray-400 bg-gray-800 rounded px-2 py-0.5">
                          {scene.ycFrameworkRole}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => skipScene(idx)}
                      className="text-[10px] text-gray-500 hover:text-red-400 transition-colors"
                    >
                      Skip
                    </button>
                  </div>
                  <textarea
                    value={scene.narration}
                    onChange={(e) => updateSceneNarration(idx, e.target.value)}
                    className="w-full bg-gray-900 border border-gray-700 rounded-md p-3 text-sm text-gray-200 focus:border-purple-500 focus:outline-none resize-none"
                    rows={scene.narrationStyle === "explain" ? 3 : 2}
                  />
                  <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-500">
                    <span>{scene.estimatedDurationSeconds}s</span>
                    <span>&middot;</span>
                    <span>{scene.narration.trim().split(/\s+/).length} words</span>
                    {scene.keyPhrase && (
                      <>
                        <span>&middot;</span>
                        <span className="text-purple-400/80">key: "{scene.keyPhrase.slice(0, 40)}{(scene.keyPhrase.length || 0) > 40 ? "..." : ""}"</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-800">
              <p className="text-xs text-gray-500">
                Edit any narration above. Click skip to remove a scene.
              </p>
              <button
                onClick={handleGenerateFromScript}
                className="bg-purple-600 hover:bg-purple-500 text-white font-semibold px-6 py-3 rounded-lg transition-colors"
                data-testid="button-generate-video"
              >
                Generate Video →
              </button>
            </div>
          </div>
        )}

        {/* Progress state */}
        {status !== "idle" && status !== "extracting" && status !== "script_ready" && status !== "complete" && status !== "failed" && (
          <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-8">
            <div className="flex items-center justify-between mb-6">
              <span className="text-lg font-medium">
                {status === "processing"
                  ? STAGE_LABELS[STAGE_ORDER[progress < 5 ? 0 : progress < 25 ? 1 : progress < 55 ? 2 : progress < 85 ? 3 : 4]] || "Processing..."
                  : STAGE_LABELS[status] || status}
              </span>
              <div className="flex items-center gap-3">
                <span className="text-gray-400 text-sm">{overallProgress}%</span>
                {jobId && (
                  <button
                    onClick={cancelUpload}
                    className="text-xs text-gray-400 hover:text-red-400 border border-gray-700 hover:border-red-500/50 rounded-md px-3 py-1 transition-colors"
                    data-testid="button-studio-cancel"
                  >
                    Cancel
                  </button>
                )}
              </div>
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
