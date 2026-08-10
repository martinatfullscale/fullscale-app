import assert from "node:assert/strict";
import test from "node:test";

import { parseMediaProbeOutput, probeMedia } from "./probe.js";

const probeJson = JSON.stringify({
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001" },
    { codec_type: "audio", codec_name: "aac" },
  ],
  format: { duration: "12.5", format_name: "mov,mp4,m4a,3gp,3g2,mj2", tags: { major_brand: "isom" } },
});

test("parses media truth from ffprobe JSON", () => {
  assert.deepEqual(parseMediaProbeOutput(probeJson), {
    durationSec: 12.5,
    width: 1920,
    height: 1080,
    fps: 30000 / 1001,
    videoCodec: "h264",
    audioCodec: "aac",
    container: "mp4",
  });
});

test("rejects probe output without a usable video stream", () => {
  assert.throws(
    () => parseMediaProbeOutput(JSON.stringify({ streams: [], format: { duration: "1", format_name: "wav" } })),
    /video stream/i,
  );
});

test("invokes ffprobe with JSON and stream metadata flags", async () => {
  let observed: { command: string; args: readonly string[] } | undefined;
  const result = await probeMedia("/tmp/input.mov", {
    ffprobeBin: "/opt/ffprobe",
    run: async (command, args) => {
      observed = { command, args };
      return { stdout: probeJson, stderr: "", stdoutTruncated: false, stderrTruncated: false };
    },
  });

  assert.equal(result.videoCodec, "h264");
  assert.equal(observed?.command, "/opt/ffprobe");
  assert.deepEqual(observed?.args, [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "/tmp/input.mov",
  ]);
});
