# Arabic FullScale — the plan

*Everything below was re-verified against the working tree on branch `claude/fullscale-app-tweaks`. Where I quote a count I ran it myself.*

---

## 1. What you are actually asking for

You asked for a language button. The button is half a day. What sits behind it is two jobs with very different price tags, and they are usually confused with each other.

**Job A — translation.** ~3,200 user-visible strings in the client (working band 3,000–3,500). The crude grep you already have found 569; the real number is ~5.7x that because most of this app's copy is not a JSX text node — it is in `placeholder=`/`title=`/`aria-label=` attributes, in the ~316 `toast({...})` call sites, in template literals, and in prose arrays like `Story.tsx:104-134`. Plus ~865 `res.status(...).json(...)` sites in `server/routes.ts` alone (I counted them), of which ~640 are user-facing.

**Job B — direction.** This is the part that is not obvious, and it is the one that decides whether the project is worth doing.

Measured, just now, across `client/src`:

| | count |
|---|---|
| `ml-` | 100 |
| `mr-` | 181 |
| `pl-` / `pr-` | 50 / 42 |
| `left-` / `right-` | 134 / 105 |
| `text-left` / `text-right` | 44 / 48 |
| `border-l` / `border-r` | 25 / 50 |
| `translate-x` | 36 |
| **logical equivalents (`ms-`,`me-`,`ps-`,`pe-`,`start-`,`end-`)** | **0** |
| **`rtl:` variants** | **0** |
| **`dir=` attributes anywhere** | **0** |
| **`Intl.*` calls in the client** | **0** |

~779 physical directional tokens, zero logical ones, zero locale-aware formatters. `client/index.html:2` is `<html lang="en">`, hardcoded, for all 40 routes.

**The ratio.** Translation is linear, parallelisable, and can be bought — a contractor works through a JSON file and you can ship half of it. Direction is not: it is ~779 edits that each need a human judgement about whether the side is *reading order* or *physical fact*, plus a set of things that break silently with no error. My estimate is that translating the public site is ~15 engineering days and the direction work behind the full app is ~25–30, and the direction work is the part that produces bugs you cannot see in a screenshot.

**The three things that will surprise you, all verified:**

1. **`dir="rtl"` does nothing for 27 Radix packages.** `node_modules/@radix-ui/react-direction/dist/index.mjs:9-12` is literally `return localDir || globalDir || "ltr"` where `globalDir` comes from a React context. It never reads the DOM. There is no `DirectionProvider` in `client/src`. So Select, DropdownMenu, Tabs, Slider, ScrollArea, Toast all stay internally LTR — arrow keys run backwards, submenus open the wrong side, slider drag inverts — while the CSS around them flips.

2. **The moment `dir="rtl"` inherits, both video editors silently compute the wrong time.** `client/src/components/clip-studio/Timeline.tsx:154` and `client/src/components/reel-editor/ReelTimeline.tsx:79` both do `clientX - r.left + el.scrollLeft`. In an RTL scroll container `scrollLeft` is 0 at the *right* edge and goes negative. Every scrub, drag, trim, razor cut and drop reads a wrong timestamp. No console error. No visual glitch until someone drags something.

3. **Neither of your fonts has a single Arabic glyph.** `client/src/index.css:1` loads Outfit + Inter. Outfit ships `latin`/`latin-ext` only; Inter adds Greek/Cyrillic/Vietnamese. Arabic falls through to the generic `sans-serif` — Geeza Pro on Mac, Tahoma on Windows, tofu on some Android. Your typography would be uncontrolled and different on every platform.

---

## 2. Recommended scope

**Ship Arabic on the public site. Do not ship Arabic on the product yet.**

Reading `client/src/App.tsx:205-234`, exactly six surfaces are reachable logged out, totalling ~849 strings — **26% of the total**:

| surface | strings | verdict |
|---|---|---|
| Marketing (`Landing`, `Brands`, `FullScaleCreates`, `Story`, `FullScaleStudio`, `StudioPricing`, `Footer`) | 397 | **ship Arabic** |
| Auth + waitlist gates (`AuthPage`, `WaitlistPage`, `StudioWaitlistPage`, `ComingSoon`, `not-found`) | 94 | **ship Arabic** |
| Public creator permalinks (`/c/:slug`, `/s/:slug`) | 101 | **ship Arabic** |
| Brand funnel (`BrandOnboarding`, `BrandSignUp`) | 121 | ship only if brands are the target — see the decision below |
| Legal (`Privacy` 480 lines, `Terms`) | 83 | **leave English**, with "the English version governs" |
| FullScale Studio (`StudioUpload`, `StudioLibrary`) | 53 | defer |

The other **2,350 strings across 29 authenticated pages** stay English in phase 1.

**Why this split and not "translate everything".** The public 849 are the cheapest strings in the codebase to translate *and* the cheapest to make RTL. They have almost no interpolation: the plural ternaries (~35 sites), the currency formatters, the 24 separate mm:ss implementations, the relative-time ladders and the two video timelines are all concentrated behind the login. You get the entire addressable audience's first impression for a fifth of the string count and a much smaller fraction of the direction risk.

**Three explicit exclusions, permanently:**

- **Admin pages** (`AdminMeasurement`, `AdminDataInventory`, `AdminPlacements`, `AdminSignups`, `AdminCreatorIntelligence`) — 228 strings, 7% of the total, audience is your team. `AdminMeasurement.tsx` alone has eight inline plural ternaries; translating it would front-load the hardest i18n work onto the readers who need it least. Also excludes the ~1,010 words of prose in `server/lib/crossPlatformAnalysis.ts` that only `AdminDataInventory.tsx:389` renders.
- **Legal.** `Privacy.tsx` is 480 lines of policy citing the YouTube API ToS, stitched with inline links so single sentences span 3–5 JSX nodes. A machine-translated privacy policy is a second, differently-worded contract. Either budget a reviewed legal translation or state that English governs.
- **The two video editors' timelines.** Section 4.

