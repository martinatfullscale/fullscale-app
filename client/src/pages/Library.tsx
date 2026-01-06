import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Upload, Eye, CheckCircle, Loader2, AlertTriangle } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";

const videoData = [
  { 
    title: "NYC Vlog Day 1", 
    views: "1.2M Views", 
    status: "Ready (4 Spots)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1534430480872-3498386e7856?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "4 Scenes Indexed"
  },
  { 
    title: "Coding Tutorial React", 
    views: "450k Views", 
    status: "Scanning (78%)", 
    statusColor: "bg-yellow-500/20 text-yellow-400",
    statusDot: "bg-yellow-500",
    image: "https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=800&h=450&fit=crop",
    aiStatus: "scanning",
    aiText: "Processing..."
  },
  { 
    title: "Gaming Highlights", 
    views: "890k Views", 
    status: "Brand Safety Issue", 
    statusColor: "bg-red-500/20 text-red-400",
    statusDot: "bg-red-500",
    image: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=800&h=450&fit=crop",
    aiStatus: "issue",
    aiText: "Brand Safety"
  },
  { 
    title: "Travel Diary: Japan", 
    views: "2.1M Views", 
    status: "Bidding Active ($450)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "6 Scenes Indexed"
  },
  { 
    title: "Tech Review: iPhone", 
    views: "1.5M Views", 
    status: "Ready (2 Spots)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500",
    image: "https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=800&h=450&fit=crop",
    aiStatus: "ready",
    aiText: "2 Scenes Indexed"
  },
  { 
    title: "Q&A Special", 
    views: "300k Views", 
    status: "Pending Indexing", 
    statusColor: "bg-gray-500/20 text-gray-400",
    statusDot: "bg-gray-400",
    image: "https://images.unsplash.com/photo-1478737270239-2f02b77fc618?w=800&h=450&fit=crop",
    aiStatus: "scanning",
    aiText: "Processing..."
  },
];

function AiOverlayIcon({ status }: { status: string }) {
  if (status === "ready") return <CheckCircle className="w-3 h-3 text-emerald-400" />;
  if (status === "scanning") return <Loader2 className="w-3 h-3 text-yellow-400 animate-spin" />;
  if (status === "issue") return <AlertTriangle className="w-3 h-3 text-red-400" />;
  return null;
}

export default function Library() {
  const { user } = useAuth();

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
    </div>
  );
}
