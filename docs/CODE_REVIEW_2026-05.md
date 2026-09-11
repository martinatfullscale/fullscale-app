# Code Review — May 2026

Full-codebase review across four dimensions: security, backend architecture,
video pipeline, client. Conducted with Fable 5. This doc is the durable record;
findings are ranked by severity/impact within each section.

Legend: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low/health · ✅ already fixed

---

## Tier 0 — Fixed during the review

- ✅ **FB/IG token exfiltration** via `/api/debug/fb-insights-test` (+ `facebook-session`, `test-fb-update`). Decrypted a user's Facebook token and returned Page access tokens in the HTTP body, reachable via ungated `?admin_email=`. All three debug endpoints removed. (commit `001bd6c`)
- ✅ **Unauthenticated admin bypass** via `/api/admin/provision-test-creator?admin_email=`. Now session/OIDC only. (commit `001bd6c`)

**Manual follow-ups required (cannot be done in code):**
- Rotate `test-creator@gofullscale.co` password — hardcoded in git history.
- Rotate FB/IG tokens (disconnect+reconnect Facebook once) — the debug endpoint was live.

---

## Tier 1 — Security still open + runtime crashers (small, high-impact)

### 🟠 Placement IDOR — any logged-in user can edit/delete any placement
`PATCH` and `DELETE /api/placements/:id` (routes.ts ~8718 / ~8760) have zero ownership check. Any authenticated creator/brand can iterate placement IDs and rewrite or delete other tenants' paid placements. Fix: load placement, resolve owner, enforce `authUserId`/`authEmail`/`isAdmin` match.

### 🟠 Unauthenticated mutation via `/api/videos/:id/update-path`
No auth middleware at all (routes.ts ~4095). Only gate is that `video.userId` is an admin email — but the request itself is anonymous. An attacker can repoint `filePath`/`thumbnailUrl` on admin-owned (flagship/showcase) videos: defacement, or point thumbnails at attacker images shown on public profiles. Fix: add `isFlexibleAuthenticated` + admin/owner check + validate paths stay in the storage namespace.

### 🟠 Runtime crashers — nonexistent storage methods (shipped, never typechecked)
- `storage.getPlacement(...)` at routes.ts:5695 — does not exist (should be `getPlacementById`). **The bid→placement linking flow 500s.** Core marketplace path.
- `storage.getSurfacesForVideo(...)` at routes.ts:9801/9874/9949 — does not exist. `/api/generate/product-asset` and `/api/generate/composite-preview` crash on invocation.
- Client: `videoDetails` undefined at RemixEngine.tsx:1936-37 — **Share button throws after a Remix export** (misleading "Share failed" toast).

### 🟡 Client-side `?admin_email=` bypass
App.tsx:104-110 sets `isAuthenticated = true` from the URL param with no session. Server data-gating holds, but it exposes the hardcoded admin list (in the bundle 3×) and an authenticated-looking broken shell. Fix: derive `isAdmin` from `/api/auth/user-type`, delete the URL bypass.

### 🟡 No rate limiting anywhere
Only one limiter exists (a single proxy route). `/api/auth/login`, `/api/auth/register`, scan, and upload are unthrottled → credential stuffing, compute-cost abuse (each scan calls a paid model). Fix: `express-rate-limit` globally, stricter on `/api/auth/*` and scan/upload; add `helmet`.

### 🟡 Dev auto-auth footgun
routes.ts:1901-1909 authenticates *anyone* as the first admin whenever `NODE_ENV !== 'production'`. Safe in prod (esbuild inlines `NODE_ENV="production"`), but that inlining is a single point of failure — any switch to running the un-bundled server reopens every gated bypass at once. Gate behind an explicit `ALLOW_DEV_AUTH=1` too.

---

## Tier 2 — The product is blocked here: scan pipeline

