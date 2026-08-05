/**
 * Does the deployed database match the code that's running against it?
 *
 * Drizzle emits an EXPLICIT column list on every select. So a column that
 * exists in shared/schema.ts but not in the database doesn't degrade one
 * feature — it fails every query that touches that table, and the app reads
 * as "laggy, everything spins" because each failed request is then retried
 * with backoff by the client. This has now caused three separate incidents,
 * each diagnosed from scratch.
 *
 * This compares what the code expects against information_schema and says
 * exactly what's missing and what to run. Cheap (two queries), run at boot
 * and available on demand.
 */

import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { db } from "../db";
import * as schema from "@shared/schema";

export interface SchemaDrift {
  ok: boolean;
  missingTables: string[];
  missingColumns: Array<{ table: string; column: string }>;
  /** Columns the DB has that the code no longer declares. Informational —
   *  extra columns are harmless to Drizzle and are NOT a failure. */
  extraColumns: Array<{ table: string; column: string }>;
  checkedTables: number;
  /** The one-line instruction, when something is wrong. */
  remedy: string | null;
  error?: string;
}

const OK: SchemaDrift = {
  ok: true, missingTables: [], missingColumns: [], extraColumns: [],
  checkedTables: 0, remedy: null,
};

/** Every pgTable exported from the schema module, by SQL name. */
function declaredTables(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const value of Object.values(schema as Record<string, unknown>)) {
    // getTableConfig throws for anything that isn't a pgTable; that's the
    // cheapest way to filter the module's many non-table exports.
    let cfg: ReturnType<typeof getTableConfig>;
    try {
      cfg = getTableConfig(value as any);
    } catch {
      continue;
    }
    if (!cfg?.name || !Array.isArray(cfg.columns)) continue;
    const cols = new Set<string>();
    for (const col of cfg.columns) if (col?.name) cols.add(String(col.name));
    // A table re-exported under two names must not be checked twice.
    if (!out.has(cfg.name)) out.set(cfg.name, cols);
  }
  return out;
}

export async function checkSchemaDrift(): Promise<SchemaDrift> {
  try {
    const declared = declaredTables();
    if (declared.size === 0) return { ...OK };

    const rows: any = await db.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `);
    const list: Array<{ table_name: string; column_name: string }> =
      (rows?.rows ?? rows ?? []) as any[];

    const actual = new Map<string, Set<string>>();
    for (const r of list) {
      const t = String(r.table_name);
      if (!actual.has(t)) actual.set(t, new Set());
      actual.get(t)!.add(String(r.column_name));
    }

    const missingTables: string[] = [];
    const missingColumns: Array<{ table: string; column: string }> = [];
    const extraColumns: Array<{ table: string; column: string }> = [];

    for (const [table, cols] of Array.from(declared.entries())) {
      const have = actual.get(table);
      if (!have) { missingTables.push(table); continue; }
      for (const c of Array.from(cols)) if (!have.has(c)) missingColumns.push({ table, column: c });
      for (const c of Array.from(have)) if (!cols.has(c)) extraColumns.push({ table, column: c });
    }

    const ok = missingTables.length === 0 && missingColumns.length === 0;
    return {
      ok,
      missingTables,
      missingColumns,
      extraColumns,
      checkedTables: declared.size,
      remedy: ok ? null : "Run `npm run db:push` against this environment, then restart.",
    };
  } catch (err: any) {
    // A failed check must never be read as "schema is fine".
    return {
      ...OK,
      ok: false,
      checkedTables: 0,
      remedy: "Could not verify the schema — check DATABASE_URL and connectivity.",
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Boot-time check. Loud on failure, one line on success. Deliberately does
 * NOT exit the process: a partial schema still serves most of the app, and
 * refusing to boot would turn a degraded deploy into a total outage.
 */
export async function logSchemaDriftAtBoot(): Promise<SchemaDrift> {
  const drift = await checkSchemaDrift();
  if (drift.ok) {
    console.log(`[SchemaCheck] OK — ${drift.checkedTables} table(s) match the database`);
    return drift;
  }
  const bar = "=".repeat(72);
  console.error(`\n${bar}`);
  console.error("[SchemaCheck] DATABASE IS BEHIND THE DEPLOYED CODE");
  if (drift.error) console.error(`[SchemaCheck] check failed: ${drift.error}`);
  for (const t of drift.missingTables) {
    console.error(`[SchemaCheck]   MISSING TABLE   ${t}`);
  }
  // Group by table so a five-column change reads as one line, not five.
  const byTable = new Map<string, string[]>();
  for (const m of drift.missingColumns) {
    if (!byTable.has(m.table)) byTable.set(m.table, []);
    byTable.get(m.table)!.push(m.column);
  }
  for (const [t, cols] of Array.from(byTable.entries())) {
    console.error(`[SchemaCheck]   MISSING COLUMNS ${t}: ${cols.join(", ")}`);
  }
  console.error("[SchemaCheck]");
  console.error("[SchemaCheck] Every query touching those tables will fail — Drizzle names");
  console.error("[SchemaCheck] every column explicitly. The app will look slow and hang.");
  console.error(`[SchemaCheck] FIX: ${drift.remedy}`);
  console.error(`${bar}\n`);
  return drift;
}
