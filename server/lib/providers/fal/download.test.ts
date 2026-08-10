import assert from "node:assert/strict";
import test from "node:test";

import { downloadFalFile } from "./download.js";

test("downloads an allowed HTTPS result with bounded bytes", async () => {
  const bytes = await downloadFalFile("https://cdn.example/result.png", {
    fetch: async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png", "content-length": "3" },
    }),
    allowedContentTypes: ["image/png"],
    maxBytes: 4,
  });
  assert.deepEqual(bytes, Buffer.from([1, 2, 3]));
});

test("rejects non-HTTPS result URLs", async () => {
  await assert.rejects(
    downloadFalFile("http://cdn.example/result.png"),
    /HTTPS/i,
  );
});

test("rejects unexpected content types", async () => {
  await assert.rejects(
    downloadFalFile("https://cdn.example/result", {
      fetch: async () => new Response("<html>", { headers: { "content-type": "text/html" } }),
      allowedContentTypes: ["image/png"],
    }),
    /content type/i,
  );
});

test("rejects bodies that exceed the configured byte limit", async () => {
  await assert.rejects(
    downloadFalFile("https://cdn.example/result.png", {
      fetch: async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        headers: { "content-type": "image/png" },
      }),
      allowedContentTypes: ["image/png"],
      maxBytes: 4,
    }),
    /byte limit/i,
  );
});
