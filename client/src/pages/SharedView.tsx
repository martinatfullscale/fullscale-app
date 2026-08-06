/**
 * SharedView — Public viewer page for shareable links
 *
 * Renders at /s/:slug — no authentication required.
 * Shows composited placement frame, video metadata, and optional export download.
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { useParams, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Play,
  Download,
  Eye,
  Clock,
  Share2,
  ExternalLink,
  Film,
  Loader2,
  Image as ImageIcon,
  ArrowLeft,
  CheckCircle,
  MessageSquare,
  AlertTriangle,
  ThumbsUp,
  RotateCcw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

interface SharedData {
  slug: string;
  title: string;
  createdBy: string;
  viewCount: number;
  createdAt: string;
  video: {
    id: number;
    title: string;
    thumbnailUrl: string | null;
    duration: string | null;
    platform: string;
  };
  placement: {
    id: number;
    productImageUrl: string;
    surfaceId: number;
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
  } | null;
  export: {
    id: number;
    status: string;
    outputUrl: string | null;
    progress: number;
  } | null;
  /** A1 release pages: present when this link was minted at brand-approval. */
  release: {
    placementId: number;
    clipUrl: string | null;
    thumbnailUrl: string | null;
    clipTitle: string | null;
    aspectRatio: string | null;
    duration: number | null;
    product: { name: string; category: string | null; imageUrl: string | null } | null;
    creatorName: string | null;
    brandName: string | null;
    approvedAt: string | null;
  } | null;
  surfaces: Array<{
    id: number;
    surfaceType: string;
    timestamp: string;
    boundingBoxX: string;
    boundingBoxY: string;
    boundingBoxWidth: string;
    boundingBoxHeight: string;
    frameUrl: string | null;
  }>;
}

interface ReviewContext {
  bidId: number | null;
  bidStatus: string | null;
  brandEmail: string | null;
  brandName: string | null;
  bidAmount: number | null;
  reviewNote: string | null;
}

