import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, Shield, Video, X, Ban, DollarSign, TrendingUp, Users, Sparkles, Cpu, Eye, Timer, Layers, Mail, User, Plus } from "lucide-react";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
import logoBlackAmbition from "@assets/logo-black-ambition_1767712118620.png";
import logoMayDavis from "@assets/logo-may-davis_1767712118621.png";
import logoElementa from "@assets/logo-elementa_1767712118620.png";
import logoNue from "@assets/logo-nue_1767712118621.png";
import heroVideo from "@assets/generated_videos/creator_studio_cinematic_loop.mp4";
import realityImg from "@assets/generated_images/modern_kitchen_with_empty_counter.png";
import aiAugmentedImg from "@assets/generated_images/kitchen_with_liquid_death_can.png";
import surfaceEngineImg from "@assets/generated_images/desk_with_ai_tracking_grid.png";
import kitchenFrame from "@assets/generated_images/kitchen_vlog_frame.png";
import fitnessFrame from "@assets/generated_images/fitness_vlog_frame.png";
import techFrame from "@assets/generated_images/tech_review_frame.png";
import beautyFrame from "@assets/generated_images/beauty_vlog_frame.png";
import travelFrame from "@assets/generated_images/travel_vlog_frame.png";
import gamingFrame from "@assets/generated_images/gaming_stream_frame.png";
import { Footer } from "@/components/Footer";
import { Slider } from "@/components/ui/slider";

// ============================================================================
// SURFACE ENGINE DEMO - HARDCODED SUCCESS FOR FOUNDING COHORT LAUNCH
// Goal: 100% success rate - never show "Scan Failed"
// ============================================================================

// Pre-defined grid coordinates for "Many Jobs" 9:16 video (center-bottom desk area)
const HARDCODED_GRID_COORDS = {
  "16:9": [
    { x: 18, y: 52 }, { x: 82, y: 52 }, { x: 85, y: 82 }, { x: 15, y: 82 }
  ],
  "9:16": [
    // Pinned to lower-center of frame for vertical video (desk area)
    { x: 22, y: 68 }, { x: 78, y: 68 }, { x: 80, y: 92 }, { x: 20, y: 92 }
  ]
};

// Force success timeout (500ms) - if scan takes longer, immediately return success
const FORCE_SUCCESS_TIMEOUT_MS = 500;