**The seam, handled deliberately.** An Arabic visitor who signs up hits an English product. The one option that reads as broken rather than phased is silently persisting a language the app then ignores. So: the switcher is present on public routes and on `/settings`; past `/auth` the app is English and says so once, in Arabic, in the sidebar. That is honest and it is cheap.

> **The one decision only you can make:** *are you localising to recruit Arabic-speaking **creators** (supply — which makes phase 3 `Dashboard` + `Library`, ~730 strings) or to sell to Arabic-speaking **brands** (demand — which makes phase 3 `BrandMarketplace` + `BrandOnboarding` + `BrandPlacementRequestModal`, ~390 strings and a completely different glossary)?*

They are separate products with separate left rails (`Sidebar.tsx` vs `BrandSidebar.tsx`) and users are actively bounced between them at `App.tsx:179-194`. Answering this changes phase 3 entirely and changes nothing about phases 1 and 2 — which is why phases 1 and 2 can start before you answer.

---

## 3. Architecture

### 3.1 Library: react-i18next, with English sentences as keys

`i18next` + `react-i18next` + `i18next-browser-languagedetector` + `i18next-http-backend`. Catalogs as plain JSON at `client/public/locales/{lng}/{ns}.json`.

**Bundle size is not the argument** and I want to kill it before someone raises it. The built client is a single **2,783,227-byte** chunk with zero code splitting (`React.lazy` appears nowhere; `App.tsx:17-56` eagerly imports all 40 pages). i18next is ~40KB against that — 1.4%. Noise.

**The real argument is cost-per-wrap.** No library extracts your strings; `i18next-parser`, `@formatjs/cli` and `lingui extract` all scan for *already-wrapped* calls and find zero until a human wraps them. That ~1,500–2,500-call-site cost is identical across every option. So judge on what makes each wrap cheap. Configure i18next with `keySeparator: false, nsSeparator: false` and the key *is* the English sentence: `t("Sync failed")`, not `t("library.toast.syncFailed")`. You get Lingui's headline ergonomic with no build-toolchain change.

**Why not Lingui** (the closest call): its ergonomics come from a Babel macro. `@vitejs/plugin-react` is 4.7.0 so it is technically available — but that adds a full Babel pass over ~59,500 lines of client TS/TSX in a build already running at `NODE_OPTIONS=--max-old-space-size=4096` (`package.json:8`) on Replit. Worse, Lingui compiles catalogs to JS modules, so every translator correction becomes a rebuild and a redeploy. With i18next, a fixed `ar/common.json` drops into `client/public/locales/` and ships through the existing `express.static` mount at `server/static.ts:74` with no rebuild. Lingui is the better library in the abstract and the worse one for this host.

**Why not hand-rolled** (`contexts/pitch-mode-context.tsx` is the house pattern, and there are only two locales): Arabic has **six** CLDR plural categories against English's two, and "few" vs "many" turns on `n mod 100` landing in 3–10 vs 11–99. You would be hand-wiring `Intl.PluralRules` + interpolation + namespace lazy-loading + missing-key fallback + a file format — ~300 lines you now own and must debug in a language you do not read. And no translation tool imports a format you invented.

**Trade-off I am accepting:** i18next's API is loose — a typo'd key renders the key itself, silently, in production, where Lingui would have failed at build. Mitigate with `saveMissing: true` in dev plus a CI grep asserting every `t()` literal exists in `en`. Second accepted cost: natural-language keys mean English copy edits churn the catalog and orphan the Arabic. The discipline is that copy edits go through the catalog, not the JSX.

**One extraction rule that matters more than the library choice.** 25+ sentences are split across JSX nodes around inline links — `Privacy.tsx:240,253,262,270-271`, `AuthPage.tsx:483-485` ("By continuing, you agree to our … and …"), `BrandSignUp.tsx:238,245,247`, `Settings.tsx:1061,1064`. Arabic reorders clauses relative to English, so translating the fragments puts the link in the wrong clause. These need `<Trans>` with markup placeholders. A bare key-value lookup looks adequate until it hits these, and then the fix is a library swap mid-project.

### 3.2 Routing: cookie first, `/ar` prefix second

`wouter` is 3.3.5 and **does** support `RouterOptions.base` (`node_modules/wouter/types/router.d.ts`). There is no `<Router>` in the tree today — `App.tsx:1` imports only `{ Switch, Route, Redirect, useLocation }` and rides the default. Adding one needs an import alias, because your local component at `App.tsx:110` is already called `Router`.

The SPA fallback is `app.use("*")` at `server/static.ts:86`, so `/ar/anything` already resolves server-side with **zero server change**.

**Recommend:** ship the cookie in phase 1, add `<Router base={locale === "ar" ? "/ar" : ""}>` in phase 2 once Arabic copy is signed off.

- **Not `?lang=ar`:** Google canonicalises it unpredictably *and* every internal link still has to carry the param — same link surgery, worse SEO. Strictly dominated.
- **Not `ar.gofullscale.co`:** cleanest for SEO, loses on operations. A second origin means re-registering OAuth redirect URIs across six providers (`Settings.tsx:606-641` wires Twitch, Facebook, YouTube, TikTok, Twitter, LinkedIn), widening the session cookie to `.gofullscale.co`, a CORS pass, and a second Replit domain — while a Meta App Review is in flight. Reject on operational cost, not merit.

