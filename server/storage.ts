import { db } from "./db";
import { eq, desc, and } from "drizzle-orm";
import {
  monetizationItems,
  youtubeConnections,
  allowedUsers,
  videoIndex,
  detectedSurfaces,
  type MonetizationItem,
  type InsertMonetizationItem,
  type YoutubeConnection,
  type InsertYoutubeConnection,
  type AllowedUser,
  type InsertAllowedUser,
  type VideoIndex,
  type InsertVideoIndex,
  type DetectedSurface,
  type InsertDetectedSurface,
} from "@shared/schema";
import { encrypt, decrypt } from "./encryption";

export interface IStorage {
  getMonetizationItems(): Promise<MonetizationItem[]>;
  createMonetizationItem(item: InsertMonetizationItem): Promise<MonetizationItem>;
  getYoutubeConnection(userId: string): Promise<YoutubeConnection | undefined>;
  upsertYoutubeConnection(connection: InsertYoutubeConnection): Promise<YoutubeConnection>;
  deleteYoutubeConnection(userId: string): Promise<void>;
  isEmailAllowed(email: string): Promise<boolean>;
  addAllowedUser(user: InsertAllowedUser): Promise<AllowedUser>;
  getAllowedUsers(): Promise<AllowedUser[]>;
  getVideoIndex(userId: string): Promise<VideoIndex[]>;
  upsertVideoIndex(video: InsertVideoIndex): Promise<VideoIndex>;
  bulkUpsertVideoIndex(videos: InsertVideoIndex[]): Promise<void>;
  deleteVideoIndex(userId: string): Promise<void>;
  getVideoById(id: number): Promise<VideoIndex | undefined>;
  getPendingVideos(userId: string, limit?: number): Promise<VideoIndex[]>;
  updateVideoStatus(videoId: number, status: string): Promise<void>;
  insertDetectedSurface(surface: InsertDetectedSurface): Promise<DetectedSurface>;
  getDetectedSurfaces(videoId: number): Promise<DetectedSurface[]>;
  getSurfaceCountByVideo(videoId: number): Promise<number>;
  clearDetectedSurfaces(videoId: number): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getMonetizationItems(): Promise<MonetizationItem[]> {
    return await db.select().from(monetizationItems);
  }

  async createMonetizationItem(item: InsertMonetizationItem): Promise<MonetizationItem> {
    const [newItem] = await db
      .insert(monetizationItems)
      .values(item)
      .returning();
    return newItem;
  }

  async getYoutubeConnection(userId: string): Promise<YoutubeConnection | undefined> {
    const [connection] = await db
      .select()
      .from(youtubeConnections)
      .where(eq(youtubeConnections.userId, userId));
    
    if (connection) {
      try {
        return {
          ...connection,
          accessToken: decrypt(connection.accessToken),
          refreshToken: connection.refreshToken ? decrypt(connection.refreshToken) : null,
        };
      } catch {
        return connection;
      }
    }
    return connection;
  }

