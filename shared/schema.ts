import { pgTable, text, serial, timestamp, boolean, varchar, integer, numeric, uniqueIndex, index, jsonb, real, uuid, bigint } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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

// Social Accounts Table — multi-account creator identity.
//
// Replaces the single-account-per-platform model on the users table
// (users.facebookPageId, users.instagramHandle, etc.) with a normalized
// table that supports multiple accounts per user, distinguished by type.
//
// One user can have e.g.:
//   (instagram, business, @quiettruthpodcast)
//   (instagram, personal, @martin)
//   (facebook, business, "Quiet Truth Podcast" Page)
//   (youtube, business, the podcast channel)
//   (youtube, personal, Martin's personal channel)
//
// audience_data is a JSONB blob holding the latest demographics +
// engagement metrics pulled from each platform. Shape:
//   {
//     age_distribution: { "13-17": 0.05, "18-24": 0.32, ... },
//     gender_distribution: { "male": 0.55, "female": 0.43, "other": 0.02 },
//     top_countries: [{ code: "US", percent: 0.78 }, ...],
//     top_cities: [{ name: "New York", percent: 0.12 }, ...],
//     engagement: { reach: ..., total_interactions: ..., follower_count: ... },
//     raw: { ... }
//   }
//
// See docs/adr/001-multi-account-creator-profile.md for full design.
export const socialAccounts = pgTable("social_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: varchar("user_id").notNull(),

  platform: varchar("platform").notNull(),                    // 'instagram' | 'facebook' | 'youtube' | 'twitch'
  accountType: varchar("account_type").notNull(),             // 'business' | 'personal'
  platformAccountId: varchar("platform_account_id").notNull(), // FB page id / IG biz id / YT channel id

  handle: varchar("handle"),                                   // @username, page name, channel name
  displayName: varchar("display_name"),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),                                            // platform-provided bio (input for AI synthesis)

  followers: integer("followers"),
  totalViews: bigint("total_views", { mode: "number" }),       // YT channel total views; null elsewhere

  accessToken: text("access_token"),                           // encrypted
  refreshToken: text("refresh_token"),                         // encrypted, nullable (FB doesn't refresh)
  tokenExpiresAt: timestamp("token_expires_at"),
  scopes: text("scopes").array(),                              // granted OAuth scopes

  audienceData: jsonb("audience_data"),                        // latest demographics; see comment above
  audienceSyncedAt: timestamp("audience_synced_at"),

  metadata: jsonb("metadata"),                                 // platform-specific extras
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  userIdIdx: index("idx_social_accounts_user_id").on(table.userId),
  platformIdx: index("idx_social_accounts_platform").on(table.platform, table.accountType),
  uniqueAccount: uniqueIndex("idx_social_accounts_unique").on(
    table.userId, table.platform, table.accountType, table.platformAccountId
  ),
}));