**What the prefix costs, named honestly.** `base` rewrites `<Link>` and the `useLocation` setter and nothing else. I counted **45 raw `<a href="/...">` anchors** (excluding `/api`) and **41 `window.location.href =` assignments**, of which roughly 20 target app routes (`App.tsx:180,193`, `TopBar.tsx:44,46`, `Sidebar.tsx:36`, `BrandSidebar.tsx:45`, `WaitlistPage.tsx:49/68/99/106`, `SavedPlacements.tsx:604/739/751`) — the other ~21 are `/api/*` and Stripe and must **not** be prefixed. Only 26 files import from wouter at all. Each un-prefixed navigation silently drops an Arabic user back into English.

Mitigation that makes it affordable: scope the prefix to public routes only. Most of those anchors live in files you are already opening to translate the copy. The authenticated hard-navigations stay untouched, because those routes have no SEO value.

### 3.3 Persistence: one cookie, `fs_lang`

`Path=/`, `SameSite=Lax`, `Max-Age=31536000`, **not** HttpOnly. Precedence: `/ar` prefix > `fs_lang` > `navigator.language` > `en`.

Three reasons it is a cookie and not `localStorage`, the first decisive:

1. **The server must read it** to pick a per-locale HTML shell (§3.6). `localStorage` is invisible server-side.
2. **It survives full-page navigation.** Six OAuth providers hard-navigate out and back; `use-auth.ts:22` and `lib/auth-utils.ts:15` do full-page redirects that destroy all React state. A cookie rides through; a context does not.
3. **Zero new dependency** — `cookie-parser` is already mounted at `server/index.ts:254`.

**Schema gap, verified.** `shared/models/auth.ts:18-48` — the `users` table has **no** locale column. Without one the server never learns the user's language, which means all 13 email templates in `server/lib/resend.ts` and every notification written at event time have nothing to key off. Add `preferredLocale varchar(8)`. Per your own deploy notes, `db:push` must land *before* the app boots against the new code.

### 3.4 The button: one insertion point, not eight

There is no "top right" in this app. `TopBar.tsx` is imported by exactly **11 of 40 pages** (I counted). Fifteen pages have neither a TopBar nor any `<header>`/`<nav>`. The four marketing pages each carry a byte-identical copy-pasted header (`Brands.tsx:248`, `FullScaleCreates.tsx:156`, `FullScaleStudio.tsx:126`, `StudioPricing.tsx:174`); `Landing.tsx:1363`, `Story.tsx:425`, `Terms.tsx:10`, `Privacy.tsx:8` have their own; `SharedView.tsx` has two (`:337`, `:503`); `BrandOnboarding.tsx` has two (`:481`, `:527`). Twenty-four distinct top-of-page render sites across 22 files.

**Mount `<LanguageSwitcher />` exactly once**, as a sibling of `<Toaster />` inside `App()` (`client/src/App.tsx`, the `App` function at the tail of the file — `<Toaster />` already proves this pattern works app-wide). Fixed position, `inset-block-start: 0; inset-inline-end: 0`, `z-[60]`, with `padding-top: env(safe-area-inset-top)` to match `Landing.tsx:1364`.

One insertion covers all 40 pages including `not-found`, and it cannot be forgotten by whoever writes page 41.

Then exactly three targeted offsets: `AuthPage.tsx:238` and `BrandSignUp.tsx:91` already have close buttons at `absolute top-4 right-4` (a collision), and `TopBar.tsx:95` needs its `px-8` bumped so the switcher clears the notification/role group at `:106`.

`z-[60]` is required: `SharedView.tsx:337`/`:503` are z-50, Radix dialog overlays are z-50, `Landing.tsx:1364` and the public headers are z-20/z-30. Rendering as a direct child of `App()` also keeps it outside every Radix focus trap.

**The alternative I am rejecting:** putting it into the chrome primitives properly (extract a shared `PublicHeader` from the nine copy-pasted headers, add it to `TopBar` and both sidebars). Better-looking, a nine-file refactor performed *before* a single line of i18n, and it still misses `AuthPage`, `BrandSignUp`, `StudioUpload`, `ReelEditor`, `RemixEngine`, `not-found` and the nine sidebar-only pages. Ship the portal now; extract `PublicHeader` later as its own change, when the reward is code health rather than a button.

### 3.5 Fonts — this pass should make loading *faster*, not slower

`client/index.html:44` loads **25 families**. I grepped all 23 non-Inter/Outfit families against `client/src`: every one scores zero references. That request is ~147KB raw / 7.4KB gzipped, 337 `@font-face` rules, and it is render-blocking on the critical path. Separately, `client/src/index.css:1` loads Outfit+Inter via `@import`, which is only discovered *after* index.css downloads — serialising the font fetch behind the CSS fetch.

**Do:** delete `index.html:44` entirely; move the `index.css:1` `@import` into `index.html` as a `<link>` next to the existing preconnects; add Arabic to that single link.

**Pairing: Cairo (display) + IBM Plex Sans Arabic (body).** Append rather than swap:

```css
--font-display: 'Outfit', 'Cairo', sans-serif;
--font-body: 'Inter', 'IBM Plex Sans Arabic', sans-serif;
```

Google ships the Arabic faces with `unicode-range`, so the browser downloads them only when an Arabic codepoint is actually painted — **English visitors pay zero extra bytes and no `:lang()` plumbing is needed**. Fallback is per-character, so "FullScale" and Latin URLs inside an Arabic sentence still render in Outfit/Inter, which a `:lang(ar)` font swap gets wrong.

