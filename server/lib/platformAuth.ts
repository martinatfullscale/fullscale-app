import passport from "passport";
import type { Express } from "express";
import { db } from "../db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
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
              const existingLoggedInUser = req.user?.claims?.sub || req.session?.userId;
              const fbEmail = profile.emails?.[0]?.value;
              
              // Fetch real Page data from Graph API
              console.log(`[PlatformAuth] Fetching Graph API data for ${profile.displayName}...`);
              const pageData = await fetchFacebookPageData(accessToken);
              
              // Build update object with Page data
              const socialDataUpdate: Record<string, any> = {
                facebookId: profile.id,
              };
              
              if (pageData) {
                socialDataUpdate.facebookPageId = pageData.pageId;
                socialDataUpdate.facebookPageName = pageData.pageName;
                socialDataUpdate.facebookFollowers = pageData.followers;
                socialDataUpdate.facebookAccessToken = encrypt(pageData.accessToken);
                
                if (pageData.instagramBusinessId) {
                  socialDataUpdate.instagramBusinessId = pageData.instagramBusinessId;
                  socialDataUpdate.instagramHandle = pageData.instagramHandle;
                  socialDataUpdate.instagramFollowers = pageData.instagramFollowers;
                  socialDataUpdate.instagramId = pageData.instagramBusinessId;
                }
                
                console.log(`[PlatformAuth] Page data: ${pageData.pageName} - ${pageData.followers} followers`);
                if (pageData.instagramHandle) {
                  console.log(`[PlatformAuth] Instagram: ${pageData.instagramHandle} - ${pageData.instagramFollowers} followers`);
                }
              } else {
                console.log(`[PlatformAuth] No Page data found (user may not manage a Page)`);
              }
              
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
                  
                console.log(`[PlatformAuth] Facebook login: Updated user ${existingUser.id} with Page data`);
                req.session.userId = existingUser.id;
                req.session.facebookProfile = { 
                  id: profile.id, 
                  displayName: profile.displayName,
                  pageName: pageData?.pageName,
                  followers: pageData?.followers
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
                  displayName: profile.displayName,
                  pageName: pageData?.pageName,
                  followers: pageData?.followers
                };
                return done(null, req.user);
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
                    displayName: profile.displayName,
                    pageName: pageData?.pageName,
                    followers: pageData?.followers
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
                displayName: profile.displayName,
                pageName: pageData?.pageName,
                followers: pageData?.followers
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
  app.get("/auth/facebook", (req, res, next) => {
    console.log("[PlatformAuth] Starting Facebook OAuth flow...");
    console.log("[PlatformAuth] Callback URL will be:", `${BASE_URL}/auth/facebook/callback`);
    if (!FACEBOOK_APP_ID) {
      console.error("[PlatformAuth] Facebook auth not configured - missing FACEBOOK_APP_ID");
      return res.status(503).json({ error: "Facebook auth not configured" });
    }
    // Request scopes for creator data access
    passport.authenticate("facebook", { 
      scope: ["email", "public_profile", "pages_show_list", "pages_read_engagement"] 
    })(req, res, next);
  });

  app.get("/auth/facebook/callback", (req, res, next) => {
    console.log("[PlatformAuth] Facebook callback received");
    console.log("[PlatformAuth] Query params:", req.query);
    if (!FACEBOOK_APP_ID) {
      return res.status(503).json({ error: "Facebook auth not configured" });
    }
    passport.authenticate("facebook", (err: any, user: any, info: any) => {
      if (err) {
        console.error("[PlatformAuth] Facebook callback error:", err);
        return res.redirect("/?error=facebook_auth_failed");
      }
      if (!user) {
        console.error("[PlatformAuth] Facebook callback - no user returned:", info);
        return res.redirect("/?error=facebook_auth_failed");
      }
      console.log("[PlatformAuth] Facebook login successful for user:", user.id || user.email);
      req.logIn(user, (loginErr: any) => {
        if (loginErr) {
          console.error("[PlatformAuth] Facebook login error:", loginErr);
          return res.redirect("/?error=facebook_auth_failed");
        }
        return res.redirect("/dashboard");
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

  console.log("[PlatformAuth] Platform auth routes registered");
}
