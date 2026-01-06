import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Upload, Eye, CheckCircle, Loader2, AlertTriangle, X, Shield, Sun, Tag, Box, DollarSign } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

const videoData = [
  { 
    title: "NYC Vlog Day 1", 
    views: "1.2M Views", 
    status: "Ready (4 Spots)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1534430480872-3498386e7856?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "4 Scenes Indexed",
    detectedObjects: ["Street Sign", "Car", "Building Facade", "Empty Billboard"],
    context: "Travel / Lifestyle",
    brandSafety: 98,
    cpm: 38
  },
  { 
    title: "Coding Tutorial React", 
    views: "450k Views", 
    status: "Scanning (78%)", 
    statusColor: "bg-yellow-500/20 text-yellow-400",
    statusDot: "bg-yellow-500",
    image: "https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=800&h=450&fit=crop",
    aiStatus: "scanning",
    aiText: "Processing...",
    detectedObjects: ["Laptop", "Coffee Mug", "Empty Wall"],
    context: "Tech / Education",
    brandSafety: 99,
    cpm: 45
  },
  { 
    title: "Gaming Highlights", 
    views: "890k Views", 
    status: "Brand Safety Issue", 
    statusColor: "bg-red-500/20 text-red-400",
    statusDot: "bg-red-500",
    image: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=800&h=450&fit=crop",
    aiStatus: "issue",
    aiText: "Brand Safety",
    detectedObjects: ["Gaming Chair", "Monitor", "RGB Lighting"],
    context: "Gaming / Entertainment",
    brandSafety: 62,
    cpm: 28
  },
  { 
    title: "Travel Diary: Japan", 
    views: "2.1M Views", 
    status: "Bidding Active ($450)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "6 Scenes Indexed",
    detectedObjects: ["Temple", "Cherry Blossom", "Open Sky", "Tourist Sign"],
    context: "Travel / Culture",
    brandSafety: 100,
    cpm: 52
  },
  { 
    title: "Tech Review: iPhone", 
    views: "1.5M Views", 
    status: "Ready (2 Spots)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "2 Scenes Indexed",
    detectedObjects: ["Smartphone", "Desk Surface", "Product Box"],
    context: "Tech / Reviews",
    brandSafety: 97,
    cpm: 48
  },
  { 
    title: "Q&A Special", 
    views: "300k Views", 
    status: "Pending Indexing", 
    statusColor: "bg-gray-500/20 text-gray-400",
    statusDot: "bg-gray-400",
    image: "https://images.unsplash.com/photo-1478737270239-2f02b77fc618?w=800&h=450&fit=crop",
    aiStatus: "scanning",
    aiText: "Processing...",
    detectedObjects: ["Microphone", "Studio Light", "Backdrop"],
    context: "Entertainment / Podcast",
    brandSafety: 95,
    cpm: 32
  },
];

function AiOverlayIcon({ status }: { status: string }) {
  if (status === "ready") return <CheckCircle className="w-3 h-3 text-emerald-400" />;
  if (status === "scanning") return <Loader2 className="w-3 h-3 text-yellow-400 animate-spin" />;
  if (status === "issue") return <AlertTriangle className="w-3 h-3 text-red-400" />;
  return null;
}

type VideoType = typeof videoData[0];