Cost: ~136KB of Arabic woff2, for Arabic readers only. Net against deleting the 25-family link, this is a win. Cheaper alternative if 136KB is judged too much: Cairo alone for both roles (31KB, variable, differentiate by weight), accepting less display/body contrast than English gets.

**What `:lang(ar)` *is* still needed for is vertical rhythm.** Measured ink spans (fontTools, 400 weight, undotted bases, no tashkeel): Inter 0.932em, Outfit 0.893em — against Cairo 1.237, IBM Plex Sans Arabic 1.180. Arabic needs ~30% more vertical room at the same nominal size, and that is the floor. You have 15 `leading-none` and 9 `leading-tight` sites, both at or below every Arabic candidate's ink span — final-form jeem and meem descenders will be cut. And Tailwind's arbitrary `text-[Npx]` does not pair a line-height the way the named scale does, and there are ~597 of them, so those elements would inherit the font's natural box (1.874 for Cairo). Set `html[lang="ar"] body { line-height: 1.5 }` explicitly and the natural-box problem disappears.

One trap worth naming because a naive metric match walks straight into it: **Almarai and Alexandria** have the most Inter-like natural line boxes on paper and both have ink spans that *exceed their own default line box* (1.172 vs 1.116; 1.372 vs 1.219). They clip at default leading. Match on ink, not on line box.

**Micro-type floor.** 50 sites set text below 10px (`text-[8px]` ×11, `text-[9px]` ×36, etc.). Arabic letters are distinguished largely by dot count and position, and at 9px the dots of beh/teh/theh merge into a smudge. Latin at 9px is small; Arabic at 9px is ambiguous. Raise the Arabic floor to ~11px and accept that the dense editor chrome grows a few pixels.

### 3.6 SEO: `/ar` alone buys you an indexable URL and almost nothing else

Verified: `server/static.ts:86` sends the same `index.html` for every non-asset path. `client/index.html:7-8` is **one** `<title>` and **one** meta description for all 40 routes. There is no `react-helmet` in the tree and `document.title` appears nowhere in `client/src`. No `robots.txt`, no `sitemap.xml`.

So `/about`, `/brands`, `/terms` and `/studio/pricing` are *already* indistinguishable to a crawler. Arabic does not create this problem, it makes it visible.

What actually happens to `/ar/about`: Googlebot does execute JS, so it can eventually be indexed with Arabic body text. But the first-pass index entry and usually the SERP snippet come from the *served* head — `lang="en"`, English title, English description. `hreflang` injected after hydration is not a mechanism Google commits to. And social unfurlers run **zero** JavaScript: LinkedIn, X, Slack and — the one that matters for MENA — WhatsApp will show the English `og:title` from `client/index.html:16-17` for an Arabic page, forever.

**Do step 1 only.** At build time (`script/build.ts`, after `viteBuild()`) emit `dist/public/index.html` *and* `dist/public/ar/index.html` with `<html lang="ar" dir="rtl">`, Arabic title/description/og tags, a self-referencing canonical, and the `hreflang` en/ar/x-default triple. Then branch `server/static.ts:86` on `req.originalUrl.startsWith("/ar")`, falling back to the `fs_lang` cookie. ~15 lines of server change plus one build step. This fixes `lang`, `dir`, hreflang, canonical, WhatsApp unfurls, **and** the flash-of-LTR that no client-side approach can avoid.

Add `robots.txt` and a `sitemap.xml` with `xhtml:link` alternates — neither file exists and both are trivially cheap.

**Do not do real SSR** because someone asked for a language button. And do not let anyone claim that shipping `/ar` gets Arabic search traffic. It gets an Arabic URL; the per-locale shell is what makes the index entry Arabic.

---

## 4. The editors — the honest answer

**Do not mirror the timelines.** Ship `dir="rtl"` for the marketing and app chrome, and keep `/reel-editor` and Clip Studio as explicit `dir="ltr"` islands with Arabic strings inside them.

**The industry precedent is unanimous.** Adobe's Arabic answer is a build listed in the CC installer as "English يدعم العربية" — a fully English, LTR interface plus a bidi-aware *text engine* for content. The UI is not translated and the timeline is not mirrored. Final Cut ships no Arabic UI at all. DaVinci Resolve ships no Arabic UI; 20.1's RTL fix was in the *transcription dialog*. CapCut ships an Arabic UI and the Arabic ecosystem around it is entirely third-party converters for *caption text*. Four professional NLEs, zero mirrored timelines. That is not an oversight.

**The design authorities split, and one side is right for this case.** Material Design is explicit that media playback controls and progress indicators do not mirror, because they refer to the direction of the media, not the direction of time. Localisation vendors say the opposite — but that guidance is written for a 6px consumer progress bar under a video, not for a non-linear editor. In an NLE the timeline is a coordinate system: the frame at x is the frame at t, and a hundred spatial affordances have to agree on that mapping. Media time runs L→R in every filmstrip, every waveform, and — decisively here — in ffmpeg's `overlay=x=` output pixels.

**The codebase-specific argument is stronger than the general one.** Both files carry scar tissue. `clip-studio/Timeline.tsx:33-38` documents a bug where `paddingLeft: 76` put `getBoundingClientRect().left` 76px from where content began, so clicking the drawn playhead moved it. `Timeline.tsx:71-78` documents a second where the receiver *inferred* which trim edge moved and silently reset the start trim. This is the most fragile arithmetic in your product and it has already failed twice in ways that were invisible until someone dragged something. Mirroring re-derives every line of it — 20+ absolute `left:` sites across the two files, eight gestures routed through `timeAt`, trim-edge binding, snapping guides, `ReelEditor.tsx:458`'s `scrollTo({left})` — for a locale with no users yet.

