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

import { sql, type SQL } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { db } from "../db";
import * as schema from "@shared/schema";

/** Where a person fixes drift the app can't fix alone. One constant, so every
 *  message that points there stays true if the page moves. */
export const SCHEMA_REPAIR_WHERE = "Repair database schema on the admin Placement Review Queue page (/admin/placements)";

/**
 * The instruction printed with every drift report. It used to say `npm run
 * db:push`, which from the Replit workspace pushes to the DEV database — so
 * following it reported "no changes" while production stayed broken.
 */
export const SCHEMA_REMEDY =
  "Restarting adds missing columns automatically unless SCHEMA_AUTOREPAIR=false. " +
  `For a missing table, or a column that still fails: ${SCHEMA_REPAIR_WHERE}, which shows the change before applying it. ` +
  "`npm run db:push` in the Replit workspace changes the dev database, not this one.";

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
      remedy: ok ? null : SCHEMA_REMEDY,
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
  printDriftBanner(drift);
  return drift;
}

/** The loud version. Printed again when a boot repair leaves drift behind. */
export function printDriftBanner(drift: SchemaDrift): void {
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
  console.error(`[SchemaCheck] FIX: ${drift.remedy ?? SCHEMA_REMEDY}`);
  console.error(`${bar}\n`);
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
//
// At boot it runs by default, columns only (runBootSchemaRepair). The admin
// route runs the full plan, tables included, after showing it to a person.

export interface PlannedStatement {
  sql: string;
  reason: string;
  kind: "table" | "column";
  /** The table it touches; also the advisory-lock key. */
  table: string;
}

export interface SchemaFixPlan {
  statements: PlannedStatement[];
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
      kind: "table",
      table,
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
        kind: "column",
        table,
      });
    }
  }

  // A rename looks like one missing and one extra column on the same table.
  // Adding the new name is still right (nothing is dropped, and the code needs
  // it), but the data is in the old column, so say so rather than guess.
  for (const [table, cols] of Array.from(colsByTable.entries())) {
    const extra = drift.extraColumns.filter((e) => e.table === table).map((e) => e.column);
    if (extra.length > 0) {
      warnings.push(`possible rename on ${table}: missing [${cols.join(", ")}], extra [${extra.join(", ")}] — the missing column is added empty and the old one is left as it is`);
    }
  }

  if (drift.missingTables.length > 0) {
    warnings.push("A table created here gets its primary key and nothing else: no unique constraints, foreign keys or indexes. Reads and plain inserts work; an upsert on any other unique column fails until the table is migrated properly.");
  }
  return { statements, warnings };
}

export interface SchemaFixOptions {
  /**
   * ADD COLUMN only. A CREATE TABLE built from Drizzle metadata gets a primary
   * key and nothing else, so an unattended run leaves a missing table loud
   * instead of quietly half-made.
   */
  columnsOnly?: boolean;
  /**
   * Give up on a statement that can't get its lock within this long. ADD
   * COLUMN needs an exclusive lock, and a WAITING exclusive lock queues every
   * later reader of that table behind it — one long query on stitch_plans
   * would otherwise stall every page that reads stitch_plans for as long as
   * the ALTER waited.
   */
  lockTimeoutMs?: number;
}

export interface SchemaFixResult {
  applied: Array<{ sql: string; ok: boolean; error?: string; attempts: number }>;
  warnings: string[];
  /** Missing tables a columnsOnly run left for a person. */
  skippedTables: string[];
  driftAfter: SchemaDrift;
}

/**
 * Advisory-lock namespace for schema repair; the second key is the table.
 * Old and new instances overlap on every deploy, and CREATE TABLE IF NOT
 * EXISTS is not safe against itself: both sessions can pass the existence
 * check and one then fails on a duplicate type. Keying by table serializes
 * the two without making unrelated tables wait. Any int4 will do; nothing
 * else in this app takes advisory locks.
 */
const SCHEMA_FIX_LOCK_NS = 7_310_402;

/** lock_not_available — lock_timeout fired. Worth another try; nothing else is. */
const LOCK_NOT_AVAILABLE = "55P03";
const LOCK_RETRY_DELAYS_MS = [1000, 2000, 4000];
const BOOT_LOCK_TIMEOUT_MS = 3000;

/** node-postgres puts the SQLSTATE on the error; a wrapping driver puts it on the cause. */
const pgCode = (err: any): string | undefined => err?.code ?? err?.cause?.code;

/**
 * One statement, inside one transaction on one pinned connection.
 *
 * lock_timeout is set before either lock is requested, so it bounds the wait
 * for the advisory lock as well as the table lock. The advisory lock is
 * WAITED for rather than tried and skipped: with try-and-skip, two instances
 * can each skip the same statement while the other holds the lock for a
 * different one, and neither applies it. Transaction-scoped, never
 * session-scoped: a session lock taken through the pool stays with whichever
 * connection happened to run it.
 */
