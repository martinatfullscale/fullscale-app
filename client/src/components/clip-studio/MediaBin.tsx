import { useMemo, useRef, useState } from "react";
import { Loader2, Plus, Search, Upload, Video } from "lucide-react";
import type { AssetRow } from "./types";
import { fmtShort } from "./types";

/**
 * The media bin — one pool, source filters.
 *
 * The old panel was four tabs that read as four libraries, opening on Stock
 * with the creator's own files third under a label that named a storage
 * bucket ("Uploads"). The complaint that came back was "it doesn't allow for
 * any clips to be uploaded into it" — which was never true; the control was
 * just behind two clicks and a word nobody was looking for.
 *
 * Underneath, all four sources have always been the same thing: upload,
 * webcam capture, stock import and AI generation every write one media_assets
 * row. So this is one grid with filters over it, "Yours" leads whenever it
 * isn't empty, and the filter is named for the person rather than the bucket.
 *
 * Stock and AI keep their existing panels — they are search-and-generate
 * surfaces, not grids of owned files — and are passed in rather than rebuilt.
 */

export type BinFilter = "mine" | "webcam" | "stock" | "ai" | "music";

export interface MediaBinProps {
  assets: AssetRow[];
  loading: boolean;
  /** Disabled with a reason when the clip is assembled from multiple beats. */
  lockedReason: string | null;
  uploading: boolean;
  onUpload: (file: File, kind: "broll_video" | "broll_image" | "music") => void;
  /** Click-to-place, for people who would rather not drag. */
  onPlace: (assetId: number) => void;
  stockPanel: React.ReactNode;
  aiPanel: React.ReactNode;
}

const isImage = (a: AssetRow) => a.kind === "broll_image";
const isMusic = (a: AssetRow) => a.kind === "music";
/** Webcam takes come through the same endpoint; the name is the only marker. */
const isWebcam = (a: AssetRow) => /webcam|recording/i.test(a.name || "");

