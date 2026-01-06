import { motion } from "framer-motion";
import { Link } from "wouter";
import { ArrowLeft, FileText, Scale, Users } from "lucide-react";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
import { Footer } from "@/components/Footer";

export default function Terms() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <nav className="container mx-auto px-6 h-20 flex items-center justify-between border-b border-white/5">
        <Link href="/">
          <img src={logoUrl} alt="FullScale" className="h-10 w-auto" />
        </Link>
        <Link href="/" className="text-sm text-muted-foreground hover:text-white transition-colors inline-flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
      </nav>

      <main className="flex-1 container mx-auto px-6 py-16 max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <h1 className="text-4xl md:text-5xl font-bold font-display tracking-tight mb-4">
            Terms of <span className="text-primary">Service</span>
          </h1>
          <p className="text-xl text-muted-foreground mb-12">
            Clear terms that protect both creators and the platform.
          </p>

          <div className="space-y-8">
            <div className="p-6 rounded-2xl bg-white/5 border border-white/5">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <FileText className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-bold font-display mb-2">Service Agreement</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    By using FullScale, you agree to allow our AI to analyze your content for product placement opportunities. You maintain full control over which placements are approved and published.
                  </p>
                </div>
              </div>
            </div>

            <div className="p-6 rounded-2xl bg-white/5 border border-white/5">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center shrink-0">
                  <Scale className="w-6 h-6 text-emerald-500" />
                </div>
                <div>
                  <h3 className="text-lg font-bold font-display mb-2">Revenue Sharing</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    Creators receive a competitive share of all revenue generated through product placements. Payment terms and schedules are clearly defined in your creator agreement.
                  </p>
                </div>
              </div>
            </div>

            <div className="p-6 rounded-2xl bg-white/5 border border-white/5">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0">
                  <Users className="w-6 h-6 text-blue-500" />
                </div>
                <div>
                  <h3 className="text-lg font-bold font-display mb-2">Community Standards</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    We maintain high standards for brand partnerships. All placements must align with your content's values and audience expectations. You have final approval on every placement.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-12 p-6 rounded-2xl bg-primary/5 border border-primary/20">
            <p className="text-sm text-muted-foreground leading-relaxed">
              <strong className="text-white">Need clarification?</strong> Our team is here to help you understand our terms. Reach out to legal@fullscale.com for any questions.
            </p>
          </div>
        </motion.div>
      </main>

      <Footer />
    </div>
  );
}