export async function runRepairStatement(
  execute: (query: SQL) => Promise<unknown>,
  stmt: PlannedStatement,
  lockTimeoutMs?: number,
): Promise<void> {
  if (lockTimeoutMs && lockTimeoutMs > 0) {
    // SET takes no bind parameters; the value is an integer built here.
    await execute(sql.raw(`SET LOCAL lock_timeout = '${Math.floor(lockTimeoutMs)}ms'`));
  }
  await execute(sql`SELECT pg_advisory_xact_lock(${SCHEMA_FIX_LOCK_NS}, hashtext(${stmt.table}))`);
  await execute(sql.raw(stmt.sql));
}

const realHooks = {
  runInTransaction: (stmt: PlannedStatement, lockTimeoutMs?: number): Promise<void> =>
    db.transaction((tx) => runRepairStatement((q) => tx.execute(q), stmt, lockTimeoutMs)),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  checkDrift: (): Promise<SchemaDrift> => checkSchemaDrift(),
};
let hooks = { ...realHooks };

/** Tests only: replace the database-facing pieces. Returns a restore function. */
export function __setSchemaFixTestHooks(overrides: Partial<typeof realHooks>): () => void {
  hooks = { ...realHooks, ...overrides };
  return () => { hooks = { ...realHooks }; };
}

/**
 * Execute the plan statement by statement. One failure never aborts the rest:
 * every statement is independently additive.
 */
export async function applySchemaFix(opts: SchemaFixOptions = {}): Promise<SchemaFixResult> {
  const drift = await hooks.checkDrift();
  // Plan from a report with the tables taken out, rather than filtering the
  // statements afterwards, so warnings about tables this run won't create
  // aren't printed either.
  const plan = buildSchemaFixPlan(opts.columnsOnly ? { ...drift, missingTables: [] } : drift);
  const skippedTables = opts.columnsOnly ? [...drift.missingTables] : [];
  for (const t of skippedTables) {
    console.error(`[SchemaFix] MISSING TABLE ${t} — not created automatically. ${SCHEMA_REPAIR_WHERE}.`);
  }
  for (const w of plan.warnings) console.warn(`[SchemaFix] WARNING ${w}`);

  const applied: SchemaFixResult["applied"] = [];
  for (const stmt of plan.statements) {
    for (let attempt = 1; ; attempt++) {
      try {
        await hooks.runInTransaction(stmt, opts.lockTimeoutMs);
        applied.push({ sql: stmt.sql, ok: true, attempts: attempt });
        console.log(`[SchemaFix] OK: ${stmt.sql}`);
        break;
      } catch (err: any) {
        const retryIn = pgCode(err) === LOCK_NOT_AVAILABLE ? LOCK_RETRY_DELAYS_MS[attempt - 1] : undefined;
        if (retryIn !== undefined) {
          console.warn(`[SchemaFix] ${stmt.table} is busy (lock timeout), retrying in ${retryIn / 1000}s: ${stmt.sql}`);
          await hooks.sleep(retryIn);
          continue;
        }
        applied.push({ sql: stmt.sql, ok: false, error: err?.message ?? String(err), attempts: attempt });
        console.error(`[SchemaFix] FAILED after ${attempt} attempt(s): ${stmt.sql} — ${err?.message ?? err}`);
        break;
      }
    }
  }
  return { applied, warnings: plan.warnings, skippedTables, driftAfter: await hooks.checkDrift() };
}

/** What boot should do about a drift report. Split out so the kill switch has a test. */
export function bootRepairDecision(
  drift: SchemaDrift,
  env: Record<string, string | undefined> = process.env,
): "repair" | "disabled" | "none" {
  if (drift.missingTables.length === 0 && drift.missingColumns.length === 0) return "none";
  return env.SCHEMA_AUTOREPAIR === "false" ? "disabled" : "repair";
}

/**
 * The unattended repair: columns only, short lock waits, and a summary either
 * way. A failed statement is reported, never thrown.
 */
export async function runBootSchemaRepair(drift: SchemaDrift): Promise<SchemaFixResult> {
  console.log(
    `[SchemaFix] boot repair: ${drift.missingColumns.length} missing column(s)` +
    (drift.missingTables.length > 0 ? `, ${drift.missingTables.length} missing table(s) left for an admin` : ""),
  );
  const result = await applySchemaFix({ columnsOnly: true, lockTimeoutMs: BOOT_LOCK_TIMEOUT_MS });
  const ok = result.applied.filter((a) => a.ok).length;
  console.log(
    `[SchemaFix] boot repair finished: ${ok} applied, ${result.applied.length - ok} failed — ` +
    (result.driftAfter.ok ? "the schema matches the code" : "the schema is still behind"),
  );
  if (!result.driftAfter.ok) printDriftBanner(result.driftAfter);
  return result;
}
