import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import HttpBackend from "i18next-http-backend";

/**
 * i18n bootstrap.
 *
 * Catalogs are served as static JSON from client/public/locales/<lng>/<ns>.json
 * rather than bundled. The client is a single ~2.8MB chunk with no code
 * splitting, and folding a second language into it would make every English
 * visitor pay for Arabic they never load.
 *
 * `keySeparator: false` and `nsSeparator: false` on purpose: keys here are
 * English sentences, and a default "." separator would treat every full stop
 * in a key as a nesting level.
 */
export const SUPPORTED = ["en", "ar"] as const;
export type Locale = (typeof SUPPORTED)[number];

/**
 * Which locales a visitor may actually be offered.
 *
 * Arabic is BUILT but not REVIEWED. Every Arabic string in this repo is a
 * machine draft written so the RTL layout could be built and tested against
 * text of realistic length — it is scaffolding that happens to be in Arabic,
 * not a translation. One of the six glossary terms in the first pass was
 * simply invented (see docs/GLOSSARY_ARABIC.md §1).
 *
 * Shipping that to an Arabic-speaking visitor is worse than shipping nothing:
 * a site written in confident, wrong Arabic tells a reader the company does
 * not know or does not care, and that is the opposite of the impression the
 * whole exercise exists to make.
 *
 * So Arabic is reachable — with an explicit ?lang=ar, for the team and for the
 * reviewer to work against — but it is not offered in the switcher. Flip this
 * to include "ar" when a native reviewer has signed off, and not before.
 */
export const OFFERED: readonly Locale[] = ["en"];
export const RTL_LOCALES: readonly string[] = ["ar", "he", "fa", "ur"];

export const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  ar: "العربية",
};

/** The cookie the server also reads, so a per-locale HTML shell can be served
 *  later without the client having to ask twice. */
export const LOCALE_COOKIE = "fs_lang";

export function readStoredLocale(): Locale | null {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("lang");
    if (fromQuery && (SUPPORTED as readonly string[]).includes(fromQuery)) return fromQuery as Locale;
    const m = document.cookie.match(/(?:^|;\s*)fs_lang=([^;]+)/);
    if (m && (SUPPORTED as readonly string[]).includes(m[1])) return m[1] as Locale;
  } catch { /* private mode — fall through to the browser's own preference */ }
  return null;
}

export function persistLocale(locale: Locale) {
  try {
    // A year, site-wide, Lax: it is a display preference, never a credential.
    document.cookie = `${LOCALE_COOKIE}=${locale};path=/;max-age=31536000;samesite=lax`;
  } catch { /* ignore */ }
}

i18n
  .use(HttpBackend)
  .use(initReactI18next)
  .init({
    lng: readStoredLocale() ?? undefined,
    fallbackLng: "en",
    supportedLngs: SUPPORTED as unknown as string[],
    // "en-GB" and "en-US" both resolve to "en" rather than 404ing the backend.
    load: "languageOnly",
    ns: ["common"],
    defaultNS: "common",
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    backend: { loadPath: "/locales/{{lng}}/{{ns}}.json" },
    // The English catalog IS the source text, so a missing Arabic key renders
    // the English sentence rather than the key. Never show a reader a dotted
    // identifier because a translator has not reached that line yet.
    parseMissingKeyHandler: (key) => key,
    react: { useSuspense: false },
  });

export default i18n;