export const insertSocialAccountSchema = createInsertSchema(socialAccounts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SocialAccount = typeof socialAccounts.$inferSelect;
export type InsertSocialAccount = z.infer<typeof insertSocialAccountSchema>;

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
  // Creator-controlled image for the Featured Creator card on the brand
  // marketplace. Distinct from the Google avatar (profileImageUrl) — this
  // is a logo / brand image the creator picks specifically for marketplace
  // surface-area. When null, the card falls back to first video thumbnail,
  // then gradient + initials.
  cardImageUrl: text("card_image_url"),
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
  // Scene-cut timestamps detected during scan, used to prevent placements
  // from following the camera across hard cuts. Format: array of seconds
  // marking the START of each new shot, e.g. [0, 12.5, 28, 45.2]. A surface
  // at timestamp t belongs to the block whose start <= t < next-start.
  // Computed by ffmpeg scene-detect; null until first scan completes.
  sceneBoundaries: jsonb("scene_boundaries"),
  // Scene-first index. Cuts give us shot boundaries but don't tell us which
  // shots are the SAME scene returning (e.g. podcast cuts host↔guest 10x —
  // that's 2 scenes, not 10). This field clusters shots by perceptual
  // similarity so a placement on the host's coffee table at :08 carries to
  // every other host shot. Format:
  //   { shots: [{shotIdx, sceneId, tStart, tEnd, hash}], sceneCount, cuts }
  // Computed by sceneIndex.ts after sceneBoundaries; null until scan.
  sceneIndex: jsonb("scene_index"),
  // Scene-block inventory — the rolled-up "what's in this episode" view built
  // at scan finalize. Where sceneIndex maps every shot to its recurring scene
  // class, this aggregates those classes into the sellable model: each scene
  // lists its canonical physical surfaces ONCE, with occurrence counts and
  // total screen time, instead of per-frame detection rows. Format:
  //   { version: 1, source: "sceneIndex" | "grid",
  //     scenes: [{ sceneId, label,            // "Scene A" by descending totalSec
  //                occurrences, totalSec,     // shot count / Σ shot durations
  //                surfaces: [{ groupId, surfaceType,
  //                             bbox: {x,y,w,h},          // median, 0-1
  //                             confidence, screenTimeSec, // = scene totalSec
  //                             rowCount, representativeRowId,
  //                             frameUrl }] }],
  //     generatedAt }
  // source="grid" marks streamed scans where the scene index was synthesized
  // from dense-grid frame hashes rather than shot-midpoint keyframes. Null
  // until a scan with surface grouping runs — consumers must handle null.
  sceneInventory: jsonb("scene_inventory"),
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
  // Surface orientation — drives placement type (horizontal=product, vertical=signage/poster)
  orientation: varchar("orientation"), // "horizontal" | "vertical"
  // Creator approval — surfaces are hidden from brands until the creator
  // explicitly approves them. Default false (all hidden) per the
  // creator-controlled exposure model.
  creatorApproved: boolean("creator_approved").default(false).notNull(),
  // Scene cluster ID from sceneIndex — surfaces with the same sceneId are in
  // the same physical scene (e.g. host's couch across all host-shot returns).
  // Used to propagate placements across visually-similar shots: drop a mug
  // on the coffee table at :08, it shows up at :46 too. Null for surfaces
  // detected before scene clustering shipped.
  sceneId: integer("scene_id"),
  // Canonical physical-surface identity. The scanner writes one row per
  // supporting frame of a consensus surface, so "the host's desk" spans many
  // rows — every member row shares this id so downstream can group, count,
  // and sell the desk as ONE surface instead of N frames. Two formats, both
  // stamped at insert and preserved through post-processing merges:
  // "g{videoId}-{sceneKey}-{seq}" (e.g. "g91067-2-1") for surfaces discovered
  // fresh in this scan, and "rm{modelId}-s{idx}" (e.g. "rm12-s3") for surfaces
  // confirmed against a room model — the latter is IDENTICAL across rescans
  // and episodes on purpose, so group-keyed placements survive both. Consumers
  // must treat the id as an opaque string, never parse its parts. Null for
  // rows written before grouping shipped — fall back to a (surfaceType,
  // sceneId) composite when null, never treat raw rows as distinct surfaces.
  surfaceGroupId: text("surface_group_id"),
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

// Room Models Table — persistent per-creator "set memory". sceneIndex already
// knows the host's studio keeps coming back WITHIN one video; this table
// remembers it ACROSS rescans and episodes. Each row is one recurring
// set/camera setup: sceneExemplarHashes identifies it perceptually (a scan's
// scene class matches when any of its shot dHashes lands within hamming
// distance 12 of any exemplar), and `surfaces` is the ONE authoritative
// surface list for that set — built from the cleanest frames ever seen, then
// CONFIRMED on later scans instead of re-discovered from scratch. That buys
// consistent labels/boxes within a scan, placements that survive rescans
// (via the stable "rm{modelId}-s{idx}" group id), and instant, consistent
// inventory for new episodes shot in the same room.
// `surfaces` holds a RoomModelSurface[]:
//   { idx,                       // stable per-model index — append-only,
//                                //   never reused after a deletion
//     surfaceType, orientation,  // canonical values; later scans keep these
//                                //   even when Gemini relabels the surface
//     bbox: {x,y,w,h},           // 0-1 normalized floats
//     confidence,
//     frameUrl }                 // cleanest keyframe seen so far, or null
export const roomModels = pgTable("room_models", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(), // Canonical creator (users.id); legacy email-keyed rows fold in via the usual alias handling at read time
  sceneExemplarHashes: text("scene_exemplar_hashes").array().notNull(), // Up to 8 dHashes of shot-midpoint keyframes for this set/camera setup
  surfaces: jsonb("surfaces").notNull(), // RoomModelSurface[] — see comment above
  sourceVideoId: integer("source_video_id"), // First video that built this model
  lastVideoId: integer("last_video_id"), // Most recent video that confirmed it
  episodeCount: integer("episode_count").default(1), // Distinct videos that have matched this set
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertRoomModelSchema = createInsertSchema(roomModels).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type RoomModel = typeof roomModels.$inferSelect;
export type InsertRoomModel = z.infer<typeof insertRoomModelSchema>;

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
// ── Notifications ─────────────────────────────────────────────────
// In-app notification rows. userId stores the recipient's identity key AS
// KNOWN AT EMIT TIME (users.id UUID or legacy email — the dual-ID reality);
// reads expand aliases the same way the placement inbox does.
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  type: varchar("type", { length: 40 }).notNull(), // placement_request | placement_approved | placement_rejected | placement_withdrawn | editorial_ready
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body"),
  linkPath: varchar("link_path", { length: 300 }),  // in-app route the notification opens
  metadata: jsonb("metadata").$type<Record<string, any>>(),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({ id: true, createdAt: true });
export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;

export const brandPlacementAssignments = pgTable("brand_placement_assignments", {
  id: serial("id").primaryKey(),
  brandUserId: varchar("brand_user_id").notNull(),       // Brand who requested placement
  creatorUserId: varchar("creator_user_id").notNull(),   // Creator who owns the video
  videoId: integer("video_id").notNull(),                // FK to video_index.id
  // The editorial clip this placement targets (nullable for backward-compat with
  // legacy assignments tied to source video, but new requests should always set it).
  // Brands browse rendered editorial clips and request placements on surfaces within them.
  editorialClipId: integer("editorial_clip_id"),         // FK to editorial_clips.id
  brandProductId: integer("brand_product_id"), // FK to brand_products.id; NULL = brand delegated the choice — creator picks from the brand's catalog at approval time
  surfaceId: integer("surface_id").notNull(),            // FK to detected_surfaces.id
  // Status lifecycle:
  //   pending_creator_review (default) → creator_approved | creator_rejected | brand_withdrawn | expired
  status: varchar("status", { length: 30 }).notNull().default("pending_creator_review"),
  brandMessage: text("brand_message"),                   // Optional message from brand → creator
  rejectionReason: text("rejection_reason"),             // Optional reason from creator
  reviewedAt: timestamp("reviewed_at"),                  // When creator approved/rejected
  // ── Pricing fields (cents, integer to avoid float math on money) ────────
  // Calculated at placement-request time using the CPM rubric in
  // server/lib/placementPricing.ts.
  // Charged on creator approval; refunded if creator later revokes.
  placementFeeCents: integer("placement_fee_cents").default(0),    // Total fee brand pays
  platformTakeCents: integer("platform_take_cents").default(0),    // Platform's 30% cut
  creatorPayoutCents: integer("creator_payout_cents").default(0),  // Creator's 70%
  isTestPlacement: boolean("is_test_placement").default(false),    // Admin override: zero charge
  customFeeCents: integer("custom_fee_cents"),                     // Admin override: bespoke fee
  negotiatedNote: text("negotiated_note"),                         // Audit note for custom deals
  // Pricing breakdown (jsonb for audit — full inputs and multipliers used)
  pricingBreakdown: jsonb("pricing_breakdown"),
  // Duration commitment
  durationTerm: varchar("duration_term", { length: 20 }).default("single"), // single|1-month|3-month|6-month|12-month
  durationDays: integer("duration_days").default(0),
  expiresAt: timestamp("expires_at"),                              // null = no expiry (single placement)
  // Lifecycle: pending → charged | failed (Stripe integration is a follow-up)
  chargeStatus: varchar("charge_status", { length: 20 }).default("pending"),
  chargedAt: timestamp("charged_at"),
  stripeChargeId: varchar("stripe_charge_id"),
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
  /**
   * The editorial clip this framing was authored FOR.
   *
   * A brand browses rendered clips and requests a placement on one
   * (brand_placement_assignments.editorial_clip_id), but until now the
   * creator's side of that — where the product actually sits — was keyed
   * only by (video, surface). The clip render therefore had to guess which
   * saved row it meant with a heuristic join, and the same fixture appearing
   * in three clips could carry only one framing.
   *
   * Geometry stays in SOURCE-video space regardless: the renderer composites
   * overlays on the source frame and applies the 9:16 crop afterwards, so a
   * clip-scoped placement is the same coordinate system with a narrower
   * intent. Null = a video-level placement that applies wherever the fixture
   * appears (the pre-existing behavior, unchanged).
   */
  editorialClipId: integer("editorial_clip_id"),
  productId: integer("product_id"), // Reference to brand_products.id (null if custom upload)
  productImageUrl: text("product_image_url").notNull(), // URL of product image used
  createdBy: varchar("created_by").notNull(), // Email of user who created placement
  role: varchar("role").notNull().default("creator"), // 'creator' or 'brand'
  bidId: integer("bid_id"), // Reference to monetization_items.id (null for organic placements)
  // Scene continuity: group ID links surfaces that share the same placement
  sceneGroupId: varchar("scene_group_id"), // e.g., "video-5-Desk-0.3-0.5" — surfaces with matching group share placements
  // Placement scoping — the creator's explicit answer to "where does this
  // placement apply?". Values are detected_surfaces.surfaceGroupId strings
  // (canonical physical surfaces), so a scope can deliberately include the
  // same table's surface as seen in another scene.
  //   null = legacy row (saved before scoping): heuristic group/scene/fuzzy
  //          matching applies exactly as before.
  //   []   = anchor surface only — no propagation anywhere.
  //   ["rm3-s1", ...] = exactly those canonical surfaces, nothing else.
  appliesToGroupIds: jsonb("applies_to_group_ids").$type<string[]>(),
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
  // Human-review lifecycle — the creator CHOOSES a placement; a human at
  // FullScale reviews the choice and produces the final photorealistic
  // render before anything ships. 'submitted' (default on save) →
  // 'in_review' → 'render_ready' | 'needs_changes'. Distinct from `status`
  // (active/archived), which is row liveness, not pipeline position.
  reviewStatus: varchar("review_status", { length: 20 }).notNull().default("submitted"),
  reviewNote: text("review_note"), // ops note back to the creator (esp. needs_changes)
  reviewedAt: timestamp("reviewed_at"),
  // Harmonization persistence — per-placement opt-in. When isHarmonized=true,
  // brand-side previews + render pipeline use harmonizedImageUrl instead of
  // the flat product overlay. URL points at fal.ai's CDN (or a future GCS
  // copy if we move to durable storage). null when creator opted out via
  // the Harmonized/Flat toggle in the placement modal.
  harmonizedImageUrl: text("harmonized_image_url"),
  isHarmonized: boolean("is_harmonized").default(false).notNull(),
  // Frame-by-frame keyframes for fine-grained placement editing. When
  // empty / null the placement uses the base `transform` constant. When
  // populated, the render pipeline lerps between adjacent keyframes by
  // playback time. Each keyframe captures a full transform snapshot at
  // a specific timestamp (seconds) so the creator can pin the product to
  // exact frames where motion tracking drifts.
  // Format: [{ t: 12.5, transform: {offsetX, offsetY, scale, rotation, flipH} }]
  keyframes: jsonb("keyframes").$type<Array<{
    t: number;
    transform: {
      offsetX: number;
      offsetY: number;
      scale: number;
      rotation: number;
      flipH: boolean;
    };
  }>>(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_saved_placements_clip").on(table.editorialClipId),
]);

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
  // A1 release pages: links a brand placement's FINAL approved render.
  // Minted at brand_approved; the public page plays the baked clip with
  // creator/brand credits and a download. One link per placement.
  brandPlacementId: integer("brand_placement_id"), // Reference to brand_placement_assignments.id (optional)
  videoId: integer("video_id").notNull(), // Reference to video_index.id
  createdBy: varchar("created_by").notNull(), // Email of user who created the share link
  title: text("title"), // Optional custom title for the shared content
  viewCount: integer("view_count").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true), // Can be deactivated
  expiresAt: timestamp("expires_at"), // Optional expiration date
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  // One release link per placement — makes the lazy mint race-safe (the
  // loser of a concurrent mint re-reads the winner instead of duplicating).
  uniqueBrandPlacement: uniqueIndex("idx_shared_links_brand_placement")
    .on(table.brandPlacementId)
    .where(sql`brand_placement_id IS NOT NULL`),
}));

