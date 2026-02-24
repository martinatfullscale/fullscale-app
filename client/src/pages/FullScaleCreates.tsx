import { motion } from "framer-motion";
import { Film, Play, Sparkles, Users, Zap, ArrowRight, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

// Placeholder video showcase — will be replaced with real links from the user
const VIDEO_SHOWCASE = [
  {
    title: "Premium Content Production",
    description: "Full-service video production for creators who want to level up",
    thumbnail: "https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?w=640&h=360&fit=crop",
    tag: "Production",
  },
  {
    title: "Brand Integration Stories",
    description: "Authentic brand narratives woven into creator content",
    thumbnail: "https://images.unsplash.com/photo-1536240478700-b869070f9279?w=640&h=360&fit=crop",
    tag: "Brand",
  },
  {
    title: "Podcast & Studio",
    description: "Professional studio content with cinematic quality",
    thumbnail: "https://images.unsplash.com/photo-1478737270239-2f02b77fc618?w=640&h=360&fit=crop",
    tag: "Podcast",
  },
  {
    title: "Cultural Storytelling",
    description: "Content that resonates with audiences seeking authenticity",
    thumbnail: "https://images.unsplash.com/photo-1505373877841-8d25f7d46678?w=640&h=360&fit=crop",
    tag: "Culture",
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
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-md sticky top-0 z-20">
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

      {/* Hero Section */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/8 via-transparent to-purple-500/5" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/5 to-transparent" />
        <div className="relative max-w-6xl mx-auto px-6 pt-20 pb-16">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7 }}
            className="text-center max-w-3xl mx-auto"
          >
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-sm font-medium mb-6">
              <Film className="w-4 h-4" />
              FullScale Creates
            </div>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-6 bg-gradient-to-r from-white via-white to-white/60 bg-clip-text text-transparent">
              Content That Connects
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground leading-relaxed max-w-2xl mx-auto mb-4">
              FullScale Creates focuses on building and curating content meant to connect to an audience screaming for things that are real.
            </p>
            <p className="text-base text-muted-foreground/80 leading-relaxed max-w-xl mx-auto mb-8">
              There is the utility of AI — which is great — but there needs to be a nice balance there between AI and Human.
            </p>
            <div className="flex items-center justify-center gap-4">
              <Button size="lg" className="gap-2">
                Work With Us
                <ArrowRight className="w-4 h-4" />
              </Button>
              <Button size="lg" variant="outline" className="gap-2" onClick={() => {
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {VIDEO_SHOWCASE.map((video, idx) => (
            <motion.div
              key={video.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: idx * 0.1, duration: 0.4 }}
            >
              <Card className="overflow-hidden group border-white/5 hover:border-primary/20 transition-all duration-300 cursor-pointer">
                <div className="relative aspect-video bg-muted overflow-hidden">
                  <img
                    src={video.thumbnail}
                    alt={video.title}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
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
              We believe in the power of real stories told by real people. AI is a tool that amplifies creativity — it doesn't replace the human connection that makes content resonate.
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
