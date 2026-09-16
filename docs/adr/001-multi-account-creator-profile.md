# ADR 001 — Multi-Account Creator Profile + Audience Media Kit

**Status:** Proposed (pending review)
**Date:** 2026-05-03
**Author:** Martin (with Claude)

---

## Context

Today's data model is single-account: the `users` table has columns
`facebookPageId`, `facebookFollowers`, `instagramHandle`,
`instagramFollowers`, plus a 1:1 `youtube_connections` table. One user, one
account per platform. Implicitly, this is the **business** identity — the
podcast Page, the brand IG, the brand YT channel — because the existing
FB Login flow lands on `Pages → linked IG Business Account`.

This breaks for two real-world creator archetypes:

1. **Podcast/show creator.** Has a business presence (`@quiettruthpodcast`)
   AND a personal presence (`@martin_ekechukwu`). Brands evaluating a
   campaign may want either or both.
2. **Individual creator.** Has only a personal presence, no Page. Today's
   FB Login flow gives them nothing useful; the IG Business / Page model
   doesn't apply.

The driving use case is **brand compliance**. A liquor brand cannot
engage a creator whose audience skews underage. A regional bank cares
about geography. A fashion brand cares about gender mix. Without
audience demographics surfaced at the creator-profile level, brand
media buyers can't make informed decisions and won't engage.

The public creator profile (`/creator/:slug` → `CreatorProfile.tsx`)
already exists as a portfolio page. This ADR turns it into a **media kit**
— a profile page that brand media buyers use to evaluate fit.

## Decision

### 1. Schema: separate `social_accounts` table

Replace the per-platform columns on `users` with a normalized table.

```sql
CREATE TABLE social_accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  platform              VARCHAR NOT NULL,        -- 'instagram' | 'facebook' | 'youtube' | 'twitch'
  account_type          VARCHAR NOT NULL,        -- 'business' | 'personal'
  platform_account_id   VARCHAR NOT NULL,        -- FB page id / IG business id / YT channel id

  handle                VARCHAR,                 -- @username, page name, channel name
  display_name          VARCHAR,
  avatar_url            VARCHAR,
  bio                   TEXT,                    -- platform-provided bio (used for AI synthesis input)

  followers             INTEGER,
  total_views           BIGINT,                  -- YT channel-level total views; null elsewhere

  access_token          TEXT,                    -- encrypted
  refresh_token         TEXT,                    -- encrypted, nullable (FB doesn't refresh, YT does)
  token_expires_at      TIMESTAMPTZ,
  scopes                TEXT[],                  -- granted OAuth scopes for this token

  audience_data         JSONB,                   -- latest demographics; see Audience Schema below
  audience_synced_at    TIMESTAMPTZ,

  metadata              JSONB,                   -- platform-specific extras (linked accounts, etc.)
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (user_id, platform, account_type, platform_account_id)
);

CREATE INDEX idx_social_accounts_user_id ON social_accounts(user_id);
CREATE INDEX idx_social_accounts_platform ON social_accounts(platform, account_type);
```

Audience data shape stored in `audience_data` JSONB:

```jsonc
{
  "age_distribution": { "13-17": 0.05, "18-24": 0.32, "25-34": 0.41, "35-44": 0.15, "45-54": 0.05, "55-64": 0.02, "65+": 0.00 },
  "gender_distribution": { "male": 0.55, "female": 0.43, "other": 0.02 },
  "top_countries": [{ "code": "US", "percent": 0.78 }, { "code": "CA", "percent": 0.07 }, ...],
  "top_cities": [{ "name": "New York", "percent": 0.12 }, ...],
  "language_distribution": [{ "lang": "en", "percent": 0.95 }, ...],

  // Engagement metrics (where available)
  "engagement_rate": 0.034,
  "avg_views_per_post": 12500,

  // Platform raw response, kept for debugging and future fields we haven't mapped yet
  "raw": { ... }
}
```

**Why JSONB not separate columns**: each platform exposes slightly different
fields (YT has watch time, IG has saves, FB has page reach), and we want
the freedom to surface whichever ones are available without a schema migration
every time a platform adds something.

**Why no `audience_snapshots` history table**: keeping daily snapshots is
useful for trend lines, but it's scope creep for v1. Latest-only now;
we can add a history table later (and seed it from the moment we switch on)
without breaking anything.

### 2. Migration plan (zero-downtime, two phases)

