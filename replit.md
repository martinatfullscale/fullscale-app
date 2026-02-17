# FullScale - Content Creator Dashboard

## Overview
FullScale is a dual-portal content monetization platform designed for content creators and brands. It features Google OAuth-gated access with YouTube integration, role-based views (creator/brand) with an admin View Switcher, a Brand Marketplace for purchasing ad placements, and a Campaign Tracker for monitoring bids. The platform uses real-time AI object detection (TensorFlow.js COCO-SSD) for product placement surface analysis within video content. The goal is to provide creators with tools to monetize their content and brands with a marketplace to find suitable ad placements.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter
- **State Management**: TanStack React Query
- **Styling**: Tailwind CSS with CSS variables (dark theme default), shadcn/ui components with Radix UI primitives
- **Animations**: Framer Motion
- **Build Tool**: Vite

### Backend Architecture
- **Runtime**: Node.js with Express
- **Language**: TypeScript
- **API Design**: REST API with typed route definitions (`shared/routes.ts`)
- **Session Management**: Express sessions with PostgreSQL session store
- **Authentication**: Replit Auth with OpenID Connect (OIDC)

### Data Storage
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM with drizzle-zod for schema validation
- **Schema Location**: `shared/schema.ts`
- **Migrations**: Drizzle Kit
- **Object Storage**: Replit Object Storage (GCS-backed) for all file storage (videos, thumbnails, frames, exports, product uploads). Files are served via a `/storage/*` route proxy.

### Authentication & Authorization
- **Primary Auth**: Google OAuth 2.0 with email allowlist.
- **Secondary Auth**: Replit OIDC Auth via Passport.js.
- **Flexible Auth Middleware**: `isFlexibleAuthenticated` supports both Google OAuth and Replit OIDC sessions.
- **Allowlist System**: `allowed_users` table defines user access and type (creator/brand).
- **Role-Based Views**: Differentiates features for creators (Dashboard, Library, Opportunities) and brands (Marketplace, Campaigns).
- **View Switcher**: Admins can toggle between creator/brand views.
- **CSRF Protection**: OAuth state parameter generation and verification.
- **OAuth Integration**: Google OAuth for YouTube API access; Passport.js strategies for Twitch and Facebook integration, supporting standalone login/signup and account linking.
- **Token Security**: AES-256-GCM encryption for storing OAuth tokens.
- **Session Storage**: PostgreSQL-backed sessions with a 2-hour TTL.

### Key Design Patterns
- **Shared Types**: `shared/` directory for common schemas and types.
- **API Routes Contract**: `shared/routes.ts` defines API contracts with Zod validation.
- **Component Architecture**: Feature components in `client/src/components/`, pages in `client/src/pages/`.
- **Hybrid Data Mode**: `use-hybrid-mode.ts` detects Google auth, switching between 'demo' (simulated data for unauthenticated users) and 'real' (live data for authenticated users).
- **Scanner V2**: Resource-safe video scanner using Sharp for edge detection, processing one frame at a time and deleting frames immediately.
- **TensorFlow.js Surface Detection**: Background worker queue for AI-powered object detection (COCO-SSD model) to identify placement surfaces in videos.
- **FFmpeg Thumbnail Extraction**: Automatic thumbnail generation from local video files.
- **Multi-Platform Integrations**: Comprehensive integration with Facebook Graph API and Instagram Business Accounts for content import and data fetching. YouTube thumbnail resolution without OAuth.
- **Direct Video Upload**: Users can upload videos directly; file paths are stored in the database.

## External Dependencies

### Third-Party Services
- **YouTube Data API v3**: For channel info, video listings, and statistics.
- **Google OAuth 2.0**: For YouTube API access and user authentication.
- **Replit Auth**: Primary user authentication via OIDC.
- **Facebook Graph API**: For fetching Facebook Page and Instagram Business Account data and importing content.
- **Twitch API**: For integrating Twitch channel data.
- **TensorFlow.js COCO-SSD**: For real-time object detection in videos.
- **FFmpeg**: For video processing tasks like thumbnail extraction.
- **Sharp**: For image processing in Scanner V2.

### Required Environment Variables
- `DATABASE_URL`
- `SESSION_SECRET`
- `ENCRYPTION_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `ISSUER_URL`
- `REPL_ID`
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `FACEBOOK_APP_ID`
- `FACEBOOK_APP_SECRET`

### Database Tables
- `users`
- `sessions`
- `youtube_connections`
- `monetization_items`
- `allowed_users`
- `video_index`
- `detected_surfaces`
- `twitch_connections` (implied by Twitch integration)
- `facebook_connections` (implied by Facebook integration)