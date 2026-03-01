#!/usr/bin/env python3
"""
============================================================
SQUINT — Photorealistic Image Generator
============================================================

Generates photorealistic game images using Flux 2 Pro via Replicate API.
Uses "camera-first" prompting to lock the model into real-photo mode.

SETUP:
  pip install replicate requests
  export REPLICATE_API_TOKEN="your-token-here"
  (Get token at: https://replicate.com/account/api-tokens)

USAGE:
  python3 scripts/generate-flux-images.py                          # Generate all
  python3 scripts/generate-flux-images.py --category landmarks     # One category
  python3 scripts/generate-flux-images.py --dry-run                # Preview prompts
  python3 scripts/generate-flux-images.py --list                   # List all entries
  python3 scripts/generate-flux-images.py --force                  # Re-generate existing

COST: ~$0.055/image × 30 images = ~$1.65 total
MODEL: Black Forest Labs Flux 2 Pro (black-forest-labs/flux-2-pro)

============================================================
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import replicate
import requests

# ────────────────────────────────────────────
# Paths
# ────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
ASSETS_DIR = SCRIPT_DIR.parent / "assets" / "images"

# ────────────────────────────────────────────
# Camera-first prompt templates
# The key insight: lead with photographic medium so the model
# locks into "real photo" mode before rendering the subject.
# ────────────────────────────────────────────

# Different camera setups for variety
CAMERAS = {
    "landscape_wide": "photograph shot on Fujifilm GFX 100S 32-64mm f/4, golden hour light, sharp detail, natural colors",
    "landscape_tele": "photograph shot on Nikon Z9 70-200mm f/2.8, crystal clear atmosphere, rich tones",
    "street": "candid photograph shot on Fujifilm X-T4 23mm f/2.0, available light, subtle grain, muted tones",
    "object_studio": "product photograph shot on Canon R5 100mm f/2.8 macro, studio lighting, crisp detail, white seamless background",
    "object_natural": "photograph shot on Sony A7IV 35mm f/1.4, natural window light, shallow depth of field, warm tones",
    "action": "photograph shot on Sony A1 70-200mm f/2.8, 1/2000s freeze frame, sharp detail, vivid colors",
    "aerial": "aerial photograph shot on DJI Mavic 3 Hasselblad, overhead perspective, crystal clear detail",
    "moody": "photograph shot on Leica Q3 28mm f/1.7, dramatic light, deep shadows, film-like rendering",
}

# ────────────────────────────────────────────
# All 30 image prompts organized by category
# ────────────────────────────────────────────

IMAGE_PROMPTS: dict[str, list[dict]] = {
    "landmarks": [
        {
            "filename": "eiffel-tower.png",
            "camera": "landscape_wide",
            "prompt": "the Eiffel Tower in Paris, full structure visible, shot from Champ de Mars, blue sky with wispy clouds, green lawn in foreground, iconic iron lattice detail",
        },
        {
            "filename": "great-wall.png",
            "camera": "landscape_tele",
            "prompt": "the Great Wall of China winding across mountain ridges, ancient stone watchtower in foreground, misty green mountains receding into distance, dramatic perspective",
        },
        {
            "filename": "statue-of-liberty.png",
            "camera": "landscape_wide",
            "prompt": "the Statue of Liberty on Liberty Island, full statue with pedestal, torch raised high, green patina copper, New York harbor water, blue sky",
        },
        {
            "filename": "taj-mahal.png",
            "camera": "landscape_wide",
            "prompt": "the Taj Mahal in Agra India, symmetrical front view from the reflecting pool, white marble dome and minarets, long reflecting pool with cypress trees lining both sides",
        },
        {
            "filename": "colosseum.png",
            "camera": "landscape_wide",
            "prompt": "the Roman Colosseum in Rome Italy, exterior view showing the famous arched facade, ancient stone architecture, warm afternoon light, some tourists for scale",
        },
        {
            "filename": "machu-picchu.png",
            "camera": "aerial",
            "prompt": "Machu Picchu ancient Incan citadel in Peru, terraced stone ruins on mountain ridge, Huayna Picchu peak rising behind, morning mist in the valley below, lush green mountains",
        },
        {
            "filename": "sydney-opera-house.png",
            "camera": "landscape_wide",
            "prompt": "the Sydney Opera House, iconic white shell-shaped roof sails, shot from across the harbor, deep blue water in foreground, clear sky, Harbour Bridge visible in background",
        },
        {
            "filename": "big-ben.png",
            "camera": "landscape_tele",
            "prompt": "Big Ben clock tower at the Palace of Westminster in London, Elizabeth Tower with golden clock face, Gothic Revival architecture, dramatic clouds, classic London scene",
        },
        {
            "filename": "christ-redeemer.png",
            "camera": "landscape_wide",
            "prompt": "Christ the Redeemer statue on Corcovado mountain in Rio de Janeiro Brazil, arms outstretched, Art Deco soapstone figure, blue sky, city and Sugarloaf Mountain visible below",
        },
        {
            "filename": "golden-gate.png",
            "camera": "landscape_wide",
            "prompt": "the Golden Gate Bridge in San Francisco, iconic International Orange suspension bridge spanning the bay, shot from Battery Spencer viewpoint, fog rolling under the bridge, dramatic composition",
        },
        {
            "filename": "petra.png",
            "camera": "landscape_wide",
            "prompt": "the Treasury facade of Petra in Jordan, rose-red sandstone carved into a narrow canyon wall called the Siq, intricate Hellenistic columns and pediments, warm golden light illuminating the rock face",
        },
        {
            "filename": "angkor-wat.png",
            "camera": "landscape_wide",
            "prompt": "Angkor Wat temple complex in Siem Reap Cambodia, five lotus-shaped towers reflected perfectly in the moat water, ancient sandstone architecture, sunrise golden light, palm trees framing the scene",
        },
        {
            "filename": "pyramids-of-giza.png",
            "camera": "landscape_wide",
            "prompt": "the three Great Pyramids of Giza in Egypt, massive limestone pyramids rising from the desert sand, the Great Sphinx visible in foreground, clear blue sky, warm desert light, Cairo skyline faintly visible in background",
        },
        {
            "filename": "mount-rushmore.png",
            "camera": "landscape_tele",
            "prompt": "Mount Rushmore National Memorial in South Dakota, four presidential faces carved into granite mountainside, Washington Jefferson Roosevelt Lincoln, pine trees at the base, clear sky, dramatic American monument",
        },
        {
            "filename": "stonehenge.png",
            "camera": "landscape_wide",
            "prompt": "Stonehenge prehistoric stone circle on Salisbury Plain in Wiltshire England, massive sarsen stone trilithons arranged in a circle, green grass field, dramatic cloudy sky, ancient mysterious atmosphere",
        },
        {
            "filename": "burj-khalifa.png",
            "camera": "landscape_tele",
            "prompt": "the Burj Khalifa supertall skyscraper in Dubai UAE, gleaming glass and steel tower soaring into clear blue sky, Y-shaped floor plan visible, modern city skyline below, world's tallest building",
        },
        {
            "filename": "leaning-tower-of-pisa.png",
            "camera": "landscape_tele",
            "prompt": "the Leaning Tower of Pisa in Tuscany Italy, white marble Romanesque bell tower tilting to one side, multiple levels of arched colonnades, green grass of Piazza dei Miracoli, blue sky, cathedral partially visible",
        },
        {
            "filename": "chichen-itza.png",
            "camera": "landscape_wide",
            "prompt": "the Temple of Kukulcan pyramid at Chichen Itza in Yucatan Mexico, stepped limestone pyramid with flat top, ancient Mayan architecture, green grass plaza, clear blue sky, dramatic stone serpent head at base of stairs",
        },
        {
            "filename": "sagrada-familia.png",
            "camera": "landscape_tele",
            "prompt": "La Sagrada Familia basilica in Barcelona Spain, Antoni Gaudi's unfinished masterpiece, fantastical organic spires and towers, intricate stone facades with religious sculptures, construction cranes visible, warm Mediterranean light",
        },
        {
            "filename": "niagara-falls.png",
            "camera": "landscape_wide",
            "prompt": "Niagara Falls Horseshoe Falls on the US-Canadian border, massive curtain of water plunging over rocky cliff edge, enormous mist cloud rising, turquoise water, rainbow in the spray, tourist boat below for scale",
        },
    ],
    "whats-happening": [
        {
            "filename": "man-on-bike.png",
            "camera": "action",
            "prompt": "a man riding a bicycle down a city street, cycling fast, urban environment, motion and energy, casual athletic clothing, daytime",
        },
        {
            "filename": "woman-jumping.png",
            "camera": "action",
            "prompt": "a young woman jumping joyfully in the air outdoors, arms spread wide, big smile, park setting with green grass, sunshine, pure happiness and freedom",
        },
        {
            "filename": "kid-kite.png",
            "camera": "street",
            "prompt": "a child running across an open grassy field flying a colorful kite high in the sky, windy day, string visible, bright colored diamond kite against blue sky",
        },
        {
            "filename": "dog-frisbee.png",
            "camera": "action",
            "prompt": "an energetic dog leaping high into the air to catch a red frisbee in a park, athletic mid-air jump, tongue out, green grass field, action shot",
        },
        {
            "filename": "dancing-rain.png",
            "camera": "moody",
            "prompt": "a couple dancing together in the rain on a city street at night, romantic scene, rain drops visible, wet pavement reflecting streetlights, umbrellas abandoned, joyful embrace",
        },
        {
            "filename": "skateboarding.png",
            "camera": "action",
            "prompt": "a skateboarder performing a kickflip trick at a concrete skatepark, mid-air, skateboard flipping under feet, wearing casual street clothes and helmet, dynamic angle",
        },
        {
            "filename": "pizza-toss.png",
            "camera": "street",
            "prompt": "a pizza chef tossing pizza dough high in the air inside a pizzeria kitchen, flour dusting the air, white chef uniform, wood-fired oven glowing in background, skilled hands",
        },
        {
            "filename": "hammock-reading.png",
            "camera": "object_natural",
            "prompt": "a person relaxing in a hammock reading a book, strung between two palm trees, tropical beach setting, dappled sunlight, bare feet, peaceful lazy afternoon",
        },
        {
            "filename": "street-musician.png",
            "camera": "street",
            "prompt": "a street musician playing a saxophone on a city sidewalk, jazz performance, instrument gleaming gold, open instrument case with tips, cobblestone street, warm evening light",
        },
        {
            "filename": "snowball-fight.png",
            "camera": "action",
            "prompt": "children having an energetic snowball fight in a snowy backyard, throwing snowballs, laughing faces, winter coats and hats, snow-covered trees, white winter wonderland",
        },
        {
            "filename": "surfing-wave.png",
            "camera": "action",
            "prompt": "a surfer riding a large turquoise ocean wave, crouching low on a surfboard, wetsuit, spray of white water, tropical beach in background, athletic action shot, bright sunny day",
        },
        {
            "filename": "tug-of-war.png",
            "camera": "action",
            "prompt": "two teams of kids playing tug of war outdoors, pulling a thick rope in opposite directions, digging heels into grass, straining faces, school field day atmosphere, bright sunny day",
        },
        {
            "filename": "birthday-candles.png",
            "camera": "object_natural",
            "prompt": "a child blowing out birthday candles on a decorated cake, puffed cheeks, party hats, colorful frosted cake with lit candles, birthday party atmosphere, warm indoor lighting, friends gathered around",
        },
        {
            "filename": "painter-easel.png",
            "camera": "street",
            "prompt": "an artist painting at a wooden easel in a bright sunlit studio, holding a paint palette with oil colors, brush applying strokes to a landscape canvas, paint-splattered smock, creative atmosphere",
        },
        {
            "filename": "walking-dog.png",
            "camera": "street",
            "prompt": "a person walking a golden retriever on a leash down a tree-lined suburban sidewalk, casual clothing, autumn leaves on the ground, peaceful neighborhood, warm afternoon light",
        },
        {
            "filename": "casting-line.png",
            "camera": "landscape_wide",
            "prompt": "a fisherman casting a fly fishing line over a scenic mountain river, rod arcing overhead, fishing line visible mid-air, wearing waders and vest, misty morning light, rocky stream bed, pine trees",
        },
        {
            "filename": "merry-go-round.png",
            "camera": "street",
            "prompt": "children riding a colorful carousel merry-go-round at a fairground, painted wooden horses bobbing up and down, twinkling lights and mirrors, bright carnival atmosphere, joyful expressions",
        },
        {
            "filename": "doing-yoga.png",
            "camera": "object_natural",
            "prompt": "a woman doing a tree pose yoga position on a yoga mat in a serene sunlit studio, balanced on one leg with arms raised, peaceful expression, minimalist room with plants, warm natural light",
        },
        {
            "filename": "firefighter-hose.png",
            "camera": "action",
            "prompt": "a firefighter in full turnout gear and helmet spraying a powerful stream of water from a fire hose, dramatic angle, smoke in background, protective breathing apparatus, intense action scene",
        },
        {
            "filename": "barber-cutting.png",
            "camera": "street",
            "prompt": "a barber cutting a man's hair in a classic barbershop, using electric clippers for a fade, barber cape on client, vintage barber chair, mirrors and traditional barbershop interior, warm lighting",
        },
    ],
    "everyday-objects": [
        {
            "filename": "red-sneakers.png",
            "camera": "object_natural",
            "prompt": "a pair of bright red sneakers on a wooden floor, classic canvas high-top style, white rubber soles, white laces, slightly worn and lived-in, top-down angle",
        },
        {
            "filename": "typewriter.png",
            "camera": "object_natural",
            "prompt": "a vintage mechanical typewriter on a wooden desk, black metal body with round glass keys, paper loaded and partially typed, warm nostalgic lighting, retro aesthetic",
        },
        {
            "filename": "pancakes.png",
            "camera": "object_natural",
            "prompt": "a tall stack of fluffy golden pancakes on a white plate, dripping with maple syrup, pat of butter melting on top, fresh berries scattered around, breakfast table setting",
        },
        {
            "filename": "guitar.png",
            "camera": "object_natural",
            "prompt": "a beautiful acoustic guitar leaning against a sunlit wall, warm wood grain body, steel strings, classic dreadnought shape, natural window light, musician's living room",
        },
        {
            "filename": "rotary-phone.png",
            "camera": "object_natural",
            "prompt": "a vintage rotary dial telephone, classic mid-century design, round numbered dial, coiled handset cord, sitting on a side table, warm retro color palette",
        },
        {
            "filename": "hot-air-balloon.png",
            "camera": "landscape_wide",
            "prompt": "a single colorful hot air balloon floating in a clear blue sky, vibrant rainbow-striped envelope fully inflated, wicker basket below, puffy white clouds, festival atmosphere",
        },
        {
            "filename": "polaroid-camera.png",
            "camera": "object_studio",
            "prompt": "a classic white Polaroid instant camera, iconic square body design, rainbow stripe, viewfinder and lens visible, slightly angled hero shot, clean minimal background",
        },
        {
            "filename": "disco-ball.png",
            "camera": "moody",
            "prompt": "a shimmering disco ball hanging from a dark ceiling, hundreds of tiny mirror tiles catching colored lights, beams of light scattered across the room, party atmosphere, sparkle",
        },
        {
            "filename": "school-bus.png",
            "camera": "street",
            "prompt": "a classic yellow American school bus parked on a suburban street, iconic flat-nose design, black lettering reading SCHOOL BUS, red stop sign arm, clear day",
        },
        {
            "filename": "rubiks-cube.png",
            "camera": "object_natural",
            "prompt": "a Rubik's cube sitting on a table, classic 3x3 puzzle, partially solved with colorful scrambled faces visible, red blue green yellow orange white squares, sharp focus",
        },
        {
            "filename": "vintage-globe.png",
            "camera": "object_natural",
            "prompt": "a vintage desktop globe on a brass stand, faded antique map showing continents and oceans, brass meridian ring, sitting on a wooden desk in a study, warm library lighting, leather books in background",
        },
        {
            "filename": "cactus-in-a-pot.png",
            "camera": "object_natural",
            "prompt": "a small prickly cactus in a terracotta clay pot on a sunny windowsill, green spiny succulent, desert plant, simple and charming, natural window light, minimalist indoor garden aesthetic",
        },
        {
            "filename": "lava-lamp.png",
            "camera": "moody",
            "prompt": "a classic lava lamp glowing on a dark surface, cone-shaped base, glass cylinder with colorful wax blobs floating and rising in illuminated liquid, retro 1960s aesthetic, psychedelic warm glow",
        },
        {
            "filename": "fire-hydrant.png",
            "camera": "street",
            "prompt": "a bright red fire hydrant on a city sidewalk, classic American style with two nozzle caps and a bonnet on top, concrete pavement, urban street scene, slight wear and chipped paint",
        },
        {
            "filename": "grandfather-clock.png",
            "camera": "object_natural",
            "prompt": "a tall grandfather clock standing against a wall in a traditional living room, ornate dark wood case, pendulum visible through glass panel, roman numeral clock face, warm ambient lighting",
        },
        {
            "filename": "telescope.png",
            "camera": "object_natural",
            "prompt": "a brass and black telescope on a wooden tripod, pointed slightly upward, sitting near a window at night, starry sky visible outside, classic refractor design, astronomer's study setting",
        },
        {
            "filename": "vintage-suitcase.png",
            "camera": "object_natural",
            "prompt": "a vintage leather suitcase with brass latches and corner protectors, covered in colorful travel stickers from old hotels, warm brown leather, sitting on a wooden floor, nostalgic travel aesthetic",
        },
        {
            "filename": "popcorn-machine.png",
            "camera": "street",
            "prompt": "a classic red and gold popcorn machine cart, glass cabinet filled with freshly popped popcorn, heated kettle visible inside, carnival fairground setting, warm inviting glow, movie theater vibes",
        },
        {
            "filename": "vinyl-record-player.png",
            "camera": "object_natural",
            "prompt": "a vintage turntable record player with a black vinyl record spinning on the platter, tonearm with stylus resting on the groove, wooden base, warm retro living room setting, audiophile aesthetic",
        },
        {
            "filename": "red-fire-extinguisher.png",
            "camera": "object_natural",
            "prompt": "a bright red fire extinguisher mounted on a white wall with a metal bracket, pressurized steel cylinder with black squeeze handle and safety pin, rubber hose nozzle, safety equipment",
        },
    ],
}

# ────────────────────────────────────────────
# Flux 2 Pro generation config
# ────────────────────────────────────────────

FLUX_MODEL = "black-forest-labs/flux-2-pro"
DEFAULT_CONFIG = {
    "aspect_ratio": "1:1",      # Square for game tiles
    "output_format": "png",
    "output_quality": 95,
    "safety_tolerance": 5,      # Landmarks/objects don't need strict filtering
    "prompt_upsampling": False,  # We craft precise prompts — don't auto-modify
}


def build_prompt(entry: dict) -> str:
    """Build a camera-first prompt from an entry's fields."""
    camera_prefix = CAMERAS[entry["camera"]]
    scene = entry["prompt"]
    return f"{camera_prefix}. {scene}"


