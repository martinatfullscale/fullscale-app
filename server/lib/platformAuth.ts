import passport from "passport";
import type { Express } from "express";
import { db } from "../db";
import { users, videoIndex } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { encrypt } from "../encryption";

interface TwitchProfile {
  id: string;
  login: string;
  display_name: string;
  email?: string;
  profile_image_url?: string;
}

interface FacebookProfile {
  id: string;
  displayName: string;
  emails?: Array<{ value: string }>;
  photos?: Array<{ value: string }>;
}

interface FacebookPageData {
  pageId: string;
  pageName: string;
  followers: number;
  accessToken: string;
  instagramBusinessId?: string;
  instagramHandle?: string;
  instagramFollowers?: number;
}

async function fetchFacebookPageData(userAccessToken: string): Promise<FacebookPageData | null> {
  try {
    // Fetch Pages the user manages with fan_count (followers) and Instagram Business Account
    const pagesUrl = `https://graph.facebook.com/v18.0/me/accounts?fields=id,name,fan_count,access_token,instagram_business_account&access_token=${userAccessToken}`;
    const pagesResponse = await fetch(pagesUrl);
    const pagesData = await pagesResponse.json();
    
    // Log only non-sensitive page info (exclude access tokens)
    console.log("[Graph API] Pages found:", pagesData.data?.length || 0);
    
    if (!pagesData.data || pagesData.data.length === 0) {
      console.log("[Graph API] No Pages found for this user");
      return null;
    }
    
    // Use the first Page (most common case is one Page per creator)
    const page = pagesData.data[0];
    const result: FacebookPageData = {
      pageId: page.id,
      pageName: page.name,
      followers: page.fan_count || 0,
      accessToken: page.access_token,
    };
    
    // If Instagram Business Account is connected, fetch its data
    if (page.instagram_business_account?.id) {
      const igId = page.instagram_business_account.id;
      const igUrl = `https://graph.facebook.com/v18.0/${igId}?fields=username,followers_count&access_token=${page.access_token}`;
      const igResponse = await fetch(igUrl);
      const igData = await igResponse.json();
      
      // Log only non-sensitive Instagram info
      console.log("[Graph API] Instagram username found:", igData.username || "none");
      
      if (igData.username) {
        result.instagramBusinessId = igId;
        result.instagramHandle = `@${igData.username}`;
        result.instagramFollowers = igData.followers_count || 0;
      }
    }
    
    // Log summary without sensitive data
    console.log(`[Graph API] Page: ${result.pageName}, Followers: ${result.followers}, Instagram: ${result.instagramHandle || "not linked"}`);
    return result;
  } catch (error) {
    console.error("[Graph API] Error fetching page data:", error);
    return null;
  }
}

// Fetch Facebook Page videos
async function fetchFacebookPageVideos(pageId: string, accessToken: string): Promise<any[]> {
  try {
    const url = `https://graph.facebook.com/v18.0/${pageId}/videos?fields=id,title,description,created_time,thumbnails,permalink_url,length,views&limit=50&access_token=${accessToken}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.error) {
      console.error("[Graph API] Error fetching Facebook videos:", data.error.message);
      return [];
    }
    
    console.log(`[Graph API] Found ${data.data?.length || 0} Facebook videos`);
    return data.data || [];
  } catch (error) {
    console.error("[Graph API] Error fetching Facebook videos:", error);
    return [];
  }
}

// Fetch Instagram Business media
async function fetchInstagramMedia(igUserId: string, accessToken: string): Promise<any[]> {
  try {
    const url = `https://graph.facebook.com/v18.0/${igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,permalink&limit=50&access_token=${accessToken}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.error) {
      console.error("[Graph API] Error fetching Instagram media:", data.error.message);
      return [];
    }
    
    console.log(`[Graph API] Found ${data.data?.length || 0} Instagram media items`);
    return data.data || [];
  } catch (error) {
    console.error("[Graph API] Error fetching Instagram media:", error);
    return [];
  }
}