**Phase A (this ADR's work):** Create `social_accounts` table. Backfill
existing data. Read code uses both the new table AND the legacy `users`
columns. Write code (new connections) writes to both during transition.

**Phase B (later):** Once Phase A is shipped and stable, flip read code
to use `social_accounts` exclusively. Drop the legacy columns from
`users` in a separate cleanup migration.

Backfill SQL sketch:

```sql
-- For each existing user with FB Page data, create a 'business' Facebook account
INSERT INTO social_accounts (user_id, platform, account_type, platform_account_id, handle, followers, access_token, scopes)
SELECT id, 'facebook', 'business', facebook_page_id, facebook_page_name, facebook_followers, facebook_access_token, ARRAY['email','public_profile','pages_show_list','pages_read_engagement','instagram_basic','instagram_manage_insights']
FROM users WHERE facebook_page_id IS NOT NULL;

-- IG Business linked through the same FB Login token
INSERT INTO social_accounts (user_id, platform, account_type, platform_account_id, handle, followers, access_token, scopes)
SELECT id, 'instagram', 'business', instagram_business_id, instagram_handle, instagram_followers, facebook_access_token, ARRAY['instagram_basic','instagram_manage_insights']
FROM users WHERE instagram_business_id IS NOT NULL;

-- YouTube connections move from youtube_connections table (always business for now)
INSERT INTO social_accounts (user_id, platform, account_type, platform_account_id, handle, followers, total_views, access_token, refresh_token, token_expires_at, scopes)
SELECT user_id, 'youtube', 'business', channel_id, channel_title, subscriber_count, total_view_count, access_token, refresh_token, expires_at, ARRAY['youtube.readonly','yt-analytics.readonly']
FROM youtube_connections;
```

All existing connections are tagged `business` because that's what they
historically are (FB Login flow targets Pages, YT was connected via the
brand channel for most users).

### 3. OAuth flow changes — what's new vs what stays

| Connection | Current | After ADR |
|---|---|---|
| FB Page (business) | FB Login flow ✓ exists | Same flow, writes to `social_accounts` with type='business' |
| IG Business (linked to Page) | FB Login auto-links ✓ exists | Same |
| YT business channel | YT OAuth ✓ exists | Same flow |
| **IG Personal** | **Not supported** | New: IG Login flow (`instagram.com/oauth/authorize`, scopes `instagram_business_basic` + `instagram_business_manage_insights`) → writes type='personal' |
| **FB Personal profile** | **Not supported** | Limited: connect via FB Login with `user_videos` to read videos, but **no audience demographics** — Meta doesn't expose them for personal profiles. Surface as "Personal Facebook (followers + posts only)". |
| **YT Personal channel** | Implicit (uses same flow) | Explicit: same OAuth, but UI prompts "is this a personal or business channel?" — store as type='personal'. |

**Important compliance note on personal accounts:** Meta only exposes
audience demographics for business accounts (Pages and IG Business
Accounts). Personal IG accounts via IG Login expose **media** but not
demographics. We surface this clearly: brand viewers will see "Audience
demographics not available for personal accounts on this platform" with
an explanation, rather than appearing to hide data.

### 4. Analytics endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/social-accounts` | List the current user's connected accounts (handle, type, follower counts) |
| `POST /api/social-accounts/connect/:platform/:type` | Initiate OAuth for a specific platform+type — branches to the right flow |
| `DELETE /api/social-accounts/:id` | Disconnect (revokes platform-side where supported, removes locally) |
| `POST /api/social-accounts/:id/refresh-analytics` | Pull fresh demographics from the platform — gated to once-per-hour to avoid rate limits |
| `GET /api/public/creator/:slug/audience` | Public read endpoint — returns the latest `audience_data` for each connected account, grouped by type |

### 5. Daily refresh job

A background job runs at 03:00 UTC daily and refreshes audience data for
every connected business account (personal accounts only refresh on
manual trigger to limit rate-limit exposure for less-monetizable data).

Implementation: in-process `setInterval`-based scheduler in `server/lib/cron.ts`.
Replit Deploy runs single-instance, so no distributed-lock complexity.
If we ever scale to multi-instance, swap for a real cron with leader election.

### 6. Bio synthesis

`POST /api/profile/bio/generate` reads:
- All connected accounts' platform-provided bios (`social_accounts.bio`)
- The 5 most recent video titles + captions
- Channel descriptions (for YT)

Sends to Claude Haiku with prompt: "Write a 2-3 sentence creator bio that
captures who this person is, their content focus, and their voice. Use the
3rd person. No marketing fluff." Returns suggested bio.

`PATCH /api/profile/bio` saves the creator's edited version to
`users.bio` (new column). Persisted across sessions.

### 7. UI: media kit shape

Public creator profile (`/creator/:slug`) layout:

```
┌─────────────────────────────────────────────────┐
│  AVATAR    NAME                                 │
│            BIO (AI-synthesized, creator-edited) │
│                                                 │
├─────────────────────────────────────────────────┤
│  BUSINESS AUDIENCE                              │
│  ┌──────────────┬─────────────┬──────────────┐ │
│  │ @podcast IG  │ Page on FB  │ YT Channel   │ │
│  │ 45.2K        │ 12.1K       │ 8.5K subs    │ │
│  │ Age: 25-34 ↗ │ Age: 25-34  │ Age: 25-34   │ │
│  │ Gender: 60F  │ Gender: 55F │ Gender: 50/50│ │
│  │ Top: US 78%  │ Top: US 82% │ Top: US 71%  │ │
│  └──────────────┴─────────────┴──────────────┘ │
├─────────────────────────────────────────────────┤
│  PERSONAL AUDIENCE                              │
│  ┌──────────────┐                              │
│  │ @martin IG   │  (FB personal: no demos)     │
│  │ 3.2K         │                              │
│  │ Age: 25-34   │                              │
│  │ Gender: 60M  │                              │
│  │ Top: US 65%  │                              │
│  └──────────────┘                              │
├─────────────────────────────────────────────────┤
│  CONTENT PORTFOLIO                              │
│  [existing video grid]                          │
└─────────────────────────────────────────────────┘
```

Stacked cards, business above personal (deliberate — brands evaluating
the bigger audience first). Each card is visually self-contained with
the account handle, follower count, and demographic summary. Cards are
clickable for a deeper drill-down (full distributions, top cities, etc.).

If a creator only has business or only has personal, the empty section
just isn't rendered.

### 8. Compliance footnote: age verification

To explicitly support liquor / age-gated brand campaigns:

- The `audience_data.age_distribution` field is the source of truth.
- We'll surface a derived `pct_under_21` field on the public response,
  computed server-side: `age_distribution["13-17"] + age_distribution["18-20"]`.
  (Note: platforms bucket as 13-17 / 18-24, so under-21 is approximated
  as 13-17 + ~⅓ of 18-24 — we'll document the approximation in tooltips.)
- Brand-side filters (future work, not in this ADR) can use this to
  filter out creators whose under-21 percentage exceeds a threshold.

## Consequences

### Positive

- **Unblocks the "individual creator" archetype** — personal IG / personal YT support
- **Brand-grade audience data** — campaigns can clear compliance based on real demographics
- **Future-proof for additional account types** — adding TikTok, Twitch, etc. is just a new row, not a schema migration
- **Cleaner code** — one query path for "fetch all accounts for user" replaces 3 different field accesses

### Negative / costs

- **Two-phase migration** — Phase A keeps both schemas in sync briefly, modest code duplication during transition
- **New OAuth flow to build** — IG Login flow is genuinely separate from FB Login; ~1-2 days alone
- **App Review for new scopes** — Meta `pages_read_insights` (or equivalent) and IG Login scopes likely need review submission. 3-7 days lead time. Build in parallel; demographics gated behind "coming soon" until approval.
- **Rate-limit exposure** — daily refresh × N accounts × per-platform limits. Need monitoring. Mitigation: stagger refreshes, manual trigger gated to once-per-hour.
- **Data privacy** — fully-public audience demographics is a deliberate choice (creator opts in by connecting), but creators may push back on full demographic exposure later. Easy to add a per-account "show on public profile?" toggle in v2.

### Deferred / out of scope

- Historical audience trend tracking (snapshots over time)
- Brand-side filtering UI (audience age threshold filter on Brand Marketplace)
- Per-account public toggle (visible / hidden on creator profile)
- Engagement-rate computation across platforms (each platform defines it differently)
- Multi-channel YT support (one user with multiple YT channels, e.g. main + side channel) — supported by schema but no first-class UI yet

## Implementation order

Approximate sequencing once the ADR is approved:

1. **Schema migration** — create `social_accounts`, run backfill (read-only, no behavior change)
2. **Storage helpers** — `getSocialAccounts(userId, type?)`, `upsertSocialAccount(...)`, etc.
3. **Read-path updates** — `/api/public/creator/:slug` reads from `social_accounts` (parallel with legacy fields)
4. **Audience analytics fetchers** — one per platform: FB Page, IG Business, YT (build the test FB endpoint first, see commit `[pending]`)
5. **Daily refresh job** — cron-like scheduler
6. **Bio generation** — Claude Haiku endpoint + UI affordance
7. **IG Login flow** — new OAuth, personal IG support
8. **Personal YT prompt** — UI ask "personal or business?" on YT connect
9. **Public profile UI** — stacked cards, demographic widgets
10. **Phase B cleanup** — drop legacy columns

Each step ships independently. Steps 1-3 + 4 unlock the immediate "show
business audience demographics" use case; the rest is layered on.

## Status & next step

This ADR is **Proposed**. Before implementation, Martin to confirm or
push back on:

- Schema shape (especially the JSONB `audience_data` choice)
- Personal-FB limitation acknowledgment (no demographics)
- App Review acceptance (3-7 day delay for some demographics features)
- Implementation order / what to ship first

Once confirmed, work proceeds in order of the implementation list above,
each step in its own commit on `claude/fullscale-app-tweaks`.
