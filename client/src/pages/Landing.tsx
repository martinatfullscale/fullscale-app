import { motion } from "framer-motion";
import { Zap, Shield, Globe } from "lucide-react";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

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
        
        <button 
          onClick={handleLogin}
          className="px-5 py-2 rounded-lg font-medium text-sm border border-border bg-white/5 hover:bg-white/10 transition-colors"
        >
          Sign In
        </button>
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
            Democratizing the <br/>
            <span className="text-primary">Product Placement Economy</span>
          </h1>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed">
            The AI-powered marketplace that turns content libraries into recurring, measurable revenue. Connect your channel, index your inventory, and let brands bid on your empty pixels.
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
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-20 w-full max-w-5xl"
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
            icon={<Globe className="w-6 h-6 text-blue-400" />} 
            title="Passive Income" 
            desc="Stop fighting for views. Generate recurring revenue from your back-catalog without lifting a finger." 
          />
        </motion.div>
      </main>
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
