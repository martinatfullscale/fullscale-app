import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

const dbUrl = process.env.DATABASE_URL_OVERRIDE || process.env.DATABASE_URL;
if (!dbUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Optimized connection pool configuration for Neon (handles connection drops)
export const pool = new Pool({ 
  connectionString: dbUrl,
  max: 10,                    // Maximum 10 connections in pool
  min: 1,                     // Keep 1 connection warm (reduced for Neon)
  idleTimeoutMillis: 20000,   // Close idle connections after 20s (before Neon kills them)
  connectionTimeoutMillis: 10000, // Wait up to 10s for connection
  allowExitOnIdle: false,     // Keep pool alive
  // A checked-out client with no timeout is never reclaimed: one slow query
  // holds its slot indefinitely, and with max:10 it takes ten of those to
  // wedge the entire app. Every later request then WAITS instead of failing —
  // which is what "the site is laggy, then everything spins forever" actually
  // is. Postgres kills the query at the server; pg returns the connection.
  statement_timeout: 30_000,
  query_timeout: 30_000,
  // A transaction left open by a crashed handler is the other way to leak a
  // slot permanently.
  idle_in_transaction_session_timeout: 60_000,
});

/** Pool pressure, for the health endpoint. waitingCount > 0 means requests
 *  are queued for a connection — the leading indicator of the hang. */
export function poolStats() {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: 10 };
}

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