**One failure mode makes partial mirroring the worst option of all.** `Timeline.tsx:396-408` lays filmstrip frames in a plain flex row. `direction: rtl` reverses flex main-axis order automatically, so the *frames* flip for free and correctly — while every overlay drawn on top of them (word cuts `:415`, silence hatching `:421`, segment boundaries `:443`, labels `:452`, trim caps `:472`/`:481`) uses physical `left:` and does not. Footage running one way, its annotations the other, no error anywhere.

**And there is a hard constraint that removes the choice anyway:** `dir` is inherited, and a scroll container's `direction` decides its `scrollLeft` origin. `dir="ltr"` on these subtrees is not a stylistic preference to settle later — it is the thing that stops the editors breaking on day one. **It must land in the same commit that sets `dir` on `<html>`.** Add a one-line regression test asserting `getComputedStyle(scroller).direction === "ltr"` in both editors; it is the only cheap guard against a future ancestor re-flipping them.

**Put the boundary at the route, not the scroller.** `ReelEditor.tsx:655` already carries `style={{ minWidth: 1360, overflowX: "auto" }}` — the page is itself a horizontal scroller, so islanding only the inner timeline leaves an RTL scroll container wrapping an LTR one, the hardest possible thing to reason about. And a per-panel island gives you RTL bin → LTR timeline → RTL inspector, two direction flips in one screen, which is what actually reads as broken. A whole-route LTR canvas with Arabic text in it reads as a professional tool.

**What else must not mirror, and this one is a correctness constraint, not a taste call.** Video-frame overlay coordinates are *render contracts*. `ClipStudio.tsx:1015` places the b-roll PiP at `left: ${activeBroll.x*(1-scale)*100}%` and `:1052` places a text overlay at `left: ${o.x*100}%`; `ClipPlacementPreview.tsx:243-253`; `SceneAnalysisModal.tsx:1122/1139`; `Library.tsx:409/439`; `CreatorProfile.tsx:956`; `AdminPlacements.tsx:241`; `PlacementInbox.tsx:190`. Those normalized x values are consumed verbatim by ffmpeg — `server/lib/remix/editStack.ts:583-585` emits `overlay=x=${px}`, `editorialAutoPipeline.ts:1994` the same. Mirror the preview and the preview stops matching the render. Your product's entire claim is that what you position is what gets composited. A blind `left:` → `inset-inline-start:` codemod corrupts all nine sites, silently, invisibly until someone renders.

**Also excluded from mirroring:** `SceneComparisonSlider.tsx` (it compares two images and `clipPath: inset()` is physical — plus its Radix `<Slider>` at `:164` *will* invert once a `DirectionProvider` lands, so the image drag and the slider drag would fight each other; pass `dir="ltr"` there); the recharts charts across nine files (Material groups charts with the things that do not mirror; accept that an Arabic reader scans the legend RTL while bars run LTR, because a per-chart-type rule is unmaintainable); `Undo`/`Redo`/`SkipBack` icons; and the negative `-ml-1`/`-ml-[5px]` handle-centring at `Panels.tsx:533-534` and `RemixStudio.tsx:1732/1741`, which are half-width corrections on a media-time anchor, not spacing.

**Keep timecode in Latin numerals.** `reel-editor/types.ts:128-139` and `clip-studio/types.ts:121/127` already emit ASCII via `padStart`/`toFixed` and never touch `Intl`. Do not "fix" that: timecode has to match the rendered file; `tabular-nums` is used at `ReelTimeline.tsx:279/502` and neither Inter nor Outfit has tabular Arabic-Indic figures, so the ruler labels would stop aligning at exactly the zoom levels the tick-step logic is tuned for.

**Trade-off I am accepting:** an Arabic user meets an LTR region inside an RTL page. That is a real seam. I take it because it is the same seam Adobe ships, because the timeline genuinely *is* a machine coordinate space, and because it can be made to read as deliberate — label the ruler axis in the gutter header (`ReelTimeline.tsx:230-235`, currently "Timecode") with a localised caption carrying an explicit arrow, and keep the editor's own header bar (`ReelEditor.tsx:637-682`) LTR too so the flip happens once at the route boundary rather than twice inside the page.

---

## 5. Phases

Estimates are engineer-days for one person who knows this codebase, excluding translator turnaround (which runs in parallel).

### Phase 0 — Prerequisites and cleanup. **4 days. Ships value with zero Arabic.**

Do this whether or not Arabic happens.

