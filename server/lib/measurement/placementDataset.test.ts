// This file is the artifact a partner regresses, so the rules that protect it
// are worth pinning: a column cannot ship without a definition, "not measured"
// never becomes 0, geometry we cannot trust is reported as unknown rather than
// guessed, and seeded demo rows are labelled so they can never be read as
// results.

import assert from "node:assert/strict";
import test from "node:test";

import {
  PLACEMENT_DATASET_COLUMNS,
  buildDatasetRow,
  isDemoVideo,
  toCsv,
  type DatasetInput,
} from "./placementDataset";

const base = (over: Partial<DatasetInput> = {}): DatasetInput => ({
  placement: {
    id: 7, videoId: 91, surfaceId: 5,
    transform: { offsetX: 96, offsetY: 0, scale: 1.5, rotation: 0, flipH: false, canvasWidth: 960, canvasHeight: 540 },
    placementVector: null,
  },
  video: { id: 91, title: "The Quiet Truth", platform: "youtube", userId: "u1", youtubeId: "abc123" },
  surface: {
    surfaceGroupId: "rm12-s3", sceneId: 2, surfaceType: "Table", orientation: "horizontal",
    confidence: "0.82", timestamp: "134.5",
    boundingBoxX: "0.4", boundingBoxY: "0.5", boundingBoxWidth: "0.2", boundingBoxHeight: "0.1",
    personContext: null,
  },
  fixture: { isModelBacked: true, sceneScreenTimeSec: "72.5", occurrences: 9, rowCount: 14, videoDurationSec: "1800" },
  exposure: null,
  curve: undefined,
  sourcePlatformPostId: null,
  clicks: 0,
  conversions: 0,
  delivered: null,
  builtAt: "2026-09-20T12:00:00.000Z",
  ...over,
});

test("every column carries a definition, and the row matches the registry exactly", () => {
  for (const c of PLACEMENT_DATASET_COLUMNS) {
    assert.ok(c.key && c.description && c.description.length > 10, `column ${c.key} needs a real description`);
    assert.ok(typeof c.unit === "string", `column ${c.key} needs a unit`);
  }
  const keys = PLACEMENT_DATASET_COLUMNS.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate column keys");
  // Drift in either direction is a bug: a column with no value, or a value
  // with no definition.
  assert.deepEqual(Object.keys(buildDatasetRow(base())).sort(), [...keys].sort());
});

test("the placement's position is computed from the canvas it was dragged on", () => {
  const row = buildDatasetRow(base());
  // Surface centre 0.5, plus 96px of a 960px canvas = 0.1 of the frame.
  assert.equal(row.product_center_x, 0.6);
  assert.equal(row.product_center_y, 0.55);
  assert.equal(row.dist_from_right, 0.4);
  assert.equal(row.dist_from_bottom, 0.45);
  assert.equal(row.geometry_trusted, true);
  // 0.02 of frame area, scaled by 1.5 squared.
  assert.equal(row.product_area_share_est, 0.045);
});

test("a placement with no recorded canvas reports position unknown, not a guess", () => {
  const input = base();
  input.placement.transform = { offsetX: 96, offsetY: 0, scale: 1, rotation: 0, flipH: false };
  const row = buildDatasetRow(input);
  assert.equal(row.geometry_trusted, false);
  assert.equal(row.product_center_x, null);
  assert.equal(row.dist_from_right, null);
  assert.equal(row.dist_from_left_px, null);
  // The surface itself is still known — only the offset lacks a scale.
  assert.equal(row.surface_x, 0.4);
});

test("not measured is null, never zero", () => {
  const row = buildDatasetRow(base());
  assert.equal(row.has_scene_measurement, false);
  assert.equal(row.region_tilt_deg, null);
  assert.equal(row.region_luminance, null);
  assert.equal(row.has_person_context, false);
  assert.equal(row.person_count, null);
  assert.equal(row.person_overlap_fraction, null);
  assert.equal(row.went_live, false);
});

