import {
  ProviderError,
  classifyProviderError,
} from "./errors.js";

export interface RetryAttemptContext {
  attempt: number;
  signal: AbortSignal;
}

export type RetrySleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

export interface RetryOptions {
  provider: string;
  operation: string;
  idempotent: boolean;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  random?: () => number;
  now?: () => number;
  sleep?: RetrySleep;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_DEADLINE_MS = 30_000;

export async function withRetry<T>(
  operation: (context: RetryAttemptContext) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;

  validateOptions({ maxAttempts, baseDelayMs, maxDelayMs, deadlineMs });

  const startedAt = now();
  const deadlineAt = startedAt + deadlineMs;
  const controller = new AbortController();
  let timedOut = false;

  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Provider deadline exceeded"));
  }, deadlineMs);
  deadlineTimer.unref?.();

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (timedOut || now() >= deadlineAt) {
        throw timeoutError(options, attempt, deadlineMs);
      }
      if (controller.signal.aborted) {
        throw cancellationError(options, attempt, controller.signal.reason);
      }

      try {
        return await operation({ attempt, signal: controller.signal });
      } catch (error) {
        if (timedOut || now() >= deadlineAt) {
          throw timeoutError(options, attempt, deadlineMs, error);
        }
        if (controller.signal.aborted) {
          throw cancellationError(options, attempt, controller.signal.reason ?? error);
        }

        const classified = classifyProviderError(error, {
          provider: options.provider,
          operation: options.operation,
          attempt,
        });

        if (!classified.retryable || !options.idempotent || attempt >= maxAttempts) {
          throw classified;
        }

        const retryAfterMs = readRetryAfterMs(error, now());
        const delayMs = retryAfterMs ?? calculateBackoff(
          attempt,
          baseDelayMs,
          maxDelayMs,
          random,
        );
        const remainingMs = deadlineAt - now();
        if (delayMs >= remainingMs) {
          throw timeoutError(options, attempt, deadlineMs, classified);
        }

        try {
          await sleep(delayMs, controller.signal);
        } catch (sleepError) {
          if (timedOut || now() >= deadlineAt) {
            throw timeoutError(options, attempt, deadlineMs, sleepError);
          }
          throw cancellationError(options, attempt, sleepError);
        }
      }
    }

    throw new Error("Provider retry loop exhausted unexpectedly");
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = 0.5 + clamp(random(), 0, 1);
  return Math.round(Math.min(maxDelayMs, exponential * jitter));
}

function readRetryAfterMs(error: unknown, currentTimeMs: number): number | undefined {
  for (const candidate of walkCauses(error)) {
    if (!isRecord(candidate)) continue;
    const direct = candidate.retryAfterMs;
    if (typeof direct === "number" && direct >= 0) return direct;

    const response = isRecord(candidate.response) ? candidate.response : undefined;
    const headers = response && isRecord(response.headers) ? response.headers : undefined;
    const raw = headers?.["retry-after"] ?? headers?.["Retry-After"] ?? candidate.retryAfter;
    if (typeof raw !== "string" && typeof raw !== "number") continue;

    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    if (typeof raw === "string") {
      const dateMs = Date.parse(raw);
      if (Number.isFinite(dateMs)) return Math.max(0, dateMs - currentTimeMs);
    }
  }
  return undefined;
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal.reason));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function timeoutError(
  options: RetryOptions,
  attempt: number,
  deadlineMs: number,
  cause?: unknown,
): ProviderError {
  return new ProviderError({
    code: "timeout",
    message: `Provider deadline exceeded after ${deadlineMs}ms`,
    provider: options.provider,
    operation: options.operation,
    retryable: true,
    attempt,
    details: { deadlineMs },
    cause,
  });
}

function cancellationError(
  options: RetryOptions,
  attempt: number,
  cause?: unknown,
): ProviderError {
  return new ProviderError({
    code: "cancelled",
    message: "Provider operation was cancelled",
    provider: options.provider,
    operation: options.operation,
    retryable: false,
    attempt,
    cause,
  });
}

function abortError(cause?: unknown): Error {
  return Object.assign(new Error("The operation was aborted", { cause }), {
    name: "AbortError",
  });
}

function validateOptions(values: {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  deadlineMs: number;
}): void {
  if (!Number.isInteger(values.maxAttempts) || values.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  for (const [name, value] of Object.entries(values).slice(1)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative finite number`);
    }
  }
  if (values.deadlineMs === 0) {
    throw new RangeError("deadlineMs must be greater than zero");
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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
