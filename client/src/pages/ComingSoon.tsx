import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { ArrowLeft, Sparkles, Film, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

const PAGE_CONFIG: Record<string, { title: string; subtitle: string; description: string; icon: typeof Sparkles }> = {
  "/content": {
    title: "FullScale Creates",
    subtitle: "Content & Production Studio",
    description: "A full-service content and production studio specializing in developing creator content. From concept to final cut, we create for the creators.",
    icon: Film,
  },
  "/about": {
    title: "About Us",
    subtitle: "Our Story",
    description: "We're a team of creators, technologists, and storytellers building the future of content monetization. Our full story is coming soon — stay tuned.",
    icon: Users,
  },
};

const DEFAULT_CONFIG = {
  title: "Coming Soon",
  subtitle: "",
  description: "We're working on something exciting. Stay tuned for updates.",
  icon: Sparkles,
};

export default function ComingSoon() {
  const [location] = useLocation();
  const config = PAGE_CONFIG[location] || DEFAULT_CONFIG;
  const Icon = config.icon;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="text-center max-w-lg"
      >
        <img src={logoUrl} alt="FullScale" className="h-10 w-auto mx-auto mb-8" />
        <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
          <Icon className="w-8 h-8 text-primary" />
        </div>
        <h1 className="text-3xl font-bold font-display mb-2">{config.title}</h1>
        {config.subtitle && (
          <p className="text-sm uppercase tracking-widest text-primary/80 font-medium mb-4">{config.subtitle}</p>
        )}
        <p className="text-muted-foreground mb-8 leading-relaxed">
          {config.description}
        </p>
        <Button variant="outline" onClick={() => window.history.back()} className="gap-2">
          <ArrowLeft className="w-4 h-4" />
          Go Back
        </Button>
      </motion.div>
    </div>
  );
}