export default function MediaBin(props: MediaBinProps) {
  const { assets, loading, lockedReason, uploading, onUpload, onPlace, stockPanel, aiPanel } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");

  const mine = useMemo(() => assets.filter((a) => !isMusic(a)), [assets]);
  const music = useMemo(() => assets.filter(isMusic), [assets]);
  const webcam = useMemo(() => mine.filter(isWebcam), [mine]);

  /**
   * Yours leads whenever it isn't empty. On a genuinely empty library there
   * is nothing to lead with, so the bin opens on the drop zone instead — the
   * one case where reaching for stock first is the right answer.
   */
  const [filter, setFilter] = useState<BinFilter>(mine.length > 0 ? "mine" : "mine");

  const shown = useMemo(() => {
    const pool = filter === "music" ? music : filter === "webcam" ? webcam : mine;
    const needle = q.trim().toLowerCase();
    return needle ? pool.filter((a) => (a.name || "").toLowerCase().includes(needle)) : pool;
  }, [filter, mine, music, webcam, q]);

  const chips: Array<{ id: BinFilter; label: string; count: string | number }> = [
    { id: "mine", label: "Yours", count: mine.length },
    { id: "webcam", label: "Webcam", count: webcam.length },
    { id: "stock", label: "Stock", count: "∞" },
    { id: "ai", label: "AI", count: "" },
    { id: "music", label: "Music", count: music.length },
  ];

  const pick = (kind: "broll_video" | "broll_image" | "music") => {
    const el = fileRef.current;
    if (!el) return;
    el.accept = kind === "music" ? "audio/*" : "video/*,image/*";
    el.dataset.kind = kind;
    el.click();
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#05070f]">
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          const declared = (e.target.dataset.kind as "broll_video" | "broll_image" | "music") || "broll_video";
          e.target.value = "";
          if (!f) return;
          // An image picked from the video slot is still an image — the kind
          // is decided by the file, not by which button opened the dialog.
          const kind = declared === "music" ? "music" : f.type.startsWith("image/") ? "broll_image" : "broll_video";
          onUpload(f, kind);
        }}
      />

      <div className="p-3.5 border-b border-white/10 flex flex-col gap-2.5 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-display text-[13px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
            Media
          </span>
          <button
            onClick={() => pick(filter === "music" ? "music" : "broll_video")}
            disabled={uploading}
            className="inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-[7px] bg-primary text-white text-xs font-semibold hover:bg-primary/90 disabled:opacity-50"
            data-testid="bin-add-media"
          >
            {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
            Add media
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => {
            const on = filter === c.id;
            return (
              <button
                key={c.id}
                onClick={() => setFilter(c.id)}
                className={`h-[26px] px-2.5 rounded-[7px] text-[11px] transition-colors ${
                  on
                    ? "bg-primary/15 border border-primary/45 text-primary font-semibold"
                    : "border border-white/10 text-muted-foreground hover:text-foreground hover:border-white/20"
                }`}
                data-testid={`bin-filter-${c.id}`}
              >
                {c.label}
                {c.count !== "" && <span className={`ml-1 ${on ? "opacity-70" : "text-muted-foreground/60"}`}>{c.count}</span>}
              </button>
            );
          })}
        </div>

        {filter !== "stock" && filter !== "ai" && (
          <label className="h-[30px] flex items-center gap-2 px-2.5 rounded-lg border border-white/10 focus-within:border-primary/50">
            <Search className="w-3.5 h-3.5 text-muted-foreground/70 shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search your footage"
              className="flex-1 min-w-0 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none"
              data-testid="bin-search"
            />
          </label>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {filter === "stock" ? (
          <div className="p-3.5">{stockPanel}</div>
        ) : filter === "ai" ? (
          <div className="p-3.5">{aiPanel}</div>
        ) : loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
        ) : shown.length === 0 ? (
          <EmptyBin onChoose={() => pick(filter === "music" ? "music" : "broll_video")} filter={filter} searching={!!q.trim()} />
        ) : (
          <div className="p-3.5 grid grid-cols-2 gap-2.5">
            {shown.map((a) => (
              <AssetCard key={a.id} asset={a} locked={!!lockedReason} onPlace={() => onPlace(a.id)} />
            ))}
            <button
              onClick={() => pick(filter === "music" ? "music" : "broll_video")}
              className="h-[78px] rounded-lg border border-dashed border-white/15 hover:border-primary/50 flex flex-col items-center justify-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
              data-testid="bin-drop-tile"
            >
              <Plus className="w-4 h-4" />
              <span className="text-[10px]">Add files</span>
            </button>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-white/10 shrink-0 flex gap-2 text-[11px] leading-snug text-muted-foreground/80">
        <Video className="w-3.5 h-3.5 shrink-0 mt-px" />
        {lockedReason ? (
          <span className="text-amber-300/80">{lockedReason}</span>
        ) : (
          <span>
            Drag onto <span className="font-mono text-foreground/70">V1</span> to place — the drop point sets the
            start, and the length comes from the clip, not a fixed 3 seconds.
          </span>
        )}
      </div>
    </div>
  );
}

function EmptyBin({ onChoose, filter, searching }: { onChoose: () => void; filter: BinFilter; searching: boolean }) {
  if (searching) {
    return <p className="px-4 py-8 text-center text-xs text-muted-foreground">Nothing here matches that.</p>;
  }
  return (
    <div className="p-5 flex flex-col gap-3.5 items-start">
      <button
        onClick={onChoose}
        className="w-full h-[132px] rounded-[10px] border-[1.5px] border-dashed border-white/15 bg-primary/[0.04] hover:border-primary/50 hover:bg-primary/[0.07] transition-colors flex flex-col items-center justify-center gap-2"
        data-testid="bin-empty-drop"
      >
        <Upload className="w-5 h-5 text-primary" />
        <span className="font-display text-sm font-semibold text-foreground">
          {filter === "music" ? "Add a music bed" : "Drop your own footage here"}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {filter === "music" ? "any audio file" : "video or stills"}
        </span>
      </button>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Nothing of yours here yet. Stock and AI are one chip away — but the moment you add a file of your own,
        this is what the bin opens on.
      </p>
    </div>
  );
}

function AssetCard({ asset, locked, onPlace }: { asset: AssetRow; locked: boolean; onPlace: () => void }) {
  const dur = Number(asset.durationSec);
  const badge = isImage(asset) ? "still" : Number.isFinite(dur) && dur > 0 ? fmtShort(dur) : "—";
  return (
    <div
      draggable={!locked}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-fullscale-asset", String(asset.id));
        e.dataTransfer.effectAllowed = "copy";
      }}
      className={`flex flex-col gap-1.5 ${locked ? "opacity-50" : "cursor-grab active:cursor-grabbing"}`}
      data-testid={`bin-asset-${asset.id}`}
    >
      <button
        onClick={locked ? undefined : onPlace}
        disabled={locked}
        title={locked ? undefined : "Place at the playhead"}
        className="relative h-[78px] rounded-lg border border-white/10 hover:border-primary/50 overflow-hidden bg-gradient-to-br from-[#232c3b] to-[#131a26] disabled:cursor-not-allowed"
      >
        {/* No poster: the upload endpoint has never written thumbnailPath and
            media_assets has no width/height column, so there is nothing to
            show but the file's own identity. Rather than a grey rectangle,
            the badge row carries the information that exists. */}
        <span className="absolute left-1.5 top-1.5 h-4 px-1.5 rounded bg-black/65 text-[10px] font-mono text-foreground/90 flex items-center">
          {badge}
        </span>
        {isWebcam(asset) && (
          <span className="absolute right-1.5 top-1.5 h-4 px-1.5 rounded bg-emerald-500/20 text-[10px] text-emerald-300 flex items-center">
            Webcam
          </span>
        )}
      </button>
      <span className="text-[11px] text-foreground/80 truncate" title={asset.name}>
        {asset.name}
      </span>
    </div>
  );
}
