/**
 * Read a source duration into seconds.
 *
 * video_index.duration is a `varchar` and holds at least three shapes
 * depending on how the video arrived: YouTube's ISO-8601 ("PT1H5M12S"), a
 * colon clock from an importer ("1:05:12"), and a plain seconds string from an
 * upload probe ("3912"). Nothing downstream could sort or group by length
 * because the only parser lived privately inside scanner_v2.ts — so the AI
 * video picker printed "PT1H5M12S" to a creator, and the reel bin had no
 * numeric length at all.
 *
 * Returns null rather than 0 for anything unrecognisable, so a caller can tell
 * "no duration recorded" from "zero seconds long".
 */
export function parseDurationSec(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? input : null;
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;

  const clock = raw.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clock) {
    const total = clock[3] !== undefined
      ? parseInt(clock[1], 10) * 3600 + parseInt(clock[2], 10) * 60 + parseInt(clock[3], 10)
      : parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10);
    return total > 0 ? total : null;
  }

  const m = raw.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return null;
  const total =
    parseInt(m[1] || "0", 10) * 3600 +
    parseInt(m[2] || "0", 10) * 60 +
    parseFloat(m[3] || "0");
  return total > 0 ? total : null;
}

/**
 * Where the line between short and long form sits, in seconds.
 *
 * Five minutes. Not a technical threshold — it is the point past which a video
 * is something you cut FROM rather than something you post, which is the
 * distinction the reel bin has to make legible.
 */
export const LONG_FORM_SEC = 5 * 60;
export const isLongForm = (seconds: number | null | undefined) =>
  typeof seconds === "number" && seconds >= LONG_FORM_SEC;
