import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronLeft, ChevronRight, Target, Clock, Eye, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface Scene {
  id: string;
  timestamp: string;
  imageUrl: string;
  surfaces: number;
  surfaceTypes: string[];
  context: string;
  confidence: number;
}

export interface VideoWithScenes {
  id: number;
  title: string;
  duration: string;
  viewCount: number;
  scenes: Scene[];
}

interface SceneAnalysisModalProps {
  video: VideoWithScenes | null;
  open: boolean;
  onClose: () => void;
}

export function SceneAnalysisModal({ video, open, onClose }: SceneAnalysisModalProps) {
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);

  if (!video || !open) return null;

  const currentScene = video.scenes[currentSceneIndex];
  const totalScenes = video.scenes.length;

  const goToPrevious = () => {
    setCurrentSceneIndex((prev) => (prev > 0 ? prev - 1 : totalScenes - 1));
  };

  const goToNext = () => {
    setCurrentSceneIndex((prev) => (prev < totalScenes - 1 ? prev + 1 : 0));
  };

  const goToScene = (index: number) => {
    setCurrentSceneIndex(index);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={onClose}
          data-testid="modal-scene-analysis"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="relative w-full max-w-5xl bg-card border border-white/10 rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 z-20 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
              data-testid="button-modal-close"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex flex-col lg:flex-row">
              <div className="flex-1 relative">
                <div className="aspect-video relative overflow-hidden bg-black">
                  <img
                    src={currentScene.imageUrl}
                    alt={`Scene at ${currentScene.timestamp}`}
                    className="w-full h-full object-cover"
                    data-testid="img-scene-main"
                  />
                  
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                  
                  <div className="absolute bottom-4 left-4 flex items-center gap-2">
                    <Badge className="bg-primary/90 text-white">
                      <Clock className="w-3 h-3 mr-1" />
                      {currentScene.timestamp}
                    </Badge>
                    <Badge className="bg-emerald-500/90 text-white">
                      <Target className="w-3 h-3 mr-1" />
                      {currentScene.surfaces} Surfaces
                    </Badge>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={goToPrevious}
                    className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white rounded-full h-10 w-10"
                    data-testid="button-scene-prev"
                  >
                    <ChevronLeft className="w-6 h-6" />
                  </Button>
                  
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={goToNext}
                    className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white rounded-full h-10 w-10"
                    data-testid="button-scene-next"
                  >
                    <ChevronRight className="w-6 h-6" />
                  </Button>
                </div>

                <div className="p-3 bg-black/50 border-t border-white/10">
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    {video.scenes.map((scene, idx) => (
                      <button
                        key={scene.id}
                        onClick={() => goToScene(idx)}
                        className={`relative flex-shrink-0 w-16 h-10 rounded-md overflow-hidden border-2 transition-all ${
                          idx === currentSceneIndex
                            ? "border-primary ring-2 ring-primary/30"
                            : "border-white/20 hover:border-white/40"
                        }`}
                        data-testid={`thumbnail-scene-${idx}`}
                      >
                        <img
                          src={scene.imageUrl}
                          alt={`Scene ${idx + 1}`}
                          className="w-full h-full object-cover"
                        />
                        <span className="absolute bottom-0 left-0 right-0 bg-black/70 text-[8px] text-white text-center py-0.5">
                          {scene.timestamp}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground text-center mt-2">
                    Scene {currentSceneIndex + 1} of {totalScenes}
                  </p>
                </div>
              </div>

              <div className="lg:w-80 p-6 bg-gradient-to-b from-card to-secondary/20 border-l border-white/10">
                <h3 className="text-lg font-bold text-white mb-1 line-clamp-2" data-testid="text-video-title">
                  {video.title}
                </h3>
                <p className="text-sm text-muted-foreground mb-6">
                  {video.viewCount.toLocaleString()} views
                </p>

                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <div className="flex items-center gap-2 mb-2">
                      <Target className="w-4 h-4 text-primary" />
                      <span className="text-sm font-medium text-white">Surfaces Found</span>
                    </div>
                    <p className="text-2xl font-bold text-primary mb-2" data-testid="text-surfaces-count">
                      {currentScene.surfaces}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {currentScene.surfaceTypes.map((surface, idx) => (
                        <Badge 
                          key={idx} 
                          variant="secondary" 
                          className="text-xs"
                          data-testid={`badge-surface-${idx}`}
                        >
                          {surface}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <div className="flex items-center gap-2 mb-2">
                      <Sparkles className="w-4 h-4 text-emerald-400" />
                      <span className="text-sm font-medium text-white">Scene Context</span>
                    </div>
                    <p className="text-sm text-muted-foreground" data-testid="text-scene-context">
                      {currentScene.context}
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <div className="flex items-center gap-2 mb-2">
                      <Eye className="w-4 h-4 text-blue-400" />
                      <span className="text-sm font-medium text-white">AI Confidence</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-white/10 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 rounded-full"
                          style={{ width: `${currentScene.confidence}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium text-white" data-testid="text-confidence">
                        {currentScene.confidence}%
                      </span>
                    </div>
                  </div>
                </div>

                <Button 
                  className="w-full mt-6"
                  data-testid="button-view-opportunities"
                >
                  View Ad Opportunities
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export const DEMO_VIDEO_SCENES: Record<number, Scene[]> = {
  1001: [
    { id: "1001-1", timestamp: "00:05", imageUrl: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Monitor", "Desk", "Wall", "Shelf"], context: "Wide shot of minimalist workspace showing clean desk setup with monitor and wall decor area", confidence: 96 },
    { id: "1001-2", timestamp: "00:32", imageUrl: "https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Desk Mat", "Keyboard", "Accessories"], context: "Close-up of desk accessories and peripherals with clear product placement space", confidence: 92 },
    { id: "1001-3", timestamp: "01:15", imageUrl: "https://images.unsplash.com/photo-1593642702821-c8da6771f0c6?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Screen", "Background"], context: "Screen recording segment with visible background area", confidence: 88 },
    { id: "1001-4", timestamp: "02:48", imageUrl: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Laptop", "Table", "Hands"], context: "Product demonstration showing laptop and workspace", confidence: 94 },
  ],
  1002: [
    { id: "1002-1", timestamp: "00:12", imageUrl: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&h=450&fit=crop", surfaces: 5, surfaceTypes: ["Counter", "Appliances", "Cabinet", "Backsplash", "Island"], context: "Kitchen overview showing multiple surface areas for product integration", confidence: 97 },
    { id: "1002-2", timestamp: "00:45", imageUrl: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Island", "Stools", "Lighting"], context: "Kitchen island close-up with seating area", confidence: 91 },
    { id: "1002-3", timestamp: "01:30", imageUrl: "https://images.unsplash.com/photo-1556909172-54557c7e4fb7?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Countertop", "Utensils"], context: "Cooking preparation area with clear counter space", confidence: 89 },
  ],
  1003: [
    { id: "1003-1", timestamp: "00:08", imageUrl: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Microphone", "Desk", "Wall", "Monitor"], context: "Professional podcast setup with prominent equipment display", confidence: 98 },
    { id: "1003-2", timestamp: "01:20", imageUrl: "https://images.unsplash.com/photo-1478737270239-2f02b77fc618?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Audio Interface", "Headphones", "Cables"], context: "Audio equipment close-up showing technical gear", confidence: 95 },
    { id: "1003-3", timestamp: "03:45", imageUrl: "https://images.unsplash.com/photo-1590602847861-f357a9332bbc?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Background Wall", "Lighting"], context: "Background shot showing wall space for branding", confidence: 87 },
  ],
  1004: [
    { id: "1004-1", timestamp: "00:15", imageUrl: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Coffee Table", "Sofa", "Rug", "Wall Art"], context: "Living room wide shot with prominent coffee table", confidence: 95 },
    { id: "1004-2", timestamp: "00:48", imageUrl: "https://images.unsplash.com/photo-1583847268964-b28dc8f51f92?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Table Surface", "Decor", "Books"], context: "Coffee table styling close-up", confidence: 93 },
    { id: "1004-3", timestamp: "02:10", imageUrl: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Shelving", "Decorative Items"], context: "Shelf styling with accessory display area", confidence: 90 },
  ],
  1005: [
    { id: "1005-1", timestamp: "00:10", imageUrl: "https://images.unsplash.com/photo-1616588589676-62b3bd4ff6d2?w=800&h=450&fit=crop", surfaces: 5, surfaceTypes: ["Monitor", "Desk", "RGB Wall", "Keyboard", "Mouse"], context: "Ultimate gaming battlestation overview", confidence: 99 },
    { id: "1005-2", timestamp: "01:35", imageUrl: "https://images.unsplash.com/photo-1612287230202-1ff1d85d1bdf?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Headset", "Controller", "Stand"], context: "Gaming accessories close-up display", confidence: 94 },
    { id: "1005-3", timestamp: "03:20", imageUrl: "https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Chair", "Floor Mat"], context: "Gaming chair and floor setup", confidence: 88 },
  ],
  1006: [
    { id: "1006-1", timestamp: "00:05", imageUrl: "https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Desk", "Bookshelf", "Window"], context: "Home office transformation overview", confidence: 93 },
    { id: "1006-2", timestamp: "00:40", imageUrl: "https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Wall", "Lighting"], context: "Office wall decor and lighting setup", confidence: 89 },
  ],
  1007: [
    { id: "1007-1", timestamp: "00:08", imageUrl: "https://images.unsplash.com/photo-1603481588273-2f908a9a7a1b?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Camera", "Microphone", "Lights", "Green Screen"], context: "Streaming studio full setup", confidence: 97 },
    { id: "1007-2", timestamp: "02:15", imageUrl: "https://images.unsplash.com/photo-1587825140708-dfaf72ae4b04?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Webcam", "Monitor", "Desk"], context: "Close-up of streaming equipment", confidence: 94 },
    { id: "1007-3", timestamp: "04:30", imageUrl: "https://images.unsplash.com/photo-1616588589676-62b3bd4ff6d2?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Background", "Panels"], context: "Background setup and acoustic panels", confidence: 91 },
  ],
  1008: [
    { id: "1008-1", timestamp: "00:12", imageUrl: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Kitchen Island", "Stools", "Pendant Lights", "Backsplash"], context: "Modern kitchen island focal point", confidence: 96 },
    { id: "1008-2", timestamp: "01:05", imageUrl: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Counter", "Appliances", "Storage"], context: "Kitchen counter workspace", confidence: 92 },
  ],
  1009: [
    { id: "1009-1", timestamp: "00:20", imageUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Reading Chair", "Bookshelf", "Lamp", "Side Table"], context: "Cozy reading nook complete setup", confidence: 95 },
    { id: "1009-2", timestamp: "01:45", imageUrl: "https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Books", "Decor"], context: "Bookshelf styling details", confidence: 90 },
  ],
  1010: [
    { id: "1010-1", timestamp: "00:08", imageUrl: "https://images.unsplash.com/photo-1593642702821-c8da6771f0c6?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Monitor", "Desk", "Accessories"], context: "Clean workspace essentials overview", confidence: 94 },
    { id: "1010-2", timestamp: "00:55", imageUrl: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Laptop", "Stand"], context: "Laptop setup details", confidence: 91 },
  ],
  1011: [
    { id: "1011-1", timestamp: "00:15", imageUrl: "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800&h=450&fit=crop", surfaces: 5, surfaceTypes: ["Living Area", "Kitchen", "Bedroom", "Windows", "Art"], context: "Studio apartment full overview", confidence: 98 },
    { id: "1011-2", timestamp: "02:30", imageUrl: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&h=450&fit=crop", surfaces: 3, surfaceTypes: ["Shelving", "Storage", "Decor"], context: "Space-saving storage solutions", confidence: 93 },
    { id: "1011-3", timestamp: "05:15", imageUrl: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Seating", "Table"], context: "Dining and living space", confidence: 90 },
  ],
  1012: [
    { id: "1012-1", timestamp: "00:10", imageUrl: "https://images.unsplash.com/photo-1616594039964-ae9021a400a0?w=800&h=450&fit=crop", surfaces: 4, surfaceTypes: ["Bed", "Nightstand", "Wall", "Lighting"], context: "Aesthetic bedroom full reveal", confidence: 96 },
    { id: "1012-2", timestamp: "01:25", imageUrl: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&h=450&fit=crop", surfaces: 2, surfaceTypes: ["Dresser", "Mirror"], context: "Bedroom vanity area", confidence: 91 },
  ],
};
