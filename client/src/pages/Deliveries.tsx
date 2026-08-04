/**
 * Deliveries — the creator's repository of finished renders.
 *
 * The creator chose where the product lives; the FullScale team produced the
 * final photorealistic cut. This is where that work comes back: download it,
 * post it natively, then tell us where so the placement can be measured.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { TopBar } from "@/components/TopBar";
import { Loader2, Download, PackageOpen, CheckCircle2, Radio, ExternalLink, Link2, Copy } from "lucide-react";

interface Delivery {
  id: number;
  placementId: number;
  videoId: number;
  aspectRatio: string;
  version: number;
  fileName: string | null;
  fileSizeBytes: number | null;
  deliveryNote: string | null;
  deliveredAt: string;
  downloadedAt: string | null;
  videoTitle: string;
  videoThumbnailUrl: string | null;
  productName: string | null;
  publishedAt: string | null;
  postUrl: string | null;
}

const fmtSize = (bytes: number | null) => {
  if (!bytes) return null;
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
};

export default function Deliveries() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [downloading, setDownloading] = useState<number | null>(null);
  const [linkFor, setLinkFor] = useState<number | null>(null);
  const [destUrl, setDestUrl] = useState("");
  const [minting, setMinting] = useState(false);
  const [mintedUrl, setMintedUrl] = useState<Record<number, string>>({});

  // A placement isn't clickable — the only real click signal is a link the
  // creator posts alongside the video. This is where they get it.
  const mintLink = async (placementId: number) => {
    setMinting(true);
    try {
      const res = await fetch(`/api/placements/${placementId}/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ destinationUrl: destUrl.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Could not create link");
      setMintedUrl((m) => ({ ...m, [placementId]: body.url }));
      setLinkFor(null);
      setDestUrl("");
      await navigator.clipboard.writeText(body.url).catch(() => {});
      toast({
        title: "Tracking link copied",
        description: "Paste it in your video description or pinned comment — that's how clicks get credited to this placement.",
      });
    } catch (err: any) {
      toast({ title: "Couldn't create link", description: err?.message, variant: "destructive" });
    } finally {
      setMinting(false);
    }
  };

  const { data, isLoading, isError } = useQuery<{ deliveries: Delivery[] }>({
    queryKey: ["/api/deliveries"],
    queryFn: async () => {
      const res = await fetch("/api/deliveries", { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load deliveries (${res.status})`);
      return res.json();
    },
  });

  const download = async (d: Delivery) => {
    setDownloading(d.id);
    try {
      const res = await fetch(`/api/deliveries/${d.id}/download`, { credentials: "include" });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = d.fileName || `${d.videoTitle}-${d.aspectRatio}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      queryClient.invalidateQueries({ queryKey: ["/api/deliveries"] });
      toast({
        title: "Downloading your render",
        description: "Once it's posted, mark it live from Saved Placements so we can track how it performs.",
      });
    } catch (err: any) {
      toast({ title: "Download failed", description: err?.message, variant: "destructive" });
    } finally {
      setDownloading(null);
    }
  };

  const deliveries = data?.deliveries ?? [];
  const published = deliveries.filter((d) => d.publishedAt);
  const ready = deliveries.filter((d) => !d.publishedAt);

  const Row = ({ d }: { d: Delivery }) => (
    <div className="flex items-center gap-4 p-4 border-b border-white/5 last:border-b-0" data-testid={`delivery-${d.id}`}>
      <div className="w-24 h-14 rounded bg-black/40 border border-white/10 overflow-hidden shrink-0">
        {d.videoThumbnailUrl ? (
          <img src={d.videoThumbnailUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <PackageOpen className="w-4 h-4 text-muted-foreground" />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{d.videoTitle}</p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <Badge variant="outline" className="text-[10px]">{d.aspectRatio}</Badge>
          {d.version > 1 && <Badge variant="outline" className="text-[10px]">v{d.version}</Badge>}
          {d.productName && <span className="text-[11px] text-muted-foreground">{d.productName}</span>}
          {fmtSize(d.fileSizeBytes) && (
            <span className="text-[11px] text-muted-foreground">{fmtSize(d.fileSizeBytes)}</span>
          )}
        </div>
        {d.deliveryNote && (
          <p className="text-[11px] text-muted-foreground mt-1 italic">"{d.deliveryNote}"</p>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {d.publishedAt ? (
          <>
            <Badge variant="outline" className="text-[10px] text-emerald-400 border-emerald-500/30 gap-1">
              <Radio className="w-3 h-3" /> Live
            </Badge>
            {d.postUrl && (
              <a href={d.postUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
          </>
        ) : d.downloadedAt ? (
          <Badge variant="outline" className="text-[10px] text-sky-400 border-sky-500/30 gap-1">
            <CheckCircle2 className="w-3 h-3" /> Downloaded
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] text-emerald-400 border-emerald-500/30">New</Badge>
        )}
        <Button size="sm" variant="outline" className="gap-1.5"
          disabled={downloading === d.id}
          onClick={() => download(d)}
          data-testid={`download-${d.id}`}>
          {downloading === d.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          Download
        </Button>
        <Button size="sm" variant="ghost" className="gap-1.5"
          onClick={() => {
            const existing = mintedUrl[d.placementId];
            if (existing) {
              navigator.clipboard.writeText(existing).catch(() => {});
              toast({ title: "Link copied", description: "Paste it in your description or pinned comment." });
            } else {
              setLinkFor(linkFor === d.placementId ? null : d.placementId);
            }
          }}
          data-testid={`link-${d.id}`}>
          {mintedUrl[d.placementId] ? <Copy className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
          {mintedUrl[d.placementId] ? "Copy link" : "Tracking link"}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar />
      <main className="p-8 max-w-4xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <PackageOpen className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold font-display">Deliveries</h1>
        </div>
        <p className="text-muted-foreground text-sm mb-8 max-w-2xl">
          Your finished renders — the polished cut our team produced from the placements you
          chose. Download, post it to your channel, then mark it live from Saved Placements so
          we can show you and the brand how it performed.
        </p>

        {isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : isError ? (
          <p className="text-destructive text-sm">Couldn't load your deliveries — try refreshing.</p>
        ) : deliveries.length === 0 ? (
          <Card className="border-border/50">
            <CardContent className="p-8 text-center">
              <PackageOpen className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm font-medium mb-1">Nothing delivered yet</p>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                Once you save a placement, our team reviews it and produces the final render.
                It lands here when it's ready — you'll get a notification.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {ready.length > 0 && (
              <>
                <h2 className="font-semibold text-sm mb-3">Ready to publish ({ready.length})</h2>
                <Card className="border-border/50 mb-4">
                  <CardContent className="p-0">
                    {ready.map((d) => <Row key={d.id} d={d} />)}
                  </CardContent>
                </Card>
                {linkFor != null && (
                  <Card className="border-primary/25 bg-primary/5 mb-10">
                    <CardContent className="p-4 space-y-2">
                      <p className="text-sm font-medium">Create a tracking link</p>
                      <p className="text-xs text-muted-foreground">
                        Where should viewers land — the brand's product page? We'll give you a short
                        link to put in your description or pinned comment, and clicks get credited to
                        this placement.
                      </p>
                      <div className="flex gap-2">
                        <input
                          value={destUrl}
                          onChange={(e) => setDestUrl(e.target.value)}
                          placeholder="https://brand.com/product"
                          className="flex-1 h-9 px-3 rounded-md bg-white/5 border border-white/10 text-sm"
                          data-testid="link-destination"
                        />
                        <Button disabled={minting || !destUrl.trim()} onClick={() => mintLink(linkFor)}>
                          {minting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
            {published.length > 0 && (
              <>
                <h2 className="font-semibold text-sm mb-3">Published ({published.length})</h2>
                <Card className="border-border/50">
                  <CardContent className="p-0">
                    {published.map((d) => <Row key={d.id} d={d} />)}
                  </CardContent>
                </Card>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
