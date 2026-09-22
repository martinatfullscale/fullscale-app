// What a viewer saw, not what the creator dragged. The rules that matter:
// dwell recorded must equal dwell rendered, "no visibility data" must not
// become "on screen for the whole video", and a moving placement must not
// write one sample per frame.

import assert from "node:assert/strict";
import test from "node:test";

import {
  GeometrySampler, buildDeliveredPlacement, medianRect, visibilityWindows, visibleSeconds,
} from "./deliveredGeometry";

test("keyframes become contiguous windows, split on real gaps", () => {
  // Two runs: 1-3s, then 20-21s after a long absence.
  const w = visibilityWindows([1, 2, 3, 20, 21], { gapThresholdSec: 4, duration: 30 });
  assert.deepEqual(w, [[1, 3], [20, 21]]);
  assert.equal(visibleSeconds(w), 3);
});

test("padding is clamped to the render, and overlapping windows are not counted twice", () => {
  const w = visibilityWindows([0, 1, 2], { gapThresholdSec: 4, duration: 2.5, padSec: 0.75 });
  assert.deepEqual(w, [[0, 2.5]], "pad cannot run past the end or before the start");
  // Two windows that overlap after padding are merged, not summed.
  assert.equal(visibleSeconds([[0, 5], [4, 8]]), 8);
});

test("no keyframes means unknown dwell, never the whole video", () => {
  assert.deepEqual(visibilityWindows([], { gapThresholdSec: 4, duration: 30 }), []);
  const d = buildDeliveredPlacement({
    placementIndex: 0, renderKind: "video_export", frame: { width: 1920, height: 1080 },
    rect: { x: 100, y: 100, w: 200, h: 200 }, visibleWindows: [], windowsKnown: false, dwellBasis: "visibility-windows",
    canvasKnown: true, renderedAt: "2026-09-21T00:00:00.000Z",
  });
  assert.equal(d.visibleSec, null);
  assert.equal(d.sampleKind, "static");
});

test("the rect is recorded in pixels and as a fraction, so resolutions compare", () => {
  const d = buildDeliveredPlacement({
    placementIndex: 1, savedPlacementId: 7, surfaceId: 5, renderKind: "editorial_clip",
    frame: { width: 1080, height: 1920 }, rect: { x: 108, y: 192, w: 270, h: 480 },
    visibleWindows: [[2, 11]], windowsKnown: true, dwellBasis: "visibility-windows", canvasKnown: true,
    renderedAt: "2026-09-21T00:00:00.000Z",
  });
  assert.deepEqual(d.rectFrac, { x: 0.1, y: 0.1, w: 0.25, h: 0.25 });
  assert.equal(d.areaShare, 0.0625);
  assert.equal(d.visibleSec, 9);
  assert.equal(d.savedPlacementId, 7);
});

test("a dwell number says how it was derived, so two renderers are not averaged blindly", () => {
  const exact = buildDeliveredPlacement({
    placementIndex: 0, renderKind: "video_export", frame: { width: 1920, height: 1080 },
    rect: { x: 0, y: 0, w: 10, h: 10 }, visibleWindows: [[0, 4]], windowsKnown: true,
    dwellBasis: "visibility-windows", canvasKnown: true, renderedAt: "2026-09-21T00:00:00.000Z",
  });
  assert.equal(exact.dwellBasis, "visibility-windows");
  assert.equal(exact.visibleSec, 4);

  // A clip overlay runs the whole cut, which is an upper bound: b-roll can
  // cover it. The number is kept, and labelled for what it is.
  const clip = buildDeliveredPlacement({
    placementIndex: 0, renderKind: "editorial_clip", frame: { width: 1080, height: 1920 },
    rect: { x: 0, y: 0, w: 10, h: 10 }, visibleWindows: [[0, 30]], windowsKnown: true,
    dwellBasis: "full-render", canvasKnown: true, renderedAt: "2026-09-21T00:00:00.000Z",
  });
  assert.equal(clip.dwellBasis, "full-render");
  assert.equal(clip.visibleSec, 30);

  // With no visibility data at all, the basis is unknown whatever was claimed.
  const blind = buildDeliveredPlacement({
    placementIndex: 0, renderKind: "video_export", frame: { width: 1920, height: 1080 },
    rect: { x: 0, y: 0, w: 10, h: 10 }, visibleWindows: [], windowsKnown: false,
    dwellBasis: "visibility-windows", canvasKnown: true, renderedAt: "2026-09-21T00:00:00.000Z",
  });
  assert.equal(blind.dwellBasis, "unknown");
  assert.equal(blind.visibleSec, null);
});

test("a moving placement is sampled, not logged frame by frame", () => {
  const sampler = new GeometrySampler({ maxSamples: 5, minIntervalSec: 1 });
  // 24fps for 10 seconds = 240 calls for one placement.
  for (let i = 0; i < 240; i++) {
    sampler.add(0, i / 24, { x: i, y: 0, w: 10, h: 10 });
  }
  const samples = sampler.samplesFor(0);
  assert.equal(samples.length, 5, "capped");
  assert.ok(samples[1].t - samples[0].t >= 1, "at most one per interval");
  assert.deepEqual(sampler.indices(), [0]);
});

test("the representative rect of a moving placement is the median, not one bad frame", () => {
  const samples = [
    { t: 0, rect: { x: 100, y: 100, w: 50, h: 50 } },
    { t: 1, rect: { x: 104, y: 100, w: 50, h: 50 } },
    { t: 2, rect: { x: 9999, y: 100, w: 50, h: 50 } }, // one tracking glitch
  ];
  assert.deepEqual(medianRect(samples), { x: 104, y: 100, w: 50, h: 50 });
  assert.equal(medianRect([]), null);
  const d = buildDeliveredPlacement({
    placementIndex: 0, renderKind: "video_export", frame: { width: 1920, height: 1080 },
    rect: medianRect(samples)!, samples, visibleWindows: [[0, 2]], windowsKnown: true, dwellBasis: "sampled",
    canvasKnown: false, renderedAt: "2026-09-21T00:00:00.000Z",
  });
  assert.equal(d.sampleKind, "frame-sampled");
  assert.equal(d.sampleCount, 3);
  assert.equal(d.canvasKnown, false);
});
