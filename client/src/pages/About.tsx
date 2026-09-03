import { Link } from "wouter";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight } from "lucide-react";
import logoUrl from "@assets/fullscale-logo_1767679525676.png";
import { Footer } from "@/components/Footer";

/**
 * About — a founders' note, not a corporate page.
 *
 * /about used to render ComingSoon: the footer offered "About Us" and it led
 * to a placeholder saying our story was coming soon. Anyone who wanted to
 * know who was behind this found nothing.
 *
 * The treatment borrows the shape of an Agentio blog post: a declarative
 * headline that carries the thesis, a deck under it, a byline, and one image
 * — then short sections that each make a claim and say what it means. No
 * titles in the byline, by choice.
 *
 * Every factual claim below is checkable against the code:
 *   - 70% creator share — PLATFORM_TAKE_RATE = 0.30, server/lib/placementPricing.ts
 *   - brands only see approved surfaces — the creatorApproved gate in
 *     storage.getReadyVideosForMarketplace
 *   - three approval gates — surface approval, the placement inbox, and the
 *     render review before anything is published
 *   - we don't keep the source video — the scan pulls to /tmp, keeps frames
 *     and coordinates, and discards the file
 *   - payouts are not live — charge_status has never advanced past "pending"
 * If any of those stop being true, this page has to change with them.
 */

/** Save the founders photo here: client/public/founders.jpg
 *  Referenced as a URL rather than imported so a missing file degrades to a
 *  broken image instead of failing the build. */
const FOUNDERS_PHOTO = "/founders.jpg";

const SECTIONS: Array<{ heading: string; body: string[]; takeaway: string }> = [
  {
    heading: "The only thing most creators can sell is an interruption",
    body: [
      "A sixty-second read is the default sponsorship because it is the easy thing to buy and the easy thing to verify. It works. It also asks a creator to stop making the video in order to pay for making the video.",
      "Meanwhile the format brands have wanted for a hundred years — a product sitting in the shot, in a room someone actually lives in — has been reserved for productions with a props department and an agency on retainer.",
    ],
    takeaway: "The gap was never demand. There was simply no way to transact.",
  },
  {
    heading: "We look for the surfaces that are already in frame",
    body: [
      "FullScale reads a video and finds the places a product could believably sit: a desk, a counter, a shelf, a wall behind someone's head. Those places already exist in footage that is already published.",
      "The creator decides which of them are for sale. A brand browsing the marketplace sees only surfaces a creator has opened, prices a placement against that video's real reach, and sends a request.",
    ],
    takeaway: "A brand cannot see a surface its creator hasn't approved.",
  },
  {
    heading: "The creator says yes three times",
    body: [
      "Once when they open a surface to the marketplace. Once when a specific brand asks for it and they accept or decline in their inbox. Once when the finished cut is in front of them and they decide whether it goes out at all.",
      "None of those steps happen on a timer, and nothing publishes on its own.",
    ],
    takeaway: "We would rather lose a placement than surprise a creator with one.",
  },
  {
    heading: "We don't keep your video",
    body: [
      "To find surfaces we pull a video down, take the frames we need, record where the surfaces are, and delete the source. When a brand commits we pull it again at full resolution to render, then delete it again.",
      "What we hold onto is thumbnails, coordinates and results — the parts that make a marketplace work. The library stays yours, on your channel, under your account.",
    ],
    takeaway: "Your footage is not our inventory.",
  },
];

