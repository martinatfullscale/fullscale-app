/**
 * Brand Placement Request Modal — opens when a brand wants to place a product
 * on a creator's video. Lets the brand pick a product from their catalog,
 * select one or more surfaces from the video, write an optional message to
 * the creator, and submit.
 *
 * On submit: POST /api/brand/placements creates one assignment per selected
 * surface, all in status pending_creator_review. The creator sees them in
 * their /inbox and approves/rejects.
 *
 * One-brand-per-surface invariant: if any selected surface already has an
 * active placement, the API returns 409 with the conflicting surface IDs;
 * we surface that to the user inline.
 */
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Send, AlertTriangle, Image as ImageIcon, CheckCircle2, DollarSign } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface BrandProduct {
  id: number;
  name: string;
  imageUrl: string;
  thumbnailUrl: string | null;
  category: string | null;
}

interface DetectedSurface {
  id: number;
  surfaceType: string;
  timestamp: string;
  confidence: string;
  boundingBoxX: string;
  boundingBoxY: string;
  boundingBoxWidth: string;
  boundingBoxHeight: string;
}

interface ActivePlacement {
  surfaceId: number;
  brandUserId: string;
  status: string;
}

export interface BrandPlacementRequestModalProps {
  /** Either editorialClipId (preferred — clip-scoped surfaces) OR videoId (legacy/fallback) */
  editorialClipId?: number;
  videoId?: number;
  videoTitle: string;
  videoThumbnailUrl?: string | null;
  /** Optional clip metadata shown in the header when in clip-targeted mode */
  clipDuration?: number;
  clipSuggestedTitle?: string | null;
  open: boolean;
  onClose: () => void;
}

