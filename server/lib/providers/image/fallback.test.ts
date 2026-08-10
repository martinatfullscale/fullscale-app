import assert from "node:assert/strict";
import test from "node:test";

import { AggregateProviderError } from "../core/fallbackError.js";
import { ProviderError } from "../core/errors.js";
import { runImageGenerationFallback } from "./fallback.js";

test("returns the primary image without invoking fallback", async () => {
  let fallbackCalls = 0;
  const result = await runImageGenerationFallback({
    primary: { provider: "openai-via-fal", generate: async () => "primary" },
    fallback: { provider: "gemini", generate: async () => { fallbackCalls += 1; return "fallback"; } },
  });
  assert.deepEqual(result, { provider: "openai-via-fal", value: "primary", usedFallback: false });
  assert.equal(fallbackCalls, 0);
});

test("uses Gemini only for explicitly fallback-eligible provider failures", async () => {
  const result = await runImageGenerationFallback({
    primary: {
      provider: "openai-via-fal",
      generate: async () => { throw Object.assign(new Error("rate limited"), { status: 429 }); },
    },
    fallback: { provider: "gemini", generate: async () => "fallback" },
  });
  assert.deepEqual(result, { provider: "gemini", value: "fallback", usedFallback: true });
});

test("does not fallback on validation, authentication, or cancellation failures", async () => {
  for (const code of ["validation", "authentication", "cancelled"] as const) {
    let fallbackCalls = 0;
    await assert.rejects(runImageGenerationFallback({
      primary: {
        provider: "openai-via-fal",
        generate: async () => { throw new ProviderError({ code, message: code, provider: "openai-via-fal", operation: "generate-image" }); },
      },
      fallback: { provider: "gemini", generate: async () => { fallbackCalls += 1; return "fallback"; } },
    }));
    assert.equal(fallbackCalls, 0);
  }
});

test("preserves both provider failures when fallback also fails", async () => {
  await assert.rejects(
    runImageGenerationFallback({
      primary: {
        provider: "openai-via-fal",
        generate: async () => { throw Object.assign(new Error("temporary"), { status: 503 }); },
      },
      fallback: {
        provider: "gemini",
        generate: async () => { throw Object.assign(new Error("quota"), { status: 402 }); },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateProviderError);
      assert.deepEqual(error.toJSON().attempts.map((attempt) => attempt.provider), ["openai-via-fal", "gemini"]);
      return true;
    },
  );
});
