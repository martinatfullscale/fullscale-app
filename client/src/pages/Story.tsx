import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Mail, Play, X } from "lucide-react";
import { SiInstagram, SiLinkedin, SiYoutube } from "react-icons/si";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
import { Footer } from "@/components/Footer";
import {
  bandStories,
  gridStories,
  sectionStory,
  youTubeEmbed,
  youTubeId,
  youTubePoster,
  youTubePosterFallback,
  youTubePosterIsFallback,
  type Story,
} from "@/data/stories";

/**
 * The FullScale story — one page, served at both /about and /stories.
 *
 * These were two routes carrying one story: a founders' note at /about, and a
 * grid of the same founders' videos at /stories whose lead card was a link
 * back to /about. They are merged here.
 *
 * The shape is Claude Design's ("The FullScale Story.dc.html"): a full-width
 * masthead, a bottom-aligned thesis against the photograph, then the argument
 * as four numbered sections with a rail on the left and a companion column on
 * the right. That right column is the point of the redesign — the old page put
 * a 672px column of text against 584-840px of empty page, and this fills it
 * with the thing the reader would otherwise have to visit a second page to see.
 *
 * Four deliberate departures from the design file, each for a checkable reason:
 *
 *   1. Videos 3 and 4 are NOT docked beside sections 3 and 4. The design paired
 *      them positionally, which puts "It's Hard to Raise" and "How We Got
 *      Funded" — both about our cap table — next to the two sections where a
 *      creator decides whether to trust us with their channel and their
 *      footage. Those sections carry the product's receipts instead, and the
 *      two fundraising Shorts sit together in their own band.
 *   2. The hero uses items-end, not a stretched column. The design gave the
 *      photo an explicit height and let the text column stretch to match it,
 *      which reproduced the dead air the redesign existed to remove.
 *   3. The thesis sentence is the one that was already here. The design's
 *      rewrite ("what hasn't existed is a way to put a product into footage
 *      that has already been shot") is a claim about existence, and companies
 *      sell post-shoot placement today. "Almost no creator was ever offered
 *      it" is a claim about access, which is the true one.
 *   4. No speculative "open slot" cards. The grid says what is actually there.
 *
 * THE CLAIM LEDGER. This page makes promises about the product, so each one is
 * tied to the code that has to keep it. Checked 2026-09-04:
 *
 *   HOLDS  70% creator share — PLATFORM_TAKE_RATE = 0.30, server/lib/placementPricing.ts
 *   HOLDS  payouts are not live — charge_status has never advanced past "pending"
 *   HOLDS  a pulled video is discarded — the scan writes to /tmp under a TTL
 *          (server/lib/sourceCache.ts). NOTE this is true of a video we pull;
 *          an UPLOADED video is written to public/videos/ (routes.ts:6883) and
 *          scanned in place, so "we delete the source" describes one of the
 *          two paths, not both.
 *
 *   DOES NOT HOLD — "A brand cannot see a surface its creator hasn't approved."
 *          storage.getReadyVideosForMarketplace gates the VIDEO on having at
 *          least one approved surface, then pushes `surfaces` — every active
 *          surface on it — rather than `approvedSurfaces` (storage.ts:1951-1956).
 *          A brand browsing discovery sees surface types the creator never
 *          opened. The one-line fix is to push approvedSurfaces; it was not
 *          made here because it changes brand-facing behaviour.
 *
 *   DOES NOT HOLD — "the finished cut is in front of them and they decide
 *          whether it goes out at all." There is no creator render gate.
 *          shared/schema.ts:484 runs pending_creator_review -> creator_approved,
 *          the render fires AFTER that approval (routes.ts:11169) and
 *          auto-advances to pending_brand_review (routes.ts:11175). The creator
 *          never sees the baked render before the brand can release it.
 *
 * Both failing claims predate this merge — they are on the live /about page
 * today. They are carried here unchanged rather than silently reworded,
 * because the fix is a product decision: change the copy, or build the gate.
 */

