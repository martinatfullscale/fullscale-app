import passport from "passport";
import type { Express } from "express";
import { db } from "../db";
import { users, videoIndex } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { encrypt, decrypt } from "../encryption";
import { categorizeVideos } from "./ai/categorize";
import { pLimit } from "./concurrency";
import {
  cacheInstagramThumbnail,
  cacheFacebookThumbnail,
  refreshSocialThumbnails,
} from "./socialThumbnails";

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
    const pagesUrl = `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,fan_count,access_token,instagram_business_account&access_token=${userAccessToken}`;
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
      const igUrl = `https://graph.facebook.com/v25.0/${igId}?fields=username,followers_count&access_token=${page.access_token}`;
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
export async function fetchFacebookPageVideos(pageId: string, accessToken: string): Promise<any[]> {
  try {
    // Include 'title' and 'name' fields - Facebook uses different fields for different video types
    const url = `https://graph.facebook.com/v25.0/${pageId}/videos?fields=id,title,name,description,created_time,thumbnails,permalink_url,length,views,source&limit=50&access_token=${accessToken}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.error) {
      console.error("[Graph API] Error fetching Facebook videos:", data.error.message);
      return [];
    }
    
    // Log first video to see what fields we get
    if (data.data?.length > 0) {
      console.log(`[Graph API] Sample video fields:`, Object.keys(data.data[0]));
    }
    
    console.log(`[Graph API] Found ${data.data?.length || 0} Facebook Page videos`);
    return data.data || [];
  } catch (error) {
    console.error("[Graph API] Error fetching Facebook videos:", error);
    return [];
  }
}

// Fetch Facebook personal profile videos (requires user_videos permission)
export async function fetchPersonalProfileVideos(accessToken: string): Promise<any[]> {
  try {
    // Personal profile videos endpoint
    const url = `https://graph.facebook.com/v25.0/me/videos?fields=id,title,description,created_time,thumbnails,permalink_url,length,views,source&type=uploaded&limit=50&access_token=${accessToken}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.error) {
      console.error("[Graph API] Error fetching personal videos:", data.error.message);
      return [];
    }
    
    console.log(`[Graph API] Found ${data.data?.length || 0} personal profile videos`);
    return data.data || [];
  } catch (error) {
    console.error("[Graph API] Error fetching personal videos:", error);
    return [];
  }
}

