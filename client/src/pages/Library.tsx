import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Upload, Eye, Video } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";

const videoData = [
  { 
    title: "NYC Vlog Day 1", 
    views: "1.2M Views", 
    status: "Ready (4 Spots)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500"
  },
  { 
    title: "Coding Tutorial React", 
    views: "450k Views", 
    status: "Scanning (78%)", 
    statusColor: "bg-yellow-500/20 text-yellow-400",
    statusDot: "bg-yellow-500"
  },
  { 
    title: "Gaming Highlights", 
    views: "890k Views", 
    status: "Brand Safety Issue", 
    statusColor: "bg-red-500/20 text-red-400",
    statusDot: "bg-red-500"
  },
  { 
    title: "Travel Diary: Japan", 
    views: "2.1M Views", 
    status: "Bidding Active ($450)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500"
  },
  { 
    title: "Tech Review: iPhone", 
    views: "1.5M Views", 
    status: "Ready (2 Spots)", 
    statusColor: "bg-emerald-500/20 text-emerald-400",
    statusDot: "bg-emerald-500"
  },
  { 
    title: "Q&A Special", 
    views: "300k Views", 
    status: "Pending Indexing", 
    statusColor: "bg-gray-500/20 text-gray-400",
    statusDot: "bg-gray-400"
  },
];

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
              className="bg-white/5 rounded-xl border border-white/5 overflow-hidden group"
              data-testid={`card-video-${idx}`}
            >
              <div className="aspect-video bg-gray-800 flex items-center justify-center relative">
                <Video className="w-12 h-12 text-gray-600" />
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