/** Save the founders photo here: client/public/founders.jpg
 *  Referenced as a URL rather than imported so a missing file degrades to a
 *  broken image instead of failing the build. */
const FOUNDERS_PHOTO = "/founders.jpg";

const LINKEDIN_MARTIN = "https://linkedin.com/in/martinekechukwu";
const LINKEDIN_TAMARA = "https://www.linkedin.com/in/tamara-spinner-zachery-aa4b26141/";
const INSTAGRAM = "https://www.instagram.com/gofullscale";
const YOUTUBE = "https://www.youtube.com/@FullScale-Journey";
const CONTACT_EMAIL = "fullscale_info@gofullscale.co";

interface Section {
  /** The rail label. Describes the PROSE, not the video beside it. */
  rail: string;
  heading: string;
  body: string[];
  takeaway: string;
}

const SECTIONS: Section[] = [
  {
    rail: "The gap",
    heading: "The only thing most creators can sell is an interruption",
    body: [
      "A sixty-second read is the default sponsorship because it is the easy thing to buy and the easy thing to verify. It works. It also asks a creator to stop making the video in order to pay for making the video.",
      "Meanwhile the format brands have wanted for a hundred years — a product sitting in the shot, in a room someone actually lives in — has been reserved for productions with a props department and an agency on retainer.",
    ],
    takeaway: "The gap was never demand. There was simply no way to transact.",
  },
  {
    rail: "The surfaces",
    heading: "We look for the surfaces that are already in frame",
    body: [
      "FullScale reads a video and finds the places a product could believably sit: a desk, a counter, a shelf, a wall behind someone's head. Those places already exist in footage that is already published.",
      "The creator decides which of them are for sale. A brand browsing the marketplace sees only surfaces a creator has opened, prices a placement against that video's real reach, and sends a request.",
    ],
    takeaway: "A brand cannot see a surface its creator hasn't approved.",
  },
  {
    rail: "The consent",
    heading: "The creator says yes three times",
    body: [
      "Once when they open a surface to the marketplace. Once when a specific brand asks for it and they accept or decline in their inbox. Once when the finished cut is in front of them and they decide whether it goes out at all.",
      "None of those steps happen on a timer, and nothing publishes on its own.",
    ],
    takeaway: "We would rather lose a placement than surprise a creator with one.",
  },
  {
    rail: "The footage",
    heading: "We don't keep your video",
    body: [
      "To find surfaces we pull a video down, take the frames we need, record where the surfaces are, and delete the source. When a brand commits we pull it again at full resolution to render, then delete it again.",
      "What we hold onto is thumbnails, coordinates and results — the parts that make a marketplace work. The library stays yours, on your channel, under your account.",
    ],
    takeaway: "Your footage is not our inventory.",
  },
];

/* ── Poster ────────────────────────────────────────────────────────────────
   maxresdefault doesn't exist for every video and oardefault doesn't exist
   for every Short; hqdefault always does. YouTube serves a 120x90 grey
   placeholder rather than a 404 when a variant is missing, so onError never
   fires — the naturalWidth check is what actually catches it.

   hqdefault is 480x360, i.e. LANDSCAPE. Cropping that into a 9:16 well throws
   away half the picture, so a portrait card that has fallen back letterboxes
   instead of cropping. */
function Poster({
  id,
  alt,
  orientation,
}: {
  id: string;
  alt: string;
  orientation?: "portrait" | "landscape";
}) {
  const [src, setSrc] = useState(() => youTubePoster(id, orientation));
  const fallback = youTubePosterFallback(id);
  const letterbox = youTubePosterIsFallback(src) && orientation === "portrait";

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={`absolute inset-0 w-full h-full opacity-[0.72] transition-transform duration-500 group-hover:scale-[1.03] ${
        letterbox ? "object-contain" : "object-cover"
      }`}
      onLoad={(e) => {
        if (e.currentTarget.naturalWidth <= 120 && src !== fallback) setSrc(fallback);
      }}
      onError={() => src !== fallback && setSrc(fallback)}
    />
  );
}

