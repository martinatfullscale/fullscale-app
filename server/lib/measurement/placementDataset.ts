/**
 * One row per placement, joining what we measured to what happened.
 *
 * Until now the vision layer and the measurement layer had never met in a
 * single query: geometry lived on saved_placements and detected_surfaces,
 * dose on fixture_exposure, the audience on placement_exposures and the
 * YouTube tables, and nothing joined them. This is that join — the file a
 * partner can actually regress, and the thing the "every placement emits a
 * coordinate vector" claim has to cash out as.
 *
 * Two rules it holds itself to:
 *
 * 1. EVERY COLUMN CARRIES ITS OWN DEFINITION. The registry below is both the
 *    CSV header and the data dictionary, so a column cannot ship without
 *    saying what it is, what unit it is in, and what it is measured against.
 *    Several of these numbers are proxies; the dictionary says so rather than
 *    letting the column name imply more precision than exists.
 *
 * 2. NULL AND ZERO ARE DIFFERENT. "Not measured" is never written as 0.
 *    Placements saved before a measurement existed, or without harmonizing,
 *    come back null with a coverage flag, because a zero would quietly drag
 *    any average that includes it.
 */

import { retentionAtPlacement, type RetentionCurveRow } from "../postTimeline";
import { readCanvasDims } from "@shared/placementCanvas";
import type { PlacementVector } from "@shared/placementVector";
import type { DeliveredPlacement } from "@shared/deliveredGeometry";
import {
  foldSurfaceMeasurements,
  sanitizeSurfaceMeasurement,
  type SurfaceMeasurement,
} from "@shared/surfaceMeasurement";

export interface DatasetColumn {
  key: string;
  description: string;
  /** "fraction of frame", "seconds", "count", "degrees", "" for categorical. */
  unit: string;
  /** What the number is measured against — the caveat a reader needs. */
  basis?: string;
}

