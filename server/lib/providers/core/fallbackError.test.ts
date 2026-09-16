import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError } from "./errors.js";
import { AggregateProviderError } from "./fallbackError.js";

test("preserves every provider failure in order with safe diagnostics", () => {
  const primary = new ProviderError({
    code: "rate_limit",
    message: "FAL rate limited Bearer private-token",
    provider: "fal",
    operation: "generate-image",
    status: 429,
    retryable: true,
    details: { requestId: "fal_req", apiKey: "fal-secret" },
  });
  const fallback = new ProviderError({
    code: "invalid_response",
    message: "Gemini returned no image",
    provider: "gemini",
    operation: "generate-image",
    retryable: false,
    details: { requestId: "gemini_req" },
  });

  const error = new AggregateProviderError(
    "All image providers failed",
    [
      { provider: "fal", operation: "generate-image", error: primary },
      { provider: "gemini", operation: "generate-image", error: fallback },
    ],
  );

  assert.deepEqual(error.toJSON(), {
    name: "AggregateProviderError",
    message: "All image providers failed",
    attempts: [
      {
        name: "ProviderError",
        code: "rate_limit",
        message: "FAL rate limited Bearer [REDACTED]",
        provider: "fal",
        operation: "generate-image",
        status: 429,
        retryable: true,
        details: { requestId: "fal_req", apiKey: "[REDACTED]" },
      },
      {
        name: "ProviderError",
        code: "invalid_response",
        message: "Gemini returned no image",
        provider: "gemini",
        operation: "generate-image",
        retryable: false,
        details: { requestId: "gemini_req" },
      },
    ],
  });
  assert.equal(JSON.stringify(error).includes("private-token"), false);
  assert.equal(JSON.stringify(error).includes("fal-secret"), false);
  assert.equal(error.cause, primary);
});

test("classifies unknown fallback failures using their provider context", () => {
  const error = new AggregateProviderError(
    "All providers failed",
    [{
      provider: "fal",
      operation: "download",
      attempt: 2,
      error: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    }],
  );

  assert.deepEqual(error.toJSON().attempts[0], {
    name: "ProviderError",
    code: "transient",
    message: "Provider operation failed temporarily",
    provider: "fal",
    operation: "download",
    retryable: true,
    attempt: 2,
  });
});

test("requires at least one failed attempt", () => {
  assert.throws(
    () => new AggregateProviderError("No attempts", []),
    /at least one provider attempt/i,
  );
});
