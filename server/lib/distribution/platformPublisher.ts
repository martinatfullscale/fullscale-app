/**
 * Platform Publisher — Multi-Platform Video Distribution Engine
 *
 * Handles uploading generated clips to social media platforms via their APIs.
 * Each platform has its own adapter with upload, status check, and delete capabilities.
 *
 * Supported platforms:
 * - TikTok (TikTok Content Posting API)
 * - Instagram Reels (Instagram Graph API)
 * - YouTube Shorts (YouTube Data API v3)
 * - Twitter/X (Twitter API v2)
 * - LinkedIn (LinkedIn Marketing API)
 *
 * All adapters follow the same interface for consistent orchestration.
 */

import * as fs from "fs";
import * as path from "path";

export interface PublishInput {
  /** Path to the clip file on disk */
  clipPath: string;
  /** Caption/description text */
  caption: string;
  /** Hashtags */
  hashtags: string[];
  /** Platform access token */
  accessToken: string;
  /** Platform-specific account ID */
  accountId: string;
  /** Platform-specific metadata */
  metadata?: Record<string, any>;
}

export interface PublishResult {
  success: boolean;
  /** Platform's post/video ID */
  platformPostId: string | null;
  /** Public URL of the post */
  postUrl: string | null;
  error?: string;
}

export interface PlatformAdapter {
  platform: string;
  publish(input: PublishInput): Promise<PublishResult>;
  getPostStatus(postId: string, accessToken: string): Promise<{ status: string; url?: string }>;
  deletePost(postId: string, accessToken: string): Promise<boolean>;
}

// ─── TikTok Adapter ──────────────────────────────────────────────

class TikTokAdapter implements PlatformAdapter {
  platform = "tiktok";
  private baseUrl = "https://open.tiktokapis.com/v2";

  async publish(input: PublishInput): Promise<PublishResult> {
    try {
      // Step 1: Initialize upload
      const initRes = await fetch(`${this.baseUrl}/post/publish/inbox/video/init/`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source_info: {
            source: "FILE_UPLOAD",
            video_size: fs.statSync(input.clipPath).size,
            chunk_size: fs.statSync(input.clipPath).size,
            total_chunk_count: 1,
          },
          post_info: {
            title: input.caption.slice(0, 150),
            // Overridable per profile (metadata.privacyLevel); SELF_ONLY
            // posts are visible only to the creator — the safe test mode.
            privacy_level: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"].includes(input.metadata?.privacyLevel)
              ? input.metadata!.privacyLevel
              : "PUBLIC_TO_EVERYONE",
            disable_duet: false,
            disable_stitch: false,
            disable_comment: false,
          },
        }),
      });

      if (!initRes.ok) {
        const err = await initRes.text();
        return { success: false, platformPostId: null, postUrl: null, error: `TikTok init failed: ${err}` };
      }

      const initData = await initRes.json();
      const uploadUrl = initData.data?.upload_url;
      const publishId = initData.data?.publish_id;

      if (!uploadUrl || !publishId) {
        return { success: false, platformPostId: null, postUrl: null, error: "TikTok: no upload URL received" };
      }

      // Step 2: Upload video binary
      const videoBuffer = fs.readFileSync(input.clipPath);
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
        },
        body: videoBuffer,
      });

      if (!uploadRes.ok) {
        return { success: false, platformPostId: null, postUrl: null, error: `TikTok upload failed: ${uploadRes.status}` };
      }

      console.log(`[TikTok] Published: ${publishId}`);
      return {
        success: true,
        platformPostId: publishId,
        postUrl: null, // TikTok doesn't return URL immediately — need to poll
      };
    } catch (err: any) {
      return { success: false, platformPostId: null, postUrl: null, error: err.message };
    }
  }

  async getPostStatus(postId: string, accessToken: string) {
    try {
      const res = await fetch(`${this.baseUrl}/post/publish/status/fetch/`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ publish_id: postId }),
      });
      const data = await res.json();
      return {
        status: data.data?.status || "unknown",
        url: data.data?.public_url,
      };
    } catch {
      return { status: "unknown" };
    }
  }

  async deletePost(postId: string, accessToken: string): Promise<boolean> {
    // TikTok Content Posting API doesn't support deletion — return false
    return false;
  }
}

