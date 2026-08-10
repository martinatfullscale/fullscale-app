import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError } from "./errors.js";
import { withRetry } from "./retry.js";

test("retries transient failures and returns the successful result", async () => {
  let attempts = 0;
  const delays: number[] = [];

  const result = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("Service unavailable"), { status: 503 });
      }
      return "ready";
    },
    {
      provider: "fal",
      operation: "poll",
      idempotent: true,
      maxAttempts: 3,
      baseDelayMs: 100,
      random: () => 0.5,
      sleep: async (delay) => { delays.push(delay); },
    },
  );

  assert.equal(result, "ready");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("does not retry non-retryable provider failures", async () => {
  let attempts = 0;

  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw new ProviderError({
          code: "validation",
          message: "Invalid request",
          provider: "gemini",
          operation: "generate-image",
        });
      },
      {
        provider: "gemini",
        operation: "generate-image",
        idempotent: true,
      },
    ),
    (error: unknown) => error instanceof ProviderError && error.code === "validation",
  );

  assert.equal(attempts, 1);
});

test("requires an explicit idempotency decision before retrying", async () => {
  let attempts = 0;

  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw Object.assign(new Error("Network reset"), { code: "ECONNRESET" });
      },
      {
        provider: "fal",
        operation: "submit",
        idempotent: false,
      },
    ),
    (error: unknown) => error instanceof ProviderError && error.code === "transient",
  );

  assert.equal(attempts, 1);
});

test("stops after the configured maximum attempts", async () => {
  let attempts = 0;

  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw Object.assign(new Error("Service unavailable"), { status: 503 });
      },
      {
        provider: "fal",
        operation: "poll",
        idempotent: true,
        maxAttempts: 3,
        sleep: async () => undefined,
      },
    ),
    (error: unknown) => error instanceof ProviderError
      && error.code === "transient"
      && error.attempt === 3,
  );

  assert.equal(attempts, 3);
});

test("honors Retry-After for rate limits", async () => {
  const delays: number[] = [];
  let attempts = 0;

  await withRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("Rate limited"), {
          status: 429,
          response: { headers: { "retry-after": "2" } },
        });
      }
      return "ready";
    },
    {
      provider: "fal",
      operation: "poll",
      idempotent: true,
      sleep: async (delay) => { delays.push(delay); },
    },
  );

  assert.deepEqual(delays, [2_000]);
});

test("fails with timeout when the next retry exceeds the overall deadline", async () => {
  let now = 1_000;
  let slept = false;

  await assert.rejects(
    withRetry(
      async () => {
        throw Object.assign(new Error("Service unavailable"), { status: 503 });
      },
      {
        provider: "fal",
        operation: "poll",
        idempotent: true,
        deadlineMs: 50,
        baseDelayMs: 100,
        random: () => 0.5,
        now: () => now,
        sleep: async () => { slept = true; now += 100; },
      },
    ),
    (error: unknown) => error instanceof ProviderError && error.code === "timeout",
  );

  assert.equal(slept, false);
});

test("cancellation interrupts retry backoff", async () => {
  const controller = new AbortController();

  await assert.rejects(
    withRetry(
      async () => {
        throw Object.assign(new Error("Service unavailable"), { status: 503 });
      },
      {
        provider: "fal",
        operation: "poll",
        idempotent: true,
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
          throw Object.assign(new Error("Aborted"), { name: "AbortError" });
        },
      },
    ),
    (error: unknown) => error instanceof ProviderError && error.code === "cancelled",
  );
});
