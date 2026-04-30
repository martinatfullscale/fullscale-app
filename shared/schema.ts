import { pgTable, text, serial, timestamp, boolean, varchar, integer, numeric, uniqueIndex, jsonb, real, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Import Auth Definitions
import { users } from "./models/auth";
export * from "./models/auth";

// Import Chat Definitions (for Gemini integration)
export * from "./models/chat";

// YouTube Connections Table - stores OAuth tokens for YouTube API access
export const youtubeConnections = pgTable("youtube_connections", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().unique(), // Links to the Replit Auth user
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at"),
  channelId: text("channel_id"),
  channelTitle: text("channel_title"),
  subscriberCount: integer("subscriber_count"), // YouTube channel subscriber count
  totalViewCount: integer("total_view_count"), // YouTube channel total view count
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertYoutubeConnectionSchema = createInsertSchema(youtubeConnections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type YoutubeConnection = typeof youtubeConnections.$inferSelect;
export type InsertYoutubeConnection = z.infer<typeof insertYoutubeConnectionSchema>;

// Allowed Users Table - Email allowlist for founding cohort
export const allowedUsers = pgTable("allowed_users", {
  id: serial("id").primaryKey(),
  email: varchar("email").notNull().unique(),
  name: varchar("name"),
  userType: varchar("user_type").notNull().default("creator"), // 'creator' or 'brand'
  companyName: varchar("company_name"), // For brand users
  addedAt: timestamp("added_at").defaultNow(),
  // Creator profile fields
  slug: varchar("slug"), // Unique URL slug for creator profiles (e.g., "martin")
  isFeatured: boolean("is_featured").default(false), // Show in marketplace featured section
  bio: text("bio"), // Creator bio/blurb
  headline: varchar("headline"), // One-liner (e.g., "Sports Podcast Host")
  podcastName: varchar("podcast_name"), // Podcast title if applicable
  podcastUrl: varchar("podcast_url"), // Podcast link
  websiteUrl: varchar("website_url"), // Personal/company website
});

export const insertAllowedUserSchema = createInsertSchema(allowedUsers).omit({
  id: true,
  addedAt: true,
});

export type AllowedUser = typeof allowedUsers.$inferSelect;
export type InsertAllowedUser = z.infer<typeof insertAllowedUserSchema>;

// OAuth States Table - stores state tokens for OAuth CSRF protection (survives server restarts)
export const oauthStates = pgTable("oauth_states", {
  state: varchar("state").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type OAuthState = typeof oauthStates.$inferSelect;

// Monetization Items Table - Brand bids on creator video surfaces
export const monetizationItems = pgTable("monetization_items", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  date: timestamp("date").defaultNow(),
  status: text("status").notNull(), // 'pending', 'placed', 'accepted', 'revision_requested', 'rejected', 'expired'
  videoId: integer("video_id"), // Reference to video_index.id
  creatorUserId: varchar("creator_user_id"), // Creator who owns the video
  brandEmail: varchar("brand_email"), // Brand who placed the bid
  brandName: varchar("brand_name"), // Brand company name
  bidAmount: numeric("bid_amount"), // Bid amount in dollars
  sceneType: varchar("scene_type"), // e.g., 'Desk', 'Wall', 'Product'
  genre: varchar("genre"), // e.g., 'Tech', 'Lifestyle', 'Gaming'
  // Placement review lifecycle
  placementId: integer("placement_id"), // Reference to saved_placements.id (placement that fulfills this bid)
  reviewSlug: varchar("review_slug"), // Shared link slug for brand to review the placement
  reviewNote: text("review_note"), // Brand's note when requesting revision
});

export const insertMonetizationItemSchema = createInsertSchema(monetizationItems).omit({ 
  id: true,
  date: true 
});

export type MonetizationItem = typeof monetizationItems.$inferSelect;
export type InsertMonetizationItem = z.infer<typeof insertMonetizationItemSchema>;

// Video Index Table - stores indexed high-value videos from YouTube, Instagram, etc.
export const videoIndex = pgTable("video_index", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  youtubeId: varchar("youtube_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  viewCount: integer("view_count").notNull().default(0),
  thumbnailUrl: text("thumbnail_url"),
  status: varchar("status").notNull().default("Pending Scan"),
  priorityScore: integer("priority_score").notNull().default(0),
  publishedAt: timestamp("published_at"),
  category: varchar("category"),
  isEvergreen: boolean("is_evergreen").default(false),
  duration: varchar("duration"),
  platform: varchar("platform").notNull().default("youtube"), // 'youtube', 'instagram', 'facebook'
  sentiment: varchar("sentiment").default("Neutral"), // 'Uplifting', 'Serious', 'Chaotic', 'Educational', etc.
  culturalContext: varchar("cultural_context").default("General"), // 'American Tech Office', 'Japanese Tea Room', etc.
  filePath: text("file_path"), // Persistent file path for uploaded videos (survives server restart)
  sourceUrl: text("source_url"), // Canonical URL to the original content (Facebook permalink, Instagram permalink, etc.)
  subcategory: varchar("subcategory"), // e.g., "Sports", "Tech", "Comedy" — finer classification than category
  tags: jsonb("tags"), // Flexible tag array for future filtering (e.g., ["sports", "basketball", "interview"])
  // Soft delete (trash bin)
  deletedAt: timestamp("deleted_at"), // null = active, set = trashed
  // Editorial auto-clip pipeline state (Feature A):
  // null | 'pending' | 'transcribing' | 'analyzing' | 'rendering' | 'ready' | 'failed'
  editorialStatus: varchar("editorial_status", { length: 20 }),
  editorialError: text("editorial_error"),
  editorialClipCount: integer("editorial_clip_count").default(0),
  editorialCompletedAt: timestamp("editorial_completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertVideoIndexSchema = createInsertSchema(videoIndex).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type VideoIndex = typeof videoIndex.$inferSelect;
export type InsertVideoIndex = z.infer<typeof insertVideoIndexSchema>;

// Detected Surfaces Table - stores AI-detected ad placement surfaces in videos
export const detectedSurfaces = pgTable("detected_surfaces", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull(), // Reference to video_index.id
  timestamp: numeric("timestamp").notNull(), // Seconds into video where surface was detected
  surfaceType: varchar("surface_type").notNull(), // Table, Desk, Wall, Monitor, Bottle
  confidence: numeric("confidence").notNull(), // AI confidence score (0-1)
  boundingBoxX: numeric("bounding_box_x").notNull(), // X coordinate (0-1 normalized)
  boundingBoxY: numeric("bounding_box_y").notNull(), // Y coordinate (0-1 normalized)
  boundingBoxWidth: numeric("bounding_box_width").notNull(), // Width (0-1 normalized)
  boundingBoxHeight: numeric("bounding_box_height").notNull(), // Height (0-1 normalized)
  frameUrl: text("frame_url"), // Optional: stored frame image URL
  surroundings: text("surroundings").array(), // Array of surrounding objects detected
  sceneContext: text("scene_context"), // Scene description from AI
  // Lighting & camera data for realistic product placement (populated by Gemini AI)
  lightingDirection: varchar("lighting_direction"), // left, right, top, top-left, top-right, ambient
  lightingIntensity: numeric("lighting_intensity"), // 0.0-1.0 (dim to bright)
  cameraAngle: varchar("camera_angle"), // eye-level, slightly-above, top-down, low-angle
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertDetectedSurfaceSchema = createInsertSchema(detectedSurfaces).omit({
  id: true,
  createdAt: true,
});

export type DetectedSurface = typeof detectedSurfaces.$inferSelect;
export type InsertDetectedSurface = z.infer<typeof insertDetectedSurfaceSchema>;

// Surface Keyframes Table — stores per-frame bounding box positions for motion tracking
// Preserves the raw bbox before normalization overwrites it, enabling smooth interpolation
export const surfaceKeyframes = pgTable("surface_keyframes", {
  id: serial("id").primaryKey(),
  surfaceId: integer("surface_id").notNull(), // References detected_surfaces.id (canonical surface)
  videoId: integer("video_id").notNull(), // References video_index.id
  timestamp: numeric("timestamp").notNull(), // Seconds into video
  boundingBoxX: numeric("bounding_box_x").notNull(), // 0-1 normalized
  boundingBoxY: numeric("bounding_box_y").notNull(),
  boundingBoxWidth: numeric("bounding_box_width").notNull(),
  boundingBoxHeight: numeric("bounding_box_height").notNull(),
  confidence: numeric("confidence").notNull(), // Detection confidence at this frame
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSurfaceKeyframeSchema = createInsertSchema(surfaceKeyframes).omit({
  id: true,
  createdAt: true,
});

export type SurfaceKeyframe = typeof surfaceKeyframes.$inferSelect;
export type InsertSurfaceKeyframe = z.infer<typeof insertSurfaceKeyframeSchema>;

// Brand Products Table - stores product images uploaded by brands for placement previews
export const brandProducts = pgTable("brand_products", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(), // Brand user ID (references users.id)
  name: varchar("name").notNull(), // Product name
  imageUrl: text("image_url").notNull(), // Path to stored product image
  thumbnailUrl: text("thumbnail_url"), // Auto-generated smaller thumbnail
  category: varchar("category"), // e.g., "beverage", "electronics", "fashion"
  width: integer("width"), // Image pixel width
  height: integer("height"), // Image pixel height
  isTransparent: boolean("is_transparent").default(false), // Whether image has alpha channel
  // Product ingest analysis fields (auto-populated on upload)
  subjectBoundsX: numeric("subject_bounds_x"), // Normalized 0-1: X offset of non-transparent subject
  subjectBoundsY: numeric("subject_bounds_y"), // Normalized 0-1: Y offset of non-transparent subject
  subjectBoundsW: numeric("subject_bounds_w"), // Normalized 0-1: Width of non-transparent subject
  subjectBoundsH: numeric("subject_bounds_h"), // Normalized 0-1: Height of non-transparent subject
  dominantColor: varchar("dominant_color"), // Hex color e.g. "#FF6B2B"
  backgroundType: varchar("background_type"), // 'transparent' | 'solid' | 'complex'
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertBrandProductSchema = createInsertSchema(brandProducts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type BrandProduct = typeof brandProducts.$inferSelect;
export type InsertBrandProduct = z.infer<typeof insertBrandProductSchema>;

// Brand Placement Assignments — brand-initiated placement requests waiting for creator approval.
// Flow: brand picks a product + surface(s) on a creator's video → row created with status
// 'pending_creator_review' → creator sees in their inbox → approves or rejects → on approval,
// auto-remix renders include the brand product on that surface.
//
// Constraint: only ONE active (pending or approved) assignment per surface_id. Enforced at
// app layer in storage.createBrandPlacement(). A second brand requesting the same surface
// gets a 409 Conflict until the first is rejected/withdrawn.
export const brandPlacementAssignments = pgTable("brand_placement_assignments", {
  id: serial("id").primaryKey(),
  brandUserId: varchar("brand_user_id").notNull(),       // Brand who requested placement
  creatorUserId: varchar("creator_user_id").notNull(),   // Creator who owns the video
  videoId: integer("video_id").notNull(),                // FK to video_index.id
  // The editorial clip this placement targets (nullable for backward-compat with
  // legacy assignments tied to source video, but new requests should always set it).
  // Brands browse rendered editorial clips and request placements on surfaces within them.
  editorialClipId: integer("editorial_clip_id"),         // FK to editorial_clips.id
  brandProductId: integer("brand_product_id").notNull(), // FK to brand_products.id
  surfaceId: integer("surface_id").notNull(),            // FK to detected_surfaces.id
  // Status lifecycle:
  //   pending_creator_review (default) → creator_approved | creator_rejected | brand_withdrawn | expired
  status: varchar("status", { length: 30 }).notNull().default("pending_creator_review"),
  brandMessage: text("brand_message"),                   // Optional message from brand → creator
  rejectionReason: text("rejection_reason"),             // Optional reason from creator
  reviewedAt: timestamp("reviewed_at"),                  // When creator approved/rejected
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertBrandPlacementAssignmentSchema = createInsertSchema(brandPlacementAssignments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type BrandPlacementAssignment = typeof brandPlacementAssignments.$inferSelect;
export type InsertBrandPlacementAssignment = z.infer<typeof insertBrandPlacementAssignmentSchema>;

// Saved Placements Table - persistent product placements on video surfaces
// Supports scene continuity: a placement on one surface auto-propagates to similar surfaces
export const savedPlacements = pgTable("saved_placements", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull(), // Reference to video_index.id
  surfaceId: integer("surface_id").notNull(), // Reference to detected_surfaces.id (anchor surface)
  productId: integer("product_id"), // Reference to brand_products.id (null if custom upload)
  productImageUrl: text("product_image_url").notNull(), // URL of product image used
  createdBy: varchar("created_by").notNull(), // Email of user who created placement
  role: varchar("role").notNull().default("creator"), // 'creator' or 'brand'
  bidId: integer("bid_id"), // Reference to monetization_items.id (null for organic placements)
  // Scene continuity: group ID links surfaces that share the same placement
  sceneGroupId: varchar("scene_group_id"), // e.g., "video-5-Desk-0.3-0.5" — surfaces with matching group share placements
  // Transform settings (JSON blob)
  transform: jsonb("transform").notNull().$type<{
    offsetX: number;
    offsetY: number;
    scale: number;
    rotation: number;
    flipH: boolean;
  }>(),
  // Blend settings (JSON blob)
  blend: jsonb("blend").notNull().$type<{
    opacity: number;
    blendMode: string;
    shadowEnabled: boolean;
    shadowBlur: number;
    shadowOffsetX: number;
    shadowOffsetY: number;
    shadowColor: string;
    featherRadius: number;
    brightness: number;
    contrast: number;
  }>(),
  status: varchar("status").notNull().default("active"), // 'active', 'archived'
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSavedPlacementSchema = createInsertSchema(savedPlacements).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SavedPlacement = typeof savedPlacements.$inferSelect;
export type InsertSavedPlacement = z.infer<typeof insertSavedPlacementSchema>;

// Video Exports Table - tracks async video export jobs (composited videos with product placements)
export const videoExports = pgTable("video_exports", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull(), // Reference to video_index.id
  requestedBy: varchar("requested_by").notNull(), // Email of user who requested export
  status: varchar("status").notNull().default("queued"), // 'queued' | 'processing' | 'complete' | 'failed'
  progress: integer("progress").default(0), // 0-100 percentage
  placementData: jsonb("placement_data").notNull(), // Array of placement configs with keyframes
  outputPath: text("output_path"), // Path to exported MP4 file
  outputUrl: text("output_url"), // Relative URL for download
  error: text("error"), // Error message if failed
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertVideoExportSchema = createInsertSchema(videoExports).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});

export type VideoExport = typeof videoExports.$inferSelect;
export type InsertVideoExport = z.infer<typeof insertVideoExportSchema>;

// Shared Links Table — shareable public links for placements and exports
export const sharedLinks = pgTable("shared_links", {
  id: serial("id").primaryKey(),
  slug: varchar("slug").notNull().unique(), // 8-char unique slug for URL (e.g., /s/abc12345)
  placementId: integer("placement_id"), // Reference to saved_placements.id (optional)
  exportId: integer("export_id"), // Reference to video_exports.id (optional)
  videoId: integer("video_id").notNull(), // Reference to video_index.id
  createdBy: varchar("created_by").notNull(), // Email of user who created the share link
  title: text("title"), // Optional custom title for the shared content
  viewCount: integer("view_count").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true), // Can be deactivated
  expiresAt: timestamp("expires_at"), // Optional expiration date
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSharedLinkSchema = createInsertSchema(sharedLinks).omit({
  id: true,
  viewCount: true,
  createdAt: true,
});

export type SharedLink = typeof sharedLinks.$inferSelect;
export type InsertSharedLink = z.infer<typeof insertSharedLinkSchema>;

// ============================================================================
// EDITORIAL INTELLIGENCE: Transcript + Feedback Tables
// ============================================================================

// Video Transcripts Table — speech-to-text transcription with speaker diarization
export const videoTranscripts = pgTable('video_transcripts', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').references(() => videoIndex.id).notNull(),
  provider: varchar('provider', { length: 30 }).notNull(), // 'whisper', 'deepgram'
  language: varchar('language', { length: 10 }).default('en'),
  // Full transcript text (plain)
  fullText: text('full_text'),
  // Timestamped segments with speaker diarization
  segments: jsonb('segments').$type<Array<{
    start: number;      // seconds
    end: number;        // seconds
    text: string;
    speaker?: string;   // speaker ID from diarization
    confidence: number; // 0-1
    words?: Array<{
      word: string;
      start: number;
      end: number;
      confidence: number;
    }>;
  }>>(),
  // Speaker map (diarization labels → display names)
  speakerMap: jsonb('speaker_map').$type<Record<string, string>>(),
  // Processing metadata
  audioDuration: real('audio_duration'),     // total audio length in seconds
  wordCount: integer('word_count'),
  segmentCount: integer('segment_count'),
  status: varchar('status', { length: 20 }).default('pending'), // pending, processing, completed, failed
  errorMessage: text('error_message'),
  processingTimeMs: integer('processing_time_ms'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at'),
});

export const insertVideoTranscriptSchema = createInsertSchema(videoTranscripts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type VideoTranscript = typeof videoTranscripts.$inferSelect;
export type InsertVideoTranscript = z.infer<typeof insertVideoTranscriptSchema>;

// Clip Feedback Table — creator/brand approval + post-publish performance tracking
export const clipFeedback = pgTable('clip_feedback', {
  id: serial('id').primaryKey(),
  generatedClipId: integer('generated_clip_id').references(() => generatedClips.id).notNull(),
  feedbackType: varchar('feedback_type', { length: 20 }).notNull(), // 'creator', 'brand', 'performance'
  approved: boolean('approved'),
  rating: integer('rating'),                                        // 1-5
  rejectionReason: varchar('rejection_reason', { length: 200 }),
  // Performance metrics (post-publish, collected by analyticsCollector)
  views: integer('views'),
  engagementRate: real('engagement_rate'),
  shareCount: integer('share_count'),
  completionRate: real('completion_rate'),                          // % of viewers who watched to end
  clickThroughRate: real('click_through_rate'),                    // % who clicked product link
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at'),
});

export const insertClipFeedbackSchema = createInsertSchema(clipFeedback).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ClipFeedback = typeof clipFeedback.$inferSelect;
export type InsertClipFeedback = z.infer<typeof insertClipFeedbackSchema>;

// ============================================================================
// PHASE 1: NARRATIVE INTELLIGENCE + AUTO-REMIX TABLES
// ============================================================================

// Scene Analysis Table — Claude Dense narrative analysis per surface/frame
export const sceneAnalysis = pgTable('scene_analysis', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').references(() => videoIndex.id).notNull(),
  surfaceId: integer('surface_id').references(() => detectedSurfaces.id),
  frameStart: real('frame_start').notNull(),
  frameEnd: real('frame_end'),
  narrativeContext: text('narrative_context'),
  emotionalTone: varchar('emotional_tone', { length: 50 }),
  culturalTags: jsonb('cultural_tags').$type<string[]>(),
  placementViability: real('placement_viability'),
  suggestedCategories: jsonb('suggested_categories').$type<string[]>(),
  reasoning: text('reasoning'),
  claudeResponseRaw: jsonb('claude_response_raw'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const insertSceneAnalysisSchema = createInsertSchema(sceneAnalysis).omit({
  id: true,
  createdAt: true,
});

export type SceneAnalysis = typeof sceneAnalysis.$inferSelect;
export type InsertSceneAnalysis = z.infer<typeof insertSceneAnalysisSchema>;

// Brand Match Scores Table — brand ↔ scene compatibility scores
export const brandMatchScores = pgTable('brand_match_scores', {
  id: serial('id').primaryKey(),
  sceneAnalysisId: integer('scene_analysis_id').references(() => sceneAnalysis.id).notNull(),
  brandProductId: integer('brand_product_id').references(() => brandProducts.id).notNull(),
  compatibilityScore: real('compatibility_score'),
  reasoning: text('reasoning'),
  suggestedPlacementStyle: varchar('suggested_placement_style', { length: 100 }),
  approved: boolean('approved').default(false),
  approvedBy: varchar('approved_by', { length: 20 }),
  createdAt: timestamp('created_at').defaultNow(),
});

export const insertBrandMatchScoreSchema = createInsertSchema(brandMatchScores).omit({
  id: true,
  createdAt: true,
});

export type BrandMatchScore = typeof brandMatchScores.$inferSelect;
export type InsertBrandMatchScore = z.infer<typeof insertBrandMatchScoreSchema>;

// Remix Jobs Table — auto-remix job tracking
export const remixJobs = pgTable('remix_jobs', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').references(() => videoIndex.id).notNull(),
  userId: integer('user_id').notNull(),
  status: varchar('status', { length: 30 }).default('queued'),
  config: jsonb('config').$type<{
    minClipDuration: number;
    maxClipDuration: number;
    maxClips: number;
    platformTargets: string[];
    captionsEnabled: boolean;
    captionStyle?: string;
    clipRange?: { start: number; end: number };
    editorialMode?: boolean;
  }>(),
  clipCount: integer('clip_count').default(0),
  platformTargets: jsonb('platform_targets').$type<string[]>(),
  brandMatchIds: jsonb('brand_match_ids').$type<number[]>(),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow(),
  completedAt: timestamp('completed_at'),
});

export const insertRemixJobSchema = createInsertSchema(remixJobs).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});

export type RemixJob = typeof remixJobs.$inferSelect;
export type InsertRemixJob = z.infer<typeof insertRemixJobSchema>;

// Generated Clips Table — clips from auto-remix pipeline
export const generatedClips = pgTable('generated_clips', {
  id: serial('id').primaryKey(),
  remixJobId: integer('remix_job_id').references(() => remixJobs.id).notNull(),
  videoId: integer('video_id').references(() => videoIndex.id).notNull(),
  clipStart: real('clip_start').notNull(),
  clipEnd: real('clip_end').notNull(),
  duration: real('duration').notNull(),
  format: varchar('format', { length: 10 }),
  platformTarget: varchar('platform_target', { length: 30 }),
  productPlacements: jsonb('product_placements').$type<Array<{
    surfaceId: number;
    brandProductId: number;
    placementId: number;
  }>>(),
  captionsEnabled: boolean('captions_enabled').default(true),
  qualityScore: real('quality_score'),
  exportPath: varchar('export_path', { length: 500 }),
  thumbnailPath: varchar('thumbnail_path', { length: 500 }),
  status: varchar('status', { length: 30 }).default('generated'),
  publishedAt: timestamp('published_at'),
  publishedPlatform: varchar('published_platform', { length: 30 }),
  publishedUrl: varchar('published_url', { length: 500 }),
  createdAt: timestamp('created_at').defaultNow(),
});

export const insertGeneratedClipSchema = createInsertSchema(generatedClips).omit({
  id: true,
  createdAt: true,
});

export type GeneratedClip = typeof generatedClips.$inferSelect;
export type InsertGeneratedClip = z.infer<typeof insertGeneratedClipSchema>;

// Stitch Plans Table — multi-segment highlight reel plans (OpusClip-style)
export const stitchPlans = pgTable('stitch_plans', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').references(() => videoIndex.id).notNull(),
  userId: integer('user_id').notNull(),
  status: varchar('status', { length: 30 }).default('draft'), // draft, generating, completed, failed
  narrativeArc: text('narrative_arc'),
  suggestedTitle: varchar('suggested_title', { length: 200 }),
  segments: jsonb('segments').$type<Array<{
    start: number;
    end: number;
    role: 'hook' | 'development' | 'climax' | 'payoff' | 'bridge';
    narrativePurpose: string;
    connectionToNext?: string;
    suggestedTransition: 'cut' | 'crossfade' | 'branded_wipe';
    enabled: boolean;
  }>>(),
  totalDuration: real('total_duration'),
  transitionStyle: varchar('transition_style', { length: 30 }).default('crossfade'),
  platformTarget: varchar('platform_target', { length: 30 }).default('tiktok'),
  outputPath: varchar('output_path', { length: 500 }),
  thumbnailPath: varchar('thumbnail_path', { length: 500 }),
  qualityScore: real('quality_score'),
  generatedClipId: integer('generated_clip_id').references(() => generatedClips.id),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow(),
  completedAt: timestamp('completed_at'),
});

export const insertStitchPlanSchema = createInsertSchema(stitchPlans).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});

export type StitchPlan = typeof stitchPlans.$inferSelect;
export type InsertStitchPlan = z.infer<typeof insertStitchPlanSchema>;

// Editorial Clips Table — persisted AI-identified viral moments for each video
export const editorialClips = pgTable('editorial_clips', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').references(() => videoIndex.id).notNull(),
  userId: integer('user_id').notNull(),
  clipStart: real('clip_start').notNull(),
  clipEnd: real('clip_end').notNull(),
  duration: real('duration').notNull(),
  editorialScore: real('editorial_score'),
  surfaceScore: real('surface_score'),
  brandMatchScore: real('brand_match_score'),
  finalScore: real('final_score'),
  monetizationTier: varchar('monetization_tier', { length: 20 }), // premium, standard, organic
  scores: jsonb('scores').$type<{
    hookStrength: number;
    narrativeCompleteness: number;
    emotionalArc: number;
    speakerClarity: number;
    surfaceCompatibility: number;
    culturalRelevance: number;
    replayability: number;
  }>(),
  surfaces: jsonb('surfaces'),
  brandMatches: jsonb('brand_matches'),
  editPoints: jsonb('edit_points').$type<{ start: number; end: number; adjustments: string[] }>(),
  suggestedTitle: varchar('suggested_title', { length: 300 }),
  topicTags: jsonb('topic_tags').$type<string[]>(),
  reasoning: text('reasoning'),
  rawClipStart: real('raw_clip_start'),
  rawClipEnd: real('raw_clip_end'),
  // Auto-render fields (Editorial Auto-Clips pipeline)
  exportPath: varchar('export_path', { length: 500 }),       // Object Storage URL for rendered MP4
  thumbnailPath: varchar('thumbnail_path', { length: 500 }), // Object Storage URL for thumbnail JPG
  aspectRatio: varchar('aspect_ratio', { length: 10 }),      // e.g., '9:16', '16:9', '1:1'
  renderStatus: varchar('render_status', { length: 20 }).default('pending'), // pending, rendering, rendered, failed
  renderError: text('render_error'),
  renderedAt: timestamp('rendered_at'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const insertEditorialClipSchema = createInsertSchema(editorialClips).omit({
  id: true,
  createdAt: true,
});

export type EditorialClip = typeof editorialClips.$inferSelect;
export type InsertEditorialClip = z.infer<typeof insertEditorialClipSchema>;

// Remix Templates Table — brand-specific formatting templates
export const remixTemplates = pgTable('remix_templates', {
  id: serial('id').primaryKey(),
  userId: integer('user_id'),
  brandId: integer('brand_id'),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  formatRules: jsonb('format_rules'),
  transitionStyle: varchar('transition_style', { length: 50 }),
  captionStyle: jsonb('caption_style'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const insertRemixTemplateSchema = createInsertSchema(remixTemplates).omit({
  id: true,
  createdAt: true,
});

export type RemixTemplate = typeof remixTemplates.$inferSelect;
export type InsertRemixTemplate = z.infer<typeof insertRemixTemplateSchema>;

// Generated Assets Table — AI-generated product assets (video clips via Seeddance 2.0 or images)
export const generatedAssets = pgTable('generated_assets', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').references(() => videoIndex.id).notNull(),
  surfaceId: integer('surface_id').references(() => detectedSurfaces.id),
  brandProductId: integer('brand_product_id').references(() => brandProducts.id),
  assetType: varchar('asset_type', { length: 30 }), // 'video', 'image', 'placeholder'
  generationPrompt: text('generation_prompt'),
  assetPath: varchar('asset_path', { length: 500 }),
  compositePath: varchar('composite_path', { length: 500 }),
  // Video-specific fields (Seeddance 2.0)
  seeddanceJobId: varchar('seeddance_job_id', { length: 200 }),
  videoDuration: real('video_duration'), // seconds
  videoAspectRatio: varchar('video_aspect_ratio', { length: 10 }), // e.g. "16:9", "9:16"
  videoResolution: varchar('video_resolution', { length: 10 }), // e.g. "1080p", "720p"
  targetPlatform: varchar('target_platform', { length: 30 }), // e.g. "tiktok", "youtube"
  // Quality evaluation
  qualityScore: real('quality_score'),
  needsManualReview: boolean('needs_manual_review').default(true),
  approved: boolean('approved').default(false),
  createdAt: timestamp('created_at').defaultNow(),
});

export const insertGeneratedAssetSchema = createInsertSchema(generatedAssets).omit({
  id: true,
  createdAt: true,
});

export type GeneratedAsset = typeof generatedAssets.$inferSelect;
export type InsertGeneratedAsset = z.infer<typeof insertGeneratedAssetSchema>;

// ─── Phase 3: Distribution & Analytics ─────────────────────────

export const distributionProfiles = pgTable('distribution_profiles', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  platform: varchar('platform', { length: 30 }).notNull(), // tiktok, instagram, youtube, twitter, linkedin
  accountName: varchar('account_name', { length: 200 }),
  accountId: varchar('account_id', { length: 200 }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: timestamp('token_expires_at'),
  isActive: boolean('is_active').default(true),
  metadata: jsonb('metadata').$type<Record<string, any>>(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const insertDistributionProfileSchema = createInsertSchema(distributionProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type DistributionProfile = typeof distributionProfiles.$inferSelect;
export type InsertDistributionProfile = z.infer<typeof insertDistributionProfileSchema>;

export const publishedPosts = pgTable('published_posts', {
  id: serial('id').primaryKey(),
  clipId: integer('clip_id').references(() => generatedClips.id).notNull(),
  videoId: integer('video_id').references(() => videoIndex.id).notNull(),
  profileId: integer('profile_id').references(() => distributionProfiles.id),
  platform: varchar('platform', { length: 30 }).notNull(),
  platformPostId: varchar('platform_post_id', { length: 200 }),
  postUrl: varchar('post_url', { length: 500 }),
  caption: text('caption'),
  hashtags: jsonb('hashtags').$type<string[]>(),
  scheduledFor: timestamp('scheduled_for'),
  publishedAt: timestamp('published_at'),
  status: varchar('status', { length: 30 }).default('draft'), // draft, scheduled, publishing, published, failed
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const insertPublishedPostSchema = createInsertSchema(publishedPosts).omit({
  id: true,
  createdAt: true,
});

export type PublishedPost = typeof publishedPosts.$inferSelect;
export type InsertPublishedPost = z.infer<typeof insertPublishedPostSchema>;

export const clipAnalytics = pgTable('clip_analytics', {
  id: serial('id').primaryKey(),
  postId: integer('post_id').references(() => publishedPosts.id).notNull(),
  clipId: integer('clip_id').references(() => generatedClips.id).notNull(),
  platform: varchar('platform', { length: 30 }).notNull(),
  views: integer('views').default(0),
  likes: integer('likes').default(0),
  comments: integer('comments').default(0),
  shares: integer('shares').default(0),
  saves: integer('saves').default(0),
  reach: integer('reach').default(0),
  impressions: integer('impressions').default(0),
  engagementRate: real('engagement_rate').default(0),
  watchTimeSeconds: real('watch_time_seconds').default(0),
  completionRate: real('completion_rate').default(0),
  clickThroughRate: real('click_through_rate').default(0),
  demographicsData: jsonb('demographics_data').$type<Record<string, any>>(),
  fetchedAt: timestamp('fetched_at').defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const insertClipAnalyticsSchema = createInsertSchema(clipAnalytics).omit({
  id: true,
  createdAt: true,
});

export type ClipAnalytics = typeof clipAnalytics.$inferSelect;
export type InsertClipAnalytics = z.infer<typeof insertClipAnalyticsSchema>;

export const publishingSchedules = pgTable('publishing_schedules', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  clipId: integer('clip_id').references(() => generatedClips.id).notNull(),
  profileId: integer('profile_id').references(() => distributionProfiles.id).notNull(),
  platform: varchar('platform', { length: 30 }).notNull(),
  scheduledFor: timestamp('scheduled_for').notNull(),
  caption: text('caption'),
  hashtags: jsonb('hashtags').$type<string[]>(),
  status: varchar('status', { length: 30 }).default('pending'), // pending, processing, completed, failed, cancelled
  postId: integer('post_id'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const insertPublishingScheduleSchema = createInsertSchema(publishingSchedules).omit({
  id: true,
  createdAt: true,
});

export type PublishingSchedule = typeof publishingSchedules.$inferSelect;
export type InsertPublishingSchedule = z.infer<typeof insertPublishingScheduleSchema>;

// ============================================================================
// FULLSCALE STUDIO: Subscriptions, Usage & Voice Tables
// ============================================================================

// Studio Subscriptions — tracks user's active plan tier
export const studioSubscriptions = pgTable("studio_subscriptions", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().unique(), // References users.id
  tier: varchar("tier").notNull().default("free"), // 'free' | 'starter' | 'pro' | 'business'
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  status: varchar("status").notNull().default("active"), // 'active' | 'canceled' | 'past_due' | 'trialing'
  cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertStudioSubscriptionSchema = createInsertSchema(studioSubscriptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type StudioSubscription = typeof studioSubscriptions.$inferSelect;
export type InsertStudioSubscription = z.infer<typeof insertStudioSubscriptionSchema>;

// Studio Usage — tracks monthly video generation count per user
export const studioUsage = pgTable("studio_usage", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(), // References users.id
  month: varchar("month").notNull(), // YYYY-MM format (e.g., "2026-03")
  videosGenerated: integer("videos_generated").notNull().default(0),
  videosLimit: integer("videos_limit").notNull().default(1), // Derived from tier at time of creation
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertStudioUsageSchema = createInsertSchema(studioUsage).omit({
  id: true,
  createdAt: true,
});

export type StudioUsage = typeof studioUsage.$inferSelect;
export type InsertStudioUsage = z.infer<typeof insertStudioUsageSchema>;

// Studio Voices — available ElevenLabs voices gated by tier
export const studioVoices = pgTable("studio_voices", {
  id: serial("id").primaryKey(),
  voiceId: varchar("voice_id").notNull().unique(), // ElevenLabs voice ID
  name: varchar("name").notNull(), // Display name (e.g., "Rachel", "Adam")
  previewUrl: text("preview_url"), // URL to audio preview sample
  tier: varchar("tier").notNull().default("free"), // Minimum tier required: 'free' | 'starter' | 'pro' | 'business'
  category: varchar("category").notNull().default("professional"), // 'professional' | 'casual' | 'narrator' | 'character'
  gender: varchar("gender"), // 'male' | 'female' | 'neutral'
  accent: varchar("accent"), // 'american' | 'british' | 'australian' etc.
  description: text("description"), // Short description of the voice
  isDefault: boolean("is_default").default(false), // Default voice for free tier
  isActive: boolean("is_active").default(true), // Can be temporarily disabled
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertStudioVoiceSchema = createInsertSchema(studioVoices).omit({
  id: true,
  createdAt: true,
});

export type StudioVoice = typeof studioVoices.$inferSelect;
export type InsertStudioVoice = z.infer<typeof insertStudioVoiceSchema>;

// Studio Videos — tracks generated Studio videos (document-to-video outputs)
export const studioVideos = pgTable("studio_videos", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(), // References users.id
  title: varchar("title"), // Auto-derived from document
  sourceFileName: varchar("source_file_name"), // Original uploaded file name
  sourceFileUrl: text("source_file_url"), // Stored document path
  voiceId: varchar("voice_id"), // ElevenLabs voice used
  tier: varchar("tier").notNull().default("free"), // Tier at time of generation
  visualQuality: varchar("visual_quality").default("720p"), // '720p' | '1080p'
  visualMode: varchar("visual_mode").default("static"), // 'static' | 'ai_generated'
  isWatermarked: boolean("is_watermarked").default(true),
  // Status:
  //   'queued' | 'extracting' | 'script_ready' | 'processing' | 'completed' | 'failed' | 'cancelled'
  status: varchar("status").notNull().default("queued"),
  progress: integer("progress").default(0), // 0-100
  outputUrl: text("output_url"), // Path to final MP4
  thumbnailUrl: text("thumbnail_url"),
  durationSeconds: real("duration_seconds"),
  sceneCount: integer("scene_count"),
  errorMessage: text("error_message"),
  // Two-stage pipeline fields
  scriptData: jsonb("script_data"), // StoryScript JSON from extract stage
  workDir: text("work_dir"),          // Path to workDir where slides live (between extract + generate)
  deckIntent: varchar("deck_intent"), // investor-pitch / sales-deck / team-update / marketing
  slideImagePaths: jsonb("slide_image_paths"), // Array of paths to rendered slide JPEGs
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertStudioVideoSchema = createInsertSchema(studioVideos).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});

export type StudioVideo = typeof studioVideos.$inferSelect;
export type InsertStudioVideo = z.infer<typeof insertStudioVideoSchema>;

// Studio Jobs Table — tracks pipeline job progress
export const studioJobs = pgTable('studio_jobs', {
  id: serial("id").primaryKey(),
  videoId: integer('video_id'),
  status: text('status').default('queued'), // queued | parsing | extracting | generating | adding-voice | assembling | complete | failed
  currentStage: text('current_stage'),
  progress: integer('progress').default(0),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const insertStudioJobSchema = createInsertSchema(studioJobs).omit({
  id: true,
  createdAt: true,
});

export type StudioJob = typeof studioJobs.$inferSelect;
export type InsertStudioJob = z.infer<typeof insertStudioJobSchema>;

// ── Studio Waitlist ─────────────────────────────────────────────────
export const studioWaitlist = pgTable("studio_waitlist", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id"),
  name: varchar("name").notNull(),
  email: varchar("email").notNull(),
  useCase: text("use_case"),
  status: varchar("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected'
  submittedAt: timestamp("submitted_at").defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
  reviewedBy: varchar("reviewed_by"),
});

export const insertStudioWaitlistSchema = createInsertSchema(studioWaitlist).omit({
  id: true,
  submittedAt: true,
  reviewedAt: true,
  reviewedBy: true,
});

export type StudioWaitlistEntry = typeof studioWaitlist.$inferSelect;
export type InsertStudioWaitlistEntry = z.infer<typeof insertStudioWaitlistSchema>;

// ═══════════════════════════════════════════════════════════════════════
// Brand Brief — multi-step onboarding wizard submitted by brand users.
// One brief per user (userId is UNIQUE). Status flips from 'draft' to
// 'submitted' when the user hits Submit on the final step of the wizard.
// Array fields use jsonb so we can store multi-select chip values
// without a join table. Fields nullable to support draft state where
// the user is part-way through the wizard.
// ═══════════════════════════════════════════════════════════════════════
export const brandBriefs = pgTable("brand_briefs", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().unique(),
  status: varchar("status").notNull().default("draft"), // 'draft' | 'submitted'

  // Step 1 — Your Brand at a Glance
  brandName: varchar("brand_name"),
  website: varchar("website"),
  industry: varchar("industry"),
  brandVoice: jsonb("brand_voice").$type<string[]>().default([]),
  logoUrl: varchar("logo_url"),

  // Step 2 — What You Want to Place
  placementTypes: jsonb("placement_types").$type<string[]>().default([]),
  productDescription: text("product_description"),
  referenceImageUrls: jsonb("reference_image_urls").$type<string[]>().default([]),
  flexibility: varchar("flexibility"), // 'exact' | 'substitutes' | 'flexible'

  // Step 3 — Who You Want to Reach
  targetGeographies: jsonb("target_geographies").$type<string[]>().default([]),
  audienceAgeMin: integer("audience_age_min").default(18),
  audienceAgeMax: integer("audience_age_max").default(45),
  audienceInterests: jsonb("audience_interests").$type<string[]>().default([]),
  languages: jsonb("languages").$type<string[]>().default([]),

  // Step 4 — What Success Looks Like
  primaryObjective: varchar("primary_objective"), // 'awareness' | 'launch' | 'pmf_test' | 'conversions' | 'partnerships' | 'other'
  successMeasurement: text("success_measurement"),
  budgetRange: varchar("budget_range"), // 'under_5k' | '5k_25k' | '25k_100k' | '100k_500k' | '500k_plus' | 'discuss'
  timeline: varchar("timeline"), // 'one_time' | '3mo' | '6mo' | 'ongoing' | 'exploring'

  // Step 5 — Working Together
  contentCategories: jsonb("content_categories").$type<string[]>().default([]),
  specificCreators: text("specific_creators"),
  thingsToAvoid: text("things_to_avoid"),
  handsOnLevel: varchar("hands_on_level"), // 'hands_off' | 'selective' | 'hands_on'

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  submittedAt: timestamp("submitted_at"),
});

export const insertBrandBriefSchema = createInsertSchema(brandBriefs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  submittedAt: true,
});

export type BrandBrief = typeof brandBriefs.$inferSelect;
export type InsertBrandBrief = z.infer<typeof insertBrandBriefSchema>;
