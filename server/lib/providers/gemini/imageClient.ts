import { ProviderError, classifyProviderError } from "../core/errors.js";
import { withRetry, type RetrySleep } from "../core/retry.js";

export interface GeminiImageReference {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Buffer;
}

export interface GeminiImageRequest {
  prompt: string;
  references?: readonly GeminiImageReference[];
  signal?: AbortSignal;
  safeToRetry?: boolean;
}

export interface GeminiImageResult {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Buffer;
  model: string;
}

export interface GeminiTransportRequest {
  model: string;
  prompt: string;
  references: readonly GeminiImageReference[];
  signal?: AbortSignal;
}

export type GeminiImageTransport = (request: GeminiTransportRequest) => Promise<unknown>;

export interface GeminiImageClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  transport?: GeminiImageTransport;
  timeoutMs?: number;
  maxAttempts?: number;
  maxOutputBytes?: number;
  sleep?: RetrySleep;
}

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function invalidResponse(message: string, cause?: unknown): ProviderError {
  return new ProviderError({
    code: "invalid_response",
    message,
    provider: "gemini",
    operation: "generate-image",
    retryable: false,
    cause,
  });
}

function decodeBase64(value: string, maxBytes: number): Buffer {
  const normalized = value.trim();
  if (!normalized || normalized.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw invalidResponse("Gemini returned malformed base64 image data");
  }
  const estimatedBytes = Math.floor((normalized.length * 3) / 4);
  if (estimatedBytes > maxBytes) throw invalidResponse("Gemini image exceeds the configured byte limit");
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes) throw invalidResponse("Gemini image exceeds the configured byte limit");
  return bytes;
}

export function parseGeminiImageResponse(response: unknown, maxBytes = 25 * 1024 * 1024): Omit<GeminiImageResult, "model"> {
  const candidates = record(response)?.candidates;
  if (!Array.isArray(candidates)) throw invalidResponse("Gemini returned no image candidates");
  for (const candidate of candidates) {
    const parts = record(record(candidate)?.content)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inlineData = record(record(part)?.inlineData);
      if (!inlineData) continue;
      const mimeType = typeof inlineData.mimeType === "string" ? inlineData.mimeType.toLowerCase() : "";
      if (!ALLOWED_IMAGE_TYPES.has(mimeType)) throw invalidResponse("Gemini returned an unsupported image MIME type");
      if (typeof inlineData.data !== "string") throw invalidResponse("Gemini returned no inline image data");
      return {
        mimeType: mimeType as GeminiImageResult["mimeType"],
        bytes: decodeBase64(inlineData.data, maxBytes),
      };
    }
  }
  throw invalidResponse("Gemini returned no image data");
}

function sdkTransport(options: { apiKey: string; baseUrl?: string; timeoutMs: number }): GeminiImageTransport {
  const client = import("@google/genai").then(({ GoogleGenAI }) => new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: {
      ...(options.baseUrl ? { baseUrl: options.baseUrl, apiVersion: "" } : {}),
      timeout: options.timeoutMs,
    },
  }));
  return async (request) => {
    const { Modality } = await import("@google/genai");
    return (await client).models.generateContent({
      model: request.model,
      contents: [{
        role: "user",
        parts: [
          { text: request.prompt },
          ...request.references.map((reference) => ({
            inlineData: { mimeType: reference.mimeType, data: reference.bytes.toString("base64") },
          })),
        ],
      }],
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
        abortSignal: request.signal,
        httpOptions: { timeout: options.timeoutMs },
      },
    });
  };
}

export function createGeminiImageClient(options: GeminiImageClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const model = options.model ?? "gemini-2.5-flash-image";
  const apiKey = options.apiKey?.trim();
  if (!options.transport && !apiKey) {
    throw new ProviderError({
      code: "authentication",
      message: "Gemini API credentials are required",
      provider: "gemini",
      operation: "configure",
    });
  }
  const transport = options.transport ?? sdkTransport({ apiKey: apiKey!, baseUrl: options.baseUrl, timeoutMs });

  return {
    async generate(request: GeminiImageRequest): Promise<GeminiImageResult> {
      if (!request.prompt.trim()) {
        throw new ProviderError({
          code: "validation",
          message: "Gemini image prompt is required",
          provider: "gemini",
          operation: "generate-image",
        });
      }
      try {
        const response = await withRetry(
          ({ signal }) => transport({
            model,
            prompt: request.prompt,
            references: request.references ?? [],
            signal,
          }),
          {
            provider: "gemini",
            operation: "generate-image",
            idempotent: request.safeToRetry === true,
            deadlineMs: timeoutMs,
            maxAttempts: options.maxAttempts ?? 3,
            signal: request.signal,
            ...(options.sleep ? { sleep: options.sleep } : {}),
          },
        );
        return { ...parseGeminiImageResponse(response, options.maxOutputBytes), model };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw classifyProviderError(error, { provider: "gemini", operation: "generate-image" });
      }
    },
  };
}
