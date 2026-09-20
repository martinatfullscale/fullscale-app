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
