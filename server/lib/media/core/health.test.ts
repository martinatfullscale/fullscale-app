import assert from "node:assert/strict";
import test from "node:test";

import { checkMediaBinaries } from "./health.js";

test("reports versions and source type for both required media binaries", async () => {
  const health = await checkMediaBinaries({
    ffmpegBin: "ffmpeg",
    ffprobeBin: "/vendor/ffprobe",
    run: async (command) => ({
      stdout: `${command} version 7.1\n`,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  });

  assert.equal(health.ok, true);
  assert.deepEqual(health.binaries.map(({ name, source, ok }) => ({ name, source, ok })), [
    { name: "ffmpeg", source: "path", ok: true },
    { name: "ffprobe", source: "configured", ok: true },
  ]);
});

test("fails closed while preserving per-binary diagnostics", async () => {
  const health = await checkMediaBinaries({
    ffmpegBin: "ffmpeg",
    ffprobeBin: "ffprobe",
    run: async (command) => {
      if (command === "ffprobe") throw new Error("not installed");
      return { stdout: "ffmpeg version 7.1\n", stderr: "", stdoutTruncated: false, stderrTruncated: false };
    },
  });

  assert.equal(health.ok, false);
  assert.equal(health.binaries[1].ok, false);
  assert.equal(health.binaries[1].error, "not installed");
});
