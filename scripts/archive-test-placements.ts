/**
 * Audit — and then archive — placements that were never a real opportunity.
 *
 * Two known cases, both from before the access rule in `Creators can only
 * place brands that selected them` landed:
 *
 *   1. A creator placed a brand that had never engaged them (the JustWater
 *      test). The rule now blocks this at /api/brand-products/catalog AND at
 *      POST /api/placements, but rows created under the old rule are still
 *      live and still sitting in the review queue.
 *   2. Operator test placements — us exercising the placement flow, not a
 *      creator making a real choice.
 *
 * ── IT ARCHIVES, IT DOES NOT DELETE ───────────────────────────────────────
 * saved_placements.id is referenced by SIX tables, none of which declare a
 * foreign key, so nothing in the database would stop a DELETE from orphaning
 * them:
 *
 *     placement_renders.placement_id      placement_exposures.placement_id
 *     placement_links.placement_id        placement_conversions.placement_id
 *     link_clicks.placement_id            monetization_items.placement_id
 *
 * `status` already carries 'active' | 'archived' as row liveness, the review
 * queue reads `status = 'active'`, and archiving is reversible with
 * --unarchive. A hard delete buys nothing over that and cannot be undone, so
 * this script does not offer one. If you truly want rows gone after seeing
 * the audit, say so and I will write the delete with its child-row cleanup.
 *
 * ── USAGE (on Replit, where DATABASE_URL exists) ──────────────────────────
 *
 *   # 1. Audit. Writes nothing. Start here.
 *   tsx scripts/archive-test-placements.ts
 *
 *   # 2. Archive exactly the rows you picked out of the audit.
 *   tsx scripts/archive-test-placements.ts --apply --ids 12,34,56
 *
 *   # 3. Or archive every placement matched to a brand by name.
 *   tsx scripts/archive-test-placements.ts --apply --brand justwater
 *
 *   # Undo any of it.
 *   tsx scripts/archive-test-placements.ts --unarchive --ids 12,34,56
 *
 * --ids is the safe path: you read the audit, you name the rows. --brand
 * archives whatever section 1 of the audit listed for that term, which is
 * only as good as the name match — so run the audit first and check it.
 */
import { db } from "../server/db";
import {
  savedPlacements,
  brandProducts,
  monetizationItems,
  brandPlacementAssignments,
  placementRenders,
  placementLinks,
  placementConversions,
  placementExposures,
  linkClicks,
  videoIndex,
  allowedUsers,
} from "@shared/schema";
import { users } from "@shared/models/auth";
import { ADMIN_EMAILS } from "../server/lib/adminEmails";
import { eq, inArray, sql } from "drizzle-orm";

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const val = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const APPLY = has("--apply");
const UNARCHIVE = has("--unarchive");
const BRAND_TERM = val("--brand") ?? "justwater";
const EXPLICIT_IDS = (val("--ids") ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));

/** Case- and punctuation-insensitive containment, the same shape of match
 *  server/lib/envKeys.ts uses for secret names: "JUST Water", "just-water"
 *  and "justwater@brand.com" all reduce to the same haystack. */
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const matches = (s: unknown, term: string) => norm(s).includes(norm(term));

const log = (...a: unknown[]) => console.log("[archive-test-placements]", ...a);

// ── the six tables that point at saved_placements.id ──────────────────────
const CHILD_TABLES = [
  { label: "placement_renders", table: placementRenders, col: placementRenders.placementId },
  { label: "placement_links", table: placementLinks, col: placementLinks.placementId },
  { label: "link_clicks", table: linkClicks, col: linkClicks.placementId },
  { label: "placement_conversions", table: placementConversions, col: placementConversions.placementId },
  { label: "placement_exposures", table: placementExposures, col: placementExposures.placementId },
  { label: "monetization_items", table: monetizationItems, col: monetizationItems.placementId },
] as const;

async function childCounts(ids: number[]): Promise<Map<number, Record<string, number>>> {
  const out = new Map<number, Record<string, number>>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, {});
  for (const { label, table, col } of CHILD_TABLES) {
    try {
      const rows = await db
        .select({ placementId: col, n: sql<number>`count(*)::int` })
        .from(table as any)
        .where(inArray(col as any, ids))
        .groupBy(col as any);
      for (const r of rows as Array<{ placementId: number | null; n: number }>) {
        if (r.placementId == null) continue;
        const bucket = out.get(r.placementId);
        if (bucket && r.n > 0) bucket[label] = r.n;
      }
    } catch (err: any) {
      // A table that does not exist yet in this database should not abort the
      // audit — report it and carry on.
      log(`  ! could not count ${label}: ${err?.message || err}`);
    }
  }
  return out;
}

