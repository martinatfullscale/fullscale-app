import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bookmark,
  Trash2,
  Eye,
  Clock,
  Loader2,
  Image as ImageIcon,
  Layers,
  Filter,
  Pencil,
  Video,
  RefreshCw,
  Share2,
  Copy,
  Check,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import PlacementPreviewModal from "@/components/PlacementPreviewModal";

interface SavedPlacementEnriched {
  id: number;
  videoId: number;
  surfaceId: number;
  productId: number | null;
  productImageUrl: string;
  createdBy: string;
  role: string;
  sceneGroupId: string | null;
  transform: {
    offsetX: number;
    offsetY: number;
    scale: number;
    rotation: number;
    flipH: boolean;
  };
  blend: {
    opacity: number;
    blendMode: string;
    shadowEnabled: boolean;
    shadowBlur: number;
    shadowOffsetX: number;
    shadowOffsetY: number;
    shadowColor: string;
    featherRadius: number;
    brightness: number;
    contrast: number;
  };
  status: string;
  createdAt: string;
  updatedAt: string;
  videoTitle: string;
  videoThumbnailUrl: string | null;
  videoYoutubeId: string | null;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function SavedPlacements() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [previewPlacement, setPreviewPlacement] = useState<SavedPlacementEnriched | null>(null);
  const [quickEditPlacement, setQuickEditPlacement] = useState<SavedPlacementEnriched | null>(null);
  const [quickEditSurfaces, setQuickEditSurfaces] = useState<any[]>([]);
  const [loadingSurfaces, setLoadingSurfaces] = useState(false);
  const [sharingId, setSharingId] = useState<number | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  // Fetch surfaces when Quick Edit is triggered
  useEffect(() => {
    if (!quickEditPlacement) {
      setQuickEditSurfaces([]);
      return;
    }
    const fetchSurfaces = async () => {
      setLoadingSurfaces(true);
      try {
        // Owner is editing their own placement — show all surfaces (the
        // anchor surface might not be creatorApproved yet on a new scan).
        const res = await fetch(`/api/video/${quickEditPlacement.videoId}/surfaces?includeUnapproved=true`, { credentials: "include" });
        if (res.ok) {
          const surfaces = await res.json();
          // Filter to just the surface this placement is on
          const targetSurface = surfaces.find((s: any) => s.id === quickEditPlacement.surfaceId);
          setQuickEditSurfaces(targetSurface ? [targetSurface] : surfaces.slice(0, 1));
        }
      } catch (err) {
        console.error("[SavedPlacements] Failed to fetch surfaces:", err);
      } finally {
        setLoadingSurfaces(false);
      }
    };
    fetchSurfaces();
  }, [quickEditPlacement]);

