/**
 * Social insight snapshots — FullScale's own longitudinal analytics record.
 *
 * Meta only retains account-level Instagram insights ~90 days and story
 * insights 24 hours. This job runs every 12 hours, pulls the current
 * account metrics + demographics + live-story insights for every connected
 * Meta account, and appends them to social_insight_snapshots — so creator
 * history accumulates indefinitely on our side and the analytics UI can
 * chart beyond Meta's window.
 *
 * Fail-soft everywhere: a dead token or an unsupported metric skips that
 * account/metric, never the whole run.
 */

import { storage } from "../storage";
import {
  fetchInstagramAccountInsights,
  fetchInstagramStoryInsights,
  fetchFacebookPageAnalytics,
} from "./socialAnalytics";

const SNAPSHOT_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h — stories live 24h, so two chances per story
const FIRST_RUN_DELAY_MS = 3 * 60 * 1000;         // let boot settle first

export async function runSocialInsightSnapshots(): Promise<{ captured: number; skipped: number }> {
  let captured = 0;
  let skipped = 0;
  const accounts = await storage.getAllMetaSocialAccounts();
  console.log(`[SocialSnapshots] Snapshot cycle: ${accounts.length} Meta account(s)`);

  for (const acct of accounts) {
    try {
      const token = acct.accessToken; // decrypted by getAllMetaSocialAccounts
      if (!token) { skipped++; continue; }

      if (acct.platform === "instagram") {
        const insights = await fetchInstagramAccountInsights(acct.platformAccountId, token);
        if (!insights) { skipped++; continue; }
        const stories = await fetchInstagramStoryInsights(acct.platformAccountId, token);

        await storage.insertSocialInsightSnapshot({
          socialAccountId: acct.id,
          userId: acct.userId,
          platform: "instagram",
          platformAccountId: acct.platformAccountId,
          followers: acct.followers ?? null,
          metrics: insights.metrics,
          demographics: Object.keys(insights.demographics).length > 0 ? insights.demographics : null,
          stories: stories.length > 0 ? stories : null,
        });
        // Keep the account's live demographics fresh for the UI.
        if (Object.keys(insights.demographics).length > 0) {
          await storage.updateSocialAccountAudience(acct.id, insights.demographics);
        }
        captured++;
      } else if (acct.platform === "facebook") {
        const page = await fetchFacebookPageAnalytics(acct.platformAccountId, token);
        if (!page) { skipped++; continue; }
        await storage.insertSocialInsightSnapshot({
          socialAccountId: acct.id,
          userId: acct.userId,
          platform: "facebook",
          platformAccountId: acct.platformAccountId,
          followers: page.fanCount ?? acct.followers ?? null,
          metrics: page.insights,
          demographics: null,
          stories: null,
        });
        captured++;
      } else {
        skipped++;
      }
      // Gentle pacing between accounts — insights calls fan out per account.
      await new Promise((r) => setTimeout(r, 750));
    } catch (err: any) {
      skipped++;
      console.warn(`[SocialSnapshots] Account ${acct.platform}/${acct.platformAccountId} failed (non-fatal): ${err?.message}`);
    }
  }

  console.log(`[SocialSnapshots] Cycle done: ${captured} captured, ${skipped} skipped`);
  return { captured, skipped };
}

let snapshotTimer: ReturnType<typeof setInterval> | null = null;

export function startSocialSnapshotJob(): void {
  if (snapshotTimer) return;
  setTimeout(() => {
    runSocialInsightSnapshots().catch((err) =>
      console.warn("[SocialSnapshots] Initial run failed (non-fatal):", err?.message));
  }, FIRST_RUN_DELAY_MS);
  snapshotTimer = setInterval(() => {
    runSocialInsightSnapshots().catch((err) =>
      console.warn("[SocialSnapshots] Cycle failed (non-fatal):", err?.message));
  }, SNAPSHOT_INTERVAL_MS);
  console.log(`[SocialSnapshots] Job started (every ${SNAPSHOT_INTERVAL_MS / 3600000}h, first run in ${FIRST_RUN_DELAY_MS / 60000}min)`);
}
