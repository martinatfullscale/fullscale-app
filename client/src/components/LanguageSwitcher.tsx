import { useEffect, useRef, useState } from "react";
import { Globe, Check } from "lucide-react";
import { useLocation } from "wouter";
import { hasTranslation, LOCALE_LABEL, OFFERED, SUPPORTED, useLocale, type Locale } from "@/lib/locale";

/**
 * The language control, top right, on every page.
 *
 * Rendered INLINE, inside each translated page's own nav.
 *
 * It began as a single fixed element at the app root, on the reasoning that
 * this codebase has no shared header and adding a button to each of six
 * would drift. Two things overturned that. Scoping the switcher to the four
 * pages that actually have Arabic cut the insertion points from six to four —
 * exactly the pages whose navs were being edited anyway. And a fixed control
 * in the top corner sits precisely where every one of those navs already puts
 * its buttons: it overlapped "Sign In" by 59px at 1280, in both directions,
 * because the trailing edge is the right in English and the left in Arabic and
 * the nav's actions move with it.
 *
 * A floating control cannot dodge that. It belongs in the row.
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
    <div ref={wrapRef} className={`relative ${className}`} data-testid="language-switcher">
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
          // z above the nav so the menu is not clipped by a sticky header.
          className="absolute z-50 mt-1.5 min-w-[9rem] rounded-lg border border-white/15 bg-background/95 backdrop-blur shadow-xl overflow-hidden"
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
