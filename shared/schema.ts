import { pgTable, text, serial, timestamp, boolean, varchar, integer, numeric, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Import Auth Definitions
export * from "./models/auth";

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
  addedAt: timestamp("added_at").defaultNow(),
});

export const insertAllowedUserSchema = createInsertSchema(allowedUsers).omit({
  id: true,
  addedAt: true,
});

export type AllowedUser = typeof allowedUsers.$inferSelect;
export type InsertAllowedUser = z.infer<typeof insertAllowedUserSchema>;

// Monetization Items Table
export const monetizationItems = pgTable("monetization_items", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  date: timestamp("date").defaultNow(),
  status: text("status").notNull(), // e.g., 'Monetized', 'Pending', 'Rejected'
});

export const insertMonetizationItemSchema = createInsertSchema(monetizationItems).omit({ 
  id: true,
  date: true 
});

export type MonetizationItem = typeof monetizationItems.$inferSelect;
export type InsertMonetizationItem = z.infer<typeof insertMonetizationItemSchema>;

// Video Index Table - stores indexed high-value videos from YouTube
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