  async upsertYoutubeConnection(connection: InsertYoutubeConnection): Promise<YoutubeConnection> {
    const encryptedConnection = {
      ...connection,
      accessToken: encrypt(connection.accessToken),
      refreshToken: connection.refreshToken ? encrypt(connection.refreshToken) : null,
    };
    
    const [result] = await db
      .insert(youtubeConnections)
      .values(encryptedConnection)
      .onConflictDoUpdate({
        target: youtubeConnections.userId,
        set: {
          accessToken: encryptedConnection.accessToken,
          refreshToken: encryptedConnection.refreshToken,
          expiresAt: connection.expiresAt,
          channelId: connection.channelId,
          channelTitle: connection.channelTitle,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result;
  }

  async deleteYoutubeConnection(userId: string): Promise<void> {
    await db.delete(youtubeConnections).where(eq(youtubeConnections.userId, userId));
  }

  async isEmailAllowed(email: string): Promise<boolean> {
    const normalizedEmail = email.toLowerCase().trim();
    const [user] = await db
      .select()
      .from(allowedUsers)
      .where(eq(allowedUsers.email, normalizedEmail));
    return !!user;
  }

  async addAllowedUser(user: InsertAllowedUser): Promise<AllowedUser> {
    const [newUser] = await db
      .insert(allowedUsers)
      .values({ ...user, email: user.email.toLowerCase().trim() })
      .returning();
    return newUser;
  }

  async getAllowedUsers(): Promise<AllowedUser[]> {
    return await db.select().from(allowedUsers);
  }

  async getVideoIndex(userId: string): Promise<VideoIndex[]> {
    return await db
      .select()
      .from(videoIndex)
      .where(eq(videoIndex.userId, userId))
      .orderBy(desc(videoIndex.priorityScore));
  }

  async upsertVideoIndex(video: InsertVideoIndex): Promise<VideoIndex> {
    const [existing] = await db
      .select()
      .from(videoIndex)
      .where(and(
        eq(videoIndex.userId, video.userId),
        eq(videoIndex.youtubeId, video.youtubeId)
      ));
    
    if (existing) {
      const [updated] = await db
        .update(videoIndex)
        .set({
          title: video.title,
          description: video.description,
          viewCount: video.viewCount,
          thumbnailUrl: video.thumbnailUrl,
          status: video.status,
          priorityScore: video.priorityScore,
          publishedAt: video.publishedAt,
          category: video.category,
          isEvergreen: video.isEvergreen,
          duration: video.duration,
          updatedAt: new Date(),
        })
        .where(eq(videoIndex.id, existing.id))
        .returning();
      return updated;
    }
    
    const [result] = await db
      .insert(videoIndex)
      .values(video)
      .returning();
    return result;
  }

  async bulkUpsertVideoIndex(videos: InsertVideoIndex[]): Promise<void> {
    if (videos.length === 0) return;
    
    for (const video of videos) {
      await this.upsertVideoIndex(video);
    }
  }

  async deleteVideoIndex(userId: string): Promise<void> {
    await db.delete(videoIndex).where(eq(videoIndex.userId, userId));
  }

  async getVideoById(id: number): Promise<VideoIndex | undefined> {
    const [video] = await db
      .select()
      .from(videoIndex)
      .where(eq(videoIndex.id, id));
    return video;
  }

  async getPendingVideos(userId: string, limit: number = 10): Promise<VideoIndex[]> {
    return await db
      .select()
      .from(videoIndex)
      .where(and(
        eq(videoIndex.userId, userId),
        eq(videoIndex.status, "Pending Scan")
      ))
      .orderBy(desc(videoIndex.priorityScore))
      .limit(limit);
  }

  async updateVideoStatus(videoId: number, status: string): Promise<void> {
    await db
      .update(videoIndex)
      .set({ status, updatedAt: new Date() })
      .where(eq(videoIndex.id, videoId));
  }

  async insertDetectedSurface(surface: InsertDetectedSurface): Promise<DetectedSurface> {
    const [result] = await db
      .insert(detectedSurfaces)
      .values(surface)
      .returning();
    return result;
  }

  async getDetectedSurfaces(videoId: number): Promise<DetectedSurface[]> {
    return await db
      .select()
      .from(detectedSurfaces)
      .where(eq(detectedSurfaces.videoId, videoId))
      .orderBy(detectedSurfaces.timestamp);
  }

  async getSurfaceCountByVideo(videoId: number): Promise<number> {
    const surfaces = await db
      .select()
      .from(detectedSurfaces)
      .where(eq(detectedSurfaces.videoId, videoId));
    return surfaces.length;
  }

  async clearDetectedSurfaces(videoId: number): Promise<void> {
    await db.delete(detectedSurfaces).where(eq(detectedSurfaces.videoId, videoId));
  }
}

export const storage = new DatabaseStorage();
