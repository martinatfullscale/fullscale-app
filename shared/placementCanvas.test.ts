// The canvas a placement was dragged on decides where it renders. These pin
// that a recorded size wins over every renderer's own guess, and that a bad or
// missing size falls back rather than being divided by.

import assert from "node:assert/strict";
import test from "node:test";

import { offsetScale, readCanvasDims, sanitizeCanvasDims } from "./placementCanvas";

const FRAME = { width: 1920, height: 1080 };
const CLIP_PIPELINE_GUESS = { canvasWidth: 1920, canvasHeight: 1080 };
const EXPORT_ROUTE_GUESS = { canvasWidth: 640, canvasHeight: 360 };

test("a saved placement lands in the same spot whichever renderer draws it", () => {
  // Dragged 96px right on a 960×540 editor: a tenth of the canvas width.
  const saved = { offsetX: 96, offsetY: 54, scale: 1, rotation: 0, flipH: false, canvasWidth: 960, canvasHeight: 540 };
  const clip = offsetScale(saved, FRAME, CLIP_PIPELINE_GUESS);
  const route = offsetScale(saved, FRAME, EXPORT_ROUTE_GUESS);

  // Before, these were 96px and 288px for the same row.
  assert.equal(saved.offsetX * clip.scaleX, 192);
  assert.equal(saved.offsetX * route.scaleX, 192);
  assert.equal(saved.offsetY * route.scaleY, 108);
  assert.equal(clip.canvasKnown, true);
});

test("a row without a recorded canvas keeps the renderer's old assumption", () => {
  const legacy = { offsetX: 96, offsetY: 0, scale: 1, rotation: 0, flipH: false };
  const s = offsetScale(legacy, FRAME, CLIP_PIPELINE_GUESS);
  assert.equal(legacy.offsetX * s.scaleX, 96);
  assert.equal(s.canvasKnown, false);
});

test("an unusable canvas size is ignored, never divided by", () => {
  for (const bad of [0, -5, NaN, Infinity, "960", null, 100_000]) {
    assert.equal(readCanvasDims({ canvasWidth: bad, canvasHeight: 540 }), null, `canvasWidth ${String(bad)}`);
  }
  assert.equal(readCanvasDims(null), null);
  assert.equal(offsetScale({ canvasWidth: 0, canvasHeight: 0 }, FRAME, EXPORT_ROUTE_GUESS).scaleX, 3);
});

test("storing a transform keeps a valid canvas size and strips an invalid one", () => {
  const base = { offsetX: 1, offsetY: 2, scale: 1, rotation: 0, flipH: false };
  assert.deepEqual(sanitizeCanvasDims({ ...base, canvasWidth: 960, canvasHeight: 540 }), { ...base, canvasWidth: 960, canvasHeight: 540 });
  assert.deepEqual(sanitizeCanvasDims({ ...base, canvasWidth: 960, canvasHeight: 0 }), base);
  assert.deepEqual(sanitizeCanvasDims(base), base);
});
