/**
 * Measurement readout — the CV-impact research spine, visible.
 *
 * Fixtures are the experimental units (a stable physical surface, the same
 * desk across rescans and episodes); products are the treatments; screen
 * time is the exposure dose. A fixture becomes analyzable for within-unit
 * comparison once it has carried two or more distinct products — that's the
 * same-scene / different-products design. See docs/DATA_DICTIONARY.md §1.
 */
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TopBar } from "@/components/TopBar";
import { Loader2, FlaskConical, Layers, Radio, Clock, Activity, Users, MessageSquare, Globe2 } from "lucide-react";

interface FixtureRow {
  surfaceGroupId: string;
  displayLabel: string | null;
  surfaceType: string;
  isModelBacked: boolean;
  videoCount: number;
  fixtureSecondsSum: number;
  orphaned: boolean;
  totalOccurrences: number;
  distinctProducts: number;
  liveExposures: number;
  treatments: Array<{
    brandProductId: number | null;
    productName: string | null;
    startedAt: string;
    endedAt: string | null;
    endReason: string | null;
  }>;
}

interface Readout {
  summary: {
    fixtures: number;
    crossEpisodeFixtures: number;
    modelBackedFixtures: number;
    multiTreatmentFixtures: number;
    wallClockSupplySec: number;
    orphanedFixtures: number;
    openTreatmentWindows: number;
    controlPeriods: number;
    liveExposures: number;
  };
  fixtures: FixtureRow[];
}

interface CrossPlatform {
  generatedAt: string;
  headline: string[];
  design: Record<string, number>;
  platforms: Array<{
    platform: string;
    label: string;
    role: string;
    account: { supported: boolean; snapshots: number; accounts: number; daysOfHistory: number; lastCapture: string | null };
    content: {
      supported: boolean; posts: number; snapshots: number; daysOfHistory: number;
      retentionCurves: number; demographics: number; dailyMetricRows: number; comments: number;
    };
    strengths: string[];
    limits: string[];
  }>;
  analyses: Array<{
    id: string;
    question: string;
    design: string;
    platforms: string[];
    status: "ready" | "accumulating" | "blocked";
    evidence: string;
    blocking: string[];
  }>;
}

const STATUS_STYLE: Record<string, string> = {
  ready: "text-emerald-400 border-emerald-500/30",
  accumulating: "text-amber-400 border-amber-500/30",
  blocked: "text-muted-foreground border-white/15",
};

const fmtDuration = (sec: number) => {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
};

