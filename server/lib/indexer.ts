import { storage } from "../storage";
import type { InsertVideoIndex, YoutubeConnection } from "@shared/schema";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

interface IndexerOptions {
  minViews?: number;
  maxAgeMonths?: number;
}

const DEFAULT_OPTIONS: IndexerOptions = {
  minViews: 0,
  maxAgeMonths: 120,
};

const EVERGREEN_KEYWORDS = [
  "how to",
  "how-to",
  "tutorial",
  "guide",
  "review",
  "vlog",
  "explained",
  "tips",
  "walkthrough",
  "lesson",
  "learn",
  "beginner",
  "basics",
];

interface YouTubePlaylistItem {
  snippet: {
    title: string;
    description: string;
    publishedAt: string;
    thumbnails: {
      high?: { url: string };
      medium?: { url: string };
      default?: { url: string };
    };
    resourceId: {
      videoId: string;
    };
  };
  contentDetails: {
    videoId: string;
  };
}

interface YouTubeVideoStats {
  id: string;
  statistics: {
    viewCount: string;
    likeCount?: string;
    commentCount?: string;
  };
  contentDetails?: {
    duration: string;
  };
}

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number } | null> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function getChannelUploadsPlaylistId(accessToken: string): Promise<string | null> {
  const response = await fetch(
    `${YOUTUBE_API_BASE}/channels?part=contentDetails&mine=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await response.json();
  return data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
}

async function getAllPlaylistItems(
  accessToken: string,
  playlistId: string
): Promise<YouTubePlaylistItem[]> {
  const items: YouTubePlaylistItem[] = [];
  let pageToken = "";
  
  do {
    const url = `${YOUTUBE_API_BASE}/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json();
    
    if (data.items) {
      items.push(...data.items);
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  
  return items;
}

async function getVideoStatsBatch(
  accessToken: string,
  videoIds: string[]
): Promise<Map<string, YouTubeVideoStats>> {
  const statsMap = new Map<string, YouTubeVideoStats>();
  
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = `${YOUTUBE_API_BASE}/videos?part=statistics,contentDetails&id=${batch.join(",")}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json();
    
    if (data.items) {
      for (const item of data.items) {
        statsMap.set(item.id, item);
      }
    }
  }
  
  return statsMap;
}

function isEvergreen(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  return EVERGREEN_KEYWORDS.some(keyword => text.includes(keyword));
}

function detectCategory(title: string, description: string): string {
  const text = `${title} ${description}`.toLowerCase();
  
  if (text.includes("tutorial") || text.includes("how to") || text.includes("how-to")) {
    return "Tutorial";
  }
  if (text.includes("review")) {
    return "Review";
  }
  if (text.includes("vlog")) {
    return "Vlog";
  }
  if (text.includes("unboxing")) {
    return "Unboxing";
  }
  if (text.includes("interview")) {
    return "Interview";
  }
  if (text.includes("podcast")) {
    return "Podcast";
  }
  return "General";
}

function calculatePriorityScore(
  viewCount: number,
  publishedAt: Date,
  isEvergreenContent: boolean
): number {
  let score = 0;
  
  const viewScore = Math.min(Math.floor(viewCount / 1000), 100);
  score += viewScore;
  
  const now = new Date();
  const ageMonths = (now.getTime() - publishedAt.getTime()) / (1000 * 60 * 60 * 24 * 30);
  if (ageMonths <= 6) {
    score += 30;
  } else if (ageMonths <= 12) {
    score += 20;
  } else if (ageMonths <= 24) {
    score += 10;
  }
  
  if (isEvergreenContent) {
    score += 25;
  }
  
  return score;
}

export async function runIndexerForUser(
  userId: string,
  options: IndexerOptions = {}
): Promise<{ indexed: number; filtered: number; error?: string }> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  console.log(`[Indexer] Starting indexer for user: ${userId}`);
  
  try {
    const connection = await storage.getYoutubeConnection(userId);
    if (!connection) {
      console.log(`[Indexer] No YouTube connection found for user: ${userId}`);
      return { indexed: 0, filtered: 0, error: "No YouTube connection" };
    }
    
    let accessToken = connection.accessToken;
    
    if (connection.expiresAt && new Date(connection.expiresAt) < new Date()) {
      console.log(`[Indexer] Token expired, refreshing...`);
      if (!connection.refreshToken) {
        return { indexed: 0, filtered: 0, error: "Token expired and no refresh token" };
      }
      const newTokens = await refreshAccessToken(connection.refreshToken);
      if (!newTokens) {
        return { indexed: 0, filtered: 0, error: "Failed to refresh token" };
      }
      accessToken = newTokens.access_token;
      
      await storage.upsertYoutubeConnection({
        userId,
        accessToken: newTokens.access_token,
        refreshToken: connection.refreshToken,
        expiresAt: new Date(Date.now() + newTokens.expires_in * 1000),
        channelId: connection.channelId,
        channelTitle: connection.channelTitle,
      });
    }
    
    const uploadsPlaylistId = await getChannelUploadsPlaylistId(accessToken);
    if (!uploadsPlaylistId) {
      console.log(`[Indexer] Could not find uploads playlist`);
      return { indexed: 0, filtered: 0, error: "Could not find uploads playlist" };
    }
    
    console.log(`[Indexer] Fetching all playlist items from uploads playlist: ${uploadsPlaylistId}`);
    const allPlaylistItems = await getAllPlaylistItems(accessToken, uploadsPlaylistId);
    console.log(`[Indexer] YouTube API returned ${allPlaylistItems.length} total videos`);
    
    const playlistItems = allPlaylistItems
      .sort((a, b) => new Date(b.snippet.publishedAt).getTime() - new Date(a.snippet.publishedAt).getTime())
      .slice(0, 10);
    console.log(`[Indexer] Processing top ${playlistItems.length} most recent videos for indexing`);
    
    const videoIds = playlistItems.map(item => item.contentDetails.videoId);
    console.log(`[Indexer] Fetching stats for ${videoIds.length} videos...`);
    const statsMap = await getVideoStatsBatch(accessToken, videoIds);
    
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - (opts.maxAgeMonths || 24));
    
    const videosToIndex: InsertVideoIndex[] = [];
    let filteredCount = 0;
    
    for (const item of playlistItems) {
      const videoId = item.contentDetails.videoId;
      const title = item.snippet.title;
      const description = item.snippet.description || "";
      const stats = statsMap.get(videoId);
      const publishedAt = new Date(item.snippet.publishedAt);
      const viewCount = parseInt(stats?.statistics?.viewCount || "0", 10);
      
      console.log(`[Indexer] Video: "${title}" | Views: ${viewCount} | Published: ${publishedAt.toISOString()}`);
      
      if (opts.minViews && opts.minViews > 0 && viewCount < opts.minViews) {
        console.log(`[Indexer]   -> Filtered: views (${viewCount}) below minimum (${opts.minViews})`);
        filteredCount++;
        continue;
      }
      
      if (opts.maxAgeMonths && opts.maxAgeMonths < 120 && publishedAt < cutoffDate) {
        console.log(`[Indexer]   -> Filtered: too old (published before ${cutoffDate.toISOString()})`);
        filteredCount++;
        continue;
      }
      const evergreenStatus = isEvergreen(title, description);
      const category = detectCategory(title, description);
      const priorityScore = calculatePriorityScore(viewCount, publishedAt, evergreenStatus);
      
      const thumbnail = 
        item.snippet.thumbnails?.high?.url ||
        item.snippet.thumbnails?.medium?.url ||
        item.snippet.thumbnails?.default?.url ||
        null;
      
      videosToIndex.push({
        userId,
        youtubeId: videoId,
        title,
        description: description.substring(0, 500),
        viewCount,
        thumbnailUrl: thumbnail,
        status: "Pending Scan",
        priorityScore,
        publishedAt,
        category,
        isEvergreen: evergreenStatus,
        duration: stats?.contentDetails?.duration || null,
      });
    }
    
    console.log(`[Indexer] ===== SUMMARY =====`);
    console.log(`[Indexer] YouTube API returned: ${allPlaylistItems.length} total videos`);
    console.log(`[Indexer] Processed (top 10 recent): ${playlistItems.length} videos`);
    console.log(`[Indexer] Passed filters: ${videosToIndex.length} videos`);
    console.log(`[Indexer] Filtered out: ${filteredCount} videos`);
    
    if (videosToIndex.length > 0) {
      console.log(`[Indexer] Writing ${videosToIndex.length} videos to database...`);
      videosToIndex.forEach((v, i) => {
        console.log(`[Indexer]   ${i + 1}. "${v.title}" (${v.viewCount} views)`);
      });
      await storage.bulkUpsertVideoIndex(videosToIndex);
      console.log(`[Indexer] Database write complete!`);
    } else {
      console.log(`[Indexer] WARNING: No videos to write to database!`);
    }
    
    console.log(`[Indexer] Indexing complete for user: ${userId}`);
    return { indexed: videosToIndex.length, filtered: filteredCount };
    
  } catch (error: any) {
    console.error(`[Indexer] Error indexing videos for user ${userId}:`, error.message || error);
    return { indexed: 0, filtered: 0, error: error.message || "Unknown error" };
  }
}
