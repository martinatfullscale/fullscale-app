import * as fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const GRAPH_API_VERSION = "v18.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Strip the platform prefix used in video_index.youtubeId.
// FB imports use "facebook:${id}", IG imports use "instagram:${id}".
export function stripPlatformPrefix(youtubeId: string): string {
  if (youtubeId.startsWith("facebook:")) return youtubeId.slice("facebook:".length);
  if (youtubeId.startsWith("instagram:")) return youtubeId.slice("instagram:".length);
  return youtubeId;
}

async function downloadUrlToFile(url: string, outputPath: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) {
      console.error(`[SocialDownloader] HTTP ${res.status} fetching source URL`);
      return false;
    }
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(outputPath));
    const stat = fs.statSync(outputPath);
    if (stat.size === 0) {
      console.error(`[SocialDownloader] Downloaded file is empty: ${outputPath}`);
      fs.unlinkSync(outputPath);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error(`[SocialDownloader] Download failed: ${err.message}`);
    return false;
  }
}

// Resolve a Facebook video's downloadable mp4 source via the Graph API.
// The `source` field on a video node is a CDN URL hosting the original
// upload — short-lived and signed, so we fetch it on-demand at scan time.
export async function downloadFacebookVideo(
  fbVideoId: string,
  accessToken: string,
  outputPath: string,
): Promise<boolean> {
  const id = stripPlatformPrefix(fbVideoId);
  const url = `${GRAPH_BASE}/${id}?fields=source&access_token=${encodeURIComponent(accessToken)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.error(`[SocialDownloader] FB Graph API error: ${data.error.message}`);
      return false;
    }
    if (!data.source) {
      console.error(`[SocialDownloader] FB video ${id} has no source URL (likely private or expired token)`);
      return false;
    }
    console.log(`[SocialDownloader] Downloading FB video ${id} from CDN`);
    return downloadUrlToFile(data.source, outputPath);
  } catch (err: any) {
    console.error(`[SocialDownloader] FB metadata fetch failed: ${err.message}`);
    return false;
  }
}

// Resolve an Instagram media item's downloadable URL via the Graph API.
// VIDEO and REELS items expose `media_url` pointing at a CDN-hosted mp4;
// IMAGE items have no source video and are skipped upstream.
export async function downloadInstagramVideo(
  igMediaId: string,
  accessToken: string,
  outputPath: string,
): Promise<boolean> {
  const id = stripPlatformPrefix(igMediaId);
  const url = `${GRAPH_BASE}/${id}?fields=media_url,media_type&access_token=${encodeURIComponent(accessToken)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.error(`[SocialDownloader] IG Graph API error: ${data.error.message}`);
      return false;
    }
    if (data.media_type !== "VIDEO" && data.media_type !== "REELS") {
      console.error(`[SocialDownloader] IG media ${id} is ${data.media_type}, not a video`);
      return false;
    }
    if (!data.media_url) {
      console.error(`[SocialDownloader] IG media ${id} has no media_url`);
      return false;
    }
    console.log(`[SocialDownloader] Downloading IG ${data.media_type} ${id} from CDN`);
    return downloadUrlToFile(data.media_url, outputPath);
  } catch (err: any) {
    console.error(`[SocialDownloader] IG metadata fetch failed: ${err.message}`);
    return false;
  }
}