  const { data, isLoading } = useQuery<{ placements: SavedPlacementEnriched[] }>({
    queryKey: ["/api/placements"],
    queryFn: async () => {
      const res = await fetch("/api/placements", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch placements");
      return res.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/placements/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete placement");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/placements"] });
      toast({ title: "Placement archived", description: "The placement has been removed." });
      setDeleteId(null);
    },
    onError: (err: any) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  // Share placement handler
  const handleShare = async (placement: SavedPlacementEnriched) => {
    setSharingId(placement.id);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          placementId: placement.id,
          videoId: placement.videoId,
          title: placement.videoTitle || `Placement on ${placement.surfaceType}`,
        }),
      });
      if (!res.ok) throw new Error("Failed to create share link");
      const { slug } = await res.json();
      const fullUrl = `${window.location.origin}/s/${slug}`;
      await navigator.clipboard.writeText(fullUrl);
      setCopiedSlug(slug);
      toast({ title: "Share link copied!", description: fullUrl });
      setTimeout(() => setCopiedSlug(null), 3000);
    } catch (err: any) {
      toast({ title: "Share failed", description: err.message, variant: "destructive" });
    } finally {
      setSharingId(null);
    }
  };

  // Detect user role — creators can export video
  const { data: userTypeData } = useQuery<{ userType?: "creator" | "brand" | null }>({
    queryKey: ["/api/auth/user-type"],
    queryFn: async () => {
      const res = await fetch("/api/auth/user-type", { credentials: "include" });
      if (!res.ok) return { userType: null };
      return res.json();
    },
  });
  const isCreator = userTypeData?.userType === "creator";

  // Export state
  const [exportingId, setExportingId] = useState<number | null>(null);
  const [exportProgress, setExportProgress] = useState<number>(0);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  // Direct export handler — triggers server-side video export with placement
  const handleExport = async (placement: SavedPlacementEnriched) => {
    setExportingId(placement.id);
    setExportProgress(0);
    setExportStatus("Starting export...");
    try {
      // Build placement data for export endpoint
      const placementData = [{
        surfaceId: placement.surfaceId,
        productImageUrl: placement.productImageUrl,
        transform: placement.transform,
        blend: placement.blend,
      }];

      const res = await fetch(`/api/video/${placement.videoId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          placements: placementData,
          canvasWidth: 1920,
          canvasHeight: 1080,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Export failed");
      }

      const { exportId } = await res.json();
      setExportStatus("Processing video...");

      // Poll for progress
      const pollInterval = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/exports/${exportId}`, { credentials: "include" });
          if (!pollRes.ok) return;
          const exportData = await pollRes.json();

          if (exportData.progress) {
            setExportProgress(exportData.progress);
          }

          if (exportData.status === "completed" && exportData.outputUrl) {
            clearInterval(pollInterval);
            setExportStatus("Download ready!");
            setExportProgress(100);

            // Trigger download
            const link = document.createElement("a");
            link.href = exportData.outputUrl;
            link.download = `${placement.videoTitle || "export"}_with_placement.mp4`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            toast({ title: "Export complete!", description: "Your video with product placement is downloading." });
            setTimeout(() => {
              setExportingId(null);
              setExportStatus(null);
            }, 2000);
          } else if (exportData.status === "failed") {
            clearInterval(pollInterval);
            throw new Error(exportData.error || "Export processing failed");
          }
        } catch (pollErr) {
          // Continue polling unless it's a definitive failure
        }
      }, 3000);

      // Safety timeout — stop polling after 10 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
        if (exportingId === placement.id) {
          setExportingId(null);
          setExportStatus(null);
          toast({ title: "Export timeout", description: "Export is taking longer than expected. Check back later.", variant: "destructive" });
        }
      }, 600000);
    } catch (err: any) {
      toast({ title: "Export failed", description: err.message, variant: "destructive" });
      setExportingId(null);
      setExportStatus(null);
    }
  };

  const placements = data?.placements || [];

  // Group placements by video
  const groupedByVideo = placements.reduce<Record<number, SavedPlacementEnriched[]>>((acc, p) => {
    if (!acc[p.videoId]) acc[p.videoId] = [];
    acc[p.videoId].push(p);
    return acc;
  }, {});

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
            <Bookmark className="h-8 w-8 text-primary" />
            Saved Placements
          </h1>
          <p className="text-muted-foreground mt-1">
            View and manage your saved product placements across videos
          </p>
        </div>
        <Badge variant="outline" className="gap-1 text-sm">
          <Layers className="w-3.5 h-3.5" />
          {placements.length} placement{placements.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      {/* Export Progress Banner */}
      {exportingId && exportStatus && (
        <div className="mb-4 p-3 rounded-lg border border-purple-500/30 bg-purple-500/10">
          <div className="flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
            <div className="flex-1">
              <p className="text-sm font-medium text-purple-300">{exportStatus}</p>
              {exportProgress > 0 && (
                <div className="mt-1.5 h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-purple-500 rounded-full transition-all duration-500"
                    style={{ width: `${exportProgress}%` }}
                  />
                </div>
              )}
            </div>
            <span className="text-xs text-purple-400">{exportProgress}%</span>
          </div>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : placements.length === 0 ? (
        <Card>
          <CardContent className="py-20 text-center">
            <Bookmark className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium text-foreground mb-1">No saved placements yet</p>
            <p className="text-muted-foreground">
              Use the Placement Preview tool on any video to create and save product placements.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {Object.entries(groupedByVideo).map(([videoId, videoPlcs]) => {
            const first = videoPlcs[0];
            return (
              <div key={videoId}>
                {/* Video header */}
                <div className="flex items-center gap-3 mb-4">
                  {first.videoThumbnailUrl && (
                    <img
                      src={first.videoThumbnailUrl}
                      alt={first.videoTitle}
                      className="w-16 h-10 rounded object-cover border border-border"
                    />
                  )}
                  <div>
                    <h2 className="text-sm font-semibold text-foreground line-clamp-1">
                      {first.videoTitle}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {videoPlcs.length} placement{videoPlcs.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                </div>

                {/* Placement cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  <AnimatePresence mode="popLayout">
                    {videoPlcs.map((placement, idx) => (
                      <motion.div
                        key={placement.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={{ delay: idx * 0.03 }}
                      >
                        <Card className="group overflow-hidden hover:border-primary/30 transition-all duration-200">
                          {/* Product image preview */}
                          <div
                            className="relative aspect-video bg-muted/30 flex items-center justify-center cursor-pointer"
                            onClick={() => setPreviewPlacement(placement)}
                          >
                            {/* Checkerboard background for transparency */}
                            <div
                              className="absolute inset-0"
                              style={{
                                backgroundImage:
                                  "linear-gradient(45deg, #1a1a2e 25%, transparent 25%), linear-gradient(-45deg, #1a1a2e 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1a1a2e 75%), linear-gradient(-45deg, transparent 75%, #1a1a2e 75%)",
                                backgroundSize: "12px 12px",
                                backgroundPosition: "0 0, 0 6px, 6px -6px, -6px 0px",
                              }}
                            />
                            <img
                              src={placement.productImageUrl}
                              alt="Placement"
                              className="relative max-w-full max-h-full object-contain p-3"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = "none";
                              }}
                            />

                            {/* Hover overlay */}
                            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40">
                              <div className="flex items-center gap-1 text-white text-xs font-medium">
                                <Eye className="w-4 h-4" />
                                Preview
                              </div>
                            </div>

                            {/* Delete button on hover */}
                            <Button
                              variant="destructive"
                              size="icon"
                              className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteId(placement.id);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>

                            {/* Scene group badge */}
                            {placement.sceneGroupId && (
                              <Badge
                                variant="secondary"
                                className="absolute bottom-2 left-2 text-[9px] gap-1"
                              >
                                <Layers className="w-2.5 h-2.5" />
                                Scene Group
                              </Badge>
                            )}
                          </div>

                          {/* Info */}
                          <CardContent className="p-3">
                            <div className="flex items-center justify-between gap-2 mb-1.5">
                              <Badge variant="outline" className="text-[10px]">
                                Surface #{placement.surfaceId}
                              </Badge>
                              <span className="text-[10px] text-muted-foreground tabular-nums">
                                {Math.round(placement.blend.opacity)}% opacity
                              </span>
                            </div>
                            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <Clock className="w-3 h-3" />
                              {placement.createdAt ? formatDate(placement.createdAt) : "Unknown"}
                            </div>
                            {/* Action buttons */}
                            <div className="flex items-center gap-1.5 mt-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="flex-1 gap-1 text-[10px] h-7"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setQuickEditPlacement(placement);
                                }}
                              >
                                <Pencil className="w-3 h-3" />
                                Quick Edit
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="flex-1 gap-1 text-[10px] h-7"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.location.href = `/remix/${placement.videoId}`;
                                }}
                              >
                                <Video className="w-3 h-3" />
                                Full Editor
                              </Button>
                              {isCreator && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="gap-1 text-[10px] h-7 px-2"
                                  title="Export Video with Placement"
                                  disabled={exportingId === placement.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleExport(placement);
                                  }}
                                >
                                  {exportingId === placement.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Download className="w-3 h-3" />
                                  )}
                                </Button>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1 text-[10px] h-7 px-2"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleShare(placement);
                                }}
                                disabled={sharingId === placement.id}
                              >
                                {sharingId === placement.id ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : copiedSlug ? (
                                  <Check className="w-3 h-3 text-green-500" />
                                ) : (
                                  <Share2 className="w-3 h-3" />
                                )}
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Preview Dialog */}
      <Dialog open={!!previewPlacement} onOpenChange={(open) => !open && setPreviewPlacement(null)}>
        <DialogContent className="max-w-lg">
          {previewPlacement && (
            <>
              <DialogHeader>
                <DialogTitle>Placement Details</DialogTitle>
                <DialogDescription>
                  {previewPlacement.videoTitle}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                {/* Product image */}
                <div className="relative aspect-video bg-muted/20 rounded-lg overflow-hidden flex items-center justify-center border border-border">
                  <div
                    className="absolute inset-0"
                    style={{
                      backgroundImage:
                        "linear-gradient(45deg, #1a1a2e 25%, transparent 25%), linear-gradient(-45deg, #1a1a2e 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1a1a2e 75%), linear-gradient(-45deg, transparent 75%, #1a1a2e 75%)",
                      backgroundSize: "16px 16px",
                      backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
                    }}
                  />
                  <img
                    src={previewPlacement.productImageUrl}
                    alt="Product"
                    className="relative max-w-full max-h-full object-contain p-4"
                  />
                </div>

                {/* Transform & Blend info */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-lg bg-card border border-border">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Transform</p>
                    <div className="space-y-1 text-xs">
                      <p>Scale: {Math.round(previewPlacement.transform.scale * 100)}%</p>
                      <p>Rotation: {previewPlacement.transform.rotation.toFixed(0)}&deg;</p>
                      <p>Offset: ({Math.round(previewPlacement.transform.offsetX)}, {Math.round(previewPlacement.transform.offsetY)})</p>
                      {previewPlacement.transform.flipH && <Badge variant="secondary" className="text-[9px]">Flipped</Badge>}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-card border border-border">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Blend</p>
                    <div className="space-y-1 text-xs">
                      <p>Opacity: {previewPlacement.blend.opacity}%</p>
                      <p>Mode: {previewPlacement.blend.blendMode}</p>
                      <p>Shadow: {previewPlacement.blend.shadowEnabled ? "On" : "Off"}</p>
                      <p>Feather: {previewPlacement.blend.featherRadius}px</p>
                    </div>
                  </div>
                </div>

                {/* Metadata */}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Created by: {previewPlacement.createdBy}</span>
                  <span>{previewPlacement.createdAt ? formatDate(previewPlacement.createdAt) : ""}</span>
                </div>
              </div>

              <DialogFooter className="flex-row gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  onClick={() => {
                    setQuickEditPlacement(previewPlacement);
                    setPreviewPlacement(null);
                  }}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Quick Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  onClick={() => {
                    window.location.href = `/remix/${previewPlacement.videoId}`;
                  }}
                >
                  <Video className="w-3.5 h-3.5" />
                  Full Editor
                </Button>
                {isCreator && (
                  <Button
                    variant="default"
                    size="sm"
                    className="gap-1"
                    onClick={() => {
                      window.location.href = `/remix/${previewPlacement.videoId}`;
                    }}
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export Video
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  onClick={() => handleShare(previewPlacement)}
                  disabled={sharingId === previewPlacement.id}
                >
                  {sharingId === previewPlacement.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Share2 className="w-3.5 h-3.5" />
                  )}
                  Share
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setDeleteId(previewPlacement.id);
                    setPreviewPlacement(null);
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  Delete
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Placement</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this placement? It will be archived and no longer visible.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Delete"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick Edit loading state */}
      {quickEditPlacement && loadingSurfaces && (
        <Dialog open={true} onOpenChange={() => { setQuickEditPlacement(null); setLoadingSurfaces(false); }}>
          <DialogContent className="sm:max-w-sm">
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary mb-3" />
              <p className="text-sm text-muted-foreground">Loading scene data...</p>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Quick Edit — opens PlacementPreviewModal with saved data */}
      {quickEditPlacement && quickEditSurfaces.length > 0 && !loadingSurfaces && (
        <PlacementPreviewModal
          open={true}
          onClose={() => {
            setQuickEditPlacement(null);
            setQuickEditSurfaces([]);
            queryClient.invalidateQueries({ queryKey: ["/api/placements"] });
          }}
          videoId={quickEditPlacement.videoId}
          videoTitle={quickEditPlacement.videoTitle}
          surfaces={quickEditSurfaces}
          initialPlacement={{
            productImageUrl: quickEditPlacement.productImageUrl,
            productId: quickEditPlacement.productId,
            transform: quickEditPlacement.transform as any,
            blend: quickEditPlacement.blend as any,
          }}
        />
      )}
    </div>
  );
}
