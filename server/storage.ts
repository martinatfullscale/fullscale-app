import { db } from "./db";
import { eq } from "drizzle-orm";
import {
  monetizationItems,
  youtubeConnections,
  allowedUsers,
  type MonetizationItem,
  type InsertMonetizationItem,
  type YoutubeConnection,
  type InsertYoutubeConnection,
  type AllowedUser,
  type InsertAllowedUser,
} from "@shared/schema";
import { encrypt, decrypt } from "./encryption";

export interface IStorage {
  getMonetizationItems(): Promise<MonetizationItem[]>;
  createMonetizationItem(item: InsertMonetizationItem): Promise<MonetizationItem>;
  getYoutubeConnection(userId: string): Promise<YoutubeConnection | undefined>;
  upsertYoutubeConnection(connection: InsertYoutubeConnection): Promise<YoutubeConnection>;
  deleteYoutubeConnection(userId: string): Promise<void>;
  isEmailAllowed(email: string): Promise<boolean>;
  addAllowedUser(user: InsertAllowedUser): Promise<AllowedUser>;
  getAllowedUsers(): Promise<AllowedUser[]>;
}

export class DatabaseStorage implements IStorage {
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

  async deleteYoutubeConnection(userId: string): Promise<void> {
    await db.delete(youtubeConnections).where(eq(youtubeConnections.userId, userId));
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
}

export const storage = new DatabaseStorage();
