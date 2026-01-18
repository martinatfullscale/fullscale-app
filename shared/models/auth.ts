import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

// Session storage table.
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)]
);

// User storage table.
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  password: varchar("password"), // Hashed password for email/password auth
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  isApproved: boolean("is_approved").default(false), // Waitlist by default, admin approves
  authProvider: varchar("auth_provider").default("email"), // 'email' or 'google'
  // Multi-platform OAuth IDs
  twitchId: varchar("twitch_id"),
  facebookId: varchar("facebook_id"),
  instagramId: varchar("instagram_id"),
  // Facebook Page data (from Graph API)
  facebookPageId: varchar("facebook_page_id"),
  facebookPageName: varchar("facebook_page_name"),
  facebookFollowers: integer("facebook_followers"),
  facebookAccessToken: text("facebook_access_token"), // Page access token for future API calls
  // Instagram Business Account data (linked via Facebook)
  instagramBusinessId: varchar("instagram_business_id"),
  instagramHandle: varchar("instagram_handle"),
  instagramFollowers: integer("instagram_followers"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
