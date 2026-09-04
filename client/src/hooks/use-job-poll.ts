import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchWithTimeout } from "@/lib/queryClient";

/**
 * The one way the client waits for background work.
 *
 * Every long server action (publish, analysis, search, clip re-render,
 * stitch, remix) acks with a job reference — `{ job: { kind, id } }` on a
 * 202 — and GET /api/jobs/:kind/:id reports the same normalized view for all
 * of them. This hook polls that view until it settles, stops on its own
 * (terminal state, a hard 403/404, or the max wait), cleans up on unmount
 * because it is a query rather than a bare setInterval, and fires
 * `onTerminal` / `onTimeout` exactly once per job.
 *
 * Before this there were eleven hand-rolled setInterval loops with four
 * different ideas of "done" (completed / complete / rendered / ready), two
 * of which leaked on close and one of which could never detect success.
 */

export type JobKind = "publish" | "clip-render" | "editorial" | "stitch" | "remix" | "search";
export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobRef {
  kind: JobKind;
  id: number | string;
}

export interface JobView<R = any> {
  kind: JobKind;
  id: number | string;
  state: JobState;
  /** Pipeline stage or entity status, for progress copy. */
  stage?: string | null;
  /** 0–100 when the producer reports it; null otherwise. */
  progress?: number | null;
  error?: string | null;
  updatedAt?: string | null;
  /** True when the row says "running" but nothing has touched it in a while. */
  stale?: boolean;
  /** Kind-specific payload (the post row, the clip row, plan, job+clips…). */
  result?: R;
}

export const isTerminalJob = (state?: JobState | null): boolean =>
  state === "succeeded" || state === "failed" || state === "cancelled";

export interface UseJobPollOptions<R> {
  /** Poll cadence while the job is live. */
  intervalMs?: number;
  /** Give up (and fire onTimeout) after this long. */
  maxMs?: number;
  onTerminal?: (view: JobView<R>) => void;
  onTimeout?: () => void;
}

export function useJobPoll<R = any>(job: JobRef | null | undefined, opts: UseJobPollOptions<R> = {}) {
  // 20 minutes was comfortably above every render when a reel capped at three
  // minutes. At a 65-minute ceiling it is not: the poll would give up and
  // report a timeout on a job that is still running and will succeed.
  const { intervalMs = 3000, maxMs = 90 * 60_000 } = opts;
  const key = job ? `${job.kind}:${job.id}` : null;

  // Callbacks live in refs so a caller passing inline closures does not
  // restart anything.
  const onTerminalRef = useRef(opts.onTerminal);
  const onTimeoutRef = useRef(opts.onTimeout);
  onTerminalRef.current = opts.onTerminal;
  onTimeoutRef.current = opts.onTimeout;

  // Per-job bookkeeping, reset DURING the render in which the key changes.
  // An effect would be too late: a consumer that has been mounted longer than
  // maxMs (the hub inside Remix Studio, the studio itself) would compute
  // `timedOut` for the brand-new job from the old clock on this very render
  // and fire onTimeout before the first poll ever went out.
  const run = useRef<{ key: string | null; startedAt: number; fired: boolean }>({ key: null, startedAt: 0, fired: false });
  if (run.current.key !== key) run.current = { key, startedAt: Date.now(), fired: false };

  // The deadline is a real timer that forces a render. A render-time
  // comparison alone could never fire: a job whose view is structurally
  // identical poll after poll (a plan still "generating") never re-renders,
  // so the deadline passed silently and the spinner never resolved.
  const [expiredKey, setExpiredKey] = useState<string | null>(null);
  useEffect(() => {
    if (!key) return;
    const t = setTimeout(() => setExpiredKey(key), maxMs);
    return () => clearTimeout(t);
  }, [key, maxMs]);

  const query = useQuery<JobView<R>, Error & { status?: number }>({
    queryKey: ["/api/jobs", job?.kind ?? "", String(job?.id ?? "")],
    enabled: !!job,
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const res = await fetchWithTimeout(`/api/jobs/${job!.kind}/${job!.id}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err: Error & { status?: number } = new Error(body.error || `Job lookup failed (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    refetchInterval: (q) => {
      const data = q.state.data;
      if (data && isTerminalJob(data.state)) return false;
      const status = (q.state.error as any)?.status;
      if (status === 403 || status === 404) return false;
      if (Date.now() - run.current.startedAt > maxMs) return false;
      return intervalMs;
    },
  });

  const view = query.data ?? null;
  const hardError = !!query.error && (query.error.status === 403 || query.error.status === 404);
  const timedOut = !!job && expiredKey === key && !isTerminalJob(view?.state) && !hardError;

  useEffect(() => {
    if (!key || run.current.key !== key || run.current.fired) return;
    if (view && isTerminalJob(view.state)) {
      run.current.fired = true;
      onTerminalRef.current?.(view);
    } else if (hardError) {
      // A job we cannot read is a terminal condition for the caller too:
      // report it as failed rather than spinning on a 404.
      run.current.fired = true;
      onTerminalRef.current?.({
        kind: job!.kind,
        id: job!.id,
        state: "failed",
        error: query.error?.message ?? "Job not found",
      } as JobView<R>);
    } else if (timedOut) {
      run.current.fired = true;
      onTimeoutRef.current?.();
    }
  }, [key, view, timedOut, hardError, job, query.error]);

  return {
    job: view,
    isPolling: !!job && !isTerminalJob(view?.state) && !timedOut && !hardError,
    error: query.error ?? null,
    timedOut,
  };
}
