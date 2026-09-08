import { useEffect, useRef, useState } from "react";
import { Globe, Check } from "lucide-react";
import { useLocation } from "wouter";
import { hasTranslation, LOCALE_LABEL, OFFERED, SUPPORTED, useLocale, type Locale } from "@/lib/locale";

/**
 * The language control, top right, on every page.
 *
 * Rendered ONCE at the app root as a fixed element rather than added to each
 * header. There is no shared marketing header in this codebase — Brands,
 * FullScaleCreates, FullScaleStudio and StudioPricing each carry a
 * byte-identical copy-pasted <header>, Landing and Story have their own <nav>,
 * and fifteen pages have no header at all. Adding a button to each would mean
 * six insertion points that immediately drift, and would still miss half the
 * app.
 *
 * Not a Radix DropdownMenu, deliberately: with two languages a menu is one
 * extra interaction for no information, and this way the control has no
 * dependency on the direction context it is partly responsible for setting.
 */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  /** Whatever is offered, plus whatever the visitor is already in — so someone
   *  previewing with ?lang=ar can still see and leave it. */
  const choices = SUPPORTED.filter((l) => OFFERED.includes(l) || l === locale);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Nothing to switch between: don't put a control on every page that opens a
  // menu with one item in it.
  if (choices.length < 2) return null;

  /* Only where there is something to switch TO.
     Four pages are translated; the other five public routes and the whole
     authenticated app are English. Offering the control there would be an
     invitation to a language the page cannot speak — the visitor clicks,
     nothing changes, and the product looks broken rather than partial.
     This does NOT make the fallback in LocaleProvider redundant: someone who
     switches to Arabic here and then navigates to an untranslated page carries
     the preference with them in the cookie, and it is that page's direction
     the fallback protects. Two different problems. */
  if (!hasTranslation(location)) return null;

  return (
    // inset-inline-end, not right: the control itself has to sit on the
    // trailing edge in both directions, which is the one place in this file
    // where "top right" means "top start-of-nothing, end-of-line".
    <div
      ref={wrapRef}
      className={`fixed top-3 z-[60] ${className}`}
      style={{ insetInlineEnd: "0.75rem" }}
      data-testid="language-switcher"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Language: ${LOCALE_LABEL[locale]}`}
        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border border-white/15 bg-background/80 backdrop-blur text-[12px] font-medium text-foreground/90 hover:text-white hover:border-white/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        data-testid="button-language"
      >
        <Globe className="w-3.5 h-3.5 shrink-0" />
        <span>{LOCALE_LABEL[locale]}</span>
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Language"
          className="absolute mt-1.5 min-w-[9rem] rounded-lg border border-white/15 bg-background/95 backdrop-blur shadow-xl overflow-hidden"
          style={{ insetInlineEnd: 0 }}
        >
          {choices.map((l) => {
            const active = l === locale;
            return (
              <li key={l}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  // Each option is written in ITS OWN language and direction —
                  // a reader looking for Arabic is looking for العربية, not for
                  // the word "Arabic" written in English.
                  dir={l === "ar" ? "rtl" : "ltr"}
                  lang={l}
                  onClick={() => { setLocale(l as Locale); setOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] text-start hover:bg-white/10 transition-colors ${
                    active ? "text-primary" : "text-foreground/90"
                  }`}
                  data-testid={`button-language-${l}`}
                >
                  <Check className={`w-3.5 h-3.5 shrink-0 ${active ? "opacity-100" : "opacity-0"}`} />
                  {LOCALE_LABEL[l as Locale]}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
