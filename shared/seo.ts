/**
 * Per-route page metadata — one table, read by the server and the client.
 *
 * WHY THIS EXISTS. client/index.html is a single static shell and nothing set
 * meta at runtime, so every route on the site served the same <title>, the
 * same description, and — worst of all — a hardcoded
 * `og:url = https://gofullscale.co/`. Every link anyone shared, a creator's
 * own /c/<slug> permalink included, unfurled on WhatsApp, LinkedIn, iMessage
 * and Slack as the homepage. Google saw one description for forty routes.
 *
 * WHY IT IS RENDERED ON THE SERVER. Social unfurlers do not execute
 * JavaScript. Google's renderer does, so a client-only fix would eventually
 * help search and would never fix a shared link — which is the failure that
 * actually costs something. The server injects these into the shell before it
 * is sent; the client re-applies them on SPA navigation so an in-app route
 * change keeps the tab title honest.
 */

export interface PageMeta {
  title: string;
  description: string;
  /** Absolute or root-relative. Falls back to the site card. */
  image?: string;
  /** Login walls, dashboards and one-off share links have nothing to offer a
   *  search index and should not compete with the pages that do. */
  noindex?: boolean;
}

export const SITE_NAME = "FullScale";
export const SITE_ORIGIN = "https://gofullscale.co";
export const DEFAULT_IMAGE = "/hero-share-final.jpg";

/**
 * Exact paths. Dynamic routes (/c/:slug, /s/:slug) are resolved separately
 * because their titles depend on data — see resolveDynamicMeta on the server.
 */
export const ROUTE_META: Record<string, PageMeta> = {
  "/": {
    title: "FullScale — product placement in video that already exists",
    description:
      "FullScale finds the spaces already in a creator's footage where a product could sit, and lets brands buy them. No reshoots, no sixty-second reads.",
  },

  "/creates": {
    title: "FullScale Creates — brand activation work",
    description:
      "Brand activation coverage and sizzle work from FullScale Creates, including the NAACP Image Awards and the ANTA x Kyrie Irving partnership.",
  },

  "/brands": {
    title: "For brands — buy the space, not the shoot | FullScale",
    description:
      "Sourcing talent, negotiating rates, funding production, hoping the impressions land. FullScale places your product into video that already performs.",
  },

  "/studio": {
    title: "FullScale Studio — turn a deck into a narrated video",
    description:
      "Drop in a PDF or PPTX. Claude reads every page, writes the script, generates each scene, and returns a narrated MP4. No stock footage, no templates.",
  },

  "/studio/pricing": {
    title: "FullScale Studio pricing",
    description: "Plans for FullScale Studio, including voice options and voice cloning.",
  },

  "/about": {
    title: "How we're building FullScale",
    description:
      "Written and filmed by the two people doing it — the argument, the honest parts, and the videos where we say it out loud.",
  },

  "/privacy": { title: "Privacy Policy | FullScale", description: "How FullScale handles creator and brand data, including what we do not keep." },
  "/terms": { title: "Terms of Service | FullScale", description: "The terms that govern use of FullScale." },

  // Gates and walls. Real pages, but nothing a search result should land on.
  "/auth": { title: "Sign in | FullScale", description: "Sign in to FullScale.", noindex: true },
  "/waitlist": { title: "Join the waitlist | FullScale", description: "FullScale is invite-only while we build. Join the waitlist.", noindex: true },
  "/brand-signup": { title: "For brands — apply | FullScale", description: "Apply for brand access to FullScale.", noindex: true },
  "/brands/onboarding": { title: "Brand onboarding | FullScale", description: "Set up your brand on FullScale.", noindex: true },
  "/studio/waitlist": { title: "FullScale Studio waitlist", description: "Join the waitlist for FullScale Studio.", noindex: true },
};

/** Paths that share another route's metadata. */
export const ALIASES: Record<string, string> = {
  "/stories": "/about",
  "/login": "/auth",
  "/signup": "/auth",
  "/home": "/",
  "/content": "/creates",
};

/** Everything behind a login: one noindex entry rather than forty. */
export const APP_FALLBACK: PageMeta = {
  title: "FullScale",
  description: "FullScale — product placement in video that already exists.",
  noindex: true,
};

export function metaForPath(pathname: string): PageMeta {
  const clean = (pathname.split("?")[0] || "/").replace(/\/+$/, "") || "/";
  const target = ALIASES[clean] ?? clean;
  return ROUTE_META[target] ?? APP_FALLBACK;
}

/** Anything interpolated into HTML has to be escaped — a creator's display
 *  name reaches this, and a stray quote would break out of the attribute. */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function absoluteUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return SITE_ORIGIN + (pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`);
}
