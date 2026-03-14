import fs from "fs";
import path from "path";
import os from "os";

/**
 * Get the base temp directory for studio pipeline jobs.
 */
export function getStudioTempDir(): string {
  const dir = path.join(os.tmpdir(), "studio-pipeline");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a job-specific working directory.
 */
export function createJobDir(jobId: string): string {
  const dir = path.join(getStudioTempDir(), jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Clean up a job's temp directory.
 */
export function cleanupJobDir(jobId: string): void {
  const dir = path.join(getStudioTempDir(), jobId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Validate that a file extension is an allowed document type.
 */
export function isAllowedDocumentType(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ext === ".pdf" || ext === ".pptx";
}

/**
 * Get document type from filename.
 */
export function getDocumentType(filename: string): "pdf" | "pptx" {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".pptx") return "pptx";
  throw new Error(`Unsupported file type: ${ext}`);
}
