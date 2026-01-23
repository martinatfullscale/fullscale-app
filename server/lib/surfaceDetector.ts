import * as tf from '@tensorflow/tfjs-node';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

let model: cocoSsd.ObjectDetection | null = null;
let modelLoading: Promise<cocoSsd.ObjectDetection> | null = null;

const SURFACE_OBJECTS = ['dining table', 'desk', 'bench', 'table'];
const SURROUNDING_OBJECTS = ['laptop', 'keyboard', 'mouse', 'cell phone', 'bottle', 'cup', 'book', 'remote', 'clock', 'vase', 'tv', 'monitor'];
const OBJECT_MAP: Record<string, string> = {
  'dining table': 'desk',
  'bench': 'table',
  'laptop': 'laptop',
  'keyboard': 'keyboard',
  'mouse': 'mouse',
  'cell phone': 'phone',
  'bottle': 'bottle',
  'cup': 'cup',
  'book': 'book',
  'remote': 'remote',
  'clock': 'clock',
  'vase': 'vase',
  'tv': 'monitor',
  'tvmonitor': 'monitor',
};

export interface SurfaceDetectionResult {
  surface: string;
  surroundings: string[];
  confidence: number;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

async function loadModel(): Promise<cocoSsd.ObjectDetection> {
  if (model) return model;
  
  if (modelLoading) {
    return modelLoading;
  }
  
  console.log('[SurfaceDetector] Loading COCO-SSD model...');
  modelLoading = cocoSsd.load({
    base: 'mobilenet_v2'
  });
  
  model = await modelLoading;
  console.log('[SurfaceDetector] COCO-SSD model loaded successfully');
  return model;
}

export async function detectSurfaces(imagePath: string): Promise<SurfaceDetectionResult | 'NO_SURFACES_EXIST'> {
  console.log(`[SurfaceDetector] Analyzing frame: ${imagePath}`);
  
  try {
    const loadedModel = await loadModel();
    
    const imageBuffer = await sharp(imagePath)
      .resize(640, 480, { fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    const { data, info } = imageBuffer;
    const { width, height, channels } = info;
    
    const imageTensor = tf.tensor3d(
      new Uint8Array(data),
      [height, width, channels]
    );
    
    const predictions = await loadedModel.detect(imageTensor as tf.Tensor3D);
    
    imageTensor.dispose();
    
    console.log(`[SurfaceDetector] Found ${predictions.length} objects`);
    predictions.forEach(p => {
      console.log(`[SurfaceDetector]   - ${p.class}: ${(p.score * 100).toFixed(1)}%`);
    });
    
    const surfaces = predictions.filter(p => 
      SURFACE_OBJECTS.includes(p.class.toLowerCase()) && p.score >= 0.3
    );
    
    const surroundings = predictions.filter(p => 
      SURROUNDING_OBJECTS.includes(p.class.toLowerCase()) && p.score >= 0.25
    );
    
    if (surfaces.length === 0 && surroundings.length === 0) {
      console.log('[SurfaceDetector] No surfaces or context objects detected');
      return 'NO_SURFACES_EXIST';
    }
    
    let bestSurface: cocoSsd.DetectedObject | null = null;
    
    if (surfaces.length > 0) {
      bestSurface = surfaces.reduce((a, b) => a.score > b.score ? a : b);
    } else if (surroundings.length > 0) {
      console.log('[SurfaceDetector] No direct surface, inferring from objects...');
      const hasWorkObjects = surroundings.some(s => 
        ['laptop', 'keyboard', 'mouse', 'book'].includes(s.class.toLowerCase())
      );
      if (hasWorkObjects) {
        bestSurface = {
          class: 'desk',
          score: 0.65,
          bbox: [0.1, 0.5, 0.8, 0.45]
        } as cocoSsd.DetectedObject;
      }
    }
    
    if (!bestSurface) {
      return 'NO_SURFACES_EXIST';
    }
    
    const surfaceType = OBJECT_MAP[bestSurface.class.toLowerCase()] || bestSurface.class;
    const surroundingNames = [...new Set(
      surroundings.map(s => OBJECT_MAP[s.class.toLowerCase()] || s.class.toLowerCase())
    )];
    
    const result: SurfaceDetectionResult = {
      surface: surfaceType,
      surroundings: surroundingNames,
      confidence: bestSurface.score,
      boundingBox: bestSurface.bbox ? {
        x: bestSurface.bbox[0] / 640,
        y: bestSurface.bbox[1] / 480,
        width: bestSurface.bbox[2] / 640,
        height: bestSurface.bbox[3] / 480,
      } : undefined
    };
    
    console.log(`[SurfaceDetector] Result: ${JSON.stringify(result)}`);
    return result;
    
  } catch (err: any) {
    console.error(`[SurfaceDetector] Error analyzing frame:`, err.message);
    return 'NO_SURFACES_EXIST';
  }
}

// Extract multiple frames at specified intervals (default every 3 seconds, up to 10 frames)
export async function detectSurfacesFromVideo(videoPath: string, frameInterval: number = 3, maxFrames: number = 10): Promise<SurfaceDetectionResult | 'NO_SURFACES_EXIST'> {
  const { spawn } = await import('child_process');
  const os = await import('os');
  
  console.log(`[SurfaceDetector] Processing video: ${videoPath}`);
  console.log(`[SurfaceDetector] Frame interval: ${frameInterval}s, max frames: ${maxFrames}`);
  
  const absoluteVideoPath = path.resolve(videoPath);
  if (!fs.existsSync(absoluteVideoPath)) {
    console.error(`[SurfaceDetector] Video file not found: ${absoluteVideoPath}`);
    return 'NO_SURFACES_EXIST';
  }
  
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-detect-'));
  
  try {
    // First, get video duration using ffprobe
    let videoDuration = 30; // default fallback
    try {
      const durationResult = await new Promise<string>((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'csv=p=0',
          absoluteVideoPath
        ]);
        let output = '';
        ffprobe.stdout.on('data', (data) => { output += data.toString(); });
        ffprobe.on('close', (code) => code === 0 ? resolve(output.trim()) : reject());
        ffprobe.on('error', reject);
      });
      videoDuration = parseFloat(durationResult) || 30;
      console.log(`[SurfaceDetector] Video duration: ${videoDuration.toFixed(1)}s`);
    } catch {
      console.log(`[SurfaceDetector] Could not get duration, using default: ${videoDuration}s`);
    }
    
    // Calculate frame timestamps (every frameInterval seconds, starting at 1s)
    const timestamps: number[] = [];
    for (let t = 1; t < videoDuration && timestamps.length < maxFrames; t += frameInterval) {
      timestamps.push(t);
    }
    
    console.log(`[SurfaceDetector] Extracting ${timestamps.length} frames at: ${timestamps.map(t => t + 's').join(', ')}`);
    
    // Extract all frames
    const framePaths: string[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const framePath = path.join(tempDir, `frame_${String(i + 1).padStart(3, '0')}.jpg`);
      
      await new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-ss', String(timestamps[i]),
          '-i', absoluteVideoPath,
          '-vframes', '1',
          '-q:v', '2',
          framePath
        ]);
        
        let stderr = '';
        ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });
        
        ffmpeg.on('close', (code) => {
          if (code === 0 && fs.existsSync(framePath)) {
            framePaths.push(framePath);
            resolve();
          } else {
            console.warn(`[SurfaceDetector] Frame at ${timestamps[i]}s failed, skipping`);
            resolve(); // Don't fail, just skip this frame
          }
        });
        
        ffmpeg.on('error', () => resolve()); // Skip on error
      });
    }
    
    console.log(`[SurfaceDetector] Successfully extracted ${framePaths.length} frames`);
    
    if (framePaths.length === 0) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return 'NO_SURFACES_EXIST';
    }
    
    // Analyze each frame and collect all results
    let bestResult: SurfaceDetectionResult | null = null;
    let allSurroundings: string[] = [];
    
    for (const framePath of framePaths) {
      const result = await detectSurfaces(framePath);
      
      if (result !== 'NO_SURFACES_EXIST') {
        // Collect all surroundings from all frames
        allSurroundings = [...allSurroundings, ...result.surroundings];
        
        // Keep the best surface (highest confidence)
        if (!bestResult || result.confidence > bestResult.confidence) {
          bestResult = result;
        }
      }
    }
    
    fs.rmSync(tempDir, { recursive: true, force: true });
    
    if (!bestResult) {
      console.log(`[SurfaceDetector] No surfaces found in any of ${framePaths.length} frames`);
      return 'NO_SURFACES_EXIST';
    }
    
    // Merge unique surroundings from all frames
    bestResult.surroundings = [...new Set([...bestResult.surroundings, ...allSurroundings])];
    
    console.log(`[SurfaceDetector] Best result from ${framePaths.length} frames: ${JSON.stringify(bestResult)}`);
    return bestResult;
    
  } catch (err: any) {
    console.error(`[SurfaceDetector] Video processing error:`, err.message);
    fs.rmSync(tempDir, { recursive: true, force: true });
    return 'NO_SURFACES_EXIST';
  }
}

export async function warmupModel(): Promise<void> {
  try {
    await loadModel();
    console.log('[SurfaceDetector] Model warmed up and ready');
  } catch (err: any) {
    console.error('[SurfaceDetector] Failed to warmup model:', err.message);
  }
}
