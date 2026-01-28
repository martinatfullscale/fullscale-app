import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Optimized connection pool configuration for Neon (handles connection drops)
export const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  max: 10,                    // Maximum 10 connections in pool
  min: 1,                     // Keep 1 connection warm (reduced for Neon)
  idleTimeoutMillis: 20000,   // Close idle connections after 20s (before Neon kills them)
  connectionTimeoutMillis: 10000, // Wait up to 10s for connection
  allowExitOnIdle: false,     // Keep pool alive
});

// Handle pool errors gracefully (Neon can terminate idle connections)
pool.on('error', (err) => {
  console.error('[DB Pool] Unexpected error on idle client:', err.message);
  // Don't crash - pool will create new connections as needed
});

// Handle individual client errors
pool.on('connect', (client) => {
  client.on('error', (err) => {
    console.error('[DB Client] Connection error:', err.message);
  });
});

export const db = drizzle(pool, { schema });
