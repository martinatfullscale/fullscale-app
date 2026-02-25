import { useState, useRef } from "react";
import { motion } from "framer-motion";
import { Film, Play, Sparkles, Users, Zap, ArrowRight, Globe } from "lucide-react";
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

// Hero video path — Replit generates this file (fast-cut montage: podcasts, kitchen, music)
// Drop the mp4 into: client/src/assets/generated_videos/fullscale_creates_hero_loop.mp4
// Then uncomment the import below and remove the null fallback:
// import createsHeroVideo from "@assets/generated_videos/fullscale_creates_hero_loop.mp4";
const CREATES_HERO_VIDEO: string | null = "/attached_assets/fullscale_creates_hero_loop.mp4";

// Video showcase — real Vimeo content from vimeo.com/whtwrks
const VIDEO_SHOWCASE = [
  {
    title: "Deleon at the NAACP Image Awards",
    description: "Brand activation coverage at one of culture's biggest nights",
    thumbnail: "https://i.vimeocdn.com/video/2011839791-0e13911c3ea48cb8e48c0601f118107660c026e782eaa20dc6f33613e52a0cfd-d_640x360",
    tag: "Brand",
    vimeoId: "1081125562",
  },
  {
    title: "ANTA x Kyrie — The Journey is the Reward",
    description: "Sizzle reel for the ANTA x Kyrie Irving partnership",
    thumbnail: "https://i.vimeocdn.com/video/1751193427-8f6f48de3b0156f20b6dccd29ff7a844408ec7bf33eaa3be0d15ca4ccb696539-d_640x360",
    tag: "Sports",
    vimeoId: "882921661",
  },
  {
    title: "Chase United Ep. 2 — The Airport",
    description: "Branded content series for Chase United",
    thumbnail: "https://i.vimeocdn.com/video/1681997467-f1eff679e856e4d91be65c2d4d7e516451bc5feabaf592c606c24a46e09ccaab-d_640x360",
    tag: "Series",
    vimeoId: "834907261",
  },
  {
    title: "Nike Blueprint",
    description: "Campaign content for Nike's Blueprint initiative",
    thumbnail: "https://i.vimeocdn.com/video/1552867525-26f71cfc72e9e88e091b6199a38294163734a67b5c6ff7c0a741c4efd69183f8-d_640x360",
    tag: "Campaign",
    vimeoId: "773881582",
  },
  {
    title: "Machine Gun Kelly at the MTV VMAs × Doritos",
    description: "Sponsored activation with MGK at the VMAs",
    thumbnail: "https://i.vimeocdn.com/video/1241264300-8544249c591846901a6df3cf6b20c3dbc8120b79bc7431759973c0ad8f1773c1-d_640x360",
    tag: "Music",
    vimeoId: "604858629",
  },
  {
    title: "The Right Pitch on ROKU",
    description: "Original series streaming on ROKU",
    thumbnail: "https://i.vimeocdn.com/video/1992075312-2e02568673b7ad726568e07b6730887b5f8448f9852830ffe63d2661bff26427-d_640x360?region=us",
    tag: "Original",
    vimeoId: "1064709284",
  },
  {
    title: "Smirnoff x BET — Ambre",
    description: "Branded spot for Smirnoff in partnership with BET",
    thumbnail: "https://i.vimeocdn.com/video/1701620964-ede573fc419aa4d9f0f16ce249bd4194119e866f56361bcefd96e6ddbfc17037-d_640x360?region=us",
    tag: "Brand",
    vimeoId: "848085934",
  },
  {
    title: "Retool Your School — Home Depot × Rashan Ali",
    description: "Home Depot's Retool Your School initiative with Rashan Ali",
    thumbnail: "https://i.vimeocdn.com/video/863188183-5fa9e5bb245b887071a33639fc49252818eb2e070bc055f92508545906ed6078-d_640x360?region=us",
    tag: "Brand",
    vimeoId: "396427937",
  },
  {
    title: "LEGO",
    description: "Branded content for LEGO",
    thumbnail: "https://i.vimeocdn.com/video/1100956605-d026d6bdce68dd4a655c2500d5e74794f055858c5e1d2e04fb201e06c991ccec-d_640x360?region=us",
    tag: "Brand",
    vimeoId: "531983975",
  },
];

