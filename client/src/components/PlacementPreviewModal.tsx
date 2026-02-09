import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Upload,
  Download,
  Image as ImageIcon,
  Loader2,
  Target,
  Clock,
  RotateCcw,
  ZoomIn,
  Layers,
  Package,
  CheckCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface CatalogProduct {
  id: number;
  name: string;
  imageUrl: string;
  thumbnailUrl: string | null;
  category: string | null;
  isTransparent: boolean | null;
}

interface Surface {
  id: number;
  timestamp: number;
  surfaceType: string;
  confidence: number;
  frameUrl: string | null;
  boundingBoxX: number;
  boundingBoxY: number;
  boundingBoxWidth: number;
  boundingBoxHeight: number;
  sceneContext?: string | null;
}

interface PlacementPreviewModalProps {
  open: boolean;
  onClose: () => void;
  videoId: number;
  videoTitle: string;
  surfaces: Surface[];
}

export default function PlacementPreviewModal({
  open,
  onClose,
  videoId,
  videoTitle,
  surfaces,
}: PlacementPreviewModalProps) {
  const [selectedSurface, setSelectedSurface] = useState<Surface | null>(null);
  const [productImage, setProductImage] = useState<string | null>(null);
  const [productFile, setProductFile] = useState<File | null>(null);
  const [isCompositing, setIsCompositing] = useState(false);
  const [compositedImage, setCompositedImage] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(85);
  const [productTab, setProductTab] = useState<"upload" | "catalog">("upload");
  const [selectedCatalogProduct, setSelectedCatalogProduct] = useState<CatalogProduct | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch product catalog
  const { data: catalogProducts } = useQuery<CatalogProduct[]>({
    queryKey: ["/api/brand-products/catalog"],
    queryFn: async () => {
      const res = await fetch("/api/brand-products/catalog");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open,
  });

  // Auto-select first surface with a frame
  useEffect(() => {
    if (open && surfaces.length > 0 && !selectedSurface) {
      const surfaceWithFrame = surfaces.find((s) => s.frameUrl);
      setSelectedSurface(surfaceWithFrame || surfaces[0]);
    }
  }, [open, surfaces, selectedSurface]);

  // Reset state on close
  useEffect(() => {
    if (!open) {
      setSelectedSurface(null);
      setProductImage(null);
      setProductFile(null);
      setCompositedImage(null);
      setIsCompositing(false);
      setProductTab("upload");
      setSelectedCatalogProduct(null);
    }
  }, [open]);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        alert("Please upload an image file (PNG, JPG, etc.)");
        return;
      }

      setProductFile(file);
      setCompositedImage(null);

      const reader = new FileReader();
      reader.onload = () => {
        setProductImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    },
    []
  );

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith("image/")) return;

    setProductFile(file);
    setCompositedImage(null);

    const reader = new FileReader();
    reader.onload = () => {
      setProductImage(reader.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  // Client-side canvas compositing for instant preview
  const generatePreview = useCallback(async () => {
    if (!selectedSurface?.frameUrl || !productImage) return;

    setIsCompositing(true);

    try {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Load frame image
      const frameImg = new Image();
      frameImg.crossOrigin = "anonymous";

      await new Promise<void>((resolve, reject) => {
        frameImg.onload = () => resolve();
        frameImg.onerror = () => reject(new Error("Failed to load frame"));
        frameImg.src = selectedSurface.frameUrl!;
      });

      // Set canvas to frame dimensions
      canvas.width = frameImg.naturalWidth;
      canvas.height = frameImg.naturalHeight;

      // Draw frame
      ctx.drawImage(frameImg, 0, 0);

      // Load product image
      const prodImg = new Image();
      await new Promise<void>((resolve, reject) => {
        prodImg.onload = () => resolve();
        prodImg.onerror = () => reject(new Error("Failed to load product image"));
        prodImg.src = productImage;
      });

      // Calculate bounding box in pixel coordinates
      // The bounding box values are percentages (0-100)
      const bx = (selectedSurface.boundingBoxX / 100) * canvas.width;
      const by = (selectedSurface.boundingBoxY / 100) * canvas.height;
      const bw = (selectedSurface.boundingBoxWidth / 100) * canvas.width;
      const bh = (selectedSurface.boundingBoxHeight / 100) * canvas.height;

      // Draw product image onto the bounding box area with opacity
      ctx.globalAlpha = opacity / 100;

      // Maintain product aspect ratio within bounding box
      const prodAspect = prodImg.naturalWidth / prodImg.naturalHeight;
      const boxAspect = bw / bh;

      let drawWidth = bw;
      let drawHeight = bh;
      let drawX = bx;
      let drawY = by;

      if (prodAspect > boxAspect) {
        // Product is wider than box → fit to width
        drawHeight = bw / prodAspect;
        drawY = by + (bh - drawHeight) / 2;
      } else {
        // Product is taller → fit to height
        drawWidth = bh * prodAspect;
        drawX = bx + (bw - drawWidth) / 2;
      }

      ctx.drawImage(prodImg, drawX, drawY, drawWidth, drawHeight);
      ctx.globalAlpha = 1;

      // Export as data URL
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      setCompositedImage(dataUrl);
    } catch (err) {
      console.error("Compositing failed:", err);
    } finally {
      setIsCompositing(false);
    }
  }, [selectedSurface, productImage, opacity]);

  // Auto-generate preview when both surface and product are selected
  useEffect(() => {
    if (selectedSurface?.frameUrl && productImage) {
      generatePreview();
    }
  }, [selectedSurface, productImage, opacity, generatePreview]);

  const downloadPreview = useCallback(() => {
    if (!compositedImage) return;
    const link = document.createElement("a");
    link.download = `placement-preview-${videoId}-${selectedSurface?.id || "surface"}.jpg`;
    link.href = compositedImage;
    link.click();
  }, [compositedImage, videoId, selectedSurface]);

  const selectCatalogProduct = useCallback((product: CatalogProduct) => {
    setSelectedCatalogProduct(product);
    setCompositedImage(null);
    // Load the product image URL as the product image for compositing
    setProductImage(product.imageUrl);
    setProductFile(null);
  }, []);

  const resetPreview = () => {
    setProductImage(null);
    setProductFile(null);
    setCompositedImage(null);
    setSelectedCatalogProduct(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const surfacesWithFrames = surfaces.filter((s) => s.frameUrl);

  if (!open) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="relative w-full max-w-5xl max-h-[90vh] bg-card border border-white/10 rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div>
                <h2 className="text-lg font-bold text-white">Placement Preview</h2>
                <p className="text-sm text-muted-foreground line-clamp-1">{videoTitle}</p>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex flex-col lg:flex-row overflow-hidden">
              {/* Main preview area */}
              <div className="flex-1 min-w-0 p-4">
                <div className="relative bg-black rounded-lg overflow-hidden" style={{ minHeight: "300px" }}>
                  {compositedImage ? (
                    // Show composited preview
                    <img
                      src={compositedImage}
                      alt="Placement preview"
                      className="w-full h-auto max-h-[60vh] object-contain mx-auto"
                    />
                  ) : selectedSurface?.frameUrl ? (
                    // Show frame with bounding box overlay
                    <div className="relative">
                      <img
                        src={selectedSurface.frameUrl}
                        alt={`Surface at ${selectedSurface.timestamp}s`}
                        className="w-full h-auto max-h-[60vh] object-contain mx-auto"
                      />
                      <div
                        className="absolute border-2 border-dashed border-primary/80 bg-primary/10 rounded-sm animate-pulse"
                        style={{
                          left: `${selectedSurface.boundingBoxX}%`,
                          top: `${selectedSurface.boundingBoxY}%`,
                          width: `${selectedSurface.boundingBoxWidth}%`,
                          height: `${selectedSurface.boundingBoxHeight}%`,
                        }}
                      >
                        {!productImage && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <span className="text-xs text-primary font-medium bg-black/60 px-2 py-1 rounded">
                              Drop product here
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center" style={{ minHeight: "300px" }}>
                      <div className="text-center text-muted-foreground">
                        <ImageIcon className="w-12 h-12 mx-auto mb-2 opacity-50" />
                        <p>Select a surface to preview</p>
                      </div>
                    </div>
                  )}

                  {isCompositing && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                      <div className="text-center">
                        <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-2" />
                        <p className="text-sm text-white">Generating preview...</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Surface selector strip */}
                {surfacesWithFrames.length > 1 && (
                  <div className="mt-3 p-2 bg-black/30 rounded-lg">
                    <p className="text-xs text-muted-foreground mb-2">Select surface:</p>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {surfacesWithFrames.map((surface) => (
                        <button
                          key={surface.id}
                          onClick={() => {
                            setSelectedSurface(surface);
                            setCompositedImage(null);
                          }}
                          className={`relative flex-shrink-0 w-20 h-14 rounded-md overflow-hidden border-2 transition-all ${
                            selectedSurface?.id === surface.id
                              ? "border-primary ring-2 ring-primary/30"
                              : "border-white/20 hover:border-white/40"
                          }`}
                        >
                          <img
                            src={surface.frameUrl!}
                            alt={`Surface ${surface.surfaceType}`}
                            className="w-full h-full object-cover"
                          />
                          <span className="absolute bottom-0 left-0 right-0 bg-black/70 text-[8px] text-white text-center py-0.5">
                            {surface.surfaceType}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Hidden canvas for compositing */}
                <canvas ref={canvasRef} className="hidden" />
              </div>

              {/* Right panel — controls */}
              <div className="lg:w-72 flex-shrink-0 p-5 bg-gradient-to-b from-card to-secondary/20 border-l border-white/10 overflow-y-auto max-h-[80vh]">
                {/* Surface info */}
                {selectedSurface && (
                  <div className="mb-5 p-3 rounded-xl bg-white/5 border border-white/10">
                    <div className="flex items-center gap-2 mb-2">
                      <Target className="w-4 h-4 text-primary" />
                      <span className="text-sm font-medium text-white">Selected Surface</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="secondary" className="text-xs">
                        {selectedSurface.surfaceType}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        <Clock className="w-3 h-3 mr-1" />
                        {Math.floor(selectedSurface.timestamp / 60)}:
                        {String(Math.floor(selectedSurface.timestamp) % 60).padStart(2, "0")}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {Math.round(selectedSurface.confidence * 100)}%
                      </Badge>
                    </div>
                    {selectedSurface.sceneContext && (
                      <p className="text-xs text-muted-foreground mt-2">
                        {selectedSurface.sceneContext}
                      </p>
                    )}
                  </div>
                )}

                {/* Product image — tabbed: Upload / Catalog */}
                <div className="mb-5">
                  <label className="text-sm font-medium text-white mb-2 block">
                    Product Image
                  </label>

                  {/* Tab switcher */}
                  <div className="flex rounded-lg bg-black/30 p-0.5 mb-3">
                    <button
                      onClick={() => setProductTab("upload")}
                      className={`flex-1 text-xs py-1.5 px-2 rounded-md transition-colors flex items-center justify-center gap-1.5 ${
                        productTab === "upload"
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-white"
                      }`}
                    >
                      <Upload className="w-3 h-3" />
                      Upload
                    </button>
                    <button
                      onClick={() => setProductTab("catalog")}
                      className={`flex-1 text-xs py-1.5 px-2 rounded-md transition-colors flex items-center justify-center gap-1.5 ${
                        productTab === "catalog"
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-white"
                      }`}
                    >
                      <Package className="w-3 h-3" />
                      Catalog
                      {catalogProducts && catalogProducts.length > 0 && (
                        <span className="text-[9px] bg-white/20 rounded-full px-1.5">
                          {catalogProducts.length}
                        </span>
                      )}
                    </button>
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFileUpload}
                    className="hidden"
                  />

                  {/* Selected product preview (shared for both tabs) */}
                  {productImage ? (
                    <div className="relative">
                      <div className="w-full h-24 rounded-lg overflow-hidden border border-white/10 bg-black/30">
                        <img
                          src={productImage}
                          alt="Product"
                          className="w-full h-full object-contain"
                        />
                      </div>
                      {selectedCatalogProduct && (
                        <p className="text-[10px] text-muted-foreground mt-1 truncate">
                          {selectedCatalogProduct.name}
                        </p>
                      )}
                      <div className="flex gap-2 mt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1 text-xs"
                          onClick={() => {
                            if (productTab === "upload") {
                              fileInputRef.current?.click();
                            } else {
                              resetPreview();
                            }
                          }}
                        >
                          Change
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-xs text-red-400 hover:text-red-300"
                          onClick={resetPreview}
                        >
                          <RotateCcw className="w-3 h-3 mr-1" />
                          Reset
                        </Button>
                      </div>
                    </div>
                  ) : productTab === "upload" ? (
                    // Upload dropzone
                    <div
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full h-28 rounded-lg border-2 border-dashed border-white/20 hover:border-primary/50 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors bg-black/20"
                    >
                      <Upload className="w-5 h-5 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">
                        Drop or click to upload
                      </span>
                      <span className="text-[10px] text-muted-foreground/60">
                        PNG, JPG, SVG
                      </span>
                    </div>
                  ) : (
                    // Catalog product grid
                    <div className="max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-black/20">
                      {!catalogProducts || catalogProducts.length === 0 ? (
                        <div className="p-4 text-center">
                          <Package className="w-6 h-6 text-muted-foreground mx-auto mb-1.5" />
                          <p className="text-xs text-muted-foreground">No products in catalog</p>
                          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                            Brands can upload products in Product Catalog
                          </p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 gap-1.5 p-1.5">
                          {catalogProducts.map((product) => (
                            <button
                              key={product.id}
                              onClick={() => selectCatalogProduct(product)}
                              className={`relative aspect-square rounded-md overflow-hidden border-2 transition-all ${
                                selectedCatalogProduct?.id === product.id
                                  ? "border-primary ring-1 ring-primary/30"
                                  : "border-white/10 hover:border-white/30"
                              }`}
                              title={product.name}
                            >
                              <img
                                src={product.thumbnailUrl || product.imageUrl}
                                alt={product.name}
                                className="w-full h-full object-contain bg-white/5 p-1"
                              />
                              {product.isTransparent && (
                                <CheckCircle className="absolute top-0.5 right-0.5 w-3 h-3 text-green-400" />
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Opacity slider */}
                {productImage && (
                  <div className="mb-5">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs font-medium text-white">Blend Opacity</label>
                      <span className="text-xs text-muted-foreground">{opacity}%</span>
                    </div>
                    <input
                      type="range"
                      min={20}
                      max={100}
                      value={opacity}
                      onChange={(e) => setOpacity(Number(e.target.value))}
                      className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
                    />
                  </div>
                )}

                {/* Action buttons */}
                <div className="space-y-2">
                  {compositedImage && (
                    <Button
                      className="w-full gap-2"
                      onClick={downloadPreview}
                    >
                      <Download className="w-4 h-4" />
                      Download Preview
                    </Button>
                  )}

                  {productImage && !compositedImage && !isCompositing && (
                    <Button
                      className="w-full gap-2"
                      onClick={generatePreview}
                    >
                      <Layers className="w-4 h-4" />
                      Generate Preview
                    </Button>
                  )}
                </div>

                {/* How it works */}
                {!productImage && (
                  <div className="mt-6 p-3 rounded-xl bg-white/5 border border-white/10">
                    <h4 className="text-xs font-medium text-white mb-2">How it works</h4>
                    <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
                      <li>Select an ad surface from the video</li>
                      <li>Upload your product or brand image</li>
                      <li>Preview how it looks in the scene</li>
                      <li>Download the mockup to share</li>
                    </ol>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
