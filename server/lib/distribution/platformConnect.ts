/**
 * OAuth connect flows that provision distribution publishing tokens.
 *
 * Token sources per platform:
 * - YouTube    → youtube_connections (existing flow) via /api/distribution/profiles/from-youtube
 * - Instagram  → users.facebookAccessToken (existing FB Login flow) via /from-instagram
 * - TikTok     → /auth/tiktok flow here (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET)
 * - X/Twitter  → /auth/twitter flow here (X_CLIENT_ID / X_CLIENT_SECRET), OAuth2 + PKCE
 * - LinkedIn   → /auth/linkedin flow here (LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET)
 *
 * Tokens land directly on distribution_profiles rows keyed
 * (stableUserIntId(user), platform) — the same ids the /api/distribution
 * routes derive — and are refreshed at publish time by
 * resolvePublishAccessToken (platformPublisher.ts) where the platform
 * supports it (TikTok and X rotate refresh tokens; LinkedIn tokens last
 * ~60 days with no self-serve refresh — the user reconnects).
 */

import type { Express } from "express";
import * as crypto from "crypto";
import { storage } from "../../storage";
import { stableUserIntId } from "../stableUserId";

const BASE_URL = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "https://gofullscale.co";

/** Same identity derivation as isFlexibleAuthenticated so profiles land
 *  under the ids the distribution API queries with. Throws on DB failure —
 *  callers redirect to a connect_error rather than provisioning under a
 *  possibly-wrong fallback id. */
async function sessionUserIntId(req: any): Promise<number | null> {
  const email = req.session?.googleUser?.email || req.user?.claims?.email;
  if (!email) return null;
  const authUserId = (await storage.getUserByEmail(email))?.id || email;
  return stableUserIntId(authUserId);
}

async function upsertProfile(
  userId: number,
  platform: string,
  data: {
    accountName?: string | null;
    accountId?: string | null;
    accessToken: string;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
    metadata?: Record<string, any> | null;
  },
) {
  const existing = (await storage.getDistributionProfiles(userId)).find(p => p.platform === platform);
  const row = {
    accountName: data.accountName ?? null,
    accountId: data.accountId ?? null,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    tokenExpiresAt: data.tokenExpiresAt ?? null,
    isActive: true,
    metadata: data.metadata ?? null,
  };
  return existing
    ? storage.updateDistributionProfile(existing.id, row)
    : storage.createDistributionProfile({ userId, platform, ...row });
}

// ─── TikTok ──────────────────────────────────────────────────────

const TIKTOK_AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

/** Refresh a TikTok access token and persist the rotated pair. */
export async function refreshTikTokToken(profile: {
  id: number;
  refreshToken?: string | null;
}): Promise<string | null> {
  if (!profile.refreshToken || !process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET) return null;
  try {
    const res = await fetch(TIKTOK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: profile.refreshToken,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.access_token) return null;
    await storage.updateDistributionProfile(profile.id, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || profile.refreshToken,
      tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    });
    return data.access_token;
  } catch (err: any) {
    console.error("[PlatformConnect] TikTok refresh failed:", err.message);
    return null;
  }
}

// ─── X / Twitter ─────────────────────────────────────────────────

const X_AUTH_URL = "https://x.com/i/oauth2/authorize";
const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";

function xBasicAuth(): string {
  return "Basic " + Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString("base64");
}

/** Refresh an X access token. X rotates refresh tokens — persist the new one. */
export async function refreshTwitterToken(profile: {
  id: number;
  refreshToken?: string | null;
}): Promise<string | null> {
  if (!profile.refreshToken || !process.env.X_CLIENT_ID || !process.env.X_CLIENT_SECRET) return null;
  try {
    const res = await fetch(X_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": xBasicAuth(),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: profile.refreshToken,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.access_token) return null;
    await storage.updateDistributionProfile(profile.id, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || profile.refreshToken,
      tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    });
    return data.access_token;
  } catch (err: any) {
    console.error("[PlatformConnect] X refresh failed:", err.message);
    return null;
  }
}

// ─── LinkedIn ────────────────────────────────────────────────────

const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

// ─── Route registration ──────────────────────────────────────────

