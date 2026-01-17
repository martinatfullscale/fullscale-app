import { pgTable, text, serial, timestamp, boolean, varchar, integer, numeric, uniqueIndex } from "drizzle-orm/pg-core";
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
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertDetectedSurfaceSchema = createInsertSchema(detectedSurfaces).omit({
  id: true,
  createdAt: true,
});

export type DetectedSurface = typeof detectedSurfaces.$inferSelect;
export type InsertDetectedSurface = z.infer<typeof insertDetectedSurfaceSchema>;
