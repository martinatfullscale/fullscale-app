import type { CreatesContent } from "./types";

/**
 * /creates — English source.
 *
 * The nine showcase entries name REAL WORK for real brands. Their `title`
 * fields are the names of campaigns, partnerships and people — Deleon, ANTA x
 * Kyrie, the NAACP Image Awards, LEGO — and stay in Latin script in every
 * locale. Only the one-line `description` under each is translatable.
 * Translating "Nike Blueprint" would make a real campaign unfindable.
 */
export const createsEn: CreatesContent = {
  badge: "FullScale Creates",

  hero: {
    title: "Content That Connects",
    deck:
      "We build and curate content for audiences that demand something real. AI accelerates the craft — but the creator drives the story. That partnership is where the magic lands.",
    ctaPrimary: "Work With Us",
    ctaSecondary: "See Our Work",
  },

  capabilities: {
    title: "What We Do",
    deck: "End-to-end content production for creators and brands who value authenticity",
    items: [
      {
        title: "Content Production",
        description: "From concept to final cut — full-service video production for digital creators",
      },
      {
        title: "Creator Partnerships",
        description: "Strategic partnerships that connect brands with authentic creator voices",
      },
      {
        title: "AI-Enhanced Workflow",
        description: "Leveraging AI tools to accelerate production while preserving the human touch",
      },
      {
        title: "Distribution & Reach",
        description: "Multi-platform content strategy to maximize audience engagement and impact",
      },
    ],
  },

  showcase: {
    title: "Our Work",
    deck: "A showcase of content crafted at the intersection of creativity and technology",
    /** Descriptions only — the titles are proper nouns, held in the page. */
    descriptions: [
      "Brand activation coverage at one of culture's biggest nights",
      "Sizzle reel for the ANTA x Kyrie Irving partnership",
      "Branded content series for Chase United",
      "Campaign content for Nike's Blueprint initiative",
      "Sponsored activation with MGK at the VMAs",
      "Original series streaming on ROKU",
      "Branded spot for Smirnoff in partnership with BET",
      "Home Depot's Retool Your School initiative with Rashan Ali",
      "Branded content for LEGO",
    ],
  },

  philosophy: {
    title: "The FullScale Creates Philosophy",
    body:
      "We believe in the power of real stories told by real people. When creators own the narrative and the tools work in service of that vision, the content doesn't just perform, it connects.",
  },

  cta: {
    title: "Ready to Create Something Real?",
    deck:
      "Whether you're a creator looking to produce premium content or a brand seeking authentic partnerships.",
    ctaPrimary: "Get in Touch",
    ctaSecondary: "Explore Marketplace",
  },
};
