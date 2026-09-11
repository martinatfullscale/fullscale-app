import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError } from "../core/errors.js";
import { createFalQueueClient, type FalQueueTransport } from "./queueClient.js";

function transport(overrides: Partial<FalQueueTransport> = {}): FalQueueTransport {
  return {
    submit: async () => ({ request_id: "req_1" }),
    status: async () => ({ status: "COMPLETED" }),
    result: async () => ({ data: { image: { url: "https://cdn.example/result.png" } } }),
    cancel: async () => {},
    ...overrides,
  };
}

test("submits, polls, and returns queued FAL output", async () => {
  const states = ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"];
  const observed: string[] = [];
  const client = createFalQueueClient({
    transport: transport({
      submit: async (endpoint, input) => {
        assert.equal(endpoint, "fal-ai/model");
        assert.deepEqual(input, { prompt: "hello" });
        return { request_id: "req_42" };
      },
      status: async (_endpoint, requestId) => {
        assert.equal(requestId, "req_42");
        return { status: states.shift() };
      },
      result: async () => ({ data: { ok: true } }),
    }),
    sleep: async () => {},
    onStatus: (status) => observed.push(status),
  });

  const completed = await client.run<{ ok: boolean }>("fal-ai/model", { prompt: "hello" });
  assert.equal(completed.requestId, "req_42");
  assert.deepEqual(completed.data, { ok: true });
  assert.deepEqual(observed, ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]);
});

test("rejects malformed submit responses", async () => {
  const client = createFalQueueClient({
    transport: transport({ submit: async () => ({}) }),
  });

  await assert.rejects(
    client.submit("fal-ai/model", {}),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_response",
  );
});

test("does not retry queue submission without an explicit safe-to-retry decision", async () => {
  let attempts = 0;
  const client = createFalQueueClient({
    transport: transport({
      submit: async () => {
        attempts += 1;
        throw Object.assign(new Error("temporary"), { status: 503 });
      },
    }),
    sleep: async () => {},
  });

  await assert.rejects(client.submit("fal-ai/model", {}));
  assert.equal(attempts, 1);
});

test("retries idempotent status reads on transient errors", async () => {
  let attempts = 0;
  const client = createFalQueueClient({
    transport: transport({
      status: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("temporary"), { status: 503 });
        return { status: "COMPLETED" };
      },
    }),
    sleep: async () => {},
  });

  await client.wait({ endpoint: "fal-ai/model", requestId: "req_1" });
  assert.equal(attempts, 2);
});

test("cancels the remote request when the overall deadline expires", async () => {
  let now = 0;
  let cancelled = false;
  const client = createFalQueueClient({
    transport: transport({
      status: async () => ({ status: "IN_PROGRESS" }),
      cancel: async () => { cancelled = true; },
    }),
    timeoutMs: 5,
    now: () => now,
    sleep: async () => { now = 6; },
  });

  await assert.rejects(
    client.wait({ endpoint: "fal-ai/model", requestId: "req_1" }),
    (error: unknown) => error instanceof ProviderError && error.code === "timeout",
  );
  assert.equal(cancelled, true);
});

test("forwards caller cancellation to queue operations", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const client = createFalQueueClient({
    transport: transport({
      status: async (_endpoint, _requestId, signal) => {
        receivedSignal = signal;
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    }),
  });

  await assert.rejects(
    client.wait({ endpoint: "fal-ai/model", requestId: "req_1" }, { signal: controller.signal }),
    (error: unknown) => error instanceof ProviderError && error.code === "cancelled",
  );
  assert.equal(receivedSignal?.aborted, true);
});

test("classifies cancellation during the polling delay and cancels remotely", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const client = createFalQueueClient({
    transport: transport({
      status: async () => ({ status: "IN_PROGRESS" }),
      cancel: async () => { cancelled = true; },
    }),
    sleep: async (_delay, signal) => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError", cause: signal.reason });
    },
  });

  await assert.rejects(
    client.wait({ endpoint: "fal-ai/model", requestId: "req_1" }, { signal: controller.signal }),
    (error: unknown) => error instanceof ProviderError && error.code === "cancelled",
  );
  assert.equal(cancelled, true);
});
