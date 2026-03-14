import type { Express } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import os from "os";
import { runPipeline } from "../pipeline/index.js";
import {
  createJob,
  updateJob,
  getJob,
  completeJob,
  failJob,
  type JobState,
} from "../utils/jobManager.js";
import { isAllowedDocumentType, getDocumentType } from "../utils/fileHelpers.js";

// Configure multer for document uploads
const studioUploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const tmpDir = path.join(os.tmpdir(), "studio-uploads");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    cb(null, tmpDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `studio-${uniqueSuffix}${ext}`);
  },
});

const studioUpload = multer({
  storage: studioUploadStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (_req, file, cb) => {
    if (isAllowedDocumentType(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and PPTX files are allowed"));
    }
  },
});

/**
 * Register Studio API routes on the existing Express app.
 * Follows the same pattern as the main fullscale-app routes.
 */
export function registerStudioRoutes(app: Express): void {
  /**
   * POST /api/studio/videos/upload
   * Accepts multipart/form-data { file }
   * Creates a job, fires pipeline in background, returns jobId.
   */
  app.post(
    "/api/studio/videos/upload",
    studioUpload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "No file uploaded" });
        }

        const documentType = getDocumentType(req.file.originalname);
        const documentBuffer = fs.readFileSync(req.file.path);

        // Generate a job ID
        const { randomUUID } = await import("crypto");
        const jobId = randomUUID();

        // Create job record
        createJob(jobId);

        // Fire pipeline in background (don't await)
        runPipelineInBackground(jobId, documentBuffer, documentType);

        // Clean up the uploaded temp file
        try {
          fs.unlinkSync(req.file.path);
        } catch {}

        res.json({
          jobId,
          videoId: jobId, // In MVP, jobId === videoId
          status: "queued",
        });
      } catch (err: any) {
        console.error("[Studio] Upload error:", err);
        res.status(500).json({ error: err.message || "Upload failed" });
      }
    }
  );

  /**
   * GET /api/studio/videos/:id/status
   * Returns current job status with stage and progress.
   */
  app.get("/api/studio/videos/:id/status", (req, res) => {
    const jobId = req.params.id;
    const job = getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json({
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      metadata: job.metadata || null,
      error: job.error || null,
    });
  });

  /**
   * GET /api/studio/videos/:id/download
   * Streams the completed MP4 file.
   */
  app.get("/api/studio/videos/:id/download", (req, res) => {
    const jobId = req.params.id;
    const job = getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (job.status !== "complete") {
      return res.status(400).json({
        error: "Video not ready",
        status: job.status,
      });
    }

    if (!job.outputPath || !fs.existsSync(job.outputPath)) {
      return res.status(404).json({ error: "Output file not found" });
    }

    const stat = fs.statSync(job.outputPath);
    const filename = `${job.metadata?.title || "studio-video"}.mp4`
      .replace(/[^a-zA-Z0-9._-]/g, "_");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    fs.createReadStream(job.outputPath).pipe(res);
  });

  console.log("[Studio] Routes registered: /api/studio/videos/*");
}

/**
 * Run the pipeline as a background task, updating job state at each stage.
 */
async function runPipelineInBackground(
  jobId: string,
  documentBuffer: Buffer,
  documentType: "pdf" | "pptx"
): Promise<void> {
  try {
    const result = await runPipeline(documentBuffer, documentType, {
      onStageChange: (stage, progress) => {
        // Map pipeline stage names to job status values
        const statusMap: Record<string, JobState["status"]> = {
          parsing: "parsing",
          extracting: "extracting",
          generating: "generating",
          "adding-voice": "adding-voice",
          assembling: "assembling",
          complete: "complete",
          failed: "failed",
        };

        updateJob(jobId, {
          status: statusMap[stage] || "parsing",
          stage,
          progress,
        });
      },
    });

    completeJob(jobId, result.outputPath, result.metadata);
  } catch (err: any) {
    console.error(`[Studio] Pipeline failed for job ${jobId}:`, err);
    failJob(jobId, err.message || "Pipeline failed");
  }
}