// ── Meta compliance + analytics history ────────────────────────────────────

// Meta App Review requires a Data Deletion Request callback: when a user
// removes the app on Facebook/Instagram, Meta POSTs a signed request and we
// must delete their data and expose a human-readable status page.
export const dataDeletionRequests = pgTable("data_deletion_requests", {
  id: serial("id").primaryKey(),
  platform: varchar("platform", { length: 20 }).notNull(),         // 'meta'
  platformUserId: varchar("platform_user_id").notNull(),           // app-scoped FB user id from the signed request
  confirmationCode: varchar("confirmation_code").notNull().unique(),
  status: varchar("status", { length: 20 }).notNull().default("completed"), // completed | partial | failed
  details: jsonb("details"),                                       // what was deleted (tables + row counts)
  createdAt: timestamp("created_at").defaultNow(),
});
export type DataDeletionRequest = typeof dataDeletionRequests.$inferSelect;
export const insertDataDeletionRequestSchema = createInsertSchema(dataDeletionRequests).omit({ id: true, createdAt: true });
export type InsertDataDeletionRequest = z.infer<typeof insertDataDeletionRequestSchema>;

// Meta retains account-level IG insights only ~90 days (stories 24h) — this
// table is FullScale's own longitudinal record, appended by the snapshot job.
//
// Now ALL-PLATFORM. YouTube and Twitch expose channel stats that are current
// values with no history behind them, and the app used to overwrite its copy
// on every refresh — so "how did this channel grow around the campaign" was
// answerable for Meta and unanswerable for YouTube. Same table, same 12h
// cadence, so the analysis layer never branches on platform to get a series.
export const socialInsightSnapshots = pgTable("social_insight_snapshots", {
  id: serial("id").primaryKey(),
  socialAccountId: uuid("social_account_id"),                      // FK to social_accounts.id (nullable: YouTube/Twitch have no social_accounts row)
  userId: varchar("user_id").notNull(),
  platform: varchar("platform", { length: 20 }).notNull(),         // 'instagram' | 'facebook' | 'youtube' | 'twitch'
  platformAccountId: varchar("platform_account_id").notNull(),     // IG business id | FB page id | YT channel id | Twitch broadcaster id
  followers: integer("followers"),
  metrics: jsonb("metrics"),                                       // account-level insight values for the window
  demographics: jsonb("demographics"),                             // follower/engaged-audience breakdowns
  stories: jsonb("stories"),                                       // live-story insights captured this cycle (24h window)
  capturedAt: timestamp("captured_at").defaultNow(),
}, (table) => ({
  accountTimeIdx: index("idx_insight_snapshots_account_time").on(table.platformAccountId, table.capturedAt),
  // The analytics endpoints filter by social_account_id + sort by captured_at
  socialAcctTimeIdx: index("idx_insight_snapshots_socialacct_time").on(table.socialAccountId, table.capturedAt),
}));
export type SocialInsightSnapshot = typeof socialInsightSnapshots.$inferSelect;
export const insertSocialInsightSnapshotSchema = createInsertSchema(socialInsightSnapshots).omit({ id: true, capturedAt: true });
export type InsertSocialInsightSnapshot = z.infer<typeof insertSocialInsightSnapshotSchema>;