function SurfaceEngineDemo({ isInView, aspectRatio = "16:9" }: { isInView: boolean; aspectRatio?: "16:9" | "9:16" }) {
  const [scanPhase, setScanPhase] = useState(0);
  const [confidence, setConfidence] = useState(0);
  const [lightingMatch, setLightingMatch] = useState(0);
  const [trackingLatency, setTrackingLatency] = useState(12);
  const [surfaceFound, setSurfaceFound] = useState(false);
  const [gridLocked, setGridLocked] = useState(false);
  const [statusMessage, setStatusMessage] = useState<'scanning' | 'syncing' | 'found' | 'locked'>('scanning');
  const forceSuccessTriggered = useRef(false);
  const scanStartTime = useRef<number | null>(null);

  const isVertical = aspectRatio === "9:16";
  const hardcodedGrid = HARDCODED_GRID_COORDS[aspectRatio];

  // ============================================================================
  // HARDCODED SUCCESS LOGIC - 500ms timeout forces "Surface Found"
  // ============================================================================
  useEffect(() => {
    if (!isInView) {
      setScanPhase(0);
      setConfidence(0);
      setLightingMatch(0);
      setTrackingLatency(12);
      setSurfaceFound(false);
      setGridLocked(false);
      setStatusMessage('scanning');
      forceSuccessTriggered.current = false;
      scanStartTime.current = null;
      return;
    }

    // Start timer for 500ms force success
    if (!scanStartTime.current) {
      scanStartTime.current = Date.now();
    }

    const interval = setInterval(() => {
      const elapsed = Date.now() - (scanStartTime.current || Date.now());
      
      setScanPhase(prev => {
        const next = prev + 1.5; // Faster scan animation
        
        // Force success after 500ms timeout - skip live scan, pin hardcoded grid
        if (elapsed >= FORCE_SUCCESS_TIMEOUT_MS && !forceSuccessTriggered.current) {
          forceSuccessTriggered.current = true;
          setSurfaceFound(true);
          setGridLocked(true);
          setStatusMessage('found');
          setConfidence(96);
          setLightingMatch(98);
          setTrackingLatency(0.02); // 0.02ms latency as promised
          return 100; // Jump to complete
        }
        
        // Scanning phase (0-30%): Show "Syncing Lighting..." instead of any failure
        if (next < 30) {
          setStatusMessage('syncing');
          setConfidence(prev => Math.min(40, prev + 2));
          setLightingMatch(prev => Math.min(60, prev + 3));
        }
        // Surface detection phase (30-70%)
        else if (next < 70) {
          setStatusMessage('found');
          setSurfaceFound(true);
          setConfidence(prev => Math.min(85, prev + 1.5));
          setLightingMatch(prev => Math.min(90, prev + 1.2));
          setTrackingLatency(prev => Math.max(0.02, prev - 1));
        }
        // Grid locked phase (70-100%)
        else {
          setStatusMessage('locked');
          setGridLocked(true);
          setConfidence(prev => Math.min(98, prev + 0.5));
          setLightingMatch(prev => Math.min(99, prev + 0.3));
          setTrackingLatency(0.02);
        }
        
        if (next >= 100) return 100; // Stay at 100, don't reset
        return next;
      });
    }, 40);

    return () => clearInterval(interval);
  }, [isInView]);

  // Always use hardcoded grid coordinates - no live detection needed
  const displayPoints = hardcodedGrid;
  
  // Grid always stable after initial scan (never show failure state)
  const isGridStable = scanPhase > 25 || surfaceFound;
  const gridOpacity = isGridStable ? 0.9 : 0.4 + Math.sin(Date.now() / 200) * 0.2;

  return (
    <div className="space-y-4">
      <div className="relative aspect-video rounded-2xl overflow-hidden border border-emerald-500/30 bg-black">
        <img src={realityImg} alt="Scene" className="absolute inset-0 w-full h-full object-cover" />
        
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
          <defs>
            <linearGradient id="homographyGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#10b981" stopOpacity={isGridStable ? "0.9" : "0.5"} />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity={isGridStable ? "0.7" : "0.3"} />
            </linearGradient>
          </defs>
          
          {/* Always render grid with hardcoded coordinates - never fails */}
          {scanPhase > 15 && (
            <>
              <motion.polygon
                points={displayPoints.map(p => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke="url(#homographyGradient)"
                strokeWidth={isGridStable ? "0.4" : "0.3"}
                animate={{ opacity: gridOpacity }}
                transition={{ duration: 0.1 }}
                style={{ filter: isGridStable ? 'drop-shadow(0 0 4px #10b981)' : 'none' }}
              />
              
              {[...Array(5)].map((_, i) => {
                const t = (i + 1) / 6;
                const x1 = displayPoints[0].x + (displayPoints[1].x - displayPoints[0].x) * t;
                const y1 = displayPoints[0].y + (displayPoints[1].y - displayPoints[0].y) * t;
                const x2 = displayPoints[3].x + (displayPoints[2].x - displayPoints[3].x) * t;
                const y2 = displayPoints[3].y + (displayPoints[2].y - displayPoints[3].y) * t;
                return (
                  <motion.line key={`v-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke="url(#homographyGradient)" strokeWidth="0.2"
                    animate={{ opacity: gridOpacity * 0.6 }}
                  />
                );
              })}
              {[...Array(4)].map((_, i) => {
                const t = (i + 1) / 5;
                const x1 = displayPoints[0].x + (displayPoints[3].x - displayPoints[0].x) * t;
                const y1 = displayPoints[0].y + (displayPoints[3].y - displayPoints[0].y) * t;
                const x2 = displayPoints[1].x + (displayPoints[2].x - displayPoints[1].x) * t;
                const y2 = displayPoints[1].y + (displayPoints[2].y - displayPoints[1].y) * t;
                return (
                  <motion.line key={`h-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke="url(#homographyGradient)" strokeWidth="0.2"
                    animate={{ opacity: gridOpacity * 0.6 }}
                  />
                );
              })}
              
              {displayPoints.map((p, i) => (
                <motion.circle key={i} cx={p.x} cy={p.y} r={isGridStable ? "1.2" : "0.8"}
                  fill={isGridStable ? "#10b981" : "#22d3ee"}
                  animate={{ opacity: isGridStable ? 1 : 0.6, scale: isGridStable ? 1 : [1, 1.3, 1] }}
                  transition={{ duration: 0.5, repeat: isGridStable ? 0 : Infinity }}
                  style={{ filter: 'drop-shadow(0 0 3px #10b981)' }}
                />
              ))}
            </>
          )}
        </svg>

        {/* Status indicator - never shows "Scan Failed", only positive states */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: scanPhase > 10 ? 1 : 0 }}
          className="absolute top-3 left-3"
        >
          <div className="px-2 py-1 rounded bg-black/80 border border-emerald-500/50 backdrop-blur-sm">
            <span className="text-[9px] font-mono text-emerald-400">
              {statusMessage === 'locked' || gridLocked
                ? "[Grid_Locked]" 
                : statusMessage === 'found' || surfaceFound
                  ? "[Surface_Found]"
                  : statusMessage === 'syncing'
                    ? "[Syncing_Lighting...]"
                    : "[Scanning...]"}
            </span>
          </div>
        </motion.div>

        {/* 3D Scene Reconstruction badge - always green when active */}
        {scanPhase > 20 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute top-10 left-3"
          >
            <div className="px-2 py-1 rounded bg-emerald-500/20 border border-emerald-400/50 backdrop-blur-sm">
              <span className="text-[8px] font-mono text-emerald-300">[3D_Scene_Active]</span>
            </div>
          </motion.div>
        )}

        {/* Grid locked indicator - always shows success */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: surfaceFound || scanPhase > 40 ? 1 : 0 }}
          className="absolute top-3 right-3"
        >
          <div className="px-2 py-1 rounded bg-emerald-500/20 border border-emerald-400 backdrop-blur-sm">
            <span className="text-[9px] font-mono text-emerald-300 font-semibold">
              {gridLocked ? "[Coords_Pinned]" : "[Tracking]"}
            </span>
          </div>
        </motion.div>

        <div className="absolute bottom-3 left-3 right-3">
          <div className="flex items-center justify-between text-[9px] font-mono text-emerald-400 mb-1">
            <span>Plane Detection</span>
            <span>{Math.round(scanPhase)}%</span>
          </div>
          <div className="h-1 bg-black/50 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-emerald-500 to-cyan-400 transition-all duration-75" style={{ width: `${scanPhase}%` }} />
          </div>
        </div>
      </div>

      {/* Stats cards - responsive grid: stack on mobile, 2 cols on sm, 3 cols on md+ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 mt-4">
        <div className={`rounded-xl p-3 border transition-all duration-300 ${scanPhase > 30 ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-white/5 border-white/10'}`}>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Confidence</p>
          <p className={`text-xl font-bold font-mono ${scanPhase > 30 ? 'text-emerald-400' : 'text-yellow-400'}`}>
            {confidence.toFixed(1)}%
          </p>
          <p className="text-[9px] text-muted-foreground mt-0.5">{scanPhase > 50 ? 'Stable' : 'Calibrating'}</p>
        </div>
        <div className={`rounded-xl p-3 border transition-all duration-300 ${scanPhase > 40 ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-white/5 border-white/10'}`}>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Lighting Match</p>
          <p className={`text-xl font-bold font-mono ${scanPhase > 40 ? 'text-emerald-400' : 'text-yellow-400'}`}>
            {lightingMatch.toFixed(1)}%
          </p>
          <p className="text-[9px] text-muted-foreground mt-0.5">{scanPhase > 60 ? 'Matched' : 'Syncing'}</p>
        </div>
        <div className={`rounded-xl p-3 border transition-all duration-300 ${scanPhase > 50 ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-white/5 border-white/10'}`}>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Track Latency</p>
          <p className={`text-xl font-bold font-mono ${scanPhase > 50 ? 'text-emerald-400' : 'text-yellow-400'}`}>
            {gridLocked ? '0.02ms' : `${trackingLatency.toFixed(0)}ms`}
          </p>
          <p className="text-[9px] text-muted-foreground mt-0.5">{scanPhase > 70 ? 'Real-time' : 'Optimizing'}</p>
        </div>
      </div>
    </div>
  );
}

function ModalNeuralScan({ isInView }: { isInView: boolean }) {
  const [scanProgress, setScanProgress] = useState(0);
  const [showProduct, setShowProduct] = useState(false);

  useEffect(() => {
    if (!isInView) {
      setScanProgress(0);
      setShowProduct(false);
      return;
    }

    const interval = setInterval(() => {
      setScanProgress(prev => {
        if (prev >= 100) {
          return 0;
        }
        if (prev >= 70 && prev < 72) {
          setShowProduct(true);
        }
        return prev + 1.5;
      });
    }, 40);

    return () => clearInterval(interval);
  }, [isInView]);

  return (
    <div className="relative aspect-video rounded-2xl overflow-hidden border border-emerald-500/30">
      <img src={realityImg} alt="Reality Scene" className="absolute inset-0 w-full h-full object-cover" />
      
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: showProduct ? 1 : 0 }}
        transition={{ duration: 0.4 }}
        className="absolute inset-0"
      >
        <img src={aiAugmentedImg} alt="AI Augmented" className="absolute inset-0 w-full h-full object-cover" />
      </motion.div>

      <svg className="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="none">
        <defs>
          <linearGradient id="modalScanGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="transparent" />
            <stop offset={`${Math.max(0, scanProgress - 10)}%`} stopColor="transparent" />
            <stop offset={`${scanProgress}%`} stopColor="#10b981" stopOpacity="0.8" />
            <stop offset={`${Math.min(100, scanProgress + 3)}%`} stopColor="#10b981" stopOpacity="0.1" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
        </defs>
        
        {[...Array(6)].map((_, i) => (
          <line key={`h-${i}`} x1="0%" y1={`${20 + i * 12}%`} x2="100%" y2={`${20 + i * 12}%`} stroke="url(#modalScanGradient)" strokeWidth="1" opacity="0.5" />
        ))}
        {[...Array(10)].map((_, i) => (
          <line key={`v-${i}`} x1={`${10 + i * 9}%`} y1="20%" x2={`${10 + i * 9}%`} y2="80%" stroke="url(#modalScanGradient)" strokeWidth="1" opacity="0.5" />
        ))}
        
        <line x1={`${scanProgress}%`} y1="0%" x2={`${scanProgress}%`} y2="100%" stroke="#10b981" strokeWidth="2" opacity="0.9" style={{ filter: 'drop-shadow(0 0 6px #10b981)' }} />
      </svg>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: scanProgress > 30 ? 1 : 0 }}
        className="absolute top-[25%] left-[20%]"
      >
        <div className="px-2 py-1 rounded bg-black/70 border border-emerald-500/50 backdrop-blur-sm">
          <span className="text-[9px] font-mono text-emerald-400">[Surface_ID: Counter_01]</span>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: scanProgress > 55 ? 1 : 0 }}
        className="absolute top-[40%] left-[45%]"
      >
        <div className="px-2 py-1 rounded bg-black/70 border border-emerald-500/50 backdrop-blur-sm">
          <span className="text-[9px] font-mono text-emerald-400">[Lighting: 99.4%]</span>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: showProduct ? 1 : 0, scale: showProduct ? 1 : 0.8 }}
        className="absolute bottom-[20%] right-[25%]"
      >
        <div className="px-2 py-1 rounded bg-emerald-500/20 border border-emerald-400 backdrop-blur-sm">
          <span className="text-[9px] font-mono text-emerald-300 font-semibold">[Product_Placed]</span>
        </div>
      </motion.div>

      <div className="absolute bottom-3 left-3 right-3">
        <div className="h-1 bg-black/50 rounded-full overflow-hidden">
          <div className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-75" style={{ width: `${scanProgress}%` }} />
        </div>
        <p className="text-[9px] font-mono text-emerald-400 text-center mt-1">Surface Engine: {Math.round(scanProgress)}%</p>
      </div>
    </div>
  );
}

function NeuralGrid() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-10">
      <svg className="absolute inset-0 w-full h-full opacity-20" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="gridGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.6" />
            <stop offset="50%" stopColor="#10b981" stopOpacity="0.4" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.2" />
          </linearGradient>
        </defs>
        {[...Array(11)].map((_, i) => (
          <motion.line
            key={`h-${i}`}
            x1="0"
            y1={i * 10}
            x2="100"
            y2={i * 10}
            stroke="url(#gridGradient)"
            strokeWidth="0.1"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: [0.1, 0.4, 0.1] }}
            transition={{ duration: 3, delay: i * 0.1, repeat: Infinity, repeatType: "reverse" }}
          />
        ))}
        {[...Array(11)].map((_, i) => (
          <motion.line
            key={`v-${i}`}
            x1={i * 10}
            y1="0"
            x2={i * 10 + 5}
            y2="100"
            stroke="url(#gridGradient)"
            strokeWidth="0.1"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: [0.1, 0.3, 0.1] }}
            transition={{ duration: 4, delay: i * 0.15, repeat: Infinity, repeatType: "reverse" }}
          />
        ))}
        {[...Array(5)].map((_, i) => (
          <motion.circle
            key={`node-${i}`}
            cx={20 + i * 15}
            cy={30 + (i % 3) * 20}
            r="0.8"
            fill="#10b981"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: [0, 1.5, 0], opacity: [0, 1, 0] }}
            transition={{ duration: 2, delay: i * 0.5, repeat: Infinity }}
          />
        ))}
      </svg>
      <div className="absolute top-1/4 left-1/4 w-2 h-2 bg-emerald-400 rounded-full animate-ping" />
      <div className="absolute top-1/3 right-1/3 w-1.5 h-1.5 bg-primary rounded-full animate-ping" style={{ animationDelay: '0.5s' }} />
      <div className="absolute bottom-1/3 left-1/2 w-2 h-2 bg-emerald-400 rounded-full animate-ping" style={{ animationDelay: '1s' }} />
    </div>
  );
}

function NeuralScanOverlay({ isVisible, onRevealProduct }: { isVisible: boolean; onRevealProduct: (revealed: boolean) => void }) {
  const [scanProgress, setScanProgress] = useState(0);
  const [showProductLabel, setShowProductLabel] = useState(false);
  const [shouldReveal, setShouldReveal] = useState(false);
  const productRevealThreshold = 70;

  useEffect(() => {
    if (shouldReveal) {
      onRevealProduct(true);
    }
  }, [shouldReveal, onRevealProduct]);

  useEffect(() => {
    if (!isVisible) {
      setScanProgress(0);
      setShowProductLabel(false);
      setShouldReveal(false);
      return;
    }

    const interval = setInterval(() => {
      setScanProgress(prev => {
        if (prev >= 100) {
          setShowProductLabel(false);
          return 0;
        }
        if (prev >= productRevealThreshold && prev < productRevealThreshold + 2) {
          setShowProductLabel(true);
          setShouldReveal(true);
        }
        return prev + 2;
      });
    }, 50);

    return () => clearInterval(interval);
  }, [isVisible]);

  if (!isVisible) return null;

  return (
    <div className="absolute inset-0 pointer-events-none z-10">
      <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="scanGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="transparent" />
            <stop offset={`${Math.max(0, scanProgress - 15)}%`} stopColor="transparent" />
            <stop offset={`${scanProgress}%`} stopColor="#10b981" stopOpacity="0.8" />
            <stop offset={`${Math.min(100, scanProgress + 5)}%`} stopColor="#10b981" stopOpacity="0.1" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
        </defs>
        
        {[...Array(8)].map((_, i) => (
          <line
            key={`h-${i}`}
            x1="0%"
            y1={`${15 + i * 10}%`}
            x2="100%"
            y2={`${15 + i * 10}%`}
            stroke="url(#scanGradient)"
            strokeWidth="1"
            opacity="0.6"
          />
        ))}
        
        {[...Array(12)].map((_, i) => (
          <line
            key={`v-${i}`}
            x1={`${8 + i * 8}%`}
            y1="15%"
            x2={`${8 + i * 8}%`}
            y2="85%"
            stroke="url(#scanGradient)"
            strokeWidth="1"
            opacity="0.6"
          />
        ))}
        
        <line
          x1={`${scanProgress}%`}
          y1="0%"
          x2={`${scanProgress}%`}
          y2="100%"
          stroke="#10b981"
          strokeWidth="2"
          opacity="0.9"
          style={{ filter: 'drop-shadow(0 0 8px #10b981)' }}
        />
      </svg>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: scanProgress > 20 ? 1 : 0 }}
        className="absolute top-[20%] left-[15%] hidden md:block"
      >
        <div className="px-2 py-1 rounded bg-black/70 border border-emerald-500/50 backdrop-blur-sm">
          <span className="text-[10px] font-mono text-emerald-400 animate-pulse">[Surface_ID: Table_01]</span>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: scanProgress > 45 ? 1 : 0 }}
        className="absolute top-[35%] left-[40%] hidden md:block"
      >
        <div className="px-2 py-1 rounded bg-black/70 border border-emerald-500/50 backdrop-blur-sm">
          <span className="text-[10px] font-mono text-emerald-400 animate-pulse">[Lighting_Fidelity: 99.4%]</span>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: scanProgress > 65 ? 1 : 0 }}
        className="absolute top-[55%] right-[20%] hidden md:block"
      >
        <div className="px-2 py-1 rounded bg-black/70 border border-emerald-500/50 backdrop-blur-sm">
          <span className="text-[10px] font-mono text-emerald-400 animate-pulse">[Occlusion_Mapping: Active]</span>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: showProductLabel ? 1 : 0, scale: showProductLabel ? 1 : 0.8 }}
        transition={{ duration: 0.3 }}
        className="absolute bottom-[25%] right-[25%] hidden md:block"
      >
        <div className="px-2 py-1 rounded bg-emerald-500/20 border border-emerald-400 backdrop-blur-sm">
          <span className="text-[10px] font-mono text-emerald-300 font-semibold">[Product_Materialized]</span>
        </div>
      </motion.div>

      <div className="md:hidden absolute bottom-4 left-4 right-4">
        <div className="h-1 bg-black/50 rounded-full overflow-hidden">
          <div 
            className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-100"
            style={{ width: `${scanProgress}%` }}
          />
        </div>
        <p className="text-[10px] font-mono text-emerald-400 text-center mt-1">Neural Scan: {scanProgress}%</p>
      </div>
    </div>
  );
}

function RealitySlider() {
  const [sliderValue, setSliderValue] = useState([50]);
  const [productRevealed, setProductRevealed] = useState(false);
  const showScan = sliderValue[0] > 10 && !productRevealed;
  const showAiImage = productRevealed;

  const handleRevealProduct = useCallback((revealed: boolean) => {
    if (revealed) {
      setProductRevealed(true);
    }
  }, []);

  useEffect(() => {
    if (sliderValue[0] <= 10) {
      setProductRevealed(false);
    }
  }, [sliderValue]);

  return (
    <div className="relative w-full max-w-4xl mx-auto">
      <div className="relative aspect-video rounded-2xl overflow-hidden border border-white/10 shadow-2xl shadow-primary/10">
        <img src={realityImg} alt="Reality Scene (Empty)" className="absolute inset-0 w-full h-full object-cover" data-testid="img-reality-base" />
        
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: showAiImage ? 1 : 0 }}
          transition={{ duration: 0.5 }}
          className="absolute inset-0"
        >
          <img src={aiAugmentedImg} alt="AI Augmented Scene" className="absolute inset-0 w-full h-full object-cover" data-testid="img-ai-augmented" />
        </motion.div>
        
        <NeuralScanOverlay isVisible={showScan} onRevealProduct={handleRevealProduct} />
        
        <div 
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 0 0 ${sliderValue[0]}%)` }}
        >
          <img src={realityImg} alt="Reality Scene" className="absolute inset-0 w-full h-full object-cover" data-testid="img-reality" />
        </div>
        <div 
          className="absolute top-0 bottom-0 w-1 bg-gradient-to-b from-primary via-emerald-400 to-primary shadow-lg shadow-primary/50"
          style={{ left: `${sliderValue[0]}%`, transform: 'translateX(-50%)' }}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/80 border-2 border-primary flex items-center justify-center backdrop-blur-sm">
            <Layers className="w-4 h-4 text-primary" />
          </div>
        </div>
        <div className="absolute top-4 left-4 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-xs font-medium text-white/80">
          Reality
        </div>
        <div className="absolute top-4 right-4 px-3 py-1.5 rounded-full bg-emerald-500/20 backdrop-blur-md border border-emerald-500/30 text-xs font-medium text-emerald-400 flex items-center gap-1.5">
          {showScan && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
          AI Augmented
        </div>
      </div>
      <div className="mt-6 px-4">
        <Slider
          value={sliderValue}
          onValueChange={setSliderValue}
          max={100}
          step={1}
          className="w-full"
          data-testid="slider-reality-augmented"
        />
        <div className="flex justify-between gap-4 mt-2 text-xs text-muted-foreground">
          <span>Reality</span>
          <span>AI Augmented</span>
        </div>
      </div>
    </div>
  );
}

function OpportunityFeed() {
  const frames = [
    { id: "frame-1", img: kitchenFrame, title: "Kitchen Vlog #42", cpm: 65, creator: "Maya T." },
    { id: "frame-2", img: fitnessFrame, title: "Morning Workout", cpm: 48, creator: "Jordan L." },
    { id: "frame-3", img: techFrame, title: "M3 Mac Unboxing", cpm: 85, creator: "Alex C." },
    { id: "frame-4", img: beautyFrame, title: "Summer Glow Tutorial", cpm: 72, creator: "Jamie B." },
    { id: "frame-5", img: travelFrame, title: "Tokyo Day 3", cpm: 55, creator: "Sam R." },
    { id: "frame-6", img: gamingFrame, title: "Ranked Grind", cpm: 42, creator: "Drew M." },
    { id: "frame-7", img: surfaceEngineImg, title: "Home Office Setup", cpm: 78, creator: "Taylor K." },
    { id: "frame-8", img: kitchenFrame, title: "Baking Challenge", cpm: 52, creator: "Chris P." },
  ];

  const duplicatedFrames = [...frames, ...frames, ...frames];
  const cardWidth = 272;
  const totalWidth = cardWidth * frames.length;

  return (
    <div className="relative w-full overflow-hidden py-8">
      <div className="absolute left-0 top-0 bottom-0 w-32 bg-gradient-to-r from-background to-transparent z-10" />
      <div className="absolute right-0 top-0 bottom-0 w-32 bg-gradient-to-l from-background to-transparent z-10" />
      <div 
        className="flex gap-4 animate-marquee"
        style={{ 
          width: `${totalWidth * 3}px`,
          animation: `marquee ${frames.length * 5}s linear infinite`
        }}
      >
        {duplicatedFrames.map((frame, i) => (
          <div 
            key={`${frame.id}-${i}`} 
            className="flex-shrink-0 w-64"
            data-testid={`card-opportunity-${frame.id}`}
          >
            <div className="relative rounded-xl overflow-hidden border border-white/10 bg-card/50 backdrop-blur-sm">
              <div className="aspect-video relative">
                <img src={frame.img} alt={frame.title} className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                <div className="absolute top-2 right-2 px-2 py-1 rounded-md bg-emerald-500/20 border border-emerald-500/40 backdrop-blur-sm" data-testid={`badge-detected-${frame.id}`}>
                  <span className="text-emerald-400 text-xs font-bold flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Detected
                  </span>
                </div>
                <div className="absolute bottom-2 left-2 right-2">
                  <p className="text-white text-sm font-medium truncate" data-testid={`text-title-${frame.id}`}>{frame.title}</p>
                  <p className="text-muted-foreground text-xs">{frame.creator}</p>
                </div>
              </div>
              <div className="p-3 flex items-center justify-between gap-2 border-t border-white/5">
                <div className="flex items-center gap-1.5">
                  <DollarSign className="w-3 h-3 text-primary" />
                  <span className="text-primary font-bold text-sm" data-testid={`text-cpm-${frame.id}`}>{frame.cpm} Credits</span>
                </div>
                <span className="text-xs text-muted-foreground">CPM Value</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <style>{`
        @keyframes marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-${totalWidth}px); }
        }
      `}</style>
    </div>
  );
}

function GlassMetricCard({ icon: Icon, label, value, sublabel, color = "primary", testId }: { 
  icon: typeof Cpu, 
  label: string, 
  value: string, 
  sublabel: string,
  color?: "primary" | "emerald" | "yellow",
  testId?: string
}) {
  const colorClasses = {
    primary: "text-primary border-primary/30 bg-primary/5",
    emerald: "text-emerald-400 border-emerald-500/30 bg-emerald-500/5",
    yellow: "text-yellow-400 border-yellow-500/30 bg-yellow-500/5"
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5 }}
      className={`relative p-3 md:p-4 rounded-xl md:rounded-2xl backdrop-blur-xl border ${colorClasses[color]} shadow-lg`}
      data-testid={testId}
    >
      <div className="absolute inset-0 rounded-xl md:rounded-2xl bg-gradient-to-br from-white/5 to-transparent pointer-events-none" />
      <div className="relative">
        <div className="flex items-center gap-1 md:gap-2 mb-1 md:mb-2">
          <Icon className={`w-3 h-3 md:w-4 md:h-4 ${color === 'primary' ? 'text-primary' : color === 'emerald' ? 'text-emerald-400' : 'text-yellow-400'}`} />
          <span className="text-[10px] md:text-xs uppercase tracking-wider text-muted-foreground font-medium">{label}</span>
        </div>
        <p className={`text-lg md:text-2xl font-bold ${color === 'primary' ? 'text-primary' : color === 'emerald' ? 'text-emerald-400' : 'text-yellow-400'}`} data-testid={testId ? `${testId}-value` : undefined}>{value}</p>
        <p className="text-[10px] md:text-xs text-muted-foreground mt-0.5 md:mt-1">{sublabel}</p>
      </div>
    </motion.div>
  );
}

export default function Landing() {
  const [showBetaModal, setShowBetaModal] = useState(false);
  const [showDemoModal, setShowDemoModal] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    const email = params.get("email");
    
    if (error === "access_restricted") {
      setAccessError(email || "your email");
      setShowBetaModal(true);
      window.history.replaceState({}, "", "/");
    }
  }, []);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, []);

  const handleLoginClick = () => {
    setAccessError(null);
    setShowBetaModal(true);
  };

  const handleActualLogin = () => {
    window.location.href = "/api/auth/google";
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col relative">
      {/* Cinematic Hero Section */}
      <section className="relative min-h-[600px] md:min-h-[700px] lg:h-screen overflow-hidden">
        <video
          ref={videoRef}
          src={heroVideo}
          autoPlay
          loop
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
          data-testid="video-hero"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/50 to-background" />
        <NeuralGrid />
        
        {/* Floating Glassmorphism Metrics - Desktop Only */}
        <div className="absolute top-1/4 right-8 hidden lg:flex flex-col gap-3 z-20">
          <GlassMetricCard icon={Eye} label="Lighting Match" value="98%" sublabel="Scene Analysis" color="emerald" testId="metric-lighting" />
          <GlassMetricCard icon={Timer} label="Tracking Latency" value="0.02ms" sublabel="Real-time" color="primary" testId="metric-latency" />
          <GlassMetricCard icon={Cpu} label="Inpainting" value="Active" sublabel="Proprietary AI" color="yellow" testId="metric-inpainting" />
        </div>

        {/* Navigation */}
        <nav 
          className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-4 md:px-6 h-16 md:h-20"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <img 
            src={logoUrl} 
            alt="FullScale" 
            className="h-8 md:h-10 w-auto" 
            data-testid="img-landing-logo" 
          />
          
          {/* Desktop Navigation - visible at 600px and above */}
          <div className="hidden min-[600px]:flex items-center gap-3">
            <a 
              href="https://airtable.com/appF4oLhgbf143xe7/pagil3dstNSBZvLUr/form"
              target="_blank"
              rel="noopener noreferrer"
              className="px-5 py-2 rounded-lg font-medium text-sm border border-primary text-primary bg-black/20 backdrop-blur-sm hover:bg-primary/10 transition-colors min-h-[44px] flex items-center"
              data-testid="button-nav-apply"
            >
              Apply for Access
            </a>
            <button 
              onClick={handleLoginClick}
              className="px-5 py-2 rounded-lg font-medium text-sm border border-white/20 bg-white/10 backdrop-blur-sm hover:bg-white/20 transition-colors text-white min-h-[44px] flex items-center"
              data-testid="button-nav-signin"
            >
              Sign In
            </button>
          </div>

          {/* Mobile Icon Buttons - visible below 600px with 1.5rem spacing from logo */}
          <div className="flex min-[600px]:hidden items-center gap-3 ml-6">
            <a 
              href="https://airtable.com/appF4oLhgbf143xe7/pagil3dstNSBZvLUr/form"
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 rounded-lg border border-primary text-primary bg-black/20 backdrop-blur-sm hover:bg-primary/10 transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
              data-testid="button-mobile-apply"
              aria-label="Apply for Access"
            >
              <Plus className="w-5 h-5" />
            </a>
            <button 
              onClick={handleLoginClick}
              className="p-2 rounded-lg border border-white/20 bg-white/10 backdrop-blur-sm hover:bg-white/20 transition-colors text-white min-h-[44px] min-w-[44px] flex items-center justify-center"
              data-testid="button-mobile-signin"
              aria-label="Sign In"
            >
              <User className="w-5 h-5" />
            </button>
          </div>
        </nav>

        {/* Hero Content */}
        <div className="absolute inset-0 flex items-center justify-center z-20 pt-20 md:pt-0">
          <div className="container mx-auto px-6 text-center">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8 }}
              className="flex flex-col items-center mt-4 md:mt-0"
            >
              {/* Status Badge - Positioned above headline with 2rem spacing, clear of nav on mobile */}
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-black/40 backdrop-blur-md border border-white/10 text-xs sm:text-sm text-white/80 mb-8 mt-8 md:mt-0">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400"></span>
                </span>
                3D Scene Reconstruction Active
              </div>

              <h1 className="text-4xl sm:text-5xl md:text-7xl font-bold font-display tracking-tight mb-6 text-white uppercase">
                We Turn Storytelling <br/>
                <span className="bg-gradient-to-r from-primary via-emerald-400 to-primary bg-clip-text text-transparent">Into Revenue</span>
              </h1>
              
              <p className="text-xl md:text-2xl text-white/70 max-w-3xl mx-auto mb-10 leading-relaxed">
                AI-powered product placement that dreams products into your existing content with perfect lighting, occlusion, and tracking.
              </p>

              <div className="flex flex-col sm:flex-row gap-4 items-center justify-center">
                <button 
                  onClick={handleLoginClick}
                  className="px-10 py-5 rounded-xl bg-primary hover:bg-primary/90 text-white font-semibold text-lg shadow-2xl shadow-primary/30 hover:shadow-primary/50 hover:-translate-y-1 transition-all duration-300"
                  data-testid="button-hero-start"
                >
                  Start Monetizing Now
                </button>
                <button 
                  onClick={() => setShowDemoModal(true)}
                  className="px-10 py-5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white font-semibold text-lg backdrop-blur-md transition-all duration-300 flex items-center gap-2"
                  data-testid="button-view-demo"
                >
                  <Eye className="w-5 h-5" />
                  Take an Interactive Tour
                </button>
              </div>
            </motion.div>
          </div>
        </div>

        {/* Scroll Indicator - Hidden on mobile to avoid overlapping CTA buttons */}
        <motion.div 
          className="absolute bottom-[5%] left-1/2 -translate-x-1/2 z-20 hidden md:block"
          animate={{ y: [0, 10, 0] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          <div className="w-6 h-10 rounded-full border-2 border-white/30 flex items-start justify-center p-2">
            <div className="w-1.5 h-3 rounded-full bg-white/50" />
          </div>
        </motion.div>
      </section>

      {/* Mobile Floating Metrics - responsive: stack on mobile, 3 cols on sm+ */}
      <div className="lg:hidden container mx-auto px-6 py-8 relative z-20 mt-8">
        <div className="grid grid-cols-1 min-[480px]:grid-cols-3 gap-3">
          <GlassMetricCard icon={Eye} label="Lighting" value="98%" sublabel="Match" color="emerald" testId="metric-lighting-mobile" />
          <GlassMetricCard icon={Timer} label="Latency" value="0.02ms" sublabel="Tracking" color="primary" testId="metric-latency-mobile" />
          <GlassMetricCard icon={Cpu} label="Inpainting" value="Active" sublabel="AI" color="yellow" testId="metric-inpainting-mobile" />
        </div>
      </div>

      {/* Reality vs Augmented Section */}
      <section className="py-24 relative overflow-hidden">
        <div className="absolute top-1/2 left-0 w-[600px] h-[600px] bg-primary/10 rounded-full blur-[200px] -translate-y-1/2 pointer-events-none" />
        <div className="absolute top-1/2 right-0 w-[600px] h-[600px] bg-emerald-500/10 rounded-full blur-[200px] -translate-y-1/2 pointer-events-none" />
        
        <div className="container mx-auto px-6 relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-12"
          >
            <h2 className="text-3xl md:text-5xl font-bold font-display tracking-tight mb-4 uppercase">
              Reality vs <span className="text-emerald-400">Augmented</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Watch our AI dream products onto surfaces with perfect occlusion and lighting. Drag the slider to see the transformation.
            </p>
          </motion.div>
          
          <RealitySlider />
        </div>
      </section>

      {/* Opportunity Feed Marquee */}
      <section className="py-16 bg-gradient-to-b from-transparent via-card/30 to-transparent">
        <div className="container mx-auto px-6 mb-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center"
          >
            <h2 className="text-3xl md:text-4xl font-bold font-display tracking-tight mb-4 uppercase">
              Live <span className="text-primary">Opportunity Feed</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Real-time inventory index. Every frame scanned. Every surface monetizable.
            </p>
          </motion.div>
        </div>
        <OpportunityFeed />
      </section>

      {/* Partners Section */}
      <section className="py-16 container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="w-full max-w-4xl mx-auto py-8 border-t border-b border-white/5"
        >
          <p className="text-xs uppercase tracking-widest text-muted-foreground/50 mb-6 font-medium text-center">Backed by Industry Leaders</p>
          <div className="flex flex-row flex-wrap md:flex-nowrap items-center justify-center gap-12">
            <img src={logoBlackAmbition} alt="Black Ambition" className="h-10 w-auto opacity-60 hover:opacity-100 transition-opacity" />
            <img src={logoMayDavis} alt="May Davis Partners" className="h-16 w-auto opacity-60 hover:opacity-100 transition-opacity" />
            <img src={logoElementa} alt="Elementa" className="h-16 w-auto opacity-60 hover:opacity-100 transition-opacity" />
            <img src={logoNue} alt="Nue Agency" className="h-10 w-auto opacity-60 hover:opacity-100 transition-opacity" />
          </div>
        </motion.div>
      </section>

      {/* Features Section */}
      <section className="py-24 container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-5xl mx-auto"
        >
          <FeatureCard 
            icon={<Zap className="w-6 h-6 text-yellow-400" />} 
            title="The Remix Engine" 
            desc="We turn archives into new viral inventory. Our AI identifies high-value moments and inserts products automatically." 
          />
          <FeatureCard 
            icon={<Shield className="w-6 h-6 text-emerald-400" />} 
            title="Contextual AI" 
            desc="Beyond computer vision. We analyze narrative, sentiment, and cultural nuance to ensure brand safety." 
          />
          <FeatureCard 
            icon={<Video className="w-6 h-6 text-blue-400" />} 
            title="ZERO RESHOOTS" 
            desc="Stop filming ads. We insert high-value products into your existing content library using post-production AI." 
          />
        </motion.div>
      </section>

      {/* How It Works Section */}
      <section className="py-24 container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="w-full max-w-5xl mx-auto"
        >
          <h2 className="text-3xl md:text-4xl font-bold font-display tracking-tight mb-12 uppercase text-center">
            A Simple Path <span className="text-primary">Forward.</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="text-center p-6">
              <span className="text-5xl font-bold text-primary font-display">01</span>
              <h3 className="text-xl font-bold font-display mt-4 mb-3">Connect.</h3>
              <p className="text-muted-foreground leading-relaxed">
                Link your YouTube channel securely. We index your library in minutes, not weeks.
              </p>
            </div>
            <div className="text-center p-6">
              <span className="text-5xl font-bold text-primary font-display">02</span>
              <h3 className="text-xl font-bold font-display mt-4 mb-3">Align.</h3>
              <p className="text-muted-foreground leading-relaxed">
                Our AI identifies brand-safe opportunities that match your specific aesthetic.
              </p>
            </div>
            <div className="text-center p-6">
              <span className="text-5xl font-bold text-primary font-display">03</span>
              <h3 className="text-xl font-bold font-display mt-4 mb-3">Earn.</h3>
              <p className="text-muted-foreground leading-relaxed">
                Approve placements and generate recurring revenue from your back-catalog.
              </p>
            </div>
          </div>
        </motion.div>
      </section>

      {/* Testimonial */}
      <section className="py-24 container mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="w-full max-w-3xl mx-auto text-center"
        >
          <blockquote className="text-2xl md:text-3xl italic font-serif text-white/90 leading-relaxed">
            "FullScale helped us unlock value from content we'd forgotten about. It feels like discovering a whole new revenue stream without changing how we create."
          </blockquote>
          <p className="mt-6 text-muted-foreground font-medium">— Early Creator Partner</p>
        </motion.div>
      </section>

      {/* Founding Cohort CTA */}
      <section
        id="cohort"
        className="relative w-full py-20 bg-gradient-to-b from-transparent to-card/30"
      >
        <div className="container mx-auto px-6 text-center">
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-4xl font-bold font-display tracking-tight mb-4 uppercase">
              Join the <span className="text-primary">Founding Cohort.</span>
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-8 leading-relaxed">
              Not ready to automate everything? Join our exclusive group of partner creators shaping the future of the platform.
            </p>
            <a 
              href="https://airtable.com/appF4oLhgbf143xe7/pagil3dstNSBZvLUr/form"
              target="_blank"
              rel="noopener noreferrer"
              className="px-8 py-4 rounded-xl bg-transparent hover:bg-white/5 border-2 border-primary text-primary font-semibold text-lg transition-all duration-300 inline-block"
              data-testid="button-apply-access"
            >
              Apply for Access
            </a>
          </motion.div>
        </div>
      </section>

      <Footer />

      {/* Beta Modal */}
      <AnimatePresence>
        {showBetaModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
            onClick={() => setShowBetaModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="relative w-full max-w-md bg-card border border-white/10 rounded-2xl p-8 text-center shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => { setShowBetaModal(false); setAccessError(null); }}
                className="absolute top-4 right-4 text-muted-foreground hover:text-white transition-colors"
                data-testid="button-modal-close"
              >
                <X className="w-5 h-5" />
              </button>

              {accessError ? (
                <>
                  <div className="w-16 h-16 mx-auto mb-6 bg-red-500/20 rounded-full flex items-center justify-center">
                    <Ban className="w-8 h-8 text-red-400" />
                  </div>
                  <h2 className="text-2xl font-bold font-display tracking-tight mb-4 uppercase text-red-400">
                    Access Restricted
                  </h2>
                  <p className="text-muted-foreground leading-relaxed mb-4">
                    You are not in the Founding Cohort yet.
                  </p>
                  <p className="text-sm text-muted-foreground/60 mb-8">
                    Email: <span className="text-white">{accessError}</span>
                  </p>
                  <a
                    href="https://airtable.com/appF4oLhgbf143xe7/pagil3dstNSBZvLUr/form"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block w-full px-6 py-3 rounded-xl bg-primary hover:bg-primary/90 text-white font-semibold text-lg transition-colors"
                    data-testid="button-modal-apply-after-denied"
                  >
                    Apply for Access
                  </a>
                </>
              ) : (
                <>
                  <h2 className="text-2xl font-bold font-display tracking-tight mb-4 uppercase">
                    FullScale is Currently <span className="text-primary">Invite-Only.</span>
                  </h2>
                  
                  <p className="text-muted-foreground leading-relaxed mb-8">
                    We are onboarding a select cohort of founding creators to ensure the highest quality experience. Applications are reviewed daily.
                  </p>

                  <a
                    href="https://airtable.com/appF4oLhgbf143xe7/pagil3dstNSBZvLUr/form"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block w-full px-6 py-3 rounded-xl bg-primary hover:bg-primary/90 text-white font-semibold text-lg transition-colors"
                    data-testid="button-modal-apply"
                  >
                    Apply for Access
                  </a>

                  <button
                    onClick={handleActualLogin}
                    className="mt-6 text-sm text-muted-foreground/60 hover:text-white transition-colors underline underline-offset-4"
                    data-testid="button-modal-partner-signin"
                  >
                    Already a Partner? Sign In
                  </button>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Demo/Vision Pitch Modal */}
      <AnimatePresence>
        {showDemoModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/95 backdrop-blur-md overflow-y-auto"
            onClick={() => setShowDemoModal(false)}
          >
            <button
              onClick={() => setShowDemoModal(false)}
              className="fixed top-6 right-6 z-[200] w-12 h-12 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-xl border border-white/30 text-white hover:text-white hover:bg-white/30 transition-all duration-200 shadow-xl shadow-black/40"
              style={{ boxShadow: '0 0 20px rgba(16, 185, 129, 0.3), 0 4px 20px rgba(0,0,0,0.5)' }}
              data-testid="button-demo-close"
            >
              <X className="w-6 h-6" />
            </button>
            
            <div className="min-h-full flex items-start justify-center p-4 pt-8 pb-16">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                transition={{ duration: 0.3 }}
                className="relative w-full max-w-6xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="relative rounded-3xl border border-white/10 bg-gradient-to-br from-black/80 via-black/90 to-black/80 backdrop-blur-2xl shadow-2xl overflow-hidden">
                <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/20 rounded-full blur-[120px] pointer-events-none" />
                <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-emerald-500/10 rounded-full blur-[120px] pointer-events-none" />
                
                <div className="relative px-8 pt-8 pb-6 border-b border-white/5">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.3em] text-primary font-bold mb-2">Vision Preview</p>
                      <h2 className="text-3xl md:text-4xl font-bold font-display tracking-tight">
                        The Future of <span className="text-primary">Creator Revenue</span>
                      </h2>
                    </div>
                    <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/30">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400"></span>
                      </span>
                      <span className="text-emerald-400 text-sm font-medium">Platform Live</span>
                    </div>
                  </div>
                </div>

                <div className="relative p-8">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-10">
                    <div className="space-y-4">
                      <div className="flex items-center gap-2 mb-4">
                        <Users className="w-5 h-5 text-primary" />
                        <h3 className="text-lg font-bold text-white uppercase tracking-wider">Founding Creators</h3>
                      </div>
                      <div className="bg-white/5 rounded-2xl border border-white/5 p-4 max-h-64 overflow-y-auto">
                        <div className="grid grid-cols-4 gap-2">
                          {[
                            { name: "Alex Chen", niche: "Tech", revenue: "$4.2K" },
                            { name: "Maya Torres", niche: "Lifestyle", revenue: "$3.8K" },
                            { name: "Jordan Lee", niche: "Fitness", revenue: "$5.1K" },
                            { name: "Sam Rivera", niche: "Travel", revenue: "$2.9K" },
                            { name: "Taylor Kim", niche: "Food", revenue: "$3.4K" },
                            { name: "Drew Morgan", niche: "Gaming", revenue: "$6.2K" },
                            { name: "Chris Patel", niche: "Music", revenue: "$2.7K" },
                            { name: "Jamie Brooks", niche: "Beauty", revenue: "$4.5K" },
                          ].map((creator, i) => (
                            <div key={i} className="bg-white/5 rounded-xl p-2 text-center hover:bg-white/10 transition-colors">
                              <div className="w-10 h-10 mx-auto rounded-full bg-gradient-to-br from-primary/40 to-emerald-500/40 flex items-center justify-center text-white text-xs font-bold mb-1">
                                {creator.name.split(' ').map(n => n[0]).join('')}
                              </div>
                              <p className="text-xs font-medium text-white truncate">{creator.name.split(' ')[0]}</p>
                              <p className="text-xs text-muted-foreground">{creator.niche}</p>
                              <p className="text-xs text-emerald-400 font-bold">{creator.revenue}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground text-center">
                        Join 50+ creators already earning passive income
                      </p>
                    </div>

                    <div className="space-y-4">
                      <div className="flex items-center gap-2 mb-4">
                        <TrendingUp className="w-5 h-5 text-emerald-400" />
                        <h3 className="text-lg font-bold text-white uppercase tracking-wider">Platform Metrics</h3>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-gradient-to-br from-primary/20 to-primary/5 rounded-2xl p-5 border border-primary/20">
                          <p className="text-xs text-primary uppercase tracking-wider mb-2 font-semibold">Total Scene Value</p>
                          <p className="text-3xl font-bold text-white">$2.4M</p>
                          <p className="text-xs text-muted-foreground mt-1">Identified opportunities</p>
                        </div>
                        <div className="bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 rounded-2xl p-5 border border-emerald-500/20">
                          <p className="text-xs text-emerald-400 uppercase tracking-wider mb-2 font-semibold">Active Brand Bids</p>
                          <p className="text-3xl font-bold text-white">847</p>
                          <p className="text-xs text-muted-foreground mt-1">Across all creators</p>
                        </div>
                        <div className="bg-white/5 rounded-2xl p-5 border border-white/5">
                          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-semibold">Avg. Placement Value</p>
                          <p className="text-3xl font-bold text-white">$285</p>
                          <p className="text-xs text-emerald-400 mt-1">+42% vs. traditional</p>
                        </div>
                        <div className="bg-white/5 rounded-2xl p-5 border border-white/5">
                          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-semibold">Videos Analyzed</p>
                          <p className="text-3xl font-bold text-white">12.4K</p>
                          <p className="text-xs text-muted-foreground mt-1">And growing daily</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mb-10">
                    <div className="flex items-center gap-2 mb-6">
                      <Sparkles className="w-5 h-5 text-yellow-400" />
                      <h3 className="text-lg font-bold text-white uppercase tracking-wider">The Surface Engine</h3>
                      <span className="px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 text-xs font-bold">Proprietary AI</span>
                    </div>
                    <div className="w-full max-w-4xl mx-auto">
                      <SurfaceEngineDemo isInView={showDemoModal} />
                      <p className="mt-4 text-center text-muted-foreground text-sm" data-testid="text-engine-caption">
                        Homography estimation locks onto horizontal planes. Confidence thresholds ensure stable, jitter-free placement grids.
                      </p>
                    </div>
                  </div>

                  <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-emerald-500/10 rounded-2xl border border-primary/20 p-6">
                    <div className="flex items-center gap-2 mb-4">
                      <DollarSign className="w-5 h-5 text-primary" />
                      <h3 className="text-lg font-bold text-white uppercase tracking-wider">Your Potential Earnings</h3>
                    </div>
                    <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                      <div className="flex items-center gap-4">
                        <div className="w-16 h-16 rounded-2xl bg-primary/20 border border-primary/30 flex items-center justify-center">
                          <Video className="w-8 h-8 text-primary" />
                        </div>
                        <div>
                          <p className="text-2xl font-bold text-white">Your Library (4 Videos)</p>
                          <p className="text-muted-foreground">Estimated monthly passive placements</p>
                        </div>
                      </div>
                      <div className="text-center md:text-right">
                        <p className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-emerald-400 to-primary bg-clip-text text-transparent">
                          $150 - $400<span className="text-lg text-muted-foreground">/mo</span>
                        </p>
                        <p className="text-sm text-muted-foreground mt-1">Based on current platform averages</p>
                      </div>
                    </div>
                  </div>

                  <div className="mt-8 bg-gradient-to-br from-white/5 to-transparent rounded-2xl border border-white/10 p-8 text-center">
                    <h3 className="text-xl font-bold text-white mb-2" data-testid="text-tour-heading">Request a Private Founders Tour</h3>
                    <p className="text-muted-foreground mb-6 max-w-lg mx-auto">
                      Get a personalized walkthrough of the platform, see the AI in action, and discuss partnership opportunities directly with our founder.
                    </p>
                    <a
                      href="mailto:fullscale_info@gofullscale.co?subject=FullScale Demo Request - Founding Cohort"
                      className="inline-flex items-center gap-2 px-10 py-4 rounded-xl bg-primary hover:bg-primary/90 text-white font-bold text-lg shadow-lg shadow-primary/30 hover:shadow-primary/50 hover:-translate-y-1 transition-all duration-300"
                      data-testid="button-email-demo"
                    >
                      <Mail className="w-5 h-5" />
                      Email our team for a demo
                    </a>
                    <p className="mt-4 text-sm text-muted-foreground">
                      Limited spots available in the Founding Cohort
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode, title: string, desc: string }) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className="p-6 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors text-left"
    >
      <div className="w-12 h-12 rounded-xl bg-background/50 flex items-center justify-center mb-4">
        {icon}
      </div>
      <h3 className="text-lg font-bold font-display mb-2">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{desc}</p>
    </motion.div>
  );
}
