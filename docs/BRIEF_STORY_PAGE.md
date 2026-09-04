# Design brief — The FullScale story (merge `/about` + `/stories` into one page)

**For:** Claude Design
**Merges:** `client/src/pages/About.tsx` (223 lines) + `client/src/pages/Stories.tsx` (459 lines) → one page
**Content model:** `client/src/data/stories.ts` (170 lines) — no CMS, no database; edit the file, commit, deploy
**Routes today:** `/about` and `/stories`, registered in three shells (`client/src/App.tsx:226-227`, `:258-259`, `:291-292`)
**Target feel:** a founder-run company showing its work — the people, the argument, and the videos where they say it in their own voice.

---

## 1. The one-sentence problem

`/about` and `/stories` are two routes carrying one story, and the Stories page opens with a promise it cannot keep: it advertises creator and brand case studies, while every item on it is Martin and Tamara talking about how they are building FullScale.

---

## 2. The false premise, precisely

The masthead (`Stories.tsx:326`, `:329`) reads:

> **What a placement looks like when it works**
> Creators, brands and the machinery in between — shown rather than described.

That sells a placement case study. Here is everything actually on the page:

| Story | What it really is |
|---|---|
| "Product placement has existed for a century…" | The founders' note. `href: "/about"` — it is a link to the other page. |
| "$43Billion On Creators" | The market, in Martin's voice |
| "AI Product Placement is Real" | The thesis |
| "It's Hard to Raise" | Fundraising, honestly |
| "How We Got Funded" | The outcome |

Not one is a placement. All five are **FullScale's own story of how it is doing what it does** — which is the page Martin actually wants, and the copy has to say so.

**The two pages are already one page.** The featured Stories card (`stories.ts:109-118`) carries `/about`'s headline, `/about`'s photo (`/founders.jpg`), `/about`'s byline, and `href: "/about"`. The lead item on Stories is a link to About. A reader who lands on either one is reading half of something.

---

## 3. What is actually there today (verified)

### `/about` — `About.tsx`

A founders' note in five parts: a hero (eyebrow / headline / deck / byline + photo), four `SECTIONS` (`:36-69`) each written as *claim → two paragraphs → a takeaway line on an oxblood left rule*, and a closing "Where we actually are" card (`:194-215`) that admits payouts aren't live.

**The copy is load-bearing and every factual claim in it is checkable against the code** (`:19-28` documents which line of the server backs each one). Keep the substance. Re-cut, re-order, re-typeset it freely.

One hard rule inherited from a live bug (`:166-173`): the body has **no scroll-triggered entry animation**, deliberately. It used `whileInView` + `once: true` and three of five sections stayed at opacity 0 in testing — a missed intersection means the copy never appears at all. On a page whose whole job is to be read, nothing decorative may hide the words. Any animation you add must leave the text visible if the animation never fires.

### `/stories` — `Stories.tsx`

Masthead → a featured band (`:335`) → an "All stories" grid (`:425`, `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-7 gap-y-14`). Cards play inline; posters come from YouTube automatically, so there is nothing to upload and nothing to keep in sync.

Two things silently do nothing:

- **The category filter never renders.** `chips` (`:281-284`) only offers a category that has stories behind it, and every story is `"Company"` — so `chips.length > 1` is false at `:401` and the whole filter row is invisible. Five categories are declared (`stories.ts:164-170`); one is used.
- **All four videos have `deck: ""`** (`stories.ts:133, 141, 149, 158`). Every card is a bare title with no sentence under it.

### The two spacing defects, measured

Rendered from the real markup at three viewport widths:

| | 1280 | 1440 | 1920 |
|---|---|---|---|
| Container width | 1280 | 1280 | 1536 (caps here) |
| Photo frame | 588 × 481 | 588 × 481 | 716 × 586 |
| **Empty page right of the photo** | 24px | **104px** | **216px** |
| Hero text block height | 446 | 446 | 398 |
| **Vertical slack in the hero** (`items-center` splits it) | 35px | 35px | **188px** |
| Body column (`max-w-2xl`) | 672 | 672 | 672 |
| **Empty page right of the body** | **584px** | **584px** | **840px** |
| Body column as share of screen | 52.5% | 46.7% | **35.0%** |

**Right of the photo** (`About.tsx:103`, `:141-143`): the hero is `lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]` inside a container that stops at 1536px. On any screen wider than that the photo ends 216px short of the edge. Worse, the photo frame is pinned to the photo's exact aspect ratio (`1153 / 944`) so its height is a function of column width — at 1920 it stands 586px tall against 398px of text, and `items-center` splits the 188px difference into dead air above and below the words.

**Space below** (`About.tsx:159`, `:164`): the entire body is a 672px `max-w-2xl` column hugging the left edge, running 1,552px down the page with 584–840px of nothing beside it. That column is the "too much space below" — the page reads as a narrow strip of text with an empty right half.

### Socials

- **Instagram** exists, once, in the footer: `https://www.instagram.com/gofullscale` (`Footer.tsx:84`).
- **LinkedIn does not exist anywhere in the codebase.** The only hits are LinkedIn as a *publishing destination* inside the product (`RemixStudio.tsx:110`, `DistributionDashboard.tsx:97`). The profiles in §5 were supplied for this brief and are wired nowhere yet — and note they are the **founders' personal profiles, not a company page**. That suits a founders' note, but it means they belong beside the byline as *these two people*, not in a row of corporate icons in the footer.
- **No YouTube channel link** either — the four Shorts are embedded individually, but nothing points at the channel.

---

## 4. What to design