def generate_image(prompt: str, config: dict | None = None) -> str:
    """Call Flux 2 Pro via Replicate and return the output image URL."""
    cfg = {**DEFAULT_CONFIG, **(config or {})}

    output = replicate.run(
        FLUX_MODEL,
        input={
            "prompt": prompt,
            **cfg,
        },
    )

    # Replicate returns a FileOutput object or URL string
    if hasattr(output, "url"):
        return output.url
    return str(output)


def download_file(url: str, dest: Path) -> int:
    """Download a file and return bytes written."""
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    return len(resp.content)


def save_metadata(dest: Path, entry: dict, prompt: str, image_url: str):
    """Save a JSON sidecar with generation metadata."""
    meta_path = dest.with_suffix(".json")
    meta = {
        "filename": entry["filename"],
        "model": FLUX_MODEL,
        "prompt": prompt,
        "camera_preset": entry["camera"],
        "config": DEFAULT_CONFIG,
        "source_url": image_url,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    meta_path.write_text(json.dumps(meta, indent=2))


# ────────────────────────────────────────────
# CLI
# ────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Generate photorealistic Squint images with Flux 2 Pro")
    parser.add_argument("--category", help="Only generate one category (landmarks, whats-happening, everyday-objects)")
    parser.add_argument("--dry-run", action="store_true", help="Preview prompts without generating")
    parser.add_argument("--list", action="store_true", help="List all entries and exit")
    parser.add_argument("--force", action="store_true", help="Re-generate even if image exists")
    parser.add_argument("--no-metadata", action="store_true", help="Skip saving JSON sidecar files")
    args = parser.parse_args()

    if args.list:
        print("\n  All Squint image entries:\n")
        for cat_id, entries in IMAGE_PROMPTS.items():
            print(f"  {cat_id.upper()}:")
            for e in entries:
                print(f"    {e['filename']:30s} [{e['camera']}]")
            print()
        total = sum(len(v) for v in IMAGE_PROMPTS.values())
        print(f"  Total: {total} images (~${total * 0.055:.2f} at $0.055/image)\n")
        return

    # Validate API token
    token = os.environ.get("REPLICATE_API_TOKEN")
    if not token and not args.dry_run:
        print("\n  ERROR: REPLICATE_API_TOKEN not set.\n")
        print("  Get your token at: https://replicate.com/account/api-tokens")
        print("  Then: export REPLICATE_API_TOKEN=\"your-token-here\"\n")
        print("  Or use --dry-run to preview prompts.\n")
        sys.exit(1)

    # Filter categories
    if args.category:
        if args.category not in IMAGE_PROMPTS:
            print(f"\n  Unknown category: '{args.category}'")
            print(f"  Available: {', '.join(IMAGE_PROMPTS.keys())}\n")
            sys.exit(1)
        categories = {args.category: IMAGE_PROMPTS[args.category]}
    else:
        categories = IMAGE_PROMPTS

    total = sum(len(v) for v in categories.values())
    downloaded = 0
    skipped = 0
    failed = 0

    print()
    print("  ╔═══════════════════════════════════════════╗")
    print("  ║  SQUINT — Flux 2 Pro Image Generator      ║")
    print("  ║  Photorealistic · Camera-First Prompting   ║")
    print("  ╚═══════════════════════════════════════════╝")
    print()

    if not args.dry_run:
        cost = total * 0.055
        print(f"  Generating {total} images · Estimated cost: ${cost:.2f}")
        print(f"  Model: {FLUX_MODEL}")
        print()

    for cat_id, entries in categories.items():
        cat_dir = ASSETS_DIR / cat_id
        cat_dir.mkdir(parents=True, exist_ok=True)

        print(f"  ┌─ {cat_id.upper()} ({len(entries)} images)")

        for entry in entries:
            file_path = cat_dir / entry["filename"]
            prompt = build_prompt(entry)

            # Skip existing unless --force
            if file_path.exists() and not args.force:
                size_kb = file_path.stat().st_size / 1024
                if size_kb > 500:  # Real Flux images are 1-2MB; Canvas ones are 30-100KB
                    print(f"  │  SKIP  {entry['filename']} ({size_kb:.0f}KB — already photorealistic)")
                    skipped += 1
                    continue

            if args.dry_run:
                print(f"  │  DRY   {entry['filename']}")
                print(f"  │        Camera: {entry['camera']}")
                print(f"  │        Prompt: {prompt[:100]}...")
                print(f"  │")
                continue

            try:
                print(f"  │  GEN   {entry['filename']} ...", end="", flush=True)
                image_url = generate_image(prompt)
                print(f" downloading ...", end="", flush=True)

                nbytes = download_file(image_url, file_path)
                downloaded += 1
                print(f" done ({nbytes / 1024:.0f}KB)")

                if not args.no_metadata:
                    save_metadata(file_path, entry, prompt, image_url)

            except Exception as e:
                failed += 1
                print(f" FAILED: {e}")

            # Small delay between API calls
            time.sleep(0.5)

        print(f"  └─ done")
        print()

    print(f"  ────────────────────────────────────────")
    print(f"  Generated:  {downloaded}")
    print(f"  Skipped:    {skipped}")
    print(f"  Failed:     {failed}")
    print(f"  Total:      {total}")
    if downloaded > 0:
        print(f"  Est. cost:  ${downloaded * 0.055:.2f}")
    print(f"  ────────────────────────────────────────")
    print()

    if downloaded > 0:
        print(f"  Images saved to: {ASSETS_DIR}")
        print(f"  Model: {FLUX_MODEL}")
        print()


if __name__ == "__main__":
    main()
