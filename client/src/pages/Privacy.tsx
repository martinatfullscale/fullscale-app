import { Link } from "wouter";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";

export default function Privacy() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="container mx-auto px-6 h-20 flex items-center justify-between border-b border-white/5">
        <Link href="/">
          <img src={logoUrl} alt="FullScale Creator Portal" className="h-10 w-auto" />
        </Link>
        <Link href="/" className="text-sm text-muted-foreground hover:text-white transition-colors inline-flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
      </nav>

      <main className="p-8 max-w-2xl mx-auto space-y-10">
        <div>
          <h1 className="text-3xl font-bold mb-4">Privacy Policy</h1>
          <p className="text-muted-foreground text-sm">Effective Date: January 1, 2025</p>
        </div>

        {/* ── General ── */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">1. General</h2>
          <p className="text-muted-foreground leading-relaxed">
            FullScale ("we", "us", "our") respects your privacy. This policy explains what
            information we collect, how we use it, and your rights regarding your data across
            all FullScale products including the Creator Portal and FullScale Studio.
          </p>
        </section>

        {/* ── Data We Collect ── */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">2. Information We Collect</h2>
          <p className="text-muted-foreground leading-relaxed">
            We collect only the minimum data necessary to provide our services:
          </p>
          <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-2">
            <li>
              <span className="text-foreground font-medium">Account information</span> — your
              email address and profile name via Google OAuth for authentication and access management.
            </li>
            <li>
              <span className="text-foreground font-medium">Usage data</span> — basic product usage
              metrics (e.g., video generation count) to manage quotas and improve our services.
            </li>
            <li>
              <span className="text-foreground font-medium">Payment information</span> — if you
              subscribe to a paid plan, payment details are processed securely by Stripe. We do not
              store credit card numbers or banking details on our servers.
            </li>
          </ul>
        </section>

        {/* ── Studio Data Handling ── */}
        <section id="studio-data" className="space-y-4 scroll-mt-24">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-6 h-6 text-green-400" />
            <h2 className="text-xl font-semibold">3. FullScale Studio — Document & Data Handling</h2>
          </div>

          <div className="p-5 rounded-xl bg-green-500/5 border border-green-500/10 space-y-4">
            <p className="text-foreground font-medium">
              We do not retain any documents you upload to FullScale Studio.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              When you upload a PDF or PPTX to Studio, our pipeline processes the document
              through the following steps: parsing, AI story extraction, visual generation,
              voice synthesis, and video assembly. Once processing is complete — whether
              successful or not — the original uploaded document and all intermediate working
              files are permanently deleted from our servers.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              Your uploaded materials are treated as proprietary and confidential. Specifically:
            </p>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-2">
              <li>
                <span className="text-foreground font-medium">No document retention</span> —
                uploaded decks are never stored beyond the time required for processing.
              </li>
              <li>
                <span className="text-foreground font-medium">No training on your data</span> —
                your documents are not used to train or fine-tune any AI models.
              </li>
              <li>
                <span className="text-foreground font-medium">Temporary processing only</span> —
                all intermediate files (extracted text, slide images, audio clips, scene data)
                are created in ephemeral storage and deleted after the final video is assembled.
              </li>
              <li>
                <span className="text-foreground font-medium">Generated videos</span> — your
                completed video files are available for download and are retained on our
                servers for a limited period to allow you to retrieve them. You may request
                deletion at any time.
              </li>
            </ul>
          </div>
        </section>

        {/* ── Third-Party Services ── */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">4. Third-Party Services</h2>
          <p className="text-muted-foreground leading-relaxed">
            Our Studio pipeline uses third-party AI services to process your content:
          </p>
          <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-2">
            <li>
              <span className="text-foreground font-medium">Anthropic (Claude)</span> — for
              extracting narrative structure from your document text. Text content is sent to
              Anthropic's API for processing and is subject to{" "}
              <a
                href="https://www.anthropic.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-400 hover:text-purple-300 underline underline-offset-2"
              >
                Anthropic's privacy policy
              </a>.
            </li>
            <li>
              <span className="text-foreground font-medium">ElevenLabs</span> — for voice
              narration synthesis. Narration text is sent to ElevenLabs' API and is subject to{" "}
              <a
                href="https://elevenlabs.io/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-400 hover:text-purple-300 underline underline-offset-2"
              >
                ElevenLabs' privacy policy
              </a>.
            </li>
            <li>
              <span className="text-foreground font-medium">fal.ai (Seedance)</span> — for
              AI-generated video visuals (paid tiers). Scene prompts are sent to fal.ai's API
              and are subject to{" "}
              <a
                href="https://fal.ai/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-400 hover:text-purple-300 underline underline-offset-2"
              >
                fal.ai's privacy policy
              </a>.
            </li>
            <li>
              <span className="text-foreground font-medium">Stripe</span> — for payment
              processing. Payment data is handled by Stripe and is subject to{" "}
              <a
                href="https://stripe.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-400 hover:text-purple-300 underline underline-offset-2"
              >
                Stripe's privacy policy
              </a>.
            </li>
          </ul>
        </section>

        {/* ── Data Sharing ── */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">5. Data Sharing</h2>
          <p className="text-muted-foreground leading-relaxed">
            We do not sell your personal data to third parties. We only share data with the
            third-party service providers listed above, and only to the extent necessary to
            deliver our services.
          </p>
        </section>

        {/* ── Your Rights ── */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">6. Your Rights</h2>
          <p className="text-muted-foreground leading-relaxed">
            You have the right to:
          </p>
          <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-2">
            <li>Request access to the personal data we hold about you</li>
            <li>Request deletion of your account and all associated data</li>
            <li>Request deletion of any generated videos stored on our servers</li>
            <li>Withdraw consent for data processing at any time</li>
          </ul>
          <p className="text-muted-foreground leading-relaxed">
            To exercise any of these rights, contact us at the address below.
          </p>
        </section>

        {/* ── Contact ── */}
        <section className="space-y-4 pb-12">
          <h2 className="text-xl font-semibold">7. Contact Us</h2>
          <p className="text-muted-foreground leading-relaxed">
            If you have questions about this privacy policy or wish to exercise your data
            rights, please contact us:
          </p>
          <p className="text-muted-foreground">
            <a
              href="mailto:fullscale_info@gofullscale.co"
              className="text-purple-400 hover:text-purple-300 underline underline-offset-2"
            >
              fullscale_info@gofullscale.co
            </a>
          </p>
        </section>
      </main>
    </div>
  );
}
