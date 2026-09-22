// The full FullScale Creates catalogue — everything behind "See all pieces"
// on /creates.
//
// A poster grid, not a video grid: 157 <video> elements would have every
// browser opening connections it will mostly abandon. Posters are lazy images,
// and only the piece a visitor actually clicks streams anything.

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Film, Play } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useCreatesLibrary, formatDuration, type CreatesVideo } from "@/lib/createsLibrary";

export default function CreatesWork() {
  const { videos, state } = useCreatesLibrary();
  const [active, setActive] = useState<CreatesVideo | null>(null);
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return videos;
    return videos.filter(
      (v) =>
        v.title.toLowerCase().includes(needle) ||
        (v.brand ?? "").toLowerCase().includes(needle),
    );
  }, [videos, q]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-6 py-6 flex items-center gap-4">
          <Link href="/creates">
            <Button variant="ghost" size="sm" className="gap-2" data-testid="link-back-to-creates">
              <ArrowLeft className="w-4 h-4" />
              FullScale Creates
            </Button>
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-foreground mb-2">The work</h1>
            <p className="text-muted-foreground">
              {state === "ready"
                ? `${videos.length} pieces across brand, series and campaign work.`
                : state === "error"
                  ? "The catalogue could not be loaded."
                  : "Loading the catalogue…"}
            </p>
          </div>
          {state === "ready" && videos.length > 0 && (
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by title or brand"
              className="sm:max-w-xs"
              data-testid="input-search-work"
            />
          )}
        </div>

        {state === "loading" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className="aspect-video rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        )}

        {state === "ready" && shown.length === 0 && (
          <p className="text-muted-foreground py-16 text-center">
            Nothing matches “{q}”.
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {shown.map((v) => (
            <Card
              key={v.slug}
              className="overflow-hidden group cursor-pointer border-white/5 hover:border-primary/20 transition-colors"
              onClick={() => setActive(v)}
              data-testid={`card-work-${v.slug}`}
            >
              <div className="relative aspect-video bg-muted overflow-hidden">
                <img
                  src={v.posterUrl}
                  alt={v.title}
                  loading="lazy"
                  // The manifest derives URLs rather than reading them back
                  // from the upload, so a poster can legitimately not exist
                  // yet. Hide the image and let the placeholder show through.
                  onError={(e) => { e.currentTarget.style.display = "none"; }}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
                <div className="absolute inset-0 -z-10 flex items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900">
                  <Film className="w-8 h-8 text-zinc-600" />
                </div>
                <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                    <Play className="w-5 h-5 text-white ml-0.5" />
                  </div>
                </div>
                {v.brand && (
                  <Badge className="absolute top-3 right-3 text-xs" variant="secondary">
                    {v.brand}
                  </Badge>
                )}
                {v.durationSec ? (
                  <span className="absolute bottom-3 right-3 px-1.5 py-0.5 rounded bg-black/70 text-white text-[11px] font-mono">
                    {formatDuration(v.durationSec)}
                  </span>
                ) : null}
              </div>
              <div className="p-4">
                <h3 className="font-medium text-sm text-foreground leading-snug">{v.title}</h3>
              </div>
            </Card>
          ))}
        </div>
      </main>

      <Dialog open={!!active} onOpenChange={(open) => !open && setActive(null)}>
        <DialogContent className="max-w-4xl p-0 bg-black border-white/10 overflow-hidden">
          <DialogHeader className="p-4 pb-2">
            <DialogTitle className="text-white">{active?.title}</DialogTitle>
          </DialogHeader>
          <div className="aspect-video w-full bg-black">
            {active && (
              <video
                key={active.slug}
                src={active.videoUrl}
                poster={active.posterUrl}
                controls
                autoPlay
                playsInline
                className="w-full h-full"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
