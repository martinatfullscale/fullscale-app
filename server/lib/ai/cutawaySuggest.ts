/**
 * "What should go on screen, and when."
 *
 * The editor already had two capable halves that never met: a stock search and
 * an AI generator, both of which ask the creator to invent a query from a blank
 * box, and a copilot that could propose a b-roll prompt but carried NO
 * timestamp — so it could say what, never where. The creator was left to watch
 * their own clip, decide a cutaway belonged at 0:14, think up search terms, and
 * hand-place the result.
 *
 * This closes that gap: read the transcript first, then propose specific
 * moments with the search query AND the generation prompt already written, each
 * anchored to the seconds it covers. Accepting one is a click.
 *
 * Deliberately conservative about how many it proposes. A cutaway every few
 * seconds is worse than none — it reads as a stock-footage reel rather than a
 * person talking — so the model is told to earn each one and we cap the result.
 */

import Anthropic from "@anthropic-ai/sdk";
import { keyValue, hasKey, KEY_ALIASES } from "../envKeys";

const MODEL = "claude-sonnet-4-5-20250929";
/** Above this the clip stops being a talking head with support and becomes a slideshow. */
const MAX_SUGGESTIONS = 6;
/** A cutaway shorter than this is a flash; longer and the speaker disappears. */
const MIN_SEC = 1.5;
const MAX_SEC = 4.0;

export interface TranscriptLine { start: number; end: number; text: string }

export interface CutawaySuggestion {
  /** Seconds, relative to the same clock the caller's lines use. */
  tStart: number;
  tEnd: number;
  /** The words on screen at that moment — so the creator can judge the call. */
  quote: string;
  /** Why a visual helps HERE, in one line. */
  why: string;
  /** Ready to paste into stock search. Concrete nouns, no adjectives. */
  stockQuery: string;
  /** Ready to paste into the image/video generator. */
  aiPrompt: string;
  /** "stock" when a real photo is the honest choice; "ai" when it is abstract. */
  prefer: "stock" | "ai";
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    const apiKey = keyValue(KEY_ALIASES.anthropic);
    const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;
    const config: Record<string, any> = {};
    if (apiKey) config.apiKey = apiKey;
    if (baseURL) config.baseURL = baseURL;
    client = new Anthropic(config);
  }
  return client;
}

export function suggestAvailable(): boolean {
  return hasKey(KEY_ALIASES.anthropic) || !!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
}

const SYSTEM = `You place cutaways in short-form video.

You get a transcript with timestamps. Return the moments where showing something
would genuinely help the viewer — a place being named, an object being
described, a number or comparison worth seeing, a story beat that has a clear
image.

Rules that matter more than coverage:
- EARN each one. Most seconds of a good talking-head clip need no cutaway. It is
  correct to return two, or none. Never pad to fill a quota.
- Never cut away from the speaker's own face at an emotional beat, a punchline,
  or a direct address to camera.
- Space them out. Two cutaways inside four seconds of each other is wrong.
- stockQuery is for a stock library: 2-4 concrete nouns, no adjectives, no
  proper nouns a library will not have. "tokyo street night" not "the bustling
  energy of Tokyo".
- aiPrompt is for an image model: one vivid sentence, describe the frame, no
  text or logos in the image, no named real people.
- prefer "stock" when a real photograph is the honest choice (places, everyday
  objects, crowds). prefer "ai" when the idea is abstract, stylised, or
  specific in a way no library will hold.

Return ONLY a JSON array. No prose, no code fence. Each element:
{"tStart":number,"tEnd":number,"quote":string,"why":string,"stockQuery":string,"aiPrompt":string,"prefer":"stock"|"ai"}`;

/**
 * Propose timed cutaways for one clip.
 *
 * Fails soft and returns [] — this is an assistive layer over an editor that
 * works without it, so a model outage should cost the creator a suggestion
 * list, never the ability to edit.
 */
export async function suggestCutaways(
  lines: TranscriptLine[],
  opts: { clipStart?: number; clipEnd?: number; max?: number } = {},
): Promise<CutawaySuggestion[]> {
  if (!suggestAvailable() || lines.length === 0) return [];

  const lo = opts.clipStart ?? lines[0].start;
  const hi = opts.clipEnd ?? lines[lines.length - 1].end;
  const within = lines.filter((l) => l.end > lo && l.start < hi);
  if (within.length === 0) return [];

  // Timestamps are given relative to the clip, because that is the clock the
  // editor's playhead and the render's overlay windows both use. Handing the
  // model absolute source time invites off-by-clipStart errors that land a
  // cutaway in the wrong place with no obvious cause.
  const script = within
    .map((l) => `[${(l.start - lo).toFixed(1)}-${(l.end - lo).toFixed(1)}] ${l.text.trim()}`)
    .join("\n");

  const cap = Math.min(opts.max ?? MAX_SUGGESTIONS, MAX_SUGGESTIONS);

  let raw = "";
  try {
    const res = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `Clip is ${(hi - lo).toFixed(1)}s long. At most ${cap} cutaways, fewer if fewer are earned.\n\n${script}`,
      }],
    });
    raw = res.content.map((c: any) => (c.type === "text" ? c.text : "")).join("");
  } catch (err: any) {
    console.warn(`[CutawaySuggest] model call failed: ${err?.message}`);
    return [];
  }

  // Models sometimes wrap JSON in a fence despite instructions. Take the first
  // array in the response rather than trusting the whole string to parse.
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    console.warn("[CutawaySuggest] no JSON array in response");
    return [];
  }

  let parsed: any[];
  try {
    parsed = JSON.parse(match[0]);
  } catch (err: any) {
    console.warn(`[CutawaySuggest] unparseable JSON: ${err?.message}`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const clipLen = hi - lo;
  const out: CutawaySuggestion[] = [];
  for (const p of parsed) {
    const tStart = Number(p?.tStart);
    let tEnd = Number(p?.tEnd);
    if (!Number.isFinite(tStart) || !Number.isFinite(tEnd)) continue;

    // Clamp to the clip and to a sane duration. A model that returns a 30s
    // cutaway on a 20s clip would otherwise blank the speaker entirely.
    const s = Math.max(0, Math.min(tStart, Math.max(0, clipLen - MIN_SEC)));
    tEnd = Math.min(Math.max(tEnd, s + MIN_SEC), Math.min(s + MAX_SEC, clipLen));
    if (tEnd - s < MIN_SEC) continue;

    // Enforce spacing here rather than trusting the instruction: overlapping
    // cutaways compile into overlapping full-frame windows, and the last one
    // wins silently.
    if (out.some((o) => s < o.tEnd + 1.0 && tEnd > o.tStart - 1.0)) continue;

    const stockQuery = String(p?.stockQuery ?? "").trim().slice(0, 80);
    const aiPrompt = String(p?.aiPrompt ?? "").trim().slice(0, 400);
    if (!stockQuery && !aiPrompt) continue;

    out.push({
      tStart: Math.round(s * 10) / 10,
      tEnd: Math.round(tEnd * 10) / 10,
      quote: String(p?.quote ?? "").trim().slice(0, 200),
      why: String(p?.why ?? "").trim().slice(0, 160),
      stockQuery,
      aiPrompt,
      prefer: p?.prefer === "ai" ? "ai" : "stock",
    });
    if (out.length >= cap) break;
  }

  return out.sort((a, b) => a.tStart - b.tStart);
}