export const PLACEMENT_DATASET_COLUMNS: DatasetColumn[] = [
  // ── identity ──
  { key: "placement_id", description: "Primary key of the placement. One row per placement.", unit: "id" },
  { key: "video_id", description: "The source video the placement lives on.", unit: "id" },
  { key: "video_title", description: "Title of the source video.", unit: "" },
  { key: "video_platform", description: "Where the source video came from.", unit: "" },
  { key: "creator_user_id", description: "Owner of the content.", unit: "" },
  { key: "surface_id", description: "The anchor detection row this placement was authored on.", unit: "id" },
  { key: "surface_group_id", description: "Canonical physical-surface identity; stable across rescans, and across episodes when model-backed.", unit: "" },
  { key: "fixture_is_model_backed", description: "True when the fixture comes from the creator's persistent set model, so it is comparable across episodes.", unit: "boolean" },
  { key: "scene_id", description: "Scene class (recurring camera setup) the surface sits in.", unit: "id" },

  // ── the surface, in frame coordinates ──
  { key: "surface_type", description: "What the detector called it (Table, Wall, Shelf…).", unit: "" },
  { key: "surface_orientation", description: "horizontal (product) or vertical (signage).", unit: "" },
  { key: "surface_confidence", description: "Consensus confidence for the detection.", unit: "0-1" },
  { key: "surface_timestamp_sec", description: "Where in the source video this detection was made.", unit: "seconds" },
  { key: "surface_x", description: "Left edge of the surface box.", unit: "fraction of frame width" },
  { key: "surface_y", description: "Top edge of the surface box.", unit: "fraction of frame height" },
  { key: "surface_w", description: "Surface box width.", unit: "fraction of frame width" },
  { key: "surface_h", description: "Surface box height.", unit: "fraction of frame height" },
  { key: "surface_area_share", description: "Share of the frame the surface occupies.", unit: "fraction of frame area" },

  // ── the placement, in frame coordinates ──
  { key: "product_center_x", description: "Where the product sits horizontally: the surface centre plus the creator's offset.", unit: "fraction of frame width", basis: "null when the placement predates canvas recording, since its offsets have no known scale" },
  { key: "product_center_y", description: "Where the product sits vertically.", unit: "fraction of frame height", basis: "as product_center_x" },
  { key: "dist_from_left", description: "Distance from the product centre to the left frame edge.", unit: "fraction of frame width" },
  { key: "dist_from_right", description: "Distance to the right frame edge.", unit: "fraction of frame width" },
  { key: "dist_from_top", description: "Distance to the top frame edge.", unit: "fraction of frame height" },
  { key: "dist_from_bottom", description: "Distance to the bottom frame edge.", unit: "fraction of frame height" },
  { key: "dist_from_left_px", description: "Distance from the left edge in pixels of the measured frame.", unit: "pixels", basis: "only when the frame size was recorded by a harmonize run" },
  { key: "dist_from_top_px", description: "Distance from the top edge in pixels of the measured frame.", unit: "pixels", basis: "as dist_from_left_px" },
  { key: "product_scale", description: "Creator's scale multiplier on the fit-to-surface size.", unit: "multiplier" },
  { key: "product_rotation_deg", description: "Creator's rotation.", unit: "degrees" },
  { key: "product_area_share_est", description: "ESTIMATED share of frame the product covers: surface area x scale squared.", unit: "fraction of frame area", basis: "an estimate — the product's own aspect ratio is not stored, so this is the fitted box, not the drawn pixels" },
  { key: "geometry_trusted", description: "False when the placement predates canvas recording, so its offsets are interpreted with a renderer's assumption rather than a recorded size.", unit: "boolean" },

  // ── where it actually landed, from the renderer that drew it ──
  { key: "delivered_source", description: "Which render this geometry came from: a video export or an editorial clip.", unit: "", basis: "null when no render of this placement recorded geometry — including a render produced outside the platform and uploaded by hand" },
  { key: "delivered_x", description: "Left edge of the product as drawn.", unit: "fraction of rendered frame width" },
  { key: "delivered_y", description: "Top edge of the product as drawn.", unit: "fraction of rendered frame height" },
  { key: "delivered_w", description: "Product width as drawn.", unit: "fraction of rendered frame width" },
  { key: "delivered_h", description: "Product height as drawn.", unit: "fraction of rendered frame height" },
  { key: "delivered_center_x", description: "Horizontal centre of the product as drawn.", unit: "fraction of rendered frame width" },
  { key: "delivered_center_y", description: "Vertical centre of the product as drawn.", unit: "fraction of rendered frame height" },
  { key: "delivered_area_share", description: "Share of the rendered frame the product covers. This is the drawn pixels, not an estimate.", unit: "fraction of frame area" },
  { key: "intent_to_delivered_drift", description: "How far the delivered centre sits from the intended centre.", unit: "fraction of frame diagonal", basis: "null unless both the intent and the delivery are known; a crop or a different frame size moves it legitimately" },
  { key: "delivered_visible_sec", description: "Seconds the product was on screen in the render.", unit: "seconds", basis: "read delivered_dwell_basis before comparing two rows" },
  { key: "delivered_dwell_basis", description: "How the dwell was derived: visibility-windows (exact), sampled (measured from drawn frames), full-render (upper bound, does not subtract b-roll), or unknown.", unit: "" },
  { key: "delivered_sample_kind", description: "static for one fixed rect, frame-sampled for a tracked placement.", unit: "" },
  { key: "delivered_frame_w", description: "Width of the frame it was rendered into.", unit: "pixels" },
  { key: "delivered_frame_h", description: "Height of the frame it was rendered into.", unit: "pixels" },
  { key: "delivered_clipped_at_edge", description: "True when the product had to be pushed back inside the frame to stay visible.", unit: "boolean" },
  { key: "delivered_rendered_at", description: "When that render was produced.", unit: "ISO 8601" },

  // ── what harmonize measured about the spot ──
  { key: "region_surface_normal", description: "Measured orientation of the surface plane.", unit: "" },
  { key: "region_tilt_deg", description: "Tilt away from perpendicular to the camera axis.", unit: "degrees" },
  { key: "region_shadow_direction", description: "Direction of the shadow already present in the scene.", unit: "" },
  { key: "region_shadow_intensity", description: "Strength of that existing shadow.", unit: "0-1" },
  { key: "region_hue_deg", description: "Dominant hue of the region.", unit: "degrees (0-360)" },
  { key: "region_saturation", description: "Dominant saturation of the region.", unit: "0-1" },
  { key: "region_luminance", description: "Average luminance of the region.", unit: "0-1" },
  { key: "region_open_space", description: "How crowded the spot is: cramped, open or isolated.", unit: "" },
  { key: "region_recommended_scale", description: "Scale the model thought the product should be.", unit: "multiplier", basis: "harmonize-only: it is a multiplier on one product's chosen size, so a scan-measured surface leaves it null" },
  { key: "region_neighbors", description: "Objects the model saw next to the spot.", unit: "list" },
  { key: "region_measured_on", description: "Which reading the region columns came from: placement (measured against the exact box the product was dropped in, during a harmonize) or surface (measured by the scan for the surface as a whole).", unit: "", basis: "a placement reading describes a product-sized crop; a surface reading describes the whole surface. Do not average the two without splitting on this column." },
  { key: "region_sample_count", description: "How many scanned frames the surface reading was folded from.", unit: "count", basis: "null for a placement reading, which is a single measurement" },
  { key: "region_hue_agreement", description: "How much the scanned frames agreed about the hue, as the resultant length of their angles.", unit: "0-1", basis: "near 0 means the frames disagreed and region_hue_deg carries no information; null for a placement reading" },

  // ── depth ──
  { key: "depth_band", description: "Which layer of the scene the spot sits in: foreground, midground or background.", unit: "" },
  { key: "depth_rank_in_frame", description: "Ordering of this surface among the surfaces in its frame, 1 being nearest the camera.", unit: "rank", basis: "ordinal WITHIN one frame; not comparable across frames or videos" },
  { key: "depth_vs_person", description: "Where the spot sits relative to the nearest person along the camera axis: in-front-of-person, alongside-person, behind-person, or no-person.", unit: "", basis: "a depth-model reading cannot see people, so this always comes from the scan" },
  { key: "depth_relative", description: "Sampled depth at the spot, 1 being closest to camera.", unit: "0-1", basis: "null unless a depth map was actually sampled — absent is NOT the far plane. Normalised per image, so it ranks planes within one frame and must never be compared across frames" },
  { key: "depth_source", description: "vision (the scan's estimate, present for every surface) or depth-model (a sampled depth map, present only where one was run).", unit: "" },
  { key: "depth_sample_count", description: "How many readings the folded depth rests on.", unit: "count" },
  { key: "atmosphere_brightness_factor", description: "Brightness correction the scene implied for the product.", unit: "multiplier" },
  { key: "atmosphere_scene_brightness", description: "Measured brightness of the scene around the placement.", unit: "0-1" },
  { key: "scene_measurement_mode", description: "Which harmonize path produced the measurements.", unit: "" },
  { key: "has_scene_measurement", description: "False when neither the scan nor a harmonize run produced a reading of the spot, so the region columns are null.", unit: "boolean", basis: "read with region_measured_on: true no longer implies a harmonize ran, because the scan now measures every surface it finds" },

  // ── proximity to people ──
  { key: "person_count", description: "People detected in the frame this surface was measured on.", unit: "count" },
  { key: "person_overlap_fraction", description: "Share of the surface covered by people, as a union.", unit: "0-1" },
  { key: "person_nearest_gap", description: "Gap from the surface to the nearest person, aspect-corrected.", unit: "fraction of frame diagonal", basis: "0 means they overlap; null means nobody was detected" },
  { key: "person_nearest_side", description: "Which side the nearest person was on.", unit: "" },
  { key: "has_person_context", description: "False when the frame carried no people data at all, which is not the same as nobody being there.", unit: "boolean" },

  // ── dose ──
  { key: "scene_screen_time_sec", description: "Seconds the fixture's SCENE CLASS is on screen in the video.", unit: "seconds", basis: "PROXY: a scene-level quantity copied onto every fixture in that scene, not a per-surface measurement. Summing across fixtures in a video double-counts." },
  { key: "scene_occurrences", description: "How many times that camera setup recurs.", unit: "count" },
  { key: "fixture_row_count", description: "Detection rows backing this fixture in the scan — a data-quality signal.", unit: "count" },
  { key: "video_duration_sec", description: "Video duration at scan time.", unit: "seconds" },

  // ── exposure ──
  { key: "went_live", description: "Whether this placement was ever recorded as reaching an audience.", unit: "boolean" },
  { key: "exposure_platform", description: "Platform the carrying post was published on.", unit: "" },
  { key: "exposure_post_id", description: "Platform-native id of the post carrying the placement.", unit: "" },
  { key: "live_at", description: "When the audience could first see it.", unit: "ISO 8601" },
  { key: "source_start_sec", description: "Placement position in SOURCE-video seconds.", unit: "seconds" },
  { key: "editorial_clip_id", description: "The clip that aired, when the post was a clip rather than the full upload.", unit: "id" },
  { key: "clip_start_sec", description: "Offset mapping source seconds into the post's own timeline.", unit: "seconds" },
  { key: "link_source", description: "How the go-live was recorded: creator_confirmed, auto_matched or admin.", unit: "" },

  // ── outcome ──
  { key: "retention_watch_ratio", description: "Audience retention at the placement's moment.", unit: "0-1", basis: "only when the post IS the source upload; a clip posted separately has its own curve, which is not captured" },
  { key: "retention_video_mean", description: "Mean retention across the whole video, for comparison.", unit: "0-1" },
  { key: "retention_lift", description: "Retention at the placement minus the video mean. Above zero means more viewers than average were present.", unit: "difference", basis: "descriptive, not causal: treatment is not randomised" },
  { key: "retention_unavailable_reason", description: "Why retention is null, in words.", unit: "" },
  { key: "link_clicks", description: "Clicks on the placement's own tracking link.", unit: "count", basis: "raw clicks: no bot filtering and no unique-visitor dedup" },
  { key: "conversions", description: "Conversions reported for the placement.", unit: "count", basis: "always 0 today: the postback endpoint issues no key, so no brand can report one" },

  // ── provenance ──
  { key: "is_demo_data", description: "True for seeded or demo rows, which must never be read as results.", unit: "boolean" },
  { key: "row_built_at", description: "When this row was generated.", unit: "ISO 8601" },
];

