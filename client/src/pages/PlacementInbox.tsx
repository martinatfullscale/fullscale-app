/**
 * Placement Inbox — creator-side view of pending brand placement requests.
 *
 * Each pending request shows: brand product card, video thumbnail + title,
 * surface-type chip + bbox preview, optional brand message, accept/reject buttons.
 *
 * Approve → status flips to creator_approved → next remix render bakes the
 * brand product onto that surface. Reject → status flips to creator_rejected
 * (with optional reason).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, CheckCircle2, XCircle, Inbox, ExternalLink, Image as ImageIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient as qc } from "@/lib/queryClient";

interface PlacementInboxItem {
  id: number;
  brandUserId: string;
  videoId: number;
  brandProductId: number;
  surfaceId: number;
  status: string;
  brandMessage: string | null;
  createdAt: string | null;
  product: {
    id: number;
    name: string;
    imageUrl: string;
    thumbnailUrl: string | null;
    category: string | null;
  } | null;
  video: {
    id: number;
    title: string;
    thumbnailUrl: string | null;
  } | null;
  surface: {
    id: number;
    surfaceType: string;
    timestamp: string;
    boundingBox: { x: string; y: string; width: string; height: string };
  } | null;
}

export default function PlacementInbox() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const { data, isLoading } = useQuery<{ placements: PlacementInboxItem[]; count: number }>({
    queryKey: ["/api/creator/placements/inbox"],
  });

  const approveMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/creator/placements/${id}/approve`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/creator/placements/inbox"] });
      queryClient.invalidateQueries({ queryKey: ["/api/creator/placements/inbox/count"] });
      toast({ title: "Placement approved", description: "It will appear in your next remix render." });
    },
    onError: (err: any) => {
      toast({ title: "Approval failed", description: err?.message || "Try again", variant: "destructive" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      await apiRequest("POST", `/api/creator/placements/${id}/reject`, { reason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/creator/placements/inbox"] });
      queryClient.invalidateQueries({ queryKey: ["/api/creator/placements/inbox/count"] });
      setRejectingId(null);
      setRejectReason("");
      toast({ title: "Placement rejected" });
    },
    onError: (err: any) => {
      toast({ title: "Rejection failed", description: err?.message || "Try again", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const placements = data?.placements ?? [];

  return (
    <div className="container mx-auto px-4 md:px-6 py-8 max-w-5xl">
      <div className="mb-8 flex items-center gap-3">
        <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
          <Inbox className="w-6 h-6 text-emerald-400" />
        </div>
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-inbox-title">
            Placement Inbox
          </h1>
          <p className="text-sm md:text-base text-muted-foreground">
            Brands have requested placements on your videos. Approve to include them in your next remix.
          </p>
        </div>
      </div>

      {placements.length === 0 ? (
        <Card className="border-dashed border-border/50">
          <CardContent className="py-16 text-center">
            <Inbox className="w-12 h-12 mx-auto mb-4 text-muted-foreground/40" />
            <h2 className="text-lg font-semibold mb-2">No pending requests</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              When brands want to place a product on your videos, requests will appear here for your approval.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {placements.map((p) => (
            <Card
              key={p.id}
              className="border-border/50 hover:border-emerald-500/30 transition-colors"
              data-testid={`card-placement-${p.id}`}
            >
              <CardContent className="p-5">
                <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-5 items-start">
                  {/* Video + surface preview */}
                  <div className="space-y-2">
                    {p.video?.thumbnailUrl ? (
                      <div className="relative aspect-video rounded-lg overflow-hidden bg-muted">
                        <img
                          src={p.video.thumbnailUrl}
                          alt={p.video.title}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                        {p.surface && (
                          <div
                            className="absolute border-2 border-emerald-400 bg-emerald-400/20 rounded-sm pointer-events-none"
                            style={{
                              left: `${parseFloat(p.surface.boundingBox.x) * 100}%`,
                              top: `${parseFloat(p.surface.boundingBox.y) * 100}%`,
                              width: `${parseFloat(p.surface.boundingBox.width) * 100}%`,
                              height: `${parseFloat(p.surface.boundingBox.height) * 100}%`,
                            }}
                          />
                        )}
                      </div>
                    ) : (
                      <div className="aspect-video rounded-lg bg-muted flex items-center justify-center">
                        <ImageIcon className="w-8 h-8 text-muted-foreground/40" />
                      </div>
                    )}
                    {p.surface && (
                      <Badge variant="outline" className="text-xs">
                        {p.surface.surfaceType} @ {parseFloat(p.surface.timestamp).toFixed(1)}s
                      </Badge>
                    )}
                  </div>

                  {/* Details */}
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs uppercase tracking-widest text-muted-foreground/70 mb-1">Video</p>
                      <p className="font-medium" data-testid={`text-video-title-${p.id}`}>
                        {p.video?.title || "Unknown video"}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {p.product?.thumbnailUrl || p.product?.imageUrl ? (
                        <img
                          src={p.product.thumbnailUrl || p.product.imageUrl}
                          alt={p.product.name}
                          className="w-14 h-14 rounded-md border border-border/50 object-contain bg-white"
                        />
                      ) : (
                        <div className="w-14 h-14 rounded-md border border-border/50 bg-muted flex items-center justify-center">
                          <ImageIcon className="w-6 h-6 text-muted-foreground/40" />
                        </div>
                      )}
                      <div>
                        <p className="text-xs uppercase tracking-widest text-muted-foreground/70 mb-1">
                          Brand product
                        </p>
                        <p className="font-medium" data-testid={`text-product-name-${p.id}`}>
                          {p.product?.name || "Unknown product"}
                        </p>
                        {p.product?.category && (
                          <p className="text-xs text-muted-foreground capitalize">{p.product.category}</p>
                        )}
                      </div>
                    </div>
                    {p.brandMessage && (
                      <div className="rounded-md bg-muted/50 border border-border/50 p-3">
                        <p className="text-xs uppercase tracking-widest text-muted-foreground/70 mb-1">
                          Message from brand
                        </p>
                        <p className="text-sm leading-relaxed">{p.brandMessage}</p>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex md:flex-col gap-2 md:w-32">
                    <Button
                      onClick={() => approveMutation.mutate(p.id)}
                      disabled={approveMutation.isPending}
                      className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white"
                      data-testid={`button-approve-${p.id}`}
                    >
                      <CheckCircle2 className="w-4 h-4 mr-1.5" />
                      Approve
                    </Button>
                    <Button
                      onClick={() => setRejectingId(p.id)}
                      variant="outline"
                      className="flex-1 border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                      data-testid={`button-reject-${p.id}`}
                    >
                      <XCircle className="w-4 h-4 mr-1.5" />
                      Reject
                    </Button>
                    {p.video && (
                      <Link href={`/remix/${p.video.id}`}>
                        <Button variant="ghost" size="sm" className="text-xs w-full" data-testid={`button-preview-${p.id}`}>
                          <ExternalLink className="w-3 h-3 mr-1" />
                          Preview
                        </Button>
                      </Link>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Reject dialog with optional reason */}
      <Dialog open={rejectingId !== null} onOpenChange={(open) => !open && setRejectingId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject placement</DialogTitle>
            <DialogDescription>
              Optionally tell the brand why. They'll see your reason. Leave blank to reject silently.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Doesn't fit my brand voice / wrong audience / already at brand cap / etc."
            rows={4}
            data-testid="textarea-reject-reason"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectingId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => rejectingId && rejectMutation.mutate({ id: rejectingId, reason: rejectReason })}
              disabled={rejectMutation.isPending}
              data-testid="button-confirm-reject"
            >
              <XCircle className="w-4 h-4 mr-1.5" />
              Reject placement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
