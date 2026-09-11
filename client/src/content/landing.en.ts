import type { LandingContent } from "./types";

/**
 * / — English source.
 *
 * SCOPE, deliberately narrow. This module holds the MARKETING copy only:
 * the nav, hero, the two feature bands, how-it-works, the testimonial, the
 * founding-cohort CTA and the invite-only modal.
 *
 * Two parts of this page are NOT here, and must not be moved here:
 *
 *   1. The Google OAuth verification section (Landing.tsx, "App Name, Purpose
 *      & Legal Links"). Every sentence in it was checked against the code that
 *      actually runs, and it is the text submitted to Google after a review
 *      found the page "does not explain the purpose of your app". It stays
 *      English in every locale — the reviewed text is the text, and a
 *      mistranslated description of a YouTube scope is a worse finding than an
 *      untranslated one.
 *
 *   2. The demo modal's HUD — [Surface_ID: Counter_01], [Lighting: 99.4%],
 *      [Occlusion_Mapping: Active]. Stylised machine output, not prose.
 *
 * Backer names are proper nouns and stay Latin in every locale.
 */
export const landingEn: LandingContent = {
  nav: {
    logoAlt: "FullScale Creator Portal",
    /* NOT wired into the page, deliberately. The nav renders "FullScale
       Creator Portal" as the app's NAME, and it is there because a Google
       OAuth reviewer recorded the name as absent from the page — see the
       comment above it in Landing.tsx. It stays Latin in every locale for the
       same reason the wordmark does. Kept here so the next person sees a
       decision rather than an omission. */
    wordmark: "FullScale",
    forBrands: "For Brands",
    signIn: "Sign In",
  },

  hero: {
    badge: "3D Scene Reconstruction Active",
    titleLead: "We Turn Storytelling",
    titleAccent: "Into Revenue",
    deck:
      "AI-powered product placement that places products into your existing content with perfect lighting, occlusion, and tracking—scaling your reach for a global economy.",
    ctaPrimary: "Sign Up Now",
    ctaSecondary: "Demo Preview",
  },

  partners: { label: "Already used by", accent: "Best in the Game" },

  realityAugmented: {
    titleLead: "Reality vs",
    titleAccent: "Augmented",
    deck:
      "Watch our AI place products onto surfaces with perfect occlusion and lighting. From flat surface to seamless product placement.",
  },

  opportunityFeed: {
    title: "Global Opportunity Feed",
    deck: "Real-time inventory index. Every frame scanned. Every surface monetizable.",
  },

  backers: {
    title: "Backed by Industry Leaders",
    /** Proper nouns — never translated, only ever reordered if the logos are. */
    names: ["Black Ambition", "May Davis Partners", "Elementa", "Mighty Capital"],
  },

  features: {
    titles: ["The Remix Engine", "Contextual AI", "ZERO RESHOOTS", "Context-Aware Reach"],
  },

  howItWorks: {
    titleLead: "A Simple Path",
    titleAccent: "Forward.",
    steps: [
      {
        title: "Connect.",
        description:
          "Seamlessly integrate with YouTube, Instagram, Facebook, and TikTok. We index your library in minutes, not weeks.",
      },
      {
        title: "Align.",
        description:
          "Our AI identifies brand-safe opportunities that match your specific aesthetic.",
      },
      {
        title: "Earn.",
        description: "Approve placements and generate recurring revenue from your back-catalog.",
      },
    ],
  },

  testimonial: {
    /* The quotation marks are part of the string, per locale — Arabic
       conventionally uses guillemets, and hardcoding " in the JSX would stamp
       Latin punctuation on every language. */
    quote:
      "\"FullScale helped us unlock value from content we'd forgotten about. It feels like discovering a whole new revenue stream without changing how we create.\"",
    attribution: "— Early Creator Partner",
  },

  cohort: {
    titleLead: "Join the",
    titleAccent: "Founding Cohort.",
    deck:
      "Not ready to automate everything? Join our exclusive group of partner creators shaping the future of the platform.",
  },

  betaModal: {
    restricted: "Access Restricted",
    notInCohort: "You are not in the Founding Cohort yet.",
    titleLead: "FullScale is Currently",
    titleAccent: "Invite-Only.",
    deck:
      "We are onboarding a select cohort of founding creators to ensure the highest quality experience. Applications are reviewed daily.",
    ctaPrimary: "Sign Up Now",
    alreadyPartner: "Already a Partner? Sign In",
  },
};
