#!/usr/bin/env node

/**
 * ============================================================
 * SQUINT — AI Image Generator
 * ============================================================
 *
 * Generates game images using OpenAI's DALL-E API.
 * You OWN all generated images — no licensing issues.
 *
 * SETUP:
 *   1. Get an OpenAI API key: https://platform.openai.com/api-keys
 *   2. Export it:  export OPENAI_API_KEY="sk-..."
 *   3. Run:       node scripts/generate-images.js
 *
 * OPTIONS:
 *   --category <id>    Generate images for a specific category only
 *   --dry-run          Show what would be generated without calling the API
 *   --size <size>      Image size: 1024x1024 (default), 512x512, 256x256
 *   --model <model>    DALL-E model: dall-e-3 (default), dall-e-2
 *
 * EXAMPLES:
 *   node scripts/generate-images.js --category landmarks
 *   node scripts/generate-images.js --category whats-happening --dry-run
 *   node scripts/generate-images.js --category everyday-objects --size 512x512
 *
 * COST ESTIMATE (DALL-E 3, 1024x1024):
 *   ~$0.04 per image × 10 images per category = ~$0.40 per category
 *   All 13 categories = ~$5.20 total
 *
 * ============================================================
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ────────────────────────────────────────────
// Image prompts for AI-generated categories
// ────────────────────────────────────────────

const AI_GENERATED_PROMPTS = {
  'landmarks': [
    { id: 'lm-1', name: 'Eiffel Tower', prompt: 'The Eiffel Tower in Paris at golden hour, dramatic lighting, travel photography style, no text or watermarks', filename: 'eiffel-tower.png' },
    { id: 'lm-2', name: 'Great Wall of China', prompt: 'The Great Wall of China stretching across misty mountains, epic landscape photography, no text or watermarks', filename: 'great-wall.png' },
    { id: 'lm-3', name: 'Statue of Liberty', prompt: 'The Statue of Liberty in New York with blue sky, iconic angle from below, travel photography, no text or watermarks', filename: 'statue-of-liberty.png' },
    { id: 'lm-4', name: 'Taj Mahal', prompt: 'The Taj Mahal in Agra India at sunrise with reflecting pool, stunning architecture photography, no text or watermarks', filename: 'taj-mahal.png' },
    { id: 'lm-5', name: 'Colosseum', prompt: 'The Roman Colosseum in Rome Italy, ancient architecture, dramatic sky, travel photography, no text or watermarks', filename: 'colosseum.png' },
    { id: 'lm-6', name: 'Machu Picchu', prompt: 'Machu Picchu ruins in Peru surrounded by misty mountains, breathtaking aerial view, travel photography, no text or watermarks', filename: 'machu-picchu.png' },
    { id: 'lm-7', name: 'Sydney Opera House', prompt: 'Sydney Opera House and Harbour Bridge at dusk, iconic Australian landmark, travel photography, no text or watermarks', filename: 'sydney-opera-house.png' },
    { id: 'lm-8', name: 'Big Ben', prompt: 'Big Ben and the Houses of Parliament in London at twilight with glowing lights, travel photography, no text or watermarks', filename: 'big-ben.png' },
    { id: 'lm-9', name: 'Christ the Redeemer', prompt: 'Christ the Redeemer statue in Rio de Janeiro Brazil on Corcovado mountain with dramatic clouds, travel photography, no text or watermarks', filename: 'christ-redeemer.png' },
    { id: 'lm-10', name: 'Golden Gate Bridge', prompt: 'The Golden Gate Bridge in San Francisco with fog rolling in, iconic red bridge, cinematic photography, no text or watermarks', filename: 'golden-gate.png' },
  ],

  'whats-happening': [
    { id: 'wh-1', name: 'Man Riding a Bike', prompt: 'A person riding a bicycle through a colorful city street, motion blur, vibrant street photography style, no text or watermarks', filename: 'man-on-bike.png' },
    { id: 'wh-2', name: 'Woman Jumping', prompt: 'A woman jumping joyfully in the air on a beach at sunset, silhouette style, dynamic action photography, no text or watermarks', filename: 'woman-jumping.png' },
    { id: 'wh-3', name: 'Kid Flying a Kite', prompt: 'A child flying a colorful kite in a green field on a windy day, whimsical and joyful, photography style, no text or watermarks', filename: 'kid-kite.png' },
    { id: 'wh-4', name: 'Dog Catching a Frisbee', prompt: 'A dog leaping high to catch a frisbee in a park, dramatic action shot, pet photography, no text or watermarks', filename: 'dog-frisbee.png' },
    { id: 'wh-5', name: 'Couple Dancing in Rain', prompt: 'Two people dancing together in the rain on a city street at night with streetlights reflecting on wet pavement, romantic photography, no text or watermarks', filename: 'dancing-rain.png' },
    { id: 'wh-6', name: 'Person Skateboarding', prompt: 'A skateboarder doing a trick on a halfpipe at a skatepark, dramatic low angle, action sports photography, no text or watermarks', filename: 'skateboarding.png' },
    { id: 'wh-7', name: 'Chef Tossing Pizza Dough', prompt: 'A chef tossing pizza dough in the air in a rustic kitchen, flour dust in the air, food photography style, no text or watermarks', filename: 'pizza-toss.png' },
    { id: 'wh-8', name: 'Person Reading in Hammock', prompt: 'A person reading a book while relaxing in a hammock between two palm trees on a tropical beach, lifestyle photography, no text or watermarks', filename: 'hammock-reading.png' },
    { id: 'wh-9', name: 'Street Musician Playing', prompt: 'A street musician playing saxophone on a busy corner with warm evening light, soulful atmosphere, street photography, no text or watermarks', filename: 'street-musician.png' },
    { id: 'wh-10', name: 'Kids Having a Snowball Fight', prompt: 'Children having an epic snowball fight in a snowy park, joyful and chaotic, winter photography style, no text or watermarks', filename: 'snowball-fight.png' },
  ],

  'everyday-objects': [
    { id: 'eo-1', name: 'Red Sneakers', prompt: 'A pair of bright red sneakers on a concrete sidewalk, dramatic shadow, product photography style, no text or watermarks', filename: 'red-sneakers.png' },
    { id: 'eo-2', name: 'Vintage Typewriter', prompt: 'A vintage typewriter on an old wooden desk with warm lighting, nostalgic aesthetic, still life photography, no text or watermarks', filename: 'typewriter.png' },
    { id: 'eo-3', name: 'Stack of Pancakes', prompt: 'A tall stack of fluffy pancakes with maple syrup dripping down and butter on top, mouth-watering food photography, no text or watermarks', filename: 'pancakes.png' },
    { id: 'eo-4', name: 'Acoustic Guitar', prompt: 'An acoustic guitar leaning against a brick wall with warm sunset light, moody atmosphere, still life photography, no text or watermarks', filename: 'guitar.png' },
    { id: 'eo-5', name: 'Old Rotary Phone', prompt: 'A retro rotary telephone in mint green color on a mid-century modern table, vintage aesthetic, product photography, no text or watermarks', filename: 'rotary-phone.png' },
    { id: 'eo-6', name: 'Hot Air Balloon', prompt: 'A single colorful hot air balloon floating in a clear blue sky at dawn, dreamy and peaceful, aerial photography, no text or watermarks', filename: 'hot-air-balloon.png' },
    { id: 'eo-7', name: 'Polaroid Camera', prompt: 'A vintage Polaroid instant camera with scattered photos around it, retro aesthetic, product photography style, no text or watermarks', filename: 'polaroid-camera.png' },
    { id: 'eo-8', name: 'Disco Ball', prompt: 'A shiny disco ball reflecting colorful lights in a dark room, party atmosphere, dramatic lighting photography, no text or watermarks', filename: 'disco-ball.png' },
    { id: 'eo-9', name: 'Yellow School Bus', prompt: 'An iconic yellow American school bus parked on a tree-lined street in autumn, nostalgic Americana, photography style, no text or watermarks', filename: 'school-bus.png' },
    { id: 'eo-10', name: 'Rubik\'s Cube', prompt: 'A colorful Rubik\'s cube partially solved on a reflective surface, sharp detail, product photography style, no text or watermarks', filename: 'rubiks-cube.png' },
  ],
};

// Prompts for celebrity/public figure categories (optional — use real photos when possible)
const CELEBRITY_PROMPTS = {
  'hip-hop': 'A stylish hip hop artist portrait, dramatic studio lighting, music industry aesthetic',
  'pop-stars': 'A glamorous pop star portrait, bright colorful lighting, concert energy',
  'iconic-women': 'A powerful confident woman portrait, elegant and inspiring, studio photography',
  'nba-legends': 'A basketball player portrait in dramatic lighting, athletic and intense',
  'hollywood': 'A Hollywood movie star portrait, cinematic lighting, red carpet glamour',
  'rnb-icons': 'A soulful R&B artist portrait, warm moody lighting, studio aesthetic',
  'world-leaders': 'A distinguished leader portrait, formal and authoritative, professional photography',
  'tech-titans': 'A tech entrepreneur portrait, modern clean background, corporate photography',
  'sports-goats': 'An elite athlete portrait, powerful and determined, sports photography',
  'tv-streaming': 'A TV star portrait, modern and stylish, entertainment industry aesthetic',
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
const CATEGORY_FILTER = getArg('--category');
const SIZE = getArg('--size') || '1024x1024';
const MODEL = getArg('--model') || 'dall-e-3';
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY && !DRY_RUN) {
  console.error('\n  ERROR: OPENAI_API_KEY environment variable is required.\n');
  console.error('  Set it with:  export OPENAI_API_KEY="sk-your-key-here"\n');
  console.error('  Or use --dry-run to preview what would be generated.\n');
  process.exit(1);
}

// ────────────────────────────────────────────
// DALL-E API call
// ────────────────────────────────────────────

function generateImage(prompt, size, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      prompt,
      n: 1,
      size,
      response_format: 'b64_json',
    });

    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/images/generations',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error(parsed.error.message));
            } else {
              resolve(parsed.data[0].b64_json);
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ────────────────────────────────────────────
// Main
// ────────────────────────────────────────────

async function main() {
  const categoriesToGenerate = CATEGORY_FILTER
    ? { [CATEGORY_FILTER]: AI_GENERATED_PROMPTS[CATEGORY_FILTER] }
    : AI_GENERATED_PROMPTS;

  if (CATEGORY_FILTER && !AI_GENERATED_PROMPTS[CATEGORY_FILTER]) {
    console.error(`\n  Unknown category: "${CATEGORY_FILTER}"`);
    console.error(`  Available: ${Object.keys(AI_GENERATED_PROMPTS).join(', ')}\n`);
    process.exit(1);
  }

  const assetsDir = path.join(__dirname, '..', 'assets', 'images');
  let totalImages = 0;
  let generated = 0;

  for (const [catId, entries] of Object.entries(categoriesToGenerate)) {
    const catDir = path.join(assetsDir, catId);
    if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });

    console.log(`\n  ┌─ ${catId.toUpperCase()} (${entries.length} images)`);

    for (const entry of entries) {
      totalImages++;
      const filePath = path.join(catDir, entry.filename);

      if (fs.existsSync(filePath)) {
        console.log(`  │  SKIP  ${entry.filename} (already exists)`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  │  DRY   ${entry.filename}`);
        console.log(`  │        "${entry.prompt.substring(0, 80)}..."`);
        continue;
      }

      try {
        process.stdout.write(`  │  GEN   ${entry.filename} ...`);
        const b64 = await generateImage(entry.prompt, SIZE, MODEL);
        fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
        generated++;
        console.log(` done`);
      } catch (err) {
        console.log(` FAILED: ${err.message}`);
      }

      // Rate limit: 1 second between requests
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(`  └─ done`);
  }

  console.log(`\n  ✓ ${generated}/${totalImages} images generated.`);
  if (generated > 0) {
    console.log(`  ✓ Images saved to: ${assetsDir}`);
    console.log(`\n  NEXT STEP: Update categories.js to use require() for these images.`);
    console.log(`  Example:   image: require('../../assets/images/landmarks/eiffel-tower.png')\n`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