/** A 9:16 well: poster, scrim, play badge. The whole well is the button. */
function VideoWell({ story, onPlay, badge = 56 }: { story: Story; onPlay: () => void; badge?: number }) {
  const vid = youTubeId(story.youtube);
  if (!vid) return null;
  return (
    <button
      type="button"
      onClick={onPlay}
      aria-label={`Play: ${story.title}`}
      /* The ring is drawn INSIDE: the well clips its overflow, so a positive
         outline-offset would be cropped away entirely. */
      className="group relative block w-full aspect-[9/16] overflow-hidden rounded-xl border border-white/10 bg-[hsl(224_71%_6%)] focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:[outline-offset:-3px]"
      data-testid={`card-story-${story.slug}`}
    >
      <Poster id={vid} alt="" orientation={story.orientation} />
      <span
        aria-hidden="true"
        className="absolute inset-0"
        style={{ background: "linear-gradient(to top, hsl(224 71% 4% / 0.85) 0%, hsl(224 71% 4% / 0.1) 55%)" }}
      />
      <span
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 grid place-items-center rounded-full bg-primary text-white shadow-lg shadow-black/40 transition-transform duration-300 group-hover:scale-110"
        style={{ width: badge, height: badge }}
      >
        <Play style={{ width: badge * 0.36, height: badge * 0.36 }} className="ml-0.5" fill="currentColor" />
      </span>
    </button>
  );
}

/** A still well for a story that is a link or an image rather than a video. */
function StillWell({ story }: { story: Story }) {
  return (
    <div className="relative w-full aspect-[9/16] overflow-hidden rounded-xl border border-white/10 bg-[hsl(224_71%_6%)]">
      {story.image ? (
        <img
          src={story.image}
          alt=""
          loading="lazy"
          className="absolute inset-0 w-full h-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.03]"
        />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(120%_120%_at_18%_0%,hsl(350_96%_43%/0.26),transparent_64%)]"
        />
      )}
    </div>
  );
}

/** The well plus its eyebrow, title and deck.
 *  A video is a button (it opens a player, which is an action); a link story is
 *  an anchor. A screen reader should not be told "link" for something that
 *  opens a dialog, or "button" for something that navigates. */
function StoryCard({ story, onPlay, badge }: { story: Story; onPlay: () => void; badge?: number }) {
  const hasVideo = !!youTubeId(story.youtube);
  const external = !!story.href && /^https?:/i.test(story.href);

  const well = hasVideo ? (
    <VideoWell story={story} onPlay={onPlay} badge={badge} />
  ) : story.href ? (
    external ? (
      <a
        href={story.href}
        target="_blank"
        rel="noopener noreferrer"
        className="group block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        data-testid={`card-story-${story.slug}`}
      >
        <StillWell story={story} />
      </a>
    ) : (
      <Link
        href={story.href}
        className="group block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        data-testid={`card-story-${story.slug}`}
      >
        <StillWell story={story} />
      </Link>
    )
  ) : (
    <StillWell story={story} />
  );

  return (
    <div className="flex flex-col gap-3.5 min-w-0">
      {well}
      {story.tag && (
        <p className="font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {story.tag}
        </p>
      )}
      <p className="font-display text-[17px] font-semibold leading-[1.3] tracking-[-0.01em] text-foreground">
        {story.title}
      </p>
      {story.deck && <p className="text-sm leading-[1.55] text-muted-foreground">{story.deck}</p>}
    </div>
  );
}

/* ── Lightbox ──────────────────────────────────────────────────────────────
   Escape closes, focus moves to the close button on open and returns to
   whatever opened it on close, and body scroll is locked while it's up. */
