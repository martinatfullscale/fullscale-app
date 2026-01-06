import { motion } from "framer-motion";
import { Link } from "wouter";
import { ArrowLeft, Shield, Lock, Eye } from "lucide-react";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
import { Footer } from "@/components/Footer";

export default function Privacy() {
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
            Your Content, <span className="text-primary">Your Control.</span>
          </h1>
          <p className="text-xl text-muted-foreground mb-12">
            We believe in transparency and respect for creator ownership.
          </p>

          <div className="space-y-8">
            <div className="p-6 rounded-2xl bg-white/5 border border-white/5">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Shield className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="text-lg font-bold font-display mb-2">We Never Sell Your Raw Footage</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    Your original content remains yours. We do not sell, distribute, or share your raw footage with any third parties. Your creative assets are protected and only used to identify monetization opportunities.
                  </p>
                </div>
              </div>
            </div>

            <div className="p-6 rounded-2xl bg-white/5 border border-white/5">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center shrink-0">
                  <Lock className="w-6 h-6 text-emerald-500" />
                </div>
                <div>
                  <h3 className="text-lg font-bold font-display mb-2">You Retain 100% Ownership of Your IP</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    Full intellectual property rights remain with you at all times. FullScale operates as a service provider, not a content owner. You maintain complete control over your creative work.
                  </p>
                </div>
              </div>
            </div>

            <div className="p-6 rounded-2xl bg-white/5 border border-white/5">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0">
                  <Eye className="w-6 h-6 text-blue-500" />
                </div>
                <div>
                  <h3 className="text-lg font-bold font-display mb-2">AI Analysis for Placement Only</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    Our AI analyzes your content strictly for product placement opportunities. We identify scenes, context, and sentiment to match you with relevant brands while ensuring every placement fits naturally with your content.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-12 p-6 rounded-2xl bg-primary/5 border border-primary/20">
            <p className="text-sm text-muted-foreground leading-relaxed">
              <strong className="text-white">Questions about your data?</strong> We're committed to transparency. Contact us at privacy@fullscale.com for any inquiries about how we handle your content and personal information.
            </p>
          </div>
        </motion.div>
      </main>

      <Footer />
    </div>
  );
}