/**
 * PER-POST history for platform-native content — the mirror of
 * video_stat_snapshots for posts that do not live in our library.
 *
 * The gap this closes is the exact inverse of the one above. For Meta we had
 * account history but read per-media insights ON DEMAND and threw them away,
 * so a Reel's trajectory was only ever "as of the moment someone opened the
 * analytics page". For YouTube the reverse was true. Neither half of a
 * pilot readout works without both.
 *
 * Grain: ONE ROW PER (post, capture). Deltas are the analysis unit —
 * views_at_t2 − views_at_t1 — because every counter here is a lifetime
 * cumulative total, not a per-window value.
 *
 * Separate from video_stat_snapshots on purpose: that table's video_id is a
 * NOT NULL FK into video_index, and an Instagram Reel we never ingested has
 * no row there. Inventing placeholder library rows to satisfy a foreign key
 * would corrupt every count that reads video_index.
 */
export const socialPostSnapshots = pgTable("social_post_snapshots", {
  id: serial("id").primaryKey(),
  socialAccountId: uuid("social_account_id"),                      // FK to social_accounts.id (nullable: account may be disconnected later)
  userId: varchar("user_id").notNull(),
  platform: varchar("platform", { length: 20 }).notNull(),         // 'instagram' | 'facebook'
  platformAccountId: varchar("platform_account_id").notNull(),
  /** Platform-native post id (IG media id, FB post id). */
  platformPostId: varchar("platform_post_id", { length: 128 }).notNull(),
  mediaType: varchar("media_type", { length: 32 }),                // IMAGE | VIDEO | REELS | CAROUSEL_ALBUM | STATUS …
  permalink: text("permalink"),
  /** The post's own publish time — fixed, unlike captured_at. Needed to age
   *  a post so a 3-day-old Reel isn't compared against a 3-month-old one. */
  postedAt: timestamp("posted_at"),
  /** Lifetime cumulative counters as of capture. Null = the platform did not
   *  return it (missing scope / unsupported for this media type), which is
   *  NOT the same as zero and must not be modeled as zero. */
  views: bigint("views", { mode: "number" }),
  reach: bigint("reach", { mode: "number" }),
  likeCount: integer("like_count"),
  commentCount: integer("comment_count"),
  savedCount: integer("saved_count"),
  shareCount: integer("share_count"),
  totalInteractions: integer("total_interactions"),
  /** Reels only — the closest Meta analogue to a YouTube retention curve.
   *  Meta gives two scalars, not a curve, so per-second placement alignment
   *  is impossible on Meta by design of their API, not by our omission. */
  avgWatchTimeMs: integer("avg_watch_time_ms"),
  totalWatchTimeMs: bigint("total_watch_time_ms", { mode: "number" }),
  raw: jsonb("raw"),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
}, (table) => [
  index("idx_social_post_snap_post_time").on(table.platformPostId, table.capturedAt),
  index("idx_social_post_snap_user_time").on(table.userId, table.capturedAt),
  index("idx_social_post_snap_acct_time").on(table.socialAccountId, table.capturedAt),
]);
export type SocialPostSnapshot = typeof socialPostSnapshots.$inferSelect;
export type InsertSocialPostSnapshot = typeof socialPostSnapshots.$inferInsert;

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
  // Assembled-narrative beats (hook→body→payoff) in NARRATIVE order; null for
  // single-range clips. Times are source-video seconds; duration = sum of beats.
  segments: jsonb('segments').$type<Array<{ start: number; end: number; role?: string }>>(),
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
  // Post-render quality rubric score (0-1) — REAL column (a prior commit
  // wrote this key without the column existing; drizzle silently dropped it)
  qualityScore: real('quality_score'),
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

// ============================================================================
// MEASUREMENT SPINE — CV-impact research instrumentation (Phase 1)
//
// The research design: FIXTURE (a stable physical surface, identified by
// surface_group_id — the same desk across rescans AND episodes) is the
// experimental unit; PRODUCT is the treatment; SCREEN TIME is the exposure
// dose; the audience response is the outcome. These three tables make that
// design queryable in SQL instead of buried in jsonb.
//
// See docs/DATA_DICTIONARY.md §1 for the full frame.
// ============================================================================

/**
 * Per-fixture exposure supply, materialized at scan finalize.
 *
 * The numbers already exist inside video_index.scene_inventory (jsonb) — this
 * table lifts them into relational form so a fixture's cumulative screen time
 * across every episode is one GROUP BY instead of a jsonb walk. This is the
 * DENOMINATOR of every effect estimate.
 *
 * SEMANTICS a researcher must know:
 *  - APPEND-ONLY / SCAN-VERSIONED. A rescan SUPERSEDES prior rows rather than
 *    deleting them: the old row gets superseded_at, the new row is current
 *    (superseded_at IS NULL). Dose-as-of-a-past-treatment-window is therefore
 *    reconstructible — the exposure row valid at time T is the one where
 *    scan_at <= T AND (superseded_at IS NULL OR superseded_at > T).
 *  - Writes are gated on scan quality: a degraded scan (mostly edge-detection
 *    fallback) leaves prior rows untouched rather than overwriting good data
 *    with fallback geometry.
 *  - MISSINGNESS IS NON-RANDOM: videos with a degenerate scene index produce
 *    no rows at all, and pre-instrumentation scans were never backfilled.
 */
