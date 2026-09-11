import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderError,
  classifyProviderError,
} from "./errors.js";

test("ProviderError serializes safe fields without exposing its cause", () => {
  const cause = new Error("sdk included a private token");
  const error = new ProviderError({
    code: "invalid_response",
    message: "Gemini returned no image",
    provider: "gemini",
    operation: "generate-image",
    status: 502,
    retryable: true,
    attempt: 2,
    details: { requestId: "req_123" },
    cause,
  });

  assert.deepEqual(error.toJSON(), {
    name: "ProviderError",
    code: "invalid_response",
    message: "Gemini returned no image",
    provider: "gemini",
    operation: "generate-image",
    status: 502,
    retryable: true,
    attempt: 2,
    details: { requestId: "req_123" },
  });
  assert.equal(JSON.stringify(error).includes("private token"), false);
  assert.equal(error.cause, cause);
});

test("ProviderError redacts unsafe messages and details during serialization", () => {
  const error = new ProviderError({
    code: "unknown",
    message: "Request used Authorization: Bearer abc.def.ghi",
    provider: "gemini",
    operation: "generate-image",
    details: { apiKey: "private-key", requestId: "req_123" },
  });

  assert.deepEqual(error.toJSON(), {
    name: "ProviderError",
    code: "unknown",
    message: "Request used Authorization: Bearer [REDACTED]",
    provider: "gemini",
    operation: "generate-image",
    retryable: false,
    details: { apiKey: "[REDACTED]", requestId: "req_123" },
  });
});

test("classifies authentication failures as non-retryable", () => {
  const error = classifyProviderError(
    Object.assign(new Error("Unauthorized"), { status: 401 }),
    { provider: "gemini", operation: "generate-image" },
  );

  assert.equal(error.code, "authentication");
  assert.equal(error.status, 401);
  assert.equal(error.retryable, false);
});

test("classifies rate limits and selected server failures as retryable", () => {
  const rateLimit = classifyProviderError(
    Object.assign(new Error("Too many requests"), { statusCode: 429 }),
    { provider: "fal", operation: "submit" },
  );
  const unavailable = classifyProviderError(
    Object.assign(new Error("Service unavailable"), { response: { status: 503 } }),
    { provider: "fal", operation: "poll" },
  );

  assert.equal(rateLimit.code, "rate_limit");
  assert.equal(rateLimit.retryable, true);
  assert.equal(unavailable.code, "transient");
  assert.equal(unavailable.retryable, true);
});

test("classifies nested network causes as transient", () => {
  const error = classifyProviderError(
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    }),
    { provider: "fal", operation: "download" },
  );

  assert.equal(error.code, "transient");
  assert.equal(error.retryable, true);
});

test("classifies aborts as cancellation", () => {
  const error = classifyProviderError(
    Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    { provider: "gemini", operation: "generate-image" },
  );

  assert.equal(error.code, "cancelled");
  assert.equal(error.retryable, false);
});

test("preserves an existing ProviderError while adding a missing attempt", () => {
  const original = new ProviderError({
    code: "validation",
    message: "Invalid prompt",
    provider: "gemini",
    operation: "generate-image",
    retryable: false,
  });

  const classified = classifyProviderError(original, {
    provider: "gemini",
    operation: "generate-image",
    attempt: 3,
  });

  assert.equal(classified.code, "validation");
  assert.equal(classified.attempt, 3);
  assert.equal(classified.cause, original.cause);
});