export type DatasetRow = Record<string, string | number | boolean | null>;

export interface DatasetInput {
  placement: any;
  video: any | null;
  surface: any | null;
  fixture: any | null;
  exposure: any | null;
  curve: RetentionCurveRow | undefined;
  sourcePlatformPostId: string | null;
  clicks: number;
  conversions: number;
  /** Where the renderer actually drew it, when any render recorded geometry. */
  delivered: DeliveredPlacement | null;
  /**
   * Every scanned frame's reading of the fixture this placement sits on.
   *
   * Optional, and the reason it is a list: the scan writes one row per
   * supporting frame, so a desk seen in twelve frames has twelve readings. A
   * caller that has the whole group should pass it, and region_sample_count
   * then says how many frames the answer rests on. When it is absent the
   * anchor row's own reading is used, which is a sample of one and reports
   * itself as such.
   */
  surfaceMeasurements?: SurfaceMeasurement[] | null;
  builtAt: string;
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (n: number | null, places = 4): number | null =>
  n === null ? null : Math.round(n * 10 ** places) / 10 ** places;

/** A seeded or demo video must never be mistaken for a result. */
export function isDemoVideo(video: any | null): boolean {
  const yt = String(video?.youtubeId ?? "");
  const id = Number(video?.id ?? 0);
  return yt.startsWith("demo-") || (id >= 1001 && id <= 1099);
}

export function buildDatasetRow(input: DatasetInput): DatasetRow {
  const { placement, video, surface, fixture, exposure, curve, clicks, conversions, builtAt } = input;
  const transform = placement?.transform ?? {};
  const vector: PlacementVector | null = placement?.placementVector ?? null;
  const person = surface?.personContext ?? null;

  // The same spot can be described twice: once by the scan, for the surface as
  // a whole, and once by a harmonize run, against the exact box the product
  // was dropped in. The harmonize reading is the tighter one where it exists,
  // so it wins — but the scan's reading is the one that exists for EVERY
  // surface, including the ones nobody ever bought. `region_measured_on` says
  // which, because averaging the two without knowing would compare a
  // product-sized crop against a whole desk.
  const groupReadings = Array.isArray(input.surfaceMeasurements) && input.surfaceMeasurements.length
    ? input.surfaceMeasurements
    : [surface?.surfaceMeasurement];
  const surfaceMeasurement = foldSurfaceMeasurements(
    groupReadings
      .map((m) => sanitizeSurfaceMeasurement(m))
      .filter((m): m is SurfaceMeasurement => m !== null),
  );
  const region = vector?.regionAnalysis ?? surfaceMeasurement ?? null;
  const regionSource: "placement" | "surface" | null =
    vector?.regionAnalysis ? "placement" : surfaceMeasurement ? "surface" : null;

  // Depth resolves on its own, not with the region block, because the two
  // come from different instruments. A sampled depth map beats the scan's
  // estimate — but it cannot see people, so depth_vs_person always comes from
  // the scan's reading even when the number beside it was measured.
  const scanDepth = surfaceMeasurement?.depth ?? null;
  const sampledDepth = vector?.depth ?? null;
  const depth = sampledDepth ?? scanDepth;
  const depthVsPerson = scanDepth?.relativeToPerson ?? null;

  const sx = numOrNull(surface?.boundingBoxX);
  const sy = numOrNull(surface?.boundingBoxY);
  const sw = numOrNull(surface?.boundingBoxWidth);
  const sh = numOrNull(surface?.boundingBoxHeight);
  const surfaceArea = sw !== null && sh !== null ? sw * sh : null;

  // Offsets are canvas pixels. Without the canvas they were dragged on there
  // is no scale to convert them, so the position is reported as unknown
  // rather than guessed with a renderer's default.
  const dims = readCanvasDims(transform);
  const scale = numOrNull(transform?.scale);
  const offsetX = numOrNull(transform?.offsetX);
  const offsetY = numOrNull(transform?.offsetY);
  const centerX = dims && sx !== null && sw !== null && offsetX !== null
    ? sx + sw / 2 + offsetX / dims.canvasWidth
    : null;
  const centerY = dims && sy !== null && sh !== null && offsetY !== null
    ? sy + sh / 2 + offsetY / dims.canvasHeight
    : null;

  const frame = vector?.frameDimensions ?? null;

  // Where it was actually drawn, and how far that is from where it was meant
  // to go. They diverge for ordinary reasons — a crop, a different frame size,
  // a clamp at the edge — which is exactly why both are recorded.
  const deliveredCenter = input.delivered
    ? {
        x: input.delivered.rectFrac.x + input.delivered.rectFrac.w / 2,
        y: input.delivered.rectFrac.y + input.delivered.rectFrac.h / 2,
      }
    : null;
  const drift = deliveredCenter && centerX !== null && centerY !== null
    ? round(Math.hypot(deliveredCenter.x - centerX, deliveredCenter.y - centerY) / Math.SQRT2)
    : null;
  const placed = retentionAtPlacement({
    exposure: exposure ?? { platformPostId: null, sourceStartSec: null },
    curve,
    sourcePlatformPostId: input.sourcePlatformPostId,
  });

  return {
    placement_id: placement?.id ?? null,
    video_id: placement?.videoId ?? null,
    video_title: video?.title ?? null,
    video_platform: video?.platform ?? null,
    creator_user_id: video?.userId ?? null,
    surface_id: placement?.surfaceId ?? null,
    surface_group_id: surface?.surfaceGroupId ?? null,
    fixture_is_model_backed: fixture ? !!fixture.isModelBacked : null,
    scene_id: surface?.sceneId ?? null,

    surface_type: surface?.surfaceType ?? null,
    surface_orientation: surface?.orientation ?? null,
    surface_confidence: round(numOrNull(surface?.confidence)),
    surface_timestamp_sec: round(numOrNull(surface?.timestamp), 2),
    surface_x: round(sx),
    surface_y: round(sy),
    surface_w: round(sw),
    surface_h: round(sh),
    surface_area_share: round(surfaceArea),

    product_center_x: round(centerX),
    product_center_y: round(centerY),
    dist_from_left: round(centerX),
    dist_from_right: centerX === null ? null : round(1 - centerX),
    dist_from_top: round(centerY),
    dist_from_bottom: centerY === null ? null : round(1 - centerY),
    dist_from_left_px: centerX === null || !frame ? null : Math.round(centerX * frame.width),
    dist_from_top_px: centerY === null || !frame ? null : Math.round(centerY * frame.height),
    product_scale: round(scale),
    product_rotation_deg: round(numOrNull(transform?.rotation), 2),
    product_area_share_est: surfaceArea === null || scale === null ? null : round(surfaceArea * scale * scale),
    geometry_trusted: dims !== null,

    delivered_source: input.delivered?.renderKind ?? null,
    delivered_x: input.delivered?.rectFrac.x ?? null,
    delivered_y: input.delivered?.rectFrac.y ?? null,
    delivered_w: input.delivered?.rectFrac.w ?? null,
    delivered_h: input.delivered?.rectFrac.h ?? null,
    delivered_center_x: deliveredCenter ? round(deliveredCenter.x) : null,
    delivered_center_y: deliveredCenter ? round(deliveredCenter.y) : null,
    delivered_area_share: input.delivered?.areaShare ?? null,
    intent_to_delivered_drift: drift,
    delivered_visible_sec: input.delivered?.visibleSec ?? null,
    delivered_dwell_basis: input.delivered?.dwellBasis ?? null,
    delivered_sample_kind: input.delivered?.sampleKind ?? null,
    delivered_frame_w: input.delivered?.frame.width ?? null,
    delivered_frame_h: input.delivered?.frame.height ?? null,
    delivered_clipped_at_edge: input.delivered ? input.delivered.clippedAtEdge : null,
    delivered_rendered_at: input.delivered?.renderedAt ?? null,

    region_surface_normal: region?.surfaceNormal ?? null,
    region_tilt_deg: round(region?.tiltDegrees ?? null, 2),
    region_shadow_direction: region?.existingShadowDirection ?? null,
    region_shadow_intensity: round(region?.existingShadowIntensity ?? null),
    region_hue_deg: round(region?.dominantHueDeg ?? null, 1),
    region_saturation: round(region?.dominantSaturation ?? null),
    region_luminance: round(region?.averageLuminance ?? null),
    region_open_space: region?.openSpaceClass ?? null,
    // Only a harmonize run produces this: it is a multiplier on a specific
    // product's size, so the scan has no opinion on it and leaves it null.
    region_recommended_scale: round(vector?.regionAnalysis?.recommendedScale ?? null),
    region_neighbors: region?.neighboringObjects?.join("; ") ?? null,
    region_measured_on: regionSource,
    region_sample_count: surfaceMeasurement?.sampleCount ?? null,
    region_hue_agreement: regionSource === "surface"
      ? round(surfaceMeasurement?.hueAgreement ?? null)
      : null,
    depth_band: depth?.band ?? null,
    depth_rank_in_frame: depth?.rankInFrame ?? null,
    depth_vs_person: depthVsPerson,
    depth_relative: round(depth?.relativeDepth ?? null),
    depth_source: depth?.source ?? null,
    // Describes the reading actually reported: a sampled placement is one
    // measurement, not the scan's frame count sitting next to it.
    depth_sample_count: sampledDepth ? 1 : (scanDepth?.sampleCount ?? null),

    atmosphere_brightness_factor: round(vector?.atmosphere?.brightnessFactor ?? null),
    atmosphere_scene_brightness: round(vector?.atmosphere?.sceneBrightness ?? null),
    scene_measurement_mode: vector?.mode ?? null,
    has_scene_measurement: !!(region || vector?.atmosphere),

    person_count: person?.measured?.personCount ?? null,
    person_overlap_fraction: round(person?.measured?.overlapFraction ?? null),
    person_nearest_gap: round(person?.measured?.nearestGap ?? null),
    person_nearest_side: person?.measured?.nearestSide ?? null,
    has_person_context: !!person,

    scene_screen_time_sec: round(numOrNull(fixture?.sceneScreenTimeSec), 2),
    scene_occurrences: fixture?.occurrences ?? null,
    fixture_row_count: fixture?.rowCount ?? null,
    video_duration_sec: round(numOrNull(fixture?.videoDurationSec), 2),

    went_live: !!exposure,
    exposure_platform: exposure?.platform ?? null,
    exposure_post_id: exposure?.platformPostId ?? null,
    live_at: exposure?.liveAt ? new Date(exposure.liveAt).toISOString() : null,
    source_start_sec: round(numOrNull(exposure?.sourceStartSec), 2),
    editorial_clip_id: exposure?.editorialClipId ?? null,
    clip_start_sec: round(numOrNull(exposure?.clipStartSec), 2),
    link_source: exposure?.linkSource ?? null,

    retention_watch_ratio: placed.retention?.watchRatioAtPlacement ?? null,
    retention_video_mean: placed.retention?.videoMeanWatchRatio ?? null,
    retention_lift: placed.retention?.liftVsVideoMean ?? null,
    retention_unavailable_reason: placed.reason,
    link_clicks: clicks,
    conversions,

    is_demo_data: isDemoVideo(video),
    row_built_at: builtAt,
  };
}

/** RFC 4180: quote anything containing a comma, quote or newline; double the quotes. */
export function toCsv(rows: DatasetRow[], columns: DatasetColumn[] = PLACEMENT_DATASET_COLUMNS): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => cell(c.key)).join(",");
  const body = rows.map((r) => columns.map((c) => cell(r[c.key])).join(","));
  return [header, ...body].join("\n") + "\n";
}