export const fixtureExposure = pgTable("fixture_exposure", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),          // creator who owns the content
  videoId: integer("video_id").notNull(),        // video_index.id
  surfaceGroupId: varchar("surface_group_id", { length: 64 }).notNull(), // FIXTURE identity
  sceneId: integer("scene_id").notNull(),        // scene class within the video
  sceneLabel: varchar("scene_label", { length: 32 }),   // "Scene A"
  displayLabel: varchar("display_label", { length: 64 }), // "Wall 2", "Nightstand 1"
  surfaceType: varchar("surface_type", { length: 64 }).notNull(),
  /** Model-backed fixtures (rm{modelId}-s{idx}) persist across episodes;
   *  fresh g-ids are video-local. Analysts should filter on this for
   *  cross-episode work. */
  isModelBacked: boolean("is_model_backed").notNull().default(false),
  /** Seconds the fixture's SCENE CLASS is on screen in this video.
   *  ⚠️ GRAIN WARNING: this is a SCENE-level quantity replicated onto every
   *  fixture in that scene (the set-dressing model: a surface is on screen
   *  whenever its camera setup is). SUMMING THIS ACROSS FIXTURES WITHIN A
   *  VIDEO DOUBLE-COUNTS — a 10-min single-scene video with 5 fixtures sums
   *  to 50 min. For total exposure supply, sum over DISTINCT
   *  (video_id, scene_id). Per-fixture comparisons are valid as-is. */
  sceneScreenTimeSec: numeric("scene_screen_time_sec").notNull(),
  /** Distinct runs of the scene class (how many times the setup recurs). */
  occurrences: integer("occurrences").notNull().default(0),
  /** Detection rows backing this fixture in this scan — a data-quality signal. */
  rowCount: integer("row_count").notNull().default(0),
  confidence: numeric("confidence"),
  /** Video duration at scan time, so screen-time share is computable without a join. */
  videoDurationSec: numeric("video_duration_sec"),
  /** When this measurement was taken. With superseded_at, this bounds the
   *  validity interval of the row — the basis for as-of-window dose. */
  scanAt: timestamp("scan_at").defaultNow().notNull(),
  /** Null = the CURRENT measurement for this (video, fixture). Set when a
   *  later scan replaced it. Never delete: a treatment window that closed
   *  last month must still resolve the dose that applied while it was open. */
  supersededAt: timestamp("superseded_at"),
  /** Monotonic per (video, fixture) — 1 is the first observation. Cheap way
   *  to order revisions without relying on timestamp ties. */
  scanVersion: integer("scan_version").notNull().default(1),
}, (table) => [
  index("idx_fixture_exposure_group").on(table.surfaceGroupId),
  index("idx_fixture_exposure_video").on(table.videoId),
  // As-of queries scan by fixture over the validity interval.
  index("idx_fixture_exposure_asof").on(table.surfaceGroupId, table.scanAt),
  // Exactly one CURRENT row per (video, fixture); history rows carry a
  // superseded_at so they fall outside this partial index.
  uniqueIndex("uq_fixture_exposure_current")
    .on(table.videoId, table.surfaceGroupId)
    .where(sql`superseded_at IS NULL`),
]);

/**
 * Treatment assignment periods: which product occupied which fixture, when.
 *
 * A within-fixture crossover design needs the on-air window per treatment —
 * AND the untreated periods to compare against. Control periods are stored
 * as EXPLICIT ROWS (brand_product_id IS NULL, is_control = true), not
 * inferred from gaps: a row you can join is worth more than an absence you
 * have to reconstruct, and it makes "was this fixture observed-but-untreated
 * or simply unobserved?" answerable.
 *
 * A control row opens when a fixture is first observed by instrumentation and
 * whenever a treatment window closes; it closes when the next treatment opens.
 * observed_from on the first control row marks when measurement began, so
 * pre-instrumentation time is UNOBSERVED rather than silently read as control.
 * Exclusivity is enforced per (fixture × video), not globally: the same
 * physical fixture legitimately carries different products in different
 * episodes at the same wall-clock time.
 */
export const fixtureAssignments = pgTable("fixture_assignments", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  surfaceGroupId: varchar("surface_group_id", { length: 64 }).notNull(), // FIXTURE
  videoId: integer("video_id").notNull(),
  /** TREATMENT: the product occupying the fixture. Null + is_control = the
   *  explicit control period (observed, untreated). */
  brandProductId: integer("brand_product_id"),
  /** True for materialized control periods. Distinguishes "observed with no
   *  product" from a malformed treatment row with a missing product id. */
  isControl: boolean("is_control").notNull().default(false),
  productName: varchar("product_name", { length: 200 }),
  brandUserId: varchar("brand_user_id"),
  /** Source rows so an analyst can trace back to the raw lifecycle. */
  placementId: integer("placement_id"),        // saved_placements.id
  assignmentId: integer("assignment_id"),      // brand_placement_assignments.id
  /** Window in DEAL TIME (approval → archive), not audience time: a product
   *  is "assigned" from approval even though the audience only sees it once
   *  the creator posts. For audience-time windows join placement_exposures
   *  on assignment_id and use its live_at. endedAt null = still assigned. */
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  endReason: varchar("end_reason", { length: 32 }), // 'archived' | 'expired' | 'replaced' | 'withdrawn' | 'render_failed' | 'treatment_started'
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_fixture_assign_group").on(table.surfaceGroupId),
  index("idx_fixture_assign_window").on(table.startedAt),
]);

/**
 * Exposure events: a placement that actually reached an audience.
 *
 * THE blocking gap — without a row here, no audience metric can be attributed
 * to a treatment. One row per (placement, published post). Populated when a
 * creator marks a render live, or when the auto-matcher links a new upload on
 * their synced channel to a render-ready placement and the creator confirms.
 */
