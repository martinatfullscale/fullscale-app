import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Play, X } from "lucide-react";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
import { Footer } from "@/components/Footer";
import {
  STORIES,
  STORY_CATEGORIES,
  youTubeEmbed,
  youTubeId,
  youTubePoster,
  youTubePosterFallback,
  type Story,
  type StoryCategory,
} from "@/data/stories";

/**
 * Stories — /stories
 *
 * The structure is lifted from Agentio's blog, measured at 1440px: a
 * "Featured content" band over an "All content" grid, three columns of 414px
 * cards with a 26px gutter, each card an eyebrow / headline / deck / CTA over
 * a 16:9 image, with category chips filtering the grid.
 *
 * The one deliberate departure: their 57 cards are all still images and not
 * one of them is video. Ours lead with the video. A 16:9 card slot is already
 * exactly a YouTube frame, so the shape cost nothing to adopt and the story
 * plays instead of being described.
 *
 * Playback is click-to-play, never autoload: the poster is an <img> from
 * i.ytimg.com and the iframe is only mounted after a click. Nothing from
 * youtube-nocookie.com loads until someone asks for it, so the page costs one
 * thumbnail per card instead of one player per card.
 *
 * Content lives in client/src/data/stories.ts. Adding a story is a commit.
 */

/* ── Poster ────────────────────────────────────────────────────────────────
   maxresdefault.jpg doesn't exist for every video; hqdefault always does.
   YouTube serves a 120x90 grey placeholder rather than a 404 when maxres is
   missing, so onError never fires — the naturalWidth check is what actually
   catches it. */
function Poster({ id, alt, className }: { id: string; alt: string; className?: string }) {
  const [src, setSrc] = useState(youTubePoster(id));
  const fallback = youTubePosterFallback(id);
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className={className}
      onLoad={(e) => {
        if (e.currentTarget.naturalWidth <= 120 && src !== fallback) setSrc(fallback);
      }}
      onError={() => src !== fallback && setSrc(fallback)}
    />
  );
}

/** The media well of a card: a video poster with a play badge, an image, or a
 *  typographic panel when a story has neither. Always 16:9. */
