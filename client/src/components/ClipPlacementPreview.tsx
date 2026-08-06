/**
 * Placement preview for one editorial clip — what a brand's product would
 * look like on each fixture the clip actually shows.
 *
 * COORDINATE HONESTY. Surface boxes live in SOURCE-video space, and rendered
 * clips are cropped/reframed (9:16 follows the speaker), so drawing these
 * boxes over the rendered output would point at the wrong pixels. The preview
 * therefore uses the scene inventory's keyframes — real source-space frames
 * with the fixture's median bbox — which is the same convention the render
 * pipeline composites in. What you see here is where the product sits before
 * the reframe; the reframe is constrained to keep placements in view
 * (faceTracker anchorBoxes), so the framing survives the crop.
 *
 * Three states per fixture, and they are different answers:
 *   placed   — a saved placement exists: product sprite drawn at its
 *              transform, solid box
 *   open     — fixture detected, nothing placed: dashed box + CTA
 *   (absent) — not in this clip's playing range at all
 */
import { useMemo } from "react";
import { fetchWithTimeout } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, PackageOpen, Move, X as XIcon, ScanSearch } from "lucide-react";

interface SceneSurface {
  groupId: string | null;
  surfaceType: string;
  bbox: { x: number; y: number; w: number; h: number };
  confidence?: number;
  screenTimeSec?: number;
  frameUrl?: string | null;
  representativeRowId?: number;
}

interface ClipSurfacesResponse {
  surfaces: Array<{
    id: number;
    surfaceType: string;
    surfaceGroupId: string | null;
    timestamp: string;
    boundingBoxX: string;
    boundingBoxY: string;
    boundingBoxWidth: string;
    boundingBoxHeight: string;
  }>;
  sceneInventory: { scenes: Array<{ sceneId: string | number; label?: string; surfaces: SceneSurface[] }> } | null;
  count: number;
  scanState?: { inFlight: boolean; mode: string | null; videoScanned: boolean };
}

interface SavedPlacement {
  id: number;
  surfaceId: number;
  editorialClipId?: number | null;
  productId: number | null;
  productImageUrl: string;
  harmonizedImageUrl?: string | null;
  isHarmonized?: boolean;
  appliesToGroupIds?: string[] | null;
  status: string;
  transform: { offsetX: number; offsetY: number; scale: number; rotation: number; flipH: boolean };
  blend: { opacity: number };
}

interface Props {
  clipId: number;
  videoId: number;
  clipTitle?: string | null;
  onClose: () => void;
  onScan?: () => void;
  scanInFlight?: boolean;
}