- Delete `client/index.html:44` (25 unused font families, render-blocking). Move `index.css:1`'s `@import` to a `<link>`. *Faster first paint for every user today.*
- Fix `client/src/lib/queryClient.ts:44-48`: `throwIfResNotOk` never parses the JSON, so it throws `Error("400: {\"error\":\"Invalid video ID\"}")` — and **88 client sites** render `err.message` straight into a toast body. Your users are being shown raw JSON with braces, right now, in English. Parse the body, and add a stable `code` field to server errors so a client can map them later.
- Consolidate the 24 separate mm:ss implementations into one `formatTimecode`, and the ten copies of the K/M abbreviator into one. Argue this as cleanup, not as i18n — it is worth doing on its own and it turns 24 later fixes into one. (Note: unifying the K/M copies means reconciling inconsistent rounding, which will visibly change numbers on the English site. That is a product decision hiding inside a refactor — surface it, don't smuggle it.)
- Delete the dead `@tailwindcss/vite ^4.1.18` from `package.json:124`. `vite.config.ts` never imports it; the real build is Tailwind **3.4.17** through PostCSS. It is 3–4MB installed for nothing and it will mislead anyone planning against v4 semantics.
- Promote `@radix-ui/react-direction` from a transitive install to a declared dependency.
- Add `dir="auto"` to user-content nodes (video titles, comments, brand product names, `clip_feedback.rejection_reason`). Cheap, mechanical, and correct today: `content_comments.text` (`shared/schema.ts:2055`) is already arbitrary-language.

**Worth on its own:** a faster site, a real bug fixed, three duplicated helpers collapsed.

### Phase 1 — Public Arabic. **12–15 days + translation. Independently shippable.**

Ships: `/ar` marketing, auth gates, and public creator permalinks in Arabic, RTL, with the language button.

- i18next wired at `App()` with `keySeparator: false`; `en`/`ar` JSON in `client/public/locales/`.
- `<DirectionProvider dir={...}>` at the app root **and** `<html dir>` from the same source. Nested `<DirectionProvider dir="ltr">` on the editor routes.
- `dir="ltr"` on `ReelEditor.tsx:655` and the ClipStudio root — **same commit as `<html dir>`**, plus the regression test.
- `<LanguageSwitcher />` as a child of `App()` at `z-[60]`, plus the three offsets (`AuthPage.tsx:238`, `BrandSignUp.tsx:91`, `TopBar.tsx:95`).
- `fs_lang` cookie; `preferredLocale` on `users` (`db:push` before boot).
- Fonts: Cairo + IBM Plex Sans Arabic appended, `html[lang="ar"] body { line-height: 1.5 }`, the 24 `leading-none`/`leading-tight` sites raised, the 50 sub-10px sites floored at 11px under `:lang(ar)`.
- Wrap + translate: `Landing.tsx` (156), `Brands.tsx` (80), `FullScaleCreates.tsx` (44), `Story.tsx` (43), `FullScaleStudio.tsx` (33), `StudioPricing.tsx` (22), `Footer.tsx` (19), `AuthPage.tsx` (59), the three waitlist/gate pages (34), `CreatorProfile.tsx` (55), `SharedView.tsx` (46).
- RTL the ~140 directional classes in those files only.
- Per-locale HTML shells + the `server/static.ts:86` branch + `robots.txt` + `sitemap.xml`.

**A recommendation about the marketing copy specifically:** do *not* run `Landing.tsx`, `Brands.tsx` and `Story.tsx` through a key-value catalog. That is ~2,250 words of hand-written brand voice, and `Story.tsx:104-134` is a founder narrative held in a `sections` array of `heading` + `body: string[]` paragraphs. A sentence-by-sentence Arabic translation of English positioning reads as a foreign company's brochure to the market you are presumably aiming at. Ship these as parallel Arabic content modules keyed by locale, so a copywriter can restructure, cut and reorder. Accepted cost: two versions per marketing page, and they will drift. That drift is cheaper than stilted Arabic on the front door.

**Worth on its own:** a complete, credible Arabic front door with correct `lang`/`dir`/hreflang/OG tags, and a shareable Arabic link that unfurls correctly in WhatsApp. This is 100% of what a visitor sees before they have an account.

### Phase 2 — The authenticated frame. **8–10 days. No translation.**

Makes the app *structurally* ready. No Arabic strings ship.

- Flip the shell as one atomic set: `App.tsx:78` `ml-64` → `ms-64`, `Sidebar.tsx:105` and `BrandSidebar.tsx:63` `fixed left-0` → `start-0` and `border-r` → `border-e`, `TopBar.tsx:95` `ml-64` → `ms-64`. **Four tokens, all four together.** Miss one and the entire authenticated app renders content underneath the sidebar. Highest blast radius, lowest effort in the project — do it first and eyeball it.
- Codemod ~450 of the ~779 directional tokens to logical properties — with `client/src/components/reel-editor/`, `client/src/components/clip-studio/`, `ClipStudio.tsx`, `RemixStudio.tsx`, `SceneComparisonSlider.tsx` and `PlacementPreviewModal.tsx` **excluded entirely** (pinned LTR instead), and with the nine video-frame overlay sites explicitly guarded.
- Hand-review the ~10 `border-l` sites: decorative accents (`Story.tsx:609/626`, `RemixEngine.tsx:1958`, `Panels.tsx:722/744/745`, `PlacementResults.tsx:189`) mirror; razor markers (`ReelTimeline.tsx:374/515`, `Timeline.tsx:492`) do not. The discriminator is whether the element sits in a subtree positioned by `toPx()`.
- Hand-fix the six icon-in-input pairs (`AuthPage.tsx` ×6, `BrandSignUp.tsx` ×4, `TopBar.tsx:98`, `EditorialClips.tsx:881`, `BrandMarketplace.tsx:657`, `BrandClipsBrowser.tsx:151`) — `pl-10` and `absolute left-3` are two halves of one layout and must convert as an atomic unit or the icon lands on top of the text.
- `text-left` → `text-start` globally (44 sites, genuinely safe) — **except** `ClipStudio.tsx:1052`'s `textAlign: o.align`, which is a persisted render contract. Guard it with a comment at the definition site; it is the single site most likely to be caught by a global rename.
- `switch.tsx:20`'s `translate-x-5` → `ltr:`/`rtl:` pair.
- Add `<bdi>`/`dir="ltr"` isolates around the ~15 composite numeric expressions — `Panels.tsx:501/598`, `VideoPreviewModal.tsx:230`, `EditorialClips.tsx:1226`, `ClipStudio.tsx:1311`, `DistributionDashboard.tsx:1013`. Without these, `0:05 / 1:20` renders as `1:20 / 0:05` in an Arabic paragraph, because `/` and `·` and `→` are bidi-neutral. This is invisible to every linter and every codemod, and it gets reported as a data bug.
- One locale-aware formatter module replacing the 59 `toLocale*` calls (six of which hardcode `"en-US"`, the rest follow the *browser* locale rather than the app's — meaning today an English-UI user with an Arabic browser already gets Arabic-Indic digits). Use `ar-u-nu-latn` product-wide so numerals are Latin everywhere, matching the timecode rule.

**Worth on its own:** the app can be flipped to Arabic in a day once strings exist, and every future page inherits the right primitives. Also, the bidi isolates and the unified formatter fix real inconsistencies in the English product today.

### Phase 3 — One authenticated surface. **20–25 days + translation. Gate on demand.**

Whichever surface your §2 decision names — creator (`Dashboard` 136 + `Library` 196 + shared components) or brand (`BrandMarketplace` 105 + `BrandOnboarding` 92 + `BrandPlacementRequestModal` 58).

**Phase by component ownership, not by route.** `RemixStudio`, `EditorialClips`, `DistributionDashboard`, `ClipStudio` and `SceneAnalysisModal` are each imported by two or three pages (`Library.tsx:19-25`, `ClipsAndReels.tsx:20-24`, `BrandMarketplace.tsx:36`, `SavedPlacements.tsx:35`), and `RemixStudio` itself pulls in `EditorialClips` and `DistributionDashboard`. "Translate the library" silently means translating most of the reel builder and part of the brand marketplace. Any plan that phases by page produces half-Arabic screens.

This is where the ~35 plural sites, the eleven enum→English label maps (`PLATFORM_LABEL` is defined independently in four files, already drifting), and the relative-time ladders live. Budget accordingly: each plural site *looks* like a one-line fix and is not, because the whole surrounding sentence has to become one ICU message.

### Phase 4 — Server, notifications, email, transcription. **15–20 days. Only if phase 3 shipped.**

- Error codes across ~640 user-facing `res.status().json()` sites.
- `notifications.title`/`body` (`shared/schema.ts:460-461`) store fully-rendered English sentences written at event time by 14 call sites — rows already in the table can never be translated. Move to `type` + `metadata` (both columns already exist at `:459`/`:463`) and render client-side. Same problem, same fix, for `editorial_clips.render_warnings` (`:1247`).
- 13 email templates in `server/lib/resend.ts`, each a hand-built LTR HTML table with `text-align` baked in. An Arabic version is a second template, not a string swap.
- **Transcription.** `server/lib/remix/speechToText.ts:497` defaults `language = "en"` and `:134` force-appends it; `server/lib/remix/editorialAutoPipeline.ts:782,792` hardcodes `language: "en"`. So an Arabic video uploaded today is transcribed under a forced English hypothesis and every downstream artefact — clips, titles, captions, brand matches — is built on garbage. This is the largest engineering item in the whole Arabic story and it is completely invisible from the UI. Fix: drop the default, let Whisper auto-detect, and write the result into `video_transcripts.language` (`shared/schema.ts:948`) — a column that already exists and that nothing currently writes anything but `'en'` to.

### Explicitly not planned

Admin pages. Legal translation. Real SSR. Arabic burned-in video captions (see §6).

**Total if you do everything: roughly 60–75 engineer-days.** My recommendation is **Phase 0 + Phase 1 + Phase 2 = ~25–30 days**, then stop and look at whether anyone actually arrives through the Arabic door before spending the other 40.

---

## 6. What will go wrong

Specific to this codebase, ordered by how much it will hurt.

1. **The editors break silently on the day `dir` lands.** Covered in §4. `Timeline.tsx:154` and `ReelTimeline.tsx:79`. No error, no visual glitch, wrong timestamps. Same commit, plus the computed-style test.

2. **A blind `left:` codemod corrupts the render contract.** The nine video-frame overlay sites feed ffmpeg. The preview mirrors, the output does not, nobody finds out until a creator renders. Exclusion list, and a comment at each definition site.

3. **Radix goes half-RTL.** `dir="rtl"` on `<html>` flips your CSS and leaves 27 Radix packages internally LTR. And the *inverse* trap: the moment you add `DirectionProvider dir="rtl"`, `SceneComparisonSlider.tsx:164`'s Radix `<Slider>` inverts while the same component's `clipPath` at `:123` and `left:` divider at `:137` do not — dragging the image and dragging the slider move the reveal in opposite directions.

4. **Two progress-bar implementations will disagree with each other.** `ui/progress.tsx` fills via `transform: translateX(-${100-value}%)` — physical, keeps filling from the left. The hand-rolled ones (`RemixStudio.tsx:1507/1879`, `SceneAnalysisModal.tsx:1036/1492`) are a `width: ${pct}%` child in normal flow — those flip for free. Adjacent screens filling in opposite directions.

5. **88 toasts render server English.** Verified count. The title is translated, the body is whatever the server sent. Half-Arabic toasts read worse than fully English ones. Phase 1 answer: generic Arabic failure message, raw detail in a collapsed LTR "details" line. Accepted cost: support loses a debugging cue from screenshots — hence the collapsed line rather than dropping it.

6. **The empty state is 20 English fake video cards.** `server/routes.ts:5699-5726` serves hardcoded demo data ("Desk Setup 2026", "Ultimate Gaming Setup Tour") to users with no real videos. Low cost to fix, high first-impression cost if missed — an Arabic user's very first screen.

7. **AI-generated DB values cannot come from a static catalog.** `detected_surfaces.surface_type` is a free-text varchar written by the scanner with an open English vocabulary (`shared/schema.ts:255` documents "Table, Desk, Wall, Monitor, Bottle") and renders directly in Library, the marketplace and the placement flows. Either canonicalise to an enum with a client-side label map (a data migration over existing rows) or accept that the screens closest to your product's actual value stay half-English. Decide before promising anyone a fully Arabic product.

8. **Short enum varchars render raw.** `render_status` ('rendering'), `monetization_tier`, `sentiment`, `video_transcripts.status`. These are the *cheapest* strings in the project — a 4-to-8-value client map each — and the most visible if skipped. One English word like `rendering` in an otherwise-Arabic screen reads as a bug, not as untranslated.

9. **AI output language is undefined.** No prompt in `server/lib/ai/` takes a language parameter. The right design is a split: `suggestedTitle` and `topicTags` follow the **source audio** (they become the actual published caption — `platformPublisher.ts` builds the YouTube description at `:163`, the Instagram caption at `:287`, the X post at `:440` from them), while `reasoning` and `narrativePurpose` follow the **UI language** (they are editorial rationale, never published). Accepted cost: an Arabic-UI creator editing English footage sees English clip titles beside Arabic explanations. Mildly ugly and correct; the alternative publishes wrong-language captions.

10. **Two brand-safety heuristics fail open on Arabic.** `server/lib/clipExtractor.ts:92`'s `avoidFillerStarts` is an English filler-word list used to pick clip in/out points — on Arabic it matches nothing, so clips start on filler. Worse, `server/lib/briefMatcher.ts:119` tokenizes clip text against the brand's "things to avoid" list; Arabic clip text can never match an English avoid-list, so a brand-safety filter that appears to be running passes everything. That is a commercial risk, not a cosmetic one.

11. **Burned-in Arabic captions do not work and will not work without container changes.** `server/lib/remix/captionStyler.ts:190` names ASS `Fontname: Sans` and lets fontconfig resolve it; `replit.nix` installs no Arabic font, so ASS captions render as tofu. The fallback at `clipGenerator.ts:1078` uses ffmpeg `drawtext`, which does no bidi reordering and no Arabic shaping — isolated, reversed letterforms — and `clipGenerator.ts:272-273` retries with drawtext whenever ASS fails, so an Arabic clip can silently downgrade to unreadable output. State this as a boundary now. An Arabic UI that renders unshaped Arabic into the exported video is worse than no Arabic UI. (One bright spot: `editStack.ts:592` rasterises text overlays with `sharp`/Pango, which shapes correctly — that path is probably fine.)

12. **`/ar` leaks through 45 raw anchors and ~20 hard navigations.** Verified counts. `wouter`'s `base` rewrites `<Link>` and `useLocation` and nothing else. Careful: the other ~21 `window.location` targets are `/api/*` and Stripe and must **not** be prefixed. And OAuth callbacks return to `/dashboard`, not `/ar/dashboard` — the cookie is what carries the locale across those, which is why the cookie is not optional even in the path-prefix design.

13. **Build fragility.** One 2.78MB chunk, no code splitting, already at `--max-old-space-size=4096` on Replit. Do not add a Babel macro pass. And load the Arabic catalog over HTTP — if it joins the main chunk, every English user pays for it.

---

## 7. What I need from you

1. **Creators or brands?** The one-sentence decision from §2. It changes phase 3 completely and phases 0–2 not at all.

2. **Dialect.** Recommend **Modern Standard Arabic** for everything except marketing. MSA reads as neutral and professional across all markets; Gulf dialect reads as local in the Gulf and as foreign in Egypt or the Levant. The exception is `Landing.tsx` and `Story.tsx`, where a light Gulf register may sell better if the Gulf is the target — that is a positioning call, not an engineering one. Tell me which market and I will scope the copywriter differently from the UI translator.

3. **A translator, and specifically two different people.** The UI catalog needs a technical translator working in JSON with a glossary. The marketing pages need a *copywriter* who can restructure — see the phase 1 note. If you only hire one, hire the copywriter and machine-assist the UI; the reverse produces a technically-correct site nobody wants to sign up to.

4. **Does "FullScale" transliterate?** My recommendation is **no** — keep the Latin wordmark everywhere, which is what the font-fallback strategy in §3.5 gives you for free (Latin runs inside Arabic sentences stay in Outfit/Inter). Transliterating it means the brand looks different on the Arabic site, and every OG image, every logo asset at `Sidebar.tsx:106`, and every social handle stays Latin anyway. But this is your call, not mine.

5. **A glossary decision, before a single string is translated.** "Placement", "surface", "remix", "reel", "story clip", "scene" have no settled Arabic equivalents. Eleven enum→label maps should be the first thing that consumes it (`Earnings.tsx:59-78`, `ClipsAndReels.tsx:105/107`, `CreatorProfile.tsx:173`, `RemixStudio.tsx:113`, `PlacementResults.tsx:59`, `RemixCopilot.tsx:77`, `legacyTools.tsx:199`, `reel-editor/types.ts:346`, `StudioUpload.tsx:41`). They are already drifting in English — `PLATFORM_LABEL` is defined independently in four files — so a single status reads differently on two screens today. Fix that in English while you build the glossary.

6. **Legal: English-governs, or a reviewed Arabic translation?** `Privacy.tsx` is 480 lines citing the YouTube API ToS. A mistranslated data-retention claim is a compliance problem, not a polish problem. Separately, and unrelated to Arabic: `Terms.tsx` at 88 lines is unusually thin for a marketplace that moves money.

7. **Are Arabic burned-in captions in scope?** If yes, it is a separate workstream: an Arabic font added to `replit.nix`, named explicitly in the ASS style line instead of relying on `"Sans"`, and a verification on the *deployed* Replit container (`ffmpeg -hide_banner -buildconf | grep -E 'fribidi|harfbuzz|libass'`) — your local ffmpeg build says nothing about the deployed one. If no, say so now so it is a stated boundary rather than a launch-week discovery.