function CardMedia({ story, large = false }: { story: Story; large?: boolean }) {
  const vid = youTubeId(story.youtube);
  return (
    <div className="relative w-full overflow-hidden rounded-xl bg-secondary/60 border border-white/10" style={{ aspectRatio: "16 / 9" }}>
      {vid ? (
        <>
          <Poster
            id={vid}
            alt={story.title}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/5 to-transparent" />
          <span
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 grid place-items-center rounded-full bg-primary text-white shadow-lg shadow-black/40 transition-transform duration-300 group-hover:scale-110 ${
              large ? "w-16 h-16" : "w-12 h-12"
            }`}
          >
            <Play className={large ? "w-7 h-7 ml-0.5" : "w-5 h-5 ml-0.5"} fill="currentColor" />
          </span>
        </>
      ) : story.image ? (
        <img
          src={story.image}
          alt={story.title}
          loading="lazy"
          className="absolute inset-0 w-full h-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.03]"
        />
      ) : (
        /* No video and no image. An earlier pass set the headline into the
           well, which put the same sentence twice on one card — the well and
           the <h3> beneath it. A quiet branded panel instead: the card's
           words stay in one place. */
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(120%_120%_at_18%_0%,hsl(350_96%_43%/0.26),transparent_64%)]"
        >
          <div
            className="absolute inset-0 opacity-[0.16]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(115deg, hsl(0 0% 100% / 0.5) 0 1px, transparent 1px 22px)",
            }}
          />
        </div>
      )}
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
      {children}
    </span>
  );
}

/* ── Card ──────────────────────────────────────────────────────────────────
   A video card is a <button> (it opens a player, which is an action). A link
   card is an <a>. Same visual treatment, correct semantics for each — a
   screen reader shouldn't be told "link" for something that opens a dialog. */
function StoryCard({
  story,
  onPlay,
  large = false,
}: {
  story: Story;
  onPlay: (s: Story) => void;
  large?: boolean;
}) {
  const vid = youTubeId(story.youtube);
  const external = !!story.href && /^https?:/i.test(story.href);

  const body = (
    <>
      <CardMedia story={story} large={large} />
      <div className={large ? "mt-6" : "mt-5"}>
        <Eyebrow>{story.category}</Eyebrow>
        <h3
          className={`mt-4 font-display font-semibold tracking-tight leading-snug text-foreground group-hover:text-white transition-colors ${
            large ? "text-2xl md:text-[28px]" : "text-xl"
          }`}
          style={{ textWrap: "balance" } as React.CSSProperties}
        >
          {story.title}
        </h3>
        {story.deck && (
          <p className={`mt-3 text-muted-foreground leading-relaxed ${large ? "text-base max-w-2xl" : "text-sm"}`}>
            {story.deck}
          </p>
        )}
        {story.byline && (
          <p className="mt-3 text-xs text-muted-foreground/70">{story.byline}</p>
        )}
        <span className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-primary">
          {vid ? "Watch" : "Read"}
          <span className="grid place-items-center w-6 h-6 rounded-full bg-primary/15 transition-transform duration-300 group-hover:translate-x-0.5">
            <ArrowRight className="w-3.5 h-3.5" />
          </span>
        </span>
      </div>
    </>
  );

  const shell = "group block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-xl";

  if (vid) {
    return (
      <button type="button" onClick={() => onPlay(story)} className={shell} data-testid={`card-story-${story.slug}`}>
        {body}
      </button>
    );
  }
  if (story.href) {
    return external ? (
      <a href={story.href} target="_blank" rel="noopener noreferrer" className={shell} data-testid={`card-story-${story.slug}`}>
        {body}
      </a>
    ) : (
      <Link href={story.href} className={shell} data-testid={`card-story-${story.slug}`}>
        {body}
      </Link>
    );
  }
  return <div className={shell} data-testid={`card-story-${story.slug}`}>{body}</div>;
}

/* ── Lightbox ──────────────────────────────────────────────────────────────
   Escape closes, focus moves to the close button on open and returns to the
   trigger on close, and body scroll is locked while it's up. */
function PlayerDialog({ story, onClose }: { story: Story; onClose: () => void }) {
  const vid = youTubeId(story.youtube)!;
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8 bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={story.title}
      onClick={onClose}
      data-testid="dialog-story-player"
    >
      <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <Eyebrow>{story.category}</Eyebrow>
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
        <div className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-black" style={{ aspectRatio: "16 / 9" }}>
          <iframe
            src={youTubeEmbed(vid)}
            title={story.title}
            className="absolute inset-0 w-full h-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        </div>
        {story.deck && <p className="mt-4 text-sm md:text-base text-white/70 leading-relaxed max-w-3xl">{story.deck}</p>}
      </div>
    </div>
  );
}

export default function Stories() {
  const [active, setActive] = useState<StoryCategory | "All">("All");
  const [playing, setPlaying] = useState<Story | null>(null);
  /** The featured slot plays in place rather than in the dialog — it's
   *  already large enough that a modal would be a lateral move. */
  const [heroPlaying, setHeroPlaying] = useState(false);

  const featured = useMemo(() => STORIES.filter((s) => s.featured), []);
  const hero = featured[0];
  const heroSecondary = featured.slice(1, 3);
  const rest = useMemo(() => STORIES.filter((s) => !s.featured), []);

  /** Only offer a chip for a category that actually has stories behind it —
   *  a filter that returns nothing is worse than no filter. */
  const chips = useMemo(
    () => STORY_CATEGORIES.filter((c) => rest.some((s) => s.category === c)),
    [rest],
  );
  const shown = active === "All" ? rest : rest.filter((s) => s.category === active);

  /** Deep link: /stories#slug opens that story's player. */
  useEffect(() => {
    const slug = window.location.hash.replace(/^#/, "");
    if (!slug) return;
    const match = STORIES.find((s) => s.slug === slug && youTubeId(s.youtube));
    if (!match) return;
    // The hero plays in place, so a deep link to it should do the same rather
    // than stacking a dialog over the player it already has.
    if (match.slug === STORIES.find((s) => s.featured)?.slug) setHeroPlaying(true);
    else setPlaying(match);
  }, []);

  const heroVid = youTubeId(hero?.youtube);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Same standalone chrome as About, Privacy and Terms. */}
      <nav className="container mx-auto px-6 h-20 flex items-center justify-between border-b border-white/5">
        <Link href="/" data-testid="link-stories-logo">
          <img src={logoUrl} alt="FullScale Creator Portal" className="h-9 md:h-10 w-auto" />
        </Link>
        <Link
          href="/"
          className="text-sm text-muted-foreground hover:text-white transition-colors inline-flex items-center gap-2"
          data-testid="link-stories-home"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
      </nav>

      <main className="container mx-auto px-6">
        {/* ── Masthead ── */}
        <header className="pt-14 pb-10 md:pt-20 md:pb-12 max-w-3xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary mb-5">Stories</p>
          <h1
            className="text-3xl sm:text-4xl md:text-5xl font-bold font-display tracking-tight leading-[1.08]"
            style={{ textWrap: "balance" } as React.CSSProperties}
          >
            What a placement looks like when it works
          </h1>
          <p className="mt-5 text-base md:text-lg text-muted-foreground leading-relaxed">
            Creators, brands and the machinery in between — shown rather than described.
          </p>
        </header>

        {/* ── Featured ── */}
        {hero && (
          <section aria-labelledby="featured-heading" className="pb-14 md:pb-20 border-b border-white/5">
            <h2
              id="featured-heading"
              className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 mb-7"
            >
              Featured
            </h2>

            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-10 lg:gap-12 items-start">
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
              >
                {heroVid && heroPlaying ? (
                  <div className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-black" style={{ aspectRatio: "16 / 9" }}>
                    <iframe
                      src={youTubeEmbed(heroVid)}
                      title={hero.title}
                      className="absolute inset-0 w-full h-full"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                    />
                  </div>
                ) : (
                  <StoryCard
                    story={hero}
                    large
                    onPlay={() => setHeroPlaying(true)}
                  />
                )}
                {heroVid && heroPlaying && (
                  <div className="mt-6">
                    <Eyebrow>{hero.category}</Eyebrow>
                    <h3 className="mt-4 text-2xl md:text-[28px] font-display font-semibold tracking-tight leading-snug">
                      {hero.title}
                    </h3>
                    {hero.deck && <p className="mt-3 text-muted-foreground leading-relaxed max-w-2xl">{hero.deck}</p>}
                  </div>
                )}
              </motion.div>

              {heroSecondary.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-10">
                  {heroSecondary.map((s) => (
                    <StoryCard key={s.slug} story={s} onPlay={setPlaying} />
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── All stories ── */}
        <section aria-labelledby="all-heading" className="py-14 md:py-20">
          <div className="flex flex-wrap items-center justify-between gap-6 mb-9">
            <h2 id="all-heading" className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
              All stories
            </h2>

            {chips.length > 1 && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Filter stories by category">
                {(["All", ...chips] as Array<StoryCategory | "All">).map((c) => (
                  <button
                    key={c}
                    onClick={() => setActive(c)}
                    aria-pressed={active === c}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${
                      active === c
                        ? "bg-primary text-white"
                        : "bg-white/5 text-muted-foreground hover:text-white hover:bg-white/10 border border-white/10"
                    }`}
                    data-testid={`chip-category-${String(c).toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>

          {shown.length > 0 ? (
            /* Three columns at desktop, matching the measured Agentio grid;
               two at tablet, one on a phone. */
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-7 gap-y-14">
              {shown.map((s) => (
                <StoryCard key={s.slug} story={s} onPlay={setPlaying} />
              ))}
            </div>
          ) : (
            /* Honest empty state. This page ships before the videos do, and a
               row of skeleton cards pretending otherwise would be worse. */
            <div className="rounded-2xl border border-white/10 bg-card/40 p-8 md:p-10 max-w-2xl">
              <h3 className="text-lg md:text-xl font-display font-semibold tracking-tight mb-3">
                More stories are on the way
              </h3>
              <p className="text-muted-foreground leading-relaxed">
                We're filming the first set now — how a scan finds a surface, what a creator sees when a brand
                asks for one, and what the finished cut looks like next to the original.
              </p>
              <a
                href="mailto:fullscale_info@gofullscale.co"
                className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
                data-testid="link-stories-contact"
              >
                Tell us what you'd want to see
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          )}
        </section>
      </main>

      {playing && <PlayerDialog story={playing} onClose={() => setPlaying(null)} />}

      <Footer />
    </div>
  );
}
