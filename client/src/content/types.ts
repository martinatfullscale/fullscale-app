/**
 * Marketing copy, per locale, as MODULES rather than catalog keys.
 *
 * The UI chrome — buttons, form labels, toasts — goes through i18next, because
 * those are labels and a key-value catalog is exactly right for labels.
 *
 * This is the other half. The public pages are ~2,250 words of hand-written
 * brand voice, and a sentence-by-sentence Arabic rendering of English
 * positioning reads as a foreign company's brochure translated by a machine —
 * which is what it would be. A copywriter needs to be able to restructure, cut
 * a paragraph that does not land in Arabic, reorder an argument, and use a
 * different number of sections. A flat catalog cannot express any of that; a
 * module can, because each locale's file is just a typed object.
 *
 * THE CONTRACT: every locale file satisfies the same interface, so the page
 * component is written once and never branches on language. What varies is the
 * words and, where the type allows an array, how many of them there are.
 *
 * THE COST, stated plainly: two files per page that will drift. That is the
 * trade being made — drift is cheaper than stilted Arabic on the front door,
 * and a missing Arabic module falls back to English rather than breaking.
 */

export interface StorySection {
  /** The margin label. Describes the prose, not the video beside it. */
  rail: string;
  heading: string;
  /** One or more paragraphs. A translator may use a different number. */
  body: string[];
  takeaway: string;
}

export interface StoryContent {
  nav: { backHome: string };
  masthead: { eyebrow: string; title: string; deck: string };
  thesis: string;
  byline: { label: string; linkedin: string };
  /** Shown over the Short that sits beside a section. */
  inOurOwnVoice: string;
  sections: StorySection[];
  band: { eyebrow: string; title: string; deck: string };
  grid: { eyebrow: string; title: string };
  find: { title: string; instagram: string; youtube: string };
  player: { close: string };
}


/* ── /brands ──────────────────────────────────────────────────────────────
   Only WORDS. The icons, images, testIds and outbound links stay in the page
   and are zipped to these lists by index — a translator should never be able
   to break a data-testid or a lucide import, and reordering a list in Arabic
   would silently reorder the icons if they lived here. */

export interface BrandsCapability { title: string; description: string }
export interface BrandsStep { step: string; title: string; description: string }
export interface BrandsScene {
  label: string;
  sceneNumber: string;
  description: string;
  realityAlt: string;
  augmentedAlt: string;
}

export interface BrandsContent {
  badge: string;
  hero: { titleLead: string; titleAccent: string; deck: string; ctaPrimary: string; ctaSecondary: string };
  friction: {
    title: string; deck: string;
    traditionalLabel: string; fullscaleLabel: string;
    /** These two must stay the SAME LENGTH as each other and as the icon
     *  lists in the page — they render as a paired comparison. */
    traditional: string[]; fullscale: string[];
    statSlow: string; statUncertain: string;
    statFast: string; statCheap: string; statMeasured: string;
  };
  showcase: { title: string; deck: string; scenes: BrandsScene[] };
  capabilities: { title: string; deck: string; items: BrandsCapability[] };
  steps: { title: string; deck: string; items: BrandsStep[] };
  testLearn: { title: string; deck: string; items: BrandsCapability[] };
  finalCta: { titleLead: string; titleAccent: string; deck: string; ctaPrimary: string; ctaSecondary: string };
}


/* ── / (the landing page) ─────────────────────────────────────────────────
   MARKETING copy only. Two parts of that page are deliberately absent and
   must stay absent: the Google OAuth verification section, whose text was
   checked sentence by sentence against the running code and submitted to
   Google, and the demo modal's technical HUD. See landing.en.ts. */

export interface LandingStep { title: string; description: string }

export interface LandingContent {
  nav: { logoAlt: string; wordmark: string; forBrands: string; signIn: string };
  hero: {
    badge: string; titleLead: string; titleAccent: string; deck: string;
    ctaPrimary: string; ctaSecondary: string;
  };
  partners: { label: string; accent: string };
  realityAugmented: { titleLead: string; titleAccent: string; deck: string };
  opportunityFeed: { title: string; deck: string };
  /** `names` are proper nouns and stay Latin in every locale. */
  backers: { title: string; names: string[] };
  /** Zipped to the feature images by index in the page — keep the order. */
  features: { titles: string[] };
  howItWorks: { titleLead: string; titleAccent: string; steps: LandingStep[] };
  testimonial: { quote: string; attribution: string };
  cohort: { titleLead: string; titleAccent: string; deck: string };
  betaModal: {
    restricted: string; notInCohort: string;
    titleLead: string; titleAccent: string; deck: string;
    ctaPrimary: string; alreadyPartner: string;
  };
}

/** Every page's content shape, keyed by page. Extended as pages are converted. */

/* ── /creates ─────────────────────────────────────────────────────────────
   The nine showcase TITLES are proper nouns — real campaigns, brands and
   people — and stay in the page in Latin script. Only their one-line
   descriptions are translatable, held here as a parallel list zipped by
   index. */

export interface CreatesCapability { title: string; description: string }

export interface CreatesContent {
  badge: string;
  hero: { title: string; deck: string; ctaPrimary: string; ctaSecondary: string };
  capabilities: { title: string; deck: string; items: CreatesCapability[] };
  showcase: { title: string; deck: string; descriptions: string[] };
  philosophy: { title: string; body: string };
  cta: { title: string; deck: string; ctaPrimary: string; ctaSecondary: string };
}

export interface ContentByPage {
  story: StoryContent;
  brands: BrandsContent;
  landing: LandingContent;
  creates: CreatesContent;
}
