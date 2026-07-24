/**
 * Caption styler — OpusClip-style animated captions via ASS/libass.
 *
 * The legacy path burned captions with drawtext: one static white line per
 * 6-word chunk. This module renders the modern short-form look instead:
 * short punchy phrases, bold outlined type, and the ACTIVE word highlighted
 * as it's spoken (word-level timing comes from the transcript pipeline and
 * is preserved on CaptionSegment.words).
 *
 * Output is an .ass subtitle document burned with ffmpeg's `ass=` filter
 * (the bundled ffmpeg-static build ships libass). Callers keep the legacy
 * drawtext filter as a fallback if the ASS render fails (e.g. a fontless
 * container) — styling must never cost a clip.
 *
 * Styles (names match the existing UI options):
 *  - "highlight"     big centered phrases, active word in yellow + bold pop
 *  - "brand_callout" same skeleton, gold accent — brand-adjacent moments
 *  - "narrative"     calmer: full lines, soft fade, no per-word highlight
 */

import type { CaptionSegment } from "./clipGenerator";

export type CaptionStyleName = "highlight" | "brand_callout" | "narrative";

interface StyleSpec {
  /** ASS PrimaryColour (&HAABBGGRR — alpha first, BGR order) */
  primary: string;
  /** Highlight colour for the active word */
  accent: string;
  outline: number;
  fontScale: number;   // relative to base size
  /** Max words shown per phrase event */
  wordsPerPhrase: number;
  perWordHighlight: boolean;
  fade: string;        // ASS \fad tag or ""
}

const STYLES: Record<CaptionStyleName, StyleSpec> = {
  highlight: {
    primary: "&H00FFFFFF",
    accent: "&H0000E5FF",   // vivid yellow (BGR)
    outline: 3,
    fontScale: 1.0,
    wordsPerPhrase: 4,
    perWordHighlight: true,
    fade: "",
  },
  brand_callout: {
    primary: "&H00FFFFFF",
    accent: "&H0021C2FF",   // warm gold (BGR)
    outline: 3,
    fontScale: 1.0,
    wordsPerPhrase: 3,
    perWordHighlight: true,
    fade: "",
  },
  narrative: {
    primary: "&H00FFFFFF",
    accent: "&H00FFFFFF",
    outline: 2,
    fontScale: 0.85,
    wordsPerPhrase: 6,
    perWordHighlight: false,
    fade: "\\fad(150,120)",
  },
};

function assTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(Math.min(99, cs)).padStart(2, "0")}`;
}

function escapeAssText(text: string): string {
  // Braces open override blocks; backslash starts tags; newlines are \N
  return text.replace(/\\/g, "＼").replace(/\{/g, "(").replace(/\}/g, ")").replace(/[\r\n]+/g, " ");
}

interface PhraseWord {
  word: string;
  start: number;
  end: number;
}

/** Re-chunk caption segments into short phrases using word timing. Segments
 *  without word timing pass through as single phrases. */
function toPhrases(segments: CaptionSegment[], wordsPerPhrase: number): Array<{ words: PhraseWord[]; start: number; end: number; text: string }> {
  const phrases: Array<{ words: PhraseWord[]; start: number; end: number; text: string }> = [];
  for (const seg of segments) {
    if (seg.words && seg.words.length > 0) {
      for (let i = 0; i < seg.words.length; i += wordsPerPhrase) {
        const chunk = seg.words.slice(i, i + wordsPerPhrase);
        const start = chunk[0].start;
        // Hold the phrase until the next chunk begins (or the segment ends)
        const next = seg.words[i + wordsPerPhrase];
        const end = next ? next.start : Math.max(chunk[chunk.length - 1].end, start + 0.6);
        phrases.push({ words: chunk, start, end, text: chunk.map((w) => w.word).join(" ") });
      }
    } else {
      phrases.push({
        words: [],
        start: seg.startTime,
        end: Math.max(seg.endTime, seg.startTime + 0.6),
        text: seg.text,
      });
    }
  }
  return phrases;
}

/**
 * Build a complete .ass document for the clip.
 *
 * @param segments  clip-relative caption segments (words optional)
 * @param styleName one of the UI style options; unknown values → "highlight"
 * @param config    output dimensions (ASS PlayRes = pixel-exact styling)
 */
export function buildAssSubtitles(
  segments: CaptionSegment[],
  styleName: string,
  config: { targetWidth: number; targetHeight: number; aspectRatio: string },
): string | null {
  if (!segments || segments.length === 0) return null;
  const spec = STYLES[(styleName as CaptionStyleName)] ?? STYLES.highlight;

  const baseSize = Math.round((config.aspectRatio === "9:16" ? config.targetHeight * 0.042 : config.targetHeight * 0.05) * spec.fontScale);
  // Lower-third margin — mirrors the drawtext y placement (~82% down)
  const marginV = Math.round(config.targetHeight * 0.14);

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${config.targetWidth}`,
    `PlayResY: ${config.targetHeight}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Fontname "Sans" resolves through fontconfig to whatever the container
    // has — same mechanism the working drawtext path relies on.
    `Style: Cap,Sans,${baseSize},${spec.primary},${spec.primary},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${spec.outline},1,2,40,40,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events: string[] = [];
  const phrases = toPhrases(segments, spec.wordsPerPhrase);

  for (const phrase of phrases) {
    if (phrase.end <= phrase.start) continue;

    if (!spec.perWordHighlight || phrase.words.length === 0) {
      // One event for the whole phrase
      events.push(
        `Dialogue: 0,${assTime(phrase.start)},${assTime(phrase.end)},Cap,,0,0,0,,{${spec.fade}}${escapeAssText(phrase.text)}`,
      );
      continue;
    }

    // One event per word-window: the full phrase stays on screen, the
    // active word renders in the accent colour with a bold pop.
    for (let wi = 0; wi < phrase.words.length; wi++) {
      const w = phrase.words[wi];
      const winStart = wi === 0 ? phrase.start : w.start;
      const winEnd = wi === phrase.words.length - 1 ? phrase.end : phrase.words[wi + 1].start;
      if (winEnd <= winStart) continue;

      const rendered = phrase.words
        .map((pw, i) =>
          i === wi
            ? `{\\c${spec.accent}\\b1\\fscx108\\fscy108}${escapeAssText(pw.word)}{\\c${spec.primary}\\b0\\fscx100\\fscy100}`
            : escapeAssText(pw.word),
        )
        .join(" ");
      events.push(`Dialogue: 0,${assTime(winStart)},${assTime(winEnd)},Cap,,0,0,0,,${rendered}`);
    }
  }

  if (events.length === 0) return null;
  return `${header}\n${events.join("\n")}\n`;
}

/** Escape a filesystem path for use inside an ffmpeg filtergraph value. */
export function escapeAssFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
