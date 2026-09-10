// Schema repair runs unattended at boot, so what it refuses to do matters as
// much as what it does. These pin the contract without a database: statements
// go through an injected runner, and the SQL a real transaction would send is
// rendered with Drizzle's own dialect.
//
// Not covered, because it needs a live Postgres: that lock_timeout really
// fires on a blocked ALTER, and that two instances really serialize on the
// advisory lock. The last test pins the three statements both depend on.

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import {
  applySchemaFix,
  bootRepairDecision,
  buildSchemaFixPlan,
  runBootSchemaRepair,
  runRepairStatement,
  __setSchemaFixTestHooks,
  type SchemaDrift,
} from "./schemaCheck";

const drift = (over: Partial<SchemaDrift> = {}): SchemaDrift => ({
  ok: false, missingTables: [], missingColumns: [], extraColumns: [], checkedTables: 1, remedy: null, ...over,
});
const clean = drift({ ok: true });

const OVERLAYS = { table: "stitch_plans", column: "overlays" };
const OVERLAYS_SQL = 'ALTER TABLE "stitch_plans" ADD COLUMN IF NOT EXISTS "overlays" jsonb';

// The column that broke reel builds on 2026-09-09, plus a missing table.
const incident = drift({ missingTables: ["creator_credits"], missingColumns: [OVERLAYS] });

const lockTimeout = () => Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });

let restore: (() => void) | null = null;
beforeEach(() => {
  for (const m of ["log", "warn", "error"] as const) mock.method(console, m, () => {});
});
afterEach(() => {
  restore?.();
  restore = null;
  mock.restoreAll();
});

/** Runs nothing; records what it was asked to run and fails per table from a script. */
function fakeDatabase(before: SchemaDrift, after: SchemaDrift, failures: Record<string, unknown[]> = {}) {
  const calls: Array<{ sql: string; lockTimeoutMs?: number }> = [];
  const sleeps: number[] = [];
  let checks = 0;
  restore = __setSchemaFixTestHooks({
    checkDrift: async () => (checks++ === 0 ? before : after),
    sleep: async (ms) => { sleeps.push(ms); },
    runInTransaction: async (stmt, lockTimeoutMs) => {
      calls.push({ sql: stmt.sql, lockTimeoutMs });
      const queue = failures[stmt.table];
      if (queue && queue.length > 0) throw queue.shift();
    },
  });
  return { calls, sleeps };
}

test("boot repair adds the missing column and does not create the missing table", async () => {
  const db = fakeDatabase(incident, drift({ missingTables: ["creator_credits"] }));
  const result = await runBootSchemaRepair(incident);

  assert.deepEqual(db.calls.map((c) => c.sql), [OVERLAYS_SQL]);
  assert.equal(db.calls[0].lockTimeoutMs, 3000);
  assert.deepEqual(result.skippedTables, ["creator_credits"]);
  assert.deepEqual(result.applied.map((a) => a.ok), [true]);
  // The primary-key-only warning is about tables this run did not create.
  assert.ok(!result.warnings.some((w) => /primary key/.test(w)));
});

test("the admin repair still creates missing tables", async () => {
  const db = fakeDatabase(incident, clean);
  const result = await applySchemaFix({ lockTimeoutMs: 3000 });

  assert.ok(db.calls.some((c) => c.sql.startsWith('CREATE TABLE IF NOT EXISTS "creator_credits"')));
  assert.ok(db.calls.some((c) => c.sql === OVERLAYS_SQL));
  assert.deepEqual(result.skippedTables, []);
  assert.ok(result.warnings.some((w) => /primary key and nothing else/.test(w)));
});

test("a lock timeout is retried with 1s then 2s backoff, then applies", async () => {
  const one = drift({ missingColumns: [OVERLAYS] });
  const db = fakeDatabase(one, clean, { stitch_plans: [lockTimeout(), lockTimeout()] });
  const result = await applySchemaFix({ columnsOnly: true, lockTimeoutMs: 3000 });

  assert.equal(db.calls.length, 3);
  assert.deepEqual(db.sleeps, [1000, 2000]);
  assert.deepEqual(result.applied, [{ sql: OVERLAYS_SQL, ok: true, attempts: 3 }]);
});

