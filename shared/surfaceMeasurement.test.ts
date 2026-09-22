// A surface is seen in many frames and each frame gets its own reading. The
// rules that matter here: a half-measured surface is dropped rather than
// stored, and rolling several readings into one must not invent a value none
// of the frames saw — which is exactly what arithmetic does to hue.

import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeSurfaceMeasurement,
  foldSurfaceMeasurements,
  median,
  circularMeanDeg,
  type SurfaceMeasurement,
} from "./surfaceMeasurement";

const raw = {
  surfaceNormal: "horizontal",
  tiltDegrees: 4,
  existingShadowDirection: "top-left",
  existingShadowIntensity: 0.4,
  dominantHueDeg: 210,
  dominantSaturation: 0.3,
  averageLuminance: 0.62,
  neighboringObjects: ["mic arm", "water bottle"],
  openSpaceClass: "open",
};

const sample = (over: Partial<SurfaceMeasurement> = {}): SurfaceMeasurement => ({
  ...(sanitizeSurfaceMeasurement(raw) as SurfaceMeasurement),
  ...over,
});

test("a complete reading survives, stamped with its source", () => {
  const m = sanitizeSurfaceMeasurement(raw);
  assert.ok(m);
  assert.equal(m.surfaceNormal, "horizontal");
  assert.equal(m.dominantHueDeg, 210);
  assert.equal(m.source, "scan");
  assert.deepEqual(m.neighboringObjects, ["mic arm", "water bottle"]);
});

test("the source can be declared, and a claimed source is honoured", () => {
  assert.equal(sanitizeSurfaceMeasurement(raw, "harmonize")?.source, "harmonize");
  assert.equal(sanitizeSurfaceMeasurement({ ...raw, source: "external" })?.source, "external");
  // An unrecognised source falls back rather than being stored as-is.
  assert.equal(sanitizeSurfaceMeasurement({ ...raw, source: "chu-engine" })?.source, "scan");
});

test("a reading missing any measured field is dropped whole", () => {
  for (const key of [
    "surfaceNormal", "tiltDegrees", "existingShadowDirection", "existingShadowIntensity",
    "dominantHueDeg", "dominantSaturation", "averageLuminance", "openSpaceClass",
  ]) {
    const partial: Record<string, unknown> = { ...raw };
    delete partial[key];
    assert.equal(sanitizeSurfaceMeasurement(partial), null, `${key} missing should drop the row`);
  }
});

test("an empty neighbour list is an answer, not a missing field", () => {
  const m = sanitizeSurfaceMeasurement({ ...raw, neighboringObjects: [] });
  assert.ok(m, "no neighbours nearby is a real reading");
  assert.deepEqual(m.neighboringObjects, []);
});

test("out-of-range numbers are rejected rather than clamped", () => {
  assert.equal(sanitizeSurfaceMeasurement({ ...raw, dominantSaturation: 1.4 }), null);
  assert.equal(sanitizeSurfaceMeasurement({ ...raw, dominantHueDeg: 400 }), null);
  assert.equal(sanitizeSurfaceMeasurement({ ...raw, tiltDegrees: -120 }), null);
});

test("nothing measured folds to null, not to a zeroed shell", () => {
  assert.equal(foldSurfaceMeasurements([]), null);
  assert.equal(foldSurfaceMeasurements(undefined as never), null);
});

test("hue folds around the wrap point instead of through the opposite colour", () => {
  // 350 and 10 are both red. Their arithmetic mean is 180 — cyan — which no
  // frame saw. The circular mean is 0.
  const folded = foldSurfaceMeasurements([
    sample({ dominantHueDeg: 350 }),
    sample({ dominantHueDeg: 10 }),
  ]);
  assert.ok(folded);
  const distanceFromRed = Math.min(folded.dominantHueDeg, 360 - folded.dominantHueDeg);
  assert.ok(distanceFromRed < 1, `expected ~0/360, got ${folded.dominantHueDeg}`);
  assert.ok(folded.hueAgreement > 0.9, "two reds should agree strongly");
});

