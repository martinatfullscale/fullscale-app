import { db } from "./db";
import {
  monetizationItems,
  type MonetizationItem,
  type InsertMonetizationItem
} from "@shared/schema";

export interface IStorage {
  getMonetizationItems(): Promise<MonetizationItem[]>;
  createMonetizationItem(item: InsertMonetizationItem): Promise<MonetizationItem>;
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
}

export const storage = new DatabaseStorage();