function PlayerDialog({ story, onClose }: { story: Story; onClose: () => void }) {
  const vid = youTubeId(story.youtube)!;
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Where the gesture STARTED. A click is dispatched on the nearest common
   *  ancestor of mousedown and mouseup, so selecting the title and releasing
   *  on the backdrop targets the backdrop — and a stopPropagation guard on the
   *  panel never runs, because the panel is below the target, not above it.
   *  Without this, dragging to select the deck tears the player down. */
  const startedOutside = useRef(false);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab") return;
      // Confine Tab. aria-modal only moves the screen-reader cursor; without
      // this, three tabs put focus on a link behind an opaque backdrop where
      // the focus ring cannot be seen.
      const root = panelRef.current;
      if (!root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),iframe,[tabindex]:not([tabindex="-1"])'),
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const outside = !active || !root.contains(active);
      if (e.shiftKey ? active === first || outside : active === last || outside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      // Send focus back where it came from, or it lands on <body> and the
      // next Tab starts from the top of the document.
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    /* A scroll container, not a centring flexbox: at 390x745 — an iPhone with
       its browser chrome — a portrait player plus header and deck is ~776px
       tall, and a centred overflow crops 15px off BOTH ends with no way to
       scroll to it, because body scroll is locked. */
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={story.title}
      onPointerDown={(e) => {
        startedOutside.current = !panelRef.current?.contains(e.target as Node);
      }}
      onClick={(e) => {
        if (startedOutside.current && !panelRef.current?.contains(e.target as Node)) onClose();
      }}
      data-testid="dialog-story-player"
    >
      <div className="flex min-h-full items-center justify-center p-4 md:p-8">
      <div ref={panelRef} className="w-full max-w-5xl">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            {story.tag && (
              <span className="inline-block rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
                {story.tag}
              </span>
            )}
            <h2 className="mt-3 text-xl md:text-2xl font-display font-semibold tracking-tight text-white leading-snug">
              {story.title}
            </h2>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 grid place-items-center w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            data-testid="button-close-player"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div
          className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-black mx-auto"
          style={{
            aspectRatio: story.orientation === "portrait" ? "9 / 16" : "16 / 9",
            maxWidth: story.orientation === "portrait" ? "min(420px, 46vh)" : undefined,
          }}
        >
          <iframe
            src={youTubeEmbed(vid)}
            title={story.title}
            className="absolute inset-0 w-full h-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        </div>
        {story.deck && (
          <p className="mt-4 text-sm md:text-base text-white/70 leading-relaxed max-w-3xl">{story.deck}</p>
        )}
      </div>
      </div>
    </div>
  );
}

