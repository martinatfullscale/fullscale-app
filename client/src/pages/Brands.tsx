import { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Briefcase,
  ArrowRight,
  Mail,
  Play,
  Clock,
  DollarSign,
  Film,
  TrendingDown,
  Sparkles,
  Target,
  TrendingUp,
  Package,
  Tag,
  Monitor,
  Layers,
  FlaskConical,
  CheckCircle2,
  XCircle,
  Gauge,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Footer } from "@/components/Footer";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

import heroVideoUrl from "@assets/brands_hero_loop.mp4";
import heroVideoMobileUrl from "@assets/brands_hero_loop_mobile.mp4";

/**
 * FullScale For Brands landing page.
 *
 * Full-page brand-facing marketing site. Five beats:
 *   1. Hero — 4-scene video loop (podcast / DJ / gaming / kitchen) with
 *      hero copy and dual CTAs ("Sign Up Now" + "See How It Works")
 *   2. Friction comparison — traditional brand-talent path vs FullScale path,
 *      side-by-side cards
 *   3. Capabilities — four placement types (physical product / stickers /
 *      on-screen overlays / ambient branding)
 *   4. Test-and-learn — three-card row explaining pre-commit validation
 *      (match → A/B → measure-and-scale)
 *   5. Sign-up CTA — final push to the brand signup flow
 *
 * Hero video pattern mirrors FullScaleCreates.tsx exactly (Vite @assets
 * imports for desktop + mobile variants, ref callback for iOS autoplay,
 * videoFailed fallback, window.matchMedia breakpoint switching).
 */

const FRICTION_TRADITIONAL = [
  { icon: Clock, text: "Spend weeks sourcing and vetting creator talent" },
  { icon: DollarSign, text: "Negotiate rates, contracts, and exclusivity terms" },
  { icon: Film, text: "Fund production, travel, reshoots, revisions" },
  { icon: TrendingDown, text: "Launch one spot and hope the impressions land" },
];

const FRICTION_FULLSCALE = [
  { icon: Sparkles, text: "Pick content that already has proven engagement" },
  { icon: Target, text: "Our AI matches your product to contextually-relevant surfaces" },
  { icon: FlaskConical, text: "Test placements across multiple creators at once" },
  { icon: TrendingUp, text: "Scale only the variants that actually perform" },
];

const CAPABILITIES = [
  {
    icon: Package,
    title: "Physical Products",
    description:
      "Drop beverages, electronics, beauty, lifestyle, or food & bev onto a creator's desk, counter, or studio table with AI-perfect lighting and occlusion.",
  },
  {
    icon: Tag,
    title: "Branded Stickers & Decals",
    description:
      "Place your logo or campaign art on a DJ controller, laptop, helmet, or instrument case — wherever your brand fits the moment.",
  },
  {
    icon: Monitor,
    title: "On-Screen Overlays",
    description:
      "Replace a creator's monitor content with your app UI, game preview, or product demo. Perfectly tracked across every frame.",
  },
  {
    icon: Layers,
    title: "Ambient Branding",
    description:
      "Wall art, posters, neon signs, book spines — the subtle placements that build brand presence without breaking the creator's moment.",
  },
];

const TEST_AND_LEARN = [
  {
    icon: Target,
    title: "Match products to creators",
    description:
      "Run the same product across multiple creators' existing content libraries. See which audience engages most before you commit a dollar.",
  },
  {
    icon: FlaskConical,
    title: "A/B placement variants",
    description:
      "Same video, two surfaces, two product treatments. Find the variant that converts before you commit to a full flight.",
  },
  {
    icon: Gauge,
    title: "Measure and scale",
    description:
      "Engagement per second, view-through rate, click-through for purchase-linked placements. The signal you need to double down on what works.",
  },
];

