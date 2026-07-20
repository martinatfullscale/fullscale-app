/**
 * Publishing Scheduler — Scheduled Clip Distribution
 *
 * Manages the scheduling and execution of clip publications.
 * Runs on a configurable interval to check for pending scheduled posts
 * and publishes them via the platform adapters.
 *
 * Features:
 * - Optimal time suggestions per platform
 * - Queue management with retry logic
 * - Batch scheduling across platforms
 */

import { storage } from "../../storage";
import { publishToPlaftorm, resolvePublishAccessToken, type PublishInput } from "./platformPublisher";
import { formatCaption } from "./captionFormatter";
import * as path from "path";
import * as fs from "fs";

export interface ScheduleInput {
  userId: number;
  clipId: number;
  profileId: number;
  platform: string;
  scheduledFor: Date;
  caption?: string;
  hashtags?: string[];
}

export interface BatchScheduleInput {
  userId: number;
  clipId: number;
  /** Platform → profileId mapping */
  platformProfiles: Array<{ platform: string; profileId: number }>;
  /** Schedule each platform with optimal time offsets */
  baseTime: Date;
  /** Minutes between each platform post (stagger) */
  staggerMinutes?: number;
  caption?: string;
  hashtags?: string[];
}

// Optimal posting times by platform (UTC hours)
const OPTIMAL_HOURS: Record<string, number[]> = {
  tiktok: [11, 14, 19, 21],        // 11am, 2pm, 7pm, 9pm
  instagram_reels: [11, 13, 17, 20], // 11am, 1pm, 5pm, 8pm
  youtube_shorts: [12, 15, 18],     // noon, 3pm, 6pm
  youtube: [14, 17],                // 2pm, 5pm
  twitter: [9, 12, 17],            // 9am, noon, 5pm
  linkedin: [8, 10, 12],           // 8am, 10am, noon (business hours)
};

/**
 * Create a single scheduled post.
 */
export async function schedulePost(input: ScheduleInput) {
  const schedule = await storage.createPublishingSchedule({
    userId: input.userId,
    clipId: input.clipId,
    profileId: input.profileId,
    platform: input.platform,
    scheduledFor: input.scheduledFor,
    caption: input.caption || null,
    hashtags: input.hashtags || null,
    status: "pending",
  });

  console.log(`[Scheduler] Scheduled clip ${input.clipId} for ${input.platform} at ${input.scheduledFor.toISOString()}`);
  return schedule;
}

/**
 * Schedule a clip across multiple platforms with staggered timing.
 */
export async function batchSchedule(input: BatchScheduleInput) {
  const stagger = input.staggerMinutes || 30;
  const schedules = [];

  for (let i = 0; i < input.platformProfiles.length; i++) {
    const { platform, profileId } = input.platformProfiles[i];
    const scheduledTime = new Date(input.baseTime.getTime() + i * stagger * 60 * 1000);

    const schedule = await schedulePost({
      userId: input.userId,
      clipId: input.clipId,
      profileId,
      platform,
      scheduledFor: scheduledTime,
      caption: input.caption,
      hashtags: input.hashtags,
    });

    schedules.push(schedule);
  }

  console.log(`[Scheduler] Batch scheduled ${schedules.length} posts across ${input.platformProfiles.length} platforms`);
  return schedules;
}

/**
 * Suggest an optimal posting time for a platform.
 */
export function suggestPostingTime(platform: string, timezone: string = "America/New_York"): Date {
  const now = new Date();
  const optimalHours = OPTIMAL_HOURS[platform] || [12, 17];

  // Find the next optimal hour
  const currentHour = now.getUTCHours();

  for (const hour of optimalHours) {
    if (hour > currentHour) {
      const scheduled = new Date(now);
      scheduled.setUTCHours(hour, 0, 0, 0);
      return scheduled;
    }
  }

  // All optimal hours passed today — schedule for tomorrow's first slot
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setUTCHours(optimalHours[0], 0, 0, 0);
  return tomorrow;
}

/**
 * Process all pending scheduled posts that are due.
 * Call this on a periodic interval (e.g., every minute via setInterval).
 */
