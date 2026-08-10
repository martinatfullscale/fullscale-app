import assert from "node:assert/strict";
import test from "node:test";

import { redactSensitive } from "./redact.js";

test("redacts sensitive fields recursively without mutating the input", () => {
  const input = {
    provider: "gemini",
    apiKey: "secret-key",
    headers: { Authorization: "Bearer private-token", accept: "image/png" },
    nested: [{ password: "hunter2", requestId: "req_123" }],
  };

  const result = redactSensitive(input);

  assert.deepEqual(result, {
    provider: "gemini",
    apiKey: "[REDACTED]",
    headers: { Authorization: "[REDACTED]", accept: "image/png" },
    nested: [{ password: "[REDACTED]", requestId: "req_123" }],
  });
  assert.equal(input.apiKey, "secret-key");
});

test("redacts signed URL credentials while retaining safe URL context", () => {
  const value = "https://cdn.example.com/result.png?size=large&X-Amz-Signature=abc123&token=private";

  assert.equal(
    redactSensitive(value),
    "https://cdn.example.com/result.png?size=large&X-Amz-Signature=%5BREDACTED%5D&token=%5BREDACTED%5D",
  );
});

test("redacts data URLs and large base64 payloads", () => {
  assert.equal(
    redactSensitive("data:image/png;base64,aGVsbG8="),
    "[REDACTED_DATA_URL]",
  );
  assert.equal(redactSensitive("A".repeat(256)), "[REDACTED_BASE64]");
});

test("redacts bearer tokens and common inline provider keys", () => {
  assert.equal(
    redactSensitive("Authorization: Bearer abc.def.ghi"),
    "Authorization: Bearer [REDACTED]",
  );
  assert.equal(
    redactSensitive("request failed for key sk-abcdefghijklmnopqrstuvwxyz123456"),
    "request failed for key [REDACTED]",
  );
});

test("bounds recursive diagnostics and handles circular input", () => {
  const circular: Record<string, unknown> = { safe: true };
  circular.self = circular;

  assert.deepEqual(redactSensitive(circular), {
    safe: true,
    self: "[CIRCULAR]",
  });
});
