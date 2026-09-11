import fs from "fs";
import {
  ALIASES, APP_FALLBACK, DEFAULT_IMAGE, ROUTE_META, SITE_NAME, SITE_ORIGIN,
  absoluteUrl, escapeHtml, metaForPath, type PageMeta,
} from "@shared/seo";
/** The single source of truth for which routes have Arabic copy. */
import { LOCALIZED_PATHS } from "@shared/locales";

/**
 * Inject per-route metadata into the SPA shell before it is sent.
 *
 * Social unfurlers — WhatsApp, iMessage, LinkedIn, Slack, X — fetch the HTML
 * and never run the JavaScript. So this has to happen here; a client-side
 * update would fix Google eventually and would never fix a shared link.
 *
 * Cheap by construction: the shell is read once and cached against its mtime,
 * and the substitution is a handful of string replacements on a ~4KB document.
 * The only I/O per request is the dynamic-route lookup below, and only for the
 * two routes that need one.
 */

let cached: { mtimeMs: number; html: string } | null = null;

/** Used when a creator exists but cannot be read right now, or does not exist.
 *  Deliberately indexable: see the catch below. */
const GENERIC_CREATOR: PageMeta = {
  title: "Creator on FullScale",
  description: "Browse this creator's videos and the spaces available for product placement.",
};

function readShell(indexPath: string): string | null {
  try {
    const stat = fs.statSync(indexPath);
    if (!cached || cached.mtimeMs !== stat.mtimeMs) {
      cached = { mtimeMs: stat.mtimeMs, html: fs.readFileSync(indexPath, "utf8") };
    }
    return cached.html;
  } catch {
    return null;
  }
}

/**
 * The two routes whose title depends on data — and the two that get shared
 * most, because they are the links a creator pastes into a DM.
 */
async function resolveDynamicMeta(pathname: string): Promise<PageMeta | null> {
  const creator = pathname.match(/^\/c\/([A-Za-z0-9._-]{1,80})\/?$/);
  if (creator) {
    try {
      // Imported lazily, on purpose. A static top-level import would give the
      // SPA-serving path a load-time dependency on server/db.ts — which throws
      // if DATABASE_URL is unset — so a database problem would stop the site
      // rendering AT ALL rather than just costing one page its title.
      const { storage } = await import("../storage");
      const row: any = await storage.getCreatorBySlug(creator[1]);
      if (!row) return GENERIC_CREATOR;
      const name = row.displayName || row.name || row.channelTitle || creator[1];
      return {
        title: `${name} on FullScale`,
        description: `Browse ${name}'s videos and the spaces available for product placement.`,
        image: row.cardImageUrl || row.profileImageUrl || undefined,
      };
    } catch {
      // A transient database problem must not cost a real creator page its
      // place in the index. Falling through to APP_FALLBACK would stamp
      // noindex on every /c/ URL for the duration of the outage, and a
      // deindexed page does not come back the moment the database does.
      return GENERIC_CREATOR;
    }
  }

  // A shared review link is a one-off URL for one recipient. It gets a correct
  // og:url and title so it does not unfurl as the homepage, and noindex so it
  // never reaches a search result.
  if (/^\/s\/[A-Za-z0-9._-]{1,120}\/?$/.test(pathname)) {
    return {
      title: `Shared from FullScale`,
      description: "A placement shared with you for review.",
      noindex: true,
    };
  }
  return null;
}

/** Replace an existing tag if present, otherwise append into <head>. */
function upsert(html: string, matcher: RegExp, tag: string): string {
  return matcher.test(html) ? html.replace(matcher, tag) : html.replace("</head>", `    ${tag}\n  </head>`);
}

/** Which locale this request is for, from the same signals the client uses. */
function localeFromRequest(search: string, cookie: string | undefined): "en" | "ar" {
  const q = new URLSearchParams(search || "").get("lang");
  if (q === "ar" || q === "en") return q;
  const m = (cookie || "").match(/(?:^|;\s*)fs_lang=([^;]+)/);
  return m && m[1] === "ar" ? "ar" : "en";
}

