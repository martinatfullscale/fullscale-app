/**
 * FullScale Studio — API Routes
 * Handles: Auth, Stripe payments, quota enforcement, voice listing, video management
 */
import type { Express, Request, Response } from "express";
import Stripe from "stripe";
import multer from "multer";
import { storage } from "../storage";
import { db } from "../db";
import { users } from "@shared/models/auth";
import { eq } from "drizzle-orm";

// Multer setup for file uploads (memory storage — buffer available as req.file.buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint",
    ];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith(".pdf") || file.originalname.endsWith(".pptx")) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and PPTX files are allowed"));
    }
  },
});

// ── Tier Configuration ──────────────────────────────────────────────
export const STUDIO_TIERS = {
  free: { label: "Free", price: 0, videosPerMonth: 1, voiceTier: "free", quality: "720p", visualMode: "static", watermark: true },
  starter: { label: "Starter", price: 9, videosPerMonth: 5, voiceTier: "starter", quality: "720p", visualMode: "ai_generated", watermark: false },
  pro: { label: "Pro", price: 29, videosPerMonth: 20, voiceTier: "pro", quality: "1080p", visualMode: "ai_generated", watermark: false },
  business: { label: "Business", price: 99, videosPerMonth: 999, voiceTier: "business", quality: "1080p", visualMode: "ai_generated", watermark: false },
} as const;

type TierName = keyof typeof STUDIO_TIERS;

// ── Stripe Setup ────────────────────────────────────────────────────
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const STRIPE_PRICE_MAP: Record<string, TierName> = {};
if (process.env.STRIPE_PRICE_ID_STARTER) STRIPE_PRICE_MAP[process.env.STRIPE_PRICE_ID_STARTER] = "starter";
if (process.env.STRIPE_PRICE_ID_PRO) STRIPE_PRICE_MAP[process.env.STRIPE_PRICE_ID_PRO] = "pro";
if (process.env.STRIPE_PRICE_ID_BUSINESS) STRIPE_PRICE_MAP[process.env.STRIPE_PRICE_ID_BUSINESS] = "business";

// ── Helpers ─────────────────────────────────────────────────────────
function getSessionEmail(req: any): string | null {
  return (
    req.session?.googleUser?.email ||
    req.session?.email ||
    req.user?.claims?.email ||
    null
  );
}