export const placementExposures = pgTable("placement_exposures", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  /** What was shown. */
  placementId: integer("placement_id"),          // saved_placements.id
  assignmentId: integer("assignment_id"),        // brand_placement_assignments.id
  surfaceGroupId: varchar("surface_group_id", { length: 64 }), // FIXTURE
  brandProductId: integer("brand_product_id"),   // TREATMENT
  sourceVideoId: integer("source_video_id").notNull(), // video_index.id the placement lives on
  /** Where it ran. */
  platform: varchar("platform", { length: 32 }).notNull(), // youtube | instagram | tiktok | twitter | facebook | other
  postUrl: text("post_url"),
  /** Platform-native id once resolved — this is what the analytics fetchers poll. */
  platformPostId: varchar("platform_post_id", { length: 128 }),
  /** When the audience could see it. */
  liveAt: timestamp("live_at").notNull(),
  endedAt: timestamp("ended_at"),
  /** Position of the placement in SOURCE-VIDEO coordinates (seconds from the
   *  start of the original upload), taken from the anchor surface timestamp.
   *  ⚠️ NOT post-relative. Published assets are frequently trimmed clips, so
   *  Phase 2 retention joins MUST map this into post coordinates using the
   *  clip's start offset (see editorialClipId below) before aligning to a
   *  retention curve. Named for what it is so nothing silently misaligns. */
  sourceStartSec: numeric("source_start_sec"),
  sourceEndSec: numeric("source_end_sec"),
  /** The editorial clip this exposure ran as, when the published asset was a
   *  clip rather than the full upload. Null = full-video post (source
   *  coordinates ARE post coordinates). Phase 2 needs this to align. */
  editorialClipId: integer("editorial_clip_id"),
  clipStartSec: numeric("clip_start_sec"),
  /** How this record came to exist — auto-matched links need lower analytic
   *  trust than creator-confirmed ones. */
  linkSource: varchar("link_source", { length: 24 }).notNull().default("creator_confirmed"), // creator_confirmed | auto_matched | admin
  confirmedAt: timestamp("confirmed_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_placement_exposure_group").on(table.surfaceGroupId),
  index("idx_placement_exposure_live").on(table.liveAt),
  index("idx_placement_exposure_post").on(table.platform, table.platformPostId),
  // One exposure per placement — the check-then-insert guard alone loses a
  // double-submit race and would double-count an audience.
  uniqueIndex("uq_placement_exposure_placement").on(table.placementId),
]);

/**
 * Per-video audience time series — the OUTCOME side of the design.
 *
 * video_index.view_count is overwritten on every refresh, so it can only ever
 * answer "how many views now". Causal comparison needs trajectories: view
 * velocity before and after a placement went live, and the counterfactual
 * slope during control periods. This table APPENDS, never overwrites.
 *
 * Captured for videos that matter to the study (any video carrying a fixture
 * with a treatment or exposure) plus, cheaply, the rest of a connected
 * channel in the same batch call.
 */
export const videoStatSnapshots = pgTable("video_stat_snapshots", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull(),          // video_index.id
  userId: varchar("user_id").notNull(),
  platform: varchar("platform", { length: 32 }).notNull(),
  /** Platform-native id polled (youtube video id, IG media id, …). */
  platformPostId: varchar("platform_post_id", { length: 128 }),
  viewCount: bigint("view_count", { mode: "number" }),
  likeCount: integer("like_count"),
  commentCount: integer("comment_count"),
  /** Raw payload for metrics we don't model yet — cheap future-proofing. */
  raw: jsonb("raw"),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
}, (table) => [
  // The dominant query: one video's series over time.
  index("idx_video_stat_video_time").on(table.videoId, table.capturedAt),
  index("idx_video_stat_user_time").on(table.userId, table.capturedAt),
]);

/**
 * Audience retention curves — the measurement that answers the actual
 * research question: do viewers LINGER or DROP at the seconds a placed
 * product is on screen?
 *
 * YouTube Analytics returns retention as a normalized curve: for each
 * elapsed-time ratio (0.0 → 1.0 of the video), what fraction of viewers were
 * still watching (audienceWatchRatio), and how that compares to similar
 * videos (relativeRetentionPerformance). Stored as a whole curve per video
 * per capture so it can be joined against placement timestamps.
 *
 * JOINING TO A PLACEMENT (the part that is easy to get wrong):
 *   placement_exposures.source_start_sec is in SOURCE-video coordinates. If
 *   the published post was a trimmed clip, subtract clip_start_sec first.
 *   Then position_ratio = post_relative_seconds / video_duration_sec, and
 *   look up the curve bucket at that ratio.
 */
export const videoRetentionCurves = pgTable("video_retention_curves", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull(),        // video_index.id
  userId: varchar("user_id").notNull(),
  platform: varchar("platform", { length: 32 }).notNull().default("youtube"),
  platformPostId: varchar("platform_post_id", { length: 128 }),
  /** Duration the curve is normalized against — needed to convert a ratio
   *  back into seconds (and therefore to align a placement). */
  videoDurationSec: numeric("video_duration_sec"),
  /** The curve itself: [{ ratio, watchRatio, relativePerformance }] ordered
   *  by ratio. YouTube typically returns ~100 buckets. */
  curve: jsonb("curve").$type<Array<{
    ratio: number;
    watchRatio: number;
    relativePerformance?: number | null;
  }>>(),
  /** Reporting window the curve covers. */
  startDate: varchar("start_date", { length: 10 }),
  endDate: varchar("end_date", { length: 10 }),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
}, (table) => [
  index("idx_retention_video_time").on(table.videoId, table.capturedAt),
]);

/**
 * Per-CONTENT viewer demographics (as opposed to channel-level).
 *
 * Comparing product A against product B on the same fixture is confounded if
 * the two videos reached different audiences. These are the covariates that
 * make the comparison honest.
 */
export const videoDemographics = pgTable("video_demographics", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull(),
  userId: varchar("user_id").notNull(),
  platform: varchar("platform", { length: 32 }).notNull().default("youtube"),
  platformPostId: varchar("platform_post_id", { length: 128 }),
  /** ageGroup → share, gender → share; each normalized to sum ~1.0. */
  ageDistribution: jsonb("age_distribution"),
  genderDistribution: jsonb("gender_distribution"),
  /** Raw ageGroup × gender cells, for analysts who want the joint. */
  raw: jsonb("raw"),
  startDate: varchar("start_date", { length: 10 }),
  endDate: varchar("end_date", { length: 10 }),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
}, (table) => [
  index("idx_video_demo_video_time").on(table.videoId, table.capturedAt),
]);

/**
 * CREATOR EVENT LOG — the missing primitive.
 *
 * Everything else in this app records creator decisions as STATE: a surface
 * approval is a boolean, a rejection overwrites a type column, a teach is a
 * flag inside a jsonb array. State answers "what is true now" and cannot
 * answer "what did this creator do, when, and how did that change" — which
 * is exactly the creator-behavior question. This table is append-only and
 * never updated; it is the only place a decision's TIME and ACTOR are kept.
 *
 * Retroactive backfill is impossible for most of these (the timestamps were
 * never written), so coverage starts the day this ships.
 */
