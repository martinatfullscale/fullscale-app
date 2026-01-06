import { motion } from "framer-motion";
import { Zap, Shield, Video, ImageIcon } from "lucide-react";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
import logoBlackAmbition from "@assets/logo-black-ambition_1767712118620.png";
import logoMayDavis from "@assets/logo-may-davis_1767712118621.png";
import logoElementa from "@assets/logo-elementa_1767712118620.png";
import logoNue from "@assets/logo-nue_1767712118621.png";
import { Footer } from "@/components/Footer";

export default function Landing() {
  const handleLogin = () => {
    window.location.href = "/api/login";
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col relative overflow-hidden">
      {/* Background Gradients */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0">
        <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-primary/20 rounded-full blur-[128px]" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-blue-600/10 rounded-full blur-[128px]" />
      </div>

      <nav className="relative z-10 container mx-auto px-6 h-20 flex items-center justify-between">
        <img src={logoUrl} alt="FullScale" className="h-10 w-auto" data-testid="img-landing-logo" />
        
        <div className="flex items-center gap-3">
          <a 
            href="#cohort"
            className="px-5 py-2 rounded-lg font-medium text-sm border border-primary text-primary bg-transparent hover:bg-primary/10 transition-colors"
            data-testid="button-nav-apply"
          >
            Apply for Access
          </a>
          <button 
            onClick={handleLogin}
            className="px-5 py-2 rounded-lg font-medium text-sm border border-border bg-white/5 hover:bg-white/10 transition-colors"
          >
            Sign In
          </button>
        </div>
      </nav>

      <main className="flex-1 relative z-10 container mx-auto px-6 flex flex-col items-center justify-center text-center pb-20">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-secondary/50 border border-white/10 text-sm text-primary mb-8">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
            </span>
            New Creator Features Available
          </div>

          <h1 className="text-4xl md:text-6xl font-bold font-display tracking-tight mb-6 bg-clip-text text-transparent bg-gradient-to-b from-white to-white/60 uppercase">
            We Turn Storytelling <br/>
            <span className="text-primary">Into Revenue</span>
          </h1>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed">
            Earn from existing and new video — powered by AI-driven product placement.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 items-center justify-center">
            <button 
              onClick={handleLogin}
              className="px-8 py-4 rounded-xl bg-primary hover:bg-primary/90 text-white font-semibold text-lg shadow-lg shadow-primary/25 hover:shadow-primary/40 hover:-translate-y-1 transition-all duration-300 w-full sm:w-auto"
            >
              Start Monetizing Now
            </button>
            <button className="px-8 py-4 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white font-semibold text-lg backdrop-blur-sm transition-all duration-300 w-full sm:w-auto">
              View Demo
            </button>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="w-full max-w-4xl mt-16 py-8 border-t border-b border-white/5"
        >
          <p className="text-xs uppercase tracking-widest text-muted-foreground/50 mb-6 font-medium">Backed by Industry Leaders</p>
          <div className="flex flex-wrap items-center justify-center gap-8 md:gap-12">
            <img src={logoBlackAmbition} alt="Black Ambition" className="h-8 w-auto grayscale opacity-70 hover:grayscale-0 hover:opacity-100 transition-all duration-300" />
            <img src={logoMayDavis} alt="May Davis Partners" className="h-8 w-auto grayscale opacity-70 hover:grayscale-0 hover:opacity-100 transition-all duration-300" />
            <img src={logoElementa} alt="Elementa" className="h-8 w-auto grayscale opacity-70 hover:grayscale-0 hover:opacity-100 transition-all duration-300" />
            <img src={logoNue} alt="Nue Agency" className="h-8 w-auto grayscale opacity-70 hover:grayscale-0 hover:opacity-100 transition-all duration-300" />
          </div>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.4 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-16 w-full max-w-5xl"
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
            desc="Stop filming ads. We insert high-value products into your existing content library using post-production AI. You earn without lifting a camera." 
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.5 }}
          className="w-full max-w-5xl mt-24 mb-12"
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div className="text-left">
              <h2 className="text-3xl md:text-4xl font-bold font-display tracking-tight mb-6 uppercase">
                Protect the <span className="text-primary">Vibe.</span>
              </h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Your audience trusts you. We help you keep it that way. Our Contextual AI ensures every placement fits the sentiment, lighting, and narrative of your scene. No jarring ads, just seamless integration.
              </p>
            </div>
            <div className="relative">
              <div className="aspect-video rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                <div className="text-center p-8">
                  <ImageIcon className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
                  <p className="text-sm text-muted-foreground/50">Before/After Comparison</p>
                  <p className="text-xs text-muted-foreground/30 mt-1">Upload your image to replace</p>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </main>

      <motion.section
        id="cohort"
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.6 }}
        className="relative z-10 w-full py-20 bg-gradient-to-b from-transparent to-card/30"
      >
        <div className="container mx-auto px-6 text-center">
          <h2 className="text-3xl md:text-4xl font-bold font-display tracking-tight mb-4 uppercase">
            Join the <span className="text-primary">Founding Cohort.</span>
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-8 leading-relaxed">
            Not ready to automate everything? Join our exclusive group of partner creators shaping the future of the platform.
          </p>
          <button className="px-8 py-4 rounded-xl bg-transparent hover:bg-white/5 border-2 border-primary text-primary font-semibold text-lg transition-all duration-300" data-testid="button-apply-access">
            Apply for Access
          </button>
        </div>
      </motion.section>

      <Footer />
    </div>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode, title: string, desc: string }) {
  return (
    <div className="p-6 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors text-left">
      <div className="w-12 h-12 rounded-xl bg-background/50 flex items-center justify-center mb-4">
        {icon}
      </div>
      <h3 className="text-lg font-bold font-display mb-2">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{desc}</p>
    </div>
  );
}