// Import Facebook videos into video_index
async function importFacebookVideos(userId: string, pageId: string, accessToken: string): Promise<number> {
  const videos = await fetchFacebookPageVideos(pageId, accessToken);
  let imported = 0;
  
  for (const video of videos) {
    try {
      // Check if already exists
      const existing = await db.query.videoIndex.findFirst({
        where: and(
          eq(videoIndex.userId, userId),
          eq(videoIndex.youtubeId, `facebook:${video.id}`),
          eq(videoIndex.platform, "facebook")
        )
      });
      
      if (!existing) {
        await db.insert(videoIndex).values({
          userId,
          youtubeId: `facebook:${video.id}`,
          title: video.title || "Untitled Video",
          description: video.description || "",
          viewCount: video.views || 0,
          thumbnailUrl: video.thumbnails?.data?.[0]?.uri || null,
          status: "Pending Scan",
          priorityScore: 50,
          publishedAt: video.created_time ? new Date(video.created_time) : new Date(),
          platform: "facebook",
          duration: video.length ? `${Math.floor(video.length / 60)}:${String(video.length % 60).padStart(2, '0')}` : null,
          sourceUrl: video.permalink_url || null,
        });
        imported++;
      }
    } catch (error) {
      console.error(`[Graph API] Error importing Facebook video ${video.id}:`, error);
    }
  }
  
  console.log(`[Graph API] Imported ${imported} new Facebook videos`);
  return imported;
}

// Import Instagram media into video_index
async function importInstagramMedia(userId: string, igUserId: string, accessToken: string): Promise<number> {
  const media = await fetchInstagramMedia(igUserId, accessToken);
  let imported = 0;
  
  for (const item of media) {
    try {
      // Only import videos and reels (not images)
      if (item.media_type !== "VIDEO" && item.media_type !== "REELS") {
        continue;
      }
      
      // Check if already exists
      const existing = await db.query.videoIndex.findFirst({
        where: and(
          eq(videoIndex.userId, userId),
          eq(videoIndex.youtubeId, `instagram:${item.id}`),
          eq(videoIndex.platform, "instagram")
        )
      });
      
      if (!existing) {
        await db.insert(videoIndex).values({
          userId,
          youtubeId: `instagram:${item.id}`,
          title: item.caption?.substring(0, 100) || "Instagram Video",
          description: item.caption || "",
          viewCount: 0,
          thumbnailUrl: item.thumbnail_url || item.media_url || null,
          status: "Pending Scan",
          priorityScore: 50,
          publishedAt: item.timestamp ? new Date(item.timestamp) : new Date(),
          platform: "instagram",
          sourceUrl: item.permalink || null,
        });
        imported++;
      }
    } catch (error) {
      console.error(`[Graph API] Error importing Instagram media ${item.id}:`, error);
    }
  }
  
  console.log(`[Graph API] Imported ${imported} new Instagram videos/reels`);
  return imported;
}

// Export for use in routes
export { importFacebookVideos, importInstagramMedia };

