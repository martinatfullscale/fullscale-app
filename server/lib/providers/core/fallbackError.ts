import {
  type SerializedProviderError,
  classifyProviderError,
} from "./errors.js";
import { redactSensitive } from "./redact.js";

export interface ProviderAttemptFailure {
  provider: string;
  operation: string;
  attempt?: number;
  error: unknown;
}

export interface SerializedAggregateProviderError {
  name: "AggregateProviderError";
  message: string;
  attempts: SerializedProviderError[];
}

export class AggregateProviderError extends Error {
  override readonly name = "AggregateProviderError";
  readonly failures: readonly ProviderAttemptFailure[];
  override readonly cause: unknown;

  constructor(message: string, failures: readonly ProviderAttemptFailure[]) {
    super(message);
    if (failures.length === 0) {
      throw new RangeError("AggregateProviderError requires at least one provider attempt");
    }
    this.failures = [...failures];
    this.cause = failures[0].error;
  }

  toJSON(): SerializedAggregateProviderError {
    return {
      name: "AggregateProviderError",
      message: redactSensitive(this.message) as string,
      attempts: this.failures.map((failure) => classifyProviderError(
        failure.error,
        {
          provider: failure.provider,
          operation: failure.operation,
          attempt: failure.attempt,
        },
      ).toJSON()),
    };
  }
}
