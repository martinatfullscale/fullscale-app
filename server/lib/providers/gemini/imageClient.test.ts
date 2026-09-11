import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError } from "../core/errors.js";
import {
  createGeminiImageClient,
  parseGeminiImageResponse,
  type GeminiImageTransport,
} from "./imageClient.js";

const pngBase64 = Buffer.from([137, 80, 78, 71]).toString("base64");

test("parses validated image bytes and MIME type from a Gemini response", () => {
  const image = parseGeminiImageResponse({
    candidates: [{ content: { parts: [{ text: "done" }, { inlineData: { mimeType: "image/png", data: pngBase64 } }] } }],
  });
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(image.bytes, Buffer.from([137, 80, 78, 71]));
});

test("rejects missing, unsupported, or malformed inline image data", () => {
  assert.throws(() => parseGeminiImageResponse({ candidates: [] }), /image/i);
  assert.throws(() => parseGeminiImageResponse({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "text/html", data: pngBase64 } }] } }],
  }), /MIME/i);
  assert.throws(() => parseGeminiImageResponse({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "%%%" } }] } }],
  }), /base64/i);
});

test("sends prompt and typed reference images through the configured model", async () => {
  let captured: Parameters<GeminiImageTransport>[0] | undefined;
  const client = createGeminiImageClient({
    transport: async (request) => {
      captured = request;
      return { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: pngBase64 } }] } }] };
    },
    model: "gemini-test-image",
  });

  const result = await client.generate({
    prompt: "Place the product",
    references: [{ mimeType: "image/jpeg", bytes: Buffer.from([1, 2, 3]) }],
  });

  assert.equal(captured?.model, "gemini-test-image");
  assert.equal(captured?.prompt, "Place the product");
  assert.equal(captured?.references[0].mimeType, "image/jpeg");
  assert.deepEqual(result.bytes, Buffer.from([137, 80, 78, 71]));
});

test("does not retry generation unless the caller explicitly marks it safe", async () => {
  let attempts = 0;
  const transport: GeminiImageTransport = async () => {
    attempts += 1;
    if (attempts < 2) throw Object.assign(new Error("temporary"), { status: 503 });
    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: pngBase64 } }] } }] };
  };
  const client = createGeminiImageClient({ transport, sleep: async () => {} });

  await assert.rejects(client.generate({ prompt: "first" }));
  assert.equal(attempts, 1);

  const result = await client.generate({ prompt: "second", safeToRetry: true });
  assert.equal(result.mimeType, "image/png");
  assert.equal(attempts, 2);
});

test("classifies invalid provider output without exposing raw response data", async () => {
  const client = createGeminiImageClient({ transport: async () => ({ candidates: [] }) });
  await assert.rejects(
    client.generate({ prompt: "test" }),
    (error: unknown) => error instanceof ProviderError && error.code === "invalid_response",
  );
});
