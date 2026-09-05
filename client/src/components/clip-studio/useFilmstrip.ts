import { useEffect, useRef, useState } from "react";

/**
 * Real frames under the base track.
 *
 * The old timeline tiled ONE thumbnail with `background-repeat: repeat-x`, so
 * every position on the strip looked identical and the strip told you nothing
 * about where you were. A filmstrip that shows the actual footage is what
 * makes a timeline scrubbable by eye.
 *
 * The extraction pattern is the one already proven in VideoPreviewModal:
 * set currentTime, await `seeked`, drawImage to a canvas, toDataURL. Two
 * changes matter here:
 *
 *   1. It runs on a DETACHED <video>, not the visible player. The original
 *      seeks the element the user is watching and resets it to 0 when it
 *      finishes — acceptable for a one-shot thumbnail row, not for a strip
 *      that regenerates whenever the zoom changes under someone's playhead.
 *   2. It is abortable and cached. Seeks are slow (one network-ish round trip
 *      each), so a zoom change must not restart a run that is still going,
 *      and frames already extracted at a given time must not be re-extracted.
 *
 * No WebCodecs and no ffmpeg.wasm: neither exists in this codebase, both are
 * a significant new dependency, and seek-and-draw is enough for a strip.
 */

export interface Filmstrip {
  /** Data URLs in time order. Sparse while a run is in flight. */
  frames: string[];
  /** The clip-relative time each frame was taken at, same index. */
  times: number[];
  loading: boolean;
  /** True when the source cannot produce frames at all (no src, decode error). */
  failed: boolean;
}

const FRAME_H = 44;

export function useFilmstrip(
  src: string | null | undefined,
  duration: number,
  /** How many frames to spread across the strip. Driven by zoom. */
  count: number,
): Filmstrip {
  const [strip, setStrip] = useState<Filmstrip>({ frames: [], times: [], loading: false, failed: false });
  /** Extracted frames keyed by rounded time, surviving zoom changes. */
  const cache = useRef<Map<number, string>>(new Map());
  const lastSrc = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (lastSrc.current !== src) {
      cache.current.clear();
      lastSrc.current = src;
    }
    if (!src || !(duration > 0) || count < 1) {
      setStrip({ frames: [], times: [], loading: false, failed: !src });
      return;
    }

    let cancelled = false;
    const wanted: number[] = [];
    for (let i = 0; i < count; i++) {
      // Sample at the CENTRE of each cell, not its left edge: a frame taken at
      // t=0 of a fade-in is black, and a strip that opens on black reads as
      // broken footage.
      wanted.push(Number((((i + 0.5) / count) * duration).toFixed(2)));
    }

    const fromCache = wanted.map((t) => cache.current.get(t) ?? "");
    if (fromCache.every(Boolean)) {
      setStrip({ frames: fromCache, times: wanted, loading: false, failed: false });
      return;
    }
    setStrip({ frames: fromCache, times: wanted, loading: true, failed: false });

    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    // Same-origin (/storage/* and /uploads/*), so the canvas is never tainted.
    video.src = src;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const seekTo = (t: number) =>
      new Promise<void>((resolve) => {
        // Never hang the run on a seek that does not settle — a partially
        // filled strip is fine, a spinner that never clears is not.
        const done = () => { clearTimeout(timer); video.removeEventListener("seeked", done); resolve(); };
        const timer = setTimeout(done, 4000);
        video.addEventListener("seeked", done);
        try { video.currentTime = t; } catch { done(); }
      });

    const run = async () => {
      try {
        if (video.readyState < 1) {
          await new Promise<void>((resolve, reject) => {
            const ok = () => { cleanup(); resolve(); };
            const bad = () => { cleanup(); reject(new Error("decode")); };
            const timer = setTimeout(bad, 8000);
            const cleanup = () => {
              clearTimeout(timer);
              video.removeEventListener("loadedmetadata", ok);
              video.removeEventListener("error", bad);
            };
            video.addEventListener("loadedmetadata", ok);
            video.addEventListener("error", bad);
          });
        }
        if (cancelled || !ctx) return;

        const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
        canvas.height = FRAME_H * 2;                      // 2x for retina
        canvas.width = Math.max(2, Math.round(canvas.height * ratio));

        const out = [...fromCache];
        for (let i = 0; i < wanted.length; i++) {
          if (cancelled) return;
          if (out[i]) continue;
          await seekTo(wanted[i]);
          if (cancelled) return;
          try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const url = canvas.toDataURL("image/jpeg", 0.6);
            cache.current.set(wanted[i], url);
            out[i] = url;
          } catch {
            // A single undecodable frame is not a failed strip.
          }
          // Publish as we go — the strip fills in rather than appearing at once.
          if (i % 3 === 2 || i === wanted.length - 1) {
            setStrip({ frames: [...out], times: wanted, loading: i < wanted.length - 1, failed: false });
          }
        }
        if (!cancelled) setStrip({ frames: out, times: wanted, loading: false, failed: false });
      } catch {
        if (!cancelled) setStrip({ frames: fromCache, times: wanted, loading: false, failed: true });
      }
    };

    void run();
    return () => {
      cancelled = true;
      video.removeAttribute("src");
      try { video.load(); } catch { /* detaching a never-loaded element */ }
    };
  }, [src, duration, count]);

  return strip;
}
