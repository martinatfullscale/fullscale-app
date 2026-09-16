// A placement's position is in source-video seconds; the audience watched a
// post. These pin the mapping between the two, and that the retention readout
// refuses to score a post against a curve that belongs to a different video.

import assert from "node:assert/strict";
import test from "node:test";

import { resolvePostTimeline, retentionAtPlacement } from "./postTimeline";

const SOURCE = "yt-source";
const SHORT = "yt-short";
const single = { id: 7, clipStart: 120, duration: 30 };
// hook@480-490, body@210-240, payoff@500-505 — played in that order.
const assembled = {
  id: 9, clipStart: 210, duration: 45,
  segments: [{ start: 480, end: 490 }, { start: 210, end: 240 }, { start: 500, end: 505 }],
};

test("posting the source upload itself needs no offset, even for a clip-scoped placement", () => {
  const t = resolvePostTimeline({ platformPostId: SOURCE, sourcePlatformPostId: SOURCE, clip: single, sourceSec: 130 });
  assert.deepEqual(t, { kind: "source", editorialClipId: null, offsetSec: 0 });
});

test("a single-range clip offsets by its start", () => {
  const t = resolvePostTimeline({ platformPostId: SHORT, sourcePlatformPostId: SOURCE, clip: single, sourceSec: 130 });
  assert.deepEqual(t, { kind: "clip", editorialClipId: 7, offsetSec: 120 });
});

test("an assembled clip maps through its beats in playback order", () => {
  const body = resolvePostTimeline({ platformPostId: SHORT, sourcePlatformPostId: SOURCE, clip: assembled, sourceSec: 215 });
  assert.equal(body.kind, "clip");
  // 5s into the body, which starts after the 10s hook.
  assert.equal(215 - (body.offsetSec as number), 15);

  const payoff = resolvePostTimeline({ platformPostId: SHORT, sourcePlatformPostId: SOURCE, clip: assembled, sourceSec: 502 });
  // 2s into the payoff, after 10s of hook and 30s of body.
  assert.equal(502 - (payoff.offsetSec as number), 42);
});

test("a moment the clip doesn't contain is reported, not guessed", () => {
  const outside = resolvePostTimeline({ platformPostId: SHORT, sourcePlatformPostId: SOURCE, clip: single, sourceSec: 400 });
  assert.equal(outside.kind, "clip-unmapped");
  assert.equal(outside.offsetSec, null);

  const betweenBeats = resolvePostTimeline({ platformPostId: SHORT, sourcePlatformPostId: SOURCE, clip: assembled, sourceSec: 300 });
  assert.equal(betweenBeats.kind, "clip-unmapped");

  const noMoment = resolvePostTimeline({ platformPostId: SHORT, sourcePlatformPostId: SOURCE, clip: single, sourceSec: null });
  assert.equal(noMoment.kind, "clip-unmapped");
});

test("a post that isn't the source and has no clip stays unknown instead of defaulting to zero", () => {
  const t = resolvePostTimeline({ platformPostId: "yt-reupload", sourcePlatformPostId: SOURCE, clip: null, sourceSec: 130 });
  assert.equal(t.kind, "unknown");
  assert.equal(t.offsetSec, null);
});

const curve = {
  platformPostId: SOURCE,
  videoDurationSec: "600",
  curve: [
    { ratio: 0, watchRatio: 1 },
    { ratio: 0.25, watchRatio: 0.8 },
    { ratio: 0.5, watchRatio: 0.5 },
    { ratio: 0.75, watchRatio: 0.3 },
  ],
  capturedAt: "2026-09-01",
};

test("the source upload's curve is read at the placement's moment", () => {
  const r = retentionAtPlacement({ exposure: { platformPostId: SOURCE, sourceStartSec: "300" }, curve, sourcePlatformPostId: null });
  assert.equal(r.reason, null);
  assert.equal(r.retention?.positionRatio, 0.5);
  assert.equal(r.retention?.watchRatioAtPlacement, 0.5);
  assert.equal(r.retention?.videoMeanWatchRatio, 0.65);
  assert.equal(r.retention?.liftVsVideoMean, -0.15);
});

test("a clip post is not scored against the source upload's curve", () => {
  const r = retentionAtPlacement({ exposure: { platformPostId: SHORT, sourceStartSec: "300" }, curve, sourcePlatformPostId: null });
  assert.equal(r.retention, null);
  assert.match(r.reason ?? "", /isn't the source upload/);
});

test("a curve saved before it recorded a post id falls back to the source video's id", () => {
  const old = { ...curve, platformPostId: null };
  assert.equal(retentionAtPlacement({ exposure: { platformPostId: SOURCE, sourceStartSec: "300" }, curve: old, sourcePlatformPostId: SOURCE }).reason, null);
  assert.equal(retentionAtPlacement({ exposure: { platformPostId: SOURCE, sourceStartSec: "300" }, curve: old, sourcePlatformPostId: null }).retention, null);
});

test("no post id, no curve, or no timestamp each say why", () => {
  assert.match(retentionAtPlacement({ exposure: { platformPostId: null, sourceStartSec: "300" }, curve, sourcePlatformPostId: null }).reason ?? "", /no post id/);
  assert.match(retentionAtPlacement({ exposure: { platformPostId: SOURCE, sourceStartSec: "300" }, curve: undefined, sourcePlatformPostId: null }).reason ?? "", /no retention curve/);
  assert.match(retentionAtPlacement({ exposure: { platformPostId: SOURCE, sourceStartSec: null }, curve, sourcePlatformPostId: null }).reason ?? "", /missing placement timestamp/);
});