const CAPABILITIES = [
  {
    icon: Film,
    title: "Content Production",
    description: "From concept to final cut — full-service video production for digital creators",
  },
  {
    icon: Users,
    title: "Creator Partnerships",
    description: "Strategic partnerships that connect brands with authentic creator voices",
  },
  {
    icon: Sparkles,
    title: "AI-Enhanced Workflow",
    description: "Leveraging AI tools to accelerate production while preserving the human touch",
  },
  {
    icon: Zap,
    title: "Distribution & Reach",
    description: "Multi-platform content strategy to maximize audience engagement and impact",
  },
];

export default function FullScaleCreates() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const [activeVideo, setActiveVideo] = useState<typeof VIDEO_SHOWCASE[number] | null>(null);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <a href="/">
            <img src={logoUrl} alt="FullScale" className="h-7" />
          </a>
          <Badge variant="outline" className="text-xs font-medium">
            <Film className="w-3 h-3 mr-1" />
            Creates
          </Badge>
        </div>
      </header>

      {/* Hero Section — video background with gradient overlay */}
      <section className="relative min-h-[500px] md:min-h-[600px] overflow-hidden">
        {/* Video background (falls back to gradient if video not available) */}
        {CREATES_HERO_VIDEO && !videoFailed ? (
          <video
            ref={videoRef}
            src={CREATES_HERO_VIDEO}
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
              FullScale Creates
            </div>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-6 text-white">
              Content That Connects
            </h1>
            <p className="text-lg md:text-xl text-white/80 leading-relaxed max-w-2xl mx-auto mb-8">
              We build and curate content for audiences that demand something real. AI accelerates the craft — but the creator drives the story. That partnership is where the magic lands.
            </p>
            <div className="flex items-center justify-center gap-4">
              <Button size="lg" className="gap-2">
                Work With Us
                <ArrowRight className="w-4 h-4" />
              </Button>
              <Button size="lg" variant="outline" className="gap-2 border-white/30 text-white hover:bg-white/10" onClick={() => {
                document.getElementById("showcase")?.scrollIntoView({ behavior: "smooth" });
              }}>
                <Play className="w-4 h-4" />
                See Our Work
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
            <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-3">What We Do</h2>
            <p className="text-muted-foreground max-w-lg mx-auto">
              End-to-end content production for creators and brands who value authenticity
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
          <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-3">Our Work</h2>
          <p className="text-muted-foreground max-w-lg mx-auto">
            A showcase of content crafted at the intersection of creativity and technology
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {VIDEO_SHOWCASE.map((video, idx) => (
            <motion.div
              key={video.vimeoId}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: idx * 0.08, duration: 0.4 }}
            >
              <Card
                className="overflow-hidden group border-white/5 hover:border-primary/20 transition-all duration-300 cursor-pointer"
                onClick={() => video.vimeoId && setActiveVideo(video)}
              >
                <div className="relative aspect-video bg-muted overflow-hidden">
                  {video.thumbnail ? (
                    <img
                      src={video.thumbnail}
                      alt={video.title}
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
                  <Badge className="absolute top-3 right-3 text-xs" variant="secondary">
                    {video.tag}
                  </Badge>
                </div>
                <CardContent className="p-5">
                  <h3 className="font-semibold text-foreground mb-1">{video.title}</h3>
                  <p className="text-sm text-muted-foreground">{video.description}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        {/* Vimeo Playback Modal */}
        <Dialog open={!!activeVideo} onOpenChange={(open) => !open && setActiveVideo(null)}>
          <DialogContent className="max-w-4xl p-0 bg-black border-white/10 overflow-hidden">
            <DialogHeader className="p-4 pb-2">
              <DialogTitle className="text-white">
                {activeVideo?.title}
              </DialogTitle>
            </DialogHeader>
            <div className="aspect-video w-full">
              {activeVideo?.vimeoId && (
                <iframe
                  src={`https://player.vimeo.com/video/${activeVideo.vimeoId}?autoplay=1&title=0&byline=0&portrait=0`}
                  className="w-full h-full border-0"
                  allow="autoplay; fullscreen; picture-in-picture"
                  allowFullScreen
                  title={activeVideo.title}
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
              We believe in the power of real stories told by real people. FullScale Creates amplifies creativity using the human connection that makes content resonate.
            </p>
            <p className="text-muted-foreground text-sm uppercase tracking-widest">
              The FullScale Creates Philosophy
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
            Ready to Create Something Real?
          </h2>
          <p className="text-muted-foreground max-w-md mx-auto mb-8">
            Whether you're a creator looking to produce premium content or a brand seeking authentic partnerships.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <Button size="lg" className="gap-2">
              <Globe className="w-4 h-4" />
              Get in Touch
            </Button>
            <a href="/marketplace">
              <Button size="lg" variant="outline" className="gap-2">
                Explore Marketplace
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
