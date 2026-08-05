/**
 * CROSS-PLATFORM ANALYTICAL READOUT — the pilot's defensible point of view.
 *
 * Two questions get asked in a pilot conversation, and they are not the same
 * question:
 *
 *   1. "What can you measure?"  — a capability claim. Answering it from a
 *      slide deck is how people end up promising YouTube-grade retention on
 *      Instagram, where the API does not expose a curve at all.
 *   2. "What do you have?"      — a corpus claim. Answering it from intent
 *      rather than row counts is how a study gets designed around data that
 *      will not exist by the readout date.
 *
 * This module answers both from the database, per platform, and then states
 * which analyses those two facts jointly permit. Anything it cannot support
 * is named with the reason, because a stated limit is what makes the rest of
 * the readout credible — the alternative is a reviewer finding the limit
 * themselves and discounting everything.
 *
 * PLATFORM ASYMMETRY, stated once:
 *
 *   YouTube is the only surface with a within-video retention curve. That is
 *   what makes second-level alignment to a placement possible, and it is the
 *   strongest causal claim available anywhere in this dataset. YouTube
 *   Analytics is also retroactive to publish date, so a pre/post comparison
 *   is computable on day one rather than after weeks of collection.
 *
 *   Meta gives no retention curve. Reels expose two watch-time scalars
 *   (average and total), which support a between-post comparison of watch
 *   depth but cannot locate WHERE attention moved inside the post. Meta's
 *   per-media insights are also point-in-time reads with roughly a 90-day
 *   retention on their side, so history only exists because we snapshot it.
 *
 *   Twitch is view counts only, and VOD counters expire with the VOD.
 *   TikTok and X are dark pending scope/tier decisions.
 *
 * The consequence for study design: YouTube carries the mechanism claim
 * ("attention held at the placement moment"), Meta carries the scale and
 * audience claim ("the effect reproduces at reach, on the platform in the
 * pilot"). Neither substitutes for the other, and a design that treats them
 * as interchangeable outcomes will produce a result that does not replicate.
 */

import { db } from "../db";
import { sql } from "drizzle-orm";
import {
  socialInsightSnapshots,
  socialPostSnapshots,
  videoStatSnapshots,
  videoRetentionCurves,
  videoDemographics,
  videoDailyMetrics,
  contentComments,
  fixtureExposure,
  fixtureAssignments,
  placementExposures,
  linkClicks,
  placementConversions,
} from "@shared/schema";

export type AnalysisStatus = "ready" | "accumulating" | "blocked";

export interface PlatformReadout {
  platform: string;
  label: string;
  /** What this platform is FOR in the design — not a ranking, a role. */
  role: string;
  account: {
    supported: boolean;
    snapshots: number;
    accounts: number;
    firstCapture: string | null;
    lastCapture: string | null;
    daysOfHistory: number;
  };
  content: {
    supported: boolean;
    posts: number;
    snapshots: number;
    firstCapture: string | null;
    lastCapture: string | null;
    daysOfHistory: number;
    retentionCurves: number;
    demographics: number;
    dailyMetricRows: number;
    comments: number;
  };
  strengths: string[];
  limits: string[];
}

export interface AnalysisReadout {
  id: string;
  question: string;
  design: string;
  platforms: string[];
  status: AnalysisStatus;
  /** What the current row counts say — the sentence a reviewer can check. */
  evidence: string;
  /** What has to happen for status to become "ready". Empty when ready. */
  blocking: string[];
}

const dayMs = 24 * 60 * 60 * 1000;

function spanDays(first: Date | string | null, last: Date | string | null): number {
  if (!first || !last) return 0;
  const a = new Date(first).getTime();
  const b = new Date(last).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / dayMs));
}

const iso = (d: any): string | null => (d ? new Date(d).toISOString() : null);

