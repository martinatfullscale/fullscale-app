import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";

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
    res.json({ success: true });
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
  
  // Admin emails that can manage the allowlist
  const ADMIN_EMAILS = ["martin@gofullscale.co", "martin@whtwrks.com", "martincekechukwu@gmail.com"];
  
  // Middleware to check if user is admin
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
