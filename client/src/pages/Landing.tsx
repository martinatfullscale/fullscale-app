import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, Shield, Video, X, Ban, DollarSign, TrendingUp, Users, Sparkles, Play, Cpu, Eye, Timer, Layers } from "lucide-react";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
import logoBlackAmbition from "@assets/logo-black-ambition_1767712118620.png";
import logoMayDavis from "@assets/logo-may-davis_1767712118621.png";
import logoElementa from "@assets/logo-elementa_1767712118620.png";
import logoNue from "@assets/logo-nue_1767712118621.png";
import heroVideo from "@assets/generated_videos/creator_studio_cinematic_loop.mp4";
import beforeImg from "@assets/generated_images/clean_desk_before_product_placement.png";
import afterImg from "@assets/generated_images/desk_with_ai-placed_product.png";
import surfaceEngineImg from "@assets/generated_images/desk_with_ai_tracking_grid.png";
import kitchenFrame from "@assets/generated_images/kitchen_vlog_frame.png";
import fitnessFrame from "@assets/generated_images/fitness_vlog_frame.png";
import techFrame from "@assets/generated_images/tech_review_frame.png";
import beautyFrame from "@assets/generated_images/beauty_vlog_frame.png";
import travelFrame from "@assets/generated_images/travel_vlog_frame.png";
import gamingFrame from "@assets/generated_images/gaming_stream_frame.png";
import { Footer } from "@/components/Footer";
import { Slider } from "@/components/ui/slider";

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

function RealitySlider() {
  const [sliderValue, setSliderValue] = useState([50]);

  return (
    <div className="relative w-full max-w-4xl mx-auto">
      <div className="relative aspect-video rounded-2xl overflow-hidden border border-white/10 shadow-2xl shadow-primary/10">
        <img src={beforeImg} alt="Original Scene" className="absolute inset-0 w-full h-full object-cover" />
        <div 
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 ${100 - sliderValue[0]}% 0 0)` }}
        >
          <img src={afterImg} alt="AI Enhanced Scene" className="absolute inset-0 w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-emerald-500/5 to-emerald-500/10" />
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
        <div className="absolute top-4 right-4 px-3 py-1.5 rounded-full bg-emerald-500/20 backdrop-blur-md border border-emerald-500/30 text-xs font-medium text-emerald-400">
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
        <div className="flex justify-between mt-2 text-xs text-muted-foreground">
          <span>Original Scene</span>
          <span>AI Product Placement</span>
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
        <nav className="absolute top-0 left-0 right-0 z-30 container mx-auto px-6 h-20 flex items-center justify-between">
          <img src={logoUrl} alt="FullScale" className="h-10 w-auto" data-testid="img-landing-logo" />
          <div className="flex items-center gap-3">
            <a 
              href="https://airtable.com/appF4oLhgbf143xe7/pagil3dstNSBZvLUr/form"
              target="_blank"
              rel="noopener noreferrer"
              className="px-5 py-2 rounded-lg font-medium text-sm border border-primary text-primary bg-black/20 backdrop-blur-sm hover:bg-primary/10 transition-colors"
              data-testid="button-nav-apply"
            >
              Apply for Access
            </a>
            <button 
              onClick={handleLoginClick}
              className="px-5 py-2 rounded-lg font-medium text-sm border border-white/20 bg-white/10 backdrop-blur-sm hover:bg-white/20 transition-colors text-white"
              data-testid="button-nav-signin"
            >
              Sign In
            </button>
          </div>
        </nav>

        {/* Hero Content */}
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className="container mx-auto px-6 text-center">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8 }}
            >
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-black/40 backdrop-blur-md border border-white/10 text-sm text-white/80 mb-8">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400"></span>
                </span>
                3D Scene Reconstruction Active
              </div>

              <h1 className="text-5xl md:text-7xl font-bold font-display tracking-tight mb-6 text-white uppercase">
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

        {/* Scroll Indicator */}
        <motion.div 
          className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20"
          animate={{ y: [0, 10, 0] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          <div className="w-6 h-10 rounded-full border-2 border-white/30 flex items-start justify-center p-2">
            <div className="w-1.5 h-3 rounded-full bg-white/50" />
          </div>
        </motion.div>
      </section>

      {/* Mobile Floating Metrics */}
      <div className="lg:hidden container mx-auto px-6 py-6 relative z-20">
        <div className="grid grid-cols-3 gap-2">
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
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-md p-4 overflow-y-auto"
            onClick={() => setShowDemoModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.3 }}
              className="relative w-full max-w-6xl my-8"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setShowDemoModal(false)}
                className="absolute -top-12 right-0 text-white/60 hover:text-white transition-colors z-10"
                data-testid="button-demo-close"
              >
                <X className="w-8 h-8" />
              </button>

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
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-center">
                      <div className="relative rounded-2xl overflow-hidden border border-emerald-500/30 shadow-lg shadow-emerald-500/10">
                        <img 
                          src={surfaceEngineImg} 
                          alt="Surface Engine - Homography Estimation" 
                          className="w-full h-auto"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                        <div className="absolute bottom-0 left-0 right-0 p-4">
                          <div className="flex items-center gap-2">
                            <Play className="w-4 h-4 text-emerald-400" />
                            <span className="text-emerald-400 text-xs font-semibold uppercase tracking-wider">Live Detection</span>
                          </div>
                        </div>
                      </div>
                      <div className="space-y-4">
                        <p className="text-lg text-white leading-relaxed">
                          Our proprietary AI identifies <span className="text-emerald-400 font-semibold">high-value contextual real estate</span> in every frame.
                        </p>
                        <div className="space-y-3">
                          <div className="flex items-start gap-3">
                            <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <span className="text-emerald-400 text-xs font-bold">1</span>
                            </div>
                            <p className="text-sm text-muted-foreground"><span className="text-white font-medium">Homography Estimation</span> - Precise surface mapping in 3D space</p>
                          </div>
                          <div className="flex items-start gap-3">
                            <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <span className="text-emerald-400 text-xs font-bold">2</span>
                            </div>
                            <p className="text-sm text-muted-foreground"><span className="text-white font-medium">2D Planar Tracking</span> - Frame-by-frame motion analysis</p>
                          </div>
                          <div className="flex items-start gap-3">
                            <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <span className="text-emerald-400 text-xs font-bold">3</span>
                            </div>
                            <p className="text-sm text-muted-foreground"><span className="text-white font-medium">Context Scoring</span> - Brand-safe opportunity ranking</p>
                          </div>
                        </div>
                      </div>
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

                  <div className="mt-8 text-center">
                    <a
                      href="https://airtable.com/appF4oLhgbf143xe7/pagil3dstNSBZvLUr/form"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block px-10 py-4 rounded-xl bg-primary hover:bg-primary/90 text-white font-bold text-lg shadow-lg shadow-primary/30 hover:shadow-primary/50 hover:-translate-y-1 transition-all duration-300"
                      data-testid="button-demo-apply"
                    >
                      Apply for Early Access
                    </a>
                    <p className="mt-4 text-sm text-muted-foreground">
                      Limited spots available in the Founding Cohort
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
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