test("measurements are carried through when they exist", () => {
  const input = base();
  input.placement.placementVector = {
    regionAnalysis: {
      surfaceNormal: "horizontal", tiltDegrees: 4.2, existingShadowDirection: "top-left",
      existingShadowIntensity: 0.4, dominantHueDeg: 210.4, dominantSaturation: 0.3,
      averageLuminance: 0.62, neighboringObjects: ["turntable", "records"],
      openSpaceClass: "open", recommendedScale: 1.1,
    },
    atmosphere: { brightnessFactor: 1.05, sceneRgb: { r: 120, g: 118, b: 110 }, sceneBrightness: 0.46 },
    mode: "procedural",
    bbox: { x: 0.4, y: 0.5, width: 0.2, height: 0.1 },
    frameDimensions: { width: 1920, height: 1080 },
    measuredAt: "2026-09-20T11:00:00.000Z",
  };
  input.surface.personContext = {
    frame: { width: 1920, height: 1080 }, source: "detector", people: [{ x: 0.7, y: 0.3, w: 0.2, h: 0.6 }],
    measured: { personCount: 1, overlapFraction: 0, nearestGap: 0.12, nearestSide: "right" },
    measuredAgainst: "detection-frame-bbox",
  };
  const row = buildDatasetRow(input);
  assert.equal(row.has_scene_measurement, true);
  assert.equal(row.region_open_space, "open");
  assert.equal(row.region_neighbors, "turntable; records");
  assert.equal(row.region_hue_deg, 210.4);
  assert.equal(row.has_person_context, true);
  assert.equal(row.person_nearest_side, "right");
  assert.equal(row.person_nearest_gap, 0.12);
  // Pixels only exist because a harmonize run recorded the frame size.
  assert.equal(row.dist_from_left_px, Math.round(0.6 * 1920));
});

test("delivered geometry is recorded next to intent, with the drift between them", () => {
  const withoutRender = buildDatasetRow(base());
  assert.equal(withoutRender.delivered_source, null);
  assert.equal(withoutRender.delivered_visible_sec, null);
  assert.equal(withoutRender.intent_to_delivered_drift, null, "no render means no drift, not zero drift");

  const row = buildDatasetRow(base({
    delivered: {
      placementIndex: 0, savedPlacementId: 7, surfaceId: 5, renderKind: "video_export",
      frame: { width: 1920, height: 1080 },
      rect: { x: 1056, y: 540, w: 192, h: 108 },
      rectFrac: { x: 0.55, y: 0.5, w: 0.1, h: 0.1 },
      areaShare: 0.01, sampleKind: "static", sampleCount: 0,
      visibleWindows: [[3, 12]], visibleSec: 9, dwellBasis: "visibility-windows",
      clippedAtEdge: false, canvasKnown: true, renderedAt: "2026-09-21T09:00:00.000Z",
    },
  }));
  assert.equal(row.delivered_source, "video_export");
  assert.equal(row.delivered_area_share, 0.01);
  assert.equal(row.delivered_visible_sec, 9);
  assert.equal(row.delivered_dwell_basis, "visibility-windows");
  // Intent centre is 0.6, 0.55; delivered centre is 0.6, 0.55 — they agree here.
  assert.equal(row.delivered_center_x, 0.6);
  assert.equal(row.intent_to_delivered_drift, 0);
});

test("a placement that landed somewhere else shows the drift", () => {
  const row = buildDatasetRow(base({
    delivered: {
      placementIndex: 0, savedPlacementId: 7, surfaceId: 5, renderKind: "editorial_clip",
      frame: { width: 1080, height: 1920 },
      rect: { x: 0, y: 0, w: 108, h: 192 },
      rectFrac: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 },
      areaShare: 0.01, sampleKind: "static", sampleCount: 0,
      visibleWindows: [[0, 30]], visibleSec: 30, dwellBasis: "full-render",
      clippedAtEdge: true, canvasKnown: true, renderedAt: "2026-09-21T09:00:00.000Z",
    },
  }));
  // Intent 0.6/0.55 vs delivered 0.25/0.25 — a vertical crop moved it.
  assert.ok((row.intent_to_delivered_drift as number) > 0.2, String(row.intent_to_delivered_drift));
  assert.equal(row.delivered_clipped_at_edge, true);
  assert.equal(row.delivered_dwell_basis, "full-render");
});

