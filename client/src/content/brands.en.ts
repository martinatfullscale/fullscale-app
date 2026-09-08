import type { BrandsContent } from "./types";

/**
 * /brands — English source.
 *
 * Lifted verbatim from pages/Brands.tsx. Only WORDS live here: the icons,
 * images, testIds and links stay in the page, zipped to these by index, so a
 * translator never has to see a lucide import or risk breaking a data-testid.
 */
export const brandsEn: BrandsContent = {
  badge: "For Brands",

  hero: {
    titleLead: "Your brand,",
    titleAccent: "in content that's already performing.",
    deck:
      "Drop your product into podcast desks, DJ booths, gaming setups, and creator studios — without the heavy friction of finding talent, negotiating rates, or chasing reshoots. Test creator-product associations before you commit the big budget.",
    ctaPrimary: "Apply for Access",
    ctaSecondary: "See How It Works",
  },

  friction: {
    title: "There are two ways to get your product in front of audiences.",
    deck: "One way is expensive, slow, and hit-or-miss. The other is FullScale.",
    traditionalLabel: "Heavy friction, hit-or-miss outcomes",
    fullscaleLabel: "Proven content, measurable outcomes",
    traditional: [
      "Spend weeks sourcing and vetting creator talent",
      "Negotiate rates, contracts, and exclusivity terms",
      "Fund production, travel, reshoots, revisions",
      "Launch one spot and hope the impressions land",
    ],
    fullscale: [
      "Pick content that already has proven engagement",
      "Our AI matches your product to contextually-relevant spaces",
      "Test placements across multiple creators at once",
      "Scale only the variants that actually perform",
    ],
    statSlow: "6–12 weeks",
    statUncertain: "hit or miss",
    statFast: "48 hours",
    statCheap: "a fraction",
    statMeasured: "measurable",
  },

  showcase: {
    title: "Real products. Real creator moments.",
    deck:
      "Drag the slider on each scene to see what FullScale's AI does to a creator's existing content — no reshoots, no prop-swapping, no production day required.",
    scenes: [
      {
        label: "Kitchen",
        sceneNumber: "Scene 1 of 3",
        description:
          "A warm minimalist kitchen — oak counter, sage cabinets, copper pans, morning light from the window. Drag the slider to see our AI place an Olipop can onto the counter with shadow direction matched to the window light and the counter's wood grain preserved right up to the can's base.",
        realityAlt: "Warm minimalist kitchen with oak counter, copper pans, morning window light",
        augmentedAlt: "Same kitchen with an Olipop can placed on the counter by FullScale AI",
      },
      {
        label: "DJ Booth",
        sceneNumber: "Scene 2 of 3",
        description:
          "A DJ controller mid-session — jog wheels, mixer faders, RGB performance pads glowing purple and cyan. Drag to reveal an energy drink can placed on the surface beside the mixer. The can's shadow falls in the direction of the booth's ambient lighting, and its scale matches the controller's depth of field perfectly.",
        realityAlt: "DJ controller close-up with jog wheels, mixer faders, and RGB pads",
        augmentedAlt: "Same DJ booth with an energy drink can placed beside the mixer",
      },
      {
        label: "Gaming Setup",
        sceneNumber: "Scene 3 of 3",
        description:
          "A gaming desk at dusk — dual monitors, mechanical RGB keyboard, desk mat with RGB underglow, gaming chair blurred in the background. Drag to see a Monster Energy can land to the left of the keyboard. The can picks up the warm RGB light in its reflections and drops a clean shadow across the desk space.",
        realityAlt: "Gaming desk with dual monitors, RGB keyboard, and accent lighting",
        augmentedAlt: "Same gaming desk with a Monster Energy can placed beside the keyboard",
      },
    ],
  },

  capabilities: {
    title: "Stickers. Products. Screens. All of it.",
    deck: "If it has a flat surface, a screen, or an empty frame — you can own the moment.",
    items: [
      {
        title: "Physical Products",
        description:
          "Drop beverages, electronics, beauty, lifestyle, or food & bev onto a creator's desk, counter, or studio table with AI-perfect lighting and occlusion.",
      },
      {
        title: "Branded Stickers & Decals",
        description:
          "Place your logo or campaign art on a DJ controller, laptop, helmet, or instrument case — wherever your brand fits the moment.",
      },
      {
        title: "On-Screen Overlays",
        description:
          "Replace a creator's monitor content with your app UI, game preview, or product demo. Perfectly tracked across every frame.",
      },
      {
        title: "Ambient Branding",
        description:
          "Wall art, posters, neon signs, book spines — the subtle placements that build brand presence without breaking the creator's moment.",
      },
    ],
  },

  steps: {
    title: "From product upload to live placement in four steps.",
    deck: "No production crew. No reshoots. No waiting months for a creator to decide.",
    items: [
      {
        step: "Step 1",
        title: "You upload your product",
        description:
          "Drop in a clean PNG of your product — drinks, electronics, beauty, apparel, anything with a recognizable silhouette. Add brand guidelines, placement preferences, and which markets you want to reach.",
      },
      {
        step: "Step 2",
        title: "Our AI scans creator content",
        description:
          "FullScale's space engine analyzes the existing videos in your matched creators' libraries. Every flat surface, every empty frame, every moment your product could live in — identified, scored, and ranked.",
      },
      {
        step: "Step 3",
        title: "You approve the placements",
        description:
          "Review AI-generated composites before anything goes live. Approve the ones that fit your brand, reject the ones that don't. No surprises, no off-brand moments, no creator-product mismatches.",
      },
      {
        step: "Step 4",
        title: "Measure, iterate, scale",
        description:
          "Performance data comes in — engagement per second, view-through rate, purchase-link clicks. Double down on the creators and formats that work. Kill the rest. Scale only what's proven.",
      },
    ],
  },

  testLearn: {
    title: "Test everything before you scale anything.",
    deck: "Figure out what lands — and with whom — before you commit real budget.",
    items: [
      {
        title: "Match products to creators",
        description:
          "Run the same product across multiple creators' existing content libraries. See which audience engages most before you commit a dollar.",
      },
      {
        title: "A/B placement variants",
        description:
          "Same video, two spaces, two product treatments. Find the variant that converts before you commit to a full flight.",
      },
      {
        title: "Measure and scale",
        description:
          "Engagement per second, view-through rate, click-through for purchase-linked placements. The signal you need to double down on what works.",
      },
    ],
  },

  finalCta: {
    titleLead: "Ready to put your brand in content that's",
    titleAccent: "already winning?",
    deck:
      "Sign up and our team walks you through a brief tailored to your brand, budget, and audience. Pick a creator, test a placement, see the numbers — before you commit.",
    ctaPrimary: "Apply for Access",
    ctaSecondary: "Talk to Us",
  },
};