export async function setupPlatformAuth(app: Express) {
  const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
  const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
  const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID;
  const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;
  const BASE_URL = process.env.BASE_URL || "https://fullscale.replit.app";

  // Setup Twitch strategy
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.warn("[PlatformAuth] Twitch credentials not configured - Twitch auth disabled");
  } else {
    try {
      const twitchModule = await import("passport-twitch-new");
      const TwitchStrategy = twitchModule.Strategy;
      
      passport.use(
        "twitch",
        new TwitchStrategy(
          {
            clientID: TWITCH_CLIENT_ID,
            clientSecret: TWITCH_CLIENT_SECRET,
            callbackURL: `${BASE_URL}/auth/twitch/callback`,
            scope: "user:read:email",
            passReqToCallback: true,
          },
          async (
            req: any,
            accessToken: string,
            refreshToken: string,
            profile: TwitchProfile,
            done: (err: Error | null, user?: any) => void
          ) => {
            try {
              const existingLoggedInUser = req.user?.claims?.sub || req.session?.userId;
              
              // Check if user with this Twitch ID already exists
              let existingUser = await db.query.users.findFirst({
                where: eq(users.twitchId, profile.id),
              });

              if (existingUser) {
                console.log(`[PlatformAuth] Twitch login: Found existing user ${existingUser.id}`);
                req.session.userId = existingUser.id;
                req.session.twitchProfile = { id: profile.id, displayName: profile.display_name };
                return done(null, existingUser);
              }

              // If logged in with another method, link Twitch to that account
              if (existingLoggedInUser) {
                await db
                  .update(users)
                  .set({ twitchId: profile.id })
                  .where(eq(users.id, existingLoggedInUser));
                console.log(`[PlatformAuth] Linked Twitch account ${profile.display_name} to user ${existingLoggedInUser}`);
                return done(null, req.user);
              }

              // Check if user exists by email (to link accounts)
              const twitchEmail = profile.email;
              if (twitchEmail) {
                existingUser = await db.query.users.findFirst({
                  where: eq(users.id, twitchEmail),
                });
                if (existingUser) {
                  await db
                    .update(users)
                    .set({ twitchId: profile.id })
                    .where(eq(users.id, twitchEmail));
                  console.log(`[PlatformAuth] Linked Twitch to existing email account ${twitchEmail}`);
                  req.session.userId = existingUser.id;
                  return done(null, existingUser);
                }
              }

              // Create new user from Twitch
              const newUserId = twitchEmail || `twitch:${profile.id}`;
              const [newUser] = await db.insert(users).values({
                id: newUserId,
                twitchId: profile.id,
                firstName: profile.display_name,
                lastName: "",
                profileImageUrl: profile.profile_image_url,
              }).returning();

              console.log(`[PlatformAuth] Created new user from Twitch: ${newUserId}`);
              req.session.userId = newUser.id;
              req.session.twitchProfile = { id: profile.id, displayName: profile.display_name };
              done(null, newUser);
            } catch (error) {
              console.error("[PlatformAuth] Twitch auth error:", error);
              done(error as Error);
            }
          }
        )
      );
      console.log("[PlatformAuth] Twitch strategy configured");
    } catch (err) {
      console.error("[PlatformAuth] Failed to initialize Twitch strategy:", err);
    }
  }

  // Setup Facebook strategy
  if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) {
    console.warn("[PlatformAuth] Facebook credentials not configured - Facebook auth disabled");
  } else {
    try {
      const facebookModule = await import("passport-facebook");
      const FacebookStrategy = facebookModule.Strategy;
      
      passport.use(
        "facebook",
        new FacebookStrategy(
          {
            clientID: FACEBOOK_APP_ID,
            clientSecret: FACEBOOK_APP_SECRET,
            callbackURL: `${BASE_URL}/auth/facebook/callback`,
            profileFields: ["id", "displayName", "email", "photos"],
            passReqToCallback: true,
          },
          async (
            req: any,
            accessToken: string,
            refreshToken: string,
            profile: FacebookProfile,
            done: (err: Error | null, user?: any) => void
          ) => {
            try {
              // Support multiple auth methods: Replit OIDC, session userId, AND Google OAuth
              const existingLoggedInUser = req.user?.claims?.sub || req.session?.userId;
              // Check both googleUser AND pendingGoogleUser (saved before OAuth redirect)
              const googleUserEmail = req.session?.googleUser?.email || req.session?.pendingGoogleUser?.email;
              const fbEmail = profile.emails?.[0]?.value;
              
              // Comprehensive logging for debugging account linking
              console.log(`[PlatformAuth] ========== FACEBOOK VERIFY CALLBACK ==========`);
              console.log(`[PlatformAuth] Facebook profile: ${profile.displayName} (${profile.id})`);
              console.log(`[PlatformAuth] Facebook email: ${fbEmail || 'none'}`);
              console.log(`[PlatformAuth] Session existingLoggedInUser: ${existingLoggedInUser || 'none'}`);
              console.log(`[PlatformAuth] Session googleUserEmail: ${googleUserEmail || 'none'}`);
              console.log(`[PlatformAuth] Session ID: ${req.sessionID}`);
              console.log(`[PlatformAuth] Session googleUser: ${JSON.stringify(req.session?.googleUser || 'none')}`);
              console.log(`[PlatformAuth] Session pendingGoogleUser: ${JSON.stringify(req.session?.pendingGoogleUser || 'none')}`);
              
              // FAST LOGIN: Only save basic Facebook ID, defer Page data fetch to manual sync
              // This prevents slow API calls from blocking login
              console.log(`[PlatformAuth] Fast login for ${profile.displayName} - Page data will sync on demand`);
              
              // Build minimal update object (no Graph API calls during login)
              const socialDataUpdate: Record<string, any> = {
                facebookId: profile.id,
              };
              
              // Store access token for later manual sync (encrypted)
              socialDataUpdate.facebookAccessToken = encrypt(accessToken);
              
              // Check if user with this Facebook ID already exists
              let existingUser = await db.query.users.findFirst({
                where: eq(users.facebookId, profile.id),
              });

              if (existingUser) {
                // Update existing user with latest Page data
                await db
                  .update(users)
                  .set(socialDataUpdate)
                  .where(eq(users.id, existingUser.id));
                  
                console.log(`[PlatformAuth] Facebook login: Updated user ${existingUser.id}`);
                req.session.userId = existingUser.id;
                req.session.facebookProfile = { 
                  id: profile.id, 
                  displayName: profile.displayName
                };
                return done(null, existingUser);
              }

              // If logged in with another method, link Facebook to that account
              if (existingLoggedInUser) {
                await db
                  .update(users)
                  .set(socialDataUpdate)
                  .where(eq(users.id, existingLoggedInUser));
                console.log(`[PlatformAuth] Linked Facebook account ${profile.displayName} to user ${existingLoggedInUser}`);
                req.session.facebookProfile = { 
                  id: profile.id, 
                  displayName: profile.displayName
                };
                return done(null, req.user);
              }
              
              // If logged in with Google OAuth, link Facebook to that account
              if (googleUserEmail) {
                console.log(`[PlatformAuth] Looking up user by Google email: ${googleUserEmail}`);
                const googleUser = await db.query.users.findFirst({
                  where: eq(users.email, googleUserEmail),
                });
                console.log(`[PlatformAuth] User lookup result: ${googleUser ? `found (id=${googleUser.id})` : 'NOT FOUND'}`);
                
                if (googleUser) {
                  console.log(`[PlatformAuth] Updating user ${googleUser.id} with Facebook data...`);
                  console.log(`[PlatformAuth] Update payload: ${JSON.stringify(Object.keys(socialDataUpdate))}`);
                  
                  try {
                    const updateResult = await db
                      .update(users)
                      .set(socialDataUpdate)
                      .where(eq(users.id, googleUser.id))
                      .returning();
                    console.log(`[PlatformAuth] Update result: ${JSON.stringify(updateResult?.length)} rows affected`);
                    console.log(`[PlatformAuth] Successfully linked Facebook to user ${googleUserEmail}`);
                  } catch (updateError: any) {
                    console.error(`[PlatformAuth] DATABASE UPDATE ERROR: ${updateError.message}`);
                    console.error(`[PlatformAuth] Update error stack:`, updateError.stack);
                  }
                  
                  req.session.userId = googleUser.id;
                  req.session.facebookProfile = { 
                    id: profile.id, 
                    displayName: profile.displayName
                  };
                  return done(null, googleUser);
                } else {
                  console.log(`[PlatformAuth] WARNING: Could not find user with email ${googleUserEmail} in database`);
                }
              }

              // Check if user exists by email (to link accounts)
              if (fbEmail) {
                existingUser = await db.query.users.findFirst({
                  where: eq(users.email, fbEmail),
                });
                if (existingUser) {
                  await db
                    .update(users)
                    .set(socialDataUpdate)
                    .where(eq(users.id, existingUser.id));
                  console.log(`[PlatformAuth] Linked Facebook to existing email account ${fbEmail}`);
                  req.session.userId = existingUser.id;
                  req.session.facebookProfile = { 
                    id: profile.id, 
                    displayName: profile.displayName
                  };
                  return done(null, existingUser);
                }
              }

              // Create new user from Facebook
              const newUserId = fbEmail || `facebook:${profile.id}`;
              const nameParts = profile.displayName.split(" ");
              const [newUser] = await db.insert(users).values({
                id: newUserId,
                facebookId: profile.id,
                firstName: nameParts[0] || "",
                lastName: nameParts.slice(1).join(" ") || "",
                profileImageUrl: profile.photos?.[0]?.value,
                ...socialDataUpdate,
              }).returning();

              console.log(`[PlatformAuth] Created new user from Facebook: ${newUserId}`);
              req.session.userId = newUser.id;
              req.session.facebookProfile = { 
                id: profile.id, 
                displayName: profile.displayName
              };
              done(null, newUser);
            } catch (error) {
              console.error("[PlatformAuth] Facebook auth error:", error);
              done(error as Error);
            }
          }
        )
      );
      console.log("[PlatformAuth] Facebook strategy configured");
    } catch (err) {
      console.error("[PlatformAuth] Failed to initialize Facebook strategy:", err);
    }
  }

  // Twitch auth routes - works for both login and account linking
  app.get("/auth/twitch", (req, res, next) => {
    if (!TWITCH_CLIENT_ID) {
      return res.status(503).json({ error: "Twitch auth not configured" });
    }
    passport.authenticate("twitch")(req, res, next);
  });

  app.get("/auth/twitch/callback", (req, res, next) => {
    if (!TWITCH_CLIENT_ID) {
      return res.status(503).json({ error: "Twitch auth not configured" });
    }
    passport.authenticate("twitch", {
      successRedirect: "/dashboard",
      failureRedirect: "/?error=twitch_auth_failed",
    })(req, res, next);
  });

  // Facebook auth routes - works for both login and account linking
  app.get("/auth/facebook", (req: any, res, next) => {
    console.log("[PlatformAuth] Starting Facebook OAuth flow...");
    console.log("[PlatformAuth] Callback URL will be:", `${BASE_URL}/auth/facebook/callback`);
    console.log("[PlatformAuth] Session ID at start:", req.sessionID);
    console.log("[PlatformAuth] GoogleUser in session:", req.session?.googleUser?.email || 'none');
    
    if (!FACEBOOK_APP_ID) {
      console.error("[PlatformAuth] Facebook auth not configured - missing FACEBOOK_APP_ID");
      return res.status(503).json({ error: "Facebook auth not configured" });
    }
    
    // Save Google user info to session before OAuth redirect (survives redirect)
    if (req.session?.googleUser) {
      req.session.pendingGoogleUser = req.session.googleUser;
      console.log("[PlatformAuth] Saved pendingGoogleUser for linking:", req.session.pendingGoogleUser.email);
    }
    
    // Save session before redirecting to Facebook
    req.session.save((err: any) => {
      if (err) {
        console.error("[PlatformAuth] Session save error:", err);
      }
      // Request scopes for creator data access
      // Note: instagram_basic and instagram_manage_insights require Facebook App Review approval
      // The instagram_business_account is fetched via pages_read_engagement when a Page has linked IG
      passport.authenticate("facebook", { 
        scope: ["email", "public_profile", "pages_show_list", "pages_read_engagement"] 
      })(req, res, next);
    });
  });

  app.get("/auth/facebook/callback", (req: any, res, next) => {
    console.log("[PlatformAuth] ========== FACEBOOK CALLBACK RECEIVED ==========");
    console.log("[PlatformAuth] Query params:", JSON.stringify(req.query));
    console.log("[PlatformAuth] Session ID before auth:", req.sessionID);
    console.log("[PlatformAuth] Session googleUser:", req.session?.googleUser?.email || 'none');
    console.log("[PlatformAuth] Session pendingGoogleUser:", req.session?.pendingGoogleUser?.email || 'none');
    
    if (!FACEBOOK_APP_ID) {
      console.error("[PlatformAuth] Facebook auth not configured");
      return res.status(503).json({ error: "Facebook auth not configured" });
    }
    
    // Use simpler passport.authenticate with options (like Twitch)
    // The strategy already sets req.session.userId in the verify callback
    passport.authenticate("facebook", {
      failureRedirect: "/?error=facebook_auth_failed",
      keepSessionInfo: true, // Preserve session data across login
    }, (err: any, user: any, info: any) => {
      if (err) {
        console.error("[PlatformAuth] Facebook callback ERROR:", err.message || err);
        return res.redirect("/?error=facebook_auth_failed&reason=passport_error");
      }
      
      if (!user) {
        console.error("[PlatformAuth] Facebook callback - NO USER returned");
        console.error("[PlatformAuth] Info:", JSON.stringify(info));
        return res.redirect("/?error=facebook_auth_failed&reason=no_user");
      }
      
      console.log("[PlatformAuth] Facebook Auth SUCCESS!");
      console.log("[PlatformAuth] User ID:", user.id);
      console.log("[PlatformAuth] User email:", user.email);
      
      // Use req.login with keepSessionInfo to preserve session data
      req.login(user, { keepSessionInfo: true }, async (loginErr: any) => {
        if (loginErr) {
          console.error("[PlatformAuth] req.login ERROR:", loginErr.message || loginErr);
          return res.redirect("/?error=facebook_auth_failed&reason=login_error");
        }
        
        // Ensure userId is set AFTER login (in case session was regenerated)
        req.session.userId = user.id;
        req.session.facebookConnected = true;
        
        console.log("[PlatformAuth] Session ID after login:", req.sessionID);
        console.log("[PlatformAuth] Session userId set to:", req.session.userId);
        
        // SYNC: Update database with Facebook ID using session data
        const googleEmail = req.session?.googleUser?.email || req.session?.pendingGoogleUser?.email;
        const facebookProfile = req.session?.facebookProfile;
        
        if (googleEmail && facebookProfile?.id) {
          try {
            const dbUser = await db.query.users.findFirst({
              where: eq(users.email, googleEmail),
            });
            if (dbUser) {
              await db
                .update(users)
                .set({ facebookId: facebookProfile.id })
                .where(eq(users.id, dbUser.id));
              console.log(`[PlatformAuth] Auto-synced Facebook ID ${facebookProfile.id} to user ${googleEmail}`);
            }
          } catch (syncErr: any) {
            console.error("[PlatformAuth] Auto-sync error:", syncErr.message);
          }
        }
        
        // Save session explicitly before redirect
        req.session.save((saveErr: any) => {
          if (saveErr) {
            console.error("[PlatformAuth] Session save ERROR:", saveErr.message || saveErr);
            return res.redirect("/?error=facebook_auth_failed&reason=session_error");
          }
          
          console.log("[PlatformAuth] Session saved, redirecting to /dashboard");
          console.log("[PlatformAuth] ========== END FACEBOOK CALLBACK ==========");
          return res.redirect("/dashboard");
        });
      });
    })(req, res, next);
  });

  // Status endpoint to check which platforms are configured/connected
  app.get("/api/platform-auth/status", async (req: any, res) => {
    // Support multiple auth methods
    const googleUser = req.session?.googleUser;
    const replitUser = req.user?.claims;
    const adminEmail = process.env.NODE_ENV !== 'production' ? (req.query.admin_email || req.headers['x-admin-email']) : null;
    
    let userId = req.session?.userId || replitUser?.sub;
    let userEmail = googleUser?.email || replitUser?.email || adminEmail;
    
    let twitchConnected = false;
    let facebookConnected = false;
    let facebookData: { pageName?: string; followers?: number } = {};
    let instagramData: { handle?: string; followers?: number } = {};

    // Try to find user by email if no userId
    let user = null;
    if (userId) {
      user = await db.query.users.findFirst({
        where: eq(users.id, userId),
      });
    } else if (userEmail) {
      user = await db.query.users.findFirst({
        where: eq(users.email, userEmail),
      });
    }
    
    if (user) {
      twitchConnected = !!user.twitchId;
      facebookConnected = !!user.facebookId;
      
      // Include real Page data if available
      if (user.facebookPageName) {
        facebookData = {
          pageName: user.facebookPageName,
          followers: user.facebookFollowers || 0,
        };
      }
      
      // Include Instagram data if available
      if (user.instagramHandle) {
        instagramData = {
          handle: user.instagramHandle,
          followers: user.instagramFollowers || 0,
        };
      }
    }

    res.json({
      twitch: {
        configured: !!TWITCH_CLIENT_ID,
        connected: twitchConnected,
      },
      facebook: {
        configured: !!FACEBOOK_APP_ID,
        connected: facebookConnected,
        ...facebookData,
      },
      instagram: {
        configured: !!FACEBOOK_APP_ID, // Instagram uses Facebook auth
        connected: !!instagramData.handle,
        ...instagramData,
      },
    });
  });

  // Endpoint to sync Facebook connection from session to database
  // Call this after Facebook OAuth to ensure the connection is saved
  // Accepts both GET (for easy testing) and POST
  app.all("/api/facebook/sync-connection", async (req: any, res) => {
    const googleEmail = req.session?.googleUser?.email || req.session?.pendingGoogleUser?.email;
    const facebookProfile = req.session?.facebookProfile;
    
    console.log("[Facebook Sync] Starting sync...");
    console.log("[Facebook Sync] Google email:", googleEmail);
    console.log("[Facebook Sync] Facebook profile:", JSON.stringify(facebookProfile));
    
    if (!googleEmail) {
      return res.status(401).json({ error: "Not logged in with Google" });
    }
    
    if (!facebookProfile || !facebookProfile.id) {
      return res.status(400).json({ error: "No Facebook profile in session. Please connect Facebook first." });
    }
    
    try {
      // Find user by Google email
      const user = await db.query.users.findFirst({
        where: eq(users.email, googleEmail),
      });
      
      if (!user) {
        console.log("[Facebook Sync] User not found:", googleEmail);
        return res.status(404).json({ error: "User not found" });
      }
      
      console.log("[Facebook Sync] Found user:", user.id);
      
      // Update user with Facebook data from session
      await db
        .update(users)
        .set({
          facebookId: facebookProfile.id,
        })
        .where(eq(users.id, user.id));
      
      console.log("[Facebook Sync] Successfully synced Facebook connection");
      
      return res.json({
        success: true,
        message: "Facebook connection synced",
        facebookId: facebookProfile.id,
        displayName: facebookProfile.displayName,
      });
    } catch (error: any) {
      console.error("[Facebook Sync] Error:", error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  // Debug endpoint to manually test Facebook database update
  app.get("/api/debug/test-fb-update", async (req: any, res) => {
    const email = req.session?.googleUser?.email || req.session?.pendingGoogleUser?.email;
    if (!email) {
      return res.json({ error: "Not logged in with Google", session: req.session });
    }
    
    try {
      // Find user by email
      const user = await db.query.users.findFirst({
        where: eq(users.email, email),
      });
      
      if (!user) {
        return res.json({ error: "User not found", email });
      }
      
      // Try updating with test data
      const testUpdate = {
        facebookId: "TEST_FB_ID_" + Date.now(),
      };
      
      const result = await db
        .update(users)
        .set(testUpdate)
        .where(eq(users.id, user.id))
        .returning();
      
      // Read back the user
      const updatedUser = await db.query.users.findFirst({
        where: eq(users.id, user.id),
      });
      
      return res.json({
        success: true,
        userId: user.id,
        email: user.email,
        updateResult: result?.length,
        updatedFacebookId: updatedUser?.facebookId,
      });
    } catch (error: any) {
      return res.json({
        error: error.message,
        stack: error.stack,
      });
    }
  });

  // Debug endpoint to check session state after OAuth
  app.get("/api/debug/facebook-session", async (req: any, res) => {
    const sessionData = {
      sessionId: req.sessionID,
      googleUser: req.session?.googleUser?.email || null,
      pendingGoogleUser: req.session?.pendingGoogleUser?.email || null,
      userId: req.session?.userId || null,
      facebookConnected: req.session?.facebookConnected || false,
      facebookProfile: req.session?.facebookProfile || null,
      replitUser: req.user?.claims?.email || null,
    };
    
    // Check database for user
    const email = sessionData.googleUser || sessionData.pendingGoogleUser;
    let dbUser = null;
    if (email) {
      dbUser = await db.query.users.findFirst({
        where: eq(users.email, email),
      });
    }
    
    res.json({
      session: sessionData,
      dbUser: dbUser ? {
        id: dbUser.id,
        email: dbUser.email,
        facebookId: dbUser.facebookId,
        facebookPageId: dbUser.facebookPageId,
        facebookPageName: dbUser.facebookPageName,
        hasToken: !!dbUser.facebookAccessToken,
      } : null,
    });
  });

  console.log("[PlatformAuth] Platform auth routes registered");
}