export async function buildCrossPlatformReadout(): Promise<{
  generatedAt: string;
  platforms: PlatformReadout[];
  analyses: AnalysisReadout[];
  design: Record<string, number>;
  headline: string[];
}> {
  // ── Raw corpus counts, one grouped query per table ──────────────────
  const [
    acctRows, postRows, statRows, retRows, demoRows, dailyRows, commentRows,
    designRows,
  ] = await Promise.all([
    db.select({
      platform: socialInsightSnapshots.platform,
      snapshots: sql<number>`count(*)::int`,
      accounts: sql<number>`count(distinct ${socialInsightSnapshots.platformAccountId})::int`,
      first: sql<Date | null>`min(${socialInsightSnapshots.capturedAt})`,
      last: sql<Date | null>`max(${socialInsightSnapshots.capturedAt})`,
    }).from(socialInsightSnapshots).groupBy(socialInsightSnapshots.platform),

    db.select({
      platform: socialPostSnapshots.platform,
      snapshots: sql<number>`count(*)::int`,
      posts: sql<number>`count(distinct ${socialPostSnapshots.platformPostId})::int`,
      first: sql<Date | null>`min(${socialPostSnapshots.capturedAt})`,
      last: sql<Date | null>`max(${socialPostSnapshots.capturedAt})`,
    }).from(socialPostSnapshots).groupBy(socialPostSnapshots.platform),

    db.select({
      platform: videoStatSnapshots.platform,
      snapshots: sql<number>`count(*)::int`,
      posts: sql<number>`count(distinct ${videoStatSnapshots.videoId})::int`,
      first: sql<Date | null>`min(${videoStatSnapshots.capturedAt})`,
      last: sql<Date | null>`max(${videoStatSnapshots.capturedAt})`,
    }).from(videoStatSnapshots).groupBy(videoStatSnapshots.platform),

    db.select({
      platform: videoRetentionCurves.platform,
      n: sql<number>`count(distinct ${videoRetentionCurves.videoId})::int`,
    }).from(videoRetentionCurves).groupBy(videoRetentionCurves.platform),

    db.select({
      platform: videoDemographics.platform,
      n: sql<number>`count(distinct ${videoDemographics.videoId})::int`,
    }).from(videoDemographics).groupBy(videoDemographics.platform),

    db.select({
      platform: videoDailyMetrics.platform,
      n: sql<number>`count(*)::int`,
    }).from(videoDailyMetrics).groupBy(videoDailyMetrics.platform),

    db.select({
      platform: contentComments.platform,
      n: sql<number>`count(*)::int`,
    }).from(contentComments).groupBy(contentComments.platform),

    Promise.all([
      db.select({ n: sql<number>`count(distinct ${fixtureExposure.surfaceGroupId})::int` }).from(fixtureExposure),
      db.select({ n: sql<number>`count(*)::int` }).from(fixtureAssignments),
      db.select({ n: sql<number>`count(distinct ${fixtureAssignments.surfaceGroupId})::int` })
        .from(fixtureAssignments).where(sql`${fixtureAssignments.brandProductId} IS NOT NULL`),
      // is_control, not "null product" — a null product with is_control
      // false is a malformed treatment row, and counting it as a control
      // would inflate the counterfactual with broken data.
      db.select({ n: sql<number>`count(*)::int` })
        .from(fixtureAssignments).where(sql`${fixtureAssignments.isControl} = true`),
      // live_at is NOT NULL on this table — a row exists only once a
      // placement has actually gone live, so the row count IS the go-live
      // count. ended_at separates "still running" from "ran and finished".
      db.select({ n: sql<number>`count(*)::int` }).from(placementExposures),
      db.select({ n: sql<number>`count(*)::int` })
        .from(placementExposures).where(sql`${placementExposures.endedAt} IS NULL`),
      db.select({ n: sql<number>`count(*)::int` }).from(linkClicks),
      db.select({ n: sql<number>`count(*)::int` }).from(placementConversions),
      // The flagship design's precondition: one fixture that has carried
      // more than one DISTINCT product. Without this there is no crossover,
      // only a set of unrelated single-arm observations.
      db.execute(sql`
        SELECT count(*)::int AS n FROM (
          SELECT surface_group_id
          FROM fixture_assignments
          WHERE brand_product_id IS NOT NULL
          GROUP BY surface_group_id
          HAVING count(DISTINCT brand_product_id) > 1
        ) t
      `),
    ]),
  ]);

  const pick = (rows: any[], p: string): any =>
    (rows as any[]).find((r) => String(r?.platform) === p);
  const num = (rows: any[], p: string, field = "n"): number => Number(pick(rows, p)?.[field] ?? 0);
  const one = (r: any): number => Number(r?.[0]?.n ?? 0);

  const [
    fixturesRaw, assignmentsRaw, treatedFixturesRaw, controlPeriodsRaw,
    exposuresRaw, currentlyLiveRaw, clicksRaw, conversionsRaw, crossoverRaw,
  ] = designRows as any[];

  const design = {
    fixtures: one(fixturesRaw),
    assignments: one(assignmentsRaw),
    treatedFixtures: one(treatedFixturesRaw),
    controlPeriods: one(controlPeriodsRaw),
    placementExposures: one(exposuresRaw),
    livePlacements: one(exposuresRaw),
    currentlyLive: one(currentlyLiveRaw),
    crossoverFixtures: Number((crossoverRaw as any)?.rows?.[0]?.n ?? (crossoverRaw as any)?.[0]?.n ?? 0),
    linkClicks: one(clicksRaw),
    conversions: one(conversionsRaw),
  };

  // ── Per-platform readouts ──────────────────────────────────────────
  const build = (
    platform: string,
    label: string,
    role: string,
    accountSupported: boolean,
    contentSupported: boolean,
    strengths: string[],
    limits: string[],
    contentSource: "video" | "social",
  ): PlatformReadout => {
    const a = pick(acctRows as any, platform) as any;
    const c = (contentSource === "video" ? pick(statRows as any, platform) : pick(postRows as any, platform)) as any;
    return {
      platform,
      label,
      role,
      account: {
        supported: accountSupported,
        snapshots: Number(a?.snapshots ?? 0),
        accounts: Number(a?.accounts ?? 0),
        firstCapture: iso(a?.first),
        lastCapture: iso(a?.last),
        daysOfHistory: spanDays(a?.first ?? null, a?.last ?? null),
      },
      content: {
        supported: contentSupported,
        posts: Number(c?.posts ?? 0),
        snapshots: Number(c?.snapshots ?? 0),
        firstCapture: iso(c?.first),
        lastCapture: iso(c?.last),
        daysOfHistory: spanDays(c?.first ?? null, c?.last ?? null),
        retentionCurves: num(retRows, platform),
        demographics: num(demoRows, platform),
        dailyMetricRows: num(dailyRows, platform),
        comments: num(commentRows, platform),
      },
      strengths,
      limits,
    };
  };

  const platforms: PlatformReadout[] = [
    build(
      "youtube", "YouTube", "Mechanism — where the causal claim is made",
      true, true,
      [
        "Audience retention curve per video (~100 buckets) — the only surface where attention can be located at the SECOND the product appears",
        "Analytics reports are retroactive to publish date, so pre/post comparison is computable immediately rather than after a collection window",
        "Per-video demographics (age × gender), which is what makes a same-fixture product comparison honest rather than confounded by audience mix",
        "Comment text readable under the already-granted youtube.readonly scope — the qualitative half of audience response",
      ],
      [
        "Retention is normalized to a ratio of video duration, so aligning a placement requires the published asset's duration and its trim offset — a clip republished from a longer source needs clip_start_sec subtracted first",
        "Channel-level stats are current values only; the history exists solely because this app now snapshots them",
        "Retention and demographics require the creator's OAuth to remain connected — a revoked token ends the series, it does not backfill",
      ],
      "video",
    ),
    build(
      "instagram", "Instagram", "Scale and audience — where the effect must reproduce",
      true, true,
      [
        "Account insights + follower demographics with our own longitudinal record beyond Meta's ~90-day retention",
        "Per-media views, reach, saves, shares and total interactions, now appended per cycle so a post has a trajectory rather than a single reading",
        "Reels expose average and total watch time — a between-post measure of watch depth",
      ],
      [
        "NO within-post retention curve exists in the Meta API. Watch-depth is two scalars, so 'attention held at the placement moment' is not measurable on Instagram at any budget — it is an API limit, not a collection gap",
        "Insights are point-in-time reads with no retroactive history, so pre/post around a go-live only works for placements that go live AFTER snapshotting starts",
        "Comment text needs an App Review permission this integration does not hold",
        "Per-media demographics are unavailable; only account-level audience breakdowns exist",
      ],
      "social",
    ),
    build(
      "facebook", "Facebook", "Scale and audience — secondary Meta surface",
      true, true,
      [
        "Page follower and engagement history on our own longitudinal record",
        "Per-post impressions, reach, video views, reactions, comments and shares, appended per cycle",
      ],
      [
        "No within-post retention curve, same as Instagram",
        "Several page and post metric families were deprecated by Meta in the 2025–26 wave; the surviving set is narrower than the Instagram one",
        "post_impressions counts deliveries rather than plays — not directly comparable to a YouTube view without saying so",
      ],
      "social",
    ),
    build(
      "twitch", "Twitch", "Reach only — supporting evidence, not a primary outcome",
      true, true,
      [
        "View counts for public VODs and clips on an app token — no creator OAuth needed",
        "Channel follower history now accumulating on the same cadence as the other platforms",
      ],
      [
        "Views only: no likes, no comments, no retention, no demographics",
        "VOD view counters expire WITH the VOD (14/60 days by account tier), so clips are the only durable series",
        "Broadcaster identity is inferred from imported content, not from a connected account — ownership is unverified and flagged as such on every row",
      ],
      "video",
    ),
    build(
      "tiktok", "TikTok", "Dark — pending scope",
      false, false,
      [],
      [
        "Per-video metrics need the video.list scope added to the connect flow, creator re-authorization, and creator ownership of the post — URL-paste import does not establish ownership",
        "No comment list is exposed to this integration",
      ],
      "video",
    ),
    build(
      "twitter", "X", "Dark — pending API tier",
      false, false,
      [],
      [
        "Scopes and the public_metrics fetcher exist; read access needs a paid API tier",
        "No retention or demographics at any tier relevant here",
      ],
      "video",
    ),
  ];

  const yt = platforms.find((p) => p.platform === "youtube")!;
  const ig = platforms.find((p) => p.platform === "instagram")!;
  const fb = platforms.find((p) => p.platform === "facebook")!;
  const metaContentPosts = ig.content.posts + fb.content.posts;
  const metaContentSnaps = ig.content.snapshots + fb.content.snapshots;
  const metaAcctSnaps = ig.account.snapshots + fb.account.snapshots;

  // ── What the corpus permits, stated as testable analyses ───────────
  const analyses: AnalysisReadout[] = [];

  analyses.push({
    id: "retention-at-placement",
    question: "Do viewers hold attention at the second the placed product is on screen?",
    design:
      "Align placement_exposures.source_start_sec (minus clip_start_sec) to the video's normalized retention curve and compare the watch-ratio slope across the placement window against the same video's baseline slope and against relativeRetentionPerformance.",
    platforms: ["youtube"],
    status: yt.content.retentionCurves > 0 && design.livePlacements > 0 ? "ready" : "accumulating",
    evidence: `${yt.content.retentionCurves} video(s) with a retention curve; ${design.livePlacements} placement(s) with a recorded go-live.`,
    blocking: [
      ...(yt.content.retentionCurves === 0 ? ["No retention curves captured yet — needs a connected YouTube creator with a published, measured video"] : []),
      ...(design.livePlacements === 0 ? ["No placement has been marked live, so there are no seconds to align to"] : []),
    ],
  });

  analyses.push({
    id: "pre-post-trajectory",
    question: "Did the content's audience trajectory change when the placement went live?",
    design:
      "Interrupted time series on the content's own daily series, using the pre-live segment as its own counterfactual. YouTube supplies this retroactively from video_daily_metrics; Meta supplies it forward-only from social_post_snapshots deltas.",
    platforms: ["youtube", "instagram", "facebook"],
    status: design.livePlacements > 0 && (yt.content.dailyMetricRows > 0 || metaContentSnaps > 0) ? "ready" : "accumulating",
    evidence: `${yt.content.dailyMetricRows} retroactive YouTube day-rows; ${metaContentSnaps} Meta post snapshot(s) across ${metaContentPosts} post(s); ${design.livePlacements} live placement(s).`,
    blocking: [
      ...(design.livePlacements === 0 ? ["No live placements yet"] : []),
      ...(metaContentSnaps === 0 ? ["Meta post history starts at first snapshot — a Meta placement that went live before then has no usable pre-period"] : []),
    ],
  });

  analyses.push({
    id: "fixture-crossover",
    question: "Held the scene constant, does product A outperform product B?",
    design:
      "Within-fixture crossover: the same surface_group_id carries different products across non-overlapping treatment windows, with scene screen-time as the exposure dose. The fixture is its own control, which removes scene, creator and format as confounds in one step.",
    platforms: ["youtube", "instagram", "facebook", "twitch"],
    status: design.crossoverFixtures > 0 ? "ready" : "accumulating",
    evidence: `${design.crossoverFixtures} fixture(s) have carried more than one distinct product; ${design.treatedFixtures} fixture(s) treated at all, out of ${design.fixtures} observed.`,
    blocking: design.crossoverFixtures > 0 ? [] : [
      "No fixture has carried two different products yet — this is the flagship design and it needs a second campaign on an already-used fixture, not more fixtures",
    ],
  });

  analyses.push({
    id: "treated-vs-control-window",
    question: "Against the same fixture untreated, what did the treatment change?",
    design:
      "Compare outcomes over explicit control periods (the fixture observed with no product) against its treatment windows. Note that assignment is NOT random — brand_match_score and placement_viability drive which fixtures get treated, so any estimate needs those as covariates or a matched comparison.",
    platforms: ["youtube", "instagram", "facebook"],
    status: design.controlPeriods > 0 && design.treatedFixtures > 0 ? "ready" : "accumulating",
    evidence: `${design.controlPeriods} explicit control period(s); ${design.treatedFixtures} treated fixture(s).`,
    blocking: [
      ...(design.controlPeriods === 0 ? ["No control periods opened yet"] : []),
      ...(design.treatedFixtures === 0 ? ["No fixture has been treated yet"] : []),
    ],
  });

  analyses.push({
    id: "channel-growth-confound",
    question: "Was the movement the placement, or was the whole channel moving that month?",
    design:
      "Difference the content-level series against the creator's account-level series over the same window. Without this, a creator whose channel doubled in the campaign month reads as a large placement effect.",
    platforms: ["youtube", "instagram", "facebook", "twitch"],
    status: (yt.account.snapshots > 0 || metaAcctSnaps > 0) ? "accumulating" : "blocked",
    evidence: `${yt.account.snapshots} YouTube channel snapshot(s) over ${yt.account.daysOfHistory} day(s); ${metaAcctSnaps} Meta account snapshot(s).`,
    blocking: [
      "Needs at least two captures spanning the campaign window on both levels — the series starts the day snapshotting starts and cannot be backfilled",
    ],
  });

  analyses.push({
    id: "audience-composition",
    question: "Were the compared audiences actually comparable?",
    design:
      "Use per-video demographics as covariates in any cross-content comparison. YouTube gives this per video; Meta gives it only at account level, so a Meta comparison controls for the creator's audience rather than the post's.",
    platforms: ["youtube", "instagram", "facebook"],
    status: yt.content.demographics > 0 ? "ready" : "accumulating",
    evidence: `${yt.content.demographics} video(s) with per-video demographics. Meta contributes account-level breakdowns only.`,
    blocking: yt.content.demographics > 0 ? [] : ["No per-video demographics captured yet"],
  });

  analyses.push({
    id: "qualitative-response",
    question: "What did the audience actually SAY about the integration?",
    design:
      "Classify comments for sentiment and brand mention, split pre/post go-live. Brand mention is the signal that separates a reaction to the integration from a reaction to the video.",
    platforms: ["youtube"],
    status: yt.content.comments > 0 ? "ready" : "accumulating",
    evidence: `${yt.content.comments} comment(s) captured and classified. Instagram and Facebook comment text needs an App Review permission we do not hold; TikTok exposes no list; Twitch has none.`,
    blocking: yt.content.comments > 0 ? [] : ["No comments captured yet — needs a live placement on a connected YouTube channel"],
  });

  analyses.push({
    id: "click-attribution",
    question: "Did the placement drive traffic?",
    design:
      "First-party tracking links minted per placement, clicked from the creator's description or pinned comment. Conversions arrive only via brand server-to-server postback — a placement is pixels in a frame and is not clickable, so this measures link traffic alongside the placement, never the placement itself.",
    platforms: ["youtube", "instagram", "facebook", "twitch"],
    status: design.linkClicks > 0 ? "ready" : "accumulating",
    evidence: `${design.linkClicks} click(s), ${design.conversions} reported conversion(s).`,
    blocking: [
      ...(design.linkClicks === 0 ? ["No tracking link has been clicked yet"] : []),
      ...(design.conversions === 0 ? ["Zero conversions means no brand is reporting them, NOT that no conversions happened — this needs a brand-side pixel integration, which is a partnership decision"] : []),
    ],
  });

  // ── The three sentences to lead with ───────────────────────────────
  const headline = [
    `YouTube carries the mechanism claim: ${yt.content.retentionCurves} video(s) have a second-level retention curve that a placement can be aligned to, plus ${yt.content.demographics} with per-video audience composition. No other platform in this pilot can locate attention inside a post.`,
    `Meta carries the scale claim: ${metaContentPosts} post(s) under content-level tracking and ${metaAcctSnaps} account-level capture(s). Meta exposes watch-DEPTH but not watch-POSITION, so a Meta result confirms that an effect reproduces at reach — it cannot independently establish the mechanism.`,
    `The flagship crossover — same fixture, different products — currently has ${design.crossoverFixtures} qualifying fixture(s) out of ${design.fixtures} observed and ${design.treatedFixtures} treated. That number, not total video count, is the gating metric for the readout.`,
  ];

  return {
    generatedAt: new Date().toISOString(),
    platforms,
    analyses,
    design,
    headline,
  };
}