export default function About() {
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

      {/* ── Hero: headline + deck + byline on the left, the photo on the right ── */}
      <header className="relative overflow-hidden">
        {/* An oxblood wash so the photo's own dark-red backdrop meets the page
            instead of ending in a hard rectangle. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              "radial-gradient(58% 70% at 78% 42%, hsl(350 96% 43% / 0.20) 0%, hsl(350 80% 20% / 0.12) 42%, transparent 72%)",
          }}
        />

        <div className="container mx-auto px-6 relative">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-10 lg:gap-14 items-center py-14 md:py-20">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary mb-5">
                Why we're building this
              </p>
              <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold font-display tracking-tight leading-[1.08] mb-6">
                Product placement has existed for a century. Almost no creator was ever offered it.
              </h1>
              <p className="text-base md:text-lg text-muted-foreground leading-relaxed max-w-xl">
                Every sponsorship asks a creator to stop their video and read a script. We are building
                the other option: a real product placed in a scene that was already there, on a surface
                the creator chose, at a price they can see before they agree to it.
              </p>

              {/* Byline. Names only — no titles, deliberately. */}
              <div className="mt-8 pt-6 border-t border-white/10 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-semibold text-foreground" data-testid="text-founder-martin">
                  Martin Ekechukwu
                </span>
                <span className="text-white/35" aria-hidden="true">·</span>
                <span className="text-sm font-semibold text-foreground" data-testid="text-founder-tamara">
                  Tamara Spinner
                </span>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="relative"
            >
              {/* aspect-ratio on the frame, not the img: the box holds its
                  shape before the photo loads, so the hero doesn't reflow. */}
              <div
                className="relative rounded-2xl overflow-hidden border border-white/10 shadow-2xl shadow-black/50 bg-[hsl(350_60%_8%)]"
                style={{ aspectRatio: "1153 / 945" }}
              >
                <img
                  src={FOUNDERS_PHOTO}
                  alt="Martin Ekechukwu and Tamara Spinner"
                  className="absolute inset-0 w-full h-full object-cover object-top"
                  loading="eager"
                  data-testid="img-founders"
                />
              </div>
            </motion.div>
          </div>
        </div>
      </header>

      {/* ── Body ── */}
      <main className="container mx-auto px-6 pb-8">
        {/* Left-aligned, NOT centred: the hero's headline sits in the left
            column of a two-up grid, so centring the body on the page put
            every paragraph a few rems to the right of the headline above it
            and the eye caught the jog. */}
        <div className="max-w-2xl">
          <div className="space-y-12 md:space-y-14">
            {/* No scroll-triggered entry animation on the body, deliberately.
                These were motion.section with initial opacity 0 and
                whileInView + once:true. Three of the five stayed at opacity 0
                in testing: if the observer misses an element — a fast scroll
                past the -80px margin, a backgrounded tab, a throttled frame
                loop — `once` means it never gets a second chance and the copy
                is invisible for good. On a page whose entire job is to be
                read, nothing decorative gets to hide the words. */}
            {SECTIONS.map((s) => (
              <section key={s.heading}>
                <h2 className="text-xl md:text-2xl font-bold font-display tracking-tight mb-4 leading-snug">
                  {s.heading}
                </h2>
                {s.body.map((p) => (
                  <p key={p.slice(0, 24)} className="text-muted-foreground leading-relaxed mb-4">
                    {p}
                  </p>
                ))}
                {/* The takeaway line, the one device worth borrowing outright:
                    a claim, then the sentence that says why it matters. */}
                <p className="mt-5 pl-4 border-l-2 border-primary/60 text-foreground font-medium leading-relaxed">
                  {s.takeaway}
                </p>
              </section>
            ))}

            {/* Honest closing. This page would be worse without it, and the
                Earnings page already tells creators the same thing. */}
            <section className="rounded-2xl border border-white/10 bg-card/40 p-6 md:p-7">
              <h2 className="text-lg md:text-xl font-bold font-display tracking-tight mb-4">
                Where we actually are
              </h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                FullScale is early and invite-only. Scanning, story clips, placements, publishing and
                results are live. Payouts are not: approved placements accrue against a real price, and
                we say so on your earnings page rather than showing you a balance we cannot pay yet.
              </p>
              <p className="text-muted-foreground leading-relaxed">
                We would rather tell you what is missing than let you find out. If something on this
                platform ever shows you a number it cannot stand behind, we want to hear about it.
              </p>
              <a
                href="mailto:fullscale_info@gofullscale.co"
                className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
                data-testid="link-about-contact"
              >
                Tell us what's broken
                <ArrowRight className="w-4 h-4" />
              </a>
            </section>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
