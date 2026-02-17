import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { storage } from '../storage';
import { uploadFileToStorage, downloadToTempFile } from './objectStorage';

export async function extractThumbnail(videoPath: string, videoId: number): Promise<string | null> {
  let resolvedVideoPath = videoPath;
  let tempVideoFile: string | null = null;

  if (videoPath.startsWith('/storage/')) {
    try {
      const objectKey = videoPath.replace(/^\/storage\//, 'public/');
      tempVideoFile = await downloadToTempFile(objectKey);
      resolvedVideoPath = tempVideoFile;
      console.log(`[ThumbnailExtractor] Downloaded from Object Storage: ${resolvedVideoPath}`);
    } catch (e: any) {
      console.error(`[ThumbnailExtractor] Object Storage download failed:`, e.message);
      return null;
    }
  } else {
    resolvedVideoPath = path.resolve(videoPath);
    if (!fs.existsSync(resolvedVideoPath)) {
      console.error(`[ThumbnailExtractor] Video not found: ${resolvedVideoPath}`);
      return null;
    }
  }

  const thumbnailFilename = `thumbnail_${videoId}_${Date.now()}.jpg`;
  const tempDir = os.tmpdir();
  const tempThumbnailPath = path.join(tempDir, thumbnailFilename);

  console.log(`[ThumbnailExtractor] Extracting thumbnail from: ${resolvedVideoPath}`);

  const result = await new Promise<string | null>((resolve) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', resolvedVideoPath,
      '-ss', '2',
      '-vframes', '1',
      '-vf', 'scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2',
      '-q:v', '2',
      '-y',
      tempThumbnailPath
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    ffmpeg.on('close', async (code) => {
      if (code === 0 && fs.existsSync(tempThumbnailPath)) {
        try {
          const objectKey = `public/thumbnails/${thumbnailFilename}`;
          const serveUrl = await uploadFileToStorage(tempThumbnailPath, objectKey);
          console.log(`[ThumbnailExtractor] Uploaded to Object Storage: ${serveUrl}`);
          fs.unlinkSync(tempThumbnailPath);
          resolve(serveUrl);
        } catch (uploadErr: any) {
          console.error(`[ThumbnailExtractor] Upload failed:`, uploadErr.message);
          fs.unlinkSync(tempThumbnailPath);
          resolve(null);
        }
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

  if (tempVideoFile) {
    try { fs.unlinkSync(tempVideoFile); } catch {}
  }

  return result;
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
  const videosWithFiles = videos.filter(v => v.filePath);

  console.log(`[ThumbnailExtractor] Found ${videosWithFiles.length} videos with file paths`);

  let processed = 0;
  let failed = 0;

  for (const video of videosWithFiles) {
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