function Rail({ num, label }: { num: string; label: string }) {
  return (
    <div className="flex flex-row lg:flex-col gap-3 lg:gap-2.5 items-baseline lg:items-start lg:sticky lg:top-24">
      <p className="font-display text-[13px] font-semibold tracking-[0.16em] text-primary">{num}</p>
      <p className="font-display text-[13px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

export default function Story() {
  const [playing, setPlaying] = useState<Story | null>(null);

  const band = useMemo(() => bandStories(), []);
  const grid = useMemo(() => gridStories(), []);

  /** Deep link: /about#slug and /stories#slug open that story's player.
   *  Both routes render this page, so both fragments have to work. */
  useEffect(() => {
    const slug = window.location.hash.replace(/^#/, "");
    if (!slug) return;
    const all = [...band, ...grid, ...SECTIONS.map((_, i) => sectionStory(i))];
    const match = all.find((s) => s && s.slug === slug && youTubeId(s.youtube));
    if (match) setPlaying(match);
  }, [band, grid]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Same standalone chrome as the other content pages (Privacy, Terms). */}
      <nav className="container mx-auto px-6 h-20 flex items-center justify-between border-b border-white/5">
        <Link href="/" data-testid="link-about-logo">
          <img src={logoUrl} alt="FullScale Creator Portal" className="h-9 md:h-10 w-auto" />
        </Link>
        <Link
          href="/"
          className="text-sm text-muted-foreground hover:text-white transition-colors inline-flex items-center gap-2"
          data-testid="link-about-home"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
      </nav>

      <main>
        {/* ── Masthead ────────────────────────────────────────────────────── */}
        <header className="relative overflow-hidden">
          {/* An oxblood wash so the photo's own dark-red backdrop meets the
              page instead of ending in a hard rectangle. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{
              background:
                "radial-gradient(58% 70% at 78% 42%, hsl(350 96% 43% / 0.20) 0%, hsl(350 80% 20% / 0.12) 42%, transparent 72%)",
            }}
          />

          <div className="container mx-auto px-6 relative">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="pt-14 md:pt-24 pb-10 md:pb-16"
            >
              <p className="font-display text-[13px] font-semibold uppercase tracking-[0.18em] text-primary mb-6 md:mb-7">
                The FullScale Story
              </p>
              <h1
                className="font-display font-bold text-[clamp(2.75rem,6.4vw,6.5rem)] leading-[0.97] tracking-[-0.035em] max-w-[20ch]"
                style={{ textWrap: "balance" } as React.CSSProperties}
              >
                How we're building FullScale
              </h1>
              <p
                className="mt-7 md:mt-8 text-[clamp(1.125rem,1.4vw,1.375rem)] leading-[1.5] text-muted-foreground max-w-[58ch]"
                style={{ textWrap: "pretty" } as React.CSSProperties}
              >
                Written and filmed by the two people doing it — the argument, the honest parts, and the
                videos where we say it out loud. Creator and brand case studies will live here too, once
                there are placements worth showing.
              </p>
            </motion.div>

            {/* ── Thesis + byline / photograph ──────────────────────────────
                The photo stretches to the text, not the other way round. The
                design fixed the photo at clamp(340px,40vw,600px) and let the
                text column stretch to match, which stranded a short caption at
                the bottom of a 576px row — measured here at 307px of blank
                above the thesis, worse than the 188px the redesign was
                commissioned to remove. Inverting it means the row is as tall
                as the words, and the photograph crops to fit. */}
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)] gap-10 lg:gap-14 items-stretch pb-14 md:pb-24">
              <motion.div
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.08 }}
                className="flex flex-col justify-end gap-8 md:gap-9"
              >
                <p
                  className="font-display font-medium text-[clamp(1.5rem,2.1vw,2.125rem)] leading-[1.28] tracking-[-0.02em] text-foreground"
                  style={{ textWrap: "pretty" } as React.CSSProperties}
                >
                  Product placement has existed for a century. Almost no creator was ever offered it.
                </p>

                {/* Byline. Names only — no titles, deliberately. */}
                <div className="border-t border-white/10 pt-7 flex flex-col gap-5">
                  <p className="font-display text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Written by
                  </p>
                  <div className="flex flex-wrap gap-x-10 gap-y-4">
                    <div className="flex flex-col gap-1.5">
                      <p className="font-display text-[17px] font-semibold text-foreground" data-testid="text-founder-martin">
                        Martin Ekechukwu
                      </p>
                      <a
                        href={LINKEDIN_MARTIN}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-muted-foreground hover:text-white transition-colors inline-flex items-center gap-2"
                        data-testid="link-linkedin-martin"
                      >
                        <SiLinkedin className="w-3.5 h-3.5" />
                        LinkedIn
                      </a>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <p className="font-display text-[17px] font-semibold text-foreground" data-testid="text-founder-tamara">
                        Tamara Spinner
                      </p>
                      <a
                        href={LINKEDIN_TAMARA}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-muted-foreground hover:text-white transition-colors inline-flex items-center gap-2"
                        data-testid="link-linkedin-tamara"
                      >
                        <SiLinkedin className="w-3.5 h-3.5" />
                        LinkedIn
                      </a>
                    </div>
                  </div>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.6, delay: 0.1 }}
                /* min-height, not height: it fills whatever the text column
                   needs and only takes over when the text is shorter than the
                   floor. Never pinned to the photo's own 1153/944 — that ratio
                   is what made the frame 586px tall against 398px of text. */
                className="relative rounded-2xl overflow-hidden border border-white/10 shadow-2xl shadow-black/50 bg-[hsl(350_60%_8%)] min-h-[clamp(300px,26vw,420px)]"
              >
                <img
                  src={FOUNDERS_PHOTO}
                  alt="Martin Ekechukwu and Tamara Spinner"
                  /* object-top, never centred: the top of Martin's head sits
                     ~85px into a 944px frame, and a centred crop cuts 87px. */
                  className="absolute inset-0 w-full h-full object-cover object-top"
                  loading="eager"
                  data-testid="img-founders"
                />
              </motion.div>
            </div>
          </div>
        </header>

        <div className="container mx-auto px-6">
          <div className="h-px bg-white/10" />
        </div>

        {/* ── The argument ────────────────────────────────────────────────── */}
        {/* No scroll-triggered entry animation on the body, deliberately.
            These were motion.section with initial opacity 0 and whileInView +
            once:true. Three of the five stayed at opacity 0 in testing: if the
            observer misses an element — a fast scroll past the margin, a
            backgrounded tab, a throttled frame loop — `once` means it never
            gets a second chance and the copy is invisible for good. On a page
            whose entire job is to be read, nothing decorative hides the
            words. */}
        {SECTIONS.map((s, i) => {
          const short = sectionStory(i);
          return (
            <section
              key={s.heading}
              aria-labelledby={`section-${i}`}
              className="container mx-auto px-6 border-b border-white/10"
            >
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,168px)_minmax(0,1fr)_minmax(0,300px)] gap-y-8 gap-x-8 xl:gap-x-14 items-start py-14 md:py-20">
                <Rail num={`0${i + 1}`} label={s.rail} />

                <div className="flex flex-col gap-7 max-w-[680px] min-w-0">
                  <h2
                    id={`section-${i}`}
                    className="font-display font-bold text-2xl md:text-[32px] leading-[1.2] tracking-[-0.02em]"
                    style={{ textWrap: "balance" } as React.CSSProperties}
                  >
                    {s.heading}
                  </h2>
                  <div className="flex flex-col gap-4">
                    {s.body.map((p) => (
                      <p key={p.slice(0, 24)} className="text-[17px] leading-[1.7] text-muted-foreground">
                        {p}
                      </p>
                    ))}
                  </div>
                  {/* The takeaway: a claim, then the sentence that says why it
                      matters. The one device worth borrowing outright. It sits
                      under the prose where a video holds the margin, and in
                      the margin where nothing else does. */}
                  {short && (
                    <p className="border-l-2 border-primary/60 pl-6 font-display text-xl leading-[1.4] text-foreground font-medium">
                      {s.takeaway}
                    </p>
                  )}
                </div>

                {/* The companion column. A Short where one belongs, the
                    product's receipts where one doesn't. */}
                <div className="w-full lg:max-w-[300px] lg:ml-auto min-w-0">
                  {short ? (
                    <div className="flex flex-col gap-3.5">
                      <p className="font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        In our own voice
                      </p>
                      <StoryCard story={short} onPlay={() => setPlaying(short)} />
                    </div>
                  ) : (
                    <p className="border-l-2 border-primary/60 pl-6 font-display text-xl md:text-[22px] leading-[1.35] text-foreground font-medium">
                      {s.takeaway}
                    </p>
                  )}
                </div>
              </div>
            </section>
          );
        })}

        {/* ── The band: the two Shorts that are about us, not the product ─── */}
        {band.length > 0 && (
          <section aria-labelledby="band-heading" className="container mx-auto px-6 border-b border-white/10">
            <div className="py-14 md:py-20">
              <p className="font-display text-[13px] font-semibold uppercase tracking-[0.16em] text-primary mb-5">
                How we got here
              </p>
              <h2
                id="band-heading"
                className="font-display font-bold text-[clamp(1.875rem,3.2vw,3.25rem)] leading-[1.05] tracking-[-0.03em]"
              >
                The part that isn't about the product
              </h2>
              <p
                className="mt-4 text-lg leading-[1.6] text-muted-foreground max-w-[56ch]"
                style={{ textWrap: "pretty" } as React.CSSProperties}
              >
                Raising the money to build this was its own story, and it did not go the way the tidy
                version goes. Both of these are ours, filmed at the time.
              </p>
              <div className="mt-11 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
                {band.map((s) => (
                  <StoryCard key={s.slug} story={s} onPlay={() => setPlaying(s)} />
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ── The grid ──────────────────────────────────────────────────────
            Only when there is something in it. This page IS the story, so a
            subsection headed "Stories" holding a paragraph about how there
            are no stories yet was the page saying its own name back to itself
            — and the masthead already makes the promise ("case studies will
            live here too, once there are placements worth showing"). Add a
            case study to stories.ts with no `pairsWith` and no `band` and this
            section appears with it. */}
        {grid.length > 0 && (
          <section aria-labelledby="record-heading" className="container mx-auto px-6 border-b border-white/10">
            <div className="py-14 md:py-20">
              <p className="font-display text-[13px] font-semibold uppercase tracking-[0.16em] text-primary mb-5">
                Case studies
              </p>
              <h2
                id="record-heading"
                className="font-display font-bold text-[clamp(1.875rem,3.2vw,3.25rem)] leading-[1.05] tracking-[-0.03em]"
              >
                Placements that ran
              </h2>
              <div className="mt-11 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-7 gap-y-11">
                {grid.map((st) => (
                  <StoryCard key={st.slug} story={st} onPlay={() => setPlaying(st)} />
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ── Where we actually are / Find FullScale ──────────────────────── */}
        <section aria-labelledby="status-heading" className="container mx-auto px-6">
          <div className="py-14 md:py-24">
            <div className="rounded-2xl border border-white/10 bg-card/40 p-7 md:p-12 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)] gap-10 lg:gap-16">
              <div className="max-w-[680px] flex flex-col gap-5">
                <p className="font-display text-[13px] font-semibold uppercase tracking-[0.16em] text-primary">
                  Where we actually are
                </p>
                <h2
                  id="status-heading"
                  className="font-display font-bold text-[clamp(1.625rem,2.6vw,2.5rem)] leading-[1.1] tracking-[-0.025em]"
                >
                  Creator payouts are not live yet.
                </h2>
                <p className="text-[17px] leading-[1.7] text-muted-foreground">
                  FullScale is early and invite-only. Scanning, story clips, placements, publishing and
                  results are live. Payouts are not: approved placements accrue against a real price, and
                  we say so on your earnings page rather than showing you a balance we cannot pay yet.
                </p>
                <p className="text-[17px] leading-[1.7] text-muted-foreground">
                  We would rather tell you what is missing than let you find out. If something on this
                  platform ever shows you a number it cannot stand behind, we want to hear about it.
                </p>
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="mt-1 inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-white transition-colors self-start"
                  data-testid="link-about-contact"
                >
                  Tell us what's broken
                  <ArrowRight className="w-4 h-4" />
                </a>
              </div>

              <div className="lg:ml-auto w-full">
                <p className="font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-4">
                  Find FullScale
                </p>
                <div className="flex flex-col border-t border-white/10">
                  <a
                    href={INSTAGRAM}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 py-4 border-b border-white/10 text-[15px] text-foreground hover:text-white transition-colors"
                    data-testid="link-instagram"
                  >
                    <SiInstagram className="w-4 h-4 shrink-0" />
                    <span>
                      Instagram <span className="text-muted-foreground">@gofullscale</span>
                    </span>
                  </a>
                  <a
                    href={YOUTUBE}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 py-4 border-b border-white/10 text-[15px] text-foreground hover:text-white transition-colors"
                    data-testid="link-youtube"
                  >
                    <SiYoutube className="w-4 h-4 shrink-0" />
                    <span>
                      YouTube <span className="text-muted-foreground">@FullScale-Journey</span>
                    </span>
                  </a>
                  <a
                    href={`mailto:${CONTACT_EMAIL}`}
                    className="flex items-center gap-3 py-4 border-b border-white/10 text-[15px] text-foreground hover:text-white transition-colors break-all"
                    data-testid="link-email"
                  >
                    <Mail className="w-4 h-4 shrink-0" />
                    <span>{CONTACT_EMAIL}</span>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />

      {playing && <PlayerDialog story={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}