test("a table that stays locked fails after three retries instead of waiting forever", async () => {
  const one = drift({ missingColumns: [OVERLAYS] });
  const db = fakeDatabase(one, one, { stitch_plans: Array.from({ length: 10 }, lockTimeout) });
  const result = await applySchemaFix({ columnsOnly: true, lockTimeoutMs: 3000 });

  assert.equal(db.calls.length, 4);
  assert.deepEqual(db.sleeps, [1000, 2000, 4000]);
  assert.equal(result.applied[0].ok, false);
  assert.equal(result.applied[0].attempts, 4);
});

test("a lock error wrapped by the driver is still recognised", async () => {
  const one = drift({ missingColumns: [OVERLAYS] });
  const wrapped = Object.assign(new Error("Failed query"), { cause: { code: "55P03" } });
  const db = fakeDatabase(one, clean, { stitch_plans: [wrapped] });
  const result = await applySchemaFix({ columnsOnly: true });

  assert.deepEqual(db.sleeps, [1000]);
  assert.equal(result.applied[0].ok, true);
});

test("any other error fails at once and does not stop the next statement", async () => {
  const two = drift({ missingColumns: [OVERLAYS, { table: "creator_credits", column: "balance" }] });
  const denied = Object.assign(new Error("must be owner of table stitch_plans"), { code: "42501" });
  const db = fakeDatabase(two, drift({ missingColumns: [OVERLAYS] }), { stitch_plans: [denied] });
  const result = await applySchemaFix({ columnsOnly: true });

  assert.deepEqual(db.sleeps, []);
  assert.deepEqual(result.applied.map((a) => [a.ok, a.attempts]), [[false, 1], [true, 1]]);
  assert.match(result.applied[1].sql, /^ALTER TABLE "creator_credits" ADD COLUMN IF NOT EXISTS "balance"/);
});

test("a possible rename is warned about and the missing column is still added", () => {
  const plan = buildSchemaFixPlan(drift({
    missingColumns: [OVERLAYS],
    extraColumns: [{ table: "stitch_plans", column: "overlays_old" }],
  }));

  assert.deepEqual(plan.statements.map((st) => st.sql), [OVERLAYS_SQL]);
  assert.ok(plan.warnings.some((w) => w.startsWith("possible rename on stitch_plans") && w.includes("overlays_old")));
});

test("boot repair is on by default and off only for SCHEMA_AUTOREPAIR=false", () => {
  assert.equal(bootRepairDecision(incident, {}), "repair");
  assert.equal(bootRepairDecision(incident, { SCHEMA_AUTOREPAIR: "true" }), "repair");
  assert.equal(bootRepairDecision(incident, { SCHEMA_AUTOREPAIR: "false" }), "disabled");
  assert.equal(bootRepairDecision(clean, {}), "none");
  // A check that could not run says ok:false with nothing missing. Nothing to apply.
  assert.equal(bootRepairDecision(drift({ error: "connect ECONNREFUSED" }), {}), "none");
});

test("a statement sets lock_timeout before taking any lock, and only a transaction-scoped one", async () => {
  const dialect = new PgDialect();
  const sent: Array<{ sql: string; params: unknown[] }> = [];
  const [stmt] = buildSchemaFixPlan(drift({ missingColumns: [OVERLAYS] })).statements;

  await runRepairStatement(async (q: SQL) => { sent.push(dialect.sqlToQuery(q)); }, stmt, 3000);

  assert.equal(sent.length, 3);
  assert.equal(sent[0].sql, "SET LOCAL lock_timeout = '3000ms'");
  assert.match(sent[1].sql, /^SELECT pg_advisory_xact_lock\(\$1, hashtext\(\$2\)\)$/);
  assert.equal(sent[1].params[1], "stitch_plans");
  assert.equal(sent[2].sql, OVERLAYS_SQL);
});
