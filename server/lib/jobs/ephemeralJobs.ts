/**
 * In-memory jobs for work whose RESULT is not persisted anywhere.
 *
 * Most background work in FullScale already has a durable home for its state
 * — a published_posts row, an editorial_clips row, video_index.editorialStatus,
 * a stitch_plans row — and GET /api/jobs/:kind/:id reads those. A few calls
 * produce a result that only ever lived in the HTTP response (transcript
 * search is the one today): making them async needs somewhere to park the
 * result until the client collects it. That is all this is.
 *
 * Deliberately NOT a general job table (see docs/ASYNC_JOBS.md for why): the
 * registry is process-local and forgets on restart, which is the honest scope
 * for results the user can simply re-request. Entries expire on their own.
 */

export type EphemeralJobState = "queued" | "running" | "succeeded" | "failed";

export interface EphemeralJob<R = unknown> {
  id: string;
  kind: string;
  /** Who may read it — compared verbatim on GET. */
  ownerKey: string;
  state: EphemeralJobState;
  error: string | null;
  result: R | null;
  createdAt: number;
  updatedAt: number;
}

/** Terminal entries linger this long so a slow poller still collects them. */
const TERMINAL_TTL_MS = 15 * 60_000;
/** A job still "running" after this is presumed dead (its promise never settled). */
const RUNNING_TTL_MS = 30 * 60_000;

const jobs = new Map<string, EphemeralJob<any>>();

function sweep(): void {
  const now = Date.now();
  jobs.forEach((job, id) => {
    const terminal = job.state === "succeeded" || job.state === "failed";
    const ttl = terminal ? TERMINAL_TTL_MS : RUNNING_TTL_MS;
    if (now - job.updatedAt > ttl) jobs.delete(id);
  });
}

function newId(kind: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${kind}_${Date.now().toString(36)}_${rand}`;
}

/**
 * Register and immediately start a job. The returned record is live — the
 * registry mutates it as `run` settles — so callers can hand its id to the
 * client straight away.
 */
export function startEphemeralJob<R>(
  kind: string,
  ownerKey: string,
  run: () => Promise<R>,
): EphemeralJob<R> {
  sweep();
  const now = Date.now();
  const job: EphemeralJob<R> = {
    id: newId(kind),
    kind,
    ownerKey,
    state: "running",
    error: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  run().then(
    (result) => {
      job.state = "succeeded";
      job.result = result;
      job.updatedAt = Date.now();
    },
    (err: any) => {
      job.state = "failed";
      job.error = err?.message || String(err);
      job.updatedAt = Date.now();
      console.error(`[EphemeralJobs] ${kind} ${job.id} failed:`, job.error);
    },
  );
  return job;
}

export function getEphemeralJob(id: string): EphemeralJob | undefined {
  sweep();
  return jobs.get(id);
}
