# Arabic glossary — for review

**Status: NOT SETTLED. Nothing here should be treated as decided.**

I drafted the first Arabic pass and presented six terms as glossary "decisions". They were not
decisions, they were guesses, and at least one is wrong. This file replaces them with what can
actually be evidenced, what cannot, and what a reviewer has to choose between.

Six words run through the entire product — they appear in the marketing pages, the app UI, the
error messages and eventually the emails. Settling them once, here, is cheap. Discovering they
are wrong after five pages are translated is not.

---

## 1. product placement — **التسويق المُدمج** — *changed 2026-09-08, and read the warning*

My first draft used **توظيف المنتجات**, which I invented. It appears in no source. The second used
**موضعة المنتج** — "positioning of the product" — which is real, but transactional: it describes
the act of putting a thing somewhere.

The steer was to make it read closer to *product in entertainment* — the product living inside
something a person chose to watch, rather than a slot being filled. That is a better description
of what FullScale does, and Arabic has a term for it that is already attested as a synonym:

| Term | Sense | Source |
|---|---|---|
| **التسويق المُدمج** | integrated / embedded marketing — the product woven into the work | [Arabic Wikipedia](https://ar.wikipedia.org/wiki/موضعة_المنتج), which gives it as the alternative name for موضعة المنتج |
| موضعة المنتج | positioning of the product — the transactional act | same |
| الإشارة إلى المنتج | reference to the product — closer to a mention | [Harvard Business Review Arabic](https://hbrarabic.com/المفاهيم-الادارية/الإشارة-إلى-المنتج/) |

The files now carry **التسويق المُدمج**.

### The warning — three obvious terms would misdescribe the product

Searching for the "product in entertainment" framing surfaces three terms that sound exactly
right and are exactly wrong for FullScale:

- **المحتوى المميز بالعلامة التجارية** / branded content — [HBR Arabic](https://hbrarabic.com/المفاهيم-الادارية/المحتوى-المميز-بالعلامة-التجارية/) defines it as content *funded or produced by the advertiser*.
- **الترفيه ذو العلامة التجارية** / branded entertainment — [same](https://ar.wikipedia.org/wiki/محتوى_ذو_علامة_تجارية) premise.
- **الترفيه الإعلاني** / advertainment — [HBR Arabic](https://hbrarabic.com/المفاهيم-الادارية/الترفيه-الاعلاني/): advertising elements placed into entertainment *the company produces*.

All three assume the brand commissioned the content. FullScale's entire proposition is the
opposite: **the creator already made the video, owns it, and the product goes in afterwards.**
Using any of them in Arabic would not be a clumsy translation — it would describe a different
business, and it would undercut the one thing the marketing pages spend their whole length
arguing. Do not let a translator reach for them because they read more naturally.

**Still for a native reviewer to confirm**, and the reason to ask specifically: التسويق المُدمج is
attested, but it is a *marketing-category* noun. Whether it works as a countable thing a creator
sells one of — "approve a placement", "three placements this month" — is a judgement call, and
§5 depends on the answer.

## 2. creator — **صانع المحتوى** (plural **صنّاع المحتوى**) — *evidenced*

Standard and unambiguous. Used by [Al-Araby](https://www.alaraby.com/news/إن-كنت-ترغب-في-أن-تصبح-صانع-محتوى-إليك-ما-يجب-معرفته-أولًا),
by [Mostaql](https://mostaql.com/freelancers/content-creator), and by
[Makeity](https://makeity.com/ar/) — an Arabic platform that connects creators to brands, i.e.
the closest thing to a direct competitor's own vocabulary.

## 3. brand — **العلامة التجارية** — *evidenced*

Confirmed in the same sources. Not in doubt.

## 4. surface — **مساحة** — *settled*

The English product noun stays **surface**. It was briefly changed to "space" and changed back
on 2026-09-08: "surface" is the word the product, the code and the marketing have always used,
and there was no reason to move the English to make the Arabic easier.

The Arabic is **مساحة** regardless. A translation does not have to be literal, and مساحة — the
ordinary word for a space or an area — is what an Arabic reader would use for the in-frame spot a
product sits on. The near-literal alternative, سطح (a surface in the physical sense, a tabletop),
reads as the material rather than as the sellable slot, which is the wrong half of the meaning.

It has to work as a countable noun and it does: *4 surfaces*, *approve a surface*, *a surface
your creator hasn't opened* — **٤ مساحات**، **الموافقة على مساحة**.

This is the one entry where English and Arabic deliberately diverge in imagery, and it is worth a
reviewer's attention for exactly that reason.

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
