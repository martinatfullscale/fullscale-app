# Provider Core Design

## Goal

Add a vendor-neutral provider reliability layer to `fullscale-app` without changing routes, schemas, migrations, queues, or existing provider call sites.

## Architecture

The provider core lives under `server/lib/providers/core`. It contains no FAL, Gemini, database, route, or task imports. Provider adapters will use it later to classify failures, decide whether an operation may retry, enforce one overall deadline, redact unsafe diagnostics, and preserve every attempted provider when a fallback chain fails.

The first PR deliberately lands the core without migrating consumers. This keeps review focused and prevents shared policy from being coupled to one vendor before the contract is approved.

## Public API

- `ProviderError`: structured provider failure with code, provider, operation, status, retryability, attempt, safe details, and internal cause.
- `classifyProviderError`: converts unknown SDK/fetch errors into a `ProviderError` using HTTP status, error name, message, and nested causes.
- `redactSensitive`: recursively redacts credentials, authorization headers, signed URL query values, and large base64/data-URL payloads.
- `withRetry`: runs an async operation under an overall deadline and optional abort signal, using capped exponential backoff with jitter and `Retry-After` support.
- `AggregateProviderError`: preserves safe diagnostics for every attempted provider when a capability-level fallback chain fails.

## Error policy

Retryable by default: network failures, HTTP 408, HTTP 429, and HTTP 500, 502, 503, or 504.

Not retryable by default: authentication, authorization, quota/payment, validation, invalid response, cancellation, and unavailable dependency.

Submission retries additionally require `idempotent: true`; callers must opt in rather than accidentally submitting paid work twice.

## Testing

Tests use Node's built-in test runner through the existing `tsx` development dependency. Sleep, clock, and randomness are injectable so retry tests are deterministic and make no network or paid-provider calls.

## Explicit exclusions

- No database schema or migration changes.
- No task or queue changes.
- No route changes.
- No existing provider integration changes.
- No live FAL or Gemini calls.
- No generic FAL-to-Gemini fallback policy.
