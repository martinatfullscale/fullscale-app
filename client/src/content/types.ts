/**
 * Marketing copy, per locale, as MODULES rather than catalog keys.
 *
 * The UI chrome — buttons, form labels, toasts — goes through i18next, because
 * those are labels and a key-value catalog is exactly right for labels.
 *
 * This is the other half. The public pages are ~2,250 words of hand-written
 * brand voice, and a sentence-by-sentence Arabic rendering of English
 * positioning reads as a foreign company's brochure translated by a machine —
 * which is what it would be. A copywriter needs to be able to restructure, cut
 * a paragraph that does not land in Arabic, reorder an argument, and use a
 * different number of sections. A flat catalog cannot express any of that; a
 * module can, because each locale's file is just a typed object.
 *
 * THE CONTRACT: every locale file satisfies the same interface, so the page
 * component is written once and never branches on language. What varies is the
 * words and, where the type allows an array, how many of them there are.
 *
 * THE COST, stated plainly: two files per page that will drift. That is the
 * trade being made — drift is cheaper than stilted Arabic on the front door,
 * and a missing Arabic module falls back to English rather than breaking.
 */

export interface StorySection {
  /** The margin label. Describes the prose, not the video beside it. */
  rail: string;
  heading: string;
  /** One or more paragraphs. A translator may use a different number. */
  body: string[];
  takeaway: string;
}

export interface StoryContent {
  nav: { backHome: string };
  masthead: { eyebrow: string; title: string; deck: string };
  thesis: string;
  byline: { label: string; linkedin: string };
  /** Shown over the Short that sits beside a section. */
  inOurOwnVoice: string;
  sections: StorySection[];
  band: { eyebrow: string; title: string; deck: string };
  grid: { eyebrow: string; title: string };
  find: { title: string; instagram: string; youtube: string };
  player: { close: string };
}

/** Every page's content shape, keyed by page. Extended as pages are converted. */
export interface ContentByPage {
  story: StoryContent;
}
