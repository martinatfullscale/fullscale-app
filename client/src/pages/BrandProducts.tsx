import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Upload,
  Trash2,
  Image as ImageIcon,
  Package,
  CheckCircle,
  AlertTriangle,
} from "lucide-react";
import { apiRequest, fetchWithTimeout } from "@/lib/queryClient";

const UPLOAD_TIMEOUT_MS = 30 * 60_000; // files, not JSON — see AdminPlacements


interface BrandProduct {
  id: number;
  userId: string;
  name: string;
  imageUrl: string;
  thumbnailUrl: string | null;
  category: string | null;
  width: number | null;
  height: number | null;
  isTransparent: boolean | null;
  subjectBoundsX: string | null;
  subjectBoundsY: string | null;
  subjectBoundsW: string | null;
  subjectBoundsH: string | null;
  dominantColor: string | null;
  backgroundType: string | null;
  createdAt: string;
}

const CATEGORIES = [
  "beverage",
  "electronics",
  "fashion",
  "food",
  "beauty",
  "health",
  "home",
  "automotive",
  "sports",
  "entertainment",
  "other",
];

export default function BrandProducts() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [productName, setProductName] = useState("");
  const [category, setCategory] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: products, isLoading } = useQuery<BrandProduct[]>({
    queryKey: ["/api/brand-products"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/brand-products");
      return res.json();
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const res = await fetchWithTimeout("/api/brand-products", {
        method: "POST",
        body: formData,
        credentials: "include",
      }, UPLOAD_TIMEOUT_MS);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (data: BrandProduct) => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand-products"] });

      // Contextual feedback based on product analysis
      let description = "Your product image has been added to the catalog.";
      if (data.backgroundType === "solid" || data.backgroundType === "complex") {
        description = "Product uploaded. For best placement results, re-upload as a PNG with a transparent background.";
      } else if (data.isTransparent && data.subjectBoundsW) {
        const coverage = Math.round(parseFloat(data.subjectBoundsW) * 100);
        description = `Product uploaded with transparent background — subject fills ${coverage}% width. Ready for placement!`;
      }

      toast({ title: "Product uploaded", description });
      closeUpload();
    },
    onError: (err: any) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (productId: number) => {
      const res = await apiRequest("DELETE", `/api/brand-products/${productId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand-products"] });
      toast({ title: "Product deleted", description: "Product has been removed from your catalog." });
      setDeleteId(null);
    },
    onError: (err: any) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const closeUpload = () => {
    setIsUploadOpen(false);
    setProductName("");
    setCategory("");
    setSelectedFile(null);
    setPreviewUrl(null);
  };

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) {
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
      if (!productName) {
        setProductName(file.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "));
      }
    }
  }, [productName]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
      if (!productName) {
        setProductName(file.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "));
      }
    }
  };

  const handleUpload = () => {
    if (!selectedFile || !productName) return;
    const formData = new FormData();
    formData.append("productImage", selectedFile);
    formData.append("name", productName);
    if (category) formData.append("category", category);
    uploadMutation.mutate(formData);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
            <Package className="h-8 w-8 text-primary" />
            Product Catalog
          </h1>
          <p className="text-muted-foreground mt-1">
            Upload product images for placement previews on creator videos
          </p>
        </div>
        <Button onClick={() => setIsUploadOpen(true)} className="gap-2">
          <Upload className="h-4 w-4" />
          Upload Product
        </Button>
      </div>

      {/* Guidance banner */}
      <Card className="mb-8 border-primary/20 bg-primary/5">
        <CardContent className="py-4 px-5">
          <div className="flex items-start gap-3">
            <ImageIcon className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground">Product Image Tips</p>
              <p className="text-xs text-muted-foreground mt-1">
                Upload product images with transparent backgrounds (PNG) for best placement results.
                360 product renders work great for realistic mockups. Minimum recommended size: 500x500px.
                Each upload is auto-analyzed for subject bounds, dominant color, and background type.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Product grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : !products || products.length === 0 ? (
        <Card>
          <CardContent className="py-20 text-center">
            <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium text-foreground mb-1">No products yet</p>
            <p className="text-muted-foreground mb-6">
              Upload your first product image to start creating placement previews.
            </p>
            <Button onClick={() => setIsUploadOpen(true)} className="gap-2">
              <Upload className="h-4 w-4" />
              Upload Product
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {products.map((product) => (
            <Card
              key={product.id}
              className="overflow-hidden group hover:border-primary/30 transition-all duration-200"
            >
              {/* Image */}
              <div className="relative aspect-square bg-muted/30 flex items-center justify-center p-4">
                {/* Checkerboard background for transparency */}
                <div
                  className="absolute inset-0"
                  style={{
                    backgroundImage:
                      "linear-gradient(45deg, #f0f0f0 25%, transparent 25%), linear-gradient(-45deg, #f0f0f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #f0f0f0 75%), linear-gradient(-45deg, transparent 75%, #f0f0f0 75%)",
                    backgroundSize: "16px 16px",
                    backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
                  }}
                />
                <img
                  src={product.imageUrl}
                  alt={product.name}
                  className="relative max-w-full max-h-full object-contain"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = product.thumbnailUrl || "";
                  }}
                />

                {/* Transparency badge */}
                {product.isTransparent && (
                  <Badge className="absolute top-2 right-2 text-[10px] bg-green-500/90">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    PNG
                  </Badge>
                )}

                {/* Delete button on hover */}
                <Button
                  variant="destructive"
                  size="icon"
                  className="absolute top-2 left-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => setDeleteId(product.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              {/* Info */}
              <CardContent className="p-3">
                <p className="font-medium text-sm text-foreground truncate">{product.name}</p>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  {product.category && (
                    <Badge variant="outline" className="text-[10px] capitalize">
                      {product.category}
                    </Badge>
                  )}
                  {product.width && product.height && (
                    <span className="text-[10px] text-muted-foreground">
                      {product.width}x{product.height}
                    </span>
                  )}
                  {/* Dominant color swatch */}
                  {product.dominantColor && (
                    <span className="flex items-center gap-1" title={`Dominant: ${product.dominantColor}`}>
                      <span
                        className="inline-block w-3 h-3 rounded-full border border-border"
                        style={{ backgroundColor: product.dominantColor }}
                      />
                    </span>
                  )}
                  {/* Background type badge */}
                  {product.backgroundType === "solid" && !product.isTransparent && (
                    <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-900/20">
                      Solid BG
                    </Badge>
                  )}
                  {product.backgroundType === "complex" && (
                    <Badge variant="outline" className="text-[10px] text-red-600 border-red-300 bg-red-50 dark:bg-red-900/20">
                      Complex BG
                    </Badge>
                  )}
                </div>
                {/* Subject coverage info for transparent images */}
                {product.subjectBoundsW && product.subjectBoundsH && (
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Subject: {Math.round(parseFloat(product.subjectBoundsW) * 100)}% × {Math.round(parseFloat(product.subjectBoundsH) * 100)}% coverage
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Upload Modal ── */}
      <Dialog open={isUploadOpen} onOpenChange={closeUpload}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload Product</DialogTitle>
            <DialogDescription>
              Add a product image to your catalog for placement previews.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Drop zone */}
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
                dragActive
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 hover:border-primary/50"
              }`}
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => document.getElementById("product-file-input")?.click()}
            >
              {previewUrl ? (
                <div className="flex flex-col items-center gap-3">
                  <img
                    src={previewUrl}
                    alt="Preview"
                    className="max-h-32 object-contain rounded"
                  />
                  <p className="text-xs text-muted-foreground">{selectedFile?.name}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedFile(null);
                      setPreviewUrl(null);
                    }}
                  >
                    Change Image
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Upload className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Drop image here or <span className="text-primary font-medium">browse</span>
                  </p>
                  <p className="text-xs text-muted-foreground">PNG, JPG, WebP up to 10MB</p>
                </div>
              )}
              <input
                id="product-file-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={handleFileSelect}
              />
            </div>

            {/* Product name */}
            <div>
              <label className="text-sm font-medium text-foreground">Product Name *</label>
              <Input
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="e.g., Mountain Dew Can"
              />
            </div>

            {/* Category */}
            <div>
              <label className="text-sm font-medium text-foreground">Category</label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue placeholder="Select category..." />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat} className="capitalize">
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Transparency warning */}
            {selectedFile && selectedFile.type !== "image/png" && (
              <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded-md p-3">
                <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>
                  For best placement results, use PNG images with transparent backgrounds.
                  JPG/WebP images will have solid backgrounds.
                </span>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeUpload}>
              Cancel
            </Button>
            <Button
              onClick={handleUpload}
              disabled={!selectedFile || !productName || uploadMutation.isPending}
            >
              {uploadMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                "Upload Product"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation ── */}
      <Dialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Product</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this product? This action cannot be undone.
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
    </div>
  );
}