export default function SharedView() {
  const params = useParams<{ slug: string }>();
  const [, setLocation] = useLocation();
  const [data, setData] = useState<SharedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [composited, setComposited] = useState(false);

  // Review context & state
  const [reviewCtx, setReviewCtx] = useState<ReviewContext | null>(null);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState<"approve" | "request_revision" | null>(null);
  const [revisionNote, setRevisionNote] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewComplete, setReviewComplete] = useState<"approved" | "revision" | null>(null);
  const [showRevisionDialog, setShowRevisionDialog] = useState(false);

  // Fetch shared data
  useEffect(() => {
    async function fetchShared() {
      try {
        const res = await fetchWithTimeout(`/api/share/${params.slug}`);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Share link not found (${res.status})`);
        }
        const json = await res.json();
        setData(json);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    if (params.slug) fetchShared();
  }, [params.slug]);

  // Fetch review context (is this a review link for a brand bid?)
  useEffect(() => {
    async function fetchReviewContext() {
      try {
        const res = await fetchWithTimeout(`/api/share/${params.slug}/review-context`);
        if (res.ok) {
          const ctx = await res.json();
          setReviewCtx(ctx);
        }
      } catch (err) {
        console.error("[SharedView] Failed to fetch review context:", err);
      }
    }
    if (params.slug) fetchReviewContext();
  }, [params.slug]);

  // Fetch current user email for brand matching
  useEffect(() => {
    async function fetchUserEmail() {
      try {
        const res = await fetchWithTimeout("/api/auth/user-type", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setCurrentUserEmail(data.email || null);
        }
      } catch (err) {
        // Not logged in — that's fine for public views
      }
    }
    fetchUserEmail();
  }, []);

  // Submit review (approve or request revision)
  const handleReviewSubmit = async (action: "approve" | "request_revision") => {
    if (!reviewCtx?.bidId) return;
    setSubmittingReview(true);
    try {
      const res = await fetchWithTimeout(`/api/bids/${reviewCtx.bidId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action,
          note: action === "request_revision" ? revisionNote : undefined,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Review failed");
      }
      setReviewComplete(action === "approve" ? "approved" : "revision");
      setShowRevisionDialog(false);
      // Update the local review context to reflect the new status
      setReviewCtx(prev => prev ? {
        ...prev,
        bidStatus: action === "approve" ? "accepted" : "revision_requested",
        reviewNote: action === "request_revision" ? revisionNote : prev.reviewNote,
      } : null);
    } catch (err: any) {
      console.error("[SharedView] Review submit error:", err);
      alert(err.message || "Failed to submit review");
    } finally {
      setSubmittingReview(false);
    }
  };

  // Composite the placement onto the frame canvas
  const renderComposite = useCallback(async () => {
    if (!data || !data.placement || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Find the surface for the placement
    const surface = data.surfaces.find((s) => s.id === data.placement!.surfaceId);
    const frameUrl = surface?.frameUrl || data.video.thumbnailUrl;
    if (!frameUrl) return;

    // Load background frame
    const bgImg = new Image();
    bgImg.crossOrigin = "anonymous";
    bgImg.src = frameUrl;

    await new Promise<void>((resolve, reject) => {
      bgImg.onload = () => resolve();
      bgImg.onerror = () => reject(new Error("Failed to load frame"));
    });

    canvas.width = bgImg.naturalWidth;
    canvas.height = bgImg.naturalHeight;
    ctx.drawImage(bgImg, 0, 0);

    // Load product image
    const productImg = new Image();
    productImg.crossOrigin = "anonymous";
    productImg.src = data.placement!.productImageUrl;

    await new Promise<void>((resolve, reject) => {
      productImg.onload = () => resolve();
      productImg.onerror = () => reject(new Error("Failed to load product"));
    });

    // Calculate bounding box from surface
    if (surface) {
      const bboxX = parseFloat(surface.boundingBoxX) * canvas.width;
      const bboxY = parseFloat(surface.boundingBoxY) * canvas.height;
      const bboxW = parseFloat(surface.boundingBoxWidth) * canvas.width;
      const bboxH = parseFloat(surface.boundingBoxHeight) * canvas.height;

      const t = data.placement!.transform;
      const b = data.placement!.blend;

      const scaledW = bboxW * t.scale;
      const scaledH = bboxH * t.scale;
      const centerX = bboxX + bboxW / 2 + t.offsetX;
      const centerY = bboxY + bboxH / 2 + t.offsetY;

      ctx.save();
      ctx.globalAlpha = (b.opacity || 100) / 100;
      ctx.translate(centerX, centerY);
      if (t.rotation) ctx.rotate((t.rotation * Math.PI) / 180);
      if (t.flipH) ctx.scale(-1, 1);
      ctx.drawImage(productImg, -scaledW / 2, -scaledH / 2, scaledW, scaledH);
      ctx.restore();
    }

    setComposited(true);
  }, [data]);

  useEffect(() => {
    if (data?.placement) {
      renderComposite().catch(console.error);
    }
  }, [data, renderComposite]);

  // Copy share URL to clipboard
  const copyShareUrl = () => {
    const url = `${window.location.origin}/s/${params.slug}`;
    navigator.clipboard.writeText(url);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading shared content...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md mx-auto">
          <CardContent className="p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/20 flex items-center justify-center mx-auto mb-4">
              <ExternalLink className="w-8 h-8 text-red-500" />
            </div>
            <h2 className="text-xl font-semibold mb-2">Link Not Found</h2>
            <p className="text-muted-foreground mb-6">
              {error || "This share link doesn't exist or has expired."}
            </p>
            <Button variant="outline" onClick={() => setLocation("/")}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Go to FullScale
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── A1 Release page — the placement's final approved render ──
  if (data.release) {
    const rel = data.release;
    const isPortrait = rel.aspectRatio === "9:16";
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <a href="/" className="font-bold text-lg tracking-tight">
                Full<span className="text-primary">Scale</span>
              </a>
              <Badge variant="secondary" className="text-xs">
                <CheckCircle className="w-3 h-3 mr-1 text-emerald-500" />
                Placement Release
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={copyShareUrl} data-testid="release-copy-link">
                <Share2 className="w-4 h-4 mr-1" />
                Copy Link
              </Button>
              {rel.clipUrl && (
                <a href={rel.clipUrl} download>
                  <Button size="sm" data-testid="release-download">
                    <Download className="w-4 h-4 mr-1" />
                    Download
                  </Button>
                </a>
              )}
            </div>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-4 py-8">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <Card className="overflow-hidden">
                <div className={`relative bg-black flex items-center justify-center ${isPortrait ? "max-h-[80vh]" : "aspect-video"}`}>
                  {rel.clipUrl ? (
                    <video
                      src={rel.clipUrl}
                      controls
                      poster={rel.thumbnailUrl || undefined}
                      className={isPortrait ? "h-[80vh] max-w-full object-contain" : "w-full h-full object-contain"}
                      data-testid="release-video"
                    />
                  ) : (
                    <img
                      src={rel.thumbnailUrl || data.video.thumbnailUrl || "/placeholder.jpg"}
                      alt={data.title}
                      className="w-full h-full object-contain"
                    />
                  )}
                </div>
              </Card>

              <div className="mt-4">
                <h1 className="text-2xl font-bold">{rel.clipTitle || data.title}</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {rel.creatorName && <span className="font-medium text-foreground">{rel.creatorName}</span>}
                  {rel.creatorName && rel.brandName && " · in partnership with "}
                  {rel.brandName && <span className="font-medium text-foreground">{rel.brandName}</span>}
                </p>
                <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Eye className="w-4 h-4" />
                    {data.viewCount} {data.viewCount === 1 ? "view" : "views"}
                  </span>
                  {rel.duration != null && (
                    <span className="flex items-center gap-1">
                      <Clock className="w-4 h-4" />
                      {Math.round(rel.duration)}s
                    </span>
                  )}
                  {rel.approvedAt && (
                    <span>
                      Approved{" "}
                      {new Date(rel.approvedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                  )}
                </div>
                {!rel.clipUrl && (
                  <p className="mt-3 text-sm text-muted-foreground">
                    This placement runs on the creator's original video.
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-4">
              {rel.product && (
                <Card>
                  <CardContent className="p-4">
                    <h3 className="font-semibold mb-3">Featured Product</h3>
                    <div className="rounded-lg border bg-muted/30 p-3 flex items-center gap-3">
                      {rel.product.imageUrl && (
                        <img
                          src={rel.product.imageUrl}
                          alt={rel.product.name}
                          className="w-14 h-14 rounded object-contain bg-white"
                        />
                      )}
                      <div className="text-sm">
                        <div className="font-medium">{rel.product.name}</div>
                        {rel.product.category && (
                          <div className="text-muted-foreground capitalize">{rel.product.category}</div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card className="border-emerald-500/30 bg-emerald-500/5">
                <CardContent className="p-4">
                  <h3 className="font-semibold mb-2 flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-emerald-500" />
                    Verified Placement
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    This placement was approved by both the creator and the brand through
                    FullScale's two-sided review. The FullScale team produces the final
                    polished render.
                  </p>
                </CardContent>
              </Card>

              {rel.clipUrl && (
                <Card>
                  <CardContent className="p-4">
                    <h3 className="font-semibold mb-3">Approved Placement Preview</h3>
                    <a href={rel.clipUrl} download>
                      <Button className="w-full" size="sm">
                        <Download className="w-4 h-4 mr-2" />
                        Download MP4
                      </Button>
                    </a>
                  </CardContent>
                </Card>
              )}

              <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
                <CardContent className="p-4 text-center">
                  <h3 className="font-semibold mb-1">Made with FullScale</h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    AI-powered product placement for creators and brands.
                  </p>
                  <a href="/">
                    <Button variant="outline" size="sm" className="w-full">
                      Learn More
                      <ExternalLink className="w-3 h-3 ml-1" />
                    </Button>
                  </a>
                </CardContent>
              </Card>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const hasExport = data.export?.status === "complete" && data.export?.outputUrl;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a href="/" className="font-bold text-lg tracking-tight">
              Full<span className="text-primary">Scale</span>
            </a>
            <Badge variant="secondary" className="text-xs">
              Shared Content
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={copyShareUrl}>
              <Share2 className="w-4 h-4 mr-1" />
              Copy Link
            </Button>
            {hasExport && (
              <a href={data.export!.outputUrl!} download>
                <Button size="sm">
                  <Download className="w-4 h-4 mr-1" />
                  Download
                </Button>
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Preview Area — takes 2/3 */}
          <div className="lg:col-span-2">
            <Card className="overflow-hidden">
              <div className="relative aspect-video bg-black">
                {/* Show export video if available, otherwise composited frame */}
                {hasExport ? (
                  <video
                    src={data.export!.outputUrl!}
                    controls
                    poster={data.video.thumbnailUrl || undefined}
                    className="w-full h-full object-contain"
                  />
                ) : data.placement ? (
                  <canvas
                    ref={canvasRef}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <img
                    src={data.video.thumbnailUrl || "/placeholder.jpg"}
                    alt={data.title}
                    className="w-full h-full object-contain"
                  />
                )}

                {/* Overlay badge */}
                <div className="absolute top-3 left-3">
                  <Badge
                    variant="secondary"
                    className="bg-black/60 backdrop-blur-sm text-white border-0"
                  >
                    {hasExport ? (
                      <>
                        <Film className="w-3 h-3 mr-1" /> Remixed Video
                      </>
                    ) : data.placement ? (
                      <>
                        <ImageIcon className="w-3 h-3 mr-1" /> Product Placement
                      </>
                    ) : (
                      <>
                        <Play className="w-3 h-3 mr-1" /> Video
                      </>
                    )}
                  </Badge>
                </div>
              </div>
            </Card>

            {/* Title and metadata */}
            <div className="mt-4">
              <h1 className="text-2xl font-bold">{data.title}</h1>
              <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Eye className="w-4 h-4" />
                  {data.viewCount} {data.viewCount === 1 ? "view" : "views"}
                </span>
                {data.video.duration && (
                  <span className="flex items-center gap-1">
                    <Clock className="w-4 h-4" />
                    {data.video.duration}
                  </span>
                )}
                <span>
                  Shared{" "}
                  {new Date(data.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              </div>
            </div>
          </div>

          {/* Sidebar — 1/3 */}
          <div className="space-y-4">
            {/* Placement details */}
            {data.placement && (
              <Card>
                <CardContent className="p-4">
                  <h3 className="font-semibold mb-3">Placement Details</h3>
                  <div className="space-y-3">
                    {/* Product preview */}
                    <div className="rounded-lg border bg-muted/30 p-3 flex items-center gap-3">
                      <img
                        src={data.placement.productImageUrl}
                        alt="Product"
                        className="w-12 h-12 rounded object-contain bg-white"
                      />
                      <div className="text-sm">
                        <div className="font-medium">Product Image</div>
                        <div className="text-muted-foreground">
                          Scale: {Math.round(data.placement.transform.scale * 100)}%
                          {data.placement.transform.rotation !== 0 && ` · Rotated ${data.placement.transform.rotation}°`}
                        </div>
                      </div>
                    </div>

                    {/* Surface info */}
                    {data.surfaces.length > 0 && (
                      <div className="text-sm">
                        <span className="text-muted-foreground">Surface: </span>
                        <Badge variant="outline">
                          {data.surfaces.find((s) => s.id === data.placement!.surfaceId)?.surfaceType || "Unknown"}
                        </Badge>
                      </div>
                    )}

                    {/* Blend settings */}
                    <div className="text-sm text-muted-foreground">
                      Opacity: {data.placement.blend.opacity}%
                      {data.placement.blend.shadowEnabled && " · Shadow enabled"}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Brand Review Card — shown when this is a review link */}
            {reviewCtx && reviewCtx.bidId && (() => {
              const isBrandReviewer = currentUserEmail && reviewCtx.brandEmail &&
                currentUserEmail.toLowerCase() === reviewCtx.brandEmail.toLowerCase();
              const canReview = isBrandReviewer && reviewCtx.bidStatus === "placed" && !reviewComplete;

              return (
                <Card className={
                  reviewComplete === "approved" ? "border-emerald-500/30 bg-emerald-500/5" :
                  reviewComplete === "revision" ? "border-orange-500/30 bg-orange-500/5" :
                  reviewCtx.bidStatus === "accepted" ? "border-emerald-500/30 bg-emerald-500/5" :
                  reviewCtx.bidStatus === "revision_requested" ? "border-orange-500/30 bg-orange-500/5" :
                  "border-blue-500/30 bg-blue-500/5"
                }>
                  <CardContent className="p-4">
                    <h3 className="font-semibold mb-3 flex items-center gap-2">
                      {reviewComplete === "approved" || reviewCtx.bidStatus === "accepted" ? (
                        <><CheckCircle className="w-4 h-4 text-emerald-500" /> Placement Approved</>
                      ) : reviewComplete === "revision" || reviewCtx.bidStatus === "revision_requested" ? (
                        <><RotateCcw className="w-4 h-4 text-orange-500" /> Revision Requested</>
                      ) : (
                        <><Eye className="w-4 h-4 text-blue-500" /> Placement Review</>
                      )}
                    </h3>

                    {/* Bid info */}
                    <div className="space-y-2 text-sm mb-4">
                      {reviewCtx.brandName && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Brand</span>
                          <span className="font-medium">{reviewCtx.brandName}</span>
                        </div>
                      )}
                      {reviewCtx.bidAmount && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Bid Amount</span>
                          <span className="font-medium text-green-400">
                            ${Number(reviewCtx.bidAmount).toLocaleString()}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Review note (visible to both creator and brand) */}
                    {reviewCtx.reviewNote && reviewCtx.bidStatus === "revision_requested" && (
                      <div className="rounded-lg bg-orange-500/10 border border-orange-500/20 p-3 mb-4">
                        <p className="text-xs font-medium text-orange-400 mb-1 flex items-center gap-1">
                          <MessageSquare className="w-3 h-3" /> Revision Feedback
                        </p>
                        <p className="text-sm text-orange-300">{reviewCtx.reviewNote}</p>
                      </div>
                    )}

                    {/* Approved confirmation */}
                    {(reviewComplete === "approved" || (!reviewComplete && reviewCtx.bidStatus === "accepted")) && (
                      <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 text-center">
                        <ThumbsUp className="w-5 h-5 text-emerald-500 mx-auto mb-1" />
                        <p className="text-sm text-emerald-400 font-medium">This placement has been approved</p>
                      </div>
                    )}

                    {/* Revision sent confirmation */}
                    {reviewComplete === "revision" && (
                      <div className="rounded-lg bg-orange-500/10 border border-orange-500/20 p-3 text-center">
                        <RotateCcw className="w-5 h-5 text-orange-500 mx-auto mb-1" />
                        <p className="text-sm text-orange-400 font-medium">Revision request sent to creator</p>
                      </div>
                    )}

                    {/* Action buttons — only for brand reviewer when status is "placed" */}
                    {canReview && (
                      <div className="flex gap-2">
                        <Button
                          className="flex-1 gap-1"
                          size="sm"
                          onClick={() => handleReviewSubmit("approve")}
                          disabled={submittingReview}
                        >
                          {submittingReview ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <ThumbsUp className="w-3.5 h-3.5" />
                          )}
                          Approve
                        </Button>
                        <Button
                          variant="outline"
                          className="flex-1 gap-1 border-orange-500/30 text-orange-400 hover:bg-orange-500/10"
                          size="sm"
                          onClick={() => setShowRevisionDialog(true)}
                          disabled={submittingReview}
                        >
                          <MessageSquare className="w-3.5 h-3.5" />
                          Request Changes
                        </Button>
                      </div>
                    )}

                    {/* Not the reviewer message */}
                    {!isBrandReviewer && reviewCtx.bidStatus === "placed" && currentUserEmail && (
                      <div className="text-xs text-muted-foreground text-center">
                        Only the brand reviewer can approve this placement
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })()}

            {/* Export info */}
            {hasExport && (
              <Card>
                <CardContent className="p-4">
                  <h3 className="font-semibold mb-3">Exported Video</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Film className="w-4 h-4 text-green-500" />
                      <span>Export complete</span>
                    </div>
                    <a href={data.export!.outputUrl!} download>
                      <Button className="w-full mt-2" size="sm">
                        <Download className="w-4 h-4 mr-2" />
                        Download MP4
                      </Button>
                    </a>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Detected surfaces */}
            {data.surfaces.length > 0 && (
              <Card>
                <CardContent className="p-4">
                  <h3 className="font-semibold mb-3">Detected Surfaces</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {data.surfaces.map((surface) => (
                      <Badge key={surface.id} variant="outline" className="text-xs">
                        {surface.surfaceType}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* CTA */}
            <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
              <CardContent className="p-4 text-center">
                <h3 className="font-semibold mb-1">Made with FullScale</h3>
                <p className="text-sm text-muted-foreground mb-3">
                  AI-powered product placement for creators and brands.
                </p>
                <a href="/">
                  <Button variant="outline" size="sm" className="w-full">
                    Learn More
                    <ExternalLink className="w-3 h-3 ml-1" />
                  </Button>
                </a>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      {/* Revision Request Dialog */}
      <Dialog open={showRevisionDialog} onOpenChange={setShowRevisionDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Request Changes</DialogTitle>
            <DialogDescription>
              Describe what changes you'd like the creator to make to this placement.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="e.g., Please adjust the product position to be more centered on the surface, and increase the opacity slightly."
            value={revisionNote}
            onChange={(e) => setRevisionNote(e.target.value)}
            rows={4}
            className="resize-none"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowRevisionDialog(false)}
              disabled={submittingReview}
            >
              Cancel
            </Button>
            <Button
              variant="default"
              className="gap-1"
              onClick={() => handleReviewSubmit("request_revision")}
              disabled={submittingReview || !revisionNote.trim()}
            >
              {submittingReview ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <MessageSquare className="w-3.5 h-3.5" />
              )}
              Send Feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
