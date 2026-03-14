# FullScale Project TODO

## Current Focus: Brand Marketplace Foundation
Building the dual-portal experience for creators and brands with the Opportunities Hub.

---

## Deep Vision Scanner (FUNCTIONAL — Last updated Feb 12 2026)

### Status: Full Pipeline Working
- YouTube video import, metadata, thumbnails all operational
- **Gemini-powered surface detection** fully working (`server/scanner_v2.ts`)
- Post-scan normalization pipeline for consistent bounding boxes
- Synonym merging (Table/Desk/Studio_desk → "Table") to avoid duplicate tracks
- Camera-cut awareness — products don't interpolate across scene changes (>4s gap)
- False detection filtering and scene persistence in place

### RemixEngine (`client/src/components/RemixEngine.tsx`)
- Interactive product placement on detected surfaces
- Save Placements button persists to DB with auto-propagation to matching scene groups
- Saved placements auto-load on mount
- Surface hotkeys for quick assignment

### Placement Persistence
- Frontend: Save button in PlacementPreviewModal + dedicated Saved Placements page
- Backend: `/api/placements` with scene continuity and propagation
- Product ingest pipeline auto-analyzes uploads for subject bounds, color, background type
- Auto-realistic blend defaults from Gemini scene lighting analysis

### Resume Point (if continuing scanner/remix work):
- Latest code: `server/scanner_v2.ts` (scanner), `client/src/components/RemixEngine.tsx` (remix UI)
- `client/src/pages/Library.tsx` for scan triggers
- All 10 commits from Feb 12 session cover scanner + remix + placement features

---

## Brand Marketplace MVP (COMPLETED)

### Dual Portals:
- [x] Schema updated: `allowed_users.userType` (creator/brand), `allowed_users.companyName`
- [x] Schema updated: `monetization_items` with videoId, creatorUserId, brandEmail, brandName, bidAmount, sceneType, genre
- [x] `/api/auth/user-type` endpoint for brand detection
- [x] Brand redirect logic in App.tsx (brands go to /marketplace on login)

### Brand Marketplace Feed (/marketplace):
- [x] High-density video grid with Scene Value ($) and Context labels
- [x] Genre, Budget, Scene Type filter bars
- [x] 8 dummy opportunities for demo presentation
- [x] Buy button with Zod-validated POST /api/marketplace/buy
- [x] Bids create `monetization_items` records with status "pending"

### Creator Dashboard Integration:
- [x] Active Bids count pulls from `getActiveBidsForCreator()`
- [x] Real-time stats via `/api/marketplace/stats`

### Next Steps:
- [ ] Add brand users to `allowed_users` table for testing
- [ ] Connect marketplace to real scanned surfaces
- [ ] Creator bid acceptance/rejection workflow
- [ ] Brand onboarding flow

---

## Opportunities Hub (Creator Side - COMPLETED)

- [x] Backend API: GET /api/marketplace/opportunities
- [x] Backend API: GET /api/marketplace/stats
- [x] Storage methods for deriving contexts from surfaces
- [x] Opportunities page with video grid
- [x] Brand offers sidebar (Sony, Nike, Squarespace hardcoded)
- [x] Dashboard Active Bids pulls from marketplace stats

---

## Reference

**Super Admin:** martin@gofullscale.co
**Admins:** martin@whtwrks.com, martincekechukwu@gmail.com
**Production URL:** https://gofullscale.co