export default function ClipPlacementPreview({ clipId, videoId, clipTitle, onClose, onScan, scanInFlight }: Props) {
  const { data: surf, isLoading } = useQuery<ClipSurfacesResponse>({
    queryKey: ["/api/editorial-clips", clipId, "surfaces"],
    queryFn: async () => {
      const res = await fetchWithTimeout(`/api/editorial-clips/${clipId}/surfaces`, { credentials: "include" });
      if (!res.ok) throw new Error("surfaces unavailable");
      return res.json();
    },
    // While a scan runs, keep the panel live so surfaces appear as they land.
    refetchInterval: scanInFlight ? 8000 : false,
  });

  const { data: placements } = useQuery<SavedPlacement[]>({
    queryKey: ["/api/video", videoId, "placements", "clip-preview"],
    queryFn: async () => {
      const res = await fetchWithTimeout(`/api/video/${videoId}/placements`, { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return data.placements || [];
    },
  });

  // One card per physical fixture in the clip, with its best matching
  // placement. Clip-scoped placements outrank video-level ones — the same
  // precedence the render uses, so the preview predicts the output.
  const fixtures = useMemo(() => {
    const scenes = surf?.sceneInventory?.scenes ?? [];
    const surfaceRows = surf?.surfaces ?? [];
    const saved = (placements ?? []).filter((p) => p.status !== "archived");

    const byGroup = new Map<string, { surface: SceneSurface; sceneLabel: string }>();
    for (const sc of scenes) {
      for (const sf of sc.surfaces ?? []) {
        const key = sf.groupId ?? `row-${sf.representativeRowId}`;
        if (!byGroup.has(key)) byGroup.set(key, { surface: sf, sceneLabel: String(sc.label ?? sc.sceneId) });
      }
    }
    // Fixtures with no inventory entry (ungrouped detections) still get a
    // card, from their raw row — bbox only, no keyframe.
    for (const row of surfaceRows) {
      const key = row.surfaceGroupId ?? `raw-${row.id}`;
      if (byGroup.has(key)) continue;
      byGroup.set(key, {
        surface: {
          groupId: row.surfaceGroupId,
          surfaceType: row.surfaceType,
          bbox: {
            x: parseFloat(row.boundingBoxX), y: parseFloat(row.boundingBoxY),
            w: parseFloat(row.boundingBoxWidth), h: parseFloat(row.boundingBoxHeight),
          },
          frameUrl: null,
          representativeRowId: row.id,
        },
        sceneLabel: "",
      });
    }

    const rowIdsByGroup = new Map<string, number[]>();
    for (const row of surfaceRows) {
      const key = row.surfaceGroupId ?? `raw-${row.id}`;
      if (!rowIdsByGroup.has(key)) rowIdsByGroup.set(key, []);
      rowIdsByGroup.get(key)!.push(row.id);
    }

    return Array.from(byGroup.entries()).map(([key, { surface, sceneLabel }]) => {
      const rowIds = new Set(rowIdsByGroup.get(key) ?? (surface.representativeRowId ? [surface.representativeRowId] : []));
      const candidates = saved.filter((p) =>
        rowIds.has(p.surfaceId) ||
        (surface.groupId && Array.isArray(p.appliesToGroupIds) && p.appliesToGroupIds.includes(surface.groupId)));
      const placement =
        candidates.find((p) => p.editorialClipId === clipId) ??
        candidates.find((p) => p.editorialClipId == null) ??
        null;
      return { key, surface, sceneLabel, placement, anchorRowId: rowIds.values().next().value as number | undefined };
    });
  }, [surf, placements, clipId]);

  const placedCount = fixtures.filter((f) => f.placement).length;
  const scanState = surf?.scanState;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        data-testid={`placement-preview-${clipId}`}
      >
        <div className="sticky top-0 bg-gray-900/95 backdrop-blur border-b border-gray-800 px-5 py-3 flex items-center gap-3">
          <PackageOpen className="w-4 h-4 text-purple-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate">{clipTitle || `Clip #${clipId}`} — placement preview</p>
            <p className="text-[11px] text-gray-500">
              Source-space frames; the vertical reframe keeps placed products in view.
            </p>
          </div>
          {fixtures.length > 0 && (
            <Badge variant="outline" className="text-[10px] shrink-0">
              {placedCount}/{fixtures.length} placed
            </Badge>
          )}
          <button onClick={onClose} className="text-gray-400 hover:text-white shrink-0" data-testid="close-preview">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5">
          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-purple-400" /></div>
          ) : fixtures.length === 0 ? (
            <div className="text-center py-10">
              <ScanSearch className="w-10 h-10 text-gray-600 mx-auto mb-3" />
              {scanState && !scanState.videoScanned ? (
                <>
                  <p className="text-sm text-gray-300 mb-1">This clip hasn't been scanned</p>
                  <p className="text-xs text-gray-500 max-w-sm mx-auto mb-4">
                    No surfaces are known for the source video yet, so there's no placement
                    inventory to preview — and nothing for a brand to request.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-gray-300 mb-1">No placement surfaces in this clip's range</p>
                  <p className="text-xs text-gray-500 max-w-sm mx-auto mb-4">
                    The scan found nothing sellable inside {" "}
                    this cut. A denser scan of the range sometimes finds surfaces the sparse pass missed.
                  </p>
                </>
              )}
              {onScan && (
                <Button size="sm" onClick={onScan} disabled={scanInFlight} className="bg-purple-600 hover:bg-purple-500 text-white text-xs">
                  {scanInFlight ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5 mr-1.5" />}
                  {scanInFlight ? "Scanning…" : scanState && !scanState.videoScanned ? "Scan source video" : "Scan this clip's range"}
                </Button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {fixtures.map(({ key, surface, sceneLabel, placement, anchorRowId }) => {
                const b = surface.bbox;
                const t = placement?.transform;
                // Sprite rect inside the bbox, mirroring the render's
                // transform math at preview fidelity: scale relative to the
                // box, offsets as fractions of it.
                const spriteW = (t?.scale ?? 0.6) * b.w * 100;
                const spriteH = spriteW; // product images are near-square; the render preserves AR
                const spriteX = (b.x + b.w * 0.5) * 100 + (t?.offsetX ?? 0) * b.w * 100 - spriteW / 2;
                const spriteY = (b.y + b.h * 0.5) * 100 + (t?.offsetY ?? 0) * b.h * 100 - spriteH / 2;
                const img = placement?.isHarmonized && placement.harmonizedImageUrl
                  ? placement.harmonizedImageUrl
                  : placement?.productImageUrl;
                return (
                  <div key={key} className="rounded-lg border border-gray-700/60 overflow-hidden bg-black/40">
                    <div className="relative aspect-video bg-gray-950">
                      {surface.frameUrl ? (
                        <img src={surface.frameUrl} alt={surface.surfaceType} className="w-full h-full object-cover" loading="lazy" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[11px] text-gray-600">
                          no keyframe — box position only
                        </div>
                      )}
                      {/* Fixture box: solid when placed, dashed when open */}
                      <div
                        className={`absolute rounded-sm pointer-events-none ${
                          placement ? "border-2 border-emerald-400/90" : "border-2 border-dashed border-amber-400/70"
                        }`}
                        style={{
                          left: `${b.x * 100}%`, top: `${b.y * 100}%`,
                          width: `${b.w * 100}%`, height: `${b.h * 100}%`,
                        }}
                      />
                      {placement && img && (
                        <img
                          src={img}
                          alt="placed product"
                          className="absolute pointer-events-none object-contain"
                          style={{
                            left: `${spriteX}%`, top: `${spriteY}%`,
                            width: `${spriteW}%`, height: `${spriteH}%`,
                            opacity: (placement.blend?.opacity ?? 90) / 100,
                            transform: `rotate(${t?.rotation ?? 0}deg)${t?.flipH ? " scaleX(-1)" : ""}`,
                          }}
                        />
                      )}
                    </div>
                    <div className="px-3 py-2 flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium truncate">
                          {surface.surfaceType}
                          {sceneLabel ? <span className="text-gray-500"> · {sceneLabel}</span> : null}
                        </p>
                        <p className="text-[10px] text-gray-500">
                          {placement
                            ? placement.editorialClipId === clipId
                              ? "Placed for this clip"
                              : "Placed at video level — applies here"
                            : "Open — nothing placed yet"}
                          {typeof surface.screenTimeSec === "number" && surface.screenTimeSec > 0
                            ? ` · ${Math.round(surface.screenTimeSec)}s on screen`
                            : ""}
                        </p>
                      </div>
                      <Link
                        href={`/remix/${videoId}?${new URLSearchParams({
                          clip: String(clipId),
                          ...(anchorRowId ? { surface: String(anchorRowId) } : {}),
                        }).toString()}`}
                      >
                        <Button size="sm" variant="ghost" className="text-[11px] text-purple-300 hover:text-purple-200 h-7 px-2">
                          <Move className="w-3 h-3 mr-1" />
                          {placement ? "Adjust" : "Place"}
                        </Button>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
