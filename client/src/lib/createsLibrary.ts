// The FullScale Creates portfolio, loaded from a static manifest.
//
// Served from client/public rather than bundled: the client is a single ~2.8MB
// chunk and 157 entries do not belong in it — the same reasoning that put the
// i18n catalogs in client/public/locales.
//
// Media lives in Object Storage under /storage/creates-library/. The manifest
// derives those URLs rather than reading them back from the upload, so an entry
// can exist before its bytes do. Callers must therefore tolerate a 404 on any
// individual poster or video and degrade that one card.

import { useEffect, useState } from "react";

export interface CreatesVideo {
  slug: string;
  title: string;
  brand: string | null;
  /** 1..N for the pieces featured on the landing page, null for the rest. */
  featuredRank: number | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  videoUrl: string;
  posterUrl: string;
}

export interface CreatesLibrary {
  generatedAt: string;
  count: number;
  featuredCount: number;
  videos: CreatesVideo[];
}

export function formatDuration(sec: number | null): string {
  if (!sec || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

let cache: CreatesLibrary | null = null;
let inflight: Promise<CreatesLibrary> | null = null;

async function load(): Promise<CreatesLibrary> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = fetch("/creates-library.json", { credentials: "omit" })
    .then((r) => {
      if (!r.ok) throw new Error(`creates-library.json ${r.status}`);
      return r.json();
    })
    .then((data: CreatesLibrary) => {
      cache = data;
      return data;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * The library, or an empty one while loading or on failure.
 *
 * Failure is deliberately quiet. This feeds a marketing page whose other
 * sections stand on their own — a manifest that will not load should cost the
 * showcase, not the page.
 */
export function useCreatesLibrary() {
  const [videos, setVideos] = useState<CreatesVideo[]>(cache?.videos ?? []);
  const [state, setState] = useState<"loading" | "ready" | "error">(cache ? "ready" : "loading");

  useEffect(() => {
    let dead = false;
    load()
      .then((lib) => { if (!dead) { setVideos(lib.videos); setState("ready"); } })
      .catch((err) => {
        if (dead) return;
        console.warn("[CreatesLibrary] manifest unavailable:", err?.message || err);
        setState("error");
      });
    return () => { dead = true; };
  }, []);

  const featured = videos
    .filter((v) => v.featuredRank != null)
    .sort((a, b) => (a.featuredRank ?? 0) - (b.featuredRank ?? 0));

  return { videos, featured, state };
}
