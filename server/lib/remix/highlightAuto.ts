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

export async function autoGenerateHighlightReel(videoId: number, userId: number): Promise<void> {
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
      targetDuration: AUTO_REEL.targetDuration,
      segmentCount: AUTO_REEL.segmentCount,
    } as any);
    if (!thread || !Array.isArray((thread as any).segments) || (thread as any).segments.length < 2) {
      console.log(`[HighlightAuto] No usable narrative thread for video ${videoId}`);
      return;
    }
    const segments: any[] = (thread as any).segments;

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

      // Captions remapped to the output timeline (same math as the manual
      // stitch route, incl. the 0.1s micro-fade cuts consume in xfade mode)
      let captionSegments: CaptionSegment[] | undefined = undefined;
      try {
        const reelHasCrossfade = stitchSegs.some((s, i) => i > 0 && s.transitionIn !== "cut");
        const out: CaptionSegment[] = [];
        let offset = 0;
        for (let i = 0; i < stitchSegs.length; i++) {
          const seg = stitchSegs[i];
          const overlap = i === 0 ? 0 : seg.transitionIn === "cut" ? (reelHasCrossfade ? 0.1 : 0) : 0.5;
          offset -= overlap;
          const segTranscript = (transcript.segments as any[]).filter(
            (t: any) => t.start >= seg.start - 0.5 && t.start <= seg.end,
          );
          if (segTranscript.length > 0) {
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
            for (const c of res.segments) {
              out.push({ ...c, startTime: Math.max(0, c.startTime + offset), endTime: Math.max(0, c.endTime + offset) });
            }
          }
          offset += seg.end - seg.start;
        }
        if (out.length > 0) captionSegments = out;
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
        captionSegments,
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

      await storage.updateStitchPlanStatus(plan.id, "completed", {
        outputPath: storageUrl,
        thumbnailPath: thumbUrl ?? undefined,
      });

      storage.createNotification({
        userId: String(video.userId),
        type: "highlight_ready",
        title: "Your highlight reel is ready",
        body: `We assembled a ~${AUTO_REEL.targetDuration}s narrative reel from "${(video.title || "your video").slice(0, 80)}".`,
        linkPath: "/library",
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
  }
}
