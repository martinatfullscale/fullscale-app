# FullScale Project TODO

## Current Focus: Brand Marketplace Foundation
Building the dual-portal experience for creators and brands with the Opportunities Hub.

---

## Deep Vision Scanner (PAUSED)

### Status: YouTube Indexing 100% Functional
- Video import from YouTube API working correctly
- Metadata storage and retrieval operational
- Thumbnail fetching and display working
- Video index populated with real channel data

### Issue: scanVideoForSurfaces Handshake Silent
The Deep Vision scanner (`server/lib/scanner.ts`) is not returning expected surface detection results. The handshake between frontend scan button and backend Gemini API needs debugging.

**Symptoms:**
- Scan button triggers mutation correctly (frontend logs confirm)
- Backend receives request and attempts Gemini API call
- Response handling or surface parsing may be failing silently
- Extensive logging added but root cause not yet identified

**Resume Point:**
- See `client/src/pages/Library.tsx` for scan button logic (marked with TODO comment)
- See `server/lib/scanner.ts` for verbose logging already in place
- Check frame optimization, API timeouts, and response parsing

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
