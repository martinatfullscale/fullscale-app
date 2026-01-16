# FullScale - Content Creator Dashboard

## Overview

FullScale is a dual-portal content monetization platform with Google OAuth-gated access and YouTube integration. Features role-based views (creator/brand) with View Switcher for admins, a Brand Marketplace where brands purchase ad placements, and Campaign Tracker for monitoring bids. Built as a full-stack TypeScript application with React frontend and Express backend, using PostgreSQL for data persistence. Includes real-time AI object detection using TensorFlow.js COCO-SSD for product placement surface analysis.

## Recent Changes (January 2026)
- Video scanning pipeline fully functional: ffmpeg frame extraction → Gemini 2.5 Flash analysis → surface detection → database storage
- LOCAL_ASSET_MAP in scanner.ts maps demo video IDs to local files for testing without YouTube download
- Test video (ID 52) successfully scanned with AI-detected placement surface (Desk) for martin@gofullscale.co
- Added TensorFlow.js COCO-SSD integration for real-time object detection in SceneAnalysisModal
- Added Social Integrations tab in Settings with simulated connect/disconnect for IG, Meta, X, TikTok, YouTube, Twitch
- Brand Marketplace has 20 industry categories with tabbed interface and genre/budget/scene/platform filters
- Multi-platform support: YouTube (red), Twitch (purple #9146FF), Facebook (blue #1877F2) platform badges on video cards
- Platform filter dropdown in Brand Marketplace for filtering by YouTube/Twitch/Facebook
- Linked Accounts card in Settings showing connected social profiles with follower counts
- Demo videos expanded: 20 YouTube, 15 Instagram, 4 Twitch VODs, 4 Facebook videos in server/routes.ts
- Settings connections renamed to be more specific (e.g., "Instagram Professional", "Facebook Page", "Twitch Channel")
- Session timeout set to 2 hours for security (confirmed by user)

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter for lightweight client-side routing
- **State Management**: TanStack React Query for server state and caching
- **Styling**: Tailwind CSS with CSS variables for theming (dark theme default)
- **UI Components**: shadcn/ui component library with Radix UI primitives
- **Animations**: Framer Motion for page transitions and micro-interactions
- **Build Tool**: Vite with HMR support

### Backend Architecture
- **Runtime**: Node.js with Express
- **Language**: TypeScript with tsx for development
- **API Design**: REST API with typed route definitions in `shared/routes.ts`
- **Session Management**: Express sessions with PostgreSQL session store (connect-pg-simple)
- **Authentication**: Replit Auth integration with OpenID Connect (OIDC)

### Data Storage
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM with drizzle-zod for schema validation
- **Schema Location**: `shared/schema.ts` contains all table definitions
- **Migrations**: Drizzle Kit with `db:push` command for schema sync

### Authentication & Authorization
- **Primary Auth**: Google OAuth 2.0 login with email allowlist gatekeeper
- **Allowlist System**: `allowed_users` table controls founding cohort access with user_type (creator/brand)
- **Default Role Assignment**: Users on allowlist without role default to 'creator'
- **Role-Based Views**: Creators see Dashboard/Library/Opportunities; Brands see Marketplace/Campaigns
- **View Switcher**: Admins can switch between creator/brand views for testing
- **CSRF Protection**: OAuth state parameter generation and verification
- **Admin Emails**: martin@gofullscale.co, martin@whtwrks.com, martincekechukwu@gmail.com
- **OAuth Integration**: Google OAuth for YouTube API access
- **Token Security**: AES-256-GCM encryption for storing OAuth tokens
- **Session Storage**: PostgreSQL-backed sessions with 2-hour TTL
- **Auth API Fix**: /api/auth/user-type returns {authenticated: false} for unauthenticated users (no 401 loops)

### Key Design Patterns
- **Shared Types**: `shared/` directory contains schemas and types used by both client and server
- **API Routes Contract**: `shared/routes.ts` defines API contracts with Zod validation
- **Component Architecture**: Feature components in `client/src/components/`, pages in `client/src/pages/`
- **Storage Abstraction**: `server/storage.ts` provides database access interface
- **Hybrid Data Mode**: `client/src/hooks/use-hybrid-mode.ts` detects Google auth and returns `mode: 'demo' | 'real'`
  - Demo mode: Unauthenticated visitors see simulated data, fake sync animations, hardcoded charts
  - Real mode: Authenticated users (on allowlist) see live YouTube channel data and actual video library

## External Dependencies

### Third-Party Services
- **YouTube Data API v3**: Channel info, video listings, and statistics
- **Google OAuth 2.0**: Authentication for YouTube API access
- **Replit Auth**: Primary user authentication via OIDC

### Required Environment Variables
- `DATABASE_URL`: PostgreSQL connection string
- `SESSION_SECRET`: Secret for session encryption
- `ENCRYPTION_KEY`: Key for OAuth token encryption (falls back to SESSION_SECRET)
- `GOOGLE_CLIENT_ID`: Google OAuth client ID for YouTube
- `GOOGLE_CLIENT_SECRET`: Google OAuth client secret
- `ISSUER_URL`: Replit OIDC issuer (defaults to https://replit.com/oidc)
- `REPL_ID`: Replit environment identifier

### Database Tables
- `users`: User accounts from Replit Auth
- `sessions`: Session storage for authentication
- `youtube_connections`: Encrypted OAuth tokens and channel info
- `monetization_items`: Content monetization tracking (brand bids on creator content)
- `allowed_users`: Email allowlist with user_type (creator/brand) for access control
- `video_index`: Indexed videos with AI analysis status and priority scores
- `detected_surfaces`: AI-detected placement surfaces in videos

### AI Insertion Engine (server/lib/ai/engine/)
- **types.ts**: PlacementSurface, InsertionOpportunity, SceneAnalysis types
- **scene-analyzer.ts**: SceneAnalyzer class for Gemini 2.5 Flash frame analysis
- **insertion-engine.ts**: Main orchestrator for video analysis pipeline
- **Status**: Scaffold with TODOs - ready for implementation