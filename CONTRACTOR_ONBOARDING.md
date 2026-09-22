# FullScale — Contractor Onboarding

Welcome. This doc gets a new dev up and running on FullScale from a fresh
machine. Should take ~30 minutes end to end assuming you have the prerequisites.

## What FullScale is

Creator/brand marketplace for product placement in video content. Pipeline:
1. Creator uploads a video → AI scans for placement surfaces (Gemini)
2. Surfaces are clustered into unique scenes (dHash perceptual clustering)
3. Brands drop products onto surfaces in the placement preview modal
4. Harmonization (procedural / TRELLIS 3D mesh + IC-Light) makes products
   look integrated into the scene
5. Final video gets rendered with the products composited in

Stack: React + Vite + TypeScript on the frontend. Express + TypeScript on
the backend. Postgres via Drizzle ORM. Deployed on Replit with GCS-backed
object storage. AI via Google Gemini, Anthropic Claude, and fal.ai.

## Prerequisites

- Node 18+ (`node -v`)
- npm 9+
- Postgres 14+ running locally OR a hosted dev DB (Neon, Supabase, etc.)
- `ffmpeg` and `ffprobe` on PATH (`ffmpeg -version`)
- Git access to the repo (you already have this)

## 1. Clone and install

```bash
git clone https://github.com/martinatfullscale/fullscale-app.git
cd fullscale-app
git checkout claude/fullscale-app-tweaks   # current active branch
npm install
```

## 2. Set up local Postgres

Easiest path: docker.

```bash
docker run -d \
  --name fullscale-postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=fullscale_dev \
  -p 5432:5432 \
  postgres:14
```

Or use Postgres.app / Homebrew if you prefer.

## 3. Configure .env

Copy the template and fill it in:

```bash
cp .env.example .env
```

The `.env` file is gitignored — never commit yours.

### Required to boot:
- `DATABASE_URL` — the connection string for your local Postgres
- `ENCRYPTION_KEY` — run `openssl rand -hex 32`
- `SESSION_SECRET` — run `openssl rand -hex 32`

### Required for scanning/harmonization (the main feature):
- `AI_INTEGRATIONS_GEMINI_API_KEY` — surface detection. Free tier works for dev.
  Get at https://aistudio.google.com/apikey
- `ANTHROPIC_API_KEY` — narrative analysis. Pay-as-you-go.
  Get at https://console.anthropic.com/
- `FAL_KEY` — TRELLIS 3D, IC-Light, Depth Anything v2.
  Get at https://fal.ai/dashboard/keys

For dev work, you don't need Stripe / Facebook OAuth / Twitch / production
GCS — those are flagged "REQUIRED for production" in `.env.example`. The
app boots without them; affected features just no-op or log warnings.

**Ask Martin** (martin@gofullscale.co) for the dev API keys if you don't
want to set up your own accounts. He'll generate scoped keys for you so
you're not using his personal credentials.

## 4. Initialize the schema

```bash
npm run db:push
```

This runs Drizzle to create all tables. It's idempotent and safe to re-run.
It will prompt to confirm any column changes.

## 5. Run it

```bash
npm run dev
```

Server boots on port 5000. Open http://localhost:5000 in a browser. Sign
in with Google (you'll need to be added to the allowlist — ask Martin).

## Key directories

| Path | What's in it |
|---|---|
| `client/src/pages/` | React pages (Library, Dashboard, BrandMarketplace, Settings) |
| `client/src/components/` | Shared components. **PlacementPreviewModal.tsx** is the big one — placement editor with keyframe timeline. |
| `server/routes.ts` | All HTTP routes. 10k+ lines, search-friendly. |
| `server/scanner_v2.ts` | Surface detection pipeline. Scene-first sampling lives here. |
| `server/lib/scenes/sceneIndex.ts` | dHash perceptual scene clustering. |
| `server/lib/ai/harmonization.ts` | Procedural + TRELLIS + IC-Light + Depth Anything v2. |
| `server/storage.ts` | All DB queries (Drizzle wrappers). |
| `shared/schema.ts` | Drizzle table definitions. Source of truth for the data model. |

## Recent work / current state

See the git log on `claude/fullscale-app-tweaks` — most recent ~30 commits
cover: scene-first scanner indexing, per-scene Gemini sampling, harmonize
fixes (black box, IC-Light tuning, depth-aware angle picking), creator
card image upload, frame-by-frame keyframe editor.

Open question / TODO list:
- True 3D-aware GLB render (Depth Anything depth + headless three.js) —
  the current path uses TRELLIS turnaround MP4 frames; works for yaw but
  fakes pitch via 2D shear.
- Manual surface relabel UI (creator overrides Gemini's auto-label).
- Auto-placement matching (brand uploads product → system finds best
  surfaces across creators automatically — scoped but not built).
- Render-pipeline integration of harmonize into export-video flow.

## Common gotchas

1. **`/storage/...` URLs.** These are server-mapped routes to GCS objects.
   Don't try to read them as files on disk — go through the object storage
   helper at `server/lib/objectStorage.ts`.

2. **Scene-first frame filenames.** Scanner saves at `Math.round(timestamp)`
   (e.g. 14.7s → `frame_15s.jpg`). Any downstream code that reconstructs
   the filename must round, not floor.

3. **Dual-id problem.** `users.id` is a UUID but `video.userId` is sometimes
   email (file uploads) and sometimes UUID (IG/FB imports). Most lookups
   need to query both. See `storage.getVideoIndex` for the pattern.

4. **Creator approval gate.** New surfaces default to `creatorApproved=false`.
   The public API filters them out unless `?includeUnapproved=true`. The
   OWNER sees all surfaces; brands see only approved ones.

5. **Soft-delete on rescan.** Re-scanning marks old surfaces as
   `surfaceType=Filtered` rather than deleting them. The count helper
   filters Filtered out. If you see counts that look stale, check that.

## Workflow

- Branch off `claude/fullscale-app-tweaks` for any non-trivial change
- Push to GitHub regularly. The Replit deploy auto-pulls.
- Run `npx tsc --noEmit -p tsconfig.json` before pushing — there are some
  pre-existing TS errors but you shouldn't add new ones
- Drizzle schema changes need `npm run db:push` on every machine that
  runs the app (local + Replit deploy)

## Deployment

Production runs on Replit. The deploy panel is owned by Martin. Auto-deploys
on push to the configured branch. Logs are in the Replit panel — search by
timestamp.

## Contact

- Martin Ekechukwu — martin@gofullscale.co (founder, full context)
- Ben Michals — ben@muselabs.ai (co-builder, technical)