export const creatorEvents = pgTable("creator_events", {
  id: serial("id").primaryKey(),
  /** The creator whose behavior this describes — the CONTENT owner, always. */
  creatorUserId: varchar("creator_user_id").notNull(),
  /** Who actually performed it. Differs from creatorUserId when an admin
   *  acts on a creator's behalf — without this, ops activity is silently
   *  recorded as creator engagement (an existing bug in the teach path). */
  actorUserId: varchar("actor_user_id"),
  actorRole: varchar("actor_role", { length: 16 }).notNull().default("creator"), // creator | admin | brand | system
  /** What happened. Kept as a plain varchar rather than a pg enum so a new
   *  event type never needs a migration. */
  eventType: varchar("event_type", { length: 48 }).notNull(),
  // surface_approved | surface_rejected | surface_unapproved | surface_taught
  // placement_created | placement_archived | placement_went_live
  // brand_request_approved | brand_request_rejected
  // video_imported | video_trashed | scan_started
  /** What it happened to — sparse by design; only the relevant ids are set. */
  videoId: integer("video_id"),
  surfaceId: integer("surface_id"),
  surfaceGroupId: varchar("surface_group_id", { length: 64 }),
  placementId: integer("placement_id"),
  assignmentId: integer("assignment_id"),
  brandProductId: integer("brand_product_id"),
  /** Free-form context: rejection reasons, surface types, bulk-action flags.
   *  `bulk: true` matters — an "approve all" click is one decision, not N. */
  metadata: jsonb("metadata"),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
}, (table) => [
  index("idx_creator_events_creator_time").on(table.creatorUserId, table.occurredAt),
  index("idx_creator_events_type_time").on(table.eventType, table.occurredAt),
]);

/**
 * Per-day audience metrics per video, from YouTube Analytics.
 *
 * Unlike the 6-hourly counter snapshots (which only start accumulating when
 * we begin polling), this report is RETROACTIVE to publish date — so a
 * before/after comparison around a placement's go-live is computable on day
 * one rather than after weeks of waiting.
 */
export const videoDailyMetrics = pgTable("video_daily_metrics", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull(),
  userId: varchar("user_id").notNull(),
  platform: varchar("platform", { length: 32 }).notNull().default("youtube"),
  platformPostId: varchar("platform_post_id", { length: 128 }),
  /** The calendar day these metrics describe (platform timezone). */
  day: varchar("day", { length: 10 }).notNull(),
  views: integer("views"),
  likes: integer("likes"),
  comments: integer("comments"),
  shares: integer("shares"),
  estimatedMinutesWatched: numeric("estimated_minutes_watched"),
  averageViewDuration: numeric("average_view_duration"),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_video_daily").on(table.videoId, table.day),
  index("idx_video_daily_day").on(table.day),
]);

/**
 * Audience comments on content carrying a placement, with classification.
 *
 * The qualitative half of "what are the responses" — what viewers actually
 * SAY when a brand appears, as opposed to how many of them watched.
 * YouTube-only today (its comment read needs no scope beyond the granted
 * youtube.readonly); Instagram/Facebook need an App Review permission,
 * TikTok exposes no comment list to this integration, and Twitch has none.
 */
export const contentComments = pgTable("content_comments", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id").notNull(),
  userId: varchar("user_id").notNull(),
  platform: varchar("platform", { length: 32 }).notNull().default("youtube"),
  platformCommentId: varchar("platform_comment_id", { length: 128 }).notNull(),
  authorDisplayName: varchar("author_display_name", { length: 200 }),
  text: text("text").notNull(),
  likeCount: integer("like_count"),
  publishedAt: timestamp("published_at"),
  /** Classification — null until the classifier runs. */
  sentiment: varchar("sentiment", { length: 16 }),        // positive | neutral | negative | mixed
  /** Does the comment reference the placed product / brand at all? This is
   *  the signal that separates "audience reacted to the integration" from
   *  "audience reacted to the video". */
  mentionsBrand: boolean("mentions_brand"),
  /** Was the comment posted after the placement went live? Set at capture
   *  so the pre/post split survives later re-classification. */
  afterPlacementLive: boolean("after_placement_live"),
  classifiedAt: timestamp("classified_at"),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_content_comment").on(table.platform, table.platformCommentId),
  index("idx_content_comments_video").on(table.videoId, table.publishedAt),
]);

/**
 * DELIVERED RENDERS — the finished asset coming back to the creator.
 *
 * The creator chooses WHERE a product lives; the FullScale team produces the
 * final photorealistic render out-of-band. Until now `reviewStatus =
 * render_ready` was a status flag with no file behind it, so the finished
 * work had nowhere to land and no way to reach the creator. This is that
 * repository: one placement can ship several renders — different aspect
 * ratios for different platforms, and revisions of each.
 *
 * The creator downloads from here, publishes natively, and marks it live —
 * which is what closes the measurement loop.
 */
export const placementRenders = pgTable("placement_renders", {
  id: serial("id").primaryKey(),
  /** What was rendered. */
  placementId: integer("placement_id").notNull(),
  videoId: integer("video_id").notNull(),
  /** The creator this is FOR — the content owner, not whoever uploaded it. */
  creatorUserId: varchar("creator_user_id").notNull(),
  brandProductId: integer("brand_product_id"),
  surfaceGroupId: varchar("surface_group_id", { length: 64 }),
  /** Cut variant, so one placement can ship for several destinations.
   *  e.g. "16:9" (YouTube), "9:16" (Shorts/TikTok/Reels), "1:1". */
  aspectRatio: varchar("aspect_ratio", { length: 16 }).notNull().default("16:9"),
  /** Revision number within (placement, aspectRatio) — a re-render after
   *  creator feedback supersedes rather than overwrites, so the history of
   *  what was delivered stays intact. */
  version: integer("version").notNull().default(1),
  supersededAt: timestamp("superseded_at"),
  /** The asset. storagePath is the object key; downloads are served through
   *  an ownership-gated route, never a public URL. */
  storagePath: text("storage_path").notNull(),
  fileName: varchar("file_name", { length: 255 }),
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
  durationSec: numeric("duration_sec"),
  thumbnailPath: text("thumbnail_path"),
  /** A note from the team to the creator — "muted the original audio bed",
   *  "product reads better at 0:42, moved it". */
  deliveryNote: text("delivery_note"),
  /** Who delivered it (a FullScale operator) and when. */
  deliveredByUserId: varchar("delivered_by_user_id"),
  deliveredAt: timestamp("delivered_at").defaultNow().notNull(),
  /** Creator-side state: they downloaded it / they published it. Publishing
   *  is recorded on placement_exposures; this is just the repository view. */
  downloadedAt: timestamp("downloaded_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_placement_renders_creator").on(table.creatorUserId, table.deliveredAt),
  index("idx_placement_renders_placement").on(table.placementId),
  uniqueIndex("uq_placement_render_variant").on(table.placementId, table.aspectRatio, table.version),
]);

