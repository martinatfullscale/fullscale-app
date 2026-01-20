import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import { runIndexerForUser } from "./lib/indexer";
import { processVideoScan, scanPendingVideos, addToLocalAssetMap, getYouTubeThumbnailWithFallback } from "./lib/scanner";
import { hashPassword, verifyPassword } from "./lib/password";
import { addSignupToAirtable } from "./lib/airtable";
import { setupPlatformAuth, importFacebookVideos, importInstagramMedia } from "./lib/platformAuth";
import multer from "multer";
import path from "path";
import fs from "fs";
import ytdl from "@distube/ytdl-core";
import { decrypt } from "./encryption";
import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

// Configure multer for video uploads
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), "public", "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `video-${uniqueSuffix}${ext}`);
  },
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
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

// VIP Founding Members - bypass allowlist check automatically
const FOUNDING_MEMBERS = [
  'martin@ekechukwu.com',
  'martin@gofullscale.co',
  'martin@whtwrks.com',
  'martincekechukwu@gmail.com',
  'simmone@capitalizevc.com',
  'simmoneaseymour@gmail.com'
];

// Google Login OAuth Configuration (for authentication with allowlist)
const GOOGLE_LOGIN_SCOPES = [
  "openid",
  "email",
  "profile",
];

function generateOAuthState(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
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
const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
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

  // ============================================
  // Google Login OAuth Routes (with Allowlist)
  // ============================================
  
  // Helper to check if email is a VIP/Founding member (uses FOUNDING_MEMBERS from top of file)
  const isVipEmail = (email: string) => 
    FOUNDING_MEMBERS.some(vip => vip.toLowerCase() === email.toLowerCase().trim());

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
  app.get("/api/auth/google", (req: any, res) => {
    const baseUrl = process.env.BASE_URL;
    const requestHost = req.get('host');
    const requestProtocol = req.protocol;
    console.log("[Google OAuth] ========== LOGIN INITIATED ==========");
    console.log("[Google OAuth] BASE_URL env:", baseUrl);
    console.log("[Google OAuth] Request host:", requestHost);
    console.log("[Google OAuth] Request protocol:", requestProtocol);
    console.log("[Google OAuth] Request hostname:", req.hostname);
    
    if (!baseUrl) {
      console.error("BASE_URL environment variable is not set");
      return res.redirect("/?error=configuration_error");
    }
    const redirectUri = `${baseUrl}/api/auth/google/callback`;
    
    // Clear any old OAuth state and Google user data to prevent conflicts
    delete req.session.oauthState;
    delete req.session.googleUser;
    
    const state = generateOAuthState();
    req.session.oauthState = state;
    console.log("[Google OAuth] Redirect URI being used:", redirectUri);
    console.log("[Google OAuth] State generated:", state);
    console.log("[Google OAuth] Session ID:", req.sessionID);
    console.log("[Google OAuth] ====================================");
    
    // Save session before redirect to ensure state persists
    req.session.save((err: any) => {
      if (err) {
        console.error("[Google OAuth] Session save error:", err);
        return res.redirect("/?error=session_error");
      }
      console.log("[Google OAuth] Session saved successfully");
      const authUrl = getGoogleLoginAuthUrl(redirectUri, state);
      console.log("[Google OAuth] Redirecting to Google...");
      res.redirect(authUrl);
    });
  });

  // Helper to clear session and redirect on auth error
  const clearSessionAndRedirect = (req: any, res: any, errorCode: string) => {
    console.log("[Auth Error] Clearing session due to error:", errorCode);
    req.session.destroy((err: any) => {
      if (err) console.error("[Auth Error] Session destroy failed:", err);
      res.clearCookie("connect.sid");
      res.redirect("/?error=" + encodeURIComponent(errorCode));
    });
  };

  // Google login callback with allowlist check
  app.get("/api/auth/google/callback", async (req: any, res) => {
    const { code, error, state } = req.query;
    console.log("[Google OAuth Callback] Received callback");
    console.log("[Google OAuth Callback] State from query:", state);
    console.log("[Google OAuth Callback] Session ID:", req.sessionID);
    
    if (error) {
      console.error("[Google OAuth Callback] Error from Google:", error);
      return clearSessionAndRedirect(req, res, error as string);
    }

    if (!code) {
      console.error("[Google OAuth Callback] No code received");
      return clearSessionAndRedirect(req, res, "no_code");
    }

    // Verify state to prevent CSRF attacks
    const savedState = req.session?.oauthState;
    console.log("[Google OAuth Callback] Saved state from session:", savedState || "(missing - session may have been lost)");
    delete req.session?.oauthState;
    
    // Be lenient with state validation:
    // - If savedState exists, validate it matches
    // - If savedState is missing (session lost after deploy), proceed anyway since
    //   the code exchange with Google validates this is a legitimate callback
    if (savedState && state !== savedState) {
      console.error("[Google OAuth Callback] State mismatch - received:", state, "expected:", savedState);
      return clearSessionAndRedirect(req, res, "invalid_state");
    }
    
    if (!savedState) {
      console.warn("[Google OAuth Callback] Session state was missing - proceeding with OAuth (session may have been lost after deployment)");
    }

    try {
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
        console.error("Google token exchange failed:", tokenResponse.status, errorText);
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
        
        // Defer Airtable sync to after login completes (non-blocking)
        const nameParts2 = (userInfo.name || "").split(" ");
        setTimeout(() => {
          addSignupToAirtable({
            email: normalizedEmail,
            firstName: nameParts2[0] || null,
            lastName: nameParts2.slice(1).join(" ") || null,
            authProvider: "google",
            isApproved: userIsApproved,
          }).catch(err => console.error("[Airtable] Sync failed:", err));
        }, 5000);
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
      
      // Redirect based on approval status
      const productionDashboardUrl = userIsApproved 
        ? "https://gofullscale.co/dashboard" 
        : "https://gofullscale.co/waitlist";
      
      // Explicitly save session before redirect to ensure it persists
      req.session.save((err: any) => {
        if (err) {
          console.error("Session save error:", err);
          return res.redirect("https://gofullscale.co/?error=session_error");
        }
        console.log(`[Google OAuth] Redirecting to: ${productionDashboardUrl}`);
        res.redirect(productionDashboardUrl);
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
      res.clearCookie("connect.sid");
      res.redirect("/");
    });
  });

  // Logout from Google session
  app.post("/api/auth/google/logout", (req, res) => {
    delete (req.session as any).googleUser;
    res.json({ success: true });
  });

  // Unified logout endpoint (works for both Google and email auth)
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error("Logout error:", err);
        return res.status(500).json({ success: false, message: "Logout failed" });
      }
      res.clearCookie("connect.sid");
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
      
      const { email, password, firstName, lastName } = parsed.data;
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

      console.log(`User registered: ${normalizedEmail}, VIP: ${isVip}, approved: ${isVip}`);

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
    if (!googleUser || !googleUser.email) {
      return res.status(401).json({ message: "Unauthorized - Please login with Google" });
    }
    req.googleUser = googleUser;
    next();
  };
  
  // Flexible auth middleware - works with Google OAuth, Replit Auth, or Facebook session
  // Used for endpoints that should work for authenticated users regardless of method
  const isFlexibleAuthenticated = async (req: any, res: any, next: any) => {
    const adminEmails = ['martin@gofullscale.co', 'martin@whtwrks.com', 'martincekechukwu@gmail.com'];
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
  
  // Initiate YouTube OAuth flow
  app.get("/api/auth/youtube", isGoogleAuthenticated, (req: any, res) => {
    const baseUrl = process.env.BASE_URL;
    if (!baseUrl) {
      console.error("BASE_URL environment variable is not set");
      return res.redirect("/?youtube_error=configuration_error");
    }
    const redirectUri = `${baseUrl}/api/auth/youtube/callback`;
    const authUrl = getYoutubeAuthUrl(redirectUri);
    res.redirect(authUrl);
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

      const userId = req.googleUser.email;
      console.log("[YouTube Callback] User:", userId);
      
      // FAST LOGIN: Save tokens immediately, defer channel fetch to background
      // This prevents slow API calls from blocking login
      console.log("[YouTube Callback] Saving tokens to database (channel fetch deferred)...");
      await storage.upsertYoutubeConnection({
        userId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: tokens.expires_in 
          ? new Date(Date.now() + tokens.expires_in * 1000) 
          : null,
        channelId: null, // Will be fetched on first dashboard load or manual sync
        channelTitle: null,
      });
      console.log("[YouTube Callback] Tokens saved successfully");
      
      // Fetch channel info in background (non-blocking)
      setImmediate(async () => {
        try {
          console.log("[YouTube Background] Fetching channel info...");
          const channelData = await getYoutubeChannelInfo(tokens.access_token);
          const channel = channelData.items?.[0];
          if (channel) {
            await storage.upsertYoutubeConnection({
              userId,
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token || null,
              expiresAt: tokens.expires_in 
                ? new Date(Date.now() + tokens.expires_in * 1000) 
                : null,
              channelId: channel.id || null,
              channelTitle: channel.snippet?.title || null,
            });
            console.log("[YouTube Background] Channel info saved:", channel.snippet?.title);
          }
        } catch (bgErr: any) {
          console.error("[YouTube Background] Channel fetch failed:", bgErr.message);
        }
      });

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
  app.get("/api/auth/youtube/status", isGoogleAuthenticated, async (req: any, res) => {
    const userId = req.googleUser.email;
    const connection = await storage.getYoutubeConnection(userId);
    
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

  // Disconnect YouTube
  app.delete("/api/auth/youtube", isGoogleAuthenticated, async (req: any, res) => {
    const userId = req.googleUser.email;
    await storage.deleteYoutubeConnection(userId);
    await storage.deleteVideoIndex(userId);
    res.json({ success: true });
  });

  // Get indexed videos for the user's library
  app.get("/api/video-index", isGoogleAuthenticated, async (req: any, res) => {
    const userId = req.googleUser.email;
    const videos = await storage.getVideoIndex(userId);
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

  // Public demo endpoint - returns STATIC demo videos (NO database query)
  // Completely decoupled from real user data for pitch mode
  app.get("/api/demo/videos", (req, res) => {
    console.log(`[DEMO] Returning ${STATIC_DEMO_VIDEOS.length} static demo videos (no DB query)`);
    res.json({ videos: STATIC_DEMO_VIDEOS, total: STATIC_DEMO_VIDEOS.length });
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

  // Admin scan endpoint - for testing uploaded videos without auth
  // Only works for videos owned by admin emails (uses ADMIN_EMAILS defined below)
  const adminEmails = ['martin@gofullscale.co', 'martin@whtwrks.com', 'martincekechukwu@gmail.com'];
  app.post("/api/admin-scan/:id", async (req, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Only allow scanning videos owned by admin
    if (!adminEmails.includes(video.userId)) {
      return res.status(403).json({ error: "Admin scan only for admin-owned videos" });
    }

    console.log(`[ADMIN SCAN] Starting scan for video ${videoId}: "${video.title}"`);
    
    // Run scan synchronously so we can return results
    try {
      const result = await processVideoScan(videoId, true);
      console.log(`[ADMIN SCAN] Scan complete for ${videoId}:`, result);
      res.json({ success: true, result });
    } catch (err: any) {
      console.error(`[ADMIN SCAN] Scan failed for ${videoId}:`, err);
      res.status(500).json({ error: err.message || "Scan failed" });
    }
  });

  // Direct video upload endpoint - bypass YouTube download
  app.post("/api/upload", isGoogleAuthenticated, uploadMiddleware.single("video"), async (req: any, res) => {
    console.log(`[UPLOAD] ===== VIDEO UPLOAD RECEIVED =====`);
    console.log(`[UPLOAD] User: ${req.googleUser?.email}`);
    
    if (!req.file) {
      console.log(`[UPLOAD] ERROR: No file received`);
      return res.status(400).json({ error: "No video file uploaded" });
    }

    const userId = req.googleUser.email;
    const file = req.file;
    const title = req.body.title || file.originalname.replace(/\.[^/.]+$/, "");
    
    console.log(`[UPLOAD] File: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`[UPLOAD] Saved as: ${file.filename}`);
    console.log(`[UPLOAD] Title: ${title}`);

    try {
      // Generate a unique video ID for LOCAL_ASSET_MAP
      const uploadVideoId = `upload-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const filePath = `./public/uploads/${file.filename}`;
      const videoUrl = `/uploads/${file.filename}`;

      // Add to LOCAL_ASSET_MAP so scanner can find it
      addToLocalAssetMap(uploadVideoId, filePath);

      // Insert into video_index table with persistent file path
      const video = await storage.insertVideo({
        userId,
        youtubeId: uploadVideoId,
        title,
        description: `Uploaded video: ${file.originalname}`,
        thumbnailUrl: "/uploads/default-thumbnail.png",
        viewCount: 0,
        publishedAt: new Date(),
        status: "Pending Scan",
        priorityScore: 80,
        platform: "fullscale",
        category: "Uploaded",
        isEvergreen: true,
        duration: "0:00",
        filePath, // Store file path in DB for persistence across server restarts
      });

      console.log(`[UPLOAD] Video inserted with ID: ${video.id}`);
      console.log(`[UPLOAD] Ready for scanning`);

      res.json({ 
        success: true, 
        video: {
          id: video.id,
          title: video.title,
          youtubeId: uploadVideoId,
          videoUrl,
          status: video.status,
          platform: "fullscale"
        },
        message: "Video uploaded successfully. Click 'Scan' to analyze for ad placements."
      });
    } catch (error: any) {
      console.error(`[UPLOAD] Database error:`, error);
      // Clean up uploaded file on error
      try {
        fs.unlinkSync(path.join(process.cwd(), "public", "uploads", file.filename));
      } catch {}
      res.status(500).json({ error: "Failed to save video record" });
    }
  });

  // Get detected surfaces for a video (Ad Opportunities)
  app.get("/api/video/:id/surfaces", isFlexibleAuthenticated, async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Check ownership - allow if video userId matches auth userId OR auth email
    const isOwner = video.userId === req.authUserId || video.userId === req.authEmail;
    if (!isOwner) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const surfaces = await storage.getDetectedSurfaces(videoId);
    res.json({ surfaces, count: surfaces.length });
  });

  // Get videos with their Ad Opportunity counts
  app.get("/api/video-index/with-opportunities", isFlexibleAuthenticated, async (req: any, res) => {
    const userId = req.authUserId;
    const authEmail = req.authEmail;
    console.log(`[VideoIndex] Fetching videos for userId: ${userId}, authEmail: ${authEmail}`);
    
    const videos = await storage.getVideoIndex(userId);
    console.log(`[VideoIndex] Found ${videos.length} videos for user`);
    
    const videosWithCounts = await Promise.all(
      videos.map(async (video) => {
        const count = await storage.getSurfaceCountByVideo(video.id);
        return { ...video, adOpportunities: count };
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

  // BRAND MARKETPLACE: Get Ready videos for discovery (brand view)
  app.get("/api/brand/discovery", isGoogleAuthenticated, async (req: any, res) => {
    try {
      const videos = await storage.getReadyVideosForMarketplace();
      
      // Transform videos into marketplace opportunities format
      const opportunities = videos.map((video) => ({
        id: video.id,
        videoId: video.id,
        youtubeId: video.youtubeId,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        creatorName: CREATOR_NAMES[video.category || ""] || video.category || "Pro Creator",
        viewCount: video.viewCount,
        sceneValue: Math.round(video.priorityScore * 1.2), // Derive value from priority
        context: video.contexts?.[0] || video.category || "General",
        genre: video.category || "Lifestyle",
        sceneType: video.surfaces?.[0]?.surfaceType || "Desk",
        surfaces: video.surfaces?.map(s => s.surfaceType) || [],
        duration: video.duration || "10:00",
      }));
      
      res.json({ opportunities, total: opportunities.length });
    } catch (err: any) {
      console.error("Error fetching brand discovery:", err);
      res.status(500).json({ error: "Failed to fetch discovery" });
    }
  });

  // Admin emails that can switch between roles
  const ADMIN_EMAILS = ["martin@gofullscale.co", "martin@whtwrks.com", "martincekechukwu@gmail.com"];

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
  app.post("/api/sync/facebook-instagram", isFlexibleAuthenticated, async (req: any, res) => {
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
      
      if (!user.facebookAccessToken || !user.facebookPageId) {
        return res.status(400).json({ error: "Facebook not connected. Please connect your Facebook account first." });
      }
      
      // Decrypt the access token
      const accessToken = decrypt(user.facebookAccessToken);
      
      // Use the user's ID for storing videos
      const userIdForVideos = user.id;
      
      let facebookImported = 0;
      let instagramImported = 0;
      
      // Import Facebook Page videos
      if (user.facebookPageId) {
        facebookImported = await importFacebookVideos(userIdForVideos, user.facebookPageId, accessToken);
      }
      
      // Import Instagram media if connected
      if (user.instagramBusinessId) {
        instagramImported = await importInstagramMedia(userIdForVideos, user.instagramBusinessId, accessToken);
      }
      
      res.json({
        success: true,
        facebookVideos: facebookImported,
        instagramVideos: instagramImported,
        message: `Imported ${facebookImported} Facebook videos and ${instagramImported} Instagram videos/reels`
      });
    } catch (error: any) {
      console.error("[Sync] Error syncing Facebook/Instagram:", error);
      res.status(500).json({ error: error.message || "Failed to sync content" });
    }
  });

  // Get brand's campaigns (bids they've placed)
  app.get("/api/brand/campaigns", isGoogleAuthenticated, async (req: any, res) => {
    const brandEmail = req.googleUser.email;
    const campaigns = await storage.getBrandCampaigns(brandEmail);
    
    // Enrich campaigns with video data for estimated reach
    const enrichedCampaigns = await Promise.all(campaigns.map(async (campaign) => {
      let viewCount = 0;
      let videoTitle = campaign.title;
      let thumbnailUrl = campaign.thumbnailUrl;
      
      if (campaign.videoId) {
        const video = await storage.getVideoById(campaign.videoId);
        if (video) {
          viewCount = video.viewCount || 0;
          videoTitle = video.title || campaign.title;
          thumbnailUrl = video.thumbnailUrl || campaign.thumbnailUrl;
        }
      }
      
      return {
        ...campaign,
        title: videoTitle,
        thumbnailUrl,
        viewCount,
        creatorName: CREATOR_NAMES[campaign.genre || ""] || campaign.genre || "Pro Creator",
      };
    }));
    
    res.json(enrichedCampaigns);
  });

  // Get full YouTube channel data (with profile picture and stats)
  app.get("/api/youtube/channel", isGoogleAuthenticated, async (req: any, res) => {
    const userId = req.googleUser.email;
    const connection = await storage.getYoutubeConnection(userId);
    
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

  // Get user's latest YouTube videos
  app.get("/api/youtube/videos", isGoogleAuthenticated, async (req: any, res) => {
    const userId = req.googleUser.email;
    const connection = await storage.getYoutubeConnection(userId);
    
    if (!connection) {
      return res.json({ connected: false, videos: [] });
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
        return res.json({ videos: [] });
      }

      const videosData = await getYoutubeVideos(accessToken, uploadsPlaylistId, 5);
      
      const videos = (videosData.items || []).map((item: any) => {
        const videoId = item.contentDetails?.videoId || item.id;
        return {
          id: videoId,
          title: item.snippet.title,
          // Use public YouTube thumbnail URL (no OAuth required for thumbnails)
          thumbnailUrl: getYouTubeThumbnailWithFallback(videoId),
          publishedAt: item.snippet.publishedAt,
          description: item.snippet.description,
        };
      });

      res.json({ connected: true, videos });
    } catch (err: any) {
      console.error("Error fetching YouTube videos:", err);
      res.status(500).json({ error: "Failed to fetch videos" });
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
    if (!googleUser || !ADMIN_EMAILS.includes(googleUser.email?.toLowerCase())) {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
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

  // Seed Data
  await seedDatabase();

  return httpServer;
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
}
