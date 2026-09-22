import { ProviderError } from "../core/errors.js";

export interface FalDownloadOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  maxBytes?: number;
  allowedContentTypes?: readonly string[];
  allowedHosts?: readonly string[];
}

function downloadError(code: "validation" | "invalid_response", message: string, details?: Record<string, unknown>) {
  return new ProviderError({
    code,
    message,
    provider: "fal",
    operation: "download",
    retryable: false,
    details,
  });
}

export async function downloadFalFile(urlText: string, options: FalDownloadOptions = {}): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch (cause) {
    throw downloadError("validation", "FAL result URL is invalid", { cause: String(cause) });
  }
  if (url.protocol !== "https:") throw downloadError("validation", "FAL downloads require HTTPS");
  if (options.allowedHosts && !options.allowedHosts.includes(url.hostname)) {
    throw downloadError("validation", "FAL result host is not allowed", { host: url.hostname });
  }

  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  const response = await (options.fetch ?? globalThis.fetch)(url, { signal: options.signal, redirect: "error" });
  if (!response.ok) {
    throw downloadError("invalid_response", `FAL result download failed (${response.status})`, { status: response.status });
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const allowedTypes = options.allowedContentTypes?.map((value) => value.toLowerCase());
  if (allowedTypes?.length && !allowedTypes.includes(contentType)) {
    throw downloadError("invalid_response", "FAL result has an unexpected content type", { contentType });
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw downloadError("invalid_response", "FAL result exceeds the configured byte limit", { declaredLength, maxBytes });
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw downloadError("invalid_response", "FAL result exceeds the configured byte limit", { maxBytes });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
