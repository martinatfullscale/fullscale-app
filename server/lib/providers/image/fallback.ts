import { AggregateProviderError } from "../core/fallbackError.js";
import { classifyProviderError, type ProviderErrorCode } from "../core/errors.js";

export interface ImageGenerationProvider<T> {
  provider: string;
  generate(): Promise<T>;
}

export interface ImageFallbackResult<T> {
  provider: string;
  value: T;
  usedFallback: boolean;
}

const DEFAULT_FALLBACK_CODES = new Set<ProviderErrorCode>([
  "quota",
  "rate_limit",
  "timeout",
  "transient",
  "invalid_response",
  "unavailable",
]);

export async function runImageGenerationFallback<T>(options: {
  primary: ImageGenerationProvider<T>;
  fallback: ImageGenerationProvider<T>;
  fallbackOn?: ReadonlySet<ProviderErrorCode>;
}): Promise<ImageFallbackResult<T>> {
  const operation = "generate-image";
  try {
    return {
      provider: options.primary.provider,
      value: await options.primary.generate(),
      usedFallback: false,
    };
  } catch (primaryError) {
    const primary = classifyProviderError(primaryError, { provider: options.primary.provider, operation });
    if (!(options.fallbackOn ?? DEFAULT_FALLBACK_CODES).has(primary.code)) throw primary;
    try {
      return {
        provider: options.fallback.provider,
        value: await options.fallback.generate(),
        usedFallback: true,
      };
    } catch (fallbackError) {
      throw new AggregateProviderError("Every image-generation provider failed", [
        { provider: options.primary.provider, operation, error: primaryError },
        { provider: options.fallback.provider, operation, error: fallbackError },
      ]);
    }
  }
}
