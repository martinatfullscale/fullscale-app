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
import { Loader2, Send, AlertTriangle, Image as ImageIcon, CheckCircle2 } from "lucide-react";
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
  videoId: number;
  videoTitle: string;
  videoThumbnailUrl?: string | null;
  open: boolean;
  onClose: () => void;
}

export function BrandPlacementRequestModal({
  videoId,
  videoTitle,
  videoThumbnailUrl,
  open,
  onClose,
}: BrandPlacementRequestModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [selectedSurfaceIds, setSelectedSurfaceIds] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState("");
  const [conflictSurfaceIds, setConflictSurfaceIds] = useState<Set<number>>(new Set());

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

  // Surfaces in this video
  const { data: surfacesData, isLoading: surfacesLoading } = useQuery<{ surfaces?: DetectedSurface[] } | DetectedSurface[]>({
    queryKey: [`/api/videos/${videoId}/surfaces`],
    enabled: open,
  });
  const surfaces: DetectedSurface[] = useMemo(() => {
    if (!surfacesData) return [];
    if (Array.isArray(surfacesData)) return surfacesData;
    return surfacesData.surfaces ?? [];
  }, [surfacesData]);

  // Already-claimed surfaces on this video (so we can disable them)
  const { data: approvedData } = useQuery<{ placements: { surfaceId: number; status: string; brandUserId: string }[] }>({
    queryKey: [`/api/videos/${videoId}/placements/approved`],
    enabled: open,
  });
  const claimedSurfaceIds = useMemo(() => {
    const set = new Set<number>();
    (approvedData?.placements ?? []).forEach((p) => set.add(p.surfaceId));
    return set;
  }, [approvedData]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      const surfaceIds = Array.from(selectedSurfaceIds);
      const res = await apiRequest("POST", "/api/brand/placements", {
        videoId,
        brandProductId: parseInt(selectedProductId),
        surfaceIds,
        message: message.trim() || undefined,
      });
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
          {/* Video header */}
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
              <p className="text-xs uppercase tracking-widest text-muted-foreground/70">Video</p>
              <p className="font-medium truncate" data-testid="text-video-title">
                {videoTitle}
              </p>
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
