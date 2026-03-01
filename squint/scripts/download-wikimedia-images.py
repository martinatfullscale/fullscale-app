#!/usr/bin/env python3
"""
============================================================
SQUINT — Wikimedia Commons Image Downloader
============================================================

Downloads free-to-use portrait photos of public figures from
Wikimedia Commons for the people-based categories.

NO API KEY NEEDED — Wikimedia Commons is free and open.

SETUP:
  pip install requests Pillow

USAGE:
  python3 scripts/download-wikimedia-images.py                          # Download all
  python3 scripts/download-wikimedia-images.py --category hip-hop       # One category
  python3 scripts/download-wikimedia-images.py --dry-run                # Preview URLs
  python3 scripts/download-wikimedia-images.py --list                   # List all entries
  python3 scripts/download-wikimedia-images.py --force                  # Re-download existing
  python3 scripts/download-wikimedia-images.py --person "Drake"         # One person only

COST: FREE (Wikimedia Commons, Creative Commons licensed)
OUTPUT: 1024×1024 center-cropped PNGs in assets/images/<category>/

============================================================
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from io import BytesIO
from pathlib import Path
from urllib.parse import quote

import requests

try:
    from PIL import Image
except ImportError:
    print("\n  ERROR: Pillow not installed.\n")
    print("  Run: pip install Pillow\n")
    sys.exit(1)

# ────────────────────────────────────────────
# Paths
# ────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
ASSETS_DIR = SCRIPT_DIR.parent / "assets" / "images"

# ────────────────────────────────────────────
# Wikimedia Commons API
# ────────────────────────────────────────────

WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "SquintGameBot/1.0 (trivia game; contact: dev@squint.app)"
TARGET_SIZE = 1024  # Output square size

HEADERS = {
    "User-Agent": USER_AGENT,
}


def get_wikipedia_image(person_name: str, wikipedia_title: str | None = None) -> dict | None:
    """Get the main infobox image from a person's Wikipedia page.
    This is the most reliable approach — every famous person has a Wikipedia
    page with a primary photo that's hosted on Wikimedia Commons.

    If wikipedia_title is provided, use it directly (skips search).
    Otherwise, search Wikipedia for the person's name.
    """

    if wikipedia_title:
        page_title = wikipedia_title
    else:
        # Search Wikipedia for the person's page
        search_params = {
            "action": "query",
            "format": "json",
            "list": "search",
            "srsearch": person_name,
            "srlimit": 1,
        }
        resp = requests.get(WIKIPEDIA_API, params=search_params, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        search_data = resp.json()

        results = search_data.get("query", {}).get("search", [])
        if not results:
            return None

        page_title = results[0]["title"]

    # Get the page's primary image (from infobox / pageimage)
    image_params = {
        "action": "query",
        "format": "json",
        "titles": page_title,
        "prop": "pageimages|images",
        "piprop": "original|thumbnail",
        "pithumbsize": TARGET_SIZE,
        "pilimit": 1,
    }
    resp = requests.get(WIKIPEDIA_API, params=image_params, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    image_data = resp.json()

    pages = image_data.get("query", {}).get("pages", {})
    for page in pages.values():
        pi = page.get("pageimage")
        original = page.get("original", {})
        thumbnail = page.get("thumbnail", {})

        if not pi:
            continue

        image_url = thumbnail.get("source") or original.get("source")
        if not image_url:
            continue

        # Step 3: Get Commons metadata for the image file
        file_title = f"File:{pi}"
        meta_params = {
            "action": "query",
            "format": "json",
            "titles": file_title,
            "prop": "imageinfo",
            "iiprop": "url|size|mime|extmetadata",
            "iiurlwidth": TARGET_SIZE,
        }
        resp = requests.get(COMMONS_API, params=meta_params, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        meta_data = resp.json()

        meta_pages = meta_data.get("query", {}).get("pages", {})
        license_str = "unknown"
        artist_str = "unknown"
        desc_url = ""
        for mp in meta_pages.values():
            mi = mp.get("imageinfo", [{}])[0]
            if mi:
                ext = mi.get("extmetadata", {})
                license_str = ext.get("LicenseShortName", {}).get("value", "unknown")
                artist_str = ext.get("Artist", {}).get("value", "unknown")
                desc_url = mi.get("descriptionurl", "")
                # Prefer the Commons thumb URL if available
                if mi.get("thumburl"):
                    image_url = mi["thumburl"]

        return {
            "title": file_title,
            "url": image_url,
            "width": thumbnail.get("width") or original.get("width", 0),
            "height": thumbnail.get("height") or original.get("height", 0),
            "desc_url": desc_url,
            "license": license_str,
            "artist": artist_str,
            "wikipedia_page": page_title,
        }

    return None


def search_commons_fallback(query: str, limit: int = 5) -> list[dict]:
    """Fallback: search Commons directly if Wikipedia approach fails."""
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": f"File: {query}",
        "gsrlimit": limit,
        "gsrnamespace": 6,
        "prop": "imageinfo",
        "iiprop": "url|size|mime|extmetadata",
        "iiurlwidth": TARGET_SIZE,
    }
    resp = requests.get(COMMONS_API, params=params, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    pages = data.get("query", {}).get("pages", {})
    results = []
    for page in pages.values():
        info = page.get("imageinfo", [{}])[0]
        if not info:
            continue
        mime = info.get("mime", "")
        if mime not in ("image/jpeg", "image/png", "image/webp"):
            continue
        results.append({
            "title": page.get("title", ""),
            "url": info.get("thumburl") or info.get("url"),
            "width": info.get("thumbwidth") or info.get("width"),
            "height": info.get("thumbheight") or info.get("height"),
            "desc_url": info.get("descriptionurl", ""),
            "license": (info.get("extmetadata", {})
                        .get("LicenseShortName", {})
                        .get("value", "unknown")),
            "artist": (info.get("extmetadata", {})
                       .get("Artist", {})
                       .get("value", "unknown")),
        })

    results.sort(key=lambda r: r.get("width", 0), reverse=True)
    return results


def download_and_crop(url: str, dest: Path, size: int = TARGET_SIZE) -> int:
    """Download an image, center-crop to square, resize, and save as PNG."""
    resp = requests.get(url, headers=HEADERS, timeout=120)
    resp.raise_for_status()

    img = Image.open(BytesIO(resp.content))

    # Convert to RGB if needed (handles RGBA, P mode, etc.)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")

    # Center crop to square
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))

    # Resize to target
    img = img.resize((size, size), Image.LANCZOS)

    # Save as PNG
    img.save(dest, "PNG", optimize=True)
    return dest.stat().st_size


def save_attribution(dest: Path, entry: dict, result: dict):
    """Save a JSON file with licensing/attribution metadata."""
    meta_path = dest.with_suffix(".attribution.json")
    meta = {
        "person": entry["name"],
        "source": "Wikimedia Commons",
        "source_url": result.get("desc_url", ""),
        "license": result.get("license", "unknown"),
        "artist": result.get("artist", "unknown"),
        "original_url": result.get("url", ""),
        "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    meta_path.write_text(json.dumps(meta, indent=2))


# ────────────────────────────────────────────
# People data — maps category to list of people
# Search terms can be customized for better results
# ────────────────────────────────────────────

PEOPLE: dict[str, list[dict]] = {
    "hip-hop": [
        {"name": "Drake", "filename": "drake.jpg", "wikipedia": "Drake (musician)", "search": "Drake rapper"},
        {"name": "Jay-Z", "filename": "jay-z.jpg", "wikipedia": "Jay-Z", "search": "Jay-Z rapper"},
        {"name": "Kendrick Lamar", "filename": "kendrick-lamar.jpg", "wikipedia": "Kendrick Lamar", "search": "Kendrick Lamar"},
        {"name": "Nicki Minaj", "filename": "nicki-minaj.jpg", "wikipedia": "Nicki Minaj", "search": "Nicki Minaj"},
        {"name": "Kanye West", "filename": "kanye-west.jpg", "wikipedia": "Kanye West", "search": "Kanye West rapper"},
        {"name": "Lil Wayne", "filename": "lil-wayne.jpg", "wikipedia": "Lil Wayne", "search": "Lil Wayne rapper"},
        {"name": "Cardi B", "filename": "cardi-b.jpg", "wikipedia": "Cardi B", "search": "Cardi B rapper"},
        {"name": "Travis Scott", "filename": "travis-scott.jpg", "wikipedia": "Travis Scott", "search": "Travis Scott rapper"},
        {"name": "Snoop Dogg", "filename": "snoop-dogg.jpg", "wikipedia": "Snoop Dogg", "search": "Snoop Dogg"},
        {"name": "Megan Thee Stallion", "filename": "megan-thee-stallion.jpg", "wikipedia": "Megan Thee Stallion", "search": "Megan Thee Stallion"},
    ],
    "pop-stars": [
        {"name": "Taylor Swift", "filename": "taylor-swift.jpg", "wikipedia": "Taylor Swift", "search": "Taylor Swift"},
        {"name": "Ariana Grande", "filename": "ariana-grande.jpg", "wikipedia": "Ariana Grande", "search": "Ariana Grande"},
        {"name": "Billie Eilish", "filename": "billie-eilish.jpg", "wikipedia": "Billie Eilish", "search": "Billie Eilish"},
        {"name": "Ed Sheeran", "filename": "ed-sheeran.jpg", "wikipedia": "Ed Sheeran", "search": "Ed Sheeran"},
        {"name": "Justin Bieber", "filename": "justin-bieber.jpg", "wikipedia": "Justin Bieber", "search": "Justin Bieber"},
        {"name": "Lady Gaga", "filename": "lady-gaga.jpg", "wikipedia": "Lady Gaga", "search": "Lady Gaga"},
        {"name": "Harry Styles", "filename": "harry-styles.jpg", "wikipedia": "Harry Styles", "search": "Harry Styles"},
        {"name": "Dua Lipa", "filename": "dua-lipa.jpg", "wikipedia": "Dua Lipa", "search": "Dua Lipa"},
        {"name": "The Weeknd", "filename": "the-weeknd.jpg", "wikipedia": "The Weeknd", "search": "The Weeknd"},
        {"name": "Olivia Rodrigo", "filename": "olivia-rodrigo.jpg", "wikipedia": "Olivia Rodrigo", "search": "Olivia Rodrigo"},
    ],
    "iconic-women": [
        {"name": "Oprah Winfrey", "filename": "oprah-winfrey.jpg", "wikipedia": "Oprah Winfrey", "search": "Oprah Winfrey"},
        {"name": "Michelle Obama", "filename": "michelle-obama.jpg", "wikipedia": "Michelle Obama", "search": "Michelle Obama"},
        {"name": "Serena Williams", "filename": "serena-williams.jpg", "wikipedia": "Serena Williams", "search": "Serena Williams"},
        {"name": "Beyoncé", "filename": "beyonce.jpg", "wikipedia": "Beyoncé", "search": "Beyoncé singer"},
        {"name": "Kamala Harris", "filename": "kamala-harris.jpg", "wikipedia": "Kamala Harris", "search": "Kamala Harris"},
        {"name": "Viola Davis", "filename": "viola-davis.jpg", "wikipedia": "Viola Davis", "search": "Viola Davis"},
        {"name": "Simone Biles", "filename": "simone-biles.jpg", "wikipedia": "Simone Biles", "search": "Simone Biles"},
        {"name": "Dolly Parton", "filename": "dolly-parton.jpg", "wikipedia": "Dolly Parton", "search": "Dolly Parton"},
        {"name": "Ruth Bader Ginsburg", "filename": "ruth-bader-ginsburg.jpg", "wikipedia": "Ruth Bader Ginsburg", "search": "Ruth Bader Ginsburg"},
        {"name": "Maya Angelou", "filename": "maya-angelou.jpg", "wikipedia": "Maya Angelou", "search": "Maya Angelou"},
    ],
    "nba-legends": [
        {"name": "Michael Jordan", "filename": "michael-jordan.jpg", "wikipedia": "Michael Jordan", "search": "Michael Jordan basketball"},
        {"name": "LeBron James", "filename": "lebron-james.jpg", "wikipedia": "LeBron James", "search": "LeBron James"},
        {"name": "Kobe Bryant", "filename": "kobe-bryant.jpg", "wikipedia": "Kobe Bryant", "search": "Kobe Bryant"},
        {"name": "Stephen Curry", "filename": "stephen-curry.jpg", "wikipedia": "Stephen Curry", "search": "Stephen Curry"},
        {"name": "Magic Johnson", "filename": "magic-johnson.jpg", "wikipedia": "Magic Johnson", "search": "Magic Johnson"},
        {"name": "Shaquille O'Neal", "filename": "shaquille-oneal.jpg", "wikipedia": "Shaquille O'Neal", "search": "Shaquille O'Neal"},
        {"name": "Kevin Durant", "filename": "kevin-durant.jpg", "wikipedia": "Kevin Durant", "search": "Kevin Durant"},
        {"name": "Allen Iverson", "filename": "allen-iverson.jpg", "wikipedia": "Allen Iverson", "search": "Allen Iverson"},
        {"name": "Tim Duncan", "filename": "tim-duncan.jpg", "wikipedia": "Tim Duncan", "search": "Tim Duncan"},
        {"name": "Wilt Chamberlain", "filename": "wilt-chamberlain.jpg", "wikipedia": "Wilt Chamberlain", "search": "Wilt Chamberlain"},
    ],
    "hollywood": [
        {"name": "Denzel Washington", "filename": "denzel-washington.jpg", "wikipedia": "Denzel Washington", "search": "Denzel Washington"},
        {"name": "Leonardo DiCaprio", "filename": "leonardo-dicaprio.jpg", "wikipedia": "Leonardo DiCaprio", "search": "Leonardo DiCaprio"},
        {"name": "Meryl Streep", "filename": "meryl-streep.jpg", "wikipedia": "Meryl Streep", "search": "Meryl Streep"},
        {"name": "Will Smith", "filename": "will-smith.jpg", "wikipedia": "Will Smith", "search": "Will Smith actor"},
        {"name": "Scarlett Johansson", "filename": "scarlett-johansson.jpg", "wikipedia": "Scarlett Johansson", "search": "Scarlett Johansson"},
        {"name": "Samuel L. Jackson", "filename": "samuel-l-jackson.jpg", "wikipedia": "Samuel L. Jackson", "search": "Samuel L. Jackson"},
        {"name": "Jennifer Aniston", "filename": "jennifer-aniston.jpg", "wikipedia": "Jennifer Aniston", "search": "Jennifer Aniston"},
        {"name": "Brad Pitt", "filename": "brad-pitt.jpg", "wikipedia": "Brad Pitt", "search": "Brad Pitt"},
        {"name": "Zendaya", "filename": "zendaya.jpg", "wikipedia": "Zendaya", "search": "Zendaya actress"},
        {"name": "Morgan Freeman", "filename": "morgan-freeman.jpg", "wikipedia": "Morgan Freeman", "search": "Morgan Freeman"},
    ],
    "rnb-icons": [
        {"name": "Rihanna", "filename": "rihanna.jpg", "wikipedia": "Rihanna", "search": "Rihanna singer"},
        {"name": "Usher", "filename": "usher.jpg", "wikipedia": "Usher (musician)", "search": "Usher singer"},
        {"name": "Alicia Keys", "filename": "alicia-keys.jpg", "wikipedia": "Alicia Keys", "search": "Alicia Keys"},
        {"name": "Frank Ocean", "filename": "frank-ocean.jpg", "wikipedia": "Frank Ocean", "search": "Frank Ocean"},
        {"name": "SZA", "filename": "sza.jpg", "wikipedia": "SZA", "search": "SZA singer"},
        {"name": "Mariah Carey", "filename": "mariah-carey.jpg", "wikipedia": "Mariah Carey", "search": "Mariah Carey"},
        {"name": "Chris Brown", "filename": "chris-brown.jpg", "wikipedia": "Chris Brown", "search": "Chris Brown singer"},
        {"name": "Lauryn Hill", "filename": "lauryn-hill.jpg", "wikipedia": "Lauryn Hill", "search": "Lauryn Hill"},
        {"name": "Toni Braxton", "filename": "toni-braxton.jpg", "wikipedia": "Toni Braxton", "search": "Toni Braxton"},
        {"name": "H.E.R.", "filename": "her.jpg", "wikipedia": "H.E.R.", "search": "H.E.R. singer Grammy"},
    ],
    "world-leaders": [
        {"name": "Barack Obama", "filename": "barack-obama.jpg", "wikipedia": "Barack Obama", "search": "Barack Obama"},
        {"name": "Nelson Mandela", "filename": "nelson-mandela.jpg", "wikipedia": "Nelson Mandela", "search": "Nelson Mandela"},
        {"name": "Martin Luther King Jr.", "filename": "martin-luther-king-jr.jpg", "wikipedia": "Martin Luther King Jr.", "search": "Martin Luther King Jr."},
        {"name": "Queen Elizabeth II", "filename": "queen-elizabeth-ii.jpg", "wikipedia": "Elizabeth II", "search": "Queen Elizabeth II"},
        {"name": "Abraham Lincoln", "filename": "abraham-lincoln.jpg", "wikipedia": "Abraham Lincoln", "search": "Abraham Lincoln"},
        {"name": "John F. Kennedy", "filename": "john-f-kennedy.jpg", "wikipedia": "John F. Kennedy", "search": "John F. Kennedy"},
        {"name": "Mahatma Gandhi", "filename": "mahatma-gandhi.jpg", "wikipedia": "Mahatma Gandhi", "search": "Mahatma Gandhi"},
        {"name": "Malala Yousafzai", "filename": "malala-yousafzai.jpg", "wikipedia": "Malala Yousafzai", "search": "Malala Yousafzai"},
        {"name": "Winston Churchill", "filename": "winston-churchill.jpg", "wikipedia": "Winston Churchill", "search": "Winston Churchill"},
        {"name": "Angela Merkel", "filename": "angela-merkel.jpg", "wikipedia": "Angela Merkel", "search": "Angela Merkel"},
    ],
    "tech-titans": [
        {"name": "Elon Musk", "filename": "elon-musk.jpg", "wikipedia": "Elon Musk", "search": "Elon Musk"},
        {"name": "Jeff Bezos", "filename": "jeff-bezos.jpg", "wikipedia": "Jeff Bezos", "search": "Jeff Bezos"},
        {"name": "Bill Gates", "filename": "bill-gates.jpg", "wikipedia": "Bill Gates", "search": "Bill Gates"},
        {"name": "Mark Zuckerberg", "filename": "mark-zuckerberg.jpg", "wikipedia": "Mark Zuckerberg", "search": "Mark Zuckerberg"},
        {"name": "Steve Jobs", "filename": "steve-jobs.jpg", "wikipedia": "Steve Jobs", "search": "Steve Jobs"},
        {"name": "Tim Cook", "filename": "tim-cook.jpg", "wikipedia": "Tim Cook", "search": "Tim Cook Apple"},
        {"name": "Sundar Pichai", "filename": "sundar-pichai.jpg", "wikipedia": "Sundar Pichai", "search": "Sundar Pichai"},
        {"name": "Jensen Huang", "filename": "jensen-huang.jpg", "wikipedia": "Jensen Huang", "search": "Jensen Huang"},
        {"name": "Satya Nadella", "filename": "satya-nadella.jpg", "wikipedia": "Satya Nadella", "search": "Satya Nadella"},
        {"name": "Lisa Su", "filename": "lisa-su.jpg", "wikipedia": "Lisa Su", "search": "Lisa Su AMD"},
    ],
    "sports-goats": [
        {"name": "Tom Brady", "filename": "tom-brady.jpg", "wikipedia": "Tom Brady", "search": "Tom Brady"},
        {"name": "Usain Bolt", "filename": "usain-bolt.jpg", "wikipedia": "Usain Bolt", "search": "Usain Bolt"},
        {"name": "Lionel Messi", "filename": "lionel-messi.jpg", "wikipedia": "Lionel Messi", "search": "Lionel Messi"},
        {"name": "Muhammad Ali", "filename": "muhammad-ali.jpg", "wikipedia": "Muhammad Ali", "search": "Muhammad Ali boxer"},
        {"name": "Tiger Woods", "filename": "tiger-woods.jpg", "wikipedia": "Tiger Woods", "search": "Tiger Woods"},
        {"name": "Cristiano Ronaldo", "filename": "cristiano-ronaldo.jpg", "wikipedia": "Cristiano Ronaldo", "search": "Cristiano Ronaldo"},
        {"name": "Wayne Gretzky", "filename": "wayne-gretzky.jpg", "wikipedia": "Wayne Gretzky", "search": "Wayne Gretzky"},
        {"name": "Michael Phelps", "filename": "michael-phelps.jpg", "wikipedia": "Michael Phelps", "search": "Michael Phelps"},
        {"name": "Patrick Mahomes", "filename": "patrick-mahomes.jpg", "wikipedia": "Patrick Mahomes", "search": "Patrick Mahomes"},
        {"name": "Sha'Carri Richardson", "filename": "shacarri-richardson.jpg", "wikipedia": "Sha'Carri Richardson", "search": "Sha'Carri Richardson"},
    ],
    "tv-streaming": [
        {"name": "Pedro Pascal", "filename": "pedro-pascal.jpg", "wikipedia": "Pedro Pascal", "search": "Pedro Pascal actor"},
        {"name": "Issa Rae", "filename": "issa-rae.jpg", "wikipedia": "Issa Rae", "search": "Issa Rae"},
        {"name": "Millie Bobby Brown", "filename": "millie-bobby-brown.jpg", "wikipedia": "Millie Bobby Brown", "search": "Millie Bobby Brown"},
        {"name": "Sterling K. Brown", "filename": "sterling-k-brown.jpg", "wikipedia": "Sterling K. Brown", "search": "Sterling K. Brown"},
        {"name": "Kerry Washington", "filename": "kerry-washington.jpg", "wikipedia": "Kerry Washington", "search": "Kerry Washington"},
        {"name": "Idris Elba", "filename": "idris-elba.jpg", "wikipedia": "Idris Elba", "search": "Idris Elba"},
        {"name": "Donald Glover", "filename": "donald-glover.jpg", "wikipedia": "Donald Glover", "search": "Donald Glover"},
        {"name": "Jenna Ortega", "filename": "jenna-ortega.jpg", "wikipedia": "Jenna Ortega", "search": "Jenna Ortega"},
        {"name": "Michael B. Jordan", "filename": "michael-b-jordan.jpg", "wikipedia": "Michael B. Jordan", "search": "Michael B. Jordan"},
        {"name": "Tracee Ellis Ross", "filename": "tracee-ellis-ross.jpg", "wikipedia": "Tracee Ellis Ross", "search": "Tracee Ellis Ross"},
    ],
}


# ────────────────────────────────────────────
# CLI
# ────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Download Wikimedia Commons portraits for Squint"
    )
    parser.add_argument(
        "--category",
        help="Only download one category (e.g. hip-hop, pop-stars, nba-legends)",
    )
    parser.add_argument(
        "--person",
        help="Only download one person by name (e.g. 'Drake', 'Taylor Swift')",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Search and preview results without downloading",
    )
    parser.add_argument(
        "--list", action="store_true",
        help="List all people entries and exit",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Re-download even if image already exists",
    )
    parser.add_argument(
        "--pick", action="store_true",
        help="Show multiple results and let you pick which image to download",
    )
    args = parser.parse_args()

    if args.list:
        print("\n  All Squint people entries:\n")
        for cat_id, entries in PEOPLE.items():
            print(f"  {cat_id.upper()}:")
            for e in entries:
                print(f"    {e['name']:30s} → {e['filename']}")
            print()
        total = sum(len(v) for v in PEOPLE.values())
        print(f"  Total: {total} people (FREE from Wikimedia Commons)\n")
        return

    # Filter by category
    if args.category:
        if args.category not in PEOPLE:
            print(f"\n  Unknown category: '{args.category}'")
            print(f"  Available: {', '.join(PEOPLE.keys())}\n")
            sys.exit(1)
        categories = {args.category: PEOPLE[args.category]}
    else:
        categories = PEOPLE

    # Filter by person
    if args.person:
        found = False
        filtered = {}
        for cat_id, entries in categories.items():
            matches = [e for e in entries if args.person.lower() in e["name"].lower()]
            if matches:
                filtered[cat_id] = matches
                found = True
        if not found:
            print(f"\n  Person not found: '{args.person}'")
            print(f"  Try: --list to see all entries\n")
            sys.exit(1)
        categories = filtered

    total = sum(len(v) for v in categories.values())
    downloaded = 0
    skipped = 0
    failed = 0
    not_found = []

    print()
    print("  ╔═══════════════════════════════════════════╗")
    print("  ║  SQUINT — Wikimedia Commons Downloader     ║")
    print("  ║  Free portraits · Creative Commons         ║")
    print("  ╚═══════════════════════════════════════════╝")
    print()
    print(f"  Searching for {total} people · FREE")
    print(f"  Output: {TARGET_SIZE}×{TARGET_SIZE} center-cropped PNGs")
    print()

    for cat_id, entries in categories.items():
        cat_dir = ASSETS_DIR / cat_id
        cat_dir.mkdir(parents=True, exist_ok=True)

        print(f"  ┌─ {cat_id.upper()} ({len(entries)} people)")

        for entry in entries:
            # Use .png extension for consistency with rest of game
            file_path = cat_dir / entry["filename"].replace(".jpg", ".png")

            # Skip existing unless --force
            if file_path.exists() and not args.force:
                size_kb = file_path.stat().st_size / 1024
                if size_kb > 10:
                    print(f"  │  SKIP  {entry['name']:30s} ({size_kb:.0f}KB exists)")
                    skipped += 1
                    continue

            print(f"  │  SRCH  {entry['name']:30s} ...", end="", flush=True)

            try:
                # Primary: get the main image from their Wikipedia page
                result = get_wikipedia_image(entry["name"], entry.get("wikipedia"))

                if result:
                    source = "Wikipedia"
                else:
                    # Fallback: search Commons directly
                    fallback = search_commons_fallback(entry["search"])
                    if fallback:
                        result = fallback[0]
                        source = "Commons"

                if not result:
                    print(f" NO RESULTS")
                    not_found.append(entry["name"])
                    failed += 1
                    continue

                if args.dry_run:
                    wp = result.get("wikipedia_page", "")
                    wp_str = f" (via {wp})" if wp else ""
                    print(f" found via {source}{wp_str}")
                    print(f"  │        {result['width']}×{result['height']} [{result['license']}] {result['title'][:60]}")
                    print(f"  │        {result['url'][:90]}")
                    continue

                print(f" downloading via {source} ...", end="", flush=True)
                nbytes = download_and_crop(result["url"], file_path)
                save_attribution(file_path, entry, result)
                downloaded += 1
                print(f" done ({nbytes / 1024:.0f}KB) [{result['license']}]")

            except Exception as e:
                failed += 1
                print(f" FAILED: {e}")

            # Be polite to Wikimedia's servers
            time.sleep(1.0)

        print(f"  └─ done")
        print()

    print(f"  ────────────────────────────────────────")
    print(f"  Downloaded:  {downloaded}")
    print(f"  Skipped:     {skipped}")
    print(f"  Failed:      {failed}")
    print(f"  Total:       {total}")
    print(f"  ────────────────────────────────────────")

    if not_found:
        print()
        print(f"  ⚠  Not found on Wikimedia Commons ({len(not_found)}):")
        for name in not_found:
            print(f"     - {name}")
        print(f"     Try adjusting search terms in the PEOPLE dict,")
        print(f"     or download these manually from another source.")

    print()

    if downloaded > 0:
        print(f"  Images saved to: {ASSETS_DIR}")
        print(f"  Attribution files saved alongside each image.")
        print()
        print(f"  ⚠  IMPORTANT: Review each downloaded image!")
        print(f"     Wikimedia search isn't perfect — some images")
        print(f"     may be wrong or low quality. Use --pick mode")
        print(f"     to manually choose the best result.")
        print()


if __name__ == "__main__":
    main()