// ─── YouTube Adapter ─────────────────────────────────────────────

class YouTubeAdapter implements PlatformAdapter {
  platform = "youtube";
  private baseUrl = "https://www.googleapis.com/upload/youtube/v3/videos";

  async publish(input: PublishInput): Promise<PublishResult> {
    try {
      const videoBuffer = fs.readFileSync(input.clipPath);
      const description = [input.caption, "", input.hashtags.map(h => `#${h}`).join(" ")].join("\n").trim();

      // Resumable upload: Step 1 — initiate
      const initRes = await fetch(
        `${this.baseUrl}?uploadType=resumable&part=snippet,status`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${input.accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": videoBuffer.length.toString(),
            "X-Upload-Content-Type": "video/mp4",
          },
          body: JSON.stringify({
            snippet: {
              title: input.caption.slice(0, 100),
              description,
              tags: input.hashtags.slice(0, 30),
              categoryId: "22", // People & Blogs
            },
            status: {
              // Overridable per profile (metadata.privacyStatus) so tests
              // and cautious creators can land uploads as private/unlisted.
              privacyStatus: ["public", "unlisted", "private"].includes(input.metadata?.privacyStatus)
                ? input.metadata!.privacyStatus
                : "public",
              selfDeclaredMadeForKids: false,
              madeForKids: false,
            },
          }),
        }
      );

      if (!initRes.ok) {
        const err = await initRes.text();
        return { success: false, platformPostId: null, postUrl: null, error: `YouTube init failed: ${err}` };
      }

      const uploadUrl = initRes.headers.get("location");
      if (!uploadUrl) {
        return { success: false, platformPostId: null, postUrl: null, error: "YouTube: no upload URL" };
      }

      // Step 2 — upload binary
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4" },
        body: videoBuffer,
      });

      if (!uploadRes.ok) {
        return { success: false, platformPostId: null, postUrl: null, error: `YouTube upload failed: ${uploadRes.status}` };
      }

      const data = await uploadRes.json();
      const videoId = data.id;

      console.log(`[YouTube] Published: ${videoId}`);
      return {
        success: true,
        platformPostId: videoId,
        postUrl: `https://youtube.com/shorts/${videoId}`,
      };
    } catch (err: any) {
      return { success: false, platformPostId: null, postUrl: null, error: err.message };
    }
  }

  async getPostStatus(postId: string, accessToken: string) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=status&id=${postId}`,
        { headers: { "Authorization": `Bearer ${accessToken}` } }
      );
      const data = await res.json();
      const status = data.items?.[0]?.status?.uploadStatus || "unknown";
      return {
        status,
        url: `https://youtube.com/shorts/${postId}`,
      };
    } catch {
      return { status: "unknown" };
    }
  }

  async deletePost(postId: string, accessToken: string): Promise<boolean> {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?id=${postId}`,
        {
          method: "DELETE",
          headers: { "Authorization": `Bearer ${accessToken}` },
        }
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ─── Instagram Adapter ───────────────────────────────────────────

class InstagramAdapter implements PlatformAdapter {
  platform = "instagram";
  private baseUrl = "https://graph.facebook.com/v19.0";

  async publish(input: PublishInput): Promise<PublishResult> {
    try {
      // Instagram's Graph API pulls the video from a URL rather than
      // accepting an upload — the clip must be publicly reachable.
      // Publishers inject metadata.publicVideoUrl from the clip's public
      // exportPath before calling this adapter.
      if (!input.metadata?.publicVideoUrl) {
        return { success: false, platformPostId: null, postUrl: null, error: "Instagram requires a publicly hosted video URL (metadata.publicVideoUrl)" };
      }
      const caption = [input.caption, "", input.hashtags.map(h => `#${h}`).join(" ")].join("\n").trim();

      // Step 1: Create container
      const containerRes = await fetch(
        `${this.baseUrl}/${input.accountId}/media`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            media_type: "REELS",
            video_url: input.metadata?.publicVideoUrl || "",
            caption,
            access_token: input.accessToken,
          }),
        }
      );

      if (!containerRes.ok) {
        const err = await containerRes.text();
        return { success: false, platformPostId: null, postUrl: null, error: `Instagram container failed: ${err}` };
      }

      const containerData = await containerRes.json();
      const containerId = containerData.id;

      // Step 2: Wait for the container to finish processing. Reels
      // containers ingest the video asynchronously; publishing before
      // status FINISHED fails with "Media ID is not available".
      let containerReady = false;
      for (let attempt = 0; attempt < 18; attempt++) {
        const statusRes = await fetch(
          `${this.baseUrl}/${containerId}?fields=status_code&access_token=${input.accessToken}`
        );
        const statusData = await statusRes.json();
        if (statusData.status_code === "FINISHED") { containerReady = true; break; }
        if (statusData.status_code === "ERROR") {
          return { success: false, platformPostId: null, postUrl: null, error: "Instagram container processing failed" };
        }
        await new Promise(r => setTimeout(r, 5000));
      }
      if (!containerReady) {
        return { success: false, platformPostId: null, postUrl: null, error: "Instagram container not ready after 90s" };
      }

      // Step 3: Publish container
      const publishRes = await fetch(
        `${this.baseUrl}/${input.accountId}/media_publish`,
        {
          method: "POST",
          body: JSON.stringify({
            creation_id: containerId,
            access_token: input.accessToken,
          }),
        }
      );

      if (!publishRes.ok) {
        return { success: false, platformPostId: null, postUrl: null, error: "Instagram publish failed" };
      }

      const publishData = await publishRes.json();
      console.log(`[Instagram] Published: ${publishData.id}`);

      return {
        success: true,
        platformPostId: publishData.id,
        postUrl: `https://www.instagram.com/reel/${publishData.id}/`,
      };
    } catch (err: any) {
      return { success: false, platformPostId: null, postUrl: null, error: err.message };
    }
  }

  async getPostStatus(postId: string, accessToken: string) {
    try {
      const res = await fetch(
        `${this.baseUrl}/${postId}?fields=id,media_type,permalink,timestamp&access_token=${accessToken}`
      );
      const data = await res.json();
      return {
        status: data.id ? "published" : "unknown",
        url: data.permalink,
      };
    } catch {
      return { status: "unknown" };
    }
  }

  async deletePost(postId: string, accessToken: string): Promise<boolean> {
    // Instagram Graph API doesn't support deletion
    return false;
  }
}

