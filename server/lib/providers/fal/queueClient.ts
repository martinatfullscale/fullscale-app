import { ProviderError, classifyProviderError } from "../core/errors.js";
import { withRetry, type RetrySleep } from "../core/retry.js";

export interface FalQueueHandle {
  endpoint: string;
  requestId: string;
}

export interface FalQueueTransport {
  submit(endpoint: string, input: unknown, signal?: AbortSignal): Promise<{ request_id?: unknown }>;
  status(endpoint: string, requestId: string, signal?: AbortSignal): Promise<{ status?: unknown }>;
  result<T>(endpoint: string, requestId: string, signal?: AbortSignal): Promise<{ data?: T }>;
  cancel(endpoint: string, requestId: string, signal?: AbortSignal): Promise<void>;
}

export interface FalQueueRunResult<T> extends FalQueueHandle {
  data: T;
}

export interface FalQueueClientOptions {
  credentials?: string;
  transport?: FalQueueTransport;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  sleep?: RetrySleep;
  now?: () => number;
  onStatus?: (status: string) => void;
}

export interface FalOperationOptions {
  signal?: AbortSignal;
  safeToRetry?: boolean;
}

export interface FalQueueClient {
  submit(endpoint: string, input: unknown, options?: FalOperationOptions): Promise<FalQueueHandle>;
  wait(handle: FalQueueHandle, options?: FalOperationOptions): Promise<void>;
  result<T>(handle: FalQueueHandle, options?: FalOperationOptions): Promise<FalQueueRunResult<T>>;
  cancel(handle: FalQueueHandle, options?: FalOperationOptions): Promise<void>;
  run<T>(endpoint: string, input: unknown, options?: FalOperationOptions): Promise<FalQueueRunResult<T>>;
}

function sdkTransport(credentials: string): FalQueueTransport {
  const client = import("@fal-ai/client").then(({ createFalClient }) => createFalClient({ credentials }));
  return {
    async submit(endpoint, input, signal) {
      return (await client).queue.submit(endpoint, { input, abortSignal: signal } as never);
    },
    async status(endpoint, requestId, signal) {
      return (await client).queue.status(endpoint, { requestId, abortSignal: signal });
    },
    async result<T>(endpoint: string, requestId: string, signal?: AbortSignal) {
      return (await client).queue.result(endpoint, { requestId, abortSignal: signal }) as Promise<{ data?: T }>;
    },
    async cancel(endpoint, requestId, signal) {
      await (await client).queue.cancel(endpoint, { requestId, abortSignal: signal });
    },
  };
}

function timeoutError(operation: string, timeoutMs: number): ProviderError {
  return new ProviderError({
    code: "timeout",
    message: `FAL queue deadline exceeded after ${timeoutMs}ms`,
    provider: "fal",
    operation,
    retryable: true,
    details: { timeoutMs },
  });
}

function invalidResponse(operation: string, message: string): ProviderError {
  return new ProviderError({
    code: "invalid_response",
    message,
    provider: "fal",
    operation,
    retryable: false,
  });
}

