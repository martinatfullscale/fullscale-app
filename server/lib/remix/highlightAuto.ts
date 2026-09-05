/**
 * Auto highlight reel — fires after an editorial batch completes.
 *
 * The Highlight Reel was manual-only: the creator had to click "Find
 * Narrative Thread" then "Generate". This module runs the same machinery
 * unprompted once a video has enough rendered clips: Claude picks a
 * ~110s narrative arc, a stitch plan is created, and the reel renders
 * (branded card wipes when an approved placement exists) — so opening the
 * Highlight Reel tab shows a finished reel instead of an empty state.
 *
 * Guards: completed transcript, >=3 rendered editorial clips, and NO
 * existing stitch plan for the video (never clobber creator work).
 */

import * as fs from "fs";
import { MAX_REEL_SEC, reelTotalSeconds } from "@shared/reel";
import * as path from "path";
import { storage } from "../../storage";
import { stitchSegments } from "./clipStitcher";
import { PLATFORM_CONFIGS } from "./clipDetector";
import { generateTranscriptCaptions } from "./captionEngine";
import type { CaptionSegment } from "./clipGenerator";
import { uploadFileToStorage } from "../objectStorage";

const AUTO_REEL = {
  targetDuration: 110,
  segmentCount: 5,
  minRenderedClips: 3,
  platformKey: "tiktok" as const,
};

// The plan-existence guard and the plan INSERT are separated by a
// minutes-long Claude call — without an in-flight marker, two editorial
// completions in that window would both pass the empty check and render
// two near-identical reels (single-instance deploy, so a Set suffices).
const inFlightAutoReels = new Set<number>();