type Row = typeof savedPlacements.$inferSelect;

async function describe(rows: Row[], productNames: Map<number, string>) {
  if (rows.length === 0) {
    log("  (none)");
    return;
  }
  const counts = await childCounts(rows.map((r) => r.id));
  const videoIds = Array.from(new Set(rows.map((r) => r.videoId)));
  const titles = new Map<number, string>();
  if (videoIds.length > 0) {
    const vids = await db
      .select({ id: videoIndex.id, title: videoIndex.title })
      .from(videoIndex)
      .where(inArray(videoIndex.id, videoIds));
    for (const v of vids) titles.set(v.id, v.title);
  }
  for (const r of rows) {
    const kids = counts.get(r.id) ?? {};
    const kidStr = Object.keys(kids).length
      ? Object.entries(kids).map(([k, v]) => `${k}=${v}`).join(" ")
      : "no child rows";
    log(
      `  #${r.id}  status=${r.status}  review=${r.reviewStatus}  role=${r.role}\n` +
      `        by=${r.createdBy}  video=${r.videoId} "${titles.get(r.videoId) ?? "?"}"\n` +
      `        product=${r.productId ?? "custom upload"}${r.productId ? ` "${productNames.get(r.productId) ?? "?"}"` : ""}  created=${r.createdAt?.toISOString?.() ?? r.createdAt}\n` +
      `        references: ${kidStr}`,
    );
  }
}