export async function renderShellWithMeta(
  indexPath: string,
  pathname: string,
  opts?: { search?: string; cookie?: string },
): Promise<string | null> {
  const shell = readShell(indexPath);
  if (!shell) return null;

  const meta: PageMeta = (await resolveDynamicMeta(pathname)) ?? metaForPath(pathname);
  const url = absoluteUrl(pathname === "/" ? "/" : pathname.replace(/\/+$/, ""));
  const image = absoluteUrl(meta.image || DEFAULT_IMAGE);
  const t = escapeHtml(meta.title);
  const d = escapeHtml(meta.description);

  let html = shell;

  // lang and dir ON THE SERVER. The client sets these too, but a crawler or an
  // unfurler never runs that code — and Google decides a page's language from
  // the markup it is served. Only routes that actually have Arabic copy are
  // served as Arabic; the rest stay English regardless of the cookie, matching
  // hasTranslation() on the client.
  const localized = LOCALIZED_PATHS.includes(pathname.replace(/\/+$/, "") || "/");
  const locale = localized ? localeFromRequest(opts?.search ?? "", opts?.cookie) : "en";
  if (locale === "ar") {
    html = html.replace(/<html[^>]*>/i, '<html lang="ar" dir="rtl">');
  }

  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${t}</title>`);
  html = upsert(html, /<meta\s+name="description"[^>]*>/i, `<meta name="description" content="${d}" />`);
  html = upsert(html, /<meta\s+property="og:title"[^>]*>/i, `<meta property="og:title" content="${t}" />`);
  html = upsert(html, /<meta\s+property="og:description"[^>]*>/i, `<meta property="og:description" content="${d}" />`);
  html = upsert(html, /<meta\s+property="og:url"[^>]*>/i, `<meta property="og:url" content="${escapeHtml(url)}" />`);
  html = upsert(html, /<meta\s+property="og:image"[^>]*>/i, `<meta property="og:image" content="${escapeHtml(image)}" />`);
  html = upsert(html, /<meta\s+property="og:site_name"[^>]*>/i, `<meta property="og:site_name" content="${SITE_NAME}" />`);
  html = upsert(html, /<meta\s+name="twitter:title"[^>]*>/i, `<meta name="twitter:title" content="${t}" />`);
  html = upsert(html, /<meta\s+name="twitter:description"[^>]*>/i, `<meta name="twitter:description" content="${d}" />`);
  html = upsert(html, /<meta\s+name="twitter:image"[^>]*>/i, `<meta name="twitter:image" content="${escapeHtml(image)}" />`);
  html = upsert(html, /<link\s+rel="canonical"[^>]*>/i, `<link rel="canonical" href="${escapeHtml(url)}" />`);

  // hreflang, but only where a translation genuinely exists. Declaring an
  // Arabic alternate for a page that is still English is a worse signal than
  // declaring none — it tells Google to serve Arabic speakers a page in a
  // language it is not in.
  html = html.replace(/\s*<link\s+rel="alternate"[^>]*>/gi, "");
  if (localized) {
    const alts = [
      `<link rel="alternate" hreflang="en" href="${escapeHtml(url)}" />`,
      `<link rel="alternate" hreflang="ar" href="${escapeHtml(url)}${url.includes("?") ? "&" : "?"}lang=ar" />`,
      `<link rel="alternate" hreflang="x-default" href="${escapeHtml(url)}" />`,
    ].join("\n    ");
    html = html.replace("</head>", `    ${alts}\n  </head>`);
  }

  // robots: only ever ADD a noindex. Never emit an "index" directive that
  // could contradict a future robots.txt or a header set upstream.
  html = html.replace(/\s*<meta\s+name="robots"[^>]*>/gi, "");
  if (meta.noindex) {
    html = html.replace("</head>", `    <meta name="robots" content="noindex, nofollow" />\n  </head>`);
  }

  return html;
}

export { ROUTE_META, ALIASES, APP_FALLBACK, SITE_ORIGIN };
