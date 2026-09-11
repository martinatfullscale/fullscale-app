/**
 * Find a secret whatever the operator named it.
 *
 * Environment variable names are CASE-SENSITIVE on Linux, and every secrets
 * panel — Replit's included — invites you to type "Fal_API_Key" or
 * "Pexels API Key". Code that reads process.env.FAL_KEY then sees nothing,
 * the feature reports itself as unconfigured, and the operator is looking
 * straight at the key in the UI being told it is missing.
 *
 * That exact failure cost this project days: the scanner had already learned
 * the lesson and grown a private resolver for Gemini (see scanner_v2.ts), but
 * every OTHER integration kept doing an exact match. So stock search, AI
 * generation and cutaway suggestions all reported "not configured" on a
 * deployment where the keys were genuinely present — and the diagnosis kept
 * coming back as "your key isn't set", which was wrong and wasted the
 * operator's time twice.
 *
 * This generalises the resolver. Match on the NAME reduced to letters only, so
 * FAL_KEY, Fal_Key, fal-key and "Fal Key" all resolve to the same secret.
 *
 * Never returns or logs a value — callers get the value, and separately the
 * NAME it was found under, so boot logs and status screens can be specific
 * without leaking anything.
 */

/** Letters only, lowercased: "Fal_API_Key" -> "falapikey". */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A value is only "real" if it is long enough to be a credential and is not
 * Replit's proxy placeholder. An empty string in a secrets panel is a very
 * common way to have a variable that exists and means nothing.
 */
function looksReal(v: string | undefined): v is string {
  return !!v && v.trim().length >= 12 && !v.includes("DUMMY");
}

export interface ResolvedKey {
  value: string;
  /** The env var name it was actually found under. Safe to log. */
  source: string;
}

/**
 * Resolve the first of `names` present in the environment, trying exact
 * matches first (cheap, predictable) then a normalized sweep.
 *
 * @param names Accepted spellings, most canonical first.
 */
export function resolveKey(names: readonly string[]): ResolvedKey | null {
  for (const name of names) {
    if (looksReal(process.env[name])) {
      return { value: process.env[name]!.trim(), source: name };
    }
  }
  const wanted = new Set(names.map(normalize));
  for (const name of Object.keys(process.env)) {
    if (wanted.has(normalize(name)) && looksReal(process.env[name])) {
      return { value: process.env[name]!.trim(), source: name };
    }
  }
  return null;
}

/** Convenience: the value alone, or undefined. */
export function keyValue(names: readonly string[]): string | undefined {
  return resolveKey(names)?.value;
}

/** Convenience: is any spelling of this secret present and plausible? */
export function hasKey(names: readonly string[]): boolean {
  return resolveKey(names) !== null;
}

/**
 * The accepted spellings for every secret that gates a user-facing feature.
 *
 * Aliases are the names an operator plausibly types, not every permutation —
 * the normalized sweep already handles case and separators, so these only need
 * to cover genuinely DIFFERENT words (FAL_KEY vs FAL_API_KEY).
 */
export const KEY_ALIASES = {
  fal: ["FAL_KEY", "FAL_API_KEY", "FALAI_API_KEY", "FAL_AI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  pexels: ["PEXELS_API_KEY", "PEXELS_KEY"],
  pixabay: ["PIXABAY_API_KEY", "PIXABAY_KEY"],
  deepgram: ["DEEPGRAM_API_KEY", "DEEPGRAM_KEY"],
  stripeSecret: ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"],
  stripeWebhook: ["STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SIGNING_SECRET"],
  openai: ["OPENAI_API_KEY"],
} as const;
