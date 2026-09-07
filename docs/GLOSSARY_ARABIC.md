# Arabic glossary — for review

**Status: NOT SETTLED. Nothing here should be treated as decided.**

I drafted the first Arabic pass and presented six terms as glossary "decisions". They were not
decisions, they were guesses, and at least one is wrong. This file replaces them with what can
actually be evidenced, what cannot, and what a reviewer has to choose between.

Six words run through the entire product — they appear in the marketing pages, the app UI, the
error messages and eventually the emails. Settling them once, here, is cheap. Discovering they
are wrong after five pages are translated is not.

---

## 1. product placement — **MY DRAFT WAS WRONG**

I used **توظيف المنتجات**. It appears in no established source I can find. I invented it.

The terms actually in use:

| Term | Literal sense | Used by |
|---|---|---|
| **موضعة المنتج** | positioning of the product | [Arabic Wikipedia](https://ar.wikipedia.org/wiki/موضعة_المنتج) |
| **الإشارة إلى المنتج** | reference to the product | [Harvard Business Review Arabic](https://hbrarabic.com/المفاهيم-الادارية/الإشارة-إلى-المنتج/) |
| **التسويق الضمني** / **الإعلان الضمني** | embedded marketing / embedded advertising | HBR Arabic, general marketing press |

**Reviewer's call.** My reading, offered as a starting point and not a recommendation I can
stand behind: *موضعة المنتج* is closest to what FullScale actually does — putting a product in a
position within a frame — whereas *الإشارة إلى المنتج* reads closer to a mention, and
*التسويق الضمني* names the category rather than the act. But this is exactly the judgement a
native marketer should make, not me.

The files currently carry **موضعة المنتج** as a placeholder because it has the strongest
sourcing, not because it has been chosen.

## 2. creator — **صانع المحتوى** (plural **صنّاع المحتوى**) — *evidenced*

Standard and unambiguous. Used by [Al-Araby](https://www.alaraby.com/news/إن-كنت-ترغب-في-أن-تصبح-صانع-محتوى-إليك-ما-يجب-معرفته-أولًا),
by [Mostaql](https://mostaql.com/freelancers/content-creator), and by
[Makeity](https://makeity.com/ar/) — an Arabic platform that connects creators to brands, i.e.
the closest thing to a direct competitor's own vocabulary.

## 3. brand — **العلامة التجارية** — *evidenced*

Confirmed in the same sources. Not in doubt.

## 4. surface — **مساحة العرض** — *a coinage, and it is ours*

This is FullScale's own term of art. No dictionary or industry source will settle it, because
the concept barely exists elsewhere: the specific in-frame spot where a product could sit.

That makes it the most important one to get right and the one no amount of research can answer.
Options a reviewer should weigh: **مساحة العرض** (display space), **موضع** (position/spot),
**مساحة** alone, or leaving it as a defined term introduced once on the page. Whatever is
chosen has to work as a countable noun — the product says "4 surfaces", "approve a surface",
"a surface your creator hasn't opened".

## 5. placement (a single transaction) — **إدراج** — *unverified, and it should follow §1*

I used **إدراج** (insertion). It has to be consistent with whatever is chosen for
*product placement*, because in the product they are the same thing at two scales — the category
and one instance of it. Do not settle this before §1.

## 6. marketplace — **السوق** — *plausible, unverified*

Literally "the market". Probably fine. A reviewer should confirm whether a two-sided platform
reads better as **السوق** or as **المنصة** (the platform), which is what
[Makeity](https://makeity.com/ar/) calls itself.

## 7. FullScale — **stays in Latin** — *a brand decision, not a translation one*

Recommendation stands, and it is the one item here I would defend: the wordmark, the logo asset,
the social handles and every OG image are Latin. The font stack lists Outfit before Cairo and
resolves per glyph, so *FullScale* renders in the brand's own type inside an Arabic sentence for
free. Transliterating it means the brand looks like a different company on the Arabic site.

---

## What I cannot do

I am not a native Arabic speaker and I have no way to judge register, regional fit, or whether a
sentence reads as natural or as translated. Web sources establish that a term is *used*; they do
not establish that it is the right one for this product, this audience, or this tone.

Everything in `client/src/content/*.ar.ts` is a machine draft written so the Arabic layout could
be built and tested against text of realistic length and shape. It is scaffolding. It should be
read as a placeholder that happens to be in Arabic, not as a translation.

Until a native reviewer has been through it, Arabic is **hidden from the language switcher** and
reachable only with an explicit `?lang=ar`. See `client/src/lib/i18n.ts`.
