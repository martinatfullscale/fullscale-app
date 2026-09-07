import type { StoryContent } from "./types";

/**
 * The FullScale story — English source.
 *
 * This IS the copy. It was lifted verbatim out of pages/Story.tsx, so the
 * English site reads exactly as it did before; the page now takes its words
 * from here instead of holding them inline.
 *
 * Every factual claim below is tied to code. See the claim ledger at the top
 * of pages/Story.tsx — two of the promises in section 3 and section 4 are
 * recorded there as NOT currently held by the server. If those sentences
 * change, they change in this file and in the ledger together, and the Arabic
 * module has to change with them.
 */
export const storyEn: StoryContent = {
  nav: { backHome: "Back to Home" },

  masthead: {
    eyebrow: "The FullScale Story",
    title: "How we're building FullScale",
    deck:
      "Written and filmed by the two people doing it — the argument, the honest parts, and the videos where we say it out loud. Creator and brand case studies will live here too, once there are placements worth showing.",
  },

  thesis: "Product placement has existed for a century. Almost no creator was ever offered it.",

  byline: { label: "Written by", linkedin: "LinkedIn" },

  inOurOwnVoice: "In our own voice",

  sections: [
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
  ],

  band: {
    eyebrow: "How we got here",
    title: "The part that isn't about the product",
    deck:
      "Raising the money to build this was its own story, and it did not go the way the tidy version goes. Both of these are ours, filmed at the time.",
  },

  grid: { eyebrow: "Case studies", title: "Placements that ran" },

  find: { title: "Find FullScale", instagram: "Instagram", youtube: "YouTube" },

  player: { close: "Close" },
};
