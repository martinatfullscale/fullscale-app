import passport from "passport";
import type { Express, RequestHandler } from "express";
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

export function setupPlatformAuth(app: Express) {
  const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
  const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
  const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID;
  const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;
  const BASE_URL = process.env.BASE_URL || "https://fullscale.replit.app";

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.warn("[PlatformAuth] Twitch credentials not configured - Twitch auth disabled");
  } else {
    try {
      const TwitchStrategy = require("passport-twitch-new").Strategy;
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
            req: Express.Request,
            accessToken: string,
            refreshToken: string,
            profile: TwitchProfile,
            done: (err: Error | null, user?: any) => void
          ) => {
            try {
              const userId = (req.user as any)?.claims?.sub;
              if (!userId) {
                return done(new Error("Must be logged in to link Twitch account"));
              }

              await db
                .update(users)
                .set({ twitchId: profile.id })
                .where(eq(users.id, userId));

              console.log(`[PlatformAuth] Linked Twitch account ${profile.display_name} to user ${userId}`);
              done(null, req.user);
            } catch (error) {
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

  if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) {
    console.warn("[PlatformAuth] Facebook credentials not configured - Facebook auth disabled");
  } else {
    try {
      const FacebookStrategy = require("passport-facebook").Strategy;
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
            req: Express.Request,
            accessToken: string,
            refreshToken: string,
            profile: FacebookProfile,
            done: (err: Error | null, user?: any) => void
          ) => {
            try {
              const userId = (req.user as any)?.claims?.sub;
              if (!userId) {
                return done(new Error("Must be logged in to link Facebook account"));
              }

              await db
                .update(users)
                .set({ 
                  facebookId: profile.id,
                  instagramId: profile.id 
                })
                .where(eq(users.id, userId));

              console.log(`[PlatformAuth] Linked Facebook account ${profile.displayName} to user ${userId}`);
              done(null, req.user);
            } catch (error) {
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

  app.get("/auth/twitch", (req, res, next) => {
    if (!TWITCH_CLIENT_ID) {
      return res.status(503).json({ error: "Twitch auth not configured" });
    }
    if (!req.isAuthenticated()) {
      return res.redirect("/api/login?returnTo=/auth/twitch");
    }
    passport.authenticate("twitch")(req, res, next);
  });

  app.get("/auth/twitch/callback", (req, res, next) => {
    if (!TWITCH_CLIENT_ID) {
      return res.status(503).json({ error: "Twitch auth not configured" });
    }
    passport.authenticate("twitch", {
      successRedirect: "/settings?linked=twitch",
      failureRedirect: "/settings?error=twitch_link_failed",
    })(req, res, next);
  });

  app.get("/auth/facebook", (req, res, next) => {
    if (!FACEBOOK_APP_ID) {
      return res.status(503).json({ error: "Facebook auth not configured" });
    }
    if (!req.isAuthenticated()) {
      return res.redirect("/api/login?returnTo=/auth/facebook");
    }
    passport.authenticate("facebook", { scope: ["email", "public_profile"] })(req, res, next);
  });

  app.get("/auth/facebook/callback", (req, res, next) => {
    if (!FACEBOOK_APP_ID) {
      return res.status(503).json({ error: "Facebook auth not configured" });
    }
    passport.authenticate("facebook", {
      successRedirect: "/settings?linked=facebook",
      failureRedirect: "/settings?error=facebook_link_failed",
    })(req, res, next);
  });

  app.get("/api/platform-auth/status", async (req, res) => {
    res.json({
      twitch: {
        configured: !!TWITCH_CLIENT_ID,
        connected: false,
      },
      facebook: {
        configured: !!FACEBOOK_APP_ID,
        connected: false,
      },
    });
  });

  console.log("[PlatformAuth] Platform auth routes registered");
}
