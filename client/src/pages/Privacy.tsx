import { Link } from "wouter";
import { ArrowLeft, ShieldCheck, Lock } from "lucide-react";
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
          <p className="text-muted-foreground text-sm">Effective Date: June 4, 2026</p>
        </div>

        {/* ── General ── */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">1. General</h2>
          <p className="text-muted-foreground leading-relaxed">
            FullScale ("we", "us", "our") respects your privacy. This policy explains what
            information we collect, how we use it, how we protect it, and your rights regarding
            your data across all FullScale products including the Creator Portal and FullScale Studio.
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
              email address and profile name via Google OAuth (or email/password registration)
              for authentication and access management.
            </li>
            <li>
              <span className="text-foreground font-medium">Connected platform data</span> —
              when you choose to connect external accounts (e.g. YouTube via Google, Instagram,
              Facebook), we receive the metadata and content you authorize us to access. See
              Section 4 for specifics about Google user data.
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

        {/* ── How We Protect Your Data ── */}
        <section className="space-y-4 scroll-mt-24">
          <div className="flex items-center gap-3">
            <Lock className="w-6 h-6 text-emerald-400" />
            <h2 className="text-xl font-semibold">3. How We Protect Your Data</h2>
          </div>
          <p className="text-muted-foreground leading-relaxed">
            We employ industry-standard security procedures to protect the confidentiality,
            integrity, and availability of your data. Security procedures are in place to protect
            against unauthorized access, alteration, disclosure, or destruction of your information.
          </p>
          <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-2">
            <li>
              <span className="text-foreground font-medium">Encryption in transit</span> — all
              communication between your browser and our servers is encrypted using TLS (HTTPS).
              All API calls we make to third-party services (Google, YouTube, AI providers, etc.)
              are likewise encrypted in transit.
            </li>
            <li>
              <span className="text-foreground font-medium">Encryption at rest</span> — sensitive
              data including OAuth access tokens, refresh tokens, and connected-platform
              credentials are encrypted before being written to our databases and decrypted only
              at the moment they're needed for an authorized API call.
            </li>
            <li>
              <span className="text-foreground font-medium">Password hashing</span> — when you
              register with an email and password, your password is hashed using bcrypt before
              storage. We never store plaintext passwords and we cannot recover your password if
              you lose it (we can only reset it).
            </li>
            <li>
              <span className="text-foreground font-medium">Access controls</span> — internal
              access to user data is limited to authorized personnel on a need-to-know basis and
              gated by administrative authentication. Sensitive admin actions are logged.
            </li>
            <li>
              <span className="text-foreground font-medium">Hosted infrastructure</span> — our
              services run on managed cloud infrastructure (Google Cloud / Replit Deployments)
              that itself maintains industry-standard physical and network security controls.
            </li>
            <li>
              <span className="text-foreground font-medium">Regular review</span> — we periodically
              review our security practices and dependencies and update them as needed.
            </li>
          </ul>
          <p className="text-muted-foreground leading-relaxed text-sm italic">
            No method of transmission or storage is 100% secure, but we work to maintain a high
            standard of protection commensurate with the sensitivity of the data involved.
          </p>
        </section>

        {/* ── Google User Data ── */}
        <section id="google-user-data" className="space-y-4 scroll-mt-24">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
            <h2 className="text-xl font-semibold">4. Google User Data &amp; YouTube API Services</h2>
          </div>

          <div className="p-5 rounded-xl bg-emerald-500/5 border border-emerald-500/15 space-y-4">
            <p className="text-muted-foreground leading-relaxed">
              When you sign in with Google or connect a YouTube channel to FullScale, we access
              limited information from your Google Account using the following scopes:
            </p>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-2">
              <li>
                <span className="text-foreground font-medium">openid, email, profile</span> —
                your Google email address and display name for authentication.
              </li>
              <li>
                <span className="text-foreground font-medium">youtube.readonly</span> — read-only
                access to your YouTube channel metadata, video listings, thumbnails, and basic
                statistics, so that FullScale can list and import the videos you choose for
                AI-powered scene analysis.
              </li>
            </ul>

            <p className="text-foreground font-medium mt-2">How we use Google user data</p>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-2">
              <li>To authenticate you and associate activity with your Google Account.</li>
              <li>To list and import the YouTube videos you select.</li>
              <li>
                To temporarily download video files for AI scene analysis. Frames are extracted
                and stored as part of your private library; the source video file is permanently
                deleted from our servers after processing.
              </li>
              <li>
                To display your YouTube channel and video metadata within your FullScale library
                so you can manage placement opportunities.
              </li>
            </ul>

            <p className="text-foreground font-medium mt-2">How we protect Google user data</p>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-2">
              <li>
                Google OAuth access tokens and refresh tokens are <strong>encrypted at rest</strong>
                {" "}before storage and decrypted only when required for an authorized API call.
              </li>
              <li>
                All requests to Google APIs are made over <strong>TLS-encrypted connections</strong>.
              </li>
              <li>
                We do not retain original YouTube video files. Files downloaded for analysis are
                deleted immediately after the AI scene-analysis pipeline finishes.
              </li>
              <li>
                Access to Google user data within FullScale is limited to the systems that need
                it to deliver the features you've activated.
              </li>
            </ul>

            <p className="text-foreground font-medium mt-2">What we do not do</p>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-2">
              <li>
                We do not sell or transfer Google user data to third parties except as necessary
                to provide or improve the user-facing features you've activated, for security
                purposes, or to comply with applicable law.
              </li>
              <li>
                We do not use Google user data to serve advertising, including personalized,
                retargeted, or interest-based advertising.
              </li>
              <li>
                We do not use Google user data to develop, improve, or train generalized or
                general-purpose AI/ML models. Where AI vendors (listed in Section 6) process
                Google user data on our behalf, they do so under contractual restrictions
                consistent with this policy.
              </li>
              <li>
                We do not allow humans to read your Google user data, except: (i) with your
                affirmative agreement for specific data points, (ii) where necessary for
                security purposes such as investigating abuse, (iii) to comply with applicable
                law, or (iv) where the data has been aggregated and anonymized.
              </li>
            </ul>

            <p className="text-muted-foreground leading-relaxed mt-2">
              FullScale's use and transfer to any other app of information received from Google
              APIs will adhere to the{" "}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>

            <p className="text-muted-foreground leading-relaxed">
              You can revoke FullScale's access to your Google Account at any time via your{" "}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2"
              >
                Google Account permissions page
              </a>
              . Use of YouTube data through FullScale is also subject to the{" "}
              <a
                href="https://www.youtube.com/t/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2"
              >
                YouTube Terms of Service
              </a>{" "}
              and the{" "}
              <a
                href="https://policies.google.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2"
              >
                Google Privacy Policy
              </a>
              .
            </p>
          </div>
        </section>

        {/* ── Studio Data Handling ── */}
        <section id="studio-data" className="space-y-4 scroll-mt-24">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-6 h-6 text-green-400" />
            <h2 className="text-xl font-semibold">5. FullScale Studio — Document &amp; Data Handling</h2>
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
          <h2 className="text-xl font-semibold">6. Third-Party Services</h2>
          <p className="text-muted-foreground leading-relaxed">
            FullScale uses the following third-party services to authenticate users, process
            content, and run our AI pipelines. Each provider receives only the data necessary
            to perform its function and is contractually bound by its own privacy commitments.
          </p>
          <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-2">
            <li>
              <span className="text-foreground font-medium">Google (Sign-In &amp; YouTube Data API)</span>{" "}
              — for authentication and to access the YouTube data described in Section 4.
              Subject to the{" "}
              <a
                href="https://policies.google.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-400 hover:text-purple-300 underline underline-offset-2"
              >
                Google Privacy Policy
              </a>
              .
            </li>
            <li>
              <span className="text-foreground font-medium">Anthropic (Claude)</span> — for
              extracting narrative structure from document text and for harmonization-related
              analysis. Content sent to Anthropic is subject to{" "}
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
              <span className="text-foreground font-medium">Google Gemini</span> — for AI scene
              analysis on individual video frames (no audio is transmitted). Subject to the{" "}
              <a
                href="https://policies.google.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-400 hover:text-purple-300 underline underline-offset-2"
              >
                Google Privacy Policy
              </a>
              .
            </li>
            <li>
              <span className="text-foreground font-medium">ElevenLabs</span> — for voice
              narration synthesis in FullScale Studio. Narration text is sent to ElevenLabs and
              is subject to{" "}
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
              <span className="text-foreground font-medium">fal.ai</span> — for image-to-3D,
              relighting, and other AI compositing operations used by the harmonization pipeline.
              Image data sent is subject to{" "}
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
            <li>
              <span className="text-foreground font-medium">Resend</span> — for transactional
              email delivery (welcome emails, approval notifications, etc.). Subject to{" "}
              <a
                href="https://resend.com/legal/privacy-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-400 hover:text-purple-300 underline underline-offset-2"
              >
                Resend's privacy policy
              </a>.
            </li>
          </ul>
        </section>

        {/* ── Data Sharing ── */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">7. Data Sharing</h2>
          <p className="text-muted-foreground leading-relaxed">
            We do not sell your personal data, and we do not share your personal data — including
            any Google user data — with third parties for their own independent commercial use.
            We only share data with the third-party service providers listed in Section 6, and
            only to the extent necessary to deliver the FullScale features you have activated.
          </p>
        </section>

        {/* ── Your Rights ── */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">8. Your Rights</h2>
          <p className="text-muted-foreground leading-relaxed">
            You have the right to:
          </p>
          <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-2">
            <li>Request access to the personal data we hold about you</li>
            <li>Request deletion of your account and all associated data</li>
            <li>Request deletion of any generated videos stored on our servers</li>
            <li>Revoke FullScale's access to your connected Google / YouTube account at any time</li>
            <li>Withdraw consent for data processing at any time</li>
          </ul>
          <p className="text-muted-foreground leading-relaxed">
            To exercise any of these rights, contact us at the address below.
          </p>
        </section>

        {/* ── Contact ── */}
        <section className="space-y-4 pb-12">
          <h2 className="text-xl font-semibold">9. Contact Us</h2>
          <p className="text-muted-foreground leading-relaxed">
            If you have questions about this privacy policy or wish to exercise your data
            rights, please contact us:
          </p>
          <p className="text-muted-foreground">
            <a
              href="mailto:martin@gofullscale.co"
              className="text-purple-400 hover:text-purple-300 underline underline-offset-2"
            >
              martin@gofullscale.co
            </a>
          </p>
        </section>
      </main>
    </div>
  );
}
