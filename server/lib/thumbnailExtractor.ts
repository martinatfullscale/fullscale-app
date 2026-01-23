import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { storage } from '../storage';

const THUMBNAIL_DIR = './public/thumbnails';

if (!fs.existsSync(THUMBNAIL_DIR)) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

export async function extractThumbnail(videoPath: string, videoId: number): Promise<string | null> {
  const absoluteVideoPath = path.resolve(videoPath);
  
  if (!fs.existsSync(absoluteVideoPath)) {
    console.error(`[ThumbnailExtractor] Video not found: ${absoluteVideoPath}`);
    return null;
  }
  
  const thumbnailFilename = `thumbnail_${videoId}_${Date.now()}.jpg`;
  const thumbnailPath = path.join(THUMBNAIL_DIR, thumbnailFilename);
  const absoluteThumbnailPath = path.resolve(thumbnailPath);
  
  console.log(`[ThumbnailExtractor] Extracting thumbnail from: ${absoluteVideoPath}`);
  
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', absoluteVideoPath,
      '-ss', '2',
      '-vframes', '1',
      '-vf', 'scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2',
      '-q:v', '2',
      '-y',
      absoluteThumbnailPath
    ]);
    
    let stderr = '';
    ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });
    
    ffmpeg.on('close', (code) => {
      if (code === 0 && fs.existsSync(absoluteThumbnailPath)) {
        console.log(`[ThumbnailExtractor] Created: ${thumbnailPath}`);
        const publicUrl = `/thumbnails/${thumbnailFilename}`;
        resolve(publicUrl);
      } else {
        console.error(`[ThumbnailExtractor] FFmpeg failed:`, stderr.slice(-300));
        resolve(null);
      }
    });
    
    ffmpeg.on('error', (err) => {
      console.error(`[ThumbnailExtractor] Spawn error:`, err.message);
      resolve(null);
    });
  });
}

export async function updateVideoThumbnail(videoId: number, thumbnailUrl: string): Promise<void> {
  try {
    await storage.updateVideoThumbnail(videoId, thumbnailUrl);
    console.log(`[ThumbnailExtractor] Updated video ${videoId} thumbnail: ${thumbnailUrl}`);
  } catch (err: any) {
    console.error(`[ThumbnailExtractor] Failed to update:`, err.message);
  }
}

export async function extractAndUpdateThumbnails(): Promise<{ processed: number; failed: number }> {
  console.log('[ThumbnailExtractor] Starting batch thumbnail extraction...');
  
  const videos = await storage.getAllVideos();
  
  const videosWithLocalFiles = videos.filter(v => v.filePath && fs.existsSync(v.filePath));
  
  console.log(`[ThumbnailExtractor] Found ${videosWithLocalFiles.length} videos with local files`);
  
  let processed = 0;
  let failed = 0;
  
  for (const video of videosWithLocalFiles) {
    try {
      const thumbnailUrl = await extractThumbnail(video.filePath!, video.id);
      
      if (thumbnailUrl) {
        await updateVideoThumbnail(video.id, thumbnailUrl);
        processed++;
      } else {
        failed++;
      }
    } catch (err: any) {
      console.error(`[ThumbnailExtractor] Error processing video ${video.id}:`, err.message);
      failed++;
    }
  }
  
  console.log(`[ThumbnailExtractor] Complete: ${processed} processed, ${failed} failed`);
  return { processed, failed };
}

export async function extractThumbnailForVideo(videoId: number): Promise<string | null> {
  const video = await storage.getVideoById(videoId);
  
  if (!video || !video.filePath) {
    console.error(`[ThumbnailExtractor] Video ${videoId} not found or has no file path`);
    return null;
  }
  
  const thumbnailUrl = await extractThumbnail(video.filePath, videoId);
  
  if (thumbnailUrl) {
    await updateVideoThumbnail(videoId, thumbnailUrl);
    return thumbnailUrl;
  }
  
  return null;
}