/**
 * ATTRIBUTION LINKS — the only honest way to measure traffic from a placement.
 *
 * A product placement is not clickable; it is pixels in a frame. The click,
 * if there is one, happens on a link the CREATOR posts alongside the video —
 * in the description, a pinned comment, or their bio. This table mints that
 * link per placement so a click is attributable to a specific product on a
 * specific fixture, from a real viewer rather than from a brand reviewing
 * their own campaign page.
 */
export const placementLinks = pgTable("placement_links", {
  id: serial("id").primaryKey(),
  placementId: integer("placement_id").notNull(),
  videoId: integer("video_id").notNull(),
  creatorUserId: varchar("creator_user_id").notNull(),
  brandProductId: integer("brand_product_id"),
  surfaceGroupId: varchar("surface_group_id", { length: 64 }),
  /** Short public slug: /go/<slug>. */
  slug: varchar("slug", { length: 32 }).notNull(),
  /** Where the viewer lands — the brand's product/campaign page. */
  destinationUrl: text("destination_url").notNull(),
  /** UTM params appended on redirect so the brand ALSO sees the traffic in
   *  their own analytics. Two independent records of the same clicks is
   *  what makes the number credible to a brand. */
  utmSource: varchar("utm_source", { length: 64 }).default("fullscale"),
  utmMedium: varchar("utm_medium", { length: 64 }).default("placement"),
  utmCampaign: varchar("utm_campaign", { length: 128 }),
  /** Optional shared secret for this brand's conversion postbacks. Null
   *  until the brand opts in to server-to-server conversion reporting. */
  conversionSecret: varchar("conversion_secret", { length: 64 }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  uniqueIndex("uq_placement_link_slug").on(table.slug),
  index("idx_placement_link_placement").on(table.placementId),
]);

/**
 * Click events on an attribution link.
 *
 * PRIVACY BY DESIGN: no IP address, no cookie, no device id, no user agent
 * string is stored — only a coarse referrer host, a coarse device class,
 * and a country when the CDN supplies one. That keeps the dataset useful
 * for aggregate attribution while staying out of personal-data territory,
 * which matters because this data sits alongside a licensing conversation.
 */
export const linkClicks = pgTable("link_clicks", {
  id: serial("id").primaryKey(),
  linkId: integer("link_id").notNull(),
  placementId: integer("placement_id").notNull(),
  /** Host only ("youtube.com"), never the full referring URL. */
  referrerHost: varchar("referrer_host", { length: 128 }),
  deviceClass: varchar("device_class", { length: 16 }), // mobile | desktop | tablet | unknown
  country: varchar("country", { length: 8 }),
  clickedAt: timestamp("clicked_at").defaultNow().notNull(),
}, (table) => [
  index("idx_link_clicks_link_time").on(table.linkId, table.clickedAt),
  index("idx_link_clicks_placement").on(table.placementId),
]);

/**
 * Conversions reported by the BRAND (server-to-server postback).
 *
 * We cannot observe a purchase on someone else's storefront, so this is the
 * receiving end of a brand integration: when an order completes, the brand
 * POSTs to /api/conversions/:slug with their shared secret. Built now so
 * that a brand agreeing to integrate is a configuration step rather than a
 * project. Zero rows until a brand opts in — and an empty table here means
 * "no brand is reporting", never "no conversions happened".
 */
export const placementConversions = pgTable("placement_conversions", {
  id: serial("id").primaryKey(),
  linkId: integer("link_id").notNull(),
  placementId: integer("placement_id").notNull(),
  /** Brand's own order/event reference — deduplicates replays. */
  externalRef: varchar("external_ref", { length: 128 }),
  eventType: varchar("event_type", { length: 32 }).notNull().default("purchase"), // purchase | signup | add_to_cart | lead
  valueCents: integer("value_cents"),
  currency: varchar("currency", { length: 8 }),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_conversion_ref").on(table.linkId, table.externalRef),
  index("idx_conversions_placement").on(table.placementId),
]);

export type PlacementLink = typeof placementLinks.$inferSelect;
export type InsertPlacementLink = typeof placementLinks.$inferInsert;
export type LinkClick = typeof linkClicks.$inferSelect;
export type PlacementConversion = typeof placementConversions.$inferSelect;

export type PlacementRender = typeof placementRenders.$inferSelect;
export type InsertPlacementRender = typeof placementRenders.$inferInsert;

export type CreatorEvent = typeof creatorEvents.$inferSelect;
export type InsertCreatorEvent = typeof creatorEvents.$inferInsert;
export type VideoDailyMetric = typeof videoDailyMetrics.$inferSelect;
export type InsertVideoDailyMetric = typeof videoDailyMetrics.$inferInsert;
export type ContentComment = typeof contentComments.$inferSelect;
export type InsertContentComment = typeof contentComments.$inferInsert;

export type VideoRetentionCurve = typeof videoRetentionCurves.$inferSelect;
export type InsertVideoRetentionCurve = typeof videoRetentionCurves.$inferInsert;
export type VideoDemographics = typeof videoDemographics.$inferSelect;
export type InsertVideoDemographics = typeof videoDemographics.$inferInsert;

export type VideoStatSnapshot = typeof videoStatSnapshots.$inferSelect;
export type InsertVideoStatSnapshot = typeof videoStatSnapshots.$inferInsert;

export type FixtureExposure = typeof fixtureExposure.$inferSelect;
export type InsertFixtureExposure = typeof fixtureExposure.$inferInsert;
export type FixtureAssignment = typeof fixtureAssignments.$inferSelect;
export type InsertFixtureAssignment = typeof fixtureAssignments.$inferInsert;
export type PlacementExposure = typeof placementExposures.$inferSelect;
export type InsertPlacementExposure = typeof placementExposures.$inferInsert;
