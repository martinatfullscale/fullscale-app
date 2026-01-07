# FullScale Project TODO

## Current Focus: Marketplace / Opportunities Hub
Building the brand-creator matchmaking experience where creators showcase videos with detected ad placement surfaces to brand partners.

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

## Marketplace MVP (IN PROGRESS)

### Completed:
- [x] Backend API: GET /api/marketplace/opportunities
- [x] Backend API: GET /api/marketplace/stats
- [x] Storage methods for deriving contexts from surfaces
- [x] Opportunities page with video grid
- [x] Brand offers sidebar (Sony, Nike, Squarespace hardcoded)
- [x] Dashboard Active Bids pulls from marketplace stats

### Next Steps:
- [ ] Connect opportunities to actual scanned surfaces
- [ ] Brand partner signup flow
- [ ] Bid/offer management system
- [ ] Creator acceptance workflow

---

## Reference

**Super Admin:** martin@gofullscale.co
**Admins:** martin@whtwrks.com, martincekechukwu@gmail.com
**Production URL:** https://gofullscale.co
