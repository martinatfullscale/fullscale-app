import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DirectionProvider } from "@radix-ui/react-direction";
import { useLocation } from "wouter";
import i18n, { hasTranslation, LOCALE_LABEL, OFFERED, persistLocale, readStoredLocale, RTL_LOCALES, SUPPORTED, type Locale } from "./i18n";

/**
 * Locale and DIRECTION, from one source.
 *
 * Direction cannot be left to CSS alone here, for two reasons the codebase
 * makes non-negotiable:
 *
 *  1. Radix reads direction from a React context, never from the DOM
 *     (@radix-ui/react-direction is `localDir || globalDir || "ltr"`). Without
 *     a DirectionProvider, 27 primitives — Select, DropdownMenu, Tabs, Slider,
 *     ScrollArea, Toast — stay internally LTR while the CSS around them flips:
 *     arrow keys run backwards and submenus open on the wrong side.
 *
 *  2. `direction` decides a scroll container's scrollLeft ORIGIN. Both video
 *     editors convert a pointer to a time with `clientX - rect.left +
 *     scrollLeft` (clip-studio/Timeline.tsx, reel-editor/ReelTimeline.tsx).
 *     Under an inherited RTL that arithmetic silently returns the wrong
 *     timestamp — no error, nothing visibly broken, just cuts in the wrong
 *     place. `LtrIsland` below is the guard, and it has to be in place the
 *     moment `dir` can become "rtl" — which is why both live in this file.
 */

interface LocaleCtx {
  locale: Locale;
  dir: "ltr" | "rtl";
  setLocale: (next: Locale) => void;
}

const Ctx = createContext<LocaleCtx>({ locale: "en", dir: "ltr", setLocale: () => {} });

export const useLocale = () => useContext(Ctx);
export const dirOf = (locale: string): "ltr" | "rtl" =>
  RTL_LOCALES.includes(locale.split("-")[0]) ? "rtl" : "ltr";

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const { i18n: inst } = useTranslation();
  const [location] = useLocation();
  const [locale, setLocaleState] = useState<Locale>(
    () => (readStoredLocale() ?? (inst.resolvedLanguage as Locale) ?? "en"),
  );
  /* Direction follows the ROUTE, not just the locale. Five of the nine public
     pages have no Arabic module yet, and English text in an RTL page is not
     neutral — paragraphs right-align, sentence-final punctuation jumps to the
     left, lists reverse. It reads as broken rather than as untranslated. An
     untranslated route therefore renders LTR while keeping the language
     preference, so the switcher still says العربية and the next translated
     page a visitor opens is Arabic again. */
  const dir = hasTranslation(location) ? dirOf(locale) : "ltr";

  /* lang follows the same rule as dir, and for a sharper reason: it is a
     promise about what language the text on this page IS. On an untranslated
     route the text is English, so lang="ar" would tell a screen reader to
     pronounce English words with Arabic phonetics — unintelligible — and tell
     Google the page is Arabic when it is not. */
  const pageLocale = hasTranslation(location) ? locale : "en";

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("lang", pageLocale);
    root.setAttribute("dir", dir);
    // Arabic needs more vertical room than Latin at the same nominal size, and
    // it has no lowercase, so the tight leading this design uses reads as
    // cramped. Scoped to the <html> element so nothing else has to know.
    root.classList.toggle("locale-ar", pageLocale === "ar");
    if (inst.resolvedLanguage !== locale) inst.changeLanguage(locale);
  }, [locale, pageLocale, dir, inst]);

  const setLocale = useCallback((next: Locale) => {
    if (!(SUPPORTED as readonly string[]).includes(next)) return;
    persistLocale(next);
    setLocaleState(next);
  }, []);

  const value = useMemo(() => ({ locale, dir, setLocale }), [locale, dir, setLocale]);

  return (
    <Ctx.Provider value={value}>
      <DirectionProvider dir={dir}>{children}</DirectionProvider>
    </Ctx.Provider>
  );
}

/**
 * A subtree pinned left-to-right inside an otherwise RTL page.
 *
 * For the video editors and anything else whose horizontal axis is a MACHINE
 * COORDINATE — media time, or a pixel position that is fed to ffmpeg. Media
 * time runs left to right in every professional tool in every locale; Adobe's
 * own Middle East build ships an English LTR interface with Arabic text
 * support rather than mirroring the timeline.
 *
 * Sets both the DOM attribute (so CSS and scrollLeft behave) and the Radix
 * context (so a Slider inside does not invert against the CSS around it).
 */
export function LtrIsland({
  children,
  className,
  style,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <DirectionProvider dir="ltr">
      <div dir="ltr" className={className} style={style} {...rest}>
        {children}
      </div>
    </DirectionProvider>
  );
}

export { hasTranslation, LOCALE_LABEL, OFFERED, SUPPORTED, type Locale };
export default i18n;
