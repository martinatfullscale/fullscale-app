# Distribution Publishing — Token Sources

How each platform's publishing tokens get provisioned, what you must set up
once as the app operator, and what each creator does in the product.

Tokens live on `distribution_profiles` rows (one per user per platform).
At publish time `resolvePublishAccessToken` (platformPublisher.ts) refreshes
or re-resolves them; stored tokens are only a bootstrap.

| Platform | Token source | Operator setup (once) | Creator action | Refresh at publish |
|---|---|---|---|---|
| YouTube / Shorts | `youtube_connections` (existing YouTube connect) | Google OAuth app already exists; `youtube.upload` scope added 2026-07 | Connect YouTube in Settings (re-consent if connected before the scope landed), then `POST /api/distribution/profiles/from-youtube` | Yes — auto-refresh via stored refresh token |
| Instagram Reels | `users.facebookAccessToken` (existing FB Login) | Meta app already exists; `instagram_content_publish` scope added 2026-07 — needs Meta **App Review** before non-testers can grant it | Connect Facebook/Instagram in Settings (re-consent for the new scope), then `POST /api/distribution/profiles/from-instagram` | Yes — re-reads the user's current FB token; profile stores a ~60-day long-lived token |
| TikTok | `/auth/tiktok` OAuth flow | Create a TikTok developer app (developers.tiktok.com), add **Login Kit** + **Content Posting API**, set redirect `$BASE_URL/auth/tiktok/callback`, put key/secret in `TIKTOK_CLIENT_KEY/SECRET` | Click Connect TikTok in Settings | Yes — refresh-token grant (rotates; persisted) |
| X / Twitter | `/auth/twitter` OAuth flow (OAuth2 + PKCE) | Create an X developer app (developer.x.com), type Web App, redirect `$BASE_URL/auth/twitter/callback`, creds in `X_CLIENT_ID/SECRET`. Posting needs a paid API tier for meaningful volume | Click Connect X in Settings | Yes — refresh-token grant (rotates; persisted) |
| LinkedIn | `/auth/linkedin` OAuth flow | Create a LinkedIn app (developer.linkedin.com), add products **Sign In with LinkedIn (OpenID Connect)** + **Share on LinkedIn**, redirect `$BASE_URL/auth/linkedin/callback`, creds in `LINKEDIN_CLIENT_ID/SECRET` | Click Connect LinkedIn in Settings | No — tokens last ~60 days; creator reconnects when posts start failing |

## Platform caveats you will hit

- **TikTok audit**: until TikTok approves (audits) the app for the Content
  Posting API, direct posts are restricted to `SELF_ONLY` visibility.
  Provisioned TikTok profiles default to `metadata.privacyLevel = "SELF_ONLY"`
  for exactly this reason — flip it after audit approval.
- **Instagram App Review**: `instagram_content_publish` is an App-Review
  permission. Before approval it only works for users with a role on the Meta
  app (admin/developer/tester) — fine for testing with your own accounts.
  Instagram also requires the video at a **public URL** (the API pulls it);
  publishers inject `metadata.publicVideoUrl` from the clip's export path, so
  clips must be exported and publicly served before an IG publish.
- **YouTube**: uploads from API projects that haven't passed a YouTube API
  audit may be locked private by YouTube regardless of requested privacy.
  Since provisioned profiles default to `privacyStatus: "private"` anyway,
  test flows are unaffected; request the audit before going public.
- **X**: the free API tier is heavily rate-limited for posting; check the
  current tier limits before scheduling real volume.
- **LinkedIn**: standard apps get no refresh token. Expect a reconnect every
  ~60 days per creator.

## Testing

1. Set `PUBLISH_DRY_RUN=true` — schedules run the entire pipeline (pickup,
   clip resolution, captioning, token resolution, status transitions) and log
   the would-be payload instead of hitting the platform.
2. First real publishes: YouTube `privacyStatus: "private"` (default),
   TikTok `SELF_ONLY` (default). Both are invisible to audiences.
3. Privacy is per-profile metadata — update via
   `PUT /api/distribution/profiles/:id` when ready to go public.
