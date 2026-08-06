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

// ── Self-repair ─────────────────────────────────────────────────────────
//
// Exists because the operator could not reach the production database any
// other way: Replit's UI would not surface the connection string, the
// workspace's DATABASE_URL points at development, and drizzle-kit is a dev
// dependency absent from the production bundle. The deployed app is the one
// process that provably holds the right DATABASE_URL — so it repairs itself.
//
// STRICTLY ADDITIVE by construction: CREATE TABLE IF NOT EXISTS and
// ALTER TABLE ADD COLUMN IF NOT EXISTS, generated from the same Drizzle
// metadata the queries compile from. It never drops, renames, or retypes
// anything, so the worst possible outcome of running it twice is a no-op.

export interface SchemaFixPlan {
  statements: Array<{ sql: string; reason: string }>;
  warnings: string[];
}

const quoteIdent = (n: string) => `"${n.replace(/"/g, '""')}"`;

/** Literal DEFAULT clause for a drizzle column, or null when not portable. */
function defaultClause(col: any, sqlType: string): { clause: string | null; warning?: string } {
  const d = col.default;
  if (d === undefined || d === null) return { clause: null };
  if (typeof d === "number" || typeof d === "boolean") return { clause: String(d) };
  if (typeof d === "string") return { clause: `'${d.replace(/'/g, "''")}'` };
  // SQL-object defaults: in this schema those are exclusively defaultNow().
  if (sqlType.startsWith("timestamp")) return { clause: "now()" };
  return { clause: null, warning: `default for "${col.name}" is not portable — column added without it` };
}

/**
 * Compile the drift report into additive DDL.
 *
 * ADD COLUMN nuance: a NOT NULL column can only be added to a possibly
 * non-empty table when it carries a DEFAULT to backfill with. Without one it
 * is added nullable, with a warning — a nullable column the code treats as
 * required beats a failed ALTER and a still-broken app.
 */
export function buildSchemaFixPlan(drift: SchemaDrift): SchemaFixPlan {
  const statements: SchemaFixPlan["statements"] = [];
  const warnings: string[] = [];

  const tableCfg = new Map<string, ReturnType<typeof getTableConfig>>();
  for (const value of Object.values(schema as Record<string, unknown>)) {
    try {
      const cfg = getTableConfig(value as any);
      if (cfg?.name && !tableCfg.has(cfg.name)) tableCfg.set(cfg.name, cfg);
    } catch { /* not a table export */ }
  }

  for (const table of drift.missingTables) {
    const cfg = tableCfg.get(table);
    if (!cfg) { warnings.push(`No metadata for missing table ${table} — skipped`); continue; }
    const colDefs: string[] = [];
    for (const col of cfg.columns) {
      const sqlType = col.getSQLType();
      let def = `${quoteIdent(col.name)} ${sqlType}`;
      const { clause, warning } = defaultClause(col, sqlType);
      if (warning) warnings.push(warning);
      if (clause) def += ` DEFAULT ${clause}`;
      if (col.primary) def += " PRIMARY KEY";
      else if (col.notNull && !/serial/.test(sqlType)) def += " NOT NULL";
      colDefs.push(def);
    }
    statements.push({
      sql: `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (${colDefs.join(", ")})`,
      reason: `table ${table} is missing`,
    });
  }

  // Group missing columns per table so the plan reads as one line per table.
  const colsByTable = new Map<string, string[]>();
  for (const m of drift.missingColumns) {
    if (!colsByTable.has(m.table)) colsByTable.set(m.table, []);
    colsByTable.get(m.table)!.push(m.column);
  }
  for (const [table, cols] of Array.from(colsByTable.entries())) {
    const cfg = tableCfg.get(table);
    if (!cfg) { warnings.push(`No metadata for table ${table} — its columns were skipped`); continue; }
    for (const colName of cols) {
      const col = cfg.columns.find((c: any) => c.name === colName);
      if (!col) { warnings.push(`No metadata for ${table}.${colName} — skipped`); continue; }
      const sqlType = col.getSQLType();
      let def = `${quoteIdent(colName)} ${sqlType}`;
      const { clause, warning } = defaultClause(col, sqlType);
      if (warning) warnings.push(warning);
      if (clause) def += ` DEFAULT ${clause}`;
      if (col.notNull && !/serial/.test(sqlType)) {
        if (clause) def += " NOT NULL";
        else warnings.push(`${table}.${colName} is NOT NULL in code but was added nullable (no default to backfill existing rows)`);
      }
      statements.push({
        sql: `ALTER TABLE ${quoteIdent(table)} ADD COLUMN IF NOT EXISTS ${def}`,
        reason: `column ${table}.${colName} is missing`,
      });
    }
  }

  if (drift.missingTables.length > 0) {
    warnings.push("Indexes for newly created tables are not generated here — run drizzle-kit push when database access is sorted to add them. Queries work without them; they are a performance optimization.");
  }
  return { statements, warnings };
}

export interface SchemaFixResult {
  applied: Array<{ sql: string; ok: boolean; error?: string }>;
  warnings: string[];
  driftAfter: SchemaDrift;
}

/** Execute the plan statement by statement; one failure never aborts the
 *  rest — every statement is independently additive. */
export async function applySchemaFix(): Promise<SchemaFixResult> {
  const drift = await checkSchemaDrift();
  const plan = buildSchemaFixPlan(drift);
  const applied: SchemaFixResult["applied"] = [];
  for (const stmt of plan.statements) {
    try {
      await db.execute(sql.raw(stmt.sql));
      applied.push({ sql: stmt.sql, ok: true });
      console.log(`[SchemaFix] OK: ${stmt.sql}`);
    } catch (err: any) {
      applied.push({ sql: stmt.sql, ok: false, error: err?.message });
      console.error(`[SchemaFix] FAILED: ${stmt.sql} — ${err?.message}`);
    }
  }
  return { applied, warnings: plan.warnings, driftAfter: await checkSchemaDrift() };
}