export function BrandPlacementRequestModal({
  editorialClipId,
  videoId,
  videoTitle,
  videoThumbnailUrl,
  clipDuration,
  clipSuggestedTitle,
  open,
  onClose,
}: BrandPlacementRequestModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [selectedSurfaceIds, setSelectedSurfaceIds] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState("");
  const [conflictSurfaceIds, setConflictSurfaceIds] = useState<Set<number>>(new Set());
  const [durationTerm, setDurationTerm] = useState<"single" | "1-month" | "3-month" | "6-month" | "12-month">("single");

  // Brand's products
  const { data: productsData, isLoading: productsLoading } = useQuery<{ products?: BrandProduct[] } | BrandProduct[]>({
    queryKey: ["/api/brand-products"],
    enabled: open,
  });
  const products: BrandProduct[] = useMemo(() => {
    if (!productsData) return [];
    if (Array.isArray(productsData)) return productsData;
    return productsData.products ?? [];
  }, [productsData]);

  // Surfaces — clip-scoped if editorialClipId provided, else all surfaces in the video
  const surfacesEndpoint = editorialClipId
    ? `/api/editorial-clips/${editorialClipId}/surfaces`
    : `/api/videos/${videoId}/surfaces`;
  const { data: surfacesData, isLoading: surfacesLoading } = useQuery<{ surfaces?: DetectedSurface[] } | DetectedSurface[]>({
    queryKey: [surfacesEndpoint],
    enabled: open && (editorialClipId !== undefined || videoId !== undefined),
  });
  const surfaces: DetectedSurface[] = useMemo(() => {
    if (!surfacesData) return [];
    if (Array.isArray(surfacesData)) return surfacesData;
    return surfacesData.surfaces ?? [];
  }, [surfacesData]);

  // Already-claimed surfaces on this video (so we can disable them).
  // Always video-scoped because surface IDs are global; even in clip-targeted mode
  // we want to know if a surface is taken on the parent video.
  const videoIdForApproval = videoId; // clip endpoint also returns video info, but we just need it for the query
  const { data: approvedData } = useQuery<{ placements: { surfaceId: number; status: string; brandUserId: string }[] }>({
    queryKey: [`/api/videos/${videoIdForApproval}/placements/approved`],
    enabled: open && videoIdForApproval !== undefined,
  });
  const claimedSurfaceIds = useMemo(() => {
    const set = new Set<number>();
    (approvedData?.placements ?? []).forEach((p) => set.add(p.surfaceId));
    return set;
  }, [approvedData]);

  // Live price quote — refetches when surfaces or duration change
  const { data: quoteData } = useQuery<{
    creator: { followerCount: number | null; avgRecentViews: number; tier: string };
    video: { ageDays: number; viewCount: number };
    clip: { id: number; monetizationTier: string | null; finalScore: number | null } | null;
    durationTerm: string;
    durationDays: number;
    perSurfaceQuotes: Array<{
      surfaceId: number | null;
      surfaceType: string | null;
      breakdown: {
        placementFeeCents: number;
        creatorPayoutCents: number;
        expectedImpressions: number;
        creatorTier: string;
        creatorTierMultiplier: number;
        contentTier: string;
        contentTierMultiplier: number;
        recencyMultiplier: number;
        surfaceMultiplier: number;
        durationMultiplier: number;
        rawCalculatedCents: number;
      };
    }>;
    totalFeeCents: number;
    totalFeeUsd: string;
    creatorTotalPayoutUsd: string;
    isTestPlacement: boolean;
    rubric: { baseCpmUsd: number };
  }>({
    queryKey: [
      "/api/brand/placements/quote",
      { editorialClipId, videoId, surfaceIds: Array.from(selectedSurfaceIds).sort(), durationTerm },
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (editorialClipId) params.set("editorialClipId", String(editorialClipId));
      else if (videoId) params.set("videoId", String(videoId));
      params.set("durationTerm", durationTerm);
      if (selectedSurfaceIds.size > 0) {
        params.set("surfaceIds", Array.from(selectedSurfaceIds).join(","));
      }
      const res = await fetch(`/api/brand/placements/quote?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch quote");
      return res.json();
    },
    enabled: open && (editorialClipId !== undefined || videoId !== undefined),
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      const surfaceIds = Array.from(selectedSurfaceIds);
      const body: any = {
        brandProductId: parseInt(selectedProductId),
        surfaceIds,
        message: message.trim() || undefined,
        durationTerm,
      };
      // Prefer clip-targeted mode when available
      if (editorialClipId) body.editorialClipId = editorialClipId;
      else body.videoId = videoId;
      const res = await apiRequest("POST", "/api/brand/placements", body);
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Placement request sent",
        description: `${data.count} surface${data.count !== 1 ? "s" : ""} sent to creator for approval.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/placements"] });
      queryClient.invalidateQueries({ queryKey: [`/api/videos/${videoId}/placements/approved`] });
      // Reset form + close
      setSelectedProductId("");
      setSelectedSurfaceIds(new Set());
      setMessage("");
      setConflictSurfaceIds(new Set());
      onClose();
    },
    onError: async (err: any) => {
      // Try to parse server response for 409 conflict details
      try {
        const responseData = err?.response?.data ?? err?.data ?? {};
        if (responseData.conflicts) {
          const conflictIds = new Set<number>(
            responseData.conflicts.map((c: any) => c.surfaceId),
          );
          setConflictSurfaceIds(conflictIds);
          toast({
            title: "Some surfaces are already taken",
            description: `${conflictIds.size} of your selected surfaces have an active placement from another brand. Deselect those and try again.`,
            variant: "destructive",
          });
          return;
        }
      } catch {
        // fall through
      }
      toast({
        title: "Request failed",
        description: err?.message || "Could not send placement request",
        variant: "destructive",
      });
    },
  });

  function toggleSurface(id: number) {
    setSelectedSurfaceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Clear conflict highlight when user changes selection
    if (conflictSurfaceIds.size > 0) {
      setConflictSurfaceIds(new Set());
    }
  }

  const canSubmit = selectedProductId && selectedSurfaceIds.size > 0 && !submitMutation.isPending;
  const selectedProduct = products.find((p) => p.id === parseInt(selectedProductId));

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle data-testid="text-placement-modal-title">Request placement on this video</DialogTitle>
          <DialogDescription>
            Pick a product and the surfaces you want it on. The creator will review and approve before
            it's baked into their next remix.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Video / clip header */}
          <div className="flex items-center gap-3 pb-3 border-b border-border/50">
            {videoThumbnailUrl ? (
              <img
                src={videoThumbnailUrl}
                alt={videoTitle}
                className="w-20 aspect-video object-cover rounded-md border border-border/50"
              />
            ) : (
              <div className="w-20 aspect-video rounded-md bg-muted flex items-center justify-center">
                <ImageIcon className="w-6 h-6 text-muted-foreground/40" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-xs uppercase tracking-widest text-muted-foreground/70">
                {editorialClipId ? "Editorial clip" : "Video"}
              </p>
              <p className="font-medium truncate" data-testid="text-video-title">
                {clipSuggestedTitle || videoTitle}
              </p>
              {editorialClipId && (
                <div className="flex items-center gap-2 mt-0.5">
                  {clipDuration !== undefined && (
                    <Badge variant="outline" className="text-xs">
                      {clipDuration.toFixed(1)}s
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground truncate">
                    from "{videoTitle}"
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Product picker */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Product to place</label>
            {productsLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading your catalog…
              </div>
            ) : products.length === 0 ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                You haven't uploaded any products yet. Add one in <strong>Brand Products</strong> first.
              </div>
            ) : (
              <Select value={selectedProductId} onValueChange={setSelectedProductId}>
                <SelectTrigger data-testid="select-product">
                  <SelectValue placeholder="Select a product from your catalog" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)} data-testid={`option-product-${p.id}`}>
                      <div className="flex items-center gap-2">
                        <img
                          src={p.thumbnailUrl || p.imageUrl}
                          alt={p.name}
                          className="w-6 h-6 rounded object-contain bg-white"
                        />
                        <span>{p.name}</span>
                        {p.category && (
                          <span className="text-xs text-muted-foreground capitalize ml-1">· {p.category}</span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {selectedProduct && (
              <div className="flex items-center gap-3 rounded-md border border-border/50 bg-muted/30 p-2.5">
                <img
                  src={selectedProduct.thumbnailUrl || selectedProduct.imageUrl}
                  alt={selectedProduct.name}
                  className="w-12 h-12 rounded object-contain bg-white"
                />
                <div>
                  <p className="text-sm font-medium">{selectedProduct.name}</p>
                  {selectedProduct.category && (
                    <p className="text-xs text-muted-foreground capitalize">{selectedProduct.category}</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Surface picker */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Surfaces to place on</label>
              <span className="text-xs text-muted-foreground">
                {selectedSurfaceIds.size} selected
              </span>
            </div>
            {surfacesLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading surfaces…
              </div>
            ) : surfaces.length === 0 ? (
              <div className="rounded-md border border-border/50 p-3 text-sm text-muted-foreground">
                This video has no detected surfaces yet. Ask the creator to run scene analysis.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto border border-border/50 rounded-md p-2">
                {surfaces.map((s) => {
                  const isClaimed = claimedSurfaceIds.has(s.id);
                  const isConflict = conflictSurfaceIds.has(s.id);
                  const isSelected = selectedSurfaceIds.has(s.id);
                  const confidencePct = Math.round(parseFloat(s.confidence) * 100);
                  return (
                    <label
                      key={s.id}
                      className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${
                        isClaimed
                          ? "opacity-50 cursor-not-allowed"
                          : isConflict
                          ? "bg-red-500/10 border border-red-500/30"
                          : isSelected
                          ? "bg-emerald-500/10 border border-emerald-500/30"
                          : "hover:bg-muted/50"
                      }`}
                      data-testid={`row-surface-${s.id}`}
                    >
                      <Checkbox
                        checked={isSelected}
                        disabled={isClaimed}
                        onCheckedChange={() => toggleSurface(s.id)}
                        data-testid={`checkbox-surface-${s.id}`}
                      />
                      <div className="flex-1 flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {s.surfaceType}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          @ {parseFloat(s.timestamp).toFixed(1)}s · {confidencePct}% conf
                        </span>
                        {isClaimed && (
                          <Badge variant="outline" className="text-xs border-amber-500/40 text-amber-400">
                            already taken
                          </Badge>
                        )}
                        {isConflict && (
                          <Badge variant="outline" className="text-xs border-red-500/40 text-red-400">
                            <AlertTriangle className="w-3 h-3 mr-1" />
                            conflict
                          </Badge>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Duration term selector */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Engagement duration</label>
            <div className="grid grid-cols-5 gap-1.5">
              {[
                { key: "single" as const, label: "Single", desc: "One-time" },
                { key: "1-month" as const, label: "1 mo", desc: "Locked" },
                { key: "3-month" as const, label: "3 mo", desc: "−17%/mo" },
                { key: "6-month" as const, label: "6 mo", desc: "−25%/mo" },
                { key: "12-month" as const, label: "12 mo", desc: "−33%/mo" },
              ].map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setDurationTerm(d.key)}
                  className={`p-2 rounded-md border text-center transition-colors ${
                    durationTerm === d.key
                      ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-200"
                      : "border-border/50 hover:border-border/80"
                  }`}
                  data-testid={`button-duration-${d.key}`}
                >
                  <div className="text-sm font-medium">{d.label}</div>
                  <div className="text-[10px] text-muted-foreground">{d.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Price quote — full rubric breakdown */}
          {quoteData && selectedSurfaceIds.size > 0 && (
            <div
              className={`rounded-md border p-4 space-y-3 ${
                quoteData.isTestPlacement
                  ? "border-blue-500/40 bg-blue-500/10"
                  : "border-emerald-500/30 bg-emerald-500/5"
              }`}
              data-testid="panel-price-quote"
            >
              {/* Big total */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1 mb-0.5">
                    <DollarSign className="w-3 h-3" />
                    {durationTerm === "single" ? "Total cost" : `Total for ${quoteData.durationDays}-day commitment`}
                  </div>
                  <div className="text-2xl font-bold" data-testid="text-total-fee">
                    ${quoteData.totalFeeUsd}
                  </div>
                </div>
                <div className="text-right text-xs">
                  <div className="text-muted-foreground/70">Creator earns</div>
                  <div className="text-base font-semibold text-emerald-300">
                    ${quoteData.creatorTotalPayoutUsd}
                  </div>
                </div>
              </div>

              {/* Rubric breakdown */}
              {quoteData.perSurfaceQuotes && quoteData.perSurfaceQuotes[0] && (
                <div className="text-[11px] text-muted-foreground/80 space-y-1 pt-2 border-t border-border/50">
                  <div className="flex justify-between">
                    <span>Expected reach</span>
                    <span className="font-mono">
                      {quoteData.perSurfaceQuotes[0].breakdown.expectedImpressions.toLocaleString()} views
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Base CPM</span>
                    <span className="font-mono">${quoteData.rubric?.baseCpmUsd ?? 7}.00</span>
                  </div>
                  <div className="flex justify-between">
                    <span>
                      Creator tier (
                      {quoteData.creator.followerCount?.toLocaleString() ?? "?"} followers,{" "}
                      <span className="capitalize">{quoteData.creator.tier}</span>)
                    </span>
                    <span className="font-mono">
                      ×{quoteData.perSurfaceQuotes[0].breakdown.creatorTierMultiplier.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>
                      Content tier (<span className="capitalize">{quoteData.perSurfaceQuotes[0].breakdown.contentTier}</span>)
                    </span>
                    <span className="font-mono">
                      ×{quoteData.perSurfaceQuotes[0].breakdown.contentTierMultiplier.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Video age ({quoteData.video.ageDays} days)</span>
                    <span className="font-mono">
                      ×{quoteData.perSurfaceQuotes[0].breakdown.recencyMultiplier.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Surface (avg across {selectedSurfaceIds.size})</span>
                    <span className="font-mono">
                      ×
                      {(
                        quoteData.perSurfaceQuotes.reduce(
                          (s, q) => s + q.breakdown.surfaceMultiplier,
                          0,
                        ) / quoteData.perSurfaceQuotes.length
                      ).toFixed(2)}
                    </span>
                  </div>
                  {durationTerm !== "single" && (
                    <div className="flex justify-between">
                      <span>Duration ({durationTerm})</span>
                      <span className="font-mono">
                        ×{quoteData.perSurfaceQuotes[0].breakdown.durationMultiplier.toFixed(2)}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {quoteData.isTestPlacement && (
                <p className="text-xs text-blue-300 font-medium flex items-center gap-1 pt-2 border-t border-border/50">
                  <CheckCircle2 className="w-3 h-3" />
                  Test placement — no charge applied
                </p>
              )}
              {!quoteData.isTestPlacement && (
                <p className="text-xs text-muted-foreground pt-2 border-t border-border/50">
                  Charged when creator approves. Refunded if rejected.
                </p>
              )}
            </div>
          )}

          {/* Message */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Message to creator (optional)</label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Why this is a good fit for your audience, any specific timing requests, etc."
              rows={3}
              maxLength={500}
              data-testid="textarea-brand-message"
            />
            <p className="text-xs text-muted-foreground text-right">{message.length}/500</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => submitMutation.mutate()}
            disabled={!canSubmit}
            className="bg-emerald-600 hover:bg-emerald-500 text-white"
            data-testid="button-send-placement-request"
          >
            {submitMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <Send className="w-4 h-4 mr-1.5" />
            )}
            Send {selectedSurfaceIds.size > 0 ? `${selectedSurfaceIds.size} ` : ""}request
            {selectedSurfaceIds.size !== 1 ? "s" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
