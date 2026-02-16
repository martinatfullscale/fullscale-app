import { db } from "./db";
import { eq, desc, and, or, sql } from "drizzle-orm";
import {
  monetizationItems,
  youtubeConnections,
  allowedUsers,
  videoIndex,
  detectedSurfaces,
  brandProducts,
  savedPlacements,
  videoExports,
  sharedLinks,
  sceneAnalysis,
  brandMatchScores,
  remixJobs,
  generatedClips,
  remixTemplates,
  generatedAssets,
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
  type BrandProduct,
  type InsertBrandProduct,
  type SavedPlacement,
  type InsertSavedPlacement,
  type VideoExport,
  type InsertVideoExport,
  type SharedLink,
  type InsertSharedLink,
  type SceneAnalysis,
  type InsertSceneAnalysis,
  type BrandMatchScore,
  type InsertBrandMatchScore,
  type RemixJob,
  type InsertRemixJob,
  type GeneratedClip,
  type InsertGeneratedClip,
  type RemixTemplate,
  type InsertRemixTemplate,
  type GeneratedAsset,
  type InsertGeneratedAsset,
  distributionProfiles,
  publishedPosts,
  clipAnalytics,
  publishingSchedules,
  type DistributionProfile,
  type InsertDistributionProfile,
  type PublishedPost,
  type InsertPublishedPost,
  type ClipAnalytics,
  type InsertClipAnalytics,
  type PublishingSchedule,
  type InsertPublishingSchedule,
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
  deleteVideoIndex(userId: string, userEmail?: string): Promise<void>;
  deleteVideoById(videoId: number): Promise<VideoIndex | undefined>;
  getVideoById(id: number): Promise<VideoIndex | undefined>;
  getPendingVideos(userId: string, limit?: number): Promise<VideoIndex[]>;
  updateVideoStatus(videoId: number, status: string): Promise<void>;
  updateVideoThumbnail(videoId: number, thumbnailUrl: string): Promise<void>;
  updateVideoIndex(videoId: number, updates: Partial<InsertVideoIndex>): Promise<void>;
  updateVideoMetadata(videoId: number, metadata: { sentiment?: string; culturalContext?: string }): Promise<void>;
  insertDetectedSurface(surface: InsertDetectedSurface): Promise<DetectedSurface>;
  updateDetectedSurface(surfaceId: number, updates: { surfaceType?: string; sceneContext?: string; surroundings?: string[]; boundingBoxX?: string; boundingBoxY?: string; boundingBoxWidth?: string; boundingBoxHeight?: string }): Promise<void>;
  getDetectedSurfaces(videoId: number): Promise<DetectedSurface[]>;
  getSurfaceCountByVideo(videoId: number): Promise<number>;
  clearDetectedSurfaces(videoId: number): Promise<void>;
  getVideosWithOpportunities(userId: string): Promise<VideoWithOpportunities[]>;
  getAllVideosWithOpportunities(): Promise<VideoWithOpportunities[]>;
  getReadyVideosForMarketplace(): Promise<VideoWithOpportunities[]>;
  getVideosWithSurfacesPublic(userEmail: string): Promise<any[]>;
  createBid(bid: InsertMonetizationItem): Promise<MonetizationItem>;
  getActiveBidsForCreator(creatorUserId: string): Promise<MonetizationItem[]>;
  getBrandCampaigns(brandEmail: string): Promise<MonetizationItem[]>;
  // YouTube stats methods
  getYoutubeConnectionByEmail(email: string): Promise<YoutubeConnection | undefined>;
  updateYoutubeStats(connectionId: number, stats: { subscriberCount: number; totalViewCount: number }): Promise<void>;
  // Brand product methods
  createBrandProduct(product: InsertBrandProduct): Promise<BrandProduct>;
  getBrandProducts(userId: string): Promise<BrandProduct[]>;
  getBrandProduct(productId: number): Promise<BrandProduct | undefined>;
  deleteBrandProduct(productId: number): Promise<BrandProduct | undefined>;
  getAllBrandProducts(): Promise<BrandProduct[]>;
  // Saved placement methods
  savePlacement(placement: InsertSavedPlacement): Promise<SavedPlacement>;
  getAllActivePlacements(): Promise<SavedPlacement[]>;
  getPlacementsForVideo(videoId: number): Promise<SavedPlacement[]>;
  getPlacementById(placementId: number): Promise<SavedPlacement | undefined>;
  updatePlacement(placementId: number, updates: Partial<InsertSavedPlacement>): Promise<SavedPlacement | undefined>;
  deletePlacement(placementId: number): Promise<SavedPlacement | undefined>;
  getPlacementsBySceneGroup(videoId: number, sceneGroupId: string): Promise<SavedPlacement[]>;
  // Video export methods
  createVideoExport(data: InsertVideoExport): Promise<VideoExport>;
  getVideoExport(exportId: number): Promise<VideoExport | undefined>;
  updateVideoExportProgress(exportId: number, progress: number): Promise<void>;
  updateVideoExportComplete(exportId: number, outputPath: string, outputUrl: string): Promise<void>;
  updateVideoExportFailed(exportId: number, error: string): Promise<void>;
  // Shared link methods
  createSharedLink(data: InsertSharedLink): Promise<SharedLink>;
  getSharedLinkBySlug(slug: string): Promise<SharedLink | undefined>;
  incrementSharedLinkViews(slug: string): Promise<void>;
  getSharedLinksByUser(email: string): Promise<SharedLink[]>;
  deactivateSharedLink(id: number): Promise<void>;
  // Scene analysis methods
  createSceneAnalysis(data: InsertSceneAnalysis): Promise<SceneAnalysis>;
  getSceneAnalysisByVideo(videoId: number): Promise<SceneAnalysis[]>;
  getSceneAnalysisBySurface(surfaceId: number): Promise<SceneAnalysis | undefined>;
  // Brand matching methods
  createBrandMatchScore(data: InsertBrandMatchScore): Promise<BrandMatchScore>;
  getBrandMatchesByScene(sceneAnalysisId: number): Promise<BrandMatchScore[]>;
  getBrandMatchesByVideo(videoId: number): Promise<BrandMatchScore[]>;
  approveBrandMatch(matchId: number, approvedBy: string): Promise<BrandMatchScore | undefined>;
  // Remix job methods
  createRemixJob(data: InsertRemixJob): Promise<RemixJob>;
  getRemixJob(jobId: number): Promise<RemixJob | undefined>;
  getRemixJobsByUser(userId: number): Promise<RemixJob[]>;
  updateRemixJobStatus(jobId: number, status: string, errorMessage?: string): Promise<RemixJob | undefined>;
  // Generated clip methods
  createGeneratedClip(data: InsertGeneratedClip): Promise<GeneratedClip>;
  getClipsByJob(jobId: number): Promise<GeneratedClip[]>;
  getClipsByVideo(videoId: number): Promise<GeneratedClip[]>;
  updateClipStatus(clipId: number, status: string): Promise<GeneratedClip | undefined>;
  publishClip(clipId: number, platform: string, url: string): Promise<GeneratedClip | undefined>;
  // Generated asset methods
  createGeneratedAsset(data: InsertGeneratedAsset): Promise<GeneratedAsset>;
  getAssetsByVideo(videoId: number): Promise<GeneratedAsset[]>;
  approveAsset(assetId: number): Promise<GeneratedAsset | undefined>;
  // Remix template methods
  createRemixTemplate(data: InsertRemixTemplate): Promise<RemixTemplate>;
  getRemixTemplates(userId: number): Promise<RemixTemplate[]>;
  updateRemixTemplate(id: number, data: Partial<InsertRemixTemplate>): Promise<RemixTemplate | undefined>;
  deleteRemixTemplate(id: number): Promise<void>;

  // Distribution profile methods
  createDistributionProfile(data: InsertDistributionProfile): Promise<DistributionProfile>;
  getDistributionProfiles(userId: number): Promise<DistributionProfile[]>;
  getDistributionProfile(id: number): Promise<DistributionProfile | undefined>;
  updateDistributionProfile(id: number, data: Partial<InsertDistributionProfile>): Promise<DistributionProfile | undefined>;
  deleteDistributionProfile(id: number): Promise<void>;

  // Published posts methods
  createPublishedPost(data: InsertPublishedPost): Promise<PublishedPost>;
  getPublishedPost(id: number): Promise<PublishedPost | undefined>;
  getPublishedPostsByClip(clipId: number): Promise<PublishedPost[]>;
  getPublishedPostsByVideo(videoId: number): Promise<PublishedPost[]>;
  getPublishedPostsByUser(userId: number): Promise<PublishedPost[]>;
  updatePublishedPostStatus(postId: number, status: string, platformPostId?: string, postUrl?: string, errorMessage?: string): Promise<PublishedPost | undefined>;

  // Clip analytics methods
  upsertClipAnalytics(data: InsertClipAnalytics): Promise<ClipAnalytics>;
  getAnalyticsByPost(postId: number): Promise<ClipAnalytics[]>;
  getAnalyticsByClip(clipId: number): Promise<ClipAnalytics[]>;
  getAnalyticsSummaryByVideo(videoId: number): Promise<ClipAnalytics[]>;

  // Publishing schedule methods
  createPublishingSchedule(data: InsertPublishingSchedule): Promise<PublishingSchedule>;
  getSchedulesByUser(userId: number): Promise<PublishingSchedule[]>;
  getPendingSchedules(): Promise<PublishingSchedule[]>;
  updateScheduleStatus(scheduleId: number, status: string, postId?: number, errorMessage?: string): Promise<PublishingSchedule | undefined>;
  cancelSchedule(scheduleId: number): Promise<void>;
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

    let videos: VideoIndex[];

    // Query videos matching either the user ID or the user's email
    // This handles legacy videos stored with email as userId
    if (userEmail && userEmail !== userId) {
      console.log(`[Storage.getVideoIndex] Querying by userId=${userId} OR userId=${userEmail}`);
      videos = await db
        .select()
        .from(videoIndex)
        .where(or(
          eq(videoIndex.userId, userId),
          eq(videoIndex.userId, userEmail)
        ))
        .orderBy(desc(videoIndex.priorityScore));
      console.log(`[Storage.getVideoIndex] Found ${videos.length} videos (dual query)`);
    } else {
      console.log(`[Storage.getVideoIndex] Querying by userId=${userId} only`);
      videos = await db
        .select()
        .from(videoIndex)
        .where(eq(videoIndex.userId, userId))
        .orderBy(desc(videoIndex.priorityScore));
      console.log(`[Storage.getVideoIndex] Found ${videos.length} videos (single query)`);
    }

    // Deduplicate by normalized title — keeps the entry with the most surfaces (best scan)
    // This handles duplicate uploads, re-imports, and mixed youtubeId formats
    const seen = new Map<string, VideoIndex>();
    const surfaceCounts = new Map<number, number>();

    // Pre-fetch surface counts for smarter dedup (keep the best-scanned version)
    for (const video of videos) {
      const count = await this.getSurfaceCountByVideo(video.id);
      surfaceCounts.set(video.id, count);
    }

    for (const video of videos) {
      const dedupeKey = video.title.toLowerCase().replace(/[_\s-]+/g, ' ').trim();
      const existing = seen.get(dedupeKey);

      if (!existing) {
        seen.set(dedupeKey, video);
      } else {
        // Prefer the version with more detected surfaces; tie-break by most recent update
        const existingCount = surfaceCounts.get(existing.id) || 0;
        const currentCount = surfaceCounts.get(video.id) || 0;
        if (currentCount > existingCount || (currentCount === existingCount && new Date(video.updatedAt!) > new Date(existing.updatedAt!))) {
          seen.set(dedupeKey, video);
        }
      }
    }

    const dedupedVideos = Array.from(seen.values())
      .sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));
    console.log(`[Storage.getVideoIndex] After dedup: ${dedupedVideos.length} unique videos (from ${videos.length})`);
    return dedupedVideos;
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

  async deleteVideoIndex(userId: string, userEmail?: string): Promise<void> {
    // Delete videos matching either userId or email (handles legacy data)
    if (userEmail && userEmail !== userId) {
      await db.delete(videoIndex).where(
        or(eq(videoIndex.userId, userId), eq(videoIndex.userId, userEmail))
      );
    } else {
      await db.delete(videoIndex).where(eq(videoIndex.userId, userId));
    }
  }

  async deleteVideoById(videoId: number): Promise<VideoIndex | undefined> {
    // Delete related records in order: shared links, exports, surfaces, placements, then video
    await db.delete(sharedLinks).where(eq(sharedLinks.videoId, videoId));
    await db.delete(videoExports).where(eq(videoExports.videoId, videoId));
    await db.delete(detectedSurfaces).where(eq(detectedSurfaces.videoId, videoId));
    await db.delete(savedPlacements).where(eq(savedPlacements.videoId, videoId));
    const [deleted] = await db.delete(videoIndex).where(eq(videoIndex.id, videoId)).returning();
    return deleted;
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

  async updateVideoIndex(videoId: number, updates: Partial<InsertVideoIndex>): Promise<void> {
    await db
      .update(videoIndex)
      .set({ ...updates, updatedAt: new Date() })
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

  async updateDetectedSurface(surfaceId: number, updates: {
    surfaceType?: string;
    sceneContext?: string;
    surroundings?: string[];
    boundingBoxX?: string;
    boundingBoxY?: string;
    boundingBoxWidth?: string;
    boundingBoxHeight?: string;
  }): Promise<void> {
    await db
      .update(detectedSurfaces)
      .set(updates)
      .where(eq(detectedSurfaces.id, surfaceId));
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

  async getVideosWithSurfacesPublic(userEmail: string): Promise<any[]> {
    // Get ready videos for a creator by email (for public profile page)
    const videos = await db
      .select()
      .from(videoIndex)
      .where(
        and(
          eq(videoIndex.userId, userEmail),
          or(
            eq(videoIndex.status, "Ready"),
            eq(videoIndex.status, "Scan Complete"),
            sql`${videoIndex.status} LIKE 'Ready%'`
          )
        )
      )
      .orderBy(desc(videoIndex.priorityScore));
    
    const results: any[] = [];
    
    for (const video of videos) {
      const surfaces = await this.getDetectedSurfaces(video.id);
      if (surfaces.length > 0) {
        results.push({
          ...video,
          surfaces,
          surfaceCount: surfaces.length,
        });
      }
    }
    
    return results;
  }

  // YouTube stats methods
  async getYoutubeConnectionByEmail(email: string): Promise<YoutubeConnection | undefined> {
    const normalizedEmail = email.toLowerCase().trim();
    // Find the user by email, then get their YouTube connection
    const user = await this.getUserByEmail(normalizedEmail);
    if (!user) return undefined;
    return this.getYoutubeConnection(user.id);
  }

  async updateYoutubeStats(connectionId: number, stats: { subscriberCount: number; totalViewCount: number }): Promise<void> {
    await db
      .update(youtubeConnections)
      .set({
        subscriberCount: stats.subscriberCount,
        totalViewCount: stats.totalViewCount,
        updatedAt: new Date(),
      })
      .where(eq(youtubeConnections.id, connectionId));
  }

  // Brand product methods
  async createBrandProduct(product: InsertBrandProduct): Promise<BrandProduct> {
    const [result] = await db
      .insert(brandProducts)
      .values(product)
      .returning();
    return result;
  }

  async getBrandProducts(userId: string): Promise<BrandProduct[]> {
    return await db
      .select()
      .from(brandProducts)
      .where(eq(brandProducts.userId, userId))
      .orderBy(desc(brandProducts.createdAt));
  }

  async getBrandProduct(productId: number): Promise<BrandProduct | undefined> {
    const [result] = await db
      .select()
      .from(brandProducts)
      .where(eq(brandProducts.id, productId));
    return result;
  }

  async deleteBrandProduct(productId: number): Promise<BrandProduct | undefined> {
    const [result] = await db
      .delete(brandProducts)
      .where(eq(brandProducts.id, productId))
      .returning();
    return result;
  }

  async getAllBrandProducts(): Promise<BrandProduct[]> {
    return await db
      .select()
      .from(brandProducts)
      .orderBy(desc(brandProducts.createdAt));
  }

  // Saved placement methods
  async savePlacement(placement: InsertSavedPlacement): Promise<SavedPlacement> {
    const [result] = await db
      .insert(savedPlacements)
      .values(placement)
      .returning();
    return result;
  }

  async getAllActivePlacements(): Promise<SavedPlacement[]> {
    return await db
      .select()
      .from(savedPlacements)
      .where(eq(savedPlacements.status, "active"))
      .orderBy(desc(savedPlacements.createdAt));
  }

  async getPlacementsForVideo(videoId: number): Promise<SavedPlacement[]> {
    return await db
      .select()
      .from(savedPlacements)
      .where(and(
        eq(savedPlacements.videoId, videoId),
        eq(savedPlacements.status, "active")
      ))
      .orderBy(desc(savedPlacements.createdAt));
  }

  async getPlacementById(placementId: number): Promise<SavedPlacement | undefined> {
    const [result] = await db
      .select()
      .from(savedPlacements)
      .where(eq(savedPlacements.id, placementId));
    return result;
  }

  async updatePlacement(placementId: number, updates: Partial<InsertSavedPlacement>): Promise<SavedPlacement | undefined> {
    const [result] = await db
      .update(savedPlacements)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(savedPlacements.id, placementId))
      .returning();
    return result;
  }

  async deletePlacement(placementId: number): Promise<SavedPlacement | undefined> {
    const [result] = await db
      .update(savedPlacements)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(savedPlacements.id, placementId))
      .returning();
    return result;
  }

  async getPlacementsBySceneGroup(videoId: number, sceneGroupId: string): Promise<SavedPlacement[]> {
    return await db
      .select()
      .from(savedPlacements)
      .where(and(
        eq(savedPlacements.videoId, videoId),
        eq(savedPlacements.sceneGroupId, sceneGroupId),
        eq(savedPlacements.status, "active")
      ))
      .orderBy(savedPlacements.createdAt);
  }

  // ── Video Export Methods ──

  async createVideoExport(data: InsertVideoExport): Promise<VideoExport> {
    const [result] = await db
      .insert(videoExports)
      .values(data)
      .returning();
    return result;
  }

  async getVideoExport(exportId: number): Promise<VideoExport | undefined> {
    const [result] = await db
      .select()
      .from(videoExports)
      .where(eq(videoExports.id, exportId));
    return result;
  }

  async updateVideoExportProgress(exportId: number, progress: number): Promise<void> {
    await db
      .update(videoExports)
      .set({ progress })
      .where(eq(videoExports.id, exportId));
  }

  async updateVideoExportComplete(exportId: number, outputPath: string, outputUrl: string): Promise<void> {
    await db
      .update(videoExports)
      .set({
        status: "complete",
        progress: 100,
        outputPath,
        outputUrl,
        completedAt: new Date(),
      })
      .where(eq(videoExports.id, exportId));
  }

  async updateVideoExportFailed(exportId: number, error: string): Promise<void> {
    await db
      .update(videoExports)
      .set({
        status: "failed",
        error,
        completedAt: new Date(),
      })
      .where(eq(videoExports.id, exportId));
  }

  // ── Shared Links ──

  async createSharedLink(data: InsertSharedLink): Promise<SharedLink> {
    const [result] = await db
      .insert(sharedLinks)
      .values(data)
      .returning();
    return result;
  }

  async getSharedLinkBySlug(slug: string): Promise<SharedLink | undefined> {
    const [result] = await db
      .select()
      .from(sharedLinks)
      .where(eq(sharedLinks.slug, slug));
    return result;
  }

  async incrementSharedLinkViews(slug: string): Promise<void> {
    await db
      .update(sharedLinks)
      .set({ viewCount: sql`${sharedLinks.viewCount} + 1` })
      .where(eq(sharedLinks.slug, slug));
  }

  async getSharedLinksByUser(email: string): Promise<SharedLink[]> {
    return db
      .select()
      .from(sharedLinks)
      .where(eq(sharedLinks.createdBy, email))
      .orderBy(desc(sharedLinks.createdAt));
  }

  async deactivateSharedLink(id: number): Promise<void> {
    await db
      .update(sharedLinks)
      .set({ isActive: false })
      .where(eq(sharedLinks.id, id));
  }

  // ── Scene Analysis Methods ──

  async createSceneAnalysis(data: InsertSceneAnalysis): Promise<SceneAnalysis> {
    const [result] = await db.insert(sceneAnalysis).values(data).returning();
    return result;
  }

  async getSceneAnalysisByVideo(videoId: number): Promise<SceneAnalysis[]> {
    return db.select().from(sceneAnalysis)
      .where(eq(sceneAnalysis.videoId, videoId))
      .orderBy(sceneAnalysis.frameStart);
  }

  async getSceneAnalysisBySurface(surfaceId: number): Promise<SceneAnalysis | undefined> {
    const [result] = await db.select().from(sceneAnalysis)
      .where(eq(sceneAnalysis.surfaceId, surfaceId));
    return result;
  }

  // ── Brand Matching Methods ──

  async createBrandMatchScore(data: InsertBrandMatchScore): Promise<BrandMatchScore> {
    const [result] = await db.insert(brandMatchScores).values(data).returning();
    return result;
  }

  async getBrandMatchesByScene(sceneAnalysisId: number): Promise<BrandMatchScore[]> {
    return db.select().from(brandMatchScores)
      .where(eq(brandMatchScores.sceneAnalysisId, sceneAnalysisId))
      .orderBy(desc(brandMatchScores.compatibilityScore));
  }

  async getBrandMatchesByVideo(videoId: number): Promise<BrandMatchScore[]> {
    const scenes = await this.getSceneAnalysisByVideo(videoId);
    if (scenes.length === 0) return [];
    const sceneIds = scenes.map(s => s.id);
    return db.select().from(brandMatchScores)
      .where(sql`${brandMatchScores.sceneAnalysisId} IN (${sql.join(sceneIds.map(id => sql`${id}`), sql`, `)})`)
      .orderBy(desc(brandMatchScores.compatibilityScore));
  }

  async approveBrandMatch(matchId: number, approvedBy: string): Promise<BrandMatchScore | undefined> {
    const [result] = await db.update(brandMatchScores)
      .set({ approved: true, approvedBy })
      .where(eq(brandMatchScores.id, matchId))
      .returning();
    return result;
  }

  // ── Remix Job Methods ──

  async createRemixJob(data: InsertRemixJob): Promise<RemixJob> {
    const [result] = await db.insert(remixJobs).values(data).returning();
    return result;
  }

  async getRemixJob(jobId: number): Promise<RemixJob | undefined> {
    const [result] = await db.select().from(remixJobs)
      .where(eq(remixJobs.id, jobId));
    return result;
  }

  async getRemixJobsByUser(userId: number): Promise<RemixJob[]> {
    return db.select().from(remixJobs)
      .where(eq(remixJobs.userId, userId))
      .orderBy(desc(remixJobs.createdAt));
  }

  async updateRemixJobStatus(jobId: number, status: string, errorMessage?: string): Promise<RemixJob | undefined> {
    const updates: any = { status };
    if (errorMessage) updates.errorMessage = errorMessage;
    if (status === 'complete' || status === 'failed') updates.completedAt = new Date();
    const [result] = await db.update(remixJobs)
      .set(updates)
      .where(eq(remixJobs.id, jobId))
      .returning();
    return result;
  }

  // ── Generated Clip Methods ──

  async createGeneratedClip(data: InsertGeneratedClip): Promise<GeneratedClip> {
    const [result] = await db.insert(generatedClips).values(data).returning();
    return result;
  }

  async getClipsByJob(jobId: number): Promise<GeneratedClip[]> {
    return db.select().from(generatedClips)
      .where(eq(generatedClips.remixJobId, jobId))
      .orderBy(generatedClips.clipStart);
  }

  async getClipsByVideo(videoId: number): Promise<GeneratedClip[]> {
    return db.select().from(generatedClips)
      .where(eq(generatedClips.videoId, videoId))
      .orderBy(desc(generatedClips.createdAt));
  }

  async updateClipStatus(clipId: number, status: string): Promise<GeneratedClip | undefined> {
    const [result] = await db.update(generatedClips)
      .set({ status })
      .where(eq(generatedClips.id, clipId))
      .returning();
    return result;
  }

  async publishClip(clipId: number, platform: string, url: string): Promise<GeneratedClip | undefined> {
    const [result] = await db.update(generatedClips)
      .set({
        status: 'published',
        publishedAt: new Date(),
        publishedPlatform: platform,
        publishedUrl: url,
      })
      .where(eq(generatedClips.id, clipId))
      .returning();
    return result;
  }

  // ── Generated Asset Methods ──

  async createGeneratedAsset(data: InsertGeneratedAsset): Promise<GeneratedAsset> {
    const [result] = await db.insert(generatedAssets).values(data).returning();
    return result;
  }

  async getAssetsByVideo(videoId: number): Promise<GeneratedAsset[]> {
    return db.select().from(generatedAssets)
      .where(eq(generatedAssets.videoId, videoId))
      .orderBy(desc(generatedAssets.createdAt));
  }

  async approveAsset(assetId: number): Promise<GeneratedAsset | undefined> {
    const [result] = await db.update(generatedAssets)
      .set({ approved: true })
      .where(eq(generatedAssets.id, assetId))
      .returning();
    return result;
  }

  // ── Remix Template Methods ──

  async createRemixTemplate(data: InsertRemixTemplate): Promise<RemixTemplate> {
    const [result] = await db.insert(remixTemplates).values(data).returning();
    return result;
  }

  async getRemixTemplates(userId: number): Promise<RemixTemplate[]> {
    return db.select().from(remixTemplates)
      .where(eq(remixTemplates.userId, userId))
      .orderBy(desc(remixTemplates.createdAt));
  }

  async updateRemixTemplate(id: number, data: Partial<InsertRemixTemplate>): Promise<RemixTemplate | undefined> {
    const [result] = await db.update(remixTemplates)
      .set(data)
      .where(eq(remixTemplates.id, id))
      .returning();
    return result;
  }

  async deleteRemixTemplate(id: number): Promise<void> {
    await db.delete(remixTemplates).where(eq(remixTemplates.id, id));
  }

  // ── Distribution Profile Methods ──

  async createDistributionProfile(data: InsertDistributionProfile): Promise<DistributionProfile> {
    const [result] = await db.insert(distributionProfiles).values(data).returning();
    return result;
  }

  async getDistributionProfiles(userId: number): Promise<DistributionProfile[]> {
    return db.select().from(distributionProfiles)
      .where(and(eq(distributionProfiles.userId, userId), eq(distributionProfiles.isActive, true)))
      .orderBy(desc(distributionProfiles.createdAt));
  }

  async getDistributionProfile(id: number): Promise<DistributionProfile | undefined> {
    const [result] = await db.select().from(distributionProfiles)
      .where(eq(distributionProfiles.id, id)).limit(1);
    return result;
  }

  async updateDistributionProfile(id: number, data: Partial<InsertDistributionProfile>): Promise<DistributionProfile | undefined> {
    const [result] = await db.update(distributionProfiles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(distributionProfiles.id, id))
      .returning();
    return result;
  }

  async deleteDistributionProfile(id: number): Promise<void> {
    await db.update(distributionProfiles)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(distributionProfiles.id, id));
  }

  // ── Published Post Methods ──

  async createPublishedPost(data: InsertPublishedPost): Promise<PublishedPost> {
    const [result] = await db.insert(publishedPosts).values(data).returning();
    return result;
  }

  async getPublishedPost(id: number): Promise<PublishedPost | undefined> {
    const [result] = await db.select().from(publishedPosts)
      .where(eq(publishedPosts.id, id)).limit(1);
    return result;
  }

  async getPublishedPostsByClip(clipId: number): Promise<PublishedPost[]> {
    return db.select().from(publishedPosts)
      .where(eq(publishedPosts.clipId, clipId))
      .orderBy(desc(publishedPosts.createdAt));
  }

  async getPublishedPostsByVideo(videoId: number): Promise<PublishedPost[]> {
    return db.select().from(publishedPosts)
      .where(eq(publishedPosts.videoId, videoId))
      .orderBy(desc(publishedPosts.createdAt));
  }

  async getPublishedPostsByUser(userId: number): Promise<PublishedPost[]> {
    const profiles = await this.getDistributionProfiles(userId);
    if (profiles.length === 0) return [];
    const profileIds = profiles.map(p => p.id);
    return db.select().from(publishedPosts)
      .where(sql`${publishedPosts.profileId} IN (${sql.join(profileIds.map(id => sql`${id}`), sql`, `)})`)
      .orderBy(desc(publishedPosts.createdAt));
  }

  async updatePublishedPostStatus(
    postId: number,
    status: string,
    platformPostId?: string,
    postUrl?: string,
    errorMessage?: string
  ): Promise<PublishedPost | undefined> {
    const updateData: Record<string, any> = { status };
    if (platformPostId) updateData.platformPostId = platformPostId;
    if (postUrl) updateData.postUrl = postUrl;
    if (errorMessage) updateData.errorMessage = errorMessage;
    if (status === "published") updateData.publishedAt = new Date();

    const [result] = await db.update(publishedPosts)
      .set(updateData)
      .where(eq(publishedPosts.id, postId))
      .returning();
    return result;
  }

  // ── Clip Analytics Methods ──

  async upsertClipAnalytics(data: InsertClipAnalytics): Promise<ClipAnalytics> {
    const [result] = await db.insert(clipAnalytics).values(data).returning();
    return result;
  }

  async getAnalyticsByPost(postId: number): Promise<ClipAnalytics[]> {
    return db.select().from(clipAnalytics)
      .where(eq(clipAnalytics.postId, postId))
      .orderBy(desc(clipAnalytics.fetchedAt));
  }

  async getAnalyticsByClip(clipId: number): Promise<ClipAnalytics[]> {
    return db.select().from(clipAnalytics)
      .where(eq(clipAnalytics.clipId, clipId))
      .orderBy(desc(clipAnalytics.fetchedAt));
  }

  async getAnalyticsSummaryByVideo(videoId: number): Promise<ClipAnalytics[]> {
    const clips = await this.getClipsByVideo(videoId);
    if (clips.length === 0) return [];
    const clipIds = clips.map(c => c.id);
    return db.select().from(clipAnalytics)
      .where(sql`${clipAnalytics.clipId} IN (${sql.join(clipIds.map(id => sql`${id}`), sql`, `)})`)
      .orderBy(desc(clipAnalytics.fetchedAt));
  }

  // ── Publishing Schedule Methods ──

  async createPublishingSchedule(data: InsertPublishingSchedule): Promise<PublishingSchedule> {
    const [result] = await db.insert(publishingSchedules).values(data).returning();
    return result;
  }

  async getSchedulesByUser(userId: number): Promise<PublishingSchedule[]> {
    return db.select().from(publishingSchedules)
      .where(eq(publishingSchedules.userId, userId))
      .orderBy(desc(publishingSchedules.scheduledFor));
  }

  async getPendingSchedules(): Promise<PublishingSchedule[]> {
    return db.select().from(publishingSchedules)
      .where(and(
        eq(publishingSchedules.status, "pending"),
        sql`${publishingSchedules.scheduledFor} <= NOW()`
      ))
      .orderBy(publishingSchedules.scheduledFor);
  }

  async updateScheduleStatus(
    scheduleId: number,
    status: string,
    postId?: number,
    errorMessage?: string
  ): Promise<PublishingSchedule | undefined> {
    const updateData: Record<string, any> = { status };
    if (postId) updateData.postId = postId;
    if (errorMessage) updateData.errorMessage = errorMessage;

    const [result] = await db.update(publishingSchedules)
      .set(updateData)
      .where(eq(publishingSchedules.id, scheduleId))
      .returning();
    return result;
  }

  async cancelSchedule(scheduleId: number): Promise<void> {
    await db.update(publishingSchedules)
      .set({ status: "cancelled" })
      .where(eq(publishingSchedules.id, scheduleId));
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