function linkedSignal(defaultSignal?: AbortSignal, operationSignal?: AbortSignal): AbortSignal | undefined {
  const signals = [defaultSignal, operationSignal].filter((signal): signal is AbortSignal => Boolean(signal));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

export function createFalQueueClient(options: FalQueueClientOptions): FalQueueClient {
  const credentials = options.credentials?.trim();
  if (!options.transport && !credentials) {
    throw new ProviderError({
      code: "authentication",
      message: "FAL credentials are required",
      provider: "fal",
      operation: "configure",
    });
  }

  const transport = options.transport ?? sdkTransport(credentials!);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const now = options.now ?? Date.now;
  const sleep = options.sleep;

  async function retry<T>(
    operation: string,
    idempotent: boolean,
    deadlineMs: number,
    signal: AbortSignal | undefined,
    invoke: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return withRetry(
      ({ signal: attemptSignal }) => invoke(attemptSignal),
      {
        provider: "fal",
        operation,
        idempotent,
        deadlineMs: Math.max(1, deadlineMs),
        maxAttempts,
        signal,
        now,
        ...(sleep ? { sleep } : {}),
      },
    );
  }

  const client: FalQueueClient = {
    async submit(endpoint, input, operationOptions = {}) {
      const signal = linkedSignal(options.signal, operationOptions.signal);
      const submitted = await retry(
        "submit",
        operationOptions.safeToRetry === true,
        timeoutMs,
        signal,
        (attemptSignal) => transport.submit(endpoint, input, attemptSignal),
      );
      const requestId = typeof submitted.request_id === "string" ? submitted.request_id.trim() : "";
      if (!requestId) throw invalidResponse("submit", "FAL queue returned no request id");
      return { endpoint, requestId };
    },

    async wait(handle, operationOptions = {}) {
      const signal = linkedSignal(options.signal, operationOptions.signal);
      const startedAt = now();
      const deadlineAt = startedAt + timeoutMs;
      try {
        for (;;) {
          const remainingMs = deadlineAt - now();
          if (remainingMs <= 0) throw timeoutError("wait", timeoutMs);
          const response = await retry(
            "status",
            true,
            remainingMs,
            signal,
            (attemptSignal) => transport.status(handle.endpoint, handle.requestId, attemptSignal),
          );
          const status = typeof response.status === "string" ? response.status.toUpperCase() : "";
          if (!status) throw invalidResponse("status", "FAL queue returned no status");
          options.onStatus?.(status);
          if (status === "COMPLETED") return;
          if (status === "FAILED" || status === "CANCELLED") {
            throw new ProviderError({
              code: status === "CANCELLED" ? "cancelled" : "unknown",
              message: `FAL queue request ${status.toLowerCase()}`,
              provider: "fal",
              operation: "wait",
              retryable: false,
              details: { requestId: handle.requestId, status },
            });
          }
          const afterPollMs = deadlineAt - now();
          if (afterPollMs <= 0) throw timeoutError("wait", timeoutMs);
          const pollSleep = sleep ?? ((delayMs: number, abortSignal: AbortSignal) => new Promise<void>((resolve, reject) => {
            if (abortSignal.aborted) return reject(abortSignal.reason);
            const timer = setTimeout(resolve, delayMs);
            abortSignal.addEventListener("abort", () => { clearTimeout(timer); reject(abortSignal.reason); }, { once: true });
          }));
          const sleepSignal = signal ?? new AbortController().signal;
          await pollSleep(Math.min(pollIntervalMs, afterPollMs), sleepSignal);
        }
      } catch (error) {
        const providerError = error instanceof ProviderError
          ? error
          : classifyProviderError(error, { provider: "fal", operation: "wait" });
        if (providerError.code === "timeout" || providerError.code === "cancelled") {
          await transport.cancel(handle.endpoint, handle.requestId).catch(() => undefined);
        }
        throw providerError;
      }
    },

    async result<T>(handle: FalQueueHandle, operationOptions: FalOperationOptions = {}) {
      const signal = linkedSignal(options.signal, operationOptions.signal);
      const response = await retry(
        "result",
        true,
        timeoutMs,
        signal,
        (attemptSignal) => transport.result<T>(handle.endpoint, handle.requestId, attemptSignal),
      );
      if (!("data" in response)) throw invalidResponse("result", "FAL queue returned no result data");
      return { ...handle, data: response.data as T };
    },

    async cancel(handle, operationOptions = {}) {
      const signal = linkedSignal(options.signal, operationOptions.signal);
      await transport.cancel(handle.endpoint, handle.requestId, signal);
    },

    async run<T>(endpoint: string, input: unknown, operationOptions: FalOperationOptions = {}) {
      const handle = await client.submit(endpoint, input, operationOptions);
      await client.wait(handle, operationOptions);
      return client.result<T>(handle, operationOptions);
    },
  };

  return client;
}
