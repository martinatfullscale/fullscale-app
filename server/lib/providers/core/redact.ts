export interface RedactionOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxStringLength?: number;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_STRING_LENGTH = 4_096;
const LARGE_BASE64_LENGTH = 200;

const SENSITIVE_KEY = /(?:^|[-_])(?:api[-_]?key|authorization|credential|password|secret|signature|token)(?:$|[-_])/i;
const PROVIDER_KEY = /\b(?:sk|key)-[A-Za-z0-9_-]{20,}\b/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const BASE64_VALUE = /^[A-Za-z0-9+/]+={0,2}$/;
const SENSITIVE_QUERY_KEY = /(?:credential|key|secret|signature|token|x-amz-|x-goog-)/i;

export function redactSensitive(
  value: unknown,
  options: RedactionOptions = {},
): unknown {
  const limits = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
  };

  return redactValue(value, limits, new WeakSet<object>(), 0);
}

function redactValue(
  value: unknown,
  limits: Required<RedactionOptions>,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") return redactString(value, limits.maxStringLength);
  if (value === null || typeof value !== "object") return value;
  if (depth >= limits.maxDepth) return "[MAX_DEPTH]";
  if (ancestors.has(value)) return "[CIRCULAR]";

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const values = value
        .slice(0, limits.maxEntries)
        .map((item) => redactValue(item, limits, ancestors, depth + 1));
      if (value.length > limits.maxEntries) values.push("[TRUNCATED]");
      return values;
    }

    if (value instanceof Date) return value.toISOString();

    const entries = Object.entries(value).slice(0, limits.maxEntries);
    const result: Record<string, unknown> = {};
    for (const [key, nested] of entries) {
      result[key] = SENSITIVE_KEY.test(normalizeKey(key))
        ? "[REDACTED]"
        : redactValue(nested, limits, ancestors, depth + 1);
    }
    if (Object.keys(value).length > limits.maxEntries) {
      result.__truncated__ = true;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function redactString(value: string, maxLength: number): string {
  if (/^data:[^;,]+;base64,/i.test(value)) return "[REDACTED_DATA_URL]";
  if (value.length >= LARGE_BASE64_LENGTH && BASE64_VALUE.test(value)) {
    return "[REDACTED_BASE64]";
  }

  const asUrl = redactUrl(value);
  const redacted = asUrl
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(PROVIDER_KEY, "[REDACTED]");

  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}...[TRUNCATED]`;
}

function redactUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
}
