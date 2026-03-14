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
import { publishToPlaftorm, type PublishInput } from "./platformPublisher";
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

    for (const schedule of pendingSchedules) {
      try {
        await storage.updateScheduleStatus(schedule.id, "processing");

        // Get the clip
        const clips = await storage.getClipsByVideo(0); // Need to find clip by ID
        // Use the direct import approach like routes.ts findClipById
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
        if (!profile || !profile.accessToken) {
          await storage.updateScheduleStatus(schedule.id, "failed", undefined, "Distribution profile not found or no access token");
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

        // Resolve clip path
        const clipPath = path.join(process.cwd(), "public", clip.exportPath.replace(/^\//, ""));
        if (!fs.existsSync(clipPath)) {
          await storage.updateScheduleStatus(schedule.id, "failed", undefined, "Clip file not found on disk");
          continue;
        }

        // Publish
        const result = await publishToPlaftorm(schedule.platform, {
          clipPath,
          caption,
          hashtags,
          accessToken: profile.accessToken,
          accountId: profile.accountId || "",
          metadata: profile.metadata as Record<string, any> || {},
        });

        if (result.success) {
          // Create published post record
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
            status: "published",
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

/**
 * Start the scheduler daemon (checks every 60 seconds).
 */
export function startScheduler(intervalMs: number = 60000) {
  if (schedulerInterval) {
    console.log("[Scheduler] Already running");
    return;
  }

  console.log(`[Scheduler] Starting with ${intervalMs}ms interval`);
  schedulerInterval = setInterval(() => {
    processScheduledPosts().catch(err => {
      console.error("[Scheduler] Interval error:", err);
    });
  }, intervalMs);
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