// ─── Twitter/X Adapter ───────────────────────────────────────────

class TwitterAdapter implements PlatformAdapter {
  platform = "twitter";
  private baseUrl = "https://api.twitter.com/2";
  private uploadUrl = "https://upload.twitter.com/1.1";

  async publish(input: PublishInput): Promise<PublishResult> {
    try {
      const videoBuffer = fs.readFileSync(input.clipPath);

      // Step 1: INIT
      const initRes = await fetch(`${this.uploadUrl}/media/upload.json`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${input.accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          command: "INIT",
          total_bytes: videoBuffer.length.toString(),
          media_type: "video/mp4",
          media_category: "tweet_video",
        }),
      });

      if (!initRes.ok) {
        return { success: false, platformPostId: null, postUrl: null, error: "Twitter INIT failed" };
      }

      const initData = await initRes.json();
      const mediaId = initData.media_id_string;

      // Step 2: APPEND (single chunk for small files)
      const formData = new FormData();
      formData.append("command", "APPEND");
      formData.append("media_id", mediaId);
      formData.append("segment_index", "0");
      formData.append("media_data", videoBuffer.toString("base64"));

      await fetch(`${this.uploadUrl}/media/upload.json`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${input.accessToken}` },
        body: formData,
      });

      // Step 3: FINALIZE
      await fetch(`${this.uploadUrl}/media/upload.json`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${input.accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ command: "FINALIZE", media_id: mediaId }),
      });

      // Step 4: Create tweet
      const text = [input.caption, input.hashtags.map(h => `#${h}`).join(" ")].join("\n\n").trim();

      const tweetRes = await fetch(`${this.baseUrl}/tweets`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: text.slice(0, 280),
          media: { media_ids: [mediaId] },
        }),
      });

      if (!tweetRes.ok) {
        return { success: false, platformPostId: null, postUrl: null, error: "Twitter tweet creation failed" };
      }

      const tweetData = await tweetRes.json();
      const tweetId = tweetData.data?.id;
      console.log(`[Twitter] Published: ${tweetId}`);

      return {
        success: true,
        platformPostId: tweetId,
        postUrl: `https://twitter.com/i/status/${tweetId}`,
      };
    } catch (err: any) {
      return { success: false, platformPostId: null, postUrl: null, error: err.message };
    }
  }

  async getPostStatus(postId: string, accessToken: string) {
    try {
      const res = await fetch(`${this.baseUrl}/tweets/${postId}`, {
        headers: { "Authorization": `Bearer ${accessToken}` },
      });
      const data = await res.json();
      return {
        status: data.data?.id ? "published" : "unknown",
        url: `https://twitter.com/i/status/${postId}`,
      };
    } catch {
      return { status: "unknown" };
    }
  }

  async deletePost(postId: string, accessToken: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/tweets/${postId}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${accessToken}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ─── LinkedIn Adapter ────────────────────────────────────────────

class LinkedInAdapter implements PlatformAdapter {
  platform = "linkedin";
  private baseUrl = "https://api.linkedin.com/v2";

  async publish(input: PublishInput): Promise<PublishResult> {
    try {
      const videoBuffer = fs.readFileSync(input.clipPath);

      // Step 1: Register upload
      const registerRes = await fetch(`${this.baseUrl}/assets?action=registerUpload`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          registerUploadRequest: {
            recipes: ["urn:li:digitalmediaRecipe:feedshare-video"],
            owner: `urn:li:person:${input.accountId}`,
            serviceRelationships: [{
              relationshipType: "OWNER",
              identifier: "urn:li:userGeneratedContent",
            }],
          },
        }),
      });

      if (!registerRes.ok) {
        return { success: false, platformPostId: null, postUrl: null, error: "LinkedIn register failed" };
      }

      const registerData = await registerRes.json();
      const uploadUrl = registerData.value?.uploadMechanism?.["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]?.uploadUrl;
      const asset = registerData.value?.asset;

      if (!uploadUrl || !asset) {
        return { success: false, platformPostId: null, postUrl: null, error: "LinkedIn: no upload URL" };
      }

      // Step 2: Upload binary
      await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${input.accessToken}`,
          "Content-Type": "application/octet-stream",
        },
        body: videoBuffer,
      });

      // Step 3: Create share
      const text = [input.caption, "", input.hashtags.map(h => `#${h}`).join(" ")].join("\n").trim();

      const shareRes = await fetch(`${this.baseUrl}/ugcPosts`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          author: `urn:li:person:${input.accountId}`,
          lifecycleState: "PUBLISHED",
          specificContent: {
            "com.linkedin.ugc.ShareContent": {
              shareCommentary: { text },
              shareMediaCategory: "VIDEO",
              media: [{ status: "READY", media: asset }],
            },
          },
          visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
        }),
      });

      if (!shareRes.ok) {
        return { success: false, platformPostId: null, postUrl: null, error: "LinkedIn share creation failed" };
      }

      const shareData = await shareRes.json();
      const shareId = shareData.id;
      console.log(`[LinkedIn] Published: ${shareId}`);

      return {
        success: true,
        platformPostId: shareId,
        postUrl: null, // LinkedIn doesn't return direct URL
      };
    } catch (err: any) {
      return { success: false, platformPostId: null, postUrl: null, error: err.message };
    }
  }

  async getPostStatus(postId: string, accessToken: string) {
    return { status: "published" }; // LinkedIn doesn't have a simple status endpoint
  }

  async deletePost(postId: string, accessToken: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/ugcPosts/${postId}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${accessToken}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ─── Adapter Registry ────────────────────────────────────────────

const adapters: Record<string, PlatformAdapter> = {
  tiktok: new TikTokAdapter(),
  youtube: new YouTubeAdapter(),
  youtube_shorts: new YouTubeAdapter(),
  instagram: new InstagramAdapter(),
  instagram_reels: new InstagramAdapter(),
  twitter: new TwitterAdapter(),
  linkedin: new LinkedInAdapter(),
};

export function getAdapter(platform: string): PlatformAdapter | null {
  return adapters[platform] || null;
}

export function getSupportedPlatforms(): string[] {
  return Object.keys(adapters);
}

/**
 * Resolve the access token to publish with, at publish time. Stored tokens
 * are typically stale by the time a scheduled post fires, so each platform
 * resolves from its live source where possible:
 * - youtube*   → fresh token from the creator's YouTube connection
 *                (profile.metadata.youtubeUserId), auto-refreshed
 * - instagram* → the user's current Facebook token (metadata.igUserKey),
 *                decrypted from the users row the FB Login flow maintains
 * - tiktok / twitter → refresh-token grant when near/past expiry
 *                (rotated tokens are persisted back to the profile)
 * - linkedin   → stored token only (no self-serve refresh; ~60-day life)
 * Falls back to the stored profile token in every case.
 */
export async function resolvePublishAccessToken(profile: {
  id?: number;
  platform: string;
  accessToken: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: Date | string | null;
  metadata?: Record<string, any> | null;
}): Promise<string | null> {
  if (profile.platform.startsWith("youtube")) {
    const ytUserId = profile.metadata?.youtubeUserId;
    if (ytUserId) {
      const { getFreshYoutubeTokenForUser } = await import("../youtubeAuth");
      const fresh = await getFreshYoutubeTokenForUser(String(ytUserId));
      if (fresh) return fresh;
    }
  }

  if (profile.platform.startsWith("instagram")) {
    const igUserKey = profile.metadata?.igUserKey;
    if (igUserKey) {
      try {
        const { storage } = await import("../../storage");
        const { decrypt } = await import("../../encryption");
        const user = await storage.getUserByEmail(String(igUserKey));
        if (user?.facebookAccessToken) {
          const tok = decrypt(user.facebookAccessToken);
          if (tok) return tok;
        }
      } catch (err: any) {
        console.error("[Publisher] Instagram token resolution failed, using stored token:", err.message);
      }
    }
  }

  if ((profile.platform === "tiktok" || profile.platform === "twitter") && profile.id) {
    const expiresAt = profile.tokenExpiresAt ? new Date(profile.tokenExpiresAt).getTime() : null;
    const nearExpiry = expiresAt !== null && expiresAt < Date.now() + 60_000;
    if (nearExpiry && profile.refreshToken) {
      const { refreshTikTokToken, refreshTwitterToken } = await import("./platformConnect");
      const fresh = profile.platform === "tiktok"
        ? await refreshTikTokToken(profile as { id: number; refreshToken: string })
        : await refreshTwitterToken(profile as { id: number; refreshToken: string });
      if (fresh) return fresh;
    }
  }

  return profile.accessToken || null;
}

/**
 * Publish a clip to a platform using the appropriate adapter.
 */
export async function publishToPlaftorm(
  platform: string,
  input: PublishInput
): Promise<PublishResult> {
  const adapter = getAdapter(platform);
  if (!adapter) {
    return { success: false, platformPostId: null, postUrl: null, error: `Unsupported platform: ${platform}` };
  }

  // PUBLISH_DRY_RUN=true exercises the whole pipeline — schedule pickup,
  // clip resolution, caption formatting, status transitions — but stops
  // here and logs what would have been sent instead of calling the
  // platform API.
  if (process.env.PUBLISH_DRY_RUN === "true") {
    const clipBytes = fs.existsSync(input.clipPath) ? fs.statSync(input.clipPath).size : -1;
    console.log(`[Publisher] DRY RUN — would publish to ${platform}: ${JSON.stringify({
      clipPath: input.clipPath,
      clipBytes,
      caption: input.caption.slice(0, 120),
      hashtagCount: input.hashtags.length,
      accountId: input.accountId,
      tokenSuffix: input.accessToken ? input.accessToken.slice(-4) : null,
      metadata: input.metadata || {},
    })}`);
    return { success: true, platformPostId: `dryrun-${Date.now()}`, postUrl: null };
  }

  console.log(`[Publisher] Publishing to ${platform}...`);
  const result = await adapter.publish(input);

  if (result.success) {
    console.log(`[Publisher] Published to ${platform}: ${result.platformPostId}`);
  } else {
    console.error(`[Publisher] Failed on ${platform}: ${result.error}`);
  }

  return result;
}
