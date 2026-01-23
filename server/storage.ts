import { db } from "./db";
import { eq, desc, and, or, sql } from "drizzle-orm";
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
import { users, type User, type UpsertUser } from "@shared/models/auth";
import { encrypt, decrypt } from "./encryption";

export interface VideoWithOpportunities extends VideoIndex {
  surfaces: DetectedSurface[];
  surfaceCount: number;
  contexts: string[];
}

export interface IStorage {
  // User authentication methods
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserById(id: string): Promise<User | undefined>;
  createUser(user: UpsertUser): Promise<User>;
  upsertUserByEmail(user: UpsertUser): Promise<User>;
  
  // Original methods
  getMonetizationItems(): Promise<MonetizationItem[]>;
  createMonetizationItem(item: InsertMonetizationItem): Promise<MonetizationItem>;
  getYoutubeConnection(userId: string): Promise<YoutubeConnection | undefined>;
  upsertYoutubeConnection(connection: InsertYoutubeConnection): Promise<YoutubeConnection>;
  deleteYoutubeConnection(userId: string, userEmail?: string): Promise<void>;
  isEmailAllowed(email: string): Promise<boolean>;
  addAllowedUser(user: InsertAllowedUser): Promise<AllowedUser>;
  getAllowedUsers(): Promise<AllowedUser[]>;
  getAllowedUser(email: string): Promise<AllowedUser | undefined>;
  updateAllowedUserRole(email: string, userType: string): Promise<void>;
  getVideoIndex(userId: string): Promise<VideoIndex[]>;
  getAllVideos(): Promise<VideoIndex[]>;
  upsertVideoIndex(video: InsertVideoIndex): Promise<VideoIndex>;
  insertVideo(video: InsertVideoIndex): Promise<VideoIndex>;
  bulkUpsertVideoIndex(videos: InsertVideoIndex[]): Promise<void>;
  deleteVideoIndex(userId: string): Promise<void>;
  getVideoById(id: number): Promise<VideoIndex | undefined>;
  getPendingVideos(userId: string, limit?: number): Promise<VideoIndex[]>;
  updateVideoStatus(videoId: number, status: string): Promise<void>;
  updateVideoThumbnail(videoId: number, thumbnailUrl: string): Promise<void>;
  updateVideoMetadata(videoId: number, metadata: { sentiment?: string; culturalContext?: string }): Promise<void>;
  insertDetectedSurface(surface: InsertDetectedSurface): Promise<DetectedSurface>;
  getDetectedSurfaces(videoId: number): Promise<DetectedSurface[]>;
  getSurfaceCountByVideo(videoId: number): Promise<number>;
  clearDetectedSurfaces(videoId: number): Promise<void>;
  getVideosWithOpportunities(userId: string): Promise<VideoWithOpportunities[]>;
  getAllVideosWithOpportunities(): Promise<VideoWithOpportunities[]>;
  getReadyVideosForMarketplace(): Promise<VideoWithOpportunities[]>;
  createBid(bid: InsertMonetizationItem): Promise<MonetizationItem>;
  getActiveBidsForCreator(creatorUserId: string): Promise<MonetizationItem[]>;
  getBrandCampaigns(brandEmail: string): Promise<MonetizationItem[]>;
}

