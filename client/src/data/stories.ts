/**
 * Stories — the content behind /stories.
 *
 * This is the whole content model. To publish a story, add an entry to
 * STORIES below. No CMS, no build step, no database: edit this file, commit,
 * deploy.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TO ADD A YOUTUBE VIDEO: paste the URL into `youtube`. Any of these work —
 *
 *     youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *     youtube: "https://youtu.be/dQw4w9WgXcQ"
 *     youtube: "dQw4w9WgXcQ"
 *
 * The poster frame comes from YouTube automatically, so there is no image to
 * upload and nothing to keep in sync.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The shape borrows Agentio's blog structure — a featured band over a
 * filterable grid, each card an eyebrow / headline / deck — and departs from
 * it in the one way that matters here: their cards are all still images (57
 * of them, zero video). Ours lead with the video, because the video IS the
 * story. A 16:9 card is already exactly a YouTube frame.
 */

export type StoryCategory =
  | "Creator stories"
  | "How it works"
  | "Brand playbooks"
  | "Product updates"
  | "Company";

export interface Story {
  /** URL-safe id. Also the deep-link hash: /stories#<slug>. */
  slug: string;
  category: StoryCategory;
  title: string;
  /** One or two sentences. This is the card's deck and the player's subhead. */
  deck: string;
  /**
   * A YouTube watch URL, youtu.be link, or bare 11-character id.
   * When present the card plays inline and the poster frame is automatic.
   */
  youtube?: string;
  /**
   * Where a non-video card goes. Internal paths use client routing; anything
   * starting with http opens in a new tab.
   */
  href?: string;
  /** Poster for a non-video card. Optional — cards render fine without one. */
  image?: string;
  /** Shown under the title on the card. Names only, matching /about. */
  byline?: string;
  /** Pin to the featured band at the top. Keep this to 1–3 entries. */
  featured?: boolean;
  /**
   * Shape of the video. Shorts are 9:16 and letterbox badly in a 16:9 well —
   * a vertical clip in a horizontal frame is mostly black bars — so a
   * portrait story gets a portrait card and a portrait player.
   */
  orientation?: "portrait" | "landscape";
}

/**
 * Pull the 11-character video id out of whatever form the URL took.
 * Returns null for anything that isn't recognisably a YouTube reference, so a
 * typo degrades to a non-video card instead of a broken iframe.
 */
export function youTubeId(input?: string): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/(?:embed|shorts|live|v)\/)([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = raw.match(p);
    if (m) return m[1];
  }
  return null;
}

/**
 * YouTube's own poster frame.
 *
 * maxresdefault is 16:9 — for a Short that means the vertical frame
 * letterboxed inside black bars, which then gets letterboxed again by the
 * card. `oardefault` is the ORIGINAL aspect (1080x1920 for a Short), so a
 * portrait story asks for that instead and fills its well properly.
 */
export function youTubePoster(id: string, orientation?: "portrait" | "landscape"): string {
  return orientation === "portrait"
    ? `https://i.ytimg.com/vi/${id}/oardefault.jpg`
    : `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
}
export function youTubePosterFallback(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/** Privacy-preserving embed host, autoplay on click-to-play. */
export function youTubeEmbed(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1`;
}

export const STORIES: Story[] = [
  {
    slug: "why-we-are-building-this",
    category: "Company",
    title: "Product placement has existed for a century. Almost no creator was ever offered it.",
    deck:
      "Every sponsorship asks a creator to stop their video and read a script. We are building the other option — and we wrote down why, including the parts that aren't finished yet.",
    href: "/about",
    image: "/founders.jpg",
    byline: "Martin Ekechukwu · Tamara Spinner",
    featured: true,
  },

  // ───────────────────────────────────────────────────────────────────────
  // ORDER IS DISPLAY ORDER, and these four read as one arc rather than four
  // unrelated clips: the market, then the thesis, then the difficulty, then
  // the outcome. They were in reverse upload order, which is not an order at
  // all — this is. Move an entry to change where it sits.
  //
  // The FIRST entry carrying `featured: true` becomes the large player at the
  // top; the next two sit beside it. Everything else falls into the grid.
  // ───────────────────────────────────────────────────────────────────────
  {
    slug: "43-billion-on-creators",
    category: "Company",
    title: "$43Billion On Creators",
    deck: "",
    youtube: "https://youtube.com/shorts/nVXd4-Hwe_o",
    orientation: "portrait",
  },
  {
    slug: "ai-product-placement-is-real",
    category: "Company",
    title: "AI Product Placement is Real",
    deck: "",
    youtube: "https://youtube.com/shorts/U4myeHPl9Cc",
    orientation: "portrait",
  },
  {
    slug: "its-hard-to-raise",
    category: "Company",
    title: "It's Hard to Raise",
    deck: "",
    youtube: "https://youtube.com/shorts/RVTC2oTQMdE",
    orientation: "portrait",
  },
  {
    slug: "how-we-got-funded",
    category: "Company",
    title: "How We Got Funded",
    deck: "",
    youtube: "https://youtube.com/shorts/1zOTyIiMrKo",
    orientation: "portrait",
  },
];

/** Filter chips, in display order. "All" is prepended by the page. */
export const STORY_CATEGORIES: StoryCategory[] = [
  "Creator stories",
  "How it works",
  "Brand playbooks",
  "Product updates",
  "Company",
];
