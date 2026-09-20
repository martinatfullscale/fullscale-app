// Proximity is a measurement, so the arithmetic has to be right rather than
// merely plausible: two people standing together must not be counted twice,
// "nobody in frame" must not read as "a person right there", and a gap must
// mean the same thing on a 16:9 episode as on a 9:16 cut.

import assert from "node:assert/strict";
import test from "node:test";

import { personProximity, unionAreaWithin, type PersonBox, type SurfaceBox } from "./proximity";

const SURFACE: SurfaceBox = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }; // area 0.04
const WIDE = 16 / 9;

test("two overlapping people are counted once, not twice", () => {
  // Each covers the surface's left half; together they still cover half.
  const a: PersonBox = { x: 0.3, y: 0.3, w: 0.2, h: 0.4 };
  const b: PersonBox = { x: 0.35, y: 0.3, w: 0.15, h: 0.4 };
  assert.equal(Math.round(unionAreaWithin(SURFACE, [a, b]) * 10000) / 10000, 0.02);
  // Summing intersections would have given 0.035/0.04 = 0.875.
  assert.equal(personProximity(SURFACE, [a, b], WIDE).overlapFraction, 0.5);
});

test("people in different parts of the surface each cover only their own part", () => {
  // A fills the left half top to bottom; B covers only the top of the right
  // half. Union = 0.02 + 0.01 of a 0.04 surface = three quarters.
  const a: PersonBox = { x: 0.4, y: 0.4, w: 0.1, h: 0.2 };
  const b: PersonBox = { x: 0.5, y: 0.4, w: 0.1, h: 0.1 };
  assert.equal(Math.round(unionAreaWithin(SURFACE, [a, b]) * 10000) / 10000, 0.03);
  assert.equal(personProximity(SURFACE, [a, b], WIDE).overlapFraction, 0.75);
});

test("a person covering the whole surface reads as full coverage", () => {
  const p: PersonBox = { x: 0, y: 0, w: 1, h: 1 };
  const r = personProximity(SURFACE, [p], WIDE);
  assert.equal(r.overlapFraction, 1);
  assert.equal(r.nearestGap, 0);
  assert.equal(r.nearestSide, "overlapping");
});

test("nobody in frame is null, not zero distance", () => {
  const r = personProximity(SURFACE, [], WIDE);
  assert.deepEqual(r, { personCount: 0, overlapFraction: 0, nearestGap: null, nearestSide: null });
});

test("the nearest person's side is reported from the surface's point of view", () => {
  const left: PersonBox = { x: 0.1, y: 0.4, w: 0.1, h: 0.2 };
  const below: PersonBox = { x: 0.42, y: 0.75, w: 0.1, h: 0.2 };
  assert.equal(personProximity(SURFACE, [left], WIDE).nearestSide, "left");
  assert.equal(personProximity(SURFACE, [below], WIDE).nearestSide, "below");
  assert.equal(personProximity(SURFACE, [{ x: 0.9, y: 0.4, w: 0.05, h: 0.2 }], WIDE).nearestSide, "right");
  assert.equal(personProximity(SURFACE, [{ x: 0.42, y: 0.05, w: 0.1, h: 0.2 }], WIDE).nearestSide, "above");
});

test("the gap is aspect-corrected, so the same pixels mean the same number", () => {
  // 0.2 of the width to the left of the surface.
  const p: PersonBox = { x: 0.1, y: 0.4, w: 0.1, h: 0.2 };
  const wide = personProximity(SURFACE, [p], 16 / 9).nearestGap!;
  const square = personProximity(SURFACE, [p], 1).nearestGap!;
  // On a wider frame the same horizontal fraction is a longer distance, but
  // normalising by that frame's own diagonal keeps the reading comparable.
  assert.ok(wide > 0 && square > 0);
  assert.ok(Math.abs(wide - square) < 0.05, `wide ${wide} vs square ${square}`);
  // And it is a real distance, not a fraction of width: 0.2 of a 16:9 frame's
  // width is ~0.194 of its diagonal.
  assert.ok(wide > 0.15 && wide < 0.25, String(wide));
});

test("the nearest person wins when several are in frame", () => {
  const far: PersonBox = { x: 0.02, y: 0.02, w: 0.05, h: 0.05 };
  const near: PersonBox = { x: 0.62, y: 0.4, w: 0.1, h: 0.2 };
  const r = personProximity(SURFACE, [far, near], WIDE);
  assert.equal(r.personCount, 2);
  assert.equal(r.nearestSide, "right");
  assert.ok(r.nearestGap! < 0.05, String(r.nearestGap));
});

test("degenerate boxes are ignored rather than poisoning the numbers", () => {
  const bad = [
    { x: 0.1, y: 0.1, w: 0, h: 0.2 },
    { x: 0.1, y: 0.1, w: NaN, h: 0.2 },
    { x: 0.1, y: 0.1, w: -0.2, h: 0.2 },
  ] as PersonBox[];
  const r = personProximity(SURFACE, bad, WIDE);
  assert.deepEqual(r, { personCount: 0, overlapFraction: 0, nearestGap: null, nearestSide: null });
  // A zero-area surface cannot have a coverage fraction.
  assert.equal(personProximity({ x: 0.5, y: 0.5, width: 0, height: 0 }, [{ x: 0, y: 0, w: 1, h: 1 }], WIDE).overlapFraction, 0);
});
