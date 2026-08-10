import { redactSensitive } from "./redact.js";

export type ProviderErrorCode =
  | "authentication"
  | "authorization"
  | "quota"
  | "validation"
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "transient"
  | "invalid_response"
  | "unavailable"
  | "unknown";

export interface ProviderErrorOptions {
  code: ProviderErrorCode;
  message: string;
  provider: string;
  operation: string;
  status?: number;
  retryable?: boolean;
  attempt?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export interface ProviderErrorContext {
  provider: string;
  operation: string;
  attempt?: number;
}

export interface SerializedProviderError {
  name: "ProviderError";
  code: ProviderErrorCode;
  message: string;
  provider: string;
  operation: string;
  status?: number;
  retryable: boolean;
  attempt?: number;
  details?: Record<string, unknown>;
}

const RETRYABLE_CODES = new Set<ProviderErrorCode>([
  "rate_limit",
  "timeout",
  "transient",
]);

const NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly operation: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly attempt?: number;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(options: ProviderErrorOptions) {
    super(options.message);
    this.code = options.code;
    this.provider = options.provider;
    this.operation = options.operation;
    this.status = options.status;
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(options.code);
    this.attempt = options.attempt;
    this.details = options.details;
    this.cause = options.cause;
  }

  toJSON(): SerializedProviderError {
    return {
      name: "ProviderError",
      code: this.code,
      message: redactSensitive(this.message) as string,
      provider: this.provider,
      operation: this.operation,
      ...(this.status === undefined ? {} : { status: this.status }),
      retryable: this.retryable,
      ...(this.attempt === undefined ? {} : { attempt: this.attempt }),
      ...(this.details === undefined
        ? {}
        : { details: redactSensitive(this.details) as Record<string, unknown> }),
    };
  }
}

export function classifyProviderError(
  error: unknown,
  context: ProviderErrorContext,
): ProviderError {
  if (error instanceof ProviderError) {
    if (error.attempt !== undefined || context.attempt === undefined) {
      return error;
    }
    return new ProviderError({
      code: error.code,
      message: error.message,
      provider: error.provider,
      operation: error.operation,
      status: error.status,
      retryable: error.retryable,
      attempt: context.attempt,
      details: error.details,
      cause: error.cause,
    });
  }

  const status = readStatus(error);
  const code = classifyCode(error, status);

  return new ProviderError({
    code,
    message: safeMessage(code),
    provider: context.provider,
    operation: context.operation,
    status,
    retryable: RETRYABLE_CODES.has(code),
    attempt: context.attempt,
    cause: error,
  });
}

function classifyCode(error: unknown, status?: number): ProviderErrorCode {
  if (hasName(error, "AbortError")) return "cancelled";
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 402) return "quota";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status !== undefined && [400, 404, 409, 422].includes(status)) {
    return "validation";
  }
  if (status !== undefined && [500, 502, 503, 504].includes(status)) {
    return "transient";
  }
  if (hasNestedCode(error, "ENOENT")) return "unavailable";
  if (hasNetworkCode(error)) return "transient";

  const message = readMessage(error).toLowerCase();
  if (message.includes("timed out") || message.includes("timeout")) return "timeout";
  if (message.includes("quota") || message.includes("billing") || message.includes("payment")) {
    return "quota";
  }
  return "unknown";
}

function safeMessage(code: ProviderErrorCode): string {
  switch (code) {
    case "authentication": return "Provider authentication failed";
    case "authorization": return "Provider authorization failed";
    case "quota": return "Provider quota or billing prevented the operation";
    case "validation": return "Provider rejected the request";
    case "rate_limit": return "Provider rate limit exceeded";
    case "timeout": return "Provider operation timed out";
    case "cancelled": return "Provider operation was cancelled";
    case "transient": return "Provider operation failed temporarily";
    case "invalid_response": return "Provider returned an invalid response";
    case "unavailable": return "Provider dependency is unavailable";
    case "unknown": return "Provider operation failed";
  }
}

function readStatus(error: unknown): number | undefined {
  for (const candidate of walkCauses(error)) {
    if (!isRecord(candidate)) continue;
    for (const value of [candidate.status, candidate.statusCode]) {
      const parsed = typeof value === "string" ? Number(value) : value;
      if (typeof parsed === "number" && Number.isInteger(parsed)) return parsed;
    }
    if (isRecord(candidate.response)) {
      const value = candidate.response.status;
      const parsed = typeof value === "string" ? Number(value) : value;
      if (typeof parsed === "number" && Number.isInteger(parsed)) return parsed;
    }
  }
  return undefined;
}

function hasNetworkCode(error: unknown): boolean {
  let found = false;
  NETWORK_CODES.forEach((code) => {
    if (hasNestedCode(error, code)) found = true;
  });
  return found;
}

function hasNestedCode(error: unknown, expected: string): boolean {
  for (const candidate of walkCauses(error)) {
    if (isRecord(candidate) && candidate.code === expected) return true;
  }
  return false;
}

function hasName(error: unknown, expected: string): boolean {
  return walkCauses(error).some(
    (candidate) => isRecord(candidate) && candidate.name === expected,
  );
}

function readMessage(error: unknown): string {
  for (const candidate of walkCauses(error)) {
    if (isRecord(candidate) && typeof candidate.message === "string") {
      return candidate.message;
    }
  }
  return "";
}

function walkCauses(error: unknown): unknown[] {
  const values: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    values.push(current);
    seen.add(current);
    current = isRecord(current) ? current.cause : undefined;
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
