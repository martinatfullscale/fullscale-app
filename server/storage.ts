import { db } from "./db";
import { eq, desc, and, or, sql, inArray, ne } from "drizzle-orm";
import {
  monetizationItems,
  youtubeConnections,
  allowedUsers,
  videoIndex,
  detectedSurfaces,
  brandProducts,
  brandPlacementAssignments,
  notifications,
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
  socialAccounts,
  type SocialAccount,
  type InsertSocialAccount,
  dataDeletionRequests,
  type DataDeletionRequest,
  type InsertDataDeletionRequest,
  socialInsightSnapshots,
  type InsertSocialInsightSnapshot,
  roomModels,
  type RoomModel,
  type InsertRoomModel,
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
  /** Flip users.isApproved for an existing user. Returns false if no
   *  user row matches the email (caller should treat as "allowlisted
   *  but not signed in yet" — fine, OAuth will flip approval on signin). */
  setUserApproved(email: string, approved: boolean): Promise<boolean>;
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
  findVideoIndexRow(userId: string, youtubeId: string): Promise<VideoIndex | undefined>;
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
  updateVideoStatusIfScanning(videoId: number, status: string): Promise<boolean>;
  updateVideoThumbnail(videoId: number, thumbnailUrl: string): Promise<void>;
  updateVideoIndex(videoId: number, updates: Partial<InsertVideoIndex>): Promise<void>;
  updateVideoMetadata(videoId: number, metadata: { sentiment?: string; culturalContext?: string }): Promise<void>;
  getSceneInventory(videoId: number): Promise<unknown>;
  insertDetectedSurface(surface: InsertDetectedSurface): Promise<DetectedSurface>;
  updateDetectedSurface(surfaceId: number, updates: { surfaceType?: string; sceneContext?: string; surroundings?: string[]; boundingBoxX?: string; boundingBoxY?: string; boundingBoxWidth?: string; boundingBoxHeight?: string; surfaceGroupId?: string }): Promise<void>;
  getDetectedSurfaces(videoId: number): Promise<DetectedSurface[]>;
  getSurfaceCountByVideo(videoId: number): Promise<number>;
  getSurfaceCountsForVideos(videoIds: number[]): Promise<Map<number, number>>;
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
  getSharedLinkByBrandPlacement(brandPlacementId: number): Promise<SharedLink | undefined>;
  getSharedLinkById(id: number): Promise<SharedLink | undefined>;
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
  getActiveRemixJobForVideo(videoId: number): Promise<RemixJob | undefined>;
  failInterruptedRemixJobs(): Promise<number>;
  failInterruptedStitchPlans(): Promise<number>;
  createNotification(data: { userId: string; type: string; title: string; body?: string | null; linkPath?: string | null; metadata?: Record<string, any> | null }): Promise<void>;
  getNotificationsForUser(userId: string, limit?: number): Promise<any[]>;
  getUnreadNotificationCount(userId: string): Promise<number>;
  markNotificationRead(id: number, userId: string): Promise<boolean>;
  markAllNotificationsRead(userId: string): Promise<number>;
  markPlacementNotificationsRead(placementId: number): Promise<void>;
  claimSchedule(scheduleId: number): Promise<boolean>;
  cancelOrphanedLegacySchedules(): Promise<number>;
  normalizeLegacyIdentityKeys(): Promise<Record<string, number>>;
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
      qualityScore?: number | null;
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
  cancelSchedule(scheduleId: number, userId?: number): Promise<boolean>;

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

  // Room model methods (persistent set memory for the scanner)
  getRoomModelsForUsers(userIds: string[]): Promise<RoomModel[]>;
  getRoomModelById(id: number): Promise<RoomModel | undefined>;
  getAllRoomModels(): Promise<RoomModel[]>;
  insertRoomModel(model: InsertRoomModel): Promise<RoomModel>;
  updateRoomModel(id: number, patch: { sceneExemplarHashes?: string[]; surfaces?: unknown; lastVideoId?: number; episodeCount?: number }): Promise<void>;
  appendRoomModelSurface(modelId: number, surface: { surfaceType: string; orientation: "horizontal" | "vertical"; bbox: { x: number; y: number; w: number; h: number }; confidence: number; frameUrl: string | null; taught?: boolean }): Promise<number>;
  deleteRoomModel(id: number): Promise<boolean>;
  deleteAllRoomModels(): Promise<number>;

  // Creator profile methods
  getFeaturedCreators(): Promise<AllowedUser[]>;
  getCreatorBySlug(slug: string): Promise<AllowedUser | undefined>;
  updateCreatorProfile(email: string, updates: { bio?: string; headline?: string; podcastName?: string; podcastUrl?: string; websiteUrl?: string; slug?: string; cardImageUrl?: string | null }): Promise<void>;
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

  async setUserApproved(email: string, approved: boolean): Promise<boolean> {
    const normalizedEmail = email.toLowerCase().trim();
    const result = await db
      .update(users)
      .set({ isApproved: approved })
      .where(eq(users.email, normalizedEmail))
      .returning({ id: users.id });
    return result.length > 0;
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

  // ─── Social Accounts (multi-account creator identity) ────────────────────
  // Reads decrypt access_token/refresh_token on the way out; writes encrypt
  // them on the way in. Matches the pattern used for youtube_connections.

  private decryptSocialAccount(account: SocialAccount): SocialAccount {
    try {
      return {
        ...account,
        accessToken: account.accessToken ? decrypt(account.accessToken) : null,
        refreshToken: account.refreshToken ? decrypt(account.refreshToken) : null,
      };
    } catch {
      // If decryption fails (e.g. legacy plaintext or key change), return raw
      return account;
    }
  }

  async getSocialAccountsByUser(userId: string, userEmail?: string): Promise<SocialAccount[]> {
    // Match either userId — same dual-id problem as videoIndex (some records
    // keyed by UUID, others by email). Pass both when available.
    const candidates = new Set([userId]);
    if (userEmail && userEmail !== userId) candidates.add(userEmail);
    const matchArray = Array.from(candidates);

    const rows = await db
      .select()
      .from(socialAccounts)
      .where(matchArray.length === 1
        ? eq(socialAccounts.userId, matchArray[0])
        : inArray(socialAccounts.userId, matchArray));

    return rows.map(r => this.decryptSocialAccount(r));
  }

  async getSocialAccount(id: string): Promise<SocialAccount | undefined> {
    const [row] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, id));
    return row ? this.decryptSocialAccount(row) : undefined;
  }

  /** Remove a user's facebook/instagram social_accounts (+ their snapshots)
   *  — called before writing a freshly-confirmed Page so switching Pages
   *  doesn't leave stale rows the snapshot cron keeps polling. */
  async replaceMetaSocialAccounts(userId: string): Promise<void> {
    const rows = await db
      .select({ id: socialAccounts.id })
      .from(socialAccounts)
      .where(and(
        eq(socialAccounts.userId, userId),
        inArray(socialAccounts.platform, ["instagram", "facebook"]),
      ));
    for (const r of rows) {
      await db.delete(socialInsightSnapshots).where(eq(socialInsightSnapshots.socialAccountId, r.id));
    }
    await db.delete(socialAccounts).where(and(
      eq(socialAccounts.userId, userId),
      inArray(socialAccounts.platform, ["instagram", "facebook"]),
    ));
  }

  /** All Meta accounts with a stored token — the snapshot job's work list. */
  async getAllMetaSocialAccounts(): Promise<SocialAccount[]> {
    const rows = await db
      .select()
      .from(socialAccounts)
      .where(and(
        inArray(socialAccounts.platform, ["instagram", "facebook"]),
        sql`${socialAccounts.accessToken} IS NOT NULL`
      ));
    return rows.map(r => this.decryptSocialAccount(r));
  }

  async insertSocialInsightSnapshot(snapshot: InsertSocialInsightSnapshot): Promise<void> {
    await db.insert(socialInsightSnapshots).values(snapshot);
  }

  /** Snapshot history for one account, newest first — the trend-chart feed. */
  async getSocialInsightSnapshotsForAccount(socialAccountId: string, limit: number = 60): Promise<any[]> {
    return await db
      .select()
      .from(socialInsightSnapshots)
      .where(eq(socialInsightSnapshots.socialAccountId, socialAccountId))
      .orderBy(desc(socialInsightSnapshots.capturedAt))
      .limit(limit);
  }

  // ── Meta data deletion (App Review compliance) ──

  async createDataDeletionRequest(req: InsertDataDeletionRequest): Promise<DataDeletionRequest> {
    const [row] = await db.insert(dataDeletionRequests).values(req).returning();
    return row;
  }

  async getDataDeletionRequestByCode(code: string): Promise<DataDeletionRequest | undefined> {
    const [row] = await db
      .select()
      .from(dataDeletionRequests)
      .where(eq(dataDeletionRequests.confirmationCode, code));
    return row;
  }

  /**
   * Delete everything we hold that came from a Meta user's grant: their
   * facebook/instagram social_accounts rows (+ insight snapshots for those
   * accounts) and the Meta fields cached on the users row. The app-scoped
   * FB user id arrives in Meta's signed deletion request and matches
   * users.facebookId (stored at OAuth time).
   */
  async deleteMetaDataForFacebookUser(fbUserId: string): Promise<{ deleted: Record<string, number>; matchedUser: boolean }> {
    const deleted: Record<string, number> = {};
    const [user] = await db.select().from(users).where(eq(users.facebookId, fbUserId));

    const ownerKeys = new Set<string>();
    if (user?.id) ownerKeys.add(user.id);
    if (user?.email) ownerKeys.add(user.email);

    // Account rows for this user (or, absent a users row, any account keyed
    // directly by the app-scoped id — defensive; normally page/ig ids differ).
    const accountRows = ownerKeys.size > 0
      ? await db.select().from(socialAccounts).where(and(
          inArray(socialAccounts.userId, Array.from(ownerKeys)),
          inArray(socialAccounts.platform, ["instagram", "facebook"]),
        ))
      : await db.select().from(socialAccounts).where(eq(socialAccounts.platformAccountId, fbUserId));

    for (const acct of accountRows) {
      const snaps: any = await db.delete(socialInsightSnapshots)
        .where(eq(socialInsightSnapshots.socialAccountId, acct.id))
        .returning({ id: socialInsightSnapshots.id });
      deleted["social_insight_snapshots"] = (deleted["social_insight_snapshots"] || 0) + (snaps?.length || 0);
      await db.delete(socialAccounts).where(eq(socialAccounts.id, acct.id));
      deleted["social_accounts"] = (deleted["social_accounts"] || 0) + 1;
    }

    if (user) {
      await db.update(users).set({
        facebookId: null,
        instagramId: null,
        facebookPageId: null,
        facebookPageName: null,
        facebookFollowers: null,
        facebookAccessToken: null,
        instagramBusinessId: null,
        instagramHandle: null,
        instagramFollowers: null,
        updatedAt: new Date(),
      }).where(eq(users.id, user.id));
      deleted["users.meta_fields"] = 1;
    }

    return { deleted, matchedUser: !!user };
  }

  async upsertSocialAccount(account: InsertSocialAccount): Promise<SocialAccount> {
    const encryptedValues = {
      ...account,
      accessToken: account.accessToken ? encrypt(account.accessToken) : null,
      refreshToken: account.refreshToken ? encrypt(account.refreshToken) : null,
    };

    // Conflict target is the unique index (user_id, platform, account_type, platform_account_id).
    // On conflict, refresh tokens, audience data, and metadata; preserve created_at.
    const [result] = await db
      .insert(socialAccounts)
      .values(encryptedValues)
      .onConflictDoUpdate({
        target: [
          socialAccounts.userId,
          socialAccounts.platform,
          socialAccounts.accountType,
          socialAccounts.platformAccountId,
        ],
        set: {
          handle: account.handle,
          displayName: account.displayName,
          avatarUrl: account.avatarUrl,
          bio: account.bio,
          followers: account.followers,
          totalViews: account.totalViews,
          accessToken: encryptedValues.accessToken,
          refreshToken: encryptedValues.refreshToken,
          tokenExpiresAt: account.tokenExpiresAt,
          scopes: account.scopes,
          audienceData: account.audienceData,
          audienceSyncedAt: account.audienceSyncedAt,
          metadata: account.metadata,
          updatedAt: new Date(),
        },
      })
      .returning();

    return this.decryptSocialAccount(result);
  }

  async updateSocialAccountAudience(id: string, audienceData: any): Promise<void> {
    await db.update(socialAccounts)
      .set({ audienceData, audienceSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(socialAccounts.id, id));
  }

  async deleteSocialAccount(id: string): Promise<void> {
    await db.delete(socialAccounts).where(eq(socialAccounts.id, id));
  }

  // Used by the daily audience-refresh cron. Returns every connected social
  // account across all users so the cron can iterate without needing to
  // enumerate users separately.
  async getAllSocialAccounts(): Promise<SocialAccount[]> {
    const rows = await db.select().from(socialAccounts);
    return rows.map(r => this.decryptSocialAccount(r));
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

  /**
   * Resolve every identifier form (users.id + email) for a mixed-key identity
   * column match. Mirrors getVideoIndex's dual-form lookup: the boot sweep
   * (normalizeLegacyIdentityKeys) rewrites email-keyed rows to users.id, so
   * exact-email readers would silently return nothing post-sweep without this.
   */
  private async identityMatchValues(userId: string): Promise<string[]> {
    const matchValues = new Set<string>([userId]);
    try {
      let user = await this.getUserById(userId);
      if (!user && userId.includes("@")) user = await this.getUserByEmail(userId);
      if (user?.id) matchValues.add(user.id);
      if (user?.email) matchValues.add(user.email);
    } catch { /* fall back to the raw value */ }
    return Array.from(matchValues);
  }

  async getActiveBidsForCreator(creatorUserId: string): Promise<MonetizationItem[]> {
    const ids = await this.identityMatchValues(creatorUserId);
    return await db
      .select()
      .from(monetizationItems)
      .where(and(
        inArray(monetizationItems.creatorUserId, ids),
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
    // videoIndex.userId is a mixed-key column: newer rows store users.id, legacy
    // rows store the creator's email. Resolve the user from either form so the
    // match set always carries both identifiers.
    let user = await this.getUserById(userId);
    if (!user && userId.includes("@")) {
      user = await this.getUserByEmail(userId);
    }
    const userEmail = user?.email;
    console.log(`[Storage.getVideoIndex] User found: ${!!user}, email: ${userEmail}`);

    // Collect all possible userId values to match against
    const matchValues = new Set<string>([userId]);
    if (user?.id) matchValues.add(user.id);
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

    // Pre-fetch surface counts for smarter dedup (keep the best-scanned
    // version) — one batched GROUP BY, not a query per video.
    const surfaceCounts = await this.getSurfaceCountsForVideos(videos.map((v) => v.id));

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

  async findVideoIndexRow(userId: string, youtubeId: string): Promise<VideoIndex | undefined> {
    const ids = await this.identityMatchValues(userId);
    const [existing] = await db
      .select()
      .from(videoIndex)
      .where(and(
        inArray(videoIndex.userId, ids),
        eq(videoIndex.youtubeId, youtubeId)
      ));
    return existing;
  }

  async upsertVideoIndex(video: InsertVideoIndex): Promise<VideoIndex> {
    // Alias-aware existence check: the indexer still writes email keys while
    // the boot sweep converges rows to users.id — an exact-email match would
    // miss the normalized row and INSERT a duplicate on every refresh.
    const ids = await this.identityMatchValues(video.userId);
    const [existing] = await db
      .select()
      .from(videoIndex)
      .where(and(
        inArray(videoIndex.userId, ids),
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
      .where(inArray(videoIndex.youtubeId, youtubeIds));
  }

  async getPendingVideos(userId: string, limit: number = 10): Promise<VideoIndex[]> {
    const ids = await this.identityMatchValues(userId);
    return await db
      .select()
      .from(videoIndex)
      .where(and(
        inArray(videoIndex.userId, ids),
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

  // Atomic compare-and-set: write the status (and bump updatedAt) only if
  // the row still says "Scanning". A cancel or stuck-scan sweep that landed
  // first wins — the conditional UPDATE can never clobber it. Returns
  // whether a row was updated. Calling with status "Scanning" is a pure
  // heartbeat: it refreshes updatedAt without changing anything else.
  async updateVideoStatusIfScanning(videoId: number, status: string): Promise<boolean> {
    const result = await db
      .update(videoIndex)
      .set({ status, updatedAt: new Date() })
      .where(and(
        eq(videoIndex.id, videoId),
        eq(videoIndex.status, "Scanning"),
      ))
      .returning({ id: videoIndex.id });
    return result.length > 0;
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

  // Fetch just the scene-block inventory without dragging the full video row
  // (sceneIndex + sceneBoundaries blobs) across the wire. Null for videos
  // scanned before surface grouping shipped, or not yet scanned at all —
  // callers must fall back to the flat surface list in that case.
  async getSceneInventory(videoId: number): Promise<unknown> {
    const [row] = await db
      .select({ sceneInventory: videoIndex.sceneInventory })
      .from(videoIndex)
      .where(eq(videoIndex.id, videoId));
    return row?.sceneInventory ?? null;
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
    surfaceGroupId?: string;
  }): Promise<void> {
    await db
      .update(detectedSurfaces)
      .set(updates)
      .where(eq(detectedSurfaces.id, surfaceId));
  }

  // Toggle the creator-approved flag for a single surface. Used by the
  // creator's per-surface review toggle in the scene modal.
  async updateSurfaceApproval(surfaceId: number, approved: boolean): Promise<void> {
    await db
      .update(detectedSurfaces)
      .set({ creatorApproved: approved })
      .where(eq(detectedSurfaces.id, surfaceId));
  }

  async getDetectedSurfaces(videoId: number): Promise<DetectedSurface[]> {
    return await db
      .select()
      .from(detectedSurfaces)
      .where(eq(detectedSurfaces.videoId, videoId))
      .orderBy(detectedSurfaces.timestamp);
  }

  async getSurfaceCountsForVideos(videoIds: number[]): Promise<Map<number, number>> {
    // Batched form of getSurfaceCountByVideo (same Filtered exclusion, same
    // group-distinct semantics): ONE GROUP BY instead of a query per video.
    // The per-video version called in a loop over ~80 videos exhausted the
    // 10-connection pool whenever a render had the CPU — observed in prod as
    // "timeout exceeded when trying to connect" unhandled rejections and 17s
    // library responses.
    const counts = new Map<number, number>();
    if (videoIds.length === 0) return counts;
    const rows = await db
      .select({
        videoId: detectedSurfaces.videoId,
        // Count canonical surfaces, not per-frame rows — the scanner writes
        // one row per supporting frame, so count(*) reports "12 Spots" for
        // one desk seen in 12 frames. Rows from before grouping shipped have
        // null surface_group_id; fall back to a (type, scene) composite so
        // legacy scans keep a sane count instead of the inflated row count.
        count: sql<number>`count(DISTINCT COALESCE(${detectedSurfaces.surfaceGroupId}, ${detectedSurfaces.surfaceType} || ':' || COALESCE(${detectedSurfaces.sceneId}, 0)::text))::int`,
      })
      .from(detectedSurfaces)
      .where(
        and(
          inArray(detectedSurfaces.videoId, videoIds),
          ne(detectedSurfaces.surfaceType, "Filtered"),
        ),
      )
      .groupBy(detectedSurfaces.videoId);
    for (const r of rows) counts.set(r.videoId, Number(r.count));
    return counts;
  }

  async getSurfaceCountByVideo(videoId: number): Promise<number> {
    // Filter out "Filtered" surfaceType — those are soft-deleted by the
    // scanner's snapshot/swap on rescan (preserves prior IDs in case of
    // a failed rescan, but they shouldn't count as ad opportunities).
    // Without this filter, every rescan accumulates the count: 4 → 8 →
    // 12 → 56 even though only 4 are actually active. User feedback:
    // "I think that each time I'm running a scan - it's just aggregating
    // the surfaces found".
    // Counts DISTINCT canonical surfaces (surface_group_id), not rows — the
    // scanner writes one row per supporting frame, so a raw row count turns
    // one desk seen in 12 frames into "12 Spots". Legacy rows predate group
    // ids (null) and fall back to a (type, scene) composite.
    const [row] = await db
      .select({
        count: sql<number>`count(DISTINCT COALESCE(${detectedSurfaces.surfaceGroupId}, ${detectedSurfaces.surfaceType} || ':' || COALESCE(${detectedSurfaces.sceneId}, 0)::text))::int`,
      })
      .from(detectedSurfaces)
      .where(
        and(
          eq(detectedSurfaces.videoId, videoId),
          ne(detectedSurfaces.surfaceType, "Filtered"),
        ),
      );
    return Number(row?.count ?? 0);
  }

  async clearDetectedSurfaces(videoId: number): Promise<void> {
    await db.delete(detectedSurfaces).where(eq(detectedSurfaces.videoId, videoId));
  }

  // Non-Filtered surfaces for a video. "Filtered" rows are the scanner's
  // soft-deletes (rescan snapshot/swap, temporal-grouping losers) — they must
  // never appear in brand-facing surface lists or counts. Same exclusion the
  // count methods apply; without it the library said "4 Spots" while the
  // marketplace listed 56.
  private async getActiveSurfaces(videoId: number): Promise<DetectedSurface[]> {
    const surfaces = await this.getDetectedSurfaces(videoId);
    return surfaces.filter((s) => s.surfaceType !== "Filtered");
  }

  async getVideosWithOpportunities(userId: string): Promise<VideoWithOpportunities[]> {
    // Dual-form match: callers pass either users.id or an email, and rows may
    // hold either form (the boot sweep converges them to users.id over time).
    const ids = await this.identityMatchValues(userId);
    const videos = await db
      .select()
      .from(videoIndex)
      .where(inArray(videoIndex.userId, ids))
      .orderBy(desc(videoIndex.priorityScore));
    
    const results: VideoWithOpportunities[] = [];
    
    for (const video of videos) {
      const surfaces = await this.getActiveSurfaces(video.id);
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
      const surfaces = await this.getActiveSurfaces(video.id);
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
      const surfaces = await this.getActiveSurfaces(video.id);
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
    const ids = await this.identityMatchValues(userEmail);
    const videos = await db
      .select()
      .from(videoIndex)
      .where(
        and(
          inArray(videoIndex.userId, ids),
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
      const surfaces = await this.getActiveSurfaces(video.id);
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
  private readonly ACTIVE_PLACEMENT_STATUSES = ["pending_creator_review", "creator_approved", "pending_brand_review", "brand_approved"] as const;

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
          inArray(brandPlacementAssignments.status, [...this.ACTIVE_PLACEMENT_STATUSES]),
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
    // Dual-id resolution. video.userId is sometimes email (file uploads),
    // sometimes UUID (IG/FB imports). The placement creator_user_id is set
    // from video.userId, but the inbox query passes req.authUserId which
    // is always the UUID. Without the OR, an email-keyed video's
    // placements never reach the UUID-authenticated user's inbox.
    // User-facing symptom: "I've clicked on request placement a few times
    // already and I have yet to receive a notification in my inbox."
    const user = await this.getUserById(creatorUserId);
    const aliases = [creatorUserId];
    if (user?.email && user.email !== creatorUserId) aliases.push(user.email);

    // status accepts a comma-separated list — "active" placements span
    // creator_approved, pending_brand_review, and brand_approved.
    const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
    return await db
      .select()
      .from(brandPlacementAssignments)
      .where(
        and(
          inArray(brandPlacementAssignments.creatorUserId, aliases),
          inArray(brandPlacementAssignments.status, statuses),
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
          // Overlays render from creator approval onward — through brand
          // review and after final brand approval.
          inArray(brandPlacementAssignments.status, ["creator_approved", "pending_brand_review", "brand_approved"]),
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
    status: "creator_approved" | "creator_rejected" | "brand_withdrawn" | "expired" | "pending_brand_review" | "brand_approved",
    opts: { rejectionReason?: string; brandProductId?: number; expectedCurrentStatus?: string } = {},
  ): Promise<BrandPlacementAssignment | undefined> {
    const patch: Record<string, any> = {
      status,
      updatedAt: new Date(),
    };
    // Delegated-choice placements: the creator's pick lands together with
    // their approval.
    if (opts.brandProductId !== undefined) patch.brandProductId = opts.brandProductId;
    if (status === "creator_approved" || status === "creator_rejected") {
      patch.reviewedAt = new Date();
    }
    if (opts.rejectionReason !== undefined) {
      patch.rejectionReason = opts.rejectionReason;
    }
    const [row] = await db
      .update(brandPlacementAssignments)
      .set(patch)
      .where(opts.expectedCurrentStatus
          ? and(eq(brandPlacementAssignments.id, id), eq(brandPlacementAssignments.status, opts.expectedCurrentStatus))
          : eq(brandPlacementAssignments.id, id))
      .returning();
    return row;
  }

  /**
   * Count of pending placements for a creator — used for inbox badge.
   */
  async countPendingPlacementsForCreator(creatorUserId: string): Promise<number> {
    // Same dual-id alias as getCreatorPlacements — see comment above.
    const user = await this.getUserById(creatorUserId);
    const aliases = [creatorUserId];
    if (user?.email && user.email !== creatorUserId) aliases.push(user.email);

    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(brandPlacementAssignments)
      .where(
        and(
          inArray(brandPlacementAssignments.creatorUserId, aliases),
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

  async getSharedLinkByBrandPlacement(brandPlacementId: number): Promise<SharedLink | undefined> {
    // Any status — callers must check isActive. A deliberately deactivated
    // release link must BLOCK re-minting, not be silently replaced.
    const [result] = await db
      .select()
      .from(sharedLinks)
      .where(eq(sharedLinks.brandPlacementId, brandPlacementId))
      .orderBy(desc(sharedLinks.createdAt))
      .limit(1);
    return result;
  }

  async getSharedLinkById(id: number): Promise<SharedLink | undefined> {
    const [result] = await db
      .select()
      .from(sharedLinks)
      .where(eq(sharedLinks.id, id));
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

  async getActiveRemixJobForVideo(videoId: number): Promise<RemixJob | undefined> {
    // "Active" = any non-terminal status (queued or step_N). Used to prevent a
    // second concurrent pipeline for the same video.
    const [result] = await db.select().from(remixJobs)
      .where(and(
        eq(remixJobs.videoId, videoId),
        ne(remixJobs.status, "completed"),
        ne(remixJobs.status, "failed"),
        ne(remixJobs.status, "cancelled"),
      ))
      .orderBy(desc(remixJobs.createdAt))
      .limit(1);
    return result;
  }

  async failInterruptedRemixJobs(): Promise<number> {
    // Any job not in a terminal state at startup was left mid-flight by a
    // previous process (crash/redeploy). Its in-memory pipeline is gone, so it
    // will never progress — mark it failed so the UI unblocks.
    // NOTE: SQL `<>` is NULL-hostile — a NULL status would slip past the ne()
    // chain, so it is matched explicitly (no writer inserts NULL today, but a
    // NULL row would otherwise be an unsweepable permanently-"active" brick).
    const result = await db.update(remixJobs)
      .set({ status: "failed", errorMessage: "Interrupted by server restart", completedAt: new Date() })
      .where(or(
        and(
          ne(remixJobs.status, "completed"),
          ne(remixJobs.status, "failed"),
          ne(remixJobs.status, "cancelled"),
        ),
        sql`${remixJobs.status} IS NULL`,
      ))
      .returning({ id: remixJobs.id });
    return result.length;
  }

  async failInterruptedStitchPlans(): Promise<number> {
    // Same restart-sweep as remix jobs, for highlight-reel stitch plans: a
    // plan left 'generating' by a dead process never progresses, and the UI
    // polls it forever. The stitch flow creates its remixJob row only after
    // success, so the remix-job sweep can't catch these.
    const result = await db.update(stitchPlans)
      .set({ status: "failed", errorMessage: "Interrupted by server restart" })
      .where(eq(stitchPlans.status, "generating"))
      .returning({ id: stitchPlans.id });
    return result.length;
  }

  // ── Notifications ────────────────────────────────────────────────

  /** Expand a user key to its dual-ID aliases (users.id UUID + email). */
  private async notificationAliases(userId: string): Promise<string[]> {
    const aliases = [userId];
    try {
      const user = await this.getUserById(userId);
      if (user?.email && user.email !== userId) aliases.push(user.email);
      if (!user) {
        const byEmail = await this.getUserByEmail(userId);
        if (byEmail?.id && byEmail.id !== userId) aliases.push(byEmail.id);
      }
    } catch { /* fall back to the raw key */ }
    return aliases;
  }

  async createNotification(data: { userId: string; type: string; title: string; body?: string | null; linkPath?: string | null; metadata?: Record<string, any> | null }): Promise<void> {
    try {
      await db.insert(notifications).values({
        userId: data.userId,
        type: data.type,
        title: data.title,
        body: data.body ?? null,
        linkPath: data.linkPath ?? null,
        metadata: data.metadata ?? null,
      });
    } catch (err: any) {
      // Notifications are best-effort — never fail the emitting flow.
      console.warn("[Storage] createNotification failed (non-fatal):", err?.message);
    }
  }

  async getNotificationsForUser(userId: string, limit: number = 30): Promise<any[]> {
    const aliases = await this.notificationAliases(userId);
    return db.select().from(notifications)
      .where(inArray(notifications.userId, aliases))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  async getUnreadNotificationCount(userId: string): Promise<number> {
    const aliases = await this.notificationAliases(userId);
    const rows = await db.select({ count: sql<number>`count(*)` }).from(notifications)
      .where(and(inArray(notifications.userId, aliases), sql`${notifications.readAt} IS NULL`));
    return Number(rows[0]?.count || 0);
  }

  async markNotificationRead(id: number, userId: string): Promise<boolean> {
    const aliases = await this.notificationAliases(userId);
    const result = await db.update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), inArray(notifications.userId, aliases)))
      .returning({ id: notifications.id });
    return result.length > 0;
  }

  async markPlacementNotificationsRead(placementId: number): Promise<void> {
    // Acting on a placement (approve/reject) consumes its request
    // notification — matches both the batched placementIds array and the
    // legacy single placementId shape.
    try {
      await db.update(notifications)
        .set({ readAt: new Date() })
        .where(and(
          sql`${notifications.readAt} IS NULL`,
          sql`((${notifications.metadata} -> 'placementIds') @> ${JSON.stringify([placementId])}::jsonb OR (${notifications.metadata} ->> 'placementId')::int = ${placementId})`,
        ));
    } catch (err: any) {
      console.warn("[Storage] markPlacementNotificationsRead failed (non-fatal):", err?.message);
    }
  }

  async markAllNotificationsRead(userId: string): Promise<number> {
    const aliases = await this.notificationAliases(userId);
    const result = await db.update(notifications)
      .set({ readAt: new Date() })
      .where(and(inArray(notifications.userId, aliases), sql`${notifications.readAt} IS NULL`))
      .returning({ id: notifications.id });
    return result.length;
  }

  async updateRemixJobStatus(jobId: number, status: string, errorMessage?: string): Promise<RemixJob | undefined> {
    // Terminal states are (almost) sticky. During a redeploy the old and new
    // processes overlap (reusePort): the new process's startup sweep may mark a
    // job "failed" while the old process is still rendering it — its next
    // step_N write must NOT resurrect the row into a live-looking status the
    // client would poll forever. Sole allowed terminal→terminal transition:
    // failed → completed (the old process actually finishing is the truth).
    const TERMINAL = ["completed", "failed", "cancelled"];
    const [current] = await db.select({ status: remixJobs.status }).from(remixJobs)
      .where(eq(remixJobs.id, jobId));
    if (current && TERMINAL.includes(current.status ?? "")) {
      const allowed = current.status === "failed" && status === "completed";
      if (!allowed && current.status !== status) {
        console.warn(`[Storage] Ignoring remix job ${jobId} status ${current.status} → ${status} (terminal state is sticky)`);
        return undefined;
      }
    }
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
      segments: clip.segments ?? null,
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

  /**
   * Get a single editorial clip by ID — used by brand browsing flow when a
   * brand opens a clip's detail/placement-request modal.
   */
  async getEditorialClipById(clipId: number): Promise<EditorialClip | undefined> {
    const rows = await db.select().from(editorialClips)
      .where(eq(editorialClips.id, clipId))
      .limit(1);
    return rows[0];
  }

  /**
   * Browse all rendered editorial clips across the platform — used for the
   * brand marketplace view. Returns clips that have been successfully rendered
   * and are ready for brand placement requests. Joined minimally with video
   * metadata for the card view.
   */
  async getBrowsableEditorialClips(opts: { limit?: number; offset?: number } = {}): Promise<
    Array<EditorialClip & { videoTitle: string | null; videoThumbnailUrl: string | null; creatorUserId: string }>
  > {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;

    const rows = await db
      .select({
        clip: editorialClips,
        videoTitle: videoIndex.title,
        videoThumbnailUrl: videoIndex.thumbnailUrl,
        creatorUserId: videoIndex.userId,
      })
      .from(editorialClips)
      .innerJoin(videoIndex, eq(editorialClips.videoId, videoIndex.id))
      .where(
        and(
          eq(editorialClips.renderStatus, "rendered"),
          // Don't show clips from soft-deleted videos
          sql`${videoIndex.deletedAt} IS NULL`,
        ),
      )
      .orderBy(desc(editorialClips.finalScore))
      .limit(limit)
      .offset(offset);

    return rows.map((r) => ({
      ...r.clip,
      videoTitle: r.videoTitle,
      videoThumbnailUrl: r.videoThumbnailUrl,
      creatorUserId: r.creatorUserId,
    }));
  }

  /**
   * Get surfaces that fall within an editorial clip's time range.
   * Used by the brand placement request modal so brands only see surfaces
   * that are actually visible in the clip they're targeting.
   */
  async getSurfacesInEditorialClip(clipId: number): Promise<DetectedSurface[]> {
    const clip = await this.getEditorialClipById(clipId);
    if (!clip) return [];
    const rows = await db
      .select()
      .from(detectedSurfaces)
      .where(
        and(
          eq(detectedSurfaces.videoId, clip.videoId),
          sql`${detectedSurfaces.timestamp}::numeric >= ${clip.clipStart}::numeric`,
          sql`${detectedSurfaces.timestamp}::numeric <= ${clip.clipEnd}::numeric`,
        ),
      )
      .orderBy(detectedSurfaces.timestamp);

    // Assembled clips: the envelope query above includes un-played gaps —
    // only surfaces inside an actual beat exist in the rendered clip, and
    // only those may be shown/sold to brands as placement inventory.
    const segs = clip.segments as Array<{ start: number; end: number }> | null;
    if (segs && segs.length > 0) {
      return rows.filter((s) => {
        const t = parseFloat(String(s.timestamp));
        return segs.some((seg) => t >= seg.start && t <= seg.end);
      });
    }
    return rows;
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
      /** Post-render quality rubric score (0-1); null = scoring failed */
      qualityScore?: number | null;
    }
  ): Promise<EditorialClip | undefined> {
    const patch: Record<string, any> = {};
    if (updates.qualityScore !== undefined && updates.qualityScore !== null) patch.qualityScore = updates.qualityScore;
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

  async cancelSchedule(scheduleId: number, userId?: number): Promise<boolean> {
    // When userId is provided the cancel is ownership-scoped — a caller can
    // only cancel their own schedule (returns false on someone else's id).
    const conditions = [eq(publishingSchedules.id, scheduleId)];
    if (userId !== undefined) conditions.push(eq(publishingSchedules.userId, userId));
    const result = await db.update(publishingSchedules)
      .set({ status: "cancelled" })
      .where(and(...conditions))
      .returning({ id: publishingSchedules.id });
    return result.length > 0;
  }

  async claimSchedule(scheduleId: number): Promise<boolean> {
    // Atomic compare-and-set claim: only one process wins the row even when
    // two schedulers overlap (Replit reusePort redeploy overlap). Without
    // this, both processes read the same pending list and double-publish.
    const result = await db.update(publishingSchedules)
      .set({ status: "processing" })
      .where(and(
        eq(publishingSchedules.id, scheduleId),
        eq(publishingSchedules.status, "pending"),
      ))
      .returning({ id: publishingSchedules.id });
    return result.length > 0;
  }

  /**
   * Boot sweep: any video stuck in "Scanning" longer than the threshold is
   * an orphan (scans hard-cap around 10 minutes; a crashed/redeployed
   * process can never finish one). Flip to an honest failed state so the
   * creator can rescan instead of staring at a frozen spinner forever.
   */
  async failStuckScans(staleMinutes: number = 30): Promise<number> {
    const res: any = await db.execute(sql`
      UPDATE video_index
      SET status = 'Scan Failed — Interrupted', updated_at = NOW()
      WHERE status = 'Scanning'
        AND updated_at < NOW() - (${staleMinutes} * INTERVAL '1 minute')
    `);
    const count = Number(res?.rowCount ?? 0);
    if (count > 0) console.log(`[Startup] failStuckScans: released ${count} stuck scan(s)`);
    return count;
  }

  async normalizeLegacyIdentityKeys(): Promise<Record<string, number>> {
    // Dual-ID root migration, applied as an idempotent boot sweep: rewrite
    // email-keyed identity columns to users.id wherever a users row exists.
    // Rows whose email has no users row stay email-keyed and remain covered
    // by the alias lookups (isSameCreator / getVideoIndex match sets), which
    // are deliberately KEPT as a safety net. Writers that still produce
    // email keys (YouTube indexer, some auth fallbacks) converge on the
    // next boot. Excluded on purpose: youtube_connections (email-keyed by
    // design, consumers fully alias-aware — normalizing would duplicate
    // rows on reconnect) and int-keyed tables (stableUserIntId domain).
    const results: Record<string, number> = {};
    // brand_products must convert in lockstep with placements.brandUserId:
    // the delegated-product flow compares brandProducts.userId to
    // placement.brandUserId directly — converting one side only breaks it.
    const sweeps: Array<{ table: string; column: string; label: string; guard?: string }> = [
      { table: "video_index", column: "user_id", label: "videoIndex.userId" },
      { table: "brand_placement_assignments", column: "creator_user_id", label: "placements.creatorUserId" },
      { table: "brand_placement_assignments", column: "brand_user_id", label: "placements.brandUserId" },
      { table: "monetization_items", column: "creator_user_id", label: "monetizationItems.creatorUserId" },
      { table: "brand_products", column: "user_id", label: "brandProducts.userId" },
      {
        table: "social_accounts", column: "user_id", label: "socialAccounts.userId",
        // A user who reconnected post-dual-ID already has a users.id-keyed
        // twin for the same platform account; converting the email row would
        // violate idx_social_accounts_unique and roll back the WHOLE
        // statement (every user's rows) on every boot. Skip rows whose
        // converged form already exists — the twin holds the fresher token
        // and the email row stays covered by the alias lookups.
        guard: `AND NOT EXISTS (
            SELECT 1 FROM social_accounts s2
            WHERE s2.user_id = u.id
              AND s2.platform = t.platform
              AND s2.account_type = t.account_type
              AND s2.platform_account_id = t.platform_account_id
          )`,
      },
    ];
    for (const { table, column, label, guard } of sweeps) {
      try {
        const res: any = await db.execute(sql`
          UPDATE ${sql.raw(`"${table}"`)} t
          SET ${sql.raw(`"${column}"`)} = u.id
          FROM users u
          WHERE t.${sql.raw(`"${column}"`)} LIKE '%@%'
            AND lower(t.${sql.raw(`"${column}"`)}) = lower(u.email)
            ${sql.raw(guard || "")}
        `);
        const count = Number(res?.rowCount ?? 0);
        results[label] = count;
        if (count > 0) console.log(`[IdentityMigration] ${label}: normalized ${count} row(s) to users.id`);
      } catch (err: any) {
        console.warn(`[IdentityMigration] ${label} sweep failed (non-fatal):`, err?.message);
        results[label] = -1;
      }
    }
    return results;
  }

  async cancelOrphanedLegacySchedules(): Promise<number> {
    // Pre-stableUserIntId rows were all keyed userId=1 (the old
    // `req.user?.id || 1` fallback) — no real user maps to them now, so a
    // pending one would fire posts nobody can see or cancel.
    const result = await db.update(publishingSchedules)
      .set({ status: "cancelled", errorMessage: "Orphaned legacy schedule (pre-identity-fix userId=1)" })
      .where(and(
        eq(publishingSchedules.userId, 1),
        eq(publishingSchedules.status, "pending"),
      ))
      .returning({ id: publishingSchedules.id });
    return result.length;
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

  // ─── Room Model Methods (persistent set memory) ─────

  // Every room model owned by any of the given identities. Creator identity
  // is split across users.id and legacy email keys, so the CALLER passes the
  // full alias list it wants merged (the scanner sends video.userId plus the
  // canonical id when they differ) — this method is plain equality, no alias
  // resolution of its own.
  async getRoomModelsForUsers(userIds: string[]): Promise<RoomModel[]> {
    if (userIds.length === 0) return [];
    return await db
      .select()
      .from(roomModels)
      .where(inArray(roomModels.userId, userIds));
  }

  async getRoomModelById(id: number): Promise<RoomModel | undefined> {
    const [model] = await db
      .select()
      .from(roomModels)
      .where(eq(roomModels.id, id));
    return model;
  }

  // Whole-table read for the operator console. Set memory is invisible
  // everywhere else — a model built from a degraded scan keeps confirming
  // itself onto every future episode, and nothing prunes it — so the admin
  // view needs every row, not one creator's. Freshest confirmation first.
  async getAllRoomModels(): Promise<RoomModel[]> {
    return await db
      .select()
      .from(roomModels)
      .orderBy(desc(roomModels.updatedAt));
  }

  async insertRoomModel(model: InsertRoomModel): Promise<RoomModel> {
    const [result] = await db
      .insert(roomModels)
      .values(model)
      .returning();
    return result;
  }

  async updateRoomModel(id: number, patch: {
    sceneExemplarHashes?: string[];
    surfaces?: unknown;
    lastVideoId?: number;
    episodeCount?: number;
  }): Promise<void> {
    const setValues: Record<string, any> = { updatedAt: new Date() };
    if (patch.sceneExemplarHashes !== undefined) setValues.sceneExemplarHashes = patch.sceneExemplarHashes;
    if (patch.surfaces !== undefined) setValues.surfaces = patch.surfaces;
    if (patch.lastVideoId !== undefined) setValues.lastVideoId = patch.lastVideoId;
    if (patch.episodeCount !== undefined) setValues.episodeCount = patch.episodeCount;
    await db
      .update(roomModels)
      .set(setValues)
      .where(eq(roomModels.id, id));
  }

  // Append one surface to a model's jsonb list under the append-only idx
  // rule: next idx = max existing idx + 1, computed over the RAW entries so
  // even a malformed entry's idx is never reused (the groupId
  // "rm{modelId}-s{idx}" must stay unambiguous forever). Reads the row fresh
  // rather than trusting a caller-held copy, so a scan upsert landing between
  // the caller's read and this write can't be clobbered. Returns the idx the
  // surface landed at.
  async appendRoomModelSurface(modelId: number, surface: {
    surfaceType: string;
    orientation: "horizontal" | "vertical";
    bbox: { x: number; y: number; w: number; h: number };
    confidence: number;
    frameUrl: string | null;
    taught?: boolean;
  }): Promise<number> {
    const [model] = await db
      .select()
      .from(roomModels)
      .where(eq(roomModels.id, modelId));
    if (!model) throw new Error(`Room model ${modelId} not found`);
    const existing = Array.isArray(model.surfaces) ? (model.surfaces as any[]) : [];
    const nextIdx = existing.reduce(
      (mx, s) => (s && typeof s.idx === "number" && Number.isFinite(s.idx) ? Math.max(mx, s.idx) : mx),
      -1,
    ) + 1;
    await db
      .update(roomModels)
      .set({ surfaces: [...existing, { idx: nextIdx, ...surface }], updatedAt: new Date() })
      .where(eq(roomModels.id, modelId));
    return nextIdx;
  }

  // Forget one set. Detected surfaces already written by past scans stay —
  // only the memory that would re-confirm them on the next scan goes, so the
  // next scan of that room rediscovers it from scratch.
  // Returns whether a row actually went away, so the route can 404 a stale
  // id instead of reporting a deletion that never happened.
  async deleteRoomModel(id: number): Promise<boolean> {
    const gone = await db.delete(roomModels).where(eq(roomModels.id, id)).returning({ id: roomModels.id });
    return gone.length > 0;
  }

  // Forget every set on the platform. Returns how many models were dropped
  // so the operator sees what the reset actually cost.
  async deleteAllRoomModels(): Promise<number> {
    const deleted = await db
      .delete(roomModels)
      .returning({ id: roomModels.id });
    return deleted.length;
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
    updates: { bio?: string; headline?: string; podcastName?: string; podcastUrl?: string; websiteUrl?: string; slug?: string; cardImageUrl?: string | null }
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
          inArray(studioVoices.tier, allowedTiers)
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

  // ══════════════════════════════════════════════════════════════════════
  // Admin analytics aggregates — batched roll-ups for the operator surfaces
  // (/api/admin/creator-intelligence, /api/admin/data-inventory).
  //
  // Every method is ONE query per table, GROUP BY the RAW identity key —
  // never a query per creator (the per-account loop in the old operator
  // roster was the same N+1 shape that exhausted the pool in prod, see
  // getSurfaceCountsForVideos). Identity columns are mixed-key (users.id
  // UUID or legacy email — the dual-ID reality identityMatchValues handles
  // per-user); the route folds the raw-keyed rows onto canonical users.id
  // via an alias map built once from the users table.
  // ══════════════════════════════════════════════════════════════════════

  /** Lightweight full roster — identity + join date only, no auth fields. */
  async getAllUserIdentities(): Promise<Array<{
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    createdAt: Date | null;
  }>> {
    return await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(users.createdAt);
  }

  /**
   * Per-owner video supply + editorial roll-up in one GROUP BY: scanned
   * videos (status LIKE 'Ready%' — statuses are "Ready (12 Spots)" style),
   * editorial clip totals, and the sceneInventory JSON aggregation (scene
   * classes + sellable screen time). Sellable seconds count each scene's
   * totalSec once, and only for scenes that carry at least one surface —
   * screen time with nothing to sell on it isn't inventory.
   */
  async getCreatorSupplyAggregates(): Promise<Array<{
    userId: string;
    videosScanned: number;
    clipsGenerated: number;
    clipsRendered: number;
    sceneClasses: number;
    sellableSec: number;
  }>> {
    const scenes = sql`${videoIndex.sceneInventory}->'scenes'`;
    const rows = await db
      .select({
        userId: videoIndex.userId,
        // Legacy 'Scan Complete' rows are scanned too — same status band the
        // marketplace queries use, so a legacy-only creator can't show
        // Videos=0 while contributing surfaces and scenes.
        videosScanned: sql<number>`count(*) FILTER (WHERE ${videoIndex.status} LIKE 'Ready%' OR ${videoIndex.status} = 'Scan Complete')::int`,
        clipsGenerated: sql<number>`COALESCE(SUM(${videoIndex.editorialClipCount}), 0)::int`,
        sceneClasses: sql<number>`COALESCE(SUM(CASE WHEN jsonb_typeof(${scenes}) = 'array' THEN jsonb_array_length(${scenes}) ELSE 0 END), 0)::int`,
        sellableSec: sql<number>`COALESCE(SUM(CASE WHEN jsonb_typeof(${scenes}) = 'array' THEN (
          SELECT COALESCE(SUM((sc->>'totalSec')::double precision), 0)
          FROM jsonb_array_elements(${scenes}) sc
          WHERE jsonb_typeof(sc->'surfaces') = 'array' AND jsonb_array_length(sc->'surfaces') > 0
        ) ELSE 0 END), 0)::double precision`,
      })
      .from(videoIndex)
      .where(sql`${videoIndex.deletedAt} IS NULL`)
      .groupBy(videoIndex.userId);

    // Rendered = actual editorial_clips rows with render_status 'rendered'
    // — the same definition the data-inventory card uses, so the two admin
    // surfaces reconcile. (The video-level editorialStatus proxy both over-
    // and under-counted: failed clips on a 'ready' video counted, rendered
    // clips on a later-'failed' video didn't.)
    const renderedRows = await db
      .select({
        userId: videoIndex.userId,
        clipsRendered: sql<number>`count(*)::int`,
      })
      .from(editorialClips)
      .innerJoin(videoIndex, eq(videoIndex.id, editorialClips.videoId))
      .where(and(
        sql`${editorialClips.renderStatus} = 'rendered'`,
        sql`${videoIndex.deletedAt} IS NULL`,
      ))
      .groupBy(videoIndex.userId);
    const renderedByUser = new Map(renderedRows.map((r) => [r.userId, Number(r.clipsRendered)]));

    return rows.map((r) => ({
      userId: r.userId,
      videosScanned: Number(r.videosScanned),
      clipsGenerated: Number(r.clipsGenerated),
      clipsRendered: renderedByUser.get(r.userId) ?? 0,
      sceneClasses: Number(r.sceneClasses),
      sellableSec: Number(r.sellableSec),
    }));
  }

  /**
   * Per-owner canonical-surface counts. Same COALESCE fallback + Filtered
   * exclusion as getSurfaceCountsForVideos, with video_id folded into the
   * legacy composite so pre-grouping rows can't collide across videos in a
   * cross-video GROUP BY. Group-id semantics here are DELIBERATE: fresh
   * g{videoId}-... ids embed the video, so per-episode surfaces count per
   * episode — but room-model rm{modelId}-s{idx} ids are identical across
   * every rescan and episode of the same set, so a recurring studio desk
   * counts as ONE canonical surface no matter how many episodes it appears
   * in. That matches the product meaning of "canonical surface" (a
   * physical thing, not a per-video sighting); per-video counts and the
   * placement group-match are videoId-scoped and unaffected.
   * surfacesApproved counts a canonical surface once ANY member row is
   * creator-approved — approval is a per-surface toggle, but member rows
   * written before the toggle flip stay false.
   */
  async getCreatorSurfaceAggregates(): Promise<Array<{
    userId: string;
    canonicalSurfaces: number;
    surfacesApproved: number;
  }>> {
    const groupExpr = sql`COALESCE(${detectedSurfaces.surfaceGroupId}, ${detectedSurfaces.videoId}::text || ':' || ${detectedSurfaces.surfaceType} || ':' || COALESCE(${detectedSurfaces.sceneId}, 0)::text)`;
    const rows = await db
      .select({
        userId: videoIndex.userId,
        canonicalSurfaces: sql<number>`count(DISTINCT ${groupExpr})::int`,
        surfacesApproved: sql<number>`count(DISTINCT ${groupExpr}) FILTER (WHERE ${detectedSurfaces.creatorApproved})::int`,
      })
      .from(detectedSurfaces)
      .innerJoin(videoIndex, eq(videoIndex.id, detectedSurfaces.videoId))
      .where(and(
        ne(detectedSurfaces.surfaceType, "Filtered"),
        sql`${videoIndex.deletedAt} IS NULL`,
      ))
      .groupBy(videoIndex.userId);
    return rows.map((r) => ({
      userId: r.userId,
      canonicalSurfaces: Number(r.canonicalSurfaces),
      surfacesApproved: Number(r.surfacesApproved),
    }));
  }

  /**
   * Placement funnel per creator key: total brand requests (any status) and
   * creator-approved-onward (creator_approved → pending_brand_review →
   * brand_approved — same "approved by the creator" band
   * getApprovedPlacementsForVideo renders from).
   */
  async getCreatorPlacementFunnelAggregates(): Promise<Array<{
    userId: string;
    brandRequests: number;
    placementsApproved: number;
  }>> {
    const rows = await db
      .select({
        userId: brandPlacementAssignments.creatorUserId,
        brandRequests: sql<number>`count(*)::int`,
        placementsApproved: sql<number>`count(*) FILTER (WHERE ${brandPlacementAssignments.status} IN ('creator_approved', 'pending_brand_review', 'brand_approved'))::int`,
      })
      .from(brandPlacementAssignments)
      .groupBy(brandPlacementAssignments.creatorUserId);
    return rows.map((r) => ({
      userId: r.userId,
      brandRequests: Number(r.brandRequests),
      placementsApproved: Number(r.placementsApproved),
    }));
  }

  /**
   * Released A1 pages per creator key — shared_links minted against a brand
   * placement (brand_placement_id NOT NULL, enforced by the inner join).
   */
  async getCreatorReleaseCounts(): Promise<Array<{ userId: string; released: number }>> {
    const rows = await db
      .select({
        userId: brandPlacementAssignments.creatorUserId,
        released: sql<number>`count(*)::int`,
      })
      .from(sharedLinks)
      .innerJoin(brandPlacementAssignments, eq(brandPlacementAssignments.id, sharedLinks.brandPlacementId))
      .groupBy(brandPlacementAssignments.creatorUserId);
    return rows.map((r) => ({ userId: r.userId, released: Number(r.released) }));
  }

  /** Raw identity keys with a connected social account, platform tagged.
   *  Deliberately skips token columns — no decrypt work for a coverage flag. */
  async getSocialCoverageKeys(): Promise<Array<{ userId: string; platform: string }>> {
    return await db
      .select({ userId: socialAccounts.userId, platform: socialAccounts.platform })
      .from(socialAccounts);
  }

  /** Raw identity keys holding a YouTube OAuth connection (mixed id/email). */
  async getYoutubeConnectionKeys(): Promise<string[]> {
    const rows = await db
      .select({ userId: youtubeConnections.userId })
      .from(youtubeConnections);
    return rows.map((r) => r.userId);
  }

  /**
   * Latest insight snapshot per (RAW identity key, platform account). The
   * snapshot job writes one row PER connected Meta account (IG and FB) per
   * cycle, all sharing user_id — DISTINCT ON user_id alone would collapse a
   * multi-account creator to whichever account captured most recently, and
   * the winner flips between cycles. The route sums accounts per canonical
   * user instead.
   */
  async getLatestInsightSnapshotPerUser(): Promise<Array<{
    userId: string;
    platformAccountId: string;
    followers: number | null;
    metrics: unknown;
    capturedAt: Date | null;
  }>> {
    return await db
      .selectDistinctOn(
        [socialInsightSnapshots.userId, socialInsightSnapshots.platformAccountId],
        {
          userId: socialInsightSnapshots.userId,
          platformAccountId: socialInsightSnapshots.platformAccountId,
          followers: socialInsightSnapshots.followers,
          metrics: socialInsightSnapshots.metrics,
          capturedAt: socialInsightSnapshots.capturedAt,
        },
      )
      .from(socialInsightSnapshots)
      .orderBy(
        socialInsightSnapshots.userId,
        socialInsightSnapshots.platformAccountId,
        desc(socialInsightSnapshots.capturedAt),
      );
  }

  /**
   * Live table census for /api/admin/data-inventory. COUNTS ONLY — no raw
   * platform-metric values leave this method, so nothing downstream can leak
   * Meta/YouTube numbers into an exportable surface. Same-table counts are
   * merged into single statements (14 small queries total, admin-only path).
   */
  async getDataInventoryCounts(): Promise<{
    users: { rowCount: number; last30d: number };
    allowlistByType: Record<string, number>;
    videos: { rowCount: number; last30d: number; ready: number; sceneClasses: number; sellableSec: number };
    surfaces: { rowCount: number; last30d: number; canonical: number };
    savedPlacements: { rowCount: number; last30d: number };
    assignments: { rowCount: number; last30d: number; priced: number; pricedLast30d: number };
    assignmentsByStatus: Record<string, number>;
    editorialClips: { rowCount: number; last30d: number; rendered: number };
    sharedLinks: { rowCount: number; last30d: number; releasePages: number };
    insightSnapshots: { rowCount: number; last30d: number };
    socialAccounts: { rowCount: number; last30d: number };
    youtubeConnections: { rowCount: number; last30d: number };
    brandMatchScores: { rowCount: number; last30d: number };
    sceneAnalysis: { rowCount: number; last30d: number };
    brandProducts: { rowCount: number; last30d: number };
  }> {
    const recent = (col: any) => sql<number>`count(*) FILTER (WHERE ${col} >= now() - interval '30 days')::int`;
    const scenes = sql`${videoIndex.sceneInventory}->'scenes'`;
    const canonicalExpr = sql`COALESCE(${detectedSurfaces.surfaceGroupId}, ${detectedSurfaces.videoId}::text || ':' || ${detectedSurfaces.surfaceType} || ':' || COALESCE(${detectedSurfaces.sceneId}, 0)::text)`;
    const pricedCond = sql`(COALESCE(${brandPlacementAssignments.placementFeeCents}, 0) > 0 OR COALESCE(${brandPlacementAssignments.customFeeCents}, 0) > 0 OR ${brandPlacementAssignments.pricingBreakdown} IS NOT NULL)`;

    // Two waves of <=8: the pool caps at 10 connections, and a 15-wide
    // burst behind an already-busy pool (scans, renders) can queue past the
    // 10s acquire timeout and 500 the whole endpoint.
    const [
      [usersRow], allowlistRows, [videosRow], [surfacesRow], [savedRow],
      [assignRow], assignStatusRows, [editorialRow],
    ] = await Promise.all([
      db.select({ rowCount: sql<number>`count(*)::int`, last30d: recent(users.createdAt) }).from(users),
      db.select({ userType: allowedUsers.userType, count: sql<number>`count(*)::int` })
        .from(allowedUsers).groupBy(allowedUsers.userType),
      db.select({
        rowCount: sql<number>`count(*)::int`,
        last30d: recent(videoIndex.createdAt),
        ready: sql<number>`count(*) FILTER (WHERE ${videoIndex.status} LIKE 'Ready%' OR ${videoIndex.status} = 'Scan Complete')::int`,
        sceneClasses: sql<number>`COALESCE(SUM(CASE WHEN jsonb_typeof(${scenes}) = 'array' THEN jsonb_array_length(${scenes}) ELSE 0 END), 0)::int`,
        sellableSec: sql<number>`COALESCE(SUM(CASE WHEN jsonb_typeof(${scenes}) = 'array' THEN (
          SELECT COALESCE(SUM((sc->>'totalSec')::double precision), 0)
          FROM jsonb_array_elements(${scenes}) sc
          WHERE jsonb_typeof(sc->'surfaces') = 'array' AND jsonb_array_length(sc->'surfaces') > 0
        ) ELSE 0 END), 0)::double precision`,
      }).from(videoIndex).where(sql`${videoIndex.deletedAt} IS NULL`),
      db.select({
        rowCount: sql<number>`count(*)::int`,
        last30d: recent(detectedSurfaces.createdAt),
        canonical: sql<number>`count(DISTINCT ${canonicalExpr})::int`,
      }).from(detectedSurfaces).where(ne(detectedSurfaces.surfaceType, "Filtered")),
      db.select({ rowCount: sql<number>`count(*)::int`, last30d: recent(savedPlacements.createdAt) }).from(savedPlacements),
      db.select({
        rowCount: sql<number>`count(*)::int`,
        last30d: recent(brandPlacementAssignments.createdAt),
        priced: sql<number>`count(*) FILTER (WHERE ${pricedCond})::int`,
        pricedLast30d: sql<number>`count(*) FILTER (WHERE ${pricedCond} AND ${brandPlacementAssignments.createdAt} >= now() - interval '30 days')::int`,
      }).from(brandPlacementAssignments),
      db.select({ status: brandPlacementAssignments.status, count: sql<number>`count(*)::int` })
        .from(brandPlacementAssignments).groupBy(brandPlacementAssignments.status),
      db.select({
        rowCount: sql<number>`count(*)::int`,
        last30d: recent(editorialClips.createdAt),
        rendered: sql<number>`count(*) FILTER (WHERE ${editorialClips.renderStatus} = 'rendered')::int`,
      }).from(editorialClips),
    ]);
    const [
      [linksRow], [snapshotsRow], [socialRow], [ytRow],
      [matchRow], [sceneAnalysisRow], [productsRow],
    ] = await Promise.all([
      db.select({
        rowCount: sql<number>`count(*)::int`,
        last30d: recent(sharedLinks.createdAt),
        releasePages: sql<number>`count(*) FILTER (WHERE ${sharedLinks.brandPlacementId} IS NOT NULL)::int`,
      }).from(sharedLinks),
      // captured_at is the snapshots table's row-creation stamp (defaultNow at insert)
      db.select({ rowCount: sql<number>`count(*)::int`, last30d: recent(socialInsightSnapshots.capturedAt) }).from(socialInsightSnapshots),
      db.select({ rowCount: sql<number>`count(*)::int`, last30d: recent(socialAccounts.createdAt) }).from(socialAccounts),
      db.select({ rowCount: sql<number>`count(*)::int`, last30d: recent(youtubeConnections.createdAt) }).from(youtubeConnections),
      db.select({ rowCount: sql<number>`count(*)::int`, last30d: recent(brandMatchScores.createdAt) }).from(brandMatchScores),
      db.select({ rowCount: sql<number>`count(*)::int`, last30d: recent(sceneAnalysis.createdAt) }).from(sceneAnalysis),
      db.select({ rowCount: sql<number>`count(*)::int`, last30d: recent(brandProducts.createdAt) }).from(brandProducts),
    ]);

    const n = (v: unknown) => Number(v ?? 0);
    return {
      users: { rowCount: n(usersRow?.rowCount), last30d: n(usersRow?.last30d) },
      allowlistByType: Object.fromEntries(allowlistRows.map((r) => [r.userType ?? "unknown", n(r.count)])),
      videos: {
        rowCount: n(videosRow?.rowCount), last30d: n(videosRow?.last30d),
        ready: n(videosRow?.ready), sceneClasses: n(videosRow?.sceneClasses), sellableSec: n(videosRow?.sellableSec),
      },
      surfaces: { rowCount: n(surfacesRow?.rowCount), last30d: n(surfacesRow?.last30d), canonical: n(surfacesRow?.canonical) },
      savedPlacements: { rowCount: n(savedRow?.rowCount), last30d: n(savedRow?.last30d) },
      assignments: {
        rowCount: n(assignRow?.rowCount), last30d: n(assignRow?.last30d),
        priced: n(assignRow?.priced), pricedLast30d: n(assignRow?.pricedLast30d),
      },
      assignmentsByStatus: Object.fromEntries(assignStatusRows.map((r) => [r.status, n(r.count)])),
      editorialClips: { rowCount: n(editorialRow?.rowCount), last30d: n(editorialRow?.last30d), rendered: n(editorialRow?.rendered) },
      sharedLinks: { rowCount: n(linksRow?.rowCount), last30d: n(linksRow?.last30d), releasePages: n(linksRow?.releasePages) },
      insightSnapshots: { rowCount: n(snapshotsRow?.rowCount), last30d: n(snapshotsRow?.last30d) },
      socialAccounts: { rowCount: n(socialRow?.rowCount), last30d: n(socialRow?.last30d) },
      youtubeConnections: { rowCount: n(ytRow?.rowCount), last30d: n(ytRow?.last30d) },
      brandMatchScores: { rowCount: n(matchRow?.rowCount), last30d: n(matchRow?.last30d) },
      sceneAnalysis: { rowCount: n(sceneAnalysisRow?.rowCount), last30d: n(sceneAnalysisRow?.last30d) },
      brandProducts: { rowCount: n(productsRow?.rowCount), last30d: n(productsRow?.last30d) },
    };
  }
}

export const storage = new DatabaseStorage();
