import { EventEmitter } from 'events';
import { detectSurfacesFromVideo, SurfaceDetectionResult, warmupModel } from './surfaceDetector';
import { storage } from '../storage';
import * as fs from 'fs';
import * as path from 'path';

interface ScanJob {
  id: string;
  videoId: number;
  filePath: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: SurfaceDetectionResult | 'NO_SURFACES_EXIST';
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

class ScanWorkerQueue extends EventEmitter {
  private queue: ScanJob[] = [];
  private processing = false;
  private maxConcurrent = 1;
  private activeJobs = 0;
  private jobHistory: Map<string, ScanJob> = new Map();
  
  constructor() {
    super();
    console.log('[ScanWorker] Background worker queue initialized');
  }
  
  async initialize(): Promise<void> {
    console.log('[ScanWorker] Warming up TensorFlow model...');
    try {
      await warmupModel();
      console.log('[ScanWorker] Model ready, worker queue active');
    } catch (err: any) {
      console.error('[ScanWorker] Failed to warmup model:', err.message);
    }
  }
  
  addJob(videoId: number, filePath: string): string {
    const jobId = `scan-${videoId}-${Date.now()}`;
    
    const job: ScanJob = {
      id: jobId,
      videoId,
      filePath,
      status: 'pending',
      createdAt: new Date(),
    };
    
    this.queue.push(job);
    this.jobHistory.set(jobId, job);
    
    console.log(`[ScanWorker] Job added: ${jobId} for video ${videoId}`);
    console.log(`[ScanWorker] Queue size: ${this.queue.length}`);
    
    setImmediate(() => this.processQueue());
    
    return jobId;
  }
  
  getJobStatus(jobId: string): ScanJob | undefined {
    return this.jobHistory.get(jobId);
  }
  
  getQueueStatus(): { pending: number; processing: number; completed: number } {
    let pending = 0, processing = 0, completed = 0;
    this.jobHistory.forEach(job => {
      if (job.status === 'pending') pending++;
      else if (job.status === 'processing') processing++;
      else completed++;
    });
    return { pending, processing, completed };
  }
  
  private async processQueue(): Promise<void> {
    if (this.processing || this.activeJobs >= this.maxConcurrent) {
      return;
    }
    
    const job = this.queue.shift();
    if (!job) {
      return;
    }
    
    this.processing = true;
    this.activeJobs++;
    job.status = 'processing';
    
    console.log(`[ScanWorker] Processing job: ${job.id}`);
    
    try {
      if (!fs.existsSync(job.filePath)) {
        throw new Error(`Video file not found: ${job.filePath}`);
      }
      
      const result = await detectSurfacesFromVideo(job.filePath);
      
      job.status = 'completed';
      job.result = result;
      job.completedAt = new Date();
      
      console.log(`[ScanWorker] Job completed: ${job.id}`);
      console.log(`[ScanWorker] Result: ${JSON.stringify(result)}`);
      
      await this.saveScanResult(job.videoId, result);
      
      this.emit('jobComplete', job);
      
    } catch (err: any) {
      job.status = 'failed';
      job.error = err.message;
      job.completedAt = new Date();
      
      console.error(`[ScanWorker] Job failed: ${job.id}`, err.message);
      
      this.emit('jobFailed', job);
    }
    
    this.activeJobs--;
    this.processing = false;
    
    if (this.queue.length > 0) {
      setImmediate(() => this.processQueue());
    }
  }
  
  private async saveScanResult(videoId: number, result: SurfaceDetectionResult | 'NO_SURFACES_EXIST'): Promise<void> {
    try {
      if (result === 'NO_SURFACES_EXIST') {
        await storage.updateVideoStatus(videoId, 'scan_complete');
        console.log(`[ScanWorker] Saved: No surfaces for video ${videoId}`);
      } else {
        await storage.updateVideoStatus(videoId, 'scan_complete');
        
        const boundingBox = result.boundingBox || { x: 0.1, y: 0.5, width: 0.8, height: 0.4 };
        
        const surfaceData = {
          videoId,
          timestamp: '0',
          surfaceType: result.surface,
          confidence: String(result.confidence),
          boundingBoxX: String(boundingBox.x),
          boundingBoxY: String(boundingBox.y),
          boundingBoxWidth: String(boundingBox.width),
          boundingBoxHeight: String(boundingBox.height),
          surroundings: result.surroundings,
          sceneContext: `Detected ${result.surface} with ${result.surroundings.length} surrounding objects`,
        };
        
        await storage.insertDetectedSurface(surfaceData);
        
        console.log(`[ScanWorker] Saved surface: ${result.surface} for video ${videoId}`);
      }
    } catch (err: any) {
      console.error(`[ScanWorker] Failed to save result:`, err.message);
    }
  }
}

export const scanWorker = new ScanWorkerQueue();

export async function initializeScanWorker(): Promise<void> {
  await scanWorker.initialize();
}

export function queueVideoScan(videoId: number, filePath: string): string {
  return scanWorker.addJob(videoId, filePath);
}

export function getScanJobStatus(jobId: string): ScanJob | undefined {
  return scanWorker.getJobStatus(jobId);
}

export function getQueueStatus(): { pending: number; processing: number; completed: number } {
  return scanWorker.getQueueStatus();
}
