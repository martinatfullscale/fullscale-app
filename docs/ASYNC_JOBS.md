# Background work: the one async-job pattern

Every long server action in FullScale — publishing a clip, analysing a
transcript, searching it, re-rendering a clip, stitching a reel, running a
remix — follows the same contract. This document is the contract.

## The contract

1. **The request only validates and records.** It never holds the HTTP
   connection open for the work. It returns `202 Accepted` with a job
   reference:

   ```json
   { "success": true, "pending": true, "job": { "kind": "publish", "id": 123 } }
   ```

   A `409` for "already running" carries the same `job` reference so the
   client can adopt the running job instead of showing an error.

2. **State lives in the row that already holds the output.** There is no
   generic jobs table. `published_posts.status`, `editorial_clips.renderStatus`,
   `video_index.editorialStatus`, `stitch_plans.status`, `remix_jobs.status`
   are the sources of truth. (`studio_jobs` is the cautionary tale: a generic
   table nothing writes to.) Results that are *not* persisted anywhere —
   transcript search — use the in-memory registry in
   `server/lib/jobs/ephemeralJobs.ts`, which forgets on restart by design.

3. **One read endpoint normalises all of them.**
   `GET /api/jobs/:kind/:id` →

   ```ts
   { kind, id, state: "queued" | "running" | "succeeded" | "failed" | "cancelled",
     stage?, progress?, error?, updatedAt?, stale?, result? }
   ```

   Ownership is resolved through the owning video (`ownsVideo`), never
   through the integer `userId` columns (those are `stableUserIntId` hashes
   that differ between the UUID and email forms of one account).

4. **Staleness, not boot sweeps, decides what is dead.** A row that says
   "running" but has not been touched past its kind's threshold is reported
   as failed by the job view and flipped to failed by a recurring sweep
   (`failStalePublishingPosts`, `failStaleClipRenders`, `failStuckScans`).
   Boot-time "anything non-terminal is dead" sweeps misfire through the
   Replit deploy overlap, where the old process is still working.

5. **The client has one hook.** `useJobPoll(job, { onTerminal, onTimeout })`
   in `client/src/hooks/use-job-poll.ts` polls the job view, stops on a
   terminal state / hard 404 / max wait, cleans up on unmount (it is a
   react-query query, not a bare `setInterval`), and fires `onTerminal` once.

## Kinds

| kind          | id                    | backing row                      | running while            | stale after |
|---------------|-----------------------|----------------------------------|--------------------------|-------------|
| `publish`     | `published_posts.id`  | `published_posts.status`         | `publishing`             | 25 min      |
| `clip-render` | `editorial_clips.id`  | `editorial_clips.renderStatus`   | `rendering`              | 30 min (`render_started_at`) |
| `editorial`   | `video_index.id`      | `video_index.editorialStatus`    | pending…rendering        | 5 min (`updated_at`) |
| `stitch`      | `stitch_plans.id`     | `stitch_plans.status`            | `generating`             | boot sweep (deferred) |
| `remix`       | `remix_jobs.id`       | `remix_jobs.status`              | anything non-terminal    | boot sweep  |
| `search`      | ephemeral string      | in-memory registry               | until the promise settles| 30 min      |

**Schema:** `clip-render` staleness reads `editorial_clips.render_started_at`
(added 2026-09-02). Like every schema change here it ships via `npm run
db:push` / the Replit publish-flow migrations step; there is no migration
file. Until the column exists every `editorial_clips` read fails loudly
(the feed returns 503 "until the database update finishes").

## Who acks with what

- `POST /api/distribution/publish` → `202 { job: publish }`. Inserts the
  `publishing` row first; that row is also the durable duplicate guard.
- `POST /api/scenes/:videoId/editorial-analysis` → `202 { job: editorial }`.
  Sets `editorialStatus = analyzing`, saves clips, sets `ready`.
- `POST /api/videos/:videoId/editorial-search` → `202 { job: search }`.
- `POST /api/editorial-clips/:id/rerender` and
  `POST /api/videos/:videoId/editorial-clip/render` → `202 { job: clip-render }`.
- `POST /api/remix/reel`, `POST /api/remix/:videoId/stitch` → `{ planId }`
  (poll `stitch/:planId`).
- `POST /api/remix/:videoId/start` → `{ jobId }` (poll `remix/:jobId`).

## Adding a new kind

1. Make the trigger route write its in-flight state to the entity row (or
   `startEphemeralJob` if nothing persists the result), then respond `202`
   with `{ job: { kind, id } }`.
2. Add a `case` to `GET /api/jobs/:kind/:id` in `server/routes.ts` that maps
   the row's status vocabulary onto the five states and resolves ownership
   via the owning video.
3. If the row can be stranded by a restart, give it a heartbeat column and
   add it to the recurring stale sweep next to `failStaleClipRenders`.
4. On the client, call `useJobPoll` with the returned job. Do not write a
   `setInterval`.

## Why not a jobs table

Five pipelines already own their state rows, and those rows also hold the
outputs (`exportPath`, `outputPath`, `generatedClipId`, `postUrl`). A
separate jobs table would be a second source of truth that every pipeline
has to dual-write — and the one that already exists (`studio_jobs`) proves
what happens: nothing writes it. Generalising the *rules* (ack-and-detach,
sticky terminal states, staleness, one view, one hook) gets the benefit
without the drift.
