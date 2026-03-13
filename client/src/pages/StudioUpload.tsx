import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Upload,
  FileText,
  Wand2,
  Play,
  Pause,
  Lock,
  Check,
  Loader2,
  ArrowRight,
  Volume2,
  Crown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

interface Voice {
  id: number;
  voiceId: string;
  name: string;
  previewUrl: string | null;
  tier: string;
  category: string;
  gender: string | null;
  accent: string | null;
  description: string | null;
  isDefault: boolean;
  available: boolean;
  requiredTier: string;
}

interface VoicesResponse {
  voices: Voice[];
  userTier: string;
}

interface QuotaResponse {
  canGenerate: boolean;
  videosGenerated: number;
  videosLimit: number;
  tier: string;
  month: string;
}

interface StudioMeResponse {
  authenticated: boolean;
  email?: string;
  hasStudioAccess?: boolean;
  subscription?: {
    tier: string;
    status: string;
  };
}

export default function StudioUpload() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);
  const [playingPreview, setPlayingPreview] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const { data: studioMe, isLoading: isLoadingMe } = useQuery<StudioMeResponse>({
    queryKey: ["/api/studio/me"],
    retry: false,
  });

  const { data: quotaData } = useQuery<QuotaResponse>({
    queryKey: ["/api/studio/quota"],
    enabled: !!studioMe?.authenticated,
  });

  const { data: voicesData, isLoading: isLoadingVoices } = useQuery<VoicesResponse>({
    queryKey: ["/api/studio/voices"],
  });

  const voices = voicesData?.voices || [];
  const userTier = voicesData?.userTier || "free";
  const isAuthenticated = studioMe?.authenticated;
  const canGenerate = quotaData?.canGenerate ?? true;

  // Group voices by category
  const voicesByCategory = voices.reduce<Record<string, Voice[]>>((acc, voice) => {
    const cat = voice.category || "other";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(voice);
    return acc;
  }, {});

  // Handle file drop
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (isValidFile(file)) {
        setSelectedFile(file);
      }
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (isValidFile(file)) {
        setSelectedFile(file);
      }
    }
  };

  const isValidFile = (file: File) => {
    const validTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint",
    ];
    return validTypes.includes(file.type) || file.name.endsWith(".pdf") || file.name.endsWith(".pptx");
  };

  const handlePlayPreview = (voiceId: string, previewUrl: string | null) => {
    if (!previewUrl) return;
    if (playingPreview === voiceId) {
      setPlayingPreview(null);
      // Stop any playing audio
      document.querySelectorAll("audio").forEach((a) => a.pause());
    } else {
      setPlayingPreview(voiceId);
      const audio = new Audio(previewUrl);
      audio.play();
      audio.onended = () => setPlayingPreview(null);
    }
  };

  // Determine default voice selection
  if (!selectedVoice && voices.length > 0) {
    const defaultVoice = voices.find((v) => v.isDefault && v.available);
    if (defaultVoice) {
      setSelectedVoice(defaultVoice.voiceId);
    }
  }

  if (!isAuthenticated && !isLoadingMe) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <Card className="max-w-md border-white/5">
          <CardContent className="p-8 text-center">
            <Wand2 className="w-12 h-12 text-purple-400 mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">Sign in to Studio</h2>
            <p className="text-muted-foreground text-sm mb-6">
              Create an account or sign in to start generating videos.
            </p>
            <div className="flex gap-3 justify-center">
              <a href="/auth?redirect=/studio/upload">
                <Button className="bg-purple-600 hover:bg-purple-500">
                  Sign In
                </Button>
              </a>
              <a href="/studio/pricing">
                <Button variant="outline">View Pricing</Button>
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
          <a href="/">
            <img src={logoUrl} alt="FullScale" className="h-7" />
          </a>
          <div className="flex items-center gap-3">
            <a
              href="/studio/pricing"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Pricing
            </a>
            <Badge variant="outline" className="text-xs font-medium">
              <Wand2 className="w-3 h-3 mr-1" />
              Upload
            </Badge>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-10">
        {/* Quota warning */}
        {!canGenerate && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-between"
          >
            <div>
              <p className="text-sm font-medium text-red-400">
                Monthly limit reached ({quotaData?.videosGenerated}/{quotaData?.videosLimit} videos)
              </p>
              <p className="text-xs text-red-400/60 mt-0.5">
                Upgrade your plan for more videos
              </p>
            </div>
            <a href="/studio/pricing">
              <Button size="sm" className="bg-red-600 hover:bg-red-500 gap-1">
                Upgrade <ArrowRight className="w-3 h-3" />
              </Button>
            </a>
          </motion.div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left column: Upload */}
          <div className="lg:col-span-2 space-y-6">
            <div>
              <h1 className="text-2xl font-bold mb-1">Upload Your Document</h1>
              <p className="text-muted-foreground text-sm">
                Drop a PDF or PPTX and Studio will turn it into a narrated video.
              </p>
            </div>

            {/* Drop zone */}
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              className={cn(
                "relative rounded-2xl border-2 border-dashed transition-all duration-300 p-12",
                dragActive
                  ? "border-purple-500 bg-purple-500/5"
                  : selectedFile
                  ? "border-green-500/30 bg-green-500/5"
                  : "border-white/10 hover:border-white/20"
              )}
            >
              <input
                type="file"
                accept=".pdf,.pptx"
                onChange={handleFileSelect}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
              <div className="text-center">
                {selectedFile ? (
                  <motion.div
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                  >
                    <FileText className="w-12 h-12 text-green-400 mx-auto mb-3" />
                    <p className="font-medium text-foreground">
                      {selectedFile.name}
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {(selectedFile.size / 1024 / 1024).toFixed(1)} MB
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-3 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedFile(null);
                      }}
                    >
                      Change file
                    </Button>
                  </motion.div>
                ) : (
                  <>
                    <Upload className="w-12 h-12 text-white/20 mx-auto mb-3" />
                    <p className="font-medium text-foreground">
                      Drag & drop your file here
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      or click to browse — PDF or PPTX
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Voice Selection */}
            <div>
              <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <Volume2 className="w-5 h-5 text-purple-400" />
                Choose a Voice
              </h2>
              {isLoadingVoices ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : voices.length === 0 ? (
                <Card className="border-white/5">
                  <CardContent className="p-6 text-center text-muted-foreground text-sm">
                    Default voice will be used. Voice options coming soon.
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-4">
                  {Object.entries(voicesByCategory).map(([category, categoryVoices]) => (
                    <div key={category}>
                      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        {category}
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {categoryVoices.map((voice) => (
                          <button
                            key={voice.voiceId}
                            onClick={() => {
                              if (voice.available) {
                                setSelectedVoice(voice.voiceId);
                              }
                            }}
                            disabled={!voice.available}
                            className={cn(
                              "relative flex items-center gap-3 p-3 rounded-xl border transition-all text-left",
                              selectedVoice === voice.voiceId
                                ? "border-purple-500 bg-purple-500/10"
                                : voice.available
                                ? "border-white/5 hover:border-white/10 bg-card"
                                : "border-white/5 bg-card/50 opacity-60"
                            )}
                          >
                            {/* Play preview */}
                            {voice.previewUrl && voice.available && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handlePlayPreview(voice.voiceId, voice.previewUrl);
                                }}
                                className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center flex-shrink-0 transition-colors"
                              >
                                {playingPreview === voice.voiceId ? (
                                  <Pause className="w-3.5 h-3.5" />
                                ) : (
                                  <Play className="w-3.5 h-3.5 ml-0.5" />
                                )}
                              </button>
                            )}
                            {!voice.available && (
                              <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center flex-shrink-0">
                                <Lock className="w-3.5 h-3.5 text-muted-foreground" />
                              </div>
                            )}

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-sm truncate">
                                  {voice.name}
                                </span>
                                {voice.isDefault && (
                                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                    Default
                                  </Badge>
                                )}
                              </div>
                              {voice.description && (
                                <p className="text-xs text-muted-foreground truncate">
                                  {voice.description}
                                </p>
                              )}
                              {!voice.available && (
                                <p className="text-xs text-purple-400 mt-0.5">
                                  Requires {voice.requiredTier} plan
                                </p>
                              )}
                            </div>

                            {selectedVoice === voice.voiceId && (
                              <Check className="w-4 h-4 text-purple-400 flex-shrink-0" />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right column: Summary + Generate */}
          <div className="space-y-4">
            <Card className="border-white/5 sticky top-20">
              <CardContent className="p-6 space-y-5">
                <h3 className="font-semibold text-foreground">Generation Summary</h3>

                {/* File */}
                <div className="flex items-center gap-3">
                  <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", selectedFile ? "bg-green-500/10" : "bg-white/5")}>
                    <FileText className={cn("w-4 h-4", selectedFile ? "text-green-400" : "text-muted-foreground")} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {selectedFile ? selectedFile.name : "No file selected"}
                    </p>
                    <p className="text-xs text-muted-foreground">Document</p>
                  </div>
                </div>

                {/* Voice */}
                <div className="flex items-center gap-3">
                  <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", selectedVoice ? "bg-purple-500/10" : "bg-white/5")}>
                    <Volume2 className={cn("w-4 h-4", selectedVoice ? "text-purple-400" : "text-muted-foreground")} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {selectedVoice
                        ? voices.find((v) => v.voiceId === selectedVoice)?.name || "Selected"
                        : "Default voice"}
                    </p>
                    <p className="text-xs text-muted-foreground">Narration</p>
                  </div>
                </div>

                {/* Tier info */}
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center">
                    <Crown className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium capitalize">{userTier} Plan</p>
                    <p className="text-xs text-muted-foreground">
                      {quotaData
                        ? `${quotaData.videosGenerated}/${quotaData.videosLimit} videos used`
                        : "Checking usage..."}
                    </p>
                  </div>
                </div>

                <div className="border-t border-white/5 pt-4">
                  <Button
                    className="w-full gap-2 bg-purple-600 hover:bg-purple-500"
                    size="lg"
                    disabled={!selectedFile || !canGenerate}
                  >
                    <Wand2 className="w-4 h-4" />
                    Generate Video
                  </Button>
                  {!canGenerate && (
                    <p className="text-xs text-center text-red-400 mt-2">
                      <a href="/studio/pricing" className="underline">
                        Upgrade
                      </a>{" "}
                      to generate more videos
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
