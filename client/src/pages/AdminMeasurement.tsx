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
import { Loader2, FlaskConical, Layers, Radio, Clock, Activity } from "lucide-react";

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
