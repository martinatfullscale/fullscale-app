/**
 * BrandPlacementRequests — brand-side tracking for placement requests.
 *
 * Closes the "brand goes dark after sending a request" gap: brands can now
 * see each request's status through the creator-review lifecycle
 * (pending_creator_review → creator_approved / creator_rejected /
 * brand_withdrawn / expired), read the creator's rejection reason, and
 * withdraw a request that hasn't been (or has just been) approved.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Loader2, Send, Clock, CheckCircle2, XCircle, Ban, Hourglass, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface HydratedPlacement {
  id: number;
  status: string;
  videoId: number;
  brandMessage: string | null;
  rejectionReason: string | null;
  placementFeeCents: number | null;
  durationTerm: string | null;
  createdAt: string | null;
  reviewedAt: string | null;
  product: { id: number; name: string; imageUrl: string | null; thumbnailUrl: string | null; category: string | null } | null;
  video: { id: number; title: string; thumbnailUrl: string | null } | null;
  clip: { id: number; exportPath: string | null; thumbnailPath: string | null; renderStatus: string | null; suggestedTitle: string | null } | null;
}

const STATUS_META: Record<string, { label: string; className: string; icon: any }> = {
  pending_creator_review: { label: "Awaiting creator", className: "bg-amber-500/15 text-amber-400 border-amber-500/30", icon: Clock },
  creator_approved: { label: "Rendering", className: "bg-sky-500/15 text-sky-400 border-sky-500/30", icon: Loader2 },
  pending_brand_review: { label: "Review the render", className: "bg-violet-500/15 text-violet-400 border-violet-500/30", icon: Clock },
  brand_approved: { label: "Approved — ready for launch", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", icon: CheckCircle2 },
  creator_rejected: { label: "Declined", className: "bg-red-500/15 text-red-400 border-red-500/30", icon: XCircle },
  brand_withdrawn: { label: "Withdrawn", className: "bg-gray-500/15 text-gray-400 border-gray-500/30", icon: Ban },
  expired: { label: "Expired", className: "bg-gray-500/15 text-gray-400 border-gray-500/30", icon: Hourglass },
};

function formatFee(cents: number | null | undefined): string {
  if (!cents) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function BrandPlacementRequests() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ placements: HydratedPlacement[] }>({
    queryKey: ["/api/brand/placements"],
    queryFn: async () => {
      const res = await fetch("/api/brand/placements", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load placement requests");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const approveMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/brand/placements/${id}/approve`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Approve failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Placement approved", description: "The creator has been notified — this placement is ready for launch." });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/placements"] });
    },
    onError: (err: any) => {
      toast({ title: "Approve failed", description: err.message, variant: "destructive" });
    },
  });

  const withdrawMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/brand/placements/${id}/withdraw`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Withdraw failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Request withdrawn" });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/placements"] });
    },
    onError: (err: any) => {
      toast({ title: "Withdraw failed", description: err.message, variant: "destructive" });
    },
  });

  const placements = data?.placements ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 md:px-6 py-8 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Send className="w-6 h-6 text-primary" /> Placement Requests
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every request you've sent to creators, with its current review status.
        </p>
      </div>

      {placements.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-white/10 rounded-2xl">
          <Package className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No placement requests yet</p>
          <p className="text-sm text-gray-500 mt-1">
            Browse creator clips and request a product placement to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {placements.map((p, idx) => {
            const meta = STATUS_META[p.status] || { label: p.status, className: "bg-gray-500/15 text-gray-400 border-gray-500/30", icon: Clock };
            const StatusIcon = meta.icon;
            const canWithdraw = p.status === "pending_creator_review" || p.status === "creator_approved" || p.status === "pending_brand_review";
            const productImg = p.product?.thumbnailUrl || p.product?.imageUrl;
            return (
              <motion.div
                key={p.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(idx * 0.03, 0.3) }}
                className="bg-white/5 border border-white/10 rounded-xl p-4 flex flex-wrap items-center gap-4"
                data-testid={`placement-request-${p.id}`}
              >
                {productImg ? (
                  <img src={productImg} alt={p.product?.name || "Product"} className="w-12 h-12 rounded-lg object-cover bg-black/40" />
                ) : (
                  <div className="w-12 h-12 rounded-lg bg-white/5 flex items-center justify-center">
                    <Package className="w-5 h-5 text-gray-500" />
                  </div>
                )}

                <div className="flex-1 min-w-[200px]">
                  <p className="font-semibold text-white text-sm">
                    {p.product?.name || `Product #${p.id}`}
                    <span className="text-muted-foreground font-normal"> → {p.video?.title || `Video #${p.videoId}`}</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : ""}
                    {p.durationTerm && p.durationTerm !== "single" ? ` · ${p.durationTerm} term` : ""}
                    {" · "}{formatFee(p.placementFeeCents)}
                  </p>
                  {p.status === "creator_rejected" && p.rejectionReason && (
                    <p className="text-xs text-red-400/90 mt-1">Creator: “{p.rejectionReason}”</p>
                  )}
                </div>

                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium ${meta.className}`}>
                  <StatusIcon className="w-3.5 h-3.5" /> {meta.label}
                </span>

                {p.status === "pending_brand_review" && (
                  <div className="w-full mt-2 flex flex-col sm:flex-row items-start gap-3" data-testid={`render-review-${p.id}`}>
                    {p.clip?.exportPath && (
                      <video
                        src={p.clip.exportPath}
                        poster={p.clip.thumbnailPath || undefined}
                        controls
                        preload="metadata"
                        className="w-full sm:w-56 rounded-lg bg-black aspect-[9/16] object-contain"
                      />
                    )}
                    <div className="flex flex-col gap-2">
                      <p className="text-sm text-muted-foreground max-w-xs">
                        {p.clip?.exportPath
                          ? "This is the final cut with your product baked in. Approve it to mark the placement ready for launch."
                          : "The creator approved this placement. Give final approval to mark it ready for launch."}
                      </p>
                      <Button
                        size="sm"
                        disabled={approveMutation.isPending}
                        onClick={() => approveMutation.mutate(p.id)}
                        data-testid={`approve-render-${p.id}`}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white w-fit"
                      >
                        {approveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Approve final render"}
                      </Button>
                    </div>
                  </div>
                )}

                {canWithdraw && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={withdrawMutation.isPending}
                    onClick={() => withdrawMutation.mutate(p.id)}
                    data-testid={`withdraw-${p.id}`}
                    className="text-gray-300 border-white/15 hover:bg-white/10"
                  >
                    {withdrawMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Withdraw"}
                  </Button>
                )}
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
