// Regression tests for the clip and reel audio mix.
//
// The bug these pin down: a reel with any Text, PiP or Music block rendered the
// creator's own voice at volume 0. reelOverlay.ts passed `baseAudioLevel ?? null`
// into the edit stack, and `Number(null)` is 0 — finite, and not unity — so the
// gain stage emitted `volume=0.000`. `Number(undefined)` is NaN and was harmless;
// the `?? null` is what turned "no gain set" into "mute".

import assert from "node:assert/strict";
import test from "node:test";

import { buildEditGraph, editStackIsActive, type EditStack, type MusicBed } from "./editStack";
import { __setFfmpegCapabilitiesForTest } from "./ffmpegCapabilities";

// Every filter the audio paths use. Individual tests switch one off to reach the
// capability-gated branches.
const FULL_CAPS: any = {
  vidstab: true, deshake: true, drawtext: true, ass: true,
  sidechaincompress: true, amix: true, atempo: true, silencedetect: true,
  trim: true, concat: true, overlay: true, alimiter: true,
};

const BED: MusicBed = {
  assetId: 1, localPath: "/tmp/bed.m4a", volume: 0.3,
  ducking: false, duckAmountDb: 12, fadeInSec: 0, fadeOutSec: 0,
};

async function graphFor(stack: Partial<EditStack>, caps: any = FULL_CAPS) {
  __setFfmpegCapabilitiesForTest(caps);
  try {
    return await buildEditGraph({
      stack: stack as EditStack,
      clipDurationSec: 10,
      outWidth: 1280,
      outHeight: 720,
      nextInputIndex: 1,
      hasAudio: true,
    });
  } finally {
    __setFfmpegCapabilitiesForTest(null);
  }
}

const gainStage = (a: string[] | null | undefined) => (a ?? []).find((f) => f.includes("[again]"));
const bedStage = (a: string[] | null | undefined) => (a ?? []).find((f) => f.includes("aloop"));
const amixStages = (a: string[] | null | undefined) => (a ?? []).filter((f) => f.includes("amix="));

test("an unset or null gain leaves the voice at unity instead of muting it", async () => {
  for (const level of [undefined, null, 1]) {
    const g = await graphFor({ baseAudioLevel: level as any, music: BED });
    assert.equal(gainStage(g.audio), undefined, `baseAudioLevel=${level} must not emit a gain stage`);
  }
});

test("a real gain is applied, including zero", async () => {
  assert.match(gainStage((await graphFor({ baseAudioLevel: 0.5 })).audio) ?? "", /volume=0\.500/);
  assert.match(gainStage((await graphFor({ baseAudioLevel: 0 })).audio) ?? "", /volume=0\.000/);
});

test("a null gain on its own is not an edit", () => {
  assert.equal(editStackIsActive({ baseAudioLevel: null } as EditStack), false);
  assert.equal(editStackIsActive({ baseAudioLevel: 0.5 } as EditStack), true);
});

test("a bed volume of 0 is silent, and an unset volume defaults to 20%", async () => {
  assert.match(bedStage((await graphFor({ music: { ...BED, volume: 0 } })).audio) ?? "", /volume=0\.000/);
  assert.match(bedStage((await graphFor({ music: { ...BED, volume: undefined as any } })).audio) ?? "", /volume=0\.200/);
});

test("mixing in a bed does not normalize the voice down", async () => {
  for (const ducking of [false, true]) {
    const mixes = amixStages((await graphFor({ music: { ...BED, ducking } })).audio);
    assert.ok(mixes.length > 0, `ducking=${ducking} should produce a mix`);
    for (const m of mixes) assert.match(m, /normalize=0/, `ducking=${ducking}: ${m}`);
  }
});

test("the output limiter is used only when ffmpeg has alimiter", async () => {
  const withLimiter = await graphFor({ music: BED }, FULL_CAPS);
  assert.ok((withLimiter.audio ?? []).some((f) => f.includes("alimiter")), "expected an alimiter stage");
  assert.equal(withLimiter.audioOutLabel, "[alim]");

  const without = await graphFor({ music: BED }, { ...FULL_CAPS, alimiter: false });
  assert.ok(!(without.audio ?? []).some((f) => f.includes("alimiter")), "no alimiter without the capability");
  assert.equal(without.audioOutLabel, "[aout]");
});