function getSessionUserId(req: any): string | null {
  return (
    req.session?.googleUser?.userId ||
    req.session?.userId ||
    req.user?.claims?.sub ||
    null
  );
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Ensure a Studio subscription exists for this user; create free tier if missing */
async function ensureStudioSubscription(userId: string) {
  let sub = await storage.getStudioSubscription(userId);
  if (!sub) {
    sub = await storage.createStudioSubscription({
      userId,
      tier: "free",
      status: "active",
    });
  }
  return sub;
}

/** Get or create usage row for the current month */
async function getOrCreateUsage(userId: string, tier: TierName) {
  const month = getCurrentMonth();
  let usage = await storage.getStudioUsage(userId, month);
  if (!usage) {
    usage = await storage.createStudioUsage({
      userId,
      month,
      videosGenerated: 0,
      videosLimit: STUDIO_TIERS[tier].videosPerMonth,
    });
  }
  return usage;
}

// ── Register Studio Routes ──────────────────────────────────────────
export function registerStudioRoutes(app: Express) {
  console.log("[Studio] Registering Studio API routes...");

  // ──────────────────────────────────────────────────────────────────
  // AUTH: Get current Studio subscription status
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/studio/me", async (req: any, res: Response) => {
    try {
      const email = getSessionEmail(req);
      if (!email) {
        return res.json({ authenticated: false });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.json({ authenticated: true, email, hasStudioAccess: false });
      }

      const sub = await ensureStudioSubscription(user.id);
      const tier = (sub.tier as TierName) || "free";
      const tierConfig = STUDIO_TIERS[tier];
      const usage = await getOrCreateUsage(user.id, tier);

      return res.json({
        authenticated: true,
        email,
        hasStudioAccess: true,
        subscription: {
          tier: sub.tier,
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        },
        usage: {
          videosGenerated: usage.videosGenerated,
          videosLimit: usage.videosLimit,
          month: usage.month,
        },
        tierConfig: {
          label: tierConfig.label,
          price: tierConfig.price,
          quality: tierConfig.quality,
          visualMode: tierConfig.visualMode,
          watermark: tierConfig.watermark,
        },
      });
    } catch (err: any) {
      console.error("[Studio] /api/studio/me error:", err);
      res.status(500).json({ error: "Failed to get studio status" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // AUTH: Studio signup (creates user with isApproved=true, skip waitlist)
  // ──────────────────────────────────────────────────────────────────
  app.post("/api/studio/signup", async (req: any, res: Response) => {
    try {
      const { email, firstName, lastName, password } = req.body;
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Check if user already exists
      let user = await storage.getUserByEmail(normalizedEmail);
      if (user) {
        // User exists — ensure they have a Studio subscription
        const sub = await ensureStudioSubscription(user.id);
        return res.json({
          message: "Existing user — Studio access granted",
          userId: user.id,
          tier: sub.tier,
        });
      }

      // Create new user with isApproved=true (skip FullScale waitlist for Studio signups)
      const { hashPassword } = await import("./password");
      const hashedPassword = password ? await hashPassword(password) : undefined;

      user = await storage.createUser({
        email: normalizedEmail,
        firstName: firstName || null,
        lastName: lastName || null,
        password: hashedPassword || null,
        isApproved: true, // Studio users skip the waitlist
        authProvider: "email",
      });

      // Auto-create free subscription
      const sub = await storage.createStudioSubscription({
        userId: user.id,
        tier: "free",
        status: "active",
      });

      // Set session
      (req.session as any).googleUser = {
        email: normalizedEmail,
        name: `${firstName || ""} ${lastName || ""}`.trim(),
        userId: user.id,
        isApproved: true,
      };

      return res.json({
        message: "Studio account created",
        userId: user.id,
        tier: sub.tier,
      });
    } catch (err: any) {
      console.error("[Studio] /api/studio/signup error:", err);
      res.status(500).json({ error: "Signup failed" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // TIERS: Get pricing info (public)
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/studio/tiers", async (_req: Request, res: Response) => {
    const tiers = Object.entries(STUDIO_TIERS).map(([key, config]) => ({
      id: key,
      ...config,
    }));
    res.json({ tiers });
  });

  // ──────────────────────────────────────────────────────────────────
  // STRIPE: Create checkout session
  // ──────────────────────────────────────────────────────────────────
  app.post("/api/studio/checkout", async (req: any, res: Response) => {
    try {
      if (!stripe) {
        return res.status(503).json({ error: "Payments not configured" });
      }

      const email = getSessionEmail(req);
      if (!email) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { tier } = req.body;
      if (!tier || !["starter", "pro", "business"].includes(tier)) {
        return res.status(400).json({ error: "Invalid tier" });
      }

      const priceId = {
        starter: process.env.STRIPE_PRICE_ID_STARTER,
        pro: process.env.STRIPE_PRICE_ID_PRO,
        business: process.env.STRIPE_PRICE_ID_BUSINESS,
      }[tier as string];

      if (!priceId) {
        return res.status(400).json({ error: `Price not configured for tier: ${tier}` });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const sub = await ensureStudioSubscription(user.id);

      // Reuse existing Stripe customer or create new one
      let customerId = sub.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email,
          metadata: { userId: user.id, studioTier: tier },
        });
        customerId = customer.id;
        await storage.updateStudioSubscription(user.id, { stripeCustomerId: customerId });
      }

      const baseUrl = `${req.protocol}://${req.get("host")}`;

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${baseUrl}/studio/upload?checkout=success`,
        cancel_url: `${baseUrl}/studio/pricing?checkout=canceled`,
        metadata: { userId: user.id, tier },
      });

      return res.json({ url: session.url });
    } catch (err: any) {
      console.error("[Studio] /api/studio/checkout error:", err);
      res.status(500).json({ error: "Checkout failed" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // STRIPE: Billing portal (manage subscription)
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/studio/billing-portal", async (req: any, res: Response) => {
    try {
      if (!stripe) {
        return res.status(503).json({ error: "Payments not configured" });
      }

      const email = getSessionEmail(req);
      if (!email) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const sub = await storage.getStudioSubscription(user.id);
      if (!sub?.stripeCustomerId) {
        return res.status(400).json({ error: "No billing account found" });
      }

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url: `${baseUrl}/studio/pricing`,
      });

      return res.json({ url: session.url });
    } catch (err: any) {
      console.error("[Studio] /api/studio/billing-portal error:", err);
      res.status(500).json({ error: "Failed to create billing portal" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // STRIPE: Webhook handler
  // ──────────────────────────────────────────────────────────────────
  app.post("/api/studio/webhook", async (req: any, res: Response) => {
    if (!stripe) {
      return res.status(503).json({ error: "Payments not configured" });
    }

    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!sig || !webhookSecret) {
      return res.status(400).json({ error: "Missing webhook signature" });
    }

    let event: Stripe.Event;
    try {
      // Use rawBody (set by express.json verify callback in index.ts) for signature verification
      const rawBody = req.rawBody || req.body;
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err: any) {
      console.error("[Studio Webhook] Signature verification failed:", err.message);
      return res.status(400).json({ error: "Invalid signature" });
    }

    console.log(`[Studio Webhook] ${event.type}`);

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const userId = session.metadata?.userId;
          const tier = session.metadata?.tier as TierName;
          if (userId && tier) {
            await storage.updateStudioSubscription(userId, {
              tier,
              stripeSubscriptionId: session.subscription as string,
              status: "active",
              currentPeriodStart: new Date(),
              currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // ~30 days
            });
            console.log(`[Studio Webhook] Upgraded ${userId} to ${tier}`);
          }
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object as any;
          const subId = (invoice.subscription as string) || (typeof invoice.subscription === "object" ? invoice.subscription?.id : null);
          if (subId) {
            const sub = await storage.getStudioSubscriptionByStripeSubscription(subId);
            if (sub) {
              await storage.updateStudioSubscription(sub.userId, {
                status: "active",
                currentPeriodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : new Date(),
                currentPeriodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              });
              console.log(`[Studio Webhook] Invoice paid for ${sub.userId}`);
            }
          }
          break;
        }

        case "customer.subscription.updated": {
          const subscription = event.data.object as any;
          const sub = await storage.getStudioSubscriptionByStripeSubscription(subscription.id);
          if (sub) {
            const priceId = subscription.items?.data?.[0]?.price?.id;
            const tier = priceId && STRIPE_PRICE_MAP[priceId] ? STRIPE_PRICE_MAP[priceId] : sub.tier as TierName;
            await storage.updateStudioSubscription(sub.userId, {
              tier,
              status: subscription.status === "active" ? "active" : subscription.status === "past_due" ? "past_due" : "canceled",
              cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
              currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : undefined,
            });
            console.log(`[Studio Webhook] Subscription updated for ${sub.userId}: ${tier} (${subscription.status})`);
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object as any;
          const sub = await storage.getStudioSubscriptionByStripeSubscription(subscription.id);
          if (sub) {
            await storage.updateStudioSubscription(sub.userId, {
              tier: "free",
              status: "canceled",
              stripeSubscriptionId: null,
            });
            console.log(`[Studio Webhook] Subscription canceled for ${sub.userId}, downgraded to free`);
          }
          break;
        }
      }

      res.json({ received: true });
    } catch (err: any) {
      console.error("[Studio Webhook] Processing error:", err);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // QUOTA: Check if user can generate a video
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/studio/quota", async (req: any, res: Response) => {
    try {
      const email = getSessionEmail(req);
      if (!email) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const sub = await ensureStudioSubscription(user.id);
      const tier = (sub.tier as TierName) || "free";
      const usage = await getOrCreateUsage(user.id, tier);

      const canGenerate = usage.videosGenerated < usage.videosLimit;

      return res.json({
        canGenerate,
        videosGenerated: usage.videosGenerated,
        videosLimit: usage.videosLimit,
        tier: sub.tier,
        month: usage.month,
      });
    } catch (err: any) {
      console.error("[Studio] /api/studio/quota error:", err);
      res.status(500).json({ error: "Failed to check quota" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // VOICES: List available voices (filtered by user's tier)
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/studio/voices", async (req: any, res: Response) => {
    try {
      const email = getSessionEmail(req);
      let userTier: TierName = "free";

      if (email) {
        const user = await storage.getUserByEmail(email);
        if (user) {
          const sub = await storage.getStudioSubscription(user.id);
          userTier = (sub?.tier as TierName) || "free";
        }
      }

      // Get all voices and mark which are available for the user's tier
      const allVoices = await storage.getStudioVoices();
      const tierOrder: TierName[] = ["free", "starter", "pro", "business"];
      const userTierIndex = tierOrder.indexOf(userTier);

      const voices = allVoices.map((voice) => {
        const voiceTierIndex = tierOrder.indexOf(voice.tier as TierName);
        return {
          ...voice,
          available: voiceTierIndex <= userTierIndex,
          requiredTier: voice.tier,
        };
      });

      return res.json({ voices, userTier });
    } catch (err: any) {
      console.error("[Studio] /api/studio/voices error:", err);
      res.status(500).json({ error: "Failed to load voices" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // VIDEOS: List user's Studio videos
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/studio/videos", async (req: any, res: Response) => {
    try {
      const email = getSessionEmail(req);
      if (!email) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const videos = await storage.getStudioVideosByUser(user.id);
      return res.json({ videos });
    } catch (err: any) {
      console.error("[Studio] /api/studio/videos error:", err);
      res.status(500).json({ error: "Failed to load videos" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // VIDEOS: Get single Studio video status
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/studio/videos/:videoId", async (req: any, res: Response) => {
    try {
      const email = getSessionEmail(req);
      if (!email) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const videoId = parseInt(req.params.videoId, 10);
      if (isNaN(videoId)) {
        return res.status(400).json({ error: "Invalid video ID" });
      }

      const video = await storage.getStudioVideo(videoId);
      if (!video) {
        return res.status(404).json({ error: "Video not found" });
      }

      return res.json({ video });
    } catch (err: any) {
      console.error("[Studio] /api/studio/videos/:videoId error:", err);
      res.status(500).json({ error: "Failed to load video" });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GENERATE: Upload document + run full pipeline (with quota check)
  // ──────────────────────────────────────────────────────────────────
  app.post("/api/studio/generate", upload.single("file"), async (req: any, res: Response) => {
    try {
      const email = getSessionEmail(req);
      if (!email) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // ── Validate file ──
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded. Please upload a PDF or PPTX." });
      }

      const fileName = req.file.originalname || "document";
      const fileBuffer: Buffer = req.file.buffer;
      const documentType: "pdf" | "pptx" = fileName.endsWith(".pptx") ? "pptx" : "pdf";

      // ── Quota check ──
      const sub = await ensureStudioSubscription(user.id);
      const tier = (sub.tier as TierName) || "free";
      const tierConfig = STUDIO_TIERS[tier];
      const month = getCurrentMonth();
      const usage = await getOrCreateUsage(user.id, tier);

      if (usage.videosGenerated >= usage.videosLimit) {
        return res.status(402).json({
          error: "Monthly video limit reached",
          videosGenerated: usage.videosGenerated,
          videosLimit: usage.videosLimit,
          tier,
          upgradeUrl: "/studio/pricing",
        });
      }

      // ── Create video record ──
      const voiceId = req.body?.voiceId || null;

      const video = await storage.createStudioVideo({
        userId: user.id,
        title: fileName.replace(/\.(pdf|pptx)$/i, ""),
        sourceFileName: fileName,
        voiceId,
        tier,
        visualQuality: tierConfig.quality,
        visualMode: tierConfig.visualMode,
        isWatermarked: tierConfig.watermark,
        status: "processing",
        progress: 0,
      });

      // ── Increment usage ──
      await storage.incrementStudioUsage(user.id, month);

      const visualTier = tier === "free" ? "mvp" : "v1";

      console.log(`[Studio] Video ${video.id} starting for ${email} (tier: ${tier}, visual: ${visualTier}, file: ${fileName})`);

      // ── Respond immediately, run pipeline in background ──
      res.json({
        video,
        message: "Video generation started. Check status at /api/studio/videos/" + video.id,
        usage: {
          videosGenerated: usage.videosGenerated + 1,
          videosLimit: usage.videosLimit,
        },
      });

      // ── Run pipeline in background (after response sent) ──
      runPipelineInBackground(video.id, fileBuffer, documentType, visualTier, voiceId);

    } catch (err: any) {
      console.error("[Studio] /api/studio/generate error:", err);
      res.status(500).json({ error: "Failed to start generation" });
    }
  });

  /**
   * Run the Studio pipeline in the background.
   * Updates the video record with progress and final output.
   */
  async function runPipelineInBackground(
    videoId: number,
    fileBuffer: Buffer,
    documentType: "pdf" | "pptx",
    visualTier: "mvp" | "v1" | "v2",
    voiceId: string | null
  ) {
    try {
      // Dynamically import the pipeline (it lives in studio-pipeline/)
      const { runPipeline } = await import("../../studio-pipeline/src/pipeline/index.js");

      // Set voice ID env var if provided (pipeline reads from env)
      if (voiceId) {
        process.env.ELEVENLABS_VOICE_ID = voiceId;
      }

      const result = await runPipeline(fileBuffer, documentType, {
        visualTier,
        onStageChange: async (stage: string, progress: number) => {
          // Update video record with progress
          try {
            await storage.updateStudioVideoStatus(videoId, "processing", {
              progress,
            });
          } catch (updateErr) {
            console.error(`[Studio] Failed to update progress for video ${videoId}:`, updateErr);
          }
        },
      });

      // ── Pipeline succeeded — update video record ──
      console.log(`[Studio] Video ${videoId} complete: ${result.outputPath}`);

      await storage.updateStudioVideoStatus(videoId, "completed", {
        outputUrl: result.outputPath,
        durationSeconds: result.metadata.estimatedDurationSeconds,
        sceneCount: result.metadata.sceneCount,
        progress: 100,
      });

    } catch (err: any) {
      console.error(`[Studio] Pipeline failed for video ${videoId}:`, err.message);
      await storage.updateStudioVideoStatus(videoId, "failed", {
        errorMessage: err.message || "Pipeline error",
        progress: 0,
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // VIDEOS: Download completed video file
  // ──────────────────────────────────────────────────────────────────
  app.get("/api/studio/videos/:videoId/download", async (req: any, res: Response) => {
    try {
      const email = getSessionEmail(req);
      if (!email) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const videoId = parseInt(req.params.videoId, 10);
      if (isNaN(videoId)) {
        return res.status(400).json({ error: "Invalid video ID" });
      }

      const video = await storage.getStudioVideo(videoId);
      if (!video) {
        return res.status(404).json({ error: "Video not found" });
      }

      // Verify ownership
      const user = await storage.getUserByEmail(email);
      if (!user || video.userId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (video.status !== "completed" || !video.outputUrl) {
        return res.status(400).json({ error: "Video is not ready for download" });
      }

      const fs = await import("fs");
      const path = await import("path");

      if (!fs.existsSync(video.outputUrl)) {
        return res.status(404).json({ error: "Video file not found on server" });
      }

      const fileName = `${video.title || "studio-video"}.mp4`;
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

      const fileStream = fs.createReadStream(video.outputUrl);
      fileStream.pipe(res);
    } catch (err: any) {
      console.error("[Studio] /api/studio/videos/:videoId/download error:", err);
      res.status(500).json({ error: "Download failed" });
    }
  });

  console.log("[Studio] Studio API routes registered");
}
