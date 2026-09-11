/**
 * Instagram Login — connecting WITHOUT a Facebook Page.
 *
 * The existing Meta flow goes through Facebook: the creator must own a
 * Facebook Page, link an Instagram Business account to it, and grant
 * pages_show_list / pages_read_engagement so we can discover the IG account
 * through the Page. That is the only flow this product had, and it quietly
 * excluded a large share of creators — anyone with an Instagram Creator
 * account and no Page, anyone who does not use Facebook at all, anyone who
 * never linked the two. They could not connect, and the failure looked like a
 * bug rather than a requirement nobody told them about.
 *
 * Instagram Login is Meta's separate OAuth at instagram.com/oauth/authorize.
 * It works for any Instagram PROFESSIONAL account — Business *or* Creator —
 * with no Facebook Page anywhere in the picture, and it uses the newer
 * instagram_business_* permission family rather than the Page-linked one.
 *
 * WHAT IT STILL CANNOT DO, so nobody promises it: a fully personal Instagram
 * account has no insights API at all. Meta retired the Basic Display API in
 * December 2024, and nothing replaced it. Switching to a Creator account is
 * free, instant, reversible, and keeps every follower and post — so that is
 * the honest ask, and the connect UI should say so rather than failing
 * silently.
 *
 * Credentials are the INSTAGRAM app's, not the Facebook app's: Dashboard →
 * Instagram → API setup with Instagram login → Instagram app ID / secret.
 * Different values from FACEBOOK_APP_ID, which is why they get their own env
 * names. Unset, this whole module is inert and /auth/instagram reports that
 * plainly instead of half-working.
 */

import { keyValue } from "./envKeys";

const AUTH_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const LONG_LIVED_URL = "https://graph.instagram.com/access_token";
const GRAPH = "https://graph.instagram.com/v21.0";

/** Read scopes only. Publishing is requested separately, when a creator opts in. */
const SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"];

export interface InstagramLoginConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export function instagramLoginConfig(baseUrl: string): InstagramLoginConfig | null {
  const appId = keyValue(["INSTAGRAM_APP_ID", "IG_APP_ID"]);
  const appSecret = keyValue(["INSTAGRAM_APP_SECRET", "IG_APP_SECRET"]);
  if (!appId || !appSecret) return null;
  return { appId, appSecret, redirectUri: `${baseUrl}/auth/instagram/callback` };
}

export function authorizeUrl(cfg: InstagramLoginConfig, state: string): string {
  const p = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: SCOPES.join(","),
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export interface InstagramProfile {
  igUserId: string;
  username: string | null;
  followers: number;
  mediaCount: number;
  accountType: string | null;
  profilePictureUrl: string | null;
  /** Long-lived, ~60 days. Refreshable while it is still valid. */
  accessToken: string;
  expiresInSec: number;
}

/**
 * Code → long-lived token → profile.
 *
 * Two token exchanges, not one: Instagram issues a SHORT-lived token (1 hour)
 * from the code, and it must be traded for a long-lived one immediately or the
 * connection dies within the hour and the creator reconnects for no visible
 * reason.
 */
export async function exchangeCode(cfg: InstagramLoginConfig, code: string): Promise<InstagramProfile> {
  const form = new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    grant_type: "authorization_code",
    redirect_uri: cfg.redirectUri,
    code,
  });
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const tokenBody: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenBody?.access_token) {
    throw new Error(tokenBody?.error_message || tokenBody?.error?.message || `Token exchange failed (${tokenRes.status})`);
  }
  const shortToken: string = tokenBody.access_token;
  const igUserId = String(tokenBody.user_id ?? "");

  // Short-lived -> long-lived. Failing this is not fatal to the connect, but it
  // IS fatal an hour later, so it is surfaced rather than swallowed.
  let accessToken = shortToken;
  let expiresInSec = 3600;
  try {
    const p = new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: cfg.appSecret,
      access_token: shortToken,
    });
    const llRes = await fetch(`${LONG_LIVED_URL}?${p.toString()}`, { signal: AbortSignal.timeout(15_000) });
    const llBody: any = await llRes.json().catch(() => ({}));
    if (llRes.ok && llBody?.access_token) {
      accessToken = llBody.access_token;
      expiresInSec = Number(llBody.expires_in ?? 5_184_000);
    } else {
      console.warn(`[InstagramLogin] long-lived exchange failed: ${llBody?.error?.message ?? llRes.status}`);
    }
  } catch (err: any) {
    console.warn(`[InstagramLogin] long-lived exchange threw: ${err?.message}`);
  }

  const fields = "user_id,username,account_type,followers_count,media_count,profile_picture_url";
  const meRes = await fetch(`${GRAPH}/me?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const me: any = await meRes.json().catch(() => ({}));
  if (!meRes.ok) {
    throw new Error(me?.error?.message || `Profile fetch failed (${meRes.status})`);
  }

  return {
    igUserId: String(me.user_id ?? igUserId),
    username: me.username ?? null,
    followers: Number(me.followers_count ?? 0),
    mediaCount: Number(me.media_count ?? 0),
    accountType: me.account_type ?? null,
    profilePictureUrl: me.profile_picture_url ?? null,
    accessToken,
    expiresInSec,
  };
}
