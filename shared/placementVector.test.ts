// The vector arrives from a browser, so it is validated like any other input.
// The rule that matters: a half-measured region is worse than an unmeasured
// one, because it reads as data and skews anything that averages over it.

import assert from "node:assert/strict";
import test from "node:test";

import { sanitizePlacementVector } from "./placementVector";

const region = {
  surfaceNormal: "horizontal",
  tiltDegrees: 3,
  existingShadowDirection: "top-left",
  existingShadowIntensity: 0.4,
  dominantHueDeg: 210,
  dominantSaturation: 0.3,
  averageLuminance: 0.62,
  neighboringObjects: ["turntable platter", "vinyl records"],
  openSpaceClass: "open",
  recommendedScale: 1.1,
};
const atmosphere = { brightnessFactor: 1.05, sceneRgb: { r: 120, g: 118, b: 110 }, sceneBrightness: 0.46 };

test("a complete measurement is kept intact", () => {
  const v = sanitizePlacementVector({ regionAnalysis: region, atmosphere, mode: "procedural", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 }, frameDimensions: { width: 1920, height: 1080 }, measuredAt: "2026-09-20T10:00:00.000Z" });
  assert.equal(v?.regionAnalysis?.surfaceNormal, "horizontal");
  assert.equal(v?.atmosphere?.sceneRgb.g, 118);
  assert.equal(v?.mode, "procedural");
  assert.equal(v?.measuredAt, "2026-09-20T10:00:00.000Z");
});

test("a region missing one field is dropped whole, not stored half-measured", () => {
  const { tiltDegrees, ...missing } = region;
  const v = sanitizePlacementVector({ regionAnalysis: missing, atmosphere });
  assert.equal(v?.regionAnalysis, null);
  assert.ok(v?.atmosphere, "the atmosphere it did measure survives");
});

test("values outside their range are refused rather than clamped", () => {
  for (const bad of [{ ...region, dominantHueDeg: 400 }, { ...region, averageLuminance: 2 }, { ...region, surfaceNormal: "diagonal" }]) {
    assert.equal(sanitizePlacementVector({ regionAnalysis: bad, atmosphere })?.regionAnalysis, null);
  }
});

test("nothing measured returns null, so the column stays null instead of an empty shell", () => {
  assert.equal(sanitizePlacementVector({ mode: "flat" }), null);
  assert.equal(sanitizePlacementVector(null), null);
  assert.equal(sanitizePlacementVector("not an object"), null);
});

test("a hostile neighbours list is bounded", () => {
  const v = sanitizePlacementVector({
    regionAnalysis: { ...region, neighboringObjects: Array.from({ length: 500 }, () => "x".repeat(500)) },
    atmosphere,
  });
  assert.equal(v?.regionAnalysis?.neighboringObjects.length, 16);
  assert.equal(v?.regionAnalysis?.neighboringObjects[0].length, 64);
});

test("a missing or bogus timestamp is replaced, never trusted", () => {
  const v = sanitizePlacementVector({ regionAnalysis: region, atmosphere, measuredAt: "whenever" });
  assert.ok(!Number.isNaN(Date.parse(v!.measuredAt)));
});
