/**
 * Which routes actually have Arabic copy — read by BOTH the client and the
 * server, because both have to agree.
 *
 * The client uses it to decide a page's direction; the server uses it to
 * decide the served <html lang>/<dir> and whether to emit an hreflang
 * alternate. Two separate lists would drift, and the failure would be silent
 * and bad: an hreflang telling Google a page is available in Arabic while the
 * page renders English.
 *
 * Four of the nine public pages are translated. Add a path here the moment its
 * content module exists — that one edit turns on the direction, the lang
 * attribute and the search signal together.
 */
export const LOCALIZED_PATHS: readonly string[] = [
  "/",
  "/home",
  "/about",
  "/stories",
  "/brands",
  "/creates",
  "/content",
];

export function hasTranslation(pathname: string): boolean {
  const clean = (pathname.split("?")[0] || "/").replace(/\/+$/, "") || "/";
  return LOCALIZED_PATHS.includes(clean);
}
