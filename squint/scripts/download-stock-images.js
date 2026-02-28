#!/usr/bin/env node

/**
 * ============================================================
 * SQUINT — Photorealistic Image Downloader
 * ============================================================
 *
 * Downloads FREE, high-quality stock photos from Pexels.
 * All photos are licensed for free commercial use (no attribution required).
 *
 * SETUP (one time — takes 30 seconds):
 *   1. Go to: https://www.pexels.com/api/
 *   2. Click "Get Started" and create a free account
 *   3. Copy your API key
 *   4. Export it:  export PEXELS_API_KEY="your-key-here"
 *
 * USAGE:
 *   node scripts/download-stock-images.js                          # Download all
 *   node scripts/download-stock-images.js --category landmarks     # One category
 *   node scripts/download-stock-images.js --dry-run                # Preview searches
 *   node scripts/download-stock-images.js --list                   # List all entries
 *
 * COST: $0 — Pexels is 100% free.
 * LICENSE: Free for commercial use, no attribution required.
 *
 * ============================================================
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ────────────────────────────────────────────
// Search terms for each image
// Each entry maps to a Pexels search query that returns photorealistic results
// ────────────────────────────────────────────

const IMAGE_SEARCHES = {
  landmarks: [
    { filename: 'eiffel-tower.png', query: 'eiffel tower paris', orientation: 'square' },
    { filename: 'great-wall.png', query: 'great wall of china', orientation: 'square' },
    { filename: 'statue-of-liberty.png', query: 'statue of liberty new york', orientation: 'square' },
    { filename: 'taj-mahal.png', query: 'taj mahal india', orientation: 'square' },
    { filename: 'colosseum.png', query: 'colosseum rome', orientation: 'square' },
    { filename: 'machu-picchu.png', query: 'machu picchu peru ruins', orientation: 'square' },
    { filename: 'sydney-opera-house.png', query: 'sydney opera house', orientation: 'square' },
    { filename: 'big-ben.png', query: 'big ben london clock tower', orientation: 'square' },
    { filename: 'christ-redeemer.png', query: 'christ redeemer rio de janeiro', orientation: 'square' },
    { filename: 'golden-gate.png', query: 'golden gate bridge san francisco', orientation: 'square' },
  ],

  'whats-happening': [
    { filename: 'man-on-bike.png', query: 'man riding bicycle city street', orientation: 'square' },
    { filename: 'woman-jumping.png', query: 'woman jumping in air outdoors joy', orientation: 'square' },
    { filename: 'kid-kite.png', query: 'child flying kite field', orientation: 'square' },
    { filename: 'dog-frisbee.png', query: 'dog catching frisbee park', orientation: 'square' },
    { filename: 'dancing-rain.png', query: 'couple dancing rain night', orientation: 'square' },
    { filename: 'skateboarding.png', query: 'skateboarder doing trick skatepark', orientation: 'square' },
    { filename: 'pizza-toss.png', query: 'chef tossing pizza dough kitchen', orientation: 'square' },
    { filename: 'hammock-reading.png', query: 'person reading book hammock tropical', orientation: 'square' },
    { filename: 'street-musician.png', query: 'street musician playing saxophone', orientation: 'square' },
    { filename: 'snowball-fight.png', query: 'children playing snow winter', orientation: 'square' },
  ],

  'everyday-objects': [
    { filename: 'red-sneakers.png', query: 'red sneakers shoes close up', orientation: 'square' },
    { filename: 'typewriter.png', query: 'vintage typewriter wooden desk', orientation: 'square' },
    { filename: 'pancakes.png', query: 'stack pancakes maple syrup butter', orientation: 'square' },
    { filename: 'guitar.png', query: 'acoustic guitar leaning wall', orientation: 'square' },
    { filename: 'rotary-phone.png', query: 'vintage retro rotary telephone', orientation: 'square' },
    { filename: 'hot-air-balloon.png', query: 'colorful hot air balloon sky', orientation: 'square' },
    { filename: 'polaroid-camera.png', query: 'vintage polaroid instant camera', orientation: 'square' },
    { filename: 'disco-ball.png', query: 'disco ball lights reflections party', orientation: 'square' },
    { filename: 'school-bus.png', query: 'yellow school bus american', orientation: 'square' },
    { filename: 'rubiks-cube.png', query: 'rubiks cube colorful puzzle', orientation: 'square' },
  ],
};

// ────────────────────────────────────────────
// CLI arg parsing
// ────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

const DRY_RUN = args.includes('--dry-run');
const LIST = args.includes('--list');
const FORCE = args.includes('--force');
const CATEGORY_FILTER = getArg('--category');
const API_KEY = process.env.PEXELS_API_KEY;

if (LIST) {
  console.log('\n  Available images:\n');
  for (const [catId, entries] of Object.entries(IMAGE_SEARCHES)) {
    console.log(`  ${catId.toUpperCase()}:`);
    entries.forEach((e) => console.log(`    - ${e.filename}  →  "${e.query}"`));
    console.log('');
  }
  process.exit(0);
}

if (!API_KEY && !DRY_RUN) {
  console.error('\n  ERROR: PEXELS_API_KEY environment variable is required.\n');
  console.error('  Get your FREE API key in 30 seconds:');
  console.error('    1. Go to: https://www.pexels.com/api/');
  console.error('    2. Sign up (free) and copy your key');
  console.error('    3. Run:  export PEXELS_API_KEY="your-key-here"\n');
  console.error('  Or use --dry-run to preview what would be downloaded.\n');
  process.exit(1);
}

// ────────────────────────────────────────────
// Pexels API call
// ────────────────────────────────────────────

function searchPexels(query, orientation) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      query,
      per_page: '1',
      orientation: orientation || 'square',
    });

    const req = https.request(
      {
        hostname: 'api.pexels.com',
        path: `/v1/search?${params.toString()}`,
        method: 'GET',
        headers: {
          Authorization: API_KEY,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error(parsed.error));
            } else if (!parsed.photos || parsed.photos.length === 0) {
              reject(new Error(`No photos found for "${query}"`));
            } else {
              // Get the medium-sized image (good balance of quality/size)
              const photo = parsed.photos[0];
              const imageUrl = photo.src.large || photo.src.medium || photo.src.original;
              resolve({
                url: imageUrl,
                photographer: photo.photographer,
                pexelsUrl: photo.url,
              });
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function downloadImage(url, filePath) {
  return new Promise((resolve, reject) => {
    const makeRequest = (targetUrl) => {
      const protocol = targetUrl.startsWith('https') ? https : require('http');
      protocol.get(targetUrl, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          makeRequest(res.headers.location);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading image`));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          fs.writeFileSync(filePath, buffer);
          resolve(buffer.length);
        });
        res.on('error', reject);
      }).on('error', reject);
    };

    makeRequest(url);
  });
}

// ────────────────────────────────────────────
// Main
// ────────────────────────────────────────────

async function main() {
  const categoriesToDownload = CATEGORY_FILTER
    ? { [CATEGORY_FILTER]: IMAGE_SEARCHES[CATEGORY_FILTER] }
    : IMAGE_SEARCHES;

  if (CATEGORY_FILTER && !IMAGE_SEARCHES[CATEGORY_FILTER]) {
    console.error(`\n  Unknown category: "${CATEGORY_FILTER}"`);
    console.error(`  Available: ${Object.keys(IMAGE_SEARCHES).join(', ')}\n`);
    process.exit(1);
  }

  const assetsDir = path.join(__dirname, '..', 'assets', 'images');
  let totalImages = 0;
  let downloaded = 0;
  let skipped = 0;

  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║   SQUINT — Stock Photo Downloader    ║');
  console.log('  ║   Powered by Pexels (100% Free)      ║');
  console.log('  ╚══════════════════════════════════════╝\n');

  if (FORCE) {
    console.log('  ⚠  FORCE mode: re-downloading existing images\n');
  }

  for (const [catId, entries] of Object.entries(categoriesToDownload)) {
    const catDir = path.join(assetsDir, catId);
    if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });

    console.log(`  ┌─ ${catId.toUpperCase()} (${entries.length} images)`);

    for (const entry of entries) {
      totalImages++;
      const filePath = path.join(catDir, entry.filename);

      // Skip existing unless --force
      if (fs.existsSync(filePath) && !FORCE) {
        const stats = fs.statSync(filePath);
        // Only skip if file is larger than 1KB (not a placeholder)
        if (stats.size > 1024) {
          console.log(`  │  SKIP  ${entry.filename} (already exists, ${(stats.size / 1024).toFixed(0)}KB)`);
          skipped++;
          continue;
        }
      }

      if (DRY_RUN) {
        console.log(`  │  DRY   ${entry.filename}`);
        console.log(`  │        Search: "${entry.query}"`);
        continue;
      }

      try {
        process.stdout.write(`  │  SEARCH  ${entry.filename} ...`);
        const result = await searchPexels(entry.query, entry.orientation);
        process.stdout.write(` found! Downloading ...`);

        const bytes = await downloadImage(result.url, filePath);
        downloaded++;
        console.log(` done (${(bytes / 1024).toFixed(0)}KB)`);
        console.log(`  │          Photo by: ${result.photographer}`);
      } catch (err) {
        console.log(` FAILED: ${err.message}`);
      }

      // Rate limit: 200 requests/hour = ~0.3s between, use 500ms to be safe
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log(`  └─ done\n`);
  }

  console.log(`  ────────────────────────────────────`);
  console.log(`  Downloaded: ${downloaded}`);
  console.log(`  Skipped:    ${skipped}`);
  console.log(`  Total:      ${totalImages}`);
  console.log(`  ────────────────────────────────────\n`);

  if (downloaded > 0) {
    console.log(`  Images saved to: ${assetsDir}`);
    console.log(`  All photos are FREE for commercial use (Pexels license).\n`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
