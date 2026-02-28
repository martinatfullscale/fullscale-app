#!/usr/bin/env node

/**
 * ============================================================
 * SQUINT — Wikimedia Commons Image Downloader
 * ============================================================
 *
 * Downloads FREE photorealistic images from Wikimedia Commons.
 * NO API key needed. All images are public domain or CC-licensed.
 *
 * USAGE:
 *   node scripts/download-wikimedia-images.js                          # Download all
 *   node scripts/download-wikimedia-images.js --category landmarks     # One category
 *   node scripts/download-wikimedia-images.js --force                  # Re-download all
 *
 * COST: $0 — No API key, no account, completely free.
 * LICENSE: Public domain / Creative Commons.
 *
 * ============================================================
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ────────────────────────────────────────────
// Direct image URLs from Wikimedia Commons and other free sources
// All images are public domain or CC-BY/CC-BY-SA licensed
// ────────────────────────────────────────────

const DIRECT_IMAGES = {
  landmarks: [
    {
      filename: 'eiffel-tower.png',
      // Wikimedia Commons: Eiffel Tower from Champ de Mars
      wikiFile: 'Tour_Eiffel_Wikimedia_Commons_(cropped).jpg',
      search: 'Eiffel Tower Paris',
    },
    {
      filename: 'great-wall.png',
      wikiFile: 'The_Great_Wall_of_China_at_Jinshanling-edit.jpg',
      search: 'Great Wall China',
    },
    {
      filename: 'statue-of-liberty.png',
      wikiFile: 'Statue_of_Liberty_7.jpg',
      search: 'Statue of Liberty',
    },
    {
      filename: 'taj-mahal.png',
      wikiFile: 'Taj_Mahal_2012.jpg',
      search: 'Taj Mahal',
    },
    {
      filename: 'colosseum.png',
      wikiFile: 'Colosseo_2020.jpg',
      search: 'Colosseum Rome',
    },
    {
      filename: 'machu-picchu.png',
      wikiFile: 'Machu_Picchu,_Peru.jpg',
      search: 'Machu Picchu',
    },
    {
      filename: 'sydney-opera-house.png',
      wikiFile: 'Sydney_Opera_House_-_Dec_2008.jpg',
      search: 'Sydney Opera House',
    },
    {
      filename: 'big-ben.png',
      wikiFile: 'Clock_Tower_-_Palace_of_Westminster,_London_-_May_2007.jpg',
      search: 'Big Ben London',
    },
    {
      filename: 'christ-redeemer.png',
      wikiFile: 'Christ_the_Redeemer_-_Cristo_Redentor.jpg',
      search: 'Christ Redeemer Rio',
    },
    {
      filename: 'golden-gate.png',
      wikiFile: 'Golden_Gate_Bridge_as_seen_from_Battery_East.jpg',
      search: 'Golden Gate Bridge',
    },
  ],

  'whats-happening': [
    {
      filename: 'man-on-bike.png',
      search: 'person riding bicycle city',
    },
    {
      filename: 'woman-jumping.png',
      search: 'woman jumping joy outdoors',
    },
    {
      filename: 'kid-kite.png',
      search: 'child flying kite',
    },
    {
      filename: 'dog-frisbee.png',
      search: 'dog catching frisbee',
    },
    {
      filename: 'dancing-rain.png',
      search: 'dancing rain street',
    },
    {
      filename: 'skateboarding.png',
      search: 'skateboarding trick',
    },
    {
      filename: 'pizza-toss.png',
      search: 'chef pizza dough tossing',
    },
    {
      filename: 'hammock-reading.png',
      search: 'person hammock reading book',
    },
    {
      filename: 'street-musician.png',
      search: 'street musician saxophone',
    },
    {
      filename: 'snowball-fight.png',
      search: 'children playing snow winter',
    },
  ],

  'everyday-objects': [
    {
      filename: 'red-sneakers.png',
      search: 'red sneakers shoes',
    },
    {
      filename: 'typewriter.png',
      wikiFile: 'Underwoodfive.jpg',
      search: 'vintage typewriter',
    },
    {
      filename: 'pancakes.png',
      search: 'pancakes stack maple syrup',
    },
    {
      filename: 'guitar.png',
      wikiFile: 'GuitareClassique5.png',
      search: 'acoustic guitar',
    },
    {
      filename: 'rotary-phone.png',
      wikiFile: 'Telephone-annees-60.jpg',
      search: 'rotary telephone vintage',
    },
    {
      filename: 'hot-air-balloon.png',
      search: 'hot air balloon colorful sky',
    },
    {
      filename: 'polaroid-camera.png',
      search: 'polaroid camera instant',
    },
    {
      filename: 'disco-ball.png',
      search: 'disco ball mirror',
    },
    {
      filename: 'school-bus.png',
      search: 'yellow school bus american',
    },
    {
      filename: 'rubiks-cube.png',
      wikiFile: 'Rubiks_cube_by_keqs.jpg',
      search: 'rubiks cube colorful',
    },
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
const FORCE = args.includes('--force');
const CATEGORY_FILTER = getArg('--category');

// ────────────────────────────────────────────
// Wikimedia Commons API: search for images
// ────────────────────────────────────────────

function wikimediaSearch(searchTerm) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrnamespace: '6',         // File namespace
      gsrsearch: searchTerm,
      gsrlimit: '3',
      prop: 'imageinfo',
      iiprop: 'url|size|mime',
      iiurlwidth: '800',         // Get thumbnail at 800px
      format: 'json',
      origin: '*',
    });

    const url = `https://commons.wikimedia.org/w/api.php?${params.toString()}`;

    https.get(url, { headers: { 'User-Agent': 'SquintGame/1.0 (mobile game; image download)' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.query || !parsed.query.pages) {
            reject(new Error(`No results for "${searchTerm}"`));
            return;
          }

          const pages = Object.values(parsed.query.pages);
          // Find the first image that's actually a photo (JPEG/PNG)
          for (const page of pages) {
            if (page.imageinfo && page.imageinfo[0]) {
              const info = page.imageinfo[0];
              const mime = info.mime || '';
              if (mime.includes('jpeg') || mime.includes('png')) {
                // Prefer the thumbnail URL at 800px width
                const imageUrl = info.thumburl || info.url;
                resolve(imageUrl);
                return;
              }
            }
          }
          reject(new Error(`No suitable photos for "${searchTerm}"`));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function wikimediaGetFileUrl(filename) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      action: 'query',
      titles: `File:${filename}`,
      prop: 'imageinfo',
      iiprop: 'url|size|mime',
      iiurlwidth: '800',
      format: 'json',
      origin: '*',
    });

    const url = `https://commons.wikimedia.org/w/api.php?${params.toString()}`;

    https.get(url, { headers: { 'User-Agent': 'SquintGame/1.0 (mobile game; image download)' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const pages = Object.values(parsed.query.pages);
          for (const page of pages) {
            if (page.imageinfo && page.imageinfo[0]) {
              const info = page.imageinfo[0];
              resolve(info.thumburl || info.url);
              return;
            }
          }
          reject(new Error(`File not found: ${filename}`));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ────────────────────────────────────────────
// Download helper with redirect following
// ────────────────────────────────────────────

function downloadImage(url, filePath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }

    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, { headers: { 'User-Agent': 'SquintGame/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadImage(res.headers.location, filePath, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
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
  });
}

// ────────────────────────────────────────────
// Main
// ────────────────────────────────────────────

async function main() {
  const categoriesToDownload = CATEGORY_FILTER
    ? { [CATEGORY_FILTER]: DIRECT_IMAGES[CATEGORY_FILTER] }
    : DIRECT_IMAGES;

  if (CATEGORY_FILTER && !DIRECT_IMAGES[CATEGORY_FILTER]) {
    console.error(`\n  Unknown category: "${CATEGORY_FILTER}"`);
    console.error(`  Available: ${Object.keys(DIRECT_IMAGES).join(', ')}\n`);
    process.exit(1);
  }

  const assetsDir = path.join(__dirname, '..', 'assets', 'images');
  let totalImages = 0;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║  SQUINT — Wikimedia Photo Downloader     ║');
  console.log('  ║  No API Key · Public Domain · 100% Free  ║');
  console.log('  ╚══════════════════════════════════════════╝\n');

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
        if (stats.size > 10240) {  // Skip if > 10KB (real photo, not canvas placeholder)
          console.log(`  │  SKIP  ${entry.filename} (${(stats.size / 1024).toFixed(0)}KB)`);
          skipped++;
          continue;
        }
      }

      try {
        let imageUrl;

        // Strategy 1: Use direct wiki file if we know it
        if (entry.wikiFile) {
          process.stdout.write(`  │  FETCH  ${entry.filename} (direct) ...`);
          imageUrl = await wikimediaGetFileUrl(entry.wikiFile);
        } else {
          // Strategy 2: Search Wikimedia Commons
          process.stdout.write(`  │  SEARCH ${entry.filename} ("${entry.search}") ...`);
          imageUrl = await wikimediaSearch(entry.search);
        }

        process.stdout.write(` downloading ...`);
        const bytes = await downloadImage(imageUrl, filePath);
        downloaded++;
        console.log(` done (${(bytes / 1024).toFixed(0)}KB)`);
      } catch (err) {
        failed++;
        console.log(` FAILED: ${err.message}`);
      }

      // Be respectful: 1 second between requests
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(`  └─ done\n`);
  }

  console.log(`  ────────────────────────────────────`);
  console.log(`  Downloaded: ${downloaded}`);
  console.log(`  Skipped:    ${skipped}`);
  console.log(`  Failed:     ${failed}`);
  console.log(`  Total:      ${totalImages}`);
  console.log(`  ────────────────────────────────────\n`);

  if (downloaded > 0) {
    console.log(`  Images saved to: ${assetsDir}`);
    console.log(`  All photos are public domain / Creative Commons.\n`);
  }

  if (failed > 0) {
    console.log(`  TIP: For failed images, try the Pexels script instead:`);
    console.log(`    export PEXELS_API_KEY="your-key" && node scripts/download-stock-images.js --force\n`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
