import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Upload, Eye, CheckCircle, Loader2, AlertTriangle, X, Shield, Sun, Tag, Box, DollarSign, Sparkles } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { UploadModal } from "@/components/UploadModal";

const videoData = [
  { 
    title: "Tech Setup Review", 
    views: "1.5M Views", 
    status: "Ready (3 Spots)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "3 Scenes Indexed",
    detectedObjects: ["Monitor", "Keyboard", "Mouse", "Empty Desk Space"],
    context: "Tech / Home Office",
    brandSafety: 99,
    cpm: 48,
    opportunity: "Perfect for: Peripheral Placement or Drinkware",
    surfaceLabel: "Available Surface: Desk Mat",
    boundingBox: { top: "55%", left: "50%", width: "40%", height: "35%" }
  },
  { 
    title: "Cooking Vlog", 
    views: "890k Views", 
    status: "Ready (2 Spots)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "2 Scenes Indexed",
    detectedObjects: ["Counter", "Cutting Board", "Kitchen Appliances", "Empty Counter Space"],
    context: "Lifestyle / Cooking",
    brandSafety: 98,
    cpm: 42,
    opportunity: "Perfect for: Kitchen Gadgets or Food Products",
    surfaceLabel: "Available Surface: Counter",
    boundingBox: { top: "60%", left: "20%", width: "45%", height: "30%" }
  },
  { 
    title: "Podcast Episode #42", 
    views: "450k Views", 
    status: "Scanning (78%)", 
    statusColor: "bg-yellow-500/20 text-yellow-400",
    statusDot: "bg-yellow-500",
    image: "https://images.unsplash.com/photo-1590602847861-f357a9332bbc?w=800&h=450&fit=crop",
    aiStatus: "scanning",
    aiText: "Processing...",
    detectedObjects: ["Microphone", "Headphones", "Table", "Acoustic Panels"],
    context: "Entertainment / Podcast",
    brandSafety: 97,
    cpm: 38,
    opportunity: "Perfect for: Audio Equipment or Beverages",
    surfaceLabel: "Available Surface: Table",
    boundingBox: { top: "50%", left: "30%", width: "40%", height: "35%" }
  },
  { 
    title: "Home Workout", 
    views: "2.1M Views", 
    status: "Ready (4 Spots)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "4 Scenes Indexed",
    detectedObjects: ["Yoga Mat", "Weights", "Wall Space", "Floor Area"],
    context: "Fitness / Wellness",
    brandSafety: 100,
    cpm: 52,
    opportunity: "Perfect for: Fitness Equipment or Apparel",
    surfaceLabel: "Available Surface: Floor/Wall",
    boundingBox: { top: "30%", left: "60%", width: "35%", height: "50%" }
  },
  { 
    title: "Remote Work Vlog", 
    views: "680k Views", 
    status: "Bidding Active ($320)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1521017432531-fbd92d768814?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "2 Scenes Indexed",
    detectedObjects: ["Laptop", "Coffee Cup", "Notebook", "Cafe Table"],
    context: "Lifestyle / Remote Work",
    brandSafety: 95,
    cpm: 36,
    opportunity: "Perfect for: Laptop Accessories or Coffee Brands",
    surfaceLabel: "Available Surface: Table",
    boundingBox: { top: "45%", left: "25%", width: "50%", height: "40%" }
  },
  { 
    title: "DIY Workshop", 
    views: "320k Views", 
    status: "Brand Safety Review", 
    statusColor: "bg-yellow-500/20 text-yellow-400",
    statusDot: "bg-yellow-500",
    image: "https://images.unsplash.com/photo-1530124566582-a618bc2615dc?w=800&h=450&fit=crop",
    aiStatus: "scanning",
    aiText: "Processing...",
    detectedObjects: ["Workbench", "Tools", "Storage Wall", "Project Area"],
    context: "DIY / Crafts",
    brandSafety: 88,
    cpm: 32,
    opportunity: "Perfect for: Tool Brands or Hardware",
    surfaceLabel: "Available Surface: Workbench",
    boundingBox: { top: "40%", left: "15%", width: "45%", height: "45%" }
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
                top: video.boundingBox.top,
                left: video.boundingBox.left,
                width: video.boundingBox.width,
                height: video.boundingBox.height,
                boxShadow: '0 0 0 2px rgba(16, 185, 129, 0.2), inset 0 0 20px rgba(16, 185, 129, 0.1)'
              }}
            >
              <div className="absolute -top-6 left-0 bg-emerald-500/90 text-white text-xs font-mono px-2 py-0.5 rounded-sm whitespace-nowrap">
                {video.surfaceLabel}
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
                <p className="text-white font-mono text-sm">
                  {video.opportunity}
                </p>
                <p className="text-emerald-400 font-mono text-sm mt-1">
                  CPM ${video.cpm}
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

const uploadedVideoData: VideoType = {
  title: "Demo_Upload.mp4",
  views: "Just Uploaded",
  status: "Just Scanned",
  statusColor: "bg-emerald-500/20 text-emerald-400",
  statusDot: "bg-emerald-500",
  image: "https://images.unsplash.com/photo-1611162616475-46b635cb6868?w=800&h=450&fit=crop",
  aiStatus: "ready",
  aiText: "4 Scenes Indexed",
  detectedObjects: ["Table", "Wall", "Shelf", "Product Area"],
  context: "Lifestyle / General",
  brandSafety: 96,
  cpm: 34,
  opportunity: "Perfect for: General Product Placement",
  surfaceLabel: "Available Surface: Table",
  boundingBox: { top: "40%", left: "25%", width: "50%", height: "40%" }
};

export default function Library() {
  const { user } = useAuth();
  const [selectedVideo, setSelectedVideo] = useState<VideoType | null>(null);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadedVideos, setUploadedVideos] = useState<VideoType[]>([]);

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
          <Button className="gap-2" data-testid="button-upload-asset" onClick={() => setUploadModalOpen(true)}>
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
          {uploadedVideos.map((video, idx) => (
            <div 
              key={`uploaded-${idx}`} 
              className="bg-white/5 rounded-xl border border-emerald-500/30 overflow-hidden group cursor-pointer ring-1 ring-emerald-500/20"
              data-testid={`card-uploaded-${idx}`}
              onClick={() => setSelectedVideo(video)}
            >
              <div className="aspect-video relative overflow-hidden">
                <img 
                  src={video.image} 
                  alt={video.title}
                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-500/90 backdrop-blur-sm">
                  <Sparkles className="w-3 h-3 text-white" />
                  <span className="text-xs text-white font-medium">Just Scanned</span>
                </div>
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

      <UploadModal 
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onUploadComplete={() => {
          setUploadedVideos(prev => [uploadedVideoData, ...prev]);
        }}
      />
    </div>
  );
}
