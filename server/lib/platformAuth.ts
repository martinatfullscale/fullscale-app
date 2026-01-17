import passport from "passport";
import type { Express } from "express";
import { db } from "../db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

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
              
              // Check if user with this Facebook ID already exists
              let existingUser = await db.query.users.findFirst({
                where: eq(users.facebookId, profile.id),
              });

              if (existingUser) {
                console.log(`[PlatformAuth] Facebook login: Found existing user ${existingUser.id}`);
                req.session.userId = existingUser.id;
                req.session.facebookProfile = { id: profile.id, displayName: profile.displayName };
                return done(null, existingUser);
              }

              // If logged in with another method, link Facebook to that account
              if (existingLoggedInUser) {
                await db
                  .update(users)
                  .set({ 
                    facebookId: profile.id,
                    instagramId: profile.id 
                  })
                  .where(eq(users.id, existingLoggedInUser));
                console.log(`[PlatformAuth] Linked Facebook account ${profile.displayName} to user ${existingLoggedInUser}`);
                return done(null, req.user);
              }

              // Check if user exists by email (to link accounts)
              if (fbEmail) {
                existingUser = await db.query.users.findFirst({
                  where: eq(users.id, fbEmail),
                });
                if (existingUser) {
                  await db
                    .update(users)
                    .set({ 
                      facebookId: profile.id,
                      instagramId: profile.id 
                    })
                    .where(eq(users.id, fbEmail));
                  console.log(`[PlatformAuth] Linked Facebook to existing email account ${fbEmail}`);
                  req.session.userId = existingUser.id;
                  return done(null, existingUser);
                }
              }

              // Create new user from Facebook
              const newUserId = fbEmail || `facebook:${profile.id}`;
              const nameParts = profile.displayName.split(" ");
              const [newUser] = await db.insert(users).values({
                id: newUserId,
                facebookId: profile.id,
                instagramId: profile.id,
                firstName: nameParts[0] || "",
                lastName: nameParts.slice(1).join(" ") || "",
                profileImageUrl: profile.photos?.[0]?.value,
              }).returning();

              console.log(`[PlatformAuth] Created new user from Facebook: ${newUserId}`);
              req.session.userId = newUser.id;
              req.session.facebookProfile = { id: profile.id, displayName: profile.displayName };
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
    if (!FACEBOOK_APP_ID) {
      return res.status(503).json({ error: "Facebook auth not configured" });
    }
    passport.authenticate("facebook", { scope: ["email", "public_profile"] })(req, res, next);
  });

  app.get("/auth/facebook/callback", (req, res, next) => {
    if (!FACEBOOK_APP_ID) {
      return res.status(503).json({ error: "Facebook auth not configured" });
    }
    passport.authenticate("facebook", {
      successRedirect: "/dashboard",
      failureRedirect: "/?error=facebook_auth_failed",
    })(req, res, next);
  });

  // Status endpoint to check which platforms are configured/connected
  app.get("/api/platform-auth/status", async (req: any, res) => {
    const userId = req.session?.userId || req.user?.claims?.sub;
    let twitchConnected = false;
    let facebookConnected = false;

    if (userId) {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
      });
      if (user) {
        twitchConnected = !!user.twitchId;
        facebookConnected = !!user.facebookId;
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
      },
    });
  });

  console.log("[PlatformAuth] Platform auth routes registered");
}