function AnalysisModal({ video, open, onClose }: { video: VideoType | null; open: boolean; onClose: () => void }) {
  const { toast } = useToast();

  if (!video) return null;

  const handleApprove = () => {
    toast({
      title: "Placement Saved",
      description: "This surface has been approved for brand placement.",
    });
    onClose();
  };

  const safetyColor = video.brandSafety >= 90 ? "text-emerald-400" : video.brandSafety >= 70 ? "text-yellow-400" : "text-red-400";

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl p-0 bg-zinc-900 border-white/10 overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-2">
          <div className="relative aspect-video md:aspect-auto md:h-full bg-black">
            <img 
              src={video.image} 
              alt={video.title}
              className="w-full h-full object-cover"
            />
            <div 
              className="absolute border-2 border-emerald-400 rounded-sm"
              style={{
                top: '25%',
                left: '15%',
                width: '35%',
                height: '40%',
                boxShadow: '0 0 0 2px rgba(16, 185, 129, 0.2), inset 0 0 20px rgba(16, 185, 129, 0.1)'
              }}
            >
              <div className="absolute -top-6 left-0 bg-emerald-500/90 text-white text-xs font-mono px-2 py-0.5 rounded-sm">
                Available Surface
              </div>
              <div className="absolute inset-0 bg-emerald-400/5" />
            </div>
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-4">
              <p className="text-white/70 text-xs font-mono">frame_04.jpg | 00:02:34</p>
            </div>
          </div>

          <div className="p-6 space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">AI Vision Analysis</p>
                <h2 className="text-xl font-bold text-white">Scene Analysis #04</h2>
                <p className="text-sm text-muted-foreground mt-1">{video.title}</p>
              </div>
              <Button 
                size="icon" 
                variant="ghost" 
                onClick={onClose}
                data-testid="button-close-modal"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                  <div className="flex items-center gap-2 mb-1">
                    <Shield className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground font-mono uppercase">Brand Safety</span>
                  </div>
                  <p className={`text-lg font-bold font-mono ${safetyColor}`}>
                    {video.brandSafety}% Safe
                  </p>
                </div>
                <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                  <div className="flex items-center gap-2 mb-1">
                    <Sun className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground font-mono uppercase">Lighting</span>
                  </div>
                  <p className="text-lg font-bold font-mono text-white">High</p>
                </div>
              </div>

              <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <Tag className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground font-mono uppercase">Context</span>
                </div>
                <p className="text-white font-mono">{video.context}</p>
              </div>

              <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <Box className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground font-mono uppercase">Detected Objects</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {video.detectedObjects.map((obj, idx) => (
                    <span key={idx} className="px-2 py-1 bg-white/10 rounded text-xs font-mono text-white/80">
                      {obj}
                    </span>
                  ))}
                </div>
              </div>

              <div className="bg-emerald-500/10 rounded-lg p-3 border border-emerald-500/20">
                <div className="flex items-center gap-2 mb-1">
                  <DollarSign className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs text-emerald-400 font-mono uppercase">Opportunity</span>
                </div>
                <p className="text-white font-mono">
                  Premium Spot Available <span className="text-emerald-400">(CPM ${video.cpm})</span>
                </p>
              </div>
            </div>

            <Button 
              className="w-full gap-2" 
              onClick={handleApprove}
              data-testid="button-approve-placement"
            >
              <CheckCircle className="w-4 h-4" />
              Approve Placement
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Library() {
  const { user } = useAuth();
  const [selectedVideo, setSelectedVideo] = useState<VideoType | null>(null);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/20">
      <Sidebar />
      <TopBar />

      <main className="ml-64 p-8 max-w-7xl mx-auto">
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 flex flex-wrap items-start justify-between gap-4"
        >
          <div>
            <h1 className="text-3xl font-bold font-display mb-2" data-testid="text-library-title">
              Content Library
            </h1>
            <p className="text-muted-foreground">
              <span className="text-white font-medium">45 Videos Scanned</span> | 128 Ad Opportunities Found
            </p>
          </div>
          <Button className="gap-2" data-testid="button-upload-asset">
            <Upload className="w-4 h-4" />
            Upload Manual Asset
          </Button>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
        >
          {videoData.map((video, idx) => (
            <div 
              key={idx} 
              className="bg-white/5 rounded-xl border border-white/5 overflow-hidden group cursor-pointer"
              data-testid={`card-video-${idx}`}
              onClick={() => setSelectedVideo(video)}
            >
              <div className="aspect-video relative overflow-hidden">
                <img 
                  src={video.image} 
                  alt={video.title}
                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/50 backdrop-blur-sm">
                  <AiOverlayIcon status={video.aiStatus} />
                  <span className="text-xs text-white/90 font-medium">{video.aiText}</span>
                </div>
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                  <Button variant="outline" size="sm" className="gap-2">
                    <Eye className="w-4 h-4" />
                    View Analysis
                  </Button>
                </div>
              </div>
              <div className="p-4">
                <h3 className="font-semibold text-white mb-1 truncate">{video.title}</h3>
                <p className="text-sm text-muted-foreground mb-3">{video.views}</p>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${video.statusDot}`}></span>
                  <span className={`px-2 py-0.5 rounded-full ${video.statusColor} text-xs font-medium`}>
                    {video.status}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </motion.div>
      </main>

      <AnalysisModal 
        video={selectedVideo} 
        open={!!selectedVideo} 
        onClose={() => setSelectedVideo(null)} 
      />
    </div>
  );
}
