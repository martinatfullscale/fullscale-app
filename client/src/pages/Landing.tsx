import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, Shield, Video, ImageIcon, X } from "lucide-react";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
import logoBlackAmbition from "@assets/logo-black-ambition_1767712118620.png";
import logoMayDavis from "@assets/logo-may-davis_1767712118621.png";
import logoElementa from "@assets/logo-elementa_1767712118620.png";
import logoNue from "@assets/logo-nue_1767712118621.png";
import featureKitchen from "@assets/feature-kitchen_1767713076335.png";
import { Footer } from "@/components/Footer";

export default function Landing() {
  const [showBetaModal, setShowBetaModal] = useState(false);
  const [showDemoModal, setShowDemoModal] = useState(false);

  const handleLoginClick = () => {
    setShowBetaModal(true);
  };

  const handleActualLogin = () => {
    window.location.href = "/api/auth/youtube";
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
            href="https://airtable.com/appF4oLhgbf143xe7/pagil3dstNSBZvLUr/form"
            target="_blank"
            rel="noopener noreferrer"
            className="px-5 py-2 rounded-lg font-medium text-sm border border-primary text-primary bg-transparent hover:bg-primary/10 transition-colors"
            data-testid="button-nav-apply"
          >
            Apply for Access
          </a>
          <button 
            onClick={handleLoginClick}
            className="px-5 py-2 rounded-lg font-medium text-sm border border-border bg-white/5 hover:bg-white/10 transition-colors"
            data-testid="button-nav-signin"
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
              onClick={handleLoginClick}
              className="px-8 py-4 rounded-xl bg-primary hover:bg-primary/90 text-white font-semibold text-lg shadow-lg shadow-primary/25 hover:shadow-primary/40 hover:-translate-y-1 transition-all duration-300 w-full sm:w-auto"
              data-testid="button-hero-start"
            >
              Start Monetizing Now
            </button>
            <button 
              onClick={() => setShowDemoModal(true)}
              className="px-8 py-4 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white font-semibold text-lg backdrop-blur-sm transition-all duration-300 w-full sm:w-auto"
              data-testid="button-view-demo"
            >
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
          <div className="flex flex-row flex-wrap md:flex-nowrap items-center justify-center gap-12">
            <img src={logoBlackAmbition} alt="Black Ambition" className="h-10 w-auto" />
            <img src={logoMayDavis} alt="May Davis Partners" className="h-16 w-auto" />
            <img src={logoElementa} alt="Elementa" className="h-16 w-auto" />
            <img src={logoNue} alt="Nue Agency" className="h-10 w-auto" />
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
          transition={{ duration: 0.8, delay: 0.45 }}
          className="w-full max-w-5xl mt-24"
        >
          <h2 className="text-3xl md:text-4xl font-bold font-display tracking-tight mb-12 uppercase text-center">
            A Simple Path <span className="text-primary">Forward.</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="text-center p-6">
              <span className="text-5xl font-bold text-red-500 font-display">01</span>
              <h3 className="text-xl font-bold font-display mt-4 mb-3">Connect.</h3>
              <p className="text-muted-foreground leading-relaxed">
                Link your YouTube channel securely. We index your library in minutes, not weeks.
              </p>
            </div>
            <div className="text-center p-6">
              <span className="text-5xl font-bold text-red-500 font-display">02</span>
              <h3 className="text-xl font-bold font-display mt-4 mb-3">Align.</h3>
              <p className="text-muted-foreground leading-relaxed">
                Our AI identifies brand-safe opportunities that match your specific aesthetic.
              </p>
            </div>
            <div className="text-center p-6">
              <span className="text-5xl font-bold text-red-500 font-display">03</span>
              <h3 className="text-xl font-bold font-display mt-4 mb-3">Earn.</h3>
              <p className="text-muted-foreground leading-relaxed">
                Approve placements and generate recurring revenue from your back-catalog.
              </p>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.48 }}
          className="w-full max-w-3xl mt-24 text-center"
        >
          <blockquote className="text-2xl md:text-3xl italic font-serif text-white/90 leading-relaxed">
            "FullScale helped us unlock value from content we'd forgotten about. It feels like discovering a whole new revenue stream without changing how we create."
          </blockquote>
          <p className="mt-6 text-muted-foreground font-medium">— Early Creator Partner</p>
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
              <div className="aspect-video rounded-2xl overflow-hidden">
                <div className="relative w-full h-full">
                  <img 
                    src={featureKitchen} 
                    alt="Creator filming in kitchen" 
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-l from-transparent via-transparent to-background/40" />
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
          <a 
            href="https://airtable.com/appF4oLhgbf143xe7/pagil3dstNSBZvLUr/form"
            target="_blank"
            rel="noopener noreferrer"
            className="px-8 py-4 rounded-xl bg-transparent hover:bg-white/5 border-2 border-primary text-primary font-semibold text-lg transition-all duration-300 inline-block"
            data-testid="button-apply-access"
          >
            Apply for Access
          </a>
        </div>
      </motion.section>

      <Footer />

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
                onClick={() => setShowBetaModal(false)}
                className="absolute top-4 right-4 text-muted-foreground hover:text-white transition-colors"
                data-testid="button-modal-close"
              >
                <X className="w-5 h-5" />
              </button>

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
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showDemoModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md p-4 overflow-y-auto"
            onClick={() => setShowDemoModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="relative w-full max-w-5xl my-8"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setShowDemoModal(false)}
                className="absolute -top-10 right-0 text-white/60 hover:text-white transition-colors z-10"
                data-testid="button-demo-close"
              >
                <X className="w-8 h-8" />
              </button>

              <div className="relative rounded-2xl border border-white/10 bg-black/60 backdrop-blur-xl p-6 md:p-8 shadow-2xl">
                <div className="absolute top-4 right-4 px-3 py-1 rounded-full bg-primary/20 border border-primary/40 text-primary text-xs font-bold uppercase tracking-wider">
                  Simulation Mode
                </div>

                <p className="text-sm uppercase tracking-widest text-muted-foreground mb-6 font-medium">
                  The Command Center
                </p>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                  <div className="bg-white/5 rounded-xl p-4 border border-white/5">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Revenue</p>
                    <p className="text-2xl md:text-3xl font-bold text-emerald-400">$14,850</p>
                    <p className="text-xs text-emerald-400/80 mt-1">+18% this month</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4 border border-white/5">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Active Bids</p>
                    <p className="text-2xl md:text-3xl font-bold text-white">12</p>
                    <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400 text-xs font-medium">Hot</span>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4 border border-white/5">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Avg. CPM</p>
                    <p className="text-2xl md:text-3xl font-bold text-white">$35.00</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">Industry avg: $22</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4 border border-white/5">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Inventory Index</p>
                    <p className="text-2xl md:text-3xl font-bold text-white">98%</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">Scanned</p>
                  </div>
                </div>

                <div className="bg-white/5 rounded-xl p-6 border border-white/5 mb-8">
                  <p className="text-sm font-semibold text-white mb-4">Revenue Velocity</p>
                  <div className="flex items-end justify-between gap-2 h-32 md:h-40">
                    <div className="flex-1 flex flex-col items-center gap-1">
                      <div className="w-full bg-gradient-to-t from-primary/60 to-primary rounded-t-sm" style={{ height: '25%' }}></div>
                      <span className="text-xs text-muted-foreground">Jul</span>
                    </div>
                    <div className="flex-1 flex flex-col items-center gap-1">
                      <div className="w-full bg-gradient-to-t from-primary/60 to-primary rounded-t-sm" style={{ height: '40%' }}></div>
                      <span className="text-xs text-muted-foreground">Aug</span>
                    </div>
                    <div className="flex-1 flex flex-col items-center gap-1">
                      <div className="w-full bg-gradient-to-t from-primary/60 to-primary rounded-t-sm" style={{ height: '35%' }}></div>
                      <span className="text-xs text-muted-foreground">Sep</span>
                    </div>
                    <div className="flex-1 flex flex-col items-center gap-1">
                      <div className="w-full bg-gradient-to-t from-primary/60 to-primary rounded-t-sm" style={{ height: '55%' }}></div>
                      <span className="text-xs text-muted-foreground">Oct</span>
                    </div>
                    <div className="flex-1 flex flex-col items-center gap-1">
                      <div className="w-full bg-gradient-to-t from-primary/60 to-primary rounded-t-sm" style={{ height: '70%' }}></div>
                      <span className="text-xs text-muted-foreground">Nov</span>
                    </div>
                    <div className="flex-1 flex flex-col items-center gap-1">
                      <div className="w-full bg-gradient-to-t from-primary/60 to-primary rounded-t-sm" style={{ height: '90%' }}></div>
                      <span className="text-xs text-muted-foreground">Dec</span>
                    </div>
                  </div>
                </div>

                <div className="bg-white/5 rounded-xl border border-white/5 overflow-hidden">
                  <div className="px-6 py-4 border-b border-white/5">
                    <p className="text-sm font-semibold text-white">Active Brand Campaigns</p>
                  </div>
                  <div className="divide-y divide-white/5">
                    <div className="px-6 py-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="font-semibold text-white">Sony</span>
                        <span className="text-muted-foreground text-sm">Vlog #42</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-medium">Active</span>
                        <span className="font-semibold text-white">$2,400</span>
                      </div>
                    </div>
                    <div className="px-6 py-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="font-semibold text-white">Nike</span>
                        <span className="text-muted-foreground text-sm">Training Montage</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400 text-xs font-medium">Bidding</span>
                        <span className="font-semibold text-white">$850</span>
                      </div>
                    </div>
                    <div className="px-6 py-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="font-semibold text-white">Squarespace</span>
                        <span className="text-muted-foreground text-sm">Tech Review</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 text-xs font-medium">Paid</span>
                        <span className="font-semibold text-white">$1,200</span>
                      </div>
                    </div>
                    <div className="px-6 py-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="font-semibold text-white">Coca-Cola</span>
                        <span className="text-muted-foreground text-sm">Summer Vlog</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 text-xs font-medium">Pending</span>
                        <span className="font-semibold text-white">$3,100</span>
                      </div>
                    </div>
                  </div>
                </div>

                <p className="mt-6 text-center text-muted-foreground text-sm leading-relaxed">
                  Track inventory, approve placements, and watch revenue grow in real-time.
                </p>
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
    <div className="p-6 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors text-left">
      <div className="w-12 h-12 rounded-xl bg-background/50 flex items-center justify-center mb-4">
        {icon}
      </div>
      <h3 className="text-lg font-bold font-display mb-2">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{desc}</p>
    </div>
  );
}
