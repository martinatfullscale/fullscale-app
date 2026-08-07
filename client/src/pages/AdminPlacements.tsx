/**
 * Admin placement review queue — the in-app home of the human step.
 * Creators choose placements; here the FullScale team reviews each choice,
 * produces the final render out-of-band, and advances the status so the
 * creator sees where their placement stands (chip on Saved Placements +
 * bell notification).
 */
import { useState, useRef } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { TopBar } from "@/components/TopBar";
import { Loader2, ClipboardCheck, Clock, Eye, CheckCircle2, AlertTriangle, Upload } from "lucide-react";

interface ReviewRow {
  id: number;
  videoId: number;
  videoTitle: string;
  createdBy: string;
  // A pointer, never the image itself: harmonized composites are stored as
  // multi-megabyte base64 data URLs, and inlining 200 of them into this list
  // is what made the queue time out.
  thumbUrl: string | null;
  reviewStatus: string;
  reviewNote: string | null;
  createdAt: string | null;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  submitted: { label: "Submitted", cls: "bg-white/10 text-foreground border-white/20" },
  in_review: { label: "In review", cls: "bg-sky-500/15 text-sky-400 border-sky-500/30" },
  needs_changes: { label: "Needs changes", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  render_ready: { label: "Render ready", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  live: { label: "Live", cls: "bg-violet-500/15 text-violet-300 border-violet-500/30" },
};

export default function AdminPlacements() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [reviewFor, setReviewFor] = useState<number | null>(null);
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [noteText, setNoteText] = useState("");
  const [deliverFor, setDeliverFor] = useState<number | null>(null);
  const [deliverAspect, setDeliverAspect] = useState("16:9");
  const [deliverNote, setDeliverNote] = useState("");
  const [deliverFile, setDeliverFile] = useState<File | null>(null);
  const [delivering, setDelivering] = useState(false);

  const deliverRender = async (placementId: number) => {
    if (!deliverFile) return;
    setDelivering(true);
    try {
      const form = new FormData();
      form.append("render", deliverFile);
      form.append("aspectRatio", deliverAspect);
      if (deliverNote.trim()) form.append("deliveryNote", deliverNote.trim());
      const res = await fetchWithTimeout(`/api/admin/placements/${placementId}/deliver`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Delivery failed");
      toast({
        title: `Delivered to the creator`,
        description: `${deliverAspect} cut is in their Deliveries — they've been notified.`,
      });
      setDeliverFor(null);
      setDeliverFile(null);
      setDeliverNote("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/placements"] });
    } catch (err: any) {
      toast({ title: "Delivery failed", description: err?.message, variant: "destructive" });
    } finally {
      setDelivering(false);
    }
  };

