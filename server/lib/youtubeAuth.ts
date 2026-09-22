// Shared YouTube OAuth token helper. Resolves a fresh access_token for a
// given user, refreshing via the stored refresh_token if expired. Used by
// scanner downloads and player streaming to make authenticated requests
// to YouTube — bypasses bot-detection that hits anonymous yt-dlp on some
// videos ("Sign in to confirm you're not a bot").
//
// The token is the SAME one we already store via the YouTube OAuth flow
// (youtube_connections table). For the creator's own videos this is
// legally + technically clean: an authenticated user accessing their
// own content via Google's APIs.

import { storage } from "../storage";

async function refreshAccessToken(
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number } | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Returns a fresh OAuth access token for the user's YouTube connection,
 *  or null if no connection exists or refresh fails. */
export async function getFreshYoutubeTokenForUser(userId: string): Promise<string | null> {
  let connection = await storage.getYoutubeConnection(userId);
  if (!connection) {
    const user = await storage.getUserById(userId);
    if (user?.email && user.email !== userId) {
      connection = await storage.getYoutubeConnection(user.email);
    }
  }
  if (!connection) return null;

  let accessToken = connection.accessToken;

  if (connection.expiresAt && new Date(connection.expiresAt) < new Date()) {
    if (!connection.refreshToken) return null;
    const refreshed = await refreshAccessToken(connection.refreshToken);
    if (!refreshed) return null;
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

  return accessToken;
}
