// A reel overlay stack decides whether the overlay pass runs at all. With
// `baseAudioLevel: null` read as a gain of 0, a stack carrying nothing else
// looked non-empty, ran the pass, and muted the reel.

import assert from "node:assert/strict";
import test from "node:test";

import { reelOverlayStackIsEmpty } from "./reelOverlay";

test("a null gain with nothing else is an empty overlay stack", () => {
  assert.equal(reelOverlayStackIsEmpty({ baseAudioLevel: null } as any), true);
});

test("no gain and unity gain are empty; a real gain is not", () => {
  assert.equal(reelOverlayStackIsEmpty({} as any), true);
  assert.equal(reelOverlayStackIsEmpty({ baseAudioLevel: 1 } as any), true);
  assert.equal(reelOverlayStackIsEmpty({ baseAudioLevel: 0.5 } as any), false);
});