// Fetch Instagram Business media
export async function fetchInstagramMedia(igUserId: string, accessToken: string): Promise<any[]> {
  try {
    const url = `https://graph.facebook.com/v25.0/${igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,permalink&limit=50&access_token=${accessToken}`;
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

// Fetch view count for a single Instagram media item via the insights API.
// Meta deprecated the legacy metrics in API v22.0:
//   - REELS plays      → use views
//   - VIDEO video_views → use views
// `views` is now the single canonical metric across both media types. We try
// it first, then fall back to the legacy metric for older media that hasn't
// been migrated. Returns 0 on any error so a single item's insights fetch
// failure doesn't break the whole import/backfill.
export async function fetchInstagramVideoViews(
  igMediaId: string,
  mediaType: string,
  accessToken: string,
): Promise<number> {
  const tryMetric = async (metric: string): Promise<number | null> => {
    try {
      const url = `https://graph.facebook.com/v22.0/${igMediaId}/insights?metric=${metric}&access_token=${encodeURIComponent(accessToken)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        // Signal "try the next metric" by returning null on metric-not-supported,
        // 0 on real failures (token/perms/age) so we stop trying.
        const msg = data.error.message || "";
        if (msg.includes("metric") || msg.includes("not supported")) {
          return null;
        }
        console.warn(`[IG Insights] ${igMediaId} (${mediaType}, ${metric}): ${msg}`);
        return 0;
      }
      const value = data.data?.[0]?.values?.[0]?.value;
      return typeof value === "number" ? value : 0;
    } catch (err: any) {
      console.warn(`[IG Insights] ${igMediaId} (${metric}) fetch failed: ${err.message}`);
      return 0;
    }
  };

  // v22+ canonical metric — works for both REELS and VIDEO on modern media.
  const views = await tryMetric("views");
  if (views !== null) return views;

  // Legacy fallback for older media that the v22 metric doesn't cover.
  const legacy = mediaType === "REELS" ? "plays" : "video_views";
  const legacyValue = await tryMetric(legacy);
  return legacyValue ?? 0;
}

// Import personal profile videos into video_index
async function importPersonalVideos(userId: string, accessToken: string): Promise<number> {
  const videos = await fetchPersonalProfileVideos(accessToken);

  const candidates: typeof videos = [];
  for (const video of videos) {
    const existing = await db.query.videoIndex.findFirst({
      where: and(
        eq(videoIndex.userId, userId),
        eq(videoIndex.youtubeId, `facebook:${video.id}`),
        eq(videoIndex.platform, "facebook")
      )
    });
    if (!existing) candidates.push(video);
  }

  const categorizations = await categorizeVideos(
    candidates.map(v => ({ title: v.title || "Untitled Video", description: v.description || "" }))
  );

  // Cache thumbnails to GCS — fbcdn URLs expire same as IG. v.source is the
  // MP4 URL fallback for ffmpeg frame extraction.
  const fbLimit = pLimit(5);
  const cachedThumbnails = await Promise.all(
    candidates.map(v => fbLimit(() =>
      cacheFacebookThumbnail(v.id, v.thumbnails?.data?.[0]?.uri, v.source)
    ))
  );

  let imported = 0;
  for (let i = 0; i < candidates.length; i++) {
    const video = candidates[i];
    const cat = categorizations[i];
    try {
      await db.insert(videoIndex).values({
        userId,
        youtubeId: `facebook:${video.id}`,
        title: video.title || "Untitled Video",
        description: video.description || "",
        viewCount: video.views || 0,
        thumbnailUrl: cachedThumbnails[i],
        status: "Pending Scan",
        priorityScore: 50,
        publishedAt: video.created_time ? new Date(video.created_time) : new Date(),
        platform: "facebook",
        duration: video.length ? `${Math.floor(video.length / 60)}:${String(video.length % 60).padStart(2, '0')}` : null,
        sourceUrl: video.permalink_url || null,
        category: cat.category,
        subcategory: cat.subcategory,
        isEvergreen: cat.isEvergreen,
      });
      imported++;
    } catch (error) {
      console.error(`[Graph API] Error importing personal video ${video.id}:`, error);
    }
  }

  console.log(`[Graph API] Imported ${imported} new personal profile videos`);
  await refreshSocialThumbnails(userId, "facebook", videos);
  return imported;
}

// Import Facebook videos into video_index
async function importFacebookVideos(userId: string, pageId: string, accessToken: string): Promise<number> {
  const videos = await fetchFacebookPageVideos(pageId, accessToken);

  const candidates: Array<{ video: any; title: string }> = [];
  for (const video of videos) {
    const existing = await db.query.videoIndex.findFirst({
      where: and(
        eq(videoIndex.userId, userId),
        eq(videoIndex.youtubeId, `facebook:${video.id}`),
        eq(videoIndex.platform, "facebook")
      )
    });
    if (existing) continue;

    // Try multiple fields for title: title, name, or first line of description
    let videoTitle = video.title || video.name;
    if (!videoTitle && video.description) {
      const firstLine = video.description.split('\n')[0].trim();
      videoTitle = firstLine.substring(0, 100) || "Facebook Video";
    }
    videoTitle = videoTitle || "Facebook Video";
    candidates.push({ video, title: videoTitle });
  }

  const categorizations = await categorizeVideos(
    candidates.map(c => ({ title: c.title, description: c.video.description || "" }))
  );

  // Cache thumbnails to GCS — fbcdn URLs expire same as IG. video.source is
  // the MP4 URL fallback for ffmpeg frame extraction.
  const fbPageLimit = pLimit(5);
  const cachedThumbnails = await Promise.all(
    candidates.map(c => fbPageLimit(() =>
      cacheFacebookThumbnail(c.video.id, c.video.thumbnails?.data?.[0]?.uri, c.video.source)
    ))
  );

  let imported = 0;
  for (let i = 0; i < candidates.length; i++) {
    const { video, title } = candidates[i];
    const cat = categorizations[i];
    try {
      await db.insert(videoIndex).values({
        userId,
        youtubeId: `facebook:${video.id}`,
        title,
        description: video.description || "",
        viewCount: video.views || 0,
        thumbnailUrl: cachedThumbnails[i],
        status: "Pending Scan",
        priorityScore: 50,
        publishedAt: video.created_time ? new Date(video.created_time) : new Date(),
        platform: "facebook",
        duration: video.length ? `${Math.floor(video.length / 60)}:${String(video.length % 60).padStart(2, '0')}` : null,
        sourceUrl: video.permalink_url || null,
        category: cat.category,
        subcategory: cat.subcategory,
        isEvergreen: cat.isEvergreen,
      });
      imported++;
    } catch (error) {
      console.error(`[Graph API] Error importing Facebook video ${video.id}:`, error);
    }
  }

  console.log(`[Graph API] Imported ${imported} new Facebook videos`);
  await refreshSocialThumbnails(userId, "facebook", videos);
  return imported;
}

// Import Instagram media into video_index
async function importInstagramMedia(userId: string, igUserId: string, accessToken: string): Promise<number> {
  const media = await fetchInstagramMedia(igUserId, accessToken);

  const candidates: any[] = [];
  for (const item of media) {
    // Only import videos and reels (not images)
    if (item.media_type !== "VIDEO" && item.media_type !== "REELS") continue;

    const existing = await db.query.videoIndex.findFirst({
      where: and(
        eq(videoIndex.userId, userId),
        eq(videoIndex.youtubeId, `instagram:${item.id}`),
        eq(videoIndex.platform, "instagram")
      )
    });
    if (!existing) candidates.push(item);
  }

  const categorizations = await categorizeVideos(
    candidates.map(item => ({
      title: item.caption?.substring(0, 100) || "Instagram Video",
      description: item.caption || "",
    }))
  );

  // Fetch view counts in parallel with bounded concurrency. IG insights is a
  // per-item endpoint (not batchable), so 50 candidates = 50 calls; cap at 5
  // concurrent to stay well under Graph API rate limits.
  const limit = pLimit(5);
  const viewCounts = await Promise.all(
    candidates.map(item => limit(() =>
      fetchInstagramVideoViews(item.id, item.media_type, accessToken)
    ))
  );

  // Cache thumbnails to GCS in parallel — IG's CDN URLs expire so we never
  // store the raw URL. media_url is passed so cacheInstagramThumbnail can
  // fall back to ffmpeg frame extraction when Graph API returns no
  // thumbnail_url (common for older Reels).
  const cachedThumbnails = await Promise.all(
    candidates.map(item => limit(() =>
      cacheInstagramThumbnail(item.id, item.thumbnail_url, item.media_url)
    ))
  );

  let imported = 0;
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    const cat = categorizations[i];
    try {
      await db.insert(videoIndex).values({
        userId,
        youtubeId: `instagram:${item.id}`,
        title: item.caption?.substring(0, 100) || "Instagram Video",
        description: item.caption || "",
        viewCount: viewCounts[i] || 0,
        thumbnailUrl: cachedThumbnails[i],
        status: "Pending Scan",
        priorityScore: 50,
        publishedAt: item.timestamp ? new Date(item.timestamp) : new Date(),
        platform: "instagram",
        sourceUrl: item.permalink || null,
        category: cat.category,
        subcategory: cat.subcategory,
        isEvergreen: cat.isEvergreen,
      });
      imported++;
    } catch (error) {
      console.error(`[Graph API] Error importing Instagram media ${item.id}:`, error);
    }
  }

  console.log(`[Graph API] Imported ${imported} new Instagram videos/reels`);

  // Backfill: existing IG videos in the index that still hold a CDN URL or
  // null get their thumbnails re-cached now too. Cheap on subsequent syncs
  // because already-cached entries (URL on /storage/) are skipped.
  await refreshSocialThumbnails(userId, "instagram", media);

  return imported;
}

// Export for use in routes
export { importFacebookVideos, importInstagramMedia, importPersonalVideos };

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
                  displayName: profile.displayName,
                  accessToken: accessToken,  // Store for later sync
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
                  accessToken: accessToken,  // Store for later sync
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
                    displayName: profile.displayName,
                    accessToken: accessToken,  // Store for later sync
                  };
                  // Save session before calling done to ensure data persists
                  req.session.save((saveErr: any) => {
                    if (saveErr) {
                      console.error("[PlatformAuth] Session save error:", saveErr);
                    }
                    return done(null, googleUser);
                  });
                  return;  // Prevent fall-through
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
                    displayName: profile.displayName,
                    accessToken: accessToken,  // Store for later sync
                  };
                  // Save session before calling done to ensure data persists
                  req.session.save((saveErr: any) => {
                    if (saveErr) {
                      console.error("[PlatformAuth] Session save error:", saveErr);
                    }
                    return done(null, existingUser);
                  });
                  return;  // Prevent fall-through
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
    // KILL SWITCH for the window where Meta itself is refusing the flow.
    //
    // A creator clicking Connect while the Meta app is not Live — mid App
    // Review, or missing a required dashboard field — is bounced to Meta's own
    // wall: "Facebook Login is currently unavailable for this app, since we
    // are updating additional details for this app." That page says nothing
    // about FullScale, offers only a Reload button that fails identically, and
    // leaves the creator believing OUR product is broken. Every scope this
    // flow requests (pages_show_list, pages_read_engagement, read_insights,
    // instagram_basic, instagram_manage_insights) needs App Review, so this is
    // not a state we can code our way out of — but we can decline to send
    // people into it.
    //
    // Set META_CONNECT_ENABLED=false while the app is under review; unset it
    // (or "true") the moment Meta approves.
    if (process.env.META_CONNECT_ENABLED === "false") {
      console.log("[PlatformAuth] Facebook connect disabled by META_CONNECT_ENABLED");
      return res.redirect("/settings?connect=meta_unavailable");
    }
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
      // Request scopes for creator data access + analytics.
      //
      // We use Facebook Login (facebook.com/dialog/oauth) to access IG Business
      // Accounts via linked Pages. That flow uses the LEGACY scope names
      // (instagram_basic, instagram_manage_insights), NOT the new
      // instagram_business_* names.
      //
      // The instagram_business_* names are only valid for the Instagram Login
      // flow (instagram.com/oauth/authorize), which is a different OAuth
      // endpoint we do not use. Requesting them via Facebook Login causes
      // "Invalid Scopes" rejection from Meta.
      //
      // Reverted from commit 78623a3 which incorrectly applied the IG-Login
      // scope names to the FB-Login flow.
      //
      // Scopes:
      // - email, public_profile: basic identity
      // - pages_show_list: List of managed Pages
      // - pages_read_engagement: Page insights + IG Business Account discovery
      // - instagram_basic [App Review]: IG profile + media metadata
      // - instagram_manage_insights [App Review]: IG media insights (impressions,
      //   reach, plays for Reels, engagement). REQUIRED for analytics dashboard.
      passport.authenticate("facebook", {
        scope: [
          "email",
          "public_profile",
          "pages_show_list",            // List of managed Pages
          "pages_read_engagement",      // Page content/followers + IG Business Account discovery
          "read_insights",              // FB Page /insights edge (page views/reach/follows) [App Review]
          "instagram_basic",            // IG profile + media metadata [App Review]
          "instagram_manage_insights",  // IG analytics (views, reach, watch time, demographics) [App Review]
          "instagram_content_publish",  // Publish Reels via distribution scheduler [App Review]
        ],
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
        
        // SYNC: Update database with Facebook ID and token using multiple methods
        const googleEmail = req.session?.googleUser?.email || req.session?.pendingGoogleUser?.email;
        const facebookProfile = req.session?.facebookProfile;
        
        console.log("[PlatformAuth] Token sync attempt:");
        console.log("[PlatformAuth] - googleEmail:", googleEmail || "missing");
        console.log("[PlatformAuth] - facebookProfile.id:", facebookProfile?.id || "missing");
        console.log("[PlatformAuth] - facebookProfile.accessToken:", facebookProfile?.accessToken ? "present" : "missing");
        console.log("[PlatformAuth] - user.id:", user?.id || "missing");
        console.log("[PlatformAuth] - user.email:", user?.email || "missing");
        
        // Method 1: Use the user object from passport (already saved/updated in verify callback)
        // The user object already has the updated facebookId and token from the verify callback
        
        // Method 2: Update by googleEmail if available (cross-email linking)
        if (googleEmail && facebookProfile?.id) {
          try {
            const dbUser = await db.query.users.findFirst({
              where: eq(users.email, googleEmail),
            });
            if (dbUser) {
              const updateData: Record<string, any> = { 
                facebookId: facebookProfile.id 
              };
              
              // Also save the encrypted access token if available
              if (facebookProfile.accessToken) {
                updateData.facebookAccessToken = encrypt(facebookProfile.accessToken);
                console.log(`[PlatformAuth] Saving encrypted token for ${googleEmail}`);
              }
              
              await db
                .update(users)
                .set(updateData)
                .where(eq(users.id, dbUser.id));
              console.log(`[PlatformAuth] Auto-synced Facebook ID ${facebookProfile.id} to user ${googleEmail} (with token: ${!!facebookProfile.accessToken})`);
            } else {
              console.log(`[PlatformAuth] No user found with email ${googleEmail}`);
            }
          } catch (syncErr: any) {
            console.error("[PlatformAuth] Auto-sync error:", syncErr.message);
          }
        }
        
        // Method 3: Fallback - update the user returned by passport if they exist and have an email
        if (user?.id && facebookProfile?.accessToken) {
          try {
            const updateData: Record<string, any> = { 
              facebookId: facebookProfile.id 
            };
            if (facebookProfile.accessToken) {
              updateData.facebookAccessToken = encrypt(facebookProfile.accessToken);
            }
            await db
              .update(users)
              .set(updateData)
              .where(eq(users.id, user.id));
            console.log(`[PlatformAuth] Fallback: Updated user ${user.id} with Facebook token`);
          } catch (fallbackErr: any) {
            console.error("[PlatformAuth] Fallback update error:", fallbackErr.message);
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
          // facebook_connected triggers the Page-confirmation dialog: the
          // creator explicitly picks WHICH managed Page (and its linked IG
          // account) to connect — pages_show_list's allowed usage, shown.
          return res.redirect("/dashboard?facebook_connected=true");
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
    console.log("[Facebook Sync] Facebook profile id:", facebookProfile?.id);
    console.log("[Facebook Sync] Has access token:", !!facebookProfile?.accessToken);
    
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
      
      // Build update data
      const updateData: Record<string, any> = {
        facebookId: facebookProfile.id,
      };
      
      // Also save the encrypted access token if available
      if (facebookProfile.accessToken) {
        updateData.facebookAccessToken = encrypt(facebookProfile.accessToken);
        console.log("[Facebook Sync] Saving encrypted access token");
      }
      
      // Update user with Facebook data from session
      await db
        .update(users)
        .set(updateData)
        .where(eq(users.id, user.id));
      
      console.log("[Facebook Sync] Successfully synced Facebook connection");
      
      return res.json({
        success: true,
        message: "Facebook connection synced",
        facebookId: facebookProfile.id,
        displayName: facebookProfile.displayName,
        hasToken: !!facebookProfile.accessToken,
      });
    } catch (error: any) {
      console.error("[Facebook Sync] Error:", error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  // ── Page selection (creator confirms which Page to connect) ────────────
  // pages_show_list's allowed usage is literally "show a person the list of
  // Pages they manage and verify that a person manages a Page" — these two
  // endpoints implement exactly that: list the managed Pages (with linked IG
  // accounts) after OAuth, and commit the one the creator confirms.

  /** Resolve the logged-in user row + their decrypted FB USER token. */
  async function resolveFacebookUser(req: any): Promise<{ user: any; userToken: string } | { error: string; status: number }> {
    const email = req.session?.googleUser?.email || req.session?.pendingGoogleUser?.email || req.user?.claims?.email;
    const sessionUserId = req.session?.userId;
    let user: any = null;
    if (email) {
      user = await db.query.users.findFirst({ where: eq(users.email, email) });
    }
    if (!user && sessionUserId) {
      user = await db.query.users.findFirst({ where: eq(users.id, sessionUserId) });
    }
    if (!user) return { error: "Not authenticated", status: 401 };
    let userToken: string | null = null;
    if (user.facebookAccessToken) {
      try { userToken = decrypt(user.facebookAccessToken); } catch { userToken = null; }
    }
    // Session token from the just-completed OAuth is the freshest fallback.
    if (!userToken && req.session?.facebookProfile?.accessToken) {
      userToken = req.session.facebookProfile.accessToken;
    }
    if (!userToken) return { error: "Facebook not connected — connect Facebook first", status: 400 };
    return { user, userToken };
  }

  const PAGE_FIELDS = "id,name,fan_count,picture{url},access_token,instagram_business_account{id,username,followers_count,profile_picture_url}";

  /** Page IDs the user granted the app, straight from the token's granular
   *  scopes. The authoritative record of consent — /me/accounts sometimes
   *  returns [] even when Pages are plainly granted (observed live). */
  async function fetchGrantedPageIds(userToken: string): Promise<string[]> {
    try {
      const dbgRes = await fetch(`https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(userToken)}&access_token=${encodeURIComponent(userToken)}`);
      const dbg: any = await dbgRes.json();
      const ids = new Set<string>();
      for (const g of dbg?.data?.granular_scopes ?? []) {
        if (g.scope === "pages_show_list" || g.scope === "pages_read_engagement") {
          for (const t of g.target_ids ?? []) ids.add(String(t));
        }
      }
      return Array.from(ids);
    } catch {
      return [];
    }
  }

  /** Fetch the user's managed Pages with linked IG accounts (server-side).
   *  Primary: /me/accounts. Fallback: granular-scope page ids fetched
   *  individually — the same mechanism that finds directly-shared IG
   *  accounts, and immune to /me/accounts' granular-consent flakiness. */
  async function fetchManagedPages(userToken: string): Promise<any[]> {
    const url = `https://graph.facebook.com/v25.0/me/accounts?fields=${PAGE_FIELDS}&limit=25&access_token=${encodeURIComponent(userToken)}`;
    const res = await fetch(url);
    const data: any = await res.json();
    if (data.error) throw new Error(data.error.message || "Failed to list Pages");
    const viaMeAccounts: any[] = data.data ?? [];
    if (viaMeAccounts.length > 0) return viaMeAccounts;

    // /me/accounts says none — cross-check the actual grant.
    const grantedIds = await fetchGrantedPageIds(userToken);
    console.log(`[PlatformAuth] /me/accounts returned 0 pages; granular scopes grant ${grantedIds.length} page id(s)`);
    const pages: any[] = [];
    for (const pageId of grantedIds) {
      try {
        const pRes = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(pageId)}?fields=${PAGE_FIELDS}&access_token=${encodeURIComponent(userToken)}`);
        const p: any = await pRes.json();
        if (p?.id && !p.error) pages.push(p);
      } catch { /* skip page */ }
    }
    return pages;
  }

  /** IG accounts the user shared with the app DIRECTLY (no Page asset) —
   *  derived from the token's granular scopes. Common consent outcome: the
   *  user checks IG accounts on Meta's Instagram screen but skips the Pages
   *  screen, so /me/accounts is empty while IG access is fully granted. */
  async function fetchDirectIgAccounts(userToken: string): Promise<any[]> {
    try {
      const dbgRes = await fetch(`https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(userToken)}&access_token=${encodeURIComponent(userToken)}`);
      const dbg: any = await dbgRes.json();
      const igIds = new Set<string>();
      for (const g of dbg?.data?.granular_scopes ?? []) {
        if (g.scope === "instagram_basic" || g.scope === "instagram_manage_insights") {
          for (const t of g.target_ids ?? []) igIds.add(String(t));
        }
      }
      const out: any[] = [];
      for (const igId of Array.from(igIds)) {
        try {
          const igRes = await fetch(`https://graph.facebook.com/v25.0/${igId}?fields=username,followers_count,profile_picture_url&access_token=${encodeURIComponent(userToken)}`);
          const ig: any = await igRes.json();
          if (ig?.username) {
            out.push({ id: igId, handle: `@${ig.username}`, followers: ig.followers_count ?? 0, pictureUrl: ig.profile_picture_url ?? null });
          }
        } catch { /* skip account */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  // List the creator's managed Pages — NO tokens in the response. When no
  // Pages were shared, fall back to directly-shared IG accounts so the
  // connect flow doesn't dead-end (Page insights stay unavailable until a
  // Page is actually shared, and the UI says so).
  app.get("/api/facebook/pages", async (req: any, res) => {
    try {
      const resolved = await resolveFacebookUser(req);
      if ("error" in resolved) return res.status(resolved.status).json({ error: resolved.error });
      const pages = await fetchManagedPages(resolved.userToken);
      const igOnly = pages.length === 0 ? await fetchDirectIgAccounts(resolved.userToken) : [];
      res.json({
        currentPageId: resolved.user.facebookPageId ?? null,
        pages: pages.map((p: any) => ({
          pageId: p.id,
          name: p.name,
          followers: p.fan_count ?? 0,
          pictureUrl: p.picture?.data?.url ?? null,
          instagram: p.instagram_business_account
            ? {
                id: p.instagram_business_account.id,
                handle: p.instagram_business_account.username ? `@${p.instagram_business_account.username}` : null,
                followers: p.instagram_business_account.followers_count ?? 0,
                pictureUrl: p.instagram_business_account.profile_picture_url ?? null,
              }
            : null,
        })),
        igOnly,
      });
    } catch (err: any) {
      console.error("[PlatformAuth] /api/facebook/pages error:", err.message);
      res.status(500).json({ error: err.message || "Failed to list Pages" });
    }
  });

  // Commit the confirmed Page. The pageId is re-verified server-side by a
  // direct GET on the Page with the caller's token — a creator can only
  // connect a Page they manage, and this works past the 25-Page list cap.
  app.post("/api/facebook/select-page", async (req: any, res) => {
    try {
      const resolved = await resolveFacebookUser(req);
      if ("error" in resolved) return res.status(resolved.status).json({ error: resolved.error });
      const { user, userToken } = resolved;

      // Instagram-only connect: the user shared IG accounts but no Page.
      // Verified against the token's own granular scopes — a stranger's IG
      // id won't be among the target_ids of THIS user's grant.
      const igAccountId = String(req.body?.igAccountId || "");
      if (igAccountId) {
        const direct = await fetchDirectIgAccounts(userToken);
        const ig = direct.find((d) => String(d.id) === igAccountId);
        if (!ig) return res.status(403).json({ error: "That Instagram account wasn't shared with FullScale" });

        await db.update(users).set({
          instagramBusinessId: ig.id,
          instagramHandle: ig.handle,
          instagramFollowers: ig.followers ?? 0,
          updatedAt: new Date(),
        }).where(eq(users.id, user.id));

        const { storage } = await import("../storage");
        await storage.replaceMetaSocialAccounts(user.id);
        await storage.upsertSocialAccount({
          userId: user.id,
          platform: "instagram",
          accountType: "business",
          platformAccountId: ig.id,
          handle: ig.handle,
          displayName: ig.handle,
          avatarUrl: ig.pictureUrl ?? null,
          followers: ig.followers ?? 0,
          accessToken: userToken,
          scopes: ["instagram_basic", "instagram_manage_insights"],
        });

        console.log(`[PlatformAuth] User ${user.id} connected IG-only account ${ig.handle} (no Page shared)`);
        return res.json({ success: true, page: null, instagram: { id: ig.id, handle: ig.handle, followers: ig.followers ?? 0 } });
      }

      const pageId = String(req.body?.pageId || "");
      if (!pageId) return res.status(400).json({ error: "pageId required" });

      // Direct verify: fetch THIS page with the user token. Non-managed
      // pages error or omit access_token, so a stranger's page can't pass.
      const vRes = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(pageId)}?fields=id,name,fan_count,picture{url},access_token,instagram_business_account{id,username,followers_count,profile_picture_url}&access_token=${encodeURIComponent(userToken)}`);
      const page: any = await vRes.json();
      if (page?.error || !page?.id || !page?.access_token) {
        return res.status(403).json({ error: "You don't manage that Page" });
      }

      const ig = page.instagram_business_account ?? null;
      const pageToken: string = page.access_token; // page token: required by the Page /insights edge

      await db.update(users).set({
        facebookPageId: page.id,
        facebookPageName: page.name,
        facebookFollowers: page.fan_count ?? 0,
        instagramBusinessId: ig?.id ?? null,
        instagramHandle: ig?.username ? `@${ig.username}` : null,
        instagramFollowers: ig?.followers_count ?? 0,
        updatedAt: new Date(),
      }).where(eq(users.id, user.id));

      // Mirror into social_accounts so analytics + snapshots pick them up.
      // Replace any previously-selected Page/IG rows for this user so the
      // snapshot cron doesn't keep polling a Page they've switched away from.
      const { storage } = await import("../storage");
      await storage.replaceMetaSocialAccounts(user.id);

      const scopes = ["pages_show_list", "pages_read_engagement", "read_insights", "instagram_basic", "instagram_manage_insights"];
      // FB row → PAGE token (Page /insights rejects user tokens).
      await storage.upsertSocialAccount({
        userId: user.id,
        platform: "facebook",
        accountType: "business",
        platformAccountId: page.id,
        handle: page.name,
        displayName: page.name,
        avatarUrl: page.picture?.data?.url ?? null,
        followers: page.fan_count ?? 0,
        accessToken: pageToken,
        scopes,
      });
      if (ig?.id) {
        // IG row → USER token: the IG-insights consumers (backfill,
        // refresh-analytics, snapshot job) all read with the user token.
        await storage.upsertSocialAccount({
          userId: user.id,
          platform: "instagram",
          accountType: "business",
          platformAccountId: ig.id,
          handle: ig.username ? `@${ig.username}` : null,
          displayName: ig.username ? `@${ig.username}` : null,
          avatarUrl: ig.profile_picture_url ?? null,
          followers: ig.followers_count ?? 0,
          accessToken: userToken,
          scopes,
        });
      }

      console.log(`[PlatformAuth] User ${user.id} confirmed Page ${page.id} (${page.name})${ig ? ` + IG ${ig.username}` : ""}`);
      res.json({
        success: true,
        page: { pageId: page.id, name: page.name, followers: page.fan_count ?? 0 },
        instagram: ig ? { id: ig.id, handle: ig.username ? `@${ig.username}` : null, followers: ig.followers_count ?? 0 } : null,
      });
    } catch (err: any) {
      console.error("[PlatformAuth] /api/facebook/select-page error:", err.message);
      res.status(500).json({ error: err.message || "Failed to connect Page" });
    }
  });

  // NOTE: Facebook debug endpoints (test-fb-update, facebook-session,
  // fb-insights-test) were REMOVED for security. They decrypted and returned
  // users' Facebook/Instagram access tokens in the HTTP response and were
  // reachable via an ungated ?admin_email= param, allowing token exfiltration
  // for any creator whose email an attacker knew. They served their diagnostic
  // purpose during the FB/IG analytics bring-up and are no longer needed.


  // Disconnect Facebook - clears Facebook and Instagram data
  app.delete("/api/auth/facebook", async (req: any, res) => {
    const googleUser = req.session?.googleUser;
    const replitUser = req.user?.claims;
    const adminEmail = process.env.NODE_ENV !== 'production' ? req.query.admin_email : null;
    
    const userEmail = googleUser?.email || replitUser?.email || adminEmail;
    
    if (!userEmail) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.email, userEmail),
      });
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Clear Facebook and Instagram fields
      await db.update(users).set({
        facebookId: null,
        facebookPageId: null,
        facebookPageName: null,
        facebookFollowers: null,
        facebookAccessToken: null,
        instagramBusinessId: null,
        instagramHandle: null,
        instagramFollowers: null,
      }).where(eq(users.id, user.id));

      // Remove the mirrored social_accounts rows (+ their snapshots) so the
      // analytics job stops polling, and drop the session token fallback so
      // the Page endpoints don't keep working post-disconnect.
      try {
        const { storage } = await import("../storage");
        await storage.replaceMetaSocialAccounts(user.id);
      } catch (e: any) {
        console.warn("[Facebook Disconnect] social_accounts cleanup failed:", e?.message);
      }

      // Clear session data
      if (req.session?.facebookProfile) {
        delete req.session.facebookProfile;
      }
      req.session.facebookConnected = false;
      
      console.log("[Facebook Disconnect] Cleared Facebook/Instagram data for:", userEmail);
      res.json({ success: true });
    } catch (error) {
      console.error("[Facebook Disconnect] Error:", error);
      res.status(500).json({ error: "Failed to disconnect Facebook" });
    }
  });

  // Disconnect Twitch
  app.delete("/api/auth/twitch", async (req: any, res) => {
    const googleUser = req.session?.googleUser;
    const replitUser = req.user?.claims;
    const adminEmail = process.env.NODE_ENV !== 'production' ? req.query.admin_email : null;
    
    const userEmail = googleUser?.email || replitUser?.email || adminEmail;
    
    if (!userEmail) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.email, userEmail),
      });
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Clear Twitch field
      await db.update(users).set({
        twitchId: null,
      }).where(eq(users.id, user.id));
      
      console.log("[Twitch Disconnect] Cleared Twitch data for:", userEmail);
      res.json({ success: true });
    } catch (error) {
      console.error("[Twitch Disconnect] Error:", error);
      res.status(500).json({ error: "Failed to disconnect Twitch" });
    }
  });

  console.log("[PlatformAuth] Platform auth routes registered");
}