export default function AdminMeasurement() {
  const { data, isLoading, isError } = useQuery<Readout>({
    queryKey: ["/api/admin/measurement/fixtures"],
    queryFn: async () => {
      const res = await fetch("/api/admin/measurement/fixtures", { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load readout (${res.status})`);
      return res.json();
    },
  });

  const { data: retention } = useQuery<{
    summary: { exposures: number; withRetention: number; awaitingCurves: number; meanLiftVsVideoMean: number | null };
    exposures: Array<any>;
  }>({
    queryKey: ["/api/admin/measurement/retention"],
    queryFn: async () => {
      const res = await fetch("/api/admin/measurement/retention", { credentials: "include" });
      if (!res.ok) throw new Error("retention unavailable");
      return res.json();
    },
    retry: 1,
  });

  const { data: platforms } = useQuery<{
    platforms: Array<{ platform: string; ready: boolean; detail: string; videosUnderMeasurement: number }>;
    totalUnderMeasurement: number;
  }>({
    queryKey: ["/api/admin/measurement/platforms"],
    queryFn: async () => {
      const res = await fetch("/api/admin/measurement/platforms", { credentials: "include" });
      if (!res.ok) throw new Error("capability unavailable");
      return res.json();
    },
    retry: 1,
  });

  const { data: creators } = useQuery<{
    summary: { creatorsWithActivity: number; totalTaught: number; totalSelfDirectedPlacements: number; awaitingBrandResponse: number; eventLogStartedAt: string };
    creators: Array<any>;
  }>({
    queryKey: ["/api/admin/measurement/creators"],
    queryFn: async () => {
      const res = await fetch("/api/admin/measurement/creators", { credentials: "include" });
      if (!res.ok) throw new Error("creator behavior unavailable");
      return res.json();
    },
    retry: 1,
  });

  const { data: audience } = useQuery<{
    summary: { exposures: number; withComments: number; withDailySeries: number };
    exposures: Array<any>;
  }>({
    queryKey: ["/api/admin/measurement/audience-response"],
    queryFn: async () => {
      const res = await fetch("/api/admin/measurement/audience-response", { credentials: "include" });
      if (!res.ok) throw new Error("audience response unavailable");
      return res.json();
    },
    retry: 1,
  });

  // The pilot readout: capability × corpus, per platform, and the analyses
  // those two facts jointly permit. Deliberately leads the page — it's the
  // answer to "what can you actually prove", which every other panel details.
  const { data: cross } = useQuery<CrossPlatform>({
    queryKey: ["/api/admin/measurement/cross-platform"],
    queryFn: async () => {
      const res = await fetch("/api/admin/measurement/cross-platform", { credentials: "include" });
      if (!res.ok) throw new Error("cross-platform readout unavailable");
      return res.json();
    },
    retry: 1,
  });

  const s = data?.summary;

  const Stat = ({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string | number; hint?: string }) => (
    <Card className="border-border/50">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground mb-1">
          {icon}
          <span className="text-[11px] uppercase tracking-wider">{label}</span>
        </div>
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar />
      <main className="p-8 max-w-5xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <FlaskConical className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold font-display">Measurement Readout</h1>
        </div>
        <p className="text-muted-foreground text-sm mb-8 max-w-2xl">
          Fixtures are the experimental units — a stable physical surface tracked across
          rescans and episodes. Products are the treatments; screen time is the exposure
          dose. A fixture becomes analyzable for same-scene comparison once it has carried
          two or more distinct products.
        </p>
        <p className="text-[11px] text-muted-foreground/70 mb-8 max-w-2xl">
          Grain note: scene screen time is replicated onto every fixture in that scene, so
          the per-fixture column is <em>fixture-seconds</em> (dose), not wall-clock. The
          supply tile sums at the scene grain to avoid double-counting.
        </p>

        {isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : isError || !data ? (
          <p className="text-destructive text-sm">Couldn't load the readout — are you signed in as an admin?</p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
              <Stat icon={<Layers className="w-3.5 h-3.5" />} label="Fixtures tracked" value={s!.fixtures}
                hint={`${s!.crossEpisodeFixtures} seen in 2+ videos · ${s!.modelBackedFixtures} eligible to persist`} />
              <Stat icon={<FlaskConical className="w-3.5 h-3.5" />} label="Analyzable" value={s!.multiTreatmentFixtures}
                hint="2+ products on the same fixture" />
              <Stat icon={<Clock className="w-3.5 h-3.5" />} label="Exposure supply" value={fmtDuration(s!.wallClockSupplySec)}
                hint="wall-clock, scene grain (not fixture-summed)" />
              <Stat icon={<Radio className="w-3.5 h-3.5" />} label="Live exposures" value={s!.liveExposures}
                hint="placements linked to real posts" />
              <Stat icon={<Clock className="w-3.5 h-3.5" />} label="Open treatments" value={s!.openTreatmentWindows}
                hint="products currently on a fixture" />
              <Stat icon={<FlaskConical className="w-3.5 h-3.5" />} label="Control periods" value={s!.controlPeriods}
                hint="observed, untreated — the counterfactual" />
            </div>

            {s!.liveExposures === 0 && (
              <Card className="border-amber-500/25 bg-amber-500/5 mb-8">
                <CardContent className="p-4">
                  <p className="text-sm font-medium mb-1">No live exposures yet</p>
                  <p className="text-xs text-muted-foreground">
                    Exposure supply is being recorded, but no placement has been linked to a
                    published post — so no audience outcome can be attributed to a treatment yet.
                    Creators link theirs from Saved Placements once a render is ready.
                  </p>
                </CardContent>
              </Card>
            )}

            {cross && (
              <section className="mb-10" data-testid="cross-platform-readout">
                <div className="flex items-center gap-2 mb-1">
                  <Globe2 className="w-4 h-4 text-primary" />
                  <h2 className="font-semibold text-sm">Cross-platform analytical position</h2>
                </div>
                <p className="text-[11px] text-muted-foreground mb-4 max-w-2xl">
                  What each platform <em>can</em> measure, what we <em>have</em>, and which analyses
                  those two facts jointly permit. Limits are stated because a reviewer who finds one
                  we didn't state discounts everything else.
                </p>

                <Card className="border-primary/20 bg-primary/5 mb-5">
                  <CardContent className="p-4 space-y-2.5">
                    {cross.headline.map((h, i) => (
                      <p key={i} className="text-xs leading-relaxed">{h}</p>
                    ))}
                  </CardContent>
                </Card>

                {/* The 2x2 that used to be half-empty: account and content
                    history, per platform. */}
                <div className="grid md:grid-cols-2 gap-3 mb-5">
                  {cross.platforms.map((p) => {
                    const dark = !p.account.supported && !p.content.supported;
                    return (
                      <Card key={p.platform} className={`border-border/50 ${dark ? "opacity-60" : ""}`}>
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between gap-2 mb-0.5">
                            <p className="text-sm font-medium">{p.label}</p>
                            <span className="text-[10px] text-muted-foreground">{p.role}</span>
                          </div>

                          <div className="grid grid-cols-2 gap-2 my-3">
                            <div className="rounded border border-white/10 p-2">
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Account</p>
                              <p className="text-sm font-semibold tabular-nums">
                                {p.account.snapshots.toLocaleString()}
                                <span className="text-[10px] font-normal text-muted-foreground"> snapshots</span>
                              </p>
                              <p className="text-[10px] text-muted-foreground">
                                {p.account.accounts} account{p.account.accounts === 1 ? "" : "s"} · {p.account.daysOfHistory}d history
                              </p>
                            </div>
                            <div className="rounded border border-white/10 p-2">
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Content</p>
                              <p className="text-sm font-semibold tabular-nums">
                                {p.content.snapshots.toLocaleString()}
                                <span className="text-[10px] font-normal text-muted-foreground"> snapshots</span>
                              </p>
                              <p className="text-[10px] text-muted-foreground">
                                {p.content.posts} post{p.content.posts === 1 ? "" : "s"} · {p.content.daysOfHistory}d history
                              </p>
                            </div>
                          </div>

                          {(p.content.retentionCurves > 0 || p.content.demographics > 0 || p.content.comments > 0 || p.content.dailyMetricRows > 0) && (
                            <div className="flex flex-wrap gap-1.5 mb-3">
                              {p.content.retentionCurves > 0 && <Badge variant="outline" className="text-[10px]">{p.content.retentionCurves} retention curve{p.content.retentionCurves === 1 ? "" : "s"}</Badge>}
                              {p.content.demographics > 0 && <Badge variant="outline" className="text-[10px]">{p.content.demographics} demographics</Badge>}
                              {p.content.dailyMetricRows > 0 && <Badge variant="outline" className="text-[10px]">{p.content.dailyMetricRows.toLocaleString()} day-rows</Badge>}
                              {p.content.comments > 0 && <Badge variant="outline" className="text-[10px]">{p.content.comments.toLocaleString()} comments</Badge>}
                            </div>
                          )}

                          {p.strengths.length > 0 && (
                            <ul className="space-y-1 mb-2">
                              {p.strengths.map((t, i) => (
                                <li key={i} className="text-[11px] text-muted-foreground leading-snug pl-3 relative">
                                  <span className="absolute left-0 text-emerald-400">+</span>{t}
                                </li>
                              ))}
                            </ul>
                          )}
                          <ul className="space-y-1">
                            {p.limits.map((t, i) => (
                              <li key={i} className="text-[11px] text-muted-foreground leading-snug pl-3 relative">
                                <span className="absolute left-0 text-amber-400">−</span>{t}
                              </li>
                            ))}
                          </ul>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>

                <h3 className="font-semibold text-xs mb-2 text-muted-foreground uppercase tracking-wider">
                  Analyses this corpus supports
                </h3>
                <Card className="border-border/50">
                  <CardContent className="p-0">
                    {cross.analyses.map((a) => (
                      <div key={a.id} className="p-4 border-b border-white/5 last:border-b-0" data-testid={`analysis-${a.id}`}>
                        <div className="flex items-start justify-between gap-3 mb-1">
                          <p className="text-sm font-medium">{a.question}</p>
                          <Badge variant="outline" className={`text-[10px] shrink-0 ${STATUS_STYLE[a.status]}`}>
                            {a.status}
                          </Badge>
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-snug mb-2">{a.design}</p>
                        <p className="text-[11px] tabular-nums mb-1.5">{a.evidence}</p>
                        <div className="flex flex-wrap gap-1 mb-1.5">
                          {a.platforms.map((pl) => (
                            <Badge key={pl} variant="outline" className="text-[10px] capitalize">{pl}</Badge>
                          ))}
                        </div>
                        {a.blocking.map((b, i) => (
                          <p key={i} className="text-[11px] text-amber-400/90 leading-snug pl-3 relative">
                            <span className="absolute left-0">→</span>{b}
                          </p>
                        ))}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </section>
            )}

            {retention && retention.summary.exposures > 0 && (
              <>
                <div className="flex items-center gap-2 mb-3">
                  <Activity className="w-4 h-4 text-primary" />
                  <h2 className="font-semibold text-sm">Retention at the placement</h2>
                </div>
                <Card className="border-border/50 mb-10">
                  <CardContent className="p-4">
                    {retention.summary.withRetention === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {retention.summary.exposures} exposure{retention.summary.exposures === 1 ? "" : "s"} recorded,
                        no retention curves yet. YouTube only surfaces retention once a video passes its
                        reporting threshold; curves are fetched daily.
                      </p>
                    ) : (
                      <>
                        <p className="text-sm mb-3">
                          <span className="font-medium tabular-nums">{retention.summary.withRetention}</span>{" "}
                          of {retention.summary.exposures} exposures have a curve.
                          {retention.summary.meanLiftVsVideoMean != null && (
                            <>
                              {" "}Mean viewer presence at the placement vs. the video's own average:{" "}
                              <span className={`font-semibold tabular-nums ${retention.summary.meanLiftVsVideoMean >= 0 ? "text-emerald-400" : "text-amber-400"}`}>
                                {retention.summary.meanLiftVsVideoMean >= 0 ? "+" : ""}
                                {(retention.summary.meanLiftVsVideoMean * 100).toFixed(1)}pp
                              </span>
                            </>
                          )}
                        </p>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-white/10 text-left text-muted-foreground">
                                <th className="p-2 font-medium">Fixture</th>
                                <th className="p-2 font-medium">Position</th>
                                <th className="p-2 font-medium">Watching there</th>
                                <th className="p-2 font-medium">vs. video avg</th>
                              </tr>
                            </thead>
                            <tbody>
                              {retention.exposures.filter((e: any) => e.retention).slice(0, 25).map((e: any) => (
                                <tr key={e.exposureId} className="border-b border-white/5 last:border-b-0">
                                  <td className="p-2 font-mono text-[11px]">{e.surfaceGroupId ?? "—"}</td>
                                  <td className="p-2 tabular-nums">
                                    {(e.retention.positionRatio * 100).toFixed(0)}% in
                                    <span className="text-muted-foreground"> ({e.retention.postRelativeSec}s)</span>
                                  </td>
                                  <td className="p-2 tabular-nums">{(e.retention.watchRatioAtPlacement * 100).toFixed(1)}%</td>
                                  <td className={`p-2 tabular-nums ${e.retention.liftVsVideoMean >= 0 ? "text-emerald-400" : "text-amber-400"}`}>
                                    {e.retention.liftVsVideoMean >= 0 ? "+" : ""}
                                    {(e.retention.liftVsVideoMean * 100).toFixed(1)}pp
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              </>
            )}

            {creators && creators.creators.length > 0 && (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <Users className="w-4 h-4 text-primary" />
                  <h2 className="font-semibold text-sm">Creator behavior</h2>
                </div>
                <p className="text-[11px] text-muted-foreground/70 mb-3">
                  How creators actually use integrations. Event coverage begins {creators.summary.eventLogStartedAt} —
                  decisions before that were stored without a date and can't be recovered.
                  Brand responsiveness is computed from existing timestamps and covers all history.
                </p>
                <Card className="border-border/50 mb-10">
                  <CardContent className="p-0 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-white/10 text-left text-muted-foreground">
                          <th className="p-3 font-medium text-xs">Creator</th>
                          <th className="p-3 font-medium text-xs" title="Approved / rejected — a creator who rejects nothing is rubber-stamping, not curating">Curation</th>
                          <th className="p-3 font-medium text-xs" title="Hand-drawn surfaces — the highest-intent action in the product">Taught</th>
                          <th className="p-3 font-medium text-xs">Own placements</th>
                          <th className="p-3 font-medium text-xs">Brand requests</th>
                          <th className="p-3 font-medium text-xs">Median reply</th>
                        </tr>
                      </thead>
                      <tbody>
                        {creators.creators.slice(0, 25).map((c: any) => (
                          <tr key={c.creatorUserId} className="border-b border-white/5 last:border-b-0">
                            <td className="p-3">
                              <p className="font-medium truncate max-w-[180px]">{c.name}</p>
                              {c.email && <p className="text-[11px] text-muted-foreground truncate max-w-[180px]">{c.email}</p>}
                            </td>
                            <td className="p-3 tabular-nums">
                              {c.behavior.surfacesApproved}<span className="text-muted-foreground">/{c.behavior.surfacesRejected}</span>
                              {c.behavior.approvalRate != null && (
                                <span className="text-[11px] text-muted-foreground ml-1">({Math.round(c.behavior.approvalRate * 100)}%)</span>
                              )}
                            </td>
                            <td className="p-3 tabular-nums">{c.behavior.surfacesTaught}</td>
                            <td className="p-3 tabular-nums">
                              {c.behavior.placementsCreated}
                              {c.behavior.placementsWentLive > 0 && (
                                <span className="text-[11px] text-emerald-400 ml-1">{c.behavior.placementsWentLive} live</span>
                              )}
                            </td>
                            <td className="p-3 tabular-nums">
                              {c.brandResponsiveness ? (
                                <>
                                  {c.brandResponsiveness.approved}<span className="text-muted-foreground">/{c.brandResponsiveness.rejected}</span>
                                  {c.brandResponsiveness.awaitingResponse > 0 && (
                                    <span className="text-[11px] text-amber-400 ml-1">{c.brandResponsiveness.awaitingResponse} waiting</span>
                                  )}
                                </>
                              ) : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="p-3 tabular-nums">
                              {c.brandResponsiveness?.medianResponseHours != null
                                ? `${c.brandResponsiveness.medianResponseHours}h`
                                : <span className="text-muted-foreground">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              </>
            )}

            {audience && audience.summary.exposures > 0 && (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <MessageSquare className="w-4 h-4 text-primary" />
                  <h2 className="font-semibold text-sm">Audience response to integrations</h2>
                </div>
                <p className="text-[11px] text-muted-foreground/70 mb-3">
                  Comment sentiment split around each placement's go-live, and whether viewers
                  referenced the product at all — the signal that separates reacting to the
                  integration from reacting to the video. YouTube only.
                </p>
                <Card className="border-border/50 mb-10">
                  <CardContent className="p-4">
                    {audience.summary.withComments === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {audience.summary.exposures} exposure{audience.summary.exposures === 1 ? "" : "s"} tracked,
                        no comments collected yet. Comments are gathered daily for videos carrying a live placement.
                        {audience.summary.withDailySeries > 0 && ` Per-day engagement is already in for ${audience.summary.withDailySeries}.`}
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-white/10 text-left text-muted-foreground">
                              <th className="p-2 font-medium">Fixture</th>
                              <th className="p-2 font-medium">Comments before → after</th>
                              <th className="p-2 font-medium">Mentioned the product</th>
                              <th className="p-2 font-medium">Views/day before → after</th>
                            </tr>
                          </thead>
                          <tbody>
                            {audience.exposures.filter((e: any) => e.comments.before.n + e.comments.after.n > 0).slice(0, 25).map((e: any) => (
                              <tr key={e.exposureId} className="border-b border-white/5 last:border-b-0">
                                <td className="p-2 font-mono text-[11px]">{e.surfaceGroupId ?? "—"}</td>
                                <td className="p-2 tabular-nums">
                                  {e.comments.before.n} → {e.comments.after.n}
                                  <span className="text-muted-foreground ml-1">
                                    ({e.comments.after.positive}+ / {e.comments.after.negative}−)
                                  </span>
                                </td>
                                <td className="p-2 tabular-nums">{e.comments.after.mentioningBrand}</td>
                                <td className="p-2 tabular-nums">
                                  {e.engagement.viewsBeforePerDay != null && e.engagement.viewsAfterPerDay != null
                                    ? `${e.engagement.viewsBeforePerDay} → ${e.engagement.viewsAfterPerDay}`
                                    : <span className="text-muted-foreground">—</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            )}

            {platforms && (
              <>
                <h2 className="font-semibold text-sm mb-3">Platform coverage</h2>
                <Card className="border-border/50 mb-10">
                  <CardContent className="p-0">
                    {platforms.platforms.map((p) => (
                      <div key={p.platform} className="flex items-start gap-3 p-3 border-b border-white/5 last:border-b-0">
                        <span
                          className={`mt-1 w-2 h-2 rounded-full shrink-0 ${p.ready ? "bg-emerald-400" : "bg-amber-400"}`}
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium capitalize">
                            {p.platform === "twitter" ? "X" : p.platform}
                            <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                              {p.videosUnderMeasurement} video{p.videosUnderMeasurement === 1 ? "" : "s"} under measurement
                            </span>
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">{p.detail}</p>
                        </div>
                        <Badge
                          variant="outline"
                          className={`shrink-0 text-[10px] ${p.ready ? "text-emerald-400 border-emerald-500/30" : "text-amber-400 border-amber-500/30"}`}
                        >
                          {p.ready ? "collecting" : "blocked"}
                        </Badge>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </>
            )}

            <h2 className="font-semibold text-sm mb-3">Fixtures by exposure supply</h2>
            <Card className="border-border/50">
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left">
                      <th className="p-3 font-medium text-xs text-muted-foreground">Fixture</th>
                      <th className="p-3 font-medium text-xs text-muted-foreground">Videos</th>
                      <th className="p-3 font-medium text-xs text-muted-foreground" title="Scene screen time attributed to this fixture, summed across videos. Not comparable by summing across fixtures in one video.">Fixture-seconds</th>
                      <th className="p-3 font-medium text-xs text-muted-foreground">Treatments</th>
                      <th className="p-3 font-medium text-xs text-muted-foreground">Live</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.fixtures.length === 0 ? (
                      <tr><td colSpan={5} className="p-6 text-center text-muted-foreground text-sm">
                        No fixtures recorded yet — they appear after the next scan.
                      </td></tr>
                    ) : data.fixtures.map((f) => (
                      <tr key={f.surfaceGroupId} className="border-b border-white/5 last:border-b-0" data-testid={`fixture-${f.surfaceGroupId}`}>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <a
                              href={`/api/admin/measurement/fixture/${encodeURIComponent(f.surfaceGroupId)}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-medium hover:text-primary hover:underline"
                              title="Open the crossover timeline: every treatment and control period with the dose that applied during it"
                            >
                              {f.displayLabel || f.surfaceType}
                            </a>
                            {f.videoCount > 1 && (
                              <Badge variant="outline" className="text-[10px] text-sky-400 border-sky-500/30">cross-episode</Badge>
                            )}
                            {f.orphaned && (
                              <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30" title="Has treatment or exposure rows but no exposure-supply row (degenerate scan or pre-instrumentation video)">no supply row</Badge>
                            )}
                            {f.distinctProducts >= 2 && (
                              <Badge variant="outline" className="text-[10px] text-emerald-400 border-emerald-500/30">analyzable</Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground font-mono">{f.surfaceGroupId}</p>
                        </td>
                        <td className="p-3 tabular-nums">{f.videoCount}</td>
                        <td className="p-3 tabular-nums">{fmtDuration(f.fixtureSecondsSum)}</td>
                        <td className="p-3">
                          {f.treatments.length === 0 ? (
                            <span className="text-muted-foreground text-xs">control only</span>
                          ) : (
                            <span className="text-xs">
                              {f.distinctProducts} product{f.distinctProducts === 1 ? "" : "s"}
                              <span className="text-muted-foreground"> · {f.treatments.length} window{f.treatments.length === 1 ? "" : "s"}</span>
                            </span>
                          )}
                        </td>
                        <td className="p-3 tabular-nums">{f.liveExposures}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
