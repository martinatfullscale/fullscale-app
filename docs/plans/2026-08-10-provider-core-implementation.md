# Provider Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a tested vendor-neutral provider error, retry, deadline, redaction, and aggregate-failure core for FullScale Platform.

**Architecture:** Add isolated utilities under `server/lib/providers/core` with no imports from routes, schemas, persistence, or tasks. Tests run with Node's test runner through the repository's existing `tsx` dependency and use injected clocks, sleeps, and randomness for deterministic behavior.

**Tech Stack:** TypeScript, Node.js 20, `node:test`, `node:assert`, `tsx`

---

### Task 1: Establish the provider error contract

**Files:**
- Create: `server/lib/providers/core/errors.test.ts`
- Create: `server/lib/providers/core/errors.ts`

**Steps:**

1. Write failing tests for explicit error fields, safe JSON serialization, HTTP/status classification, nested fetch causes, and default retryability.
2. Run `npx tsx --test server/lib/providers/core/errors.test.ts` and verify the missing module/API failure.
3. Implement `ProviderError`, `ProviderErrorCode`, `classifyProviderError`, and safe serialization.
4. Re-run the focused test and verify it passes.
5. Commit the error contract.

### Task 2: Redact unsafe provider diagnostics

**Files:**
- Create: `server/lib/providers/core/redact.test.ts`
- Create: `server/lib/providers/core/redact.ts`

**Steps:**

1. Write failing tests for API keys, bearer tokens, signed URLs, nested objects, data URLs, and large base64 strings.
2. Run `npx tsx --test server/lib/providers/core/redact.test.ts` and verify the missing module/API failure.
3. Implement recursive, bounded redaction without mutating caller data.
4. Re-run the focused test and verify it passes.
5. Commit the redaction utility.

### Task 3: Add deadline-aware retries

**Files:**
- Create: `server/lib/providers/core/retry.test.ts`
- Create: `server/lib/providers/core/retry.ts`

**Steps:**

1. Write failing tests for transient recovery, non-retryable failure, maximum attempts, idempotency gating, `Retry-After`, deadline exhaustion, and cancellation during backoff.
2. Run `npx tsx --test server/lib/providers/core/retry.test.ts` and verify the missing module/API failure.
3. Implement `withRetry` with one overall budget, capped exponential backoff, jitter, injected sleep/random/clock, and abort support.
4. Re-run the focused test and verify it passes.
5. Commit the retry utility.

### Task 4: Preserve fallback attempt history

**Files:**
- Create: `server/lib/providers/core/fallbackError.test.ts`
- Create: `server/lib/providers/core/fallbackError.ts`
- Create: `server/lib/providers/core/index.ts`

**Steps:**

1. Write a failing test showing that primary and fallback failures are both serialized safely and in order.
2. Run `npx tsx --test server/lib/providers/core/fallbackError.test.ts` and verify the missing module/API failure.
3. Implement `AggregateProviderError`, attempt records, and the provider-core barrel export.
4. Re-run all provider-core tests and verify they pass.
5. Commit aggregate failure reporting.

### Task 5: Validate the focused PR

**Files:**
- Modify only if required: `package.json`

**Steps:**

1. Run `npx tsx --test server/lib/providers/core/*.test.ts`.
2. Run `npm run check`.
3. Run `git diff --check`.
4. Confirm `git diff origin/main --name-only` contains only provider-core files, tests, and these plan documents.
5. Review the final diff for secret exposure, schema/task imports, and unrelated cleanup.
6. Commit any necessary validation-only adjustment.

### Task 6: Publish for review

**Steps:**

1. Push `codex/provider-core` to `origin`.
2. Open a draft PR against `martinatfullscale/fullscale-app:main`.
3. Include the Studio audit link, explicit exclusions, validation commands, and fail-closed UI evidence.
4. Confirm the GitHub PR shows only the intended files.