  const { data, isLoading, isError, error } = useQuery<{ placements: ReviewRow[] }>({
    queryKey: ["/api/admin/placements"],
    queryFn: async () => {
      const res = await fetchWithTimeout("/api/admin/placements", { credentials: "include" });
      if (!res.ok) {
        // Keep the server's reason. Throwing a bare status here is why a
        // failing queue read looked like an auth problem, or like nothing at
        // all — with refetchInterval re-entering the retry cycle every 60s,
        // a persistent failure reads as a spinner that never resolves.
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Failed to load queue (${res.status})`);
      }
      return res.json();
    },
    // A 403 is a standing state, not a blip — retrying it just hides the
    // message behind another spinner.
    retry: (count, err: any) => !/403|Admin access/i.test(String(err?.message)) && count < 2,
    refetchInterval: 60_000,
  });

  const reviewMutation = useMutation({
    mutationFn: async (args: { id: number; reviewStatus: string; reviewNote?: string }) => {
      const res = await fetchWithTimeout(`/api/admin/placements/${args.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(args),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Update failed");
      return body;
    },
    onSuccess: (_body, args) => {
      toast({ title: `Placement #${args.id} → ${STATUS_META[args.reviewStatus]?.label ?? args.reviewStatus}`, description: "The creator has been notified." });
      setNoteFor(null);
      setNoteText("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/placements"] });
    },
    onError: (err: Error) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const [fixingSchema, setFixingSchema] = useState(false);
  const fixSchema = async () => {
    setFixingSchema(true);
    try {
      const res = await fetchWithTimeout("/api/admin/schema-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ confirm: true }),
      });
      const body = await res.json();
      const okCount = (body.applied ?? []).filter((a: any) => a.ok).length;
      const failCount = (body.applied ?? []).filter((a: any) => !a.ok).length;
      if (body.driftAfter?.ok) {
        toast({
          title: "Database repaired",
          description: `${okCount} change(s) applied — the schema now matches the code.`,
        });
      } else {
        toast({
          title: failCount > 0 ? "Repair incomplete" : "Repair ran",
          description: failCount > 0
            ? `${okCount} applied, ${failCount} failed — check the server log.`
            : body.error || "Schema still reports drift — check the server log.",
          variant: failCount > 0 ? "destructive" : undefined,
        });
      }
      queryClient.invalidateQueries();
    } catch (err: any) {
      toast({ title: "Repair failed", description: err?.message, variant: "destructive" });
    } finally {
      setFixingSchema(false);
    }
  };

  const rows = data?.placements ?? [];
  // The row you are actively reviewing belongs at the TOP. The server sorts
  // submitted(0) before in_review(1), so pressing "Start review" used to push
  // the placement DOWN the list and look like the button had done nothing.
  const queue = rows
    .filter((r) => r.reviewStatus === "submitted" || r.reviewStatus === "in_review" || r.reviewStatus === "needs_changes")
    .sort((a, b) => {
      const rank = (st: string) => (st === "in_review" ? 0 : st === "submitted" ? 1 : 2);
      return rank(a.reviewStatus) - rank(b.reviewStatus) || b.id - a.id;
    });
  // render_ready is waiting on the creator to post; live is measuring.
  const done = rows.filter((r) => r.reviewStatus === "render_ready" || r.reviewStatus === "live");

  /**
   * The thing you actually review with.
   *
   * The queue could START and FINISH a review but never SHOW the placement:
   * a 40x40 thumbnail and a row title were the whole basis for approving a
   * creator's choice. This puts the video, the surface, and the composite in
   * front of the operator, seeked to the moment the placement occupies.
   */
  const ReviewPanel = ({ id }: { id: number }) => {
    const { data, isLoading, isError, error } = useQuery<any>({
      queryKey: [`/api/admin/placements/${id}/detail`],
      queryFn: async () => {
        const res = await fetchWithTimeout(`/api/admin/placements/${id}/detail`, { credentials: "include" });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to load");
        return res.json();
      },
    });
    const videoRef = useRef<HTMLVideoElement | null>(null);

    // Seek once the media is ready. Setting currentTime before metadata loads
    // is silently ignored, which is why this waits for the event.
    const onLoaded = () => {
      const v = videoRef.current;
      if (v && data?.seekSec != null) { try { v.currentTime = Number(data.seekSec) || 0; } catch { /* seek unsupported */ } }
    };

    if (isLoading) {
      return <div className="mt-3 py-6 text-center"><Loader2 className="w-4 h-4 animate-spin mx-auto text-primary" /></div>;
    }
    if (isError) {
      return <p className="mt-3 text-xs text-destructive">{(error as any)?.message || "Could not load this placement."}</p>;
    }

    const box = data?.surface?.box;
    return (
      <div className="mt-3 p-3 rounded-lg border border-white/10 bg-white/[0.02] grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">In the video</p>
          {data?.video?.streamUrl ? (
            <div className="relative">
              <video
                ref={videoRef}
                src={data.video.streamUrl}
                controls
                preload="metadata"
                onLoadedMetadata={onLoaded}
                className="w-full rounded bg-black aspect-video"
                data-testid={`review-video-${id}`}
              />
              {/* Where the creator put it, drawn over the frame. */}
              {box && (
                <div
                  className="absolute border-2 border-primary/80 rounded pointer-events-none"
                  style={{
                    left: `${box.x * 100}%`, top: `${box.y * 100}%`,
                    width: `${box.w * 100}%`, height: `${box.h * 100}%`,
                  }}
                />
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No playable source on file for this video — review from the composite.
            </p>
          )}
          {data?.seekSec != null && (
            <p className="text-[11px] text-muted-foreground mt-1">
              Seeked to {Math.floor(data.seekSec / 60)}:{String(Math.floor(data.seekSec % 60)).padStart(2, "0")}
              {data?.clip ? " — clip start" : " — surface timestamp"}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">The placement</p>
          <img
            src={data.compositeUrl}
            alt="Placement composite"
            loading="lazy"
            className="w-full rounded border border-white/10 bg-black/30 object-contain max-h-56"
            data-testid={`review-composite-${id}`}
          />
          <dl className="text-xs space-y-1">
            {data?.surface && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground w-20 shrink-0">Surface</dt>
                <dd>{data.surface.surfaceType}{data.surface.timestamp != null ? ` @ ${Math.round(data.surface.timestamp)}s` : ""}</dd>
              </div>
            )}
            {data?.product?.name && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground w-20 shrink-0">Product</dt>
                <dd>{data.product.name}</dd>
              </div>
            )}
            {data?.clip && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground w-20 shrink-0">Clip</dt>
                <dd className="truncate">{data.clip.suggestedTitle || `#${data.clip.id}`} ({data.clip.aspectRatio || "16:9"})</dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20 shrink-0">Harmonized</dt>
              <dd>{data?.placement?.isHarmonized ? "Yes — AI composite" : "No — flat overlay"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20 shrink-0">Chosen by</dt>
              <dd className="truncate">{data?.placement?.createdBy} ({data?.placement?.role})</dd>
            </div>
            {data?.surface?.sceneContext && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground w-20 shrink-0">Scene</dt>
                <dd className="text-muted-foreground">{data.surface.sceneContext}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    );
  };

  const RowCard = ({ row }: { row: ReviewRow }) => {
    const meta = STATUS_META[row.reviewStatus] ?? STATUS_META.submitted;
    return (
      <div className="py-3 px-4 border-b border-white/5 last:border-b-0" data-testid={`placement-row-${row.id}`}>
        <div className="flex items-center gap-3">
          {row.thumbUrl ? (
            <img
              src={row.thumbUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="w-10 h-10 rounded object-contain bg-black/30 border border-white/10 shrink-0"
            />
          ) : (
            <div className="w-10 h-10 rounded bg-black/30 border border-white/10 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">#{row.id} — {row.videoTitle}</p>
            <p className="text-xs text-muted-foreground truncate">{row.createdBy}</p>
          </div>
          <Badge variant="outline" className={`shrink-0 ${meta.cls}`}>{meta.label}</Badge>
        </div>
        <div className="flex items-center gap-2 mt-2 pl-13">
          {row.reviewStatus !== "in_review" && row.reviewStatus !== "render_ready" && row.reviewStatus !== "live" && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1"
              disabled={reviewMutation.isPending}
              onClick={() => {
                // Open the review panel AND mark it in_review. Previously this
                // only flipped the status, so the visible result was a row that
                // moved and nothing else — no way to actually review anything.
                setReviewFor(row.id);
                reviewMutation.mutate({ id: row.id, reviewStatus: "in_review" });
              }}>
              <Eye className="w-3 h-3" /> Start review
            </Button>
          )}
          {(row.reviewStatus === "in_review" || row.reviewStatus === "render_ready") && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1"
              onClick={() => setReviewFor(reviewFor === row.id ? null : row.id)}
              data-testid={`toggle-review-${row.id}`}>
              <Eye className="w-3 h-3" /> {reviewFor === row.id ? "Hide" : "Open"} review
            </Button>
          )}
          {row.reviewStatus !== "live" && (
            <Button size="sm" className="h-7 text-xs gap-1"
              onClick={() => { setDeliverFor(deliverFor === row.id ? null : row.id); setDeliverFile(null); setDeliverNote(""); }}
              data-testid={`deliver-${row.id}`}>
              <Upload className="w-3 h-3" /> Deliver render
            </Button>
          )}
          {row.reviewStatus !== "render_ready" && row.reviewStatus !== "live" && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-amber-400 border-amber-500/30"
              disabled={reviewMutation.isPending}
              onClick={() => { setNoteFor(noteFor === row.id ? null : row.id); setNoteText(row.reviewNote ?? ""); }}>
              <AlertTriangle className="w-3 h-3" /> Needs changes
            </Button>
          )}
        </div>
        {reviewFor === row.id && <ReviewPanel id={row.id} />}

        {deliverFor === row.id && (
          <div className="mt-3 p-3 rounded-lg border border-white/10 bg-white/[0.02] space-y-2">
            <p className="text-xs text-muted-foreground">
              Upload the finished cut. It lands in the creator's Deliveries and notifies them;
              re-delivering the same aspect supersedes the previous version.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/webm"
                onChange={(e) => setDeliverFile(e.target.files?.[0] ?? null)}
                className="text-xs"
                data-testid={`deliver-file-${row.id}`}
              />
              <select
                value={deliverAspect}
                onChange={(e) => setDeliverAspect(e.target.value)}
                className="h-8 rounded-md bg-white/5 border border-white/10 text-xs px-2"
                data-testid={`deliver-aspect-${row.id}`}
              >
                <option value="16:9">16:9 — YouTube</option>
                <option value="9:16">9:16 — Shorts / TikTok / Reels</option>
                <option value="1:1">1:1 — feed</option>
              </select>
            </div>
            <Textarea
              value={deliverNote}
              onChange={(e) => setDeliverNote(e.target.value)}
              placeholder="Optional note to the creator — e.g. 'moved the product to 0:42, it reads better there'"
              className="text-xs min-h-[52px]"
            />
            <Button size="sm" disabled={delivering || !deliverFile} onClick={() => deliverRender(row.id)}>
              {delivering ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
              Deliver to creator
            </Button>
          </div>
        )}

        {noteFor === row.id && (
          <div className="mt-2 flex gap-2">
            <Textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="What should the creator adjust? This goes to them verbatim."
              className="text-xs min-h-[60px]"
            />
            <Button size="sm" className="shrink-0 self-end"
              disabled={reviewMutation.isPending || !noteText.trim()}
              onClick={() => reviewMutation.mutate({ id: row.id, reviewStatus: "needs_changes", reviewNote: noteText.trim() })}>
              Send
            </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar />
      <main className="p-8 max-w-4xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <ClipboardCheck className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold font-display">Placement Review Queue</h1>
        </div>
        <p className="text-muted-foreground text-sm mb-8">
          Creators chose these placements. Review each choice, produce the final render,
          then mark it — the creator sees the status on their placement card and gets a
          bell notification.
        </p>

        {isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : isError ? (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="p-4">
              <p className="text-sm font-medium mb-1">Couldn't load the review queue</p>
              <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                {(error as Error)?.message || "Unknown error"}
              </p>
              {/* Schema drift has a one-click repair: the deployed app holds
                  the right DATABASE_URL, so it applies the missing tables and
                  columns itself. Additive-only DDL — safe to run twice. */}
              {/schema|db:push|does not exist/i.test(String((error as Error)?.message)) && (
                <Button
                  size="sm"
                  disabled={fixingSchema}
                  onClick={fixSchema}
                  data-testid="button-fix-schema"
                >
                  {fixingSchema ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
                  {fixingSchema ? "Repairing database…" : "Repair database schema"}
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-amber-400" />
              <h2 className="font-semibold text-sm">Needs attention ({queue.length})</h2>
            </div>
            <Card className="border-border/50 mb-10">
              <CardContent className="p-0">
                {queue.length === 0
                  ? <p className="text-sm text-muted-foreground p-6 text-center">Queue clear — nothing waiting.</p>
                  : queue.map((row) => <RowCard key={row.id} row={row} />)}
              </CardContent>
            </Card>

            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <h2 className="font-semibold text-sm">Rendered &amp; live ({done.length})</h2>
            </div>
            <Card className="border-border/50">
              <CardContent className="p-0">
                {done.length === 0
                  ? <p className="text-sm text-muted-foreground p-6 text-center">None yet.</p>
                  : done.map((row) => <RowCard key={row.id} row={row} />)}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