export async function autoGenerateHighlightReel(videoId: number, userId: number): Promise<void> {
  if (inFlightAutoReels.has(videoId)) {
    console.log(`[HighlightAuto] Reel generation already in flight for video ${videoId}, skipping`);
    return;
  }
  inFlightAutoReels.add(videoId);
  // Hoisted so the outer catch can mark the plan failed — otherwise a throw
  // after createStitchPlan leaves a perpetual 'generating' spinner until the
  // next restart's failInterruptedStitchPlans sweep.
  let planId: number | null = null;
  try {
    // ── Guards ────────────────────────────────────────────────────
    const existingPlans = await storage.getStitchPlansByVideo(videoId);
    if (existingPlans.length > 0) return; // creator already has reels/plans

    const transcript = await storage.getVideoTranscript(videoId);
    if (!transcript || transcript.status !== "completed" || !transcript.segments) return;

    const clips = await storage.getEditorialClipsByVideo(videoId);
    if (clips.filter((c) => c.renderStatus === "rendered").length < AUTO_REEL.minRenderedClips) return;

    const video = await storage.getVideoById(videoId);
    if (!video) return;

    console.log(`[HighlightAuto] Generating reel for video ${videoId} (~${AUTO_REEL.targetDuration}s)`);

    // ── Narrative arc ─────────────────────────────────────────────
    const { analyzeNarrativeThread } = await import("../ai/claude-dense/editorialAnalyzer");
    const surfaces = await storage.getDetectedSurfaces(videoId);
    // brandCatalog is REQUIRED by the analyzer's prompt builder (no default
    // — omitting it throws inside its try/catch and the reel silently never
    // generates). Same mapping as the manual narrative-thread route.
    let brandCatalog: Array<{ id: number; name: string; category: string | null; dominantColor: string | null }> = [];
    try {
      brandCatalog = (await storage.getAllBrandProducts()).map((b) => ({
        id: b.id,
        name: b.name,
        category: b.category || null,
        dominantColor: null,
      }));
    } catch { /* catalog is advisory — analyze without it */ }
    const thread = await analyzeNarrativeThread({
      videoId,
      transcript: transcript.segments as any[],
      surfaces: surfaces.map((s) => ({
        id: s.id,
        timestamp: parseFloat(String(s.timestamp)),
        surfaceType: s.surfaceType || "unknown",
        confidence: parseFloat(String(s.confidence)) || 0,
        boundingBox: {
          x: parseFloat(String(s.boundingBoxX)) || 0,
          y: parseFloat(String(s.boundingBoxY)) || 0,
          width: parseFloat(String(s.boundingBoxWidth)) || 0,
          height: parseFloat(String(s.boundingBoxHeight)) || 0,
        },
      })),
      brandCatalog,
      targetDuration: AUTO_REEL.targetDuration,
      segmentCount: AUTO_REEL.segmentCount,
    });
    if (!thread || !Array.isArray((thread as any).segments) || (thread as any).segments.length < 2) {
      console.log(`[HighlightAuto] No usable narrative thread for video ${videoId}`);
      return;
    }
    let segments: any[] = (thread as any).segments;

    // Hold the auto reel to the same length cap as a hand-built one.
    // TRIMMED rather than refused, unlike the interactive routes: nobody is
    // waiting on this and a shorter reel is a better outcome than none. Whole
    // beats are dropped from the end rather than cutting one mid-sentence.
    {
      const kept: any[] = [];
      let running = 0;
      for (const seg of segments) {
        const len = Math.max(0, Number(seg.end) - Number(seg.start));
        if (running + len > MAX_REEL_SEC) break;
        kept.push(seg);
        running += len;
      }
      if (kept.length !== segments.length) {
        console.log(
          `[HighlightAuto] Arc for video ${videoId} was ${Math.round(reelTotalSeconds(segments))}s — ` +
          `trimmed to ${kept.length}/${segments.length} beats to fit the ${MAX_REEL_SEC}s cap`,
        );
      }
      if (kept.length < 2) {
        console.log(`[HighlightAuto] Arc for video ${videoId} does not fit the cap in 2+ beats, skipping`);
        return;
      }
      segments = kept;
    }

    // Re-check after the slow analysis: a concurrent completion (force
    // re-run, resume) may have created a plan while Claude was thinking.
    const plansNow = await storage.getStitchPlansByVideo(videoId);
    if (plansNow.length > 0) {
      console.log(`[HighlightAuto] Plan appeared during analysis for video ${videoId}, skipping`);
      return;
    }

    // ── Plan record ───────────────────────────────────────────────
    const plan = await storage.createStitchPlan({
      videoId,
      userId,
      status: "generating",
      narrativeArc: (thread as any).narrativeArc || null,
      suggestedTitle: (thread as any).title || (thread as any).suggestedTitle || "Auto Highlight Reel",
      segments: segments.map((seg: any) => ({
        start: seg.start,
        end: seg.end,
        role: seg.role || "development",
        narrativePurpose: seg.narrativePurpose || "",
        connectionToNext: seg.connectionToNext || undefined,
        suggestedTransition: seg.suggestedTransition || "crossfade",
        enabled: true,
      })),
    } as any);
    planId = plan.id;

    // ── Source resolution (light-cloud aware) ─────────────────────
    let videoPath: string;
    let pinDir: string | null = null;
    let tempScopeDir: string | null = null;
    if (video.filePath?.startsWith("/storage/")) {
      const { downloadToTempFile, objectKeyFromServeUrl } = await import("../objectStorage");
      tempScopeDir = path.join("/tmp/remix-videos", `auto-reel-${plan.id}`);
      videoPath = await downloadToTempFile(objectKeyFromServeUrl(video.filePath), tempScopeDir);
    } else if (video.filePath) {
      videoPath = video.filePath;
      if (videoPath.startsWith("/") && !fs.existsSync(videoPath)) {
        const publicPath = path.join(process.cwd(), "public", videoPath);
        if (fs.existsSync(publicPath)) videoPath = publicPath;
      }
    } else {
      const { getPinnedSourcePath } = await import("../sourceCache");
      pinDir = path.join("/tmp/remix-videos", `auto-reel-pin-${plan.id}`);
      videoPath = await getPinnedSourcePath(video as any, pinDir);
    }

    try {
      const platformConfig = PLATFORM_CONFIGS[AUTO_REEL.platformKey];
      const stitchSegs = segments.map((seg: any, i: number) => ({
        start: seg.start,
        end: seg.end,
        transitionIn: i === 0 ? ("cut" as const) : ((seg.suggestedTransition || "crossfade") as "cut" | "crossfade" | "branded_wipe"),
        transitionDuration: 0.5,
      }));

      // Per-segment caption groups (times relative to each segment's start).
      // clipStitcher remaps them onto the output timeline of whichever stitch
      // mode actually renders — card splices vs xfade differ by 1.3s/junction.
      let captionsBySegment: CaptionSegment[][] | undefined = undefined;
      try {
        const groups: CaptionSegment[][] = stitchSegs.map((seg) => {
          const segTranscript = (transcript.segments as any[]).filter(
            (t: any) => t.start >= seg.start - 0.5 && t.start <= seg.end,
          );
          if (segTranscript.length === 0) return [];
          const res = generateTranscriptCaptions({
            clipStart: seg.start,
            clipEnd: seg.end,
            duration: seg.end - seg.start,
            narrativeContext: "",
            emotionalTone: "neutral",
            brandNames: [],
            style: "highlight",
            transcriptSegments: segTranscript,
          });
          return res.segments;
        });
        if (groups.some((g) => g.length > 0)) captionsBySegment = groups;
      } catch { /* captions optional */ }

      // Brand product for card wipes
      let brandProduct: { id: number; name: string; category: string | null } | undefined = undefined;
      try {
        const approved = await storage.getApprovedPlacementsForVideo(videoId);
        const withProduct = approved.find((p) => p.brandProductId != null);
        if (withProduct?.brandProductId != null) {
          const prod = await storage.getBrandProduct(withProduct.brandProductId);
          if (prod) brandProduct = { id: prod.id, name: prod.name, category: prod.category ?? null };
        }
      } catch { /* optional */ }

      const outputDir = path.join(process.cwd(), "public", "exported-clips", `stitch_${plan.id}`);
      fs.mkdirSync(outputDir, { recursive: true });

      const result = await stitchSegments({
        videoPath,
        videoId,
        segments: stitchSegs,
        platformConfig,
        captionsEnabled: true,
        captionsBySegment,
        outputDir,
        planId: plan.id,
        brandProduct,
      });

      if (!result.success || !result.outputPath) {
        await storage.updateStitchPlanStatus(plan.id, "failed", { errorMessage: result.error || "Auto stitch failed" });
        return;
      }

      const objectKey = `public/exported-clips/stitch_${plan.id}/${path.basename(result.outputPath)}`;
      const storageUrl = await uploadFileToStorage(result.outputPath, objectKey);
      let thumbUrl: string | null = null;
      if (result.thumbnailPath && fs.existsSync(result.thumbnailPath)) {
        thumbUrl = await uploadFileToStorage(result.thumbnailPath, `public/exported-clips/stitch_${plan.id}/${path.basename(result.thumbnailPath)}`);
      }

      // A reel is a publishable clip like any other — the manual stitch and
      // reel routes mint a generated_clips twin so Publish/Download work;
      // auto reels never did, so they showed "completed" and went nowhere.
      let generatedClipId: number | undefined;
      try {
        const reelJob = await storage.createRemixJob({
          videoId, userId, status: "completed",
          config: { minClipDuration: 0, maxClipDuration: 600, maxClips: 1, platformTargets: [AUTO_REEL.platformKey], captionsEnabled: true },
          platformTargets: [AUTO_REEL.platformKey],
        });
        const dbClip = await storage.createGeneratedClip({
          remixJobId: reelJob.id,
          videoId,
          clipStart: 0,
          clipEnd: result.duration,
          duration: result.duration,
          format: "mp4",
          platformTarget: AUTO_REEL.platformKey,
          captionsEnabled: true,
          qualityScore: 0.8,
          exportPath: storageUrl,
          thumbnailPath: thumbUrl,
          status: "ready",
        });
        generatedClipId = dbClip.id;
      } catch (twinErr: any) {
        console.warn(`[HighlightAuto] Could not create the reel's clip record (reel still saved): ${twinErr?.message || twinErr}`);
      }

      await storage.updateStitchPlanStatus(plan.id, "completed", {
        outputPath: storageUrl,
        thumbnailPath: thumbUrl ?? undefined,
        generatedClipId,
      });

      storage.createNotification({
        userId: String(video.userId),
        type: "highlight_ready",
        title: "Your highlight reel is ready",
        body: `We assembled a ~${AUTO_REEL.targetDuration}s narrative reel from "${(video.title || "your video").slice(0, 80)}".`,
        // Land ON the reel in Clips & Reels.
        linkPath: `/clips?reel=${plan.id}`,
        metadata: { videoId, planId: plan.id },
      });
      console.log(`[HighlightAuto] ✓ Reel completed for video ${videoId} (plan ${plan.id})`);
    } finally {
      if (tempScopeDir) { try { fs.rmSync(tempScopeDir, { recursive: true, force: true }); } catch { /* ignore */ } }
      if (pinDir) { try { fs.rmSync(pinDir, { recursive: true, force: true }); } catch { /* ignore */ } }
      try { fs.rmSync(path.join(process.cwd(), "public", "exported-clips", `stitch_${plan.id}`), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch (err: any) {
    console.warn(`[HighlightAuto] Reel generation failed for video ${videoId} (non-fatal):`, err?.message || err);
    if (planId != null) {
      // Mirror the manual route's catch: an honest 'failed' beats an
      // eternal spinner the guard then treats as existing work.
      await storage
        .updateStitchPlanStatus(planId, "failed", { errorMessage: err?.message || "Auto reel generation failed" })
        .catch(() => { /* best-effort */ });
    }
  } finally {
    inFlightAutoReels.delete(videoId);
  }
}