test("retention is scored only against the post's own curve, and says why when it cannot be", () => {
  const curve = {
    platformPostId: "yt-source", videoDurationSec: "600",
    curve: [{ ratio: 0, watchRatio: 1 }, { ratio: 0.25, watchRatio: 0.8 }, { ratio: 0.5, watchRatio: 0.5 }],
    capturedAt: "2026-09-01",
  };
  const live = buildDatasetRow(base({
    exposure: { platformPostId: "yt-source", sourceStartSec: "300", platform: "youtube", liveAt: "2026-09-02T00:00:00.000Z", linkSource: "creator_confirmed" },
    curve, sourcePlatformPostId: "yt-source",
  }));
  assert.equal(live.went_live, true);
  assert.equal(live.retention_watch_ratio, 0.5);
  assert.equal(live.retention_unavailable_reason, null);

  const clipPost = buildDatasetRow(base({
    exposure: { platformPostId: "yt-short", sourceStartSec: "300", platform: "youtube", liveAt: "2026-09-02T00:00:00.000Z" },
    curve, sourcePlatformPostId: "yt-source",
  }));
  assert.equal(clipPost.retention_watch_ratio, null);
  assert.match(String(clipPost.retention_unavailable_reason), /isn't the source upload/);
});

test("seeded and demo rows are labelled", () => {
  assert.equal(isDemoVideo({ youtubeId: "demo-video-3", id: 55 }), true);
  assert.equal(isDemoVideo({ youtubeId: "abc123", id: 1042 }), true);
  assert.equal(isDemoVideo({ youtubeId: "abc123", id: 91 }), false);
  assert.equal(buildDatasetRow(base({ video: { id: 1001, youtubeId: "demo-1", title: "Desk Setup" } })).is_demo_data, true);
});

test("CSV escapes anything that would break a parser", () => {
  const rows = [buildDatasetRow(base({
    video: { id: 91, title: 'The "Quiet", Truth\nPart 2', platform: "youtube", userId: "u1", youtubeId: "abc" },
  }))];
  const csv = toCsv(rows);
  const header = csv.split("\n")[0];
  assert.equal(header, PLACEMENT_DATASET_COLUMNS.map((c) => c.key).join(","));
  assert.ok(csv.includes('"The ""Quiet"", Truth\nPart 2"'), "quotes, commas and newlines must survive a round trip");
  // A null must be an empty cell, never the string "null".
  assert.ok(!csv.includes(",null,"), csv.slice(0, 200));
});

// ── scan-measured surfaces ──────────────────────────────────────────────
// The scan now measures every surface it finds, so the region columns are no
// longer a harmonize-only artefact. Two readings of one spot exist, they mean
// different things, and the dataset has to say which one a row carries.

const reading = (over: Record<string, unknown> = {}) => ({
  surfaceNormal: "horizontal",
  tiltDegrees: 6,
  existingShadowDirection: "top-left",
  existingShadowIntensity: 0.3,
  dominantHueDeg: 30,
  dominantSaturation: 0.2,
  averageLuminance: 0.5,
  neighboringObjects: ["mic arm"],
  openSpaceClass: "open",
  source: "scan",
  ...over,
});

test("a placement that was never harmonized still carries the scan's reading", () => {
  const row = buildDatasetRow(base({
    surface: { ...base().surface, surfaceMeasurement: reading() },
  }));
  assert.equal(row.region_surface_normal, "horizontal");
  assert.equal(row.region_tilt_deg, 6);
  assert.equal(row.region_measured_on, "surface");
  assert.equal(row.has_scene_measurement, true);
});

test("the scan's reading never invents a product-specific scale", () => {
  const row = buildDatasetRow(base({
    surface: { ...base().surface, surfaceMeasurement: reading() },
  }));
  // recommendedScale is a multiplier on one product's chosen size. The scan
  // has no product, so it must stay null rather than borrow a default.
  assert.equal(row.region_recommended_scale, null);
});

test("a harmonize reading wins over the scan's, and says so", () => {
  const row = buildDatasetRow(base({
    placement: {
      ...base().placement,
      placementVector: {
        regionAnalysis: { ...reading({ tiltDegrees: 21 }), recommendedScale: 1.2 },
        atmosphere: null, mode: "procedural", bbox: null, frameDimensions: null,
        measuredAt: "2026-09-20T00:00:00.000Z",
      },
    },
    surface: { ...base().surface, surfaceMeasurement: reading({ tiltDegrees: 6 }) },
  }));
  assert.equal(row.region_tilt_deg, 21, "the placement-box reading is the tighter one");
  assert.equal(row.region_measured_on, "placement");
  assert.equal(row.region_recommended_scale, 1.2);
  // Sample count and hue agreement describe a fold of scanned frames, so they
  // must not be attached to a single harmonize reading.
  assert.equal(row.region_hue_agreement, null);
});

test("an unmeasured surface reports no reading rather than zeros", () => {
  const row = buildDatasetRow(base());
  assert.equal(row.region_measured_on, null);
  assert.equal(row.region_tilt_deg, null);
  assert.equal(row.region_luminance, null);
  assert.equal(row.region_sample_count, null);
  assert.equal(row.has_scene_measurement, false);
});

test("the fixture's frames fold into one reading, and the count is reported", () => {
  const row = buildDatasetRow(base({
    surface: { ...base().surface, surfaceMeasurement: reading({ averageLuminance: 0.9 }) },
    surfaceMeasurements: [
      reading({ averageLuminance: 0.4 }),
      reading({ averageLuminance: 0.5 }),
      reading({ averageLuminance: 0.6 }),
    ],
  }));
  assert.equal(row.region_luminance, 0.5, "the group's median, not the anchor row's value");
  assert.equal(row.region_sample_count, 3);
});

test("a surface reading carries its hue agreement so a disputed hue is visible", () => {
  const row = buildDatasetRow(base({
    surface: { ...base().surface, surfaceMeasurement: reading() },
    surfaceMeasurements: [reading({ dominantHueDeg: 0 }), reading({ dominantHueDeg: 180 })],
  }));
  assert.ok(
    (row.region_hue_agreement as number) < 0.05,
    `frames that disagree must report it (got ${row.region_hue_agreement})`,
  );
});

test("a partial reading on the surface is treated as no reading", () => {
  const broken = reading();
  delete (broken as Record<string, unknown>).dominantHueDeg;
  const row = buildDatasetRow(base({
    surface: { ...base().surface, surfaceMeasurement: broken },
  }));
  assert.equal(row.region_measured_on, null);
  assert.equal(row.region_surface_normal, null, "a half-read spot must not half-populate the row");
});

// ── depth ───────────────────────────────────────────────────────────────
// Depth comes from two instruments that know different things: the scan
// estimates the ordering and can see people, a depth map samples a number and
// cannot. The columns have to keep that straight.

const scanDepth = (over: Record<string, unknown> = {}) => ({
  band: "background",
  rankInFrame: 3,
  relativeToPerson: "behind-person",
  relativeDepth: null,
  source: "vision",
  ...over,
});

test("depth reaches the dataset from the scan alone", () => {
  const row = buildDatasetRow(base({
    surface: { ...base().surface, surfaceMeasurement: reading({ depth: scanDepth() }) },
  }));
  assert.equal(row.depth_band, "background");
  assert.equal(row.depth_vs_person, "behind-person");
  assert.equal(row.depth_source, "vision");
  assert.equal(row.depth_relative, null, "the scan samples no map, and absent is not the far plane");
});

test("a sampled depth map outranks the scan's estimate", () => {
  const row = buildDatasetRow(base({
    placement: {
      ...base().placement,
      placementVector: {
        regionAnalysis: null, atmosphere: null,
        depth: { band: "foreground", rankInFrame: 1, relativeToPerson: "no-person", relativeDepth: 0.82, source: "depth-model" },
        mode: "ai-3d", bbox: null, frameDimensions: null, measuredAt: "2026-09-21T00:00:00.000Z",
      },
    },
    surface: { ...base().surface, surfaceMeasurement: reading({ depth: scanDepth() }) },
    // Three scanned frames, so a count of 3 would prove the scan's fold was
    // reported beside a number it did not produce.
    surfaceMeasurements: [
      reading({ depth: scanDepth() }),
      reading({ depth: scanDepth() }),
      reading({ depth: scanDepth() }),
    ],
  }));
  assert.equal(row.depth_band, "foreground");
  assert.equal(row.depth_relative, 0.82);
  assert.equal(row.depth_source, "depth-model");
  assert.equal(row.depth_sample_count, 1, "one placement measurement, not the scan's frame count");
});

test("the person relation always comes from the scan, which is what can see people", () => {
  const row = buildDatasetRow(base({
    placement: {
      ...base().placement,
      placementVector: {
        regionAnalysis: null, atmosphere: null,
        depth: { band: "foreground", rankInFrame: 1, relativeToPerson: "no-person", relativeDepth: 0.82, source: "depth-model" },
        mode: "ai-3d", bbox: null, frameDimensions: null, measuredAt: "2026-09-21T00:00:00.000Z",
      },
    },
    surface: { ...base().surface, surfaceMeasurement: reading({ depth: scanDepth() }) },
  }));
  // The depth map said "no-person" only because it cannot see them. Letting
  // that overwrite the scan's reading would erase a real fact.
  assert.equal(row.depth_vs_person, "behind-person");
});

test("an unmeasured depth is null everywhere, never the far plane", () => {
  const row = buildDatasetRow(base({
    surface: { ...base().surface, surfaceMeasurement: reading() },
  }));
  assert.equal(row.depth_band, null);
  assert.equal(row.depth_relative, null);
  assert.equal(row.depth_rank_in_frame, null);
  assert.equal(row.depth_source, null);
  assert.equal(row.depth_sample_count, null);
});

test("the folded depth reports how many frames carried one", () => {
  const row = buildDatasetRow(base({
    surface: { ...base().surface, surfaceMeasurement: reading({ depth: scanDepth() }) },
    surfaceMeasurements: [
      reading({ depth: scanDepth() }),
      reading({ depth: scanDepth() }),
      reading({ depth: null }),
    ],
  }));
  assert.equal(row.depth_sample_count, 2, "the silent frame is not a vote");
  assert.equal(row.region_sample_count, 3, "but it is still a reading of the spot");
});