### 🔴 (product) Scanning an IG/YouTube import "does nothing"
Not one bug, three stacked:
1. **Download fails silently.** Imports have no local file; the scanner downloads the source to temp (IG via Meta Graph API, YT via yt-dlp), extracts frames, discards. On failure (expired FB token / YT bot-block from Replit's datacenter IP) it writes status `"Pending Upload"` and *returns a failure object instead of throwing.*
2. **Failure wrapped in HTTP 200.** `/api/admin-scan` returns `{ success: true, result: { success: false, error } }`. The modal checks only `res.ok`, drops the real error.
3. **`"Pending Upload"` renders as `"Pending Scan"`.** No UI case → card looks unchanged. Click → "Scan Started" → 3s later "No Surfaces Found" → nothing visibly changed.

Plus: **batch scan is a no-op** — `scanPendingVideos` filters `userId === email`, but imports are keyed by UUID (dual-ID). Zero rows match.

**Fix (~1.5 days):** move `updateVideoStatus("Scanning")` to the top of the scan; make `/api/admin-scan` return non-200 on `result.success === false`; surface `result.error` in the modal; add real `"Scan Failed — Source Unavailable (Reconnect Instagram)"` status + a `"Pending Upload"` UI case; preflight-check FB token validity before replying "Scan started." For YouTube: set `YTDLP_COOKIES` and/or `YTDLP_PROXY` in Replit secrets (code paths exist, dormant). Persist `duration` at import time (already fetched, currently dropped).

### 🟠 (trust) Fake placeholder surfaces on failed scans
When Gemini is down or rate-limited, the scanner pads results with up to 3 **placeholder surfaces** (fixed bottom-40% box, confidence 0.15). A totally failed detection can show **"Ready (3 Spots)"** of junk that brands could browse and bid on. Also: Gemini-unavailable, rate-limited, and genuinely-empty all collapse to `"Ready (0 Spots)"` — indistinguishable. Fix: distinct terminal statuses; drop or visibly flag placeholder surfaces.

### 🟠 (durability) Old uploads 404 forever; no job queue
- New uploads stream to GCS and are durable. **Legacy uploads on local disk are gone** (Replit deploy FS is ephemeral). `migrate-to-object-storage.ts` is a one-off script that uploaded bytes but **never updated `video_index.filePath`**, and the stream endpoint's regex doesn't handle `/storage/`-prefixed paths. Fix: one-time backfill rewriting `filePath` to `/storage/...` where the GCS object exists, else set "Source Missing — Re-upload"; fix stream endpoint to use `objectKeyFromServeUrl`.
- **No job queue.** All background work is in-process `setImmediate`/floating promises. Redeploy kills in-flight scans (stuck at `"Scanning"` forever) and remix jobs (stuck `"queued"`, UI polls a ghost). Minimum: boot-time sweep resetting `"Scanning"`→`"Pending Scan"` and stale jobs→`"failed"`. Real fix: pg-boss (Postgres already present) so work survives deploys and can be rate-limited. Rendering is serial (editorial clips one-by-one, up to 150s each).

---

## Tier 3 — The systemic root cause: dual/triple user-ID chaos

This is the single issue that has produced 4+ auth/lookup bugs this month (public profile videos, category edit, sync scan, batch scan). Worth fixing at the root.

**Three ID shapes in `users.id`:** UUID (current signups), email (legacy), Replit `claims.sub` (numeric). `video_index.user_id` and ~12 other columns hold a *mix*. There's also a **third family**: 7 remix tables use `integer user_id` populated by `parseInt(authUserId) || 1` — garbage today (mostly literal `1`), latent because those tables are queried by `videoId`.

**Why it's fixable safely:** zero FK constraints reference `users.id` — migration is pure data-rewrite, and the existing OR-alias queries match both forms mid-flight, so each phase ships independently.

**Plan (~3 dev-days):**
- Phase 0: inventory + adopt orphan emails into real user rows; build alias map.
- Phase 1: canonicalize `users.id` to UUID, rewriting all 13 varchar columns in one transaction; keep `legacy_id` for Replit session continuity.
- Phase 2: backfill email-keyed rows to UUID per table (dedupe `youtube_connections` UNIQUE conflicts).
- Phase 3: integer remix tables — add `user_uuid`, backfill via `JOIN video_index ON video_id`; delete the `parseInt || 1` lines.
- Phase 4 (payoff): `req.authUserId` is always UUID → delete alias logic (6 storage methods), collapse `isOwner` to single compare (6 sites), single-lookup `getYoutubeConnection` (13 sites).
- Phase 5: add FK constraints + NOT NULL; adopt generated migrations.

Full column inventory and per-table write-sources are in the architecture agent's notes (reproduce on request).

---

## Tier 4 — Health / maintainability (no user-facing bug, real drag)

### Backend
- **routes.ts is 12,394 lines — one function** (`registerRoutes`), 206 routes, auth middleware defined inline (can't be imported/tested). Admin allowlist pasted inline **11×** despite `lib/adminEmails.ts` existing and saying "do not re-introduce inline arrays." Split by URL group into routers (remix/auth/videos first = ~half the pain). Extract `server/middleware/auth.ts`.
- **storage.ts god-interface — 164 methods**, one 2,100-line class. Split into per-domain repos behind a compat `storage` object. Do *after* dual-ID fix.
- **YouTube token-refresh dance duplicated ~13×**; `refreshAccessToken` implemented 3×. `getFreshYoutubeTokenForUser` already encapsulates it. Route all sites through it, delete copies.
- **Error handling:** 197 hand-rolled 500s; global error mw never catches async throws (Express 4) → unhandled handlers *hang the request*. 45 empty `catch {}`. Add `asyncHandler`/`express-async-errors` + a standard `AppError`.
- **Config:** 160 scattered `process.env` reads, 41 vars, no validation, no `.env.example`. One `server/config.ts` with a zod schema, fail-fast at boot.
- **Logging:** 1,690 `console.*`, PII in hot paths (session ID + email at routes.ts:1846; alias dump per library load). Token *values* are correctly redacted. Add pino with a redaction list.

### Client
- **Monster files:** PlacementPreviewModal.tsx (3,961 lines, 43 useState), Landing.tsx (2,080), RemixEngine.tsx (1,978 — a routed page living in `components/`), Library.tsx (1,960). Split highest-ROI first.
- **Scan-progress cache writes go to an orphan query key** (Library.tsx — 6-element key vs the 7-element query key) → live progress never renders; only the coarse 15s poll updates. Also orphaned `setInterval` pollers survive unmount (up to 20 min of background calls after navigating away).
- **Dashboard error state = silent empty UI + 5s hot-retry loop** on a failing endpoint. Add error card + back off `refetchInterval` on error.
- **Auth state needs invalidate-on-change** — login/register are raw fetches that never touch the query cache; the `window.location.href` hard-nav is a band-aid. Convert to mutations with `onSuccess: invalidateQueries`.
- **~600 lines of pitch/demo data interleaved across 5 files, mirrored 3× in different casings** (and demo is a live production fallback when `!user?.id`, not pitch-only). Isolate into one typed fixture module, branch at one seam.
- **7 hand-duplicated Video-ish interfaces**, already diverging (Dashboard vs Library `IndexedVideo` have different fields). Define DTOs once in `shared/`.
- **No ErrorBoundary anywhere** — any render crash whitescreens the SPA. 84 `console.log` ship to prod.
- **90 tsc errors, build never typechecks.** ~85% are config noise (`downlevelIteration` — one tsconfig line fixes ~60); the rest hide the 3 real bugs above. Add `npm run check` to the deploy gate.

### Dead code (safe deletes)
`lib/ai/engine/` (0 importers), `lib/scanWorker.ts` + `lib/surfaceDetector.ts` (TF path, disabled), commented tf-scan route block, ~60% of `lib/scanner.ts` (v1), client `MetricCard`/`MonetizationTable`/`ObjectUploader`/`use-upload`/`use-monetization` (0 importers, ~700 lines). Deps: drop `pdf-parse`, `memorystore`; move 7 `@types/*` to devDependencies. Note: `@tensorflow/tfjs-node` is NOT removable (faceTracker uses it); `cdense/` is NOT dead (rename to reduce confusion with `claude-dense/`).

---

## Recommended sequence

1. **This week — Tier 1** (all small, high-impact): placement IDOR + update-path auth, the 3 runtime crashers, client admin bypass, rate limiting. ~1 day total.
2. **Next — Tier 2 scan fixes**: error propagation + status lifecycle + kill fake surfaces + YT cookies/proxy secrets. Unblocks the core product. ~2 days.
3. **Then — Tier 3 dual-ID migration**: the root fix that stops the recurring auth bugs. ~3 days, incremental/shippable per phase.
4. **Ongoing — Tier 4**: quick wins (adminEmails dedupe, token-refresh dedupe, `.env.example`, `npm run check` gate, dead-code delete) opportunistically; routes.ts/storage.ts splits as you touch each domain.
