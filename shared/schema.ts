import { pgTable, text, serial, timestamp, boolean, varchar, integer, numeric, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Import Auth Definitions
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
  status: text("status").notNull(), // 'pending', 'accepted', 'rejected', 'expired'
  videoId: integer("video_id"), // Reference to video_index.id
  creatorUserId: varchar("creator_user_id"), // Creator who owns the video
  brandEmail: varchar("brand_email"), // Brand who placed the bid
  brandName: varchar("brand_name"), // Brand company name
  bidAmount: numeric("bid_amount"), // Bid amount in dollars
  sceneType: varchar("scene_type"), // e.g., 'Desk', 'Wall', 'Product'
  genre: varchar("genre"), // e.g., 'Tech', 'Lifestyle', 'Gaming'
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
