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

/** YouTube's own poster frame. maxres isn't guaranteed to exist; hq always is. */
export function youTubePoster(id: string): string {
  return `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
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
  // Martin — paste your YouTube URLs here.
  //
  // Uncomment an entry, drop the URL in, edit the title and deck, and it is
  // live on the next deploy. Delete any you don't use.
  //
  // ORDER MATTERS: the FIRST entry in this array carrying `featured: true`
  // becomes the large player at the top of the page; the next two sit beside
  // it. Everything else falls into the filterable grid below. Right now the
  // founders' note holds the top slot — move a video above it to take over.
  //
  // {
  //   slug: "how-a-placement-gets-made",
  //   category: "How it works",
  //   title: "How a placement actually gets made",
  //   deck: "From a scan finding a surface to a finished cut the creator signed off on — the whole path, in one take.",
  //   youtube: "https://www.youtube.com/watch?v=REPLACE_ME",
  //   featured: true,
  // },
  // {
  //   slug: "creator-story-1",
  //   category: "Creator stories",
  //   title: "",
  //   deck: "",
  //   youtube: "https://www.youtube.com/watch?v=REPLACE_ME",
  // },
  // {
  //   slug: "brand-playbook-1",
  //   category: "Brand playbooks",
  //   title: "",
  //   deck: "",
  //   youtube: "https://www.youtube.com/watch?v=REPLACE_ME",
  // },
  // ───────────────────────────────────────────────────────────────────────
];

/** Filter chips, in display order. "All" is prepended by the page. */
export const STORY_CATEGORIES: StoryCategory[] = [
  "Creator stories",
  "How it works",
  "Brand playbooks",
  "Product updates",
  "Company",
];
