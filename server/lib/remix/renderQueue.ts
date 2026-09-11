// Global render gate for all heavy ffmpeg pipelines.
//
// Every render entry point (auto-remix clips, editorial batch renders,
// re-renders, narrative stitches) used to fire ffmpeg immediately inside the
// web process — N concurrent users (or one user with two tabs) meant N
// unthrottled x264 encodes plus frame extraction on a single small Replit
// instance, starving the event loop and risking OOM. All ffmpeg-heavy render
// functions now acquire a slot here first; excess work queues FIFO and runs as
// slots free up. Job rows are created immediately, so the UI still sees
// "queued" status while waiting.
//
// The gated functions (clipGenerator.generateClip, clipStitcher.stitchSegments,
// editorialAutoPipeline.runFFmpegRender) never call each other, so a slot
// holder can't wait on another slot — no deadlock at any concurrency. If you
// add a new gated function, keep that invariant.
import { pLimit } from "../concurrency";

const MAX_CONCURRENT_RENDERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_RENDERS || "1", 10) || 1,
);

const limit = pLimit(MAX_CONCURRENT_RENDERS);

let waiting = 0;
let active = 0;

/** Run `fn` when a global render slot is free. `label` is for queue logging. */
export function withRenderSlot<T>(label: string, fn: () => Promise<T>): Promise<T> {
  waiting++;
  const enqueuedAt = Date.now();
  return limit(async () => {
    waiting--;
    active++;
    const waitedMs = Date.now() - enqueuedAt;
    if (waitedMs > 1_000) {
      console.log(
        `[RenderQueue] ${label} waited ${(waitedMs / 1000).toFixed(1)}s for a render slot ` +
          `(${active}/${MAX_CONCURRENT_RENDERS} active, ${waiting} waiting)`,
      );
    }
    try {
      return await fn();
    } finally {
      active--;
    }
  });
}

/** Snapshot for status endpoints/logging. */
export function renderQueueStats(): { active: number; waiting: number; max: number } {
  return { active, waiting, max: MAX_CONCURRENT_RENDERS };
}