export async function processScheduledPosts(): Promise<number> {
  let processed = 0;

  try {
    const pendingSchedules = await storage.getPendingSchedules();

    if (pendingSchedules.length === 0) return 0;

    console.log(`[Scheduler] Processing ${pendingSchedules.length} pending scheduled posts...`);

    // A post that came due while the scheduler was down shouldn't fire hours
    // or days late — silently publishing stale content is worse than a missed
    // slot. Anything past the grace window is marked failed instead.
    const rawGrace = Number(process.env.SCHEDULER_MISFIRE_GRACE_HOURS);
    const graceHours = Number.isFinite(rawGrace) && rawGrace >= 0 ? rawGrace : 24;
    const misfireGraceMs = graceHours * 60 * 60 * 1000;

    for (const schedule of pendingSchedules) {
      try {
        if (Date.now() - new Date(schedule.scheduledFor).getTime() > misfireGraceMs) {
          await storage.updateScheduleStatus(
            schedule.id,
            "failed",
            undefined,
            "Missed scheduling window (scheduler offline past grace period)",
          );
          continue;
        }

        // Atomic claim: only one process wins the row. During Replit
        // redeploys old+new processes overlap (reusePort) and both read the
        // same pending list — without this CAS both would publish the post.
        const claimed = await storage.claimSchedule(schedule.id);
        if (!claimed) continue;

        // Get the clip
        const { db } = await import("../../db");
        const { generatedClips } = await import("../../../shared/schema");
        const { eq } = await import("drizzle-orm");
        const [clip] = await db.select().from(generatedClips).where(eq(generatedClips.id, schedule.clipId)).limit(1);

        if (!clip || !clip.exportPath) {
          await storage.updateScheduleStatus(schedule.id, "failed", undefined, "Clip not found or not exported");
          continue;
        }

        // Get the distribution profile
        const profile = await storage.getDistributionProfile(schedule.profileId);
        if (!profile) {
          await storage.updateScheduleStatus(schedule.id, "failed", undefined, "Distribution profile not found");
          continue;
        }
        // Defense-in-depth: a schedule must publish through its own owner's
        // profile. Route-level checks enforce this at creation; this guard
        // catches rows created before those checks (or via any missed path).
        if (profile.userId !== schedule.userId) {
          await storage.updateScheduleStatus(schedule.id, "failed", undefined, "Schedule/profile owner mismatch");
          continue;
        }

        // Resolve the token at publish time — the one stored on the profile
        // is typically expired by now (YouTube tokens live ~1 hour).
        const accessToken = await resolvePublishAccessToken(profile);
        if (!accessToken) {
          await storage.updateScheduleStatus(schedule.id, "failed", undefined, "No usable access token for profile");
          continue;
        }

        // Format caption if not provided
        let caption = schedule.caption || "";
        let hashtags = (schedule.hashtags as string[]) || [];

        if (!caption) {
          // Get scene analysis for context
          const analyses = await storage.getSceneAnalysisByVideo(clip.videoId);
          const analysis = analyses[0];

          const formatted = await formatCaption({
            platform: schedule.platform,
            brandNames: [],
            narrativeContext: analysis?.narrativeContext || "",
            emotionalTone: analysis?.emotionalTone || "neutral",
            culturalTags: (analysis?.culturalTags as string[]) || [],
          });

          caption = formatted.captionText;
          hashtags = formatted.hashtags;
        }

        // Resolve clip path. Mainline remix clips live in Object Storage
        // (exportPath = /storage/...) with the local file deleted after
        // upload — materialize those to a temp file first; without this,
        // every scheduled publish of a storage-hosted clip failed with
        // "Clip file not found on disk".
        let clipPath: string;
        let tempClipDir: string | null = null;
        if (clip.exportPath.startsWith("/storage/")) {
          const { downloadToTempFile, objectKeyFromServeUrl } = await import("../objectStorage");
          tempClipDir = path.join("/tmp/remix-videos", `publish-${schedule.id}`);
          clipPath = await downloadToTempFile(objectKeyFromServeUrl(clip.exportPath), tempClipDir);
        } else {
          clipPath = path.join(process.cwd(), "public", clip.exportPath.replace(/^\//, ""));
          if (!fs.existsSync(clipPath)) {
            await storage.updateScheduleStatus(schedule.id, "failed", undefined, "Clip file not found on disk");
            continue;
          }
        }

        // Publish
        const publishMetadata: Record<string, any> = { ...(profile.metadata as Record<string, any> || {}) };
        // Instagram's API pulls the video from a public URL instead of
        // accepting an upload — point it at the clip's public export path.
        if (schedule.platform.startsWith("instagram") && !publishMetadata.publicVideoUrl && clip.exportPath) {
          const base = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "https://gofullscale.co").replace(/\/$/, "");
          publishMetadata.publicVideoUrl = `${base}${clip.exportPath.startsWith("/") ? "" : "/"}${clip.exportPath}`;
        }
        const result = await publishToPlaftorm(schedule.platform, {
          clipPath,
          caption,
          hashtags,
          accessToken,
          accountId: profile.accountId || "",
          metadata: publishMetadata,
        });

        if (tempClipDir) {
          try { fs.rmSync(tempClipDir, { recursive: true, force: true }); } catch {}
        }

        if (result.success) {
          // Create published post record. Dry runs are labeled so they never
          // masquerade as real published posts in analytics/UI.
          const post = await storage.createPublishedPost({
            clipId: schedule.clipId,
            videoId: clip.videoId,
            profileId: schedule.profileId,
            platform: schedule.platform,
            platformPostId: result.platformPostId,
            postUrl: result.postUrl,
            caption,
            hashtags,
            publishedAt: new Date(),
            status: (result as any).dryRun ? "dry_run" : "published",
          });

          await storage.updateScheduleStatus(schedule.id, "completed", post.id);
          processed++;
        } else {
          await storage.updateScheduleStatus(schedule.id, "failed", undefined, result.error);
        }
      } catch (scheduleErr: any) {
        console.error(`[Scheduler] Failed to process schedule ${schedule.id}:`, scheduleErr);
        await storage.updateScheduleStatus(schedule.id, "failed", undefined, scheduleErr.message);
      }
    }

    console.log(`[Scheduler] Processed ${processed}/${pendingSchedules.length} scheduled posts`);
  } catch (err) {
    console.error("[Scheduler] Error processing scheduled posts:", err);
  }

  return processed;
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

function runTick() {
  if (tickInFlight) return; // previous run still publishing — don't overlap
  tickInFlight = true;
  processScheduledPosts()
    .catch(err => {
      console.error("[Scheduler] Interval error:", err);
    })
    .finally(() => {
      tickInFlight = false;
    });
}

/**
 * Start the scheduler daemon (checks every 60 seconds).
 */
export function startScheduler(intervalMs: number = 60000) {
  if (schedulerInterval) {
    console.log("[Scheduler] Already running");
    return;
  }

  console.log(`[Scheduler] Starting with ${intervalMs}ms interval`);
  schedulerInterval = setInterval(runTick, intervalMs);
  // Immediate first pass so posts that came due during a restart publish
  // promptly (bounded by the misfire grace window) instead of waiting a tick.
  runTick();
}

/**
 * Stop the scheduler daemon.
 */
export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[Scheduler] Stopped");
  }
}
