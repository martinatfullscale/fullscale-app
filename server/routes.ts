import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import { runIndexerForUser } from "./lib/indexer";
import { processVideoScan, scanPendingVideos } from "./lib/scanner";

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
  
  // Setup Replit Auth (MUST be before other routes if you want to protect them globaly, but usually fine here)
  await setupAuth(app);
  registerAuthRoutes(app);

  // ============================================
  // Google Login OAuth Routes (with Allowlist)
  // ============================================
  
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
    console.log("[Google OAuth] Initiating login, BASE_URL:", baseUrl);
    if (!baseUrl) {
      console.error("BASE_URL environment variable is not set");
      return res.redirect("/?error=configuration_error");
    }
    const redirectUri = `${baseUrl}/api/auth/callback/google`;
    const state = generateOAuthState();
    (req.session as any).oauthState = state;
    console.log("[Google OAuth] Redirect URI:", redirectUri);
    console.log("[Google OAuth] State generated:", state);
    
    // Save session before redirect to ensure state persists
    req.session.save((err: any) => {
      if (err) {
        console.error("[Google OAuth] Session save error:", err);
        return res.redirect("/?error=session_error");
      }
      const authUrl = getGoogleLoginAuthUrl(redirectUri, state);
      console.log("[Google OAuth] Redirecting to Google...");
      res.redirect(authUrl);
    });
  });

  // Google login callback with allowlist check
  app.get("/api/auth/callback/google", async (req: any, res) => {
    const { code, error, state } = req.query;
    console.log("[Google OAuth Callback] Received callback");
    console.log("[Google OAuth Callback] State from query:", state);
    console.log("[Google OAuth Callback] Session ID:", req.sessionID);
    
    if (error) {
      console.error("[Google OAuth Callback] Error:", error);
      return res.redirect("/?error=" + encodeURIComponent(error as string));
    }

    if (!code) {
      console.error("[Google OAuth Callback] No code received");
      return res.redirect("/?error=no_code");
    }

    // Verify state to prevent CSRF attacks
    const savedState = req.session?.oauthState;
    console.log("[Google OAuth Callback] Saved state from session:", savedState);
    delete req.session?.oauthState;
    
    if (!state || state !== savedState) {
      console.error("[Google OAuth Callback] State mismatch - received:", state, "expected:", savedState);
      return res.redirect("/?error=invalid_state");
    }

    try {
      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        console.error("BASE_URL environment variable is not set");
        return res.redirect("/?error=configuration_error");
      }
      const redirectUri = `${baseUrl}/api/auth/callback/google`;
      
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
      const userInfo = await getGoogleUserInfo(tokens.access_token);
      
      if (!userInfo || !userInfo.email) {
        console.error("Failed to get user info from Google");
        return res.redirect("/?error=failed_to_get_user_info");
      }

      // Check if user is in allowlist
      const isAllowed = await storage.isEmailAllowed(userInfo.email);
      
      if (!isAllowed) {
        console.log(`Access denied for email: ${userInfo.email}`);
        return res.redirect("/?error=access_restricted&email=" + encodeURIComponent(userInfo.email));
      }
      
      // If user is on allowlist but has no role, default to creator
      const allowedUser = await storage.getAllowedUser(userInfo.email);
      if (allowedUser && !allowedUser.userType) {
        await storage.updateAllowedUserRole(userInfo.email, "creator");
        console.log(`Assigned default creator role to: ${userInfo.email}`);
      }

      // User is allowed - set session and redirect to dashboard
      (req.session as any).googleUser = {
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
      };
      
      console.log(`Access granted for: ${userInfo.email}`);
      
      // Always redirect to production domain to avoid replit.dev session issues
      const productionDashboardUrl = "https://gofullscale.co/dashboard";
      
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
      res.redirect("https://gofullscale.co/?error=login_failed");
    }
  });

  // Logout from Google session
  app.post("/api/auth/google/logout", (req, res) => {
    delete (req.session as any).googleUser;
    res.json({ success: true });
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
    const { code, error } = req.query;
    
    if (error) {
      console.error("YouTube OAuth error:", error);
      return res.redirect("/dashboard?youtube_error=" + encodeURIComponent(error as string));
    }

    if (!code) {
      return res.redirect("/dashboard?youtube_error=no_code");
    }

    try {
      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        console.error("BASE_URL environment variable is not set");
        return res.redirect("/dashboard?youtube_error=configuration_error");
      }
      const redirectUri = `${baseUrl}/api/auth/youtube/callback`;
      
      // Exchange code for tokens
      let tokens;
      try {
        tokens = await exchangeCodeForTokens(code as string, redirectUri);
      } catch (exchangeErr: any) {
        console.error("Token exchange failed:", exchangeErr.message);
        return res.redirect("/dashboard?youtube_error=token_exchange_failed");
      }
      
      if (tokens.error) {
        console.error("Token exchange returned error:", tokens.error, tokens.error_description);
        return res.redirect("/dashboard?youtube_error=" + encodeURIComponent(tokens.error_description || tokens.error));
      }

      // Get channel info
      const channelData = await getYoutubeChannelInfo(tokens.access_token);
      const channel = channelData.items?.[0];

      const userId = req.googleUser.email;
      
      // Save the connection
      await storage.upsertYoutubeConnection({
        userId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: tokens.expires_in 
          ? new Date(Date.now() + tokens.expires_in * 1000) 
          : null,
        channelId: channel?.id || null,
        channelTitle: channel?.snippet?.title || null,
      });

      // Trigger video indexer asynchronously (don't block the redirect)
      setImmediate(async () => {
        try {
          console.log(`[OAuth] Triggering video indexer for user: ${userId}`);
          const result = await runIndexerForUser(userId);
          console.log(`[OAuth] Indexer completed: indexed ${result.indexed}, filtered ${result.filtered}`);
        } catch (indexerError: any) {
          console.error(`[OAuth] Indexer failed:`, indexerError.message || indexerError);
        }
      });

      // Redirect to dashboard with success flag
      res.redirect("/dashboard?youtube_connected=true");
    } catch (err: any) {
      console.error("YouTube callback error:", err.message || err);
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

  // Hardcoded fallback videos for demo mode (never returns empty)
  // All videos point to local hero_video.mp4 for playable content
  const FALLBACK_DEMO_VIDEOS = [
    { id: 1001, userId: "demo-creator", youtubeId: "demo-fallback-1", title: "Desk Setup 2026", description: "The ultimate workspace setup for productivity.", viewCount: 1250000, thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 95, publishedAt: "2025-12-01T10:00:00Z", category: "Tech", isEvergreen: true, duration: "12:34", adOpportunities: 4, surfaceCount: 4 },
    { id: 1002, userId: "demo-creator", youtubeId: "demo-fallback-2", title: "My Morning Routine", description: "Start your day right with this productive morning routine.", viewCount: 890000, thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 78, publishedAt: "2025-11-15T08:00:00Z", category: "Lifestyle", isEvergreen: true, duration: "8:45", adOpportunities: 3, surfaceCount: 3 },
    { id: 1003, userId: "demo-creator", youtubeId: "demo-fallback-3", title: "Dream Gaming Setup", description: "Building the ultimate gaming battlestation.", viewCount: 2100000, thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 92, publishedAt: "2025-10-20T15:00:00Z", category: "Gaming", isEvergreen: true, duration: "15:22", adOpportunities: 5, surfaceCount: 5 },
    { id: 1004, userId: "demo-creator", youtubeId: "demo-fallback-4", title: "Home Office Makeover", description: "Transform your home office on a budget.", viewCount: 675000, thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 65, publishedAt: "2025-09-10T12:00:00Z", category: "DIY", isEvergreen: true, duration: "10:15", adOpportunities: 3, surfaceCount: 3 },
    { id: 1005, userId: "demo-creator", youtubeId: "demo-fallback-5", title: "Tech Gadgets Unboxing", description: "Unboxing the latest and greatest tech gadgets.", viewCount: 1450000, thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 88, publishedAt: "2025-08-25T14:00:00Z", category: "Tech", isEvergreen: false, duration: "18:30", adOpportunities: 4, surfaceCount: 4 },
    { id: 1006, userId: "demo-creator", youtubeId: "demo-fallback-6", title: "Cozy Reading Nook", description: "Creating the perfect reading corner.", viewCount: 320000, thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 55, publishedAt: "2025-07-18T09:00:00Z", category: "Lifestyle", isEvergreen: true, duration: "6:30", adOpportunities: 2, surfaceCount: 2 },
    { id: 1007, userId: "demo-creator", youtubeId: "demo-fallback-7", title: "Studio Tour 2026", description: "A complete tour of my creative studio.", viewCount: 540000, thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 72, publishedAt: "2025-06-22T11:00:00Z", category: "Vlog", isEvergreen: true, duration: "14:17", adOpportunities: 4, surfaceCount: 4 },
    { id: 1008, userId: "demo-creator", youtubeId: "demo-fallback-8", title: "Productivity Apps Review", description: "My top productivity apps for 2026.", viewCount: 410000, thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 68, publishedAt: "2025-05-30T16:00:00Z", category: "Productivity", isEvergreen: false, duration: "11:45", adOpportunities: 3, surfaceCount: 3 },
    { id: 1009, userId: "demo-creator", youtubeId: "demo-fallback-9", title: "MacBook Pro M5 Review", description: "Is the M5 worth the upgrade?", viewCount: 980000, thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 85, publishedAt: "2025-04-15T10:00:00Z", category: "Tech", isEvergreen: true, duration: "16:42", adOpportunities: 4, surfaceCount: 4 },
    { id: 1010, userId: "demo-creator", youtubeId: "demo-fallback-10", title: "Minimalist Living Room", description: "How I transformed my living space.", viewCount: 275000, thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 52, publishedAt: "2025-03-28T13:00:00Z", category: "Lifestyle", isEvergreen: true, duration: "9:18", adOpportunities: 2, surfaceCount: 2 },
    { id: 1011, userId: "demo-creator", youtubeId: "demo-fallback-11", title: "iPhone 17 First Impressions", description: "My first 24 hours with the new iPhone.", viewCount: 1680000, thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 91, publishedAt: "2025-02-20T08:00:00Z", category: "Tech", isEvergreen: false, duration: "13:55", adOpportunities: 4, surfaceCount: 4 },
    { id: 1012, userId: "demo-creator", youtubeId: "demo-fallback-12", title: "Budget Desk Accessories", description: "The best desk accessories under $50.", viewCount: 520000, thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 63, publishedAt: "2025-01-12T14:00:00Z", category: "Tech", isEvergreen: true, duration: "11:20", adOpportunities: 3, surfaceCount: 3 },
    { id: 1013, userId: "demo-creator", youtubeId: "demo-fallback-13", title: "Work From Home Tips", description: "Maximize your productivity working from home.", viewCount: 445000, thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 70, publishedAt: "2024-12-08T10:00:00Z", category: "Productivity", isEvergreen: true, duration: "8:33", adOpportunities: 3, surfaceCount: 3 },
    { id: 1014, userId: "demo-creator", youtubeId: "demo-fallback-14", title: "Content Creator Setup", description: "Everything you need to start creating.", viewCount: 710000, thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 77, publishedAt: "2024-11-25T15:00:00Z", category: "Tech", isEvergreen: true, duration: "14:48", adOpportunities: 5, surfaceCount: 5 },
    { id: 1015, userId: "demo-creator", youtubeId: "demo-fallback-15", title: "Aesthetic Room Decor", description: "Creating an aesthetic room on a budget.", viewCount: 390000, thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 58, publishedAt: "2024-10-18T09:00:00Z", category: "Lifestyle", isEvergreen: true, duration: "7:22", adOpportunities: 2, surfaceCount: 2 },
    { id: 1016, userId: "demo-creator", youtubeId: "demo-fallback-16", title: "Standing Desk Review", description: "Is a standing desk worth it?", viewCount: 285000, thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 54, publishedAt: "2024-09-05T11:00:00Z", category: "Productivity", isEvergreen: true, duration: "10:05", adOpportunities: 3, surfaceCount: 3 },
    { id: 1017, userId: "demo-creator", youtubeId: "demo-fallback-17", title: "Cable Management Guide", description: "The ultimate guide to cable management.", viewCount: 620000, thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 74, publishedAt: "2024-08-22T13:00:00Z", category: "DIY", isEvergreen: true, duration: "12:38", adOpportunities: 3, surfaceCount: 3 },
    { id: 1018, userId: "demo-creator", youtubeId: "demo-fallback-18", title: "Mechanical Keyboard Guide", description: "Finding your perfect mechanical keyboard.", viewCount: 830000, thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 82, publishedAt: "2024-07-15T10:00:00Z", category: "Tech", isEvergreen: true, duration: "15:10", adOpportunities: 4, surfaceCount: 4 },
    { id: 1019, userId: "demo-creator", youtubeId: "demo-fallback-19", title: "Monitor Buying Guide", description: "How to choose the right monitor.", viewCount: 490000, thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 67, publishedAt: "2024-06-28T14:00:00Z", category: "Tech", isEvergreen: true, duration: "13:25", adOpportunities: 3, surfaceCount: 3 },
    { id: 1020, userId: "demo-creator", youtubeId: "demo-fallback-20", title: "Day in My Life", description: "A typical day as a content creator.", viewCount: 560000, thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", videoUrl: "/hero_video.mp4", status: "Scan Complete", priorityScore: 61, publishedAt: "2024-05-10T08:00:00Z", category: "Vlog", isEvergreen: false, duration: "10:50", adOpportunities: 4, surfaceCount: 4 },
  ];

  // Public demo endpoint - returns ALL videos for pitch/demo mode (no auth required)
  app.get("/api/demo/videos", async (req, res) => {
    try {
      const videos = await storage.getAllVideos();
      const videosWithCounts = await Promise.all(
        videos.map(async (video) => {
          const count = await storage.getSurfaceCountByVideo(video.id);
          return { ...video, adOpportunities: count };
        })
      );
      
      // FALLBACK: If fewer than 5 videos in DB, return hardcoded fallback
      if (videosWithCounts.length < 5) {
        console.log(`[DEMO] DB has ${videosWithCounts.length} videos, returning fallback data`);
        res.json({ videos: FALLBACK_DEMO_VIDEOS, total: FALLBACK_DEMO_VIDEOS.length });
        return;
      }
      
      res.json({ videos: videosWithCounts, total: videosWithCounts.length });
    } catch (err) {
      console.error("Error fetching demo videos, returning fallback:", err);
      res.json({ videos: FALLBACK_DEMO_VIDEOS, total: FALLBACK_DEMO_VIDEOS.length });
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

  // Trigger Cloud Scan for a specific video
  app.post("/api/video-scan/:id", isGoogleAuthenticated, async (req: any, res) => {
    console.log(`[BACKEND] ===== SCAN REQUEST RECEIVED =====`);
    console.log(`[BACKEND] Video ID from URL: ${req.params.id}`);
    console.log(`[BACKEND] User: ${req.googleUser?.email || 'unknown'}`);
    
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

    if (video.userId !== req.googleUser.email) {
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
  app.post("/api/video-scan/batch", isGoogleAuthenticated, async (req: any, res) => {
    const userId = req.googleUser.email;
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

  // Get detected surfaces for a video (Ad Opportunities)
  app.get("/api/video/:id/surfaces", isGoogleAuthenticated, async (req: any, res) => {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) {
      return res.status(400).json({ error: "Invalid video ID" });
    }

    const video = await storage.getVideoById(videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    if (video.userId !== req.googleUser.email) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const surfaces = await storage.getDetectedSurfaces(videoId);
    res.json({ surfaces, count: surfaces.length });
  });

  // Get videos with their Ad Opportunity counts
  app.get("/api/video-index/with-opportunities", isGoogleAuthenticated, async (req: any, res) => {
    const userId = req.googleUser.email;
    const videos = await storage.getVideoIndex(userId);
    
    const videosWithCounts = await Promise.all(
      videos.map(async (video) => {
        const count = await storage.getSurfaceCountByVideo(video.id);
        return { ...video, adOpportunities: count };
      })
    );

    res.json({ videos: videosWithCounts, total: videosWithCounts.length });
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

  // Hardcoded fallback campaigns for demo mode (never returns empty)
  const FALLBACK_DEMO_CAMPAIGNS = [
    { id: 2001, videoId: 1001, youtubeId: "demo-fallback-1", title: "Tech Review Series", thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", creatorName: "TechVision", viewCount: 1250000, sceneValue: 85, context: "Tech", genre: "Tech", sceneType: "Desk", surfaces: ["Monitor", "Desk", "Wall"], surfaceCount: 3, duration: "12:34", brand: "Sony", budget: 5000, status: "Active", category: "Tech" },
    { id: 2002, videoId: 1002, youtubeId: "demo-fallback-2", title: "Morning Routine Vlog", thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", creatorName: "LifestyleMax", viewCount: 890000, sceneValue: 65, context: "Lifestyle", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Table", "Shelf", "Counter"], surfaceCount: 3, duration: "8:45", brand: "Nespresso", budget: 3500, status: "Active", category: "Lifestyle" },
    { id: 2003, videoId: 1003, youtubeId: "demo-fallback-3", title: "Gaming Setup Showcase", thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", creatorName: "GamerzHQ", viewCount: 2100000, sceneValue: 120, context: "Gaming", genre: "Gaming", sceneType: "Desk", surfaces: ["Monitor", "Desk", "RGB Wall"], surfaceCount: 3, duration: "15:22", brand: "Razer", budget: 8000, status: "Active", category: "Gaming" },
    { id: 2004, videoId: 1004, youtubeId: "demo-fallback-4", title: "Home Office Tour", thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", creatorName: "DIYCreative", viewCount: 675000, sceneValue: 55, context: "Office", genre: "DIY", sceneType: "Wall", surfaces: ["Wall", "Desk", "Bookshelf"], surfaceCount: 3, duration: "10:15", brand: "IKEA", budget: 2500, status: "Active", category: "DIY" },
    { id: 2005, videoId: 1005, youtubeId: "demo-fallback-5", title: "Tech Unboxing Session", thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", creatorName: "UnboxDaily", viewCount: 1450000, sceneValue: 95, context: "Product", genre: "Tech", sceneType: "Product", surfaces: ["Table", "Product", "Hands"], surfaceCount: 3, duration: "18:30", brand: "Samsung", budget: 6000, status: "Active", category: "Tech" },
    { id: 2006, videoId: 1006, youtubeId: "demo-fallback-6", title: "Cozy Reading Corner", thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", creatorName: "BookishVibes", viewCount: 320000, sceneValue: 45, context: "Lifestyle", genre: "Books", sceneType: "Interior", surfaces: ["Bookshelf", "Chair", "Lamp"], surfaceCount: 3, duration: "6:30", brand: "Amazon Kindle", budget: 2000, status: "Active", category: "Lifestyle" },
    { id: 2007, videoId: 1007, youtubeId: "demo-fallback-7", title: "Creative Studio Setup", thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", creatorName: "StudioCraft", viewCount: 540000, sceneValue: 72, context: "Creative", genre: "Vlog", sceneType: "Desk", surfaces: ["Monitor", "Camera", "Lighting"], surfaceCount: 3, duration: "14:17", brand: "Adobe", budget: 4500, status: "Active", category: "Creative" },
    { id: 2008, videoId: 1008, youtubeId: "demo-fallback-8", title: "Productivity App Showcase", thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", creatorName: "ProductivityPro", viewCount: 410000, sceneValue: 68, context: "Productivity", genre: "Productivity", sceneType: "Screen", surfaces: ["Monitor", "Phone", "Tablet"], surfaceCount: 3, duration: "11:45", brand: "Notion", budget: 3000, status: "Active", category: "Productivity" },
    { id: 2009, videoId: 1009, youtubeId: "demo-fallback-9", title: "MacBook Deep Dive", thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", creatorName: "TechInsider", viewCount: 980000, sceneValue: 85, context: "Tech", genre: "Tech", sceneType: "Product", surfaces: ["Laptop", "Desk", "Accessories"], surfaceCount: 3, duration: "16:42", brand: "Apple", budget: 7500, status: "Active", category: "Tech" },
    { id: 2010, videoId: 1010, youtubeId: "demo-fallback-10", title: "Minimalist Home Tour", thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", creatorName: "MinimalVibes", viewCount: 275000, sceneValue: 52, context: "Lifestyle", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Wall", "Furniture", "Decor"], surfaceCount: 3, duration: "9:18", brand: "West Elm", budget: 2200, status: "Active", category: "Lifestyle" },
    { id: 2011, videoId: 1011, youtubeId: "demo-fallback-11", title: "iPhone Review Special", thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", creatorName: "PhoneGeek", viewCount: 1680000, sceneValue: 91, context: "Tech", genre: "Tech", sceneType: "Product", surfaces: ["Phone", "Table", "Accessories"], surfaceCount: 3, duration: "13:55", brand: "Apple", budget: 8500, status: "Active", category: "Tech" },
    { id: 2012, videoId: 1012, youtubeId: "demo-fallback-12", title: "Budget Tech Accessories", thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", creatorName: "BudgetTech", viewCount: 520000, sceneValue: 63, context: "Tech", genre: "Tech", sceneType: "Product", surfaces: ["Desk", "Products", "Table"], surfaceCount: 3, duration: "11:20", brand: "Anker", budget: 2800, status: "Active", category: "Tech" },
    { id: 2013, videoId: 1013, youtubeId: "demo-fallback-13", title: "WFH Productivity Guide", thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", creatorName: "RemoteWorker", viewCount: 445000, sceneValue: 70, context: "Productivity", genre: "Productivity", sceneType: "Desk", surfaces: ["Monitor", "Desk", "Chair"], surfaceCount: 3, duration: "8:33", brand: "Herman Miller", budget: 4000, status: "Active", category: "Productivity" },
    { id: 2014, videoId: 1014, youtubeId: "demo-fallback-14", title: "Creator Starter Kit", thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", creatorName: "ContentPro", viewCount: 710000, sceneValue: 77, context: "Creative", genre: "Tech", sceneType: "Desk", surfaces: ["Camera", "Mic", "Lighting"], surfaceCount: 3, duration: "14:48", brand: "Rode", budget: 5500, status: "Active", category: "Creative" },
    { id: 2015, videoId: 1015, youtubeId: "demo-fallback-15", title: "Aesthetic Room Makeover", thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", creatorName: "AestheticLife", viewCount: 390000, sceneValue: 58, context: "Lifestyle", genre: "Lifestyle", sceneType: "Interior", surfaces: ["Wall", "Furniture", "Decor"], surfaceCount: 3, duration: "7:22", brand: "Anthropologie", budget: 2400, status: "Active", category: "Lifestyle" },
    { id: 2016, videoId: 1016, youtubeId: "demo-fallback-16", title: "Standing Desk Experience", thumbnailUrl: "https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=480&h=270&fit=crop", creatorName: "HealthyWork", viewCount: 285000, sceneValue: 54, context: "Productivity", genre: "Productivity", sceneType: "Desk", surfaces: ["Desk", "Monitor", "Chair"], surfaceCount: 3, duration: "10:05", brand: "Uplift", budget: 3200, status: "Active", category: "Productivity" },
    { id: 2017, videoId: 1017, youtubeId: "demo-fallback-17", title: "Ultimate Cable Setup", thumbnailUrl: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=480&h=270&fit=crop", creatorName: "CleanDesk", viewCount: 620000, sceneValue: 74, context: "DIY", genre: "DIY", sceneType: "Desk", surfaces: ["Cables", "Desk", "Organizers"], surfaceCount: 3, duration: "12:38", brand: "Cable Matters", budget: 1800, status: "Active", category: "DIY" },
    { id: 2018, videoId: 1018, youtubeId: "demo-fallback-18", title: "Keyboard Enthusiast Guide", thumbnailUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=480&h=270&fit=crop", creatorName: "KeyboardNerd", viewCount: 830000, sceneValue: 82, context: "Tech", genre: "Tech", sceneType: "Product", surfaces: ["Keyboard", "Desk", "Accessories"], surfaceCount: 3, duration: "15:10", brand: "Keychron", budget: 4200, status: "Active", category: "Tech" },
    { id: 2019, videoId: 1019, youtubeId: "demo-fallback-19", title: "Monitor Selection Guide", thumbnailUrl: "https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=480&h=270&fit=crop", creatorName: "DisplayPro", viewCount: 490000, sceneValue: 67, context: "Tech", genre: "Tech", sceneType: "Product", surfaces: ["Monitor", "Desk", "Stand"], surfaceCount: 3, duration: "13:25", brand: "LG", budget: 5000, status: "Active", category: "Tech" },
    { id: 2020, videoId: 1020, youtubeId: "demo-fallback-20", title: "Creator Day Documentary", thumbnailUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=480&h=270&fit=crop", creatorName: "VlogMaster", viewCount: 560000, sceneValue: 61, context: "Vlog", genre: "Vlog", sceneType: "Various", surfaces: ["Studio", "Street", "Home"], surfaceCount: 3, duration: "10:50", brand: "GoPro", budget: 3800, status: "Active", category: "Vlog" },
  ];

  // Public demo endpoint for brand marketplace discovery (no auth required)
  app.get("/api/demo/brand-discovery", async (req, res) => {
    try {
      const videos = await storage.getReadyVideosForMarketplace();
      
      const opportunities = videos.map((video) => ({
        id: video.id,
        videoId: video.id,
        youtubeId: video.youtubeId,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        creatorName: video.userId?.split("@")[0] || "Creator",
        viewCount: video.viewCount,
        sceneValue: Math.floor(50 + (video.priorityScore || 0) * 1.5),
        context: video.category || "General",
        genre: video.category || "General",
        sceneType: video.category || "General",
        surfaces: video.surfaces?.map((s: any) => s.surfaceType) || [],
        surfaceCount: video.surfaceCount,
        duration: video.duration || "Unknown",
      }));
      
      // FALLBACK: If empty, return hardcoded fallback campaigns
      if (opportunities.length === 0) {
        console.log(`[DEMO] DB has 0 opportunities, returning fallback campaigns`);
        res.json({ opportunities: FALLBACK_DEMO_CAMPAIGNS, total: FALLBACK_DEMO_CAMPAIGNS.length });
        return;
      }
      
      res.json({ opportunities, total: opportunities.length });
    } catch (err) {
      console.error("Error fetching demo brand discovery, returning fallback:", err);
      res.json({ opportunities: FALLBACK_DEMO_CAMPAIGNS, total: FALLBACK_DEMO_CAMPAIGNS.length });
    }
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
  app.get("/api/auth/user-type", async (req: any, res) => {
    // Return null for unauthenticated users - no 401 loop
    if (!req.session?.googleUser) {
      return res.json({ authenticated: false, userType: null });
    }
    
    const email = req.session.googleUser.email;
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
      
      const videos = (videosData.items || []).map((item: any) => ({
        id: item.contentDetails?.videoId || item.id,
        title: item.snippet.title,
        thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
        publishedAt: item.snippet.publishedAt,
        description: item.snippet.description,
      }));

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
