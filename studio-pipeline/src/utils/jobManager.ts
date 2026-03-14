/**
 * In-memory job tracker for MVP.
 * Each job has { status, stage, progress, error, metadata }.
 * The status endpoint reads from this map.
 */

export interface JobState {
  status: "queued" | "parsing" | "extracting" | "generating" | "adding-voice" | "assembling" | "complete" | "failed";
  stage: string;
  progress: number;
  error?: string;
  metadata?: {
    title: string;
    sceneCount: number;
    estimatedDurationSeconds: number;
  };
  outputPath?: string;
  createdAt: number;
}

const jobs = new Map<string, JobState>();

export function createJob(jobId: string): void {
  jobs.set(jobId, {
    status: "queued",
    stage: "queued",
    progress: 0,
    createdAt: Date.now(),
  });
}

export function updateJob(jobId: string, update: Partial<JobState>): void {
  const existing = jobs.get(jobId);
  if (existing) {
    jobs.set(jobId, { ...existing, ...update });
  }
}

export function getJob(jobId: string): JobState | undefined {
  return jobs.get(jobId);
}

export function completeJob(
  jobId: string,
  outputPath: string,
  metadata: JobState["metadata"]
): void {
  updateJob(jobId, {
    status: "complete",
    stage: "complete",
    progress: 100,
    outputPath,
    metadata,
  });
}

export function failJob(jobId: string, error: string): void {
  updateJob(jobId, {
    status: "failed",
    stage: "failed",
    progress: 0,
    error,
  });
}