test("frames that disagree about hue report low agreement", () => {
  const folded = foldSurfaceMeasurements([
    sample({ dominantHueDeg: 0 }),
    sample({ dominantHueDeg: 180 }),
  ]);
  assert.ok(folded);
  assert.ok(
    folded.hueAgreement < 0.05,
    `opposite hues must not read as agreement (got ${folded.hueAgreement})`,
  );
});

test("magnitudes take the median, so one bad frame cannot drag the answer", () => {
  const folded = foldSurfaceMeasurements([
    sample({ averageLuminance: 0.5 }),
    sample({ averageLuminance: 0.5 }),
    sample({ averageLuminance: 0.52 }),
    sample({ averageLuminance: 0.48 }),
    sample({ averageLuminance: 1 }), // a blown-out frame
  ]);
  assert.ok(folded);
  assert.equal(folded.averageLuminance, 0.5);
  // The mean would be 0.6 — visibly pulled by the outlier.
  assert.notEqual(folded.averageLuminance, 0.6);
});

test("an even number of readings takes the midpoint of the two middles", () => {
  const folded = foldSurfaceMeasurements([
    sample({ tiltDegrees: 0 }),
    sample({ tiltDegrees: 10 }),
  ]);
  assert.equal(folded?.tiltDegrees, 5);
});

test("classes take a majority, not the first or last reading", () => {
  const folded = foldSurfaceMeasurements([
    sample({ openSpaceClass: "cramped" }),
    sample({ openSpaceClass: "open" }),
    sample({ openSpaceClass: "open" }),
    sample({ openSpaceClass: "isolated" }),
  ]);
  assert.equal(folded?.openSpaceClass, "open");
});

test("a tied class resolves to the earlier frame's reading", () => {
  const folded = foldSurfaceMeasurements([
    sample({ existingShadowDirection: "right" }),
    sample({ existingShadowDirection: "left" }),
  ]);
  assert.equal(folded?.existingShadowDirection, "right");
});

test("neighbours rank by how many frames saw them", () => {
  const folded = foldSurfaceMeasurements([
    sample({ neighboringObjects: ["lamp"] }),
    sample({ neighboringObjects: ["lamp", "mug"] }),
    sample({ neighboringObjects: ["lamp"] }),
  ]);
  assert.deepEqual(folded?.neighboringObjects, ["lamp", "mug"]);
});

test("a repeated neighbour within one frame counts once for that frame", () => {
  const folded = foldSurfaceMeasurements([
    sample({ neighboringObjects: ["mug", "mug", "mug"] }),
    sample({ neighboringObjects: ["lamp"] }),
    sample({ neighboringObjects: ["lamp"] }),
  ]);
  // Without per-frame de-duplication the mug would win 3 to 2.
  assert.deepEqual(folded?.neighboringObjects, ["lamp", "mug"]);
});

test("the fold reports how many frames it was built from", () => {
  const folded = foldSurfaceMeasurements([sample(), sample(), sample()]);
  assert.equal(folded?.sampleCount, 3);
});

test("median leaves the caller's array in the order it was given", () => {
  const values = [9, 1, 5];
  assert.equal(median(values), 5);
  assert.deepEqual(values, [9, 1, 5], "sorting must happen on a copy");
});

test("median of an even count is the midpoint of the two middles", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("circular mean of a single angle is that angle, in full agreement", () => {
  const { mean, agreement } = circularMeanDeg([137]);
  assert.equal(mean, 137);
  assert.equal(agreement, 1);
});

test("circular mean of three evenly spread hues carries no information", () => {
  // 0, 120, 240 cancel exactly. The angle that comes back is arbitrary; the
  // agreement is what tells a consumer not to trust it.
  const { agreement } = circularMeanDeg([0, 120, 240]);
  assert.ok(agreement < 0.01, `expected no agreement, got ${agreement}`);
});