export default function Brands() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Ref callback — sets muted BEFORE browser evaluates autoplay policy.
  // Same pattern as FullScaleCreates.tsx for iOS/Safari autoplay reliability.
  const videoRefCallback = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (!node) return;
    node.muted = true;
    node.setAttribute("muted", "");
    node.setAttribute("playsinline", "");
    node.setAttribute("webkit-playsinline", "");
    node.defaultMuted = true;
    node.play().catch(() => {});
  }, []);

  // Retry playback on first touch or when video data arrives
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tryPlay = () => {
      video.muted = true;
      video.play().catch(() => {});
    };
    video.addEventListener("loadeddata", tryPlay);
    window.addEventListener("touchstart", tryPlay, { once: true });
    return () => {
      video.removeEventListener("loadeddata", tryPlay);
    };
  }, []);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <a href="/" data-testid="link-brands-logo">
            <img src={logoUrl} alt="FullScale" className="h-7" />
          </a>
          <div className="flex items-center gap-3">
            <Badge
              variant="outline"
              className="text-xs font-medium border-emerald-400/40 text-emerald-300 bg-emerald-400/5"
            >
              <Briefcase className="w-3 h-3 mr-1" />
              For Brands
            </Badge>
            <a href="/auth?mode=signup&userType=brand" data-testid="link-brands-header-signup">
              <Button size="sm" className="gap-1.5 bg-emerald-500 hover:bg-emerald-500/90 text-white">
                Sign Up Now
                <ArrowRight className="w-3.5 h-3.5" />
              </Button>
            </a>
          </div>
        </div>
      </header>

      {/* Hero Section — video background with gradient overlay */}
      <section className="relative min-h-[520px] md:min-h-[640px] overflow-hidden">
        {heroVideoUrl && !videoFailed ? (
          <video
            ref={videoRefCallback}
            key={isMobile ? "mobile" : "desktop"}
            src={isMobile ? heroVideoMobileUrl : heroVideoUrl}
            preload="auto"
            autoPlay
            loop
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
            onError={() => setVideoFailed(true)}
            data-testid="video-brands-hero"
          />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/55 to-background" />
        <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/10 via-transparent to-black/30" />

        <div className="relative z-10 max-w-6xl mx-auto px-6 pt-24 pb-20">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7 }}
            className="text-center max-w-3xl mx-auto"
          >
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-400/10 border border-emerald-400/30 text-emerald-300 text-sm font-medium mb-6 backdrop-blur-sm">
              <Briefcase className="w-4 h-4" />
              FullScale For Brands
            </div>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-6 text-white">
              Your brand,{" "}
              <span className="bg-gradient-to-r from-emerald-300 via-emerald-400 to-emerald-300 bg-clip-text text-transparent">
                in content that's already performing.
              </span>
            </h1>
            <p className="text-lg md:text-xl text-white/80 leading-relaxed max-w-2xl mx-auto mb-8">
              Drop your product into podcast desks, DJ booths, gaming setups, and creator studios — without the heavy friction of finding talent, negotiating rates, or chasing reshoots. Test creator-product associations before you commit the big budget.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <a href="/auth?mode=signup&userType=brand" data-testid="link-brands-hero-signup">
                <Button
                  size="lg"
                  className="gap-2 bg-emerald-500 hover:bg-emerald-500/90 text-white shadow-2xl shadow-emerald-500/20"
                >
                  Sign Up Now
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </a>
              <Button
                size="lg"
                variant="outline"
                className="gap-2 border-white/30 text-white hover:bg-white/10"
                onClick={() => {
                  document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" });
                }}
                data-testid="button-brands-how-it-works"
              >
                <Play className="w-4 h-4" />
                See How It Works
              </Button>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Section 2 — Friction comparison */}
      <section id="how-it-works" className="max-w-6xl mx-auto px-6 py-20 scroll-mt-20">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12 max-w-3xl mx-auto"
        >
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4 tracking-tight">
            There are two ways to get your product in front of audiences.
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed">
            One way is expensive, slow, and hit-or-miss. The other is FullScale.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Traditional path card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1, duration: 0.5 }}
          >
            <Card className="h-full border-red-500/20 bg-red-950/10">
              <CardContent className="p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center justify-center">
                    <XCircle className="w-5 h-5 text-red-400" />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-widest text-red-400/80 font-semibold">
                      The Traditional Path
                    </div>
                    <div className="text-lg font-bold text-foreground">Heavy friction, hit-or-miss outcomes</div>
                  </div>
                </div>
                <ul className="space-y-4">
                  {FRICTION_TRADITIONAL.map((item) => {
                    const Icon = item.icon;
                    return (
                      <li key={item.text} className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-md bg-red-500/5 border border-red-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <Icon className="w-4 h-4 text-red-400/80" />
                        </div>
                        <p className="text-sm md:text-base text-foreground/90 leading-relaxed">{item.text}</p>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-8 pt-6 border-t border-red-500/10">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Average timeline: <span className="text-red-400/90 font-semibold">6–12 weeks</span>
                    <span className="mx-2 text-muted-foreground/50">·</span>
                    Average cost: <span className="text-red-400/90 font-semibold">$50K+</span>
                    <span className="mx-2 text-muted-foreground/50">·</span>
                    Outcome: <span className="text-red-400/90 font-semibold">hit or miss</span>
                  </p>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* FullScale path card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2, duration: 0.5 }}
          >
            <Card className="h-full border-emerald-400/30 bg-emerald-950/10 shadow-lg shadow-emerald-500/5">
              <CardContent className="p-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-lg bg-emerald-400/10 border border-emerald-400/40 flex items-center justify-center">
                    <CheckCircle2 className="w-5 h-5 text-emerald-300" />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-widest text-emerald-300 font-semibold">
                      With FullScale
                    </div>
                    <div className="text-lg font-bold text-foreground">Proven content, measurable outcomes</div>
                  </div>
                </div>
                <ul className="space-y-4">
                  {FRICTION_FULLSCALE.map((item) => {
                    const Icon = item.icon;
                    return (
                      <li key={item.text} className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-md bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <Icon className="w-4 h-4 text-emerald-300" />
                        </div>
                        <p className="text-sm md:text-base text-foreground/90 leading-relaxed">{item.text}</p>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-8 pt-6 border-t border-emerald-400/20">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Average timeline: <span className="text-emerald-300 font-semibold">48 hours</span>
                    <span className="mx-2 text-muted-foreground/50">·</span>
                    Average cost: <span className="text-emerald-300 font-semibold">a fraction</span>
                    <span className="mx-2 text-muted-foreground/50">·</span>
                    Outcome: <span className="text-emerald-300 font-semibold">measurable</span>
                  </p>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </section>

      {/* Section 3 — Capabilities */}
      <section className="border-y bg-card/30">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="text-center mb-12 max-w-3xl mx-auto"
          >
            <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4 tracking-tight">
              Stickers. Products. Screens. All of it.
            </h2>
            <p className="text-lg text-muted-foreground leading-relaxed">
              If it has a flat surface, a screen, or an empty frame — you can own the moment.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {CAPABILITIES.map((cap, idx) => {
              const Icon = cap.icon;
              return (
                <motion.div
                  key={cap.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: idx * 0.1, duration: 0.4 }}
                >
                  <Card className="h-full border-emerald-400/10 hover:border-emerald-400/30 transition-all duration-300">
                    <CardContent className="p-6">
                      <div className="w-12 h-12 rounded-xl bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center mb-4">
                        <Icon className="w-6 h-6 text-emerald-300" />
                      </div>
                      <h3 className="font-semibold text-foreground mb-2 text-base md:text-lg">{cap.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">{cap.description}</p>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Section 4 — Test-and-learn */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12 max-w-3xl mx-auto"
        >
          <Badge
            variant="outline"
            className="mb-5 text-xs font-medium border-emerald-400/40 text-emerald-300 bg-emerald-400/5"
          >
            <FlaskConical className="w-3 h-3 mr-1" />
            Test & Learn
          </Badge>
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4 tracking-tight">
            Test everything before you scale anything.
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed">
            Figure out what lands — and with whom — before you commit real budget.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {TEST_AND_LEARN.map((feature, idx) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: idx * 0.12, duration: 0.5 }}
              >
                <Card className="h-full border-emerald-400/10 hover:border-emerald-400/30 transition-all duration-300">
                  <CardContent className="p-7">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-lg bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center">
                        <Icon className="w-5 h-5 text-emerald-300" />
                      </div>
                      <div className="text-xs uppercase tracking-widest text-emerald-300/80 font-semibold">
                        Step {idx + 1}
                      </div>
                    </div>
                    <h3 className="font-semibold text-foreground mb-3 text-lg">{feature.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{feature.description}</p>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      </section>

      {/* Section 5 — Final sign-up CTA */}
      <section className="relative overflow-hidden">
        {/* Accent gradient backdrop */}
        <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/15 via-background to-emerald-400/5" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(16,185,129,0.12)_0%,_transparent_60%)]" />

        <div className="relative z-10 max-w-4xl mx-auto px-6 py-24 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-400/15 border border-emerald-400/40 mb-6">
              <Briefcase className="w-7 h-7 text-emerald-300" />
            </div>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground mb-5">
              Ready to put your brand in content that's{" "}
              <span className="bg-gradient-to-r from-emerald-300 via-emerald-400 to-emerald-300 bg-clip-text text-transparent">
                already winning?
              </span>
            </h2>
            <p className="text-lg md:text-xl text-muted-foreground leading-relaxed max-w-2xl mx-auto mb-10">
              Sign up and our team walks you through a brief tailored to your brand, budget, and audience. Pick a creator, test a placement, see the numbers — before you commit.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <a href="/auth?mode=signup&userType=brand" data-testid="link-brands-final-signup">
                <Button
                  size="lg"
                  className="gap-2 bg-emerald-500 hover:bg-emerald-500/90 text-white shadow-2xl shadow-emerald-500/25 px-8"
                >
                  Sign Up Now
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </a>
              <a
                href="mailto:hello@gofullscale.co?subject=Brand%20Interest%20%E2%80%94%20FullScale"
                data-testid="link-brands-final-talk"
              >
                <Button
                  size="lg"
                  variant="outline"
                  className="gap-2 border-emerald-400/40 text-emerald-300 hover:bg-emerald-400/10"
                >
                  <Mail className="w-4 h-4" />
                  Talk to Our Team
                </Button>
              </a>
            </div>
            <p className="text-xs text-muted-foreground/70 mt-8">
              No upfront commitment. Pick a creator, test a placement, see the numbers.
            </p>
          </motion.div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
