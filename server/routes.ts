import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import { runIndexerForUser } from "./lib/indexer";
import { processVideoScan, scanPendingVideos, addToLocalAssetMap, getYouTubeThumbnailWithFallback } from "./scanner_v2";
// DISABLED: TensorFlow scanner replaced by scanner_v2.ts which uses Sharp
// import { queueVideoScan, getScanJobStatus, getQueueStatus, initializeScanWorker } from "./lib/scanWorker";
// import { detectSurfacesFromVideo } from "./lib/surfaceDetector";
import { extractThumbnailForVideo, extractAndUpdateThumbnails } from "./lib/thumbnailExtractor";
import {
  calculatePlacementPricing,
  formatCents,
  formatImpressions,
  avgRecentViews,
  computeExpiresAt,
  videoAgeDays as calcVideoAgeDays,
  type DurationTerm,
  CREATOR_TIER_MULTIPLIER,
  CONTENT_TIER_MULTIPLIER,
  DURATION_MULTIPLIER,
  BASE_CPM_USD,
} from "./lib/placementPricing";
import { scoreClipsForBrief } from "./lib/briefMatcher";
import {
  fetchInstagramAnalytics,
  fetchFacebookPageAnalytics,
  fetchYouTubeVideoStats,
  safeDecrypt,
} from "./lib/socialAnalytics";
import { processVideoExport } from "./lib/videoExporter";
import { registerObjectStorageRoutes } from "./replit_integrations/object_storage";
import { hashPassword, verifyPassword } from "./lib/password";
import { addSignupToAirtable } from "./lib/airtable";
import { setupPlatformAuth, importFacebookVideos, importInstagramMedia, importPersonalVideos, fetchInstagramVideoViews } from "./lib/platformAuth";
import { pLimit } from "./lib/concurrency";
import { getSourcePath } from "./lib/sourceCache";
import { readFileFromStorage } from "./lib/objectStorage";
import { harmonizeProductIntoScene } from "./lib/ai/harmonization";
import multer from "multer";
import path from "path";
import fs from "fs";
import ytdl from "@distube/ytdl-core";
import { decrypt, encrypt } from "./encryption";
import { db } from "./db";
import { users, users as usersTable, allowedUsers as allowedUsersTable, videoIndex as videoIndexTable, editorialClips, detectedSurfaces } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import crypto from "crypto";
import sharp from "sharp";
import { uploadFileToStorage, fileExistsInStorage, objectKeyFromServeUrl, getStorageStream } from "./lib/objectStorage";
import { runTranscriptPipeline } from "./lib/remix/transcriptPipeline";
import { runEditorialAutoPipeline, renderSingleEditorialClip } from "./lib/remix/editorialAutoPipeline";
import { analyzeEditorial } from "./lib/ai/claude-dense/editorialAnalyzer";
import { categorizeVideos } from "./lib/ai/categorize";
import {
  fetchInstagramAudience,
  fetchYoutubeAudience,
  fetchFacebookPageAudience,
} from "./lib/audienceFetcher";
import { rankClips, deduplicateClips } from "./lib/remix/clipRanker";

// Configure multer for video uploads (temp dir, then uploaded to Object Storage)
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmpDir = path.join(require("os").tmpdir(), "video-uploads");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `video-${uniqueSuffix}${ext}`);
  },
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = [".mp4", ".mov", ".webm", ".avi"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only video files (mp4, mov, webm, avi) are allowed"));
    }
  },
});

// Separate multer for image uploads (memory storage for compositing)
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max for images
  fileFilter: (req, file, cb) => {
    const allowedTypes = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext) || file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// VIP Founding Members - bypass allowlist check automatically
const FOUNDING_MEMBERS = [
  'martin@ekechukwu.com',
  'martin@gofullscale.co',
  'martin@whtwrks.com',
  'martincekechukwu@gmail.com',
  'simmone@capitalizevc.com',
  'simmoneaseymour@gmail.com',
  // Test account provisioned for Google OAuth verification reviewers.
  // Lives on the allowlist so verification reviewers can register/sign in
  // and complete the OAuth flow end-to-end without waitlist friction.
  'test-creator@gofullscale.co'
];

// Google Login OAuth Configuration (for authentication with allowlist)
const GOOGLE_LOGIN_SCOPES = [
  "openid",
  "email",
  "profile",
];

function generateOAuthState(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Generate a short random slug for shareable links (8 chars, URL-safe) */
function generateSlug(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // No confusing chars (0/O, 1/l/I)
  let slug = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    slug += chars[bytes[i] % chars.length];
  }
  return slug;
}

// Database-backed OAuth state storage (survives server restarts)
async function saveOAuthState(state: string): Promise<void> {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await db.execute(
    sql`INSERT INTO oauth_states (state, expires_at) VALUES (${state}, ${expiresAt}) ON CONFLICT (state) DO UPDATE SET expires_at = ${expiresAt}`
  );
}

async function verifyAndConsumeOAuthState(state: string): Promise<boolean> {
  if (!state) return false;
  try {
    // Delete expired states and check if this state exists
    await db.execute(sql`DELETE FROM oauth_states WHERE expires_at < NOW()`);
    const result = await db.execute(sql`DELETE FROM oauth_states WHERE state = ${state} RETURNING state`);
    return (result as any).rowCount > 0 || (result as any).rows?.length > 0;
  } catch (err) {
    console.error("[OAuth State] Database error:", err);
    return false;
  }
}

function getGoogleLoginAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_LOGIN_SCOPES.join(" "),
    access_type: "online",
    prompt: "select_account",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function getGoogleUserInfo(accessToken: string): Promise<{ email: string; name: string; picture: string } | null> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

// YouTube OAuth Configuration
//
// youtube.readonly       — channel info, video list, statistics (subs, views)
// yt-analytics.readonly  — audience demographics (age, gender, country),
//                          watch time, traffic sources. Required for the
//                          public creator profile / media kit to show
//                          audience makeup brands need for compliance
//                          (e.g. age verification for liquor/age-gated
//                          campaigns).
//
// Adding a new scope means existing tokens are insufficient — users will
// need to disconnect + reconnect YouTube once after this deploys to grant
// the new permission. The reconnect uses prompt=consent which forces the
// new consent screen to appear.
const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

function getYoutubeAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error("Token exchange failed:", response.status, errorText);
    throw new Error(`Token exchange failed: ${response.status}`);
  }
  
  return response.json();
}

async function getYoutubeChannelInfo(accessToken: string) {
  const response = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  return response.json();
}

async function getYoutubeVideos(accessToken: string, uploadsPlaylistId: string, maxResults: number = 5) {
  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  return response.json();
}

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number } | null> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Import session setup separately - this MUST succeed for OAuth to work
  const { getSession } = await import("./replit_integrations/auth/replitAuth");
  
  // Setup session middleware FIRST - required for all OAuth flows
  // This must run even if Replit OIDC fails
  console.log("[Routes] Setting up session middleware...");
  app.use(getSession());
  console.log("[Routes] Session middleware ready");
  
  // Setup Replit Auth (optional - server should start even if OIDC discovery fails)
  // Note: Session is already set up above, so this only adds OIDC routes
  try {
    await setupAuth(app);
    registerAuthRoutes(app);
    console.log("[Routes] Replit Auth setup completed");
  } catch (authError) {
    console.error("[Routes] Replit Auth setup failed (non-fatal):", authError);
    // Server continues without Replit Auth - Google OAuth will still work
    // because session middleware was already set up above
  }
  
  // Setup multi-platform auth (Twitch, Facebook)
  try {
    await setupPlatformAuth(app);
    console.log("[Routes] Platform Auth setup completed");
  } catch (platformError) {
    console.error("[Routes] Platform Auth setup failed (non-fatal):", platformError);
  }

  registerObjectStorageRoutes(app);

  // Setup FullScale Studio routes (auth, Stripe, quota, voices, videos)
  try {
    const { registerStudioRoutes } = await import("./lib/studio");
    registerStudioRoutes(app);
    console.log("[Routes] Studio routes registered");
  } catch (studioError) {
    console.error("[Routes] Studio routes failed (non-fatal):", studioError);
  }

  // ============================================
  // Google Login OAuth Routes (with Allowlist)
  // ============================================
  
  // Helper to check if email is a VIP/Founding member (uses FOUNDING_MEMBERS from top of file)
  const isVipEmail = (email: string) => 
    FOUNDING_MEMBERS.some(vip => vip.toLowerCase() === email.toLowerCase().trim());

  // One-shot admin endpoint: provisions the test-creator account that Google
  // OAuth verification reviewers use to test the YouTube OAuth flow. Idempotent:
  // creates the user if missing, sets the password, marks approved, adds to
  // allowed_users. Run once after deploy to guarantee the account is in the
  // exact state Google reviewers need.
  app.post("/api/admin/provision-test-creator", async (req: any, res) => {
    try {
      const adminEmails = ['martin@gofullscale.co', 'martin@whtwrks.com', 'martincekechukwu@gmail.com', 'thekimkwilson@gmail.com', 'tamara@whtwrks.com'];
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email || req.query.admin_email;
      if (!callerEmail || !adminEmails.map((e: string) => e.toLowerCase()).includes(callerEmail.toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const TEST_EMAIL = "test-creator@gofullscale.co";
      const TEST_PASSWORD = "P@ssw0rd20206!";
      const hashedPassword = await hashPassword(TEST_PASSWORD);

      // Ensure user record exists with the right state.
      //
      // Using a direct UPDATE instead of upsertUserByEmail because the
      // latter's onConflict only writes firstName/lastName/profileImageUrl
      // — it deliberately preserves password and isApproved on existing
      // rows so OAuth re-logins don't reset password state. For provisioning
      // we want exactly the opposite: force the documented state regardless
      // of what's there.
      const existing = await storage.getUserByEmail(TEST_EMAIL);
      let user;
      let action: "created" | "updated";
      if (existing) {
        const [updated] = await db.update(users)
          .set({
            password: hashedPassword,
            firstName: "Test",
            lastName: "Creator",
            isApproved: true,
            authProvider: "email",
            updatedAt: new Date(),
          })
          .where(eq(users.id, existing.id))
          .returning();
        user = updated;
        action = "updated";
      } else {
        user = await storage.createUser({
          email: TEST_EMAIL,
          password: hashedPassword,
          firstName: "Test",
          lastName: "Creator",
          isApproved: true,
          authProvider: "email",
        });
        action = "created";
      }

      // Ensure on the email allowlist as a creator
      const isAllowed = await storage.isEmailAllowed(TEST_EMAIL);
      if (!isAllowed) {
        await storage.addAllowedUser({ email: TEST_EMAIL, userType: "creator" });
      }

      console.log(`[Provision] test-creator account ${action} (approved=${user.isApproved})`);
      res.json({
        success: true,
        action,
        user: {
          id: user.id,
          email: user.email,
          isApproved: user.isApproved,
          firstName: user.firstName,
          lastName: user.lastName,
        },
        allowlisted: true,
      });
    } catch (err: any) {
      console.error("[Provision] Error:", err);
      res.status(500).json({ success: false, error: err.message || "Provision failed" });
    }
  });

  app.post("/api/admin/migrate-surfaces", async (req: any, res) => {
    try {
      const adminEmails = ['martin@gofullscale.co', 'martin@whtwrks.com', 'martincekechukwu@gmail.com', 'thekimkwilson@gmail.com', 'tamara@whtwrks.com'];
      const email = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!email || !adminEmails.map((e: string) => e.toLowerCase()).includes(email.toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const migrationPath = path.join(process.cwd(), 'server', 'migration-detected-surfaces.json');
      if (!fs.existsSync(migrationPath)) {
        return res.status(404).json({ error: "Migration file not found" });
      }

      const rows = JSON.parse(fs.readFileSync(migrationPath, 'utf-8'));
      let inserted = 0;
      let skipped = 0;

      for (const row of rows) {
        try {
          const result = await db.execute(sql`
            INSERT INTO detected_surfaces (id, video_id, timestamp, surface_type, confidence, bounding_box_x, bounding_box_y, bounding_box_width, bounding_box_height, frame_url, created_at, surroundings, scene_context, lighting_direction, lighting_intensity, camera_angle)
            VALUES (${row.id}, ${row.video_id}, ${row.timestamp}, ${row.surface_type}, ${row.confidence}, ${row.bounding_box_x}, ${row.bounding_box_y}, ${row.bounding_box_width}, ${row.bounding_box_height}, ${row.frame_url}, ${row.created_at}, ${row.surroundings ? sql`ARRAY[${sql.join(row.surroundings.map((s: string) => sql`${s}`), sql`, `)}]::text[]` : sql`NULL`}, ${row.scene_context}, ${row.lighting_direction}, ${row.lighting_intensity}, ${row.camera_angle})
            ON CONFLICT (id) DO NOTHING
          `);
          inserted++;
        } catch (e: any) {
          if (e.code === '23505') {
            skipped++;
          } else {
            console.error(`[Migration] Error inserting row ${row.id}:`, e.message);
            skipped++;
          }
        }
      }

      const maxIdResult = await db.execute(sql`SELECT MAX(id) as max_id FROM detected_surfaces`);
      const maxId = (maxIdResult as any).rows?.[0]?.max_id || 0;
      if (maxId > 0) {
        await db.execute(sql`SELECT setval('detected_surfaces_id_seq', ${maxId}, true)`);
      }

      res.json({ success: true, total: rows.length, inserted, skipped });
    } catch (err: any) {
      console.error("[Migration] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Check Google login status (for hybrid mode)
  app.get("/api/auth/google/status", (req: any, res) => {
    const googleUser = req.session?.googleUser;
    if (googleUser && googleUser.email) {
      return res.json({
        authenticated: true,
        user: {
          email: googleUser.email,
          name: googleUser.name || "",
          picture: googleUser.picture || "",
        },
      });
    }
    return res.json({ authenticated: false });
  });

  // Initiate Google login flow
  app.get("/api/auth/google", async (req: any, res) => {
    try {
      console.log("[Google OAuth] ========== LOGIN INITIATED ==========");
      
      // Check all required config upfront
      const baseUrl = process.env.BASE_URL;
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      
      console.log("[Google OAuth] BASE_URL:", baseUrl ? "set" : "MISSING");
      console.log("[Google OAuth] GOOGLE_CLIENT_ID:", clientId ? "set" : "MISSING");
      console.log("[Google OAuth] GOOGLE_CLIENT_SECRET:", clientSecret ? "set" : "MISSING");
      
      if (!baseUrl || !clientId || !clientSecret) {
        console.error("[Google OAuth] Missing required configuration");
        return res.status(500).json({ 
          error: "Google OAuth not configured. Please contact support.",
          missing: { baseUrl: !baseUrl, clientId: !clientId, clientSecret: !clientSecret }
        });
      }
      
      const redirectUri = `${baseUrl}/api/auth/google/callback`;
      const state = generateOAuthState();
      
      console.log("[Google OAuth] State generated:", state.substring(0, 16) + "...");
      console.log("[Google OAuth] Redirect URI:", redirectUri);
      
      // Store state in DATABASE (survives server restarts and cold starts)
      try {
        await saveOAuthState(state);
        console.log("[Google OAuth] State saved to database");
      } catch (dbErr: any) {
        console.error("[Google OAuth] Failed to save state:", dbErr.message);
        return res.status(500).json({ error: "Database error during auth initialization" });
      }
      
      // Store post-login redirect if provided (e.g. ?redirect=/studio/upload)
      const postLoginRedirect = req.query.redirect as string | undefined;
      if (postLoginRedirect && req.session) {
        (req.session as any).postLoginRedirect = postLoginRedirect;
        console.log("[Google OAuth] Stored post-login redirect:", postLoginRedirect);
      }

      // Also clear any old Google user data from session
      if (req.session) {
        delete req.session.googleUser;
      }

      console.log("[Google OAuth] ====================================");

      const authUrl = getGoogleLoginAuthUrl(redirectUri, state);

      // Explicitly save session before redirecting to Google (ensures postLoginRedirect persists)
      req.session.save((saveErr: any) => {
        if (saveErr) {
          console.error("[Google OAuth] Session save error:", saveErr);
        }
        res.redirect(authUrl);
      });
    } catch (err: any) {
      console.error("[Google OAuth] Unexpected error:", err.message, err.stack);
      res.status(500).json({ error: "Auth initialization failed", details: err.message });
    }
  });

  // Helper to clear session and redirect on auth error
  const clearSessionAndRedirect = (req: any, res: any, errorCode: string) => {
    console.log("[Auth Error] Clearing session due to error:", errorCode);
    req.session.destroy((err: any) => {
      if (err) console.error("[Auth Error] Session destroy failed:", err);
      res.clearCookie("connect.sid", { domain: process.env.COOKIE_DOMAIN || undefined });
      res.redirect("/?error=" + encodeURIComponent(errorCode));
    });
  };

  // Google login callback with allowlist check
  app.get("/api/auth/google/callback", async (req: any, res) => {
    try {
      const { code, error, state } = req.query;
      console.log("[Google OAuth Callback] ========== CALLBACK RECEIVED ==========");
      console.log("[Google OAuth Callback] State from query:", state ? (state as string).substring(0, 16) + "..." : "missing");
      console.log("[Google OAuth Callback] Session ID:", req.sessionID);
    
      if (error) {
        console.error("[Google OAuth Callback] Error from Google:", error);
        return clearSessionAndRedirect(req, res, error as string);
      }

      if (!code) {
        console.error("[Google OAuth Callback] No code received");
        return clearSessionAndRedirect(req, res, "no_code");
      }

      // Verify state using DATABASE (survives server restarts and cold starts)
      console.log("[Google OAuth Callback] Verifying state from database...");
      const stateValid = await verifyAndConsumeOAuthState(state as string);
    
      if (!stateValid) {
        console.error("[Google OAuth Callback] State verification failed - not found in database");
        console.error("[Google OAuth Callback] Query state:", state);
        return clearSessionAndRedirect(req, res, "invalid_state");
      }
    
      console.log("[Google OAuth Callback] State verified successfully via database");

      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        console.error("BASE_URL environment variable is not set");
        return res.redirect("/?error=configuration_error");
      }
      const redirectUri = `${baseUrl}/api/auth/google/callback`;
      
      // Exchange code for tokens
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: code as string,
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error("[Google OAuth Callback] Token exchange failed!");
        console.error("[Google OAuth Callback] Status:", tokenResponse.status);
        console.error("[Google OAuth Callback] Response:", errorText);
        console.error("[Google OAuth Callback] Redirect URI used:", redirectUri);
        console.error("[Google OAuth Callback] GOOGLE_CLIENT_ID exists:", !!process.env.GOOGLE_CLIENT_ID);
        console.error("[Google OAuth Callback] GOOGLE_CLIENT_SECRET exists:", !!process.env.GOOGLE_CLIENT_SECRET);
        return res.redirect("/?error=token_exchange_failed");
      }

      const tokens = await tokenResponse.json();
      
      if (tokens.error) {
        console.error("Google token exchange returned error:", tokens.error);
        return res.redirect("/?error=" + encodeURIComponent(tokens.error_description || tokens.error));
      }

      // Get user info
      console.log("[Google OAuth Callback] Getting user info from Google...");
      let userInfo;
      try {
        userInfo = await getGoogleUserInfo(tokens.access_token);
      } catch (userInfoErr: any) {
        console.error("[Google OAuth Callback] Failed to get user info:", userInfoErr.message);
        return res.redirect("/?error=failed_to_get_user_info");
      }
      
      if (!userInfo || !userInfo.email) {
        console.error("Failed to get user info from Google");
        return res.redirect("/?error=failed_to_get_user_info");
      }
      
      console.log("[Google OAuth Callback] User info received for:", userInfo.email);

      // Check VIP status using unified helper
      const normalizedEmail = userInfo.email.toLowerCase().trim();
      const isVip = isVipEmail(normalizedEmail);
      console.log("[Google OAuth Callback] VIP check:", normalizedEmail, "isVip:", isVip);
      
      // Check if user exists in users table
      console.log("[Google OAuth Callback] Looking up existing user...");
      let existingUser = await storage.getUserByEmail(userInfo.email);
      let userIsApproved = false;
      
      // Auto-create user if they don't exist (PUBLIC SIGN UP)
      if (!existingUser) {
        console.log("[Google OAuth Callback] Creating new user...");
        const nameParts = (userInfo.name || "").split(" ");
        // Only VIPs/Founding members are auto-approved
        userIsApproved = isVip;
        try {
          existingUser = await storage.createUser({
            email: normalizedEmail,
            firstName: nameParts[0] || null,
            lastName: nameParts.slice(1).join(" ") || null,
            profileImageUrl: userInfo.picture || null,
            isApproved: userIsApproved,
            authProvider: "google",
          });
          console.log(`Auto-created new Google user: ${userInfo.email}, VIP: ${isVip}, approved: ${userIsApproved}`);
        } catch (createErr: any) {
          console.error("[Google OAuth Callback] Failed to create user:", createErr.message);
          console.error("[Google OAuth Callback] Stack:", createErr.stack);
          return res.redirect("/?error=user_creation_failed");
        }
        
        // Send emails to new user and admin (non-blocking)
        const nameParts2 = (userInfo.name || "").split(" ");
        const newUserFirstName = nameParts2[0] || "there";
        const newUserLastName = nameParts2.slice(1).join(" ") || "User";
        
        setTimeout(async () => {
          try {
            const { sendWelcomeEmail, sendAdminNotification } = await import("./lib/resend");
            
            sendWelcomeEmail(normalizedEmail, newUserFirstName).catch(err =>
              console.error("[Resend] Welcome email failed for Google signup:", err)
            );
            
            sendAdminNotification({
              email: normalizedEmail,
              firstName: newUserFirstName,
              lastName: newUserLastName,
              userType: "creator",
            }).catch(err => console.error("[Resend] Admin notification failed for Google signup:", err));
          } catch (err) {
            console.error("[Resend] Failed to load email module:", err);
          }
          
          addSignupToAirtable({
            email: normalizedEmail,
            firstName: nameParts2[0] || null,
            lastName: nameParts2.slice(1).join(" ") || null,
            authProvider: "google",
            isApproved: userIsApproved,
          }).catch(err => console.error("[Airtable] Sync failed:", err));
        }, 3000);
      } else {
        // Existing user - use their current approval status
        userIsApproved = existingUser.isApproved ?? false;
      }
      
      // Only add VIPs to allowlist
      if (isVip) {
        const isAllowed = await storage.isEmailAllowed(userInfo.email);
        if (!isAllowed) {
          await storage.addAllowedUser({ email: normalizedEmail, userType: "creator" });
          console.log(`Auto-added VIP to allowlist: ${userInfo.email}`);
        }
      }
      
      // If user is on allowlist but has no role, default to creator
      const allowedUser = await storage.getAllowedUser(userInfo.email);
      if (allowedUser && !allowedUser.userType) {
        await storage.updateAllowedUserRole(userInfo.email, "creator");
        console.log(`Assigned default creator role to: ${userInfo.email}`);
      }
      
      if (isVip) {
        console.log(`VIP/Founding member access granted: ${userInfo.email}`);
      }

      // Set session with approval status
      (req.session as any).googleUser = {
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
        authProvider: "google",
        isApproved: userIsApproved,
      };
      
      console.log(`Access set for: ${userInfo.email}, approved: ${userIsApproved}`);
      
      // Redirect based on approval status — use BASE_URL so dev deploys redirect back to themselves
      const callbackBaseUrl = process.env.BASE_URL || "https://gofullscale.co";
      // Use stored post-login redirect if present (e.g. from /auth?redirect=/studio/waitlist)
      const storedRedirect = (req.session as any)?.postLoginRedirect;
      const isStudioRedirect = storedRedirect?.startsWith("/studio");
      const defaultPath = userIsApproved ? "/dashboard" : "/waitlist";
      // Allow studio redirects even for non-approved users (Studio has its own access gate)
      const redirectPath = (storedRedirect && (userIsApproved || isStudioRedirect))
        ? storedRedirect
        : defaultPath;
      // Clean up the stored redirect
      if (req.session) {
        delete (req.session as any).postLoginRedirect;
      }
      const redirectUrl = `${callbackBaseUrl}${redirectPath}`;

      // Explicitly save session before redirect to ensure it persists
      req.session.save((err: any) => {
        if (err) {
          console.error("Session save error:", err);
          return res.redirect(`${callbackBaseUrl}/?error=session_error`);
        }
        console.log(`[Google OAuth] Redirecting to: ${redirectUrl}`);
        res.redirect(redirectUrl);
      });
    } catch (err: any) {
      console.error("Google login callback error:", err.message || err);
      console.error("Google login callback stack:", err.stack);
      // Clear session on any auth error to allow fresh retry
      return clearSessionAndRedirect(req, res, "login_failed");
    }
  });

  // Session reset endpoint - allows users to clear stuck sessions
  app.get("/api/auth/reset", (req: any, res) => {
    console.log("[Auth] Session reset requested");
    req.session.destroy((err: any) => {
      if (err) console.error("[Auth] Session reset failed:", err);
      res.clearCookie("connect.sid", { domain: process.env.COOKIE_DOMAIN || undefined });
      res.redirect("/");
    });
  });

  // Dev-only admin login bypass — skips Google OAuth for admin emails
  // Creates a real session so the entire app works (Library, Dashboard, etc.)
  app.post("/api/auth/dev-login", async (req: any, res) => {
    const adminEmails = ['martin@gofullscale.co', 'martin@whtwrks.com', 'martincekechukwu@gmail.com', 'thekimkwilson@gmail.com', 'tamara@whtwrks.com'];
    const isDevelopment = process.env.NODE_ENV !== 'production';

    if (!isDevelopment) {
      return res.status(403).json({ error: "Dev login is only available in development mode" });
    }

    const { email } = req.body;
    if (!email || !adminEmails.includes(email)) {
      return res.status(403).json({ error: "Not an authorized admin email" });
    }

    // Look up user record (create if needed for dev)
    let user = await storage.getUserByEmail(email);
    if (!user) {
      user = await storage.createUser({ email, firstName: "Admin", lastName: "Dev", authProvider: "dev-bypass", isApproved: true });
    }

    // Set session exactly like Google OAuth would
    (req.session as any).googleUser = {
      email,
      name: user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Admin (Dev)" : "Admin (Dev)",
      picture: null,
      authProvider: "dev-bypass",
      isApproved: true,
    };

    req.session.save((err: any) => {
      if (err) {
        console.error("[Dev Login] Session save error:", err);
        return res.status(500).json({ error: "Session save failed" });
      }
      console.log(`[Dev Login] Admin session created for: ${email}`);
      res.json({ success: true, email, message: "Dev session created" });
    });
  });

  // Logout from Google session
  app.post("/api/auth/google/logout", (req, res) => {
    delete (req.session as any).googleUser;
    res.json({ success: true });
  });

  // Unified logout endpoint (works for both Google and email auth)
  app.post("/api/auth/logout", (req, res) => {
    // Clear any session data first
    (req.session as any).googleUser = null;
    (req.session as any).userId = null;
    
    req.session.destroy((err) => {
      if (err) {
        console.error("Logout error:", err);
        return res.status(500).json({ success: false, message: "Logout failed" });
      }
      // Clear cookie with same options it was set with
      res.clearCookie("connect.sid", {
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax" as const,
        domain: process.env.COOKIE_DOMAIN || undefined,
      });
      console.log("[Auth] User logged out successfully");
      res.json({ success: true });
    });
  });

  // ============================================
  // Email/Password Auth Routes (Public Sign Up)
  // ============================================

  // Zod schemas for auth validation
  const registerSchema = z.object({
    email: z.string().email("Invalid email format"),
    password: z.string().min(6, "Password must be at least 6 characters"),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    userType: z.enum(["creator", "brand", "press", "other", "nosy"]).optional().default("creator"),
  });

  const loginSchema = z.object({
    email: z.string().email("Invalid email format"),
    password: z.string().min(1, "Password is required"),
  });

  // Register new user with email/password
  app.post("/api/auth/register", async (req, res) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      }
      
      const { email, password, firstName, lastName, userType } = parsed.data;
      const normalizedEmail = email.toLowerCase().trim();

      // Check if user already exists
      const existingUser = await storage.getUserByEmail(normalizedEmail);
      if (existingUser) {
        return res.status(400).json({ message: "User already exists with this email" });
      }

      // VIP users are auto-approved, others go to waitlist
      const isVip = isVipEmail(normalizedEmail);

      // Hash password and create user
      const hashedPassword = await hashPassword(password);
      const user = await storage.createUser({
        email: normalizedEmail,
        password: hashedPassword,
        firstName: firstName || null,
        lastName: lastName || null,
        isApproved: isVip, // Only VIPs are auto-approved
        authProvider: "email",
      });

      console.log(`User registered: ${normalizedEmail}, VIP: ${isVip}, approved: ${isVip}, userType: ${userType}`);

      // Send emails (async, don't block registration)
      const { sendWelcomeEmail, sendAdminNotification } = await import("./lib/resend");
      
      // Send welcome email to user
      sendWelcomeEmail(normalizedEmail, firstName || "there").catch(err => 
        console.error("[Resend] Welcome email failed:", err)
      );
      
      // Send admin notification about new signup
      sendAdminNotification({
        email: normalizedEmail,
        firstName: firstName || "Unknown",
        lastName: lastName || "User",
        userType: userType || "creator",
      }).catch(err => console.error("[Resend] Admin notification failed:", err));

      // Sync to Airtable (async, don't block registration)
      addSignupToAirtable({
        email: normalizedEmail,
        firstName: firstName || null,
        lastName: lastName || null,
        authProvider: "email",
        isApproved: isVip,
      }).catch(err => console.error("[Airtable] Sync failed:", err));

      // For VIP users, set session and allow dashboard access
      if (isVip) {
        // Auto-add VIPs to allowlist
        const isAllowed = await storage.isEmailAllowed(normalizedEmail);
        if (!isAllowed) {
          await storage.addAllowedUser({ email: normalizedEmail, userType: "creator" });
        }

        (req.session as any).googleUser = {
          email: user.email,
          name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email,
          picture: user.profileImageUrl || "",
          authProvider: "email",
          isApproved: true,
        };

        return req.session.save((err: any) => {
          if (err) {
            console.error("Session save error:", err);
            return res.status(500).json({ message: "Session error" });
          }
          res.json({ success: true, status: "approved", user: { email: user.email, name: user.firstName } });
        });
      }

      // For non-VIP users, set session but mark as pending (for waitlist page)
      (req.session as any).googleUser = {
        email: user.email,
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email,
        picture: user.profileImageUrl || "",
        authProvider: "email",
        isApproved: false,
      };

      req.session.save((err: any) => {
        if (err) {
          console.error("Session save error:", err);
          return res.status(500).json({ message: "Session error" });
        }
        res.json({ success: true, status: "pending", user: { email: user.email, name: user.firstName } });
      });
    } catch (err: any) {
      console.error("Registration error:", err);
      res.status(500).json({ message: "Registration failed" });
    }
  });

  // Login with email/password
  app.post("/api/auth/login", async (req, res) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      }
      
      const { email, password } = parsed.data;
      const normalizedEmail = email.toLowerCase().trim();

      // Find user
      const user = await storage.getUserByEmail(normalizedEmail);
      if (!user || !user.password) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      // Verify password
      const isValid = await verifyPassword(password, user.password);
      if (!isValid) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      // Set session with approval status
      (req.session as any).googleUser = {
        email: user.email,
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email,
        picture: user.profileImageUrl || "",
        authProvider: "email",
        isApproved: user.isApproved ?? false,
      };

      req.session.save((err: any) => {
        if (err) {
          console.error("Session save error:", err);
          return res.status(500).json({ message: "Session error" });
        }
        res.json({ 
          success: true, 
          status: user.isApproved ? "approved" : "pending",
          user: { email: user.email, name: user.firstName } 
        });
      });
    } catch (err: any) {
      console.error("Login error:", err);
      res.status(500).json({ message: "Login failed" });
    }
  });

  // Get auth status (for frontend to check approval)
  // Supports: Google OAuth, Replit OIDC, Facebook session auth
  app.get("/api/auth/status", async (req: any, res) => {
    // Try Google OAuth session first
    const googleUser = (req.session as any)?.googleUser;
    if (googleUser && googleUser.email) {
      const user = await storage.getUserByEmail(googleUser.email);
      const isApproved = user?.isApproved ?? googleUser.isApproved ?? false;
      return res.json({
        authenticated: true,
        email: googleUser.email,
        name: googleUser.name,
        firstName: user?.firstName || null,
        lastName: user?.lastName || null,
        picture: googleUser.picture,
        authProvider: googleUser.authProvider || "google",
        isApproved,
      });
    }
    
    // Try Replit OIDC Auth (Passport-based)
    if (req.isAuthenticated && req.isAuthenticated() && req.user?.claims) {
      const claims = req.user.claims;
      const user = await storage.getUserByEmail(claims.email);
      const isApproved = user?.isApproved ?? false;
      return res.json({
        authenticated: true,
        email: claims.email,
        name: `${claims.first_name || ""} ${claims.last_name || ""}`.trim() || claims.email,
        firstName: claims.first_name || null,
        lastName: claims.last_name || null,
        picture: claims.profile_image_url || null,
        authProvider: "replit",
        isApproved,
      });
    }
    
    // Try Facebook session auth (via req.session.userId from platformAuth)
    const sessionUserId = (req.session as any)?.userId;
    if (sessionUserId) {
      const user = await storage.getUserById(sessionUserId);
      if (user) {
        const isApproved = user.isApproved ?? false;
        return res.json({
          authenticated: true,
          email: user.email,
          name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email,
          firstName: user.firstName || null,
          lastName: user.lastName || null,
          picture: user.profileImageUrl || null,
          authProvider: "facebook",
          isApproved,
        });
      }
    }

    return res.json({ authenticated: false });
  });

  // ============================================
  // YouTube OAuth Routes
  // ============================================
  
  // Middleware to check Google OAuth session (returns JSON for API calls)
  const isGoogleAuthenticated = (req: any, res: any, next: any) => {
    const googleUser = req.session?.googleUser;
    console.log(`[isGoogleAuthenticated] Session ID: ${req.sessionID}, googleUser: ${googleUser?.email || 'missing'}`);
    if (!googleUser || !googleUser.email) {
      return res.status(401).json({ message: "Unauthorized - Please login with Google" });
    }
    req.googleUser = googleUser;
    next();
  };
  
  // Flexible auth middleware - works with Google OAuth, Replit Auth, or Facebook session
  // Used for endpoints that should work for authenticated users regardless of method
  const isFlexibleAuthenticated = async (req: any, res: any, next: any) => {
    const adminEmails = ['martin@gofullscale.co', 'martin@whtwrks.com', 'martincekechukwu@gmail.com', 'thekimkwilson@gmail.com', 'tamara@whtwrks.com'];
    const isDevelopment = process.env.NODE_ENV !== 'production';
    
    // First try Google OAuth session
    const googleUser = req.session?.googleUser;
    if (googleUser && googleUser.email) {
      req.authEmail = googleUser.email;
      req.authUserId = (await storage.getUserByEmail(googleUser.email))?.id || googleUser.email;
      req.isAdmin = adminEmails.includes(googleUser.email);
      return next();
    }
    
    // Try Replit OIDC Auth (Passport-based)
    if (req.isAuthenticated && req.isAuthenticated() && req.user?.claims) {
      const claims = req.user.claims;
      req.authEmail = claims.email;
      req.authUserId = claims.sub || (await storage.getUserByEmail(claims.email))?.id || claims.email;
      req.isAdmin = adminEmails.includes(claims.email);
      return next();
    }
    
    // Try Facebook session auth (via req.session.userId from platformAuth)
    const sessionUserId = req.session?.userId;
    if (sessionUserId) {
      const user = await storage.getUserById(sessionUserId);
      if (user && user.email) {
        req.authEmail = user.email;
        req.authUserId = user.id;
        req.isAdmin = adminEmails.includes(user.email);
        return next();
      }
    }
    
    // DEVELOPMENT ONLY: Admin email fallback for testing without OAuth setup
    // This should NEVER be used in production - it's only for local development
    if (isDevelopment) {
      const adminEmail = req.query.admin_email || req.headers['x-admin-email'];
      if (adminEmail && adminEmails.includes(adminEmail)) {
        console.warn(`[DEV ONLY] Using admin email fallback for: ${adminEmail}`);
        req.authEmail = adminEmail;
        req.authUserId = (await storage.getUserByEmail(adminEmail))?.id || adminEmail;
        req.isAdmin = true;
        return next();
      }
      // Auto-pass in development when no auth is available (default to first admin)
      const defaultAdmin = adminEmails[0];
      req.authEmail = defaultAdmin;
      req.authUserId = (await storage.getUserByEmail(defaultAdmin))?.id || 1;
      req.isAdmin = true;
      return next();
    }

    return res.status(401).json({ message: "Unauthorized - Please login" });
  };
  
  // Middleware for OAuth callbacks (redirects instead of JSON for browser flows)
  const isGoogleAuthenticatedRedirect = (req: any, res: any, next: any) => {
    const googleUser = req.session?.googleUser;
    if (!googleUser || !googleUser.email) {
      // Session lost - redirect to Google login to re-authenticate
      console.log("YouTube callback: session missing, redirecting to Google login");
      return res.redirect("/api/auth/google?youtube_pending=true");
    }
    req.googleUser = googleUser;
    next();
  };

  // ─── Social Accounts (multi-account creator identity) ──────────────────
  // The new social_accounts table replaces the single-account fields on
  // users (users.facebookPageId, users.instagramHandle, etc.) and gives us
  // first-class support for creators with both business and personal
  // presences across IG, FB, YouTube, and beyond. See
  // docs/adr/001-multi-account-creator-profile.md for the full design.

  // Backfill the new social_accounts table from existing single-account
  // fields on users + the youtube_connections table.
  //
  // Each backfilled row is tagged account_type='business' because that's
  // what these connections historically were (FB Login flow targets Pages,
  // YT was connected via the brand channel for most users). Personal
  // accounts will be added later via the new IG Login flow.
  //
  // Idempotent — safe to call repeatedly. Uses upsertSocialAccount which
  // ON CONFLICT updates existing rows on (user_id, platform, account_type,
  // platform_account_id).
  app.post("/api/social-accounts/backfill-from-legacy", isFlexibleAuthenticated, async (req: any, res) => {
    const authUserId = req.authUserId;
    const authEmail = req.authEmail;

    try {
      const user = await storage.getUserByEmail(authEmail) || await storage.getUserById(authUserId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const created: string[] = [];
      const skipped: Record<string, string> = {};

      // ─── FB token-derived discovery ─────────────────────────────────
      // The user record's facebookPageId/instagramBusinessId fields can
      // get cleared by disconnect/reconnect cycles before /api/sync runs
      // again. To make the backfill self-sufficient, we query the FB
      // token directly when the user record is empty: token_debug gives
      // us granular_scopes which list the OAuth-granted Page IDs and IG
      // Business IDs. This matches what the FB Insights probe already does.
      let derivedPageIds: string[] = [];
      let derivedIgIds: string[] = [];
      let decryptedFbToken: string | null = null;
      let pageMetadataById: Record<string, { name?: string; followers_count?: number; instagram_business_account?: { id: string } }> = {};

      if (user.facebookAccessToken) {
        try {
          decryptedFbToken = decrypt(user.facebookAccessToken);
        } catch {
          skipped.facebook = "Failed to decrypt Facebook access token";
        }
      }

      if (decryptedFbToken) {
        // Always trust the token's granular_scopes over stale user fields.
        try {
          const dbgRes = await fetch(`https://graph.facebook.com/debug_token?input_token=${decryptedFbToken}&access_token=${decryptedFbToken}`);
          const dbgData = await dbgRes.json();
          const granular = dbgData?.data?.granular_scopes || [];
          for (const g of granular) {
            const targets: string[] = g?.target_ids || [];
            if (g.scope === "pages_show_list" || g.scope === "pages_read_engagement") {
              derivedPageIds.push(...targets);
            }
            if (g.scope === "instagram_basic" || g.scope === "instagram_manage_insights") {
              derivedIgIds.push(...targets);
            }
          }
          derivedPageIds = Array.from(new Set(derivedPageIds));
          derivedIgIds = Array.from(new Set(derivedIgIds));
        } catch (err: any) {
          skipped.fbTokenDebug = err?.message || "token debug failed";
        }

        // Fetch each Page's metadata (name, follower count, linked IG)
        for (const pageId of derivedPageIds) {
          try {
            const pageRes = await fetch(`https://graph.facebook.com/v18.0/${pageId}?fields=id,name,followers_count,fan_count,instagram_business_account&access_token=${decryptedFbToken}`);
            const pageData = await pageRes.json();
            if (pageData?.id) {
              pageMetadataById[pageId] = {
                name: pageData.name,
                followers_count: pageData.followers_count ?? pageData.fan_count,
                instagram_business_account: pageData.instagram_business_account,
              };
              // The IG account linked to this Page may not be in granular_scopes
              // if the user only granted instagram_basic to a specific account —
              // but IG Business linked to a Page is implicitly covered.
              if (pageData.instagram_business_account?.id) {
                derivedIgIds.push(pageData.instagram_business_account.id);
              }
            }
          } catch (err: any) {
            skipped[`fbPage_${pageId}`] = err?.message || "Page fetch failed";
          }
        }
        derivedIgIds = Array.from(new Set(derivedIgIds));
      }

      // ─── FB Page → social_accounts ──────────────────────────────────
      // Prefer derived data from the live token; fall back to user record.
      const fbPageIdsToWrite = derivedPageIds.length > 0
        ? derivedPageIds
        : (user.facebookPageId ? [user.facebookPageId] : []);

      for (const pageId of fbPageIdsToWrite) {
        const meta = pageMetadataById[pageId];
        const fbAccount = await storage.upsertSocialAccount({
          userId: user.id,
          platform: "facebook",
          accountType: "business",
          platformAccountId: pageId,
          handle: meta?.name || user.facebookPageName || null,
          displayName: meta?.name || user.facebookPageName || null,
          followers: meta?.followers_count ?? user.facebookFollowers ?? 0,
          accessToken: decryptedFbToken,
          scopes: ["email", "public_profile", "pages_show_list", "pages_read_engagement", "instagram_basic", "instagram_manage_insights"],
        });
        created.push(`facebook/business/${fbAccount.platformAccountId}`);
      }

      // ─── IG Business → social_accounts ──────────────────────────────
      const igIdsToWrite = derivedIgIds.length > 0
        ? derivedIgIds
        : (user.instagramBusinessId ? [user.instagramBusinessId] : []);

      for (const igId of igIdsToWrite) {
        // Try to fetch IG account metadata (handle, follower count) live.
        let igHandle: string | null = user.instagramHandle || null;
        let igFollowers: number | null = user.instagramFollowers ?? null;
        if (decryptedFbToken) {
          try {
            const igRes = await fetch(`https://graph.facebook.com/v18.0/${igId}?fields=username,followers_count&access_token=${decryptedFbToken}`);
            const igData = await igRes.json();
            if (igData?.username) igHandle = `@${igData.username}`;
            if (typeof igData?.followers_count === "number") igFollowers = igData.followers_count;
          } catch {
            // fall back to user record values
          }
        }
        const igAccount = await storage.upsertSocialAccount({
          userId: user.id,
          platform: "instagram",
          accountType: "business",
          platformAccountId: igId,
          handle: igHandle,
          displayName: igHandle,
          followers: igFollowers ?? 0,
          accessToken: decryptedFbToken,
          scopes: ["instagram_basic", "instagram_manage_insights"],
        });
        created.push(`instagram/business/${igAccount.platformAccountId}`);
      }

      // ─── YouTube → from youtube_connections table ───────────────────
      // Try lookup by both user.id (UUID) and user.email — the dual-id
      // problem we've seen across other tables.
      let ytConnection = await storage.getYoutubeConnection(user.id);
      if (!ytConnection && user.email && user.email !== user.id) {
        ytConnection = await storage.getYoutubeConnection(user.email);
      }
      if (ytConnection?.channelId) {
        const ytAccount = await storage.upsertSocialAccount({
          userId: user.id,
          platform: "youtube",
          accountType: "business",
          platformAccountId: ytConnection.channelId,
          handle: ytConnection.channelTitle || null,
          displayName: ytConnection.channelTitle || null,
          followers: ytConnection.subscriberCount || 0,
          totalViews: ytConnection.totalViewCount || 0,
          accessToken: ytConnection.accessToken,
          refreshToken: ytConnection.refreshToken || null,
          tokenExpiresAt: ytConnection.expiresAt || null,
          scopes: ["youtube.readonly", "yt-analytics.readonly"],
        });
        created.push(`youtube/business/${ytAccount.platformAccountId}`);
      } else {
        skipped.youtube = "No YouTube connection found by user.id or user.email";
      }

      console.log(`[Social Accounts Backfill] User ${user.email}: created/updated ${created.length} accounts: ${created.join(", ")}`);
      res.json({ success: true, count: created.length, accounts: created, skipped, derivedPageIds, derivedIgIds });
    } catch (err: any) {
      console.error("[Social Accounts Backfill] Error:", err);
      res.status(500).json({ success: false, error: err.message || "Backfill failed" });
    }
  });

  // Resolves the freshest YouTube access token for a given user, refreshing
  // via the stored refresh_token if expired. Reads from youtube_connections
  // (canonical, updated by OAuth callback) and syncs the result back to
  // social_accounts so subsequent reads don't go stale. Returns null if
  // no connection exists or refresh fails — caller should treat as "user
  // must reconnect YouTube."
  const getFreshYoutubeToken = async (userId: string, channelId: string): Promise<string | null> => {
    let connection = await storage.getYoutubeConnection(userId);
    if (!connection) {
      // Try lookup by email — same dual-id problem we've seen elsewhere
      const user = await storage.getUserById(userId);
      if (user?.email && user.email !== userId) {
        connection = await storage.getYoutubeConnection(user.email);
      }
    }
    if (!connection) return null;

    let accessToken = connection.accessToken; // Already decrypted by storage helper
    let expiresAt = connection.expiresAt;

    // Refresh if expired (Google access tokens are 1hr; refresh tokens are long-lived)
    if (connection.expiresAt && new Date(connection.expiresAt) < new Date()) {
      if (!connection.refreshToken) return null;
      const refreshed = await refreshAccessToken(connection.refreshToken);
      if (!refreshed) return null;
      accessToken = refreshed.access_token;
      expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
      // Persist refreshed token to youtube_connections (encrypted by helper)
      await storage.upsertYoutubeConnection({
        userId: connection.userId,
        accessToken: refreshed.access_token,
        refreshToken: connection.refreshToken,
        expiresAt,
        channelId: connection.channelId,
        channelTitle: connection.channelTitle,
      });
    }

    // Keep social_accounts in sync so future direct reads pick up the fresh token
    try {
      await storage.upsertSocialAccount({
        userId,
        platform: "youtube",
        accountType: "business",
        platformAccountId: channelId,
        accessToken,
        refreshToken: connection.refreshToken || null,
        tokenExpiresAt: expiresAt || null,
      });
    } catch (err: any) {
      console.warn(`[YouTube] social_accounts sync failed (non-fatal): ${err?.message}`);
    }

    return accessToken;
  };

  // Refresh audience analytics for one connected social account. Pulls
  // demographics + engagement from the platform's analytics API, parses
  // into the standard shape, writes back to social_accounts.audience_data.
  //
  // The fetchers handle per-platform quirks:
  //   - Instagram: 4 single-breakdown follower_demographics calls + basic engagement
  //   - YouTube: channel metrics + ageGroup×gender + top countries via the Analytics API
  //   - Facebook Page: just follower_count (Meta deprecated demographics in 2024)
  //
  // Errors per-call are surfaced in audience_data.errors rather than throwing,
  // so a partial-success refresh still writes what it got.
  app.post("/api/social-accounts/:id/refresh-analytics", isFlexibleAuthenticated, async (req: any, res) => {
    const accountId = req.params.id;
    const authUserId = req.authUserId;
    const authEmail = req.authEmail;

    try {
      const account = await storage.getSocialAccount(accountId);
      if (!account) return res.status(404).json({ error: "Social account not found" });

      // Ownership check — match either auth id or email
      if (account.userId !== authUserId && account.userId !== authEmail) {
        return res.status(403).json({ error: "Not authorized to refresh this account" });
      }

      if (!account.accessToken) {
        return res.status(400).json({ error: "No access token on this account; reconnect required" });
      }

      let audienceData;
      switch (account.platform) {
        case "instagram":
          audienceData = await fetchInstagramAudience(account.platformAccountId, account.accessToken);
          break;
        case "youtube": {
          // YouTube tokens live in two places: youtube_connections (canonical,
          // updated by OAuth callback + refresh-stats) and social_accounts
          // (cached at backfill time). The latter goes stale when the user
          // reconnects YouTube. Read the canonical token, refresh if expired,
          // sync back to social_accounts so future calls don't drift again.
          const ytToken = await getFreshYoutubeToken(account.userId, account.platformAccountId);
          if (!ytToken) {
            return res.status(400).json({ error: "YouTube not connected or token cannot be refreshed; reconnect required" });
          }
          audienceData = await fetchYoutubeAudience(account.platformAccountId, ytToken);
          break;
        }
        case "facebook":
          audienceData = await fetchFacebookPageAudience(account.platformAccountId, account.accessToken);
          break;
        default:
          return res.status(400).json({ error: `Unsupported platform: ${account.platform}` });
      }

      await storage.updateSocialAccountAudience(accountId, audienceData);

      console.log(`[Audience Refresh] ${account.platform}/${account.accountType}/${account.platformAccountId} for user ${authEmail}: ${Object.keys(audienceData.errors || {}).length} errors`);
      res.json({ success: true, audienceData });
    } catch (err: any) {
      console.error("[Audience Refresh] Error:", err);
      res.status(500).json({ success: false, error: err.message || "Refresh failed" });
    }
  });

  // Refresh analytics for ALL of the current user's connected accounts.
  // Iterates per account, returns a summary. Used by the creator's manual
  // "Update analytics" button on the profile page (forthcoming UI).
  app.post("/api/social-accounts/refresh-all", isFlexibleAuthenticated, async (req: any, res) => {
    const authUserId = req.authUserId;
    const authEmail = req.authEmail;

    try {
      const accounts = await storage.getSocialAccountsByUser(authUserId, authEmail);
      const results: Array<{ id: string; platform: string; ok: boolean; errors?: any }> = [];

      for (const account of accounts) {
        if (!account.accessToken) {
          results.push({ id: account.id, platform: account.platform, ok: false, errors: { token: "missing" } });
          continue;
        }
        try {
          let audienceData;
          if (account.platform === "instagram") {
            audienceData = await fetchInstagramAudience(account.platformAccountId, account.accessToken);
          } else if (account.platform === "youtube") {
            // See refresh-analytics endpoint for explanation of dual-source
            // token management. youtube_connections is canonical; social_accounts
            // gets resynced after refresh.
            const ytToken = await getFreshYoutubeToken(account.userId, account.platformAccountId);
            if (!ytToken) {
              results.push({ id: account.id, platform: account.platform, ok: false, errors: { token: "YouTube not connected or token cannot be refreshed" } });
              continue;
            }
            audienceData = await fetchYoutubeAudience(account.platformAccountId, ytToken);
          } else if (account.platform === "facebook") {
            audienceData = await fetchFacebookPageAudience(account.platformAccountId, account.accessToken);
          } else {
            results.push({ id: account.id, platform: account.platform, ok: false, errors: { platform: "unsupported" } });
            continue;
          }
          await storage.updateSocialAccountAudience(account.id, audienceData);
          results.push({ id: account.id, platform: account.platform, ok: true, errors: audienceData.errors });
        } catch (err: any) {
          console.error(`[Audience Refresh All] ${account.platform} failed:`, err);
          results.push({ id: account.id, platform: account.platform, ok: false, errors: { exception: err.message } });
        }
      }

      const successCount = results.filter(r => r.ok).length;
      console.log(`[Audience Refresh All] User ${authEmail}: ${successCount}/${results.length} accounts refreshed`);
      res.json({ success: true, count: results.length, refreshed: successCount, results });
    } catch (err: any) {
      console.error("[Audience Refresh All] Error:", err);
      res.status(500).json({ success: false, error: err.message || "Refresh failed" });
    }
  });

  // Daily cron entrypoint: refresh audience data for every connected social
  // account across all users. Designed to be hit by Replit Scheduled
  // Deployments (or any external cron) once per day. Authenticated by a
  // shared secret in the CRON_SECRET env var since there's no user session;
  // no secret = no auth = 401 (intentional, blocks public access).
  //
  // Mirrors the per-user /api/social-accounts/refresh-all loop but iterates
  // across all accounts. YouTube uses the dual-token dance (youtube_connections
  // is canonical, refresh via getFreshYoutubeToken). Continues on per-account
  // failure so a single bad token doesn't kill the whole batch.
  app.post("/api/admin/cron/refresh-audiences", async (req: any, res) => {
    const expected = process.env.CRON_SECRET;
    if (!expected) {
      return res.status(503).json({ error: "CRON_SECRET not configured" });
    }
    const provided = req.headers["x-cron-secret"] || req.query.secret;
    if (provided !== expected) {
      return res.status(401).json({ error: "Invalid cron secret" });
    }

    const startedAt = Date.now();
    try {
      const accounts = await storage.getAllSocialAccounts();
      console.log(`[Cron Refresh] Starting refresh for ${accounts.length} accounts`);

      let succeeded = 0;
      let failed = 0;
      const failures: Array<{ id: string; platform: string; userId: string; reason: string }> = [];

      for (const account of accounts) {
        if (!account.accessToken) {
          failed++;
          failures.push({ id: account.id, platform: account.platform, userId: account.userId, reason: "missing token" });
          continue;
        }
        try {
          let audienceData;
          if (account.platform === "instagram") {
            audienceData = await fetchInstagramAudience(account.platformAccountId, account.accessToken);
          } else if (account.platform === "youtube") {
            const ytToken = await getFreshYoutubeToken(account.userId, account.platformAccountId);
            if (!ytToken) {
              failed++;
              failures.push({ id: account.id, platform: account.platform, userId: account.userId, reason: "youtube token refresh failed" });
              continue;
            }
            audienceData = await fetchYoutubeAudience(account.platformAccountId, ytToken);
          } else if (account.platform === "facebook") {
            audienceData = await fetchFacebookPageAudience(account.platformAccountId, account.accessToken);
          } else {
            failed++;
            failures.push({ id: account.id, platform: account.platform, userId: account.userId, reason: `unsupported platform` });
            continue;
          }
          await storage.updateSocialAccountAudience(account.id, audienceData);
          succeeded++;
        } catch (err: any) {
          failed++;
          failures.push({ id: account.id, platform: account.platform, userId: account.userId, reason: err?.message || "exception" });
          console.error(`[Cron Refresh] Failed ${account.platform} for ${account.userId}:`, err?.message || err);
        }
      }

      const elapsedMs = Date.now() - startedAt;
      console.log(`[Cron Refresh] Done in ${elapsedMs}ms — ${succeeded} ok, ${failed} failed of ${accounts.length}`);
      res.json({ success: true, total: accounts.length, succeeded, failed, elapsedMs, failures });
    } catch (err: any) {
      console.error("[Cron Refresh] Fatal error:", err);
      res.status(500).json({ success: false, error: err.message || "Cron refresh failed" });
    }
  });

  // List the current user's connected social accounts (decrypted tokens
  // are NOT returned — only metadata + audience data).
  app.get("/api/social-accounts", isFlexibleAuthenticated, async (req: any, res) => {
    const authUserId = req.authUserId;
    const authEmail = req.authEmail;

    try {
      const accounts = await storage.getSocialAccountsByUser(authUserId, authEmail);
      const safe = accounts.map(a => ({
        id: a.id,
        platform: a.platform,
        accountType: a.accountType,
        platformAccountId: a.platformAccountId,
        handle: a.handle,
        displayName: a.displayName,
        avatarUrl: a.avatarUrl,
        bio: a.bio,
        followers: a.followers,
        totalViews: a.totalViews,
        audienceData: a.audienceData,
        audienceSyncedAt: a.audienceSyncedAt,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      }));
      res.json({ accounts: safe });
    } catch (err: any) {
      console.error("[Social Accounts] List error:", err);
      res.status(500).json({ error: err.message || "Failed to list accounts" });
    }
  });

  // Initiate YouTube OAuth flow
  app.get("/api/auth/youtube", isGoogleAuthenticated, (req: any, res) => {
    try {
      console.log("[YouTube OAuth] ========== INITIATING ==========");
      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        console.error("[YouTube OAuth] BASE_URL environment variable is not set");
        return res.redirect("/?youtube_error=configuration_error");
      }
      const redirectUri = `${baseUrl}/api/auth/youtube/callback`;
      console.log("[YouTube OAuth] Redirect URI:", redirectUri);
      const authUrl = getYoutubeAuthUrl(redirectUri);
      console.log("[YouTube OAuth] Auth URL generated, redirecting...");
      res.redirect(authUrl);
    } catch (err: any) {
      console.error("[YouTube OAuth] Error initiating:", err.message, err.stack);
      return res.status(500).json({ error: "Failed to initiate YouTube OAuth" });
    }
  });

  // YouTube OAuth callback - uses redirect middleware for graceful session handling
  app.get("/api/auth/youtube/callback", isGoogleAuthenticatedRedirect, async (req: any, res) => {
    console.log("[YouTube Callback] Received callback request");
    const { code, error } = req.query;
    
    if (error) {
      console.error("[YouTube Callback] OAuth error from Google:", error);
      return res.redirect("/dashboard?youtube_error=" + encodeURIComponent(error as string));
    }

    if (!code) {
      console.error("[YouTube Callback] No code received");
      return res.redirect("/dashboard?youtube_error=no_code");
    }

    try {
      const baseUrl = process.env.BASE_URL;
      console.log("[YouTube Callback] BASE_URL:", baseUrl);
      if (!baseUrl) {
        console.error("[YouTube Callback] BASE_URL environment variable is not set");
        return res.redirect("/dashboard?youtube_error=configuration_error");
      }
      const redirectUri = `${baseUrl}/api/auth/youtube/callback`;
      console.log("[YouTube Callback] Using redirect URI:", redirectUri);
      
      // Exchange code for tokens
      let tokens;
      try {
        console.log("[YouTube Callback] Exchanging code for tokens...");
        tokens = await exchangeCodeForTokens(code as string, redirectUri);
        console.log("[YouTube Callback] Token exchange successful");
      } catch (exchangeErr: any) {
        console.error("[YouTube Callback] Token exchange failed:", exchangeErr.message);
        return res.redirect("/dashboard?youtube_error=token_exchange_failed");
      }
      
      if (tokens.error) {
        console.error("[YouTube Callback] Token exchange returned error:", tokens.error, tokens.error_description);
        return res.redirect("/dashboard?youtube_error=" + encodeURIComponent(tokens.error_description || tokens.error));
      }

      // Get channel info
      console.log("[YouTube Callback] Fetching channel info...");
      const channelData = await getYoutubeChannelInfo(tokens.access_token);
      const channel = channelData.items?.[0];
      console.log("[YouTube Callback] Channel:", channel?.snippet?.title || "No channel found");

      const userId = req.googleUser.email;
      console.log("[YouTube Callback] User:", userId);
      
      // Save the connection
      console.log("[YouTube Callback] Saving connection to database...");
      const connectionResult = await storage.upsertYoutubeConnection({
        userId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000)
          : null,
        channelId: channel?.id || null,
        channelTitle: channel?.snippet?.title || null,
      });
      console.log("[YouTube Callback] Connection saved successfully");

      // Persist YouTube channel stats (subscriber count, total views)
      if (channel?.statistics) {
        const subCount = parseInt(channel.statistics.subscriberCount || "0", 10);
        const viewCount = parseInt(channel.statistics.viewCount || "0", 10);
        await storage.updateYoutubeStats(connectionResult.id, {
          subscriberCount: subCount,
          totalViewCount: viewCount,
        });
        console.log(`[YouTube Callback] Stats saved: ${subCount} subscribers, ${viewCount} total views`);
      }

      // AUTO-SYNC DISABLED: User requested manual sync only via dashboard button
      // setImmediate(async () => {
      //   try {
      //     console.log(`[OAuth] Triggering video indexer for user: ${userId}`);
      //     const result = await runIndexerForUser(userId);
      //     console.log(`[OAuth] Indexer completed: indexed ${result.indexed}, filtered ${result.filtered}`);
      //   } catch (indexerError: any) {
      //     console.error(`[OAuth] Indexer failed:`, indexerError.message || indexerError);
      //   }
      // });

      // Redirect to dashboard with success flag
      console.log("[YouTube Callback] Success - redirecting to dashboard");
      res.redirect("/dashboard?youtube_connected=true");
    } catch (err: any) {
      console.error("[YouTube Callback] Unexpected error:", err.message || err, err.stack);
      res.redirect("/dashboard?youtube_error=connection_failed");
    }
  });

  // Get current user's YouTube connection status
  // Debug endpoint: probe YouTube Analytics API to verify the
  // yt-analytics.readonly scope is wired into the connected user's token
  // and that the actual analytics queries return data.
  //
  // Requires the user to have disconnected and reconnected YouTube AFTER
  // commit 0a9e455 (which added yt-analytics.readonly to YOUTUBE_SCOPES).
  // Existing tokens issued before that commit will fail the analytics
  // calls with a scope-related 403.
  //
  // Tests:
  //   1. Token introspection — does the access token have the new scope?
  //   2. Channel basic info (uses youtube.readonly) — control test, should always work
  //   3. Channel-level analytics: views, subscribersGained, etc.
  //   4. Audience demographics: ageGroup x gender breakdown
  //   5. Top countries: country breakdown by views
  app.get("/api/debug/yt-analytics-test", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const authEmail = req.authEmail;

    let connection = await storage.getYoutubeConnection(userId);
    if (!connection && authEmail && authEmail !== userId) {
      connection = await storage.getYoutubeConnection(authEmail);
    }
    if (!connection) {
      return res.status(404).json({ error: "No YouTube connection found. Connect YouTube first." });
    }

    let accessToken = connection.accessToken;

    // Refresh if expired
    if (connection.expiresAt && new Date(connection.expiresAt) < new Date()) {
      if (connection.refreshToken) {
        const refreshed = await refreshAccessToken(connection.refreshToken);
        if (refreshed) {
          accessToken = refreshed.access_token;
          await storage.upsertYoutubeConnection({
            userId: connection.userId,
            accessToken: refreshed.access_token,
            refreshToken: connection.refreshToken,
            expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
            channelId: connection.channelId,
            channelTitle: connection.channelTitle,
          });
        }
      }
    }

    const results: Record<string, any> = {
      connection: {
        channelId: connection.channelId,
        channelTitle: connection.channelTitle,
        expiresAt: connection.expiresAt,
        hasRefreshToken: !!connection.refreshToken,
      },
      tests: {},
    };

    const tryFetch = async (name: string, url: string) => {
      try {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        const data = await r.json();
        results.tests[name] = { ok: r.ok, status: r.status, data };
      } catch (err: any) {
        results.tests[name] = { ok: false, error: err?.message || String(err) };
      }
    };

    // --- Test 1: token introspection — what scopes does this token have? ---
    try {
      const r = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${accessToken}`);
      const data = await r.json();
      results.tests["1_token_info"] = { ok: r.ok, status: r.status, data };
    } catch (err: any) {
      results.tests["1_token_info"] = { ok: false, error: err?.message || String(err) };
    }

    // --- Test 2: control — fetch channel basic info (uses youtube.readonly) ---
    await tryFetch(
      "2_channel_basic",
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true"
    );

    // --- Tests 3-5: YouTube Analytics API ---
    // The Analytics API uses a different host and a date range is required.
    // We use a 90-day window ending today.
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Channel-level metrics (no dimensions): views, subscribersGained, etc.
    await tryFetch(
      "3_channel_metrics",
      `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=${startDate}&endDate=${endDate}&metrics=views,subscribersGained,estimatedMinutesWatched,averageViewDuration`
    );

    // Audience demographics: age + gender breakdown
    await tryFetch(
      "4_audience_demographics",
      `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=${startDate}&endDate=${endDate}&dimensions=ageGroup,gender&metrics=viewerPercentage`
    );

    // Top countries by views
    await tryFetch(
      "5_top_countries",
      `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=${startDate}&endDate=${endDate}&dimensions=country&metrics=views&sort=-views&maxResults=10`
    );

    // Surface scopes from token_info
    const tokenInfo = results.tests["1_token_info"]?.data;
    const grantedScopesRaw: string = tokenInfo?.scope || "";
    const grantedScopes = grantedScopesRaw.split(" ").filter(Boolean);
    const hasAnalyticsScope = grantedScopes.includes("https://www.googleapis.com/auth/yt-analytics.readonly");

    const summary = Object.entries(results.tests).map(([name, r]: [string, any]) => ({
      test: name,
      ok: !!r.ok,
      status: r.status ?? null,
      errorCode: r.data?.error?.code ?? null,
      errorReason: r.data?.error?.errors?.[0]?.reason ?? null,
      errorMessage: r.data?.error?.message ?? r.error ?? null,
      skipped: r.skipped ?? null,
    }));

    res.json({
      ...results,
      grantedScopes,
      hasAnalyticsScope,
      summary,
    });
  });

  app.get("/api/auth/youtube/status", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const authEmail = req.authEmail;
    console.log(`[YouTube Status] Checking for userId: ${userId}, email: ${authEmail}`);
    
    // Try to find connection by user ID first, then by email as fallback
    let connection = await storage.getYoutubeConnection(userId);
    if (!connection && authEmail && authEmail !== userId) {
      connection = await storage.getYoutubeConnection(authEmail);
    }
    console.log(`[YouTube Status] Connection found: ${!!connection}, channelTitle: ${connection?.channelTitle || 'none'}`);
    
    if (connection) {
      res.json({
        connected: true,
        channelId: connection.channelId,
        channelTitle: connection.channelTitle,
      });
    } else {
      res.json({ connected: false });
    }
  });

  // Refresh YouTube channel stats (subscriber count, total views)
  app.get("/api/youtube/refresh-stats", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authUserId;
      const authEmail = req.authEmail;

      let connection = await storage.getYoutubeConnection(userId);
      if (!connection && authEmail && authEmail !== userId) {
        connection = await storage.getYoutubeConnection(authEmail);
      }

      if (!connection) {
        return res.status(404).json({ error: "No YouTube connection found" });
      }

      const channelData = await getYoutubeChannelInfo(connection.accessToken);
      const channel = channelData.items?.[0];

      if (!channel?.statistics) {
        return res.status(404).json({ error: "Could not fetch channel statistics" });
      }

      const subCount = parseInt(channel.statistics.subscriberCount || "0", 10);
      const viewCount = parseInt(channel.statistics.viewCount || "0", 10);

      await storage.updateYoutubeStats(connection.id, {
        subscriberCount: subCount,
        totalViewCount: viewCount,
      });

      console.log(`[YouTube Stats Refresh] Updated: ${subCount} subscribers, ${viewCount} views`);
      res.json({
        success: true,
        subscriberCount: subCount,
        totalViewCount: viewCount
      });
    } catch (err: any) {
      console.error("[YouTube Stats Refresh] Error:", err.message);
      res.status(500).json({ error: "Failed to refresh stats" });
    }
  });

  // Disconnect YouTube
  app.delete("/api/auth/youtube", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const userEmail = req.authEmail;
    console.log(`[YouTube Disconnect] Disconnecting for userId: ${userId}, email: ${userEmail}`);
    await storage.deleteYoutubeConnection(userId, userEmail);
    // Pass both userId and email to ensure all videos are deleted (handles legacy data)
    await storage.deleteVideoIndex(userId, userEmail);
    res.json({ success: true });
  });

  // Clear all videos from library (for removing ghost/orphaned videos)
  app.delete("/api/video-index/clear-all", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const userEmail = req.authEmail;
    console.log(`[Clear Library] Clearing all videos for userId: ${userId}, email: ${userEmail}`);
    await storage.deleteVideoIndex(userId, userEmail);
    res.json({ success: true, message: "All videos cleared from library" });
  });

  // Move a video to trash (soft delete — recoverable)
  app.delete("/api/videos/:videoId", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      const userId = req.authEmail || req.authUserId;
      if (video.userId !== userId && !req.isAdmin) {
        return res.status(403).json({ error: "Not authorized to delete this video" });
      }

      const trashed = await storage.trashVideo(videoId);
      console.log(`[Trash Video] Moved video ${videoId} to trash: ${trashed?.title}`);
      res.json({ success: true, trashed: { id: videoId, title: trashed?.title } });
    } catch (err: any) {
      console.error("[Trash Video] Error:", err.message);
      res.status(500).json({ error: "Failed to trash video" });
    }
  });

  // Get trashed videos
  app.get("/api/videos/trash", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authUserId;
      const authEmail = req.authEmail;
      const videos = await storage.getTrashedVideos(userId, authEmail);
      res.json({ videos, count: videos.length });
    } catch (err: any) {
      console.error("[Trash List] Error:", err.message);
      res.status(500).json({ error: "Failed to get trashed videos" });
    }
  });

  // Restore a video from trash
  app.post("/api/videos/:videoId/restore", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      const userId = req.authEmail || req.authUserId;
      if (video.userId !== userId && !req.isAdmin) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const restored = await storage.restoreVideo(videoId);
      console.log(`[Restore Video] Restored video ${videoId}: ${restored?.title}`);
      res.json({ success: true, restored: { id: videoId, title: restored?.title } });
    } catch (err: any) {
      console.error("[Restore Video] Error:", err.message);
      res.status(500).json({ error: "Failed to restore video" });
    }
  });

  // Permanently delete a video (from trash only)
  app.delete("/api/videos/:videoId/permanent", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!video.deletedAt) return res.status(400).json({ error: "Video must be in trash first" });

      const userId = req.authEmail || req.authUserId;
      if (video.userId !== userId && !req.isAdmin) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // Delete file from storage
      if (video.filePath) {
        try {
          if (video.filePath.startsWith("/storage/")) {
            const { deleteFromStorage, objectKeyFromServeUrl } = await import("./lib/objectStorage");
            await deleteFromStorage(objectKeyFromServeUrl(video.filePath));
          } else {
            const absolutePath = path.resolve(video.filePath);
            if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
          }
        } catch { /* non-fatal */ }
      }

      const deleted = await storage.permanentlyDeleteVideo(videoId);
      console.log(`[Permanent Delete] Permanently deleted video ${videoId}: ${deleted?.title}`);
      res.json({ success: true, deleted: { id: videoId, title: deleted?.title } });
    } catch (err: any) {
      console.error("[Permanent Delete] Error:", err.message);
      res.status(500).json({ error: "Failed to permanently delete video" });
    }
  });

  // Rename / update a video title (also renames local file on disk)
  app.patch("/api/videos/:videoId", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      // Dual-id ownership check: videos can be keyed by either email (file
      // uploads) or UUID (IG/FB imports). Match either to allow edits across
      // both paths.
      const isOwner = video.userId === req.authUserId || video.userId === req.authEmail;
      if (!isOwner) {
        return res.status(403).json({ error: "Not authorized to update this video" });
      }

      const { title, category, subcategory } = req.body;
      if (!title && !category && subcategory === undefined) return res.status(400).json({ error: "title, category, or subcategory is required" });

      const updates: any = {};

      // Rename file on disk if local upload and title changed
      if (title) {
        updates.title = title;
        let newFilePath = video.filePath;
        if (video.filePath) {
          const oldPath = path.resolve(video.filePath);
          if (fs.existsSync(oldPath)) {
            const ext = path.extname(oldPath);
            const dir = path.dirname(oldPath);
            const safeName = title.replace(/[^a-zA-Z0-9\s\-_]/g, "").replace(/\s+/g, "-");
            const newPath = path.join(dir, `${safeName}${ext}`);
            fs.renameSync(oldPath, newPath);
            newFilePath = newPath;
            console.log(`[Update Video] Renamed file: ${oldPath} → ${newPath}`);
          }
        }
        updates.filePath = newFilePath;
      }

      if (category) {
        updates.category = category;
      }

      if (subcategory !== undefined) {
        updates.subcategory = subcategory;
      }

      await storage.updateVideoIndex(videoId, updates);
      res.json({ success: true, title: title || video.title, category: category || video.category, subcategory: subcategory !== undefined ? subcategory : video.subcategory });
    } catch (err: any) {
      console.error("[Rename Video] Error:", err.message);
      res.status(500).json({ error: "Failed to rename video" });
    }
  });

  // Admin endpoint to add a video entry directly (for local files)
  app.post("/api/video-index/add-local", isFlexibleAuthenticated, async (req: any, res) => {
    const userEmail = req.authEmail;
    
    // Only allow admin emails
    const adminEmails = ["martin@gofullscale.co", "martin@whtwrks.com", "martincekechukwu@gmail.com", "thekimkwilson@gmail.com", "tamara@whtwrks.com"];
    if (!adminEmails.includes(userEmail)) {
      return res.status(403).json({ error: "Admin only endpoint" });
    }

    const { title, description, filePath, platform = "upload" } = req.body;
    
    if (!title || !filePath) {
      return res.status(400).json({ error: "Title and filePath are required" });
    }

    try {
      const videoId = `local-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const video = await storage.upsertVideoIndex({
        userId: userEmail,
        youtubeId: videoId,
        title,
        description: description || `Local video file: ${title}`,
        platform,
        filePath,
        status: "pending",
        priorityScore: 100,
        viewCount: 0,
      });
      
      console.log(`[Add Local Video] Added video: ${title} with filePath: ${filePath}`);
      res.json({ success: true, video });
    } catch (error: any) {
      console.error("[Add Local Video] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Seed demo video endpoint (uses secret key for external access)
  app.get("/api/seed-demo-video", async (req, res) => {
    const secretKey = req.query.key;
    if (secretKey !== process.env.SESSION_SECRET?.substring(0, 16)) {
      return res.status(403).json({ error: "Invalid key" });
    }

    try {
      const video = await storage.upsertVideoIndex({
        userId: "martin@gofullscale.co",
        youtubeId: `hero-local-${Date.now()}`,
        title: "Hero Video - Local Test",
        description: "Local video file for testing surface detection scanning",
        platform: "upload",
        filePath: "/home/runner/workspace/public/hero_video.mp4",
        status: "pending",
        priorityScore: 100,
        viewCount: 0,
      });
      
      console.log(`[Seed Demo] Added hero video with ID: ${video.id}`);
      res.json({ success: true, video });
    } catch (error: any) {
      console.error("[Seed Demo] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Disconnect Facebook (also clears Instagram since they share auth)
  app.delete("/api/auth/facebook", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const userEmail = req.authEmail;
    console.log(`[Facebook Disconnect] Disconnecting for userId: ${userId}, email: ${userEmail}`);
    
    try {
      // Find user by ID or email
      let user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user.length && userEmail) {
        user = await db.select().from(users).where(eq(users.email, userEmail)).limit(1);
      }
      
      if (user.length) {
        // Clear Facebook and Instagram data (they share auth)
        await db.update(users).set({
          facebookId: null,
          facebookPageId: null,
          facebookPageName: null,
          facebookFollowers: null,
          facebookAccessToken: null,
          instagramBusinessId: null,
          instagramHandle: null,
          instagramFollowers: null,
          instagramId: null,
        }).where(eq(users.id, user[0].id));
        console.log(`[Facebook Disconnect] Cleared Facebook/Instagram data for user ${user[0].id}`);
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("[Facebook Disconnect] Error:", error);
      res.status(500).json({ error: "Failed to disconnect Facebook" });
    }
  });

  // Disconnect Twitch
  app.delete("/api/auth/twitch", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const userEmail = req.authEmail;
    console.log(`[Twitch Disconnect] Disconnecting for userId: ${userId}, email: ${userEmail}`);
    
    try {
      // Find user by ID or email
      let user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user.length && userEmail) {
        user = await db.select().from(users).where(eq(users.email, userEmail)).limit(1);
      }
      
      if (user.length) {
        // Clear Twitch data
        await db.update(users).set({
          twitchId: null,
        }).where(eq(users.id, user[0].id));
        console.log(`[Twitch Disconnect] Cleared Twitch data for user ${user[0].id}`);
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("[Twitch Disconnect] Error:", error);
      res.status(500).json({ error: "Failed to disconnect Twitch" });
    }
  });

  // Sync YouTube videos from API to database
  app.post("/api/youtube/sync", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const authEmail = req.authEmail;
    console.log(`[YouTube Sync] Syncing videos for userId: ${userId}`);
    
    // Find YouTube connection
    let connection = await storage.getYoutubeConnection(userId);
    if (!connection && authEmail && authEmail !== userId) {
      connection = await storage.getYoutubeConnection(authEmail);
    }
    
    if (!connection) {
      return res.status(400).json({ error: "YouTube not connected" });
    }

    try {
      let accessToken = connection.accessToken;
      
      // Refresh token if expired
      if (connection.expiresAt && new Date(connection.expiresAt) < new Date()) {
        if (connection.refreshToken) {
          const refreshed = await refreshAccessToken(connection.refreshToken);
          if (refreshed) {
            accessToken = refreshed.access_token;
            await storage.upsertYoutubeConnection({
              userId: connection.userId,
              accessToken: refreshed.access_token,
              refreshToken: connection.refreshToken,
              expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
              channelId: connection.channelId,
              channelTitle: connection.channelTitle,
            });
          }
        }
      }

      // Get channel info for uploads playlist
      const channelData = await getYoutubeChannelInfo(accessToken);
      const channel = channelData.items?.[0];
      const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads;

      if (!uploadsPlaylistId) {
        return res.json({ success: true, imported: 0, message: "No uploads found on channel" });
      }

      // Get up to 50 videos from YouTube
      const videosData = await getYoutubeVideos(accessToken, uploadsPlaylistId, 50);
      const ytVideos = videosData.items || [];

      // Playlist endpoint returns snippet+contentDetails but NOT statistics.
      // Fetch view counts in a separate batch call so synced videos don't
      // land with viewCount=0 (the original bug — every auto-imported video
      // showed "0 views" in the library because this step was missing).
      const ytIds: string[] = ytVideos
        .map((item: any) => item.contentDetails?.videoId || item.id)
        .filter(Boolean);
      const statsMap: Record<string, { viewCount: number; duration: string }> = {};
      for (let i = 0; i < ytIds.length; i += 50) {
        const batch = ytIds.slice(i, i + 50);
        try {
          const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${batch.join(",")}`;
          const statsRes = await fetch(statsUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
          const statsData = await statsRes.json();
          for (const v of (statsData.items || [])) {
            statsMap[v.id] = {
              viewCount: parseInt(v.statistics?.viewCount || "0"),
              duration: v.contentDetails?.duration || "",
            };
          }
        } catch (err) {
          console.error(`[YouTube Sync] Failed to fetch stats batch:`, err);
        }
      }

      let importedCount = 0;
      for (const item of ytVideos) {
        const videoId = item.contentDetails?.videoId || item.id;
        const stats = statsMap[videoId];
        try {
          await storage.upsertVideoIndex({
            userId: userId,
            youtubeId: videoId,
            title: item.snippet.title,
            description: item.snippet.description || '',
            thumbnailUrl: getYouTubeThumbnailWithFallback(videoId),
            platform: 'youtube',
            viewCount: stats?.viewCount ?? 0,
            status: 'Pending Scan',
            priorityScore: 50,
          });
          importedCount++;
        } catch (err) {
          console.error(`[YouTube Sync] Failed to import video ${videoId}:`, err);
        }
      }

      console.log(`[YouTube Sync] Imported ${importedCount} videos for user ${userId}`);
      res.json({ success: true, imported: importedCount });
    } catch (err: any) {
      console.error("[YouTube Sync] Error:", err);
      res.status(500).json({ error: "Failed to sync YouTube videos" });
    }
  });

  // ─── YouTube Video Picker: Browse + Import Selected ────────────

  // GET /api/youtube/browse — List user's YouTube videos WITHOUT importing
  app.get("/api/youtube/browse", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const authEmail = req.authEmail;
    const pageToken = req.query.pageToken as string | undefined;
    const maxResults = Math.min(parseInt(req.query.maxResults as string) || 25, 50);

    try {
      let connection = await storage.getYoutubeConnection(userId);
      if (!connection && authEmail && authEmail !== userId) {
        connection = await storage.getYoutubeConnection(authEmail);
      }
      if (!connection) return res.status(400).json({ error: "YouTube not connected" });

      // Refresh token if expired
      let accessToken = connection.accessToken;
      if (connection.expiresAt && new Date(connection.expiresAt) < new Date()) {
        if (connection.refreshToken) {
          const refreshed = await refreshAccessToken(connection.refreshToken);
          if (refreshed) {
            accessToken = refreshed.access_token;
            await storage.upsertYoutubeConnection({
              userId: connection.userId,
              accessToken: refreshed.access_token,
              refreshToken: connection.refreshToken,
              expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
              channelId: connection.channelId,
              channelTitle: connection.channelTitle,
            });
          }
        }
      }

      // Get uploads playlist
      const channelData = await getYoutubeChannelInfo(accessToken);
      const channel = channelData.items?.[0];
      const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploadsPlaylistId) {
        return res.json({ videos: [], nextPageToken: null, totalResults: 0 });
      }

      // Fetch playlist items (paginated)
      let url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}`;
      if (pageToken) url += `&pageToken=${pageToken}`;

      const playlistRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const playlistData = await playlistRes.json();
      const items = playlistData.items || [];

      // Fetch video stats (viewCount, duration) in batch
      const videoIds = items.map((item: any) => item.contentDetails?.videoId || item.id).filter(Boolean);
      let statsMap: Record<string, { viewCount: number; duration: string }> = {};
      if (videoIds.length > 0) {
        const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds.join(",")}`;
        const statsRes = await fetch(statsUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        const statsData = await statsRes.json();
        for (const v of (statsData.items || [])) {
          statsMap[v.id] = {
            viewCount: parseInt(v.statistics?.viewCount || "0"),
            duration: v.contentDetails?.duration || "",
          };
        }
      }

      // Check which are already imported
      const existingVideos = await storage.getVideosByYoutubeIds(videoIds);
      const importedIds = new Set(existingVideos.map((v: any) => v.youtubeId));

      const videos = items.map((item: any) => {
        const ytId = item.contentDetails?.videoId || item.id;
        const stats = statsMap[ytId] || {};
        return {
          youtubeId: ytId,
          title: item.snippet?.title || "Untitled",
          description: (item.snippet?.description || "").substring(0, 200),
          thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
          publishedAt: item.snippet?.publishedAt || null,
          viewCount: stats.viewCount || 0,
          duration: stats.duration || "",
          alreadyImported: importedIds.has(ytId),
        };
      });

      res.json({
        videos,
        nextPageToken: playlistData.nextPageToken || null,
        totalResults: playlistData.pageInfo?.totalResults || videos.length,
        channelTitle: channel?.snippet?.title || null,
      });
    } catch (err: any) {
      console.error("[YouTube Browse] Error:", err);
      res.status(500).json({ error: "Failed to browse YouTube videos" });
    }
  });

  // POST /api/youtube/import-selected — Import only selected YouTube videos
  app.post("/api/youtube/import-selected", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const authEmail = req.authEmail;
    const { videoIds } = req.body || {};

    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      return res.status(400).json({ error: "videoIds array required" });
    }
    if (videoIds.length > 200) {
      return res.status(400).json({ error: "Maximum 200 videos per import" });
    }

    try {
      let connection = await storage.getYoutubeConnection(userId);
      if (!connection && authEmail && authEmail !== userId) {
        connection = await storage.getYoutubeConnection(authEmail);
      }
      if (!connection) return res.status(400).json({ error: "YouTube not connected" });

      let accessToken = connection.accessToken;
      if (connection.expiresAt && new Date(connection.expiresAt) < new Date()) {
        if (connection.refreshToken) {
          const refreshed = await refreshAccessToken(connection.refreshToken);
          if (refreshed) accessToken = refreshed.access_token;
        }
      }

      // Fetch all video details first, batch-categorize via AI, then insert.
      // Mirrors the IG/FB import path so YouTube imports also land with
      // category/subcategory/isEvergreen populated rather than null.
      const allItems: any[] = [];
      for (let i = 0; i < videoIds.length; i += 50) {
        const batch = videoIds.slice(i, i + 50);
        const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${batch.join(",")}`;
        const vidRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        const vidData = await vidRes.json();
        for (const item of (vidData.items || [])) allItems.push(item);
      }

      const categorizations = await categorizeVideos(
        allItems.map(item => ({
          title: item.snippet?.title || "",
          description: item.snippet?.description || "",
        }))
      );

      let importedCount = 0;
      let skippedCount = 0;
      for (let i = 0; i < allItems.length; i++) {
        const item = allItems[i];
        const cat = categorizations[i];
        try {
          await storage.upsertVideoIndex({
            userId,
            youtubeId: item.id,
            title: item.snippet.title,
            description: item.snippet.description || "",
            thumbnailUrl: getYouTubeThumbnailWithFallback(item.id),
            platform: "youtube",
            viewCount: parseInt(item.statistics?.viewCount || "0"),
            status: "Pending Scan",
            priorityScore: 50,
            category: cat.category,
            subcategory: cat.subcategory,
            isEvergreen: cat.isEvergreen,
          });
          importedCount++;
        } catch {
          skippedCount++;
        }
      }

      console.log(`[YouTube Import] Imported ${importedCount}, skipped ${skippedCount} for user ${userId}`);
      res.json({ success: true, imported: importedCount, skipped: skippedCount });
    } catch (err: any) {
      console.error("[YouTube Import] Error:", err);
      res.status(500).json({ error: "Failed to import selected videos" });
    }
  });

  // SPIKE: Harmonize a product image into a scene at a detected surface's
  // bounding box, using fal.ai ACE++. Returns the harmonized composite URL.
  // Test rig only — not yet wired into the placement UI. Hit with:
  //   POST /api/placement/harmonize
  //   { surfaceId: 137777, productImageUrl: "https://...png", prompt?: "..." }
  app.post("/api/placement/harmonize", isFlexibleAuthenticated, async (req: any, res) => {
    const { surfaceId, productImageUrl, prompt } = req.body || {};
    if (typeof surfaceId !== "number" || !productImageUrl) {
      return res.status(400).json({ error: "Body must include { surfaceId: number, productImageUrl: string }" });
    }

    const [surface] = await db
      .select()
      .from(detectedSurfaces)
      .where(eq(detectedSurfaces.id, surfaceId))
      .limit(1);
    if (!surface) return res.status(404).json({ error: "Surface not found" });

    const video = await storage.getVideoById(surface.videoId);
    if (!video) return res.status(404).json({ error: "Parent video not found" });

    const isOwner = video.userId === req.authUserId || video.userId === req.authEmail;
    if (!isOwner) return res.status(403).json({ error: "Not authorized" });

    // Resolve the scene frame at the surface's timestamp. Frames live in GCS
    // at public/uploads/frames/<videoId>/frame_<ts>s.jpg.
    const ts = Math.floor(parseFloat(String(surface.timestamp)));
    const frameKey = `public/uploads/frames/${surface.videoId}/frame_${ts}s.jpg`;
    let sceneBuffer: Buffer;
    try {
      sceneBuffer = await readFileFromStorage(frameKey);
    } catch (err: any) {
      return res.status(404).json({
        error: "Scene frame not found in storage",
        detail: err?.message,
        frameKey,
      });
    }

    // Get frame dimensions for mask building.
    const meta = await sharp(sceneBuffer).metadata();
    const frameW = meta.width || 1280;
    const frameH = meta.height || 720;

    const result = await harmonizeProductIntoScene({
      sceneImage: sceneBuffer,
      productImage: productImageUrl,
      bbox: {
        x: parseFloat(String(surface.boundingBoxX)),
        y: parseFloat(String(surface.boundingBoxY)),
        width: parseFloat(String(surface.boundingBoxWidth)),
        height: parseFloat(String(surface.boundingBoxHeight)),
      },
      frameDimensions: { width: frameW, height: frameH },
      prompt,
    });

    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error, elapsedMs: result.elapsedMs });
    }
    res.json({
      success: true,
      imageUrl: result.imageUrl,
      elapsedMs: result.elapsedMs,
      surface: {
        id: surface.id,
        videoId: surface.videoId,
        timestamp: surface.timestamp,
        surfaceType: surface.surfaceType,
        bbox: {
          x: surface.boundingBoxX,
          y: surface.boundingBoxY,
          width: surface.boundingBoxWidth,
          height: surface.boundingBoxHeight,
        },
      },
    });
  });

  // Stream a video's source bytes for in-app playback. Downloads on demand
  // (cached in /tmp for ~1 hour) so creators + brands can watch without
  // leaving the app — no iframe to YouTube/IG/FB. Supports HTTP Range so
  // <video> seeking works. Source bytes never get persisted to GCS; the
  // cache is per-instance ephemeral.
  app.get("/api/video/:id/source", isFlexibleAuthenticated, async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

    const video = await storage.getVideoById(videoId);
    if (!video) return res.status(404).json({ error: "Video not found" });

    const isOwner = video.userId === req.authUserId || video.userId === req.authEmail;
    if (!isOwner) return res.status(403).json({ error: "Not authorized" });

    let sourcePath: string;
    try {
      sourcePath = await getSourcePath(video);
    } catch (err: any) {
      console.error(`[Video Source] ${videoId}: ${err.message}`);
      return res.status(502).json({ error: "Source unavailable", detail: err.message });
    }

    // Range request handling — required for <video> seeking and partial loads.
    const stat = fs.statSync(sourcePath);
    const fileSize = stat.size;
    const range = req.headers.range as string | undefined;

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (!match) return res.status(416).end();
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      if (start >= fileSize || end >= fileSize) {
        res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
        return;
      }
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/mp4",
        "Cache-Control": "private, max-age=3600",
      });
      fs.createReadStream(sourcePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    });
    fs.createReadStream(sourcePath).pipe(res);
  });

  // Get indexed videos for the user's library.
  // Uses isFlexibleAuthenticated + dual-id (UUID OR email) so videos
  // imported under either identifier are returned together — same pattern
  // as /api/video-scan, the public profile endpoint, the PATCH endpoint,
  // and the backfill endpoint. The previous email-only filter was hiding
  // most videos from users whose imports landed under their UUID.
  app.get("/api/video-index", isFlexibleAuthenticated, async (req: any, res) => {
    const authUserId = req.authUserId;
    const authEmail = req.authEmail;
    const videos = await storage.getVideoIndex(authUserId, authEmail);
    res.json({ videos, total: videos.length });
  });

  // Static demo videos for pitch mode - NEVER queries database
  // Includes BOTH camelCase AND snake_case keys for full compatibility
  // Status distribution: 15 Scan Complete, 3 Scanning, 2 Scan Failed
  const STATIC_DEMO_VIDEOS = [
    { id: 1001, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-1", youtube_id: "demo-1", title: "Desk Setup 2026", description: "The ultimate workspace setup for productivity.", viewCount: 1250000, view_count: 1250000, thumbnailUrl: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 95, priority_score: 95, publishedAt: "2025-12-01T10:00:00Z", published_at: "2025-12-01T10:00:00Z", category: "Tech", isEvergreen: true, is_evergreen: true, duration: "12:34", adOpportunities: 8, opportunities_count: 8, surfaceCount: 8, surface_count: 8, platform: "youtube", createdAt: "2025-12-01T10:00:00Z", created_at: "2025-12-01T10:00:00Z", updatedAt: "2025-12-01T10:00:00Z", updated_at: "2025-12-01T10:00:00Z" },
    { id: 1002, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-2", youtube_id: "demo-2", title: "My Morning Routine", description: "Start your day right with this productive morning routine.", viewCount: 890000, view_count: 890000, thumbnailUrl: "https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 78, priority_score: 78, publishedAt: "2025-11-15T08:00:00Z", published_at: "2025-11-15T08:00:00Z", category: "Lifestyle", isEvergreen: true, is_evergreen: true, duration: "8:45", adOpportunities: 6, opportunities_count: 6, surfaceCount: 6, surface_count: 6, platform: "youtube", createdAt: "2025-11-15T08:00:00Z", created_at: "2025-11-15T08:00:00Z", updatedAt: "2025-11-15T08:00:00Z", updated_at: "2025-11-15T08:00:00Z" },
    { id: 1003, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-3", youtube_id: "demo-3", title: "Dream Gaming Setup", description: "Building the ultimate gaming battlestation.", viewCount: 2100000, view_count: 2100000, thumbnailUrl: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 92, priority_score: 92, publishedAt: "2025-10-20T15:00:00Z", published_at: "2025-10-20T15:00:00Z", category: "Gaming", isEvergreen: true, is_evergreen: true, duration: "15:22", adOpportunities: 11, opportunities_count: 11, surfaceCount: 11, surface_count: 11, platform: "youtube", createdAt: "2025-10-20T15:00:00Z", created_at: "2025-10-20T15:00:00Z", updatedAt: "2025-10-20T15:00:00Z", updated_at: "2025-10-20T15:00:00Z" },
    { id: 1004, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-4", youtube_id: "demo-4", title: "Home Office Makeover", description: "Transform your home office on a budget.", viewCount: 675000, view_count: 675000, thumbnailUrl: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 65, priority_score: 65, publishedAt: "2025-09-10T12:00:00Z", published_at: "2025-09-10T12:00:00Z", category: "DIY", isEvergreen: true, is_evergreen: true, duration: "10:15", adOpportunities: 5, opportunities_count: 5, surfaceCount: 5, surface_count: 5, platform: "youtube", createdAt: "2025-09-10T12:00:00Z", created_at: "2025-09-10T12:00:00Z", updatedAt: "2025-09-10T12:00:00Z", updated_at: "2025-09-10T12:00:00Z" },
    { id: 1005, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-5", youtube_id: "demo-5", title: "Tech Gadgets Unboxing", description: "Unboxing the latest and greatest tech gadgets.", viewCount: 1450000, view_count: 1450000, thumbnailUrl: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scanning", scan_status: "pending", priorityScore: 88, priority_score: 88, publishedAt: "2025-08-25T14:00:00Z", published_at: "2025-08-25T14:00:00Z", category: "Tech", isEvergreen: false, is_evergreen: false, duration: "18:30", adOpportunities: 0, opportunities_count: 0, surfaceCount: 0, surface_count: 0, platform: "youtube", createdAt: "2025-08-25T14:00:00Z", created_at: "2025-08-25T14:00:00Z", updatedAt: "2025-08-25T14:00:00Z", updated_at: "2025-08-25T14:00:00Z" },
    { id: 1006, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-6", youtube_id: "demo-6", title: "Cozy Reading Nook", description: "Creating the perfect reading corner.", viewCount: 320000, view_count: 320000, thumbnailUrl: "https://images.unsplash.com/photo-1616588589676-62b3bd4ff6d2?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1616588589676-62b3bd4ff6d2?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 55, priority_score: 55, publishedAt: "2025-07-18T09:00:00Z", published_at: "2025-07-18T09:00:00Z", category: "Lifestyle", isEvergreen: true, is_evergreen: true, duration: "6:30", adOpportunities: 4, opportunities_count: 4, surfaceCount: 4, surface_count: 4, platform: "youtube", createdAt: "2025-07-18T09:00:00Z", created_at: "2025-07-18T09:00:00Z", updatedAt: "2025-07-18T09:00:00Z", updated_at: "2025-07-18T09:00:00Z" },
    { id: 1007, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-7", youtube_id: "demo-7", title: "Studio Tour 2026", description: "A complete tour of my creative studio.", viewCount: 540000, view_count: 540000, thumbnailUrl: "https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 72, priority_score: 72, publishedAt: "2025-06-22T11:00:00Z", published_at: "2025-06-22T11:00:00Z", category: "Vlog", isEvergreen: true, is_evergreen: true, duration: "14:17", adOpportunities: 9, opportunities_count: 9, surfaceCount: 9, surface_count: 9, platform: "youtube", createdAt: "2025-06-22T11:00:00Z", created_at: "2025-06-22T11:00:00Z", updatedAt: "2025-06-22T11:00:00Z", updated_at: "2025-06-22T11:00:00Z" },
    { id: 1008, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-8", youtube_id: "demo-8", title: "Productivity Apps Review", description: "My top productivity apps for 2026.", viewCount: 410000, view_count: 410000, thumbnailUrl: "https://images.unsplash.com/photo-1603481588273-2f908a9a7a1b?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1603481588273-2f908a9a7a1b?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 68, priority_score: 68, publishedAt: "2025-05-30T16:00:00Z", published_at: "2025-05-30T16:00:00Z", category: "Productivity", isEvergreen: false, is_evergreen: false, duration: "11:45", adOpportunities: 7, opportunities_count: 7, surfaceCount: 7, surface_count: 7, platform: "youtube", createdAt: "2025-05-30T16:00:00Z", created_at: "2025-05-30T16:00:00Z", updatedAt: "2025-05-30T16:00:00Z", updated_at: "2025-05-30T16:00:00Z" },
    { id: 1009, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-9", youtube_id: "demo-9", title: "MacBook Pro M5 Review", description: "Is the M5 worth the upgrade?", viewCount: 980000, view_count: 980000, thumbnailUrl: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Failed", scan_status: "failed", priorityScore: 85, priority_score: 85, publishedAt: "2025-04-15T10:00:00Z", published_at: "2025-04-15T10:00:00Z", category: "Tech", isEvergreen: true, is_evergreen: true, duration: "16:42", adOpportunities: 0, opportunities_count: 0, surfaceCount: 0, surface_count: 0, platform: "youtube", createdAt: "2025-04-15T10:00:00Z", created_at: "2025-04-15T10:00:00Z", updatedAt: "2025-04-15T10:00:00Z", updated_at: "2025-04-15T10:00:00Z" },
    { id: 1010, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-10", youtube_id: "demo-10", title: "Minimalist Living Room", description: "How I transformed my living space.", viewCount: 275000, view_count: 275000, thumbnailUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 52, priority_score: 52, publishedAt: "2025-03-28T13:00:00Z", published_at: "2025-03-28T13:00:00Z", category: "Lifestyle", isEvergreen: true, is_evergreen: true, duration: "9:18", adOpportunities: 3, opportunities_count: 3, surfaceCount: 3, surface_count: 3, platform: "youtube", createdAt: "2025-03-28T13:00:00Z", created_at: "2025-03-28T13:00:00Z", updatedAt: "2025-03-28T13:00:00Z", updated_at: "2025-03-28T13:00:00Z" },
    { id: 1011, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-11", youtube_id: "demo-11", title: "iPhone 17 First Impressions", description: "My first 24 hours with the new iPhone.", viewCount: 1680000, view_count: 1680000, thumbnailUrl: "https://images.unsplash.com/photo-1593642702821-c8da6771f0c6?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1593642702821-c8da6771f0c6?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 91, priority_score: 91, publishedAt: "2025-02-20T08:00:00Z", published_at: "2025-02-20T08:00:00Z", category: "Tech", isEvergreen: false, is_evergreen: false, duration: "13:55", adOpportunities: 10, opportunities_count: 10, surfaceCount: 10, surface_count: 10, platform: "youtube", createdAt: "2025-02-20T08:00:00Z", created_at: "2025-02-20T08:00:00Z", updatedAt: "2025-02-20T08:00:00Z", updated_at: "2025-02-20T08:00:00Z" },
    { id: 1012, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-12", youtube_id: "demo-12", title: "Budget Desk Accessories", description: "The best desk accessories under $50.", viewCount: 520000, view_count: 520000, thumbnailUrl: "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scanning", scan_status: "pending", priorityScore: 63, priority_score: 63, publishedAt: "2025-01-12T14:00:00Z", published_at: "2025-01-12T14:00:00Z", category: "Tech", isEvergreen: true, is_evergreen: true, duration: "11:20", adOpportunities: 0, opportunities_count: 0, surfaceCount: 0, surface_count: 0, platform: "youtube", createdAt: "2025-01-12T14:00:00Z", created_at: "2025-01-12T14:00:00Z", updatedAt: "2025-01-12T14:00:00Z", updated_at: "2025-01-12T14:00:00Z" },
    { id: 1013, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-13", youtube_id: "demo-13", title: "Work From Home Tips", description: "Maximize your productivity working from home.", viewCount: 445000, view_count: 445000, thumbnailUrl: "https://images.unsplash.com/photo-1616594039964-ae9021a400a0?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1616594039964-ae9021a400a0?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 70, priority_score: 70, publishedAt: "2024-12-08T10:00:00Z", published_at: "2024-12-08T10:00:00Z", category: "Productivity", isEvergreen: true, is_evergreen: true, duration: "8:33", adOpportunities: 6, opportunities_count: 6, surfaceCount: 6, surface_count: 6, platform: "youtube", createdAt: "2024-12-08T10:00:00Z", created_at: "2024-12-08T10:00:00Z", updatedAt: "2024-12-08T10:00:00Z", updated_at: "2024-12-08T10:00:00Z" },
    { id: 1014, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-14", youtube_id: "demo-14", title: "Content Creator Setup", description: "Everything you need to start creating.", viewCount: 710000, view_count: 710000, thumbnailUrl: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 77, priority_score: 77, publishedAt: "2024-11-25T15:00:00Z", published_at: "2024-11-25T15:00:00Z", category: "Tech", isEvergreen: true, is_evergreen: true, duration: "14:48", adOpportunities: 12, opportunities_count: 12, surfaceCount: 12, surface_count: 12, platform: "youtube", createdAt: "2024-11-25T15:00:00Z", created_at: "2024-11-25T15:00:00Z", updatedAt: "2024-11-25T15:00:00Z", updated_at: "2024-11-25T15:00:00Z" },
    { id: 1015, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-15", youtube_id: "demo-15", title: "Aesthetic Room Decor", description: "Creating an aesthetic room on a budget.", viewCount: 390000, view_count: 390000, thumbnailUrl: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 58, priority_score: 58, publishedAt: "2024-10-18T09:00:00Z", published_at: "2024-10-18T09:00:00Z", category: "Lifestyle", isEvergreen: true, is_evergreen: true, duration: "7:22", adOpportunities: 4, opportunities_count: 4, surfaceCount: 4, surface_count: 4, platform: "youtube", createdAt: "2024-10-18T09:00:00Z", created_at: "2024-10-18T09:00:00Z", updatedAt: "2024-10-18T09:00:00Z", updated_at: "2024-10-18T09:00:00Z" },
    { id: 1016, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-16", youtube_id: "demo-16", title: "Standing Desk Review", description: "Is a standing desk worth it?", viewCount: 285000, view_count: 285000, thumbnailUrl: "https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Failed", scan_status: "failed", priorityScore: 54, priority_score: 54, publishedAt: "2024-09-05T11:00:00Z", published_at: "2024-09-05T11:00:00Z", category: "Productivity", isEvergreen: true, is_evergreen: true, duration: "10:05", adOpportunities: 0, opportunities_count: 0, surfaceCount: 0, surface_count: 0, platform: "youtube", createdAt: "2024-09-05T11:00:00Z", created_at: "2024-09-05T11:00:00Z", updatedAt: "2024-09-05T11:00:00Z", updated_at: "2024-09-05T11:00:00Z" },
    { id: 1017, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-17", youtube_id: "demo-17", title: "Cable Management Guide", description: "The ultimate guide to cable management.", viewCount: 620000, view_count: 620000, thumbnailUrl: "https://images.unsplash.com/photo-1595225476474-87563907a212?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1595225476474-87563907a212?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 74, priority_score: 74, publishedAt: "2024-08-22T13:00:00Z", published_at: "2024-08-22T13:00:00Z", category: "DIY", isEvergreen: true, is_evergreen: true, duration: "12:38", adOpportunities: 5, opportunities_count: 5, surfaceCount: 5, surface_count: 5, platform: "youtube", createdAt: "2024-08-22T13:00:00Z", created_at: "2024-08-22T13:00:00Z", updatedAt: "2024-08-22T13:00:00Z", updated_at: "2024-08-22T13:00:00Z" },
    { id: 1018, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-18", youtube_id: "demo-18", title: "Mechanical Keyboard Guide", description: "Finding your perfect mechanical keyboard.", viewCount: 830000, view_count: 830000, thumbnailUrl: "https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1585771724684-38269d6639fd?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scanning", scan_status: "pending", priorityScore: 82, priority_score: 82, publishedAt: "2024-07-15T10:00:00Z", published_at: "2024-07-15T10:00:00Z", category: "Tech", isEvergreen: true, is_evergreen: true, duration: "15:10", adOpportunities: 0, opportunities_count: 0, surfaceCount: 0, surface_count: 0, platform: "youtube", createdAt: "2024-07-15T10:00:00Z", created_at: "2024-07-15T10:00:00Z", updatedAt: "2024-07-15T10:00:00Z", updated_at: "2024-07-15T10:00:00Z" },
    { id: 1019, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-19", youtube_id: "demo-19", title: "Monitor Buying Guide", description: "How to choose the right monitor.", viewCount: 490000, view_count: 490000, thumbnailUrl: "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 67, priority_score: 67, publishedAt: "2024-06-28T14:00:00Z", published_at: "2024-06-28T14:00:00Z", category: "Tech", isEvergreen: true, is_evergreen: true, duration: "13:25", adOpportunities: 8, opportunities_count: 8, surfaceCount: 8, surface_count: 8, platform: "youtube", createdAt: "2024-06-28T14:00:00Z", created_at: "2024-06-28T14:00:00Z", updatedAt: "2024-06-28T14:00:00Z", updated_at: "2024-06-28T14:00:00Z" },
    { id: 1020, userId: "demo-creator", user_id: "demo-creator", youtubeId: "demo-20", youtube_id: "demo-20", title: "Day in My Life", description: "A typical day as a content creator.", viewCount: 560000, view_count: 560000, thumbnailUrl: "https://images.unsplash.com/photo-1600494603989-9650cf6ddd3d?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1600494603989-9650cf6ddd3d?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 61, priority_score: 61, publishedAt: "2024-05-10T08:00:00Z", published_at: "2024-05-10T08:00:00Z", category: "Vlog", isEvergreen: false, is_evergreen: false, duration: "10:50", adOpportunities: 7, opportunities_count: 7, surfaceCount: 7, surface_count: 7, platform: "youtube", createdAt: "2024-05-10T08:00:00Z", created_at: "2024-05-10T08:00:00Z", updatedAt: "2024-05-10T08:00:00Z", updated_at: "2024-05-10T08:00:00Z" },
    // Instagram Reels - 15 items with vertical 9:16 aspect ratio
    { id: 2001, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-1", youtube_id: "ig-1", title: "Viral Dance Challenge", description: "Trending dance moves for 2026!", viewCount: 2500000, view_count: 2500000, thumbnailUrl: "https://images.unsplash.com/photo-1504703395950-b89145a5425b?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1504703395950-b89145a5425b?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 94, priority_score: 94, publishedAt: "2026-01-05T12:00:00Z", published_at: "2026-01-05T12:00:00Z", category: "Entertainment", isEvergreen: false, is_evergreen: false, duration: "0:30", adOpportunities: 3, opportunities_count: 3, surfaceCount: 3, surface_count: 3, platform: "instagram", brandName: "FashionNova", brand_name: "FashionNova", createdAt: "2026-01-05T12:00:00Z", created_at: "2026-01-05T12:00:00Z", updatedAt: "2026-01-05T12:00:00Z", updated_at: "2026-01-05T12:00:00Z" },
    { id: 2002, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-2", youtube_id: "ig-2", title: "OOTD Fashion Check", description: "Today's outfit featuring summer vibes.", viewCount: 1800000, view_count: 1800000, thumbnailUrl: "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 89, priority_score: 89, publishedAt: "2026-01-04T14:00:00Z", published_at: "2026-01-04T14:00:00Z", category: "Fashion", isEvergreen: true, is_evergreen: true, duration: "0:45", adOpportunities: 5, opportunities_count: 5, surfaceCount: 5, surface_count: 5, platform: "instagram", brandName: "FashionNova", brand_name: "FashionNova", createdAt: "2026-01-04T14:00:00Z", created_at: "2026-01-04T14:00:00Z", updatedAt: "2026-01-04T14:00:00Z", updated_at: "2026-01-04T14:00:00Z" },
    { id: 2003, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-3", youtube_id: "ig-3", title: "Gym Motivation", description: "5AM workout routine for maximum gains.", viewCount: 3200000, view_count: 3200000, thumbnailUrl: "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 96, priority_score: 96, publishedAt: "2026-01-03T06:00:00Z", published_at: "2026-01-03T06:00:00Z", category: "Fitness", isEvergreen: true, is_evergreen: true, duration: "0:60", adOpportunities: 4, opportunities_count: 4, surfaceCount: 4, surface_count: 4, platform: "instagram", brandName: "GymShark", brand_name: "GymShark", createdAt: "2026-01-03T06:00:00Z", created_at: "2026-01-03T06:00:00Z", updatedAt: "2026-01-03T06:00:00Z", updated_at: "2026-01-03T06:00:00Z" },
    { id: 2004, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-4", youtube_id: "ig-4", title: "Quick Makeup Tutorial", description: "Get ready in 60 seconds flat!", viewCount: 1500000, view_count: 1500000, thumbnailUrl: "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Processing", scan_status: "processing", priorityScore: 82, priority_score: 82, publishedAt: "2026-01-02T10:00:00Z", published_at: "2026-01-02T10:00:00Z", category: "Beauty", isEvergreen: true, is_evergreen: true, duration: "0:58", adOpportunities: 6, opportunities_count: 6, surfaceCount: 6, surface_count: 6, platform: "instagram", brandName: "Bloom", brand_name: "Bloom", createdAt: "2026-01-02T10:00:00Z", created_at: "2026-01-02T10:00:00Z", updatedAt: "2026-01-02T10:00:00Z", updated_at: "2026-01-02T10:00:00Z" },
    { id: 2005, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-5", youtube_id: "ig-5", title: "Street Food Tour", description: "Best tacos in the city!", viewCount: 980000, view_count: 980000, thumbnailUrl: "https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 75, priority_score: 75, publishedAt: "2025-12-28T18:00:00Z", published_at: "2025-12-28T18:00:00Z", category: "Food", isEvergreen: true, is_evergreen: true, duration: "0:45", adOpportunities: 3, opportunities_count: 3, surfaceCount: 3, surface_count: 3, platform: "instagram", brandName: "HelloFresh", brand_name: "HelloFresh", createdAt: "2025-12-28T18:00:00Z", created_at: "2025-12-28T18:00:00Z", updatedAt: "2025-12-28T18:00:00Z", updated_at: "2025-12-28T18:00:00Z" },
    { id: 2006, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-6", youtube_id: "ig-6", title: "Skincare Routine", description: "My holy grail products revealed.", viewCount: 2100000, view_count: 2100000, thumbnailUrl: "https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 91, priority_score: 91, publishedAt: "2025-12-25T09:00:00Z", published_at: "2025-12-25T09:00:00Z", category: "Beauty", isEvergreen: true, is_evergreen: true, duration: "0:55", adOpportunities: 8, opportunities_count: 8, surfaceCount: 8, surface_count: 8, platform: "instagram", brandName: "Bloom", brand_name: "Bloom", createdAt: "2025-12-25T09:00:00Z", created_at: "2025-12-25T09:00:00Z", updatedAt: "2025-12-25T09:00:00Z", updated_at: "2025-12-25T09:00:00Z" },
    { id: 2007, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-7", youtube_id: "ig-7", title: "Sunset Vibes Bali", description: "Golden hour aesthetic in paradise.", viewCount: 4500000, view_count: 4500000, thumbnailUrl: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 98, priority_score: 98, publishedAt: "2025-12-20T17:00:00Z", published_at: "2025-12-20T17:00:00Z", category: "Travel", isEvergreen: true, is_evergreen: true, duration: "0:30", adOpportunities: 2, opportunities_count: 2, surfaceCount: 2, surface_count: 2, platform: "instagram", brandName: "Airbnb", brand_name: "Airbnb", createdAt: "2025-12-20T17:00:00Z", created_at: "2025-12-20T17:00:00Z", updatedAt: "2025-12-20T17:00:00Z", updated_at: "2025-12-20T17:00:00Z" },
    { id: 2008, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-8", youtube_id: "ig-8", title: "Healthy Meal Prep", description: "Week's worth of lunches in 1 hour.", viewCount: 1200000, view_count: 1200000, thumbnailUrl: "https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Processing", scan_status: "processing", priorityScore: 78, priority_score: 78, publishedAt: "2025-12-18T12:00:00Z", published_at: "2025-12-18T12:00:00Z", category: "Food", isEvergreen: true, is_evergreen: true, duration: "0:50", adOpportunities: 5, opportunities_count: 5, surfaceCount: 5, surface_count: 5, platform: "instagram", brandName: "HelloFresh", brand_name: "HelloFresh", createdAt: "2025-12-18T12:00:00Z", created_at: "2025-12-18T12:00:00Z", updatedAt: "2025-12-18T12:00:00Z", updated_at: "2025-12-18T12:00:00Z" },
    { id: 2009, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-9", youtube_id: "ig-9", title: "Apartment Tour NYC", description: "My minimalist NYC apartment.", viewCount: 2800000, view_count: 2800000, thumbnailUrl: "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 93, priority_score: 93, publishedAt: "2025-12-15T14:00:00Z", published_at: "2025-12-15T14:00:00Z", category: "Lifestyle", isEvergreen: true, is_evergreen: true, duration: "0:60", adOpportunities: 10, opportunities_count: 10, surfaceCount: 10, surface_count: 10, platform: "instagram", brandName: "IKEA", brand_name: "IKEA", createdAt: "2025-12-15T14:00:00Z", created_at: "2025-12-15T14:00:00Z", updatedAt: "2025-12-15T14:00:00Z", updated_at: "2025-12-15T14:00:00Z" },
    { id: 2010, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-10", youtube_id: "ig-10", title: "Coffee Art Tutorial", description: "Learn latte art in 60 seconds.", viewCount: 890000, view_count: 890000, thumbnailUrl: "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 72, priority_score: 72, publishedAt: "2025-12-10T08:00:00Z", published_at: "2025-12-10T08:00:00Z", category: "Food", isEvergreen: true, is_evergreen: true, duration: "0:42", adOpportunities: 3, opportunities_count: 3, surfaceCount: 3, surface_count: 3, platform: "instagram", brandName: "Starbucks", brand_name: "Starbucks", createdAt: "2025-12-10T08:00:00Z", created_at: "2025-12-10T08:00:00Z", updatedAt: "2025-12-10T08:00:00Z", updated_at: "2025-12-10T08:00:00Z" },
    { id: 2011, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-11", youtube_id: "ig-11", title: "Yoga Flow Morning", description: "10 min stretch to start your day.", viewCount: 1600000, view_count: 1600000, thumbnailUrl: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 85, priority_score: 85, publishedAt: "2025-12-05T07:00:00Z", published_at: "2025-12-05T07:00:00Z", category: "Fitness", isEvergreen: true, is_evergreen: true, duration: "0:58", adOpportunities: 4, opportunities_count: 4, surfaceCount: 4, surface_count: 4, platform: "instagram", brandName: "Lululemon", brand_name: "Lululemon", createdAt: "2025-12-05T07:00:00Z", created_at: "2025-12-05T07:00:00Z", updatedAt: "2025-12-05T07:00:00Z", updated_at: "2025-12-05T07:00:00Z" },
    { id: 2012, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-12", youtube_id: "ig-12", title: "Sneaker Unboxing", description: "New Jordan drop review!", viewCount: 3100000, view_count: 3100000, thumbnailUrl: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 95, priority_score: 95, publishedAt: "2025-11-28T16:00:00Z", published_at: "2025-11-28T16:00:00Z", category: "Fashion", isEvergreen: false, is_evergreen: false, duration: "0:48", adOpportunities: 6, opportunities_count: 6, surfaceCount: 6, surface_count: 6, platform: "instagram", brandName: "Nike", brand_name: "Nike", createdAt: "2025-11-28T16:00:00Z", created_at: "2025-11-28T16:00:00Z", updatedAt: "2025-11-28T16:00:00Z", updated_at: "2025-11-28T16:00:00Z" },
    { id: 2013, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-13", youtube_id: "ig-13", title: "Hair Care Secrets", description: "How I grew my hair 6 inches.", viewCount: 2400000, view_count: 2400000, thumbnailUrl: "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Processing", scan_status: "processing", priorityScore: 88, priority_score: 88, publishedAt: "2025-11-20T11:00:00Z", published_at: "2025-11-20T11:00:00Z", category: "Beauty", isEvergreen: true, is_evergreen: true, duration: "0:55", adOpportunities: 7, opportunities_count: 7, surfaceCount: 7, surface_count: 7, platform: "instagram", brandName: "Olaplex", brand_name: "Olaplex", createdAt: "2025-11-20T11:00:00Z", created_at: "2025-11-20T11:00:00Z", updatedAt: "2025-11-20T11:00:00Z", updated_at: "2025-11-20T11:00:00Z" },
    { id: 2014, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-14", youtube_id: "ig-14", title: "Protein Shake Recipe", description: "Post-workout fuel that tastes amazing.", viewCount: 750000, view_count: 750000, thumbnailUrl: "https://images.unsplash.com/photo-1622484212850-eb596d769edc?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1622484212850-eb596d769edc?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 68, priority_score: 68, publishedAt: "2025-11-15T15:00:00Z", published_at: "2025-11-15T15:00:00Z", category: "Fitness", isEvergreen: true, is_evergreen: true, duration: "0:35", adOpportunities: 4, opportunities_count: 4, surfaceCount: 4, surface_count: 4, platform: "instagram", brandName: "GymShark", brand_name: "GymShark", createdAt: "2025-11-15T15:00:00Z", created_at: "2025-11-15T15:00:00Z", updatedAt: "2025-11-15T15:00:00Z", updated_at: "2025-11-15T15:00:00Z" },
    { id: 2015, userId: "demo-creator", user_id: "demo-creator", youtubeId: "ig-15", youtube_id: "ig-15", title: "Room Transformation", description: "Before & after glow up!", viewCount: 5200000, view_count: 5200000, thumbnailUrl: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=270&h=480&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=270&h=480&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 99, priority_score: 99, publishedAt: "2025-11-10T13:00:00Z", published_at: "2025-11-10T13:00:00Z", category: "Lifestyle", isEvergreen: true, is_evergreen: true, duration: "0:60", adOpportunities: 12, opportunities_count: 12, surfaceCount: 12, surface_count: 12, platform: "instagram", brandName: "IKEA", brand_name: "IKEA", createdAt: "2025-11-10T13:00:00Z", created_at: "2025-11-10T13:00:00Z", updatedAt: "2025-11-10T13:00:00Z", updated_at: "2025-11-10T13:00:00Z" },
    // Twitch VODs - 4 items
    { id: 3001, userId: "demo-creator", user_id: "demo-creator", youtubeId: "twitch-1", youtube_id: "twitch-1", title: "Twitch Stream VOD - 3 Hours", description: "Epic gaming session with the community.", viewCount: 890000, view_count: 890000, thumbnailUrl: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 88, priority_score: 88, publishedAt: "2026-01-10T20:00:00Z", published_at: "2026-01-10T20:00:00Z", category: "Gaming", isEvergreen: false, is_evergreen: false, duration: "3:14:55", adOpportunities: 8, opportunities_count: 8, surfaceCount: 8, surface_count: 8, platform: "twitch", brandName: "Logitech", brand_name: "Logitech", createdAt: "2026-01-10T20:00:00Z", created_at: "2026-01-10T20:00:00Z", updatedAt: "2026-01-10T20:00:00Z", updated_at: "2026-01-10T20:00:00Z" },
    { id: 3002, userId: "demo-creator", user_id: "demo-creator", youtubeId: "twitch-2", youtube_id: "twitch-2", title: "IRL Stream - Gaming Cafe Tour", description: "Exploring the coolest gaming cafe in town!", viewCount: 456000, view_count: 456000, thumbnailUrl: "https://images.unsplash.com/photo-1603481588273-2f908a9a7a1b?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1603481588273-2f908a9a7a1b?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 72, priority_score: 72, publishedAt: "2026-01-08T18:00:00Z", published_at: "2026-01-08T18:00:00Z", category: "IRL", isEvergreen: true, is_evergreen: true, duration: "2:11:25", adOpportunities: 6, opportunities_count: 6, surfaceCount: 6, surface_count: 6, platform: "twitch", brandName: "Razer", brand_name: "Razer", createdAt: "2026-01-08T18:00:00Z", created_at: "2026-01-08T18:00:00Z", updatedAt: "2026-01-08T18:00:00Z", updated_at: "2026-01-08T18:00:00Z" },
    { id: 3003, userId: "demo-creator", user_id: "demo-creator", youtubeId: "twitch-3", youtube_id: "twitch-3", title: "Just Chatting - Q&A Session", description: "Answering your questions live!", viewCount: 320000, view_count: 320000, thumbnailUrl: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scanning", scan_status: "pending", priorityScore: 65, priority_score: 65, publishedAt: "2026-01-05T21:00:00Z", published_at: "2026-01-05T21:00:00Z", category: "Just Chatting", isEvergreen: false, is_evergreen: false, duration: "1:45:00", adOpportunities: 0, opportunities_count: 0, surfaceCount: 0, surface_count: 0, platform: "twitch", createdAt: "2026-01-05T21:00:00Z", created_at: "2026-01-05T21:00:00Z", updatedAt: "2026-01-05T21:00:00Z", updated_at: "2026-01-05T21:00:00Z" },
    { id: 3004, userId: "demo-creator", user_id: "demo-creator", youtubeId: "twitch-4", youtube_id: "twitch-4", title: "Tournament Highlights", description: "Best moments from the gaming tournament.", viewCount: 1200000, view_count: 1200000, thumbnailUrl: "https://images.unsplash.com/photo-1616588589676-62b3bd4ff6d2?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1616588589676-62b3bd4ff6d2?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 92, priority_score: 92, publishedAt: "2025-12-20T15:00:00Z", published_at: "2025-12-20T15:00:00Z", category: "Gaming", isEvergreen: true, is_evergreen: true, duration: "0:45:30", adOpportunities: 10, opportunities_count: 10, surfaceCount: 10, surface_count: 10, platform: "twitch", brandName: "SteelSeries", brand_name: "SteelSeries", createdAt: "2025-12-20T15:00:00Z", created_at: "2025-12-20T15:00:00Z", updatedAt: "2025-12-20T15:00:00Z", updated_at: "2025-12-20T15:00:00Z" },
    // Facebook Videos - 4 items
    { id: 4001, userId: "demo-creator", user_id: "demo-creator", youtubeId: "fb-1", youtube_id: "fb-1", title: "Facebook Live Replay - Home Tour", description: "Live walkthrough of my new apartment!", viewCount: 2300000, view_count: 2300000, thumbnailUrl: "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 85, priority_score: 85, publishedAt: "2026-01-12T14:00:00Z", published_at: "2026-01-12T14:00:00Z", category: "Lifestyle", isEvergreen: true, is_evergreen: true, duration: "1:25:40", adOpportunities: 9, opportunities_count: 9, surfaceCount: 9, surface_count: 9, platform: "facebook", brandName: "IKEA", brand_name: "IKEA", createdAt: "2026-01-12T14:00:00Z", created_at: "2026-01-12T14:00:00Z", updatedAt: "2026-01-12T14:00:00Z", updated_at: "2026-01-12T14:00:00Z" },
    { id: 4002, userId: "demo-creator", user_id: "demo-creator", youtubeId: "fb-2", youtube_id: "fb-2", title: "Recipe Demo - Easy Pasta", description: "Cook along with me!", viewCount: 890000, view_count: 890000, thumbnailUrl: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 78, priority_score: 78, publishedAt: "2026-01-09T12:00:00Z", published_at: "2026-01-09T12:00:00Z", category: "Food", isEvergreen: true, is_evergreen: true, duration: "0:18:30", adOpportunities: 5, opportunities_count: 5, surfaceCount: 5, surface_count: 5, platform: "facebook", brandName: "HelloFresh", brand_name: "HelloFresh", createdAt: "2026-01-09T12:00:00Z", created_at: "2026-01-09T12:00:00Z", updatedAt: "2026-01-09T12:00:00Z", updated_at: "2026-01-09T12:00:00Z" },
    { id: 4003, userId: "demo-creator", user_id: "demo-creator", youtubeId: "fb-3", youtube_id: "fb-3", title: "Product Review - Smart Home", description: "Testing the latest smart home gadgets.", viewCount: 675000, view_count: 675000, thumbnailUrl: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scanning", scan_status: "pending", priorityScore: 70, priority_score: 70, publishedAt: "2026-01-06T16:00:00Z", published_at: "2026-01-06T16:00:00Z", category: "Tech", isEvergreen: true, is_evergreen: true, duration: "0:22:15", adOpportunities: 0, opportunities_count: 0, surfaceCount: 0, surface_count: 0, platform: "facebook", createdAt: "2026-01-06T16:00:00Z", created_at: "2026-01-06T16:00:00Z", updatedAt: "2026-01-06T16:00:00Z", updated_at: "2026-01-06T16:00:00Z" },
    { id: 4004, userId: "demo-creator", user_id: "demo-creator", youtubeId: "fb-4", youtube_id: "fb-4", title: "Behind the Scenes Vlog", description: "A day in the life of a content creator.", viewCount: 540000, view_count: 540000, thumbnailUrl: "https://images.unsplash.com/photo-1600494603989-9650cf6ddd3d?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1600494603989-9650cf6ddd3d?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", video_url: "/hero_video.mp4", status: "Scan Complete", scan_status: "completed", priorityScore: 68, priority_score: 68, publishedAt: "2025-12-28T10:00:00Z", published_at: "2025-12-28T10:00:00Z", category: "Vlog", isEvergreen: false, is_evergreen: false, duration: "0:15:45", adOpportunities: 4, opportunities_count: 4, surfaceCount: 4, surface_count: 4, platform: "facebook", brandName: "Canon", brand_name: "Canon", createdAt: "2025-12-28T10:00:00Z", created_at: "2025-12-28T10:00:00Z", updatedAt: "2025-12-28T10:00:00Z", updated_at: "2025-12-28T10:00:00Z" },
  ];

  // Generate realistic mock surfaces for demo/pitch mode videos
  function generateDemoSurfaces(videoId: number, demoVideo: { title: string; category: string; thumbnailUrl: string; surfaceCount: number; adOpportunities: number }) {
    const surfaceCount = demoVideo.surfaceCount || demoVideo.adOpportunities || 5;
    if (surfaceCount === 0) return []; // "Scanning" status videos have 0 surfaces

    // Category-specific surface types and scene context
    const CATEGORY_SURFACES: Record<string, Array<{ type: string; context: string; confidence: number }>> = {
      Tech: [
        { type: "Monitor/Screen", context: "Large display visible on desk — ideal for digital product overlay", confidence: 0.94 },
        { type: "Desk Surface", context: "Clean desk surface with good lighting — great for product placement", confidence: 0.91 },
        { type: "Laptop", context: "Laptop visible in frame — screen replacement opportunity", confidence: 0.88 },
        { type: "Keyboard/Peripheral", context: "Mechanical keyboard visible — peripheral brand placement", confidence: 0.85 },
        { type: "Wall Space", context: "Wall behind setup — poster or brand signage placement", confidence: 0.82 },
        { type: "Shelf/Display", context: "Shelf with items — product staging opportunity", confidence: 0.79 },
        { type: "Mouse/Mousepad", context: "Mouse pad area — subtle accessory placement", confidence: 0.76 },
        { type: "Cable Area", context: "Cable management visible — cable brand opportunity", confidence: 0.72 },
      ],
      Gaming: [
        { type: "Gaming Monitor", context: "Ultra-wide gaming display — dynamic ad overlay opportunity", confidence: 0.95 },
        { type: "Gaming Chair", context: "Gaming chair visible — chair brand placement", confidence: 0.92 },
        { type: "RGB Setup", context: "RGB lighting visible — peripheral brand integration", confidence: 0.89 },
        { type: "Desk Mat", context: "Large desk mat surface — custom brand mat placement", confidence: 0.86 },
        { type: "Headset Stand", context: "Headset on stand — audio brand opportunity", confidence: 0.83 },
        { type: "Console/PC", context: "Gaming system visible — hardware brand placement", confidence: 0.80 },
        { type: "Controller", context: "Controller in frame — controller skin/brand opportunity", confidence: 0.77 },
        { type: "Poster/Banner", context: "Gaming poster on wall — brand poster replacement", confidence: 0.73 },
      ],
      Lifestyle: [
        { type: "Coffee Table", context: "Coffee table surface — product staging area", confidence: 0.93 },
        { type: "Sofa/Seating", context: "Furniture visible — home brand placement", confidence: 0.90 },
        { type: "Wall Art", context: "Wall art frame — digital art replacement opportunity", confidence: 0.87 },
        { type: "Shelf/Bookcase", context: "Bookshelf visible — product display staging", confidence: 0.84 },
        { type: "Plant/Decor", context: "Decorative item — lifestyle brand integration", confidence: 0.81 },
        { type: "Window Area", context: "Window with natural light — outdoor brand overlay", confidence: 0.78 },
      ],
      Fitness: [
        { type: "Gym Equipment", context: "Exercise equipment visible — fitness brand placement", confidence: 0.94 },
        { type: "Yoga Mat", context: "Yoga/exercise mat — mat brand replacement", confidence: 0.91 },
        { type: "Water Bottle", context: "Water bottle in frame — beverage brand opportunity", confidence: 0.88 },
        { type: "Activewear", context: "Athletic clothing visible — apparel brand placement", confidence: 0.85 },
        { type: "Mirror/Wall", context: "Gym mirror or wall — signage placement area", confidence: 0.82 },
      ],
      Beauty: [
        { type: "Vanity/Mirror", context: "Vanity area visible — beauty brand staging", confidence: 0.94 },
        { type: "Product Display", context: "Beauty products arranged — product swap opportunity", confidence: 0.92 },
        { type: "Skin Surface", context: "Close-up skin visible — skincare brand overlay", confidence: 0.89 },
        { type: "Countertop", context: "Clean counter surface — product staging area", confidence: 0.85 },
        { type: "Lighting Setup", context: "Ring light/studio light — lighting brand placement", confidence: 0.80 },
      ],
      Food: [
        { type: "Countertop", context: "Kitchen counter — ingredient/product staging", confidence: 0.94 },
        { type: "Plate/Bowl", context: "Serving ware visible — kitchenware brand opportunity", confidence: 0.91 },
        { type: "Appliance", context: "Kitchen appliance in frame — appliance brand placement", confidence: 0.88 },
        { type: "Cutting Board", context: "Prep surface — brand-name cutting board placement", confidence: 0.84 },
        { type: "Ingredient Display", context: "Ingredients laid out — grocery/brand placement", confidence: 0.80 },
      ],
      Fashion: [
        { type: "Outfit Display", context: "Full outfit visible — clothing brand placement", confidence: 0.95 },
        { type: "Accessory", context: "Watch/jewelry/bag visible — accessory brand opportunity", confidence: 0.91 },
        { type: "Footwear", context: "Shoes visible — footwear brand placement", confidence: 0.88 },
        { type: "Background Wall", context: "Clean background — brand backdrop opportunity", confidence: 0.83 },
        { type: "Mirror", context: "Full-length mirror — fashion overlay opportunity", confidence: 0.80 },
      ],
      default: [
        { type: "Flat Surface", context: "Flat surface detected — product placement opportunity", confidence: 0.88 },
        { type: "Wall Space", context: "Wall area visible — signage or poster placement", confidence: 0.85 },
        { type: "Table/Counter", context: "Horizontal surface — product staging area", confidence: 0.82 },
        { type: "Screen/Display", context: "Screen visible — digital overlay opportunity", confidence: 0.79 },
        { type: "Background Area", context: "Open background — brand integration area", confidence: 0.75 },
      ],
    };

    const category = demoVideo.category || "default";
    const templates = CATEGORY_SURFACES[category] || CATEGORY_SURFACES["default"];
    const surfaces = [];

    for (let i = 0; i < Math.min(surfaceCount, templates.length); i++) {
      const tmpl = templates[i % templates.length];
      surfaces.push({
        id: videoId * 100 + i + 1,
        videoId,
        timestamp: (i * 15) + Math.floor(Math.random() * 10),
        surfaceType: tmpl.type,
        confidence: tmpl.confidence,
        sceneContext: tmpl.context,
        surroundings: [demoVideo.title, category, "Well-lit scene"],
        frameUrl: demoVideo.thumbnailUrl,
        boundingBoxX: (0.1 + (i * 0.15) % 0.6).toFixed(3),
        boundingBoxY: (0.15 + (i * 0.1) % 0.5).toFixed(3),
        boundingBoxWidth: (0.2 + Math.random() * 0.15).toFixed(3),
        boundingBoxHeight: (0.15 + Math.random() * 0.1).toFixed(3),
        frameExists: true,
        createdAt: new Date().toISOString(),
      });
    }

    return surfaces;
  }

  // Public demo endpoint - returns STATIC demo videos + real videos with local files
  // Shows Local File badge for videos that have actual local files
  app.get("/api/demo/videos", async (req, res) => {
    try {
      // Get real videos that have local files to show "Local File" badge
      const allRealVideos = await storage.getAllVideos();
      const localVideos = await Promise.all(
        allRealVideos.map(async (video) => {
          let fileExists = false;
          if (video.filePath) {
            try {
              if (video.filePath.startsWith('/storage/')) {
                const objectKey = objectKeyFromServeUrl(video.filePath);
                fileExists = await fileExistsInStorage(objectKey);
              } else {
                fileExists = fs.existsSync(video.filePath);
              }
            } catch {
              fileExists = false;
            }
          }
          if (fileExists) {
            // Convert to demo format with fileExists
            const count = await storage.getSurfaceCountByVideo(video.id);
            return {
              id: video.id,
              userId: video.userId,
              user_id: video.userId,
              youtubeId: video.youtubeId,
              youtube_id: video.youtubeId,
              title: video.title,
              description: video.description || "",
              viewCount: video.viewCount || 0,
              view_count: video.viewCount || 0,
              thumbnailUrl: video.thumbnailUrl || "",
              thumbnail_url: video.thumbnailUrl || "",
              videoUrl: video.filePath ? normalizeVideoUrl(video.filePath) : "",
              video_url: video.filePath ? normalizeVideoUrl(video.filePath) : "",
              status: video.status || "Ready (0 Spots)",
              scan_status: count > 0 ? "completed" : "pending",
              priorityScore: video.priorityScore || 50,
              priority_score: video.priorityScore || 50,
              publishedAt: video.publishedAt,
              published_at: video.publishedAt,
              category: video.category || "General",
              isEvergreen: video.isEvergreen ?? true,
              is_evergreen: video.isEvergreen ?? true,
              duration: video.duration || "0:00",
              adOpportunities: count,
              opportunities_count: count,
              surfaceCount: count,
              surface_count: count,
              platform: video.platform || "fullscale",
              filePath: video.filePath,
              file_path: video.filePath,
              fileExists: true,
              createdAt: video.createdAt,
              created_at: video.createdAt,
              updatedAt: video.updatedAt,
              updated_at: video.updatedAt,
            };
          }
          return null;
        })
      );
      
      // Filter out null entries and combine with static demos
      const realLocalVideos = localVideos.filter((v) => v !== null);
      
      // Add fileExists: false to all static demo videos
      const staticWithFlag = STATIC_DEMO_VIDEOS.map((v: any) => ({ ...v, fileExists: false, file_exists: false }));
      
      // Real local videos first, then static demos
      const allVideos = [...realLocalVideos, ...staticWithFlag];
      
      console.log(`[DEMO] Returning ${allVideos.length} videos (${realLocalVideos.length} local + ${STATIC_DEMO_VIDEOS.length} static demos)`);
      res.json({ videos: allVideos, total: allVideos.length });
    } catch (error) {
      console.error("[DEMO] Error fetching videos:", error);
      // Fallback to static demo videos only
      res.json({ videos: STATIC_DEMO_VIDEOS, total: STATIC_DEMO_VIDEOS.length });
    }
  });

  // Manually trigger re-indexing
  app.post("/api/video-index/refresh", isGoogleAuthenticated, async (req: any, res) => {
    const userId = req.googleUser.email;
    try {
      const result = await runIndexerForUser(userId);
      res.json({ success: true, ...result });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || "Indexing failed" });
    }
  });

  // Backfill AI categorization for the current user's videos that have category: null.
  // Idempotent — safe to call repeatedly. Useful for cleaning up videos imported
  // before the AI categorizer was wired in (e.g. older IG/FB imports).
  app.post("/api/video-index/backfill-categorize", isFlexibleAuthenticated, async (req: any, res) => {
    const authUserId = req.authUserId;
    const authEmail = req.authEmail;

    try {
      const allVideos = await storage.getVideoIndex(authUserId, authEmail);
      const targets = allVideos.filter(v => v.category == null);

      if (targets.length === 0) {
        return res.json({ success: true, scanned: allVideos.length, updated: 0, message: "No null-category videos found." });
      }

      console.log(`[Backfill Categorize] User ${authEmail}: ${targets.length} of ${allVideos.length} videos need categorization`);

      const categorizations = await categorizeVideos(
        targets.map(v => ({ title: v.title || "", description: v.description || "" }))
      );

      let updated = 0;
      for (let i = 0; i < targets.length; i++) {
        const video = targets[i];
        const cat = categorizations[i];
        try {
          await storage.updateVideoIndex(video.id, {
            category: cat.category,
            subcategory: cat.subcategory,
            isEvergreen: cat.isEvergreen,
          });
          updated++;
        } catch (err: any) {
          console.error(`[Backfill Categorize] Failed to update video ${video.id}:`, err?.message || err);
        }
      }

      console.log(`[Backfill Categorize] User ${authEmail}: updated ${updated}/${targets.length}`);
      res.json({ success: true, scanned: allVideos.length, candidates: targets.length, updated });
    } catch (error: any) {
      console.error("[Backfill Categorize] Error:", error);
      res.status(500).json({ success: false, error: error.message || "Backfill failed" });
    }
  });

  // Backfill viewCount for the current user's videos with viewCount=0.
  // Handles YouTube (batch via videos?part=statistics) and Instagram (per-item
  // via insights API). Both segments run independently — if YT isn't connected
  // we still backfill IG, and vice versa. Idempotent.
  app.post("/api/video-index/backfill-viewcounts", isFlexibleAuthenticated, async (req: any, res) => {
    const authUserId = req.authUserId;
    const authEmail = req.authEmail;

    const summary = {
      youtube: { scanned: 0, candidates: 0, updated: 0, skipped: "" as string | undefined },
      instagram: { scanned: 0, candidates: 0, updated: 0, skipped: "" as string | undefined },
    };

    try {
      const allVideos = await storage.getVideoIndex(authUserId, authEmail);

      // ─── YouTube ─────────────────────────────────────────────────────────
      const ytTargets = allVideos.filter(
        v => v.platform === "youtube" && (!v.viewCount || v.viewCount === 0) && v.youtubeId
      );
      summary.youtube.scanned = allVideos.filter(v => v.platform === "youtube").length;
      summary.youtube.candidates = ytTargets.length;

      if (ytTargets.length > 0) {
        let connection = await storage.getYoutubeConnection(authUserId);
        if (!connection && authEmail && authEmail !== authUserId) {
          connection = await storage.getYoutubeConnection(authEmail);
        }

        if (!connection) {
          summary.youtube.skipped = "YouTube not connected";
        } else {
          let accessToken = connection.accessToken;
          if (connection.expiresAt && new Date(connection.expiresAt) < new Date() && connection.refreshToken) {
            const refreshed = await refreshAccessToken(connection.refreshToken);
            if (refreshed) {
              accessToken = refreshed.access_token;
              await storage.upsertYoutubeConnection({
                userId: connection.userId,
                accessToken: refreshed.access_token,
                refreshToken: connection.refreshToken,
                expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
                channelId: connection.channelId,
                channelTitle: connection.channelTitle,
              });
            }
          }

          const ytIdToVideoId = new Map(ytTargets.map(v => [v.youtubeId!, v.id]));
          const ytIds = Array.from(ytIdToVideoId.keys());
          const statsMap: Record<string, number> = {};
          for (let i = 0; i < ytIds.length; i += 50) {
            const batch = ytIds.slice(i, i + 50);
            try {
              const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${batch.join(",")}`;
              const statsRes = await fetch(statsUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
              const statsData = await statsRes.json();
              for (const v of (statsData.items || [])) {
                statsMap[v.id] = parseInt(v.statistics?.viewCount || "0");
              }
            } catch (err) {
              console.error(`[Backfill ViewCounts] YT stats batch failed:`, err);
            }
          }

          for (const ytId of ytIds) {
            const videoDbId = ytIdToVideoId.get(ytId);
            const viewCount = statsMap[ytId];
            if (videoDbId == null || typeof viewCount !== "number") continue;
            try {
              await storage.updateVideoIndex(videoDbId, { viewCount });
              summary.youtube.updated++;
            } catch (err: any) {
              console.error(`[Backfill ViewCounts] Failed YT video ${videoDbId}:`, err?.message || err);
            }
          }
        }
      }

      // ─── Instagram ───────────────────────────────────────────────────────
      // IG view counts come from the per-item insights API. Token lives on
      // the User row (facebookAccessToken — also valid for the linked IG
      // Business account). Per-item calls, so we throttle with p-limit.
      const igTargets = allVideos.filter(
        v => v.platform === "instagram" && (!v.viewCount || v.viewCount === 0) && v.youtubeId?.startsWith("instagram:")
      );
      summary.instagram.scanned = allVideos.filter(v => v.platform === "instagram").length;
      summary.instagram.candidates = igTargets.length;

      if (igTargets.length > 0) {
        const user = await storage.getUserById(authUserId)
          ?? (authEmail ? await storage.getUserByEmail(authEmail) : undefined);
        const fbToken = safeDecrypt(user?.facebookAccessToken);
        if (!fbToken) {
          summary.instagram.skipped = "Facebook/Instagram not connected (no access token)";
        } else {
          const limit = pLimit(5);
          const results = await Promise.all(
            igTargets.map(v => limit(async () => {
              const igMediaId = v.youtubeId!.slice("instagram:".length);
              // fetchInstagramVideoViews tries the canonical `views` metric
              // first (works for both REELS and VIDEO on v22+ media), then
              // falls back to the legacy metric. Pass REELS as the hint for
              // the legacy fallback — covers the more common case for short
              // social video and is harmless if the media is actually VIDEO.
              const viewCount = await fetchInstagramVideoViews(igMediaId, "REELS", fbToken);
              return { id: v.id, viewCount };
            }))
          );
          for (const r of results) {
            if (r.viewCount <= 0) continue;
            try {
              await storage.updateVideoIndex(r.id, { viewCount: r.viewCount });
              summary.instagram.updated++;
            } catch (err: any) {
              console.error(`[Backfill ViewCounts] Failed IG video ${r.id}:`, err?.message || err);
            }
          }
        }
      }

      console.log(`[Backfill ViewCounts] User ${authEmail}: YT ${summary.youtube.updated}/${summary.youtube.candidates}, IG ${summary.instagram.updated}/${summary.instagram.candidates}`);
      res.json({
        success: true,
        scanned: allVideos.length,
        candidates: summary.youtube.candidates + summary.instagram.candidates,
        updated: summary.youtube.updated + summary.instagram.updated,
        breakdown: summary,
      });
    } catch (error: any) {
      console.error("[Backfill ViewCounts] Error:", error);
      res.status(500).json({ success: false, error: error.message || "Backfill failed" });
    }
  });

  // Trigger Cloud Scan for a specific video
  app.post("/api/video-scan/:id", isFlexibleAuthenticated, async (req: any, res) => {
    console.log(`[BACKEND] ===== SCAN REQUEST RECEIVED =====`);
    console.log(`[BACKEND] Video ID from URL: ${req.params.id}`);
    console.log(`[BACKEND] User: ${req.authEmail || 'unknown'} (ID: ${req.authUserId})`);
    
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      console.log(`[BACKEND] ERROR: Invalid video ID`);
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      console.log(`[BACKEND] ERROR: Video not found in database`);
      return res.status(404).json({ error: "Video not found" });
    }

    console.log(`[BACKEND] Video found: "${video.title}" (YouTube ID: ${video.youtubeId})`);
    console.log(`[BACKEND] Video userId: ${video.userId}, auth userId: ${req.authUserId}, auth email: ${req.authEmail}`);

    // Check ownership - allow if video userId matches auth userId OR auth email
    const isOwner = video.userId === req.authUserId || video.userId === req.authEmail;
    if (!isOwner) {
      console.log(`[BACKEND] ERROR: Unauthorized - video belongs to ${video.userId}`);
      return res.status(403).json({ error: "Unauthorized" });
    }

    console.log(`[BACKEND] Starting background scan process...`);
    
    setImmediate(async () => {
      try {
        console.log(`[BACKEND] Background scan starting for video ${videoId}`);
        // Always force rescan to allow retry on failed/empty scans
        await processVideoScan(videoId, true);
        console.log(`[BACKEND] Background scan completed for video ${videoId}`);
      } catch (err) {
        console.error(`[BACKEND] Background scan failed for video ${videoId}:`, err);
      }
    });

    console.log(`[BACKEND] Responding with success (scan running in background)`);
    res.json({ success: true, message: "Scan started", videoId });
  });

  // Scan all pending videos for the user
  app.post("/api/video-scan/batch", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authEmail;
    const limit = parseInt(req.query.limit as string) || 5;

    setImmediate(async () => {
      try {
        await scanPendingVideos(userId, limit);
      } catch (err) {
        console.error(`[Scanner] Batch scan failed for user ${userId}:`, err);
      }
    });

    res.json({ success: true, message: "Batch scan started" });
  });

  // Update video file path and thumbnail - for fixing database records
  // Only works for videos owned by admin emails
  app.post("/api/videos/:id/update-path", async (req, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const { filePath, thumbnailUrl } = req.body;
    if (!filePath && !thumbnailUrl) {
      return res.status(400).json({ error: "Must provide filePath or thumbnailUrl" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Only allow updates for admin-owned videos
    const adminEmailsList = ['martin@gofullscale.co', 'martin@whtwrks.com', 'martincekechukwu@gmail.com', 'thekimkwilson@gmail.com', 'tamara@whtwrks.com'];
    if (!adminEmailsList.includes(video.userId)) {
      return res.status(403).json({ error: "Can only update admin-owned videos" });
    }

    try {
      // Update the video record
      const updates: any = {};
      if (filePath) updates.filePath = filePath;
      if (thumbnailUrl) updates.thumbnailUrl = thumbnailUrl;
      
      await storage.updateVideoIndex(videoId, updates);
      
      console.log(`[UPDATE PATH] Video ${videoId} updated:`, updates);
      res.json({ 
        success: true, 
        videoId,
        updates,
        message: "Video path updated successfully"
      });
    } catch (err: any) {
      console.error(`[UPDATE PATH] Failed for video ${videoId}:`, err);
      res.status(500).json({ error: err.message || "Update failed" });
    }
  });

  // Synchronous scan endpoint — kept under the legacy /api/admin-scan path
  // since the SceneAnalysisModal client wires to it directly. Used by the
  // "Scan with FullScale Edge" button which needs a synchronous response so
  // the modal can immediately surface fresh surfaces. The async equivalent
  // is /api/video-scan/:id (returns immediately, scans in background).
  //
  // Previously this endpoint required video.userId to be a literal admin
  // email, which broke for IG/FB/YT-imported videos whose userId is the
  // user's UUID. Switched to dual-id ownership (same pattern as
  // /api/video-scan and the public profile fix): match either authUserId
  // or authEmail. Any authenticated user can synchronously scan their
  // own video regardless of which import path created it.
  app.post("/api/admin-scan/:id", isFlexibleAuthenticated, async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    const isOwner = video.userId === req.authUserId || video.userId === req.authEmail;
    if (!isOwner) {
      return res.status(403).json({ error: "Not authorized to scan this video" });
    }

    console.log(`[Sync Scan] Starting scan for video ${videoId}: "${video.title}" (user ${req.authEmail})`);

    try {
      const result = await processVideoScan(videoId, true);
      console.log(`[Sync Scan] Scan complete for ${videoId}:`, result);
      res.json({ success: true, result });
    } catch (err: any) {
      console.error(`[Sync Scan] Scan failed for ${videoId}:`, err);
      res.status(500).json({ error: err.message || "Scan failed" });
    }
  });

  // DISABLED: TensorFlow scanner replaced by scanner_v2.ts which uses Sharp
  // These routes are commented out to prevent TensorFlow from loading
  /*
  // TensorFlow.js Surface Detection - Background Worker Queue
  app.post("/api/tf-scan/:id", isFlexibleAuthenticated, async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Local files are test files - skip ownership check for videos with filePath
    if (!video.filePath) {
      return res.status(400).json({ error: "Video has no local file. Upload a video first." });
    }

    console.log(`[TF-SCAN] Queuing TensorFlow scan for video ${videoId}: "${video.title}"`);
    
    // Queue the scan job for background processing (prevents 503)
    const jobId = queueVideoScan(videoId, video.filePath);
    
    res.json({ 
      success: true, 
      message: "Scan queued for background processing", 
      jobId,
      videoId 
    });
  });

  // Check scan job status
  app.get("/api/tf-scan/job/:jobId", isFlexibleAuthenticated, async (req: any, res) => {
    const job = getScanJobStatus(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });

  // Get scan queue status
  app.get("/api/tf-scan/queue", isFlexibleAuthenticated, async (req: any, res) => {
    const status = getQueueStatus();
    res.json(status);
  });

  // Direct TensorFlow surface detection (synchronous - admin only for testing)
  app.post("/api/tf-detect/:id", isFlexibleAuthenticated, async (req: any, res) => {
    // Admin only - synchronous detection can be heavy
    if (!adminEmails.includes(req.authEmail || '')) {
      return res.status(403).json({ error: "Admin only endpoint" });
    }
    
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    if (!video.filePath) {
      return res.status(400).json({ error: "Video has no local file" });
    }

    console.log(`[TF-DETECT] Running direct detection for video ${videoId}: "${video.title}"`);
    
    try {
      const result = await detectSurfacesFromVideo(video.filePath);
      console.log(`[TF-DETECT] Result:`, result);
      res.json({ success: true, result });
    } catch (err: any) {
      console.error(`[TF-DETECT] Failed:`, err);
      res.status(500).json({ error: err.message || "Detection failed" });
    }
  });
  */

  // Extract thumbnails from local videos
  app.post("/api/thumbnails/extract/:id", isFlexibleAuthenticated, async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Local files are test files - skip ownership check
    console.log(`[THUMBNAIL] Extracting thumbnail for video ${videoId}`);
    
    try {
      const thumbnailUrl = await extractThumbnailForVideo(videoId);
      if (thumbnailUrl) {
        res.json({ success: true, thumbnailUrl });
      } else {
        res.status(400).json({ error: "Failed to extract thumbnail - video may not have local file" });
      }
    } catch (err: any) {
      console.error(`[THUMBNAIL] Failed:`, err);
      res.status(500).json({ error: err.message || "Extraction failed" });
    }
  });

  // Batch extract thumbnails for all videos with local files (admin only)
  app.post("/api/thumbnails/extract-all", isFlexibleAuthenticated, async (req: any, res) => {
    // Admin only - batch operation
    if (!adminEmails.includes(req.authEmail || '')) {
      return res.status(403).json({ error: "Admin only endpoint" });
    }
    
    console.log(`[THUMBNAIL] Starting batch thumbnail extraction`);
    
    try {
      const result = await extractAndUpdateThumbnails();
      res.json({ success: true, ...result });
    } catch (err: any) {
      console.error(`[THUMBNAIL] Batch extraction failed:`, err);
      res.status(500).json({ error: err.message || "Batch extraction failed" });
    }
  });

  // ─── Direct-to-Storage Upload (presigned URL — no server bottleneck) ────

  // Step 1: Get a presigned URL for the client to upload directly to Object Storage
  app.post("/api/upload/presign", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { filename, contentType, fileSize } = req.body || {};

      if (!filename || !contentType) {
        return res.status(400).json({ error: "filename and contentType required" });
      }

      // Validate file type
      const ext = path.extname(filename).toLowerCase();
      const allowedTypes = [".mp4", ".mov", ".webm", ".avi"];
      if (!allowedTypes.includes(ext)) {
        return res.status(400).json({ error: `Unsupported file type: ${ext}. Allowed: ${allowedTypes.join(", ")}` });
      }

      // Generate unique object key
      const uniqueName = `video-${Date.now()}-${Math.random().toString(36).substring(2, 9)}${ext}`;
      const objectKey = `public/videos/${uniqueName}`;

      const { getSignedUploadUrl } = await import("./lib/objectStorage");
      const result = await getSignedUploadUrl(objectKey, contentType, 60); // 60 min expiry

      console.log(`[UPLOAD/presign] Generated signed URL for ${filename} (${(fileSize / 1024 / 1024).toFixed(1)}MB) → ${objectKey}`);

      res.json({
        signedUrl: result.signedUrl,
        objectKey: result.objectKey,
        serveUrl: result.serveUrl,
        expiresInMinutes: 60,
      });
    } catch (err: any) {
      console.error("[UPLOAD/presign] Error:", err);
      res.status(500).json({ error: err.message || "Failed to generate upload URL" });
    }
  });

  // Step 2: Client notifies server that upload to Object Storage is complete
  app.post("/api/upload/complete", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authEmail || req.googleUser?.email;
      const { objectKey, serveUrl, title, category, subcategory, originalFilename } = req.body || {};

      if (!objectKey || !serveUrl) {
        return res.status(400).json({ error: "objectKey and serveUrl required" });
      }

      // Verify the file exists in Object Storage
      const { fileExistsInStorage } = await import("./lib/objectStorage");
      const exists = await fileExistsInStorage(objectKey);
      if (!exists) {
        return res.status(400).json({ error: "File not found in Object Storage. Upload may have failed." });
      }

      const uploadVideoId = `upload-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const videoTitle = title || originalFilename?.replace(/\.[^/.]+$/, "") || "Untitled Video";

      const video = await storage.insertVideo({
        userId,
        youtubeId: uploadVideoId,
        title: videoTitle,
        description: `Uploaded video: ${originalFilename || "direct upload"}`,
        thumbnailUrl: "/storage/uploads/default-thumbnail.png",
        viewCount: 0,
        publishedAt: new Date(),
        status: "Pending Scan",
        priorityScore: 80,
        platform: "fullscale",
        category: category || "Other",
        subcategory: subcategory || null,
        isEvergreen: true,
        duration: "0:00",
        filePath: serveUrl,
      });

      console.log(`[UPLOAD/complete] Video registered: ID ${video.id}, title "${videoTitle}", path: ${serveUrl}`);

      // Mark editorial pipeline as pending
      storage.updateVideoEditorialStatus(video.id, "pending").catch((e: any) =>
        console.warn(`[UPLOAD/complete] Failed to set editorial pending: ${e?.message}`)
      );

      // Auto-extract real thumbnail from the video
      extractThumbnailForVideo(video.id)
        .then(thumbUrl => { if (thumbUrl) console.log(`[UPLOAD/complete] Thumbnail extracted for ${video.id}: ${thumbUrl}`); })
        .catch(() => {});

      // Fire scan + editorial pipeline (same as traditional upload)
      processVideoScan(video.id, true).then(result => {
        console.log(`[UPLOAD/complete] Auto-scan complete for ${video.id}: ${result.surfacesDetected} surfaces`);

        const pipelineUserId = 0;
        runEditorialAutoPipeline(video.id, pipelineUserId)
          .then(r => {
            if (r.success) {
              console.log(`[UPLOAD/complete] Editorial auto-pipeline: ${r.clipsRendered}/${r.clipsGenerated} rendered`);
            } else {
              console.warn(`[UPLOAD/complete] Editorial auto-pipeline failed: ${r.error}`);
            }
          })
          .catch(err => console.error(`[UPLOAD/complete] Editorial error:`, err?.message));
      }).catch(err => {
        console.error(`[UPLOAD/complete] Auto-scan failed for ${video.id}:`, err.message);
      });

      res.json({
        success: true,
        video: {
          id: video.id,
          title: video.title,
          youtubeId: uploadVideoId,
          videoUrl: serveUrl,
          status: video.status,
          platform: "fullscale",
        },
        message: "Video registered. Scan + editorial pipeline started.",
      });
    } catch (err: any) {
      console.error("[UPLOAD/complete] Error:", err);
      res.status(500).json({ error: err.message || "Failed to register video" });
    }
  });

  // Direct video upload endpoint (traditional — file passes through server)
  app.post("/api/upload", isFlexibleAuthenticated, uploadMiddleware.single("video"), async (req: any, res) => {

    console.log(`[UPLOAD] User: ${req.authEmail || req.googleUser?.email}`);
    console.log(`[UPLOAD] User: ${req.googleUser?.email}`);
    
    if (!req.file) {
      console.log(`[UPLOAD] ERROR: No file received`);
      return res.status(400).json({ error: "No video file uploaded" });
    }

    const userId = req.authEmail || req.googleUser?.email;
    const file = req.file;
    const title = req.body.title || file.originalname.replace(/\.[^/.]+$/, "");
    const category = req.body.category || "Other";
    const subcategory = req.body.subcategory || null;

    console.log(`[UPLOAD] File: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`[UPLOAD] Saved as: ${file.filename}`);
    console.log(`[UPLOAD] Title: ${title}`);
    console.log(`[UPLOAD] Category: ${category}${subcategory ? ` / ${subcategory}` : ""}`);

    try {
      const uploadVideoId = `upload-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      const objectKey = `public/videos/${file.filename}`;
      const storageUrl = await uploadFileToStorage(file.path, objectKey);
      console.log(`[UPLOAD] Uploaded to Object Storage: ${storageUrl}`);

      try { fs.unlinkSync(file.path); } catch {}

      const video = await storage.insertVideo({
        userId,
        youtubeId: uploadVideoId,
        title,
        description: `Uploaded video: ${file.originalname}`,
        thumbnailUrl: "/storage/uploads/default-thumbnail.png",
        viewCount: 0,
        publishedAt: new Date(),
        status: "Pending Scan",
        priorityScore: 80,
        platform: "fullscale",
        category,
        subcategory,
        isEvergreen: true,
        duration: "0:00",
        filePath: storageUrl,
      });

      console.log(`[UPLOAD] Video inserted with ID: ${video.id}`);
      console.log(`[UPLOAD] Starting auto-scan...`);

      // Mark editorial pipeline as pending immediately so UI can poll
      storage.updateVideoEditorialStatus(video.id, "pending").catch((e: any) =>
        console.warn(`[UPLOAD] Failed to set editorial pending: ${e?.message}`)
      );

      // Auto-extract real thumbnail from the video (replaces default placeholder)
      extractThumbnailForVideo(video.id)
        .then(thumbUrl => { if (thumbUrl) console.log(`[UPLOAD] Thumbnail extracted for ${video.id}: ${thumbUrl}`); })
        .catch(() => {});

      processVideoScan(video.id, true).then(result => {
        console.log(`[UPLOAD] Auto-scan complete for ${video.id}: ${result.surfacesDetected} surfaces`);

        // Feature A: Auto-generate editorial story-clips after scan completes.
        // Runs transcript + narrative analysis + FFmpeg render in background.
        // userId here is the email string (req.authEmail); we pass a numeric 0
        // placeholder because the editorialClips schema requires integer userId
        // but the auto-pipeline isn't tied to a specific user role.
        const pipelineUserId = 0;
        runEditorialAutoPipeline(video.id, pipelineUserId)
          .then(r => {
            if (r.success) {
              console.log(`[UPLOAD] Editorial auto-pipeline: ${r.clipsRendered}/${r.clipsGenerated} rendered in ${(r.durationMs / 1000).toFixed(1)}s`);
            } else {
              console.warn(`[UPLOAD] Editorial auto-pipeline failed for ${video.id}: ${r.error}`);
            }
          })
          .catch(err => {
            console.error(`[UPLOAD] Editorial auto-pipeline error for ${video.id}:`, err?.message || err);
          });
      }).catch(err => {
        console.error(`[UPLOAD] Auto-scan failed for ${video.id}:`, err.message);
      });

      res.json({ 
        success: true, 
        video: {
          id: video.id,
          title: video.title,
          youtubeId: uploadVideoId,
          videoUrl: storageUrl,
          status: video.status,
          platform: "fullscale"
        },
        message: "Video uploaded successfully. Click 'Scan' to analyze for ad placements."
      });
    } catch (error: any) {
      console.error(`[UPLOAD] Error:`, error);
      try { fs.unlinkSync(file.path); } catch {}
      res.status(500).json({ error: "Failed to save video record" });
    }
  });

  // Get single video with metadata (for Remix Engine)
  app.get("/api/video/:id/details", async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    try {
      const video = await storage.getVideoById(videoId);
      if (!video) {
        return res.status(404).json({ error: "Video not found" });
      }

      const surfaceCount = await storage.getSurfaceCountByVideo(videoId);

      res.json({
        ...video,
        surfaceCount,
      });
    } catch (error: any) {
      console.error("[API] Error fetching video details:", error);
      res.status(500).json({ error: "Failed to fetch video details" });
    }
  });

  // Get detected surfaces for a video (Ad Opportunities)
  // On-demand frame extraction: generate a single frame thumbnail from a video if it doesn't exist
  // This ensures the Scene Analysis Modal always has a frame to show
  app.get("/api/video/:id/frame/:timestamp", async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    const timestamp = parseInt(req.params.timestamp) || 0;
    if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

    const video = await storage.getVideoById(videoId);
    if (!video) return res.status(404).json({ error: "Video not found" });

    const framesDir = path.join(process.cwd(), "public", "uploads", "frames", videoId.toString());
    const frameFilename = `frame_${timestamp}s.jpg`;
    const framePath = path.join(framesDir, frameFilename);

    // If frame already exists, serve it
    if (fs.existsSync(framePath)) {
      return res.sendFile(framePath);
    }

    // Generate frame from video file using FFmpeg
    const videoPath = video.filePath;
    if (!videoPath) {
      return res.status(404).json({ error: "No video file available for frame extraction" });
    }

    const absoluteVideoPath = path.resolve(videoPath);
    if (!fs.existsSync(absoluteVideoPath)) {
      return res.status(404).json({ error: "Video file not found on disk" });
    }

    fs.mkdirSync(framesDir, { recursive: true });

    try {
      const { spawn } = require("child_process");
      await new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
          "-nostdin", "-y",
          "-ss", timestamp.toString(),
          "-i", absoluteVideoPath,
          "-frames:v", "1",
          "-q:v", "2",
          "-pix_fmt", "yuvj420p",
          framePath,
        ]);
        let stderr = "";
        ffmpeg.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        const timeout = setTimeout(() => { ffmpeg.kill("SIGKILL"); reject(new Error("FFmpeg timeout")); }, 15000);
        ffmpeg.on("close", (code: number) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg exit code ${code}`));
        });
        ffmpeg.on("error", (err: Error) => { clearTimeout(timeout); reject(err); });
      });

      if (fs.existsSync(framePath)) {
        return res.sendFile(framePath);
      }
      return res.status(500).json({ error: "Frame generation failed" });
    } catch (err: any) {
      console.error(`[Frame] Failed to extract frame:`, err.message);
      return res.status(500).json({ error: "Frame extraction failed" });
    }
  });

  // Stream a video file by ID (no auth required — for public creator profiles)
  // Resolves filePath from DB and serves from Object Storage or local filesystem
  app.get("/api/video/:id/stream", async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

    try {
      const video = await storage.getVideoById(videoId);
      if (!video || !video.filePath) {
        return res.status(404).json({ error: "Video file not found" });
      }

      // Try Object Storage first (Replit)
      const objectKey = video.filePath.replace(/^\.?\/?public\//, "public/");
      try {
        if (await fileExistsInStorage(objectKey)) {
          const { file, stream } = getStorageStream(objectKey);
          const [metadata] = await file.getMetadata();
          res.set({
            "Content-Type": metadata.contentType || "video/mp4",
            "Content-Length": metadata.size?.toString(),
            "Cache-Control": "public, max-age=86400",
            "Accept-Ranges": "bytes",
          });
          stream.on("error", (err: any) => {
            console.error("[Stream] Storage stream error:", err.message);
            if (!res.headersSent) res.status(500).json({ error: "Stream failed" });
          });
          return stream.pipe(res);
        }
      } catch (e) {
        // Object Storage not available, fall through to local
      }

      // Fall back to local filesystem
      const absolutePath = path.resolve(video.filePath);
      if (fs.existsSync(absolutePath)) {
        const stat = fs.statSync(absolutePath);
        res.set({
          "Content-Type": "video/mp4",
          "Content-Length": stat.size.toString(),
          "Cache-Control": "public, max-age=86400",
          "Accept-Ranges": "bytes",
        });
        return fs.createReadStream(absolutePath).pipe(res);
      }

      return res.status(404).json({ error: "Video file not found on disk or storage" });
    } catch (err: any) {
      console.error("[Stream] Error:", err.message);
      return res.status(500).json({ error: "Failed to stream video" });
    }
  });

  // PUBLIC endpoint - surfaces are viewable by brands on creator profiles
  app.get("/api/video/:id/surfaces", async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    // Demo video IDs (1001-1099) — return realistic mock surfaces for pitch mode
    // IMPORTANT: Only check the specific demo range, NOT all IDs >= 1000,
    // because real production videos can have IDs in the tens of thousands
    if (videoId >= 1001 && videoId <= 1099) {
      const demoVideo = STATIC_DEMO_VIDEOS.find((v: any) => v.id === videoId);
      if (!demoVideo) return res.status(404).json({ error: "Demo video not found" });
      const mockSurfaces = generateDemoSurfaces(videoId, demoVideo as any);
      return res.json({ surfaces: mockSurfaces, count: mockSurfaces.length });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Approval filter: creators can opt-in surfaces for brand visibility.
    // Default (anonymous request) = approved-only. The video owner can
    // request includeUnapproved=true to see everything for the review UI.
    // Owner check uses the same dual-id pattern as elsewhere; if no auth
    // context (e.g. unauthenticated brand-side query), default applies.
    const includeUnapproved = req.query.includeUnapproved === "true";
    const requesterUserId = (req as any).authUserId;
    const requesterEmail = (req as any).authEmail;
    const isOwner = !!requesterUserId && (
      video.userId === requesterUserId || video.userId === requesterEmail
    );
    const showAll = includeUnapproved && isOwner;

    const allSurfaces = await storage.getDetectedSurfaces(videoId);
    // Exclude surfaces filtered out by post-scan normalization (phantom/too-small detections)
    let surfaces = allSurfaces.filter(s => s.surfaceType !== "Filtered");
    if (!showAll) {
      surfaces = surfaces.filter(s => (s as any).creatorApproved === true);
    }

    // Enrich surfaces with frame availability info
    const framesDir = path.join(process.cwd(), "public", "uploads", "frames", videoId.toString());
    const enrichedSurfaces = surfaces.map(s => {
      const ts = Math.floor(Number(s.timestamp));
      const frameFilename = `frame_${ts}s.jpg`;
      const framePath = path.join(framesDir, frameFilename);
      const frameExists = fs.existsSync(framePath);

      // Backfill frameUrl if frame exists but surface has no URL
      const frameUrl = s.frameUrl || (frameExists ? `/uploads/frames/${videoId}/${frameFilename}` : null);

      return { ...s, frameUrl, frameExists };
    });

    res.json({ surfaces: enrichedSurfaces, count: enrichedSurfaces.length });
  });

  // Creator toggles a single surface's approval state. Surfaces default to
  // creator_approved=false at scan time — brands can't see them until the
  // creator opts each one in via the scene modal toggle.
  app.patch("/api/surface/:id/approval", isFlexibleAuthenticated, async (req: any, res) => {
    const surfaceId = parseInt(req.params.id);
    if (isNaN(surfaceId)) return res.status(400).json({ error: "Invalid surface ID" });

    const { approved } = req.body || {};
    if (typeof approved !== "boolean") {
      return res.status(400).json({ error: "Body must include { approved: boolean }" });
    }

    // Look up surface → parent video for ownership check.
    const [surface] = await db
      .select()
      .from(detectedSurfaces)
      .where(eq(detectedSurfaces.id, surfaceId))
      .limit(1);
    if (!surface) return res.status(404).json({ error: "Surface not found" });

    const video = await storage.getVideoById(surface.videoId);
    if (!video) return res.status(404).json({ error: "Parent video not found" });

    const isOwner = video.userId === req.authUserId || video.userId === req.authEmail;
    if (!isOwner) return res.status(403).json({ error: "Not authorized to edit this video's surfaces" });

    await storage.updateSurfaceApproval(surfaceId, approved);
    res.json({ success: true, surfaceId, approved });
  });

  // Batch insert surfaces for a video (Admin only)
  // Used to copy scan results to production database
  app.post("/api/videos/:id/batch-insert-surfaces", isFlexibleAuthenticated, async (req: any, res) => {
    const authEmail = req.authEmail;
    
    // Admin only
    const adminEmails = ["martin@gofullscale.co", "martin@whtwrks.com", "martincekechukwu@gmail.com", "thekimkwilson@gmail.com", "tamara@whtwrks.com"];
    if (!adminEmails.includes(authEmail)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    const { surfaces, append } = req.body;
    if (!Array.isArray(surfaces) || surfaces.length === 0) {
      return res.status(400).json({ error: "surfaces array is required" });
    }

    try {
      // Only clear existing surfaces if not in append mode
      if (!append) {
        await storage.clearDetectedSurfaces(videoId);
      }
      
      const inserted = [];
      for (const s of surfaces) {
        const surface = await storage.insertDetectedSurface({
          videoId,
          timestamp: String(s.timestamp || "0"),
          surfaceType: s.surfaceType || "Desk",
          confidence: String(s.confidence),
          boundingBoxX: String(s.boundingBox?.x || 0.05),
          boundingBoxY: String(s.boundingBox?.y || 0.4),
          boundingBoxWidth: String(s.boundingBox?.width || 0.9),
          boundingBoxHeight: String(s.boundingBox?.height || 0.24),
          frameUrl: s.frameUrl || null,
          surroundings: null,
          sceneContext: null,
        });
        inserted.push(surface);
      }
      
      // Update video status
      await storage.updateVideoStatus(videoId, "Scan Complete");
      
      console.log(`[BatchInsertSurfaces] Added ${inserted.length} surfaces to video ${videoId}`);
      res.json({ success: true, count: inserted.length, surfaces: inserted });
    } catch (error: any) {
      console.error(`[BatchInsertSurfaces] Error:`, error);
      res.status(500).json({ error: error.message || "Failed to insert surfaces" });
    }
  });

  // Insert a detected surface for a video (Admin only)
  // Used to add scan results to production database
  app.post("/api/videos/:id/insert-surface", isFlexibleAuthenticated, async (req: any, res) => {
    const authEmail = req.authEmail;
    
    // Admin only
    const adminEmails = ["martin@gofullscale.co", "martin@whtwrks.com", "martincekechukwu@gmail.com", "thekimkwilson@gmail.com", "tamara@whtwrks.com"];
    if (!adminEmails.includes(authEmail)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    const { timestamp, surfaceType, confidence, boundingBox } = req.body;
    
    if (!surfaceType || confidence === undefined) {
      return res.status(400).json({ error: "surfaceType and confidence are required" });
    }

    try {
      const surface = await storage.insertDetectedSurface({
        videoId,
        timestamp: String(timestamp || "0"),
        surfaceType,
        confidence: String(confidence),
        boundingBoxX: String(boundingBox?.x || 0),
        boundingBoxY: String(boundingBox?.y || 0),
        boundingBoxWidth: String(boundingBox?.width || 1),
        boundingBoxHeight: String(boundingBox?.height || 1),
        frameUrl: null,
        surroundings: null,
        sceneContext: null,
      });
      
      console.log(`[InsertSurface] Added surface to video ${videoId}: ${surfaceType} @ ${confidence}`);
      res.json({ success: true, surface });
    } catch (error: any) {
      console.error(`[InsertSurface] Error:`, error);
      res.status(500).json({ error: error.message || "Failed to insert surface" });
    }
  });

  // Get videos with their Ad Opportunity counts
  app.get("/api/video-index/with-opportunities", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const authEmail = req.authEmail;
    console.log(`[VideoIndex] Fetching videos for userId: ${userId}, authEmail: ${authEmail}`);
    
    const videos = await storage.getVideoIndex(userId, authEmail);
    console.log(`[VideoIndex] Found ${videos.length} videos for user`);
    
    const videosWithCounts = await Promise.all(
      videos.map(async (video) => {
        const count = await storage.getSurfaceCountByVideo(video.id);
        let fileExists = false;
        if (video.filePath) {
          try {
            if (video.filePath.startsWith('/storage/')) {
              // Object Storage file — check async
              const objectKey = objectKeyFromServeUrl(video.filePath);
              fileExists = await fileExistsInStorage(objectKey);
            } else {
              fileExists = fs.existsSync(video.filePath);
            }
          } catch {
            fileExists = false;
          }
        }
        return { ...video, adOpportunities: count, fileExists };
      })
    );

    res.json({ videos: videosWithCounts, total: videosWithCounts.length });
  });

  // YouTube Video Proxy - Experimental feature for scanning YouTube videos
  // NOTE: This uses mobile user agent spoofing which may violate YouTube TOS.
  // For production, prefer user-uploaded videos which bypass these restrictions.
  // This is a development/testing tool only.
  const MOBILE_SAFARI_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
  const proxyRateLimit = new Map<string, { count: number; resetTime: number }>();
  const PROXY_RATE_LIMIT = 5; // 5 requests per minute per user
  const PROXY_MAX_SIZE_MB = 100; // Max 100MB per video
  
  app.get("/api/proxy-video", isGoogleAuthenticated, async (req: any, res) => {
    const userId = req.googleUser?.email || "anonymous";
    const videoUrl = req.query.url as string;
    
    // Rate limiting per authenticated user
    const now = Date.now();
    const userLimit = proxyRateLimit.get(userId);
    if (userLimit) {
      if (now < userLimit.resetTime) {
        if (userLimit.count >= PROXY_RATE_LIMIT) {
          return res.status(429).json({ error: "Rate limit exceeded. Try again in 1 minute." });
        }
        userLimit.count++;
      } else {
        proxyRateLimit.set(userId, { count: 1, resetTime: now + 60000 });
      }
    } else {
      proxyRateLimit.set(userId, { count: 1, resetTime: now + 60000 });
    }
    
    if (!videoUrl) {
      return res.status(400).json({ error: "Missing url parameter" });
    }

    const youtubeIdMatch = videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (!youtubeIdMatch) {
      return res.status(400).json({ error: "Invalid YouTube URL" });
    }
    
    const youtubeId = youtubeIdMatch[1];
    console.log(`[Proxy] User ${userId} streaming video ${youtubeId}`);
    
    try {
      const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${youtubeId}`, {
        requestOptions: {
          headers: { "User-Agent": MOBILE_SAFARI_USER_AGENT },
        },
      });
      
      const format = ytdl.chooseFormat(info.formats, { 
        quality: "highest",
        filter: (f) => !!(f.container === "mp4" && f.hasVideo && f.height && f.height <= 720)
      });
      
      if (!format) {
        return res.status(404).json({ error: "No suitable format found" });
      }
      
      // Check size limit
      const sizeInMB = format.contentLength ? parseInt(format.contentLength) / (1024 * 1024) : 0;
      if (sizeInMB > PROXY_MAX_SIZE_MB) {
        return res.status(413).json({ error: `Video too large (${sizeInMB.toFixed(0)}MB > ${PROXY_MAX_SIZE_MB}MB limit)` });
      }
      
      res.setHeader("Content-Type", format.mimeType || "video/mp4");
      if (format.contentLength) {
        res.setHeader("Content-Length", format.contentLength);
      }
      
      const videoStream = ytdl(`https://www.youtube.com/watch?v=${youtubeId}`, {
        format,
        requestOptions: {
          headers: { "User-Agent": MOBILE_SAFARI_USER_AGENT },
        },
      });
      
      videoStream.on("error", (err) => {
        console.error(`[Proxy] Stream error:`, err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to stream video" });
        }
      });
      
      videoStream.pipe(res);
    } catch (err: any) {
      console.error(`[Proxy] Failed to get video info:`, err.message);
      res.status(500).json({ error: "Failed to proxy video", details: err.message });
    }
  });

  // MARKETPLACE: Get videos with opportunities (videos that have detected surfaces)
  app.get("/api/marketplace/opportunities", isGoogleAuthenticated, async (req: any, res) => {
    const userId = req.googleUser.email;
    const opportunities = await storage.getVideosWithOpportunities(userId);
    
    res.json({ 
      opportunities, 
      total: opportunities.length,
      totalSurfaces: opportunities.reduce((sum, v) => sum + v.surfaceCount, 0)
    });
  });

  // MARKETPLACE: Get count of active opportunities (for Dashboard)
  app.get("/api/marketplace/stats", isGoogleAuthenticated, async (req: any, res) => {
    const userId = req.googleUser.email;
    const opportunities = await storage.getVideosWithOpportunities(userId);
    const activeBids = await storage.getActiveBidsForCreator(userId);
    
    res.json({ 
      videosWithOpportunities: opportunities.length,
      totalSurfaces: opportunities.reduce((sum, v) => sum + v.surfaceCount, 0),
      activeBids: activeBids.length
    });
  });

  // MARKETPLACE: Brand places a bid on a video surface
  const marketplaceBuySchema = z.object({
    videoId: z.number().optional(),
    title: z.string().min(1),
    thumbnailUrl: z.string().optional(),
    bidAmount: z.number().positive(),
    sceneType: z.string().optional(),
    genre: z.string().optional(),
    brandEmail: z.string().email().optional(),
    brandName: z.string().optional(),
  });

  app.post("/api/marketplace/buy", isGoogleAuthenticated, async (req: any, res) => {
    try {
      const parsed = marketplaceBuySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      }
      
      const { videoId, title, thumbnailUrl, bidAmount, sceneType, genre, brandEmail, brandName } = parsed.data;
      
      // Get the video to find the creator
      const video = videoId ? await storage.getVideoById(videoId) : null;
      const creatorUserId = video?.userId || "demo-creator";
      
      const bid = await storage.createBid({
        title: title || "Video Ad Placement",
        thumbnailUrl,
        status: "pending",
        videoId,
        creatorUserId,
        brandEmail: brandEmail || req.googleUser.email,
        brandName: brandName || req.googleUser.name,
        bidAmount: String(bidAmount),
        sceneType,
        genre,
      });
      
      res.json({ success: true, bid });
    } catch (err: any) {
      console.error("Error creating bid:", err);
      res.status(500).json({ error: "Failed to create bid" });
    }
  });

  // ── BID REVIEW LIFECYCLE ──

  // Get bid details (creator viewing an offer)
  app.get("/api/bids/:bidId", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const bidId = parseInt(req.params.bidId);
      if (isNaN(bidId)) return res.status(400).json({ error: "Invalid bid ID" });

      const bid = await storage.getBidById(bidId);
      if (!bid) return res.status(404).json({ error: "Bid not found" });

      // Enrich with video data
      let videoData = null;
      if (bid.videoId) {
        const video = await storage.getVideoById(bid.videoId);
        if (video) {
          const surfaceCount = await storage.getSurfaceCountByVideo(video.id);
          videoData = {
            id: video.id,
            title: video.title,
            thumbnailUrl: video.thumbnailUrl,
            viewCount: video.viewCount,
            surfaceCount,
          };
        }
      }

      res.json({ ...bid, video: videoData });
    } catch (err: any) {
      console.error("[Bids] Error fetching bid:", err.message);
      res.status(500).json({ error: "Failed to fetch bid" });
    }
  });

  // Link a saved placement to a bid (creator fulfilling an offer)
  app.post("/api/bids/:bidId/link-placement", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const bidId = parseInt(req.params.bidId);
      if (isNaN(bidId)) return res.status(400).json({ error: "Invalid bid ID" });

      const { placementId } = req.body;
      if (!placementId) return res.status(400).json({ error: "placementId is required" });

      const bid = await storage.getBidById(bidId);
      if (!bid) return res.status(404).json({ error: "Bid not found" });
      if (bid.status !== "pending" && bid.status !== "revision_requested") {
        return res.status(400).json({ error: `Bid is in '${bid.status}' state and cannot be linked to a placement` });
      }

      const placement = await storage.getPlacement(placementId);
      if (!placement) return res.status(404).json({ error: "Placement not found" });

      // Auto-create a shared link for the brand to review
      const slug = generateSlug();
      await storage.createSharedLink({
        slug,
        placementId: placement.id,
        exportId: null,
        videoId: placement.videoId,
        createdBy: req.authEmail || "system",
        title: `Placement review for ${bid.brandName || "brand"}`,
        isActive: true,
        expiresAt: null,
      });

      // Update the bid to "placed" status with the review link
      const updatedBid = await storage.updateBidStatus(bidId, "placed", {
        placementId: placement.id,
        reviewSlug: slug,
      });

      console.log(`[Bids] Linked placement ${placementId} to bid ${bidId}, review slug: ${slug}`);
      res.json({ success: true, reviewSlug: slug, bid: updatedBid });
    } catch (err: any) {
      console.error("[Bids] Error linking placement:", err.message);
      res.status(500).json({ error: "Failed to link placement to bid" });
    }
  });

  // Brand reviews a placement (approve or request changes)
  app.post("/api/bids/:bidId/review", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const bidId = parseInt(req.params.bidId);
      if (isNaN(bidId)) return res.status(400).json({ error: "Invalid bid ID" });

      const { action, note } = req.body;
      if (!action || !["approve", "request_revision"].includes(action)) {
        return res.status(400).json({ error: "action must be 'approve' or 'request_revision'" });
      }

      const bid = await storage.getBidById(bidId);
      if (!bid) return res.status(404).json({ error: "Bid not found" });
      if (bid.status !== "placed") {
        return res.status(400).json({ error: `Bid must be in 'placed' state to review (current: '${bid.status}')` });
      }

      // Verify the caller is the brand who owns this bid
      const callerEmail = req.authEmail;
      if (callerEmail !== bid.brandEmail) {
        return res.status(403).json({ error: "Only the brand who placed this bid can review it" });
      }

      const newStatus = action === "approve" ? "accepted" : "revision_requested";
      const updatedBid = await storage.updateBidStatus(bidId, newStatus, {
        reviewNote: action === "request_revision" ? (note || "Changes requested") : undefined,
      });

      console.log(`[Bids] Bid ${bidId} reviewed: ${action} by ${callerEmail}`);
      res.json({ success: true, bid: updatedBid });
    } catch (err: any) {
      console.error("[Bids] Error reviewing bid:", err.message);
      res.status(500).json({ error: "Failed to review bid" });
    }
  });

  // Get review context for a shared link (public — used by SharedView to show approve/reject UI)
  app.get("/api/share/:slug/review-context", async (req: any, res) => {
    try {
      const { slug } = req.params;
      if (!slug) return res.status(400).json({ error: "Slug is required" });

      // Find the monetization item that uses this slug as its review link
      const allBids = await storage.getMonetizationItems();
      const bid = allBids.find((b: any) => b.reviewSlug === slug);

      if (!bid) {
        return res.json({ bidId: null });
      }

      res.json({
        bidId: bid.id,
        bidStatus: bid.status,
        brandEmail: bid.brandEmail,
        brandName: bid.brandName,
        bidAmount: bid.bidAmount,
        reviewNote: bid.reviewNote || null,
      });
    } catch (err: any) {
      console.error("[Share] Error fetching review context:", err.message);
      res.status(500).json({ error: "Failed to fetch review context" });
    }
  });

  // Map category to creator display names for demo
  const CREATOR_NAMES: Record<string, string> = {
    "Tech Guru": "TechVision Pro",
    "Travel Diaries": "WanderlustMedia",
    "Chef Life": "CulinaryMasters",
    "Fitness Fusion": "FitLifeStudio",
    "Artistry": "CreativeCanvas",
    "Gaming Zone": "GamerzHQ Elite",
    "Beauty Lab": "GlamourStudio",
    "DIY Masters": "BuildItBetter",
    "Music Studio": "SoundWaveHQ",
    "Coffee Corner": "BaristaCraft",
  };

  // Static demo campaigns for pitch mode - NEVER queries database
  // Includes BOTH camelCase AND snake_case keys for full compatibility
  const STATIC_DEMO_CAMPAIGNS = [
    { id: 2001, videoId: 1001, video_id: 1001, youtubeId: "demo-1", youtube_id: "demo-1", title: "Tech Review Series", thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", creatorName: "TechVision", creator_name: "TechVision", viewCount: 1250000, view_count: 1250000, sceneValue: 85, scene_value: 85, context: "Tech", genre: "Tech", sceneType: "Desk", scene_type: "Desk", surfaces: ["Monitor", "Desk", "Wall"], surfaceCount: 3, surface_count: 3, duration: "12:34", brand: "Sony", brandName: "Sony", brand_name: "Sony", budget: 5000, budget_pool: 5000, status: "Active", category: "Tech" },
    { id: 2002, videoId: 1002, video_id: 1002, youtubeId: "demo-2", youtube_id: "demo-2", title: "Morning Routine Vlog", thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", creatorName: "LifestyleMax", creator_name: "LifestyleMax", viewCount: 890000, view_count: 890000, sceneValue: 65, scene_value: 65, context: "Lifestyle", genre: "Lifestyle", sceneType: "Interior", scene_type: "Interior", surfaces: ["Table", "Shelf", "Counter"], surfaceCount: 3, surface_count: 3, duration: "8:45", brand: "Nespresso", brandName: "Nespresso", brand_name: "Nespresso", budget: 3500, budget_pool: 3500, status: "Active", category: "Lifestyle" },
    { id: 2003, videoId: 1003, video_id: 1003, youtubeId: "demo-3", youtube_id: "demo-3", title: "Gaming Setup Showcase", thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", creatorName: "GamerzHQ", creator_name: "GamerzHQ", viewCount: 2100000, view_count: 2100000, sceneValue: 120, scene_value: 120, context: "Gaming", genre: "Gaming", sceneType: "Desk", scene_type: "Desk", surfaces: ["Monitor", "Desk", "RGB Wall"], surfaceCount: 3, surface_count: 3, duration: "15:22", brand: "Razer", brandName: "Razer", brand_name: "Razer", budget: 8000, budget_pool: 8000, status: "Active", category: "Gaming" },
    { id: 2004, videoId: 1004, video_id: 1004, youtubeId: "demo-4", youtube_id: "demo-4", title: "Home Office Tour", thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", creatorName: "DIYCreative", creator_name: "DIYCreative", viewCount: 675000, view_count: 675000, sceneValue: 55, scene_value: 55, context: "Office", genre: "DIY", sceneType: "Wall", scene_type: "Wall", surfaces: ["Wall", "Desk", "Bookshelf"], surfaceCount: 3, surface_count: 3, duration: "10:15", brand: "IKEA", brandName: "IKEA", brand_name: "IKEA", budget: 2500, budget_pool: 2500, status: "Active", category: "DIY" },
    { id: 2005, videoId: 1005, video_id: 1005, youtubeId: "demo-5", youtube_id: "demo-5", title: "Tech Unboxing Session", thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", creatorName: "UnboxDaily", creator_name: "UnboxDaily", viewCount: 1450000, view_count: 1450000, sceneValue: 95, scene_value: 95, context: "Product", genre: "Tech", sceneType: "Product", scene_type: "Product", surfaces: ["Table", "Product", "Hands"], surfaceCount: 3, surface_count: 3, duration: "18:30", brand: "Samsung", brandName: "Samsung", brand_name: "Samsung", budget: 6000, budget_pool: 6000, status: "Active", category: "Tech" },
    { id: 2006, videoId: 1006, video_id: 1006, youtubeId: "demo-6", youtube_id: "demo-6", title: "Cozy Reading Corner", thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", creatorName: "BookishVibes", creator_name: "BookishVibes", viewCount: 320000, view_count: 320000, sceneValue: 45, scene_value: 45, context: "Lifestyle", genre: "Books", sceneType: "Interior", scene_type: "Interior", surfaces: ["Bookshelf", "Chair", "Lamp"], surfaceCount: 3, surface_count: 3, duration: "6:30", brand: "Amazon Kindle", brandName: "Amazon Kindle", brand_name: "Amazon Kindle", budget: 2000, budget_pool: 2000, status: "Active", category: "Lifestyle" },
    { id: 2007, videoId: 1007, video_id: 1007, youtubeId: "demo-7", youtube_id: "demo-7", title: "Creative Studio Setup", thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", creatorName: "StudioCraft", creator_name: "StudioCraft", viewCount: 540000, view_count: 540000, sceneValue: 72, scene_value: 72, context: "Creative", genre: "Vlog", sceneType: "Desk", scene_type: "Desk", surfaces: ["Monitor", "Camera", "Lighting"], surfaceCount: 3, surface_count: 3, duration: "14:17", brand: "Adobe", brandName: "Adobe", brand_name: "Adobe", budget: 4500, budget_pool: 4500, status: "Active", category: "Creative" },
    { id: 2008, videoId: 1008, video_id: 1008, youtubeId: "demo-8", youtube_id: "demo-8", title: "Productivity App Showcase", thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", creatorName: "ProductivityPro", creator_name: "ProductivityPro", viewCount: 410000, view_count: 410000, sceneValue: 68, scene_value: 68, context: "Productivity", genre: "Productivity", sceneType: "Screen", scene_type: "Screen", surfaces: ["Monitor", "Phone", "Tablet"], surfaceCount: 3, surface_count: 3, duration: "11:45", brand: "Notion", brandName: "Notion", brand_name: "Notion", budget: 3000, budget_pool: 3000, status: "Active", category: "Productivity" },
    { id: 2009, videoId: 1009, video_id: 1009, youtubeId: "demo-9", youtube_id: "demo-9", title: "MacBook Deep Dive", thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", creatorName: "TechInsider", creator_name: "TechInsider", viewCount: 980000, view_count: 980000, sceneValue: 85, scene_value: 85, context: "Tech", genre: "Tech", sceneType: "Product", scene_type: "Product", surfaces: ["Laptop", "Desk", "Accessories"], surfaceCount: 3, surface_count: 3, duration: "16:42", brand: "Apple", brandName: "Apple", brand_name: "Apple", budget: 7500, budget_pool: 7500, status: "Active", category: "Tech" },
    { id: 2010, videoId: 1010, video_id: 1010, youtubeId: "demo-10", youtube_id: "demo-10", title: "Minimalist Home Tour", thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", creatorName: "MinimalVibes", creator_name: "MinimalVibes", viewCount: 275000, view_count: 275000, sceneValue: 52, scene_value: 52, context: "Lifestyle", genre: "Lifestyle", sceneType: "Interior", scene_type: "Interior", surfaces: ["Wall", "Furniture", "Decor"], surfaceCount: 3, surface_count: 3, duration: "9:18", brand: "West Elm", brandName: "West Elm", brand_name: "West Elm", budget: 2200, budget_pool: 2200, status: "Active", category: "Lifestyle" },
    { id: 2011, videoId: 1011, video_id: 1011, youtubeId: "demo-11", youtube_id: "demo-11", title: "iPhone Review Special", thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", creatorName: "PhoneGeek", creator_name: "PhoneGeek", viewCount: 1680000, view_count: 1680000, sceneValue: 91, scene_value: 91, context: "Tech", genre: "Tech", sceneType: "Product", scene_type: "Product", surfaces: ["Phone", "Table", "Accessories"], surfaceCount: 3, surface_count: 3, duration: "13:55", brand: "Apple", brandName: "Apple", brand_name: "Apple", budget: 8500, budget_pool: 8500, status: "Active", category: "Tech" },
    { id: 2012, videoId: 1012, video_id: 1012, youtubeId: "demo-12", youtube_id: "demo-12", title: "Budget Tech Accessories", thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", creatorName: "BudgetTech", creator_name: "BudgetTech", viewCount: 520000, view_count: 520000, sceneValue: 63, scene_value: 63, context: "Tech", genre: "Tech", sceneType: "Product", scene_type: "Product", surfaces: ["Desk", "Products", "Table"], surfaceCount: 3, surface_count: 3, duration: "11:20", brand: "Anker", brandName: "Anker", brand_name: "Anker", budget: 2800, budget_pool: 2800, status: "Active", category: "Tech" },
    { id: 2013, videoId: 1013, video_id: 1013, youtubeId: "demo-13", youtube_id: "demo-13", title: "WFH Productivity Guide", thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", creatorName: "RemoteWorker", creator_name: "RemoteWorker", viewCount: 445000, view_count: 445000, sceneValue: 70, scene_value: 70, context: "Productivity", genre: "Productivity", sceneType: "Desk", scene_type: "Desk", surfaces: ["Monitor", "Desk", "Chair"], surfaceCount: 3, surface_count: 3, duration: "8:33", brand: "Herman Miller", brandName: "Herman Miller", brand_name: "Herman Miller", budget: 4000, budget_pool: 4000, status: "Active", category: "Productivity" },
    { id: 2014, videoId: 1014, video_id: 1014, youtubeId: "demo-14", youtube_id: "demo-14", title: "Creator Starter Kit", thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", creatorName: "ContentPro", creator_name: "ContentPro", viewCount: 710000, view_count: 710000, sceneValue: 77, scene_value: 77, context: "Creative", genre: "Tech", sceneType: "Desk", scene_type: "Desk", surfaces: ["Camera", "Mic", "Lighting"], surfaceCount: 3, surface_count: 3, duration: "14:48", brand: "Rode", brandName: "Rode", brand_name: "Rode", budget: 5500, budget_pool: 5500, status: "Active", category: "Creative" },
    { id: 2015, videoId: 1015, video_id: 1015, youtubeId: "demo-15", youtube_id: "demo-15", title: "Aesthetic Room Makeover", thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", creatorName: "AestheticLife", creator_name: "AestheticLife", viewCount: 390000, view_count: 390000, sceneValue: 58, scene_value: 58, context: "Lifestyle", genre: "Lifestyle", sceneType: "Interior", scene_type: "Interior", surfaces: ["Wall", "Furniture", "Decor"], surfaceCount: 3, surface_count: 3, duration: "7:22", brand: "Anthropologie", brandName: "Anthropologie", brand_name: "Anthropologie", budget: 2400, budget_pool: 2400, status: "Active", category: "Lifestyle" },
    { id: 2016, videoId: 1016, video_id: 1016, youtubeId: "demo-16", youtube_id: "demo-16", title: "Standing Desk Experience", thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", creatorName: "HealthyWork", creator_name: "HealthyWork", viewCount: 285000, view_count: 285000, sceneValue: 54, scene_value: 54, context: "Productivity", genre: "Productivity", sceneType: "Desk", scene_type: "Desk", surfaces: ["Desk", "Monitor", "Chair"], surfaceCount: 3, surface_count: 3, duration: "10:05", brand: "Uplift", brandName: "Uplift", brand_name: "Uplift", budget: 3200, budget_pool: 3200, status: "Active", category: "Productivity" },
    { id: 2017, videoId: 1017, video_id: 1017, youtubeId: "demo-17", youtube_id: "demo-17", title: "Ultimate Cable Setup", thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", creatorName: "CleanDesk", creator_name: "CleanDesk", viewCount: 620000, view_count: 620000, sceneValue: 74, scene_value: 74, context: "DIY", genre: "DIY", sceneType: "Desk", scene_type: "Desk", surfaces: ["Cables", "Desk", "Organizers"], surfaceCount: 3, surface_count: 3, duration: "12:38", brand: "Cable Matters", brandName: "Cable Matters", brand_name: "Cable Matters", budget: 1800, budget_pool: 1800, status: "Active", category: "DIY" },
    { id: 2018, videoId: 1018, video_id: 1018, youtubeId: "demo-18", youtube_id: "demo-18", title: "Keyboard Enthusiast Guide", thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", creatorName: "KeyboardNerd", creator_name: "KeyboardNerd", viewCount: 830000, view_count: 830000, sceneValue: 82, scene_value: 82, context: "Tech", genre: "Tech", sceneType: "Product", scene_type: "Product", surfaces: ["Keyboard", "Desk", "Accessories"], surfaceCount: 3, surface_count: 3, duration: "15:10", brand: "Keychron", brandName: "Keychron", brand_name: "Keychron", budget: 4200, budget_pool: 4200, status: "Active", category: "Tech" },
    { id: 2019, videoId: 1019, video_id: 1019, youtubeId: "demo-19", youtube_id: "demo-19", title: "Monitor Selection Guide", thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", creatorName: "DisplayPro", creator_name: "DisplayPro", viewCount: 490000, view_count: 490000, sceneValue: 67, scene_value: 67, context: "Tech", genre: "Tech", sceneType: "Product", scene_type: "Product", surfaces: ["Monitor", "Desk", "Stand"], surfaceCount: 3, surface_count: 3, duration: "13:25", brand: "LG", brandName: "LG", brand_name: "LG", budget: 5000, budget_pool: 5000, status: "Active", category: "Tech" },
    { id: 2020, videoId: 1020, video_id: 1020, youtubeId: "demo-20", youtube_id: "demo-20", title: "Creator Day Documentary", thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", thumbnail_url: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", creatorName: "VlogMaster", creator_name: "VlogMaster", viewCount: 560000, view_count: 560000, sceneValue: 61, scene_value: 61, context: "Vlog", genre: "Vlog", sceneType: "Various", scene_type: "Various", surfaces: ["Studio", "Street", "Home"], surfaceCount: 3, surface_count: 3, duration: "10:50", brand: "GoPro", brandName: "GoPro", brand_name: "GoPro", budget: 3800, budget_pool: 3800, status: "Active", category: "Vlog" },
  ];

  // Public demo endpoint for brand marketplace discovery (NO database query)
  // Completely decoupled from real user data for pitch mode
  app.get("/api/demo/brand-discovery", (req, res) => {
    console.log(`[DEMO] Returning ${STATIC_DEMO_CAMPAIGNS.length} static demo campaigns (no DB query)`);
    res.json({ opportunities: STATIC_DEMO_CAMPAIGNS, total: STATIC_DEMO_CAMPAIGNS.length });
  });

  // Normalize video file paths to browser-safe URLs
  function normalizeVideoUrl(filePath: string): string {
    return filePath
      .replace(/^\.\/public\//, '/')
      .replace(/^public\//, '/')
      .replace(/^\/home\/runner\/workspace\/public\//, '/')
      .replace(/\/\//g, '/');
  }

  // BRAND MARKETPLACE: Get Ready videos for discovery (brand view)
  app.get("/api/brand/discovery", isGoogleAuthenticated, async (req: any, res) => {
    try {
      const videos = await storage.getReadyVideosForMarketplace();

      // Transform videos into marketplace opportunities format
      const opportunities = await Promise.all(videos.map(async (video) => {
        // For local uploads, prefer extracted frame or on-demand frame endpoint over DB thumbnail (which may be a stock photo)
        let thumbnailUrl = video.thumbnailUrl;
        if (video.filePath || video.platform === "fullscale") {
          // Check if a frame exists — support both Object Storage and local filesystem
          const frameUrl = `/uploads/frames/${video.id}/frame_0s.jpg`;
          const storageFrameKey = `public/uploads/frames/${video.id}/frame_0s.jpg`;
          let frameExists = false;
          try {
            if (await fileExistsInStorage(storageFrameKey)) {
              thumbnailUrl = `/storage/uploads/frames/${video.id}/frame_0s.jpg`;
              frameExists = true;
            } else {
              const framePath = path.join(process.cwd(), "public", frameUrl);
              frameExists = fs.existsSync(framePath);
              if (frameExists) thumbnailUrl = frameUrl;
            }
          } catch {
            frameExists = false;
          }
          if (!frameExists) {
            // Use on-demand frame endpoint as fallback
            thumbnailUrl = `/api/video/${video.id}/frame/0`;
          }
        }

        // Look up creator slug from allowedUsers by video owner email
        const creatorUser = await storage.getAllowedUser(video.userId);
        const creatorSlug = creatorUser?.slug || null;

        return {
        id: video.id,
        videoId: video.id,
        youtubeId: video.youtubeId,
        title: video.title,
        thumbnailUrl,
        creatorName: creatorUser?.name || CREATOR_NAMES[video.category || ""] || video.category || "Pro Creator",
        creatorSlug,
        viewCount: video.viewCount,
        sceneValue: Math.round(video.priorityScore * 1.2), // Derive value from priority
        context: video.contexts?.[0] || video.category || "General",
        genre: video.category || "Lifestyle",
        sceneType: video.surfaces?.[0]?.surfaceType || "Desk",
        surfaces: Array.from(new Set(video.surfaces?.filter(s => s.surfaceType !== "Filtered").map(s => s.surfaceType) || [])),
        duration: video.duration || "10:00",
        platform: video.platform === "fullscale" || video.filePath ? "fullscale" : (video.platform || "youtube"),
        filePath: video.filePath || null,
        videoUrl: video.filePath ? (video.filePath.startsWith('/storage/') ? video.filePath : normalizeVideoUrl(video.filePath)) : null,
        subcategory: video.subcategory || null,
      };
      }));

      res.json({ opportunities, total: opportunities.length });
    } catch (err: any) {
      console.error("Error fetching brand discovery:", err);
      res.status(500).json({ error: "Failed to fetch discovery" });
    }
  });

  // Admin emails that can switch between roles
  const ADMIN_EMAILS = ["martin@gofullscale.co", "martin@whtwrks.com", "martincekechukwu@gmail.com", "thekimkwilson@gmail.com", "tamara@whtwrks.com"];

  // Get user type (creator or brand) for routing - supports admin role override
  // Supports: Google OAuth, Replit OIDC, Facebook session auth
  app.get("/api/auth/user-type", async (req: any, res) => {
    let email: string | null = null;
    
    // Try Google OAuth session first
    if (req.session?.googleUser?.email) {
      email = req.session.googleUser.email;
    }
    // Try Replit OIDC Auth (Passport-based)
    else if (req.isAuthenticated && req.isAuthenticated() && req.user?.claims?.email) {
      email = req.user.claims.email;
    }
    // Try Facebook session auth (via req.session.userId)
    else if (req.session?.userId) {
      const user = await storage.getUserById(req.session.userId);
      if (user) {
        email = user.email;
      }
    }
    
    // Return null for unauthenticated users - no 401 loop
    if (!email) {
      return res.json({ authenticated: false, userType: null });
    }
    
    const allowedUser = await storage.getAllowedUser(email);
    const isAdmin = ADMIN_EMAILS.includes(email);
    
    // Check for session-based role override (admin switching)
    const viewRole = (req.session as any).viewRole;
    const effectiveRole = viewRole || allowedUser?.userType || "creator";
    
    res.json({
      authenticated: true,
      email,
      name: allowedUser?.name || null,
      slug: allowedUser?.slug || null,
      userType: effectiveRole,
      baseUserType: allowedUser?.userType || "creator",
      companyName: allowedUser?.companyName,
      isAdmin,
      canSwitchRoles: isAdmin,
    });
  });

  // Admin role switching endpoint
  app.post("/api/auth/switch-role", isGoogleAuthenticated, async (req: any, res) => {
    const email = req.googleUser.email;
    const isAdmin = ADMIN_EMAILS.includes(email);
    
    if (!isAdmin) {
      return res.status(403).json({ error: "Only admins can switch roles" });
    }
    
    const { role } = req.body;
    if (!role || !["creator", "brand"].includes(role)) {
      return res.status(400).json({ error: "Invalid role. Must be 'creator' or 'brand'" });
    }
    
    // Store role override in session
    (req.session as any).viewRole = role;
    
    req.session.save((err: any) => {
      if (err) {
        console.error("Error saving session:", err);
        return res.status(500).json({ error: "Failed to save role switch" });
      }
      
      res.json({ 
        success: true, 
        viewRole: role,
        redirectTo: role === "brand" ? "/marketplace" : "/"
      });
    });
  });

  // Sync Facebook and Instagram content into video library
  // Supports both GET (for testing) and POST (for production use)
  app.all("/api/sync/facebook-instagram", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      // Get user identifier from multiple auth methods
      const sessionUserId = req.session?.userId;
      const googleEmail = req.googleUser?.email;
      const replitSub = req.user?.claims?.sub;
      const replitEmail = req.user?.claims?.email;
      
      if (!sessionUserId && !googleEmail && !replitSub) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      // Find user using multiple methods (support both ID and email-based lookups)
      let user = null;
      
      // Try session userId first (works for Facebook-auth users)
      if (sessionUserId) {
        user = await db.query.users.findFirst({
          where: eq(users.id, sessionUserId),
        });
      }
      
      // Try Google email (works for Google OAuth users)
      if (!user && googleEmail) {
        user = await db.query.users.findFirst({
          where: eq(users.id, googleEmail),
        });
        // Also try by email field
        if (!user) {
          user = await db.query.users.findFirst({
            where: eq(users.email, googleEmail),
          });
        }
      }
      
      // Try Replit OIDC
      if (!user && replitSub) {
        user = await db.query.users.findFirst({
          where: eq(users.id, replitSub),
        });
      }
      if (!user && replitEmail) {
        user = await db.query.users.findFirst({
          where: eq(users.email, replitEmail),
        });
      }
      
      if (!user) {
        return res.status(404).json({ error: "User not found. Please reconnect your Facebook account." });
      }
      
      // Try to get access token from database first, then session
      let accessToken: string | null = null;
      
      if (user.facebookAccessToken) {
        accessToken = decrypt(user.facebookAccessToken);
        console.log("[Sync] Using database token");
      } else if (req.session?.facebookProfile?.accessToken) {
        // Fallback to session token and try to save it to DB
        accessToken = req.session.facebookProfile.accessToken;
        console.log("[Sync] Using session token - attempting to save to database");
        
        // Try to save the token to database now
        try {
          await db.update(users).set({
            facebookAccessToken: encrypt(accessToken!),
            facebookId: req.session.facebookProfile.id,
          }).where(eq(users.id, user.id));
          console.log("[Sync] Successfully saved token to database");
        } catch (saveErr) {
          console.error("[Sync] Failed to save token to database:", saveErr);
        }
      }
      
      if (!accessToken) {
        return res.status(400).json({ error: "Facebook not connected. Please connect your Facebook account first." });
      }
      
      // Use the user's ID for storing videos
      const userIdForVideos = user.id;
      
      // Get Page and Instagram Business Account info
      let pageId = user.facebookPageId;
      let instagramBusinessId = user.instagramBusinessId;
      
      let facebookImported = 0;
      let instagramImported = 0;
      let personalImported = 0;
      
      // Import from personal profile (always try - uses user_videos permission)
      console.log("[Sync] Importing from personal profile...");
      try {
        personalImported = await importPersonalVideos(userIdForVideos, accessToken);
      } catch (err) {
        console.log("[Sync] Could not import personal videos:", err);
      }
      
      // If user has a Page selected, import videos from it
      if (pageId) {
        console.log(`[Sync] Importing from selected Page ${pageId}...`);
        try {
          // Use user access token directly (works for Business Manager Pages)
          facebookImported = await importFacebookVideos(userIdForVideos, pageId, accessToken);
        } catch (err) {
          console.log("[Sync] Could not import Page videos:", err);
        }
      } else {
        // Try to find and import from available Pages using granular_scopes
        console.log("[Sync] No Page selected, checking for available Pages via granular_scopes...");
        try {
          // Debug token to get Page IDs from granular_scopes
          const debugUrl = `https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${accessToken}`;
          const debugResponse = await fetch(debugUrl);
          const debugData = await debugResponse.json();
          
          let pageIds: string[] = [];
          if (debugData.data?.granular_scopes) {
            const pagesScope = debugData.data.granular_scopes.find((s: any) => s.scope === "pages_show_list");
            if (pagesScope?.target_ids) {
              pageIds = pagesScope.target_ids;
            }
          }
          
          if (pageIds.length > 0) {
            console.log(`[Sync] Found ${pageIds.length} Pages in granular_scopes`);
            
            // Import from all available Pages
            for (const pId of pageIds) {
              try {
                const imported = await importFacebookVideos(userIdForVideos, pId, accessToken);
                facebookImported += imported;
                console.log(`[Sync] Imported ${imported} videos from Page ${pId}`);
              } catch (pageErr) {
                console.log(`[Sync] Could not import from Page ${pId}:`, pageErr);
              }
            }
            
            // Update user with first Page data
            if (pageIds.length > 0) {
              const firstPageUrl = `https://graph.facebook.com/v18.0/${pageIds[0]}?fields=id,name,fan_count,instagram_business_account&access_token=${accessToken}`;
              const firstPageResponse = await fetch(firstPageUrl);
              const firstPageData = await firstPageResponse.json();
              
              if (firstPageData.id) {
                const updateData: Record<string, any> = {
                  facebookPageId: firstPageData.id,
                  facebookPageName: firstPageData.name,
                  facebookFollowers: firstPageData.fan_count || 0,
                };
                
                // Check for Instagram Business Account
                if (firstPageData.instagram_business_account?.id) {
                  const igId = firstPageData.instagram_business_account.id;
                  const igUrl = `https://graph.facebook.com/v18.0/${igId}?fields=username,followers_count&access_token=${accessToken}`;
                  const igResponse = await fetch(igUrl);
                  const igData = await igResponse.json();
                  
                  if (igData.username) {
                    updateData.instagramBusinessId = igId;
                    updateData.instagramHandle = `@${igData.username}`;
                    updateData.instagramFollowers = igData.followers_count || 0;
                    instagramBusinessId = igId;
                  }
                }
                
                await db.update(users).set(updateData).where(eq(users.id, user.id));
                console.log(`[Sync] Updated user ${user.id} with Page data: ${firstPageData.name}`);
              }
            }
          } else {
            console.log("[Sync] No Facebook Pages found in granular_scopes - only personal profile imported");
          }
        } catch (err) {
          console.log("[Sync] Could not fetch Page data:", err);
        }
      }
      
      // Import Instagram media - find Instagram Business Accounts from Pages via granular_scopes
      let igId = instagramBusinessId || user.instagramBusinessId;
      
      if (!igId) {
        // Try to find Instagram Business Accounts from all Pages
        console.log("[Sync] Looking for Instagram Business Accounts on Pages...");
        try {
          const debugUrl = `https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${accessToken}`;
          const debugResponse = await fetch(debugUrl);
          const debugData = await debugResponse.json();
          
          let pageIds: string[] = [];
          if (debugData.data?.granular_scopes) {
            const pagesScope = debugData.data.granular_scopes.find((s: any) => s.scope === "pages_show_list");
            if (pagesScope?.target_ids) {
              pageIds = pagesScope.target_ids;
            }
          }
          
          for (const pId of pageIds) {
            const pageUrl = `https://graph.facebook.com/v18.0/${pId}?fields=instagram_business_account&access_token=${accessToken}`;
            const pageResponse = await fetch(pageUrl);
            const pageData = await pageResponse.json();
            
            if (pageData.instagram_business_account?.id) {
              igId = pageData.instagram_business_account.id;
              console.log(`[Sync] Found Instagram Business Account ${igId} on Page ${pId}`);
              
              // Fetch Instagram username and update user
              const igUrl = `https://graph.facebook.com/v18.0/${igId}?fields=username,followers_count&access_token=${accessToken}`;
              const igResponse = await fetch(igUrl);
              const igData = await igResponse.json();
              
              if (igData.username) {
                await db.update(users).set({
                  instagramBusinessId: igId,
                  instagramHandle: `@${igData.username}`,
                  instagramFollowers: igData.followers_count || 0,
                }).where(eq(users.id, user.id));
                console.log(`[Sync] Updated user with Instagram: @${igData.username}`);
              }
              break; // Use first found Instagram account
            }
          }
        } catch (err) {
          console.log("[Sync] Could not find Instagram Business Accounts:", err);
        }
      }
      
      if (igId) {
        console.log(`[Sync] Importing Instagram media from ${igId}...`);
        try {
          // Use user access token directly (works for Business Manager Pages)
          instagramImported = await importInstagramMedia(userIdForVideos, igId, accessToken);
        } catch (err) {
          console.log("[Sync] Could not import Instagram media:", err);
        }
      } else {
        console.log("[Sync] No Instagram Business Account found on any Page");
      }
      
      const totalFacebookImported = personalImported + facebookImported;
      res.json({
        success: true,
        personalVideos: personalImported,
        pageVideos: facebookImported,
        facebookVideos: totalFacebookImported,
        instagramVideos: instagramImported,
        message: `Imported ${personalImported} personal videos, ${facebookImported} Page videos, and ${instagramImported} Instagram videos/reels`
      });
    } catch (error: any) {
      console.error("[Sync] Error syncing Facebook/Instagram:", error);
      res.status(500).json({ error: error.message || "Failed to sync content" });
    }
  });

  // Get available Facebook sources (personal profile + pages) for selection
  app.get("/api/facebook/sources", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const googleEmail = req.googleUser?.email || req.session?.googleUser?.email;
      const sessionUserId = req.session?.userId;
      
      // Find user
      let user = null;
      if (googleEmail) {
        user = await db.query.users.findFirst({
          where: eq(users.email, googleEmail),
        });
      }
      if (!user && sessionUserId) {
        user = await db.query.users.findFirst({
          where: eq(users.id, sessionUserId),
        });
      }
      
      // Try to get access token from database first, then session
      let accessToken: string | null = null;
      
      if (user?.facebookAccessToken) {
        accessToken = decrypt(user.facebookAccessToken);
      } else if (req.session?.facebookProfile?.accessToken) {
        // Fallback to session token
        accessToken = req.session.facebookProfile.accessToken;
        console.log("[Sources] Using session token instead of DB token");
      }
      
      if (!accessToken) {
        return res.status(400).json({ 
          error: "Facebook not connected. Please connect your Facebook account first." 
        });
      }
      const sources: Array<{
        id: string;
        name: string;
        type: "personal" | "page";
        followers?: number;
        profilePicture?: string;
        instagramAccount?: { id: string; username: string; followers: number } | null;
      }> = [];
      
      // Add personal profile as an option
      try {
        const meUrl = `https://graph.facebook.com/v18.0/me?fields=id,name,picture&access_token=${accessToken}`;
        const meResponse = await fetch(meUrl);
        const meData = await meResponse.json();
        
        if (meData.id) {
          sources.push({
            id: meData.id,
            name: meData.name || "Personal Profile",
            type: "personal",
            profilePicture: meData.picture?.data?.url,
          });
        }
      } catch (err) {
        console.log("[Sources] Could not fetch personal profile");
      }
      
      // Add managed Pages
      try {
        // First try /me/accounts
        const pagesUrl = `https://graph.facebook.com/v18.0/me/accounts?fields=id,name,fan_count,picture,instagram_business_account&access_token=${accessToken}`;
        console.log("[Sources] Fetching Pages from:", pagesUrl.replace(accessToken!, '[TOKEN]'));
        const pagesResponse = await fetch(pagesUrl);
        const pagesData = await pagesResponse.json();
        console.log("[Sources] Pages response:", JSON.stringify(pagesData, null, 2));
        
        if (pagesData.error) {
          console.log("[Sources] Facebook API error:", pagesData.error.message);
        }
        
        // If /me/accounts is empty, try to get Pages from token debug info (for Business Manager Pages)
        let pagesToProcess = pagesData.data || [];
        
        if (pagesToProcess.length === 0) {
          console.log("[Sources] /me/accounts empty, checking token granular_scopes...");
          
          // Debug token to get granular scopes with Page IDs
          const debugUrl = `https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${accessToken}`;
          const debugResponse = await fetch(debugUrl);
          const debugData = await debugResponse.json();
          
          if (debugData.data?.granular_scopes) {
            const pagesScope = debugData.data.granular_scopes.find((s: any) => s.scope === "pages_show_list");
            if (pagesScope?.target_ids?.length > 0) {
              console.log("[Sources] Found Page IDs in granular_scopes:", pagesScope.target_ids);
              
              // Fetch each Page directly using the user access token
              for (const pageId of pagesScope.target_ids) {
                try {
                  const pageUrl = `https://graph.facebook.com/v18.0/${pageId}?fields=id,name,fan_count,picture,instagram_business_account&access_token=${accessToken}`;
                  const pageResponse = await fetch(pageUrl);
                  const pageData = await pageResponse.json();
                  
                  if (pageData.id && !pageData.error) {
                    pagesToProcess.push(pageData);
                    console.log("[Sources] Fetched Page:", pageData.name);
                  } else if (pageData.error) {
                    console.log("[Sources] Could not fetch Page", pageId, ":", pageData.error.message);
                  }
                } catch (pageErr) {
                  console.log("[Sources] Error fetching Page", pageId);
                }
              }
            }
          }
        }
        
        if (pagesToProcess.length > 0) {
          for (const page of pagesToProcess) {
            let igAccount = null;
            
            // Fetch Instagram Business Account details if linked
            if (page.instagram_business_account?.id) {
              try {
                const igUrl = `https://graph.facebook.com/v18.0/${page.instagram_business_account.id}?fields=username,followers_count,profile_picture_url&access_token=${accessToken}`;
                const igResponse = await fetch(igUrl);
                const igData = await igResponse.json();
                
                if (igData.username) {
                  igAccount = {
                    id: page.instagram_business_account.id,
                    username: igData.username,
                    followers: igData.followers_count || 0,
                  };
                }
              } catch (igErr) {
                console.log("[Sources] Could not fetch IG for page:", page.id);
              }
            }
            
            sources.push({
              id: page.id,
              name: page.name,
              type: "page",
              followers: page.fan_count || 0,
              profilePicture: page.picture?.data?.url,
              instagramAccount: igAccount,
            });
          }
        }
      } catch (err) {
        console.log("[Sources] Could not fetch pages");
      }
      
      res.json({
        sources,
        currentSelection: {
          facebookSourceId: user?.facebookPageId || user?.facebookId || null,
          facebookSourceType: user?.facebookPageId ? "page" : "personal",
          instagramBusinessId: user?.instagramBusinessId || null,
        },
      });
    } catch (error: any) {
      console.error("[Sources] Error:", error);
      res.status(500).json({ error: error.message || "Failed to fetch Facebook sources" });
    }
  });

  // Debug endpoint to check Facebook token and permissions
  app.get("/api/facebook/debug", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const googleEmail = req.googleUser?.email || req.session?.googleUser?.email;
      let user = null;
      if (googleEmail) {
        user = await db.query.users.findFirst({
          where: eq(users.email, googleEmail),
        });
      }
      
      let accessToken: string | null = null;
      let tokenSource = "none";
      
      if (user?.facebookAccessToken) {
        accessToken = decrypt(user.facebookAccessToken);
        tokenSource = "database";
      } else if (req.session?.facebookProfile?.accessToken) {
        accessToken = req.session.facebookProfile.accessToken;
        tokenSource = "session";
      }
      
      if (!accessToken) {
        return res.json({ error: "No Facebook token available", tokenSource });
      }
      
      // Check token permissions
      const debugUrl = `https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${accessToken}`;
      const debugResponse = await fetch(debugUrl);
      const debugData = await debugResponse.json();
      
      // Get /me/accounts response
      const accountsUrl = `https://graph.facebook.com/v18.0/me/accounts?fields=id,name,fan_count,access_token&access_token=${accessToken}`;
      const accountsResponse = await fetch(accountsUrl);
      const accountsData = await accountsResponse.json();
      
      // Try to fetch Pages directly from granular_scopes
      const pageDetails: any[] = [];
      if (debugData.data?.granular_scopes) {
        const pagesScope = debugData.data.granular_scopes.find((s: any) => s.scope === "pages_show_list");
        if (pagesScope?.target_ids) {
          for (const pageId of pagesScope.target_ids) {
            try {
              const pageUrl = `https://graph.facebook.com/v18.0/${pageId}?fields=id,name,fan_count,instagram_business_account&access_token=${accessToken}`;
              const pageResponse = await fetch(pageUrl);
              const pageData = await pageResponse.json();
              
              // Try to get videos from this page
              let videos: any = null;
              try {
                const videosUrl = `https://graph.facebook.com/v18.0/${pageId}/videos?fields=id,title,description&limit=5&access_token=${accessToken}`;
                const videosResponse = await fetch(videosUrl);
                videos = await videosResponse.json();
              } catch (e) {}
              
              pageDetails.push({
                ...pageData,
                videosResponse: videos,
              });
            } catch (e) {
              pageDetails.push({ id: pageId, error: "Failed to fetch" });
            }
          }
        }
      }
      
      res.json({
        tokenSource,
        tokenInfo: debugData,
        accounts: accountsData,
        pageDetails,
        sessionFacebookProfile: req.session?.facebookProfile ? {
          id: req.session.facebookProfile.id,
          hasToken: !!req.session.facebookProfile.accessToken,
        } : null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Save selected Facebook/Instagram sources
  app.post("/api/facebook/select-source", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { facebookSourceId, facebookSourceType, instagramBusinessId } = req.body;
      
      const googleEmail = req.googleUser?.email || req.session?.googleUser?.email;
      const sessionUserId = req.session?.userId;
      
      // Find user
      let user = null;
      if (googleEmail) {
        user = await db.query.users.findFirst({
          where: eq(users.email, googleEmail),
        });
      }
      if (!user && sessionUserId) {
        user = await db.query.users.findFirst({
          where: eq(users.id, sessionUserId),
        });
      }
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Update user with selected source
      const updateData: Record<string, any> = {};
      
      if (facebookSourceType === "page" && facebookSourceId) {
        updateData.facebookPageId = facebookSourceId;
        // Clear personal profile selection if switching to page
      } else if (facebookSourceType === "personal") {
        // Clear page selection if switching to personal profile
        updateData.facebookPageId = null;
        updateData.facebookPageName = null;
      }
      
      if (instagramBusinessId !== undefined) {
        updateData.instagramBusinessId = instagramBusinessId || null;
      }
      
      if (Object.keys(updateData).length > 0) {
        await db.update(users).set(updateData).where(eq(users.id, user.id));
      }
      
      res.json({
        success: true,
        message: "Source selection saved",
        selection: {
          facebookSourceId,
          facebookSourceType,
          instagramBusinessId,
        },
      });
    } catch (error: any) {
      console.error("[SelectSource] Error:", error);
      res.status(500).json({ error: error.message || "Failed to save source selection" });
    }
  });

  // Get brand's campaigns (bids they've placed)
  app.get("/api/brand/campaigns", isGoogleAuthenticated, async (req: any, res) => {
    try {
      const brandEmail = req.googleUser.email;
      const results: any[] = [];

      // ── SOURCE 1: Actual saved placements (Live selections) ──
      const placements = await storage.getPlacementsByCreator(brandEmail);

      // Deduplicate: one entry per video (keep the most recent placement per videoId)
      // Each scan creates new surfaceIds, so we group by videoId only
      const seen = new Map<number, typeof placements[0]>();
      for (const p of placements) {
        const existing = seen.get(p.videoId);
        if (!existing || (p.createdAt && existing.createdAt && new Date(p.createdAt) > new Date(existing.createdAt))) {
          seen.set(p.videoId, p);
        }
      }
      const uniquePlacements = Array.from(seen.values());
      console.log(`[Brand Campaigns] ${placements.length} total placements → ${uniquePlacements.length} unique videos`);

      // Track which videoIds have live placements (to avoid showing duplicate bids)
      const placedVideoIds = new Set<number>();

      for (const placement of uniquePlacements) {
        placedVideoIds.add(placement.videoId);

        const video = await storage.getVideoById(placement.videoId);
        const surfaces = await storage.getDetectedSurfaces(placement.videoId);
        const surface = surfaces.find(s => s.id === placement.surfaceId);

        let productName = "Custom Product";
        let productImageUrl = placement.productImageUrl;
        if (placement.productId) {
          const product = await storage.getBrandProduct(placement.productId);
          if (product) {
            productName = product.name;
            productImageUrl = product.thumbnailUrl || product.imageUrl;
          }
        }

        // Check for linked bid amount
        let bidAmount: string | null = null;
        if (placement.bidId) {
          const bid = await storage.getBidById(placement.bidId);
          if (bid) bidAmount = bid.bidAmount;
        }

        results.push({
          id: placement.id,
          source: "placement",
          title: video?.title || "Unknown Video",
          thumbnailUrl: surface?.frameUrl || video?.thumbnailUrl || null,
          productName,
          productImageUrl,
          surfaceType: surface?.surfaceType || "Surface",
          videoId: placement.videoId,
          creatorUserId: video?.userId || null,
          bidAmount,
          viewCount: video?.viewCount || 0,
          status: "live",
          createdAt: placement.createdAt,
        });
      }

      // ── SOURCE 2: Pending bids / pitches (not yet fulfilled with a placement) ──
      const bids = await storage.getBrandCampaigns(brandEmail);
      for (const bid of bids) {
        // Skip bids for videos that already have a live placement
        if (bid.videoId && placedVideoIds.has(bid.videoId)) continue;

        const video = bid.videoId ? await storage.getVideoById(bid.videoId) : null;

        results.push({
          id: bid.id + 1000000, // Offset to avoid ID collision with placements
          source: "bid",
          title: video?.title || bid.title || "Pending Pitch",
          thumbnailUrl: video?.thumbnailUrl || bid.thumbnailUrl || null,
          productName: bid.brandName || "Brand Product",
          productImageUrl: null,
          surfaceType: bid.sceneType || "Surface",
          videoId: bid.videoId,
          creatorUserId: video?.userId || null,
          bidAmount: bid.bidAmount,
          viewCount: video?.viewCount || 0,
          status: bid.status || "pending",
          createdAt: bid.date,
        });
      }

      // Sort: pending first, then live, most recent first within each group
      results.sort((a, b) => {
        // Pending items first
        const aPending = a.status === "pending" ? 0 : 1;
        const bPending = b.status === "pending" ? 0 : 1;
        if (aPending !== bPending) return aPending - bPending;
        // Then by date descending
        const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return db - da;
      });

      res.json(results);
    } catch (err: any) {
      console.error("[Brand Campaigns] Error:", err.message);
      res.status(500).json({ error: "Failed to fetch campaigns" });
    }
  });

  // Get full YouTube channel data (with profile picture and stats)
  app.get("/api/youtube/channel", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const authEmail = req.authEmail;
    
    // Try to find connection by user ID first, then by email as fallback
    let connection = await storage.getYoutubeConnection(userId);
    if (!connection && authEmail && authEmail !== userId) {
      connection = await storage.getYoutubeConnection(authEmail);
    }
    
    if (!connection) {
      return res.json({ connected: false });
    }

    try {
      let accessToken = connection.accessToken;
      
      // Check if token is expired and refresh if needed
      if (connection.expiresAt && new Date(connection.expiresAt) < new Date()) {
        if (connection.refreshToken) {
          const refreshed = await refreshAccessToken(connection.refreshToken);
          if (refreshed) {
            accessToken = refreshed.access_token;
            await storage.upsertYoutubeConnection({
              userId: connection.userId,
              accessToken: refreshed.access_token,
              refreshToken: connection.refreshToken,
              expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
              channelId: connection.channelId,
              channelTitle: connection.channelTitle,
            });
          }
        }
      }

      const channelData = await getYoutubeChannelInfo(accessToken);
      const channel = channelData.items?.[0];

      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }

      res.json({
        connected: true,
        channelId: channel.id,
        title: channel.snippet.title,
        description: channel.snippet.description,
        profilePictureUrl: channel.snippet.thumbnails?.medium?.url || channel.snippet.thumbnails?.default?.url,
        subscriberCount: channel.statistics?.subscriberCount,
        videoCount: channel.statistics?.videoCount,
        viewCount: channel.statistics?.viewCount,
        uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads,
      });
    } catch (err: any) {
      console.error("Error fetching YouTube channel:", err);
      res.status(500).json({ error: "Failed to fetch channel data" });
    }
  });

  // Get user's latest YouTube videos (from API + local database)
  app.get("/api/youtube/videos", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const authEmail = req.authEmail;
    console.log(`[YouTube Videos] Fetching videos for userId: ${userId}, email: ${authEmail}`);
    
    // Try to find connection by user ID first, then by email as fallback
    let connection = await storage.getYoutubeConnection(userId);
    if (!connection && authEmail && authEmail !== userId) {
      connection = await storage.getYoutubeConnection(authEmail);
    }
    console.log(`[YouTube Videos] YouTube connection found: ${!!connection}`);
    
    // Always get locally stored/uploaded videos from video_index
    const localVideos = await storage.getVideoIndex(userId);
    console.log(`[YouTube Videos] Local videos found: ${localVideos.length}`);
    
    const localVideosList = localVideos.map((v: any) => ({
      id: v.youtubeId || `local-${v.id}`,
      dbId: v.id,
      title: v.title,
      thumbnailUrl: v.thumbnailUrl || (v.youtubeId ? getYouTubeThumbnailWithFallback(v.youtubeId) : '/fullscale-logo.png'),
      publishedAt: v.createdAt,
      description: v.description || '',
      platform: v.platform || 'youtube',
      scanStatus: v.scanStatus,
      filePath: v.filePath,
    }));
    
    if (!connection) {
      // Return local videos even without YouTube connection
      return res.json({ connected: false, videos: localVideosList });
    }

    try {
      let accessToken = connection.accessToken;
      
      // Check if token is expired and refresh if needed
      if (connection.expiresAt && new Date(connection.expiresAt) < new Date()) {
        if (connection.refreshToken) {
          const refreshed = await refreshAccessToken(connection.refreshToken);
          if (refreshed) {
            accessToken = refreshed.access_token;
            await storage.upsertYoutubeConnection({
              userId: connection.userId,
              accessToken: refreshed.access_token,
              refreshToken: connection.refreshToken,
              expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
              channelId: connection.channelId,
              channelTitle: connection.channelTitle,
            });
          }
        }
      }

      // First get the channel to find the uploads playlist ID
      const channelData = await getYoutubeChannelInfo(accessToken);
      const channel = channelData.items?.[0];
      const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads;

      if (!uploadsPlaylistId) {
        // Return local videos if no YouTube uploads found
        return res.json({ connected: true, videos: localVideosList });
      }

      const videosData = await getYoutubeVideos(accessToken, uploadsPlaylistId, 5);
      
      const ytVideos = (videosData.items || []).map((item: any) => {
        const videoId = item.contentDetails?.videoId || item.id;
        return {
          id: videoId,
          title: item.snippet.title,
          thumbnailUrl: getYouTubeThumbnailWithFallback(videoId),
          publishedAt: item.snippet.publishedAt,
          description: item.snippet.description,
          platform: 'youtube',
        };
      });

      // Merge YouTube API videos with local videos, avoiding duplicates
      const seenIds = new Set(ytVideos.map((v: any) => v.id));
      const mergedVideos = [...ytVideos, ...localVideosList.filter((v: any) => !seenIds.has(v.id))];

      res.json({ connected: true, videos: mergedVideos });
    } catch (err: any) {
      console.error("Error fetching YouTube videos:", err);
      // On error, still return local videos
      res.json({ connected: false, videos: localVideosList, error: "YouTube API unavailable" });
    }
  });

  // ============================================
  // Monetization Items API
  // ============================================
  app.get(api.monetization.list.path, async (req, res) => {
    const items = await storage.getMonetizationItems();
    res.json(items);
  });

  app.post(api.monetization.create.path, async (req, res) => {
    try {
      const input = api.monetization.create.input.parse(req.body);
      const item = await storage.createMonetizationItem(input);
      res.status(201).json(item);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  // ============================================
  // Allowed Users Management (Admin - Protected)
  // ============================================
  
  // Middleware to check if user is admin (uses ADMIN_EMAILS defined above)
  const isAdmin = (req: any, res: any, next: any) => {
    const googleUser = req.session?.googleUser;
    if (googleUser && ADMIN_EMAILS.includes(googleUser.email?.toLowerCase())) {
      req.authEmail = googleUser.email;
      return next();
    }
    const isDev = process.env.NODE_ENV !== 'production';
    if (isDev) {
      const adminEmail = req.query.admin_email || req.body?.admin_email;
      if (adminEmail && ADMIN_EMAILS.includes(adminEmail)) {
        req.authEmail = adminEmail;
        return next();
      }
    }
    return res.status(403).json({ error: "Admin access required" });
  };
  
  // Get all allowed users (admin only)
  app.get("/api/admin/allowed-users", isAdmin, async (req, res) => {
    const users = await storage.getAllowedUsers();
    res.json(users);
  });

  // Add allowed user (admin only)
  app.post("/api/admin/allowed-users", isAdmin, async (req, res) => {
    try {
      const { email, name } = req.body;
      if (!email || typeof email !== "string" || !email.includes("@")) {
        return res.status(400).json({ error: "Valid email is required" });
      }
      const user = await storage.addAllowedUser({ email: email.trim(), name: name?.trim() });
      res.status(201).json(user);
    } catch (err: any) {
      if (err.message?.includes("duplicate")) {
        return res.status(409).json({ error: "Email already in allowlist" });
      }
      res.status(500).json({ error: "Failed to add user" });
    }
  });

  app.post("/api/admin/test-email", isAdmin, async (req, res) => {
    try {
      const { getResendClient } = await import("./lib/resend");
      const { client, fromEmail } = await getResendClient();

      const toEmail = req.body.to || req.authEmail;
      const result = await client.emails.send({
        from: fromEmail || 'FullScale <martin@gofullscale.co>',
        to: toEmail,
        subject: 'FullScale - Test Email',
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#030712;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#030712;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="background-color:#0a1628;border-radius:12px;border:1px solid #1e293b;">
        <tr><td style="padding:30px 40px;border-bottom:1px solid #1e293b;text-align:center;">
          <h1 style="margin:0;font-size:32px;font-weight:700;letter-spacing:-0.5px;">
            <span style="color:#fff;">Full</span><span style="color:#D90429;">Scale</span>
          </h1>
          <p style="margin:8px 0 0;color:#64748b;font-size:13px;text-transform:uppercase;letter-spacing:2px;">Creator Portal</p>
        </td></tr>
        <tr><td style="padding:40px;">
          <p style="margin:0 0 20px;color:#fff;font-size:20px;font-weight:600;">Test Email Successful</p>
          <p style="margin:0 0 20px;color:#94a3b8;font-size:16px;line-height:1.8;">
            This is a test email from FullScale Creator Portal. If you're reading this, the Resend email integration is working correctly.
          </p>
          <p style="margin:0 0 20px;color:#94a3b8;font-size:16px;line-height:1.8;">
            Sent to: <strong style="color:#fff;">${toEmail}</strong><br/>
            Sent at: <strong style="color:#fff;">${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</strong>
          </p>
          <p style="margin:0;color:#fff;font-size:16px;">
            Best,<br/><strong>FullScale Team</strong>
          </p>
        </td></tr>
        <tr><td style="padding:25px 40px;background-color:#030712;border-radius:0 0 12px 12px;text-align:center;border-top:1px solid #1e293b;">
          <p style="margin:0;color:#64748b;font-size:13px;">
            FullScale Creator Portal<br/>
            <a href="https://gofullscale.co" style="color:#D90429;text-decoration:none;">gofullscale.co</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
      });

      console.log('[Resend] Test email sent to:', toEmail, result);
      res.json({ success: true, to: toEmail, result });
    } catch (err: any) {
      console.error("[Resend] Test email failed:", err);
      res.status(500).json({ error: "Failed to send test email", details: err.message });
    }
  });

  // Send cohort invite emails (admin only)
  app.post("/api/admin/send-cohort-emails", isAdmin, async (req, res) => {
    try {
      const { sendCohortInviteEmail } = await import("./lib/resend");
      
      // List of cohort members to email (from production database)
      const cohortMembers = [
        { email: "ellingtonandre7@gmail.com", firstName: "Andre" },
        { email: "chavezprocope@gmail.com", firstName: "Chavez" },
        { email: "martin.e@me.com", firstName: "Martin" },
        { email: "idia.ogala@gmail.com", firstName: "Idia" },
        { email: "simmone@capitalizevc.com", firstName: "Simmone" },
      ];
      
      // Filter by specific emails if provided
      const targetEmails = req.body.emails as string[] | undefined;
      const membersToEmail = targetEmails 
        ? cohortMembers.filter(m => targetEmails.includes(m.email))
        : cohortMembers;
      
      console.log(`[Admin] Sending cohort emails to ${membersToEmail.length} members`);
      
      const results = [];
      for (const member of membersToEmail) {
        const result = await sendCohortInviteEmail(member.email, member.firstName);
        results.push(result);
        // Small delay between emails to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      
      console.log(`[Admin] Cohort emails sent: ${successful} success, ${failed} failed`);
      
      res.json({ 
        success: true, 
        sent: successful, 
        failed, 
        results 
      });
    } catch (err: any) {
      console.error("[Admin] Failed to send cohort emails:", err);
      res.status(500).json({ error: "Failed to send emails", details: err.message });
    }
  });

  // ============================================
  // PLACEMENT PREVIEW (Compositing) — Authenticated
  // ============================================

  // Server-side product placement compositing for higher quality output
  app.post("/api/placement-preview", isAuthenticated, imageUpload.single("productImage"), async (req: any, res) => {
    try {
      const { videoId, surfaceId } = req.body;

      if (!videoId || !surfaceId) {
        return res.status(400).json({ error: "Missing videoId or surfaceId" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No product image uploaded" });
      }

      // Get surface data from DB
      const surfaces = await storage.getDetectedSurfaces(parseInt(videoId));
      const surface = surfaces.find((s: any) => s.id === parseInt(surfaceId));
      if (!surface) {
        return res.status(404).json({ error: "Surface not found" });
      }

      // Find frame file on disk
      const ts = Math.floor(Number(surface.timestamp));
      const frameFilename = `frame_${ts}s.jpg`;
      const framePath = path.join(process.cwd(), "public", "uploads", "frames", String(videoId), frameFilename);

      if (!fs.existsSync(framePath)) {
        return res.status(404).json({ error: "Frame image not found on disk" });
      }

      // Read the frame and get its dimensions
      const frameBuffer = fs.readFileSync(framePath);
      const frameMeta = await sharp(frameBuffer).metadata();
      const frameWidth = frameMeta.width || 1280;
      const frameHeight = frameMeta.height || 720;

      // Calculate bounding box in pixel coordinates (values stored as percentages 0-100)
      const bx = Math.round((parseFloat(String(surface.boundingBoxX)) / 100) * frameWidth);
      const by = Math.round((parseFloat(String(surface.boundingBoxY)) / 100) * frameHeight);
      const bw = Math.round((parseFloat(String(surface.boundingBoxWidth)) / 100) * frameWidth);
      const bh = Math.round((parseFloat(String(surface.boundingBoxHeight)) / 100) * frameHeight);

      // Read product image from memory buffer
      const productBuffer = req.file.buffer;
      const resizedProduct = await sharp(productBuffer)
        .resize(bw, bh, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();

      // Composite product onto frame
      const composited = await sharp(frameBuffer)
        .composite([
          {
            input: resizedProduct,
            left: bx,
            top: by,
            blend: "over",
          },
        ])
        .jpeg({ quality: 90 })
        .toBuffer();

      // Return the composited image
      res.set("Content-Type", "image/jpeg");
      res.set("Content-Disposition", `attachment; filename="placement-preview-${videoId}-${surfaceId}.jpg"`);
      res.send(composited);
    } catch (err: any) {
      console.error("[Placement] Compositing error:", err);
      res.status(500).json({ error: "Compositing failed", details: err.message });
    }
  });

  // ============================================
  // PUBLIC CREATOR PROFILE ROUTES (No Auth Required)
  // ============================================
  
  // Get creator by slug (email prefix) with their ready videos
  app.get("/api/public/creator/:slug", async (req, res) => {
    const { slug } = req.params;

    try {
      // Look up creator by slug in database (replaces hardcoded mapping)
      const creator = await storage.getCreatorBySlug(slug);
      if (!creator) {
        return res.status(404).json({ error: "Creator not found" });
      }
      const email = creator.email;

      // Get user profile for avatar and social stats
      const userProfile = await storage.getUserByEmail(email);

      // Get YouTube connection for subscriber stats
      const ytConnection = await storage.getYoutubeConnectionByEmail(email);

      // Build social stats (only include platforms with data)
      const socialStats: Record<string, any> = {};
      if (ytConnection?.subscriberCount || ytConnection?.totalViewCount) {
        socialStats.youtube = {
          subscribers: ytConnection.subscriberCount || 0,
          totalViews: ytConnection.totalViewCount || 0,
          channelTitle: ytConnection.channelTitle || null,
          channelId: ytConnection.channelId || null,
        };
      }
      if (userProfile?.instagramFollowers || userProfile?.instagramHandle) {
        socialStats.instagram = {
          followers: userProfile.instagramFollowers || 0,
          handle: userProfile.instagramHandle || null,
        };
      }
      if (userProfile?.facebookFollowers || userProfile?.facebookPageName) {
        socialStats.facebook = {
          followers: userProfile.facebookFollowers || 0,
          pageName: userProfile.facebookPageName || null,
        };
      }

      // Get ALL videos for creator (including those without surfaces)
      // so the full portfolio is shown on the public profile.
      //
      // Pass both the user's PK id AND their email — historically videos have
      // landed under either userId, depending on which import path created them
      // (file uploads tend to use email, IG/FB imports use the UUID id).
      // getVideoIndex's match-by-id internal lookup only resolves if the
      // first arg is the id, so passing email-only would silently miss any
      // rows keyed off the UUID.
      const allCreatorVideos = await storage.getVideoIndex(userProfile?.id || email, email);
      // Enrich each with surfaces
      const videos: any[] = [];
      for (const v of allCreatorVideos) {
        const surfaces = await storage.getDetectedSurfaces(v.id);
        videos.push({
          ...v,
          surfaces,
          surfaceCount: surfaces.length,
        });
      }

      // Compute aggregate stats
      const totalViews = videos.reduce((sum: number, v: any) => sum + (v.viewCount || 0), 0);
      const totalSurfaces = videos.reduce((sum: number, v: any) => sum + (v.surfaceCount || 0), 0);

      // Extract unique surface types across all videos
      const allSurfaceTypes = new Set<string>();
      const allCategories = new Set<string>();
      videos.forEach((v: any) => {
        (v.surfaces || []).forEach((s: any) => {
          if (s.surfaceType) allSurfaceTypes.add(s.surfaceType);
        });
        if (v.category) allCategories.add(v.category);
      });

      // Enrich videos with frame existence, surface type breakdown, and playback URLs
      // Deduplicate by title (keep the one with most surfaces)
      const seenTitles = new Set<string>();
      const deduped = videos.filter((v: any) => {
        const key = v.title?.toLowerCase().trim();
        if (seenTitles.has(key)) return false;
        seenTitles.add(key);
        return true;
      });

      const enrichedVideos = await Promise.all(deduped.map(async (v: any) => {
        const surfaceTypes = Array.from(new Set((v.surfaces || []).map((s: any) => s.surfaceType).filter(Boolean)));

        // Resolve thumbnail — check Object Storage, then local filesystem, then on-demand
        let thumbnail = null;
        if (v.filePath || v.platform === "fullscale") {
          const storageKey = `public/uploads/frames/${v.id}/frame_0s.jpg`;
          const localPath = path.join(process.cwd(), "public", "uploads", "frames", v.id.toString(), "frame_0s.jpg");
          try {
            if (await fileExistsInStorage(storageKey)) {
              thumbnail = `/storage/uploads/frames/${v.id}/frame_0s.jpg`;
            } else if (fs.existsSync(localPath)) {
              thumbnail = `/uploads/frames/${v.id}/frame_0s.jpg`;
            } else {
              thumbnail = `/api/video/${v.id}/frame/0`;
            }
          } catch {
            thumbnail = fs.existsSync(localPath)
              ? `/uploads/frames/${v.id}/frame_0s.jpg`
              : `/api/video/${v.id}/frame/0`;
          }
        } else {
          thumbnail = v.thumbnailUrl || null;
        }

        // Use streaming endpoint for reliable video playback on public profiles
        // This avoids filePath resolution issues across environments
        const videoUrl = v.filePath ? `/api/video/${v.id}/stream` : null;

        return {
          id: v.id,
          title: v.title,
          thumbnail,
          videoUrl,
          filePath: v.filePath || null,
          platform: v.platform || "youtube",
          viewCount: v.viewCount || 0,
          surfaceCount: v.surfaceCount || 0,
          surfaceTypes,
          surfaces: (v.surfaces || []).map((s: any) => ({
            id: s.id,
            timestamp: s.timestamp,
            surfaceType: s.surfaceType,
            confidence: s.confidence,
            frameUrl: s.frameUrl,
            sceneContext: s.sceneContext,
            boundingBoxX: s.boundingBoxX,
            boundingBoxY: s.boundingBoxY,
            boundingBoxWidth: s.boundingBoxWidth,
            boundingBoxHeight: s.boundingBoxHeight,
          })),
          category: v.category || null,
          duration: v.duration || null,
        };
      }));

      // Fetch the creator's connected social accounts with audience data
      // for the media-kit-style stacked cards on the public profile.
      // Tokens are stripped — the public response is brand-facing.
      const allSocialAccounts = userProfile
        ? await storage.getSocialAccountsByUser(userProfile.id, email)
        : [];
      const socialAccounts = allSocialAccounts.map(a => ({
        id: a.id,
        platform: a.platform,
        accountType: a.accountType,
        handle: a.handle,
        displayName: a.displayName,
        avatarUrl: a.avatarUrl,
        followers: a.followers,
        totalViews: a.totalViews,
        audienceData: a.audienceData,
        audienceSyncedAt: a.audienceSyncedAt,
      }));

      res.json({
        creator: {
          name: creator.name || email.split("@")[0],
          email: creator.email,
          slug: creator.slug || slug,
          profileImage: userProfile?.profileImageUrl || null,
          bio: creator.bio || null,
          headline: creator.headline || null,
          podcastName: creator.podcastName || null,
          podcastUrl: creator.podcastUrl || null,
          websiteUrl: creator.websiteUrl || null,
          userType: creator.userType || "creator",
        },
        stats: {
          totalVideos: enrichedVideos.length,
          totalViews,
          totalSurfaces,
          surfaceTypes: Array.from(allSurfaceTypes),
          categories: Array.from(allCategories),
        },
        socialStats: Object.keys(socialStats).length > 0 ? socialStats : null,
        socialAccounts,
        videos: enrichedVideos,
      });
    } catch (err: any) {
      console.error("[Public] Error fetching creator:", err);
      res.status(500).json({ error: "Failed to fetch creator" });
    }
  });

  // Get featured creators for marketplace display
  app.get("/api/public/featured-creators", async (_req, res) => {
    try {
      const featuredUsers = await storage.getFeaturedCreators();

      // Enrich each creator with stats and social data
      const creators = await Promise.all(featuredUsers.map(async (creator) => {
        const userProfile = await storage.getUserByEmail(creator.email);
        const ytConnection = await storage.getYoutubeConnectionByEmail(creator.email);
        const videosWithSurfaces = await storage.getVideosWithSurfacesPublic(creator.email);

        // Also get ALL videos for this creator (for thumbnails — not filtered by status/surfaces)
        const allCreatorVideos = await storage.getVideoIndex(creator.email);

        const totalViews = videosWithSurfaces.reduce((sum: number, v: any) => sum + (v.viewCount || 0), 0);
        const totalSurfaces = videosWithSurfaces.reduce((sum: number, v: any) => sum + (v.surfaceCount || 0), 0);

        // Get up to 4 video thumbnails — prioritize landscape videos with cached frames
        // Sort: videos with larger cached frames first (landscape frames are bigger than portrait)
        const videosWithFrameInfo = allCreatorVideos.map((v: any) => {
          const framePath = path.join(process.cwd(), "public", "uploads", "frames", v.id.toString(), "frame_0s.jpg");
          let frameSize = 0;
          try { if (fs.existsSync(framePath)) frameSize = fs.statSync(framePath).size; } catch {}
          return { ...v, framePath, frameSize };
        }).sort((a: any, b: any) => b.frameSize - a.frameSize); // Biggest frames first (landscape > portrait)

        const thumbnails = videosWithFrameInfo
          .slice(0, 4)
          .map((v: any) => {
            // Check if a cached frame already exists on disk
            if (v.frameSize > 0) {
              return `/uploads/frames/${v.id}/frame_0s.jpg`;
            }
            // Use stored thumbnailUrl
            if (v.thumbnailUrl) return v.thumbnailUrl;
            // For YouTube videos, construct thumbnail URL
            if (v.youtubeId && !v.youtubeId.startsWith("test-") && !v.youtubeId.startsWith("local-")) {
              return `https://img.youtube.com/vi/${v.youtubeId}/mqdefault.jpg`;
            }
            // For local videos, use on-demand frame endpoint
            if (v.filePath) return `/api/video/${v.id}/frame/0`;
            return null;
          })
          .filter(Boolean);

        return {
          name: creator.name || creator.email.split("@")[0],
          slug: creator.slug,
          headline: creator.headline || null,
          profileImage: userProfile?.profileImageUrl || null,
          thumbnails,
          stats: {
            totalVideos: allCreatorVideos.length,
            totalViews,
            totalSurfaces,
            subscribers: ytConnection?.subscriberCount || 0,
          },
        };
      }));

      res.json({ creators });
    } catch (err: any) {
      console.error("[Public] Error fetching featured creators:", err);
      res.status(500).json({ error: "Failed to fetch featured creators" });
    }
  });

  // Update creator profile (authenticated)
  app.patch("/api/creator/profile", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const email = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!email) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { bio, headline, podcastName, podcastUrl, websiteUrl, slug } = req.body;
      const updates: any = {};
      if (bio !== undefined) updates.bio = bio;
      if (headline !== undefined) updates.headline = headline;
      if (podcastName !== undefined) updates.podcastName = podcastName;
      if (podcastUrl !== undefined) updates.podcastUrl = podcastUrl;
      if (websiteUrl !== undefined) updates.websiteUrl = websiteUrl;
      if (slug !== undefined) {
        // Validate slug: lowercase, alphanumeric + hyphens only
        const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (cleanSlug.length < 2) {
          return res.status(400).json({ error: "Slug must be at least 2 characters" });
        }
        // Check uniqueness
        const existing = await storage.getCreatorBySlug(cleanSlug);
        if (existing && existing.email !== email.toLowerCase().trim()) {
          return res.status(409).json({ error: "Slug already taken" });
        }
        updates.slug = cleanSlug;
      }

      await storage.updateCreatorProfile(email, updates);
      res.json({ success: true });
    } catch (err: any) {
      console.error("Error updating creator profile:", err);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // Update video subcategory (authenticated)
  app.patch("/api/videos/:videoId/subcategory", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const { subcategory } = req.body;
      if (!subcategory) {
        return res.status(400).json({ error: "Subcategory is required" });
      }
      await storage.updateVideoSubcategory(videoId, subcategory);
      res.json({ success: true });
    } catch (err: any) {
      console.error("Error updating video subcategory:", err);
      res.status(500).json({ error: "Failed to update subcategory" });
    }
  });

  // Submit a placement request (public - no auth)
  app.post("/api/public/placement-request", async (req, res) => {
    const { videoId, brandName, brandEmail, message } = req.body;
    
    if (!videoId || !brandName || !brandEmail) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    try {
      // Get video info and derive creator email from video ownership
      const video = await storage.getVideoById(parseInt(videoId));
      if (!video) {
        return res.status(404).json({ error: "Video not found" });
      }
      
      // Use video's userId (which is the creator's email) for integrity
      const creatorEmail = video.userId;
      
      // Create monetization item with pending status
      const item = await storage.createMonetizationItem({
        title: `Placement Request: ${video.title}`,
        thumbnailUrl: video.thumbnailUrl,
        status: "pending",
        videoId: video.id,
        creatorUserId: creatorEmail,
        brandEmail,
        brandName,
        sceneType: message || "General",
      });
      
      console.log(`[Public] New placement request from ${brandName} (${brandEmail}) for video ${video.title}`);
      
      res.json({ success: true, message: "Request sent! The creator will be in touch." });
    } catch (err: any) {
      console.error("[Public] Error creating placement request:", err);
      res.status(500).json({ error: "Failed to submit request" });
    }
  });

  // ── Brand Product Catalog ──

  // Upload a new brand product image
  app.post("/api/brand-products", isFlexibleAuthenticated, imageUpload.single("productImage"), async (req: any, res) => {
    try {
      const userId = req.authUserId;
      const { name, category } = req.body;

      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }
      if (!name) {
        return res.status(400).json({ error: "Product name is required" });
      }

      const imageBuffer = req.file.buffer;
      const metadata = await sharp(imageBuffer).metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;
      const hasAlpha = metadata.hasAlpha || false;

      const timestamp = Date.now();
      const ext = metadata.format === "png" ? "png" : metadata.format === "webp" ? "webp" : "jpg";
      const filename = `product_${timestamp}.${ext}`;
      const thumbFilename = `product_${timestamp}_thumb.${ext}`;

      const originalBuffer = await sharp(imageBuffer).toBuffer();
      const thumbBuffer = await sharp(imageBuffer).resize(200).toBuffer();

      const { uploadBufferToStorage } = await import("./lib/objectStorage");
      const imageUrl = await uploadBufferToStorage(originalBuffer, `public/uploads/products/${filename}`);
      const thumbnailUrl = await uploadBufferToStorage(thumbBuffer, `public/uploads/products/${thumbFilename}`);

      // ── Product Ingest Analysis ──
      let subjectBoundsX: number | null = null;
      let subjectBoundsY: number | null = null;
      let subjectBoundsW: number | null = null;
      let subjectBoundsH: number | null = null;
      let dominantColor: string | null = null;
      let backgroundType: string = hasAlpha ? "transparent" : "solid";

      try {
        // 1 & 3a. Subject bounds + transparency ratio (single raw buffer decode for alpha images)
        if (hasAlpha && width > 0 && height > 0) {
          const rawBuffer = await sharp(imageBuffer)
            .ensureAlpha()
            .raw()
            .toBuffer();

          let minX = width, minY = height, maxX = 0, maxY = 0;
          let hasOpaquePixel = false;
          let transparentPixels = 0;
          const totalPixels = width * height;

          // Single pass: find subject bounds + count transparent pixels
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const alphaIndex = (y * width + x) * 4 + 3; // RGBA, alpha is 4th byte
              if (rawBuffer[alphaIndex] < 10) {
                transparentPixels++;
              } else {
                hasOpaquePixel = true;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }

          if (hasOpaquePixel) {
            subjectBoundsX = parseFloat((minX / width).toFixed(4));
            subjectBoundsY = parseFloat((minY / height).toFixed(4));
            subjectBoundsW = parseFloat(((maxX - minX + 1) / width).toFixed(4));
            subjectBoundsH = parseFloat(((maxY - minY + 1) / height).toFixed(4));
            console.log(`[Brand Products] Subject bounds: x=${subjectBoundsX}, y=${subjectBoundsY}, w=${subjectBoundsW}, h=${subjectBoundsH}`);
          }

          // Background type from transparency ratio
          const transparencyRatio = transparentPixels / totalPixels;
          if (transparencyRatio < 0.05) {
            backgroundType = "solid"; // Has alpha channel but barely any transparent pixels
          } else {
            backgroundType = "transparent"; // Normal product cutout
          }
          console.log(`[Brand Products] Background type: ${backgroundType} (${(transparencyRatio * 100).toFixed(1)}% transparent)`);
        }

        // 2. Dominant color extraction using Sharp stats
        const stats = await sharp(imageBuffer).stats();
        if (stats.channels && stats.channels.length >= 3) {
          const r = Math.round(stats.channels[0].mean);
          const g = Math.round(stats.channels[1].mean);
          const b = Math.round(stats.channels[2].mean);
          dominantColor = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
          console.log(`[Brand Products] Dominant color: ${dominantColor}`);
        }

        // 3b. Background type for non-alpha images
        if (!hasAlpha) {
          // No alpha — check if the background is uniform (solid) or complex (photo/scene)
          // Sample corners to detect solid backgrounds
          const cornerSize = Math.max(1, Math.min(20, Math.floor(Math.min(width, height) * 0.05)));
          const corners = [
            { left: 0, top: 0 },  // top-left
            { left: width - cornerSize, top: 0 },  // top-right
            { left: 0, top: height - cornerSize },  // bottom-left
            { left: width - cornerSize, top: height - cornerSize },  // bottom-right
          ];

          const cornerColors: { r: number; g: number; b: number }[] = [];
          for (const corner of corners) {
            const cornerStats = await sharp(imageBuffer)
              .extract({ left: corner.left, top: corner.top, width: cornerSize, height: cornerSize })
              .stats();
            if (cornerStats.channels && cornerStats.channels.length >= 3) {
              cornerColors.push({
                r: Math.round(cornerStats.channels[0].mean),
                g: Math.round(cornerStats.channels[1].mean),
                b: Math.round(cornerStats.channels[2].mean),
              });
            }
          }

          // If all corners are similar in color, it's a solid background
          if (cornerColors.length >= 3) {
            const avg = {
              r: cornerColors.reduce((s, c) => s + c.r, 0) / cornerColors.length,
              g: cornerColors.reduce((s, c) => s + c.g, 0) / cornerColors.length,
              b: cornerColors.reduce((s, c) => s + c.b, 0) / cornerColors.length,
            };
            const maxDiff = cornerColors.reduce((max, c) => {
              const diff = Math.abs(c.r - avg.r) + Math.abs(c.g - avg.g) + Math.abs(c.b - avg.b);
              return Math.max(max, diff);
            }, 0);
            backgroundType = maxDiff < 60 ? "solid" : "complex";
            console.log(`[Brand Products] Background type: ${backgroundType} (corner variance: ${maxDiff.toFixed(0)})`);
          }
        }
      } catch (analysisErr: any) {
        console.warn(`[Brand Products] Analysis pipeline warning (non-fatal): ${analysisErr.message}`);
        // Non-fatal — product still uploads, just without analysis data
      }

      const product = await storage.createBrandProduct({
        userId,
        name,
        imageUrl,
        thumbnailUrl,
        category: category || null,
        width,
        height,
        isTransparent: hasAlpha,
        subjectBoundsX: subjectBoundsX != null ? subjectBoundsX.toString() : null,
        subjectBoundsY: subjectBoundsY != null ? subjectBoundsY.toString() : null,
        subjectBoundsW: subjectBoundsW != null ? subjectBoundsW.toString() : null,
        subjectBoundsH: subjectBoundsH != null ? subjectBoundsH.toString() : null,
        dominantColor,
        backgroundType,
      });

      console.log(`[Brand Products] Created product "${name}" (${width}x${height}, transparent: ${hasAlpha}, bg: ${backgroundType})`);
      res.json(product);
    } catch (err: any) {
      console.error("[Brand Products] Upload error:", err.message);
      res.status(500).json({ error: "Failed to upload product image" });
    }
  });

  // List current brand's products
  app.get("/api/brand-products", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authUserId;
      const products = await storage.getBrandProducts(userId);
      res.json(products);
    } catch (err: any) {
      console.error("[Brand Products] List error:", err.message);
      res.status(500).json({ error: "Failed to list products" });
    }
  });

  // Get single product detail
  app.get("/api/brand-products/catalog", async (_req, res) => {
    try {
      const products = await storage.getAllBrandProducts();
      res.json(products);
    } catch (err: any) {
      console.error("[Brand Products] Catalog error:", err.message);
      res.status(500).json({ error: "Failed to fetch product catalog" });
    }
  });

  app.get("/api/brand-products/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const productId = parseInt(req.params.id);
      if (isNaN(productId)) {
        return res.status(400).json({ error: "Invalid product ID" });
      }
      const product = await storage.getBrandProduct(productId);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json(product);
    } catch (err: any) {
      console.error("[Brand Products] Get error:", err.message);
      res.status(500).json({ error: "Failed to fetch product" });
    }
  });

  // Delete a brand product
  app.delete("/api/brand-products/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authUserId;
      const productId = parseInt(req.params.id);
      if (isNaN(productId)) {
        return res.status(400).json({ error: "Invalid product ID" });
      }

      // Verify ownership
      const product = await storage.getBrandProduct(productId);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      if (product.userId !== userId) {
        return res.status(403).json({ error: "Not authorized to delete this product" });
      }

      // Delete image files
      try {
        const imgPath = `./public${product.imageUrl}`;
        const thumbPath = product.thumbnailUrl ? `./public${product.thumbnailUrl}` : null;
        if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      } catch (fileErr) {
        console.warn("[Brand Products] Could not cleanup files:", fileErr);
      }

      await storage.deleteBrandProduct(productId);
      console.log(`[Brand Products] Deleted product ${productId}`);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[Brand Products] Delete error:", err.message);
      res.status(500).json({ error: "Failed to delete product" });
    }
  });

  // ============================================================================
  // BRAND PLACEMENT ASSIGNMENTS — brand-initiated placement requests, creator approves
  // ============================================================================

  // GET /api/brand/placements/quote — Returns the placement fee for a given clip,
  // surface(s), and duration term without creating anything. Uses the full CPM rubric:
  // creator follower count + recent avg views + video age + clip tier + surface
  // prominence + duration commitment.
  //
  // Query: editorialClipId, surfaceIds[], durationTerm (single|1-month|3-month|6-month|12-month),
  //        isTestPlacement (admin only), customFeeCents (admin only)
  app.get("/api/brand/placements/quote", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const editorialClipId = req.query.editorialClipId ? parseInt(req.query.editorialClipId as string) : undefined;
      const videoId = req.query.videoId ? parseInt(req.query.videoId as string) : undefined;
      const durationTerm = (req.query.durationTerm as DurationTerm) || "single";
      const requestedTestMode = req.query.isTestPlacement === "true";
      const isAdmin = req.authEmail === "martin@gofullscale.co";
      const isTestPlacement = requestedTestMode && isAdmin;
      const customFeeCents =
        isAdmin && req.query.customFeeCents
          ? parseInt(req.query.customFeeCents as string)
          : null;

      // Parse surfaceIds (may be ?surfaceIds=1,2,3 or repeated query params)
      let surfaceIdsRaw: string[] = [];
      if (Array.isArray(req.query.surfaceIds)) {
        surfaceIdsRaw = req.query.surfaceIds as string[];
      } else if (typeof req.query.surfaceIds === "string") {
        surfaceIdsRaw = req.query.surfaceIds.split(",");
      }
      const surfaceIds = surfaceIdsRaw
        .map((s) => parseInt(s))
        .filter((n) => !isNaN(n));

      // Resolve clip + video
      let clip: any = null;
      let video: any = null;
      if (editorialClipId) {
        clip = await storage.getEditorialClipById(editorialClipId);
        if (!clip) return res.status(404).json({ error: "Clip not found" });
        video = await storage.getVideoById(clip.videoId);
      } else if (videoId) {
        video = await storage.getVideoById(videoId);
      }
      if (!video) {
        return res.status(400).json({ error: "Provide editorialClipId or videoId" });
      }

      // Creator stats: follower count from YouTube connection + recent avg views
      const creatorConn = await storage.getYoutubeConnection(video.userId).catch(() => null);
      const creatorFollowers = creatorConn?.subscriberCount ?? null;
      const creatorVideos = await storage
        .getVideoIndex(video.userId)
        .catch(() => [] as any[]);
      const creatorAvgViews = avgRecentViews(
        creatorVideos.map((v: any) => ({ viewCount: v.viewCount, createdAt: v.createdAt })),
        10,
      );

      // Video age (prefer publishedAt, fall back to createdAt)
      const ageDays = calcVideoAgeDays(video.publishedAt, video.createdAt);

      // Resolve surfaces (or use a placeholder if none specified — useful for "default quote")
      let surfaces: any[] = [];
      if (surfaceIds.length > 0) {
        const allSurfaces = clip
          ? await storage.getSurfacesInEditorialClip(clip.id)
          : await storage.getDetectedSurfaces(video.id);
        surfaces = allSurfaces.filter((s: any) => surfaceIds.includes(s.id));
      }

      // Quote each surface independently — bbox/type can vary, so price varies
      const perSurfaceQuotes = (surfaces.length > 0 ? surfaces : [null]).map((s: any) => {
        const breakdown = calculatePlacementPricing({
          creatorFollowerCount: creatorFollowers,
          creatorAvgViews,
          clipParentVideoViews: video.viewCount,
          contentTier: clip?.monetizationTier as any,
          videoAgeDays: ageDays,
          surface: s
            ? {
                surfaceType: s.surfaceType,
                boundingBoxWidth: parseFloat(s.boundingBoxWidth),
                boundingBoxHeight: parseFloat(s.boundingBoxHeight),
              }
            : null,
          durationTerm,
          isTestPlacement,
          customFeeCents,
        });
        return {
          surfaceId: s?.id ?? null,
          surfaceType: s?.surfaceType ?? null,
          breakdown,
        };
      });

      const totalFeeCents = perSurfaceQuotes.reduce((s, q) => s + q.breakdown.placementFeeCents, 0);
      const totalCreatorCents = perSurfaceQuotes.reduce((s, q) => s + q.breakdown.creatorPayoutCents, 0);
      const totalPlatformCents = perSurfaceQuotes.reduce((s, q) => s + q.breakdown.platformTakeCents, 0);

      res.json({
        // Inputs
        editorialClipId: clip?.id ?? null,
        videoId: video.id,
        creator: {
          followerCount: creatorFollowers,
          avgRecentViews: creatorAvgViews,
          tier: perSurfaceQuotes[0]?.breakdown.creatorTier,
        },
        video: {
          ageDays,
          viewCount: video.viewCount,
        },
        clip: clip
          ? { id: clip.id, monetizationTier: clip.monetizationTier, finalScore: clip.finalScore }
          : null,
        durationTerm,
        durationDays: perSurfaceQuotes[0]?.breakdown.durationDays ?? 0,
        // Per-surface quotes
        perSurfaceQuotes,
        surfaceCount: perSurfaceQuotes.length,
        // Totals
        totalFeeCents,
        totalFeeUsd: formatCents(totalFeeCents),
        creatorTotalPayoutCents: totalCreatorCents,
        creatorTotalPayoutUsd: formatCents(totalCreatorCents),
        platformTotalCents: totalPlatformCents,
        platformTotalUsd: formatCents(totalPlatformCents),
        // Flags
        isTestPlacement,
        isCustomOverride: perSurfaceQuotes[0]?.breakdown.isCustomOverride ?? false,
        // Rubric reference for UI display
        rubric: {
          baseCpmUsd: BASE_CPM_USD,
          creatorTiers: CREATOR_TIER_MULTIPLIER,
          contentTiers: CONTENT_TIER_MULTIPLIER,
          durationTerms: DURATION_MULTIPLIER,
        },
      });
    } catch (err: any) {
      console.error("[API] /api/brand/placements/quote error:", err.message);
      res.status(500).json({ error: err.message || "Failed to compute quote" });
    }
  });

  // POST /api/brand/placements — Brand creates one or more placement requests on a creator's clip.
  // Body: { editorialClipId | videoId, brandProductId, surfaceIds: number[], message?: string }
  // Either editorialClipId (preferred — new flow, clip-scoped) or videoId (legacy/fallback).
  // For each surfaceId: creates one assignment with status pending_creator_review.
  // Returns 409 if any surface already has an active placement (one-brand-per-surface).
  app.post("/api/brand/placements", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const brandUserId = req.authUserId;
      const { editorialClipId, videoId, brandProductId, surfaceIds, message } = req.body || {};

      if (!brandProductId || !Array.isArray(surfaceIds) || surfaceIds.length === 0) {
        return res.status(400).json({
          error: "Missing required fields: brandProductId, surfaceIds (non-empty array)",
        });
      }
      if (!editorialClipId && !videoId) {
        return res.status(400).json({
          error: "Must provide either editorialClipId or videoId",
        });
      }

      // Resolve videoId from clipId if clip-targeted mode + capture clip for pricing
      let resolvedVideoId: number;
      let clipIdForRow: number | null = null;
      let clipForPricing: any = null;
      if (editorialClipId) {
        const clip = await storage.getEditorialClipById(parseInt(editorialClipId));
        if (!clip) return res.status(404).json({ error: "Editorial clip not found" });
        resolvedVideoId = clip.videoId;
        clipIdForRow = clip.id;
        clipForPricing = clip;
      } else {
        resolvedVideoId = parseInt(videoId);
      }

      // Verify video exists and capture creator's userId
      const video = await storage.getVideoById(resolvedVideoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      const creatorUserId = video.userId;

      // Verify brand owns the product
      const product = await storage.getBrandProduct(parseInt(brandProductId));
      if (!product) return res.status(404).json({ error: "Brand product not found" });
      if (product.userId !== brandUserId) {
        return res.status(403).json({ error: "Not authorized to use this product" });
      }

      // Admin-only override flags — zero out the fee or set bespoke price
      const isAdmin = req.authEmail === "martin@gofullscale.co"; // Expand when needed
      const isTestPlacement = req.body?.isTestPlacement === true && isAdmin;
      const customFeeCents = isAdmin && typeof req.body?.customFeeCents === "number" ? req.body.customFeeCents : null;
      const negotiatedNote = typeof req.body?.negotiatedNote === "string" ? req.body.negotiatedNote : null;

      // Duration commitment (default to single one-shot placement)
      const durationTerm: DurationTerm = req.body?.durationTerm || "single";
      const validTerms: DurationTerm[] = ["single", "1-month", "3-month", "6-month", "12-month"];
      if (!validTerms.includes(durationTerm)) {
        return res.status(400).json({ error: `Invalid durationTerm. Must be one of: ${validTerms.join(", ")}` });
      }

      // Pre-flight: which surfaces are already taken
      const conflicts: { surfaceId: number; existingAssignmentId: number }[] = [];
      for (const sid of surfaceIds) {
        const existing = await storage.getActivePlacementForSurface(parseInt(sid));
        if (existing) {
          conflicts.push({ surfaceId: parseInt(sid), existingAssignmentId: existing.id });
        }
      }
      if (conflicts.length > 0) {
        return res.status(409).json({
          error: "One or more surfaces already have an active placement",
          conflicts,
        });
      }

      // Gather pricing inputs (creator stats + video age) — fetched once, reused per surface
      const creatorConn = await storage.getYoutubeConnection(video.userId).catch(() => null);
      const creatorFollowers = creatorConn?.subscriberCount ?? null;
      const creatorVideos = await storage.getVideoIndex(video.userId).catch(() => [] as any[]);
      const creatorAvgViews = avgRecentViews(
        creatorVideos.map((v: any) => ({ viewCount: v.viewCount, createdAt: v.createdAt })),
        10,
      );
      const ageDays = calcVideoAgeDays(video.publishedAt, video.createdAt);

      // Need surface details for per-surface pricing
      const allSurfaces = clipForPricing
        ? await storage.getSurfacesInEditorialClip(clipForPricing.id)
        : await storage.getDetectedSurfaces(video.id);

      const expiresAt = computeExpiresAt(durationTerm);

      // Create one assignment per surface — each gets its own price based on its bbox/type
      const created: any[] = [];
      let totalFeeCents = 0;
      let totalCreatorCents = 0;
      let totalPlatformCents = 0;

      for (const sid of surfaceIds) {
        const surface = allSurfaces.find((s: any) => s.id === parseInt(sid));
        const breakdown = calculatePlacementPricing({
          creatorFollowerCount: creatorFollowers,
          creatorAvgViews,
          clipParentVideoViews: video.viewCount,
          contentTier: (clipForPricing?.monetizationTier as any) ?? null,
          videoAgeDays: ageDays,
          surface: surface
            ? {
                surfaceType: surface.surfaceType,
                boundingBoxWidth: parseFloat(surface.boundingBoxWidth),
                boundingBoxHeight: parseFloat(surface.boundingBoxHeight),
              }
            : null,
          durationTerm,
          isTestPlacement,
          customFeeCents,
        });

        const row = await storage.createBrandPlacement({
          brandUserId,
          creatorUserId,
          videoId: resolvedVideoId,
          editorialClipId: clipIdForRow,
          brandProductId: parseInt(brandProductId),
          surfaceId: parseInt(sid),
          status: "pending_creator_review",
          brandMessage: message || null,
          placementFeeCents: breakdown.placementFeeCents,
          platformTakeCents: breakdown.platformTakeCents,
          creatorPayoutCents: breakdown.creatorPayoutCents,
          isTestPlacement: breakdown.isTestPlacement,
          customFeeCents,
          negotiatedNote,
          pricingBreakdown: breakdown,
          durationTerm,
          durationDays: breakdown.durationDays,
          expiresAt,
          chargeStatus: "pending",
        });
        created.push(row);
        totalFeeCents += breakdown.placementFeeCents;
        totalCreatorCents += breakdown.creatorPayoutCents;
        totalPlatformCents += breakdown.platformTakeCents;
      }

      console.log(
        `[BrandPlacement] Brand ${brandUserId} requested ${created.length} placement(s) ` +
          `${clipIdForRow ? `on clip ${clipIdForRow}` : `on video ${resolvedVideoId}`} ` +
          `for product ${brandProductId} — total $${formatCents(totalFeeCents)} ` +
          `(${durationTerm}${isTestPlacement ? ", TEST" : ""}${customFeeCents ? ", CUSTOM" : ""}) ` +
          `creator earns $${formatCents(totalCreatorCents)}`,
      );
      res.json({
        assignments: created,
        count: created.length,
        pricing: {
          totalFeeCents,
          totalFeeUsd: formatCents(totalFeeCents),
          creatorTotalPayoutCents: totalCreatorCents,
          creatorTotalPayoutUsd: formatCents(totalCreatorCents),
          platformTotalCents: totalPlatformCents,
          platformTotalUsd: formatCents(totalPlatformCents),
          durationTerm,
          isTestPlacement,
          isCustomOverride: customFeeCents !== null,
        },
      });
    } catch (err: any) {
      console.error("[API] /api/brand/placements POST error:", err.message);
      res.status(500).json({ error: err.message || "Failed to create placement requests" });
    }
  });

  // GET /api/brand/placements?status=... — Brand lists their own assignments.
  app.get("/api/brand/placements", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const brandUserId = req.authUserId;
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const placements = await storage.getBrandPlacements(brandUserId, status);
      res.json({ placements, count: placements.length });
    } catch (err: any) {
      console.error("[API] /api/brand/placements GET error:", err.message);
      res.status(500).json({ error: err.message || "Failed to list placements" });
    }
  });

  // POST /api/brand/placements/:id/withdraw — Brand cancels a pending request.
  app.post("/api/brand/placements/:id/withdraw", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const brandUserId = req.authUserId;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid placement ID" });

      const placement = await storage.getBrandPlacementById(id);
      if (!placement) return res.status(404).json({ error: "Placement not found" });
      if (placement.brandUserId !== brandUserId) {
        return res.status(403).json({ error: "Not authorized to withdraw this placement" });
      }
      if (!["pending_creator_review", "creator_approved"].includes(placement.status)) {
        return res.status(400).json({ error: `Cannot withdraw a ${placement.status} placement` });
      }
      const updated = await storage.updateBrandPlacementStatus(id, "brand_withdrawn");
      res.json({ placement: updated });
    } catch (err: any) {
      console.error("[API] /api/brand/placements/:id/withdraw error:", err.message);
      res.status(500).json({ error: err.message || "Failed to withdraw placement" });
    }
  });

  // GET /api/creator/placements/inbox — Creator's pending placement requests.
  app.get("/api/creator/placements/inbox", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const creatorUserId = req.authUserId;
      const status = typeof req.query.status === "string" ? req.query.status : "pending_creator_review";
      const placements = await storage.getCreatorPlacements(creatorUserId, status);

      // Hydrate with product + video + surface details so the inbox UI doesn't need 4 round-trips
      const hydrated = await Promise.all(
        placements.map(async (p) => {
          const [product, video, surfaces] = await Promise.all([
            storage.getBrandProduct(p.brandProductId),
            storage.getVideoById(p.videoId),
            storage.getDetectedSurfaces(p.videoId),
          ]);
          const surface = surfaces.find((s) => s.id === p.surfaceId);
          return {
            ...p,
            product: product
              ? { id: product.id, name: product.name, imageUrl: product.imageUrl, thumbnailUrl: product.thumbnailUrl, category: product.category }
              : null,
            video: video ? { id: video.id, title: video.title, thumbnailUrl: video.thumbnailUrl } : null,
            surface: surface
              ? {
                  id: surface.id,
                  surfaceType: surface.surfaceType,
                  timestamp: surface.timestamp,
                  boundingBox: {
                    x: surface.boundingBoxX,
                    y: surface.boundingBoxY,
                    width: surface.boundingBoxWidth,
                    height: surface.boundingBoxHeight,
                  },
                }
              : null,
          };
        }),
      );

      res.json({ placements: hydrated, count: hydrated.length });
    } catch (err: any) {
      console.error("[API] /api/creator/placements/inbox error:", err.message);
      res.status(500).json({ error: err.message || "Failed to fetch inbox" });
    }
  });

  // GET /api/creator/placements/inbox/count — Just the badge number.
  app.get("/api/creator/placements/inbox/count", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const creatorUserId = req.authUserId;
      const count = await storage.countPendingPlacementsForCreator(creatorUserId);
      res.json({ count });
    } catch (err: any) {
      console.error("[API] /api/creator/placements/inbox/count error:", err.message);
      res.status(500).json({ error: err.message || "Failed to count" });
    }
  });

  // POST /api/creator/placements/:id/approve — Creator approves the placement.
  // On approval, fire-and-forget a re-render of the targeted clip so the brand
  // product appears in the rendered output. The render reads approved placements
  // and composites the product onto the surface's bbox.
  app.post("/api/creator/placements/:id/approve", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const creatorUserId = req.authUserId;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid placement ID" });

      const placement = await storage.getBrandPlacementById(id);
      if (!placement) return res.status(404).json({ error: "Placement not found" });
      if (placement.creatorUserId !== creatorUserId) {
        return res.status(403).json({ error: "Not authorized to approve this placement" });
      }
      if (placement.status !== "pending_creator_review") {
        return res.status(400).json({ error: `Cannot approve a ${placement.status} placement` });
      }
      const updated = await storage.updateBrandPlacementStatus(id, "creator_approved");
      console.log(`[BrandPlacement] Creator ${creatorUserId} APPROVED placement ${id}`);

      // Fire-and-forget re-render of the targeted clip so the brand product
      // appears in the output. If targeted at a video without a specific clip,
      // skip — that's the legacy path and doesn't have a clean render trigger.
      if (placement.editorialClipId) {
        const clipId = placement.editorialClipId;
        const videoId = placement.videoId;
        renderSingleEditorialClip(videoId, clipId)
          .then(() => {
            console.log(`[BrandPlacement] ✓ Re-rendered clip ${clipId} with approved placement ${id}`);
          })
          .catch((err: any) => {
            console.error(`[BrandPlacement] ✗ Re-render failed for clip ${clipId}:`, err?.message || err);
          });
      } else {
        console.log(`[BrandPlacement] Placement ${id} has no clip target — skipping auto-rerender`);
      }

      res.json({ placement: updated, rerenderScheduled: !!placement.editorialClipId });
    } catch (err: any) {
      console.error("[API] /api/creator/placements/:id/approve error:", err.message);
      res.status(500).json({ error: err.message || "Failed to approve placement" });
    }
  });

  // POST /api/creator/placements/:id/reject — Creator rejects the placement (with optional reason).
  app.post("/api/creator/placements/:id/reject", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const creatorUserId = req.authUserId;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid placement ID" });

      const placement = await storage.getBrandPlacementById(id);
      if (!placement) return res.status(404).json({ error: "Placement not found" });
      if (placement.creatorUserId !== creatorUserId) {
        return res.status(403).json({ error: "Not authorized to reject this placement" });
      }
      if (placement.status !== "pending_creator_review") {
        return res.status(400).json({ error: `Cannot reject a ${placement.status} placement` });
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      const updated = await storage.updateBrandPlacementStatus(id, "creator_rejected", { rejectionReason: reason });
      console.log(`[BrandPlacement] Creator ${creatorUserId} REJECTED placement ${id} (reason: ${reason || "none"})`);
      res.json({ placement: updated });
    } catch (err: any) {
      console.error("[API] /api/creator/placements/:id/reject error:", err.message);
      res.status(500).json({ error: err.message || "Failed to reject placement" });
    }
  });

  // GET /api/brand/clips — Brand-facing browseable feed of rendered editorial clips.
  // This is the entry point for the new "review clips, request placements" flow.
  // Each clip is a 9:16 narrative unit ready for placement; brands browse, click
  // into one, see the surfaces inside it, and request a placement on those surfaces.
  //
  // Query params:
  //   ?personalized=true → score clips against the calling brand's brief, sort by
  //                        relevance, attach matchReasons. Clips matching brief.thingsToAvoid
  //                        get a blocked flag the UI can hide by default.
  //   ?limit=N&offset=N — pagination
  app.get("/api/brand/clips", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string), 200) : 50;
      const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;
      const personalized = req.query.personalized === "true";

      const clips = await storage.getBrowsableEditorialClips({ limit, offset });

      // No personalization requested → return as-is (default sort by finalScore)
      if (!personalized) {
        return res.json({ clips, count: clips.length, limit, offset, personalized: false });
      }

      // Personalization: score against the calling brand's brief
      const brandUserId = req.authUserId;
      const brief = await storage.getBrandBriefByUserId(brandUserId).catch(() => null);
      if (!brief) {
        // No brief → return clips unscored with a hint
        return res.json({
          clips,
          count: clips.length,
          limit,
          offset,
          personalized: false,
          briefMissing: true,
          message: "Complete your brand brief at /brands/onboarding to enable personalized recommendations",
        });
      }

      const scored = scoreClipsForBrief(clips, brief);
      // Spread the scored data back into clip-shape so the existing UI keeps working
      const decoratedClips = scored.map((s) => ({
        ...s.clip,
        relevanceScore: s.relevanceScore,
        blocked: s.blocked,
        matchReasons: s.matchReasons,
      }));
      res.json({
        clips: decoratedClips,
        count: decoratedClips.length,
        limit,
        offset,
        personalized: true,
        briefId: brief.id,
      });
    } catch (err: any) {
      console.error("[API] /api/brand/clips error:", err.message);
      res.status(500).json({ error: err.message || "Failed to list clips" });
    }
  });

  // GET /api/editorial-clips/:clipId — Get a specific editorial clip with surfaces
  // that are visible during its time range. Used by the brand placement request modal.
  app.get("/api/editorial-clips/:clipId", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      if (isNaN(clipId)) return res.status(400).json({ error: "Invalid clip ID" });

      const clip = await storage.getEditorialClipById(clipId);
      if (!clip) return res.status(404).json({ error: "Clip not found" });

      const [surfaces, video] = await Promise.all([
        storage.getSurfacesInEditorialClip(clipId),
        storage.getVideoById(clip.videoId),
      ]);

      res.json({
        clip,
        surfaces,
        video: video
          ? { id: video.id, title: video.title, thumbnailUrl: video.thumbnailUrl, userId: video.userId }
          : null,
      });
    } catch (err: any) {
      console.error("[API] /api/editorial-clips/:clipId error:", err.message);
      res.status(500).json({ error: err.message || "Failed to fetch clip" });
    }
  });

  // GET /api/editorial-clips/:clipId/surfaces — Just the surfaces inside this clip's
  // time range. Used by BrandPlacementRequestModal when in clip-targeted mode.
  app.get("/api/editorial-clips/:clipId/surfaces", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      if (isNaN(clipId)) return res.status(400).json({ error: "Invalid clip ID" });
      const surfaces = await storage.getSurfacesInEditorialClip(clipId);
      res.json({ surfaces, count: surfaces.length });
    } catch (err: any) {
      console.error("[API] /api/editorial-clips/:clipId/surfaces error:", err.message);
      res.status(500).json({ error: err.message || "Failed to fetch surfaces" });
    }
  });

  // GET /api/videos/:videoId/placements/approved — Used by render pipeline; lists all
  // approved brand placements for a video. Returns hydrated product + surface info.
  app.get("/api/videos/:videoId/placements/approved", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      const placements = await storage.getApprovedPlacementsForVideo(videoId);
      const hydrated = await Promise.all(
        placements.map(async (p) => {
          const product = await storage.getBrandProduct(p.brandProductId);
          return {
            ...p,
            product: product
              ? { id: product.id, name: product.name, imageUrl: product.imageUrl, category: product.category }
              : null,
          };
        }),
      );
      res.json({ placements: hydrated, count: hydrated.length });
    } catch (err: any) {
      console.error("[API] /api/videos/:videoId/placements/approved error:", err.message);
      res.status(500).json({ error: err.message || "Failed to fetch approved placements" });
    }
  });

  // ============================================================================
  // SAVED PLACEMENTS — persistent product-on-surface configurations
  // ============================================================================

  // Save a placement (creates or updates)
  app.post("/api/placements", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userEmail = req.authEmail || "unknown";
      const { videoId, surfaceId, productId, productImageUrl, transform, blend, sceneGroupId, role, bidId } = req.body;

      if (!videoId || !surfaceId || !productImageUrl || !transform || !blend) {
        return res.status(400).json({ error: "Missing required fields: videoId, surfaceId, productImageUrl, transform, blend" });
      }

      // Auto-compute scene group ID from the anchor surface for scene persistence
      let computedGroupId = sceneGroupId || null;
      if (!computedGroupId) {
        const allSurfaces = await storage.getDetectedSurfaces(videoId);
        const anchorSurface = allSurfaces.find(s => s.id === surfaceId);
        if (anchorSurface) {
          const bbX = parseFloat(String(anchorSurface.boundingBoxX)).toFixed(1);
          const bbY = parseFloat(String(anchorSurface.boundingBoxY)).toFixed(1);
          computedGroupId = `${anchorSurface.surfaceType}-${bbX}-${bbY}`;
        }
      }

      // Save the primary placement
      const placement = await storage.savePlacement({
        videoId,
        surfaceId,
        productId: productId || null,
        productImageUrl,
        createdBy: userEmail,
        role: role || "creator",
        bidId: bidId || null,
        sceneGroupId: computedGroupId,
        transform,
        blend,
        status: "active",
      });

      // Auto-propagate to matching surfaces in the same scene group (scene persistence)
      // Uses fuzzy spatial matching: same surface type + bounding box center within 20% tolerance
      let propagatedCount = 0;
      if (computedGroupId) {
        const allSurfaces = await storage.getDetectedSurfaces(videoId);
        const anchorSurface = allSurfaces.find(s => s.id === surfaceId);
        const anchorBBX = anchorSurface ? parseFloat(String(anchorSurface.boundingBoxX)) : 0;
        const anchorBBY = anchorSurface ? parseFloat(String(anchorSurface.boundingBoxY)) : 0;
        const anchorBBW = anchorSurface ? parseFloat(String(anchorSurface.boundingBoxWidth)) : 0;
        const anchorBBH = anchorSurface ? parseFloat(String(anchorSurface.boundingBoxHeight)) : 0;
        const anchorCX = anchorBBX + anchorBBW / 2;
        const anchorCY = anchorBBY + anchorBBH / 2;
        const anchorType = anchorSurface?.surfaceType?.toLowerCase() || "";
        const FUZZY_TOLERANCE = 0.20; // 20% of frame

        const matchingSurfaces = allSurfaces.filter(s => {
          if (s.id === surfaceId) return false;
          if (s.surfaceType === "Filtered") return false;
          if (s.surfaceType.toLowerCase() !== anchorType) return false;
          const sBBX = parseFloat(String(s.boundingBoxX));
          const sBBY = parseFloat(String(s.boundingBoxY));
          const sBBW = parseFloat(String(s.boundingBoxWidth));
          const sBBH = parseFloat(String(s.boundingBoxHeight));
          const sCX = sBBX + sBBW / 2;
          const sCY = sBBY + sBBH / 2;
          return Math.abs(sCX - anchorCX) < FUZZY_TOLERANCE && Math.abs(sCY - anchorCY) < FUZZY_TOLERANCE;
        });

        for (const surface of matchingSurfaces) {
          try {
            await storage.savePlacement({
              videoId,
              surfaceId: surface.id,
              productId: productId || null,
              productImageUrl,
              createdBy: userEmail,
              role: role || "creator",
              sceneGroupId: computedGroupId,
              transform,
              blend,
              status: "active",
            });
            propagatedCount++;
          } catch (propErr: any) {
            console.warn(`[Placements] Failed to propagate to surface ${surface.id}:`, propErr.message);
          }
        }
      }

      // Auto-link to bid if bidId was provided (creator fulfilling a brand offer)
      let reviewSlug: string | null = null;
      if (bidId) {
        try {
          const bid = await storage.getBidById(bidId);
          if (bid && (bid.status === "pending" || bid.status === "revision_requested")) {
            const slug = generateSlug();
            await storage.createSharedLink({
              slug,
              placementId: placement.id,
              exportId: null,
              videoId,
              createdBy: userEmail,
              title: `Placement review for ${bid.brandName || "brand"}`,
              isActive: true,
              expiresAt: null,
            });
            await storage.updateBidStatus(bidId, "placed", {
              placementId: placement.id,
              reviewSlug: slug,
            });
            reviewSlug = slug;
            console.log(`[Placements] Auto-linked placement ${placement.id} to bid ${bidId}, review slug: ${slug}`);
          }
        } catch (linkErr: any) {
          console.warn(`[Placements] Failed to auto-link bid ${bidId}:`, linkErr.message);
        }
      }

      console.log(`[Placements] Saved placement ${placement.id} for video ${videoId} surface ${surfaceId} by ${userEmail} (propagated to ${propagatedCount} additional surfaces)`);
      res.json({ placement, propagatedCount, reviewSlug });
    } catch (err: any) {
      console.error("[Placements] Save error:", err.message);
      res.status(500).json({ error: "Failed to save placement" });
    }
  });

  // Save placement and auto-propagate to all surfaces in the same scene group
  app.post("/api/placements/propagate", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userEmail = req.authEmail || "unknown";
      const { videoId, surfaceId, productId, productImageUrl, transform, blend, sceneGroupId, role } = req.body;

      if (!videoId || !surfaceId || !productImageUrl || !transform || !blend || !sceneGroupId) {
        return res.status(400).json({ error: "Missing required fields including sceneGroupId for propagation" });
      }

      // Get all surfaces for this video
      const allSurfaces = await storage.getDetectedSurfaces(videoId);

      // Find surfaces that belong to the same scene group
      // Scene group format: "surfaceType-bbX-bbY" (rounded to 1 decimal)
      const groupSurfaces = allSurfaces.filter(s => {
        const bbX = parseFloat(String(s.boundingBoxX)).toFixed(1);
        const bbY = parseFloat(String(s.boundingBoxY)).toFixed(1);
        const groupKey = `${s.surfaceType}-${bbX}-${bbY}`;
        return groupKey === sceneGroupId;
      });

      const placements: any[] = [];

      for (const surface of groupSurfaces) {
        const placement = await storage.savePlacement({
          videoId,
          surfaceId: surface.id,
          productId: productId || null,
          productImageUrl,
          createdBy: userEmail,
          role: role || "creator",
          sceneGroupId,
          transform,
          blend,
          status: "active",
        });
        placements.push(placement);
      }

      console.log(`[Placements] Propagated placement to ${placements.length} surfaces in group "${sceneGroupId}" for video ${videoId}`);
      res.json({ placements, propagatedCount: placements.length });
    } catch (err: any) {
      console.error("[Placements] Propagate error:", err.message);
      res.status(500).json({ error: "Failed to propagate placement" });
    }
  });

  // Get active placement for a specific surface (or its scene group)
  // Used by PlacementPreviewModal to auto-load existing placements when switching scenes
  app.get("/api/video/:videoId/surface/:surfaceId/placement", async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const surfaceId = parseInt(req.params.surfaceId);
      if (isNaN(videoId) || isNaN(surfaceId)) {
        return res.status(400).json({ error: "Invalid videoId or surfaceId" });
      }

      // First check for a direct placement on this surface
      const videoplacements = await storage.getPlacementsForVideo(videoId);
      const directPlacement = videoplacements.find(p => p.surfaceId === surfaceId);
      if (directPlacement) {
        return res.json({ placement: directPlacement, source: "direct" });
      }

      // Fallback: find placement via fuzzy spatial matching (same type + nearby position)
      const allSurfaces = await storage.getDetectedSurfaces(videoId);
      const targetSurface = allSurfaces.find(s => s.id === surfaceId);
      if (targetSurface) {
        const tBBX = parseFloat(String(targetSurface.boundingBoxX));
        const tBBY = parseFloat(String(targetSurface.boundingBoxY));
        const tBBW = parseFloat(String(targetSurface.boundingBoxWidth));
        const tBBH = parseFloat(String(targetSurface.boundingBoxHeight));
        const tCX = tBBX + tBBW / 2;
        const tCY = tBBY + tBBH / 2;
        const tType = targetSurface.surfaceType.toLowerCase();
        const FUZZY_TOLERANCE = 0.20;

        // Find any surface that has a placement and is spatially similar
        for (const p of videoplacements) {
          const pSurface = allSurfaces.find(s => s.id === p.surfaceId);
          if (!pSurface || pSurface.surfaceType.toLowerCase() !== tType) continue;
          const pBBX = parseFloat(String(pSurface.boundingBoxX));
          const pBBY = parseFloat(String(pSurface.boundingBoxY));
          const pBBW = parseFloat(String(pSurface.boundingBoxWidth));
          const pBBH = parseFloat(String(pSurface.boundingBoxHeight));
          const pCX = pBBX + pBBW / 2;
          const pCY = pBBY + pBBH / 2;
          if (Math.abs(tCX - pCX) < FUZZY_TOLERANCE && Math.abs(tCY - pCY) < FUZZY_TOLERANCE) {
            return res.json({ placement: p, source: "fuzzy_match" });
          }
        }
      }

      res.json({ placement: null });
    } catch (err: any) {
      console.error("[Placements] Surface placement lookup error:", err.message);
      res.status(500).json({ error: "Failed to look up placement" });
    }
  });

  // Get all saved placements (enriched with video info)
  app.get("/api/placements", async (req: any, res) => {
    try {
      const placements = await storage.getAllActivePlacements();

      // Enrich with video titles/thumbnails
      const videoIds = [...new Set(placements.map(p => p.videoId))];
      const videoMap = new Map<number, { title: string; thumbnailUrl: string | null; youtubeId: string }>();
      for (const vid of videoIds) {
        const video = await storage.getVideoById(vid);
        if (video) {
          videoMap.set(vid, { title: video.title, thumbnailUrl: video.thumbnailUrl, youtubeId: video.youtubeId });
        }
      }

      const enriched = placements.map(p => ({
        ...p,
        videoTitle: videoMap.get(p.videoId)?.title || "Unknown Video",
        videoThumbnailUrl: videoMap.get(p.videoId)?.thumbnailUrl || null,
        videoYoutubeId: videoMap.get(p.videoId)?.youtubeId || null,
      }));

      res.json({ placements: enriched });
    } catch (err: any) {
      console.error("[Placements] Fetch all error:", err.message);
      res.status(500).json({ error: "Failed to fetch placements" });
    }
  });

  // Get all placements for a video
  app.get("/api/video/:videoId/placements", async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) {
        return res.status(400).json({ error: "Invalid video ID" });
      }

      const placements = await storage.getPlacementsForVideo(videoId);
      res.json({ placements });
    } catch (err: any) {
      console.error("[Placements] Fetch error:", err.message);
      res.status(500).json({ error: "Failed to fetch placements" });
    }
  });

  // Update a placement
  app.patch("/api/placements/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const placementId = parseInt(req.params.id);
      if (isNaN(placementId)) {
        return res.status(400).json({ error: "Invalid placement ID" });
      }

      const updated = await storage.updatePlacement(placementId, req.body);
      if (!updated) {
        return res.status(404).json({ error: "Placement not found" });
      }

      res.json({ placement: updated });
    } catch (err: any) {
      console.error("[Placements] Update error:", err.message);
      res.status(500).json({ error: "Failed to update placement" });
    }
  });

  // Delete (archive) a placement
  app.delete("/api/placements/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const placementId = parseInt(req.params.id);
      if (isNaN(placementId)) {
        return res.status(400).json({ error: "Invalid placement ID" });
      }

      const deleted = await storage.deletePlacement(placementId);
      if (!deleted) {
        return res.status(404).json({ error: "Placement not found" });
      }

      res.json({ success: true });
    } catch (err: any) {
      console.error("[Placements] Delete error:", err.message);
      res.status(500).json({ error: "Failed to delete placement" });
    }
  });

  // Get scene groups for a video (computed from surfaces)
  app.get("/api/video/:videoId/scene-groups", async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) {
        return res.status(400).json({ error: "Invalid video ID" });
      }

      const surfaces = await storage.getDetectedSurfaces(videoId);

      // Group surfaces by type + approximate bounding box position
      // Surfaces with the same type and similar position are "continuous" across time
      const groups = new Map<string, { groupId: string; surfaceType: string; surfaceIds: number[]; timestamps: number[]; count: number }>();

      for (const surface of surfaces) {
        const bbX = parseFloat(String(surface.boundingBoxX)).toFixed(1);
        const bbY = parseFloat(String(surface.boundingBoxY)).toFixed(1);
        const groupId = `${surface.surfaceType}-${bbX}-${bbY}`;

        if (!groups.has(groupId)) {
          groups.set(groupId, {
            groupId,
            surfaceType: surface.surfaceType,
            surfaceIds: [],
            timestamps: [],
            count: 0,
          });
        }

        const group = groups.get(groupId)!;
        group.surfaceIds.push(surface.id);
        group.timestamps.push(parseFloat(String(surface.timestamp)));
        group.count++;
      }

      const sceneGroups = Array.from(groups.values())
        .sort((a, b) => b.count - a.count);

      res.json({ sceneGroups });
    } catch (err: any) {
      console.error("[Scene Groups] Error:", err.message);
      res.status(500).json({ error: "Failed to compute scene groups" });
    }
  });

  // ── Video Export Pipeline ──

  // Trigger dense surface scanning for accurate camera-tracking keyframes
  // Called when user plays the video preview — generates Gemini detections at specified interval.
  // Supports `interval` body param (default 0.5). Client calls with interval=2 first for fast
  // sparse keyframes (~13 calls for 25s video = ~1 min), then optionally refines with interval=0.5.
  app.post("/api/video/:videoId/dense-scan", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      // Support configurable interval: 2.0 = fast/sparse, 0.5 = dense/slow
      const interval = parseFloat(req.body?.interval) || 0.5;
      const clampedInterval = Math.max(0.5, Math.min(5.0, interval));

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!video.filePath) return res.status(400).json({ error: "Video has no local file" });

      // Get all detected surfaces for this video
      const detectedSurfs = await storage.getDetectedSurfaces(videoId);
      if (detectedSurfs.length === 0) {
        return res.status(400).json({ error: "No surfaces detected for this video" });
      }

      // Determine minimum keyframes needed based on interval:
      // - Quick scan (interval≥1.5): need ≥4 keyframes to be useful (Catmull-Rom)
      // - Dense scan (interval<1.5): need ≥30 keyframes for smooth frame-by-frame tracking
      //   (a 25s video at 0.5s intervals should produce ~50 keyframes)
      const minKeyframes = clampedInterval >= 1.5 ? 4 : 30;
      const existingKfs = await storage.getKeyframesByVideo(videoId);
      if (existingKfs.length >= minKeyframes) {
        console.log(`[Dense Scan] Video ${videoId} already has ${existingKfs.length} keyframes (need ${minKeyframes} for interval=${clampedInterval}s), skipping`);
        return res.json({ status: "already_scanned", keyframesCount: existingKfs.length });
      }

      const surfaceIds = detectedSurfs.map(s => s.id);

      // Get video duration
      const { spawn: spawnProbe } = await import("child_process");
      const videoDuration = await new Promise<number>((resolve) => {
        if (video.filePath!.startsWith('/storage/')) {
          resolve(60); // Default for Object Storage files
          return;
        }
        const videoFilePath = path.resolve(video.filePath!);
        const proc = spawnProbe("ffprobe", [
          "-v", "quiet", "-print_format", "json", "-show_format", videoFilePath,
        ]);
        let stdout = "";
        proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.on("close", () => {
          try { resolve(parseFloat(JSON.parse(stdout).format.duration) || 30); }
          catch { resolve(30); }
        });
        proc.on("error", () => resolve(30));
      });

      console.log(`[Dense Scan] Starting for video ${videoId}: ${videoDuration.toFixed(1)}s, ${surfaceIds.length} surfaces, interval=${clampedInterval}s`);

      // Run dense scan — interval controls cost vs accuracy:
      // interval=2.0: ~13 Gemini calls for 25s video (~1 min) — sparse but fast
      // interval=0.5: ~50 Gemini calls for 25s video (~4 min) — dense and accurate
      const { denseScanRange } = await import("./scanner_v2");
      const result = await denseScanRange(videoId, 0, videoDuration, surfaceIds, clampedInterval);

      console.log(`[Dense Scan] Complete: ${result.keyframesCreated} keyframes created for video ${videoId}`);
      res.json({ status: "complete", keyframesCreated: result.keyframesCreated });
    } catch (err: any) {
      console.error("[Dense Scan] Error:", err.message);
      res.status(500).json({ error: "Dense scan failed" });
    }
  });

  // ── Motion Tracking (Gemini-anchored) ──
  // Uses the dense Gemini surface keyframes (actual surface detections at 0.5s intervals)
  // as anchor points, applies the same stabilization pipeline used for video export
  // (outlier rejection → dimension lock → bidirectional EMA smoothing → Catmull-Rom spline),
  // then pre-computes the exact surface position at 30fps.
  //
  // This is fundamentally different from vidstab (global camera motion) — Gemini
  // actually SEES the table/surface in each frame, so the product is anchored to
  // a real physical feature, not just compensating for camera movement.
  //
  // Returns: { transforms: [{x, y, w, h}...], fps, duration, available }
  app.post("/api/video/:videoId/motion-track", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      const surfaceId = req.body.surfaceId ? parseInt(req.body.surfaceId) : undefined;
      if (!surfaceId) return res.status(400).json({ error: "surfaceId required" });

      // Get video duration
      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      const videoDuration = parseFloat(video.duration as string) || 30;
      const fps = 30;

      // Get dense keyframes for this specific surface
      const allKeyframes = await storage.getKeyframesByVideo(videoId);
      const surfaceKeyframes = allKeyframes.filter(kf => kf.surfaceId === surfaceId);

      if (surfaceKeyframes.length < 2) {
        // Not enough keyframes — tell client to wait for dense scan to complete
        console.log(`[MotionTrack] Only ${surfaceKeyframes.length} keyframes for surface ${surfaceId}, need at least 2`);

        // Fall back to the static surface detection position
        const allSurfaces = await storage.getDetectedSurfaces(videoId);
        const surface = allSurfaces.find(s => s.id === surfaceId);
        if (surface) {
          const staticPos = {
            x: parseFloat(String(surface.boundingBoxX)) || 0.3,
            y: parseFloat(String(surface.boundingBoxY)) || 0.3,
            w: parseFloat(String(surface.boundingBoxWidth)) || 0.3,
            h: parseFloat(String(surface.boundingBoxHeight)) || 0.3,
          };
          // Return static position for every frame
          const totalFrames = Math.ceil(videoDuration * fps);
          const transforms = new Array(totalFrames).fill(staticPos);
          return res.json({ transforms, fps, duration: videoDuration, available: true, source: "static" });
        }
        return res.json({ transforms: [], fps, duration: videoDuration, available: false });
      }

      console.log(`[MotionTrack] Processing ${surfaceKeyframes.length} Gemini keyframes for surface ${surfaceId}`);

      // Convert DB keyframes to the format expected by the stabilization pipeline
      // Keyframes are stored as 0-1 normalized coordinates
      type PlacementKeyframe = { time: number; x: number; y: number; width: number; height: number };

      const rawKfs: PlacementKeyframe[] = surfaceKeyframes
        .map(kf => ({
          time: parseFloat(String(kf.timestamp)),
          x: parseFloat(String(kf.boundingBoxX)),
          y: parseFloat(String(kf.boundingBoxY)),
          width: parseFloat(String(kf.boundingBoxWidth)),
          height: parseFloat(String(kf.boundingBoxHeight)),
        }))
        .filter(kf => !isNaN(kf.time) && !isNaN(kf.x) && !isNaN(kf.y))
        .sort((a, b) => a.time - b.time);

      if (rawKfs.length < 2) {
        return res.json({ transforms: [], fps, duration: videoDuration, available: false });
      }

      // ── Stabilization Pipeline (Anchor-Lock Mode) ──
      // Step 1: Outlier rejection (relaxed threshold to keep more valid keyframes)
      let kfs = rawKfs;
      if (kfs.length > 3) {
        const filtered: PlacementKeyframe[] = [kfs[0]];
        for (let i = 1; i < kfs.length - 1; i++) {
          const expectedX = (kfs[i - 1].x + kfs[i + 1].x) / 2;
          const expectedY = (kfs[i - 1].y + kfs[i + 1].y) / 2;
          if (Math.abs(kfs[i].x - expectedX) > 0.15 || Math.abs(kfs[i].y - expectedY) > 0.15) {
            continue; // Skip outlier
          }
          filtered.push(kfs[i]);
        }
        filtered.push(kfs[kfs.length - 1]);
        console.log(`[MotionTrack] Outlier rejection: ${rawKfs.length} → ${filtered.length} keyframes`);
        kfs = filtered;
      }

      // Step 2: Lock dimensions to median (tight threshold to prevent size jitter)
      const widths = kfs.map(k => k.width).sort((a, b) => a - b);
      const heights = kfs.map(k => k.height).sort((a, b) => a - b);
      const medianW = widths[Math.floor(widths.length / 2)];
      const medianH = heights[Math.floor(heights.length / 2)];
      kfs = kfs.map(k => ({
        ...k,
        width: Math.abs(k.width - medianW) / medianW > 0.08 ? medianW : k.width,
        height: Math.abs(k.height - medianH) / medianH > 0.08 ? medianH : k.height,
      }));

      // Step 2B: Anchor persistence — lock top-right corner to highest-confidence keyframe
      // Prevents the entire bbox from drifting to a different part of the surface
      if (kfs.length > 1) {
        // Find highest-confidence keyframe as the anchor reference
        const anchorKf = rawKfs.reduce((best, kf) => {
          const bestConf = (best as any).confidence || 0;
          const kfConf = (kf as any).confidence || 0;
          return kfConf > bestConf ? kf : best;
        });
        const anchorTopRightX = anchorKf.x + anchorKf.width;
        const anchorTopRightY = anchorKf.y;

        // Constrain all keyframes so top-right doesn't drift >2% from anchor
        for (const kf of kfs) {
          const trX = kf.x + kf.width;
          const trY = kf.y;
          const driftX = Math.abs(trX - anchorTopRightX);
          const driftY = Math.abs(trY - anchorTopRightY);
          if (driftX > 0.02) {
            kf.x = anchorTopRightX - kf.width + Math.sign(trX - anchorTopRightX) * 0.02;
          }
          if (driftY > 0.02) {
            kf.y = anchorTopRightY + Math.sign(trY - anchorTopRightY) * 0.02;
          }
        }
        console.log(`[MotionTrack] Anchor-lock: top-right pinned at (${anchorTopRightX.toFixed(3)}, ${anchorTopRightY.toFixed(3)})`);
      }

      // Step 3: Bidirectional EMA smoothing (very heavy smoothing for rock-solid positions)
      const alpha = 0.15;
      const fwd: PlacementKeyframe[] = [{ ...kfs[0] }];
      for (let i = 1; i < kfs.length; i++) {
        fwd.push({
          time: kfs[i].time,
          x: alpha * kfs[i].x + (1 - alpha) * fwd[i - 1].x,
          y: alpha * kfs[i].y + (1 - alpha) * fwd[i - 1].y,
          width: alpha * kfs[i].width + (1 - alpha) * fwd[i - 1].width,
          height: alpha * kfs[i].height + (1 - alpha) * fwd[i - 1].height,
        });
      }
      const bwd: PlacementKeyframe[] = new Array(fwd.length);
      bwd[fwd.length - 1] = { ...fwd[fwd.length - 1] };
      for (let i = fwd.length - 2; i >= 0; i--) {
        bwd[i] = {
          time: fwd[i].time,
          x: alpha * fwd[i].x + (1 - alpha) * bwd[i + 1].x,
          y: alpha * fwd[i].y + (1 - alpha) * bwd[i + 1].y,
          width: alpha * fwd[i].width + (1 - alpha) * bwd[i + 1].width,
          height: alpha * fwd[i].height + (1 - alpha) * bwd[i + 1].height,
        };
      }
      kfs = fwd.map((f, i) => ({
        time: f.time,
        x: (f.x + bwd[i].x) / 2,
        y: (f.y + bwd[i].y) / 2,
        width: (f.width + bwd[i].width) / 2,
        height: (f.height + bwd[i].height) / 2,
      }));

      // ── Catmull-Rom spline interpolation to 30fps ──
      function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
        const t2 = t * t, t3 = t2 * t;
        return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      }

      const totalFrames = Math.ceil(videoDuration * fps);
      const framePositions: Array<{ x: number; y: number; w: number; h: number } | null> = [];
      const SCENE_GAP = 2.0; // seconds — gap > this means surface left frame

      for (let f = 0; f < totalFrames; f++) {
        const t = f / fps; // current time in seconds

        // Before first keyframe: null if too far away (surface not yet visible)
        if (t <= kfs[0].time) {
          if (t < kfs[0].time - SCENE_GAP) {
            framePositions.push(null);
          } else {
            framePositions.push({ x: kfs[0].x, y: kfs[0].y, w: kfs[0].width, h: kfs[0].height });
          }
          continue;
        }

        // After last keyframe: null if too far away (surface gone / scene cut)
        if (t >= kfs[kfs.length - 1].time) {
          if (t > kfs[kfs.length - 1].time + SCENE_GAP) {
            framePositions.push(null);
          } else {
            const last = kfs[kfs.length - 1];
            framePositions.push({ x: last.x, y: last.y, w: last.width, h: last.height });
          }
          continue;
        }

        // Find segment
        let seg = 0;
        for (; seg < kfs.length - 1; seg++) {
          if (t >= kfs[seg].time && t < kfs[seg + 1].time) break;
        }

        const segDur = kfs[seg + 1].time - kfs[seg].time;
        const segT = segDur > 0 ? (t - kfs[seg].time) / segDur : 0;

        // Large gap = scene cut — surface disappeared and reappeared
        if (segDur > SCENE_GAP * 2) {
          const midpoint = kfs[seg].time + segDur / 2;
          const distFromNearest = Math.min(t - kfs[seg].time, kfs[seg + 1].time - t);
          if (distFromNearest > SCENE_GAP) {
            framePositions.push(null); // In the dead zone — surface not visible
            continue;
          }
          // Near the edge — use nearest keyframe
          if (t < midpoint) {
            framePositions.push({ x: kfs[seg].x, y: kfs[seg].y, w: kfs[seg].width, h: kfs[seg].height });
          } else {
            framePositions.push({ x: kfs[seg + 1].x, y: kfs[seg + 1].y, w: kfs[seg + 1].width, h: kfs[seg + 1].height });
          }
          continue;
        }

        if (kfs.length === 2) {
          // Linear interpolation
          framePositions.push({
            x: kfs[0].x + (kfs[1].x - kfs[0].x) * segT,
            y: kfs[0].y + (kfs[1].y - kfs[0].y) * segT,
            w: kfs[0].width + (kfs[1].width - kfs[0].width) * segT,
            h: kfs[0].height + (kfs[1].height - kfs[0].height) * segT,
          });
        } else {
          // Catmull-Rom spline
          const p0 = kfs[Math.max(0, seg - 1)];
          const p1 = kfs[seg];
          const p2 = kfs[seg + 1];
          const p3 = kfs[Math.min(kfs.length - 1, seg + 2)];

          framePositions.push({
            x: catmullRom(p0.x, p1.x, p2.x, p3.x, segT),
            y: catmullRom(p0.y, p1.y, p2.y, p3.y, segT),
            w: Math.max(0.01, catmullRom(p0.width, p1.width, p2.width, p3.width, segT)),
            h: Math.max(0.01, catmullRom(p0.height, p1.height, p2.height, p3.height, segT)),
          });
        }
      }

      console.log(`[MotionTrack] Interpolated ${surfaceKeyframes.length} Gemini keyframes → ${framePositions.length} frames at ${fps}fps for video ${videoId}`);

      res.json({
        transforms: framePositions,
        fps,
        duration: videoDuration,
        available: true,
        source: "gemini-keyframes",
        keyframeCount: surfaceKeyframes.length,
      });
    } catch (err: any) {
      console.error("[MotionTrack] Error:", err.message);
      res.status(500).json({ error: "Motion tracking failed", message: err.message });
    }
  });

  // Start a new video export job
  // Get dense surface keyframes for a video (used by PlacementPreviewModal for accurate tracking)
  app.get("/api/video/:videoId/surface-keyframes", async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      // Get all dense keyframes for this video
      const keyframes = await storage.getKeyframesByVideo(videoId);

      // Also get detected surfaces to map surfaceId → surfaceType
      const detectedSurfs = await storage.getDetectedSurfaces(videoId);
      const surfaceTypeMap = new Map<number, string>();
      for (const s of detectedSurfs) {
        surfaceTypeMap.set(s.id, s.surfaceType);
      }

      // Group keyframes by surfaceType and format for client
      const grouped: Record<string, Array<{
        timestamp: number;
        bbox: { x: number; y: number; w: number; h: number };
        confidence: number;
        surfaceId: number;
      }>> = {};

      for (const kf of keyframes) {
        const surfaceType = surfaceTypeMap.get(kf.surfaceId) || "unknown";
        if (!grouped[surfaceType]) grouped[surfaceType] = [];
        // Keyframes are stored as 0-1 normalized; convert to 0-100 for video exporter
        grouped[surfaceType].push({
          timestamp: parseFloat(String(kf.timestamp)),
          bbox: {
            x: parseFloat(String(kf.boundingBoxX)) * 100,
            y: parseFloat(String(kf.boundingBoxY)) * 100,
            w: parseFloat(String(kf.boundingBoxWidth)) * 100,
            h: parseFloat(String(kf.boundingBoxHeight)) * 100,
          },
          confidence: parseFloat(String(kf.confidence)),
          surfaceId: kf.surfaceId,
        });
      }

      // Sort each group by timestamp
      for (const key of Object.keys(grouped)) {
        grouped[key].sort((a, b) => a.timestamp - b.timestamp);
      }

      console.log(`[Surface Keyframes] Video ${videoId}: ${keyframes.length} keyframes across ${Object.keys(grouped).length} surface types`);
      res.json({ keyframes: grouped });
    } catch (err: any) {
      console.error("[Surface Keyframes] Error:", err.message);
      res.status(500).json({ error: "Failed to fetch surface keyframes" });
    }
  });

  app.post("/api/video/:videoId/export", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      // Brand users cannot export videos — only creators can
      if (req.authEmail) {
        const viewRole = (req.session as any)?.viewRole;
        const allowedUser = await storage.getAllowedUser(req.authEmail);
        const effectiveRole = viewRole || allowedUser?.userType || "creator";
        if (effectiveRole === "brand") {
          return res.status(403).json({ error: "Video export is not available for brand accounts. Please contact the creator for exported content." });
        }
      }

      const { placements, canvasWidth, canvasHeight } = req.body;
      if (!placements || !Array.isArray(placements) || placements.length === 0) {
        return res.status(400).json({ error: "At least one placement is required" });
      }

      // Verify video exists and has a file path
      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!video.filePath) return res.status(400).json({ error: "Video has no local file — only locally uploaded videos can be exported" });

      // Verify video file is accessible (Object Storage or local disk)
      // Object Storage paths (/storage/...) are downloaded at export time by processVideoExport
      if (!video.filePath.startsWith('/storage/')) {
        const absolutePath = path.resolve(video.filePath);
        if (!fs.existsSync(absolutePath)) {
          return res.status(400).json({ error: "Video file not found on disk" });
        }
      }

      // ── Static placement export ──
      // Product stays locked at the detected surface position — no per-frame re-detection needed.
      // The client sends the surface bounding box as a single keyframe; the exporter uses
      // a fixed FFmpeg overlay at that position. No dense scan, no Gemini calls, no frame-by-frame compositing.
      for (const placement of placements) {
        console.log(`[Video Export] "${placement.surfaceType}" → static position (${placement.keyframes?.length || 0} client keyframes)`);
      }

      const userId = req.authUserId || req.googleUser?.email || "anonymous";

      // Create export job in DB
      const exportJob = await storage.createVideoExport({
        videoId,
        requestedBy: userId,
        status: "queued",
        progress: 0,
        placementData: placements,
        outputPath: null,
        outputUrl: null,
        error: null,
      });

      console.log(`[Video Export] Created export job ${exportJob.id} for video ${videoId} (${placements.length} placements)`);

      // Kick off async processing (don't await)
      processVideoExport(exportJob.id, video.filePath, placements, {
        canvasWidth: canvasWidth || 640,
        canvasHeight: canvasHeight || 360,
      }).catch((err) => {
        console.error(`[Video Export] Background processing failed for export ${exportJob.id}:`, err.message);
      });

      res.json({ exportId: exportJob.id, status: "queued" });
    } catch (err: any) {
      console.error("[Video Export] Start error:", err.message);
      res.status(500).json({ error: "Failed to start export" });
    }
  });

  // Poll export job status
  app.get("/api/exports/:exportId", async (req: any, res) => {
    try {
      const exportId = parseInt(req.params.exportId);
      if (isNaN(exportId)) return res.status(400).json({ error: "Invalid export ID" });

      const exportJob = await storage.getVideoExport(exportId);
      if (!exportJob) return res.status(404).json({ error: "Export not found" });

      res.json({
        id: exportJob.id,
        videoId: exportJob.videoId,
        status: exportJob.status,
        progress: exportJob.progress,
        outputUrl: exportJob.outputUrl,
        error: exportJob.error,
        createdAt: exportJob.createdAt,
        completedAt: exportJob.completedAt,
      });
    } catch (err: any) {
      console.error("[Video Export] Status error:", err.message);
      res.status(500).json({ error: "Failed to get export status" });
    }
  });

  // Download completed export
  app.get("/api/exports/:exportId/download", async (req: any, res) => {
    try {
      const exportId = parseInt(req.params.exportId);
      if (isNaN(exportId)) return res.status(400).json({ error: "Invalid export ID" });

      const exportJob = await storage.getVideoExport(exportId);
      if (!exportJob) return res.status(404).json({ error: "Export not found" });
      if (exportJob.status !== "complete" || !exportJob.outputPath) {
        return res.status(400).json({ error: "Export not yet complete" });
      }

      const filename = `fullscale-remix-${exportJob.videoId}-${exportJob.id}.mp4`;
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

      // Handle Object Storage paths vs local disk
      if (exportJob.outputPath.startsWith('/storage/')) {
        const { objectKeyFromServeUrl, getStorageStream } = await import("./lib/objectStorage");
        const objectKey = objectKeyFromServeUrl(exportJob.outputPath);
        const { stream } = getStorageStream(objectKey);
        stream.on("error", (err: any) => {
          console.error("[Video Export] Storage stream error:", err.message);
          if (!res.headersSent) {
            res.status(404).json({ error: "Export file not found in storage" });
          }
        });
        stream.pipe(res);
      } else {
        const absolutePath = path.resolve(exportJob.outputPath);
        if (!fs.existsSync(absolutePath)) {
          return res.status(404).json({ error: "Export file not found on disk" });
        }
        const stream = fs.createReadStream(absolutePath);
        stream.pipe(res);
      }
    } catch (err: any) {
      console.error("[Video Export] Download error:", err.message);
      res.status(500).json({ error: "Failed to download export" });
    }
  });

  // ── SHARED LINKS ──

  // Create a shareable link for a placement or export
  app.post("/api/share", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authEmail || req.googleUser?.email;
      if (!userId) return res.status(401).json({ error: "Authentication required" });

      const { placementId, exportId, videoId, title } = req.body;
      if (!videoId) return res.status(400).json({ error: "videoId is required" });

      // Generate unique 8-char slug
      const slug = generateSlug();

      const link = await storage.createSharedLink({
        slug,
        placementId: placementId || null,
        exportId: exportId || null,
        videoId,
        createdBy: userId,
        title: title || null,
        isActive: true,
        expiresAt: null,
      });

      const shareUrl = `/s/${slug}`;
      res.json({ slug, url: shareUrl, id: link.id });
    } catch (err: any) {
      console.error("[Share] Create error:", err.message);
      res.status(500).json({ error: "Failed to create share link" });
    }
  });

  // Get shared content (PUBLIC — no auth required)
  app.get("/api/share/:slug", async (req: any, res) => {
    try {
      const { slug } = req.params;
      const link = await storage.getSharedLinkBySlug(slug);
      if (!link) return res.status(404).json({ error: "Share link not found" });
      if (!link.isActive) return res.status(410).json({ error: "This share link has been deactivated" });
      if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
        return res.status(410).json({ error: "This share link has expired" });
      }

      // Increment view count
      await storage.incrementSharedLinkViews(slug);

      // Fetch associated data
      const video = await storage.getVideoById(link.videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      let placement = null;
      if (link.placementId) {
        placement = await storage.getPlacementById(link.placementId);
      }

      let exportData = null;
      if (link.exportId) {
        exportData = await storage.getVideoExport(link.exportId);
      }

      // Get surfaces for the video
      const surfaces = await storage.getDetectedSurfaces(link.videoId);

      res.json({
        slug: link.slug,
        title: link.title || video.title,
        createdBy: link.createdBy,
        viewCount: (link.viewCount || 0) + 1,
        createdAt: link.createdAt,
        video: {
          id: video.id,
          title: video.title,
          thumbnailUrl: video.thumbnailUrl,
          duration: video.duration,
          platform: video.platform,
        },
        placement: placement ? {
          id: placement.id,
          productImageUrl: placement.productImageUrl,
          surfaceId: placement.surfaceId,
          transform: placement.transform,
          blend: placement.blend,
        } : null,
        export: exportData ? {
          id: exportData.id,
          status: exportData.status,
          outputUrl: exportData.outputUrl,
          progress: exportData.progress,
        } : null,
        surfaces: surfaces.map(s => ({
          id: s.id,
          surfaceType: s.surfaceType,
          timestamp: s.timestamp,
          boundingBoxX: s.boundingBoxX,
          boundingBoxY: s.boundingBoxY,
          boundingBoxWidth: s.boundingBoxWidth,
          boundingBoxHeight: s.boundingBoxHeight,
          frameUrl: s.frameUrl,
        })),
      });
    } catch (err: any) {
      console.error("[Share] Fetch error:", err.message);
      res.status(500).json({ error: "Failed to fetch shared content" });
    }
  });

  // Get all share links for current user
  app.get("/api/shares", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authEmail || req.googleUser?.email;
      if (!userId) return res.status(401).json({ error: "Authentication required" });

      const links = await storage.getSharedLinksByUser(userId);
      res.json({ links });
    } catch (err: any) {
      console.error("[Share] List error:", err.message);
      res.status(500).json({ error: "Failed to list share links" });
    }
  });

  // Deactivate a share link
  app.delete("/api/share/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid share link ID" });

      await storage.deactivateSharedLink(id);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[Share] Deactivate error:", err.message);
      res.status(500).json({ error: "Failed to deactivate share link" });
    }
  });

  // ============================================================================
  // SCENE ANALYSIS & BRAND MATCHING (Claude Dense)
  // ============================================================================

  // Trigger Claude Dense narrative analysis for all surfaces on a video
  app.post("/api/scenes/:videoId/analyze", isAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      const surfaces = await storage.getDetectedSurfaces(videoId);
      const validSurfaces = surfaces.filter(s => s.surfaceType !== "Filtered");
      if (validSurfaces.length === 0) {
        return res.status(400).json({ error: "No detected surfaces to analyze. Run a scan first." });
      }

      // Import dynamically to avoid loading Anthropic SDK at startup
      const { analyzeNarrative } = await import("./lib/ai/claude-dense/narrativeAnalyzer");
      const { analyzeCulturalRelevance } = await import("./lib/ai/claude-dense/culturalRelevance");

      const results: any[] = [];

      // Group surfaces by unique timestamp to avoid re-analyzing the same frame
      const timestampMap = new Map<number, typeof validSurfaces>();
      for (const surface of validSurfaces) {
        const ts = Math.floor(Number(surface.timestamp));
        if (!timestampMap.has(ts)) timestampMap.set(ts, []);
        timestampMap.get(ts)!.push(surface);
      }

      for (const [timestamp, surfacesAtTime] of timestampMap) {
        const frameFilename = `frame_${timestamp}s.jpg`;
        const framePath = path.join(process.cwd(), "public", "uploads", "frames", videoId.toString(), frameFilename);

        if (!fs.existsSync(framePath)) {
          console.log(`[Scene Analysis] Frame not found: ${frameFilename}, skipping`);
          continue;
        }

        const frameBuffer = fs.readFileSync(framePath);
        const frameBase64 = frameBuffer.toString('base64');
        const bestSurface = surfacesAtTime.reduce((a, b) =>
          parseFloat(String(a.confidence)) > parseFloat(String(b.confidence)) ? a : b
        );

        // Parse scene context from existing surface data
        const sceneContextParts = (bestSurface.sceneContext || '').split(' | ');

        const narrativeInput = {
          videoId,
          frameIndex: timestamp,
          frameBase64,
          detectedSurfaces: surfacesAtTime.map(s => ({
            id: s.id,
            surfaceType: s.surfaceType,
            confidence: parseFloat(String(s.confidence)),
            boundingBox: {
              x: parseFloat(String(s.boundingBoxX)),
              y: parseFloat(String(s.boundingBoxY)),
              width: parseFloat(String(s.boundingBoxWidth)),
              height: parseFloat(String(s.boundingBoxHeight)),
            },
            lightingDirection: s.lightingDirection || undefined,
            lightingIntensity: s.lightingIntensity ? parseFloat(String(s.lightingIntensity)) : undefined,
            cameraAngle: s.cameraAngle || undefined,
          })),
          sceneContext: {
            sceneType: sceneContextParts[0] || 'Unknown',
            brightness: { overall: 128, top: 128, bottom: 128 },
            edgeDensity: 0.1,
            colorWarmth: 0,
            surroundings: bestSurface.surroundings || [],
            brandCategorySuggestions: sceneContextParts[2] ? sceneContextParts[2].replace('Brands: ', '').split(', ') : [],
          },
        };

        const narrative = await analyzeNarrative(narrativeInput);
        if (!narrative) continue;

        const cultural = analyzeCulturalRelevance(narrative);

        // Save to DB for each surface at this timestamp
        for (const surface of surfacesAtTime) {
          const saved = await storage.createSceneAnalysis({
            videoId,
            surfaceId: surface.id,
            frameStart: timestamp,
            frameEnd: timestamp + 2, // 2s frame interval
            narrativeContext: narrative.narrativeContext,
            emotionalTone: narrative.emotionalTone,
            culturalTags: [...narrative.culturalTags, ...cultural.culturalMoments],
            placementViability: narrative.placementViability,
            suggestedCategories: narrative.suggestedProductCategories,
            reasoning: narrative.reasoning,
            claudeResponseRaw: { narrative, cultural },
          });
          results.push(saved);
        }
      }

      res.json({ success: true, analyzed: results.length, results });
    } catch (err: any) {
      console.error("[Scene Analysis] Error:", err.message);
      res.status(500).json({ error: err.message || "Failed to analyze scenes" });
    }
  });

  // Get all narrative analysis results for a video
  app.get("/api/scenes/:videoId/analysis", isAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const analyses = await storage.getSceneAnalysisByVideo(videoId);
      res.json(analyses);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get analysis for a specific surface
  app.get("/api/scenes/:videoId/analysis/:surfaceId", isAuthenticated, async (req: any, res) => {
    try {
      const surfaceId = parseInt(req.params.surfaceId);
      const analysis = await storage.getSceneAnalysisBySurface(surfaceId);
      if (!analysis) return res.status(404).json({ error: "No analysis found for this surface" });
      res.json(analysis);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Run brand matching for a scene analysis
  app.post("/api/scenes/:sceneId/match-brands", isAuthenticated, async (req: any, res) => {
    try {
      const sceneId = parseInt(req.params.sceneId);

      // Get the scene analysis
      const scenes = await storage.getSceneAnalysisByVideo(0); // We need to find by ID
      // Actually get scene directly via DB
      const allScenes = await db.select().from((await import("@shared/schema")).sceneAnalysis)
        .where(eq((await import("@shared/schema")).sceneAnalysis.id, sceneId));
      const scene = allScenes[0];
      if (!scene) return res.status(404).json({ error: "Scene analysis not found" });

      // Get all brand products
      const brands = await storage.getAllBrandProducts();
      if (brands.length === 0) {
        return res.json({ matches: [], message: "No brand products available" });
      }

      // Get the surface for this scene
      const surface = scene.surfaceId ? (await storage.getDetectedSurfaces(scene.videoId))
        .find(s => s.id === scene.surfaceId) : null;

      const { matchBrands } = await import("./lib/ai/claude-dense/brandMatcher");

      const brandMatchResult = await matchBrands({
        narrativeAnalysis: {
          narrativeContext: scene.narrativeContext || '',
          emotionalTone: scene.emotionalTone || 'neutral',
          culturalTags: (scene.culturalTags as string[]) || [],
          placementViability: scene.placementViability || 0,
          suggestedProductCategories: (scene.suggestedCategories as string[]) || [],
          reasoning: scene.reasoning || '',
        },
        availableBrands: brands.map(b => ({
          id: b.id,
          name: b.name,
          category: b.category,
          imageUrl: b.imageUrl,
        })),
        surfaceDetails: {
          surfaceType: surface?.surfaceType || 'Table',
          boundingBox: {
            x: parseFloat(String(surface?.boundingBoxX || 0)),
            y: parseFloat(String(surface?.boundingBoxY || 0)),
            width: parseFloat(String(surface?.boundingBoxWidth || 0)),
            height: parseFloat(String(surface?.boundingBoxHeight || 0)),
          },
          confidence: parseFloat(String(surface?.confidence || 0)),
          lightingDirection: surface?.lightingDirection || 'ambient',
        },
      });

      // Save matches to DB
      const savedMatches = [];
      for (const match of brandMatchResult.matches) {
        const saved = await storage.createBrandMatchScore({
          sceneAnalysisId: sceneId,
          brandProductId: match.brandProductId,
          compatibilityScore: match.compatibilityScore,
          reasoning: match.reasoning,
          suggestedPlacementStyle: match.suggestedPlacementStyle,
        });
        savedMatches.push(saved);
      }

      res.json({ matches: savedMatches });
    } catch (err: any) {
      console.error("[Brand Match] Error:", err.message);
      res.status(500).json({ error: err.message || "Failed to match brands" });
    }
  });

  // Get ranked brand matches for a scene
  app.get("/api/scenes/:sceneId/matches", isAuthenticated, async (req: any, res) => {
    try {
      const sceneId = parseInt(req.params.sceneId);
      const matches = await storage.getBrandMatchesByScene(sceneId);
      res.json(matches);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Approve a brand match
  app.post("/api/scenes/:sceneId/matches/:matchId/approve", isAuthenticated, async (req: any, res) => {
    try {
      const matchId = parseInt(req.params.matchId);
      const approvedBy = req.user?.email || req.body.approvedBy || 'system';
      const updated = await storage.approveBrandMatch(matchId, approvedBy);
      if (!updated) return res.status(404).json({ error: "Match not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Auto-generate placements from approved brand matches for a video
  app.post("/api/scenes/:videoId/auto-place", isAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const userEmail = req.user?.email || '';

      // Get all approved brand matches for this video
      const matches = await storage.getBrandMatchesByVideo(videoId);
      const approvedMatches = matches.filter(m => m.approved);

      if (approvedMatches.length === 0) {
        return res.status(400).json({ error: "No approved brand matches found. Approve matches first." });
      }

      const createdPlacements = [];

      for (const match of approvedMatches) {
        // Get the scene analysis to find the surface
        const scenes = await db.select().from((await import("@shared/schema")).sceneAnalysis)
          .where(eq((await import("@shared/schema")).sceneAnalysis.id, match.sceneAnalysisId));
        const scene = scenes[0];
        if (!scene || !scene.surfaceId) continue;

        // Get the brand product
        const product = await storage.getBrandProduct(match.brandProductId);
        if (!product) continue;

        // Get the surface for bbox data
        const surfaces = await storage.getDetectedSurfaces(videoId);
        const surface = surfaces.find(s => s.id === scene.surfaceId);
        if (!surface) continue;

        // Compute scene group ID (same logic as existing placement propagation)
        const centerX = parseFloat(String(surface.boundingBoxX)) + parseFloat(String(surface.boundingBoxWidth)) / 2;
        const centerY = parseFloat(String(surface.boundingBoxY)) + parseFloat(String(surface.boundingBoxHeight)) / 2;
        const sceneGroupId = `video-${videoId}-${surface.surfaceType}-${centerX.toFixed(1)}-${centerY.toFixed(1)}`;

        const placement = await storage.savePlacement({
          videoId,
          surfaceId: surface.id,
          productId: product.id,
          productImageUrl: product.imageUrl,
          createdBy: userEmail,
          role: 'system',
          sceneGroupId,
          transform: { offsetX: 0, offsetY: 0, scale: 1, rotation: 0, flipH: false },
          blend: {
            opacity: 0.9,
            blendMode: 'source-over',
            shadowEnabled: true,
            shadowBlur: 8,
            shadowOffsetX: 2,
            shadowOffsetY: 4,
            shadowColor: 'rgba(0,0,0,0.3)',
            featherRadius: 0,
            brightness: 1,
            contrast: 1,
          },
          status: 'active',
        });
        createdPlacements.push(placement);
      }

      res.json({ success: true, created: createdPlacements.length, placements: createdPlacements });
    } catch (err: any) {
      console.error("[Auto-Place] Error:", err.message);
      res.status(500).json({ error: err.message || "Failed to auto-place" });
    }
  });

  // ─── Image Generation (Seeddance 2.0) ───────────────────────────

  // POST /api/generate/product-asset — Generate a product asset for a surface
  app.post("/api/generate/product-asset", isAuthenticated, async (req: any, res) => {
    try {
      const { videoId, surfaceId, brandProductId } = req.body;
      if (!videoId || !surfaceId || !brandProductId) {
        return res.status(400).json({ error: "videoId, surfaceId, and brandProductId are required" });
      }

      // Get surface and scene analysis data
      const surfaces = await storage.getSurfacesForVideo(videoId);
      const surface = surfaces.find((s: any) => s.id === surfaceId);
      if (!surface) return res.status(404).json({ error: "Surface not found" });

      const analyses = await storage.getSceneAnalysisBySurface(surfaceId);
      const analysis = analyses[0];
      if (!analysis) return res.status(404).json({ error: "No scene analysis for this surface. Run analysis first." });

      // Get brand product
      const items = await storage.getMonetizationItems();
      const brandProduct = items.find((i: any) => i.id === brandProductId);
      if (!brandProduct) return res.status(404).json({ error: "Brand product not found" });

      const { generateProductAsset } = await import("./lib/ai/image-gen/assetGenerator");
      const result = await generateProductAsset({
        videoId,
        surfaceId,
        brandProduct: { id: brandProduct.id, name: brandProduct.name, category: brandProduct.category || null },
        sceneContext: {
          narrativeContext: analysis.narrativeContext || "",
          emotionalTone: analysis.emotionalTone || "neutral",
          culturalTags: (analysis.culturalTags as string[]) || [],
          suggestedProductCategories: (analysis.suggestedCategories as string[]) || [],
        },
        surfaceDimensions: {
          width: Math.round((surface.bboxWidth || 0.2) * 1920),
          height: Math.round((surface.bboxHeight || 0.2) * 1080),
          aspectRatio: (surface.bboxWidth || 0.2) / Math.max(surface.bboxHeight || 0.2, 0.001),
        },
        sceneAesthetic: {
          colorWarmth: surface.colorWarmth || 0,
          brightness: { overall: surface.brightness || 128, top: 128, bottom: 128 },
          dominantColors: [],
        },
      });

      if (result.success && result.assetPath) {
        // Save to DB
        const asset = await storage.createGeneratedAsset({
          videoId,
          surfaceId,
          brandProductId,
          assetPath: result.assetPath,
          generationPrompt: result.prompt,
          assetType: result.assetType,
          seeddanceJobId: result.jobId || undefined,
          videoDuration: result.duration || undefined,
          videoAspectRatio: result.promptDetails?.aspectRatio || undefined,
          videoResolution: result.promptDetails?.resolution || undefined,
          needsManualReview: true,
        });
        res.json({ success: true, asset, prompt: result.prompt, assetType: result.assetType });
      } else {
        res.status(500).json({ success: false, error: result.error, prompt: result.prompt });
      }
    } catch (err: any) {
      console.error("[Generate] Error:", err.message);
      res.status(500).json({ error: err.message || "Asset generation failed" });
    }
  });

  // POST /api/generate/composite-preview — Composite asset onto frame and evaluate
  app.post("/api/generate/composite-preview", isAuthenticated, async (req: any, res) => {
    try {
      const { videoId, surfaceId, assetId } = req.body;
      if (!videoId || !surfaceId || !assetId) {
        return res.status(400).json({ error: "videoId, surfaceId, and assetId are required" });
      }

      const assets = await storage.getAssetsByVideo(videoId);
      const asset = assets.find((a: any) => a.id === assetId);
      if (!asset || !asset.assetPath) return res.status(404).json({ error: "Asset not found" });

      const surfaces = await storage.getSurfacesForVideo(videoId);
      const surface = surfaces.find((s: any) => s.id === surfaceId);
      if (!surface) return res.status(404).json({ error: "Surface not found" });

      // Build frame path from video's local file
      const video = await storage.getVideoById(videoId);
      if (!video || !video.localFilePath) return res.status(404).json({ error: "Video local file not found" });

      const { compositeAssetOnFrame } = await import("./lib/ai/image-gen/compositing");
      const path = await import("path");
      const outputDir = path.join(process.cwd(), "public", "generated-assets", videoId.toString());
      const fullAssetPath = path.join(process.cwd(), "public", asset.assetPath.replace(/^\//, ""));

      const result = await compositeAssetOnFrame({
        framePath: video.localFilePath,
        assetPath: fullAssetPath,
        surfaceBbox: {
          x: surface.bboxX || 0,
          y: surface.bboxY || 0,
          width: surface.bboxWidth || 0.2,
          height: surface.bboxHeight || 0.2,
        },
        frameDimensions: { width: 1920, height: 1080 },
        outputDir,
        videoId,
        surfaceId,
      });

      res.json({
        success: true,
        compositePath: "/" + path.relative(path.join(process.cwd(), "public"), result.compositePath),
        previewPath: "/" + path.relative(path.join(process.cwd(), "public"), result.previewPath),
        placedRegion: result.placedRegion,
      });
    } catch (err: any) {
      console.error("[Composite] Error:", err.message);
      res.status(500).json({ error: err.message || "Compositing failed" });
    }
  });

  // POST /api/generate/:assetId/approve — Approve a generated asset
  app.post("/api/generate/:assetId/approve", isAuthenticated, async (req: any, res) => {
    try {
      const assetId = parseInt(req.params.assetId);
      const approved = await storage.approveAsset(assetId);
      if (!approved) return res.status(404).json({ error: "Asset not found" });
      res.json(approved);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Approval failed" });
    }
  });

  // GET /api/generate/video/:videoId/assets — List generated assets for a video
  app.get("/api/generate/video/:videoId/assets", isAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const assets = await storage.getAssetsByVideo(videoId);
      res.json(assets);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch assets" });
    }
  });

  // ─── CDense Content Synthesis ──────────────────────────────────

  // POST /api/synthesize/:videoId — Run full synthesis pipeline for a video
  app.post("/api/synthesize/:videoId", isAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const { surfaceId, brandProductId, skipEvaluation } = req.body;

      if (!surfaceId || !brandProductId) {
        return res.status(400).json({ error: "surfaceId and brandProductId are required" });
      }

      const surfaces = await storage.getSurfacesForVideo(videoId);
      const surface = surfaces.find((s: any) => s.id === surfaceId);
      if (!surface) return res.status(404).json({ error: "Surface not found" });

      const analyses = await storage.getSceneAnalysisBySurface(surfaceId);
      const analysis = analyses[0];
      if (!analysis) return res.status(404).json({ error: "No scene analysis. Run analysis first." });

      const items = await storage.getMonetizationItems();
      const brandProduct = items.find((i: any) => i.id === brandProductId);
      if (!brandProduct) return res.status(404).json({ error: "Brand product not found" });

      const video = await storage.getVideoById(videoId);
      if (!video || !video.localFilePath) return res.status(404).json({ error: "Video local file not found" });

      const { synthesizeContent } = await import("./lib/ai/cdense/contentSynthesis");

      const result = await synthesizeContent({
        videoId,
        surfaceId,
        brandProduct: { id: brandProduct.id, name: brandProduct.name, category: brandProduct.category || null },
        sceneContext: {
          narrativeContext: analysis.narrativeContext || "",
          emotionalTone: analysis.emotionalTone || "neutral",
          culturalTags: (analysis.culturalTags as string[]) || [],
          suggestedProductCategories: (analysis.suggestedCategories as string[]) || [],
        },
        surfaceBbox: {
          x: surface.bboxX || 0,
          y: surface.bboxY || 0,
          width: surface.bboxWidth || 0.2,
          height: surface.bboxHeight || 0.2,
        },
        sceneAesthetic: {
          colorWarmth: surface.colorWarmth || 0,
          brightness: { overall: surface.brightness || 128, top: 128, bottom: 128 },
          dominantColors: [],
        },
        lightingDirection: surface.lightingDirection || "ambient",
        framePath: video.localFilePath,
        frameDimensions: { width: 1920, height: 1080 },
        skipEvaluation: skipEvaluation || false,
      });

      if (result.success && result.assetPath) {
        // Save the generated asset with video metadata
        await storage.createGeneratedAsset({
          videoId,
          surfaceId,
          brandProductId,
          assetPath: result.assetPath,
          compositePath: result.compositePath || undefined,
          generationPrompt: result.prompt,
          assetType: result.assetType,
          seeddanceJobId: result.jobId || undefined,
          videoDuration: result.videoDuration || undefined,
          videoAspectRatio: result.videoAspectRatio || undefined,
          qualityScore: result.evaluation?.qualityScore || undefined,
          needsManualReview: result.evaluation?.needsManualReview ?? true,
          approved: result.evaluation ? !result.evaluation.needsManualReview : false,
        });
      }

      res.json(result);
    } catch (err: any) {
      console.error("[Synthesize] Error:", err.message);
      res.status(500).json({ error: err.message || "Synthesis failed" });
    }
  });

  // POST /api/synthesize/:videoId/decide — Get placement decisions for all surfaces
  app.post("/api/synthesize/:videoId/decide", isAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const scanMode = req.body.scanMode || "standard";

      const surfaces = await storage.getSurfacesForVideo(videoId);
      const allAnalyses = await storage.getSceneAnalysisByVideo(videoId);

      if (allAnalyses.length === 0) {
        return res.status(400).json({ error: "No scene analyses found. Run narrative analysis first." });
      }

      const { decidePlacement } = await import("./lib/ai/cdense/connector");

      const decisions = [];
      for (const analysis of allAnalyses) {
        const surface = surfaces.find((s: any) => s.id === analysis.surfaceId);
        if (!surface) continue;

        const brandMatches = await storage.getBrandMatchesByScene(analysis.id);
        const existingPlacements = await storage.getPlacementsForVideo(videoId);
        const hasExisting = existingPlacements.some((p: any) => p.detectedSurfaceId === surface.id);

        const decision = decidePlacement({
          videoId,
          surfaceId: surface.id,
          narrativeAnalysis: {
            narrativeContext: analysis.narrativeContext || "",
            emotionalTone: analysis.emotionalTone || "neutral",
            culturalTags: (analysis.culturalTags as string[]) || [],
            placementViability: analysis.placementViability || 0,
            suggestedProductCategories: (analysis.suggestedCategories as string[]) || [],
            reasoning: analysis.reasoning || "",
          },
          brandMatches: {
            matches: brandMatches.map((m: any) => {
              // Surface-aware fallback so we never default a wall to "natural tabletop"
              const sType = (surface.surfaceType || "table").toLowerCase();
              let fallback = "natural tabletop";
              if (sType.includes("wall")) fallback = "wall poster";
              else if (sType.includes("shelf")) fallback = "shelf prop";
              else if (sType.includes("monitor") || sType.includes("laptop") || sType.includes("tv")) fallback = "screen overlay";
              else if (sType.includes("floor")) fallback = "floor display";
              return {
                brandProductId: m.brandProductId,
                compatibilityScore: m.compatibilityScore || 0,
                reasoning: m.reasoning || "",
                suggestedPlacementStyle: m.suggestedPlacementStyle || fallback,
              };
            }),
          },
          surfaceDetails: {
            surfaceType: surface.surfaceType || "table",
            boundingBox: {
              x: surface.bboxX || 0,
              y: surface.bboxY || 0,
              width: surface.bboxWidth || 0.2,
              height: surface.bboxHeight || 0.2,
            },
            confidence: surface.confidence || 0,
            lightingDirection: surface.lightingDirection || "ambient",
          },
          sceneAesthetic: {
            colorWarmth: surface.colorWarmth || 0,
            brightness: { overall: surface.brightness || 128, top: 128, bottom: 128 },
            dominantColors: [],
          },
          hasExistingPlacement: hasExisting,
          scanMode,
        });

        decisions.push({ surfaceId: surface.id, analysisId: analysis.id, decision });
      }

      res.json({ decisions, total: decisions.length });
    } catch (err: any) {
      console.error("[Decide] Error:", err.message);
      res.status(500).json({ error: err.message || "Decision failed" });
    }
  });

  // ─── Editorial Intelligence: Transcript Pipeline ────────────────

  // POST /api/video/:videoId/transcribe — Run audio extraction + speech-to-text
  app.post("/api/video/:videoId/transcribe", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const { language = "en", provider } = req.body || {};

      // Validate video exists
      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!video.filePath) return res.status(400).json({ error: "Video has no file path" });

      // Check if transcript already exists
      const existing = await storage.getVideoTranscript(videoId);
      if (existing && existing.status === "completed") {
        return res.json({
          message: "Transcript already exists",
          transcript: existing,
        });
      }

      // Create pending transcript record
      const transcriptRecord = await storage.createVideoTranscript({
        videoId,
        provider: provider || "auto",
        language,
        status: "processing",
      });

      console.log(`[API] Transcription started for video ${videoId} (transcript ID: ${transcriptRecord.id})`);

      // Run pipeline asynchronously (don't block response)
      res.json({
        message: "Transcription started",
        transcriptId: transcriptRecord.id,
        status: "processing",
      });

      // Execute pipeline in background
      try {
        const result = await runTranscriptPipeline({
          videoId,
          filePath: video.filePath,
          language,
          provider: provider || undefined,
        });

        if (result.success) {
          await storage.updateVideoTranscript(transcriptRecord.id, {
            provider: result.provider,
            fullText: result.fullText,
            segments: result.segments,
            speakerMap: result.speakerMap,
            audioDuration: result.audioDuration,
            wordCount: result.wordCount,
            segmentCount: result.segmentCount,
            status: "completed",
            processingTimeMs: result.totalProcessingTimeMs,
          });
          console.log(`[API] Transcription completed for video ${videoId}: ${result.wordCount} words, ${result.segmentCount} segments`);
        } else {
          await storage.updateVideoTranscriptStatus(transcriptRecord.id, "failed", result.error);
          console.error(`[API] Transcription failed for video ${videoId}: ${result.error}`);
        }
      } catch (err: any) {
        await storage.updateVideoTranscriptStatus(transcriptRecord.id, "failed", err.message);
        console.error(`[API] Transcription pipeline error for video ${videoId}:`, err.message);
      }
    } catch (err: any) {
      console.error("[API] /api/video/:videoId/transcribe error:", err.message);
      res.status(500).json({ error: err.message || "Transcription failed" });
    }
  });

  // GET /api/video/:videoId/transcript — Get transcript for a video
  app.get("/api/video/:videoId/transcript", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const transcript = await storage.getVideoTranscript(videoId);

      if (!transcript) {
        return res.status(404).json({ error: "No transcript found for this video" });
      }

      res.json(transcript);
    } catch (err: any) {
      console.error("[API] /api/video/:videoId/transcript error:", err.message);
      res.status(500).json({ error: err.message || "Failed to get transcript" });
    }
  });

  // POST /api/scenes/:videoId/editorial-analysis — Run Claude Dense editorial clip analysis
  app.post("/api/scenes/:videoId/editorial-analysis", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const { maxClips = 10 } = req.body || {};

      // Validate video exists
      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      // Get transcript (required for editorial analysis)
      const transcript = await storage.getVideoTranscript(videoId);
      if (!transcript || transcript.status !== "completed" || !transcript.segments) {
        return res.status(400).json({
          error: "Completed transcript required. Run POST /api/video/:videoId/transcribe first.",
        });
      }

      // Get detected surfaces for cross-reference
      const surfaces = await storage.getDetectedSurfaces(videoId);

      // Get brand products for matching
      const brandProducts = await storage.getAllBrandProducts();

      console.log(
        `[API] Editorial analysis for video ${videoId}: ` +
          `${transcript.segments.length} transcript segments, ` +
          `${surfaces.length} surfaces, ${brandProducts.length} brand products`
      );

      // Run Claude Dense editorial analysis
      const editorialMoments = await analyzeEditorial({
        videoId,
        transcript: transcript.segments,
        surfaces: surfaces.map((s) => ({
          id: s.id,
          timestamp: parseFloat(String(s.timestamp)),
          surfaceType: s.surfaceType,
          confidence: parseFloat(String(s.confidence)),
          boundingBox: {
            x: parseFloat(String(s.boundingBoxX)),
            y: parseFloat(String(s.boundingBoxY)),
            width: parseFloat(String(s.boundingBoxWidth)),
            height: parseFloat(String(s.boundingBoxHeight)),
          },
        })),
        brandCatalog: brandProducts.map((b) => ({
          id: b.id,
          name: b.name,
          category: b.category,
          dominantColor: b.dominantColor,
        })),
        maxClips,
      });

      if (editorialMoments.length === 0) {
        return res.json({
          message: "No editorial clip moments found",
          moments: [],
          rankedClips: [],
        });
      }

      // Get brand matches for surface cross-reference
      const brandMatches = await storage.getBrandMatchesByVideo(videoId);

      // Cross-reference with surfaces and rank clips
      const rankedClips = deduplicateClips(
        rankClips(
          editorialMoments,
          surfaces.map((s) => ({
            id: s.id,
            videoId: s.videoId,
            timestamp: parseFloat(String(s.timestamp)),
            surfaceType: s.surfaceType,
            confidence: parseFloat(String(s.confidence)),
          })),
          brandMatches.map((bm) => ({
            id: bm.id,
            sceneAnalysisId: bm.sceneAnalysisId,
            brandProductId: bm.brandProductId,
            compatibilityScore: bm.compatibilityScore ?? 0,
            reasoning: bm.reasoning ?? "",
            suggestedPlacementStyle: bm.suggestedPlacementStyle ?? undefined,
          })),
          transcript.segments,
          maxClips
        )
      );

      console.log(
        `[API] Editorial analysis complete for video ${videoId}: ` +
          `${editorialMoments.length} moments → ${rankedClips.length} ranked clips`
      );

      // Persist editorial clips to the database so they survive page reloads
      const userId = req.user?.id || 1;
      try {
        await storage.saveEditorialClips(videoId, userId, rankedClips);
        console.log(`[API] Saved ${rankedClips.length} editorial clips to DB for video ${videoId}`);
      } catch (saveErr: any) {
        // Non-fatal — still return the results even if DB save fails (table may not exist yet)
        console.warn(`[API] Failed to persist editorial clips: ${saveErr.message}`);
      }

      res.json({
        message: `Found ${rankedClips.length} editorial clip moments`,
        moments: editorialMoments,
        rankedClips,
      });
    } catch (err: any) {
      console.error("[API] /api/scenes/:videoId/editorial-analysis error:", err.message);
      res.status(500).json({ error: err.message || "Editorial analysis failed" });
    }
  });

  // GET /api/scenes/:videoId/editorial-clips — Load previously saved editorial clips
  app.get("/api/scenes/:videoId/editorial-clips", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      const clips = await storage.getEditorialClipsByVideo(videoId);
      res.json({ clips });
    } catch (err: any) {
      // Gracefully handle table not existing yet
      if (err.message?.includes("editorial_clips") && err.message?.includes("does not exist")) {
        return res.json({ clips: [] });
      }
      console.error("[API] /api/scenes/:videoId/editorial-clips error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Feature A: Editorial Auto-Pipeline Endpoints ─────────────

  // GET /api/videos/:videoId/editorial-status — Poll pipeline progress + clip counts
  app.get("/api/videos/:videoId/editorial-status", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      let clips: any[] = [];
      try {
        clips = await storage.getEditorialClipsByVideo(videoId);
      } catch (e: any) {
        // Gracefully handle missing table
        if (!e.message?.includes("does not exist")) throw e;
      }

      const renderedCount = clips.filter((c) => c.renderStatus === "rendered").length;
      const failedCount = clips.filter((c) => c.renderStatus === "failed").length;
      const pendingCount = clips.filter((c) => c.renderStatus === "pending" || c.renderStatus === "rendering").length;

      res.json({
        videoId,
        status: video.editorialStatus ?? "none",
        error: video.editorialError ?? null,
        totalClips: clips.length,
        renderedClips: renderedCount,
        failedClips: failedCount,
        pendingClips: pendingCount,
        completedAt: video.editorialCompletedAt,
        // Last DB update — UI uses this to detect stuck pipelines (no progress in 5+ min while in-flight)
        updatedAt: video.updatedAt,
      });
    } catch (err: any) {
      console.error("[API] /api/videos/:videoId/editorial-status error:", err.message);
      res.status(500).json({ error: err.message || "Failed to get editorial status" });
    }
  });

  // POST /api/videos/:videoId/editorial-search — Search for clips matching a topic/keyword
  app.post("/api/videos/:videoId/editorial-search", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });
      const { query, maxClips = 10 } = req.body || {};

      if (!query || typeof query !== "string" || query.trim().length === 0) {
        return res.status(400).json({ error: "Query is required" });
      }

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      // Require transcript
      const transcript = await storage.getVideoTranscript(videoId);
      if (!transcript || transcript.status !== "completed" || !transcript.segments) {
        return res.status(400).json({
          error: "Transcript required. Run editorial auto-pipeline first.",
        });
      }

      const surfaces = await storage.getDetectedSurfaces(videoId);
      const brandProducts = await storage.getAllBrandProducts();

      console.log(`[API] Editorial search for video ${videoId}: query="${query}", maxClips=${maxClips}`);

      // Run editorial analysis with search query
      const editorialMoments = await analyzeEditorial({
        videoId,
        transcript: transcript.segments as any,
        surfaces: surfaces.map((s) => ({
          id: s.id,
          timestamp: parseFloat(String(s.timestamp)),
          surfaceType: s.surfaceType,
          confidence: parseFloat(String(s.confidence)),
          boundingBox: {
            x: parseFloat(String(s.boundingBoxX)),
            y: parseFloat(String(s.boundingBoxY)),
            width: parseFloat(String(s.boundingBoxWidth)),
            height: parseFloat(String(s.boundingBoxHeight)),
          },
        })),
        brandCatalog: brandProducts.map((b) => ({
          id: b.id,
          name: b.name,
          category: b.category,
          dominantColor: b.dominantColor,
        })),
        maxClips,
        query: query.trim(),
      });

      res.json({
        query: query.trim(),
        clips: editorialMoments,
        count: editorialMoments.length,
      });
    } catch (err: any) {
      console.error("[API] /api/videos/:videoId/editorial-search error:", err.message);
      res.status(500).json({ error: err.message || "Search failed" });
    }
  });

  // POST /api/videos/:videoId/editorial-clip/render — Render a single ad-hoc clip
  // (from search results or manual selection) and append to the editorialClips list
  app.post("/api/videos/:videoId/editorial-clip/render", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });
      const { clipStart, clipEnd, suggestedTitle, topicTags, reasoning, scores, compositeScore } = req.body || {};

      if (typeof clipStart !== "number" || typeof clipEnd !== "number" || clipEnd <= clipStart) {
        return res.status(400).json({ error: "Valid clipStart and clipEnd required" });
      }

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!video.filePath) return res.status(400).json({ error: "Video has no filePath" });

      // Insert a new editorial clip record with pending render status
      const duration = clipEnd - clipStart;
      const [newClip] = await db.insert(editorialClips).values({
        videoId,
        userId: 0,
        clipStart,
        clipEnd,
        duration,
        editorialScore: compositeScore || 0.7,
        surfaceScore: 0,
        brandMatchScore: 0,
        finalScore: compositeScore || 0.7,
        monetizationTier: "organic",
        scores: scores || null,
        surfaces: [],
        brandMatches: [],
        editPoints: { start: clipStart, end: clipEnd, adjustments: ["Added from search"] },
        suggestedTitle: suggestedTitle || "Custom Clip",
        topicTags: topicTags || [],
        reasoning: reasoning || "Added from search results",
        rawClipStart: clipStart,
        rawClipEnd: clipEnd,
        renderStatus: "pending",
      }).returning();

      console.log(`[API] Editorial-clip/render: saved clip ${newClip.id}, queuing render...`);

      // Respond immediately — render happens in background
      res.json({
        success: true,
        clip: newClip,
        message: "Clip saved. Render queued.",
      });

      // Fire-and-forget render (reuses the pipeline's render logic via force re-run on this clip only)
      // Simplest approach: trigger runEditorialAutoPipeline with force=false so it just renders pending clips
      // But that would re-analyze — instead we do a minimal inline render here
      (async () => {
        try {
          const { renderSingleEditorialClip } = await import("./lib/remix/editorialAutoPipeline");
          await renderSingleEditorialClip(videoId, newClip.id);
        } catch (err: any) {
          console.error(`[API] Single-clip render failed for clip ${newClip.id}:`, err?.message);
          await storage.updateEditorialClipRender(newClip.id, {
            renderStatus: "failed",
            renderError: err?.message || "Render failed",
          });
        }
      })();
    } catch (err: any) {
      console.error("[API] /api/videos/:videoId/editorial-clip/render error:", err.message);
      res.status(500).json({ error: err.message || "Failed to render clip" });
    }
  });

  // POST /api/videos/:videoId/editorial-cancel — Cancel a running editorial pipeline
  app.post("/api/videos/:videoId/editorial-cancel", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      const inFlight = ["pending", "transcribing", "analyzing", "rendering"].includes(video.editorialStatus ?? "");
      if (!inFlight) {
        return res.json({ message: "No pipeline running", videoId, status: video.editorialStatus });
      }

      // Set status to failed with "Cancelled by user" — pipeline loop checks this
      await storage.updateVideoEditorialStatus(videoId, "failed", { error: "Cancelled by user" });

      console.log(`[API] Editorial pipeline cancelled by user for video ${videoId}`);
      res.json({ message: "Pipeline cancelled", videoId, status: "failed" });
    } catch (err: any) {
      console.error("[API] /api/videos/:videoId/editorial-cancel error:", err.message);
      res.status(500).json({ error: err.message || "Failed to cancel pipeline" });
    }
  });

  // POST /api/videos/:videoId/editorial-auto — Manually trigger or force re-run
  app.post("/api/videos/:videoId/editorial-auto", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });
      const { force = false } = req.body || {};

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!video.filePath) return res.status(400).json({ error: "Video has no filePath" });

      // Fire-and-forget — respond immediately
      res.json({
        message: "Editorial auto-pipeline started",
        videoId,
        status: "pending",
      });

      const pipelineUserId = 0;
      runEditorialAutoPipeline(videoId, pipelineUserId, { force: Boolean(force) })
        .then(r => {
          if (r.success) {
            console.log(`[API] Editorial auto-pipeline manual run: ${r.clipsRendered}/${r.clipsGenerated} rendered for video ${videoId}`);
          } else {
            console.warn(`[API] Editorial auto-pipeline manual run failed for ${videoId}: ${r.error}`);
          }
        })
        .catch(err => {
          console.error(`[API] Editorial auto-pipeline manual run error for ${videoId}:`, err?.message || err);
        });
    } catch (err: any) {
      console.error("[API] /api/videos/:videoId/editorial-auto error:", err.message);
      res.status(500).json({ error: err.message || "Failed to start pipeline" });
    }
  });

  // POST /api/videos/:videoId/editorial-resume — Resume a stuck pipeline.
  // Skips transcript+analysis, only renders clips with renderStatus !== "rendered".
  // Use case: server restart left clips stuck in "rendering" state. This recovers
  // without losing already-rendered clips.
  app.post("/api/videos/:videoId/editorial-resume", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!video.filePath) return res.status(400).json({ error: "Video has no filePath" });

      const existingClips = await storage.getEditorialClipsByVideo(videoId);
      if (existingClips.length === 0) {
        return res.status(400).json({
          error: "No existing clips to resume — use /editorial-auto for a full run",
        });
      }

      const unrendered = existingClips.filter((c) => c.renderStatus !== "rendered");
      if (unrendered.length === 0) {
        return res.json({
          message: "All clips already rendered",
          videoId,
          rendered: existingClips.length,
        });
      }

      // Fire-and-forget — respond immediately so UI gets a fast ack
      res.json({
        message: "Resume started",
        videoId,
        toRender: unrendered.length,
        alreadyRendered: existingClips.length - unrendered.length,
      });

      // Match the pattern from editorial-auto: pipeline takes a numeric placeholder.
      // userId on the videoIndex row is a string, so we fall back to 0 like the auto endpoint.
      const pipelineUserId = 0;
      runEditorialAutoPipeline(videoId, pipelineUserId, { resume: true })
        .then(r => {
          if (r.success) {
            console.log(`[API] Editorial resume: ${r.clipsRendered}/${r.clipsGenerated} rendered for video ${videoId}`);
          } else {
            console.warn(`[API] Editorial resume failed for ${videoId}: ${r.error}`);
          }
        })
        .catch(err => {
          console.error(`[API] Editorial resume error for ${videoId}:`, err?.message || err);
        });
    } catch (err: any) {
      console.error("[API] /api/videos/:videoId/editorial-resume error:", err.message);
      res.status(500).json({ error: err.message || "Failed to resume pipeline" });
    }
  });

  // ─── Clip Feedback Endpoints ──────────────────────────────────

  // POST /api/remix/clips/:clipId/feedback — Submit creator/brand feedback
  app.post("/api/remix/clips/:clipId/feedback", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      const { feedbackType, approved, rating, rejectionReason, views, engagementRate, shareCount, completionRate, clickThroughRate } = req.body;

      if (!feedbackType || !["creator", "brand", "performance"].includes(feedbackType)) {
        return res.status(400).json({ error: "feedbackType must be 'creator', 'brand', or 'performance'" });
      }

      const feedback = await storage.createClipFeedback({
        generatedClipId: clipId,
        feedbackType,
        approved: approved ?? null,
        rating: rating ?? null,
        rejectionReason: rejectionReason ?? null,
        views: views ?? null,
        engagementRate: engagementRate ?? null,
        shareCount: shareCount ?? null,
        completionRate: completionRate ?? null,
        clickThroughRate: clickThroughRate ?? null,
      });

      res.json(feedback);
    } catch (err: any) {
      console.error("[API] /api/remix/clips/:clipId/feedback error:", err.message);
      res.status(500).json({ error: err.message || "Failed to submit feedback" });
    }
  });

  // GET /api/remix/clips/:clipId/feedback — Get feedback for a clip
  app.get("/api/remix/clips/:clipId/feedback", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      const feedback = await storage.getClipFeedback(clipId);
      res.json(feedback);
    } catch (err: any) {
      console.error("[API] GET /api/remix/clips/:clipId/feedback error:", err.message);
      res.status(500).json({ error: err.message || "Failed to get feedback" });
    }
  });

  // GET /api/remix/analytics/rubric-performance — Analyze rubric scores vs performance
  app.get("/api/remix/analytics/rubric-performance", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const performanceFeedback = await storage.getPerformanceFeedback();
      // Return raw data — frontend or a future analyticsCollector will compute correlations
      res.json({
        feedbackCount: performanceFeedback.length,
        feedback: performanceFeedback,
      });
    } catch (err: any) {
      console.error("[API] /api/remix/analytics/rubric-performance error:", err.message);
      res.status(500).json({ error: err.message || "Failed to get analytics" });
    }
  });

  // ─── Auto-Remix Engine ──────────────────────────────────────────

  // POST /api/remix/:videoId/start — Kick off a remix job
  // Supports: clipRange (direct editorial clip), editorialMode (full editorial pipeline), or legacy (per-frame)
  app.post("/api/remix/:videoId/start", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      // authUserId can be an email string or numeric ID — ensure we have a numeric userId
      const rawUserId = req.authUserId || req.user?.id || 1;
      const userId = typeof rawUserId === "number" ? rawUserId : parseInt(rawUserId) || 1;
      const config = req.body || {};

      // Validate video exists
      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      // For editorial mode with clipRange, we don't require scene analyses
      // For legacy mode, check for scene analyses
      const isEditorial = !!config.clipRange || config.editorialMode;
      if (!isEditorial) {
        const analyses = await storage.getSceneAnalysisByVideo(videoId);
        if (analyses.length === 0) {
          return res.status(400).json({ error: "No scene analyses found. Run Claude Dense analysis first via Narrative Insights." });
        }
      }

      // Start the remix pipeline in the background
      const { runRemixPipeline } = await import("./lib/remix/remixOrchestrator");

      // Build pipeline config — pass through clipRange and editorialMode
      const pipelineConfig = {
        minClipDuration: config.minClipDuration || 15,
        maxClipDuration: config.maxClipDuration || 60,
        maxClips: config.maxClips || 5,
        platformTargets: config.platformTargets || ["tiktok", "youtube_shorts"],
        captionsEnabled: config.captionsEnabled !== false,
        captionStyle: config.captionStyle || "highlight",
        clipRange: config.clipRange || undefined,
        editorialMode: isEditorial,
      };

      // Return the job ID immediately, process async.
      // IMPORTANT: This is the ONE AND ONLY place a remix job row is created for a
      // user-initiated auto-remix. The orchestrator MUST NOT create its own — it takes
      // this jobId as input and updates its status. If you add a second createRemixJob()
      // call on this path, the UI will poll a ghost job forever. (See Bug #0 writeup.)
      const job = await storage.createRemixJob({
        videoId,
        userId,
        status: "queued",
        config: pipelineConfig,
        platformTargets: pipelineConfig.platformTargets,
      });

      // Run pipeline asynchronously, threading this job's ID through so all status
      // updates and clip inserts land on the row the UI is polling.
      runRemixPipeline(job.id, videoId, userId, pipelineConfig).catch(async (err) => {
        console.error(`[Remix] Background job ${job.id} failed:`, err);
        try {
          await storage.updateRemixJobStatus(job.id, "failed", err.message || "Pipeline crashed");
        } catch (dbErr) {
          console.error(`[Remix] Failed to update job ${job.id} status to failed:`, dbErr);
        }
      });

      const mode = config.clipRange ? "editorial-clip" : isEditorial ? "editorial" : "legacy";
      res.json({ jobId: job.id, status: "queued", mode, message: "Remix job started" });
    } catch (err: any) {
      console.error("[Remix Start] Error:", err.message, err.stack);
      res.status(500).json({ error: err.message || "Failed to start remix" });
    }
  });

  // GET /api/remix/jobs/:jobId — Get job status and clips
  app.get("/api/remix/jobs/:jobId", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const jobId = parseInt(req.params.jobId);
      const job = await storage.getRemixJob(jobId);
      if (!job) return res.status(404).json({ error: "Remix job not found" });

      const clips = await storage.getClipsByJob(jobId);
      res.json({ job, clips });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch job" });
    }
  });

  // POST /api/remix/jobs/:jobId/cancel — Soft cancel a running remix job
  app.post("/api/remix/jobs/:jobId/cancel", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const jobId = parseInt(req.params.jobId);
      const job = await storage.getRemixJob(jobId);
      if (!job) return res.status(404).json({ error: "Remix job not found" });

      if (job.status === "completed") {
        return res.status(400).json({ error: "Cannot cancel a completed job" });
      }
      if (job.status === "cancelled") {
        return res.json({ success: true, jobId, status: "cancelled", alreadyCancelled: true });
      }

      // Soft cancel — set status to "cancelled". The running pipeline checks this
      // flag between stages and throws when it sees "cancelled".
      await storage.updateRemixJobStatus(jobId, "cancelled", "Cancelled by user");

      console.log(`[Remix] Job ${jobId} cancelled by user`);
      res.json({ success: true, jobId, status: "cancelled" });
    } catch (err: any) {
      console.error("[Remix] Cancel error:", err);
      res.status(500).json({ error: err.message || "Cancel failed" });
    }
  });

  // GET /api/remix/video/:videoId/jobs — List all remix jobs for a video
  app.get("/api/remix/video/:videoId/jobs", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const userId = req.user?.id || 1;
      const jobs = await storage.getRemixJobsByUser(userId);
      const videoJobs = jobs.filter(j => j.videoId === videoId);
      res.json(videoJobs);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch jobs" });
    }
  });

  // GET /api/remix/clips/:videoId — List all generated clips for a video
  app.get("/api/remix/clips/:videoId", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const clips = await storage.getClipsByVideo(videoId);
      res.json(clips);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch clips" });
    }
  });

  // POST /api/remix/clips/:clipId/approve — Approve a clip for publishing
  app.post("/api/remix/clips/:clipId/approve", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      const updated = await storage.updateClipStatus(clipId, "ready");
      if (!updated) return res.status(404).json({ error: "Clip not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Approval failed" });
    }
  });

  // POST /api/remix/clips/:clipId/reject — Reject a clip
  app.post("/api/remix/clips/:clipId/reject", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      const updated = await storage.updateClipStatus(clipId, "rejected");
      if (!updated) return res.status(404).json({ error: "Clip not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Rejection failed" });
    }
  });

  // POST /api/remix/clips/:clipId/publish — Mark clip as published
  app.post("/api/remix/clips/:clipId/publish", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      const { platform, url } = req.body;
      if (!platform) return res.status(400).json({ error: "platform is required" });

      const published = await storage.publishClip(clipId, platform, url || "");
      if (!published) return res.status(404).json({ error: "Clip not found" });
      res.json(published);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Publishing failed" });
    }
  });

  // GET /api/remix/clips/:clipId/download — Stream clip file (Object Storage or local)
  app.get("/api/remix/clips/:clipId/download", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      const clip = await findClipById(clipId);
      if (!clip || !clip.exportPath) {
        return res.status(404).json({ error: "Clip not found or not exported" });
      }

      const filename = `fullscale-clip-${clip.videoId}-${clipId}.mp4`;
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "video/mp4");

      // Check if stored in Object Storage (/storage/... paths)
      if (clip.exportPath.startsWith("/storage/")) {
        const { getStorageStream } = await import("./lib/objectStorage");
        const objectKey = clip.exportPath.replace(/^\/storage\//, "public/");
        const { stream } = getStorageStream(objectKey);
        stream.on("error", (err: any) => {
          console.error(`[Remix Download] Object Storage stream error: ${err.message}`);
          if (!res.headersSent) {
            res.status(404).json({ error: "Clip file not found in storage" });
          }
        });
        stream.pipe(res);
      } else {
        // Fallback: local file path
        const fullPath = path.join(process.cwd(), "public", clip.exportPath.replace(/^\//, ""));
        if (!fs.existsSync(fullPath)) {
          return res.status(404).json({ error: "Clip file not found on disk" });
        }
        const fileStream = fs.createReadStream(fullPath);
        fileStream.pipe(res);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Download failed" });
    }
  });

  // ─── Phase 2C: Clip Re-Render ──────────────────────────────────

  // POST /api/remix/clips/:clipId/re-render — Re-render an existing clip with modifications
  app.post("/api/remix/clips/:clipId/re-render", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);

      // Validate clip exists
      const clip = await storage.getClipById(clipId);
      if (!clip) return res.status(404).json({ error: "Clip not found" });

      const { newStart, newEnd, captionsEnabled, captionStyle, platformTarget } = req.body;

      // Basic validation
      if (newStart !== undefined && newEnd !== undefined && newEnd <= newStart) {
        return res.status(400).json({ error: "newEnd must be greater than newStart" });
      }

      const { reRenderClip } = await import("./lib/remix/remixOrchestrator");

      // Run re-render asynchronously
      const modifications = {
        newStart: newStart !== undefined ? parseFloat(newStart) : undefined,
        newEnd: newEnd !== undefined ? parseFloat(newEnd) : undefined,
        captionsEnabled: captionsEnabled !== undefined ? captionsEnabled : undefined,
        captionStyle: captionStyle || undefined,
        platformTarget: platformTarget || undefined,
      };

      res.json({
        status: "rendering",
        originalClipId: clipId,
        modifications,
        message: "Re-render started",
      });

      // Run in background after response
      reRenderClip(clipId, modifications).catch(async (err) => {
        console.error(`[Re-Render] Background re-render for clip ${clipId} failed:`, err);
        try {
          const clip = await storage.getClipById(clipId);
          if (clip?.remixJobId) {
            await storage.updateRemixJobStatus(clip.remixJobId, "failed", `Re-render failed: ${err.message || "unknown"}`);
          }
        } catch (dbErr) {
          console.error(`[Re-Render] Failed to update job status for clip ${clipId}:`, dbErr);
        }
      });
    } catch (err: any) {
      console.error("[Re-Render Route] Error:", err.message);
      res.status(500).json({ error: err.message || "Re-render failed" });
    }
  });

  // ─── Phase 2B: Multi-Segment Stitching ───────────────────────

  // POST /api/remix/:videoId/narrative-thread — Run Claude narrative threading analysis
  app.post("/api/remix/:videoId/narrative-thread", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);

      // Validate video exists
      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      // Load transcript
      const transcript = await storage.getVideoTranscript(videoId);
      if (!transcript || transcript.status !== "completed" || !transcript.segments) {
        return res.status(400).json({ error: "No completed transcript. Run transcript analysis first." });
      }

      // Load surfaces and brand catalog
      const surfaces = await storage.getDetectedSurfaces(videoId);
      const brandCatalog = await storage.getAllBrandProducts();

      const { analyzeNarrativeThread } = await import("./lib/ai/claude-dense/editorialAnalyzer");

      const targetDuration = req.body.targetDuration || 90;
      const segmentCount = req.body.segmentCount || 4;

      const result = await analyzeNarrativeThread({
        videoId,
        transcript: transcript.segments as any[],
        surfaces: surfaces.map(s => ({
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
        brandCatalog: brandCatalog.map(b => ({
          id: b.id,
          name: b.name,
          category: b.category || null,
          dominantColor: null,
        })),
        targetDuration,
        segmentCount,
      });

      if (!result) {
        return res.status(500).json({ error: "Narrative thread analysis returned no results" });
      }

      res.json(result);
    } catch (err: any) {
      console.error("[Narrative Thread Route] Error:", err.message, err.stack);
      res.status(500).json({ error: err.message || "Narrative thread analysis failed" });
    }
  });

  // POST /api/remix/:videoId/stitch — Generate a stitched highlight reel
  app.post("/api/remix/:videoId/stitch", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const rawUserId = req.authUserId || req.user?.id || 1;
      const userId = typeof rawUserId === "number" ? rawUserId : parseInt(rawUserId) || 1;

      // Validate video exists
      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      const {
        segments,
        transitions = "crossfade",
        platformTarget = "tiktok",
        captionsEnabled = true,
        narrativeArc,
        suggestedTitle,
      } = req.body;

      if (!segments || !Array.isArray(segments) || segments.length < 2) {
        return res.status(400).json({ error: "At least 2 segments required" });
      }

      // Validate segment structure
      for (const seg of segments) {
        if (typeof seg.start !== "number" || typeof seg.end !== "number" || seg.end <= seg.start) {
          return res.status(400).json({ error: "Each segment must have valid start and end timestamps" });
        }
      }

      // Create stitch plan record
      const plan = await storage.createStitchPlan({
        videoId,
        userId,
        status: "generating",
        narrativeArc: narrativeArc || null,
        suggestedTitle: suggestedTitle || null,
        segments: segments.map((seg: any) => ({
          start: seg.start,
          end: seg.end,
          role: seg.role || "development",
          narrativePurpose: seg.narrativePurpose || "",
          connectionToNext: seg.connectionToNext || undefined,
          suggestedTransition: seg.suggestedTransition || transitions,
          enabled: seg.enabled !== false,
        })),
        totalDuration: segments.reduce((sum: number, seg: any) => sum + (seg.end - seg.start), 0),
        transitionStyle: transitions,
        platformTarget,
      });

      // Return immediately with plan ID
      res.json({
        planId: plan.id,
        status: "generating",
        message: "Stitch job started",
      });

      // Run stitching in background
      (async () => {
        // Hoisted so the finally block can clean it up no matter where we fail.
        let tempScopeDir: string | null = null;
        try {
          const { PLATFORM_CONFIGS } = await import("./lib/remix/clipDetector");
          const { stitchSegments } = await import("./lib/remix/clipStitcher");

          const filePath = video.filePath;
          if (!filePath) throw new Error("Video has no file path");

          // Note: resolveVideoPath is not exported — inline the logic.
          // IMPORTANT: scope the temp path per stitch plan so concurrent stitch jobs
          // (and concurrent remix jobs using the same source video) don't trample each
          // other. Without scoping, two jobs downloading to the same filename causes
          // "moov atom not found" and "Video file not found" errors mid-pipeline.
          const { objectKeyFromServeUrl, downloadToTempFile, uploadFileToStorage } = await import("./lib/objectStorage");

          let videoPath: string;

          if (filePath.startsWith("/storage/")) {
            const objectKey = objectKeyFromServeUrl(filePath);
            tempScopeDir = path.join("/tmp/remix-videos", `stitch-${plan.id}`);
            videoPath = await downloadToTempFile(objectKey, tempScopeDir);
          } else {
            videoPath = filePath;
            if (filePath.startsWith("/") && !fs.existsSync(filePath)) {
              const publicPath = path.join(process.cwd(), "public", filePath);
              if (fs.existsSync(publicPath)) videoPath = publicPath;
            }
          }

          const platformConfig = PLATFORM_CONFIGS[platformTarget];
          if (!platformConfig) throw new Error(`Unknown platform: ${platformTarget}`);

          const outputDir = path.join(process.cwd(), "public", "exported-clips", `stitch_${plan.id}`);

          // Build stitch segments with transition types
          const stitchSegs = segments
            .filter((_: any, i: number) => {
              const planSeg = plan.segments?.[i];
              return !planSeg || planSeg.enabled !== false;
            })
            .map((seg: any, i: number) => ({
              start: seg.start,
              end: seg.end,
              transitionIn: i === 0 ? "cut" as const : (seg.suggestedTransition || transitions) as "cut" | "crossfade" | "branded_wipe",
              transitionDuration: 0.5,
            }));

          const result = await stitchSegments({
            videoPath,
            videoId,
            segments: stitchSegs,
            platformConfig,
            captionsEnabled,
            outputDir,
            planId: plan.id,
          });

          if (!result.success) {
            await storage.updateStitchPlanStatus(plan.id, "failed", {
              errorMessage: result.error || "Stitching failed",
            });
            return;
          }

          // Upload to Object Storage
          let storagePath: string | null = null;
          let thumbStoragePath: string | null = null;

          if (result.outputPath && fs.existsSync(result.outputPath)) {
            try {
              const filename = path.basename(result.outputPath);
              const objectKey = `public/exported-clips/stitch_${plan.id}/${filename}`;
              storagePath = await uploadFileToStorage(result.outputPath, objectKey);
              fs.unlinkSync(result.outputPath);
            } catch (uploadErr: any) {
              console.warn(`[Stitch] Upload failed: ${uploadErr.message}`);
              storagePath = "/" + path.relative(path.join(process.cwd(), "public"), result.outputPath);
            }
          }

          if (result.thumbnailPath && fs.existsSync(result.thumbnailPath)) {
            try {
              const filename = path.basename(result.thumbnailPath);
              const objectKey = `public/exported-clips/stitch_${plan.id}/${filename}`;
              thumbStoragePath = await uploadFileToStorage(result.thumbnailPath, objectKey);
              fs.unlinkSync(result.thumbnailPath);
            } catch (uploadErr: any) {
              thumbStoragePath = result.thumbnailPath ? "/" + path.relative(path.join(process.cwd(), "public"), result.thumbnailPath) : null;
            }
          }

          // Create a remix job + generated clip record for the stitched output
          const stitchJob = await storage.createRemixJob({
            videoId,
            userId,
            status: "completed",
            config: {
              minClipDuration: 0,
              maxClipDuration: 300,
              maxClips: 1,
              platformTargets: [platformTarget],
              captionsEnabled,
            },
            platformTargets: [platformTarget],
          });

          const dbClip = await storage.createGeneratedClip({
            remixJobId: stitchJob.id,
            videoId,
            clipStart: segments[0].start,
            clipEnd: segments[segments.length - 1].end,
            duration: result.duration,
            format: "mp4",
            platformTarget,
            captionsEnabled,
            qualityScore: 0.8, // Default for stitched content
            exportPath: storagePath,
            thumbnailPath: thumbStoragePath,
            status: "ready",
          });

          await storage.updateStitchPlanStatus(plan.id, "completed", {
            outputPath: storagePath || undefined,
            thumbnailPath: thumbStoragePath || undefined,
            qualityScore: 0.8,
            generatedClipId: dbClip.id,
          });

          console.log(`[Stitch] Plan ${plan.id} complete — clip #${dbClip.id}`);
        } catch (err: any) {
          console.error(`[Stitch] Background stitch for plan ${plan.id} failed:`, err);
          await storage.updateStitchPlanStatus(plan.id, "failed", {
            errorMessage: err.message,
          });
        } finally {
          // Clean up the per-stitch temp scope directory (holds the source video
          // and any intermediates). rmSync with recursive+force is idempotent and
          // tolerates missing dirs, so it's safe regardless of where we failed.
          if (tempScopeDir) {
            try { fs.rmSync(tempScopeDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
          }
        }
      })();
    } catch (err: any) {
      // Gracefully handle missing stitch_plans table
      if (err.message?.includes("stitch_plans") && err.message?.includes("does not exist")) {
        console.warn("[Stitch] Table not yet created — run `npm run db:push` to migrate");
        return res.status(503).json({ error: "Stitch plans feature requires database migration. Run `npm run db:push` on Replit." });
      }
      console.error("[Stitch Route] Error:", err.message, err.stack);
      res.status(500).json({ error: err.message || "Stitch failed" });
    }
  });

  // GET /api/remix/:videoId/stitch-plans — List stitch plans for a video
  app.get("/api/remix/:videoId/stitch-plans", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const plans = await storage.getStitchPlansByVideo(videoId);
      res.json(plans);
    } catch (err: any) {
      // Gracefully handle missing stitch_plans table (needs db:push migration)
      if (err.message?.includes("stitch_plans") && err.message?.includes("does not exist")) {
        console.warn("[StitchPlans] Table not yet created — run `npm run db:push` to migrate");
        return res.json([]);
      }
      res.status(500).json({ error: err.message || "Failed to fetch stitch plans" });
    }
  });

  // GET /api/remix/stitch-plans/:planId — Get a specific stitch plan
  app.get("/api/remix/stitch-plans/:planId", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const planId = parseInt(req.params.planId);
      const plan = await storage.getStitchPlan(planId);
      if (!plan) return res.status(404).json({ error: "Stitch plan not found" });
      res.json(plan);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch stitch plan" });
    }
  });

  // DELETE /api/remix/stitch-plans/:planId — Delete a stitch plan (highlight reel)
  app.delete("/api/remix/stitch-plans/:planId", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const planId = parseInt(req.params.planId);
      if (isNaN(planId)) return res.status(400).json({ error: "Invalid plan ID" });

      const plan = await storage.getStitchPlan(planId);
      if (!plan) return res.status(404).json({ error: "Stitch plan not found" });

      await storage.deleteStitchPlan(planId);
      res.json({ success: true, message: "Highlight reel deleted" });
    } catch (err: any) {
      console.error(`[StitchPlans] Delete failed for plan ${req.params.planId}:`, err);
      res.status(500).json({ error: err.message || "Failed to delete stitch plan" });
    }
  });

  // ─── AI Co-Pilot (Phase 4) ───────────────────────────────────

  // POST /api/remix/:videoId/copilot/ask — Ask the co-pilot (SSE streaming)
  app.post("/api/remix/:videoId/copilot/ask", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const { trigger, userMessage, clipId } = req.body;

      if (!trigger || !["post_generation", "post_trim", "low_score", "user_question"].includes(trigger)) {
        return res.status(400).json({ error: "Invalid trigger. Must be one of: post_generation, post_trim, low_score, user_question" });
      }

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      // Build session context from DB
      const { streamCopilot } = await import("./lib/ai/remixCopilot");

      // Load transcript
      const videoTranscript = await storage.getVideoTranscript(videoId);
      const transcript = videoTranscript?.segments
        ? (videoTranscript.segments as any[])
        : [];

      // Load surfaces
      const allSurfaces = await storage.getDetectedSurfaces(videoId);
      const surfaces = allSurfaces.map((s: any) => ({
        id: s.id,
        timestamp: s.timestamp || 0,
        surfaceType: s.surfaceType || "unknown",
        confidence: s.confidence || 0.5,
      }));

      // Load brand catalog — use authUserId from flexible auth (not req.user which is Passport-only)
      const userId = String(req.authUserId || req.user?.id || 1);
      const allBrands = await storage.getBrandProducts(userId);
      const brandCatalog = allBrands.map((b: any) => ({
        id: b.id,
        name: b.name,
        category: b.category || null,
      }));

      // Load current clip if specified
      let currentClip: any = undefined;
      if (clipId) {
        const clip = await storage.getClipById(parseInt(clipId));
        if (clip) {
          currentClip = {
            clipId: clip.id,
            start: clip.clipStart || 0,
            end: clip.clipEnd || 0,
            duration: clip.duration || 0,
            platform: clip.platformTarget || "tiktok",
            qualityScore: clip.qualityScore || 0,
            scores: (clip as any).qualityBreakdown || undefined,
            placements: [],
            captions: undefined,
            exportPath: clip.exportPath || undefined,
          };
        }
      }

      // Load existing clips for this video (for stitch suggestions)
      const allClips = await storage.getClipsByVideo(videoId);
      const existingClips = allClips.slice(0, 20).map((c: any) => ({
        clipId: c.id,
        start: c.clipStart || 0,
        end: c.clipEnd || 0,
        platform: c.platformTarget || "tiktok",
        qualityScore: c.qualityScore || 0,
      }));

      const sessionContext = {
        videoId,
        videoTitle: video.title || `Video ${videoId}`,
        videoDuration: parseFloat(video.duration as string) || 0,
        transcript,
        currentClip,
        surfaces,
        brandCatalog,
        existingClips,
        editorialAnalysis: undefined,
        editHistory: [],
      };

      // Verify Anthropic API key is available before starting SSE stream
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const anthropicBaseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;
      if (!apiKey) {
        console.error("[CopilotRoute] ANTHROPIC_API_KEY is not set. Set it in Secrets/Environment.");
        // Log all env vars that start with ANTHROPIC or AI_INTEGRATIONS for debugging
        const relevantVars = Object.keys(process.env).filter(k => k.includes('ANTHROPIC') || k.includes('AI_INTEGRATIONS'));
        console.error(`[CopilotRoute] Relevant env vars found: ${relevantVars.join(', ') || 'NONE'}`);
        return res.status(500).json({ error: "AI Co-Pilot is not configured. Please add ANTHROPIC_API_KEY to your environment secrets." });
      }
      // Log key prefix for debugging (safe: only first 8 chars)
      console.log(`[CopilotRoute] API key present: ${apiKey.substring(0, 8)}... (${apiKey.length} chars)`);
      if (anthropicBaseURL) console.log(`[CopilotRoute] Custom base URL: ${anthropicBaseURL}`);
      console.log(`[CopilotRoute] Starting SSE stream for video ${videoId}, trigger="${trigger}", user="${userId}", clipId=${clipId || "none"}`);
      console.log(`[CopilotRoute] Context: transcript=${transcript.length} segs, surfaces=${surfaces.length}, brands=${brandCatalog.length}, clips=${existingClips.length}`);

      // Set up SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Stream the response
      const generator = streamCopilot({
        sessionContext,
        trigger,
        userMessage: userMessage || undefined,
      });

      for await (const chunk of generator) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err: any) {
      const errorDetail = err.message || "Unknown error";
      const errorType = err.constructor?.name || "Error";
      const httpStatus = err.status || err.statusCode || null;
      console.error(`[CopilotRoute] SSE Error (${errorType}):`, errorDetail);
      if (httpStatus) console.error(`[CopilotRoute] HTTP Status: ${httpStatus}`);
      if (err.error) console.error(`[CopilotRoute] API Error body:`, JSON.stringify(err.error));
      if (err.stack) console.error("[CopilotRoute] Stack:", err.stack);

      // Check for specific Anthropic API errors — match both HTTP status codes and error text
      let userMessage = `Something went wrong (${errorType}). Please try again.`;
      if (httpStatus === 401 || errorDetail.includes("401") || errorDetail.includes("authentication") || errorDetail.includes("invalid x-api-key") || errorDetail.includes("api_key")) {
        userMessage = "AI service authentication failed. The Anthropic API key may be invalid or expired. Check ANTHROPIC_API_KEY in your environment secrets.";
      } else if (httpStatus === 429 || errorDetail.includes("429") || errorDetail.includes("rate")) {
        userMessage = "AI service rate limited. Please wait a moment and try again.";
      } else if (errorDetail.includes("timeout") || errorDetail.includes("ECONNREFUSED") || errorDetail.includes("ENOTFOUND") || errorDetail.includes("fetch failed")) {
        userMessage = "AI service is temporarily unreachable. Please try again in a moment.";
      } else if (httpStatus === 500 || httpStatus === 503 || errorDetail.includes("overloaded")) {
        userMessage = "AI service is temporarily unavailable. Please try again in a moment.";
      } else if (errorDetail.includes("model")) {
        userMessage = "AI model is unavailable. Please try again later.";
      } else if (errorDetail.includes("ANTHROPIC_API_KEY") || errorDetail.includes("api key")) {
        userMessage = "AI Co-Pilot is not configured. Please add ANTHROPIC_API_KEY to your environment secrets.";
      }

      // If headers already sent, end the stream with error
      if (res.headersSent) {
        try {
          res.write(`data: ${JSON.stringify({ type: "done", data: JSON.stringify({ message: userMessage, suggestions: [], followUpQuestions: ["Can you retry?"] }) })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } catch (writeErr) {
          console.error("[CopilotRoute] Failed to write SSE error:", writeErr);
          try { res.end(); } catch {}
        }
      } else {
        res.status(500).json({ error: userMessage });
      }
    }
  });

  // POST /api/remix/:videoId/copilot/suggestions — Get suggestions (non-streaming)
  app.post("/api/remix/:videoId/copilot/suggestions", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const { trigger, userMessage, clipId } = req.body;

      if (!trigger || !["post_generation", "post_trim", "low_score", "user_question"].includes(trigger)) {
        return res.status(400).json({ error: "Invalid trigger" });
      }

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      const { askCopilot } = await import("./lib/ai/remixCopilot");

      // Load context (same as SSE route but more concise)
      const videoTranscript = await storage.getVideoTranscript(videoId);
      const transcript = videoTranscript?.segments
        ? (videoTranscript.segments as any[])
        : [];

      const allSurfaces = await storage.getDetectedSurfaces(videoId);
      const surfaces = allSurfaces.map((s: any) => ({
        id: s.id,
        timestamp: s.timestamp || 0,
        surfaceType: s.surfaceType || "unknown",
        confidence: s.confidence || 0.5,
      }));

      const userId = String(req.authUserId || req.user?.id || 1);
      const allBrands = await storage.getBrandProducts(userId);
      const brandCatalog = allBrands.map((b: any) => ({
        id: b.id,
        name: b.name,
        category: b.category || null,
      }));

      let currentClip: any = undefined;
      if (clipId) {
        const clip = await storage.getClipById(parseInt(clipId));
        if (clip) {
          currentClip = {
            clipId: clip.id,
            start: clip.clipStart || 0,
            end: clip.clipEnd || 0,
            duration: clip.duration || 0,
            platform: clip.platformTarget || "tiktok",
            qualityScore: clip.qualityScore || 0,
            scores: (clip as any).qualityBreakdown || undefined,
            placements: [],
            captions: undefined,
            exportPath: clip.exportPath || undefined,
          };
        }
      }

      const sessionContext = {
        videoId,
        videoTitle: video.title || `Video ${videoId}`,
        videoDuration: parseFloat(video.duration as string) || 0,
        transcript,
        currentClip,
        surfaces,
        brandCatalog,
        existingClips: [],
        editorialAnalysis: undefined,
        editHistory: [],
      };

      const response = await askCopilot({
        sessionContext,
        trigger,
        userMessage: userMessage || undefined,
      });

      res.json(response);
    } catch (err: any) {
      console.error("[CopilotRoute] Error:", err.message);
      res.status(500).json({ error: err.message || "Co-pilot request failed" });
    }
  });

  // ─── Remix Templates ──────────────────────────────────────────

  // GET /api/remix/templates — List user's remix templates
  app.get("/api/remix/templates", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.id || 1;
      const templates = await storage.getRemixTemplates(userId);
      res.json(templates);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch templates" });
    }
  });

  // POST /api/remix/templates — Create a new remix template
  app.post("/api/remix/templates", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.id || 1;
      const { name, description, formatRules, transitionStyle, captionStyle } = req.body;
      if (!name) return res.status(400).json({ error: "name is required" });

      const template = await storage.createRemixTemplate({
        userId,
        name,
        description: description || null,
        formatRules: formatRules || null,
        transitionStyle: transitionStyle || null,
        captionStyle: captionStyle || null,
      });
      res.json(template);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to create template" });
    }
  });

  // PUT /api/remix/templates/:id — Update a template
  app.put("/api/remix/templates/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      const updated = await storage.updateRemixTemplate(id, req.body);
      if (!updated) return res.status(404).json({ error: "Template not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Update failed" });
    }
  });

  // DELETE /api/remix/templates/:id — Delete a template
  app.delete("/api/remix/templates/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.deleteRemixTemplate(id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Delete failed" });
    }
  });

  // ─── Distribution & Publishing ──────────────────────────────────

  // Distribution Profiles (connected social accounts)

  // GET /api/distribution/profiles — List user's connected platforms
  app.get("/api/distribution/profiles", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.id || 1;
      const profiles = await storage.getDistributionProfiles(userId);
      // Strip sensitive tokens from response
      const safe = profiles.map(p => ({
        ...p,
        accessToken: p.accessToken ? "••••••" : null,
        refreshToken: undefined,
      }));
      res.json(safe);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch profiles" });
    }
  });

  // POST /api/distribution/profiles — Connect a platform
  app.post("/api/distribution/profiles", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.id || 1;
      const { platform, accountName, accountId, accessToken, refreshToken, tokenExpiresAt, metadata } = req.body;

      if (!platform) return res.status(400).json({ error: "platform is required" });

      const profile = await storage.createDistributionProfile({
        userId,
        platform,
        accountName: accountName || null,
        accountId: accountId || null,
        accessToken: accessToken || null,
        refreshToken: refreshToken || null,
        tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt) : null,
        isActive: true,
        metadata: metadata || null,
      });

      res.json({ ...profile, accessToken: "••••••", refreshToken: undefined });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to connect platform" });
    }
  });

  // PUT /api/distribution/profiles/:id — Update a profile
  app.put("/api/distribution/profiles/:id", isAuthenticated, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      const updated = await storage.updateDistributionProfile(id, req.body);
      if (!updated) return res.status(404).json({ error: "Profile not found" });
      res.json({ ...updated, accessToken: "••••••", refreshToken: undefined });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Update failed" });
    }
  });

  // DELETE /api/distribution/profiles/:id — Disconnect a platform
  app.delete("/api/distribution/profiles/:id", isAuthenticated, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.deleteDistributionProfile(id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Delete failed" });
    }
  });

  // Publishing

  // POST /api/distribution/publish — Publish a clip to a platform
  app.post("/api/distribution/publish", isAuthenticated, async (req: any, res) => {
    try {
      const { clipId, profileId, caption, hashtags } = req.body;
      if (!clipId || !profileId) {
        return res.status(400).json({ error: "clipId and profileId are required" });
      }

      const profile = await storage.getDistributionProfile(profileId);
      if (!profile || !profile.accessToken) {
        return res.status(404).json({ error: "Distribution profile not found or no access token" });
      }

      // Find clip
      const clip = await findClipById(clipId);
      if (!clip || !clip.exportPath) {
        return res.status(404).json({ error: "Clip not found or not exported" });
      }

      const clipPath = path.join(process.cwd(), "public", clip.exportPath.replace(/^\//, ""));
      if (!fs.existsSync(clipPath)) {
        return res.status(404).json({ error: "Clip file not found on disk" });
      }

      // Format caption if not provided
      let finalCaption = caption || "";
      let finalHashtags = hashtags || [];

      if (!finalCaption) {
        const { formatCaption } = await import("./lib/distribution/captionFormatter");
        const analyses = await storage.getSceneAnalysisByVideo(clip.videoId);
        const analysis = analyses[0];

        const formatted = await formatCaption({
          platform: profile.platform,
          brandNames: [],
          narrativeContext: analysis?.narrativeContext || "",
          emotionalTone: analysis?.emotionalTone || "neutral",
          culturalTags: (analysis?.culturalTags as string[]) || [],
        });

        finalCaption = formatted.captionText;
        finalHashtags = formatted.hashtags;
      }

      // Publish
      const { publishToPlaftorm } = await import("./lib/distribution/platformPublisher");
      const result = await publishToPlaftorm(profile.platform, {
        clipPath,
        caption: finalCaption,
        hashtags: finalHashtags,
        accessToken: profile.accessToken,
        accountId: profile.accountId || "",
        metadata: profile.metadata as Record<string, any> || {},
      });

      if (result.success) {
        const post = await storage.createPublishedPost({
          clipId,
          videoId: clip.videoId,
          profileId,
          platform: profile.platform,
          platformPostId: result.platformPostId,
          postUrl: result.postUrl,
          caption: finalCaption,
          hashtags: finalHashtags,
          publishedAt: new Date(),
          status: "published",
        });
        res.json({ success: true, post, postUrl: result.postUrl });
      } else {
        const post = await storage.createPublishedPost({
          clipId,
          videoId: clip.videoId,
          profileId,
          platform: profile.platform,
          caption: finalCaption,
          hashtags: finalHashtags,
          status: "failed",
          errorMessage: result.error,
        });
        res.status(500).json({ success: false, error: result.error, post });
      }
    } catch (err: any) {
      console.error("[Publish] Error:", err.message);
      res.status(500).json({ error: err.message || "Publishing failed" });
    }
  });

  // Scheduling

  // POST /api/distribution/schedule — Schedule a clip for future publishing
  app.post("/api/distribution/schedule", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.id || 1;
      const { clipId, profileId, platform, scheduledFor, caption, hashtags } = req.body;

      if (!clipId || !profileId || !scheduledFor) {
        return res.status(400).json({ error: "clipId, profileId, and scheduledFor are required" });
      }

      const { schedulePost } = await import("./lib/distribution/scheduler");
      const schedule = await schedulePost({
        userId,
        clipId,
        profileId,
        platform: platform || "tiktok",
        scheduledFor: new Date(scheduledFor),
        caption,
        hashtags,
      });

      res.json(schedule);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Scheduling failed" });
    }
  });

  // POST /api/distribution/schedule/batch — Schedule across multiple platforms
  app.post("/api/distribution/schedule/batch", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.id || 1;
      const { clipId, platformProfiles, baseTime, staggerMinutes, caption, hashtags } = req.body;

      if (!clipId || !platformProfiles || !baseTime) {
        return res.status(400).json({ error: "clipId, platformProfiles, and baseTime are required" });
      }

      const { batchSchedule } = await import("./lib/distribution/scheduler");
      const schedules = await batchSchedule({
        userId,
        clipId,
        platformProfiles,
        baseTime: new Date(baseTime),
        staggerMinutes,
        caption,
        hashtags,
      });

      res.json(schedules);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Batch scheduling failed" });
    }
  });

  // GET /api/distribution/schedules — List user's scheduled posts
  app.get("/api/distribution/schedules", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.id || 1;
      const schedules = await storage.getSchedulesByUser(userId);
      res.json(schedules);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch schedules" });
    }
  });

  // DELETE /api/distribution/schedules/:id — Cancel a scheduled post
  app.delete("/api/distribution/schedules/:id", isAuthenticated, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.cancelSchedule(id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Cancel failed" });
    }
  });

  // Caption Formatting

  // POST /api/distribution/format-caption — Generate platform-specific caption
  app.post("/api/distribution/format-caption", isAuthenticated, async (req: any, res) => {
    try {
      const { platform, clipId, brandNames, customCaption } = req.body;
      if (!platform) return res.status(400).json({ error: "platform is required" });

      let narrativeContext = "";
      let emotionalTone = "neutral";
      let culturalTags: string[] = [];

      if (clipId) {
        const clip = await findClipById(clipId);
        if (clip) {
          const analyses = await storage.getSceneAnalysisByVideo(clip.videoId);
          const analysis = analyses[0];
          if (analysis) {
            narrativeContext = analysis.narrativeContext || "";
            emotionalTone = analysis.emotionalTone || "neutral";
            culturalTags = (analysis.culturalTags as string[]) || [];
          }
        }
      }

      const { formatCaption } = await import("./lib/distribution/captionFormatter");
      const result = await formatCaption({
        platform,
        brandNames: brandNames || [],
        narrativeContext,
        emotionalTone,
        culturalTags,
        customCaption,
      });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Caption formatting failed" });
    }
  });

  // Analytics

  // GET /api/analytics/overview — Creator analytics dashboard overview
  app.get("/api/analytics/overview", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authUserId;
      const authEmail = req.authEmail;

      // Get all videos for this user
      const videos = await storage.getVideoIndex(userId, authEmail);

      // Get YouTube connection for channel-level stats
      let ytConnection = await storage.getYoutubeConnection(userId);
      if (!ytConnection && authEmail && authEmail !== userId) {
        ytConnection = await storage.getYoutubeConnection(authEmail);
      }

      // Get social platform auth for follower counts
      let platformStats: Record<string, any> = {};
      if (ytConnection) {
        platformStats.youtube = {
          subscribers: ytConnection.subscriberCount || 0,
          totalViews: ytConnection.totalViewCount || 0,
          channelTitle: ytConnection.channelTitle || null,
          connected: true,
        };
      } else {
        platformStats.youtube = { connected: false };
      }

      // Pull FB/IG follower counts from the users table (populated on FB OAuth).
      // Token decryption + live API fetch happens via the /refresh endpoint to
      // keep this endpoint fast (no external calls on dashboard load).
      const userRow = userId
        ? await db.query.users.findFirst({ where: eq(usersTable.id, userId) }).catch(() => null)
        : null;

      if (userRow?.facebookId) {
        platformStats.facebook = {
          connected: true,
          pageId: userRow.facebookPageId ?? null,
          pageName: userRow.facebookPageName ?? null,
          fans: userRow.facebookFollowers ?? 0,
        };
      } else {
        platformStats.facebook = { connected: false };
      }

      if (userRow?.instagramBusinessId) {
        platformStats.instagram = {
          connected: true,
          igBusinessId: userRow.instagramBusinessId,
          handle: userRow.instagramHandle ?? null,
          followers: userRow.instagramFollowers ?? 0,
        };
      } else {
        platformStats.instagram = { connected: false };
      }

      // Per-video metrics (top 20 by view count)
      const videoMetrics = videos
        .sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0))
        .slice(0, 20)
        .map(v => ({
          videoId: v.id,
          title: v.title,
          thumbnailUrl: v.thumbnailUrl,
          platform: v.platform,
          viewCount: v.viewCount || 0,
          status: v.status,
          editorialClipCount: v.editorialClipCount || 0,
          editorialStatus: v.editorialStatus,
          publishedAt: v.publishedAt,
        }));

      // Aggregate stats across all videos
      const totalViews = videos.reduce((sum, v) => sum + (v.viewCount || 0), 0);
      const totalVideos = videos.length;
      const youtubeVideos = videos.filter(v => v.platform === "youtube").length;
      const uploadedVideos = videos.filter(v => v.platform === "fullscale").length;

      // Editorial clip summary
      const videosWithEditorial = videos.filter(v => v.editorialClipCount && v.editorialClipCount > 0).length;
      const totalEditorialClips = videos.reduce((sum, v) => sum + (v.editorialClipCount || 0), 0);

      res.json({
        platformStats,
        videoMetrics,
        summary: {
          totalVideos,
          totalViews,
          youtubeVideos,
          uploadedVideos,
          videosWithEditorial,
          totalEditorialClips,
          youtubeSubscribers: ytConnection?.subscriberCount || 0,
          youtubeTotalViews: ytConnection?.totalViewCount || 0,
        },
      });
    } catch (err: any) {
      console.error("[API] /api/analytics/overview error:", err.message);
      res.status(500).json({ error: err.message || "Failed to load analytics" });
    }
  });

  // POST /api/analytics/refresh — Pull live metrics from connected platforms.
  // Hits Instagram Graph API + Facebook Graph API + YouTube Data API to refresh
  // follower counts and per-video engagement. Updates the users + youtubeConnections
  // + videoIndex rows so the next /api/analytics/overview call sees fresh numbers.
  //
  // Required scopes (already in OAuth flow):
  //   - YouTube: youtube.readonly
  //   - Facebook: pages_read_engagement
  //   - Instagram: instagram_basic + instagram_manage_insights (Meta App Review)
  app.post("/api/analytics/refresh", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authUserId;
      const userRow = await db.query.users.findFirst({ where: eq(usersTable.id, userId) });
      if (!userRow) return res.status(404).json({ error: "User not found" });

      const refreshed: { instagram?: any; facebook?: any; youtube?: any } = {};
      const errors: string[] = [];

      // ── Instagram refresh ──
      if (userRow.instagramBusinessId && userRow.facebookAccessToken) {
        const token = safeDecrypt(userRow.facebookAccessToken);
        if (token) {
          const igStats = await fetchInstagramAnalytics(userRow.instagramBusinessId, token, 10);
          if (igStats) {
            await db
              .update(usersTable)
              .set({
                instagramFollowers: igStats.followers,
                instagramHandle: igStats.username ?? userRow.instagramHandle,
              })
              .where(eq(usersTable.id, userId));
            refreshed.instagram = {
              followers: igStats.followers,
              following: igStats.following,
              mediaCount: igStats.mediaCount,
              recentMedia: igStats.recentMedia.slice(0, 10).map((m) => ({
                mediaId: m.mediaId,
                mediaType: m.mediaType,
                permalink: m.permalink,
                thumbnailUrl: m.thumbnailUrl,
                impressions: m.impressions,
                reach: m.reach,
                plays: m.plays,
                likes: m.likeCount,
                comments: m.commentsCount,
                saved: m.saved,
                shares: m.shares,
                totalInteractions: m.totalInteractions,
              })),
            };
          } else {
            errors.push("Instagram fetch failed (check instagram_manage_insights scope)");
          }
        } else {
          errors.push("Instagram token decryption failed");
        }
      }

      // ── Facebook refresh ──
      if (userRow.facebookPageId && userRow.facebookAccessToken) {
        const token = safeDecrypt(userRow.facebookAccessToken);
        if (token) {
          const fbStats = await fetchFacebookPageAnalytics(userRow.facebookPageId, token);
          if (fbStats) {
            await db
              .update(usersTable)
              .set({ facebookFollowers: fbStats.fanCount })
              .where(eq(usersTable.id, userId));
            refreshed.facebook = fbStats;
          } else {
            errors.push("Facebook page fetch failed");
          }
        } else {
          errors.push("Facebook token decryption failed");
        }
      }

      // ── YouTube refresh ──
      // Refresh recent video stats (likes, comments) for top 50 videos
      const ytConnection = await storage.getYoutubeConnection(userId).catch(() => null);
      if (ytConnection?.accessToken) {
        const token = safeDecrypt(ytConnection.accessToken) || ytConnection.accessToken;
        const userVideos = await storage.getVideoIndex(userId).catch(() => [] as any[]);
        const ytIds = userVideos
          .filter((v: any) => v.platform === "youtube" && v.youtubeId)
          .map((v: any) => v.youtubeId)
          .slice(0, 50);
        if (ytIds.length > 0) {
          const ytStats = await fetchYouTubeVideoStats(ytIds, token);
          // Update viewCount on indexed videos
          for (const stat of ytStats) {
            try {
              await db
                .update(videoIndexTable)
                .set({ viewCount: stat.viewCount, updatedAt: new Date() })
                .where(eq(videoIndexTable.youtubeId, stat.videoId));
            } catch { /* non-fatal */ }
          }
          refreshed.youtube = {
            videoCount: ytStats.length,
            totalRecentViews: ytStats.reduce((s, v) => s + v.viewCount, 0),
            totalRecentLikes: ytStats.reduce((s, v) => s + v.likeCount, 0),
            totalRecentComments: ytStats.reduce((s, v) => s + v.commentCount, 0),
            videos: ytStats.slice(0, 20),
          };
        }
      }

      res.json({
        refreshed,
        errors,
        message: errors.length > 0
          ? `Refreshed with ${errors.length} warnings — check logs for details.`
          : "Analytics refreshed.",
      });
    } catch (err: any) {
      console.error("[API] /api/analytics/refresh error:", err.message);
      res.status(500).json({ error: err.message || "Failed to refresh analytics" });
    }
  });

  // GET /api/distribution/analytics/video/:videoId — Get aggregate analytics for a video
  app.get("/api/distribution/analytics/video/:videoId", isAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const { computeAggregateMetrics } = await import("./lib/distribution/analyticsCollector");
      const metrics = await computeAggregateMetrics(videoId);
      res.json(metrics);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch analytics" });
    }
  });

  // POST /api/distribution/analytics/video/:videoId/refresh — Refresh analytics from platforms
  app.post("/api/distribution/analytics/video/:videoId/refresh", isAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const { collectVideoAnalytics, computeAggregateMetrics } = await import("./lib/distribution/analyticsCollector");

      await collectVideoAnalytics(videoId);
      const metrics = await computeAggregateMetrics(videoId);
      res.json(metrics);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Analytics refresh failed" });
    }
  });

  // GET /api/distribution/analytics/clip/:clipId — Get analytics for a specific clip
  app.get("/api/distribution/analytics/clip/:clipId", isAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      const analytics = await storage.getAnalyticsByClip(clipId);
      res.json(analytics);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch clip analytics" });
    }
  });

  // Published Posts

  // GET /api/distribution/posts/video/:videoId — List published posts for a video
  app.get("/api/distribution/posts/video/:videoId", isAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const posts = await storage.getPublishedPostsByVideo(videoId);
      res.json(posts);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch posts" });
    }
  });

  // POST /api/distribution/suggest-time — Get optimal posting time for a platform
  app.post("/api/distribution/suggest-time", isAuthenticated, async (req: any, res) => {
    try {
      const { platform, timezone } = req.body;
      if (!platform) return res.status(400).json({ error: "platform is required" });

      const { suggestPostingTime } = await import("./lib/distribution/scheduler");
      const suggestedTime = suggestPostingTime(platform, timezone);
      res.json({ platform, suggestedTime: suggestedTime.toISOString() });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to suggest time" });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Brand Brief — multi-step onboarding wizard for brand users
  // ═══════════════════════════════════════════════════════════════════

  // GET /api/brand-brief/me — returns the current user's brief (or null if
  // none exists yet). The wizard calls this on mount to resume a draft.
  app.get("/api/brand-brief/me", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authUserId;
      if (!userId || typeof userId !== "string") {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const brief = await storage.getBrandBriefByUserId(userId);
      res.json({ brief: brief || null });
    } catch (err: any) {
      console.error("[BrandBrief] GET /me failed:", err);
      res.status(500).json({ error: err.message || "Failed to load brief" });
    }
  });

  // PUT /api/brand-brief/me — upsert the current user's brief. Called by
  // the wizard on every field change (debounced). Status stays 'draft'
  // throughout — only POST /submit flips it to 'submitted'.
  app.put("/api/brand-brief/me", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authUserId;
      if (!userId || typeof userId !== "string") {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const data = req.body || {};
      // Whitelist of fields the client is allowed to set via this endpoint.
      // Anything else (id, status, timestamps) is ignored.
      const allowedFields = [
        "brandName", "website", "industry", "brandVoice", "logoUrl",
        "placementTypes", "productDescription", "referenceImageUrls", "flexibility",
        "targetGeographies", "audienceAgeMin", "audienceAgeMax", "audienceInterests", "languages",
        "primaryObjective", "successMeasurement", "budgetRange", "timeline",
        "contentCategories", "specificCreators", "thingsToAvoid", "handsOnLevel",
      ] as const;
      const safePayload: Record<string, any> = {};
      for (const key of allowedFields) {
        if (key in data) safePayload[key] = data[key];
      }
      const brief = await storage.upsertBrandBrief(userId, safePayload);
      res.json({ brief });
    } catch (err: any) {
      console.error("[BrandBrief] PUT /me failed:", err);
      res.status(500).json({ error: err.message || "Failed to save brief" });
    }
  });

  // POST /api/brand-brief/me/submit — mark the brief as submitted and
  // email the FullScale team (hello@gofullscale.co) the full summary.
  // Idempotent: submitting an already-submitted brief is a no-op (still
  // returns the brief, doesn't re-send the email).
  app.post("/api/brand-brief/me/submit", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authUserId;
      if (!userId || typeof userId !== "string") {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Ensure a brief exists first
      const existing = await storage.getBrandBriefByUserId(userId);
      if (!existing) {
        return res.status(400).json({
          error: "No brief found — save your answers before submitting.",
        });
      }
      if (existing.status === "submitted") {
        return res.json({ brief: existing, alreadySubmitted: true });
      }

      const submitted = await storage.submitBrandBrief(userId);
      if (!submitted) {
        return res.status(500).json({ error: "Failed to submit brief" });
      }

      // Fire-and-forget the team email. If it fails, the brief is still
      // marked submitted so the user gets a success UX — we just log and
      // the team can retrieve the brief from the DB if needed.
      try {
        const user = await storage.getUserByEmail?.(
          // Some storage impls have getUserById; use email-based lookup via a
          // cheap select. Fall back gracefully if no user helper is available.
          "",
        );
        // Prefer a direct user lookup by id
        const dbUser = await import("./db").then(({ db }) =>
          import("@shared/models/auth").then(async ({ users: usersTable }) => {
            const { eq } = await import("drizzle-orm");
            const [u] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
            return u;
          }),
        );
        const { sendBrandBriefNotification } = await import("./lib/resend");
        await sendBrandBriefNotification({
          brief: submitted,
          user: {
            email: dbUser?.email ?? null,
            firstName: dbUser?.firstName ?? null,
            lastName: dbUser?.lastName ?? null,
          },
        });
      } catch (emailErr: any) {
        console.error("[BrandBrief] Email notification failed (non-fatal):", emailErr);
      }

      res.json({ brief: submitted, alreadySubmitted: false });
    } catch (err: any) {
      console.error("[BrandBrief] POST /submit failed:", err);
      res.status(500).json({ error: err.message || "Failed to submit brief" });
    }
  });

  // Seed Data
  await seedDatabase();

  return httpServer;
}

// Helper to find a clip by ID across all jobs
async function findClipById(clipId: number) {
  // Get all videos, then search clips — not ideal but works without a dedicated storage method
  try {
    const { db } = await import("./db");
    const { generatedClips } = await import("../shared/schema");
    const { eq } = await import("drizzle-orm");
    const [clip] = await db.select().from(generatedClips).where(eq(generatedClips.id, clipId)).limit(1);
    return clip || null;
  } catch {
    return null;
  }
}

async function seedDatabase() {
  const existingItems = await storage.getMonetizationItems();
  if (existingItems.length === 0) {
    console.log("Seeding database...");
    await storage.createMonetizationItem({
      title: "Epic Vlog #1",
      status: "Monetized",
      thumbnailUrl: "https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3",
    });
    await storage.createMonetizationItem({
      title: "Coding Tutorial React",
      status: "Pending",
      thumbnailUrl: "https://images.unsplash.com/photo-1587620962725-abab7fe55159?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3",
    });
    await storage.createMonetizationItem({
      title: "Gaming Highlights",
      status: "Rejected",
      thumbnailUrl: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.0.3",
    });
    console.log("Database seeded!");
  }

  // Seed allowed users for founding cohort
  const allowedUsers = await storage.getAllowedUsers();
  if (allowedUsers.length === 0) {
    console.log("Seeding allowed users...");
    // Add founder emails here
    const founderEmails = [
      { email: "martin@gofullscale.co", name: "Martin (FullScale)" },
      { email: "martin@whtwrks.com", name: "Martin (WhtWrks)" },
      { email: "martincekechukwu@gmail.com", name: "Martin (Personal)" },
    ];
    for (const user of founderEmails) {
      try {
        await storage.addAllowedUser(user);
        console.log(`Added allowed user: ${user.email}`);
      } catch (err) {
        // Ignore duplicate errors
      }
    }
    console.log("Allowed users seeded!");
  }

  // Seed creator slugs and featured status for existing creators
  try {
    const creatorSlugs: Record<string, string> = {
      "martin@gofullscale.co": "martin",
      "thekimkwilson@gmail.com": "kim",
      "tamara@whtwrks.com": "tamara",
    };
    for (const [email, slug] of Object.entries(creatorSlugs)) {
      const user = await storage.getAllowedUser(email);
      if (user) {
        // Always ensure slug is set
        if (!user.slug) {
          await storage.updateCreatorProfile(email, { slug });
          console.log(`[Seed] Set slug="${slug}" for ${email}`);
        }
        // Always ensure isFeatured is true
        if (!user.isFeatured) {
          await db.update(allowedUsersTable).set({ isFeatured: true }).where(eq(allowedUsersTable.email, email));
          console.log(`[Seed] Set isFeatured=true for ${email}`);
        }
      }
    }
  } catch (err) {
    console.error("[Seed] Error seeding creator slugs:", err);
  }

  // Seed local video files into library if not already present
  // Test2.mov = Podcast Sample, test_video2.mov = Bar Table Test (separate files)
  try {
    const allVideos = await storage.getAllVideos();

    // Seed Test2.mov - Podcast Sample
    const hasTest2 = allVideos.some(v => v.youtubeId === "test-podcast-sample");
    if (!hasTest2) {
      const fileExists = fs.existsSync("./public/videos/Test2.mov");
      const video = await storage.insertVideo({
        userId: "martin@gofullscale.co",
        youtubeId: "test-podcast-sample",
        title: "Test2 - Podcast Sample",
        description: "Podcast video sample for product placement testing | File: /videos/Test2.mov",
        platform: "fullscale",
        filePath: "./public/videos/Test2.mov",
        status: fileExists ? "Pending Scan" : "Pending Upload",
        priorityScore: 100,
        viewCount: 0,
        category: "Podcast",
        isEvergreen: true,
        duration: "0:00",
      });
      console.log(`[Seed] Added Test2 podcast sample to library (ID: ${video.id}, fileExists: ${fileExists})`);
    }

    // Seed test_video2.mov - Bar Table Test
    const hasBarTable = allVideos.some(v => v.youtubeId === "test-video-2");
    if (!hasBarTable) {
      const fileExists = fs.existsSync("./public/videos/test_video2.mov");
      const video = await storage.insertVideo({
        userId: "martin@gofullscale.co",
        youtubeId: "test-video-2",
        title: "Bar Table Test",
        description: "Bar table test video for surface detection | File: /videos/test_video2.mov",
        platform: "fullscale",
        filePath: "./public/videos/test_video2.mov",
        status: fileExists ? "Pending Scan" : "Pending Upload",
        priorityScore: 90,
        viewCount: 0,
        category: "Test",
        isEvergreen: true,
        duration: "0:00",
      });
      console.log(`[Seed] Added Bar Table Test to library (ID: ${video.id}, fileExists: ${fileExists})`);
    }
  } catch (err) {
    console.error("[Seed] Error seeding local videos:", err);
  }
}
