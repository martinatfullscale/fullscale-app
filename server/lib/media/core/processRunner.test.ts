import assert from "node:assert/strict";
import test from "node:test";

import { MediaProcessError, runProcess } from "./processRunner.js";

test("captures bounded output and splits CR/LF progress lines", async () => {
  const stderrLines: string[] = [];
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('ready\\n'); process.stderr.write('frame=1\\rframe=2\\n')"],
    { onStderrLine: (line) => stderrLines.push(line) },
  );

  assert.equal(result.stdout, "ready\n");
  assert.equal(result.stderr, "frame=1\rframe=2\n");
  assert.deepEqual(stderrLines, ["frame=1", "frame=2"]);
});

test("caps retained output without preventing process completion", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('0123456789')"],
    { maxOutputBytes: 4 },
  );

  assert.equal(result.stdout, "6789");
  assert.equal(result.stdoutTruncated, true);
});

test("classifies missing executables as unavailable", async () => {
  await assert.rejects(
    runProcess("definitely-not-a-real-media-binary", []),
    (error: unknown) => error instanceof MediaProcessError && error.code === "unavailable",
  );
});

test("terminates commands when their deadline expires", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { timeoutMs: 20 }),
    (error: unknown) => error instanceof MediaProcessError && error.code === "timed_out",
  );
});

test("terminates commands when the caller cancels", async () => {
  const controller = new AbortController();
  const pending = runProcess(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10_000)"],
    { signal: controller.signal },
  );
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof MediaProcessError && error.code === "cancelled",
  );
});

test("reports non-zero exits with a redacted-sized stderr tail", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.stderr.write('bad input'); process.exit(7)"]),
    (error: unknown) => {
      assert.ok(error instanceof MediaProcessError);
      assert.equal(error.code, "failed");
      assert.equal(error.exitCode, 7);
      assert.match(error.message, /bad input/);
      return true;
    },
  );
});
