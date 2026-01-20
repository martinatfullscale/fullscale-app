import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Optimized connection pool configuration
// Prevents opening new connections per request - reuses existing pool
export const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  max: 10,                    // Maximum 10 connections in pool
  min: 2,                     // Keep 2 connections warm
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail fast if can't connect in 5s
  allowExitOnIdle: false,     // Keep pool alive
});

export const db = drizzle(pool, { schema });
