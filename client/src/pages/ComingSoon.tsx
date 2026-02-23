import { motion } from "framer-motion";
import { ArrowLeft, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

export default function ComingSoon() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="text-center max-w-md"
      >
        <img src={logoUrl} alt="FullScale" className="h-10 w-auto mx-auto mb-8" />
        <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
          <Sparkles className="w-8 h-8 text-primary" />
        </div>
        <h1 className="text-3xl font-bold font-display mb-3">Coming Soon</h1>
        <p className="text-muted-foreground mb-8 leading-relaxed">
          We're working on something exciting. Stay tuned for updates.
        </p>
        <Button variant="outline" onClick={() => window.history.back()} className="gap-2">
          <ArrowLeft className="w-4 h-4" />
          Go Back
        </Button>
      </motion.div>
    </div>
  );
}