export function registerDistributionOAuthRoutes(app: Express) {
  // TikTok — requires a TikTok developer app. Unaudited apps can only
  // direct-post with privacy SELF_ONLY (visible to the creator alone),
  // which is why provisioned profiles default to that.
  app.get("/auth/tiktok", async (req: any, res) => {
    try {
      if (!process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET) {
        return res.redirect("/settings?connect_error=tiktok_not_configured");
      }
      const userId = await sessionUserIntId(req);
      if (!userId) return res.redirect("/settings?connect_error=login_required");

      const state = crypto.randomBytes(16).toString("hex");
      req.session.tiktokOauth = { state, userId };
      const params = new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        // video.list is what the Display API's video/query endpoint needs to
        // return per-post metrics; without it the measurement spine gets 403
        // for every TikTok video. Existing connections predate this scope and
        // must reconnect before their metrics work.
        scope: "user.info.basic,video.upload,video.publish,video.list",
        response_type: "code",
        redirect_uri: `${BASE_URL}/auth/tiktok/callback`,
        state,
      });
      res.redirect(`${TIKTOK_AUTH_URL}?${params.toString()}`);
    } catch (err: any) {
      console.error("[PlatformConnect] tiktok connect init error:", err.message);
      res.redirect("/settings?connect_error=tiktok_failed");
    }
  });

  app.get("/auth/tiktok/callback", async (req: any, res) => {
    try {
      const pending = req.session.tiktokOauth;
      delete req.session.tiktokOauth;
      if (!pending || req.query.state !== pending.state) {
        return res.redirect("/settings?connect_error=tiktok_state_mismatch");
      }
      if (!req.query.code) return res.redirect("/settings?connect_error=tiktok_denied");

      const tokenRes = await fetch(TIKTOK_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: process.env.TIKTOK_CLIENT_KEY!,
          client_secret: process.env.TIKTOK_CLIENT_SECRET!,
          grant_type: "authorization_code",
          code: String(req.query.code),
          redirect_uri: `${BASE_URL}/auth/tiktok/callback`,
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || !tokens.access_token) {
        console.error("[PlatformConnect] TikTok token exchange failed:", JSON.stringify(tokens));
        return res.redirect("/settings?connect_error=tiktok_token_exchange");
      }

      let displayName: string | null = null;
      try {
        const infoRes = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", {
          headers: { "Authorization": `Bearer ${tokens.access_token}` },
        });
        const info = await infoRes.json();
        displayName = info?.data?.user?.display_name || null;
      } catch { /* display name is cosmetic */ }

      await upsertProfile(pending.userId, "tiktok", {
        accountName: displayName,
        accountId: tokens.open_id || null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        tokenExpiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
        // SELF_ONLY until the TikTok app passes audit — posts are visible
        // only to the creator, which is also the safe test mode.
        metadata: {
          privacyLevel: "SELF_ONLY",
          refreshExpiresAt: tokens.refresh_expires_in
            ? new Date(Date.now() + tokens.refresh_expires_in * 1000).toISOString()
            : null,
        },
      });
      console.log(`[PlatformConnect] TikTok connected for userId ${pending.userId}`);
      res.redirect("/settings?connected=tiktok");
    } catch (err: any) {
      console.error("[PlatformConnect] TikTok callback error:", err.message);
      res.redirect("/settings?connect_error=tiktok_failed");
    }
  });

  // X / Twitter — OAuth2 with PKCE. offline.access grants a refresh token.
  app.get("/auth/twitter", async (req: any, res) => {
    try {
      if (!process.env.X_CLIENT_ID || !process.env.X_CLIENT_SECRET) {
        return res.redirect("/settings?connect_error=twitter_not_configured");
      }
      const userId = await sessionUserIntId(req);
      if (!userId) return res.redirect("/settings?connect_error=login_required");

      const state = crypto.randomBytes(16).toString("hex");
      const verifier = crypto.randomBytes(32).toString("base64url");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      req.session.twitterOauth = { state, verifier, userId };
      const params = new URLSearchParams({
        response_type: "code",
        client_id: process.env.X_CLIENT_ID,
        redirect_uri: `${BASE_URL}/auth/twitter/callback`,
        scope: "tweet.read tweet.write users.read media.write offline.access",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      res.redirect(`${X_AUTH_URL}?${params.toString()}`);
    } catch (err: any) {
      console.error("[PlatformConnect] twitter connect init error:", err.message);
      res.redirect("/settings?connect_error=twitter_failed");
    }
  });

  app.get("/auth/twitter/callback", async (req: any, res) => {
    try {
      const pending = req.session.twitterOauth;
      delete req.session.twitterOauth;
      if (!pending || req.query.state !== pending.state) {
        return res.redirect("/settings?connect_error=twitter_state_mismatch");
      }
      if (!req.query.code) return res.redirect("/settings?connect_error=twitter_denied");

      const tokenRes = await fetch(X_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": xBasicAuth(),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: String(req.query.code),
          redirect_uri: `${BASE_URL}/auth/twitter/callback`,
          code_verifier: pending.verifier,
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || !tokens.access_token) {
        console.error("[PlatformConnect] X token exchange failed:", JSON.stringify(tokens));
        return res.redirect("/settings?connect_error=twitter_token_exchange");
      }

      let accountId: string | null = null;
      let accountName: string | null = null;
      try {
        const meRes = await fetch("https://api.x.com/2/users/me", {
          headers: { "Authorization": `Bearer ${tokens.access_token}` },
        });
        const me = await meRes.json();
        accountId = me?.data?.id || null;
        accountName = me?.data?.username || null;
      } catch { /* ids are recoverable later; token is the critical part */ }

      await upsertProfile(pending.userId, "twitter", {
        accountName,
        accountId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        tokenExpiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
        metadata: {},
      });
      console.log(`[PlatformConnect] X connected for userId ${pending.userId} (@${accountName})`);
      res.redirect("/settings?connected=twitter");
    } catch (err: any) {
      console.error("[PlatformConnect] X callback error:", err.message);
      res.redirect("/settings?connect_error=twitter_failed");
    }
  });

  // LinkedIn — tokens last ~60 days; standard apps get no refresh token,
  // so on expiry the user reconnects (surfaced as a failed post with a
  // clear error until they do).
  app.get("/auth/linkedin", async (req: any, res) => {
    try {
      if (!process.env.LINKEDIN_CLIENT_ID || !process.env.LINKEDIN_CLIENT_SECRET) {
        return res.redirect("/settings?connect_error=linkedin_not_configured");
      }
      const userId = await sessionUserIntId(req);
      if (!userId) return res.redirect("/settings?connect_error=login_required");

      const state = crypto.randomBytes(16).toString("hex");
      req.session.linkedinOauth = { state, userId };
      const params = new URLSearchParams({
        response_type: "code",
        client_id: process.env.LINKEDIN_CLIENT_ID,
        redirect_uri: `${BASE_URL}/auth/linkedin/callback`,
        scope: "openid profile w_member_social",
        state,
      });
      res.redirect(`${LINKEDIN_AUTH_URL}?${params.toString()}`);
    } catch (err: any) {
      console.error("[PlatformConnect] linkedin connect init error:", err.message);
      res.redirect("/settings?connect_error=linkedin_failed");
    }
  });

  app.get("/auth/linkedin/callback", async (req: any, res) => {
    try {
      const pending = req.session.linkedinOauth;
      delete req.session.linkedinOauth;
      if (!pending || req.query.state !== pending.state) {
        return res.redirect("/settings?connect_error=linkedin_state_mismatch");
      }
      if (!req.query.code) return res.redirect("/settings?connect_error=linkedin_denied");

      const tokenRes = await fetch(LINKEDIN_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: String(req.query.code),
          redirect_uri: `${BASE_URL}/auth/linkedin/callback`,
          client_id: process.env.LINKEDIN_CLIENT_ID!,
          client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || !tokens.access_token) {
        console.error("[PlatformConnect] LinkedIn token exchange failed:", JSON.stringify(tokens));
        return res.redirect("/settings?connect_error=linkedin_token_exchange");
      }

      let accountId: string | null = null;
      let accountName: string | null = null;
      try {
        const infoRes = await fetch("https://api.linkedin.com/v2/userinfo", {
          headers: { "Authorization": `Bearer ${tokens.access_token}` },
        });
        const info = await infoRes.json();
        // `sub` is the member id — the LinkedIn adapter builds
        // urn:li:person:<accountId> from it.
        accountId = info?.sub || null;
        accountName = info?.name || null;
      } catch { /* non-fatal */ }

      if (!accountId) {
        return res.redirect("/settings?connect_error=linkedin_no_member_id");
      }

      await upsertProfile(pending.userId, "linkedin", {
        accountName,
        accountId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        tokenExpiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
        metadata: {},
      });
      console.log(`[PlatformConnect] LinkedIn connected for userId ${pending.userId} (${accountName})`);
      res.redirect("/settings?connected=linkedin");
    } catch (err: any) {
      console.error("[PlatformConnect] LinkedIn callback error:", err.message);
      res.redirect("/settings?connect_error=linkedin_failed");
    }
  });

  console.log("[PlatformConnect] Distribution OAuth routes registered (TikTok, X, LinkedIn)");
}
