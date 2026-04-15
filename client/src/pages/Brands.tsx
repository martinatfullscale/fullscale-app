import { motion } from "framer-motion";
import { Briefcase, ArrowLeft } from "lucide-react";

/**
 * Placeholder Brands landing page.
 *
 * This is intentionally minimal — it exists so the "For Brands" nav button on
 * the homepage has a valid destination instead of falling through to the
 * wouter catch-all (which would just re-render the Landing page).
 *
 * Replaced by the real brands landing page in the next phase of marketing
 * work, which includes:
 *   - Brand-focused hero video (DJ / podcast / gamer table placement examples)
 *   - "Heavy friction vs. FullScale path" comparison section
 *   - Capabilities list (stickers, products, on-screen overlays, etc.)
 *   - Test-and-learn pitch
 *   - Brand-specific signup CTA → multi-step brand onboarding brief
 */
export default function Brands() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="text-center max-w-2xl"
      >
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-400/10 border border-emerald-400/30 mb-6">
          <Briefcase className="w-8 h-8 text-emerald-300" />
        </div>

        <h1 className="text-4xl md:text-6xl font-bold font-display tracking-tight text-white uppercase mb-4">
          FullScale <span className="bg-gradient-to-r from-emerald-300 via-emerald-400 to-emerald-300 bg-clip-text text-transparent">For Brands</span>
        </h1>

        <p className="text-lg md:text-xl text-white/70 leading-relaxed mb-8">
          We're building a dedicated experience for brands ready to place product into culturally relevant content that's already performing.
        </p>

        <p className="text-sm md:text-base text-white/50 mb-10">
          Drop your product into DJ booths, podcast desks, gaming setups, and creator studios — without the friction of finding talent, negotiating rates, or chasing reshoots. Test creator-product associations before you commit. Launching shortly.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 items-center justify-center">
          <a
            href="/"
            className="px-6 py-3 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white font-semibold text-sm md:text-base backdrop-blur-md transition-all duration-300 flex items-center gap-2"
            data-testid="link-brands-home"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </a>
          <a
            href="mailto:hello@gofullscale.co?subject=Brand%20Interest%20%E2%80%94%20FullScale"
            className="px-6 py-3 rounded-xl bg-emerald-500/90 hover:bg-emerald-500 text-white font-semibold text-sm md:text-base shadow-2xl shadow-emerald-500/20 transition-all duration-300"
            data-testid="link-brands-contact"
          >
            Get in Touch
          </a>
        </div>
      </motion.div>
    </div>
  );
}
