/**
 * Admin placement review queue — the in-app home of the human step.
 * Creators choose placements; here the FullScale team reviews each choice,
 * produces the final render out-of-band, and advances the status so the
 * creator sees where their placement stands (chip on Saved Placements +
 * bell notification).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { TopBar } from "@/components/TopBar";
import { Loader2, ClipboardCheck, Clock, Eye, CheckCircle2, AlertTriangle } from "lucide-react";

interface ReviewRow {
  id: number;
  videoId: number;
  videoTitle: string;
  createdBy: string;
  productImageUrl: string;
  harmonizedImageUrl: string | null;
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
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [noteText, setNoteText] = useState("");

  const { data, isLoading, isError } = useQuery<{ placements: ReviewRow[] }>({
    queryKey: ["/api/admin/placements"],
    queryFn: async () => {
      const res = await fetch("/api/admin/placements", { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load queue (${res.status})`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const reviewMutation = useMutation({
    mutationFn: async (args: { id: number; reviewStatus: string; reviewNote?: string }) => {
      const res = await fetch(`/api/admin/placements/${args.id}/review`, {
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

  const rows = data?.placements ?? [];
  const queue = rows.filter((r) => r.reviewStatus === "submitted" || r.reviewStatus === "in_review" || r.reviewStatus === "needs_changes");
  // render_ready is waiting on the creator to post; live is measuring.
  const done = rows.filter((r) => r.reviewStatus === "render_ready" || r.reviewStatus === "live");

  const RowCard = ({ row }: { row: ReviewRow }) => {
    const meta = STATUS_META[row.reviewStatus] ?? STATUS_META.submitted;
    return (
      <div className="py-3 px-4 border-b border-white/5 last:border-b-0" data-testid={`placement-row-${row.id}`}>
        <div className="flex items-center gap-3">
          <img
            src={row.harmonizedImageUrl || row.productImageUrl}
            alt=""
            className="w-10 h-10 rounded object-contain bg-black/30 border border-white/10 shrink-0"
          />
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
              onClick={() => reviewMutation.mutate({ id: row.id, reviewStatus: "in_review" })}>
              <Eye className="w-3 h-3" /> Start review
            </Button>
          )}
          {row.reviewStatus !== "render_ready" && row.reviewStatus !== "live" && (
            <Button size="sm" className="h-7 text-xs gap-1"
              disabled={reviewMutation.isPending}
              onClick={() => reviewMutation.mutate({ id: row.id, reviewStatus: "render_ready" })}>
              <CheckCircle2 className="w-3 h-3" /> Render ready
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
          <p className="text-destructive text-sm">Couldn't load the queue — are you signed in as an admin?</p>
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
