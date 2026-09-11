import { useState, useRef, useEffect, useCallback } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useMemo } from "react";
import { useContent } from "@/content";
import { motion } from "framer-motion";
import { Film, Play, Sparkles, Users, Zap, ArrowRight, Globe } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

import heroVideoUrl from "@assets/fullscale_creates_hero_loop.mp4";
import heroVideoMobileUrl from "@assets/fullscale_creates_hero_loop_mobile.mp4";

import { useCreatesLibrary, formatDuration, type CreatesVideo } from "@/lib/createsLibrary";

const CAPABILITY_ICONS = [Film, Users, Sparkles, Zap];

export default function FullScaleCreates() {
  const c = useContent("creates");
  /* Same shapes the JSX already reads: icons and the real campaign titles stay
     here, the words come from the locale. */
  const CAPABILITIES = useMemo(
    () => c.capabilities.items.map((it, i) => ({ ...it, icon: CAPABILITY_ICONS[i] })),
    [c],
  );
  // The featured ten, from the portfolio manifest. Descriptions stay in the
  // locale files and zip by position; a piece past the end of that list simply
  // shows no description rather than falling back to English.
  const { featured, videos: allVideos, state: libraryState } = useCreatesLibrary();
  const SHOWCASE = useMemo(
    () => featured.map((v, i) => ({ ...v, description: c.showcase.descriptions[i] ?? "" })),
    [featured, c],
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const [activeVideo, setActiveVideo] = useState<CreatesVideo | null>(null);
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

  // Ref callback — sets muted BEFORE browser evaluates autoplay policy
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

  // Retry playback once data arrives or on first touch
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tryPlay = () => { video.muted = true; video.play().catch(() => {}); };
    video.addEventListener("loadeddata", tryPlay);
    video.addEventListener("canplay", tryPlay);
    if (video.readyState >= 2) tryPlay();
    const onTouch = () => tryPlay();
    document.addEventListener("touchstart", onTouch, { once: true });
    return () => {
      video.removeEventListener("loadeddata", tryPlay);
      video.removeEventListener("canplay", tryPlay);
      document.removeEventListener("touchstart", onTouch);
    };
  }, [videoFailed, isMobile]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <a href="/">
            <img src={logoUrl} alt="FullScale" className="h-7" />
          </a>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <Badge variant="outline" className="text-xs font-medium">
              <Film className="w-3 h-3 mr-1" />
              Creates
            </Badge>
          </div>
        </div>
      </header>

      {/* Hero Section — video background with gradient overlay */}
      <section className="relative min-h-[500px] md:min-h-[600px] overflow-hidden">
        {/* Video background (falls back to gradient if video not available) */}
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
            data-testid="video-creates-hero"
          />
        ) : null}
        {/* Dark gradient overlay — always present for text readability */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/50 to-background" />
        {/* Subtle accent gradients */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary/8 via-transparent to-purple-500/5" />

        <div className="relative z-10 max-w-6xl mx-auto px-6 pt-24 pb-20">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7 }}
            className="text-center max-w-3xl mx-auto"
          >
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/10 border border-white/20 text-white text-sm font-medium mb-6 backdrop-blur-sm">
              <Film className="w-4 h-4" />
              {c.badge}
            </div>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-6 text-white">
              {c.hero.title}
            </h1>
            <p className="text-lg md:text-xl text-white/80 leading-relaxed max-w-2xl mx-auto mb-8">
              {c.hero.deck}
            </p>
            <div className="flex items-center justify-center gap-4">
              <a href="mailto:martin@gofullscale.ai">
                <Button size="lg" className="gap-2">
                  {c.hero.ctaPrimary}
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </a>
              <Button size="lg" variant="outline" className="gap-2 border-white/30 text-white hover:bg-white/10" onClick={() => {
                document.getElementById("showcase")?.scrollIntoView({ behavior: "smooth" });
              }}>
                <Play className="w-4 h-4" />
                {c.hero.ctaSecondary}
              </Button>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Capabilities Section */}
      <section className="border-y bg-card/30">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="text-center mb-12"
          >
            <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-3">{c.capabilities.title}</h2>
            <p className="text-muted-foreground max-w-lg mx-auto">
              {c.capabilities.deck}
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
                  <Card className="h-full border-white/5 hover:border-primary/20 transition-all duration-300">
                    <CardContent className="p-6">
                      <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                        <Icon className="w-6 h-6 text-primary" />
                      </div>
                      <h3 className="font-semibold text-foreground mb-2">{cap.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">{cap.description}</p>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Video Showcase Section */}
      <section className="max-w-6xl mx-auto px-6 py-16" id="showcase">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12"
        >
          <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-3">{c.showcase.title}</h2>
          <p className="text-muted-foreground max-w-lg mx-auto">
            {c.showcase.deck}
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {SHOWCASE.map((video, idx) => (
            <motion.div
              key={video.slug}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: idx * 0.08, duration: 0.4 }}
            >
              <Card
                className="overflow-hidden group border-white/5 hover:border-primary/20 transition-all duration-300 cursor-pointer"
                onClick={() => setActiveVideo(video)}
              >
                <div className="relative aspect-video bg-muted overflow-hidden">
                  {video.posterUrl ? (
                    <img
                      src={video.posterUrl}
                      alt={video.title}
                      loading="lazy"
                      // A poster whose bytes have not landed yet must cost this
                      // card its image, not leave a broken-image glyph.
                      onError={(e) => { e.currentTarget.style.display = "none"; }}
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                    />
                  ) : (
                    <div className="w-full h-full bg-gradient-to-br from-zinc-800 to-zinc-900 flex items-center justify-center">
                      <Film className="w-10 h-10 text-zinc-600" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="w-14 h-14 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                      <Play className="w-6 h-6 text-white ml-0.5" />
                    </div>
                  </div>
                  {video.brand && (
                    <Badge className="absolute top-3 right-3 text-xs" variant="secondary">
                      {video.brand}
                    </Badge>
                  )}
                  {video.durationSec ? (
                    <span className="absolute bottom-3 right-3 px-1.5 py-0.5 rounded bg-black/70 text-white text-[11px] font-mono">
                      {formatDuration(video.durationSec)}
                    </span>
                  ) : null}
                </div>
                <CardContent className="p-5">
                  <h3 className="font-semibold text-foreground mb-1">{video.title}</h3>
                  <p className="text-sm text-muted-foreground">{video.description}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        {/* The rest of the catalogue. A route rather than an inline expander:
            150-odd pieces is a page, and a page is something you can send to a
            brand. Hidden until the manifest actually resolves, so a failed
            fetch does not advertise work that will not load. */}
        {libraryState === "ready" && allVideos.length > SHOWCASE.length && (
          <div className="mt-12 text-center">
            <Link href="/creates/work">
              <Button variant="outline" size="lg" className="gap-2" data-testid="link-see-more-work">
                See all {allVideos.length} pieces
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        )}

        {/* Playback. Self-hosted mp4 from Object Storage — the file is encoded
            with +faststart so it begins playing before it finishes
            downloading. */}
        <Dialog open={!!activeVideo} onOpenChange={(open) => !open && setActiveVideo(null)}>
          <DialogContent className="max-w-4xl p-0 bg-black border-white/10 overflow-hidden">
            <DialogHeader className="p-4 pb-2">
              <DialogTitle className="text-white">
                {activeVideo?.title}
              </DialogTitle>
            </DialogHeader>
            <div className="aspect-video w-full bg-black">
              {activeVideo && (
                <video
                  key={activeVideo.slug}
                  src={activeVideo.videoUrl}
                  poster={activeVideo.posterUrl}
                  controls
                  autoPlay
                  playsInline
                  className="w-full h-full"
                />
              )}
            </div>
          </DialogContent>
        </Dialog>
      </section>

      {/* Thesis / Philosophy Section */}
      <section className="border-y bg-gradient-to-r from-primary/5 via-transparent to-purple-500/5">
        <div className="max-w-4xl mx-auto px-6 py-16 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <div className="text-5xl mb-6 opacity-20">"</div>
            <p className="text-xl md:text-2xl text-foreground leading-relaxed font-medium mb-6">
              {c.philosophy.body}
            </p>
            <p className="text-muted-foreground text-sm uppercase tracking-widest">
              {c.philosophy.title}
            </p>
          </motion.div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center"
        >
          <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-4">
            {c.cta.title}
          </h2>
          <p className="text-muted-foreground max-w-md mx-auto mb-8">
            {c.cta.deck}
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <a href="mailto:fullscale_info@gofullscale.co">
              <Button size="lg" className="gap-2">
                <Globe className="w-4 h-4" />
                {c.cta.ctaPrimary}
              </Button>
            </a>
            <a href="/marketplace">
              <Button size="lg" variant="outline" className="gap-2">
                {c.cta.ctaSecondary}
                <ArrowRight className="w-4 h-4" />
              </Button>
            </a>
          </div>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="border-t py-8">
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Powered by{" "}
            <a href="/" className="text-primary font-medium hover:underline">
              FullScale
            </a>
          </p>
          <img src={logoUrl} alt="FullScale" className="h-5 opacity-40" />
        </div>
      </footer>
    </div>
  );
}