export class DatabaseStorage implements IStorage {
  // User authentication methods
  async getUserByEmail(email: string): Promise<User | undefined> {
    const normalizedEmail = email.toLowerCase().trim();
    const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail));
    return user;
  }

  async getUserById(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async createUser(userData: UpsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values({
        ...userData,
        email: userData.email?.toLowerCase().trim(),
      })
      .returning();
    return user;
  }

  async upsertUserByEmail(userData: UpsertUser): Promise<User> {
    const normalizedEmail = userData.email?.toLowerCase().trim();
    const [user] = await db
      .insert(users)
      .values({
        ...userData,
        email: normalizedEmail,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: {
          firstName: userData.firstName,
          lastName: userData.lastName,
          profileImageUrl: userData.profileImageUrl,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  }

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

  async deleteYoutubeConnection(userId: string, userEmail?: string): Promise<void> {
    // Delete by userId first
    await db.delete(youtubeConnections).where(eq(youtubeConnections.userId, userId));
    // Also try to delete by email if provided (for legacy connections)
    if (userEmail && userEmail !== userId) {
      await db.delete(youtubeConnections).where(eq(youtubeConnections.userId, userEmail));
    }
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

  async getAllowedUser(email: string): Promise<AllowedUser | undefined> {
    const normalizedEmail = email.toLowerCase().trim();
    const [user] = await db
      .select()
      .from(allowedUsers)
      .where(eq(allowedUsers.email, normalizedEmail));
    return user;
  }

  async updateAllowedUserRole(email: string, userType: string): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim();
    await db
      .update(allowedUsers)
      .set({ userType })
      .where(eq(allowedUsers.email, normalizedEmail));
  }

  async createBid(bid: InsertMonetizationItem): Promise<MonetizationItem> {
    const [newBid] = await db
      .insert(monetizationItems)
      .values(bid)
      .returning();
    return newBid;
  }

  async getActiveBidsForCreator(creatorUserId: string): Promise<MonetizationItem[]> {
    return await db
      .select()
      .from(monetizationItems)
      .where(and(
        eq(monetizationItems.creatorUserId, creatorUserId),
        eq(monetizationItems.status, "pending")
      ));
  }

  async getBrandCampaigns(brandEmail: string): Promise<MonetizationItem[]> {
    return await db
      .select()
      .from(monetizationItems)
      .where(eq(monetizationItems.brandEmail, brandEmail));
  }

  async getVideoIndex(userId: string): Promise<VideoIndex[]> {
    console.log(`[Storage.getVideoIndex] Looking up user by ID: ${userId}`);
    // First, try to get user by ID to also check by email
    const user = await this.getUserById(userId);
    const userEmail = user?.email;
    console.log(`[Storage.getVideoIndex] User found: ${!!user}, email: ${userEmail}`);
    
    // Query videos matching either the user ID or the user's email
    // This handles legacy videos stored with email as userId
    if (userEmail && userEmail !== userId) {
      console.log(`[Storage.getVideoIndex] Querying by userId=${userId} OR userId=${userEmail}`);
      const videos = await db
        .select()
        .from(videoIndex)
        .where(or(
          eq(videoIndex.userId, userId),
          eq(videoIndex.userId, userEmail)
        ))
        .orderBy(desc(videoIndex.priorityScore));
      console.log(`[Storage.getVideoIndex] Found ${videos.length} videos (dual query)`);
      return videos;
    }
    
    console.log(`[Storage.getVideoIndex] Querying by userId=${userId} only`);
    const videos = await db
      .select()
      .from(videoIndex)
      .where(eq(videoIndex.userId, userId))
      .orderBy(desc(videoIndex.priorityScore));
    console.log(`[Storage.getVideoIndex] Found ${videos.length} videos (single query)`);
    return videos;
  }

  async getAllVideos(): Promise<VideoIndex[]> {
    return await db
      .select()
      .from(videoIndex)
      .orderBy(desc(videoIndex.createdAt));
  }

  async insertVideo(video: InsertVideoIndex): Promise<VideoIndex> {
    const [result] = await db
      .insert(videoIndex)
      .values(video)
      .returning();
    return result;
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

  async updateVideoThumbnail(videoId: number, thumbnailUrl: string): Promise<void> {
    await db
      .update(videoIndex)
      .set({ thumbnailUrl, updatedAt: new Date() })
      .where(eq(videoIndex.id, videoId));
  }

  async updateVideoMetadata(videoId: number, metadata: { sentiment?: string; culturalContext?: string }): Promise<void> {
    await db
      .update(videoIndex)
      .set({ ...metadata, updatedAt: new Date() })
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

  async getVideosWithOpportunities(userId: string): Promise<VideoWithOpportunities[]> {
    // First, try to get user by ID to also check by email
    const user = await this.getUserById(userId);
    const userEmail = user?.email;
    
    // Query videos matching either the user ID or the user's email
    let videos;
    if (userEmail && userEmail !== userId) {
      videos = await db
        .select()
        .from(videoIndex)
        .where(or(
          eq(videoIndex.userId, userId),
          eq(videoIndex.userId, userEmail)
        ))
        .orderBy(desc(videoIndex.priorityScore));
    } else {
      videos = await db
        .select()
        .from(videoIndex)
        .where(eq(videoIndex.userId, userId))
        .orderBy(desc(videoIndex.priorityScore));
    }
    
    const results: VideoWithOpportunities[] = [];
    
    for (const video of videos) {
      const surfaces = await this.getDetectedSurfaces(video.id);
      if (surfaces.length > 0) {
        const contexts = this.deriveContexts(surfaces);
        results.push({
          ...video,
          surfaces,
          surfaceCount: surfaces.length,
          contexts,
        });
      }
    }
    
    return results;
  }

  async getAllVideosWithOpportunities(): Promise<VideoWithOpportunities[]> {
    const videos = await db
      .select()
      .from(videoIndex)
      .orderBy(desc(videoIndex.priorityScore));
    
    const results: VideoWithOpportunities[] = [];
    
    for (const video of videos) {
      const surfaces = await this.getDetectedSurfaces(video.id);
      if (surfaces.length > 0) {
        const contexts = this.deriveContexts(surfaces);
        results.push({
          ...video,
          surfaces,
          surfaceCount: surfaces.length,
          contexts,
        });
      }
    }
    
    return results;
  }

  async getReadyVideosForMarketplace(): Promise<VideoWithOpportunities[]> {
    // Include videos with "Ready" or "Scan Complete" status
    const videos = await db
      .select()
      .from(videoIndex)
      .where(
        or(
          eq(videoIndex.status, "Ready"),
          eq(videoIndex.status, "Scan Complete"),
          sql`${videoIndex.status} LIKE 'Ready%'`
        )
      )
      .orderBy(desc(videoIndex.priorityScore));
    
    const results: VideoWithOpportunities[] = [];
    
    for (const video of videos) {
      const surfaces = await this.getDetectedSurfaces(video.id);
      const contexts = this.deriveContexts(surfaces);
      results.push({
        ...video,
        surfaces,
        surfaceCount: surfaces.length,
        contexts,
      });
    }
    
    return results;
  }

  private deriveContexts(surfaces: DetectedSurface[]): string[] {
    const contexts = new Set<string>();
    const surfaceTypes = surfaces.map(s => s.surfaceType.toLowerCase());
    
    if (surfaceTypes.some(t => ["laptop", "monitor", "desk", "keyboard", "mouse"].includes(t))) {
      contexts.add("Workspace");
    }
    if (surfaceTypes.some(t => ["couch", "coffee table", "shelf", "bookshelf"].includes(t))) {
      contexts.add("Lifestyle");
    }
    if (surfaceTypes.some(t => ["whiteboard", "chair"].includes(t))) {
      contexts.add("Office");
    }
    if (surfaceTypes.some(t => ["wall", "picture frame", "window"].includes(t))) {
      contexts.add("Interior");
    }
    if (surfaceTypes.some(t => ["bottle", "table"].includes(t))) {
      contexts.add("Product Placement");
    }
    
    if (contexts.size === 0) {
      contexts.add("General");
    }
    
    return Array.from(contexts);
  }
}

export const storage = new DatabaseStorage();
