import { useEffect } from "react";
import { useLocation } from "wouter";
import {
  ALIASES, DEFAULT_IMAGE, ROUTE_META, SITE_ORIGIN, absoluteUrl, metaForPath,
} from "@shared/seo";

/**
 * Keep the document's metadata in step with the route during SPA navigation.
 *
 * The SERVER is what fixes shared links — unfurlers never run this code. This
 * exists for the two things the server cannot cover: the tab title while
 * someone clicks around the site, and Google's renderer, which does execute
 * JavaScript and would otherwise index whichever route it happened to fetch.
 *
 * Dynamic routes are deliberately left alone. /c/<slug> and /s/<slug> get
 * their titles from a database lookup on the server; overwriting that here
 * with a generic string would make the client actively worse than the HTML it
 * was served.
 */
const DYNAMIC = /^\/(c|s)\//;

function setTag(selector: string, attr: "content" | "href", value: string, create: () => HTMLElement) {
  let el = document.head.querySelector(selector) as HTMLElement | null;
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
}

export function useRouteMeta() {
  const [location] = useLocation();

  useEffect(() => {
    const pathname = (location || "/").split("?")[0];
    if (DYNAMIC.test(pathname)) return;

    const meta = metaForPath(pathname);
    const url = absoluteUrl(pathname === "/" ? "/" : pathname.replace(/\/+$/, ""));
    const image = absoluteUrl(meta.image || DEFAULT_IMAGE);

    document.title = meta.title;

    const m = (name: string, prop: boolean, value: string) => {
      const sel = prop ? `meta[property="${name}"]` : `meta[name="${name}"]`;
      setTag(sel, "content", value, () => {
        const el = document.createElement("meta");
        el.setAttribute(prop ? "property" : "name", name);
        return el;
      });
    };

    m("description", false, meta.description);
    m("og:title", true, meta.title);
    m("og:description", true, meta.description);
    m("og:url", true, url);
    m("og:image", true, image);
    m("twitter:title", false, meta.title);
    m("twitter:description", false, meta.description);
    m("twitter:image", false, image);

    setTag('link[rel="canonical"]', "href", url, () => {
      const el = document.createElement("link");
      el.setAttribute("rel", "canonical");
      return el;
    });

    // Only ever ADD a noindex; never assert "index", which could contradict a
    // header or robots.txt set upstream.
    const robots = document.head.querySelector('meta[name="robots"]');
    if (meta.noindex) {
      if (robots) robots.setAttribute("content", "noindex, nofollow");
      else {
        const el = document.createElement("meta");
        el.setAttribute("name", "robots");
        el.setAttribute("content", "noindex, nofollow");
        document.head.appendChild(el);
      }
    } else if (robots) {
      robots.remove();
    }
  }, [location]);
}

export { ROUTE_META, ALIASES, SITE_ORIGIN };