async function main() {
  log(`mode=${UNARCHIVE ? "UNARCHIVE" : APPLY ? "APPLY (writes)" : "AUDIT (read-only)"}`);

  // Every product, so a placement's productId can name its brand. This table
  // is small — it is one row per uploaded product image.
  const allProducts = await db
    .select({ id: brandProducts.id, name: brandProducts.name, userId: brandProducts.userId })
    .from(brandProducts);
  const productNames = new Map(allProducts.map((p) => [p.id, p.name]));
  const productOwner = new Map(allProducts.map((p) => [p.id, p.userId]));

  // ── resolve the named brand to the keys its products are stored under ────
  // brand_products.userId is the mixed-key column shape used elsewhere in
  // this codebase (a users.id UUID on some rows, an email on others), so
  // collect both and match either.
  const brandKeys = new Set<string>();
  const matchedVia: string[] = [];

  const userRows = await db
    .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName })
    .from(users);
  for (const u of userRows) {
    if (matches(u.email, BRAND_TERM) || matches(`${u.firstName ?? ""}${u.lastName ?? ""}`, BRAND_TERM)) {
      if (u.id) brandKeys.add(u.id);
      if (u.email) brandKeys.add(u.email);
      matchedVia.push(`users.email=${u.email} id=${u.id}`);
    }
  }

  const allowRows = await db
    .select({ email: allowedUsers.email, name: allowedUsers.name, companyName: allowedUsers.companyName })
    .from(allowedUsers);
  for (const a of allowRows) {
    if (matches(a.companyName, BRAND_TERM) || matches(a.name, BRAND_TERM) || matches(a.email, BRAND_TERM)) {
      brandKeys.add(a.email);
      matchedVia.push(`allowed_users.company="${a.companyName ?? a.name}" email=${a.email}`);
    }
  }

  const bidRows = await db
    .select({ brandEmail: monetizationItems.brandEmail, brandName: monetizationItems.brandName })
    .from(monetizationItems);
  for (const b of bidRows) {
    if (matches(b.brandName, BRAND_TERM) || matches(b.brandEmail, BRAND_TERM)) {
      if (b.brandEmail) brandKeys.add(b.brandEmail);
      matchedVia.push(`monetization_items.brand_name="${b.brandName}" email=${b.brandEmail}`);
    }
  }

  // Products whose own NAME carries the brand, for rows uploaded under a
  // generic account ("JUST Water 500ml" owned by an ops user).
  const brandProductIds = new Set<number>();
  for (const p of allProducts) {
    if (brandKeys.has(p.userId) || matches(p.name, BRAND_TERM)) brandProductIds.add(p.id);
  }

  log("");
  log(`── 1. brand match: "${BRAND_TERM}" ──`);
  log(`   brand keys resolved: ${brandKeys.size ? Array.from(brandKeys).join(", ") : "(none)"}`);
  for (const m of Array.from(new Set(matchedVia)).slice(0, 12)) log(`   via ${m}`);
  log(`   products attributed to this brand: ${brandProductIds.size}`);

  const active = await db.select().from(savedPlacements).where(eq(savedPlacements.status, "active"));

  const brandHits = active.filter((r) => r.productId != null && brandProductIds.has(r.productId));
  await describe(brandHits, productNames);

  // ── 2. operator test placements ─────────────────────────────────────────
  // Anything in the review queue created by one of us rather than a creator.
  // REPORTED ONLY — never auto-selected, because an operator placement can
  // also be a real demo we want to keep. Pick the ids you want from here.
  const adminSet = new Set(ADMIN_EMAILS.map((e) => e.toLowerCase()));
  const operatorHits = active.filter(
    (r) => adminSet.has(String(r.createdBy).toLowerCase()) && !brandHits.some((b) => b.id === r.id),
  );
  log("");
  log("── 2. placements created by an operator (review queue) ──");
  log("   Reported only. Pass the ids you want gone to --apply --ids.");
  await describe(operatorHits, productNames);

  // ── 3. the wider class: no relationship between brand and creator ───────
  // The same rule getBrandProductsForCreator enforces, applied backwards to
  // rows that already exist. Reported only.
  const assignments = await db
    .select({
      brandUserId: brandPlacementAssignments.brandUserId,
      creatorUserId: brandPlacementAssignments.creatorUserId,
    })
    .from(brandPlacementAssignments);
  const bids = await db
    .select({ brandEmail: monetizationItems.brandEmail, creatorUserId: monetizationItems.creatorUserId })
    .from(monetizationItems);

  const related = new Set<string>();
  for (const a of assignments) related.add(`${norm(a.brandUserId)}|${norm(a.creatorUserId)}`);
  for (const b of bids) related.add(`${norm(b.brandEmail)}|${norm(b.creatorUserId)}`);
  // users.id ↔ email are the same identity; index the pair both ways so a
  // relationship recorded under one key still resolves under the other.
  const emailById = new Map(userRows.filter((u) => u.id && u.email).map((u) => [norm(u.id), norm(u.email)]));
  const idByEmail = new Map(userRows.filter((u) => u.id && u.email).map((u) => [norm(u.email), norm(u.id)]));
  const isRelated = (brandKey: string, creatorKey: string) => {
    const brands = [norm(brandKey), emailById.get(norm(brandKey)), idByEmail.get(norm(brandKey))].filter(Boolean);
    const creators = [norm(creatorKey), emailById.get(norm(creatorKey)), idByEmail.get(norm(creatorKey))].filter(Boolean);
    for (const b of brands) for (const c of creators) if (related.has(`${b}|${c}`)) return true;
    return false;
  };

  const orphanHits = active.filter((r) => {
    if (r.productId == null) return false;            // custom upload, no brand
    if (r.role === "brand") return false;             // brand placing into its own flow
    if (adminSet.has(String(r.createdBy).toLowerCase())) return false; // covered by section 2
    const owner = productOwner.get(r.productId);
    if (!owner) return false;
    return !isRelated(owner, r.createdBy);
  });
  log("");
  log("── 3. creator placed a brand that never engaged them ──");
  log("   The old-rule class. Reported only — this is the decision you have");
  log("   not made yet, and it is wider than the two cases above.");
  await describe(orphanHits, productNames);

  // ── act ─────────────────────────────────────────────────────────────────
  let targets: number[] = [];
  if (EXPLICIT_IDS.length > 0) {
    targets = EXPLICIT_IDS;
    log("");
    log(`target selection: --ids (${targets.join(", ")})`);
  } else if (APPLY || UNARCHIVE) {
    targets = brandHits.map((r) => r.id);
    log("");
    log(`target selection: brand match "${BRAND_TERM}" (${targets.length} rows)`);
  }

  if (!APPLY && !UNARCHIVE) {
    log("");
    log("AUDIT ONLY — nothing was written.");
    log(`Re-run with:  --apply --ids <comma,separated>   (or --apply --brand ${BRAND_TERM})`);
    return;
  }

  if (targets.length === 0) {
    log("Nothing to do — no rows matched.");
    return;
  }

  const nextStatus = UNARCHIVE ? "active" : "archived";
  const updated = await db
    .update(savedPlacements)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(inArray(savedPlacements.id, targets))
    .returning({ id: savedPlacements.id, status: savedPlacements.status });

  log("");
  log(`${UNARCHIVE ? "Restored" : "Archived"} ${updated.length} row(s): ${updated.map((u) => u.id).join(", ")}`);
  log("Child rows (renders, links, clicks, conversions, exposures, bids) were");
  log("left untouched — this is reversible with the opposite flag.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[archive-test-placements] Fatal:", err);
    process.exit(1);
  });
