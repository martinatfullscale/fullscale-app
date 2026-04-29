import { db } from "./db";
import { eq, desc, and, or, sql } from "drizzle-orm";
import {
  monetizationItems,
  youtubeConnections,
  allowedUsers,
  videoIndex,
  detectedSurfaces,
  brandProducts,
  brandPlacementAssignments,
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
  type BrandPlacementAssignment,
  type InsertBrandPlacementAssignment,
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
  videoTranscripts,
  clipFeedback,
  type DistributionProfile,
  type InsertDistributionProfile,
  type PublishedPost,
  type InsertPublishedPost,
  type ClipAnalytics,
  type InsertClipAnalytics,
  type PublishingSchedule,
  type InsertPublishingSchedule,
  type VideoTranscript,
  type InsertVideoTranscript,
  type ClipFeedback,
  type InsertClipFeedback,
  surfaceKeyframes,
  type SurfaceKeyframe,
  type InsertSurfaceKeyframe,
  stitchPlans,
  type StitchPlan,
  type InsertStitchPlan,
  editorialClips,
  type EditorialClip,
  type InsertEditorialClip,
  studioSubscriptions,
  studioUsage,
  studioVoices,
  studioVideos,
  type StudioSubscription,
  type InsertStudioSubscription,
  type StudioUsage,
  type InsertStudioUsage,
  type StudioVoice,
  type InsertStudioVoice,
  type StudioVideo,
  type InsertStudioVideo,
  studioWaitlist,
  type StudioWaitlistEntry,
  type InsertStudioWaitlistEntry,
  brandBriefs,
  type BrandBrief,
  type InsertBrandBrief,
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
  getVideoIndex(userId: string, authEmail?: string): Promise<VideoIndex[]>;
  getAllVideos(): Promise<VideoIndex[]>;
  upsertVideoIndex(video: InsertVideoIndex): Promise<VideoIndex>;
  insertVideo(video: InsertVideoIndex): Promise<VideoIndex>;
  bulkUpsertVideoIndex(videos: InsertVideoIndex[]): Promise<void>;
  deleteVideoIndex(userId: string, userEmail?: string): Promise<void>;
  deleteVideoById(videoId: number): Promise<VideoIndex | undefined>;
  trashVideo(videoId: number): Promise<VideoIndex | undefined>;
  restoreVideo(videoId: number): Promise<VideoIndex | undefined>;
  getTrashedVideos(userId: string, authEmail?: string): Promise<VideoIndex[]>;
  permanentlyDeleteVideo(videoId: number): Promise<VideoIndex | undefined>;
  getVideoById(id: number): Promise<VideoIndex | undefined>;
  getVideosByYoutubeIds(youtubeIds: string[]): Promise<VideoIndex[]>;
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
  getBidById(bidId: number): Promise<MonetizationItem | undefined>;
  updateBidStatus(bidId: number, status: string, updates?: { placementId?: number; reviewSlug?: string; reviewNote?: string }): Promise<MonetizationItem | undefined>;
  getPlacementsByBidId(bidId: number): Promise<SavedPlacement[]>;
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
  getPlacementsByCreator(email: string): Promise<SavedPlacement[]>;
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
  getClipById(clipId: number): Promise<GeneratedClip | undefined>;
  getClipsByJob(jobId: number): Promise<GeneratedClip[]>;
  getClipsByVideo(videoId: number): Promise<GeneratedClip[]>;
  updateClipStatus(clipId: number, status: string): Promise<GeneratedClip | undefined>;
  publishClip(clipId: number, platform: string, url: string): Promise<GeneratedClip | undefined>;
  // Stitch plan methods
  createStitchPlan(data: InsertStitchPlan): Promise<StitchPlan>;
  getStitchPlan(planId: number): Promise<StitchPlan | undefined>;
  getStitchPlansByVideo(videoId: number): Promise<StitchPlan[]>;
  updateStitchPlanStatus(planId: number, status: string, updates?: { outputPath?: string; thumbnailPath?: string; qualityScore?: number; generatedClipId?: number; errorMessage?: string }): Promise<StitchPlan | undefined>;
  deleteStitchPlan(planId: number): Promise<void>;
  // Editorial clips methods
  saveEditorialClips(videoId: number, userId: number, clips: any[]): Promise<EditorialClip[]>;
  getEditorialClipsByVideo(videoId: number): Promise<EditorialClip[]>;
  deleteEditorialClipsByVideo(videoId: number): Promise<void>;
  updateEditorialClipRender(
    clipId: number,
    updates: {
      exportPath?: string | null;
      thumbnailPath?: string | null;
      aspectRatio?: string | null;
      renderStatus?: "pending" | "rendering" | "rendered" | "failed";
      renderError?: string | null;
    }
  ): Promise<EditorialClip | undefined>;
  // Editorial pipeline status (videoIndex)
  updateVideoEditorialStatus(
    videoId: number,
    status: "pending" | "transcribing" | "analyzing" | "rendering" | "ready" | "failed",
    updates?: { error?: string | null; clipCount?: number; completedAt?: Date | null }
  ): Promise<void>;
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

  // Video transcript methods
  createVideoTranscript(data: InsertVideoTranscript): Promise<VideoTranscript>;
  getVideoTranscript(videoId: number): Promise<VideoTranscript | undefined>;
  updateVideoTranscriptStatus(transcriptId: number, status: string, errorMessage?: string): Promise<VideoTranscript | undefined>;
  updateVideoTranscript(transcriptId: number, data: Partial<InsertVideoTranscript>): Promise<VideoTranscript | undefined>;

  // Clip feedback methods
  createClipFeedback(data: InsertClipFeedback): Promise<ClipFeedback>;
  getClipFeedback(clipId: number): Promise<ClipFeedback[]>;
  getPerformanceFeedback(): Promise<ClipFeedback[]>;

  // Surface keyframe methods
  createSurfaceKeyframe(data: InsertSurfaceKeyframe): Promise<SurfaceKeyframe>;
  bulkInsertSurfaceKeyframes(data: InsertSurfaceKeyframe[]): Promise<void>;
  getSurfaceKeyframes(surfaceId: number): Promise<SurfaceKeyframe[]>;
  getSurfaceKeyframesInRange(surfaceId: number, startTime: number, endTime: number): Promise<SurfaceKeyframe[]>;
  getKeyframesByVideo(videoId: number): Promise<SurfaceKeyframe[]>;
  deleteKeyframesBySurface(surfaceId: number): Promise<void>;
  deleteSurfaceKeyframesInRange(surfaceId: number, startTime: number, endTime: number): Promise<void>;

  // Creator profile methods
  getFeaturedCreators(): Promise<AllowedUser[]>;
  getCreatorBySlug(slug: string): Promise<AllowedUser | undefined>;
  updateCreatorProfile(email: string, updates: { bio?: string; headline?: string; podcastName?: string; podcastUrl?: string; websiteUrl?: string; slug?: string }): Promise<void>;
  updateVideoSubcategory(videoId: number, subcategory: string): Promise<void>;

  // ── Studio Subscription Methods ──
  getStudioSubscription(userId: string): Promise<StudioSubscription | undefined>;
  createStudioSubscription(data: InsertStudioSubscription): Promise<StudioSubscription>;
  updateStudioSubscription(userId: string, updates: Partial<InsertStudioSubscription>): Promise<StudioSubscription | undefined>;
  getStudioSubscriptionByStripeCustomer(stripeCustomerId: string): Promise<StudioSubscription | undefined>;
  getStudioSubscriptionByStripeSubscription(stripeSubscriptionId: string): Promise<StudioSubscription | undefined>;

  // ── Studio Usage Methods ──
  getStudioUsage(userId: string, month: string): Promise<StudioUsage | undefined>;
  createStudioUsage(data: InsertStudioUsage): Promise<StudioUsage>;
  incrementStudioUsage(userId: string, month: string): Promise<StudioUsage>;
  updateStudioUsageLimit(userId: string, month: string, newLimit: number): Promise<void>;

  // ── Studio Voice Methods ──
  getStudioVoices(maxTier?: string): Promise<StudioVoice[]>;
  getStudioVoiceById(voiceId: string): Promise<StudioVoice | undefined>;
  createStudioVoice(data: InsertStudioVoice): Promise<StudioVoice>;

  // ── Studio Video Methods ──
  createStudioVideo(data: InsertStudioVideo): Promise<StudioVideo>;
  getStudioVideo(videoId: number): Promise<StudioVideo | undefined>;
  getStudioVideosByUser(userId: string): Promise<StudioVideo[]>;
  updateStudioVideoStatus(videoId: number, status: string, updates?: { progress?: number; outputUrl?: string; thumbnailUrl?: string; durationSeconds?: number; sceneCount?: number; errorMessage?: string }): Promise<StudioVideo | undefined>;

  // ── Studio Waitlist Methods ──
  createStudioWaitlistEntry(data: InsertStudioWaitlistEntry): Promise<StudioWaitlistEntry>;
  getStudioWaitlistByEmail(email: string): Promise<StudioWaitlistEntry | undefined>;
  hasApprovedStudioAccess(email: string): Promise<boolean>;
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

  async getBidById(bidId: number): Promise<MonetizationItem | undefined> {
    const [bid] = await db
      .select()
      .from(monetizationItems)
      .where(eq(monetizationItems.id, bidId));
    return bid;
  }

  async updateBidStatus(
    bidId: number,
    status: string,
    updates?: { placementId?: number; reviewSlug?: string; reviewNote?: string }
  ): Promise<MonetizationItem | undefined> {
    const setValues: Record<string, any> = { status };
    if (updates?.placementId !== undefined) setValues.placementId = updates.placementId;
    if (updates?.reviewSlug !== undefined) setValues.reviewSlug = updates.reviewSlug;
    if (updates?.reviewNote !== undefined) setValues.reviewNote = updates.reviewNote;

    const [updated] = await db
      .update(monetizationItems)
      .set(setValues)
      .where(eq(monetizationItems.id, bidId))
      .returning();
    return updated;
  }

  async getPlacementsByBidId(bidId: number): Promise<SavedPlacement[]> {
    return await db
      .select()
      .from(savedPlacements)
      .where(eq(savedPlacements.bidId, bidId))
      .orderBy(savedPlacements.createdAt);
  }

  async getVideoIndex(userId: string, authEmail?: string): Promise<VideoIndex[]> {
    console.log(`[Storage.getVideoIndex] Looking up user by ID: ${userId}, authEmail: ${authEmail}`);
    // First, try to get user by ID to also check by email
    const user = await this.getUserById(userId);
    const userEmail = user?.email;
    console.log(`[Storage.getVideoIndex] User found: ${!!user}, email: ${userEmail}`);

    // Collect all possible userId values to match against
    const matchValues = new Set<string>([userId]);
    if (userEmail) matchValues.add(userEmail);
    if (authEmail) matchValues.add(authEmail);

    const matchArray = Array.from(matchValues);
    console.log(`[Storage.getVideoIndex] Querying by userId IN [${matchArray.join(', ')}]`);

    const videos = await db
      .select()
      .from(videoIndex)
      .where(
        and(
          matchArray.length === 1
            ? eq(videoIndex.userId, matchArray[0])
            : sql`${videoIndex.userId} IN (${sql.join(matchArray.map(v => sql`${v}`), sql`, `)})`,
          sql`${videoIndex.deletedAt} IS NULL`
        )
      )
      .orderBy(desc(videoIndex.priorityScore));
    console.log(`[Storage.getVideoIndex] Found ${videos.length} videos`);

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

  async trashVideo(videoId: number): Promise<VideoIndex | undefined> {
    const [result] = await db.update(videoIndex)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(videoIndex.id, videoId))
      .returning();
    return result;
  }

  async restoreVideo(videoId: number): Promise<VideoIndex | undefined> {
    const [result] = await db.update(videoIndex)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(videoIndex.id, videoId))
      .returning();
    return result;
  }

  async getTrashedVideos(userId: string, authEmail?: string): Promise<VideoIndex[]> {
    if (authEmail && authEmail !== userId) {
      return db.select().from(videoIndex).where(
        and(
          or(eq(videoIndex.userId, userId), eq(videoIndex.userId, authEmail)),
          sql`${videoIndex.deletedAt} IS NOT NULL`
        )
      ).orderBy(desc(videoIndex.deletedAt));
    }
    return db.select().from(videoIndex).where(
      and(
        eq(videoIndex.userId, userId),
        sql`${videoIndex.deletedAt} IS NOT NULL`
      )
    ).orderBy(desc(videoIndex.deletedAt));
  }

  async permanentlyDeleteVideo(videoId: number): Promise<VideoIndex | undefined> {
    // Same as deleteVideoById — hard delete with cascading cleanup
    return this.deleteVideoById(videoId);
  }

  async getVideoById(id: number): Promise<VideoIndex | undefined> {
    const [video] = await db
      .select()
      .from(videoIndex)
      .where(eq(videoIndex.id, id));
    return video;
  }

  async getVideosByYoutubeIds(youtubeIds: string[]): Promise<VideoIndex[]> {
    if (youtubeIds.length === 0) return [];
    return db.select().from(videoIndex)
      .where(sql`${videoIndex.youtubeId} = ANY(${youtubeIds})`);
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
    // Include videos with "Ready" or "Scan Complete" status,
    // OR any video that has detected surfaces (covers migrated data with stale status)
    const videoIdsWithSurfaces = db
      .selectDistinct({ videoId: detectedSurfaces.videoId })
      .from(detectedSurfaces);

    const videos = await db
      .select()
      .from(videoIndex)
      .where(
        or(
          eq(videoIndex.status, "Ready"),
          eq(videoIndex.status, "Scan Complete"),
          sql`${videoIndex.status} LIKE 'Ready%'`,
          sql`${videoIndex.id} IN (${videoIdsWithSurfaces})`
        )
      )
      .orderBy(desc(videoIndex.priorityScore));

    const results: VideoWithOpportunities[] = [];

    for (const video of videos) {
      const surfaces = await this.getDetectedSurfaces(video.id);
      // Only include videos that actually have surfaces
      if (surfaces.length === 0) continue;
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

  // ── Brand Placement Assignment Methods ────────────────────────────────────

  /**
   * Statuses considered "active" — they hold a surface lock and prevent other
   * brands from requesting the same surface.
   */
  private readonly ACTIVE_PLACEMENT_STATUSES = ["pending_creator_review", "creator_approved"] as const;

  /**
   * Returns the active assignment for a surface, if any.
   * Used to enforce one-brand-per-surface.
   */
  async getActivePlacementForSurface(surfaceId: number): Promise<BrandPlacementAssignment | undefined> {
    const rows = await db
      .select()
      .from(brandPlacementAssignments)
      .where(
        and(
          eq(brandPlacementAssignments.surfaceId, surfaceId),
          or(
            eq(brandPlacementAssignments.status, "pending_creator_review"),
            eq(brandPlacementAssignments.status, "creator_approved"),
          ),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Create a placement assignment. Throws if the surface is already taken
   * by another active assignment (one-brand-per-surface invariant).
   */
  async createBrandPlacement(
    data: InsertBrandPlacementAssignment,
  ): Promise<BrandPlacementAssignment> {
    const existing = await this.getActivePlacementForSurface(data.surfaceId);
    if (existing) {
      const err = new Error(
        `Surface ${data.surfaceId} already has an active placement (assignment ${existing.id}, status=${existing.status})`,
      );
      (err as any).code = "SURFACE_TAKEN";
      (err as any).existingAssignmentId = existing.id;
      throw err;
    }
    const [row] = await db.insert(brandPlacementAssignments).values(data).returning();
    return row;
  }

  /**
   * List a brand's own assignments (optionally filtered by status).
   */
  async getBrandPlacements(
    brandUserId: string,
    status?: string,
  ): Promise<BrandPlacementAssignment[]> {
    const conditions = [eq(brandPlacementAssignments.brandUserId, brandUserId)];
    if (status) conditions.push(eq(brandPlacementAssignments.status, status));
    return await db
      .select()
      .from(brandPlacementAssignments)
      .where(and(...conditions))
      .orderBy(desc(brandPlacementAssignments.createdAt));
  }

  /**
   * Creator's inbox — assignments pending their review (or filter by any status).
   */
  async getCreatorPlacements(
    creatorUserId: string,
    status: string = "pending_creator_review",
  ): Promise<BrandPlacementAssignment[]> {
    return await db
      .select()
      .from(brandPlacementAssignments)
      .where(
        and(
          eq(brandPlacementAssignments.creatorUserId, creatorUserId),
          eq(brandPlacementAssignments.status, status),
        ),
      )
      .orderBy(desc(brandPlacementAssignments.createdAt));
  }

  /**
   * All approved placements for a video — used by the render pipeline to know
   * which brand products to composite onto which surfaces.
   */
  async getApprovedPlacementsForVideo(videoId: number): Promise<BrandPlacementAssignment[]> {
    return await db
      .select()
      .from(brandPlacementAssignments)
      .where(
        and(
          eq(brandPlacementAssignments.videoId, videoId),
          eq(brandPlacementAssignments.status, "creator_approved"),
        ),
      );
  }

  async getBrandPlacementById(id: number): Promise<BrandPlacementAssignment | undefined> {
    const rows = await db
      .select()
      .from(brandPlacementAssignments)
      .where(eq(brandPlacementAssignments.id, id))
      .limit(1);
    return rows[0];
  }

  /**
   * Update placement status. Sets reviewedAt when transitioning to a terminal state.
   */
  async updateBrandPlacementStatus(
    id: number,
    status: "creator_approved" | "creator_rejected" | "brand_withdrawn" | "expired",
    opts: { rejectionReason?: string } = {},
  ): Promise<BrandPlacementAssignment | undefined> {
    const patch: Record<string, any> = {
      status,
      updatedAt: new Date(),
    };
    if (status === "creator_approved" || status === "creator_rejected") {
      patch.reviewedAt = new Date();
    }
    if (opts.rejectionReason !== undefined) {
      patch.rejectionReason = opts.rejectionReason;
    }
    const [row] = await db
      .update(brandPlacementAssignments)
      .set(patch)
      .where(eq(brandPlacementAssignments.id, id))
      .returning();
    return row;
  }

  /**
   * Count of pending placements for a creator — used for inbox badge.
   */
  async countPendingPlacementsForCreator(creatorUserId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(brandPlacementAssignments)
      .where(
        and(
          eq(brandPlacementAssignments.creatorUserId, creatorUserId),
          eq(brandPlacementAssignments.status, "pending_creator_review"),
        ),
      );
    return result[0]?.count ?? 0;
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

  async getPlacementsByCreator(email: string): Promise<SavedPlacement[]> {
    return await db
      .select()
      .from(savedPlacements)
      .where(eq(savedPlacements.createdBy, email))
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
    // Set completedAt on any terminal state. Historical note: this used to check
    // for 'complete' (a value never written anywhere) instead of 'completed', so
    // successful jobs left completedAt=NULL forever. Also covers 'cancelled' now.
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      updates.completedAt = new Date();
    }
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

  async getClipById(clipId: number): Promise<GeneratedClip | undefined> {
    const [result] = await db.select().from(generatedClips)
      .where(eq(generatedClips.id, clipId));
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

  // ── Stitch Plan Methods ──

  async createStitchPlan(data: InsertStitchPlan): Promise<StitchPlan> {
    const [result] = await db.insert(stitchPlans).values(data).returning();
    return result;
  }

  async getStitchPlan(planId: number): Promise<StitchPlan | undefined> {
    const [result] = await db.select().from(stitchPlans)
      .where(eq(stitchPlans.id, planId));
    return result;
  }

  async getStitchPlansByVideo(videoId: number): Promise<StitchPlan[]> {
    return db.select().from(stitchPlans)
      .where(eq(stitchPlans.videoId, videoId))
      .orderBy(desc(stitchPlans.createdAt));
  }

  async updateStitchPlanStatus(
    planId: number,
    status: string,
    updates?: { outputPath?: string; thumbnailPath?: string; qualityScore?: number; generatedClipId?: number; errorMessage?: string }
  ): Promise<StitchPlan | undefined> {
    const setData: Record<string, any> = { status };
    if (updates?.outputPath) setData.outputPath = updates.outputPath;
    if (updates?.thumbnailPath) setData.thumbnailPath = updates.thumbnailPath;
    if (updates?.qualityScore !== undefined) setData.qualityScore = updates.qualityScore;
    if (updates?.generatedClipId !== undefined) setData.generatedClipId = updates.generatedClipId;
    if (updates?.errorMessage) setData.errorMessage = updates.errorMessage;
    if (status === 'completed') setData.completedAt = new Date();

    const [result] = await db.update(stitchPlans)
      .set(setData)
      .where(eq(stitchPlans.id, planId))
      .returning();
    return result;
  }

  async deleteStitchPlan(planId: number): Promise<void> {
    await db.delete(stitchPlans).where(eq(stitchPlans.id, planId));
  }

  // ── Editorial Clips Methods ──

  async saveEditorialClips(videoId: number, userId: number, clips: any[]): Promise<EditorialClip[]> {
    // Delete existing clips for this video first (re-analysis replaces old results)
    await db.delete(editorialClips).where(eq(editorialClips.videoId, videoId));

    if (clips.length === 0) return [];

    const rows = clips.map((clip: any) => ({
      videoId,
      userId,
      clipStart: clip.clipStart,
      clipEnd: clip.clipEnd,
      duration: clip.duration,
      editorialScore: clip.editorialScore ?? null,
      surfaceScore: clip.surfaceScore ?? null,
      brandMatchScore: clip.brandMatchScore ?? null,
      finalScore: clip.finalScore ?? null,
      monetizationTier: clip.monetizationTier ?? null,
      scores: clip.scores ?? null,
      surfaces: clip.surfaces ?? null,
      brandMatches: clip.brandMatches ?? null,
      editPoints: clip.editPoints ?? null,
      suggestedTitle: clip.suggestedTitle ?? null,
      topicTags: clip.topicTags ?? null,
      reasoning: clip.reasoning ?? null,
      rawClipStart: clip.rawClipStart ?? null,
      rawClipEnd: clip.rawClipEnd ?? null,
    }));

    return db.insert(editorialClips).values(rows).returning();
  }

  async getEditorialClipsByVideo(videoId: number): Promise<EditorialClip[]> {
    return db.select().from(editorialClips)
      .where(eq(editorialClips.videoId, videoId))
      .orderBy(desc(editorialClips.finalScore));
  }

  async deleteEditorialClipsByVideo(videoId: number): Promise<void> {
    await db.delete(editorialClips).where(eq(editorialClips.videoId, videoId));
  }

  async updateEditorialClipRender(
    clipId: number,
    updates: {
      exportPath?: string | null;
      thumbnailPath?: string | null;
      aspectRatio?: string | null;
      renderStatus?: "pending" | "rendering" | "rendered" | "failed";
      renderError?: string | null;
    }
  ): Promise<EditorialClip | undefined> {
    const patch: Record<string, any> = {};
    if (updates.exportPath !== undefined) patch.exportPath = updates.exportPath;
    if (updates.thumbnailPath !== undefined) patch.thumbnailPath = updates.thumbnailPath;
    if (updates.aspectRatio !== undefined) patch.aspectRatio = updates.aspectRatio;
    if (updates.renderStatus !== undefined) patch.renderStatus = updates.renderStatus;
    if (updates.renderError !== undefined) patch.renderError = updates.renderError;
    if (updates.renderStatus === "rendered") patch.renderedAt = new Date();

    const [result] = await db.update(editorialClips)
      .set(patch)
      .where(eq(editorialClips.id, clipId))
      .returning();
    return result;
  }

  async updateVideoEditorialStatus(
    videoId: number,
    status: "pending" | "transcribing" | "analyzing" | "rendering" | "ready" | "failed",
    updates: { error?: string | null; clipCount?: number; completedAt?: Date | null } = {}
  ): Promise<void> {
    const patch: Record<string, any> = {
      editorialStatus: status,
      updatedAt: new Date(),
    };
    if (updates.error !== undefined) patch.editorialError = updates.error;
    if (updates.clipCount !== undefined) patch.editorialClipCount = updates.clipCount;
    if (status === "ready") patch.editorialCompletedAt = updates.completedAt ?? new Date();
    else if (updates.completedAt !== undefined) patch.editorialCompletedAt = updates.completedAt;

    await db.update(videoIndex).set(patch).where(eq(videoIndex.id, videoId));
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

  // ─── Video Transcript Methods ──────────────────────────────────

  async createVideoTranscript(data: InsertVideoTranscript): Promise<VideoTranscript> {
    const [result] = await db.insert(videoTranscripts).values(data).returning();
    return result;
  }

  async getVideoTranscript(videoId: number): Promise<VideoTranscript | undefined> {
    const [result] = await db.select()
      .from(videoTranscripts)
      .where(eq(videoTranscripts.videoId, videoId))
      .orderBy(desc(videoTranscripts.createdAt))
      .limit(1);
    return result;
  }

  async updateVideoTranscriptStatus(
    transcriptId: number,
    status: string,
    errorMessage?: string
  ): Promise<VideoTranscript | undefined> {
    const updateData: Record<string, any> = { status, updatedAt: new Date() };
    if (errorMessage) updateData.errorMessage = errorMessage;

    const [result] = await db.update(videoTranscripts)
      .set(updateData)
      .where(eq(videoTranscripts.id, transcriptId))
      .returning();
    return result;
  }

  async updateVideoTranscript(
    transcriptId: number,
    data: Partial<InsertVideoTranscript>
  ): Promise<VideoTranscript | undefined> {
    const [result] = await db.update(videoTranscripts)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(videoTranscripts.id, transcriptId))
      .returning();
    return result;
  }

  // ─── Clip Feedback Methods ───────────────────────────────────

  async createClipFeedback(data: InsertClipFeedback): Promise<ClipFeedback> {
    const [result] = await db.insert(clipFeedback).values(data).returning();
    return result;
  }

  async getClipFeedback(clipId: number): Promise<ClipFeedback[]> {
    return db.select()
      .from(clipFeedback)
      .where(eq(clipFeedback.generatedClipId, clipId))
      .orderBy(desc(clipFeedback.createdAt));
  }

  async getPerformanceFeedback(): Promise<ClipFeedback[]> {
    return db.select()
      .from(clipFeedback)
      .where(eq(clipFeedback.feedbackType, "performance"))
      .orderBy(desc(clipFeedback.createdAt));
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

  // ─── Surface Keyframe Methods (Phase 2A Motion Tracking) ─────

  async createSurfaceKeyframe(data: InsertSurfaceKeyframe): Promise<SurfaceKeyframe> {
    const [result] = await db.insert(surfaceKeyframes).values(data).returning();
    return result;
  }

  async insertSurfaceKeyframe(data: InsertSurfaceKeyframe): Promise<SurfaceKeyframe> {
    return this.createSurfaceKeyframe(data);
  }

  async bulkInsertSurfaceKeyframes(data: InsertSurfaceKeyframe[]): Promise<void> {
    if (data.length === 0) return;
    await db.insert(surfaceKeyframes).values(data);
  }

  async getSurfaceKeyframes(surfaceId: number): Promise<SurfaceKeyframe[]> {
    return db.select()
      .from(surfaceKeyframes)
      .where(eq(surfaceKeyframes.surfaceId, surfaceId))
      .orderBy(surfaceKeyframes.timestamp);
  }

  async getSurfaceKeyframesInRange(
    surfaceId: number,
    startTime: number,
    endTime: number
  ): Promise<SurfaceKeyframe[]> {
    return db.select()
      .from(surfaceKeyframes)
      .where(
        and(
          eq(surfaceKeyframes.surfaceId, surfaceId),
          sql`${surfaceKeyframes.timestamp}::numeric >= ${startTime}`,
          sql`${surfaceKeyframes.timestamp}::numeric <= ${endTime}`,
        )
      )
      .orderBy(surfaceKeyframes.timestamp);
  }

  async getKeyframesByVideo(videoId: number): Promise<SurfaceKeyframe[]> {
    return db.select()
      .from(surfaceKeyframes)
      .where(eq(surfaceKeyframes.videoId, videoId))
      .orderBy(surfaceKeyframes.timestamp);
  }

  async deleteKeyframesBySurface(surfaceId: number): Promise<void> {
    await db.delete(surfaceKeyframes)
      .where(eq(surfaceKeyframes.surfaceId, surfaceId));
  }

  async deleteSurfaceKeyframesInRange(
    surfaceId: number,
    startTime: number,
    endTime: number
  ): Promise<void> {
    await db.delete(surfaceKeyframes)
      .where(
        and(
          eq(surfaceKeyframes.surfaceId, surfaceId),
          sql`${surfaceKeyframes.timestamp}::numeric >= ${startTime}`,
          sql`${surfaceKeyframes.timestamp}::numeric <= ${endTime}`,
        )
      );
  }

  // Creator profile methods
  async getFeaturedCreators(): Promise<AllowedUser[]> {
    return await db
      .select()
      .from(allowedUsers)
      .where(eq(allowedUsers.isFeatured, true));
  }

  async getCreatorBySlug(slug: string): Promise<AllowedUser | undefined> {
    const [user] = await db
      .select()
      .from(allowedUsers)
      .where(eq(allowedUsers.slug, slug.toLowerCase()));
    return user;
  }

  async updateCreatorProfile(
    email: string,
    updates: { bio?: string; headline?: string; podcastName?: string; podcastUrl?: string; websiteUrl?: string; slug?: string }
  ): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim();
    await db
      .update(allowedUsers)
      .set(updates)
      .where(eq(allowedUsers.email, normalizedEmail));
  }

  async updateVideoSubcategory(videoId: number, subcategory: string): Promise<void> {
    await db
      .update(videoIndex)
      .set({ subcategory })
      .where(eq(videoIndex.id, videoId));
  }

  // ============================================================================
  // STUDIO SUBSCRIPTION METHODS
  // ============================================================================

  async getStudioSubscription(userId: string): Promise<StudioSubscription | undefined> {
    const [sub] = await db
      .select()
      .from(studioSubscriptions)
      .where(eq(studioSubscriptions.userId, userId));
    return sub;
  }

  async createStudioSubscription(data: InsertStudioSubscription): Promise<StudioSubscription> {
    const [sub] = await db
      .insert(studioSubscriptions)
      .values(data)
      .returning();
    return sub;
  }

  async updateStudioSubscription(userId: string, updates: Partial<InsertStudioSubscription>): Promise<StudioSubscription | undefined> {
    const [sub] = await db
      .update(studioSubscriptions)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(studioSubscriptions.userId, userId))
      .returning();
    return sub;
  }

  async getStudioSubscriptionByStripeCustomer(stripeCustomerId: string): Promise<StudioSubscription | undefined> {
    const [sub] = await db
      .select()
      .from(studioSubscriptions)
      .where(eq(studioSubscriptions.stripeCustomerId, stripeCustomerId));
    return sub;
  }

  async getStudioSubscriptionByStripeSubscription(stripeSubscriptionId: string): Promise<StudioSubscription | undefined> {
    const [sub] = await db
      .select()
      .from(studioSubscriptions)
      .where(eq(studioSubscriptions.stripeSubscriptionId, stripeSubscriptionId));
    return sub;
  }

  // ============================================================================
  // STUDIO USAGE METHODS
  // ============================================================================

  async getStudioUsage(userId: string, month: string): Promise<StudioUsage | undefined> {
    const [usage] = await db
      .select()
      .from(studioUsage)
      .where(and(eq(studioUsage.userId, userId), eq(studioUsage.month, month)));
    return usage;
  }

  async createStudioUsage(data: InsertStudioUsage): Promise<StudioUsage> {
    const [usage] = await db
      .insert(studioUsage)
      .values(data)
      .returning();
    return usage;
  }

  async incrementStudioUsage(userId: string, month: string): Promise<StudioUsage> {
    const [usage] = await db
      .update(studioUsage)
      .set({ videosGenerated: sql`${studioUsage.videosGenerated} + 1` })
      .where(and(eq(studioUsage.userId, userId), eq(studioUsage.month, month)))
      .returning();
    return usage;
  }

  async updateStudioUsageLimit(userId: string, month: string, newLimit: number): Promise<void> {
    await db
      .update(studioUsage)
      .set({ videosLimit: newLimit })
      .where(and(eq(studioUsage.userId, userId), eq(studioUsage.month, month)));
  }

  // ============================================================================
  // STUDIO VOICE METHODS
  // ============================================================================

  async getStudioVoices(maxTier?: string): Promise<StudioVoice[]> {
    const tierOrder = ["free", "starter", "pro", "business"];
    if (maxTier) {
      const maxIndex = tierOrder.indexOf(maxTier);
      const allowedTiers = tierOrder.slice(0, maxIndex + 1);
      return await db
        .select()
        .from(studioVoices)
        .where(and(
          eq(studioVoices.isActive, true),
          sql`${studioVoices.tier} = ANY(${allowedTiers})`
        ));
    }
    return await db
      .select()
      .from(studioVoices)
      .where(eq(studioVoices.isActive, true));
  }

  async getStudioVoiceById(voiceId: string): Promise<StudioVoice | undefined> {
    const [voice] = await db
      .select()
      .from(studioVoices)
      .where(eq(studioVoices.voiceId, voiceId));
    return voice;
  }

  async createStudioVoice(data: InsertStudioVoice): Promise<StudioVoice> {
    const [voice] = await db
      .insert(studioVoices)
      .values(data)
      .returning();
    return voice;
  }

  // ============================================================================
  // STUDIO VIDEO METHODS
  // ============================================================================

  async createStudioVideo(data: InsertStudioVideo): Promise<StudioVideo> {
    const [video] = await db
      .insert(studioVideos)
      .values(data)
      .returning();
    return video;
  }

  async getStudioVideo(videoId: number): Promise<StudioVideo | undefined> {
    const [video] = await db
      .select()
      .from(studioVideos)
      .where(eq(studioVideos.id, videoId));
    return video;
  }

  async getStudioVideosByUser(userId: string): Promise<StudioVideo[]> {
    return await db
      .select()
      .from(studioVideos)
      .where(eq(studioVideos.userId, userId))
      .orderBy(desc(studioVideos.createdAt));
  }

  async updateStudioVideoStatus(
    videoId: number,
    status: string,
    updates?: { progress?: number; outputUrl?: string; thumbnailUrl?: string; durationSeconds?: number; sceneCount?: number; errorMessage?: string }
  ): Promise<StudioVideo | undefined> {
    const [video] = await db
      .update(studioVideos)
      .set({
        status,
        ...(updates?.progress !== undefined && { progress: updates.progress }),
        ...(updates?.outputUrl && { outputUrl: updates.outputUrl }),
        ...(updates?.thumbnailUrl && { thumbnailUrl: updates.thumbnailUrl }),
        ...(updates?.durationSeconds !== undefined && { durationSeconds: updates.durationSeconds }),
        ...(updates?.sceneCount !== undefined && { sceneCount: updates.sceneCount }),
        ...(updates?.errorMessage && { errorMessage: updates.errorMessage }),
        ...(status === "completed" && { completedAt: new Date() }),
      })
      .where(eq(studioVideos.id, videoId))
      .returning();
    return video;
  }

  // ── Studio Waitlist ────────────────────────────────────────────────

  async createStudioWaitlistEntry(data: InsertStudioWaitlistEntry): Promise<StudioWaitlistEntry> {
    const [entry] = await db.insert(studioWaitlist).values(data).returning();
    return entry;
  }

  async getStudioWaitlistByEmail(email: string): Promise<StudioWaitlistEntry | undefined> {
    const [entry] = await db
      .select()
      .from(studioWaitlist)
      .where(eq(studioWaitlist.email, email.toLowerCase().trim()))
      .orderBy(desc(studioWaitlist.submittedAt))
      .limit(1);
    return entry;
  }

  async hasApprovedStudioAccess(email: string): Promise<boolean> {
    const normalized = email.toLowerCase().trim();
    if (["martin@gofullscale.co"].includes(normalized)) return true;
    const [entry] = await db
      .select({ status: studioWaitlist.status })
      .from(studioWaitlist)
      .where(
        and(
          eq(studioWaitlist.email, normalized),
          eq(studioWaitlist.status, "approved"),
        ),
      )
      .limit(1);
    return !!entry;
  }

  // ── Brand Brief Methods ──────────────────────────────────────────────
  // One brief per user (userId UNIQUE on the table). upsert uses
  // onConflictDoUpdate so the client can autosave every field change
  // without worrying about whether a row already exists.

  async getBrandBriefByUserId(userId: string): Promise<BrandBrief | undefined> {
    const [brief] = await db
      .select()
      .from(brandBriefs)
      .where(eq(brandBriefs.userId, userId))
      .limit(1);
    return brief;
  }

  async upsertBrandBrief(
    userId: string,
    data: Partial<InsertBrandBrief>,
  ): Promise<BrandBrief> {
    // Scrub userId/status out of data — caller should never control these
    // via the update payload; they're derived from the authenticated
    // session and the submit endpoint respectively.
    const { userId: _u, status: _s, ...safeData } = data as any;

    const [result] = await db
      .insert(brandBriefs)
      .values({
        userId,
        status: "draft",
        ...safeData,
      })
      .onConflictDoUpdate({
        target: brandBriefs.userId,
        set: {
          ...safeData,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result;
  }

  async submitBrandBrief(userId: string): Promise<BrandBrief | undefined> {
    const now = new Date();
    const [result] = await db
      .update(brandBriefs)
      .set({
        status: "submitted",
        submittedAt: now,
        updatedAt: now,
      })
      .where(eq(brandBriefs.userId, userId))
      .returning();
    return result;
  }
}

export const storage = new DatabaseStorage();