**One page.** One masthead, one continuous read. `/about` and `/stories` must both keep resolving to it (existing links, the footer, and the featured card all point at one or the other).

### The spine

The page has to do four things in an order that makes sense:

1. **Who we are and why this exists** — the founders, the photo, the one-sentence thesis.
2. **The argument** — the four sections. This is the strongest writing on the site.
3. **Us saying it out loud** — the four Shorts, as a real part of the page rather than a separate destination. They already read as an arc: the market → the thesis → the difficulty → the outcome (`stories.ts:120-128`).
4. **Where to find us** — Instagram, LinkedIn, YouTube, email.

Whether the videos punctuate the argument or gather into a band after it is your call — but they should not feel bolted on, and the reader should not have to go to a second page for them.

### Requirements

- **Fix the header's claim.** The page is FullScale's own story of how it is building what it is building. Write a masthead that says that and can still hold a creator case study later, when one exists.
- **Fix both spacing defects.** Specifically: the photo should not leave 216px of empty page beside it on a wide screen, and the body must stop being a 35%-wide strip. Full-bleed the hero, widen the measure, use the second column, break the single-column body — your call, but the numbers in the table above are the test.
- **Keep the reading measure honest.** The body currently sits at 672px, which is close to right for a 65-character line. Filling the right side must not turn the argument into a 1,400px paragraph.
- **The four videos are 9:16 Shorts.** A vertical clip in a horizontal well is mostly black bars. Portrait cards are already in place, capped at 250px wide (340 featured) with `oardefault.jpg` as the poster (`stories.ts:93-97`, `Stories.tsx:73`) — but four narrow portraits in a three-column landscape grid is not a designed answer. Design the portrait treatment properly.
- **Socials get a real home,** not just a footer line. Instagram is the company (`@gofullscale`); LinkedIn is Martin and Tamara individually. Those are two different kinds of link and probably want two different places on the page — the personal profiles read naturally off the byline, the company accounts off the closing card. Plus the YouTube channel and `fullscale_info@gofullscale.co`.
- **Room to grow.** Four videos today. Design for twelve. When creator and brand case studies do exist, they need somewhere to go — that is when the category filter (`STORY_CATEGORIES`) starts earning its place. Either make it work with more than one category, or cut it and tell us what replaces it.
- **Write the decks.** All four video cards have `deck: ""` — every one is a bare title with nothing under it. Draft a sentence for each from the title and the arc it sits in, and one for the founders' note if the merged page needs it. We will correct anything that misstates a fact about the product; the writing is yours.

---

## 5. Constraints

- **Tokens, from `client/src/index.css`:** `--primary: 350 96% 43%` (oxblood), `--background: 224 71% 4%`, `--card: 224 71% 6%`, `--radius: 0.75rem`. **Outfit** display, **Inter** body. Dark ground throughout — this is not a theme-switching page.
- **Aliases:** `@` → `client/src`, `@shared` → `shared`, `@assets` → `attached_assets`. Stack is React 18 + wouter + Tailwind + shadcn + framer-motion.
- **Reuse `Footer.tsx`** and the standalone nav from `About.tsx:75-87` (logo left, "Back to Home" right — same chrome as Privacy and Terms).
- **The content model stays a TypeScript file.** Adding a story must remain: paste a YouTube URL into `stories.ts`, commit. Do not introduce a CMS, a fetch, or a build step. `youTubeId()` already handles `watch?v=`, `youtu.be/`, `/shorts/` and bare ids.
- **`/founders.jpg` is 1153 × 944.** It is the only photograph we have. If your layout wants a different crop, say which crop.
- **No animation may gate the copy.** See §3.
- **The four YouTube ids** — `nVXd4-Hwe_o`, `U4myeHPl9Cc`, `RVTC2oTQMdE`, `1zOTyIiMrKo`.
- **The links the page has to carry:**

  | | |
  |---|---|
  | Instagram (company) | `https://www.instagram.com/gofullscale` |
  | LinkedIn — Martin Ekechukwu | `https://linkedin.com/in/martinekechukwu` *(handle unconfirmed — see §8)* |
  | LinkedIn — Tamara Spinner | `https://www.linkedin.com/in/tamara-spinner-zachery-aa4b26141/` |
  | Email | `fullscale_info@gofullscale.co` |
  | YouTube channel | not supplied — see §8 |

---

## 6. Deliverables

1. A single self-contained HTML mock of the merged page at desktop width, with the real copy and the real videos.
2. The mobile behaviour — specifically what happens to the founders photo and to four portrait video cards on a phone.
3. A note on what the page looks like with **twelve** stories instead of five, and how a future creator case study slots in beside a founder Short.
4. Draft decks for the four videos — a sentence under each title.
5. Your call on the category filter: make it work, or replace it.

---

## 7. Out of scope

- The content model's shape (`Story`, `youTubeId`, `youTubePoster`) — it works and the four videos are already wired through it.
- Routing changes beyond keeping both `/about` and `/stories` alive.
- Anything behind the login. This is a public page.
- Writing new factual claims about the product. Every claim on `/about` is checkable against the server; new ones would have to be verified before they ship.

---

## 8. What we still owe you

- **Confirmation of Martin's LinkedIn handle.** Two spellings reached us in the same message, one character apart — `martinekechukwu` and `martinekechukwui`. We have used the first and guessed at nothing. Tamara's is confirmed.
- **The YouTube channel URL**, if the page should link to it as well as embed the four Shorts.
- Confirmation on the "$43Billion" title — it is missing a space, and we have left it exactly as given.
