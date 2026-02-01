import { processVideoScan } from './server/scanner_v2';
import { storage } from './server/storage';

async function main() {
  console.log('===== DIRECT SCAN TEST =====');
  console.log('Video ID: 90964');
  
  // Check if video exists
  const video = await storage.getVideoById(90964);
  console.log('Video lookup result:', video ? `Found: ${video.title}` : 'NOT FOUND');
  
  if (!video) {
    console.log('Video not in database - exiting');
    return;
  }
  
  console.log('File path:', video.filePath);
  console.log('Starting scan...');
  
  const result = await processVideoScan(90964, true);
  console.log('===== SCAN RESULT =====');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
