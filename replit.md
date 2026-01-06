# FullScale - Content Creator Dashboard

## Overview

FullScale is a content creator dashboard application that helps YouTube creators manage and scale their content. The app provides YouTube channel integration via OAuth, displaying channel statistics, video libraries, and monetization tracking. Built as a full-stack TypeScript application with React frontend and Express backend, using PostgreSQL for data persistence.

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
- **Primary Auth**: Replit Auth via OpenID Connect
- **OAuth Integration**: Google OAuth for YouTube API access
- **Token Security**: AES-256-GCM encryption for storing OAuth tokens
- **Session Storage**: PostgreSQL-backed sessions with 7-day TTL

### Key Design Patterns
- **Shared Types**: `shared/` directory contains schemas and types used by both client and server
- **API Routes Contract**: `shared/routes.ts` defines API contracts with Zod validation
- **Component Architecture**: Feature components in `client/src/components/`, pages in `client/src/pages/`
- **Storage Abstraction**: `server/storage.ts` provides database access interface

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
- `monetization_items`: Content monetization tracking