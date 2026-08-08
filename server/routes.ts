import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import { runIndexerForUser } from "./lib/indexer";
import { processVideoScan, scanPendingVideos, addToLocalAssetMap, getYouTubeThumbnailWithFallback, canonicalSurfaceType } from "./scanner_v2";
import { parsePlatformUrl, storedIdFor, platformMaxDurationSec } from "./lib/platformSources";
import { ADMIN_EMAILS } from "./lib/adminEmails";
import { recordCreatorEvent } from "./lib/creatorEvents";
import { probeVideoMeta } from "./lib/streamResolver";
import { hammingDistance } from "./lib/scenes/sceneIndex";
// DISABLED: TensorFlow scanner replaced by scanner_v2.ts which uses Sharp
import { extractThumbnailForVideo, extractAndUpdateThumbnails } from "./lib/thumbnailExtractor";
import {
  calculatePlacementPricing,
  formatCents,
  formatImpressions,
  avgRecentViews,
  computeExpiresAt,
  isSellableSurface,
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
import { addSignupToAirtable, listAirtableSignups, addBrandApplicationToAirtable } from "./lib/airtable";
import { setupPlatformAuth, importFacebookVideos, importInstagramMedia, importPersonalVideos, fetchInstagramVideoViews } from "./lib/platformAuth";
import { maybeRefreshSocialThumbnailsInBackground } from "./lib/socialThumbnailAutoRefresh";
import { pLimit } from "./lib/concurrency";
import { getSourcePath } from "./lib/sourceCache";
import { readFileFromStorage } from "./lib/objectStorage";
import { harmonizeProductIntoScene } from "./lib/ai/harmonization";
import { getYtDlpPath } from "./lib/ytDlpUpdater";
import multer from "multer";
import path from "path";
import fs from "fs";
import ytdl from "@distube/ytdl-core";
import { decrypt, encrypt } from "./encryption";
import { db } from "./db";
import { users, users as usersTable, allowedUsers as allowedUsersTable, videoIndex as videoIndexTable, editorialClips, detectedSurfaces,
  fixtureExposure as fixtureExposureTable, fixtureAssignments as fixtureAssignmentsTable, placementExposures as placementExposuresTable,
  brandPlacementAssignments as brandPlacementAssignmentsTable } from "@shared/schema";
import { eq, sql, inArray } from "drizzle-orm";
import crypto from "crypto";
import sharp from "sharp";
import { uploadFileToStorage, uploadStreamToStorage, fileExistsInStorage, objectKeyFromServeUrl, storageServeUrl, getStorageStream, downloadToTempFile } from "./lib/objectStorage";
import { runTranscriptPipeline } from "./lib/remix/transcriptPipeline";
import { runEditorialAutoPipeline, renderSingleEditorialClip } from "./lib/remix/editorialAutoPipeline";
import type { CaptionSegment } from "./lib/remix/clipGenerator";
import { analyzeEditorial } from "./lib/ai/claude-dense/editorialAnalyzer";
import { categorizeVideos } from "./lib/ai/categorize";
import {
  fetchInstagramAudience,
  fetchYoutubeAudience,
  fetchFacebookPageAudience,
} from "./lib/audienceFetcher";
import { authLimiter, scanLimiter, uploadLimiter, rateLimit } from "./middleware/rateLimit";
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

// -----------------------------------------------------------------------
// LIBRARY_VIEW_GRANTS
// -----------------------------------------------------------------------
// Narrow per-user "I'm sharing my library view with these specific people"
// access list. Keyed by the GRANTER's email (whose library is being shared)
// and valued by the list of VIEWERS (callers allowed to pass that granter
// as ?as=<email> on /api/video-index/with-opportunities).
//
// This is intentionally separate from ADMIN_EMAILS — granted viewers get
// READ access to the granter's library only. No admin endpoints, no brand
// view, no role switcher, no approval powers. Pure library-view scope.
//
// To grant view access to a new person: add their email to the array for
// the appropriate granter. To revoke: remove it. They also need to be on
// allowed_users to sign in at all (use /api/admin/onboard-cobuilder).
// -----------------------------------------------------------------------
// Empty by default — Scott + Juan are full admins per Martin's direction,
// so they don't need narrow grants (admins can view-as anyone via
// /api/me/view-as-options "admin-all" mode + /api/admin/users-with-libraries).
// Re-populate this map if you ever want to grant someone library-view-only
// access without admin powers (the gate logic in
// /api/video-index/with-opportunities still honors it).
const LIBRARY_VIEW_GRANTS: Record<string, string[]> = {};

// -----------------------------------------------------------------------
// SHOWCASE_LIBRARIES
// -----------------------------------------------------------------------
// Allowlist of library-owner emails to surface in the "Other Libraries"
// sidebar dropdown for ADMINS. Without this filter the dropdown would
// list every user with any content — including alt accounts, test users,
// and waitlisted creators with thin libraries — none of which are
// compelling for a co-builder testing remix/distribution.
//
// Only emails in this list appear in the dropdown for admins. The admin
// can still view-as any user via direct URL (/library?as=<email>) — this
// is purely a UI curation, not an authorization restriction.
//
// To feature another creator: add their email here.
// Empty array → fall back to "all users with content" (legacy behavior).
// -----------------------------------------------------------------------
const SHOWCASE_LIBRARIES: string[] = [
  "martin@gofullscale.co",
];

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
  // Co-builders — admin access, both creator + brand views via role switching
  'ben@muselabs.ai',
  'remiguyton@gmail.com',
  'scottmmills@outlook.com',
  'juanroviraesteve@gmail.com',
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

/**
 * A1 publish target: every brand-approved placement gets a public release
 * page at /s/<slug> playing the baked render with creator/brand credits and
 * a download. Idempotent — one active link per placement, minted at
 * brand-approval and lazily by the release-link endpoint (which also covers
 * placements approved before this shipped).
 */
/** Thrown when a release link exists but was deliberately deactivated. */
export class ReleaseLinkDeactivatedError extends Error {
  constructor() { super("The release link for this placement was deactivated"); }
}

async function ensurePlacementReleaseLink(placement: {
  id: number; videoId: number; creatorUserId: string; brandProductId: number | null;
}): Promise<{ slug: string; url: string }> {
  const existing = await storage.getSharedLinkByBrandPlacement(placement.id);
  if (existing?.isActive) return { slug: existing.slug, url: `/s/${existing.slug}` };
  if (existing) throw new ReleaseLinkDeactivatedError(); // deliberate takedown — don't resurrect
  let title: string | null = null;
  let createdBy = String(placement.creatorUserId);
  try {
    const [video, product] = await Promise.all([
      storage.getVideoById(placement.videoId),
      placement.brandProductId != null ? storage.getBrandProduct(placement.brandProductId) : Promise.resolve(undefined),
    ]);
    title = product?.name && video?.title ? `${product.name} × ${video.title}` : (video?.title ?? null);
    // createdBy is an email column everywhere else (getSharedLinksByUser
    // matches on it) — resolve the creator's email rather than storing a uuid.
    let cu = await storage.getUserById(createdBy);
    if (!cu && createdBy.includes("@")) cu = await storage.getUserByEmail(createdBy);
    if (cu?.email) createdBy = cu.email;
  } catch { /* cosmetic fields */ }
  try {
    const link = await storage.createSharedLink({
      slug: generateSlug(),
      placementId: null,
      exportId: null,
      brandPlacementId: placement.id,
      videoId: placement.videoId,
      createdBy,
      title,
      isActive: true,
      expiresAt: null,
    });
    return { slug: link.slug, url: `/s/${link.slug}` };
  } catch (insertErr) {
    // idx_shared_links_brand_placement: a concurrent mint won the race —
    // serve the winner's link instead of failing.
    const winner = await storage.getSharedLinkByBrandPlacement(placement.id);
    if (winner?.isActive) return { slug: winner.slug, url: `/s/${winner.slug}` };
    throw insertErr;
  }
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
  // Publishing (distribution scheduler). Tokens granted before this scope
  // was added can read but not upload — the creator must reconnect YouTube
  // once to re-consent before scheduled publishing works for them.
  "https://www.googleapis.com/auth/youtube.upload",
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

// videoIndex.userId and brandPlacementAssignments.creatorUserId are mixed-key
// columns: newer rows store users.id, legacy rows store the creator's email.
// Resolve either form to the canonical user so per-creator lookups (video
// library, YouTube connection) and ownership checks see the whole identity.
async function resolveCreatorIdentity(
  rawUserId: string,
): Promise<{ userId: string; email?: string }> {
  const byId = await storage.getUserById(rawUserId).catch(() => undefined);
  if (byId) return { userId: byId.id, email: byId.email ?? undefined };
  if (rawUserId.includes("@")) {
    const byEmail = await storage.getUserByEmail(rawUserId).catch(() => undefined);
    if (byEmail) return { userId: byEmail.id, email: byEmail.email ?? undefined };
    return { userId: rawUserId, email: rawUserId };
  }
  return { userId: rawUserId };
}

// Ownership check for rows whose creatorUserId may be a users.id or a legacy
// email. True when the stored key and the authenticated user are the same
// creator. Deliberately never consults the session-asserted email
// (req.authEmail) — registration doesn't verify email ownership, so only the
// server-recorded users row of the authenticated id is trusted.
async function isSameCreator(
  storedUserId: string,
  authUserId: string,
): Promise<boolean> {
  if (storedUserId === authUserId) return true;
  const identity = await resolveCreatorIdentity(storedUserId);
  if (identity.userId === authUserId) return true;
  // Stored key is an email with no users row — compare against the
  // authenticated user's recorded email.
  const authUser = await storage.getUserById(authUserId).catch(() => undefined);
  return !!(authUser?.email && storedUserId.toLowerCase() === authUser.email.toLowerCase());
}

// remixJobs.userId is a legacy `integer` column, but users.id is a varchar UUID.
// parseInt(uuid) is NaN → collapsed every user to 1 (cross-user job visibility).
// Until the column is migrated to varchar (Tier 3), derive a STABLE positive
// integer from the user id so jobs stay attributable and don't all share id 1.
// Legacy numeric ids pass through unchanged so existing rows still match.
import { stableUserIntId } from "./lib/stableUserId";

/**
 * Turn a Postgres error into something an operator can act on.
 *
 * Drizzle emits an explicit column list on every select, so a schema change
 * that hasn't been pushed to the deployed database makes the query fail with
 * `column "x" does not exist` — and every caller that swallowed it into a
 * generic 500 turned that into a spinner with no explanation. This names the
 * cause and the fix. Admin-only surfaces; the raw message never reaches a
 * creator or brand.
 */
function explainDbError(err: any, fallback: string): { status: number; error: string } {
  const msg = String(err?.message ?? err ?? "");
  if (/column .* does not exist|relation .* does not exist/i.test(msg)) {
    return {
      status: 503,
      error: `Database schema is behind the deployed code — ${msg.split("\n")[0]}. Run \`npm run db:push\` against this environment, then reload.`,
    };
  }
  return { status: 500, error: fallback };
}

/**
 * Clip-scan tracker. A clip "scan" is either a full source scan (video was
 * never scanned) or a densify pass over the clip's range (video scanned,
 * clip coverage sparse). Both run minutes; the UI polls the clip-surfaces
 * endpoint, which reports this state. In-memory on purpose: a restart kills
 * the child processes anyway, so persisted state would just go stale.
 */
const clipScansInFlight = new Map<number, { mode: "full_scan" | "densify"; startedAt: number }>();

/** video_index.duration is a display string ("12:34", "1:02:03") or a bare
 *  seconds value depending on the import path. Returns 0 when unparseable —
 *  callers treat 0 as "unknown", never as "zero-length". */
function durationStringToSeconds(raw: unknown): number {
  if (raw == null) return 0;
  const str = String(raw).trim();
  if (!str) return 0;
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.split(":").map((p) => parseFloat(p));
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // On boot, fail any remix job left mid-flight by a previous process (Replit
  // redeploys often). Without this the row sits in a step_N status forever and
  // the client treats it as active, permanently disabling Auto-Remix for that
  // video. Runs once per server start; safe if there are no stale rows.
  storage
    .failInterruptedRemixJobs()
    .then((n) => { if (n > 0) console.log(`[Startup] Marked ${n} interrupted remix job(s) as failed`); })
    .catch((err) => console.error("[Startup] failInterruptedRemixJobs error:", err?.message || err));
  // Deferred past the Replit reusePort deploy-overlap window so an old
  // process actively stitching doesn't get its plan falsely failed (its own
  // terminal write lands first; the sweep then only catches true orphans).
  setTimeout(() => {
    storage
      .failInterruptedStitchPlans()
      .then((n) => { if (n > 0) console.log(`[Startup] Marked ${n} interrupted stitch plan(s) as failed`); })
      .catch((err) => console.error("[Startup] failInterruptedStitchPlans error:", err?.message || err));
  }, 5 * 60 * 1000);
  // Dual-ID root migration: converge email-keyed rows onto users.id.
  // Idempotent; alias lookups stay as the safety net for unconverged rows.
  storage
    .normalizeLegacyIdentityKeys()
    .then((res) => {
      const total = Object.values(res).filter((n) => n > 0).reduce((a, b) => a + b, 0);
      if (total > 0) console.log(`[Startup] Identity migration normalized ${total} row(s)`);
    })
    .catch((err) => console.error("[Startup] normalizeLegacyIdentityKeys error:", err?.message || err));
  storage
    .cancelOrphanedLegacySchedules()
    .then((n) => { if (n > 0) console.log(`[Startup] Cancelled ${n} orphaned legacy schedule(s) (pre-identity-fix userId=1)`); })
    .catch((err) => console.error("[Startup] cancelOrphanedLegacySchedules error:", err?.message || err));
  // Release videos stuck in "Scanning" by a crashed/redeployed process.
  // Deferred like the stitch sweep so an old process actively scanning
  // through the deploy overlap isn't falsely failed. One catch: after a
  // crash + immediate Replit restart the orphan row is only ~5-15 min
  // stale when this fires (updated_at is set at scan start; scans cap
  // ~10 min), so the 30-min threshold skips it — hence the recurring
  // sweep below, which picks it up once it ages past the threshold
  // instead of leaving it "Scanning" until the next restart.
  //
  // Two different thresholds on purpose: at boot no in-process scan can
  // be live, so 30 min (past deploy overlap) safely frees fresh orphans.
  // The recurring sweep runs ALONGSIDE live scans, whose worst-case
  // wall-clock (resolver retries + probe + dense grid + download ladder
  // + ytdl-core fallback) can stretch to ~40-50 min between row writes,
  // so it uses a 2h threshold — far above any legitimate scan, and the
  // scanner's phase-boundary heartbeats keep updated_at fresh enough
  // that 2h of staleness genuinely means a dead process.
  setTimeout(() => {
    storage
      .failStuckScans(30)
      .catch((err) => console.error("[Startup] failStuckScans error:", err?.message || err));
  }, 5 * 60 * 1000);
  const stuckScanSweep = setInterval(() => {
    storage
      .failStuckScans(120)
      .catch((err) => console.error("[Sweep] failStuckScans error:", err?.message || err));
  }, 10 * 60 * 1000);
  stuckScanSweep.unref();
  
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

    // Distribution publishing token sources (TikTok, X, LinkedIn OAuth).
    // Non-fatal: each flow self-disables when its client creds are unset.
    try {
      const { registerDistributionOAuthRoutes } = await import("./lib/distribution/platformConnect");
      registerDistributionOAuthRoutes(app);
    } catch (connectErr) {
      console.error("[Routes] Distribution OAuth routes failed to register:", connectErr);
    }
  } catch (platformError) {
    console.error("[Routes] Platform Auth setup failed (non-fatal):", platformError);
  }

  const softAuth = async (req: any, _res: any, next: any) => {
    try {
      const googleUser = req.session?.googleUser;
      if (googleUser?.email) {
        req.authEmail = googleUser.email;
        req.authUserId = (await storage.getUserByEmail(googleUser.email))?.id || googleUser.email;
        return next();
      }
      if (req.isAuthenticated && req.isAuthenticated() && req.user?.claims) {
        const claims = req.user.claims;
        req.authEmail = claims.email;
        req.authUserId = claims.sub || (await storage.getUserByEmail(claims.email))?.id || claims.email;
        return next();
      }
      const sessionUserId = req.session?.userId;
      if (sessionUserId) {
        const user = await storage.getUserById(sessionUserId);
        if (user?.email) {
          req.authEmail = user.email;
          req.authUserId = user.id;
          return next();
        }
      }
    } catch (err) {
      // Auth failures here are not fatal — endpoint just runs as anonymous.
      console.warn("[softAuth] auth lookup failed (continuing anonymously):", (err as any)?.message);
    }
    next();
  };

  // Media access policy, shared by the frame and stream endpoints.
  //
  // These were fully open: any visitor could enumerate sequential video ids
  // and download the ENTIRE platform's library — including content from
  // creators who never opted into a public profile. And the frame endpoint
  // spawns ffmpeg on a cache miss, so anonymous traffic could burn CPU and
  // fill the disk at will.
  //
  // Policy now: any logged-in user may fetch (this is a closed marketplace —
  // brands browse creator content in-app); ANONYMOUS visitors may only fetch
  // videos whose owner opted into a public profile (is_featured). Denials are
  // 404, not 403, so an unauthenticated probe cannot confirm an id exists.
  const mediaLimiter = rateLimit({ windowMs: 60_000, max: 120, bucket: "public-media" });
  const canServeVideo = async (req: any, ownerUserId: string): Promise<boolean> => {
    if (req.authEmail || req.authUserId) return true;
    const featured = await storage.getFeaturedOwnerKeys();
    return featured.has(ownerUserId) || featured.has(String(ownerUserId).toLowerCase());
  };

  /**
   * Route guard for endpoints keyed on :videoId. Same policy as canServeVideo:
   * any logged-in user passes; anonymous callers only reach videos owned by a
   * creator who opted into a public profile.
   *
   * These four surface endpoints were fully open, so an anonymous visitor
   * could walk video ids and pull detected surfaces, scene groups, per-frame
   * bounding boxes and existing brand placements for the entire platform —
   * competitive inventory data for creators who never published anything.
   */
  const requireVideoAccess = async (req: any, res: any, next: any) => {
    const videoId = parseInt(req.params.videoId ?? req.params.id);
    if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });
    if (req.authEmail || req.authUserId) return next();
    try {
      const video = (await storage.getVideoSummaries([videoId])).get(videoId);
      if (video && (await canServeVideo(req, video.userId))) return next();
    } catch (err: any) {
      console.warn(`[requireVideoAccess] ${err?.message}`);
    }
    return res.status(404).json({ error: "Video not found" });
  };

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
      const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
      // Session/OIDC only. The ?admin_email= query fallback was an unauthenticated
      // admin bypass — any anonymous caller could pass a known admin email (all of
      // which are in source) and reset the test account's password. Removed.
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
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

  // Onboard a co-builder — adds to allowed_users + sends a welcome email.
  // Caller must be in the admin email list. The target email must already
  // be hardcoded in this file's admin arrays + FOUNDING_MEMBERS for the
  // role-switch / allowlist bypass to work; this endpoint just creates the
  // DB row and sends the notification.
  app.post("/api/admin/onboard-cobuilder", async (req: any, res) => {
    try {
      const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !adminEmails.map(e => e.toLowerCase()).includes(callerEmail.toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const {
        email,
        name,
        sendWelcomeEmail: sendEmail = true,
        dryRun = false,
        role = "co-builder",
        password,
        userType: requestedUserType = "creator",
      } = req.body || {};
      if (!email || !name) {
        return res.status(400).json({ error: "Body must include { email, name, sendWelcomeEmail?, dryRun?, role?, password?, userType? }" });
      }
      if (requestedUserType !== "creator" && requestedUserType !== "brand") {
        return res.status(400).json({ error: "userType must be 'creator' or 'brand'" });
      }
      // Valid roles control which welcome-email copy renders. The
      // allowlist row + admin grant are identical regardless of role —
      // role only changes the framing we send the user.
      //   "co-builder" — building the product alongside the team (Ben)
      //   "tester"     — using the platform to find bugs / give feedback (Remi)
      const validRoles = ["co-builder", "tester"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${validRoles.join(", ")}` });
      }
      // Optional password — when provided, we pre-create a User row with
      // the hashed password so the person can sign in via email+password
      // INSTEAD OF Google OAuth. Useful for collaborators who don't have
      // a usable Google account or just prefer not to OAuth in.
      if (password !== undefined && (typeof password !== "string" || password.length < 6)) {
        return res.status(400).json({ error: "password must be a string of 6+ characters" });
      }

      // 1. Allowlist row — if it doesn't exist, create as creator (admin can switch)
      const existing = await storage.getAllowedUser(email);
      let allowlistAction: "created" | "exists";
      if (existing) {
        allowlistAction = "exists";
      } else if (!dryRun) {
        await storage.addAllowedUser({
          email,
          name,
          userType: requestedUserType,
        });
        allowlistAction = "created";
      } else {
        allowlistAction = "created";
      }

      // 1b. Pre-create the User row with hashed password if requested.
      // Without this they'd still need to go through /api/auth/register to
      // set a password, which means another browser flow. Pre-creating
      // means the person can go straight to /auth and log in.
      const firstNameForUser = name.split(" ")[0];
      const lastNameForUser = name.split(" ").slice(1).join(" ") || "";
      let userAction: "created" | "exists" | "skipped" = "skipped";
      if (password && !dryRun) {
        const existingUser = await storage.getUserByEmail(email);
        if (existingUser) {
          userAction = "exists";
          console.warn(`[onboard-cobuilder] User row already exists for ${email}; password NOT updated (use a password-reset flow to change it).`);
        } else {
          const hashed = await hashPassword(password);
          await storage.createUser({
            email: email.toLowerCase().trim(),
            password: hashed,
            firstName: firstNameForUser,
            lastName: lastNameForUser,
            isApproved: true,
            authProvider: "email",
            userType: requestedUserType,
          } as any);
          userAction = "created";
          console.log(`[onboard-cobuilder] Created User row for ${email} with hashed password (auth via email+password).`);
        }
      }

      // 2. Welcome email body — copy branches on role so a tester
      // doesn't get told they're a co-builder (and vice versa).
      const loginUrl = "https://gofullscale.co/auth";
      const firstName = name.split(" ")[0];

      const subject =
        role === "tester"
          ? "You're in: FullScale tester access"
          : "You're in: FullScale co-builder access";

      const roleIntro =
        role === "tester"
          ? `You've been added as a tester. You have admin access — both <strong>creator</strong> and <strong>brand</strong> views are available; flip between them from the role switcher in the top nav. Use that god-mode visibility to find anything broken or confusing and report it back.`
          : `You've been added as a co-builder. You have admin access — both <strong>creator</strong> and <strong>brand</strong> views are available; flip between them from the role switcher in the top nav.`;

      const closing =
        role === "tester"
          ? `Whatever you find — broken UI, weird flows, confusing copy, slow pages — send it directly to me. Bug reports are the whole reason you're here.`
          : `Anything looks broken or weird, ping me directly. Welcome aboard.`;

      // Sign-in credentials block — boxed and obvious when password set,
      // plain Google-OAuth line otherwise.
      const credentialsBlock = password
        ? `
          <div style="margin: 20px 0; padding: 16px 20px; background: #f3f4f6; border-left: 4px solid #10b981; border-radius: 6px;">
            <div style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; margin-bottom: 8px;">Your sign-in credentials</div>
            <div style="line-height: 1.8;">
              <strong>Sign in URL:</strong> <a href="${loginUrl}" style="color: #059669; font-weight: 500;">${loginUrl}</a><br/>
              <strong>Email:</strong> ${email}<br/>
              <strong>Password:</strong> <code style="background: #fff; padding: 2px 6px; border-radius: 4px; border: 1px solid #d1d5db;">${password}</code>
            </div>
            <div style="margin-top: 10px; font-size: 13px; color: #6b7280;">
              <strong>Important:</strong> use the email+password login form on /auth, NOT the "Sign in with Google" button. Change your password from the account menu after first sign-in.
            </div>
          </div>
        `
        : `<p style="line-height: 1.55;">Sign in at <a href="${loginUrl}" style="color: #059669; font-weight: 500;">${loginUrl}</a> with your Google account (${email}).</p>`;

      // Step-by-step navigation guide — included in every welcome email so
      // recipients don't need a separate "how to use it" message. Tuned for
      // co-builders/testers with admin access (role switcher + view-as).
      const navigationGuide = `
        <h3 style="margin: 32px 0 12px 0; font-size: 16px; font-weight: 600;">Once you're signed in</h3>
        <ol style="line-height: 1.7; padding-left: 20px; margin: 0;">
          <li style="margin-bottom: 10px;">
            <strong>You'll land in the creator dashboard.</strong>
            You have full admin access — the same view Martin sees.
          </li>
          <li style="margin-bottom: 10px;">
            <strong>Switch between creator and brand views</strong> using the role switcher at the bottom of the sidebar. Use whichever matches what you're testing.
          </li>
          <li style="margin-bottom: 10px;">
            <strong>To view Martin's library</strong> (for testing the remix engine and distribution): in either sidebar, scroll past the main nav to the <em>"Other Libraries"</em> section and click <strong>"Martin"</strong>. You'll see his actual library with an amber banner confirming you're viewing as him. Remix + distribution actions you run from there operate on his videos.
          </li>
          <li style="margin-bottom: 10px;">
            <strong>Connect your own YouTube</strong> (optional) — your own library starts empty; you can connect a YouTube account from the Library page to import videos and run scans.
          </li>
          <li style="margin-bottom: 10px;">
            <strong>Change your password</strong> from the account menu when you have a sec. Pick something only you know.
          </li>
        </ol>
      `;

      const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111;">
          <h2 style="margin: 0 0 16px 0; font-weight: 600;">Welcome to FullScale, ${firstName}.</h2>
          <p style="line-height: 1.55;">${roleIntro}</p>
          ${credentialsBlock}
          ${navigationGuide}
          <p style="line-height: 1.55; margin-top: 28px;">${closing}</p>
          <p style="line-height: 1.4; margin-top: 32px;"><strong>Martin</strong><br/><span style="color: #6b7280;">Founder, FullScale</span></p>
        </div>
      `;

      let emailResult: any = null;
      if (sendEmail && !dryRun) {
        const { getResendClient, MAIL_FROM } = await import("./lib/resend");
        const r = await getResendClient();
        if (!r?.client) {
          emailResult = { sent: false, reason: "Resend client not available" };
        } else {
          try {
            const sent = await r.client.emails.send({
              from: MAIL_FROM.hello,
              to: email,
              subject,
              html,
            });
            emailResult = { sent: true, id: (sent as any)?.data?.id };
          } catch (sendErr: any) {
            emailResult = { sent: false, reason: sendErr?.message };
          }
        }
      } else {
        emailResult = { sent: false, reason: dryRun ? "dryRun=true" : "sendWelcomeEmail=false" };
      }

      res.json({
        success: true,
        dryRun,
        allowlist: { action: allowlistAction, email, name, userType: requestedUserType },
        user: { action: userAction, passwordSet: !!password, userType: requestedUserType },
        email: emailResult,
        previewSubject: subject,
        previewHtmlLength: html.length,
      });
    } catch (err: any) {
      console.error("[Onboard Cobuilder] Error:", err);
      res.status(500).json({ success: false, error: err.message || "Onboard failed" });
    }
  });

  // List every user who has signed up + every entry on the allowlist.
  // Admin-gated. Returns:
  //   users[]      — actually-registered users (have a User row)
  //   allowlist[]  — emails on the allowlist (may or may not have signed in yet)
  //   adminEmails  — current hardcoded admin list (what gets canSwitchRoles)
  app.get("/api/admin/list-signups", async (req: any, res) => {
    try {
      const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !adminEmails.map(e => e.toLowerCase()).includes(callerEmail.toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const allUsers = await db.select({
        id: usersTable.id,
        email: usersTable.email,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        authProvider: usersTable.authProvider,
        isApproved: usersTable.isApproved,
        profileSubmittedAt: usersTable.profileSubmittedAt,
        createdAt: usersTable.createdAt,
      }).from(usersTable).orderBy(usersTable.createdAt);

      const allAllowlist = await db.select().from(allowedUsersTable).orderBy(allowedUsersTable.addedAt);

      // Right-join feel: surface every email seen across both tables, with state from each
      const byEmail = new Map<string, any>();
      for (const u of allUsers) {
        const key = (u.email || "").toLowerCase();
        if (!key) continue;
        byEmail.set(key, {
          email: u.email,
          name: [u.firstName, u.lastName].filter(Boolean).join(" ") || null,
          hasUserRow: true,
          isApproved: u.isApproved,
          authProvider: u.authProvider,
          profileSubmitted: !!u.profileSubmittedAt,
          createdAt: u.createdAt,
          allowlistType: null,
          allowlistName: null,
          isAdmin: adminEmails.includes((u.email || "").toLowerCase()),
        });
      }
      for (const a of allAllowlist) {
        const key = (a.email || "").toLowerCase();
        if (!key) continue;
        const existing = byEmail.get(key);
        if (existing) {
          existing.allowlistType = a.userType;
          existing.allowlistName = a.name;
          existing.allowlistAddedAt = a.addedAt;
        } else {
          byEmail.set(key, {
            email: a.email,
            name: a.name,
            hasUserRow: false,
            allowlistType: a.userType,
            allowlistName: a.name,
            allowlistAddedAt: a.addedAt,
            isAdmin: adminEmails.includes((a.email || "").toLowerCase()),
          });
        }
      }

      const merged = Array.from(byEmail.values()).sort((a, b) => {
        const ta = new Date(a.createdAt || a.allowlistAddedAt || 0).getTime();
        const tb = new Date(b.createdAt || b.allowlistAddedAt || 0).getTime();
        return tb - ta;
      });

      res.json({
        adminEmails,
        totalUsers: allUsers.length,
        totalAllowlist: allAllowlist.length,
        signups: merged,
      });
    } catch (err: any) {
      console.error("[List Signups] Error:", err);
      res.status(500).json({ success: false, error: err.message || "List failed" });
    }
  });

  /** Send a teammate their access instructions. Only addresses already on
   *  the admin allowlist can be invited — the email tells them how to sign
   *  in as an admin, so sending it to a non-admin would be a lie. */
  app.post("/api/admin/send-team-invite", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { email, firstName } = req.body || {};
      if (!email || typeof email !== "string") return res.status(400).json({ error: "email required" });
      const normalized = email.toLowerCase().trim();
      if (!ADMIN_EMAILS.includes(normalized)) {
        return res.status(400).json({
          error: "That address isn't on the admin allowlist yet — add it in server/lib/adminEmails.ts and deploy first, otherwise the instructions in the email won't work for them.",
        });
      }
      const { sendTeamInviteEmail } = await import("./lib/resend");
      const result = await sendTeamInviteEmail({
        email: normalized,
        firstName: firstName ? String(firstName).slice(0, 60) : "there",
      });
      console.log(`[Admin] ${callerEmail} sent team invite to ${normalized}: ${JSON.stringify(result)}`);
      if (!result.sent) return res.status(502).json({ error: `Email failed: ${result.reason}` });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[Admin] Team invite error:", err?.message);
      res.status(500).json({ error: "Failed to send invite" });
    }
  });

  // -------------------------------------------------------------------
  // ONE-CLICK ADMIN APPROVAL — the first-party path. Flips isApproved,
  // writes the allowlist, and sends the founder-voice approval email in
  // one action; the Airtable automation becomes an optional mirror, not a
  // load-bearing dependency. Session-only admin (no dev fallback).
  // -------------------------------------------------------------------
  app.post("/api/admin/approve-user", async (req: any, res) => {
    try {
      const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !adminEmails.map((e: string) => e.toLowerCase()).includes(callerEmail.toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { email, userType } = req.body || {};
      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "email required" });
      }
      const normalizedEmail = email.toLowerCase().trim();
      const role: "brand" | "creator" = userType === "brand" ? "brand" : "creator";

      // Allowlist row (idempotent) — this is what the auth self-heal and
      // approved-before-signup creation paths read.
      const existing = await storage.getAllowedUser(normalizedEmail);
      if (!existing) {
        await storage.addAllowedUser({ email: normalizedEmail, userType: role });
      } else if (existing.userType !== role) {
        await storage.updateAllowedUserRole(normalizedEmail, role);
      }

      // Flip the flag if they already have an account (if not, the
      // allowlist admits them the moment they sign up).
      const userFlipped = await storage.setUserApproved(normalizedEmail, true);
      const userRow = await storage.getUserByEmail(normalizedEmail).catch(() => undefined);

      // Founder-voice approval email (fire-and-forget).
      const { sendApprovalEmail } = await import("./lib/resend");
      const emailResult = await sendApprovalEmail({
        email: normalizedEmail,
        firstName: userRow?.firstName || "there",
        userType: role,
      }).catch((e: any) => ({ sent: false, reason: e?.message }));

      console.log(`[Admin Approve] ${callerEmail} approved ${normalizedEmail} (${role}) — userFlipped=${userFlipped}, email=${JSON.stringify(emailResult)}`);
      res.json({ ok: true, email: normalizedEmail, userFlipped, hadAccount: !!userRow, approvalEmail: emailResult });
    } catch (err: any) {
      console.error("[Admin Approve] Error:", err?.message || err);
      res.status(500).json({ error: "Approval failed" });
    }
  });

  // -------------------------------------------------------------------
  // MEASUREMENT READOUT — the research spine as a queryable summary.
  // Fixtures (experimental units) × their treatments × exposure dose,
  // with control periods visible as gaps. This is the view the data team
  // works against; see docs/DATA_DICTIONARY.md §1.
  // -------------------------------------------------------------------
  app.get("/api/admin/measurement/fixtures", async (req: any, res) => {
    try {
      // Cross-tenant research aggregate — shared allowlist, session only.
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const exposure = await db.select().from(fixtureExposureTable);
      const assignments = await db.select().from(fixtureAssignmentsTable);
      const exposures = await db.select().from(placementExposuresTable);

      // Roll up by fixture — the experimental unit.
      const byFixture = new Map<string, any>();
      const ensure = (gid: string) => {
        let agg = byFixture.get(gid);
        if (!agg) {
          agg = {
            surfaceGroupId: gid,
            displayLabel: null,
            surfaceType: "unknown",
            isModelBacked: /^rm\d+-s\d+$/.test(gid),
            videoCount: 0,
            videoIds: new Set<number>(),
            // NOTE the name: this is fixture-seconds (a dose-weighted
            // measure), NOT wall-clock. See the grain warning below.
            fixtureSecondsSum: 0,
            totalOccurrences: 0,
            treatments: [] as any[],
            liveExposures: 0,
            /** True when the fixture has treatment/exposure rows but no
             *  exposure-supply row (degenerate-index scan, pre-instrumentation
             *  video). Dropping these silently would make the summary and the
             *  table disagree. */
            orphaned: true,
          };
          byFixture.set(gid, agg);
        }
        return agg;
      };

      // Wall-clock exposure supply must be summed at the SCENE grain:
      // scene_screen_time_sec is replicated onto every fixture in a scene,
      // so summing across fixtures multiplies by fixtures-per-scene.
      const sceneSeconds = new Map<string, number>();
      for (const row of exposure) {
        const agg = ensure(row.surfaceGroupId);
        agg.orphaned = false;
        agg.displayLabel = agg.displayLabel ?? row.displayLabel;
        agg.surfaceType = row.surfaceType ?? agg.surfaceType;
        agg.isModelBacked = row.isModelBacked;
        agg.videoIds.add(row.videoId);
        agg.fixtureSecondsSum += parseFloat(String(row.sceneScreenTimeSec)) || 0;
        agg.totalOccurrences += row.occurrences ?? 0;
        sceneSeconds.set(`${row.videoId}:${row.sceneId}`, parseFloat(String(row.sceneScreenTimeSec)) || 0);
      }
      for (const a of assignments) {
        ensure(a.surfaceGroupId).treatments.push({
          brandProductId: a.brandProductId,
          productName: a.productName,
          startedAt: a.startedAt,
          endedAt: a.endedAt,
          endReason: a.endReason,
        });
      }
      for (const e of exposures) {
        if (!e.surfaceGroupId) continue;
        ensure(e.surfaceGroupId).liveExposures += 1;
      }

      const fixtures = Array.from(byFixture.values())
        .map((f) => ({
          surfaceGroupId: f.surfaceGroupId,
          displayLabel: f.displayLabel,
          surfaceType: f.surfaceType,
          isModelBacked: f.isModelBacked,
          videoCount: f.videoIds.size,
          // Renamed from the misleading "totalScreenTimeSec": summing a
          // scene-level quantity across fixtures is dose, not wall-clock.
          fixtureSecondsSum: Math.round(f.fixtureSecondsSum * 10) / 10,
          totalOccurrences: f.totalOccurrences,
          treatments: f.treatments,
          liveExposures: f.liveExposures,
          orphaned: f.orphaned,
          distinctProducts: new Set(f.treatments.filter((t: any) => t.brandProductId).map((t: any) => t.brandProductId)).size,
        }))
        .sort((a, b) => b.fixtureSecondsSum - a.fixtureSecondsSum);

      // True wall-clock supply: each (video, scene) counted once.
      const wallClockSupplySec = Math.round(
        Array.from(sceneSeconds.values()).reduce((sum, v) => sum + v, 0),
      );

      res.json({
        summary: {
          fixtures: fixtures.length,
          // "Cross-episode" means OBSERVED in more than one video. A
          // model-backed id is merely ELIGIBLE to persist — reporting that as
          // cross-episode overstates the panel on day one.
          crossEpisodeFixtures: fixtures.filter((f) => f.videoCount > 1).length,
          modelBackedFixtures: fixtures.filter((f) => f.isModelBacked).length,
          multiTreatmentFixtures: fixtures.filter((f) => f.distinctProducts >= 2).length,
          wallClockSupplySec,
          orphanedFixtures: fixtures.filter((f) => f.orphaned).length,
          openTreatmentWindows: assignments.filter((a) => !a.endedAt && !(a as any).isControl).length,
          controlPeriods: assignments.filter((a) => (a as any).isControl).length,
          liveExposures: exposures.length,
        },
        fixtures: fixtures.slice(0, 200),
      });
    } catch (err: any) {
      console.error("[Measurement] Readout error:", err?.message);
      res.status(500).json({ error: "Failed to build measurement readout" });
    }
  });

  // CREATOR BEHAVIOR + AUDIENCE RESPONSE — how creators use brand
  // integrations, and how audiences react when one appears.
  app.get("/api/admin/measurement/creators", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Behavior events (creator-performed only — admin actions on a
      // creator's behalf are excluded at the storage layer).
      const counts = await storage.getCreatorEventCounts(365);
      const byCreator = new Map<string, any>();
      for (const c of counts) {
        const agg = byCreator.get(c.creatorUserId) ?? {
          creatorUserId: c.creatorUserId,
          events: {} as Record<string, number>,
          lastActiveAt: null as Date | null,
        };
        agg.events[c.eventType] = c.n;
        if (c.lastAt && (!agg.lastActiveAt || c.lastAt > agg.lastActiveAt)) agg.lastActiveAt = c.lastAt;
        byCreator.set(c.creatorUserId, agg);
      }

      // Brand responsiveness is fully recoverable from existing timestamps —
      // it predates the event log and needs no backfill.
      const assignments = await db.select().from(brandPlacementAssignmentsTable);
      const respByCreator = new Map<string, { responded: number[]; approved: number; rejected: number; pending: number }>();
      for (const a of assignments as any[]) {
        const key = String(a.creatorUserId ?? "");
        if (!key) continue;
        const r = respByCreator.get(key) ?? { responded: [], approved: 0, rejected: 0, pending: 0 };
        if (a.reviewedAt && a.createdAt) {
          r.responded.push(new Date(a.reviewedAt).getTime() - new Date(a.createdAt).getTime());
        }
        if (String(a.status).startsWith("creator_approved") || String(a.status).startsWith("brand_") || String(a.status) === "pending_brand_review") r.approved++;
        else if (String(a.status) === "creator_rejected") r.rejected++;
        else if (String(a.status) === "pending_creator_review") r.pending++;
        respByCreator.set(key, r);
      }

      const median = (xs: number[]) => {
        if (xs.length === 0) return null;
        const s2 = [...xs].sort((a, b) => a - b);
        const m = Math.floor(s2.length / 2);
        return s2.length % 2 ? s2[m] : Math.round((s2[m - 1] + s2[m]) / 2);
      };

      const keys = new Set<string>([...Array.from(byCreator.keys()), ...Array.from(respByCreator.keys())]);
      const creators = await Promise.all(
        Array.from(keys).map(async (id) => {
          const b = byCreator.get(id);
          const r = respByCreator.get(id);
          const user = await storage.getUserById(id).catch(() => undefined);
          const ev = b?.events ?? {};
          const decided = (ev.surface_approved ?? 0) + (ev.surface_rejected ?? 0);
          const respondedMs = r ? median(r.responded) : null;
          return {
            creatorUserId: id,
            name: user ? [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email : id,
            email: user?.email ?? null,
            lastActiveAt: b?.lastActiveAt ?? null,
            behavior: {
              surfacesApproved: ev.surface_approved ?? 0,
              surfacesRejected: ev.surface_rejected ?? 0,
              // Curation selectivity: a creator who rejects nothing isn't
              // curating, they're rubber-stamping.
              approvalRate: decided > 0 ? Math.round(((ev.surface_approved ?? 0) / decided) * 100) / 100 : null,
              surfacesTaught: ev.surface_taught ?? 0,
              placementsCreated: ev.placement_created ?? 0,
              placementsWentLive: ev.placement_went_live ?? 0,
              videosImported: ev.video_imported ?? 0,
            },
            brandResponsiveness: r
              ? {
                  requests: r.approved + r.rejected + r.pending,
                  approved: r.approved,
                  rejected: r.rejected,
                  awaitingResponse: r.pending,
                  acceptRate: r.approved + r.rejected > 0 ? Math.round((r.approved / (r.approved + r.rejected)) * 100) / 100 : null,
                  medianResponseHours: respondedMs != null ? Math.round((respondedMs / 3600_000) * 10) / 10 : null,
                }
              : null,
          };
        }),
      );
      creators.sort((a, b) => (b.behavior.placementsCreated + b.behavior.surfacesTaught) - (a.behavior.placementsCreated + a.behavior.surfacesTaught));

      res.json({
        summary: {
          creatorsWithActivity: creators.length,
          totalTaught: creators.reduce((s2, c) => s2 + c.behavior.surfacesTaught, 0),
          totalSelfDirectedPlacements: creators.reduce((s2, c) => s2 + c.behavior.placementsCreated, 0),
          awaitingBrandResponse: creators.reduce((s2, c) => s2 + (c.brandResponsiveness?.awaitingResponse ?? 0), 0),
          // Event coverage starts when the log shipped — say so rather than
          // letting a small number read as low engagement.
          eventLogStartedAt: "2026-08-04",
        },
        creators: creators.slice(0, 200),
      });
    } catch (err: any) {
      console.error("[Measurement] Creator behavior error:", err?.message);
      res.status(500).json({ error: "Failed to build creator behavior readout" });
    }
  });

  // Audience reaction to integrations: comment sentiment split pre/post
  // go-live, plus whether viewers referenced the product at all.
  app.get("/api/admin/measurement/audience-response", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const exposures = await db.select().from(placementExposuresTable);
      const rows = await Promise.all(
        exposures.map(async (e: any) => {
          const comments = await storage.getCommentsForVideo(e.sourceVideoId).catch(() => []);
          const daily = await storage.getVideoDailyMetrics(e.sourceVideoId).catch(() => []);
          const liveAt = e.liveAt ? new Date(e.liveAt).getTime() : null;

          const tally = (subset: any[]) => ({
            n: subset.length,
            positive: subset.filter((c) => c.sentiment === "positive").length,
            negative: subset.filter((c) => c.sentiment === "negative").length,
            mentioningBrand: subset.filter((c) => c.mentionsBrand === true).length,
          });
          const before = comments.filter((c: any) => c.afterPlacementLive === false);
          const after = comments.filter((c: any) => c.afterPlacementLive === true);

          // Engagement slope around go-live, from the retroactive day series.
          let viewsBeforePerDay: number | null = null;
          let viewsAfterPerDay: number | null = null;
          if (liveAt && daily.length > 0) {
            const liveDay = new Date(liveAt).toISOString().slice(0, 10);
            const pre = daily.filter((d: any) => d.day < liveDay);
            const post = daily.filter((d: any) => d.day >= liveDay);
            if (pre.length > 0) viewsBeforePerDay = Math.round(pre.reduce((s2: number, d: any) => s2 + (d.views ?? 0), 0) / pre.length);
            if (post.length > 0) viewsAfterPerDay = Math.round(post.reduce((s2: number, d: any) => s2 + (d.views ?? 0), 0) / post.length);
          }

          return {
            exposureId: e.id,
            surfaceGroupId: e.surfaceGroupId,
            platform: e.platform,
            liveAt: e.liveAt,
            comments: { before: tally(before), after: tally(after), unclassified: comments.filter((c: any) => !c.classifiedAt).length },
            engagement: { viewsBeforePerDay, viewsAfterPerDay, dayRows: daily.length },
          };
        }),
      );
      res.json({
        summary: {
          exposures: rows.length,
          withComments: rows.filter((r) => r.comments.before.n + r.comments.after.n > 0).length,
          withDailySeries: rows.filter((r) => r.engagement.dayRows > 0).length,
        },
        exposures: rows,
      });
    } catch (err: any) {
      console.error("[Measurement] Audience response error:", err?.message);
      res.status(500).json({ error: "Failed to build audience response readout" });
    }
  });

  // CONTROL vs TREATED — the counterfactual comparison. Daily metrics are
  // retroactive to publish date, so untreated periods are frequently
  // already retrievable rather than needing weeks of accumulation.
  app.get("/api/admin/measurement/control-comparison", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const assignments = await db.select().from(fixtureAssignmentsTable);
      const groupIds = Array.from(new Set(assignments.map((a: any) => a.surfaceGroupId)));

      const rows = await Promise.all(
        groupIds.map(async (gid) => {
          const { windows, days } = await storage.getFixtureTreatmentDays(gid);
          if (days.length === 0) {
            return { surfaceGroupId: gid, comparable: false, reason: "no per-day metrics for this fixture's videos yet (YouTube only today)", treated: null, control: null };
          }

          // A day is TREATED if it falls inside a non-control window for the
          // same video; CONTROL if it falls in an explicit control window or
          // outside every window (observed, untreated).
          const treatedDays: any[] = [];
          const controlDays: any[] = [];
          for (const d of days) {
            const ts = Date.parse(`${d.day}T12:00:00Z`);
            const covering = windows.filter((w: any) =>
              w.videoId === d.videoId &&
              Date.parse(String(w.startedAt)) <= ts &&
              (!w.endedAt || Date.parse(String(w.endedAt)) >= ts));
            const treated = covering.some((w: any) => !w.isControl && w.brandProductId != null);
            (treated ? treatedDays : controlDays).push(d);
          }

          const mean = (xs: any[], k: string) =>
            xs.length ? Math.round(xs.reduce((sum, x) => sum + (Number(x[k]) || 0), 0) / xs.length) : null;

          const treatedViews = mean(treatedDays, "views");
          const controlViews = mean(controlDays, "views");
          return {
            surfaceGroupId: gid,
            comparable: treatedDays.length > 0 && controlDays.length > 0,
            reason: treatedDays.length === 0 ? "no treated days observed yet"
              : controlDays.length === 0 ? "no untreated days observed — fixture has been treated for its whole observed life"
              : null,
            treated: { days: treatedDays.length, meanViewsPerDay: treatedViews },
            control: { days: controlDays.length, meanViewsPerDay: controlViews },
            // Descriptive only — assignment is NOT random, so this is a
            // starting point for the analysts, never an effect estimate.
            rawViewsDelta: treatedViews != null && controlViews != null ? treatedViews - controlViews : null,
          };
        }),
      );

      const comparable = rows.filter((r) => r.comparable);
      res.json({
        summary: {
          fixturesWithWindows: rows.length,
          comparable: comparable.length,
          awaitingData: rows.length - comparable.length,
          caveat: "Descriptive only. Treatment assignment is not random (brand match scores and placement viability select which fixtures get products), so these differences are not causal estimates — they are the input to a properly adjusted model.",
        },
        fixtures: rows.slice(0, 200),
      });
    } catch (err: any) {
      console.error("[Measurement] Control comparison error:", err?.message);
      res.status(500).json({ error: "Failed to build control comparison" });
    }
  });

  // Which platforms can actually produce outcome metrics right now, and what
  // is missing where they can't. Prevents "no data" from being read as "no
  // audience" — the platforms differ in what they expose, and some of the
  // blockers are commercial rather than technical.
  app.get("/api/admin/measurement/platforms", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { platformMetricsCapability } = await import("./lib/platformMetrics");
      const capability = await platformMetricsCapability();

      // Pair capability with what's actually in the corpus, so the answer is
      // "3 Twitch videos and we can read them" rather than an abstract matrix.
      const measuredIds = await storage.getVideoIdsUnderMeasurement();
      const counts = new Map<string, number>();
      // Only .platform is read — one projected query instead of a full row per
      // measured video, which grows with the pilot.
      const measured = await storage.getVideoSummaries(measuredIds);
      for (const v of Array.from(measured.values())) {
        const p = String(v.platform ?? "unknown");
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      res.json({
        platforms: capability.map((c) => ({ ...c, videosUnderMeasurement: counts.get(c.platform) ?? 0 })),
        totalUnderMeasurement: measuredIds.length,
      });
    } catch (err: any) {
      console.error("[Measurement] Platform capability error:", err?.message);
      res.status(500).json({ error: "Failed to read platform capability" });
    }
  });

  // The pilot readout: what each platform CAN measure, what we actually
  // HAVE, and which analyses those two facts jointly permit. Built to be
  // handed to an external data team without a verbal caveat track.
  app.get("/api/admin/measurement/cross-platform", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { buildCrossPlatformReadout } = await import("./lib/crossPlatformAnalysis");
      res.json(await buildCrossPlatformReadout());
    } catch (err: any) {
      console.error("[Measurement] Cross-platform readout error:", err?.message);
      res.status(500).json({ error: "Failed to build cross-platform readout" });
    }
  });

  // Per-fixture crossover timeline: every treatment and control period with
  // the dose that applied DURING that window (not today's numbers) and the
  // audience trajectory over it. This is the row-level view the study models.
  app.get("/api/admin/measurement/fixture/:groupId", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const groupId = String(req.params.groupId);
      const timeline = await storage.getFixtureTimeline(groupId);
      const current = await storage.getFixtureExposureByGroup(groupId);
      const history = await storage.getFixtureExposureByGroup(groupId, { includeHistory: true });

      const periods = await Promise.all(
        timeline.map(async (w: any) => {
          const from = new Date(w.startedAt);
          const to = w.endedAt ? new Date(w.endedAt) : null;
          // Dose AS OF the window — the measurement in force while it was
          // open, not whatever the latest rescan produced.
          const dose = await storage.getFixtureDoseForWindow(groupId, from, to).catch(() => []);
          const doseSec = dose.reduce((sum, d) => sum + d.sceneScreenTimeSec, 0);

          // Outcome trajectory over the window, per video carrying the fixture.
          const trajectories = await Promise.all(
            dose.map(async (d) => {
              const series = await storage.getVideoStatSeries(d.videoId, 365).catch(() => []);
              const inWindow = series.filter((pt: any) => {
                const t = new Date(pt.capturedAt).getTime();
                return t >= from.getTime() && (!to || t <= to.getTime());
              });
              const first = inWindow[0];
              const last = inWindow[inWindow.length - 1];
              const days = first && last
                ? Math.max(1e-6, (new Date(last.capturedAt).getTime() - new Date(first.capturedAt).getTime()) / 86400_000)
                : 0;
              return {
                videoId: d.videoId,
                sceneScreenTimeSec: d.sceneScreenTimeSec,
                scanVersion: d.scanVersion,
                points: inWindow.length,
                viewsAtStart: first?.viewCount ?? null,
                viewsAtEnd: last?.viewCount ?? null,
                // Views/day over the window — the comparable slope between
                // treatment and control periods.
                viewVelocityPerDay:
                  first?.viewCount != null && last?.viewCount != null && days > 0
                    ? Math.round(((last.viewCount - first.viewCount) / days) * 10) / 10
                    : null,
              };
            }),
          );

          return {
            id: w.id,
            kind: w.isControl ? "control" : "treatment",
            brandProductId: w.brandProductId,
            productName: w.productName,
            startedAt: w.startedAt,
            endedAt: w.endedAt,
            endReason: w.endReason,
            doseSecAtWindow: Math.round(doseSec * 10) / 10,
            trajectories,
            measurable: trajectories.some((t) => t.points >= 2),
          };
        }),
      );

      res.json({
        surfaceGroupId: groupId,
        displayLabel: current[0]?.displayLabel ?? null,
        surfaceType: current[0]?.surfaceType ?? null,
        currentMeasurements: current.length,
        historicalMeasurements: history.length - current.length,
        periods,
        summary: {
          treatmentPeriods: periods.filter((p) => p.kind === "treatment").length,
          controlPeriods: periods.filter((p) => p.kind === "control").length,
          measurablePeriods: periods.filter((p) => p.measurable).length,
        },
      });
    } catch (err: any) {
      console.error("[Measurement] Fixture timeline error:", err?.message);
      res.status(500).json({ error: "Failed to build fixture timeline" });
    }
  });

  // RETENTION AT THE PLACEMENT — the payoff measurement. For each live
  // exposure: where the product sits in the published asset, what fraction
  // of viewers were still watching there, and how that compares to the
  // video's own average. Handles the source→post coordinate mapping so the
  // curve is never silently misaligned.
  app.get("/api/admin/measurement/retention", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const exposures = await db.select().from(placementExposuresTable);
      const rows = await Promise.all(
        exposures.map(async (e: any) => {
          const curveRow = await storage.getLatestRetentionCurve(e.sourceVideoId).catch(() => undefined);
          const demo = await storage.getLatestVideoDemographics(e.sourceVideoId).catch(() => undefined);
          const base = {
            exposureId: e.id,
            placementId: e.placementId,
            surfaceGroupId: e.surfaceGroupId,
            brandProductId: e.brandProductId,
            platform: e.platform,
            postUrl: e.postUrl,
            liveAt: e.liveAt,
            demographics: demo
              ? { age: demo.ageDistribution, gender: demo.genderDistribution, capturedAt: demo.capturedAt }
              : null,
          };
          if (!curveRow?.curve || !Array.isArray(curveRow.curve) || curveRow.curve.length === 0) {
            return { ...base, retention: null, reason: "no retention curve yet (below YouTube's reporting threshold, or not captured)" };
          }

          // SOURCE → POST coordinates. source_start_sec is measured from the
          // start of the original upload; a clip-based post starts later.
          const sourceStart = e.sourceStartSec != null ? parseFloat(String(e.sourceStartSec)) : null;
          const clipStart = e.clipStartSec != null ? parseFloat(String(e.clipStartSec)) : 0;
          const durationSec = curveRow.videoDurationSec != null ? parseFloat(String(curveRow.videoDurationSec)) : null;
          if (sourceStart == null || !durationSec || durationSec <= 0) {
            return { ...base, retention: null, reason: "missing placement timestamp or video duration — cannot position on the curve" };
          }
          const postRelativeSec = Math.max(0, sourceStart - clipStart);
          const positionRatio = Math.min(1, postRelativeSec / durationSec);

          const curve = curveRow.curve as Array<{ ratio: number; watchRatio: number; relativePerformance?: number | null }>;
          // Nearest bucket at or before the placement position.
          let at = curve[0];
          for (const pt of curve) {
            if (pt.ratio <= positionRatio) at = pt; else break;
          }
          const meanWatch = curve.reduce((sum, p) => sum + p.watchRatio, 0) / curve.length;

          return {
            ...base,
            retention: {
              positionRatio: Math.round(positionRatio * 1000) / 1000,
              postRelativeSec: Math.round(postRelativeSec),
              watchRatioAtPlacement: Math.round(at.watchRatio * 1000) / 1000,
              videoMeanWatchRatio: Math.round(meanWatch * 1000) / 1000,
              // >0 means more viewers than average were present at the
              // moment the product was on screen.
              liftVsVideoMean: Math.round((at.watchRatio - meanWatch) * 1000) / 1000,
              relativePerformanceAtPlacement: at.relativePerformance ?? null,
              curvePoints: curve.length,
              capturedAt: curveRow.capturedAt,
            },
            reason: null,
          };
        }),
      );

      const measured = rows.filter((r: any) => r.retention);
      res.json({
        summary: {
          exposures: rows.length,
          withRetention: measured.length,
          awaitingCurves: rows.length - measured.length,
          meanLiftVsVideoMean: measured.length
            ? Math.round((measured.reduce((s: number, r: any) => s + r.retention.liftVsVideoMean, 0) / measured.length) * 1000) / 1000
            : null,
        },
        exposures: rows,
      });
    } catch (err: any) {
      console.error("[Measurement] Retention readout error:", err?.message);
      res.status(500).json({ error: "Failed to build retention readout" });
    }
  });

  // -------------------------------------------------------------------
  // PLACEMENT REVIEW QUEUE — the in-app home of the human step. Creators
  // choose placements; this is where FullScale reviews each choice and
  // marks the final render ready (or asks for changes).
  // -------------------------------------------------------------------
  // GET /api/admin/schema-check — is the deployed DB caught up with the code?
  // The answer to "the site is laggy and everything spins" often lives here.
  app.get("/api/admin/schema-check", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { checkSchemaDrift } = await import("./lib/schemaCheck");
      const drift = await checkSchemaDrift();
      res.status(drift.ok ? 200 : 503).json({
        ...drift,
        fixEndpoint: drift.ok ? null : "POST /api/admin/schema-fix { \"confirm\": true } applies the missing pieces from inside the app",
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Schema check failed" });
    }
  });

  // POST /api/admin/schema-fix — the deployed app repairs its own database.
  // Exists because the production connection string is unreachable from the
  // workspace (Replit UI doesn't surface it; drizzle-kit isn't in the prod
  // bundle). Strictly additive: CREATE TABLE / ADD COLUMN IF NOT EXISTS only,
  // generated from the same Drizzle metadata the queries compile from.
  // Without { confirm: true } it returns the plan and touches nothing.
  app.post("/api/admin/schema-fix", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { checkSchemaDrift, buildSchemaFixPlan, applySchemaFix } = await import("./lib/schemaCheck");
      if (req.body?.confirm !== true) {
        const drift = await checkSchemaDrift();
        const plan = buildSchemaFixPlan(drift);
        return res.json({ dryRun: true, drift, plan });
      }
      console.log(`[SchemaFix] ${callerEmail} confirmed schema self-repair`);
      const result = await applySchemaFix();
      const failed = result.applied.filter((a) => !a.ok).length;
      res.status(result.driftAfter.ok ? 200 : failed > 0 ? 500 : 200).json(result);
    } catch (err: any) {
      console.error("[SchemaFix] error:", err?.message);
      res.status(500).json({ error: err?.message || "Schema fix failed" });
    }
  });

  app.get("/api/admin/placements", async (req: any, res) => {
    try {
      const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !adminEmails.map((e: string) => e.toLowerCase()).includes(callerEmail.toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      // Two lean queries, not 1 + N heavy ones. The previous version called
      // getVideoById per distinct video, and that returns scene_index and
      // scene_inventory jsonb — megabytes on a scanned video, parsed
      // synchronously by the pg driver. It blocked the event loop long enough
      // to stall every other request in the process, which is why opening
      // this page appeared to take the whole site down.
      const all = await storage.getReviewQueuePlacements();
      const titles = await storage.getVideoTitles(all.map((p) => p.videoId));
      const order: Record<string, number> = { submitted: 0, in_review: 1, needs_changes: 2, render_ready: 3 };
      const rows = all
        .map((p: any) => ({
          id: p.id,
          videoId: p.videoId,
          videoTitle: titles.get(p.videoId) ?? `video ${p.videoId}`,
          createdBy: p.createdBy,
          // A pointer, not the bytes. See getReviewQueuePlacements.
          thumbUrl: p.hasImage ? `/api/admin/placements/${p.id}/thumb` : null,
          reviewStatus: p.reviewStatus ?? "submitted",
          reviewNote: p.reviewNote ?? null,
          createdAt: p.createdAt,
        }))
        .sort((a, b) => (order[a.reviewStatus] ?? 0) - (order[b.reviewStatus] ?? 0) || b.id - a.id);
      res.json({ placements: rows });
    } catch (err: any) {
      console.error("[Admin Placements] List error:", err?.message);
      const { status, error } = explainDbError(err, "Failed to list placements");
      res.status(status).json({ error });
    }
  });

  /**
   * One placement's review thumbnail.
   *
   * Exists so the queue list can stay small. The stored value is either an
   * ordinary URL (redirect to it) or a `data:image/png;base64,...` composite
   * from the harmonizer (decode and stream it). Either way ONE image crosses
   * the wire, only when a thumbnail actually asks for it, and it is cacheable
   * — instead of 200 of them inlined into a JSON list.
   */
  app.get("/api/admin/placements/:id/thumb", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.map((e: string) => e.toLowerCase()).includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid placement id" });

      const row = await storage.getPlacementReviewImage(id);
      const src = row?.harmonizedImageUrl || row?.productImageUrl;
      if (!src) return res.status(404).json({ error: "No image" });

      // [\s\S] rather than the /s flag — this file's TS target predates dotAll,
      // and a base64 payload contains no newlines anyway.
      const m = /^data:([\w/+.-]+);base64,([\s\S]*)$/.exec(src);
      if (m) {
        const buf = Buffer.from(m[2], "base64");
        res.setHeader("Content-Type", m[1]);
        res.setHeader("Content-Length", String(buf.length));
        // Immutable in practice: a re-harmonize writes a new placement row.
        res.setHeader("Cache-Control", "private, max-age=86400");
        return res.end(buf);
      }
      return res.redirect(302, src);
    } catch (err: any) {
      console.error("[Admin Placements] Thumb error:", err?.message);
      return res.status(500).json({ error: "Failed to load thumbnail" });
    }
  });

  /**
   * Everything needed to actually REVIEW one placement.
   *
   * The queue could start and finish a review but never SHOW the thing being
   * reviewed — the operator was asked to approve a creator's choice with a
   * 40x40 thumbnail and a row title. This returns the placement in context:
   * where in the video it sits, what surface it occupies, which product, and
   * the creator's own framing values.
   *
   * The image blobs stay out of the payload as always; the composite is
   * fetched from the /thumb route, which streams one image on demand.
   */
  app.get("/api/admin/placements/:id/detail", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.map((e: string) => e.toLowerCase()).includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid placement id" });

      const placement: any = await storage.getPlacementById(id);
      if (!placement) return res.status(404).json({ error: "Placement not found" });

      const [video, surfaces, product, clip] = await Promise.all([
        storage.getVideoSummaries([placement.videoId]).then((m) => m.get(placement.videoId) ?? null),
        storage.getDetectedSurfaces(placement.videoId).catch(() => [] as any[]),
        placement.productId != null
          ? storage.getBrandProduct(placement.productId).catch(() => undefined)
          : Promise.resolve(undefined),
        placement.editorialClipId
          ? storage.getEditorialClipById(placement.editorialClipId).catch(() => null)
          : Promise.resolve(null),
      ]);
      const surface: any = (surfaces as any[]).find((s) => s.id === placement.surfaceId) ?? null;

      // Where to seek the player. An editorial placement is scoped to the clip,
      // so its timestamp is relative to the clip's start in the source video.
      const surfaceSec = surface ? Number(surface.timestamp) : null;
      const seekSec = clip ? Number((clip as any).clipStart ?? 0) : (surfaceSec ?? 0);

      res.json({
        placement: {
          id: placement.id,
          videoId: placement.videoId,
          createdBy: placement.createdBy,
          role: placement.role,
          reviewStatus: placement.reviewStatus ?? "submitted",
          reviewNote: placement.reviewNote ?? null,
          isHarmonized: !!placement.isHarmonized,
          createdAt: placement.createdAt,
          transform: placement.transform ?? null,
          blend: placement.blend ?? null,
        },
        video: video
          ? {
              id: video.id,
              title: video.title,
              // Ownership-gated stream; admins pass the media policy.
              streamUrl: video.filePath ? `/api/video/${video.id}/stream` : null,
              platform: (video as any).platform ?? null,
              duration: (video as any).duration ?? null,
            }
          : null,
        surface: surface
          ? {
              id: surface.id,
              surfaceType: surface.surfaceType,
              timestamp: surfaceSec,
              sceneContext: surface.sceneContext ?? null,
              box: {
                x: Number(surface.boundingBoxX),
                y: Number(surface.boundingBoxY),
                w: Number(surface.boundingBoxWidth),
                h: Number(surface.boundingBoxHeight),
              },
            }
          : null,
        clip: clip
          ? {
              id: (clip as any).id,
              suggestedTitle: (clip as any).suggestedTitle ?? null,
              clipStart: (clip as any).clipStart ?? null,
              clipEnd: (clip as any).clipEnd ?? null,
              aspectRatio: (clip as any).aspectRatio ?? null,
              exportPath: (clip as any).exportPath ?? null,
            }
          : null,
        product: product ? { id: (product as any).id, name: (product as any).name ?? null } : null,
        seekSec,
        compositeUrl: `/api/admin/placements/${id}/thumb`,
      });
    } catch (err: any) {
      console.error("[Admin Placements] Detail error:", err?.message);
      res.status(500).json({ error: "Failed to load placement detail" });
    }
  });

  app.post("/api/admin/placements/:id/review", async (req: any, res) => {
    try {
      const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !adminEmails.map((e: string) => e.toLowerCase()).includes(callerEmail.toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const placementId = parseInt(req.params.id);
      const { reviewStatus, reviewNote } = req.body || {};
      const VALID = ["submitted", "in_review", "render_ready", "needs_changes", "live"];
      if (isNaN(placementId) || !VALID.includes(reviewStatus)) {
        return res.status(400).json({ error: `reviewStatus must be one of ${VALID.join(", ")}` });
      }
      const row = await storage.updatePlacementReview(placementId, { reviewStatus, reviewNote: reviewNote || null });
      if (!row) return res.status(404).json({ error: "Placement not found" });

      // Tell the creator where their placement stands (in-app bell).
      const creatorUser = await storage.getUserByEmail((row as any).createdBy).catch(() => undefined);
      if (creatorUser) {
        const video = await storage.getVideoById(row.videoId).catch(() => undefined);
        const titles: Record<string, { t: string; b: string }> = {
          in_review: { t: "Your placement is in review", b: "Our team is reviewing your placement choice and preparing the final render." },
          render_ready: { t: "Final render ready 🎉", b: "Your placement passed review and the final render is done — tell us where you post it so we can track how it performs." },
          needs_changes: { t: "Your placement needs a tweak", b: reviewNote ? String(reviewNote).slice(0, 200) : "Our team left a note on your placement — open it to see what to adjust." },
        };
        const msg = titles[reviewStatus];
        if (msg) {
          storage.createNotification({
            userId: creatorUser.id,
            type: "placement_review",
            title: msg.t,
            body: `${video?.title ? `"${video.title}" — ` : ""}${msg.b}`,
            linkPath: "/placements",
            metadata: { placementId, reviewStatus },
          }).catch(() => {});
        }
      }
      console.log(`[Admin Placements] ${callerEmail} set placement ${placementId} → ${reviewStatus}`);
      res.json({ ok: true, placement: row });
    } catch (err: any) {
      console.error("[Admin Placements] Review error:", err?.message);
      res.status(500).json({ error: "Review update failed" });
    }
  });

  // Pull every signup from the Airtable base (canonical source-of-truth
  // for who has expressed interest — every signup gets POSTed there at
  // -------------------------------------------------------------------
  // AIRTABLE APPROVAL WEBHOOK
  // -------------------------------------------------------------------
  // Receives a callback from Airtable Automations when an admin toggles
  // an applicant's Status to "Approved" or "Declined" in either:
  //   - the BrandApplications table (base app9YlRgIcR9M29p6)
  //   - the Creator Submissions table (base appF4oLhgbf143xe7)
  //
  // On Approved:
  //   1. Add to allowed_users with the matching userType (brand|creator).
  //      Idempotent — skips if already present.
  //   2. Flip users.isApproved=true if the applicant has already signed
  //      in once (their User row exists). For brands this is typically
  //      false — they haven't OAuth'd yet — and that's fine, the
  //      allowlist alone gates access on next signin.
  //   3. Send the applicant a "you're in" welcome email via Resend,
  //      branched on userType.
  //
  // On Declined:
  //   No DB mutation. We could optionally email a polite decline here —
  //   left off by default to avoid surprise emails. Toggle on via the
  //   sendDeclineEmail flag in the request body if you want it.
  //
  // Auth:
  //   Header `X-Airtable-Webhook-Secret` must match the
  //   AIRTABLE_WEBHOOK_SECRET env var on Replit. Configure the matching
  //   header in each Airtable Automation's "Send webhook" action.
  //
  // Setup walkthrough is in the user's onboarding doc (or ask Martin).
  // -------------------------------------------------------------------
  app.post("/api/admin/airtable-approval-webhook", async (req, res) => {
    try {
      const expectedSecret = process.env.AIRTABLE_WEBHOOK_SECRET;
      if (!expectedSecret) {
        console.error("[airtable-webhook] AIRTABLE_WEBHOOK_SECRET not set — refusing all requests");
        return res.status(500).json({ error: "Webhook secret not configured on server" });
      }
      const presentedSecret = req.headers["x-airtable-webhook-secret"];
      if (!presentedSecret || presentedSecret !== expectedSecret) {
        console.warn(`[airtable-webhook] Invalid secret (got: ${presentedSecret ? "wrong value" : "no header"})`);
        return res.status(401).json({ error: "Invalid or missing webhook secret" });
      }

      const {
        email,
        firstName,
        lastName,
        company,
        userType,
        status,
        recordId,
        tableName,
        requestType,
        sendDeclineEmail = false,
      } = req.body || {};

      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "Missing required field: email" });
      }

      const normalizedEmailEarly = email.toLowerCase().trim();

      // -----------------------------------------------------------------
      // DEMO branch — fires BEFORE the status/approval logic.
      //
      // Demo requests aren't access approvals: there's no allowlist row,
      // no isApproved flip. We just send the requester a warm note from
      // Martin with the cal.com booking link so they can self-schedule.
      //
      // Triggered when requestType === "demo" OR the source table is the
      // FullScale Demo table. No `status` required — works on a
      // "record created" Airtable trigger (fires the moment someone
      // submits the demo form).
      // -----------------------------------------------------------------
      const isDemo =
        requestType === "demo" ||
        tableName === "FullScale Demo" ||
        tableName === "Demo Requests" ||
        tableName === "FullScaleDemo";
      if (isDemo) {
        console.log(`[airtable-webhook] DEMO request from ${normalizedEmailEarly} (table=${tableName ?? "?"})`);
        const { sendDemoSchedulingEmail } = await import("./lib/resend");
        const emailResult = await sendDemoSchedulingEmail({
          email: normalizedEmailEarly,
          firstName: firstName || "there",
          companyName: company,
        });
        return res.json({
          ok: true,
          action: "demo-scheduling-email-sent",
          email: emailResult,
          recordId,
          tableName,
        });
      }

      if (!status || typeof status !== "string") {
        return res.status(400).json({ error: "Missing required field: status" });
      }

      const normalizedEmail = email.toLowerCase().trim();
      const normalizedStatus = status.trim().toLowerCase();
      // Infer userType from tableName if not explicitly provided. Useful
      // because the Airtable Automation builder sometimes forgets to set it.
      const inferredUserType: "brand" | "creator" =
        userType === "brand" || userType === "creator"
          ? userType
          : tableName === "BrandApplications"
            ? "brand"
            : "creator";

      console.log(
        `[airtable-webhook] ${normalizedStatus.toUpperCase()} for ${normalizedEmail} ` +
          `(userType=${inferredUserType}, table=${tableName ?? "?"}, recordId=${recordId ?? "?"})`,
      );

      if (normalizedStatus === "approved") {
        // 1. Allowlist row — idempotent.
        const existing = await storage.getAllowedUser(normalizedEmail);
        let allowlistAction: "created" | "exists" | "updated";
        if (!existing) {
          await storage.addAllowedUser({
            email: normalizedEmail,
            name: [firstName, lastName].filter(Boolean).join(" ") || company || normalizedEmail,
            userType: inferredUserType,
          });
          allowlistAction = "created";
        } else if (existing.userType !== inferredUserType) {
          await storage.updateAllowedUserRole(normalizedEmail, inferredUserType);
          allowlistAction = "updated";
        } else {
          allowlistAction = "exists";
        }

        // 2. Flip users.isApproved=true IF they already have a User row
        // (typical for creators who signed up via Google before approval;
        // typical NOT for brands who applied via Airtable form and haven't
        // OAuth'd yet — that's fine).
        const userFlipped = await storage.setUserApproved(normalizedEmail, true);

        // 3. Welcome email (fire-and-forget — webhook should still 200 even
        // if Resend hiccups, so the Airtable Automation doesn't retry the
        // whole approval).
        const { sendApprovalEmail } = await import("./lib/resend");
        const emailResult = await sendApprovalEmail({
          email: normalizedEmail,
          firstName: firstName || "there",
          userType: inferredUserType,
          companyName: company,
        });

        return res.json({
          ok: true,
          action: "approved",
          allowlist: allowlistAction,
          userApprovalFlipped: userFlipped,
          email: emailResult,
          recordId,
          tableName,
        });
      }

      if (normalizedStatus === "declined") {
        // Optional decline email. Off by default.
        let emailResult: any = { sent: false, reason: "sendDeclineEmail flag was false" };
        if (sendDeclineEmail === true) {
          // Reuse approval email shell but with decline copy — simple inline
          // for now since this is rarely used.
          try {
            const { getResendClient } = await import("./lib/resend");
            const { client, fromEmail } = await getResendClient();
            if (client) {
              const result = await client.emails.send({
                from: fromEmail || "FullScale <noreply@gofullscale.co>",
                to: normalizedEmail,
                subject: "Your FullScale application",
                html: `
                  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
                    <p>Hi ${firstName || "there"},</p>
                    <p>Thanks for your interest in FullScale. After reviewing your application we're not able to bring you onto the platform at this time. We try to be selective during the founding cohort to keep the experience tight for the brands and creators we've onboarded.</p>
                    <p>If your situation changes (new product line, different audience focus, more content volume) you're welcome to reapply.</p>
                    <p style="margin-top: 32px; color: #6b7280;">— Martin</p>
                  </div>
                `,
              });
              emailResult = { sent: true, id: (result as any)?.data?.id };
            }
          } catch (err: any) {
            emailResult = { sent: false, reason: err?.message || String(err) };
          }
        }
        return res.json({
          ok: true,
          action: "declined",
          email: emailResult,
          recordId,
          tableName,
        });
      }

      // Status changed to something we don't act on (e.g. back to Pending,
      // or some new option). Return ok so Airtable doesn't retry.
      return res.json({
        ok: true,
        action: "ignored",
        reason: `Status "${status}" is not actionable (only approved/declined)`,
      });
    } catch (err: any) {
      console.error("[airtable-webhook] Handler error:", err?.message || err, err?.stack);
      return res.status(500).json({ error: "Webhook handler failed", detail: err?.message || String(err) });
    }
  });

  // registration time per the existing flow). Admin-gated. Compares
  // against the Postgres allowlist + users table so you can spot drift.
  app.get("/api/admin/airtable-signups", async (req: any, res) => {
    try {
      const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !adminEmails.map(e => e.toLowerCase()).includes(callerEmail.toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const records = await listAirtableSignups();
      if (records === null) {
        return res.status(503).json({
          error: "Airtable not configured",
          detail: "AIRTABLE_API_TOKEN env var is not set on this deployment",
        });
      }

      // Cross-reference with Postgres so you can see who's where
      const allowlist = await db.select().from(allowedUsersTable);
      const allUsers = await db.select({
        email: usersTable.email,
        isApproved: usersTable.isApproved,
      }).from(usersTable);

      const allowlistByEmail = new Map(allowlist.map(a => [(a.email || "").toLowerCase(), a]));
      const usersByEmail = new Map(allUsers.map(u => [(u.email || "").toLowerCase(), u]));

      const enriched = records.map(r => {
        const lower = (r.email || "").toLowerCase();
        const inAllowlist = allowlistByEmail.has(lower);
        const inUsers = usersByEmail.has(lower);
        return {
          ...r,
          inAllowlist,
          inUsers,
          // Discrepancy flags: Airtable record but no Postgres trail
          driftLikely: !inAllowlist && !inUsers,
        };
      });

      // Summary counts at the top so the response is scannable
      const summary = {
        airtableTotal: records.length,
        inAllowlist: enriched.filter(r => r.inAllowlist).length,
        inUsers: enriched.filter(r => r.inUsers).length,
        driftLikely: enriched.filter(r => r.driftLikely).length,
        byStatus: enriched.reduce((acc: Record<string, number>, r) => {
          const k = r.status || "(none)";
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {}),
        byAuthProvider: enriched.reduce((acc: Record<string, number>, r) => {
          const k = r.authProvider || "(none)";
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {}),
      };

      res.json({ summary, records: enriched });
    } catch (err: any) {
      console.error("[Airtable Signups] Error:", err);
      res.status(500).json({ success: false, error: err.message || "Fetch failed" });
    }
  });

  app.post("/api/admin/migrate-surfaces", async (req: any, res) => {
    try {
      const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
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
        // VIPs/Founding members auto-approve — and so does anyone an admin
        // already approved via the Airtable webhook (allowed_users row
        // written before their first login).
        userIsApproved = isVip || (await storage.isEmailAllowed(normalizedEmail).catch(() => false));
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
        // Pre-hijack defense: registration never verifies email ownership,
        // so a squatter could have registered this address with their own
        // password before the real owner's first Google login. Google HAS
        // verified ownership — scrub any password on the row so the
        // squatter's credential dies the moment the real owner arrives.
        if (existingUser.authProvider === "email" && (existingUser as any).password) {
          await storage.scrubUserPassword(existingUser.id).catch((e: any) =>
            console.error("[Google OAuth Callback] Password scrub failed:", e?.message));
          console.warn(`[Google OAuth Callback] Cleared pre-existing password for ${normalizedEmail} — Google login proved ownership`);
        }
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
  app.post("/api/auth/dev-login", authLimiter, async (req: any, res) => {
    const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
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

  // -------------------------------------------------------------------
  // Brand sign-up — separate from /api/auth/register on purpose.
  //
  // Brand applications are NOT auto-approved. They get queued for admin
  // review:
  //   1. We record the request (in-memory for v1 — see brandSignupRequests
  //      below; replace with a DB table once volume justifies it).
  //   2. We notify all admins (ADMIN_EMAILS) via Resend so they can review
  //      and add the brand to allowed_users with userType="brand".
  //   3. We send the applicant a confirmation email so they know we got it.
  //
  // No account is created on this endpoint. The applicant will register a
  // normal account via /api/auth/register once admin has allowlisted them;
  // the allowlist check at /api/auth/google + /api/auth/register gates
  // their actual access to the marketplace.
  // -------------------------------------------------------------------
  app.post("/api/brand-signup", async (req, res) => {
    try {
      const brandSignupSchema = z.object({
        firstName: z.string().min(1).max(80),
        lastName: z.string().min(1).max(80),
        email: z.string().email().max(200),
        companyName: z.string().min(1).max(200),
        websiteUrl: z.string().max(400).optional(),
        message: z.string().max(2000).optional(),
      });
      const parsed = brandSignupSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: parsed.error.errors[0]?.message || "Invalid input",
        });
      }
      const { firstName, lastName, email, companyName, websiteUrl, message } = parsed.data;
      const normalizedEmail = email.toLowerCase().trim();

      // Guard against duplicate spammy submissions — if this email is
      // already in allowed_users we don't email admin again; we just tell
      // the applicant they're already in the system.
      const existing = await storage.getAllowedUser(normalizedEmail);
      if (existing) {
        console.log(`[brand-signup] ${normalizedEmail} already in allowlist (userType=${existing.userType}) — no admin notification sent`);
        return res.status(200).json({
          message: "Your account is already in our system. Please sign in at /auth.",
          alreadyAllowlisted: true,
        });
      }

      console.log(`[brand-signup] New application: ${normalizedEmail} from ${companyName}`);

      // Mirror to Airtable "BrandApplications" so admin has a queryable
      // record. Fire-and-forget — Airtable being down should never block
      // the applicant's submission. addBrandApplicationToAirtable swallows
      // its own errors and logs them.
      void addBrandApplicationToAirtable({
        email: normalizedEmail,
        firstName,
        lastName,
        companyName,
        websiteUrl: websiteUrl || null,
        message: message || null,
      });

      // Fire-and-forget email notifications. We don't await all of them
      // before responding — the applicant doesn't need to wait on SMTP.
      const sendEmails = async () => {
        try {
          // Dynamic import matches the existing pattern at /api/admin/test-email.
          const { getResendClient } = await import("./lib/resend");
          const { client, fromEmail } = await getResendClient();
          const from = fromEmail || "FullScale <noreply@gofullscale.co>";

          // Local admin recipient list (matches the routes.ts inline
          // convention; canonical list lives in server/lib/adminEmails.ts
          // — keep these in sync when adding admins).
          const brandSignupAdminRecipients = [
            "martin@gofullscale.co",
            "tamara@gofullscale.co",
            "ben@muselabs.ai",
            "chu@gofullscale.co",
            "remiguyton@gmail.com",
            "scottmmills@outlook.com",
            "juanroviraesteve@gmail.com",
          ];

          // Admin notification — one email to all admins so any of us
          // can pick it up and approve.
          await client.emails.send({
            from,
            to: brandSignupAdminRecipients,
            subject: `[FullScale] New brand application — ${companyName}`,
            html: `
<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111;">
  <h2 style="margin:0 0 16px;">New brand application</h2>
  <p style="margin:0 0 8px;color:#444;">Approve by adding the email to <code>allowed_users</code> with <code>userType=brand</code>, then reply to the applicant directly.</p>
  <table style="border-collapse:collapse;width:100%;margin-top:16px;">
    <tr><td style="padding:8px 12px;border:1px solid #eee;width:140px;color:#666;">Name</td><td style="padding:8px 12px;border:1px solid #eee;">${firstName} ${lastName}</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #eee;color:#666;">Email</td><td style="padding:8px 12px;border:1px solid #eee;"><a href="mailto:${normalizedEmail}">${normalizedEmail}</a></td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #eee;color:#666;">Company</td><td style="padding:8px 12px;border:1px solid #eee;">${companyName}</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #eee;color:#666;">Website</td><td style="padding:8px 12px;border:1px solid #eee;">${websiteUrl ? `<a href="${websiteUrl}" target="_blank" rel="noopener noreferrer">${websiteUrl}</a>` : "<em>—</em>"}</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #eee;color:#666;vertical-align:top;">Message</td><td style="padding:8px 12px;border:1px solid #eee;white-space:pre-wrap;">${message ? message.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!)) : "<em>—</em>"}</td></tr>
  </table>
</body></html>
            `.trim(),
          });

          // Applicant confirmation — concise, sets the 1–2 day expectation
          // matching the success state shown in BrandSignUp.tsx.
          await client.emails.send({
            from,
            to: normalizedEmail,
            subject: "Your FullScale brand application",
            html: `
<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111;">
  <h2 style="margin:0 0 12px;">Application received</h2>
  <p>Hi ${firstName},</p>
  <p>Thanks for applying for brand access to FullScale. We review every application personally and you'll hear back within 1–2 business days.</p>
  <p>Once approved you'll get an invite link to set up your account and start browsing the creator marketplace.</p>
  <p style="margin-top:24px;color:#666;font-size:13px;">If you didn't submit this, ignore this email or reply to let us know.</p>
  <p style="color:#666;font-size:13px;">— The FullScale team</p>
</body></html>
            `.trim(),
          });
          console.log(`[brand-signup] Notification emails sent for ${normalizedEmail}`);
        } catch (err: any) {
          console.error(`[brand-signup] Email send failed for ${normalizedEmail}:`, err?.message || err);
        }
      };
      void sendEmails();

      return res.status(201).json({
        message: "Application received. We'll review and respond within 1–2 business days.",
      });
    } catch (err: any) {
      console.error("[brand-signup] Failed:", err?.message || err);
      return res.status(500).json({
        message: "Could not submit your application. Please email fullscale_info@gofullscale.co directly.",
      });
    }
  });

  // Register new user with email/password
  app.post("/api/auth/register", authLimiter, async (req, res) => {
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

      // Admin addresses cannot be self-registered: admin status is granted
      // by email allowlist with NO email verification, so an unclaimed admin
      // address was a privilege-escalation prize for whoever registered it
      // first. Founder provisions these accounts directly.
      if (ADMIN_EMAILS.includes(normalizedEmail)) {
        console.warn(`[Auth] Blocked self-registration of admin address ${normalizedEmail} from ${req.ip}`);
        return res.status(400).json({ message: "This email cannot be registered here. Contact support." });
      }

      // VIP users are auto-approved, others go to waitlist — UNLESS an
      // admin already approved this email (Airtable webhook writes
      // allowed_users before the person ever logs in; without this check
      // they'd be created unapproved and stuck on the waitlist anyway).
      const isVip = isVipEmail(normalizedEmail);
      const preApproved = await storage.isEmailAllowed(normalizedEmail).catch(() => false);

      // Hash password and create user
      const hashedPassword = await hashPassword(password);
      const user = await storage.createUser({
        email: normalizedEmail,
        password: hashedPassword,
        firstName: firstName || null,
        lastName: lastName || null,
        isApproved: isVip || preApproved,
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
  app.post("/api/auth/login", authLimiter, async (req, res) => {
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
      let isApproved = user?.isApproved ?? googleUser.isApproved ?? false;
      // Self-heal: the approval webhook writes allowed_users, then flips
      // users.isApproved — if the flip didn't land (email-case drift, row
      // created after the webhook, transient failure), converge here. The
      // waitlist page polls this endpoint every 30s, so an approval that
      // reached the server at all lets the user in within one poll.
      if (user && !isApproved) {
        const allowed = await storage.isEmailAllowed(googleUser.email).catch(() => false);
        if (allowed) {
          await storage.setUserApproved(googleUser.email.toLowerCase().trim(), true).catch(() => {});
          isApproved = true;
          console.log(`[Auth] Self-healed approval for ${googleUser.email} from allowlist`);
        }
      }
      return res.json({
        authenticated: true,
        email: googleUser.email,
        name: googleUser.name,
        firstName: user?.firstName || null,
        lastName: user?.lastName || null,
        picture: googleUser.picture,
        authProvider: googleUser.authProvider || "google",
        isApproved,
        profileSubmitted: !!(user as any)?.profileSubmittedAt,
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
  const isGoogleAuthenticated = async (req: any, res: any, next: any) => {
    try {
      const googleUser = req.session?.googleUser;
      console.log(`[isGoogleAuthenticated] Session ID: ${req.sessionID}, googleUser: ${googleUser?.email || 'missing'}`);
      if (!googleUser || !googleUser.email) {
        return res.status(401).json({ message: "Unauthorized - Please login with Google" });
      }
      req.googleUser = googleUser;
      // Same server-side approval gate as isFlexibleAuthenticated — brand
      // discovery and the marketplace hang off this middleware, and a
      // waitlisted session must not browse them via curl.
      req.isAdmin = ADMIN_EMAILS.includes(googleUser.email?.toLowerCase?.() ?? googleUser.email);
      const row = await storage.getUserByEmail(googleUser.email);
      if (blockUnapproved(req, res, row ?? undefined)) return;
      next();
    } catch (err: any) {
      console.error(`[Auth] isGoogleAuthenticated failed: ${err?.message || err}`);
      if (!res.headersSent) res.status(500).json({ error: "Authentication check failed" });
    }
  };
  
  // Flexible auth middleware - works with Google OAuth, Replit Auth, or Facebook session
  // Used for endpoints that should work for authenticated users regardless of method
  /** After a treatment window closes, reopen an explicit CONTROL period on
   *  the same fixture so untreated time stays observable rather than
   *  becoming an ambiguous gap. */
  const reopenControlForAssignment = async (assignmentId: number): Promise<void> => {
    try {
      const placement = await storage.getBrandPlacementById(assignmentId);
      if (!placement) return;
      const surfaces = await storage.getDetectedSurfaces(placement.videoId);
      const surface = surfaces.find((sf: any) => sf.id === placement.surfaceId);
      const gid = (surface as any)?.surfaceGroupId as string | undefined;
      if (!gid) return;
      const opened = await storage.openControlPeriod({
        userId: String(placement.creatorUserId),
        surfaceGroupId: gid,
        videoId: placement.videoId,
      });
      if (opened) console.log(`[Measurement] fixture_assignments: control period reopened on ${gid} (video ${placement.videoId})`);
    } catch (e: any) {
      console.warn(`[Measurement] Control reopen failed (non-fatal): ${e?.message}`);
    }
  };

  // Per-user daily scan budget (spend guard; in-memory, single-VM).
  const DAILY_SCAN_LIMIT = Math.max(1, parseInt(process.env.DAILY_SCAN_LIMIT || "25", 10) || 25);
  const dailyScanCounts = new Map<string, { day: string; count: number }>();
  const consumeDailyScanBudget = (userId: string): boolean => {
    const day = new Date().toISOString().slice(0, 10);
    const rec = dailyScanCounts.get(userId);
    if (!rec || rec.day !== day) {
      dailyScanCounts.set(userId, { day, count: 1 });
      return true;
    }
    if (rec.count >= DAILY_SCAN_LIMIT) return false;
    rec.count += 1;
    return true;
  };

  // SERVER-SIDE approval gate. The waitlist used to be enforced only in the
  // browser — a waitlisted user's session cookie worked against every API
  // (scans, imports, brand discovery) via curl/devtools. Any identity branch
  // below that resolves to a users row with isApproved=false is now blocked
  // here, with a small exemption list for what a waitlisted user legitimately
  // needs. Legacy sessions with NO users row (email-keyed pre-migration
  // accounts) are grandfathered — new signups always have a row.
  const APPROVAL_EXEMPT_EXACT = new Set([
    "/api/waitlist/profile-submitted",
  ]);
  const approvalExemptPath = (path: string): boolean =>
    path.startsWith("/api/auth/") || APPROVAL_EXEMPT_EXACT.has(path);
  const blockUnapproved = (req: any, res: any, row: { isApproved?: boolean | null } | undefined): boolean => {
    if (req.isAdmin || !row || row.isApproved !== false || approvalExemptPath(req.path)) return false;
    res.status(403).json({ error: "Your account is pending approval", code: "PENDING_APPROVAL" });
    return true;
  };

  const isFlexibleAuthenticated = async (req: any, res: any, next: any) => {
    try {
      return await isFlexibleAuthenticatedInner(req, res, next);
    } catch (err: any) {
      // Express 4 does not catch async middleware rejections — without this
      // a DB fault here (e.g. schema drift before db:push) HANGS every
      // request instead of failing. Fail loud and fast.
      console.error(`[Auth] isFlexibleAuthenticated failed: ${err?.message || err}`);
      if (!res.headersSent) res.status(500).json({ error: "Authentication check failed" });
    }
  };
  const isFlexibleAuthenticatedInner = async (req: any, res: any, next: any) => {
    const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
    const isDevelopment = process.env.NODE_ENV !== 'production';

    // First try Google OAuth session
    const googleUser = req.session?.googleUser;
    if (googleUser && googleUser.email) {
      req.authEmail = googleUser.email;
      const userRow = await storage.getUserByEmail(googleUser.email);
      req.authUserId = userRow?.id || googleUser.email;
      req.isAdmin = adminEmails.includes(googleUser.email);
      if (blockUnapproved(req, res, userRow)) return;
      return next();
    }

    // Try Replit OIDC Auth (Passport-based)
    if (req.isAuthenticated && req.isAuthenticated() && req.user?.claims) {
      const claims = req.user.claims;
      req.authEmail = claims.email;
      const oidcRow = claims.email ? await storage.getUserByEmail(claims.email) : undefined;
      req.authUserId = claims.sub || oidcRow?.id || claims.email;
      req.isAdmin = adminEmails.includes(claims.email);
      if (blockUnapproved(req, res, oidcRow)) return;
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
        if (blockUnapproved(req, res, user)) return;
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
      // Blanket auto-pass: authenticates ANY caller as the first admin with no
      // credentials. This is the most dangerous bypass in the codebase — its
      // only protection in prod is the esbuild NODE_ENV inlining (a single
      // point of failure). Require an explicit ALLOW_DEV_AUTH=1 opt-in as a
      // second, independent gate so it can never silently reopen.
      if (process.env.ALLOW_DEV_AUTH === '1') {
        const defaultAdmin = adminEmails[0];
        req.authEmail = defaultAdmin;
        req.authUserId = (await storage.getUserByEmail(defaultAdmin))?.id || 1;
        req.isAdmin = true;
        return next();
      }
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
      let pageMetadataById: Record<string, { name?: string; followers_count?: number; accessToken?: string; instagram_business_account?: { id: string } }> = {};

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

        // Fetch each Page's metadata (name, follower count, linked IG, and
        // the PAGE access token — the Page /insights edge rejects user
        // tokens, so the facebook row must carry the page token).
        for (const pageId of derivedPageIds) {
          try {
            const pageRes = await fetch(`https://graph.facebook.com/v25.0/${pageId}?fields=id,name,followers_count,fan_count,access_token,instagram_business_account&access_token=${decryptedFbToken}`);
            const pageData = await pageRes.json();
            if (pageData?.id) {
              pageMetadataById[pageId] = {
                name: pageData.name,
                followers_count: pageData.followers_count ?? pageData.fan_count,
                accessToken: pageData.access_token,
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
          // Page token when we have it (needed for Page /insights); user
          // token only as a last resort so the row isn't tokenless.
          accessToken: meta?.accessToken || decryptedFbToken,
          scopes: ["email", "public_profile", "pages_show_list", "pages_read_engagement", "read_insights", "instagram_basic", "instagram_manage_insights"],
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
            const igRes = await fetch(`https://graph.facebook.com/v25.0/${igId}?fields=username,followers_count&access_token=${decryptedFbToken}`);
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
      if (!(await isSameCreator(String(account.userId), authUserId))) {
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
      if (!(await isSameCreator(String(video.userId), req.authUserId)) && !req.isAdmin) {
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
      if (!(await isSameCreator(String(video.userId), req.authUserId)) && !req.isAdmin) {
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
      if (!(await isSameCreator(String(video.userId), req.authUserId)) && !req.isAdmin) {
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
      const isOwner = await isSameCreator(String(video.userId), req.authUserId);
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
    const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
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
            // ISO-8601 duration (e.g. "PT12M4S") from the stats batch above.
            // The scanner sizes its frame grid off this — leaving it null
            // forces a probe of the full stream before any frames extract.
            duration: stats?.duration || undefined,
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
  // ── First-login onboarding checklist ─────────────────────────────────
  // Progress is derived from REAL state, not click-tracking: has a video,
  // has a completed scan, has a saved placement. Survives logouts and can't
  // be gamed by clicking "next".
  app.get("/api/onboarding/progress", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = req.authUserId;
      // Brand accounts get no creator checklist — report complete so the
      // component renders nothing (Dashboard is reachable via /earnings).
      const viewRole = (req.session as any)?.viewRole;
      const allowedUser = req.authEmail ? await storage.getAllowedUser(req.authEmail).catch(() => undefined) : undefined;
      if ((viewRole || allowedUser?.userType) === "brand") {
        return res.json({ hasConnection: false, hasVideo: false, hasScan: false, hasPlacement: false, dismissedAt: null, complete: true });
      }
      // These were SEQUENTIAL awaits, each paying a full round trip to a
      // remote Postgres, several doing their own nested user lookups — 7.6s
      // measured to return six booleans, on an endpoint the shell loads on
      // EVERY page. Nothing was blocked: the loop was free and the pool sat
      // idle the whole time, because latency x N is neither of those things.
      // They are independent, so they run together.
      const [userRow, videoFlags, placementCount, ytById, ytByEmail] = await Promise.all([
        storage.getUserById(userId).catch(() => undefined),
        storage.getVideoScanFlags(userId, req.authEmail).catch(() => ({ hasVideo: false, hasScan: false })),
        storage.countPlacementsByCreator(req.authEmail).catch(() => 0),
        storage.getYoutubeConnection(userId).catch(() => null),
        req.authEmail ? storage.getYoutubeConnectionByEmail(req.authEmail).catch(() => null) : Promise.resolve(null),
      ]);
      const hasVideo = videoFlags.hasVideo;
      const hasScan = videoFlags.hasScan;
      const hasPlacement = placementCount > 0;
      const hasConnection = !!(userRow?.facebookPageId || userRow?.instagramBusinessId || ytById || ytByEmail);
      res.json({
        hasConnection,
        hasVideo,
        hasScan,
        hasPlacement,
        dismissedAt: (userRow as any)?.onboardingDismissedAt ?? null,
        complete: hasVideo && hasScan && hasPlacement,
      });
    } catch (err: any) {
      console.error("[Onboarding] Progress error:", err?.message);
      res.status(500).json({ error: "Failed to load onboarding progress" });
    }
  });

  // Waitlisted creator confirms they submitted the Airtable profile form.
  // (Path contains "waitlist" → exempt from the approval gate by design.)
  app.post("/api/waitlist/profile-submitted", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      await storage.setProfileSubmitted(req.authUserId);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Waitlist] profile-submitted error:", err?.message);
      res.status(500).json({ error: "Failed to record submission" });
    }
  });

  // ── Go-live capture (measurement spine) ─────────────────────────────
  // Candidates for "which post carries this placement?" — uploads on the
  // creator's connected channel published after the render was ready.
  app.get("/api/placements/:id/go-live-candidates", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const placementId = parseInt(req.params.id);
      if (isNaN(placementId)) return res.status(400).json({ error: "Invalid placement ID" });
      const auth = await authorizePlacement(placementId, req);
      if (!auth.ok) return res.status(auth.status).json({ error: "Not authorized" });

      const row: any = await storage.getPlacementById(placementId);
      if (!row) return res.status(404).json({ error: "Placement not found" });
      const existing = await storage.getPlacementExposureForPlacement(placementId).catch(() => undefined);
      // Candidate window opens when the render was marked ready (or, failing
      // that, when the placement was saved) — anything posted before that
      // can't be carrying this render.
      const since = row.reviewedAt
        ? new Date(row.reviewedAt)
        : row.createdAt
        ? new Date(row.createdAt)
        : new Date(Date.now() - 30 * 86400_000);
      // Search the CONTENT OWNER's channel, not the caller's — otherwise an
      // admin helping a creator gets their own uploads as candidates.
      const ownerVideo = await storage.getVideoById(row.videoId).catch(() => undefined);
      const ownerUserId = ownerVideo ? String((ownerVideo as any).userId) : req.authUserId;
      const { findGoLiveCandidates } = await import("./lib/goLive");
      const candidates = await findGoLiveCandidates(ownerUserId, req.authEmail, since);
      res.json({ candidates, alreadyLive: existing ?? null });
    } catch (err: any) {
      console.error("[GoLive] Candidates error:", err?.message);
      res.status(500).json({ error: "Failed to load candidates" });
    }
  });

  // Creator confirms (or types) where the placement went live. This row is
  // what every downstream audience measurement hangs off.
  app.post("/api/placements/:id/go-live", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const placementId = parseInt(req.params.id);
      if (isNaN(placementId)) return res.status(400).json({ error: "Invalid placement ID" });
      const auth = await authorizePlacement(placementId, req);
      if (!auth.ok) return res.status(auth.status).json({ error: "Not authorized" });

      const { postUrl, platform: bodyPlatform, candidateSource, publishedAt } = req.body || {};
      if (!postUrl || typeof postUrl !== "string") {
        return res.status(400).json({ error: "postUrl required" });
      }
      const { parsePostUrl, recordGoLive } = await import("./lib/goLive");
      const parsed = parsePostUrl(postUrl);
      // A URL we can't resolve to a platform post has no analytics path —
      // which is the entire purpose of the row. Reject rather than store a
      // record that can never be measured.
      if (!parsed || (!parsed.platformPostId && parsed.platform === "other")) {
        return res.status(400).json({
          error: "That link doesn't look like a post we can track. Paste the direct URL to the published video.",
        });
      }

      const placement: any = await storage.getPlacementById(placementId);
      if (!placement) return res.status(404).json({ error: "Placement not found" });

      // Lifecycle gate: only a placement whose render is ready can be live.
      // Without this any owned placement could mint an exposure row that
      // claims an audience saw a render that was never produced.
      const rs = placement.reviewStatus ?? "submitted";
      if (rs !== "render_ready" && rs !== "live") {
        return res.status(400).json({
          error: "This placement isn't ready to go live yet — our team is still reviewing it.",
        });
      }

      const already = await storage.getPlacementExposureForPlacement(placementId).catch(() => undefined);
      if (already) {
        return res.json({ ok: true, exposure: already, alreadyRecorded: true });
      }

      const ownerVideo = await storage.getVideoById(placement.videoId).catch(() => undefined);
      const ownerUserId = ownerVideo ? String((ownerVideo as any).userId) : req.authUserId;
      const callerIsOwner = await isSameCreator(ownerUserId, String(req.authUserId)).catch(() => true);

      // liveAt is when the AUDIENCE could see it — the post's publish time
      // when we know it, not when someone clicked a button in our UI.
      let liveAt: Date | undefined;
      if (publishedAt && !isNaN(Date.parse(String(publishedAt)))) {
        liveAt = new Date(String(publishedAt));
      }

      let exposure;
      try {
        exposure = await recordGoLive({
          ownerUserId,
          placement,
          platform: bodyPlatform || parsed.platform,
          postUrl,
          platformPostId: parsed.platformPostId,
          linkSource: callerIsOwner ? "creator_confirmed" : "admin",
          candidateSource: candidateSource === "channel_match" ? "channel_match" : "manual",
          liveAt,
        });
      } catch (dupErr: any) {
        // Unique index on placement_id — a double-submit races past the
        // check above and lands here. Return the existing row, don't 500.
        const existing = await storage.getPlacementExposureForPlacement(placementId).catch(() => undefined);
        if (existing) return res.json({ ok: true, exposure: existing, alreadyRecorded: true });
        throw dupErr;
      }
      // Lifecycle: render_ready → live. Uses a dedicated setter so the
      // review timestamps (the anchor the candidate search depends on) are
      // not clobbered by a status the review team didn't set.
      await storage.setPlacementLive(placementId).catch(() => {});
      recordCreatorEvent({
        creatorUserId: ownerUserId,
        actorUserId: String(req.authUserId),
        eventType: "placement_went_live",
        videoId: placement.videoId,
        placementId,
        metadata: { platform: bodyPlatform || parsed.platform, candidateSource: candidateSource ?? "manual" },
      });
      res.json({ ok: true, exposure });
    } catch (err: any) {
      console.error("[GoLive] Record error:", err?.message);
      res.status(500).json({ error: "Failed to record go-live" });
    }
  });

  app.post("/api/onboarding/dismiss", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      await storage.setOnboardingDismissed(req.authUserId);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Onboarding] Dismiss error:", err?.message);
      res.status(500).json({ error: "Failed to dismiss" });
    }
  });

  // ── ATTRIBUTION ─────────────────────────────────────────────────────
  // A placement isn't clickable — it's pixels in a frame. The only honest
  // click signal is a link the CREATOR posts alongside the video, tied to
  // the placement. Conversions can only come from the brand's own systems.

  /** Mint (or fetch) the trackable link for a placement. Creator-facing. */
  app.post("/api/placements/:id/link", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const placementId = parseInt(req.params.id);
      if (isNaN(placementId)) return res.status(400).json({ error: "Invalid placement ID" });
      const auth = await authorizePlacement(placementId, req);
      if (!auth.ok) return res.status(auth.status).json({ error: "Placement not found" });

      const existing = await storage.getPlacementLinkForPlacement(placementId);
      if (existing) return res.json({ link: existing, url: `${req.protocol}://${req.get("host")}/go/${existing.slug}` });

      const { destinationUrl } = req.body || {};
      if (!destinationUrl || typeof destinationUrl !== "string" || !/^https?:\/\//i.test(destinationUrl)) {
        return res.status(400).json({ error: "A destination URL (the brand's product page) is required" });
      }

      const placement: any = await storage.getPlacementById(placementId);
      if (!placement) return res.status(404).json({ error: "Placement not found" });
      const video = await storage.getVideoById(placement.videoId).catch(() => undefined);

      // Short, unambiguous slug — no lookalike characters.
      const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
      const slug = Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");

      const link = await storage.createPlacementLink({
        placementId,
        videoId: placement.videoId,
        creatorUserId: String((video as any)?.userId ?? req.authUserId),
        brandProductId: placement.productId ?? null,
        slug,
        destinationUrl,
        utmCampaign: `placement-${placementId}`,
      } as any);
      res.json({ link, url: `${req.protocol}://${req.get("host")}/go/${slug}` });
    } catch (err: any) {
      console.error("[Attribution] Link creation error:", err?.message);
      res.status(500).json({ error: "Could not create link" });
    }
  });

  /** PUBLIC redirect. Records the click, then sends the viewer on with UTMs
   *  attached so the brand sees the same traffic in their own analytics —
   *  two independent records is what makes the number credible to them.
   *  Privacy: no IP, no cookie, no user-agent string is stored. */
  app.get("/go/:slug", async (req: any, res) => {
    try {
      const link = await storage.getPlacementLinkBySlug(String(req.params.slug));
      if (!link || !link.active) return res.redirect(302, "/");

      // Coarse, non-identifying signals only.
      let referrerHost: string | null = null;
      try {
        const ref = req.get("referer");
        if (ref) referrerHost = new URL(ref).hostname.slice(0, 128);
      } catch { /* malformed referer — ignore */ }
      const ua = String(req.get("user-agent") ?? "");
      const deviceClass = /iPad|Tablet/i.test(ua) ? "tablet" : /Mobi|Android|iPhone/i.test(ua) ? "mobile" : ua ? "desktop" : "unknown";
      const country = (req.get("cf-ipcountry") || req.get("x-vercel-ip-country") || null)?.slice(0, 8) ?? null;

      storage.recordLinkClick({ linkId: link.id, placementId: link.placementId, referrerHost, deviceClass, country }).catch(() => {});

      const dest = new URL(link.destinationUrl);
      if (link.utmSource) dest.searchParams.set("utm_source", link.utmSource);
      if (link.utmMedium) dest.searchParams.set("utm_medium", link.utmMedium);
      if (link.utmCampaign) dest.searchParams.set("utm_campaign", link.utmCampaign);
      res.redirect(302, dest.toString());
    } catch (err: any) {
      console.error("[Attribution] Redirect error:", err?.message);
      res.redirect(302, "/");
    }
  });

  /** Brand-side conversion postback. The brand POSTs when an order
   *  completes; we cannot observe purchases on their storefront. Built now
   *  so a brand agreeing to integrate is configuration, not a project. */
  app.post("/api/conversions/:slug", async (req: any, res) => {
    try {
      const link = await storage.getPlacementLinkBySlug(String(req.params.slug));
      if (!link) return res.status(404).json({ error: "Unknown link" });
      if (!link.conversionSecret) {
        return res.status(403).json({ error: "Conversion reporting is not enabled for this link" });
      }
      const presented = req.get("x-fullscale-secret") || req.body?.secret;
      if (presented !== link.conversionSecret) return res.status(403).json({ error: "Invalid secret" });

      const { externalRef, eventType, valueCents, currency, occurredAt } = req.body || {};
      const created = await storage.recordConversion({
        linkId: link.id,
        placementId: link.placementId,
        externalRef: externalRef ? String(externalRef).slice(0, 128) : null,
        eventType: ["purchase", "signup", "add_to_cart", "lead"].includes(eventType) ? eventType : "purchase",
        valueCents: Number.isFinite(Number(valueCents)) ? Math.round(Number(valueCents)) : null,
        currency: currency ? String(currency).slice(0, 8) : null,
        occurredAt: occurredAt && !isNaN(Date.parse(String(occurredAt))) ? new Date(String(occurredAt)) : new Date(),
      });
      // Idempotent: a replayed postback is a success, not a duplicate row.
      res.json({ ok: true, recorded: created, duplicate: !created });
    } catch (err: any) {
      console.error("[Attribution] Conversion error:", err?.message);
      res.status(500).json({ error: "Could not record conversion" });
    }
  });

  // ── DELIVERY REPOSITORY ─────────────────────────────────────────────
  // The finished render coming back to the creator. Team uploads against a
  // placement; the creator sees it in their repository, downloads it,
  // publishes natively, and marks it live — which closes the loop.
  app.post(
    "/api/admin/placements/:id/deliver",
    uploadMiddleware.single("render"),
    async (req: any, res) => {
      try {
        const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
        if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
          return res.status(403).json({ error: "Admin access required" });
        }
        const placementId = parseInt(req.params.id);
        if (isNaN(placementId)) return res.status(400).json({ error: "Invalid placement ID" });
        if (!req.file) return res.status(400).json({ error: "No render file uploaded" });

        const placement: any = await storage.getPlacementById(placementId);
        if (!placement) return res.status(404).json({ error: "Placement not found" });

        const video = await storage.getVideoById(placement.videoId).catch(() => undefined);
        if (!video) return res.status(404).json({ error: "Video not found" });
        const creatorUserId = String((video as any).userId);

        const aspectRatio = String(req.body?.aspectRatio ?? "16:9").slice(0, 16);
        const deliveryNote = req.body?.deliveryNote ? String(req.body.deliveryNote).slice(0, 2000) : null;

        // Renders are NOT public assets — the object key stays out of the
        // public/ prefix so the /storage/* route can't serve it; downloads
        // go through the ownership-gated route below.
        const safeName = `placement-${placementId}-${aspectRatio.replace(/[^0-9a-z]/gi, "")}-${Date.now()}.mp4`;
        const objectKey = `deliveries/${creatorUserId}/${safeName}`;
        await uploadFileToStorage(req.file.path, objectKey);
        try { fs.unlinkSync(req.file.path); } catch { /* temp cleanup */ }

        const render = await storage.deliverPlacementRender({
          placementId,
          videoId: placement.videoId,
          creatorUserId,
          brandProductId: placement.productId ?? null,
          surfaceGroupId: null,
          aspectRatio,
          storagePath: objectKey,
          fileName: req.file.originalname?.slice(0, 255) ?? safeName,
          fileSizeBytes: req.file.size ?? null,
          deliveryNote,
          deliveredByUserId: String(req.authUserId ?? callerEmail),
        } as any);

        // Delivery is what makes render_ready true — before this the status
        // promised a file that didn't exist.
        await storage.updatePlacementReview(placementId, { reviewStatus: "render_ready" }).catch(() => {});

        const creatorRow = await storage.getUserById(creatorUserId).catch(() => undefined);
        if (creatorRow) {
          storage.createNotification({
            userId: creatorRow.id,
            type: "render_delivered",
            title: "Your final render is ready 🎬",
            body: `${(video as any).title ?? "Your video"} — the finished cut with the product is in your Deliveries. Download it, post it, then tell us where so we can track how it performs.`,
            linkPath: "/deliveries",
            metadata: { placementId, renderId: render.id, aspectRatio },
          }).catch(() => {});
        }

        console.log(`[Deliveries] ${callerEmail} delivered render ${render.id} (${aspectRatio} v${render.version}) for placement ${placementId} → creator ${creatorUserId}`);
        res.json({ ok: true, render });
      } catch (err: any) {
        console.error("[Deliveries] Upload error:", err?.message);
        res.status(500).json({ error: err?.message || "Delivery failed" });
      }
    },
  );

  /** The creator's repository: finished renders ready to publish. */
  app.get("/api/deliveries", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const renders = await storage.getDeliveredRendersForCreator(req.authUserId);
      // Batched ahead of the Promise.all: per-row getVideoById here meant N
      // megabyte jsonb rows fetched CONCURRENTLY, each holding one of the ten
      // pool connections and each blocking the event loop on parse.
      const videoMap = await storage.getVideoSummaries(renders.map((r: any) => r.videoId));
      const enriched = await Promise.all(
        renders.map(async (r: any) => {
          const video = videoMap.get(r.videoId);
          const product = r.brandProductId
            ? await storage.getBrandProduct(r.brandProductId).catch(() => undefined)
            : undefined;
          const exposure = await storage.getPlacementExposureForPlacement(r.placementId).catch(() => undefined);
          return {
            ...r,
            videoTitle: (video as any)?.title ?? `Video ${r.videoId}`,
            videoThumbnailUrl: (video as any)?.thumbnailUrl ?? null,
            productName: (product as any)?.name ?? null,
            // Already published? Then the loop is closed for this one.
            publishedAt: exposure?.liveAt ?? null,
            postUrl: exposure?.postUrl ?? null,
          };
        }),
      );
      res.json({ deliveries: enriched });
    } catch (err: any) {
      console.error("[Deliveries] List error:", err?.message);
      res.status(500).json({ error: "Failed to load deliveries" });
    }
  });

  /** Ownership-gated download. Renders live outside the public prefix, so
   *  this is the only way to fetch one. */
  app.get("/api/deliveries/:id/download", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const renderId = parseInt(req.params.id);
      if (isNaN(renderId)) return res.status(400).json({ error: "Invalid render ID" });
      const render = await storage.getPlacementRenderById(renderId);
      if (!render) return res.status(404).json({ error: "Render not found" });

      const owns = await isSameCreator(String(render.creatorUserId), String(req.authUserId)).catch(() => false);
      if (!owns && !req.isAdmin) return res.status(404).json({ error: "Render not found" });

      const { getStorageStream } = await import("./lib/objectStorage");
      const { stream } = getStorageStream(render.storagePath);
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="${render.fileName || `render-${renderId}.mp4`}"`);
      stream.on("error", (err: any) => {
        console.error("[Deliveries] Stream error:", err.message);
        if (!res.headersSent) res.status(404).json({ error: "Render file not found in storage" });
      });
      stream.pipe(res);
      storage.markRenderDownloaded(renderId).catch(() => {});
    } catch (err: any) {
      console.error("[Deliveries] Download error:", err?.message);
      res.status(500).json({ error: "Download failed" });
    }
  });

  // URL-paste import: YouTube, Twitch, TikTok, Twitter/X. The paste flow is
  // the v1 ingest for the three new platforms (no OAuth listing exists for
  // them, and public posts need no credentials for yt-dlp). NOTE: a pasted
  // URL is not proof of ownership — monetization gating on ownership is a
  // product decision tracked separately; imports land in the creator's own
  // library either way.
  app.post("/api/video/import-url", scanLimiter, isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const { url } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "url required" });
    }
    const parsed = parsePlatformUrl(url);
    if (!parsed) {
      return res.status(400).json({
        error: "Unrecognized video URL. Supported: YouTube, Twitch (VODs & clips), TikTok, Twitter/X post links.",
      });
    }
    try {
      // Already imported? Return the existing row untouched — re-pasting a
      // URL must never wipe real metadata or flip a scanned row back to
      // "Pending Scan" (which would also cancel an in-flight scan).
      const storedIdEarly = storedIdFor(parsed.platform, parsed.nativeId);
      const existing = await storage.findVideoIndexRow(userId, storedIdEarly);
      if (existing) {
        return res.json({ video: existing, platform: parsed.platform, alreadyImported: true });
      }

      // Best-effort metadata; the scan probes again if this comes back empty.
      const meta = await probeVideoMeta(parsed.sourceUrl).catch(() => ({ title: null, durationSec: null as number | null }));

      const maxSec = platformMaxDurationSec(parsed.platform);
      if (maxSec && meta.durationSec && meta.durationSec > maxSec) {
        return res.status(400).json({
          error: `${parsed.platform} videos over ${Math.round(maxSec / 60)} minutes aren't supported yet — this one is ~${Math.round(meta.durationSec / 60)} minutes. Try a clip or a shorter VOD.`,
        });
      }

      const storedId = storedIdEarly;
      const video = await storage.upsertVideoIndex({
        userId,
        youtubeId: storedId,
        title: meta.title || `${parsed.platform} video`,
        description: "",
        thumbnailUrl: parsed.platform === "youtube" ? getYouTubeThumbnailWithFallback(parsed.nativeId) : undefined,
        platform: parsed.platform,
        viewCount: 0,
        duration: meta.durationSec ? `PT${meta.durationSec}S` : undefined,
        status: "Pending Scan",
        priorityScore: 50,
      });
      console.log(`[ImportURL] ${parsed.platform} import for user ${userId}: ${storedId} ("${meta.title ?? "untitled"}")`);
      recordCreatorEvent({
        creatorUserId: String(userId),
        actorUserId: String(userId),
        eventType: "video_imported",
        videoId: (video as any)?.id ?? null,
        metadata: { platform: parsed.platform, via: "url_paste" },
      });
      res.json({ video, platform: parsed.platform });
    } catch (err: any) {
      console.error(`[ImportURL] Failed:`, err?.message || err);
      res.status(500).json({ error: "Import failed. Check the URL and try again." });
    }
  });

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
        const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${batch.join(",")}`;
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
            // ISO-8601 duration from the contentDetails part requested above
            // — same reason as the sync path: the scanner needs it for grid
            // sizing, and null means a full stream probe first.
            duration: item.contentDetails?.duration || undefined,
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

  // Diagnostic: which yt-dlp binary is actually being used and what version.
  // Useful for verifying that the self-updater landed and the cached binary
  // is executable.
  //
  // Was open despite the /api/admin/ prefix, and it SPAWNS A PROCESS per call
  // — unauthenticated process-spawn is a cheap denial-of-service, and the
  // response leaks absolute filesystem paths. Admin-gated inline because the
  // shared isAdmin middleware is declared further down this file.
  app.get("/api/admin/yt-dlp-status", async (req: any, res) => {
    const callerEmail = (req.session?.googleUser?.email || req.user?.claims?.email || "").toLowerCase();
    if (!callerEmail || !ADMIN_EMAILS.includes(callerEmail)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const binPath = await getYtDlpPath();
      const proc = require("child_process").spawn(binPath, ["--version"]);
      let out = "";
      let err = "";
      proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      const code: number = await new Promise(resolve => {
        proc.on("close", resolve);
        proc.on("error", () => resolve(-1));
        setTimeout(() => { try { proc.kill(); } catch {} resolve(-2); }, 5000);
      });
      let cacheExists = false;
      let cacheSize = 0;
      try {
        const stat = fs.statSync(`${require("os").tmpdir()}/yt-dlp-latest`);
        cacheExists = true;
        cacheSize = stat.size;
      } catch {}
      res.json({
        binaryPath: binPath,
        version: out.trim() || null,
        exitCode: code,
        stderr: err.trim().slice(0, 500) || null,
        cache: { path: `${require("os").tmpdir()}/yt-dlp-latest`, exists: cacheExists, sizeBytes: cacheSize },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Configure bucket CORS so the browser can PUT directly to GCS resumable
  // upload session URLs without preflight failures. One-time setup per
  // bucket; idempotent. Hit this once after a fresh deploy or whenever the
  // direct-upload path returns "Network error during storage upload".
  app.post("/api/admin/setup-bucket-cors", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userEmail = req.user?.claims?.email || req.user?.email || "";
      const { isAdminEmail } = await import("./lib/adminEmails");
      if (!isAdminEmail(userEmail)) {
        return res.status(403).json({ error: "Admin only" });
      }
      const { ensureBucketCors } = await import("./lib/objectStorage");
      const config = await ensureBucketCors();
      res.json({ ok: true, applied: config });
    } catch (e: any) {
      console.error("[admin/setup-bucket-cors] failed:", e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // SPIKE: Harmonize a product image into a scene at a detected surface's
  // bounding box, using fal.ai ACE++. Returns the harmonized composite URL.
  // Test rig only — not yet wired into the placement UI. Hit with:
  //   POST /api/placement/harmonize
  //   { surfaceId: 137777, productImageUrl: "https://...png", prompt?: "..." }
  app.post("/api/placement/harmonize", isFlexibleAuthenticated, async (req: any, res) => {
    const { surfaceId, productImageUrl, prompt, productPlacementBbox } = req.body || {};
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

    const isOwner = await isSameCreator(String(video.userId), req.authUserId);
    if (!isOwner) return res.status(403).json({ error: "Not authorized" });

    // Resolve the scene frame. Prefer the surface.frameUrl (saved by the
    // scanner with the EXACT filename it uploaded — e.g. "frame_15s.jpg"
    // even when timestamp is 14.7s under scene-first sampling). Fall back
    // to recomputing from timestamp using BOTH Math.round (current scanner)
    // AND Math.floor (legacy scanner) so old surfaces still work.
    const tsFloat = parseFloat(String(surface.timestamp));
    const candidateKeys: string[] = [];
    if (surface.frameUrl) {
      // /storage/uploads/frames/91093/frame_15s.jpg → public/uploads/frames/91093/frame_15s.jpg
      const fromUrl = surface.frameUrl
        .replace(/^\/storage\//, "public/")
        .replace(/^\/uploads\//, "public/uploads/");
      candidateKeys.push(fromUrl);
    }
    candidateKeys.push(`public/uploads/frames/${surface.videoId}/frame_${Math.round(tsFloat)}s.jpg`);
    candidateKeys.push(`public/uploads/frames/${surface.videoId}/frame_${Math.floor(tsFloat)}s.jpg`);

    let sceneBuffer: Buffer | null = null;
    let usedKey = "";
    let lastErr: any = null;
    for (const key of candidateKeys) {
      try {
        sceneBuffer = await readFileFromStorage(key);
        usedKey = key;
        break;
      } catch (err: any) {
        lastErr = err;
      }
    }
    if (!sceneBuffer) {
      return res.status(404).json({
        error: "Scene frame not found in storage",
        detail: lastErr?.message,
        triedKeys: candidateKeys,
      });
    }
    if (usedKey !== candidateKeys[0]) {
      console.log(`[Harmonize] Used fallback frame key: ${usedKey} (first try: ${candidateKeys[0]})`);
    }

    // Get frame dimensions for mask building.
    const meta = await sharp(sceneBuffer).metadata();
    const frameW = meta.width || 1280;
    const frameH = meta.height || 720;

    // Use the client-supplied placement bbox when present (it reflects the
    // user's drag/scale adjustments on the canvas). Fall back to the raw
    // surface bbox if the client didn't compute one — older callers + the
    // standalone diagnostic curl land here.
    const placementBbox = (
      productPlacementBbox &&
      typeof productPlacementBbox.x === "number" &&
      typeof productPlacementBbox.y === "number" &&
      typeof productPlacementBbox.width === "number" &&
      typeof productPlacementBbox.height === "number"
    ) ? {
      x: productPlacementBbox.x,
      y: productPlacementBbox.y,
      width: productPlacementBbox.width,
      height: productPlacementBbox.height,
    } : {
      x: parseFloat(String(surface.boundingBoxX)),
      y: parseFloat(String(surface.boundingBoxY)),
      width: parseFloat(String(surface.boundingBoxWidth)),
      height: parseFloat(String(surface.boundingBoxHeight)),
    };
    console.log(`[Harmonize] bbox source: ${productPlacementBbox ? "client-supplied (transform-aware)" : "surface fallback"}`);

    // mode: "generative" (FLUX Kontext, default — analyzes scene + product
    // and generates native-looking pixels), "ai-3d" (TRELLIS + IC-Light),
    // or "procedural" (legacy sharp-only). Client typically sends
    // "generative" for the main Harmonize button now.
    const requestedMode = req.body?.mode;
    const mode: "generative" | "ai-3d" | "procedural" =
      requestedMode === "generative"
        ? "generative"
        : requestedMode === "ai-3d" || requestedMode === "ai"
          ? "ai-3d"
          : "procedural";

    // Loud diagnostic — surfaces scanned BEFORE the lighting columns
    // existed on detected_surfaces will have NULL here, in which case
    // applyProceduralHarmonization falls through to its directional
    // default (top-left @ 0.85). Logged so we can tell from deploy logs
    // whether a "shadow looks wrong" report is data-missing or code-bug.
    const surfaceLightingDir = (surface as any).lightingDirection ?? null;
    const surfaceLightingInt = (surface as any).lightingIntensity ?? null;
    console.log(
      `[Harmonize] ===> SURFACE ${surfaceId} lighting from DB: ` +
      `direction=${JSON.stringify(surfaceLightingDir)} ` +
      `intensity=${JSON.stringify(surfaceLightingInt)}` +
      (surfaceLightingDir == null ? " (NULL — proc will use directional default)" : ""),
    );

    const result = await harmonizeProductIntoScene({
      sceneImage: sceneBuffer,
      productImage: productImageUrl,
      bbox: placementBbox,
      frameDimensions: { width: frameW, height: frameH },
      prompt,
      mode,
      cameraAngle: (surface as any).cameraAngle ?? undefined,
      // Pass surfaceType so Kontext's prompt can reference it
      // ("place product on the coffee table" reads better than "place
      // product on the surface").
      surfaceType: surface.surfaceType,
      // Pass the surface's detected lighting direction + intensity so
      // procedural can render a directional CAST SHADOW (not just a
      // contact shadow). Without this every shadow drops straight down
      // regardless of where the room's actual light source is.
      lightingDirection: surfaceLightingDir || undefined,
      lightingIntensity: surfaceLightingInt != null
        ? parseFloat(String(surfaceLightingInt))
        : undefined,
    } as any);

    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error, elapsedMs: result.elapsedMs });
    }
    res.json({
      success: true,
      imageUrl: result.imageUrl,
      flatCompositeUrl: result.flatCompositeUrl,
      trellisRenderUrl: result.trellisRenderUrl,
      meshUrl: result.meshUrl,
      kontextOutputUrl: result.kontextOutputUrl,
      // requestedMode is what the client asked for; mode is what actually
      // ran. When the user requests "generative" but Kontext fails, mode
      // comes back "procedural" — the client should surface that so the
      // user knows the better path didn't execute.
      requestedMode: mode,
      mode: result.mode,
      fellBack: mode !== result.mode,
      warning: result.error,
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

    const isOwner = await isSameCreator(String(video.userId), req.authUserId);
    if (!isOwner) return res.status(403).json({ error: "Not authorized" });

    let sourcePath: string;
    try {
      sourcePath = await getSourcePath(video);
    } catch (err: any) {
      console.error(`[Video Source] ${videoId}: ${err.message}`);
      return res.status(502).json({ error: "Source unavailable", detail: err.message });
    }

    // Range request handling — required for <video> seeking and partial loads.
    // Under cap pressure the cache sweeper can evict the file between
    // getSourcePath returning and the stat — re-resolve once (fresh
    // download/promote) and retry before giving up.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sourcePath);
    } catch (statErr: any) {
      if (statErr?.code !== "ENOENT") throw statErr;
      try {
        sourcePath = await getSourcePath(video);
      } catch (err: any) {
        console.error(`[Video Source] ${videoId}: ${err.message}`);
        return res.status(502).json({ error: "Source unavailable", detail: err.message });
      }
      stat = fs.statSync(sourcePath);
    }
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
    // Background self-heal: if any IG/FB videos in this user's library still
    // hold expired CDN URLs (or null thumbnails), re-fetch via Graph API and
    // cache to GCS. Per-user 1h cooldown so this doesn't slam the API on
    // every page load. React Query will pick up the new URLs on its next
    // refetch — no manual sync click required.
    maybeRefreshSocialThumbnailsInBackground(authUserId);
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

  // Public demo endpoint - returns STATIC demo videos; admins additionally
  // get real videos with local files (with a Local File badge) for pitch demos.
  // Real library rows carry cross-user titles/emails/file paths and must never
  // reach an unauthenticated caller.
  app.get("/api/demo/videos", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      const { isAdminEmail } = await import("./lib/adminEmails");
      if (!isAdminEmail(callerEmail)) {
        const staticOnly = STATIC_DEMO_VIDEOS.map((v: any) => ({ ...v, fileExists: false, file_exists: false }));
        return res.json({ videos: staticOnly, total: staticOnly.length });
      }

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
  app.post("/api/video-scan/:id", scanLimiter, isFlexibleAuthenticated, async (req: any, res) => {
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
    const isOwner = await isSameCreator(String(video.userId), req.authUserId);
    if (!isOwner) {
      console.log(`[BACKEND] ERROR: Unauthorized - video belongs to ${video.userId}`);
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Single-flight check — if a scan is already running for this video,
    // tell the user instead of stacking another scan or wiping surfaces.
    // The actual lock is enforced inside processVideoScan; this just gives
    // a clearer response when the user clicks Scan repeatedly.
    const { isVideoScanInFlight } = await import("./scanner_v2");
    if (isVideoScanInFlight(videoId)) {
      console.log(`[BACKEND] Scan already running for video ${videoId} — declining duplicate request`);
      return res.json({
        success: true,
        videoId,
        alreadyRunning: true,
        message: "A scan is already running for this video. Wait for it to complete before re-scanning.",
      });
    }

    // Per-user daily scan cap: every scan buys Gemini + Florence-2 (+ the
    // editorial pipeline's Whisper/Claude on success) with no other spend
    // guard. Consumed only for scans that actually DISPATCH (after the
    // single-flight no-op check). In-memory on a single VM; resets on
    // redeploy.
    if (!req.isAdmin && !consumeDailyScanBudget(String(req.authUserId))) {
      return res.status(429).json({
        error: `Daily scan limit reached (${DAILY_SCAN_LIMIT}/day). It resets at midnight UTC — or reach out if you legitimately need more.`,
      });
    }

    console.log(`[BACKEND] Starting background scan process...`);

    setImmediate(async () => {
      try {
        console.log(`[BACKEND] Background scan starting for video ${videoId}`);
        // forceRescan=true allows retry on failed/empty scans. The wipe of
        // prior surfaces now happens ONLY after successful completion (see
        // scanner_v2.ts processVideoScanInner) so a failed retry preserves
        // any earlier good results.
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
  app.post("/api/video-scan/batch", scanLimiter, isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authEmail;
    let limit = parseInt(req.query.limit as string) || 5;

    // Batch scans draw from the same daily budget as single scans —
    // otherwise "Scan All" was a free bypass of the spend guard.
    if (!req.isAdmin) {
      let allowed = 0;
      while (allowed < limit && consumeDailyScanBudget(String(req.authUserId))) allowed++;
      if (allowed === 0) {
        return res.status(429).json({
          error: `Daily scan limit reached (${DAILY_SCAN_LIMIT}/day). It resets at midnight UTC.`,
        });
      }
      limit = allowed;
    }

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
  // Admin: audit + repair upload filePaths against Object Storage. Replit's
  // deploy filesystem is ephemeral, so legacy uploads written to local disk
  // vanish on redeploy while their bytes may still live in GCS under a
  // derivable key. For each fullscale upload this checks candidate GCS keys,
  // rewrites filePath to the durable "/storage/..." form when the object
  // exists, and marks genuinely-missing ones with an honest status instead of
  // leaving them to 404 silently. Idempotent; safe to run repeatedly.
  app.post("/api/admin/backfill-storage-paths", isFlexibleAuthenticated, async (req: any, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: "Admin access required" });
    const dryRun = req.query.dry === "1" || req.body?.dryRun === true;

    try {
      // Audit every video (admin-only endpoint). Import rows are skipped below.
      const videos = await storage.getAllVideos();

      const report = { scanned: 0, alreadyOk: 0, repaired: 0, missing: 0, skippedImports: 0, changes: [] as any[] };

      for (const v of videos) {
        // Only fullscale uploads have a durable-file expectation. IG/YT/FB
        // imports legitimately have filePath = null (light-cloud) — skip them.
        const fp = (v as any).filePath as string | null;
        if (!fp) { report.skippedImports++; continue; }
        report.scanned++;

        // Candidate object keys, in priority order.
        const base = fp.split("/").pop() || "";
        const candidates = [
          fp.startsWith("/storage/") ? objectKeyFromServeUrl(fp) : null,
          fp.replace(/^\.?\/?public\//, "public/"),
          `public/videos/${base}`,
          `public/uploads/${base}`,
        ].filter(Boolean) as string[];

        let foundKey: string | null = null;
        for (const key of candidates) {
          try { if (await fileExistsInStorage(key)) { foundKey = key; break; } } catch { /* ignore */ }
        }

        if (foundKey) {
          const durablePath = storageServeUrl(foundKey); // "/storage/..."
          if (fp === durablePath) { report.alreadyOk++; continue; }
          report.repaired++;
          report.changes.push({ id: v.id, from: fp, to: durablePath, foundKey });
          if (!dryRun) await storage.updateVideoIndex(v.id, { filePath: durablePath });
        } else {
          report.missing++;
          report.changes.push({ id: v.id, from: fp, status: "Source Missing — Re-upload", triedKeys: candidates });
          // Only mark uploads (not imports) and don't clobber an in-progress state.
          if (!dryRun && (v as any).platform === "fullscale") {
            await storage.updateVideoStatus(v.id, "Source Missing — Re-upload");
          }
        }
      }

      console.log(`[Backfill Storage] scanned=${report.scanned} ok=${report.alreadyOk} repaired=${report.repaired} missing=${report.missing}${dryRun ? " (DRY RUN)" : ""}`);
      res.json({ success: true, dryRun, ...report });
    } catch (err: any) {
      console.error("[Backfill Storage] Error:", err);
      res.status(500).json({ success: false, error: err.message || "Backfill failed" });
    }
  });

  app.post("/api/videos/:id/update-path", isFlexibleAuthenticated, async (req: any, res) => {
    // Was previously UNAUTHENTICATED — any anonymous caller could repoint
    // filePath/thumbnailUrl on admin-owned (flagship/showcase) videos:
    // defacement, or point thumbnails at attacker images shown on public
    // profiles. Now requires an authenticated admin, and validates the paths
    // stay inside the app's own storage namespace.
    if (!req.isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const { filePath, thumbnailUrl } = req.body;
    if (!filePath && !thumbnailUrl) {
      return res.status(400).json({ error: "Must provide filePath or thumbnailUrl" });
    }

    // Constrain paths to the app's storage namespace so this can't be used to
    // repoint media at an external URL or an arbitrary object key.
    const isSafePath = (p: string) =>
      typeof p === "string" && (p.startsWith("/storage/") || p.startsWith("/public/") || p.startsWith("public/"));
    if (filePath && !isSafePath(filePath)) {
      return res.status(400).json({ error: "filePath must be within the storage namespace" });
    }
    if (thumbnailUrl && !isSafePath(thumbnailUrl)) {
      return res.status(400).json({ error: "thumbnailUrl must be within the storage namespace" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
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
  app.post("/api/admin-scan/:id", scanLimiter, isFlexibleAuthenticated, async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    const isOwner = await isSameCreator(String(video.userId), req.authUserId);
    if (!isOwner) {
      return res.status(403).json({ error: "Not authorized to scan this video" });
    }

    console.log(`[Sync Scan] Starting scan for video ${videoId}: "${video.title}" (user ${req.authEmail})`);

    try {
      const result = await processVideoScan(videoId, true);
      console.log(`[Sync Scan] Scan complete for ${videoId}:`, result);
      // Surface scan-level failures as non-2xx so the client stops treating a
      // failed scan as success. Previously this always returned 200 with
      // { success: true } even when result.success was false, so the modal
      // showed "complete" over a scan that produced nothing.
      if (!result.success) {
        return res.status(422).json({ success: false, result, error: result.error || "Scan produced no surfaces" });
      }
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
    const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
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

  // ─── Chunked Upload (the real fix for >1.4 GB files on Replit) ──────────
  //
  // Replit's Autoscale deploy proxy kills request bodies after ~5min. At
  // observed 4.8 MB/s throughput that caps single-request uploads at ~1.4 GB.
  // The chunked flow splits the file client-side and the server relays each
  // chunk into a GCS resumable upload session it holds open per-process.
  //
  //   POST /api/upload/chunked/init      → { sessionId, chunkSize }
  //   PUT  /api/upload/chunked/:id       → 200 { received }, or 200 { done } on last chunk
  //   POST /api/upload/chunked/:id/finalize → { videoId } once GCS finalizes

  app.post("/api/upload/chunked/init", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { filename, contentType, fileSize } = req.body || {};
      if (!filename || !contentType || typeof fileSize !== "number" || fileSize <= 0) {
        return res.status(400).json({ error: "Body must include { filename, contentType, fileSize }" });
      }
      const ext = path.extname(filename).toLowerCase();
      const allowedExt = [".mp4", ".mov", ".webm", ".avi", ".m4v"];
      if (!allowedExt.includes(ext)) {
        return res.status(400).json({ error: `Unsupported file type: ${ext}. Allowed: ${allowedExt.join(", ")}` });
      }
      const MAX = 4 * 1024 * 1024 * 1024;
      if (fileSize > MAX) {
        return res.status(413).json({ error: `File too large: ${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB (max 4 GB)` });
      }
      const { createUploadSession } = await import("./lib/chunkedUpload");
      const session = await createUploadSession({ filename, contentType, totalSize: fileSize });
      // GCS resumable uploads accept chunks in multiples of 256 KB. 8 MB is a
      // good balance: ~1.5s per chunk at 4.8 MB/s, well under the proxy timeout.
      const CHUNK_SIZE = 8 * 1024 * 1024;
      res.json({ sessionId: session.sessionId, chunkSize: CHUNK_SIZE });
    } catch (err: any) {
      console.error("[upload/chunked/init] error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Failed to start upload session" });
    }
  });

  // PUT raw chunk bytes. Headers required:
  //   Content-Range: bytes <start>-<end>/<total or *>
  // The handler reads the request body into a Buffer, then PUTs it to the
  // bound GCS resumable session URL with that same Content-Range. Express
  // global json/urlencoded parsers skip non-matching content-types so the
  // request stream reaches us untouched here.
  app.put("/api/upload/chunked/:sessionId", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { sessionId } = req.params;
      const contentRange = req.header("content-range") || "";
      const m = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
      if (!m) {
        return res.status(400).json({ error: `Invalid Content-Range header: '${contentRange}' — expected 'bytes <start>-<end>/<total>'` });
      }
      const startByte = Number(m[1]);
      const endByte = Number(m[2]);
      const totalToken = m[3];
      const isFinal = totalToken !== "*" && Number(totalToken) === endByte + 1;

      const { getUploadSession, relayChunkToGcs } = await import("./lib/chunkedUpload");
      const session = getUploadSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: `Session ${sessionId} not found (expired or never created)` });
      }
      if (session.finalized) {
        return res.status(409).json({ error: "Session already finalized" });
      }

      // Buffer the chunk in RAM (max ~8 MB, set by /init).
      const chunks: Buffer[] = [];
      let totalLen = 0;
      await new Promise<void>((resolve, reject) => {
        req.on("data", (c: Buffer) => { chunks.push(c); totalLen += c.length; });
        req.on("end", () => resolve());
        req.on("error", reject);
      });
      const chunk = Buffer.concat(chunks, totalLen);

      const expectedLen = endByte - startByte + 1;
      if (chunk.length !== expectedLen) {
        return res.status(400).json({ error: `Chunk length mismatch: header says ${expectedLen}, body is ${chunk.length}` });
      }

      const result = await relayChunkToGcs({ session, chunk, startByte, isFinal });
      res.json({
        sessionId,
        bytesReceived: result.bytesReceivedNow,
        totalBytes: session.totalSize,
        finalized: result.finalized,
      });
    } catch (err: any) {
      console.error("[upload/chunked/:id] error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Chunk relay failed" });
    }
  });

  // After the last chunk: create the videoIndex row + fire scan/editorial.
  // Separate endpoint so the chunk loop on the client doesn't have to know
  // about title/category/etc — it only ships bytes.
  app.post("/api/upload/chunked/:sessionId/finalize", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { sessionId } = req.params;
      const { title: rawTitle, category, subcategory } = req.body || {};
      const userId = req.authEmail || req.googleUser?.email;

      const { getUploadSession, deleteUploadSession } = await import("./lib/chunkedUpload");
      const session = getUploadSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: `Session ${sessionId} not found` });
      }
      if (!session.finalized) {
        return res.status(409).json({ error: `Upload not complete: ${session.bytesReceived}/${session.totalSize} bytes received` });
      }

      const title = (rawTitle && String(rawTitle).trim()) || session.filename.replace(/\.[^/.]+$/, "");
      const uploadVideoId = `upload-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      const video = await storage.insertVideo({
        userId,
        youtubeId: uploadVideoId,
        title,
        description: `Uploaded video: ${session.filename}`,
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
        filePath: session.serveUrl,
      });

      console.log(`[upload/chunked/finalize] Video ${video.id} created: ${session.filename} (${(session.totalSize / 1024 / 1024).toFixed(1)} MB) → ${session.serveUrl}`);

      // Reply BEFORE background work so client modal closes promptly.
      res.json({
        success: true,
        video: {
          id: video.id,
          title: video.title,
          youtubeId: uploadVideoId,
          videoUrl: session.serveUrl,
          status: video.status,
          platform: "fullscale",
        },
      });

      deleteUploadSession(sessionId);

      // Fire scan + editorial pipeline in background.
      storage.updateVideoEditorialStatus(video.id, "pending").catch((e: any) =>
        console.warn(`[upload/chunked/finalize] editorial-pending failed: ${e?.message}`)
      );
      extractThumbnailForVideo(video.id)
        .then(thumbUrl => { if (thumbUrl) console.log(`[upload/chunked/finalize] Thumbnail: ${thumbUrl}`); })
        .catch(() => {});
      // Editorial pipeline auto-fires from scanner_v2 on scan completion.
      processVideoScan(video.id, true).then(result => {
        console.log(`[upload/chunked/finalize] Auto-scan complete for ${video.id}: ${result.surfacesDetected} surfaces`);
      }).catch(err => console.error(`[upload/chunked/finalize] Auto-scan failed:`, err?.message));
    } catch (err: any) {
      console.error("[upload/chunked/:id/finalize] error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Failed to finalize upload" });
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

      // Fire scan; the editorial pipeline auto-fires from scanner_v2 on
      // scan completion.
      processVideoScan(video.id, true).then(result => {
        console.log(`[UPLOAD/complete] Auto-scan complete for ${video.id}: ${result.surfacesDetected} surfaces`);
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
  // Streaming upload: parse the multipart body with busboy and pipe the file
  // part DIRECTLY into Object Storage via createWriteStream. No /tmp roundtrip.
  // Replaces the previous multer.diskStorage handler that buffered the entire
  // file to /tmp first — that path stalled at ~80% on Replit deploy when /tmp
  // filled up (source cache + frame extraction + multer all share /tmp), and
  // the resulting TCP backpressure froze the browser upload progress.
  app.post("/api/upload", uploadLimiter, isFlexibleAuthenticated, async (req: any, res) => {
    const uploadStartedAt = Date.now();
    // Phase timestamps for end-to-end timing diagnostics. User has been
    // reporting "upload takes forever on small files" — these markers let
    // us pin down where time is actually going (network in, GCS out,
    // DB insert, or just the polling on the client). t0 = request hit.
    const phaseLog = (phase: string) => {
      const elapsed = ((Date.now() - uploadStartedAt) / 1000).toFixed(2);
      console.log(`[UPLOAD] @ ${elapsed}s — ${phase}`);
    };
    phaseLog("request received");
    console.log(`[UPLOAD] User: ${req.authEmail || req.googleUser?.email}`);
    console.log(`[UPLOAD] Content-Length: ${req.headers["content-length"] || "unknown"} bytes`);
    const userId = req.authEmail || req.googleUser?.email;

    let Busboy: any;
    try {
      Busboy = (await import("busboy")).default;
    } catch (err: any) {
      console.error(`[UPLOAD] busboy import failed:`, err?.message);
      return res.status(500).json({ error: "Upload parser unavailable" });
    }

    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB cap (matches prior multer limit)
    });

    const fields: Record<string, string> = {};
    let uploadPromise: Promise<void> | null = null;
    let uploadResult: { storageUrl: string; objectKey: string; filename: string; size: number } | null = null;
    let uploadError: Error | null = null;
    let fileSeen = false;
    let bytesReceived = 0;
    let responseSettled = false;
    const settle = (fn: () => void) => {
      if (responseSettled || res.headersSent) return;
      responseSettled = true;
      fn();
    };

    bb.on("field", (name: string, val: string) => {
      fields[name] = val;
    });

    bb.on("file", (fieldname: string, fileStream: NodeJS.ReadableStream, info: any) => {
      if (fieldname !== "video") {
        // Not the file we care about — drain to allow the stream to finish.
        fileStream.resume();
        return;
      }
      fileSeen = true;
      const originalName: string = info?.filename || `upload-${Date.now()}.mp4`;
      const mimeType: string = info?.mimeType || info?.mime || "video/mp4";
      const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${Date.now()}-${safeName}`;
      const objectKey = `public/videos/${filename}`;

      console.log(`[UPLOAD] File: ${originalName} (mime: ${mimeType}) → ${objectKey}`);

      // Diagnostic logging — every 5MB for small files, every 25MB for
      // big ones, plus the first byte marker. Small-file uploads need
      // visibility too (the "upload takes forever on small video" report
      // came from <30MB files where the prior 25MB-only logging was
      // effectively silent).
      let lastLoggedMB = 0;
      let lastDataAt = Date.now();
      let firstByteAt: number | null = null;
      const LOG_INTERVAL_MB = 5;
      fileStream.on("data", (chunk: Buffer) => {
        bytesReceived += chunk.length;
        lastDataAt = Date.now();
        if (firstByteAt === null) {
          firstByteAt = Date.now();
          phaseLog(`first byte received (${chunk.length} bytes)`);
        }
        const currentMB = Math.floor(bytesReceived / (1024 * 1024));
        if (currentMB - lastLoggedMB >= LOG_INTERVAL_MB) {
          const sinceFirstByte = ((Date.now() - firstByteAt) / 1000) || 0.001;
          console.log(`[UPLOAD] busboy received ${currentMB} MB (${((bytesReceived / 1024 / 1024) / sinceFirstByte).toFixed(1)} MB/s in-stream)`);
          lastLoggedMB = currentMB;
        }
      });
      fileStream.on("end", () => {
        phaseLog(`busboy file stream ENDED at ${(bytesReceived / 1024 / 1024).toFixed(2)} MB`);
      });
      fileStream.on("error", (err: any) => {
        console.error(`[UPLOAD] busboy file stream ERROR:`, err?.message || err);
      });

      // Watchdog: if no bytes flow for 90s, fail the request loudly so we
      // see the silent-hang in the log and the client gets a real error.
      // Wrapped in try/catch and runs unref'd so it never crashes the process.
      const watchdog = setInterval(() => {
        try {
          const sinceLast = Date.now() - lastDataAt;
          if (sinceLast > 90_000) {
            clearInterval(watchdog);
            console.error(`[UPLOAD] WATCHDOG: no data for ${(sinceLast / 1000).toFixed(0)}s after ${(bytesReceived / 1024 / 1024).toFixed(2)} MB — aborting`);
            try { (fileStream as any).destroy?.(new Error(`Upload watchdog: no data for ${(sinceLast / 1000).toFixed(0)}s after ${(bytesReceived / 1024 / 1024).toFixed(2)} MB`)); } catch { /* swallow */ }
          }
        } catch (err: any) {
          console.error(`[UPLOAD] watchdog error (non-fatal):`, err?.message || err);
        }
      }, 15_000);
      (watchdog as any).unref?.();

      // Store outcome in variables (NOT a thrown rejection) so we never leak
      // an unhandled rejection. The .then handler always resolves the outer
      // promise; success/failure is read from uploadResult / uploadError below.
      uploadPromise = uploadStreamToStorage(fileStream, objectKey, mimeType).then(
        storageUrl => {
          clearInterval(watchdog);
          const elapsed = (Date.now() - uploadStartedAt) / 1000;
          phaseLog(`GCS write complete (${(bytesReceived / 1024 / 1024).toFixed(2)} MB)`);
          console.log(`[UPLOAD] Streamed to Object Storage: ${storageUrl} — ${((bytesReceived / 1024 / 1024) / elapsed).toFixed(1)} MB/s overall`);
          uploadResult = { storageUrl, objectKey, filename, size: bytesReceived };
        },
        err => {
          clearInterval(watchdog);
          console.error(`[UPLOAD] uploadStreamToStorage failed at ${(bytesReceived / 1024 / 1024).toFixed(2)} MB:`, err?.message || err);
          uploadError = err instanceof Error ? err : new Error(String(err));
        },
      );
    });

    bb.on("error", async (err: any) => {
      console.error(`[UPLOAD] busboy parse error:`, err?.message || err);
      // If an upload is in flight, wait for it to settle so we don't leak
      // a rejection to the process when busboy aborts the stream.
      if (uploadPromise) { try { await uploadPromise; } catch { /* swallowed */ } }
      settle(() => res.status(400).json({ error: `Upload parse error: ${err?.message || err}` }));
    });

    bb.on("close", async () => {
      try {
        if (!fileSeen || !uploadPromise) {
          settle(() => res.status(400).json({ error: "No video file uploaded (expected multipart field 'video')" }));
          return;
        }

        // Always await the upload — uploadPromise resolves regardless of
        // success (outcome is in uploadResult / uploadError).
        await uploadPromise;

        if (uploadError || !uploadResult) {
          settle(() => res.status(500).json({
            error: uploadError?.message || "Upload failed",
            bytesReceived,
          }));
          return;
        }

        const { storageUrl, filename, size } = uploadResult;

        const title = fields.title || filename.replace(/\.[^/.]+$/, "");
        const category = fields.category || "Other";
        const subcategory = fields.subcategory || null;
        const uploadVideoId = `upload-${Date.now()}-${Math.random().toString(36).substring(7)}`;

        const video = await storage.insertVideo({
          userId,
          youtubeId: uploadVideoId,
          title,
          description: `Uploaded video: ${filename}`,
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

        phaseLog(`DB insert complete, video.id=${video.id}`);
        console.log(`[UPLOAD] Video inserted with ID: ${video.id} (${(size / 1024 / 1024).toFixed(2)} MB)`);

        // Extract thumbnail SYNCHRONOUSLY before responding. User feedback:
        // "I really hate that the My Library doesn't pull a thumbnail into
        // the container immediately." Was running in background → library
        // card showed blank for up to 15s while React Query polled.
        //
        // 15s timeout (was 5s). Extraction has to round-trip: download
        // video back from GCS (~3-5s for 50MB), ffmpeg seek + frame
        // (~1-2s), upload thumbnail to GCS (~1s). 5s was getting hit
        // before extraction could complete. 15s covers >95% of uploads.
        // Promise.race still allows the slow path to update the DB after
        // the response is sent — library's next 15s poll picks it up.
        let thumbnailUrl: string | null = null;
        try {
          // Capture the in-flight extraction so it keeps running after we
          // detach. Sets the DB column when it eventually finishes, so the
          // library's next refetch shows the thumbnail even if we time out.
          const extractionPromise = extractThumbnailForVideo(video.id);
          extractionPromise.catch(() => {}); // prevent unhandled rejection if we detach
          thumbnailUrl = await Promise.race([
            extractionPromise,
            new Promise<null>(resolve => setTimeout(() => {
              console.warn(`[UPLOAD] Thumbnail extraction >15s — responding without; DB will get it when ffmpeg finishes`);
              resolve(null);
            }, 15000)),
          ]);
          if (thumbnailUrl) {
            phaseLog(`thumbnail extracted: ${thumbnailUrl}`);
          }
        } catch (err: any) {
          console.warn(`[UPLOAD] Thumbnail extraction failed: ${err?.message}`);
        }

        // Reply to the client now — modal closes, library card has a real
        // thumbnailUrl (if extraction succeeded within the timeout).
        phaseLog(`response sent — upload phase done (${(size / 1024 / 1024).toFixed(2)} MB)`);
        settle(() => res.json({
          success: true,
          video: {
            id: video.id,
            title: video.title,
            youtubeId: uploadVideoId,
            videoUrl: storageUrl,
            thumbnailUrl: thumbnailUrl || null,
            status: video.status,
            platform: "fullscale",
          },
          message: "Video uploaded successfully. Click 'Scan' to analyze for ad placements.",
        }));

        // Mark editorial pipeline as pending immediately so UI can poll
        storage.updateVideoEditorialStatus(video.id, "pending").catch((e: any) =>
          console.warn(`[UPLOAD] Failed to set editorial pending: ${e?.message}`)
        );

        // Editorial pipeline auto-fires from scanner_v2 on scan completion.
        processVideoScan(video.id, true).then(result => {
          console.log(`[UPLOAD] Auto-scan complete for ${video.id}: ${result.surfacesDetected} surfaces`);
        }).catch(err => {
          console.error(`[UPLOAD] Auto-scan failed for ${video.id}:`, err.message);
        });
      } catch (error: any) {
        console.error(`[UPLOAD] Error:`, error?.message || error);
        settle(() => res.status(500).json({ error: error?.message || "Failed to save video" }));
      }
    });

    // Last-resort safety net: if the request stream itself errors (client
    // disconnected mid-upload, proxy killed the connection, etc), still
    // settle the response and absorb any pending upload promise so we never
    // leak an unhandled rejection.
    req.on("error", async (err: any) => {
      console.error(`[UPLOAD] Request stream error after ${(bytesReceived / 1024 / 1024).toFixed(2)} MB:`, err?.message || err);
      if (uploadPromise) { try { await uploadPromise; } catch { /* swallowed */ } }
      settle(() => res.status(500).json({ error: `Connection error: ${err?.message || err}`, bytesReceived }));
    });

    req.pipe(bb);
  });

  // Get single video with metadata (for Remix Engine)
  //
  // Was fully open AND returned `...video` — the entire row for any integer
  // id. That let an anonymous visitor walk ids 1..N and read the whole
  // library's metadata, and it shipped scene_index/scene_inventory (megabytes
  // of jsonb, parsed synchronously) to an unauthenticated caller, so it was a
  // free event-loop stall as well as a data leak.
  app.get("/api/video/:id/details", mediaLimiter, softAuth, async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    try {
      const video = await storage.getVideoById(videoId);
      if (!video) {
        return res.status(404).json({ error: "Video not found" });
      }
      if (!(await canServeVideo(req, (video as any).userId))) {
        return res.status(404).json({ error: "Video not found" });
      }

      const surfaceCount = await storage.getSurfaceCountByVideo(videoId);

      // sceneInventory always goes — nothing reads it from THIS endpoint
      // (BrandPlacementRequestModal gets it from the surfaces endpoint).
      //
      // sceneIndex and sceneBoundaries stay for signed-in callers:
      // PlacementPreviewModal builds its scene gate from sceneIndex.shots, and
      // without it sceneIdFor() returns null, the hard clamp at
      // PlacementPreviewModal.tsx:1778 compares null against a real sceneId,
      // and the product renders at opacity 0 for the entire clip with the
      // "different scene" badge pinned on. Anonymous callers have no preview
      // modal, so they get the lean payload.
      const { sceneIndex, sceneInventory, sceneBoundaries, ...lean } = video as any;
      const anonymous = !(req.authEmail || req.authUserId);
      res.json({
        ...lean,
        ...(anonymous ? {} : { sceneIndex, sceneBoundaries }),
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

  app.get("/api/video/:id/frame/:timestamp", mediaLimiter, softAuth, async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    // Clamp: negative timestamps and absurd seeks are attacker input, not use
    // cases. Each distinct timestamp mints a new frame file on disk.
    const timestamp = Math.max(0, Math.min(parseInt(req.params.timestamp) || 0, 21_600));
    if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

    // Projected row — no scene jsonb on an unauthenticated hot path.
    const video = (await storage.getVideoSummaries([videoId])).get(videoId);
    if (!video) return res.status(404).json({ error: "Video not found" });
    if (!(await canServeVideo(req, video.userId))) {
      return res.status(404).json({ error: "Video not found" });
    }

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

  // Stream a video file by ID. Logged-in users pass; anonymous visitors only
  // reach videos owned by featured (public-profile) creators — see the media
  // access policy above the frame endpoint.
  app.get("/api/video/:id/stream", mediaLimiter, softAuth, async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });

    try {
      const video = (await storage.getVideoSummaries([videoId])).get(videoId);
      if (!video || !video.filePath) {
        return res.status(404).json({ error: "Video file not found" });
      }
      if (!(await canServeVideo(req, video.userId))) {
        return res.status(404).json({ error: "Video file not found" });
      }

      // Try Object Storage first (Replit). Resolve the object key handling
      // BOTH shapes: the new "/storage/..." serve URL (via objectKeyFromServeUrl)
      // and the legacy "./public/..." / "public/..." path. The old code only
      // stripped a /public/ prefix, so "/storage/videos/x.mp4" fell through to
      // a GCS lookup for a key literally named "/storage/videos/x.mp4" (miss)
      // and then 404'd — the durable file was there under "public/videos/x.mp4"
      // the whole time.
      const objectKey = video.filePath.startsWith("/storage/")
        ? objectKeyFromServeUrl(video.filePath)
        : video.filePath.replace(/^\.?\/?public\//, "public/");
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
  // Best-effort auth that NEVER rejects. Populates req.authUserId/authEmail
  // when a session is present so downstream owner-aware logic can work, but
  // anonymous callers still pass through (used by endpoints that are public
  // for brands but want owner-only behavior for the creator).

  app.get("/api/video/:id/surfaces", softAuth, async (req: any, res) => {
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

    // Pull scene-cut boundaries so the client can constrain placements to
    // the same shot they were placed in. Format: array of seconds (start of
    // each new shot after the first). Empty/null = single shot.
    const sceneBoundariesRaw = (video as any).sceneBoundaries;
    const sceneBoundaries: number[] = Array.isArray(sceneBoundariesRaw)
      ? sceneBoundariesRaw.filter((t: any) => typeof t === "number" && Number.isFinite(t))
      : [];

    // Same scene-block math as the server-side scanner — kept in sync so
    // the block IDs we emit match what cluster/temporal grouping used.
    const sceneBlockFor = (t: number): number => {
      if (sceneBoundaries.length === 0 || t < 0) return 0;
      for (let i = 0; i < sceneBoundaries.length; i++) {
        if (t < sceneBoundaries[i]) return i;
      }
      return sceneBoundaries.length;
    };

    // Scene-block inventory: canonical physical surfaces grouped by
    // recurring scene class, with occurrence counts and screen time. This
    // is the authoritative structure for the scene modal — the flat
    // per-row `surfaces` list stays for approval controls and legacy
    // videos. Null for videos scanned before the inventory existed;
    // clients must fall back to the flat view in that case.
    const sceneInventory = (video as any).sceneInventory ?? null;

    // Numbered-fixture labels: groupId → displayLabel ("Wall 2"), derived
    // once at inventory build time and rendered verbatim by clients. Null
    // when the video predates labels or a row's group isn't in the
    // inventory — clients fall back to surfaceType.
    const labelByGroup = new Map<string, string>();
    if (sceneInventory && Array.isArray(sceneInventory.scenes)) {
      for (const scene of sceneInventory.scenes) {
        if (!scene || !Array.isArray(scene.surfaces)) continue;
        for (const surf of scene.surfaces) {
          if (surf && typeof surf.groupId === "string" && typeof surf.displayLabel === "string") {
            labelByGroup.set(surf.groupId, surf.displayLabel);
          }
        }
      }
    }

    // Enrich surfaces with frame availability info AND scene block ID
    const framesDir = path.join(process.cwd(), "public", "uploads", "frames", videoId.toString());
    const enrichedSurfaces = surfaces.map(s => {
      const ts = Math.floor(Number(s.timestamp));
      const frameFilename = `frame_${ts}s.jpg`;
      const framePath = path.join(framesDir, frameFilename);
      const frameExists = fs.existsSync(framePath);

      // Backfill frameUrl if frame exists but surface has no URL
      const frameUrl = s.frameUrl || (frameExists ? `/uploads/frames/${videoId}/${frameFilename}` : null);

      const sceneBlockId = sceneBlockFor(Number(s.timestamp) || 0);

      const gid = (s as any).surfaceGroupId as string | null | undefined;
      const displayLabel = gid ? labelByGroup.get(gid) ?? null : null;

      return { ...s, frameUrl, frameExists, sceneBlockId, displayLabel };
    });

    // Pass through the perceptual scene index too — lets the client know
    // which shots belong to the same physical scene (host shot returns 5x
    // = sceneId 0 for all five). Used for placement continuity rendering.
    const sceneIndex = (video as any).sceneIndex || null;

    res.json({
      surfaces: enrichedSurfaces,
      count: enrichedSurfaces.length,
      sceneBoundaries,
      sceneIndex,
      sceneInventory,
    });
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

    const isOwner = await isSameCreator(String(video.userId), req.authUserId);
    if (!isOwner) return res.status(403).json({ error: "Not authorized to edit this video's surfaces" });

    await storage.updateSurfaceApproval(surfaceId, approved);
    // Behavior event: the boolean alone can't say WHEN this was decided or
    // by WHOM, so curation trends were unanswerable. `bulk` distinguishes an
    // "approve all" click (one decision) from N deliberate ones.
    recordCreatorEvent({
      creatorUserId: String((video as any).userId),
      actorUserId: String(req.authUserId),
      eventType: approved ? "surface_approved" : "surface_unapproved",
      videoId: (surface as any).videoId,
      surfaceId,
      surfaceGroupId: (surface as any).surfaceGroupId ?? null,
      metadata: {
        surfaceType: (surface as any).surfaceType ?? null,
        bulk: req.body?.bulk === true,
      },
    });
    res.json({ success: true, surfaceId, approved });
  });

  // Creator rejects a bad detection (wrong label, overlapping duplicate, etc.).
  // Soft-deletes by stamping surfaceType "Filtered" — the same sentinel every
  // read path already excludes (surfaces endpoint, brand marketplace, counts).
  // The original type is preserved in sceneContext for audit/un-reject tooling.
  app.post("/api/surface/:id/reject", isFlexibleAuthenticated, async (req: any, res) => {
    const surfaceId = parseInt(req.params.id);
    if (isNaN(surfaceId)) return res.status(400).json({ error: "Invalid surface ID" });

    const [surface] = await db
      .select()
      .from(detectedSurfaces)
      .where(eq(detectedSurfaces.id, surfaceId))
      .limit(1);
    if (!surface) return res.status(404).json({ error: "Surface not found" });

    const video = await storage.getVideoById(surface.videoId);
    if (!video) return res.status(404).json({ error: "Parent video not found" });

    const isOwner = await isSameCreator(String(video.userId), req.authUserId);
    if (!isOwner) return res.status(403).json({ error: "Not authorized to edit this video's surfaces" });

    await storage.updateDetectedSurface(surfaceId, {
      surfaceType: "Filtered",
      sceneContext: `Removed by creator (was ${surface.surfaceType})`,
    });
    // The reject overwrites surfaceType with a sentinel, so the original
    // type only survives here. Rejections are excluded from the aggregates,
    // which makes them invisible as a curation signal without this event.
    recordCreatorEvent({
      creatorUserId: String((video as any)?.userId ?? req.authUserId),
      actorUserId: String(req.authUserId),
      eventType: "surface_rejected",
      videoId: (surface as any).videoId,
      surfaceId,
      surfaceGroupId: (surface as any).surfaceGroupId ?? null,
      metadata: { rejectedType: surface.surfaceType },
    });
    res.json({ success: true, surfaceId, rejected: true });
  });

  // Batch insert surfaces for a video (Admin only)
  // Used to copy scan results to production database
  app.post("/api/videos/:id/batch-insert-surfaces", isFlexibleAuthenticated, async (req: any, res) => {
    const authEmail = req.authEmail;
    
    // Admin only
    const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
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
    const adminEmails = ADMIN_EMAILS; // canonical list — see server/lib/adminEmails.ts
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
    let userId = req.authUserId;
    let authEmail = req.authEmail;
    let viewingAs: string | null = null;

    // View-as access — two paths to authorize:
    //   1. Admin (req.isAdmin) → can view ANY user's library.
    //   2. Library view grant (LIBRARY_VIEW_GRANTS) → narrow, per-user.
    //      Each granter maps to a list of email addresses that may view
    //      THEIR library — and nothing else. No admin powers, no brand
    //      view, no role switcher. Just the library, read-only via
    //      ?as=<granter-email>.
    //
    // This split exists so collaborators like Scott + Juan can browse
    // Martin's library without inheriting full admin access (brand
    // marketplace, approval endpoints, dashboard powers, etc.).
    const asEmailRaw = (req.query.as as string | undefined)?.toLowerCase().trim();
    if (asEmailRaw) {
      const callerEmail = (req.authEmail || "").toLowerCase();
      const grantedViewers = (LIBRARY_VIEW_GRANTS[asEmailRaw] || []).map(e => e.toLowerCase());
      const hasGrant = grantedViewers.includes(callerEmail);
      const authorized = req.isAdmin || hasGrant;
      if (authorized) {
        const otherUser = await storage.getUserByEmail(asEmailRaw);
        if (otherUser) {
          userId = otherUser.id;
          authEmail = otherUser.email;
          viewingAs = otherUser.email;
          console.log(`[VideoIndex] ${req.isAdmin ? "Admin" : "Granted viewer"} ${callerEmail} viewing-as ${viewingAs}`);
        } else {
          console.warn(`[VideoIndex] view-as target "${asEmailRaw}" not found in users table`);
        }
      } else {
        console.warn(`[VideoIndex] ${callerEmail} requested view-as ${asEmailRaw} but has no grant and isn't admin`);
      }
    }

    console.log(`[VideoIndex] Fetching videos for userId: ${userId}, authEmail: ${authEmail}${viewingAs ? " (view-as)" : ""}`);

    // The whole handler is wrapped: this endpoint previously had NO catch, so
    // a single pool-timeout inside the per-video work became an UNHANDLED
    // rejection (observed in prod while a render had the CPU).
    try {
      const videos = await storage.getVideoIndex(userId, authEmail);
      console.log(`[VideoIndex] Found ${videos.length} videos for user`);

      // One batched count query (was one query per video — 80 parallel
      // acquisitions against a 10-connection pool).
      const counts = await storage.getSurfaceCountsForVideos(videos.map((v) => v.id));
      // The card's scene rollup, aggregated in Postgres. getVideoIndex no
      // longer returns scene_inventory at all — this endpoint used to pull
      // hundreds of KB per video only to reduce it to three integers.
      const sceneSummaries = await storage.getSceneSummaries(videos.map((v) => v.id));

      // File-existence checks hit Object Storage — bound the concurrency so 80
      // videos don't mean 80 simultaneous GCS calls.
      const fileCheckLimit = pLimit(8);
      const videosWithCounts = await Promise.all(
        videos.map((video) =>
          fileCheckLimit(async () => {
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
            // The scan internals (per-shot dHash arrays, cut lists, full
            // scene inventory) are no longer SELECTed at all — getVideoIndex
            // projects them out. They used to be fetched, parsed, and then
            // thrown away here, which ballooned this response to ~500KB / 17s
            // under load and blocked the event loop on every library open.
            const slim = video;
            // Compact rollup of the inventory for library cards:
            // surface-bearing scene classes, canonical surfaces across
            // them, and minutes of screen time those scenes cover (a
            // 40-min episode where only the desk shot has inventory
            // shouldn't advertise 40 tracked minutes; zero-surface and
            // grid-failure singleton classes are excluded so the count
            // matches the scene modal header). Null for videos scanned
            // before the inventory existed — client falls back to the
            // raw adOpportunities count.
            const sceneSummary = sceneSummaries.get(video.id) ?? null;
            return { ...slim, adOpportunities: counts.get(video.id) || 0, fileExists, sceneSummary };
          }),
        ),
      );

      res.json({
        videos: videosWithCounts,
        total: videosWithCounts.length,
        // Echo whose library this actually represents (null = your own).
        // Client uses this to render the "Viewing as X" banner so admins
        // can't accidentally lose track of whose library they're looking at.
        viewingAs,
      });
      // Background self-heal for IG/FB thumbnails (signed CDN URLs that expire).
      // Per-user 1h cooldown — see socialThumbnailAutoRefresh.ts.
      maybeRefreshSocialThumbnailsInBackground(userId);
    } catch (err: any) {
      console.error("[VideoIndex] with-opportunities error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Failed to load video index" });
    }
  });

  // Per-caller endpoint: what view-as options does this user have? Powers
  // the BrandSidebar dropdown (and any future "switch library" UI). Returns
  // an empty array for users with no grants and who aren't admin. Cheap —
  // a single in-memory map lookup + maybe a users-table query for names.
  app.get("/api/me/view-as-options", isFlexibleAuthenticated, async (req: any, res) => {
    const callerEmail = (req.authEmail || "").toLowerCase();
    // Admins: return every user with a library (sorted by video count,
    // descending — Martin tops the list as the most-content owner). This
    // is the same data /api/admin/users-with-libraries returns, inlined
    // here so the single client endpoint covers both admin and granted
    // cases without the client needing to branch.
    if (req.isAdmin) {
      try {
        const rows = await db
          .select({
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            videoCount: sql<number>`COUNT(${videoIndexTable.id})::int`,
          })
          .from(users)
          .leftJoin(
            videoIndexTable,
            sql`${videoIndexTable.userId} = ${users.id} OR ${videoIndexTable.userId} = ${users.email}`,
          )
          .groupBy(users.id, users.email, users.firstName, users.lastName)
          .orderBy(sql`COUNT(${videoIndexTable.id}) DESC`);
        // Hide the caller's own row (you don't view-as yourself) and
        // libraries with zero videos (noise). Then apply SHOWCASE_LIBRARIES
        // allowlist if non-empty — keeps the dropdown focused on featured
        // libraries (e.g. just Martin's) rather than every account with
        // any content. Admins can still view-as any user via direct URL.
        const showcaseLower = SHOWCASE_LIBRARIES.map(e => e.toLowerCase());
        const grants = rows
          .filter(r => r.email && r.email.toLowerCase() !== callerEmail && r.videoCount > 0)
          .filter(r => showcaseLower.length === 0 || showcaseLower.includes(r.email!.toLowerCase()))
          .map(r => ({
            email: r.email!,
            firstName: r.firstName,
            lastName: r.lastName,
            videoCount: r.videoCount ?? 0,
          }));
        return res.json({ mode: "admin-all", grants });
      } catch (err: any) {
        console.error("[view-as-options] admin query failed:", err?.message || err);
        return res.json({ mode: "admin-all", grants: [] });
      }
    }
    // Non-admin: enumerate LIBRARY_VIEW_GRANTS for entries where this
    // caller's email is on the viewers list.
    const granterEmails: string[] = [];
    for (const [granter, viewers] of Object.entries(LIBRARY_VIEW_GRANTS)) {
      if (viewers.map(e => e.toLowerCase()).includes(callerEmail)) {
        granterEmails.push(granter);
      }
    }
    const granters = await Promise.all(
      granterEmails.map(async (email) => {
        const u = await storage.getUserByEmail(email);
        return {
          email,
          firstName: u?.firstName || null,
          lastName: u?.lastName || null,
          videoCount: 0,
        };
      }),
    );
    res.json({ mode: "granted", grants: granters });
  });

  // Admin endpoint: list every user + their video count, so the Library
  // page's view-as dropdown can populate. Returns email + name + count
  // so the admin can pick someone informed. Non-admins get 403.
  //
  // Done as a single grouped SQL query (left-join + count) to avoid the
  // N-queries shape that would have been needed via storage methods.
  // videoIndex is dual-keyed (user_id stores either UUID or email), so
  // we count rows whose user_id matches either users.id OR users.email.
  app.get("/api/admin/users-with-libraries", isFlexibleAuthenticated, async (req: any, res) => {
    if (!req.isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          videoCount: sql<number>`COUNT(${videoIndexTable.id})::int`,
        })
        .from(users)
        .leftJoin(
          videoIndexTable,
          sql`${videoIndexTable.userId} = ${users.id} OR ${videoIndexTable.userId} = ${users.email}`,
        )
        .groupBy(users.id, users.email, users.firstName, users.lastName)
        .orderBy(sql`COUNT(${videoIndexTable.id}) DESC`);

      // Return all users; client decides whether to hide empty libraries.
      // Even empty-library users are useful as "view as" targets for
      // people debugging brand-side flows.
      res.json({
        users: rows.map(r => ({
          email: r.email,
          firstName: r.firstName,
          lastName: r.lastName,
          videoCount: r.videoCount ?? 0,
        })),
      });
    } catch (err: any) {
      console.error("[Admin/users-with-libraries] Error:", err?.message || err);
      res.status(500).json({ error: err?.message || "Failed to list users" });
    }
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
    // Two round trips, not 1+N. This endpoint keeps three integers, so the
    // per-video surface fan-out was pure latency — 4.1s measured on a shell
    // endpoint that loads on every page.
    const [stats, activeBids] = await Promise.all([
      storage.getMarketplaceStats(userId),
      storage.getActiveBidsForCreator(userId),
    ]);

    res.json({
      videosWithOpportunities: stats.videosWithOpportunities,
      totalSurfaces: stats.totalSurfaces,
      activeBids: activeBids.length,
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

      const placement = await storage.getPlacementById(placementId);
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
  // (uses the canonical ADMIN_EMAILS imported from ./lib/adminEmails)

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
            
            // Update user with first Page data — ONLY if the creator hasn't
            // explicitly confirmed a Page yet. Once they've picked one via
            // the connect dialog, a background sync must not silently
            // overwrite their choice with whatever Page happens to be first.
            if (pageIds.length > 0 && !user.facebookPageId) {
              const firstPageUrl = `https://graph.facebook.com/v25.0/${pageIds[0]}?fields=id,name,fan_count,instagram_business_account&access_token=${accessToken}`;
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
                  const igUrl = `https://graph.facebook.com/v25.0/${igId}?fields=username,followers_count&access_token=${accessToken}`;
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
            const pageUrl = `https://graph.facebook.com/v25.0/${pId}?fields=instagram_business_account&access_token=${accessToken}`;
            const pageResponse = await fetch(pageUrl);
            const pageData = await pageResponse.json();
            
            if (pageData.instagram_business_account?.id) {
              igId = pageData.instagram_business_account.id;
              console.log(`[Sync] Found Instagram Business Account ${igId} on Page ${pId}`);
              
              // Fetch Instagram username and update user
              const igUrl = `https://graph.facebook.com/v25.0/${igId}?fields=username,followers_count&access_token=${accessToken}`;
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
        const meUrl = `https://graph.facebook.com/v25.0/me?fields=id,name,picture&access_token=${accessToken}`;
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
        const pagesUrl = `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,fan_count,picture,instagram_business_account&access_token=${accessToken}`;
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
                  const pageUrl = `https://graph.facebook.com/v25.0/${pageId}?fields=id,name,fan_count,picture,instagram_business_account&access_token=${accessToken}`;
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
                const igUrl = `https://graph.facebook.com/v25.0/${page.instagram_business_account.id}?fields=username,followers_count,profile_picture_url&access_token=${accessToken}`;
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
      const accountsUrl = `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,fan_count,access_token&access_token=${accessToken}`;
      const accountsResponse = await fetch(accountsUrl);
      const accountsData = await accountsResponse.json();
      
      // Try to fetch Pages directly from granular_scopes
      const pageDetails: any[] = [];
      if (debugData.data?.granular_scopes) {
        const pagesScope = debugData.data.granular_scopes.find((s: any) => s.scope === "pages_show_list");
        if (pagesScope?.target_ids) {
          for (const pageId of pagesScope.target_ids) {
            try {
              const pageUrl = `https://graph.facebook.com/v25.0/${pageId}?fields=id,name,fan_count,instagram_business_account&access_token=${accessToken}`;
              const pageResponse = await fetch(pageUrl);
              const pageData = await pageResponse.json();
              
              // Try to get videos from this page
              let videos: any = null;
              try {
                const videosUrl = `https://graph.facebook.com/v25.0/${pageId}/videos?fields=id,title,description&limit=5&access_token=${accessToken}`;
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

      // ONE projected fetch covering BOTH loops below. Previously each loop
      // called getVideoById per row, so a single page load paid two unbounded
      // fan-outs of full video rows — scene_index and scene_inventory jsonb
      // included, parsed synchronously by the pg driver, blocking every other
      // request in the process. Only title/thumbnail/userId/viewCount are read.
      const brandBids = await storage.getBrandCampaigns(brandEmail);
      const videoMap = await storage.getVideoSummaries([
        ...uniquePlacements.map((p: any) => p.videoId),
        ...brandBids.map((b: any) => b.videoId).filter((id: any) => id != null),
      ]);

      for (const placement of uniquePlacements) {
        placedVideoIds.add(placement.videoId);

        const video = videoMap.get(placement.videoId);
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
      const bids = brandBids;
      for (const bid of bids) {
        // Skip bids for videos that already have a live placement
        if (bid.videoId && placedVideoIds.has(bid.videoId)) continue;

        const video = bid.videoId ? (videoMap.get(bid.videoId) ?? null) : null;

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
  app.get(api.monetization.list.path, isFlexibleAuthenticated, async (req: any, res) => {
    // Was unauthenticated + unscoped: every creator saw every brand's bids
    // presented as their own "Live Offers". Non-admins now see items where
    // they are the creator or the bidding brand.
    const items = await storage.getMonetizationItems();
    const scoped = req.isAdmin
      ? items
      : items.filter((it: any) =>
          (it.creatorUserId && (it.creatorUserId === req.authUserId || it.creatorUserId === req.authEmail)) ||
          (it.brandEmail && it.brandEmail === req.authEmail));
    res.json(scoped);
  });

  app.post(api.monetization.create.path, isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const input = api.monetization.create.input.parse(req.body);
      // The bidding identity comes from the SESSION — an anonymous caller
      // could previously insert fabricated bids under any brand name.
      (input as any).brandEmail = req.authEmail;
      // Creator identity comes from the TARGET VIDEO, not the request body
      // — a client-supplied creatorUserId could plant fake offers in any
      // creator's Live Offers list.
      if ((input as any).videoId) {
        const targetVid = await storage.getVideoById((input as any).videoId).catch(() => undefined);
        (input as any).creatorUserId = targetVid ? (targetVid as any).userId : null;
      } else {
        (input as any).creatorUserId = null;
      }
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
      // Enrich each with surfaces (excluding enrichment-rejected "Filtered" ones —
      // they are not placement inventory and shouldn't inflate public spot counts)
      const videos: any[] = [];
      for (const v of allCreatorVideos) {
        const surfaces = (await storage.getDetectedSurfaces(v.id)).filter(isSellableSurface);
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
          // Internal server path — never published. The client streams via
          // videoUrl; its filePath fallback only fired when videoUrl was null,
          // and videoUrl is set whenever a filePath exists.
          filePath: null,
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
          // email deliberately absent: this response is world-readable and the
          // client never renders it. Brands reach creators through the
          // platform, not by scraping addresses off profiles.
          slug: creator.slug || slug,
          profileImage: userProfile?.profileImageUrl || null,
          cardImageUrl: (creator as any).cardImageUrl || null,
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

        // Projected: getVideoIndex returns FULL rows, so this pulled every
        // scanned video's scene_index + scene_inventory for every featured
        // creator CONCURRENTLY — on an unauthenticated endpoint, which makes
        // it a stall anyone on the internet can trigger. Only id, thumbnail,
        // youtubeId and filePath are read below.
        const allCreatorVideos = await storage.getCreatorVideoThumbRows(creator.email);

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
          // Creator-controlled card image (logo/brand). Frontend uses this
          // as the primary card visual when present; thumbnails fall back.
          cardImageUrl: (creator as any).cardImageUrl || null,
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

      const { bio, headline, podcastName, podcastUrl, websiteUrl, slug, cardImageUrl } = req.body;
      const updates: any = {};
      if (bio !== undefined) updates.bio = bio;
      if (headline !== undefined) updates.headline = headline;
      if (podcastName !== undefined) updates.podcastName = podcastName;
      if (podcastUrl !== undefined) updates.podcastUrl = podcastUrl;
      if (websiteUrl !== undefined) updates.websiteUrl = websiteUrl;
      // Featured creator card image. Accepts a /storage/... URL produced by
      // the upload endpoint, or empty string to clear back to default.
      if (cardImageUrl !== undefined) {
        updates.cardImageUrl = cardImageUrl === "" ? null : cardImageUrl;
      }
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

  // Upload featured creator card image. Single multipart 'image' field.
  // Resizes to 800x450 (16:9 max — matches card render aspect), uploads to
  // GCS, returns serve URL. Caller is expected to PATCH /api/creator/profile
  // with { cardImageUrl: <url> } to actually save it on the profile.
  app.post(
    "/api/creator/card-image",
    isFlexibleAuthenticated,
    imageUpload.single("image"),
    async (req: any, res) => {
      try {
        const email = req.session?.googleUser?.email || req.user?.claims?.email || req.authEmail;
        if (!email) {
          return res.status(401).json({ error: "Not authenticated" });
        }
        if (!req.file?.buffer) {
          return res.status(400).json({ error: "No image uploaded (expected multipart field 'image')" });
        }

        const sharp = (await import("sharp")).default;
        // Resize to max 1600x900 preserving original aspect — NO letterbox.
        // The marketplace card uses CSS object-cover so the visual cropping
        // happens at display time. Storing the raw aspect means a creator
        // who uploads a 16:9 brand image gets exactly that, while a square
        // logo gets cropped to fit the card without black bars baked in.
        const outBuf = await sharp(req.file.buffer)
          .resize(1600, 900, {
            fit: "inside",          // preserve aspect, no padding
            withoutEnlargement: true, // don't upscale tiny logos
          })
          .png()
          .toBuffer();

        const slug = email.toLowerCase().replace(/[^a-z0-9]/g, "_");
        const ts = Date.now();
        const objectKey = `public/uploads/creator-cards/${slug}_${ts}.png`;

        const { uploadBufferToStorage } = await import("./lib/objectStorage");
        const url = await uploadBufferToStorage(outBuf, objectKey);

        // Save it onto the profile immediately — UI can still PATCH again
        // if user wants to clear it, but typical flow is upload = use it.
        await storage.updateCreatorProfile(email, { cardImageUrl: url });

        res.json({ success: true, cardImageUrl: url });
      } catch (err: any) {
        console.error("Error uploading creator card image:", err);
        res.status(500).json({ error: err?.message || "Upload failed" });
      }
    },
  );

  // POST /api/creator/card-image/reprocess — strip baked-in letterbox bars
  // from an existing card image. The original upload (pre-9e1401d) used
  // sharp's fit:"contain" with #111117 padding, baking dark bars INTO the
  // saved file. New uploads don't do this, but creators who already uploaded
  // get stuck with the bars unless they re-upload. This endpoint re-fetches
  // their stored card image, finds the actual non-letterbox bounding box by
  // detecting the dominant edge color, crops to it, and re-uploads.
  app.post("/api/creator/card-image/reprocess", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const email = req.session?.googleUser?.email || req.user?.claims?.email || req.authEmail;
      if (!email) return res.status(401).json({ error: "Not authenticated" });

      // Pull the existing card URL from the profile.
      const slug = email.split("@")[0].toLowerCase();
      const profile = await storage.getCreatorBySlug(slug)
        ?? (await storage.getFeaturedCreators()).find(c => c.email.toLowerCase() === email.toLowerCase());
      const existingUrl = (profile as any)?.cardImageUrl;
      if (!existingUrl) {
        return res.status(404).json({ error: "No existing card image to reprocess" });
      }

      // Fetch the current image (whether on /storage/ or external URL).
      const localBase = `http://localhost:${process.env.PORT || 5000}`;
      const fetchUrl = existingUrl.startsWith("/") ? `${localBase}${existingUrl}` : existingUrl;
      const fetchRes = await fetch(fetchUrl);
      if (!fetchRes.ok) {
        return res.status(502).json({ error: `Could not fetch existing card: ${fetchRes.status}` });
      }
      const inBuf = Buffer.from(await fetchRes.arrayBuffer());

      const sharp = (await import("sharp")).default;
      // sharp.trim() removes uniform border color automatically. Threshold
      // 30 is permissive for the dark #111117 letterbox bars from the
      // prior upload code. If no border detected, returns the original
      // unchanged (no-op).
      const trimmed = await sharp(inBuf)
        .trim({ threshold: 30 })
        .png()
        .toBuffer();

      const beforeMeta = await sharp(inBuf).metadata();
      const afterMeta = await sharp(trimmed).metadata();
      console.log(`[CardImage/reprocess] ${email}: ${beforeMeta.width}x${beforeMeta.height} → ${afterMeta.width}x${afterMeta.height}`);

      const ts = Date.now();
      const safeSlug = email.toLowerCase().replace(/[^a-z0-9]/g, "_");
      const objectKey = `public/uploads/creator-cards/${safeSlug}_${ts}.png`;
      const { uploadBufferToStorage } = await import("./lib/objectStorage");
      const newUrl = await uploadBufferToStorage(trimmed, objectKey);
      await storage.updateCreatorProfile(email, { cardImageUrl: newUrl });

      res.json({
        success: true,
        cardImageUrl: newUrl,
        before: { w: beforeMeta.width, h: beforeMeta.height },
        after: { w: afterMeta.width, h: afterMeta.height },
        trimmedPixels: (beforeMeta.width || 0) * (beforeMeta.height || 0) - (afterMeta.width || 0) * (afterMeta.height || 0),
      });
    } catch (err: any) {
      console.error("Error reprocessing creator card image:", err);
      res.status(500).json({ error: err?.message || "Reprocess failed" });
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
  app.post("/api/public/placement-request", authLimiter, async (req, res) => {
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
  /**
   * The catalog, scoped to who is asking.
   *
   * This returned EVERY brand's products to anyone logged in, which let a
   * creator pull a brand they had no relationship with into their content —
   * seen in production as a placement test for a brand that had never engaged
   * that creator. Brands choose creators; creators then place. Browsing the
   * whole catalog is the creator choosing the brand, which is the mechanic
   * backwards.
   *
   *   admin   — everything, because they operate the review queue
   *   brand   — their own products
   *   creator — only brands that requested a placement with them or bid on
   *             their inventory
   */
  app.get("/api/brand-products/catalog", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      if (req.isAdmin) {
        return res.json(await storage.getAllBrandProducts());
      }
      const viewRole = (req.session as any)?.viewRole;
      const allowed = req.authEmail
        ? await storage.getAllowedUser(req.authEmail).catch(() => undefined)
        : undefined;
      const isBrand = (viewRole || (allowed as any)?.userType) === "brand";

      if (isBrand) {
        // A brand's own shelf. Not the platform's.
        return res.json(await storage.getBrandProducts(req.authUserId));
      }

      const products = await storage.getBrandProductsForCreator(req.authUserId, req.authEmail);
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

      // Creator stats: follower count from YouTube connection + recent avg views.
      // video.userId may be a users.id or a legacy email key — resolve the full
      // identity so tier/avg-views compute from the creator's whole library.
      const creatorIdentity = await resolveCreatorIdentity(video.userId);
      const creatorConn =
        (await storage.getYoutubeConnection(creatorIdentity.userId).catch(() => null)) ??
        (creatorIdentity.userId !== video.userId
          ? await storage.getYoutubeConnection(video.userId).catch(() => null)
          : null);
      const creatorFollowers = creatorConn?.subscriberCount ?? null;
      // Raw key first (getVideoIndex self-resolves either form and matches
      // {raw, users.id, email}) so unnormalized legacy rows stay in the set.
      const creatorVideos = await storage
        .getVideoIndex(video.userId, creatorIdentity.email)
        .catch(() => [] as any[]);
      const creatorAvgViews = avgRecentViews(
        creatorVideos.map((v: any) => ({ viewCount: v.viewCount, createdAt: v.createdAt })),
        10,
      );

      // Video age (prefer publishedAt, fall back to createdAt)
      const ageDays = calcVideoAgeDays(video.publishedAt, video.createdAt);

      // Resolve surfaces (or use a placeholder if none specified — useful for "default quote").
      // Filtered surfaces were rejected by enrichment — they are not inventory.
      let surfaces: any[] = [];
      if (surfaceIds.length > 0) {
        const allSurfaces = clip
          ? await storage.getSurfacesInEditorialClip(clip.id)
          : await storage.getDetectedSurfaces(video.id);
        surfaces = allSurfaces.filter(
          (s: any) => surfaceIds.includes(s.id) && isSellableSurface(s),
        );
        if (surfaces.length === 0) {
          return res.status(400).json({
            error: "Requested surface(s) are not available for placement",
          });
        }
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
      const { editorialClipId, videoId, brandProductId, creatorChoosesProduct, surfaceIds, message } = req.body || {};

      // creatorChoosesProduct: the brand delegates the product choice — the
      // creator picks from the brand's catalog when approving.
      const delegated = creatorChoosesProduct === true && !brandProductId;
      if ((!brandProductId && !delegated) || !Array.isArray(surfaceIds) || surfaceIds.length === 0) {
        return res.status(400).json({
          error: "Missing required fields: brandProductId (or creatorChoosesProduct: true), surfaceIds (non-empty array)",
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

      // Verify video exists and resolve the creator's canonical identity.
      // video.userId may be a users.id or a legacy email key; new placement
      // rows store the canonical id (inbox reads are alias-aware either way).
      const video = await storage.getVideoById(resolvedVideoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      const creatorIdentity = await resolveCreatorIdentity(video.userId);
      const creatorUserId = creatorIdentity.userId;

      // Verify brand owns the product
      const product = delegated ? null : await storage.getBrandProduct(parseInt(brandProductId));
      if (!delegated) {
        if (!product) return res.status(404).json({ error: "Brand product not found" });
        if (product.userId !== brandUserId) {
          return res.status(403).json({ error: "Not authorized to use this product" });
        }
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

      // Gather pricing inputs (creator stats + video age) — fetched once, reused
      // per surface. Same dual-key resolution as the quote endpoint so the
      // charged price matches the quoted price.
      const creatorConn =
        (await storage.getYoutubeConnection(creatorIdentity.userId).catch(() => null)) ??
        (creatorIdentity.userId !== video.userId
          ? await storage.getYoutubeConnection(video.userId).catch(() => null)
          : null);
      const creatorFollowers = creatorConn?.subscriberCount ?? null;
      // Raw key first — same superset lookup as the quote endpoint.
      const creatorVideos = await storage
        .getVideoIndex(video.userId, creatorIdentity.email)
        .catch(() => [] as any[]);
      const creatorAvgViews = avgRecentViews(
        creatorVideos.map((v: any) => ({ viewCount: v.viewCount, createdAt: v.createdAt })),
        10,
      );
      const ageDays = calcVideoAgeDays(video.publishedAt, video.createdAt);

      // Need surface details for per-surface pricing
      const allSurfaces = clipForPricing
        ? await storage.getSurfacesInEditorialClip(clipForPricing.id)
        : await storage.getDetectedSurfaces(video.id);

      // Validate ALL requested surfaces up front — before any row is created.
      // Unknown IDs and enrichment-rejected ("Filtered") surfaces are not inventory.
      for (const sid of surfaceIds) {
        const surface = allSurfaces.find((s: any) => s.id === parseInt(sid));
        if (!surface || !isSellableSurface(surface)) {
          return res.status(400).json({
            error: `Surface ${sid} is not available for placement`,
          });
        }
      }

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
          brandProductId: delegated ? null : parseInt(brandProductId),
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

      // One notification per REQUEST (not per surface) — a multi-surface
      // request previously spammed the creator with N identical rows.
      if (created.length > 0) {
        storage.createNotification({
          userId: creatorUserId,
          type: "placement_request",
          title: created.length > 1 ? `New brand placement request (${created.length} surfaces)` : "New brand placement request",
          body: message ? `Message from the brand: ${String(message).slice(0, 200)}` : "A brand wants to place a product in one of your clips.",
          linkPath: "/inbox",
          metadata: { placementIds: created.map((r: any) => r.id), videoId: resolvedVideoId },
        });
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

      // Hydrate with product + video summaries (mirrors the creator inbox)
      // so the brand tracking UI doesn't need N round-trips.
      // Video summaries fetched ONCE for the whole list, not per placement.
      // getVideoById inside this Promise.all pulled scene_index and
      // scene_inventory jsonb concurrently for every row — N pool connections
      // and N synchronous JSON.parses, which stalls the whole process.
      const videoSummaries = await storage.getVideoSummaries(placements.map((p) => p.videoId));
      const hydrated = await Promise.all(
        placements.map(async (p) => {
          const video = videoSummaries.get(p.videoId) ?? null;
          const [product, clip] = await Promise.all([
            p.brandProductId != null ? storage.getBrandProduct(p.brandProductId) : Promise.resolve(undefined),
            p.editorialClipId ? storage.getEditorialClipById(p.editorialClipId) : Promise.resolve(null),
          ]);
          return {
            ...p,
            product: product
              ? { id: product.id, name: product.name, imageUrl: product.imageUrl, thumbnailUrl: product.thumbnailUrl, category: product.category }
              : null,
            video: video ? { id: video.id, title: video.title, thumbnailUrl: video.thumbnailUrl } : null,
            // The baked render — what the brand reviews at the final gate
            clip: clip
              ? { id: clip.id, exportPath: clip.exportPath, thumbnailPath: (clip as any).thumbnailPath ?? null, renderStatus: clip.renderStatus, suggestedTitle: clip.suggestedTitle }
              : null,
          };
        })
      );

      res.json({ placements: hydrated, count: hydrated.length });
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
      if (!["pending_creator_review", "creator_approved", "pending_brand_review"].includes(placement.status)) {
        return res.status(400).json({ error: `Cannot withdraw a ${placement.status} placement` });
      }
      const updated = await storage.updateBrandPlacementStatus(id, "brand_withdrawn");
      // Measurement spine: close the treatment window (the fixture returns
      // to a no-placement control period from here).
      // Treatment ended → the fixture returns to an explicit CONTROL period,
      // so the untreated stretch is a queryable row rather than a gap.
      (async () => {
        const n = await storage.closeFixtureAssignment({ assignmentId: id }, "withdrawn").catch(() => 0);
        if (n) console.log(`[Measurement] fixture_assignments: closed ${n} window(s) — assignment ${id} withdrawn`);
        await reopenControlForAssignment(id);
      })();
      storage.createNotification({
        userId: placement.creatorUserId,
        type: "placement_withdrawn",
        title: "Placement request withdrawn",
        body: "A brand withdrew its placement request.",
        linkPath: "/inbox",
        metadata: { placementId: id },
      });
      res.json({ placement: updated });
    } catch (err: any) {
      console.error("[API] /api/brand/placements/:id/withdraw error:", err.message);
      res.status(500).json({ error: err.message || "Failed to withdraw placement" });
    }
  });

  // GET /api/creator/placements/inbox — Creator's pending placement requests.
  // ── Notifications ────────────────────────────────────────────────
  app.get("/api/notifications", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const items = await storage.getNotificationsForUser(req.authUserId);
      const unread = await storage.getUnreadNotificationCount(req.authUserId);
      res.json({ notifications: items, unread });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load notifications" });
    }
  });

  app.post("/api/notifications/:id/read", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const ok = await storage.markNotificationRead(parseInt(req.params.id), req.authUserId);
      if (!ok) return res.status(404).json({ error: "Notification not found" });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to mark read" });
    }
  });

  app.post("/api/notifications/read-all", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const n = await storage.markAllNotificationsRead(req.authUserId);
      res.json({ success: true, marked: n });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to mark all read" });
    }
  });

  app.get("/api/creator/placements/inbox", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const creatorUserId = req.authUserId;
      const status = typeof req.query.status === "string" ? req.query.status : "pending_creator_review";
      const placements = await storage.getCreatorPlacements(creatorUserId, status);

      // Hydrate with product + video + surface details so the inbox UI doesn't need 4 round-trips
      const videoIds = placements.map((p) => p.videoId);
      // Both batched ONCE for the whole inbox. getPlacementsForVideo was called
      // per placement AND is unprojected, so it dragged harmonized_image_url —
      // multi-megabyte base64 PNG composites — across the wire N times, purely
      // to compute the `framed` boolean below, which reads four scalar fields.
      const [videoSummaries, framingByVideo] = await Promise.all([
        storage.getVideoSummaries(videoIds),
        storage.getPlacementIdentityForVideos(videoIds).catch(() => new Map()),
      ]);
      const hydrated = await Promise.all(
        placements.map(async (p) => {
          const video = videoSummaries.get(p.videoId) ?? null;
          const savedForVideo = framingByVideo.get(p.videoId) ?? [];
          const [product, surfaces, clip] = await Promise.all([
            p.brandProductId != null ? storage.getBrandProduct(p.brandProductId) : Promise.resolve(undefined),
            storage.getDetectedSurfaces(p.videoId),
            p.editorialClipId ? storage.getEditorialClipById(p.editorialClipId) : Promise.resolve(null),
          ]);
          const surface = surfaces.find((s) => s.id === p.surfaceId);
          // Has the creator actually FRAMED this yet? Without a saved
          // placement the render falls back to dropping the raw product PNG
          // into the surface bbox, which is not a choice anyone made. The
          // inbox uses this to lead with "Place product" instead of "Approve".
          const framed = (savedForVideo as any[]).some((sp) =>
            sp.status !== "archived" &&
            sp.surfaceId === p.surfaceId &&
            (p.editorialClipId ? sp.editorialClipId === p.editorialClipId : true) &&
            (p.brandProductId == null || sp.productId === p.brandProductId));
          return {
            ...p,
            hasCreatorFraming: framed,
            clip: clip
              ? {
                  id: clip.id,
                  clipStart: clip.clipStart,
                  clipEnd: clip.clipEnd,
                  aspectRatio: (clip as any).aspectRatio ?? null,
                  suggestedTitle: clip.suggestedTitle,
                  exportPath: clip.exportPath,
                  thumbnailPath: (clip as any).thumbnailPath ?? null,
                }
              : null,
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

  // POST /api/brand/placements/:id/approve — the BRAND's final gate: after
  // the creator approves and the clip re-renders with the product, the brand
  // reviews the baked render and signs off. Only then is the placement
  // publish-ready (and publishing itself still requires the creator).
  app.post("/api/brand/placements/:id/approve", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const brandUserId = req.authUserId;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid placement ID" });

      const placement = await storage.getBrandPlacementById(id);
      if (!placement) return res.status(404).json({ error: "Placement not found" });
      if (placement.brandUserId !== brandUserId) {
        return res.status(403).json({ error: "Not authorized to approve this placement" });
      }
      if (placement.status !== "pending_brand_review") {
        return res.status(400).json({ error: `Placement is ${placement.status} — only pending_brand_review placements can be brand-approved` });
      }

      // CAS so a double-click (or a concurrent withdraw) can't approve twice
      // — the loser sees the row already transitioned and stops here.
      const updated = await storage.updateBrandPlacementStatus(id, "brand_approved", { expectedCurrentStatus: "pending_brand_review" });
      if (!updated) {
        return res.status(409).json({ error: "Placement was updated by another action — refresh and try again" });
      }
      console.log(`[BrandPlacement] Brand ${brandUserId} FINAL-APPROVED placement ${id}`);

      // A1 publish: mint the public release page for the approved render.
      let releaseUrl: string | null = null;
      try {
        releaseUrl = (await ensurePlacementReleaseLink(placement)).url;
      } catch (relErr: any) {
        console.warn(`[BrandPlacement] Release-link mint failed (non-fatal): ${relErr?.message}`);
      }

      storage.createNotification({
        userId: placement.creatorUserId,
        type: "placement_final_approved",
        title: "Brand approved the final render",
        body: releaseUrl
          ? "The brand signed off on the finished clip — your public release page is live."
          : "The brand signed off on the finished clip — this placement is ready for launch.",
        linkPath: "/inbox",
        metadata: { placementId: id, releaseUrl },
      });
      res.json({ placement: updated, releaseUrl });
    } catch (err: any) {
      console.error("[API] /api/brand/placements/:id/approve error:", err.message);
      res.status(500).json({ error: err.message || "Failed to approve placement" });
    }
  });

  // POST /api/videos/:videoId/cancel-scan — escape hatch for stuck scans.
  // Flips "Scanning" to an honest failed state; a live scan notices the
  // status change within a few frames (cooperative abort in scanner_v2)
  // and stops; a dead one is simply released so the creator can rescan.
  app.post("/api/videos/:videoId/cancel-scan", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });
      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!(await isSameCreator(String(video.userId), req.authUserId)) && !req.isAdmin) {
        return res.status(403).json({ error: "Not your video" });
      }
      if (video.status !== "Scanning") {
        return res.status(409).json({ error: `Video is not scanning (status: ${video.status})` });
      }
      await storage.updateVideoStatus(videoId, "Scan Failed — Cancelled");
      console.log(`[API] Scan cancelled for video ${videoId} by ${req.authUserId}`);
      res.json({ success: true, status: "Scan Failed — Cancelled" });
    } catch (err: any) {
      console.error("[API] cancel-scan error:", err.message);
      res.status(500).json({ error: err.message || "Failed to cancel scan" });
    }
  });

  // GET /api/placements/:id/release-link — the public release page for a
  // brand-approved placement (either party). Mints lazily, so placements
  // approved before release pages existed get one on first ask. Also returns
  // the raw render URL for the Download button.
  app.get("/api/placements/:id/release-link", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid placement ID" });
      const placement = await storage.getBrandPlacementById(id);
      if (!placement) return res.status(404).json({ error: "Placement not found" });
      const isBrand = String(placement.brandUserId) === String(req.authUserId);
      const isCreator = await isSameCreator(String(placement.creatorUserId), req.authUserId);
      if (!isBrand && !isCreator) return res.status(403).json({ error: "Not your placement" });
      if (placement.status !== "brand_approved") {
        return res.status(409).json({ error: "Release pages exist only after the brand approves the final render" });
      }
      const rel = await ensurePlacementReleaseLink(placement);
      let downloadUrl: string | null = null;
      if (placement.editorialClipId) {
        const clip = await storage.getEditorialClipById(placement.editorialClipId);
        downloadUrl = clip?.exportPath || null;
      }
      res.json({ ...rel, downloadUrl });
    } catch (err: any) {
      if (err instanceof ReleaseLinkDeactivatedError) {
        return res.status(410).json({ error: err.message });
      }
      console.error("[API] /api/placements/:id/release-link error:", err.message);
      res.status(500).json({ error: err.message || "Failed to resolve release link" });
    }
  });

  // GET /api/creator/placements/:id/brand-products — the requesting brand's
  // catalog, for delegated-choice placements (creator picks the product).
  app.get("/api/creator/placements/:id/brand-products", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid placement ID" });
      const placement = await storage.getBrandPlacementById(id);
      if (!placement) return res.status(404).json({ error: "Placement not found" });
      if (!(await isSameCreator(placement.creatorUserId, req.authUserId))) {
        return res.status(403).json({ error: "Not your placement" });
      }
      const products = await storage.getBrandProducts(String(placement.brandUserId));
      res.json({ products });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load brand products" });
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
      if (!(await isSameCreator(placement.creatorUserId, creatorUserId))) {
        return res.status(403).json({ error: "Not authorized to approve this placement" });
      }
      if (placement.status !== "pending_creator_review") {
        return res.status(400).json({ error: `Cannot approve a ${placement.status} placement` });
      }

      // Delegated-choice placements: the creator must pick one of the
      // BRAND's products as part of approving.
      let chosenProductId: number | undefined = undefined;
      if (placement.brandProductId == null) {
        const bodyProductId = parseInt(req.body?.brandProductId);
        if (!bodyProductId || isNaN(bodyProductId)) {
          return res.status(400).json({ error: "This brand asked you to choose the product — pick one of their products to approve" });
        }
        const chosen = await storage.getBrandProduct(bodyProductId);
        if (!chosen || String((chosen as any).userId) !== String(placement.brandUserId)) {
          return res.status(400).json({ error: "Chosen product does not belong to the requesting brand" });
        }
        chosenProductId = bodyProductId;
      }

      const updated = await storage.updateBrandPlacementStatus(id, "creator_approved", chosenProductId !== undefined ? { brandProductId: chosenProductId } : {});
      storage.markPlacementNotificationsRead(id);
      console.log(`[BrandPlacement] Creator ${creatorUserId} APPROVED placement ${id}`);
      recordCreatorEvent({
        creatorUserId: String(placement.creatorUserId),
        actorUserId: String(creatorUserId),
        eventType: "brand_request_approved",
        videoId: placement.videoId,
        surfaceId: placement.surfaceId,
        assignmentId: id,
        brandProductId: chosenProductId ?? placement.brandProductId ?? null,
        metadata: {
          // Time-to-respond is the headline responsiveness metric.
          requestedAt: placement.createdAt,
          delegatedChoice: chosenProductId != null,
        },
      });

      // MEASUREMENT SPINE: open the treatment window on this fixture. The
      // fixture (stable surface_group_id) is the experimental unit and the
      // product is the treatment; the GAPS between windows are the
      // no-placement control periods. Non-fatal — research instrumentation
      // must never block an approval.
      (async () => {
        try {
          const surfaces = await storage.getDetectedSurfaces(placement.videoId);
          const surface = surfaces.find((sf: any) => sf.id === placement.surfaceId);
          const groupId = (surface as any)?.surfaceGroupId as string | null | undefined;
          if (!groupId) {
            console.log(`[Measurement] Placement ${id}: surface ${placement.surfaceId} has no fixture id — assignment window skipped (pre-fixture scan)`);
            return;
          }
          const effectiveProductId = chosenProductId ?? placement.brandProductId ?? null;
          const product = effectiveProductId ? await storage.getBrandProduct(effectiveProductId).catch(() => undefined) : undefined;
          // Link the creator's saved placement so archiving it can close this
          // window — without the id the archive close matched nothing and the
          // window stayed open forever, reading as TREATED after removal.
          let linkedPlacementId: number | null = null;
          try {
            const saved = await storage.getPlacementsForVideo(placement.videoId);
            const match = saved.find((sp: any) =>
              sp.surfaceId === placement.surfaceId ||
              (Array.isArray(sp.appliesToGroupIds) && sp.appliesToGroupIds.includes(groupId)));
            linkedPlacementId = match?.id ?? null;
          } catch { /* best-effort */ }
          await storage.openFixtureAssignment({
            userId: String(placement.creatorUserId),
            surfaceGroupId: groupId,
            videoId: placement.videoId,
            brandProductId: effectiveProductId,
            productName: product?.name ? String(product.name).slice(0, 200) : null,
            brandUserId: placement.brandUserId ? String(placement.brandUserId) : null,
            assignmentId: id,
            placementId: linkedPlacementId,
            startedAt: new Date(),
          } as any);
          console.log(`[Measurement] fixture_assignments: opened window on ${groupId} → product ${effectiveProductId ?? "none"} (assignment ${id})`);
        } catch (mErr: any) {
          console.warn(`[Measurement] Assignment-window write failed (non-fatal): ${mErr?.message}`);
        }
      })();
      storage.createNotification({
        userId: placement.brandUserId,
        type: "placement_approved",
        title: "Placement approved",
        body: "The creator approved your placement — the clip is being re-rendered with your product.",
        linkPath: "/brand/placements",
        metadata: { placementId: id },
      });

      // Fire-and-forget re-render of the targeted clip so the brand product
      // appears in the output. If targeted at a video without a specific clip,
      // skip — that's the legacy path and doesn't have a clean render trigger.
      if (placement.editorialClipId) {
        const clipId = placement.editorialClipId;
        const videoId = placement.videoId;
        renderSingleEditorialClip(videoId, clipId)
          .then(async () => {
            console.log(`[BrandPlacement] ✓ Re-rendered clip ${clipId} with approved placement ${id}`);
            // Second gate of the A1 lifecycle: the baked render now goes to
            // the BRAND for final review. Compare-and-set so a withdrawal
            // (or expiry) during the render window is never reversed.
            const advanced = await storage.updateBrandPlacementStatus(id, "pending_brand_review", { expectedCurrentStatus: "creator_approved" });
            if (!advanced) {
              console.log(`[BrandPlacement] Placement ${id} left creator_approved during render — not advancing`);
              return;
            }
            storage.createNotification({
              userId: placement.brandUserId,
              type: "placement_render_ready",
              title: "Render ready for your review",
              body: "The clip has been re-rendered with your product — review and approve the final cut.",
              linkPath: "/brand/placements",
              metadata: { placementId: id, clipId },
            });
          })
          .catch(async (err: any) => {
            console.error(`[BrandPlacement] ✗ Re-render failed for clip ${clipId}:`, err?.message || err);
            // Don't strand the lifecycle silently: mark the clip failed and
            // tell the creator. Re-rendering the clip (aspect chips /
            // library) advances the placement when it succeeds.
            await storage.updateEditorialClipRender(clipId, { renderStatus: "failed", renderError: err?.message || "Placement re-render failed" }).catch(() => {});
            // No render means nothing reached an audience — close the window
            // rather than leaving the fixture recorded as treated.
            storage.closeFixtureAssignment({ assignmentId: id }, "render_failed").catch(() => {});
            storage.createNotification({
              userId: placement.creatorUserId,
              type: "placement_render_failed",
              title: "Placement render failed",
              body: "The clip re-render with the brand's product failed — re-render the clip from your library to continue the approval.",
              linkPath: "/library",
              metadata: { placementId: id, clipId },
            });
          });
      } else {
        // Video-targeted placements (legacy mode, no per-clip render) go
        // straight to brand review — previously they could NEVER reach the
        // brand gate and displayed as perpetually "Rendering".
        console.log(`[BrandPlacement] Placement ${id} has no clip target — advancing directly to brand review`);
        storage.updateBrandPlacementStatus(id, "pending_brand_review", { expectedCurrentStatus: "creator_approved" })
          .then((advanced) => {
            if (!advanced) return;
            storage.createNotification({
              userId: placement.brandUserId,
              type: "placement_render_ready",
              title: "Placement ready for your review",
              body: "The creator approved your placement — review and give final approval.",
              linkPath: "/brand/placements",
              metadata: { placementId: id },
            });
          })
          .catch(() => {});
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
      if (!(await isSameCreator(placement.creatorUserId, creatorUserId))) {
        return res.status(403).json({ error: "Not authorized to reject this placement" });
      }
      if (placement.status !== "pending_creator_review") {
        return res.status(400).json({ error: `Cannot reject a ${placement.status} placement` });
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      const updated = await storage.updateBrandPlacementStatus(id, "creator_rejected", { rejectionReason: reason });
      recordCreatorEvent({
        creatorUserId: String(placement.creatorUserId),
        actorUserId: String(creatorUserId),
        eventType: "brand_request_rejected",
        videoId: placement.videoId,
        surfaceId: placement.surfaceId,
        assignmentId: id,
        brandProductId: placement.brandProductId ?? null,
        // The reason corpus is how we learn WHY creators decline brands.
        metadata: { requestedAt: placement.createdAt, reason: reason ?? null },
      });
      (async () => {
        const n = await storage.closeFixtureAssignment({ assignmentId: id }, "withdrawn").catch(() => 0);
        if (n) console.log(`[Measurement] fixture_assignments: closed ${n} window(s) — assignment ${id} rejected`);
        await reopenControlForAssignment(id);
      })();
      storage.markPlacementNotificationsRead(id);
      storage.createNotification({
        userId: placement.brandUserId,
        type: "placement_rejected",
        title: "Placement declined",
        body: reason ? `Creator: ${String(reason).slice(0, 200)}` : "The creator declined this placement request.",
        linkPath: "/brand/placements",
        metadata: { placementId: id },
      });
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

      const [allClipSurfaces, video] = await Promise.all([
        storage.getSurfacesInEditorialClip(clipId),
        storage.getVideoById(clip.videoId),
      ]);
      const surfaces = allClipSurfaces.filter(isSellableSurface);

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

  // ── Media assets: b-roll footage and music beds for the clip editor ──
  // Deliberately NOT video_index rows — these are ingredients, never scanned,
  // never in the library, never carrying a placement.

  app.post("/api/media-assets", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const Busboy = (await import("busboy")).default;
      const kindParam = String(req.query.kind ?? "");
      if (!["broll_video", "broll_image", "music"].includes(kindParam)) {
        return res.status(400).json({ error: "kind must be broll_video, broll_image or music (query param)" });
      }
      const MAX_BYTES = 300 * 1024 * 1024;
      const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES, files: 1 } });
      let handled = false;

      bb.on("file", (_name: string, fileStream: any, info: any) => {
        handled = true;
        const filename = String(info?.filename ?? "asset");
        const mimeType = String(info?.mimeType ?? "application/octet-stream");
        const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
        const objectKey = `public/media-assets/${encodeURIComponent(String(req.authUserId))}/${Date.now()}-${safe}`;
        let truncated = false;
        fileStream.on("limit", () => { truncated = true; });

        uploadStreamToStorage(fileStream, objectKey, mimeType)
          .then(async (serveUrl: string) => {
            if (truncated) {
              return res.status(413).json({ error: `File exceeds the ${MAX_BYTES / 1024 / 1024}MB limit` });
            }
            // Duration probe (music + b-roll video) so the editor can bound
            // its sliders; failure leaves it null rather than failing upload.
            let durationSec: string | null = null;
            if (kindParam !== "broll_image") {
              try {
                const tmp = await downloadToTempFile(objectKey, "/tmp");
                if (tmp) {
                  const { execFile } = await import("child_process");
                  const { promisify } = await import("util");
                  const probe = await promisify(execFile)("ffprobe", [
                    "-v", "quiet", "-print_format", "json", "-show_format", tmp,
                  ], { timeout: 30000 });
                  const d = parseFloat(JSON.parse(probe.stdout)?.format?.duration);
                  if (Number.isFinite(d)) durationSec = d.toFixed(2);
                  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
                }
              } catch { /* duration stays null */ }
            }
            const asset = await storage.createMediaAsset({
              userId: String(req.authUserId),
              kind: kindParam,
              name: filename.slice(0, 200),
              storagePath: objectKey,
              mimeType,
              durationSec,
            } as any);
            res.json({ asset: { ...asset, url: serveUrl } });
          })
          .catch((err: any) => {
            console.error("[MediaAssets] Upload failed:", err?.message);
            if (!res.headersSent) res.status(500).json({ error: "Upload failed" });
          });
      });
      bb.on("error", (err: any) => {
        if (!res.headersSent) res.status(400).json({ error: err?.message || "Malformed upload" });
      });
      bb.on("finish", () => {
        if (!handled && !res.headersSent) res.status(400).json({ error: "No file in request (multipart field expected)" });
      });
      req.pipe(bb);
    } catch (err: any) {
      console.error("[MediaAssets] Upload error:", err?.message);
      if (!res.headersSent) res.status(500).json({ error: "Upload failed" });
    }
  });

  // ── Credits: Stripe Checkout ──────────────────────────────────────

  app.get("/api/credits/packs", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { CREDIT_PACKS, checkoutAvailable } = await import("./lib/creditCheckout");
      const { getAllowance } = await import("./lib/aiGeneration");
      const gate = checkoutAvailable();
      const [allowance, purchases] = await Promise.all([
        getAllowance(String(req.authUserId)),
        storage.getCreditPurchases(String(req.authUserId), 10),
      ]);
      res.json({
        checkoutAvailable: gate.ok,
        checkoutDetail: gate.detail,
        packs: CREDIT_PACKS,
        allowance,
        purchases: purchases.map((p) => ({
          id: p.id, credits: p.credits, status: p.status,
          amountPaidCents: p.amountPaidCents, currency: p.currency,
          createdAt: p.createdAt, fulfilledAt: p.fulfilledAt,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to load packs" });
    }
  });

  app.post("/api/credits/checkout", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { createCheckoutSession } = await import("./lib/creditCheckout");
      // Origin from the request, not config: the app runs on a Replit preview
      // URL and a custom domain, and a hardcoded return URL sends the customer
      // to the wrong one after paying.
      const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const result = await createCheckoutSession({
        userId: String(req.authUserId),
        userEmail: req.authEmail ?? req.session?.googleUser?.email ?? null,
        packId: String(req.body?.packId ?? ""),
        origin: `${proto}://${host}`,
      });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err: any) {
      console.error("[Credits] checkout error:", err?.message);
      res.status(500).json({ error: err?.message || "Checkout failed" });
    }
  });

  /**
   * Stripe webhook — THE source of truth for granting credits.
   *
   * Deliberately NOT behind isFlexibleAuthenticated: Stripe has no session.
   * Authenticity comes from the signature over the RAW body, which is why
   * req.rawBody (captured by the express.json verify hook) is used rather
   * than the parsed body — JSON.stringify of a parsed object does not
   * byte-match what was signed, and verification would fail on any payload
   * with unusual key ordering or unicode.
   */
  app.post("/api/credits/webhook", async (req: any, res) => {
    const sig = req.headers["stripe-signature"] as string | undefined;
    if (!sig) return res.status(400).json({ error: "Missing signature" });

    const { verifyWebhook, fulfilCheckout } = await import("./lib/creditCheckout");
    const verified = verifyWebhook(req.rawBody ?? req.body, sig);
    if (!verified.ok) {
      console.error(`[Credits Webhook] Signature verification failed: ${verified.error}`);
      return res.status(400).json({ error: "Invalid signature" });
    }

    const event = verified.event;
    try {
      if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
        const result = await fulfilCheckout(event.data.object as any);
        console.log(`[Credits Webhook] ${event.type} → ${JSON.stringify(result)}`);
      }
      // Everything else is acknowledged and ignored. A 2xx tells Stripe to
      // stop retrying; a non-2xx on an event we simply don't handle would
      // have it retry that event for days.
      res.json({ received: true });
    } catch (err: any) {
      // A real failure DOES want a retry — 500 so Stripe redelivers, and the
      // idempotency gate makes that safe.
      console.error(`[Credits Webhook] Handling ${event.type} failed:`, err?.message);
      res.status(500).json({ error: "Handler failed" });
    }
  });

  // ── AI b-roll generation (the paid tier) ──────────────────────────

  app.get("/api/ai/generation/options", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { GEN_MODELS, generationAvailable, getAllowance, priceFor } = await import("./lib/aiGeneration");

      // A DEAD BUTTON IS THE WORST FAILURE MODE HERE. getAllowance reads
      // creator_credits, and when that table has not been pushed to this
      // environment the whole endpoint 500s — so the panel gets no models, the
      // generate button renders permanently disabled, and the operator is told
      // nothing at all. Degrade to an unavailable-with-a-reason response
      // instead, which the panel already knows how to render.
      let allowance;
      try {
        allowance = await getAllowance(String(req.authUserId));
      } catch (allowErr: any) {
        const msg = String(allowErr?.message ?? allowErr);
        const missingTable = /relation .* does not exist|does not exist/i.test(msg);
        console.error(`[AI] generation options unavailable: ${msg}`);
        return res.json({
          available: false,
          detail: missingTable
            ? "The credits tables are not in this environment's database yet. An admin can fix it from the placements page (\"Repair database schema\") or by running `npm run db:push` against this deployment."
            : `Credits are unavailable right now: ${msg}`,
          balance: 0,
          allowance: { freeImagesPerDay: 0, freeImagesUsedToday: 0, freeImagesLeft: 0, balance: 0 },
          models: [],
        });
      }
      // Price every model for THIS creator right now, so the button can say
      // "Free" or "10 credits" truthfully instead of the client guessing.
      const priced = await Promise.all(
        GEN_MODELS.map(async (m) => ({ m, p: await priceFor(String(req.authUserId), m) })),
      );
      res.json({
        available: generationAvailable(),
        detail: generationAvailable()
          ? null
          : "AI generation isn't configured on this server (FAL_KEY missing in this environment).",
        balance: allowance.balance,
        allowance,
        // Creators see credits and latency, never our unit cost.
        models: priced.map(({ m, p }) => ({
          id: m.id, kind: m.kind, label: m.label,
          credits: p.credits,
          listCredits: m.creditsPerGeneration,
          free: p.free,
          priceReason: p.reason,
          typicalSeconds: Math.round(m.typicalLatencyMs / 1000),
          outputSeconds: m.outputSeconds ?? null,
          seedsFromImage: !!m.seedsFromImage,
          notes: m.notes,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to load generation options" });
    }
  });

  app.post("/api/ai/generation", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { runGeneration } = await import("./lib/aiGeneration");
      const result = await runGeneration({
        userId: String(req.authUserId),
        modelId: String(req.body?.modelId ?? "image-fast"),
        prompt: String(req.body?.prompt ?? ""),
        promptSource: req.body?.promptSource === "transcript" ? "transcript" : "manual",
        editorialClipId: Number.isFinite(Number(req.body?.editorialClipId)) ? Number(req.body.editorialClipId) : null,
        aspectRatio: req.body?.aspectRatio === "16:9" ? "16:9" : "9:16",
        seedAssetId: Number.isFinite(Number(req.body?.seedAssetId)) ? Number(req.body.seedAssetId) : null,
      });
      const { getAllowance } = await import("./lib/aiGeneration");
      const allowance = await getAllowance(String(req.authUserId));
      // 402 for "you need to pay", so the client can branch to the upgrade
      // path rather than treating affordability as a generic failure.
      if (!result.ok) return res.status(result.needsCredits ? 402 : 400).json({ ...result, allowance });
      res.json({ ...result, balance: allowance.balance, allowance });
    } catch (err: any) {
      console.error("[AiGen] route error:", err?.message);
      res.status(500).json({ error: err?.message || "Generation failed" });
    }
  });

  // POST /api/ai/prompt-from-transcript — turn what's SAID into what to SHOW.
  /**
   * Review the clip, then say what belongs on screen and when.
   *
   * Answers the question the editor could not: the stock search and the
   * generator both started from a blank box, so the creator had to invent both
   * the moment and the query. This reads the transcript and hands back timed
   * proposals with the search terms and the prompt already written.
   *
   * Also reports which downstream tools are actually live, so the panel can
   * say "stock isn't configured" instead of returning an empty list that looks
   * like the feature is broken.
   */
  /**
   * Which features are actually switched on in THIS environment.
   *
   * Exists because "is the key set?" has cost several round trips: I cannot see
   * the deployment's env, and a Replit WORKSPACE secret is not automatically
   * present in a Deployment — so a key can be genuinely set and still absent
   * where it matters. This reports what the running process can see, grouped by
   * the feature it unlocks, and never returns a key's value.
   */
  app.get("/api/admin/config-status", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.map((e: string) => e.toLowerCase()).includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { resolveKey, KEY_ALIASES } = await import("./lib/envKeys");
      // Resolved the same way the features themselves resolve, so this screen
      // can never disagree with the code it is reporting on.
      const look = (names: readonly string[]) => resolveKey(names);
      const features = [
        {
          feature: "Cutaway suggestions",
          why: "Reads the transcript and proposes what to show and when.",
          groups: [KEY_ALIASES.anthropic],
          alsoOk: ["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"],
        },
        {
          feature: "Stock b-roll search",
          why: "Pexels / Pixabay footage in the editor. Either provider alone is enough.",
          groups: [KEY_ALIASES.pexels, KEY_ALIASES.pixabay],
          anyGroup: true,
        },
        {
          feature: "AI image + video generation",
          why: "The paid cutaway tier. Without it every generate button is dead.",
          groups: [KEY_ALIASES.fal],
        },
        {
          feature: "Buying credits (Stripe)",
          why: "Checkout stays OFF without the webhook secret — we will not take money we cannot fulfil. Admin credit grants work regardless.",
          groups: [KEY_ALIASES.stripeSecret, KEY_ALIASES.stripeWebhook],
        },
        {
          feature: "Video scanning (Gemini)",
          why: "Surface detection. Falls back to edge detection without it.",
          groups: [["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "AI_INTEGRATIONS_GEMINI_API_KEY"]],
        },
        {
          feature: "Transcription (Deepgram)",
          why: "Word timings — the editorial pipeline and captions depend on these.",
          groups: [KEY_ALIASES.deepgram],
        },
      ].map((f: any) => {
        const found = (f.groups as readonly string[][]).map((g) => look(g));
        const envFallback = (f.alsoOk ?? []).some((v: string) => !!process.env[v]);
        const live = f.anyGroup
          ? found.some(Boolean) || envFallback
          : found.every(Boolean) || (found.every((x) => !x) && envFallback);
        return {
          feature: f.feature,
          why: f.why,
          live,
          // The NAME each secret was found under — this is the whole point.
          // A key spelled "Fal_API_Key" is invisible to an exact match on
          // FAL_KEY, and that is exactly what happened here.
          foundAs: found.filter(Boolean).map((r: any) => r.source),
          missing: f.groups
            .filter((_g: any, i: number) => !found[i])
            .map((g: readonly string[]) => g[0]),
          accepts: f.groups.map((g: readonly string[]) => g.join(" | ")),
        };
      });

      res.json({
        // So it is obvious WHICH environment answered.
        environment: process.env.NODE_ENV || "development",
        build: process.env.BUILD_COMMIT || "dev",
        features,
        note: "A Replit workspace secret is NOT automatically present in a Deployment. This reflects the process that served this request.",
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed" });
    }
  });

  app.post("/api/ai/suggest-cutaways", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { suggestCutaways, suggestAvailable } = await import("./lib/ai/cutawaySuggest");
      const { anyProviderConfigured } = await import("./lib/stockProviders");
      const { generationAvailable } = await import("./lib/aiGeneration");

      const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
      const clean = lines
        .filter((l: any) => Number.isFinite(Number(l?.start)) && Number.isFinite(Number(l?.end)) && String(l?.text ?? "").trim())
        .map((l: any) => ({ start: Number(l.start), end: Number(l.end), text: String(l.text) }))
        .slice(0, 400);

      if (!suggestAvailable()) {
        return res.json({
          suggestions: [],
          available: false,
          detail: "Cutaway suggestions need ANTHROPIC_API_KEY (or the Replit AI integration) in this environment.",
          stockLive: anyProviderConfigured(),
          aiLive: generationAvailable(),
        });
      }
      if (clean.length === 0) {
        return res.json({
          suggestions: [],
          available: true,
          detail: "No transcript for this clip yet — cutaway suggestions read the words to find the moments.",
          stockLive: anyProviderConfigured(),
          aiLive: generationAvailable(),
        });
      }

      const suggestions = await suggestCutaways(clean, {
        clipStart: Number.isFinite(Number(req.body?.clipStart)) ? Number(req.body.clipStart) : undefined,
        clipEnd: Number.isFinite(Number(req.body?.clipEnd)) ? Number(req.body.clipEnd) : undefined,
      });

      res.json({
        suggestions,
        available: true,
        detail: suggestions.length === 0
          ? "Nothing in this clip clearly needs a cutaway — that is a normal answer for a strong talking-head cut."
          : null,
        stockLive: anyProviderConfigured(),
        aiLive: generationAvailable(),
      });
    } catch (err: any) {
      console.error("[AI] suggest-cutaways error:", err?.message);
      res.status(500).json({ error: err?.message || "Failed to suggest cutaways" });
    }
  });

  app.post("/api/ai/prompt-from-transcript", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { promptFromTranscript } = await import("./lib/aiGeneration");
      res.json({ prompt: promptFromTranscript(String(req.body?.text ?? "")) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed" });
    }
  });

  // Admin: what this tier actually earns. Cost and revenue from the same rows.
  app.get("/api/admin/ai-economics", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const days = Math.min(365, Math.max(1, parseInt(String(req.query.days ?? "30")) || 30));
      const econ = await storage.getGenerationEconomics(days);
      const { micosToUsd, marginReport } = await import("./lib/aiGeneration");
      res.json({
        windowDays: days,
        ...econ,
        costUsd: micosToUsd(econ.costMicros),
        // Configured margin per model, so an underpriced model is visible
        // here rather than discovered in a monthly invoice.
        pricing: marginReport(),
        // Margin needs a credit price, which is a business decision — the
        // endpoint reports units and cost, and leaves pricing to the caller
        // rather than inventing a number.
        note: "creditsCharged counts SUCCEEDED generations only; costMicros includes failures, which is where margin leaks.",
        byModel: econ.byModel.map((m) => ({ ...m, costUsd: micosToUsd(m.costMicros) })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed" });
    }
  });

  // Admin: grant credits (plan allowance, purchase, goodwill).
  app.post("/api/admin/credits/grant", async (req: any, res) => {
    try {
      const callerEmail = req.session?.googleUser?.email || req.user?.claims?.email;
      if (!callerEmail || !ADMIN_EMAILS.includes(String(callerEmail).toLowerCase())) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { userId, amount, reason, note } = req.body || {};
      const amt = parseInt(String(amount));
      if (!userId || !Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: "userId and a positive amount are required" });
      }
      const balance = await storage.grantCredits(
        String(userId), amt,
        ["plan", "purchase", "manual", "refund"].includes(String(reason)) ? String(reason) : "manual",
        note ? String(note).slice(0, 300) : undefined,
        String(callerEmail),
      );
      console.log(`[Credits] ${callerEmail} granted ${amt} to ${userId} → ${balance}`);
      res.json({ ok: true, balance });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Grant failed" });
    }
  });

  // GET /api/media-assets/stock/status — is stock search actually configured
  // IN THIS ENVIRONMENT? Replit secrets set on the workspace are not
  // automatically present in a Deployment, which is the same dev/prod split
  // that made DATABASE_URL so painful to diagnose. Answer it directly rather
  // than making someone infer it from a failed search.
  app.get("/api/media-assets/stock/status", isFlexibleAuthenticated, async (_req: any, res) => {
    try {
      const { providerStatuses, anyProviderConfigured } = await import("./lib/stockProviders");
      const providers = providerStatuses();
      res.json({
        available: anyProviderConfigured(),
        providers,
        detail: providers.map((p) => `${p.label}: ${p.configured ? "live" : "not configured"}`).join(" · "),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Status check failed" });
    }
  });

  // GET /api/media-assets/stock/search?q= — Pexels b-roll search.
  // Registered BEFORE /api/media-assets/:id-shaped routes so "stock" is never
  // parsed as an id.
  app.get("/api/media-assets/stock/search", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { searchAllProviders, providerStatuses } = await import("./lib/stockProviders");
      const statuses = providerStatuses();
      const result = await searchAllProviders(String(req.query.q ?? ""), {
        orientation: req.query.orientation === "landscape" ? "landscape" : "portrait",
      });
      if (result.configuredCount === 0) {
        // No provider configured is a setup problem, not a search failure —
        // 501 so the client can say what to do instead of "no results".
        return res.status(501).json({
          error: statuses.map((s) => s.detail).join(" "),
          providers: statuses,
        });
      }
      // Partial failure still returns results: one dead key must not take the
      // other library down with it.
      res.json({ videos: result.videos, errors: result.errors, providers: statuses });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Stock search failed" });
    }
  });

  // POST /api/media-assets/stock/import — pull a chosen stock clip into the
  // creator's own assets. Downloaded, not hotlinked: ffmpeg needs a local
  // file, and a CDN URL could change or 404 under a saved edit later.
  app.post("/api/media-assets/stock/import", isFlexibleAuthenticated, async (req: any, res) => {
    const tmpPath = `/tmp/stock-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;
    try {
      const { fileUrl, name, durationSec, photographer, pageUrl } = req.body || {};
      // Only our own provider's host — this endpoint downloads whatever URL
      // it is handed, so it must not become a general-purpose fetcher (SSRF).
      // Hostname is parsed and compared exactly; a regex here would accept
      // notpexels.com and pexels.com.evil.com.
      const { downloadStockVideo, isAllowedStockUrl } = await import("./lib/stockProviders");
      if (typeof fileUrl !== "string" || !isAllowedStockUrl(fileUrl)) {
        return res.status(400).json({ error: "That URL isn't from a supported stock provider" });
      }
      const dl = await downloadStockVideo(fileUrl, tmpPath);
      if (!dl.ok) return res.status(502).json({ error: dl.error });

      const safeName = String(name ?? "Stock clip").replace(/[^\w\s.-]/g, "").slice(0, 120) || "Stock clip";
      const objectKey = `public/media-assets/${encodeURIComponent(String(req.authUserId))}/${Date.now()}-stock.mp4`;
      const serveUrl = await uploadFileToStorage(tmpPath, objectKey);

      const asset = await storage.createMediaAsset({
        userId: String(req.authUserId),
        kind: "broll_video",
        name: photographer ? `${safeName} — ${String(photographer).slice(0, 60)}` : safeName,
        storagePath: objectKey,
        mimeType: "video/mp4",
        fileSizeBytes: dl.bytes,
        durationSec: Number.isFinite(Number(durationSec)) ? String(Number(durationSec).toFixed(2)) : null,
      } as any);

      console.log(`[Stock] ${req.authUserId} imported Pexels clip (${(dl.bytes / 1024 / 1024).toFixed(1)}MB) from ${pageUrl ?? fileUrl}`);
      res.json({ asset: { ...asset, url: serveUrl } });
    } catch (err: any) {
      console.error("[Stock] import error:", err?.message);
      res.status(500).json({ error: err?.message || "Import failed" });
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
    }
  });

  app.get("/api/media-assets", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
      const assets = await storage.getMediaAssetsForUser(String(req.authUserId), kind);
      res.json({
        assets: assets.map((a) => ({ ...a, url: storageServeUrl(a.storagePath) })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to list assets" });
    }
  });

  app.delete("/api/media-assets/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const ok = await storage.softDeleteMediaAsset(parseInt(req.params.id), String(req.authUserId));
      if (!ok) return res.status(404).json({ error: "Asset not found" });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Delete failed" });
    }
  });

  // POST /api/editorial-clips/:clipId/analyze-silence — measure the dead air.
  // Synchronous by design: audio-only decode of a clip range runs far faster
  // than realtime, and the editor wants the spans to draw immediately.
  app.post("/api/editorial-clips/:clipId/analyze-silence", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      if (isNaN(clipId)) return res.status(400).json({ error: "Invalid clip ID" });
      const clip = await storage.getEditorialClipById(clipId);
      if (!clip) return res.status(404).json({ error: "Clip not found" });
      const video = await storage.getVideoById(clip.videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!(await isSameCreator(String(video.userId), req.authUserId)) && !req.isAdmin) {
        return res.status(403).json({ error: "Not your clip" });
      }

      // Resolve a local source path the same way renders do.
      let sourcePath = (video as any).filePath as string | null;
      let pinDir: string | null = null;
      let tmpFile: string | null = null;
      try {
        if (sourcePath?.startsWith("/storage/")) {
          tmpFile = await downloadToTempFile(sourcePath.replace(/^\/storage\//, "public/"), "/tmp");
          sourcePath = tmpFile;
        } else if (sourcePath) {
          sourcePath = path.resolve(process.cwd(), sourcePath);
        } else {
          const { getPinnedSourcePath } = await import("./lib/sourceCache");
          pinDir = `/tmp/silence-pin-${clipId}-${Date.now()}`;
          sourcePath = await getPinnedSourcePath(video as any, pinDir);
        }
        if (!sourcePath || !fs.existsSync(sourcePath)) {
          return res.status(400).json({ error: "Source video is not available right now — try again shortly" });
        }

        const { analyzeSilence } = await import("./lib/remix/silenceAnalysis");
        const clipDuration = Number(clip.duration) || (Number(clip.clipEnd) - Number(clip.clipStart));
        const analysis = await analyzeSilence(sourcePath, Number(clip.clipStart), clipDuration, {
          thresholdDb: req.body?.thresholdDb,
          minDurationSec: req.body?.minDurationSec,
        });
        if (analysis.unavailableReason) {
          return res.status(501).json({ error: analysis.unavailableReason });
        }
        const stored = {
          spans: analysis.spans,
          totalSilentSec: analysis.totalSilentSec,
          thresholdDb: analysis.thresholdDb,
          minDurationSec: analysis.minDurationSec,
          analyzedAt: new Date().toISOString(),
        };
        await storage.updateEditorialClipEdit(clipId, { silenceAnalysis: stored });
        res.json(stored);
      } finally {
        if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } }
        if (pinDir) { try { fs.rmSync(pinDir, { recursive: true, force: true }); } catch { /* ignore */ } }
      }
    } catch (err: any) {
      console.error("[API] analyze-silence error:", err?.message);
      res.status(500).json({ error: err?.message || "Silence analysis failed" });
    }
  });

  // POST /api/editorial-clips/:clipId/scan — make this clip's placement
  // inventory real. Brands were browsing clips with zero products offered
  // simply because the range had never been scanned; nothing said so.
  app.post("/api/editorial-clips/:clipId/scan", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      if (isNaN(clipId)) return res.status(400).json({ error: "Invalid clip ID" });
      const clip = await storage.getEditorialClipById(clipId);
      if (!clip) return res.status(404).json({ error: "Clip not found" });
      const video = await storage.getVideoById(clip.videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!(await isSameCreator(String(video.userId), req.authUserId)) && !req.isAdmin) {
        return res.status(403).json({ error: "Not your clip" });
      }

      if (clipScansInFlight.has(clipId)) {
        return res.status(409).json({ error: "This clip is already being scanned", ...clipScansInFlight.get(clipId) });
      }

      const { isVideoScanInFlight, denseScanRange } = await import("./scanner_v2");
      const allSurfaces = await storage.getDetectedSurfaces(clip.videoId);

      if (allSurfaces.length === 0) {
        // The SOURCE was never scanned — no amount of range work helps. Run
        // the full scan (fixture identity, scene inventory and room-model
        // linkage all live there; a per-clip detector would fork the fixture
        // model the research design depends on).
        if (isVideoScanInFlight(clip.videoId)) {
          return res.status(202).json({ mode: "full_scan", alreadyRunning: true, message: "The source video is already being scanned — this clip's surfaces appear when it finishes." });
        }
        clipScansInFlight.set(clipId, { mode: "full_scan", startedAt: Date.now() });
        setImmediate(async () => {
          try {
            await processVideoScan(clip.videoId, true);
          } catch (err: any) {
            console.error(`[ClipScan] Full scan for clip ${clipId} (video ${clip.videoId}) failed: ${err?.message}`);
          } finally {
            clipScansInFlight.delete(clipId);
          }
        });
        return res.status(202).json({ mode: "full_scan", message: "Source video was never scanned — running the full scan. This takes a while; the clip updates when it finishes." });
      }

      // Source is scanned — densify THIS range so coverage inside the clip is
      // real placement inventory rather than whatever frames the sparse pass
      // happened to sample.
      clipScansInFlight.set(clipId, { mode: "densify", startedAt: Date.now() });
      const rangeStart = Number(clip.clipStart);
      const rangeEnd = Number(clip.clipEnd);
      setImmediate(async () => {
        try {
          const result = await denseScanRange(clip.videoId, rangeStart, rangeEnd, allSurfaces.map((sf) => sf.id), 0.5);
          console.log(`[ClipScan] Densify for clip ${clipId}: ${result.keyframesCreated} keyframe(s) over ${rangeStart.toFixed(1)}–${rangeEnd.toFixed(1)}s`);
        } catch (err: any) {
          console.error(`[ClipScan] Densify for clip ${clipId} failed: ${err?.message}`);
        } finally {
          clipScansInFlight.delete(clipId);
        }
      });
      return res.status(202).json({ mode: "densify", message: "Scanning this clip's range for placement surfaces — usually a few minutes." });
    } catch (err: any) {
      console.error("[API] /api/editorial-clips/:clipId/scan error:", err.message);
      res.status(500).json({ error: err.message || "Scan failed" });
    }
  });

  // GET /api/editorial-clips/:clipId/surfaces — Just the surfaces inside this clip's
  // time range. Used by BrandPlacementRequestModal when in clip-targeted mode.
  app.get("/api/editorial-clips/:clipId/surfaces", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      if (isNaN(clipId)) return res.status(400).json({ error: "Invalid clip ID" });
      const surfaces = (await storage.getSurfacesInEditorialClip(clipId)).filter(isSellableSurface);

      // Ship the scene inventory too, projected down to the fixtures that
      // actually appear in this clip. Consumers build their one-row-per-
      // physical-fixture picker from it and fall back to raw per-frame
      // detection rows when it's absent — which is what clip-targeted requests
      // were getting, because only the video-mode endpoint returned it.
      let sceneInventory: any = null;
      try {
        const clip = await storage.getEditorialClipById(clipId);
        const video = clip ? await storage.getVideoById(clip.videoId) : undefined;
        const inv: any = (video as any)?.sceneInventory;
        if (inv && Array.isArray(inv.scenes)) {
          const clipGroupIds = new Set(
            surfaces.map((s: any) => s.surfaceGroupId).filter(Boolean),
          );
          const scenes = inv.scenes
            .map((sc: any) => ({
              ...sc,
              surfaces: (sc.surfaces ?? []).filter((sf: any) => clipGroupIds.has(sf.groupId)),
            }))
            .filter((sc: any) => sc.surfaces.length > 0);
          if (scenes.length > 0) sceneInventory = { ...inv, scenes };
        }
      } catch (invErr: any) {
        console.warn(`[API] clip ${clipId} scene-inventory projection failed (non-fatal): ${invErr?.message}`);
      }

      // Scan state rides along so the picker can explain an empty list —
      // "no surfaces" and "never scanned" are different answers.
      const clipForState = await storage.getEditorialClipById(clipId);
      let videoScanned = surfaces.length > 0;
      if (!videoScanned && clipForState) {
        videoScanned = (await storage.getDetectedSurfaces(clipForState.videoId)).length > 0;
      }
      const inflight = clipScansInFlight.get(clipId) ?? null;
      res.json({
        surfaces,
        sceneInventory,
        count: surfaces.length,
        scanState: {
          inFlight: !!inflight,
          mode: inflight?.mode ?? null,
          startedAt: inflight?.startedAt ?? null,
          videoScanned,
        },
      });
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
          const product = p.brandProductId != null ? await storage.getBrandProduct(p.brandProductId) : undefined;
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
      const { videoId, surfaceId, productId, productImageUrl, transform, blend, sceneGroupId, role, bidId, harmonizedImageUrl, isHarmonized, keyframes, appliesToGroupIds, editorialClipId } = req.body;

      if (!videoId || !surfaceId || !productImageUrl || !transform || !blend) {
        return res.status(400).json({ error: "Missing required fields: videoId, surfaceId, productImageUrl, transform, blend" });
      }

      // Ownership: creators place on their OWN videos; brand accounts may
      // place on marketplace videos (the product's whole flow — still gated
      // by creator approval downstream). Random creators writing placements
      // onto strangers' videos is neither.
      const targetVideo = await storage.getVideoById(parseInt(String(videoId)));
      if (!targetVideo) return res.status(404).json({ error: "Video not found" });
      const ownsTargetVideo = await isSameCreator(String((targetVideo as any).userId ?? ""), String(req.authUserId ?? ""));
      if (!ownsTargetVideo && !req.isAdmin) {
        const viewRole = (req.session as any)?.viewRole;
        const allowedUser = await storage.getAllowedUser(req.authEmail);
        const effectiveRole = viewRole || allowedUser?.userType || "creator";
        if (effectiveRole !== "brand") {
          return res.status(403).json({ error: "You can only place products on your own videos" });
        }
      }

      // BRAND SCOPING — the boundary the catalog listing only hints at.
      //
      // Restricting which products a creator can SEE is presentation; this is
      // the rule. A creator may place a brand's product only if that brand
      // selected them — requested a placement, or bid on their inventory.
      // Without this, the previous open catalog could be replayed with a
      // productId straight to this endpoint, which is how a brand ended up in
      // a creator's content having never engaged them.
      //
      // Brands placing into their own flow, and admins, are unaffected.
      if (productId != null && !req.isAdmin) {
        const viewRoleForProduct = (req.session as any)?.viewRole;
        const allowedForProduct = req.authEmail
          ? await storage.getAllowedUser(req.authEmail).catch(() => undefined)
          : undefined;
        const actingAsBrand = (viewRoleForProduct || (allowedForProduct as any)?.userType) === "brand";
        if (!actingAsBrand) {
          const permitted = await storage.getBrandProductsForCreator(req.authUserId, req.authEmail);
          const ok = permitted.some((p: any) => Number(p.id) === Number(productId));
          if (!ok) {
            console.warn(`[Placements] ${userEmail} tried to place product ${productId} with no brand relationship`);
            return res.status(403).json({
              error: "That brand hasn't selected you yet. Brands choose creators first — once one requests a placement or bids on your video, their products appear here.",
            });
          }
        }
      }

      // Clip scoping: when the creator framed this placement inside a specific
      // editorial clip, record it. The clip must belong to the same video —
      // otherwise a placement would claim a framing for a cut it never appears
      // in, and the render would pick it up.
      let clipIdForRow: number | null = null;
      if (editorialClipId !== undefined && editorialClipId !== null) {
        const parsedClipId = parseInt(String(editorialClipId));
        if (!Number.isFinite(parsedClipId)) {
          return res.status(400).json({ error: "editorialClipId must be a number" });
        }
        const clip = await storage.getEditorialClipById(parsedClipId);
        if (!clip) return res.status(404).json({ error: "Editorial clip not found" });
        if (Number(clip.videoId) !== parseInt(String(videoId))) {
          return res.status(400).json({ error: "That clip belongs to a different video" });
        }
        clipIdForRow = parsedClipId;
      }

      // Placement scoping: a PRESENT appliesToGroupIds (including []) is the
      // creator's explicit scope — one row, no fan-out. [] means "anchor
      // surface only"; a list names exactly the canonical surfaces (by
      // surfaceGroupId) the placement applies to. Absent field = legacy
      // client = auto-propagation behavior below, and the row stays null.
      const scopeProvided = appliesToGroupIds !== undefined;
      let scopeGroupIds: string[] | null = null;
      if (scopeProvided) {
        if (
          !Array.isArray(appliesToGroupIds) ||
          appliesToGroupIds.length > 64 ||
          appliesToGroupIds.some((g: any) => typeof g !== "string" || g.length === 0)
        ) {
          return res.status(400).json({ error: "appliesToGroupIds must be an array of at most 64 non-empty strings" });
        }
        scopeGroupIds = [...new Set(appliesToGroupIds as string[])];
      }

      // Validate keyframes shape if provided. Each entry must have `t` and
      // a complete transform — partial keyframes break the lerp.
      let validatedKeyframes: any = null;
      if (Array.isArray(keyframes)) {
        validatedKeyframes = keyframes
          .filter((k: any) =>
            typeof k?.t === "number" &&
            typeof k?.transform?.offsetX === "number" &&
            typeof k?.transform?.offsetY === "number" &&
            typeof k?.transform?.scale === "number" &&
            typeof k?.transform?.rotation === "number" &&
            typeof k?.transform?.flipH === "boolean",
          )
          .sort((a: any, b: any) => a.t - b.t);
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
        editorialClipId: clipIdForRow,
        productId: productId || null,
        productImageUrl,
        createdBy: userEmail,
        role: role || "creator",
        bidId: bidId || null,
        sceneGroupId: computedGroupId,
        appliesToGroupIds: scopeGroupIds,
        transform,
        blend,
        status: "active",
        harmonizedImageUrl: harmonizedImageUrl || null,
        isHarmonized: !!isHarmonized,
        keyframes: validatedKeyframes,
      });

      // Auto-propagate to matching surfaces in the same scene group (scene persistence)
      // Uses fuzzy spatial matching: same surface type + bounding box center within 20% tolerance
      // Skipped entirely when the creator sent an explicit scope — the single
      // anchor row plus its appliesToGroupIds list already says where the
      // placement applies; cloning rows would reintroduce the fan-out.
      let propagatedCount = 0;
      if (computedGroupId && !scopeProvided) {
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
            // Propagated placements inherit harmonization state from the
            // anchor — if the creator picked "Harmonized" for the anchor
            // surface, every surface in the same scene group also gets
            // saved as harmonized. The harmonizedImageUrl is anchor-specific
            // (different bbox = different render), so we don't copy the
            // URL — render pipeline regenerates per-surface from
            // isHarmonized=true.
            await storage.savePlacement({
              videoId,
              surfaceId: surface.id,
              // Propagated rows inherit the clip intent from the anchor —
              // otherwise the render's exact-clip lookup would find the anchor
              // but not its scene siblings.
              editorialClipId: clipIdForRow,
              productId: productId || null,
              productImageUrl,
              createdBy: userEmail,
              role: role || "creator",
              sceneGroupId: computedGroupId,
              transform,
              blend,
              status: "active",
              harmonizedImageUrl: null,
              isHarmonized: !!isHarmonized,
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

      console.log(`[Placements] Saved placement ${placement.id} for video ${videoId} surface ${surfaceId} by ${userEmail} ${scopeProvided ? `(explicit scope: ${scopeGroupIds!.length} group id${scopeGroupIds!.length === 1 ? "" : "s"}, no fan-out)` : `(propagated to ${propagatedCount} additional surfaces)`}`);

      recordCreatorEvent({
        creatorUserId: String((targetVideo as any)?.userId ?? req.authUserId),
        actorUserId: String(req.authUserId),
        eventType: "placement_created",
        videoId: parseInt(String(videoId)),
        surfaceId: parseInt(String(surfaceId)),
        placementId: placement.id,
        brandProductId: productId ?? null,
        metadata: { scoped: scopeProvided, propagatedCount },
      });

      // The human step starts HERE: the creator chose a placement; a human
      // at FullScale reviews it and produces the final render. Until this
      // email existed, saves were silent and the ops step could never begin.
      (async () => {
        try {
          const { sendPlacementSubmittedNotification } = await import("./lib/resend");
          await sendPlacementSubmittedNotification({
            placementId: placement.id,
            creatorEmail: userEmail,
            videoTitle: (targetVideo as any)?.title ?? `video ${videoId}`,
          });
        } catch (e: any) {
          console.warn(`[Placements] Review-notification email failed (non-fatal): ${e?.message}`);
        }
      })();

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
  app.get("/api/video/:videoId/surface/:surfaceId/placement", mediaLimiter, softAuth, requireVideoAccess, async (req: any, res) => {
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

      const allSurfaces = await storage.getDetectedSurfaces(videoId);
      const targetSurface = allSurfaces.find(s => s.id === surfaceId);
      if (targetSurface) {
        const tType = targetSurface.surfaceType.toLowerCase();
        const tSceneId = (targetSurface as any).sceneId;

        // EXPLICIT SCOPE (decisive): rows saved with appliesToGroupIds carry
        // the creator's exact answer to "where does this apply" — they match
        // iff the target's canonical groupId is in the list, and they never
        // fall through to the heuristic tiers below (an empty list means
        // anchor-only, and the anchor was already served by the direct match
        // above). Legacy rows (null scope) skip this tier untouched.
        const tGroupId = (targetSurface as any).surfaceGroupId;
        for (const p of videoplacements) {
          const scope = (p as any).appliesToGroupIds;
          if (scope == null) continue;
          if (tGroupId && Array.isArray(scope) && scope.includes(tGroupId)) {
            return res.json({ placement: p, source: "scope_match" });
          }
        }

        // GROUP MATCH (strongest): the scanner stamps one surfaceGroupId
        // per canonical physical surface, so two rows sharing a groupId
        // ARE the same desk/wall — no type or scene inference needed.
        // Legacy rows (null groupId) fall through to the scene/fuzzy
        // heuristics below; differing groups of the same type also fall
        // through, so pre-groupId behavior is unchanged for them.
        if (tGroupId) {
          for (const p of videoplacements) {
            if ((p as any).appliesToGroupIds != null) continue; // scoped rows decided above
            const pSurface = allSurfaces.find(s => s.id === p.surfaceId);
            if (!pSurface) continue;
            // Rescans retire prior-generation rows as "Filtered" without
            // clearing surfaceGroupId, and group ids restart each scan —
            // a retired row's groupId can collide with a new scan's group
            // and anchor the placement to the wrong physical surface.
            if (pSurface.surfaceType === "Filtered") continue;
            // Same collision family: a colliding groupId from another scan
            // generation can pair a Desk with a Wall — same-group rows for
            // the same physical surface always share a type, so require it.
            if (pSurface.surfaceType.toLowerCase() !== tType) continue;
            if ((pSurface as any).surfaceGroupId === tGroupId) {
              return res.json({ placement: p, source: "group_match" });
            }
          }
        }

        // FIXTURE BOUNDARY: a target that CARRIES a canonical identity is
        // decided entirely by the identity tiers above (explicit scope,
        // exact group). The heuristic tiers below predate surface identity
        // and would hand Wall 4's placement to Wall 2 — same type, same
        // scene, different fixture — which is exactly the cross-fixture
        // bleed the fixture model forbids. They remain ONLY for legacy
        // rows with no groupId, where heuristics are all we have.
        if (tGroupId) {
          return res.json({ placement: null });
        }

        // SCENE MATCH (preferred): same sceneId + same surfaceType. Scene
        // clustering means :08 and :46 in a podcast that flips host↔guest
        // both resolve to the same coffee table. Drop a mug at :08, click
        // :46, you see the mug — no re-establishing required.
        if (typeof tSceneId === "number") {
          for (const p of videoplacements) {
            if ((p as any).appliesToGroupIds != null) continue; // scoped rows decided above
            const pSurface = allSurfaces.find(s => s.id === p.surfaceId);
            if (!pSurface) continue;
            if ((pSurface as any).sceneId !== tSceneId) continue;
            if (pSurface.surfaceType.toLowerCase() !== tType) continue;
            return res.json({ placement: p, source: "scene_match" });
          }
        }

        // Fallback: fuzzy spatial match (same type + nearby center). Used
        // for surfaces detected before sceneId existed. CRITICAL: when
        // BOTH surfaces have sceneIds and they differ, refuse the match —
        // a "Table" in scene 0 (host's coffee table) and a "Table" in
        // scene 1 (guest's side table) at similar normalized centers
        // were getting matched and product was visually "moving" between
        // scenes. The scene check above already covers same-scene; this
        // fallback now only fires when sceneId is truly unknown.
        const tBBX = parseFloat(String(targetSurface.boundingBoxX));
        const tBBY = parseFloat(String(targetSurface.boundingBoxY));
        const tBBW = parseFloat(String(targetSurface.boundingBoxWidth));
        const tBBH = parseFloat(String(targetSurface.boundingBoxHeight));
        const tCX = tBBX + tBBW / 2;
        const tCY = tBBY + tBBH / 2;
        const FUZZY_TOLERANCE = 0.20;

        for (const p of videoplacements) {
          if ((p as any).appliesToGroupIds != null) continue; // scoped rows decided above
          const pSurface = allSurfaces.find(s => s.id === p.surfaceId);
          if (!pSurface || pSurface.surfaceType.toLowerCase() !== tType) continue;
          // Hard gate: if both have sceneIds and they differ, never match.
          // Just as hard: if only ONE side has a sceneId (mixed-generation
          // pair — new scan vs. pre-sceneId row), refuse too; those pairs
          // were fuzzy-matching across scenes. Only null-null pairs, i.e.
          // pure-legacy videos, may still fuzzy-match.
          const pSceneId = (pSurface as any).sceneId;
          const tHasScene = typeof tSceneId === "number";
          const pHasScene = typeof pSceneId === "number";
          if (tHasScene !== pHasScene) continue;
          if (tHasScene && pHasScene && tSceneId !== pSceneId) continue;
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
  /**
   * One placement's image, owner- or admin-gated. Mirrors the admin queue's
   * thumb route: decode a stored data: URL, redirect an ordinary one. Exists so
   * the list above can ship pointers instead of base64.
   */
  app.get("/api/placements/:id/thumb", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid placement id" });
      const row: any = await storage.getPlacementById(id);
      if (!row) return res.status(404).json({ error: "Not found" });

      const isOwner = row.createdBy === req.authEmail || row.createdBy === req.authUserId;
      if (!isOwner && !req.isAdmin) return res.status(404).json({ error: "Not found" });

      const wantHarmonized = req.query.harmonized === "1";
      const src = wantHarmonized
        ? (row.harmonizedImageUrl || row.productImageUrl)
        : (row.productImageUrl || row.harmonizedImageUrl);
      if (!src) return res.status(404).json({ error: "No image" });

      const m = /^data:([\w/+.-]+);base64,([\s\S]*)$/.exec(src);
      if (m) {
        const buf = Buffer.from(m[2], "base64");
        res.setHeader("Content-Type", m[1]);
        res.setHeader("Content-Length", String(buf.length));
        res.setHeader("Cache-Control", "private, max-age=86400");
        return res.end(buf);
      }
      return res.redirect(302, src);
    } catch (err: any) {
      console.error("[Placements] Thumb error:", err?.message);
      return res.status(500).json({ error: "Failed to load image" });
    }
  });

  app.get("/api/placements", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      // Admins see the platform; everyone else sees THEIR placements only.
      // This endpoint was unauthenticated and returned every placement on
      // the platform (incl. creator emails in the client's preview modal).
      // Projected + bounded. The unprojected version carried a full-scene
      // harmonized PNG and a raw creator upload — both base64 — for EVERY
      // active placement on the platform, with no limit. Same defect that made
      // the review queue time out, except it grows without bound.
      const all = await storage.getActivePlacementsLean();
      const placements = req.isAdmin
        ? all
        : all.filter((p: any) =>
            p.createdBy === req.authEmail || p.createdBy === req.authUserId);

      // Enrich with video titles/thumbnails
      // One projected query, not one full row per video. getVideoById drags
      // back scene_index and scene_inventory — megabytes of jsonb that the pg
      // driver parses synchronously, stalling every other request in flight.
      const videoIds = [...new Set(placements.map(p => p.videoId))];
      const videoMap = await storage.getVideoSummaries(videoIds);

      const enriched = placements.map((p: any) => ({
        ...p,
        // Same field name the client already renders as an <img src>, but a
        // POINTER rather than the bytes — so the preview modal and the cards
        // keep working unchanged while the payload stops carrying megabytes.
        productImageUrl: p.hasProductImage ? `/api/placements/${p.id}/thumb` : null,
        harmonizedImageUrl: p.hasHarmonized ? `/api/placements/${p.id}/thumb?harmonized=1` : null,
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
  app.get("/api/video/:videoId/placements", mediaLimiter, softAuth, requireVideoAccess, async (req: any, res) => {
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
  // Ownership check for a placement: the creator who owns the underlying
  // video, the user who created the placement, or an admin. Prevents the
  // cross-tenant IDOR where any logged-in user could rewrite/delete any
  // placement by iterating integer IDs.
  async function authorizePlacement(placementId: number, req: any): Promise<{ ok: boolean; status: number }> {
    const placement = await storage.getPlacementById(placementId);
    if (!placement) return { ok: false, status: 404 };
    if (req.isAdmin) return { ok: true, status: 200 };
    if (placement.createdBy && placement.createdBy === req.authEmail) {
      return { ok: true, status: 200 };
    }
    const video = placement.videoId ? await storage.getVideoById(placement.videoId) : null;
    if (video && (await isSameCreator(String(video.userId), req.authUserId))) {
      return { ok: true, status: 200 };
    }
    return { ok: false, status: 403 };
  }

  app.patch("/api/placements/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const placementId = parseInt(req.params.id);
      if (isNaN(placementId)) {
        return res.status(400).json({ error: "Invalid placement ID" });
      }

      const auth = await authorizePlacement(placementId, req);
      if (!auth.ok) {
        return res.status(auth.status).json({ error: auth.status === 404 ? "Placement not found" : "Not authorized to modify this placement" });
      }

      // Defensive validation for keyframes — incomplete entries break the
      // render-time lerp (NaN propagates and product disappears).
      const updates = { ...req.body };
      if ("keyframes" in updates) {
        if (Array.isArray(updates.keyframes)) {
          updates.keyframes = updates.keyframes
            .filter((k: any) =>
              typeof k?.t === "number" &&
              typeof k?.transform?.offsetX === "number" &&
              typeof k?.transform?.offsetY === "number" &&
              typeof k?.transform?.scale === "number" &&
              typeof k?.transform?.rotation === "number" &&
              typeof k?.transform?.flipH === "boolean",
            )
            .sort((a: any, b: any) => a.t - b.t);
        } else if (updates.keyframes === null) {
          // Explicit null = clear all keyframes.
        } else {
          delete updates.keyframes;
        }
      }

      const updated = await storage.updatePlacement(placementId, updates);
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

      const auth = await authorizePlacement(placementId, req);
      if (!auth.ok) {
        return res.status(auth.status).json({ error: auth.status === 404 ? "Placement not found" : "Not authorized to delete this placement" });
      }

      const deleted = await storage.deletePlacement(placementId);
      if (!deleted) {
        return res.status(404).json({ error: "Placement not found" });
      }
      storage.closeFixtureAssignment({ placementId }, "archived")
        .then((n) => n && console.log(`[Measurement] fixture_assignments: closed ${n} window(s) — placement ${placementId} archived`))
        .catch(() => {});

      res.json({ success: true });
    } catch (err: any) {
      console.error("[Placements] Delete error:", err.message);
      res.status(500).json({ error: "Failed to delete placement" });
    }
  });

  // Get scene groups for a video (computed from surfaces)
  app.get("/api/video/:videoId/scene-groups", mediaLimiter, softAuth, requireVideoAccess, async (req: any, res) => {
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

  // ── Teach-a-surface ──
  // The creator can SEE a surface the detector keeps missing. Teaching = one
  // bbox drawn on a frame + a type pick; the surface enters the creator's
  // room model as a known surface, so every future scan of that set CONFIRMS
  // it (re-locates it per frame) instead of hoping detection finds it. The
  // scene class anchors the teach: its exemplar hashes are matched against
  // the creator's stored models exactly the way the scanner does at scan
  // start — a match appends to that model, no match births a new one. For
  // immediate visibility (no rescan needed) the taught surface also lands as
  // one detected_surfaces row (creator-approved — the creator personally
  // vouched for it) and as an entry in the scene inventory.
  const TEACHABLE_SURFACE_TYPES = [
    "desk", "table", "shelf", "counter", "nightstand", "side_table",
    "coffee_table", "studio_desk", "floor", "rug", "couch", "wall",
    "door", "window",
  ];
  app.post("/api/video/:videoId/scenes/:sceneId/teach", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });
      const sceneId = parseInt(req.params.sceneId);
      if (isNaN(sceneId)) return res.status(400).json({ error: "Invalid scene ID" });

      const { surfaceType: rawType, orientation, bbox } = req.body || {};
      const surfaceType = typeof rawType === "string" ? rawType.toLowerCase().trim() : "";
      if (!TEACHABLE_SURFACE_TYPES.includes(surfaceType)) {
        return res.status(400).json({ error: `surfaceType must be one of: ${TEACHABLE_SURFACE_TYPES.join(", ")}` });
      }
      if (orientation !== "horizontal" && orientation !== "vertical") {
        return res.status(400).json({ error: 'orientation must be "horizontal" or "vertical"' });
      }
      // Extent must stay inside the frame and the box must be drawably
      // large — the client enforces both, but the endpoint contract can't
      // Floor matches the CLIENT's draw guard (1.5% per dimension), not the
      // normalize pass's 3% area minimum — taught rows are exempt from that
      // filter precisely so a small real fixture (a side table is often
      // 1-3% of frame) can be taught. A 3% area floor here would reject the
      // exact surfaces teaching exists for, with the client happily letting
      // the user draw them first.
      const bboxOk = bbox &&
        [bbox.x, bbox.y, bbox.w, bbox.h].every((v: any) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) &&
        bbox.w >= 0.015 && bbox.h >= 0.015 &&
        bbox.x + bbox.w <= 1.0001 && bbox.y + bbox.h <= 1.0001;
      if (!bboxOk) {
        return res.status(400).json({ error: "bbox must be { x, y, w, h } as 0-1 floats, fully inside the frame, at least 1.5% of the frame in each dimension" });
      }
      // Store the DISPLAY-canonical type (Table, Nightstand, ...) — every
      // scan-produced row and model surface uses that vocabulary, and a
      // snake_case taught type would render as a distinct type in the UI.
      const canonicalTaughtType = canonicalSurfaceType(surfaceType);

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!(await isSameCreator(String(video.userId), req.authUserId)) && !req.isAdmin) {
        return res.status(403).json({ error: "Not authorized to teach surfaces on this video" });
      }

      // The scene class anchors everything: its shots give us the exemplar
      // hashes for model matching and the timestamp for the visible row.
      const idxShots = (video as any).sceneIndex?.shots;
      const sceneShots = Array.isArray(idxShots)
        ? idxShots.filter((s: any) =>
            s && s.sceneId === sceneId &&
            typeof s.tStart === "number" && typeof s.tEnd === "number" && s.tEnd >= s.tStart)
        : [];
      if (sceneShots.length === 0) {
        return res.status(400).json({ error: "Video has no scene index for this scene — rescan before teaching" });
      }

      // Exemplar hashes for the class — longest shots first, sentinels
      // ('fail'-prefixed unextractable keyframes) excluded, cap 5. Mirrors
      // the scanner's collectClassExemplarHashes so a teach and a scan agree
      // on what this set looks like.
      const exemplarHashes: string[] = [];
      const byDuration = [...sceneShots].sort((a: any, b: any) => (b.tEnd - b.tStart) - (a.tEnd - a.tStart));
      for (const shot of byDuration) {
        if (exemplarHashes.length >= 5) break;
        const h = shot.hash;
        if (typeof h !== "string" || !h || h.startsWith("fail")) continue;
        if (!exemplarHashes.includes(h)) exemplarHashes.push(h);
      }
      // An unhashable class can never be matched by a future scan, so the
      // taught surface could never be confirmed — refuse rather than write a
      // dead model (same rule the scanner's upsert applies).
      if (exemplarHashes.length === 0) {
        return res.status(400).json({ error: "This scene has no usable keyframe hashes — future scans could never recognize the taught surface" });
      }

      // Match against the creator's room models the way the scanner does:
      // min hamming across the exemplar cross product, same-scene threshold,
      // closest model wins. Legacy models may be keyed by email, so pass the
      // full alias list.
      const identity = await resolveCreatorIdentity(String(video.userId));
      const ownerKeys = Array.from(new Set(
        [String(video.userId), identity.userId, identity.email].filter((k): k is string => !!k)));
      const models = await storage.getRoomModelsForUsers(ownerKeys);
      let bestModel: (typeof models)[number] | null = null;
      let bestDist = Number.MAX_SAFE_INTEGER;
      for (const model of models) {
        for (const mh of model.sceneExemplarHashes ?? []) {
          if (!mh || mh.startsWith("fail")) continue;
          for (const ch of exemplarHashes) {
            const d = hammingDistance(ch, mh);
            if (d < bestDist) { bestDist = d; bestModel = model; }
          }
        }
      }

      const taughtSurface = {
        surfaceType: canonicalTaughtType,
        orientation: orientation as "horizontal" | "vertical",
        bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h },
        confidence: 0.9,
        frameUrl: null,
        taught: true,
      };

      let modelId: number;
      let surfaceIdx: number;
      if (bestModel && bestDist < 12) {
        modelId = bestModel.id;
        surfaceIdx = await storage.appendRoomModelSurface(modelId, taughtSurface);
        // Re-anchor matching on the set's CURRENT look: union the teach-time
        // exemplars into the model (teach hashes first, dedupe, cap 16 — the
        // same merge rule the scan upsert uses). Without this, a gate-skipped
        // prior upsert leaves the model's hashes stale and the next scan's
        // closest-model argmin can land on a duplicate model that shadows
        // the taught one. Non-fatal: the append above is the durable truth.
        try {
          const mergedHashes: string[] = [];
          for (const h of [...exemplarHashes, ...(bestModel.sceneExemplarHashes ?? [])]) {
            if (mergedHashes.length >= 8) break;
            if (h && !h.startsWith("fail") && !mergedHashes.includes(h)) mergedHashes.push(h);
          }
          if (mergedHashes.length > 0) {
            await storage.updateRoomModel(modelId, { sceneExemplarHashes: mergedHashes });
          }
        } catch (hashErr: any) {
          console.warn(`[Teach] Exemplar enrichment failed (non-fatal):`, hashErr?.message || hashErr);
        }
      } else {
        const created = await storage.insertRoomModel({
          userId: String(video.userId),
          sceneExemplarHashes: exemplarHashes,
          surfaces: [{ idx: 0, ...taughtSurface }],
          sourceVideoId: videoId,
          lastVideoId: videoId,
        });
        modelId = created.id;
        surfaceIdx = 0;
      }
      const groupId = `rm${modelId}-s${surfaceIdx}`;

      // Immediate visibility 1/2: one detected_surfaces row at the midpoint
      // of the scene's longest shot, pre-approved — the creator drew this
      // box personally, no review gate needed.
      const longestShot = sceneShots.reduce((a: any, b: any) =>
        (b.tEnd - b.tStart) > (a.tEnd - a.tStart) ? b : a);
      const midpoint = (longestShot.tStart + longestShot.tEnd) / 2;
      const surfaceRow = await storage.insertDetectedSurface({
        videoId,
        timestamp: midpoint.toString(),
        surfaceType: canonicalTaughtType,
        orientation,
        confidence: "0.9",
        boundingBoxX: bbox.x.toString(),
        boundingBoxY: bbox.y.toString(),
        boundingBoxWidth: bbox.w.toString(),
        boundingBoxHeight: bbox.h.toString(),
        frameUrl: null,
        creatorApproved: true,
        sceneId,
        surfaceGroupId: groupId,
      });

      // Teaching is the highest-intent creator action there is — and the
      // `taught` flag lives inside a jsonb array with no date and no actor,
      // so it was invisible as behavior. Note actorUserId: an admin is
      // explicitly allowed to teach on a creator's video, and recording that
      // as creator engagement would overstate it.
      recordCreatorEvent({
        creatorUserId: String(video.userId),
        actorUserId: String(req.authUserId),
        eventType: "surface_taught",
        videoId,
        surfaceId: surfaceRow?.id ?? null,
        surfaceGroupId: groupId,
        metadata: { surfaceType: canonicalTaughtType, orientation, sceneId },
      });

      // Immediate visibility 2/2: the scene inventory, when the video has
      // one. Non-fatal — the model and the row above are the durable truth;
      // a malformed inventory blob must not fail the teach.
      try {
        const inventory = (video as any).sceneInventory;
        if (inventory && Array.isArray(inventory.scenes)) {
          const shotSec = sceneShots.reduce((sum: number, s: any) => sum + (s.tEnd - s.tStart), 0);
          let scene = inventory.scenes.find((s: any) => s && s.sceneId === sceneId);
          if (!scene) {
            // Same orphan handling the inventory build uses: a scene the
            // rollup didn't know still shows its surface.
            const label = inventory.scenes.length < 26
              ? `Scene ${String.fromCharCode(65 + inventory.scenes.length)}`
              : `Scene ${inventory.scenes.length + 1}`;
            scene = { sceneId, label, occurrences: sceneShots.length, totalSec: Math.round(shotSec * 10) / 10, surfaces: [] };
            inventory.scenes.push(scene);
          }
          if (!Array.isArray(scene.surfaces)) scene.surfaces = [];
          scene.surfaces.push({
            groupId,
            surfaceType: canonicalTaughtType,
            bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h },
            confidence: 0.9,
            screenTimeSec: typeof scene.totalSec === "number" ? scene.totalSec : Math.round(shotSec * 10) / 10,
            rowCount: 1,
            representativeRowId: surfaceRow.id,
            frameUrl: null,
          });
          await storage.updateVideoIndex(videoId, { sceneInventory: inventory as any });
        }
      } catch (invErr: any) {
        console.warn(`[Teach] Scene inventory patch failed (non-fatal):`, invErr?.message || invErr);
      }

      console.log(`[Teach] Video ${videoId} scene ${sceneId}: taught ${surfaceType} → model #${modelId} idx ${surfaceIdx} (${bestModel && bestDist < 12 ? `matched at hamming ${bestDist}` : "new model"})`);
      res.json({ modelId, idx: surfaceIdx, groupId, surfaceRowId: surfaceRow.id });
    } catch (err: any) {
      console.error("[API] /api/video/:videoId/scenes/:sceneId/teach error:", err.message);
      res.status(500).json({ error: "Failed to teach surface" });
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

      // Real duration or bust: the transforms array is sized from this, and
      // a fallback of 30s on an hour-long import nulls every frame past 30s
      // — the placement overlay then never renders at any playhead. Prefer
      // the DB duration, then the scene index's last shot end, then the
      // last keyframe timestamp (+ a beat) before giving up at 30s.
      const sceneIdxShots = (video as any).sceneIndex?.shots;
      const lastShotEnd = Array.isArray(sceneIdxShots) && sceneIdxShots.length > 0
        ? Number(sceneIdxShots[sceneIdxShots.length - 1]?.tEnd) || 0
        : 0;
      const videoDuration = parseFloat(video.duration as string) || lastShotEnd || 30;
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
  app.get("/api/video/:videoId/surface-keyframes", mediaLimiter, softAuth, requireVideoAccess, async (req: any, res) => {
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
      // Only the video's creator (or an admin) can trigger a render of it.
      if (!req.isAdmin && !(await isSameCreator(String((video as any).userId ?? ""), String(req.authUserId ?? "")))) {
        return res.status(403).json({ error: "You can only export your own videos" });
      }
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

      // Harmonized exports, done properly this time: harmonizedImageUrl is a
      // FULL-SCENE composite, so we crop it to the placement's bbox region —
      // the crop contains the harmonized product + its cast shadow — and use
      // THAT as the overlay image. Composited back into the same bbox the
      // geometry aligns pixel-for-pixel. (A naive substitution of the whole
      // composite was reverted in review: it stamped the entire scene into
      // the surface box.)
      try {
        const saved = await storage.getPlacementsForVideo(videoId);
        // The composite is ANCHOR-SPECIFIC (rendered at one surface's frame —
        // different bbox = different render, see the save route's comment), so
        // the match must be keyed by surface, never by product image alone:
        // the same product placed on two surfaces would otherwise get one
        // surface's composite cropped at the other's bbox — plain background.
        const exportSurfaces = await storage.getDetectedSurfaces(videoId);
        const surfaceBboxPct = new Map<number, { x: number; y: number; w: number; h: number }>();
        for (const s of exportSurfaces as any[]) {
          const sx = parseFloat(String(s.boundingBoxX)) || 0;
          const sy = parseFloat(String(s.boundingBoxY)) || 0;
          const sw = parseFloat(String(s.boundingBoxWidth)) || 0;
          const sh = parseFloat(String(s.boundingBoxHeight)) || 0;
          const k = sx <= 1 && sy <= 1 && sw <= 1 && sh <= 1 ? 100 : 1; // normalized → percent
          surfaceBboxPct.set(s.id, { x: sx * k, y: sy * k, w: sw * k, h: sh * k });
        }
        const bboxIoU = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => {
          const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
          const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
          const inter = ix * iy;
          const union = a.w * a.h + b.w * b.h - inter;
          return union > 0 ? inter / union : 0;
        };
        for (const p of placements) {
          const bbox = p.keyframes?.[0]?.bbox; // {x,y,w,h} in 0-100 percent
          if (!bbox) continue;
          const match = (saved || []).find((sp: any) => {
            if (!sp.isHarmonized || !sp.harmonizedImageUrl || sp.productImageUrl !== p.productImageUrl) return false;
            // Exact surface identity when the client sends it…
            if (p.surfaceId != null) return sp.surfaceId === p.surfaceId;
            // …else require the saved placement's anchor-surface bbox to
            // substantially coincide with this placement's bbox. No match →
            // no substitution (raw product export beats a wrong-scene patch).
            const anchor = surfaceBboxPct.get(sp.surfaceId);
            return !!anchor && bboxIoU(anchor, bbox) >= 0.3;
          });
          if (!match) continue;
          try {
            // Load the composite (storage-served or absolute URL)
            let compositeBuf: Buffer | null = null;
            const hUrl: string = match.harmonizedImageUrl!;  // guarded by the find() predicate
            if (hUrl.startsWith("/storage/")) {
              const { downloadToTempFile } = await import("./lib/objectStorage");
              const local = await downloadToTempFile(objectKeyFromServeUrl(hUrl), "/tmp/harmonized-crops");
              compositeBuf = fs.readFileSync(local);
              try { fs.unlinkSync(local); } catch { /* ignore */ }
            } else if (/^https?:/.test(hUrl)) {
              const resp = await fetch(hUrl);
              if (resp.ok) compositeBuf = Buffer.from(await resp.arrayBuffer());
            }
            if (!compositeBuf) continue;

            const meta = await sharp(compositeBuf).metadata();
            if (!meta.width || !meta.height) continue;
            const left = Math.max(0, Math.round((bbox.x / 100) * meta.width));
            const top = Math.max(0, Math.round((bbox.y / 100) * meta.height));
            const width = Math.min(meta.width - left, Math.max(8, Math.round((bbox.w / 100) * meta.width)));
            const height = Math.min(meta.height - top, Math.max(8, Math.round((bbox.h / 100) * meta.height)));
            if (width < 8 || height < 8) continue;

            const cropBuf = await sharp(compositeBuf).extract({ left, top, width, height }).png().toBuffer();
            const cropPath = `/tmp/harmonized-crops/crop-${videoId}-${p.keyframes[0].timestamp ?? 0}-${left}x${top}.png`;
            fs.mkdirSync("/tmp/harmonized-crops", { recursive: true });
            fs.writeFileSync(cropPath, cropBuf);
            const cropKey = `public/exports/harmonized-crops/v${videoId}-${left}x${top}-${width}x${height}.png`;
            const cropUrl = await uploadFileToStorage(cropPath, cropKey);
            try { fs.unlinkSync(cropPath); } catch { /* ignore */ }

            p.productImageUrl = cropUrl;
            // The crop's aspect IS the bbox aspect — force exact fill, and
            // kill client-side shadow/feather (the composite already carries
            // the harmonized shadow; doubling it looks wrong).
            p.productAspectRatio = width / height;
            p.transform = { offsetX: 0, offsetY: 0, scale: 1, rotation: 0, flipH: false };
            // The crop's background pixels only align at the exact bbox it
            // was cut from — motion-track medians would draw it offset and
            // letterboxed. Pin the exporter to the keyframe bbox.
            p.motionTrackData = null;
            if (p.blend) {
              p.blend = { ...p.blend, shadowEnabled: false, featherRadius: 0, brightness: 0, contrast: 0 };
            }
            console.log(`[Video Export] Harmonized crop substituted for "${p.surfaceType}" (${width}x${height})`);
          } catch (cropErr: any) {
            console.warn(`[Video Export] Harmonized crop failed for "${p.surfaceType}" (using raw product): ${cropErr?.message}`);
          }
        }
      } catch (harmErr: any) {
        console.warn(`[Video Export] Harmonized lookup failed (non-fatal): ${harmErr?.message}`);
      }

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
  // Ownership gate shared by the export status/download routes: exports were
  // unauthenticated and integer-enumerable — anyone could walk IDs and pull
  // other creators' finished renders.
  const authorizeExportAccess = async (req: any, exportJob: { videoId: number }): Promise<boolean> => {
    if (req.isAdmin) return true;
    const video = await storage.getVideoById(exportJob.videoId).catch(() => undefined);
    if (!video) return false;
    return await isSameCreator(String((video as any).userId ?? ""), String(req.authUserId ?? ""));
  };

  app.get("/api/exports/:exportId", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const exportId = parseInt(req.params.exportId);
      if (isNaN(exportId)) return res.status(400).json({ error: "Invalid export ID" });

      const exportJob = await storage.getVideoExport(exportId);
      if (!exportJob) return res.status(404).json({ error: "Export not found" });
      if (!(await authorizeExportAccess(req, exportJob))) {
        return res.status(404).json({ error: "Export not found" });
      }

      res.json({
        id: exportJob.id,
        videoId: exportJob.videoId,
        status: exportJob.status,
        progress: exportJob.progress,
        // Always the gated route — raw /storage/exports/* URLs are no
        // longer served (legacy rows keep working through this rewrite).
        outputUrl: exportJob.outputUrl ? `/api/exports/${exportJob.id}/download` : null,
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
  app.get("/api/exports/:exportId/download", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const exportId = parseInt(req.params.exportId);
      if (isNaN(exportId)) return res.status(400).json({ error: "Invalid export ID" });

      const exportJob = await storage.getVideoExport(exportId);
      if (!exportJob) return res.status(404).json({ error: "Export not found" });
      if (!(await authorizeExportAccess(req, exportJob))) {
        return res.status(404).json({ error: "Export not found" });
      }
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

  // ── Meta Data Deletion Callback (App Review prerequisite) ──────────────
  // Registered in the Meta App Dashboard as the Data Deletion Request URL.
  // Meta POSTs form-encoded { signed_request } when a user removes the app;
  // we must delete their data and answer { url, confirmation_code } where
  // url is a human-readable status page.
  app.post("/api/meta/data-deletion", async (req: any, res) => {
    try {
      const appSecret = process.env.FACEBOOK_APP_SECRET;
      if (!appSecret) return res.status(500).json({ error: "Deletion callback not configured" });
      const signedRequest = req.body?.signed_request;
      if (!signedRequest || typeof signedRequest !== "string") {
        return res.status(400).json({ error: "signed_request required" });
      }

      const [encodedSig, payload] = signedRequest.split(".", 2);
      if (!encodedSig || !payload) return res.status(400).json({ error: "Malformed signed_request" });
      const fromB64Url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      const sig = fromB64Url(encodedSig);
      const expected = crypto.createHmac("sha256", appSecret).update(payload).digest();
      if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) {
        return res.status(400).json({ error: "Invalid signature" });
      }
      const data = JSON.parse(fromB64Url(payload).toString("utf8"));
      const fbUserId = String(data?.user_id || "");
      if (!fbUserId) return res.status(400).json({ error: "No user_id in signed_request" });

      const result = await storage.deleteMetaDataForFacebookUser(fbUserId);
      const confirmationCode = `fs-del-${crypto.randomBytes(6).toString("hex")}`;
      await storage.createDataDeletionRequest({
        platform: "meta",
        platformUserId: fbUserId,
        confirmationCode,
        status: "completed",
        details: result.deleted,
      });
      console.log(`[MetaDeletion] Deleted data for FB user ${fbUserId}:`, result.deleted);

      const statusUrl = `${req.protocol}://${req.get("host")}/deletion-status/${confirmationCode}`;
      res.json({ url: statusUrl, confirmation_code: confirmationCode });
    } catch (err: any) {
      console.error("[MetaDeletion] Callback error:", err.message);
      res.status(500).json({ error: "Deletion request failed" });
    }
  });

  // Human-readable deletion status page (public; linked from the callback response)
  app.get("/deletion-status/:code", async (req: any, res) => {
    try {
      const row = await storage.getDataDeletionRequestByCode(req.params.code);
      const body = row
        ? `<h1>Data Deletion — ${row.status === "completed" ? "Complete" : row.status}</h1>
           <p>Confirmation code: <code>${row.confirmationCode}</code></p>
           <p>All data FullScale held from your Meta account grant (connected accounts,
           cached profile fields, and analytics snapshots) was deleted on
           ${row.createdAt ? new Date(row.createdAt).toUTCString() : "record date unavailable"}.</p>`
        : `<h1>Deletion request not found</h1><p>No deletion request matches this confirmation code.</p>`;
      res.status(row ? 200 : 404).type("html").send(
        `<!doctype html><html><head><title>FullScale — Data Deletion Status</title>
         <meta name="viewport" content="width=device-width, initial-scale=1"/>
         <style>body{font-family:system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 20px;color:#222}code{background:#f4f4f4;padding:2px 6px;border-radius:4px}</style>
         </head><body>${body}</body></html>`
      );
    } catch (err: any) {
      res.status(500).type("html").send("<h1>Status lookup failed</h1>");
    }
  });

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

      // Fetch associated data (view count increments AFTER all the ways
      // this request can 404/410 — dead links shouldn't keep counting)
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

      // A1 release pages: a link minted at brand-approval carries the
      // placement's FINAL baked render + credits. Withdrawn/reverted
      // placements 410 rather than serving a stale render.
      let release: any = null;
      if (link.brandPlacementId) {
        const bp = await storage.getBrandPlacementById(link.brandPlacementId);
        if (!bp || bp.status !== "brand_approved") {
          return res.status(410).json({ error: "This release is no longer available" });
        }
        let clip: any = null;
        if (bp.editorialClipId) {
          try { clip = await storage.getEditorialClipById(bp.editorialClipId); } catch { /* optional */ }
        }
        let product: any = null;
        if (bp.brandProductId != null) {
          try { product = await storage.getBrandProduct(bp.brandProductId); } catch { /* optional */ }
        }
        const displayName = async (userId: string): Promise<string | null> => {
          try {
            let u = await storage.getUserById(userId);
            if (!u && userId.includes("@")) u = await storage.getUserByEmail(userId);
            if (!u) return null;
            // Real names only — this JSON is PUBLIC; never fall back to the
            // login email (that would print user emails on the release page).
            return [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null;
          } catch { return null; }
        };
        release = {
          placementId: bp.id,
          clipUrl: clip?.exportPath || null,
          thumbnailUrl: clip?.thumbnailPath || video.thumbnailUrl || null,
          clipTitle: clip?.suggestedTitle || null,
          aspectRatio: clip?.aspectRatio || null,
          duration: clip?.duration ?? null,
          product: product ? {
            name: product.name,
            category: product.category ?? null,
            imageUrl: product.thumbnailUrl || product.imageUrl || null,
          } : null,
          creatorName: await displayName(String(bp.creatorUserId)),
          brandName: await displayName(String(bp.brandUserId)),
          approvedAt: bp.updatedAt ?? null,
        };
      }

      // Get surfaces for the video
      const surfaces = await storage.getDetectedSurfaces(link.videoId);

      await storage.incrementSharedLinkViews(slug);

      res.json({
        slug: link.slug,
        title: link.title || video.title,
        release,
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

      // Ownership: only the link's creator — or, for release links, either
      // placement party — may deactivate. (Was unauthenticated-IDOR before:
      // any logged-in user could kill any share link by id.)
      const link = await storage.getSharedLinkById(id);
      if (!link) return res.status(404).json({ error: "Share link not found" });
      const requesterKeys = [req.authEmail, req.authUserId, req.googleUser?.email]
        .filter(Boolean)
        .map((v: string) => String(v).toLowerCase());
      let allowed = requesterKeys.includes(String(link.createdBy || "").toLowerCase());
      if (!allowed && link.brandPlacementId) {
        const bp = await storage.getBrandPlacementById(link.brandPlacementId);
        if (bp) {
          allowed =
            String(bp.brandUserId) === String(req.authUserId) ||
            (await isSameCreator(String(bp.creatorUserId), req.authUserId));
        }
      }
      if (!allowed) return res.status(403).json({ error: "Not your share link" });

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
  app.post("/api/generate/product-asset", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { videoId, surfaceId, brandProductId } = req.body;
      if (!videoId || !surfaceId || !brandProductId) {
        return res.status(400).json({ error: "videoId, surfaceId, and brandProductId are required" });
      }

      // Get surface and scene analysis data
      // detectedSurfaces stores bounding boxes as boundingBox* decimal strings;
      // this block's shape math expects bbox* numbers.
      const surfaces = (await storage.getDetectedSurfaces(videoId)).map((s: any) => ({
        ...s,
        bboxX: parseFloat(String(s.boundingBoxX ?? 0)) || 0,
        bboxY: parseFloat(String(s.boundingBoxY ?? 0)) || 0,
        bboxWidth: parseFloat(String(s.boundingBoxWidth ?? 0.2)) || 0.2,
        bboxHeight: parseFloat(String(s.boundingBoxHeight ?? 0.2)) || 0.2,
      }));
      const surface = surfaces.find((s: any) => s.id === surfaceId);
      if (!surface) return res.status(404).json({ error: "Surface not found" });

      const analyses = await storage.getSceneAnalysisBySurface(surfaceId);
      const analysis = analyses[0];
      if (!analysis) return res.status(404).json({ error: "No scene analysis for this surface. Run analysis first." });

      // Get brand product — ids come from the brand_products catalog (the
      // copilot's BRAND CATALOG context), NOT monetization_items; resolving
      // against the wrong table 404'd or picked an unrelated row.
      const brandProduct = await storage.getBrandProduct(parseInt(brandProductId));
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

      // detectedSurfaces stores bounding boxes as boundingBox* decimal strings;
      // this block's shape math expects bbox* numbers.
      const surfaces = (await storage.getDetectedSurfaces(videoId)).map((s: any) => ({
        ...s,
        bboxX: parseFloat(String(s.boundingBoxX ?? 0)) || 0,
        bboxY: parseFloat(String(s.boundingBoxY ?? 0)) || 0,
        bboxWidth: parseFloat(String(s.boundingBoxWidth ?? 0.2)) || 0.2,
        bboxHeight: parseFloat(String(s.boundingBoxHeight ?? 0.2)) || 0.2,
      }));
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

      // detectedSurfaces stores bounding boxes as boundingBox* decimal strings;
      // this block's shape math expects bbox* numbers.
      const surfaces = (await storage.getDetectedSurfaces(videoId)).map((s: any) => ({
        ...s,
        bboxX: parseFloat(String(s.boundingBoxX ?? 0)) || 0,
        bboxY: parseFloat(String(s.boundingBoxY ?? 0)) || 0,
        bboxWidth: parseFloat(String(s.boundingBoxWidth ?? 0.2)) || 0.2,
        bboxHeight: parseFloat(String(s.boundingBoxHeight ?? 0.2)) || 0.2,
      }));
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

      // detectedSurfaces stores bounding boxes as boundingBox* decimal strings;
      // this block's shape math expects bbox* numbers.
      const surfaces = (await storage.getDetectedSurfaces(videoId)).map((s: any) => ({
        ...s,
        bboxX: parseFloat(String(s.boundingBoxX ?? 0)) || 0,
        bboxY: parseFloat(String(s.boundingBoxY ?? 0)) || 0,
        bboxWidth: parseFloat(String(s.boundingBoxWidth ?? 0.2)) || 0.2,
        bboxHeight: parseFloat(String(s.boundingBoxHeight ?? 0.2)) || 0.2,
      }));
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

      // Per-clip surface counts, computed from ONE surfaces load. The cards
      // use this to show "N placement surfaces" vs "not scanned" without a
      // request per clip. Segments-aware: an assembled clip only counts
      // surfaces inside beats that actually play.
      let withCounts = clips;
      try {
        const allSurfaces = await storage.getDetectedSurfaces(videoId);
        withCounts = clips.map((c: any) => {
          const segs = Array.isArray(c.segments) && c.segments.length > 0 ? c.segments : null;
          const inClip = allSurfaces.filter((sf: any) => {
            const t = parseFloat(String(sf.timestamp));
            if (segs) return segs.some((sg: any) => t >= sg.start && t <= sg.end);
            return t >= Number(c.clipStart) && t <= Number(c.clipEnd);
          });
          return {
            ...c,
            surfaceCount: inClip.length,
            // Distinct physical fixtures: grouped rows count once per group;
            // ungrouped rows (null gid) are each their own fixture — folding
            // them into one Set entry would undercount by design.
            surfaceGroupCount:
              new Set(inClip.map((sf: any) => sf.surfaceGroupId).filter(Boolean)).size +
              inClip.filter((sf: any) => !sf.surfaceGroupId).length,
            videoScanned: allSurfaces.length > 0,
            scanInFlight: clipScansInFlight.has(c.id),
          };
        });
      } catch { /* counts are additive — the raw list still serves */ }

      res.json({ clips: withCounts });
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

  // POST /api/editorial-clips/:clipId/rerender — re-render an existing
  // editorial clip in an explicitly chosen aspect (the backlog's 16:9 vs
  // 9:16 output picker; batch default remains 9:16).
  app.post("/api/editorial-clips/:clipId/rerender", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const clipId = parseInt(req.params.clipId);
      if (isNaN(clipId)) return res.status(400).json({ error: "Invalid clip ID" });
      const clip = await storage.getEditorialClipById(clipId);
      if (!clip) return res.status(404).json({ error: "Clip not found" });
      const video = await storage.getVideoById(clip.videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!(await isSameCreator(String(video.userId), req.authUserId))) {
        return res.status(403).json({ error: "Not your clip" });
      }

      if (clip.renderStatus === "rendering") {
        return res.status(409).json({ error: "Clip is already rendering — try again when it finishes" });
      }

      const aspect = req.body?.aspect === "16:9" ? "16:9" : "9:16";
      const platformKey = aspect === "16:9" ? "youtube" : "tiktok";

      // ── Creator edit settings ────────────────────────────────────────
      // This endpoint used to accept `aspect` and nothing else, so trim and
      // caption choices had nowhere to live and every re-render silently
      // reverted to captions-on / "highlight" / lower-third.
      const b = req.body || {};
      const edit: Record<string, any> = { aspectRatio: aspect };

      // Trim, validated against the SOURCE video's duration. An out-of-range
      // trim renders a black tail or an empty file rather than failing.
      if (b.clipStart !== undefined || b.clipEnd !== undefined) {
        const start = Number(b.clipStart ?? clip.clipStart);
        const end = Number(b.clipEnd ?? clip.clipEnd);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 1) {
          return res.status(400).json({ error: "Trim must be at least 1 second and both bounds must be numbers" });
        }
        const sourceSec = durationStringToSeconds((video as any).duration);
        if (start < 0 || (sourceSec > 0 && end > sourceSec + 0.5)) {
          return res.status(400).json({
            error: sourceSec > 0
              ? `Trim must fall inside the source video (0–${sourceSec.toFixed(1)}s)`
              : "Trim start cannot be negative",
          });
        }
        // Re-trimming a multi-beat assembled clip would silently discard the
        // narrative structure, so the beats are dropped explicitly and the
        // clip becomes a single range.
        edit.clipStart = start;
        edit.clipEnd = end;
        edit.duration = end - start;
        if ((clip as any).segments) edit.segments = null;
      }

      if (b.captionsEnabled !== undefined) edit.captionsEnabled = !!b.captionsEnabled;
      if (b.captionStyle !== undefined) {
        const allowed = ["highlight", "brand_callout", "narrative"];
        if (b.captionStyle !== null && !allowed.includes(String(b.captionStyle))) {
          return res.status(400).json({ error: `captionStyle must be one of ${allowed.join(", ")}` });
        }
        edit.captionStyle = b.captionStyle;
      }
      if (b.captionSettings !== undefined) {
        const cs = b.captionSettings || {};
        const num = (v: any, lo: number, hi: number) =>
          v === undefined || v === null ? undefined : Math.min(hi, Math.max(lo, Number(v)));
        edit.captionSettings = {
          sizeScale: num(cs.sizeScale, 0.5, 2),
          positionRatio: num(cs.positionRatio, 0.02, 0.45),
          wordsPerPhrase: num(cs.wordsPerPhrase, 1, 12),
          outline: num(cs.outline, 0, 8),
          accentHex: /^#?[0-9a-f]{6}$/i.test(String(cs.accentHex ?? "")) ? String(cs.accentHex) : undefined,
        };
      }

      // ── The edit stack: b-roll, music + ducking, speed ramps, silence
      // removal, stabilization. Validated to the EditStack shape with owned
      // assets only; `edits: null` clears the stack. Absent = keep existing.
      if (b.edits !== undefined) {
        if (b.edits === null) {
          edit.edits = null;
        } else {
          const num = (v: any, lo: number, hi: number, dflt: number) => {
            const x = Number(v);
            return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
          };
          const assetOwned = async (id: any): Promise<boolean> => {
            const a = Number.isFinite(Number(id)) ? await storage.getMediaAsset(Number(id)) : undefined;
            return !!a && !a.deletedAt && String(a.userId) === String(req.authUserId);
          };
          const e = b.edits || {};
          const clean: any = {};

          if (e.stabilization?.enabled) {
            clean.stabilization = { enabled: true, strength: num(e.stabilization.strength, 1, 10, 5) };
          }
          if (e.silenceCut?.enabled) {
            clean.silenceCut = {
              enabled: true,
              thresholdDb: num(e.silenceCut.thresholdDb, -50, -20, -35),
              minDurationSec: num(e.silenceCut.minDurationSec, 0.15, 3, 0.6),
              paddingSec: num(e.silenceCut.paddingSec, 0, 0.5, 0.15),
            };
          }
          // Transcript-driven cuts. Capped generously — a heavily-edited
          // 60s clip legitimately has dozens of struck words.
          if (Array.isArray(e.wordCuts)) {
            clean.wordCuts = e.wordCuts.slice(0, 400)
              .map((w: any) => ({
                start: num(w.start, 0, 36000, 0),
                end: num(w.end, 0, 36000, 0),
                text: typeof w.text === "string" ? w.text.slice(0, 80) : undefined,
                reason: w.reason === "filler" ? "filler" : "manual",
              }))
              .filter((w: any) => w.end > w.start);
          }
          if (Array.isArray(e.speedRamps)) {
            clean.speedRamps = e.speedRamps.slice(0, 8)
              .map((r: any) => ({ start: num(r.start, 0, 36000, 0), end: num(r.end, 0, 36000, 0), rate: num(r.rate, 0.25, 4, 1) }))
              .filter((r: any) => r.end - r.start >= 0.2 && Math.abs(r.rate - 1) > 0.01);
          }
          if (Array.isArray(e.textOverlays)) {
            clean.textOverlays = e.textOverlays.slice(0, 12)
              .map((t: any) => ({
                start: num(t.start, 0, 36000, 0),
                end: num(t.end, 0, 36000, 0),
                text: String(t.text ?? "").slice(0, 200),
                x: num(t.x, 0, 1, 0.5), y: num(t.y, 0, 1, 0.1),
                size: num(t.size, 0.02, 0.25, 0.06),
                color: /^#?[0-9a-f]{6}$/i.test(String(t.color ?? "")) ? String(t.color) : "#ffffff",
                background: /^#?[0-9a-f]{6}$/i.test(String(t.background ?? "")) ? String(t.background) : null,
                weight: t.weight === "bold" ? "bold" : "regular",
                align: ["left", "center", "right"].includes(t.align) ? t.align : "center",
              }))
              .filter((t: any) => t.text.trim() && t.end - t.start >= 0.3);
          }
          if (Array.isArray(e.broll)) {
            const cuts: any[] = [];
            for (const c of e.broll.slice(0, 8)) {
              if (!(await assetOwned(c.assetId))) continue; // silently dropping someone else's asset id is the correct outcome
              cuts.push({
                assetId: Number(c.assetId),
                start: num(c.start, 0, 36000, 0), end: num(c.end, 0, 36000, 0),
                fit: c.fit === "contain" ? "contain" : "cover",
                motion: ["push", "pull", "none"].includes(c.motion) ? c.motion : "push",
                scale: num(c.scale, 0.1, 1, 1),
                x: num(c.x, 0, 1, 1), y: num(c.y, 0, 1, 0),
                muted: c.muted !== false,
              });
            }
            clean.broll = cuts.filter((c) => c.end - c.start >= 0.3);
          }
          if (e.music && (await assetOwned(e.music.assetId))) {
            clean.music = {
              assetId: Number(e.music.assetId),
              volume: num(e.music.volume, 0, 1, 0.2),
              ducking: e.music.ducking !== false,
              duckAmountDb: num(e.music.duckAmountDb, 6, 24, 12),
              fadeInSec: num(e.music.fadeInSec, 0, 10, 1),
              fadeOutSec: num(e.music.fadeOutSec, 0, 10, 2),
            };
          }
          edit.edits = clean;
        }
      }

      await storage.updateEditorialClipEdit(clipId, edit);
      await storage.updateEditorialClipRender(clipId, { renderStatus: "rendering", renderError: null });
      res.json({ message: "Re-render started", clipId, aspect, applied: edit });

      renderSingleEditorialClip(clip.videoId, clipId, { platformKey: platformKey as any })
        .then(async () => {
          console.log(`[API] Editorial clip ${clipId} re-rendered as ${aspect}`);
          // A successful re-render is also the RETRY path for placements
          // stranded at creator_approved by an earlier render failure.
          try {
            const approved = await storage.getApprovedPlacementsForVideo(clip.videoId);
            for (const pl of approved.filter((x) => x.editorialClipId === clipId && x.status === "creator_approved")) {
              const advanced = await storage.updateBrandPlacementStatus(pl.id, "pending_brand_review", { expectedCurrentStatus: "creator_approved" });
              if (advanced) {
                storage.createNotification({
                  userId: pl.brandUserId,
                  type: "placement_render_ready",
                  title: "Render ready for your review",
                  body: "The clip has been re-rendered with your product — review and approve the final cut.",
                  linkPath: "/brand/placements",
                  metadata: { placementId: pl.id, clipId },
                });
              }
            }
          } catch { /* non-fatal */ }
        })
        .catch(async (err: any) => {
          console.error(`[API] Editorial clip ${clipId} ${aspect} re-render failed:`, err?.message || err);
          await storage.updateEditorialClipRender(clipId, { renderStatus: "failed", renderError: err?.message || "Re-render failed" }).catch(() => {});
        });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Re-render failed" });
    }
  });

  // POST /api/videos/:videoId/editorial-clip/render — Render a single ad-hoc clip
  // (from search results or manual selection) and append to the editorialClips list
  app.post("/api/videos/:videoId/editorial-clip/render", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      if (isNaN(videoId)) return res.status(400).json({ error: "Invalid video ID" });
      const { clipStart, clipEnd, suggestedTitle, topicTags, reasoning, scores, compositeScore, segments } = req.body || {};

      if (typeof clipStart !== "number" || typeof clipEnd !== "number" || clipEnd <= clipStart) {
        return res.status(400).json({ error: "Valid clipStart and clipEnd required" });
      }

      // Assembled search results carry beats; validate the same way the
      // analyzer parser does (2-4 well-formed beats) or ignore them.
      let validSegments: Array<{ start: number; end: number; role?: string }> | null = null;
      if (Array.isArray(segments) && segments.length >= 2 && segments.length <= 4) {
        const ok = segments.every((s: any) => typeof s?.start === "number" && typeof s?.end === "number" && s.end > s.start);
        if (ok) validSegments = segments.map((s: any) => ({ start: s.start, end: s.end, role: typeof s.role === "string" ? s.role : undefined }));
      }

      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      if (!video.filePath && !video.youtubeId) return res.status(400).json({ error: "Video has no source — upload a file or import it from a connected platform" });

      // Insert a new editorial clip record with pending render status.
      // Assembled clips play sum-of-beats, not the envelope.
      const duration = validSegments
        ? validSegments.reduce((sum, s) => sum + (s.end - s.start), 0)
        : clipEnd - clipStart;
      const [newClip] = await db.insert(editorialClips).values({
        videoId,
        userId: stableUserIntId(req.authUserId ?? req.user?.id),
        clipStart,
        clipEnd,
        duration,
        segments: validSegments,
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
      if (!video.filePath && !video.youtubeId) return res.status(400).json({ error: "Video has no source — upload a file or import it from a connected platform" });

      // Fire-and-forget — respond immediately
      res.json({
        message: "Editorial auto-pipeline started",
        videoId,
        status: "pending",
      });

      const pipelineUserId = stableUserIntId(video.userId);
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
      if (!video.filePath && !video.youtubeId) return res.status(400).json({ error: "Video has no source — upload a file or import it from a connected platform" });

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

      const pipelineUserId = stableUserIntId(video.userId);
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
      // authUserId is a varchar UUID/email; map it to a stable integer for the
      // legacy remixJobs.userId column (see stableUserIntId).
      const userId = stableUserIntId(req.authUserId ?? req.user?.id);
      const config = req.body || {};

      // Validate video exists
      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      // Editorial mode is the DEFAULT: the Claude editorial path picks
      // narrative moments from the transcript instead of the legacy
      // per-frame clipDetector. Legacy is explicit opt-out only
      // (editorialMode: false).
      const isEditorial = !!config.clipRange || config.editorialMode !== false;
      if (!isEditorial) {
        const analyses = await storage.getSceneAnalysisByVideo(videoId);
        if (analyses.length === 0) {
          return res.status(400).json({ error: "No scene analyses found. Run Claude Dense analysis first via Narrative Insights." });
        }
      } else if (!config.clipRange) {
        // Editorial mode needs a transcript; without one the orchestrator
        // falls back to the legacy path, which needs scene analyses. If the
        // video has neither, fail fast with an actionable 400 instead of a
        // 200 followed by an async job failure.
        const vt = await storage.getVideoTranscript(videoId);
        const hasTranscript = vt?.status === "completed" && vt.segments;
        if (!hasTranscript) {
          const analyses = await storage.getSceneAnalysisByVideo(videoId);
          if (analyses.length === 0) {
            return res.status(400).json({ error: "No transcript or scene analysis available yet. Wait for transcription to finish (or run analysis via Narrative Insights), then retry." });
          }
        }
      }

      // One pipeline per video at a time — a second concurrent run would fight
      // the first over temp scopes and double the render load for no benefit.
      const activeJob = await storage.getActiveRemixJobForVideo(videoId);
      if (activeJob) {
        return res.status(409).json({
          error: "A remix job is already running for this video",
          activeJobId: activeJob.id,
          status: activeJob.status,
        });
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
        keywords: typeof config.keywords === "string" && config.keywords.trim()
          ? config.keywords.trim().slice(0, 500)
          : undefined,
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
      // Scope by VIDEO ownership, not by the caller's derived integer id.
      // remix_jobs.user_id is a stableUserIntId of req.authUserId, and that
      // varchar differs by auth branch (Google row id vs email, OIDC sub vs
      // email) — so a job created in one session could be invisible in the
      // next, which reads to the creator as "my job vanished". The clips
      // endpoint alongside this one already scopes by video only.
      const video = await storage.getVideoById(videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });
      const callerEmail = String(req.authEmail || req.session?.googleUser?.email || "").toLowerCase();
      const isAdmin = !!callerEmail && ADMIN_EMAILS.includes(callerEmail);
      const ownsVideo =
        String(video.userId) === String(req.authUserId) ||
        (!!callerEmail && String(video.userId).toLowerCase() === callerEmail);
      if (!ownsVideo && !isAdmin) {
        return res.status(403).json({ error: "Not your video" });
      }
      const jobs = await storage.getRemixJobsForVideo(videoId);
      res.json(jobs);
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

      // Run in background after response. reRenderClip RESOLVES with
      // { success:false, error } on mainline failures (it does not throw), so a
      // .catch alone would miss them — inspect the resolved result too.
      const recordFailure = async (reason: string) => {
        console.error(`[Re-Render] Background re-render for clip ${clipId} failed: ${reason}`);
        try {
          const clip = await storage.getClipById(clipId);
          if (clip?.remixJobId) {
            await storage.updateRemixJobStatus(clip.remixJobId, "failed", `Re-render failed: ${reason}`);
          }
        } catch (dbErr) {
          console.error(`[Re-Render] Failed to update job status for clip ${clipId}:`, dbErr);
        }
      };
      reRenderClip(clipId, modifications)
        .then((result) => {
          if (!result?.success) recordFailure(result?.error || "unknown");
        })
        .catch((err) => recordFailure(err?.message || "unknown"));
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

      const targetDuration = req.body.targetDuration || 110;
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
      // Same stable-int mapping as the start/list routes (parseInt on a UUID
      // collapsed every stitch job to userId=1).
      const userId = stableUserIntId(req.authUserId ?? req.user?.id);

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

          // Build caption groups per stitch segment (times relative to each
          // segment's start). The output-timeline remap happens INSIDE
          // clipStitcher, which alone knows whether the reel rendered via
          // xfade, plain concat, or branded-card splices (cards add 0.8s per
          // wipe junction — a pre-remapped xfade timeline would drift).
          let stitchCaptionGroups: CaptionSegment[][] | undefined = undefined;
          if (captionsEnabled) {
            try {
              const vt = await storage.getVideoTranscript(videoId);
              if (vt?.status === "completed" && Array.isArray(vt.segments)) {
                const { generateTranscriptCaptions } = await import("./lib/remix/captionEngine");
                const groups: CaptionSegment[][] = stitchSegs.map((seg: any) => {
                  const segTranscript = (vt.segments as any[]).filter(
                    (t: any) => t.start >= seg.start - 0.5 && t.start <= seg.end
                  );
                  if (segTranscript.length === 0) return [];
                  const cap = generateTranscriptCaptions({
                    clipStart: seg.start,
                    clipEnd: seg.end,
                    duration: seg.end - seg.start,
                    narrativeContext: "",
                    emotionalTone: "neutral",
                    brandNames: [],
                    style: "highlight",
                    transcriptSegments: segTranscript,
                  });
                  return cap.segments;
                });
                if (groups.some((g) => g.length > 0)) stitchCaptionGroups = groups;
                console.log(`[Stitch] Built ${groups.reduce((n, g) => n + g.length, 0)} caption segments across ${stitchSegs.length} stitch segments`);
              } else {
                console.log(`[Stitch] No completed transcript for video ${videoId} — stitching without captions`);
              }
            } catch (capErr: any) {
              console.warn(`[Stitch] Caption build failed (non-fatal): ${capErr?.message}`);
            }
          }

          // Brand product for branded_wipe cards — first approved placement
          // with a product on this video (fail-soft: no product, no card).
          let stitchBrandProduct: { id: number; name: string; category: string | null } | undefined = undefined;
          try {
            const approved = await storage.getApprovedPlacementsForVideo(videoId);
            const withProduct = approved.find((p) => p.brandProductId != null);
            if (withProduct?.brandProductId != null) {
              const prod = await storage.getBrandProduct(withProduct.brandProductId);
              if (prod) stitchBrandProduct = { id: prod.id, name: prod.name, category: prod.category ?? null };
            }
          } catch { /* card is optional */ }

          const result = await stitchSegments({
            videoPath,
            videoId,
            segments: stitchSegs,
            platformConfig,
            captionsEnabled,
            captionsBySegment: stitchCaptionGroups,
            outputDir,
            planId: plan.id,
            brandProduct: stitchBrandProduct,
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
      const { trigger, userMessage, clipId, clipType } = req.body;

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

      // Load current clip if specified. clipType "editorial" targets an
      // editorialClips row (the Editorial tab); default is a remix
      // generatedClips row — previously the copilot could only see those.
      let currentClip: any = undefined;
      if (clipId && clipType === "editorial") {
        const eClip = await storage.getEditorialClipById(parseInt(clipId));
        if (eClip && eClip.videoId === videoId) {
          currentClip = {
            clipId: eClip.id,
            start: eClip.clipStart ?? 0,
            end: eClip.clipEnd ?? 0,
            duration: eClip.duration ?? 0,
            platform: (eClip as any).aspectRatio === "16:9" ? "youtube" : "tiktok",
            qualityScore: (eClip as any).qualityScore ?? eClip.finalScore ?? 0,
            placements: [],
            captions: undefined,
            exportPath: eClip.exportPath || undefined,
          };
        }
      } else if (clipId) {
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
  app.get("/api/distribution/profiles", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = stableUserIntId(req.authUserId ?? req.user?.id);
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
  app.post("/api/distribution/profiles", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = stableUserIntId(req.authUserId ?? req.user?.id);
      const { platform, accountName, accountId, accessToken, refreshToken, tokenExpiresAt, metadata } = req.body;

      if (!platform) return res.status(400).json({ error: "platform is required" });

      // Strip token-resolution pointers from client-supplied metadata:
      // resolvePublishAccessToken mints LIVE tokens from
      // metadata.youtubeUserId / metadata.igUserKey, so only the
      // server-side from-youtube/from-instagram provisioning routes (which
      // set them from the authenticated session) may populate them.
      const safeMetadata = metadata && typeof metadata === "object" ? { ...metadata } : null;
      if (safeMetadata) {
        delete safeMetadata.youtubeUserId;
        delete safeMetadata.igUserKey;
      }

      const profile = await storage.createDistributionProfile({
        userId,
        platform,
        accountName: accountName || null,
        accountId: accountId || null,
        accessToken: accessToken || null,
        refreshToken: refreshToken || null,
        tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt) : null,
        isActive: true,
        metadata: safeMetadata,
      });

      res.json({ ...profile, accessToken: "••••••", refreshToken: undefined });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to connect platform" });
    }
  });

  // POST /api/distribution/profiles/from-youtube — Provision a YouTube
  // publishing profile from the caller's existing YouTube connection.
  // The stored token is only a bootstrap: publishers re-resolve a fresh
  // token from the connection at publish time (YouTube tokens expire
  // hourly, so anything stored at connect time is stale by then).
  // Defaults to private uploads until explicitly switched.
  app.post("/api/distribution/profiles/from-youtube", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const connection = await storage.getYoutubeConnection(req.authEmail);
      if (!connection) {
        return res.status(404).json({ error: "No YouTube connection found — connect YouTube in Settings first" });
      }

      const allowedPrivacy = ["public", "unlisted", "private"];
      const privacyStatus = allowedPrivacy.includes(req.body?.privacyStatus) ? req.body.privacyStatus : "private";
      const platform = req.body?.platform === "youtube" ? "youtube" : "youtube_shorts";
      const userId = stableUserIntId(req.authUserId ?? req.user?.id);
      const metadata = { youtubeUserId: connection.userId, privacyStatus };

      const profileData = {
        accountName: connection.channelTitle || null,
        accountId: connection.channelId || null,
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken || null,
        tokenExpiresAt: connection.expiresAt || null,
        isActive: true,
        metadata,
      };

      const existing = (await storage.getDistributionProfiles(userId)).find(p => p.platform === platform);
      const profile = existing
        ? await storage.updateDistributionProfile(existing.id, profileData)
        : await storage.createDistributionProfile({ userId, platform, ...profileData });

      res.json({ ...profile, accessToken: "••••••", refreshToken: undefined });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to provision YouTube profile" });
    }
  });

  // POST /api/distribution/profiles/from-instagram — Provision an Instagram
  // Reels publishing profile from the caller's existing Facebook connection.
  // Requires a linked IG Business account and the instagram_content_publish
  // scope (users connected before that scope was added must reconnect FB).
  // The stored token is exchanged for a long-lived (~60 day) one; publishers
  // additionally re-read the user's current FB token at publish time via
  // metadata.igUserKey.
  app.post("/api/distribution/profiles/from-instagram", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const user = await storage.getUserByEmail(req.authEmail);
      if (!user?.facebookAccessToken) {
        return res.status(404).json({ error: "No Facebook connection found — connect Facebook/Instagram in Settings first" });
      }
      if (!user.instagramBusinessId) {
        return res.status(404).json({ error: "No Instagram Business account linked to your Facebook Pages — link one in Meta Business Suite, then re-sync" });
      }

      const { decrypt } = await import("./encryption");
      let igToken = decrypt(user.facebookAccessToken);

      // Exchange for a long-lived token so scheduled posts outlive the
      // short-lived login token. Best-effort: the short token still works
      // for ~1-2h if the exchange fails.
      if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
        try {
          const ex = await fetch(
            `https://graph.facebook.com/v25.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.FACEBOOK_APP_ID}&client_secret=${process.env.FACEBOOK_APP_SECRET}&fb_exchange_token=${encodeURIComponent(igToken)}`
          );
          if (ex.ok) {
            const exData = await ex.json();
            if (exData.access_token) igToken = exData.access_token;
          }
        } catch { /* keep short-lived token */ }
      }

      const userId = stableUserIntId(req.authUserId ?? req.user?.id);
      const platform = req.body?.platform === "instagram" ? "instagram" : "instagram_reels";
      const profileData = {
        accountName: user.instagramHandle || null,
        accountId: user.instagramBusinessId,
        accessToken: igToken,
        refreshToken: null,
        tokenExpiresAt: null,
        isActive: true,
        metadata: { igUserKey: req.authEmail },
      };

      const existing = (await storage.getDistributionProfiles(userId)).find(p => p.platform === platform);
      const profile = existing
        ? await storage.updateDistributionProfile(existing.id, profileData)
        : await storage.createDistributionProfile({ userId, platform, ...profileData });

      res.json({ ...profile, accessToken: "••••••", refreshToken: undefined });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to provision Instagram profile" });
    }
  });

  // PUT /api/distribution/profiles/:id — Update a profile
  app.put("/api/distribution/profiles/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await storage.getDistributionProfile(id);
      if (!existing) return res.status(404).json({ error: "Profile not found" });
      if (existing.userId !== stableUserIntId(req.authUserId ?? req.user?.id)) {
        return res.status(403).json({ error: "Not your profile" });
      }

      // Allowlist: raw req.body pass-through allowed mass assignment of
      // userId/platform/accessToken (credential injection on an owned
      // profile → confused-deputy publishing). Metadata merges over the
      // existing object but can never override the server-set
      // token-resolution pointers.
      const updates: Record<string, any> = {};
      if (typeof req.body?.accountName === "string") updates.accountName = req.body.accountName;
      if (typeof req.body?.isActive === "boolean") updates.isActive = req.body.isActive;
      if (req.body?.metadata && typeof req.body.metadata === "object") {
        const incoming = { ...req.body.metadata };
        delete incoming.youtubeUserId;
        delete incoming.igUserKey;
        const existingMeta = (existing.metadata as Record<string, any>) || {};
        updates.metadata = {
          ...existingMeta,
          ...incoming,
          ...(existingMeta.youtubeUserId !== undefined ? { youtubeUserId: existingMeta.youtubeUserId } : {}),
          ...(existingMeta.igUserKey !== undefined ? { igUserKey: existingMeta.igUserKey } : {}),
        };
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No updatable fields (accountName, isActive, metadata)" });
      }

      const updated = await storage.updateDistributionProfile(id, updates);
      if (!updated) return res.status(404).json({ error: "Profile not found" });
      res.json({ ...updated, accessToken: "••••••", refreshToken: undefined });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Update failed" });
    }
  });

  // DELETE /api/distribution/profiles/:id — Disconnect a platform
  app.delete("/api/distribution/profiles/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await storage.getDistributionProfile(id);
      if (!existing) return res.status(404).json({ error: "Profile not found" });
      if (existing.userId !== stableUserIntId(req.authUserId ?? req.user?.id)) {
        return res.status(403).json({ error: "Not your profile" });
      }
      await storage.deleteDistributionProfile(id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Delete failed" });
    }
  });

  // Publishing

  // POST /api/distribution/publish — Publish a clip to a platform
  app.post("/api/distribution/publish", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const { clipId, profileId, caption, hashtags } = req.body;
      if (!clipId || !profileId) {
        return res.status(400).json({ error: "clipId and profileId are required" });
      }

      const profile = await storage.getDistributionProfile(profileId);
      if (!profile) {
        return res.status(404).json({ error: "Distribution profile not found" });
      }
      // Ownership: profile ids are sequential ints — without this check any
      // signed-in user could publish through another user's connected
      // account (the token resolver mints a LIVE token for the profile's
      // platform connection).
      if (profile.userId !== stableUserIntId(req.authUserId ?? req.user?.id)) {
        return res.status(403).json({ error: "Not your profile" });
      }
      const { resolvePublishAccessToken } = await import("./lib/distribution/platformPublisher");
      const publishToken = await resolvePublishAccessToken(profile);
      if (!publishToken) {
        return res.status(404).json({ error: "No usable access token for this profile" });
      }

      // Find clip
      const clip = await findClipById(clipId);
      if (!clip || !clip.exportPath) {
        return res.status(404).json({ error: "Clip not found or not exported" });
      }

      // Mainline remix clips live in Object Storage (/storage/...) with the
      // local file deleted after upload — materialize to temp before publish.
      let clipPath: string;
      let tempPublishDir: string | null = null;
      if (clip.exportPath.startsWith("/storage/")) {
        tempPublishDir = path.join("/tmp/remix-videos", `publish-now-${clipId}`);
        clipPath = await downloadToTempFile(objectKeyFromServeUrl(clip.exportPath), tempPublishDir);
      } else {
        clipPath = path.join(process.cwd(), "public", clip.exportPath.replace(/^\//, ""));
        if (!fs.existsSync(clipPath)) {
          return res.status(404).json({ error: "Clip file not found on disk" });
        }
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
      const publishMetadata: Record<string, any> = { ...(profile.metadata as Record<string, any> || {}) };
      // Instagram's API pulls the video from a public URL instead of
      // accepting an upload — point it at the clip's public export path.
      if (profile.platform.startsWith("instagram") && !publishMetadata.publicVideoUrl && clip.exportPath) {
        const base = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "https://gofullscale.co").replace(/\/$/, "");
        publishMetadata.publicVideoUrl = `${base}${clip.exportPath.startsWith("/") ? "" : "/"}${clip.exportPath}`;
      }
      const result = await publishToPlaftorm(profile.platform, {
        clipPath,
        caption: finalCaption,
        hashtags: finalHashtags,
        accessToken: publishToken,
        accountId: profile.accountId || "",
        metadata: publishMetadata,
      });

      if (tempPublishDir) {
        try { fs.rmSync(tempPublishDir, { recursive: true, force: true }); } catch {}
      }

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
          status: result.dryRun ? "dry_run" : "published",
        });
        res.json({ success: true, post, postUrl: result.postUrl, dryRun: !!result.dryRun });
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
  app.post("/api/distribution/schedule", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = stableUserIntId(req.authUserId ?? req.user?.id);
      const { clipId, profileId, platform, scheduledFor, caption, hashtags } = req.body;

      if (!clipId || !profileId || !scheduledFor) {
        return res.status(400).json({ error: "clipId, profileId, and scheduledFor are required" });
      }

      const targetProfile = await storage.getDistributionProfile(parseInt(profileId));
      if (!targetProfile || targetProfile.userId !== userId) {
        return res.status(403).json({ error: "Not your distribution profile" });
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
  app.post("/api/distribution/schedule/batch", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = stableUserIntId(req.authUserId ?? req.user?.id);
      const { clipId, platformProfiles, baseTime, staggerMinutes, caption, hashtags } = req.body;

      if (!clipId || !platformProfiles || !baseTime) {
        return res.status(400).json({ error: "clipId, platformProfiles, and baseTime are required" });
      }

      // Every referenced profile must belong to the caller.
      for (const pp of platformProfiles) {
        const prof = await storage.getDistributionProfile(parseInt(pp?.profileId));
        if (!prof || prof.userId !== userId) {
          return res.status(403).json({ error: `Not your distribution profile: ${pp?.profileId}` });
        }
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
  app.get("/api/distribution/schedules", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const userId = stableUserIntId(req.authUserId ?? req.user?.id);
      const schedules = await storage.getSchedulesByUser(userId);
      res.json(schedules);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch schedules" });
    }
  });

  // DELETE /api/distribution/schedules/:id — Cancel a scheduled post
  app.delete("/api/distribution/schedules/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      // Ownership-scoped: cancels nothing unless the schedule belongs to
      // the caller (ids are sequential ints — anyone could guess them).
      const cancelled = await storage.cancelSchedule(id, stableUserIntId(req.authUserId ?? req.user?.id));
      if (!cancelled) return res.status(404).json({ error: "Schedule not found" });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Cancel failed" });
    }
  });

  // Caption Formatting

  // POST /api/distribution/format-caption — Generate platform-specific caption
  app.post("/api/distribution/format-caption", isFlexibleAuthenticated, async (req: any, res) => {
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

  // Shared assembly for a Meta account's analytics payload. Two consumers
  // with deliberately different depth:
  //   - /api/analytics/social (creator): OVERVIEW tier — the value surface
  //     the App Review screencasts show (KPIs, trends, audience snapshot,
  //     top posts).
  //   - /api/admin/creator-intelligence/:userId (operator): FULL tier —
  //     every breakdown, complete media table, stories, history.
  const assembleAccountAnalytics = async (acct: any, mediaCount: number) => {
    const withTimeout = <T,>(p: Promise<T | null>, ms: number): Promise<T | null> =>
      Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    const snapshots = await storage.getSocialInsightSnapshotsForAccount(acct.id, 60);
    const latest = snapshots[0] ?? null;
    // Chronological series for trend charts
    const series = [...snapshots].reverse().map((s: any) => ({
      capturedAt: s.capturedAt,
      followers: s.followers ?? null,
      views: (s.metrics as any)?.views ?? (s.metrics as any)?.page_media_view ?? 0,
      reach: (s.metrics as any)?.reach ?? (s.metrics as any)?.page_total_media_view_unique ?? 0,
      interactions: (s.metrics as any)?.total_interactions ?? (s.metrics as any)?.page_post_engagements ?? 0,
    }));

    // Live recent-media performance (best-effort; token may be stale).
    // Bounded: the fan-out is ~2 Graph calls per media with no native timeout.
    let recentMedia: any[] = [];
    let liveFollowers: number | null = null;
    if (acct.platform === "instagram" && acct.accessToken && mediaCount > 0) {
      const live = await withTimeout(fetchInstagramAnalytics(acct.platformAccountId, acct.accessToken, mediaCount), 8000);
      if (live) {
        recentMedia = live.recentMedia;
        liveFollowers = live.followers;
      }
    }

    return {
      id: acct.id,
      platform: acct.platform,
      handle: acct.handle,
      displayName: acct.displayName,
      avatarUrl: acct.avatarUrl,
      followers: liveFollowers ?? acct.followers ?? latest?.followers ?? 0,
      lastCapturedAt: latest?.capturedAt ?? null,
      metrics: latest?.metrics ?? {},
      demographics: latest?.demographics ?? acct.audienceData ?? {},
      stories: latest?.stories ?? [],
      series,
      recentMedia,
    };
  };

  // GET /api/analytics/social — the creator-facing analytics OVERVIEW.
  // Follower count, core engagement KPIs, trends, an audience snapshot, and
  // top recent posts — the creator-value surface the instagram_manage_insights
  // / read_insights App Review screencasts show. The exhaustive drill-down
  // deliberately lives on the admin side, not here.
  app.get("/api/analytics/social", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const accounts = await storage.getSocialAccountsByUser(req.authUserId, req.authEmail);
      const metaAccounts = accounts.filter((a) => a.platform === "instagram" || a.platform === "facebook");
      const out = await Promise.all(metaAccounts.map((acct) => assembleAccountAnalytics(acct, 6)));
      res.json({ accounts: out });
    } catch (err: any) {
      console.error("[API] /api/analytics/social error:", err.message);
      res.status(500).json({ error: "Failed to load social analytics" });
    }
  });

  // GET /api/admin/creator-intelligence/:userId — FULL-depth drill-down on
  // one creator for the FullScale operator: complete demographics breakdowns,
  // full media tables with watch time, stories, snapshot history, placements.
  // Admin-gated. Used to deliver the marketplace service (brand matching,
  // placement pricing) — never shown in Meta App Review screencasts.
  app.get("/api/admin/creator-intelligence/:userId", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      if (!req.isAdmin) return res.status(403).json({ error: "Admin only" });
      const targetId = String(req.params.userId || "");
      if (!targetId) return res.status(400).json({ error: "userId required" });
      let user = await storage.getUserById(targetId);
      if (!user && targetId.includes("@")) user = await storage.getUserByEmail(targetId);
      const accounts = await storage.getSocialAccountsByUser(user?.id ?? targetId, user?.email ?? undefined);
      const metaAccounts = accounts.filter((a) => a.platform === "instagram" || a.platform === "facebook");
      const out = await Promise.all(metaAccounts.map((acct) => assembleAccountAnalytics(acct, 12)));

      let placements: any[] = [];
      try {
        placements = await storage.getCreatorPlacements(
          user?.id ?? targetId,
          "pending_creator_review,creator_approved,pending_brand_review,brand_approved,creator_rejected,brand_withdrawn",
        );
      } catch { /* best-effort */ }

      res.json({
        creator: {
          userId: user?.id ?? targetId,
          name: user ? [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email : targetId,
          email: user?.email ?? null,
        },
        accounts: out,
        placements: placements.map((p: any) => ({
          id: p.id,
          status: p.status,
          videoId: p.videoId,
          brandProductId: p.brandProductId,
          placementFeeCents: p.placementFeeCents,
          creatorPayoutCents: p.creatorPayoutCents,
          createdAt: p.createdAt,
        })),
      });
    } catch (err: any) {
      console.error("[API] /api/admin/creator-intelligence/:userId error:", err.message);
      res.status(500).json({ error: "Failed to load creator detail" });
    }
  });

  // GET /api/admin/creator-intelligence — the OPERATOR roster: EVERY creator
  // account on the platform (not just Meta-connected), each with connection
  // coverage, audience (latest Meta snapshot), supply (scanned videos /
  // canonical surfaces / scene classes / sellable minutes), the placement
  // funnel, and editorial clip totals. Admin-gated; built from whole-table
  // GROUP BY aggregates folded onto canonical users — no per-creator queries
  // (the old per-account loop was an N+1 against the pool). NOT the surface
  // shown in Meta App Review screencasts (that's /analytics).
  app.get("/api/admin/creator-intelligence", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      if (!req.isAdmin) return res.status(403).json({ error: "Admin only" });

      const [
        roster, allowlist, supplyRows, surfaceRows, funnelRows,
        releaseRows, coverageRows, ytKeys, snapshotRows,
      ] = await Promise.all([
        storage.getAllUserIdentities(),
        storage.getAllowedUsers(),
        storage.getCreatorSupplyAggregates(),
        storage.getCreatorSurfaceAggregates(),
        storage.getCreatorPlacementFunnelAggregates(),
        storage.getCreatorReleaseCounts(),
        storage.getSocialCoverageKeys(),
        storage.getYoutubeConnectionKeys(),
        storage.getLatestInsightSnapshotPerUser(),
      ]);

      // ── Who counts as a creator ───────────────────────────────────────
      // The users table carries no role column — the role lives on the
      // allowed_users allowlist (userType 'creator' | 'brand'; see the brand
      // signup flow and updateAllowedUserRole). A users row is treated as a
      // CREATOR unless its email is allowlisted with userType='brand':
      // brands only ever enter through explicitly brand-typed allowlist
      // paths, while legacy creator signups may predate their allowlist row
      // entirely — so "not a known brand" is the safe creator test (and it
      // keeps creators who own videoIndex rows without an allowlist entry).
      const brandEmails = new Set(
        allowlist
          .filter((a) => a.userType === "brand")
          .map((a) => (a.email || "").toLowerCase()),
      );
      const creatorUsers = roster.filter(
        (u) => !brandEmails.has((u.email || "").toLowerCase()),
      );

      // ── Identity-alias fold ───────────────────────────────────────────
      // Data tables key rows by users.id OR legacy email (the dual-ID
      // reality identityMatchValues resolves per-user). The aggregates come
      // back GROUPed BY the RAW key, so fold them onto canonical users.id
      // through an alias map instead of a lookup query per creator.
      const canonicalByAlias = new Map<string, string>();
      for (const u of creatorUsers) {
        canonicalByAlias.set(u.id, u.id);
        if (u.email) canonicalByAlias.set(u.email.toLowerCase(), u.id);
      }
      const resolveAlias = (raw: string | null | undefined): string | null => {
        if (!raw) return null;
        return canonicalByAlias.get(raw) ?? canonicalByAlias.get(raw.toLowerCase()) ?? null;
      };

      type SupplyAgg = { videosScanned: number; canonicalSurfaces: number; sceneClasses: number; sellableSec: number };
      type FunnelAgg = { surfacesApproved: number; brandRequests: number; placementsApproved: number; released: number };
      type EditorialAgg = { clipsGenerated: number; clipsRendered: number };
      const supply = new Map<string, SupplyAgg>();
      const funnel = new Map<string, FunnelAgg>();
      const editorial = new Map<string, EditorialAgg>();
      const supplyFor = (id: string): SupplyAgg => {
        let s = supply.get(id);
        if (!s) { s = { videosScanned: 0, canonicalSurfaces: 0, sceneClasses: 0, sellableSec: 0 }; supply.set(id, s); }
        return s;
      };
      const funnelFor = (id: string): FunnelAgg => {
        let f = funnel.get(id);
        if (!f) { f = { surfacesApproved: 0, brandRequests: 0, placementsApproved: 0, released: 0 }; funnel.set(id, f); }
        return f;
      };

      for (const row of supplyRows) {
        const id = resolveAlias(row.userId);
        if (!id) continue; // brand-owned or orphaned key — not roster supply
        const s = supplyFor(id);
        s.videosScanned += row.videosScanned;
        s.sceneClasses += row.sceneClasses;
        s.sellableSec += row.sellableSec;
        const e = editorial.get(id) ?? { clipsGenerated: 0, clipsRendered: 0 };
        e.clipsGenerated += row.clipsGenerated;
        e.clipsRendered += row.clipsRendered;
        editorial.set(id, e);
      }
      for (const row of surfaceRows) {
        const id = resolveAlias(row.userId);
        if (!id) continue;
        supplyFor(id).canonicalSurfaces += row.canonicalSurfaces;
        funnelFor(id).surfacesApproved += row.surfacesApproved;
      }
      for (const row of funnelRows) {
        const id = resolveAlias(row.userId);
        if (!id) continue;
        const f = funnelFor(id);
        f.brandRequests += row.brandRequests;
        f.placementsApproved += row.placementsApproved;
      }
      for (const row of releaseRows) {
        const id = resolveAlias(row.userId);
        if (id) funnelFor(id).released += row.released;
      }

      const coverage = new Map<string, { meta: boolean; youtube: boolean }>();
      const coverageFor = (id: string) => {
        let c = coverage.get(id);
        if (!c) { c = { meta: false, youtube: false }; coverage.set(id, c); }
        return c;
      };
      for (const row of coverageRows) {
        const id = resolveAlias(row.userId);
        if (!id) continue;
        if (row.platform === "instagram" || row.platform === "facebook") coverageFor(id).meta = true;
      }
      for (const key of ytKeys) {
        const id = resolveAlias(key);
        if (id) coverageFor(id).youtube = true;
      }

      // Sum accounts per canonical user. Rows arrive as latest-per-account
      // (IG and FB each snapshot separately under one user_id); alias keys
      // for the same human dedupe per account id so a legacy-email row and
      // a UUID row for the same IG account can't double-count.
      const audienceAgg = new Map<string, { followers: number | null; interactions: number; reach: number; accounts: Set<string> }>();
      for (const row of snapshotRows) {
        const id = resolveAlias(row.userId);
        if (!id) continue;
        const agg = audienceAgg.get(id) ?? { followers: null, interactions: 0, reach: 0, accounts: new Set<string>() };
        if (agg.accounts.has(row.platformAccountId)) continue;
        agg.accounts.add(row.platformAccountId);
        if (typeof row.followers === "number") {
          agg.followers = (agg.followers ?? 0) + row.followers;
        }
        const m: any = row.metrics ?? {};
        const interactions = m.total_interactions ?? m.page_post_engagements;
        const reach = m.reach ?? m.page_total_media_view_unique;
        if (typeof interactions === "number") agg.interactions += interactions;
        if (typeof reach === "number") agg.reach += reach;
        audienceAgg.set(id, agg);
      }

      const creators = creatorUsers.map((u) => {
        const s = supply.get(u.id) ?? { videosScanned: 0, canonicalSurfaces: 0, sceneClasses: 0, sellableSec: 0 };
        const e = editorial.get(u.id) ?? { clipsGenerated: 0, clipsRendered: 0 };
        const f = funnel.get(u.id) ?? { surfacesApproved: 0, brandRequests: 0, placementsApproved: 0, released: 0 };
        const c = coverage.get(u.id) ?? { meta: false, youtube: false };
        const snap = audienceAgg.get(u.id) ?? null;
        const engagementRatePct =
          snap && snap.reach > 0
            ? Math.round((snap.interactions / snap.reach) * 10000) / 100
            : null;
        return {
          userId: u.id,
          email: u.email ?? null,
          name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || u.id,
          joinedAt: u.createdAt ?? null,
          coverage: { meta: c.meta, youtube: c.youtube },
          audience: {
            followers: snap?.followers ?? null,
            engagementRatePct,
            source: snap ? ("meta" as const) : null,
          },
          supply: {
            videosScanned: s.videosScanned,
            canonicalSurfaces: s.canonicalSurfaces,
            sceneClasses: s.sceneClasses,
            sellableMinutes: Math.round((s.sellableSec / 60) * 10) / 10,
          },
          funnel: {
            surfacesApproved: f.surfacesApproved,
            brandRequests: f.brandRequests,
            placementsApproved: f.placementsApproved,
            released: f.released,
          },
          editorial: { clipsGenerated: e.clipsGenerated, clipsRendered: e.clipsRendered },
        };
      });

      // Most-monetizable first: audience, then supply depth, then recency
      creators.sort((a, b) =>
        ((b.audience.followers ?? -1) - (a.audience.followers ?? -1)) ||
        (b.supply.videosScanned - a.supply.videosScanned) ||
        (new Date(b.joinedAt ?? 0).getTime() - new Date(a.joinedAt ?? 0).getTime()),
      );

      res.json({ creators });
    } catch (err: any) {
      console.error("[API] /api/admin/creator-intelligence error:", err.message);
      res.status(500).json({ error: "Failed to load creator intelligence" });
    }
  });

  // GET /api/admin/data-inventory — live census of every data asset the
  // platform holds, grouped by provenance: first-party (our tables, our
  // marketplace events), third-party (platform-API metrics we merely display
  // in-app), and derived (blends). Each card carries a licensable posture —
  // the house export rule: third-party platform metrics are NEVER exportable
  // or licensable (Meta Platform Terms / YouTube API ToS), and derived
  // blends leave only as consented aggregates. This payload contains counts
  // only — no raw platform metric values. Computed live; no schema changes.
  app.get("/api/admin/data-inventory", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      if (!req.isAdmin) return res.status(403).json({ error: "Admin only" });
      const inv = await storage.getDataInventoryCounts();
      const st = inv.assignmentsByStatus;
      const sellableMinutes = Math.round((inv.videos.sellableSec / 60) * 10) / 10;
      const allowlistCreators = inv.allowlistByType["creator"] ?? 0;
      const allowlistBrands = inv.allowlistByType["brand"] ?? 0;

      const firstParty = [
        {
          key: "roster",
          title: "Creator & Brand Roster",
          description: "Registered accounts plus the typed allowlist that separates creators from brands.",
          table: "users + allowed_users",
          rowCount: inv.users.rowCount,
          last30d: inv.users.last30d,
          licensable: "consent-required",
          notes: `Allowlist: ${allowlistCreators} creators, ${allowlistBrands} brands. Contains PII — external use requires user consent.`,
        },
        {
          key: "videos-indexed",
          title: "Videos Indexed",
          description: "Creator videos imported or uploaded into the scan pipeline (active, non-trashed).",
          table: "video_index",
          rowCount: inv.videos.rowCount,
          last30d: inv.videos.last30d,
          licensable: "consent-required",
          notes: `${inv.videos.ready} fully scanned (status Ready). Creator-owned content — licensing needs creator consent.`,
        },
        {
          key: "scene-supply",
          title: "Scene Classes, Canonical Surfaces & Sellable Screen-Time",
          description: "FullScale-derived structural index of what is physically sellable inside creator footage.",
          table: "detected_surfaces + video_index.scene_inventory",
          rowCount: inv.surfaces.rowCount,
          last30d: inv.surfaces.last30d,
          licensable: "yes",
          notes: `${inv.surfaces.canonical} canonical surfaces across ${inv.videos.sceneClasses} scene classes; ${sellableMinutes} sellable screen-minutes (scenes with at least one surface). Structural metadata only — no platform metrics.`,
        },
        {
          key: "placement-funnel",
          title: "Placement Funnel Events",
          description: "Creator-side saved placements plus brand-initiated placement requests through the approval lifecycle.",
          table: "saved_placements + brand_placement_assignments",
          rowCount: inv.savedPlacements.rowCount + inv.assignments.rowCount,
          last30d: inv.savedPlacements.last30d + inv.assignments.last30d,
          licensable: "yes",
          notes: `Requests by status: ${st["pending_creator_review"] ?? 0} pending, ${(st["creator_approved"] ?? 0) + (st["pending_brand_review"] ?? 0)} creator-approved, ${st["brand_approved"] ?? 0} brand-approved. First-party marketplace events.`,
        },
        {
          key: "pricing-points",
          title: "Placement Pricing Points",
          description: "CPM-rubric priced placement requests: fee, platform take, creator payout, and the full pricing breakdown audit blob.",
          table: "brand_placement_assignments",
          rowCount: inv.assignments.priced,
          last30d: inv.assignments.pricedLast30d,
          licensable: "yes",
          notes: "Fields: placement_fee_cents, platform_take_cents, creator_payout_cents, custom_fee_cents, duration_term, pricing_breakdown. First-party pricing signal.",
        },
        {
          key: "editorial-clips",
          title: "Editorial Clips",
          description: "AI-identified narrative moments per video, with render state and quality scoring.",
          table: "editorial_clips",
          rowCount: inv.editorialClips.rowCount,
          last30d: inv.editorialClips.last30d,
          licensable: "consent-required",
          notes: `${inv.editorialClips.rendered} rendered. Derivative of creator content — distribution needs creator consent.`,
        },
        {
          key: "release-pages",
          title: "Release Pages (Shared Links)",
          description: "Public share links for placements and exports, including A1 release pages minted at brand approval.",
          table: "shared_links",
          rowCount: inv.sharedLinks.rowCount,
          last30d: inv.sharedLinks.last30d,
          licensable: "yes",
          notes: `${inv.sharedLinks.releasePages} brand-release pages (brand_placement_id set). Already public surfaces; view counts are first-party.`,
        },
      ];

      const thirdParty = [
        {
          key: "meta-insight-snapshots",
          title: "Meta Insight Snapshots",
          description: "Longitudinal IG/FB account insights (followers, engagement, demographics) captured by the snapshot job beyond Meta's ~90-day retention.",
          table: "social_insight_snapshots",
          rowCount: inv.insightSnapshots.rowCount,
          last30d: inv.insightSnapshots.last30d,
          licensable: "no",
          notes: "Meta Platform Terms — in-app display only. Never exported, resold, or included in licensable datasets.",
        },
        {
          key: "social-account-stats",
          title: "Social Account Stats",
          description: "Per-account platform stats cached on connected social accounts: follower counts, total views, audience_data demographics.",
          table: "social_accounts",
          rowCount: inv.socialAccounts.rowCount,
          last30d: inv.socialAccounts.last30d,
          licensable: "no",
          notes: "Stats fields originate from platform Graph/Data APIs — display only under the source platform's terms; no export.",
        },
        {
          key: "youtube-stats",
          title: "YouTube Channel & Video Stats",
          description: "Channel subscriber/view totals on OAuth connections plus per-video view counts refreshed from the YouTube Data API.",
          table: "youtube_connections",
          rowCount: inv.youtubeConnections.rowCount,
          last30d: inv.youtubeConnections.last30d,
          licensable: "no",
          notes: "YouTube API Services ToS — metrics are display-only and refreshed from the API; no export or retention beyond policy.",
        },
      ];

      const derived = [
        {
          key: "brand-fit-metrics",
          title: "Brand-Fit & Blended Metrics",
          description: "Scene-to-brand compatibility scores and narrative analysis blending first-party scene structure with platform-sourced audience signals.",
          table: "brand_match_scores + scene_analysis",
          rowCount: inv.brandMatchScores.rowCount + inv.sceneAnalysis.rowCount,
          last30d:
            inv.brandMatchScores.last30d != null && inv.sceneAnalysis.last30d != null
              ? inv.brandMatchScores.last30d + inv.sceneAnalysis.last30d
              : null,
          licensable: "consent-required",
          notes: `Export posture: aggregate-only (cohort-level, never raw platform metrics), and per-creator export requires creator consent. Inputs include ${inv.brandProducts.rowCount} brand product profiles.`,
        },
      ];

      res.json({ firstParty, thirdParty, derived });
    } catch (err: any) {
      console.error("[API] /api/admin/data-inventory error:", err.message);
      res.status(500).json({ error: "Failed to load data inventory" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // Room model admin — operator visibility and reset for the scanner's
  // persistent SET MEMORY (room_models). Each row is one recurring camera
  // setup whose canonical surfaces every later scan of that room CONFIRMS
  // instead of re-discovering. That's the point when the model is good, and
  // the problem when it isn't: a model built from a degraded scan (bad
  // lighting, a one-off camera angle, a person parked over the desk) keeps
  // stamping its wrong surfaces onto every future episode, and no code path
  // prunes it. These endpoints are the only way to SEE set memory and to
  // forget it. Same admin gate as the rest of /api/admin/*.
  // ══════════════════════════════════════════════════════════════════════

  // GET /api/admin/room-models — every set the platform remembers, freshest
  // confirmation first, with the creator it belongs to and the video that
  // last confirmed it. Counts are derived from the jsonb defensively: a
  // malformed surfaces blob reads as zero surfaces rather than 500ing the
  // one screen an operator would use to delete it.
  app.get("/api/admin/room-models", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      if (!req.isAdmin) return res.status(403).json({ error: "Admin only" });

      const models = await storage.getAllRoomModels();
      if (models.length === 0) return res.json({ models: [] });

      // ── Batch lookups (no per-model queries) ──────────────────────────
      // room_models.userId is users.id for new rows and a legacy email for
      // old ones, so index the roster both ways and resolve either key.
      const roster = await storage.getAllUserIdentities();
      const byIdentity = new Map<string, (typeof roster)[number]>();
      for (const u of roster) {
        byIdentity.set(u.id, u);
        if (u.email) byIdentity.set(u.email.toLowerCase(), u);
      }

      const videoIds = Array.from(
        new Set(models.map((m) => m.lastVideoId).filter((id): id is number => typeof id === "number")),
      );
      const titleById = new Map<number, string | null>();
      if (videoIds.length > 0) {
        const rows = await db
          .select({ id: videoIndexTable.id, title: videoIndexTable.title })
          .from(videoIndexTable)
          .where(inArray(videoIndexTable.id, videoIds));
        for (const row of rows) titleById.set(row.id, row.title ?? null);
      }

      const out = models.map((m) => {
        // Match the scanner's parseRoomModelSurfaces guard EXACTLY. A looser
        // count here would be worse than useless on this screen: a model
        // whose entries lack a bbox would show "6 surfaces" while every scan
        // using it resolves zero and places nothing — precisely the degraded
        // model the operator came here to find and forget.
        const surfaces = Array.isArray(m.surfaces) ? (m.surfaces as any[]) : [];
        const usable = surfaces.filter((s) =>
          s &&
          typeof s.idx === "number" &&
          typeof s.surfaceType === "string" && s.surfaceType.length > 0 &&
          (s.orientation === "horizontal" || s.orientation === "vertical") &&
          s.bbox &&
          typeof s.bbox.x === "number" && typeof s.bbox.y === "number" &&
          typeof s.bbox.w === "number" && typeof s.bbox.h === "number" &&
          typeof s.confidence === "number");
        const unusableCount = surfaces.length - usable.length;
        const surfaceTypes: string[] = [];
        for (const s of usable) {
          if (!surfaceTypes.includes(s.surfaceType)) surfaceTypes.push(s.surfaceType);
        }
        const user = byIdentity.get(m.userId) ?? byIdentity.get(m.userId.toLowerCase());

        return {
          id: m.id,
          userId: m.userId,
          creatorName: user
            ? [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email || user.id
            : null,
          creatorEmail: user?.email ?? (m.userId.includes("@") ? m.userId : null),
          surfaceCount: usable.length,
          unusableCount,
          surfaceTypes,
          episodeCount: m.episodeCount ?? 0,
          exemplarCount: Array.isArray(m.sceneExemplarHashes) ? m.sceneExemplarHashes.length : 0,
          sourceVideoId: m.sourceVideoId ?? null,
          lastVideoId: m.lastVideoId ?? null,
          lastVideoTitle: m.lastVideoId != null ? titleById.get(m.lastVideoId) ?? null : null,
          createdAt: m.createdAt ?? null,
          updatedAt: m.updatedAt ?? null,
        };
      });

      res.json({ models: out });
    } catch (err: any) {
      console.error("[API] /api/admin/room-models error:", err.message);
      res.status(500).json({ error: "Failed to load room models" });
    }
  });

  // DELETE /api/admin/room-models/:id — forget one set. The next scan of that
  // room rediscovers it from scratch; surfaces already written by past scans
  // are untouched.
  // Destructive room-model routes demand a REAL session, not just req.isAdmin.
  // isFlexibleAuthenticated's dev fallbacks (?admin_email=, x-admin-email,
  // ALLOW_DEV_AUTH) set isAdmin with no credentials whatsoever — acceptable
  // for read paths, but these delete other creators' persistent set memory
  // with no undo, so a guessable query param must never be enough.
  const requireRealAdminSession = (req: any, res: any): boolean => {
    if (!req.isAdmin) {
      res.status(403).json({ error: "Admin only" });
      return false;
    }
    if (!req.user && !req.session?.userId && !req.session?.passport?.user) {
      console.warn(`[Admin] Rejected credential-less room-model delete (dev auth fallback) from ${req.authEmail || "unknown"}`);
      res.status(403).json({ error: "A signed-in admin session is required for this action" });
      return false;
    }
    return true;
  };

  app.delete("/api/admin/room-models/:id", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      if (!requireRealAdminSession(req, res)) return;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Valid room model id required" });
      const deleted = await storage.deleteRoomModel(id);
      if (!deleted) return res.status(404).json({ error: "Room model not found" });
      console.log(`[Admin] Room model ${id} deleted by ${req.authEmail}`);
      res.json({ deleted: true });
    } catch (err: any) {
      console.error("[API] DELETE /api/admin/room-models/:id error:", err.message);
      res.status(500).json({ error: "Failed to delete room model" });
    }
  });

  // DELETE /api/admin/room-models?scope=all — wipe set memory platform-wide.
  // Requires the explicit scope=all so a client that merely forgot to
  // interpolate an id into the per-model URL can never nuke every creator's
  // memory by accident.
  app.delete("/api/admin/room-models", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      if (!requireRealAdminSession(req, res)) return;
      if (req.query.scope !== "all") {
        return res.status(400).json({ error: "scope=all required to reset all room models" });
      }
      const deleted = await storage.deleteAllRoomModels();
      console.log(`[Admin] Room model reset: ${deleted} model(s) forgotten by ${req.authEmail}`);
      res.json({ deleted });
    } catch (err: any) {
      console.error("[API] DELETE /api/admin/room-models error:", err.message);
      res.status(500).json({ error: "Failed to reset room models" });
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
  app.get("/api/distribution/analytics/video/:videoId", isFlexibleAuthenticated, async (req: any, res) => {
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
  app.post("/api/distribution/analytics/video/:videoId/refresh", isFlexibleAuthenticated, async (req: any, res) => {
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
  app.get("/api/distribution/analytics/clip/:clipId", isFlexibleAuthenticated, async (req: any, res) => {
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
  app.get("/api/distribution/posts/video/:videoId", isFlexibleAuthenticated, async (req: any, res) => {
    try {
      const videoId = parseInt(req.params.videoId);
      const posts = await storage.getPublishedPostsByVideo(videoId);
      res.json(posts);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch posts" });
    }
  });

  // POST /api/distribution/suggest-time — Get optimal posting time for a platform
  app.post("/api/distribution/suggest-time", isFlexibleAuthenticated, async (req: any, res) => {
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

  // Seed Data.
  // NON-FATAL, and this matters more than it looks: registerRoutes is awaited
  // BEFORE httpServer.listen(), and the boot catch calls process.exit(1). So
  // an unguarded throw here — a slow database, an exhausted pool, one bad row
  // — stops the process before it ever binds the port, Replit restarts it,
  // and it fails the same way: a crash loop in which the site does not load
  // at all rather than loading degraded. Demo seed data is never worth that.
  try {
    await seedDatabase();
  } catch (seedErr: any) {
    console.error(`[Boot] Seeding failed (non-fatal, server still starting): ${seedErr?.message ?? seedErr}`);
  }

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
