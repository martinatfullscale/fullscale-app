/**
 * Stories — the content behind the FullScale story page (/about, /stories).
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
 *     youtube: "https://youtube.com/shorts/dQw4w9WgXcQ"
 *     youtube: "dQw4w9WgXcQ"
 *
 * The poster frame comes from YouTube automatically, so there is no image to
 * upload and nothing to keep in sync.
 *
 * WHERE IT LANDS ON THE PAGE is decided here, not in the component:
 *   pairsWith: n  → docks beside prose section n of the founders' argument
 *   band: true    → sits in the "How we got here" band under the argument
 *   neither       → falls into the story grid at the bottom
 * A story needs no placement to be published. The grid is the default and the
 * page tells the truth when it is empty.
 * ─────────────────────────────────────────────────────────────────────────
 */

export type StoryCategory =
  | "Creator stories"
  | "How it works"
  | "Brand playbooks"
  | "Product updates"
  | "Company";

export interface Story {
  /** URL-safe id. Also the deep-link hash: /about#<slug> and /stories#<slug>. */
  slug: string;
  category: StoryCategory;
  title: string;
  /** One or two sentences. The card's deck and the player's subhead. */
  deck: string;
  /**
   * A YouTube watch URL, youtu.be link, /shorts/ link, or bare 11-character id.
   * When present the card plays and the poster frame is automatic.
   */
  youtube?: string;
  /**
   * Where a non-video card goes. Internal paths use client routing; anything
   * starting with http opens in a new tab.
   */
  href?: string;
  /** Poster for a non-video card. Optional — cards render fine without one. */
  image?: string;
  /** Shown under the title on the card. Names only, matching the byline. */
  byline?: string;
  /**
   * Shape of the video. Shorts are 9:16 and letterbox badly in a 16:9 well —
   * a vertical clip in a horizontal frame is mostly black bars — so a
   * portrait story gets a portrait card and a portrait player.
   */
  orientation?: "portrait" | "landscape";
  /** A two-or-three word role, shown as an eyebrow over the card. */
  tag?: string;
  /** Dock this story beside prose section n (0-based) of the argument. */
  pairsWith?: number;
  /** Put this story in the band under the argument. */
  band?: boolean;
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

/**
 * The one variant YouTube guarantees for every video — but only at 480x360,
 * which is LANDSCAPE. There is no universal portrait fallback, so when a
 * portrait card falls back it has to letterbox rather than crop: cropping a
 * 4:3 frame into a 9:16 well throws away half the picture. The component
 * reads `youTubePosterIsFallback` to decide between cover and contain.
 */
export function youTubePosterFallback(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}
export function youTubePosterIsFallback(src: string): boolean {
  return src.endsWith("/hqdefault.jpg");
}

/** Privacy-preserving embed host, autoplay on click-to-play. */
export function youTubeEmbed(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
}

/**
 * ORDER IS DISPLAY ORDER within each placement.
 *
 * The four founder Shorts read as one arc — the market, the thesis, the
 * difficulty, the outcome — but the arc of the PROSE is a different one, and
 * they only line up for the first two. Sections 3 and 4 of the argument are
 * about creator consent and about not keeping a creator's footage; a video
 * about raising money does not belong beside either, so the last two Shorts
 * sit in their own band instead of being forced into a column that happens
 * to be free.
 */
export const STORIES: Story[] = [
  {
    slug: "43-billion-on-creators",
    category: "Company",
    title: "$43Billion On Creators",
    deck:
      "Martin on the size of the creator economy, and why almost none of that money reaches the frames people are actually watching.",
    youtube: "https://youtube.com/shorts/nVXd4-Hwe_o",
    orientation: "portrait",
    tag: "The market",
    pairsWith: 0,
  },
  {
    slug: "ai-product-placement-is-real",
    category: "Company",
    title: "AI Product Placement is Real",
    deck:
      "The thesis said plainly: a product placed into footage after the shot, in video that already exists.",
    youtube: "https://youtube.com/shorts/U4myeHPl9Cc",
    orientation: "portrait",
    tag: "The thesis",
    pairsWith: 1,
  },
  {
    slug: "its-hard-to-raise",
    category: "Company",
    title: "It's Hard to Raise",
    deck: "Fundraising without the tidy version, from the two people who sat through it.",
    youtube: "https://youtube.com/shorts/RVTC2oTQMdE",
    orientation: "portrait",
    tag: "The difficulty",
    band: true,
  },
  {
    slug: "how-we-got-funded",
    category: "Company",
    title: "How We Got Funded",
    deck: "How the round came together in the end, and what it bought us time to build.",
    youtube: "https://youtube.com/shorts/1zOTyIiMrKo",
    orientation: "portrait",
    tag: "The outcome",
    band: true,
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

/** The stories that fall through to the grid: no section, no band. */
export function gridStories(): Story[] {
  return STORIES.filter((s) => s.pairsWith === undefined && !s.band);
}
export function sectionStory(index: number): Story | undefined {
  return STORIES.find((s) => s.pairsWith === index);
}
export function bandStories(): Story[] {
  return STORIES.filter((s) => s.band);
}
