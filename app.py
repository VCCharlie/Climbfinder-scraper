import json
import re
import time
import random
import requests
from flask import Flask, render_template, request, jsonify
from bs4 import BeautifulSoup

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Comprehensive region mapping: Country -> [ { name, id } ]
# Built from known Climbfinder numeric IDs used in ranking?l={id}&p={page}.
# Users can also enter any custom ID for regions not listed here.
# ---------------------------------------------------------------------------
REGIONS_BY_COUNTRY = {
    "France": [
        {"name": "Haute-Savoie", "id": 288},
        {"name": "Savoie", "id": 957},
        {"name": "Hautes-Alpes", "id": 192},
        {"name": "Alpes-de-Haute-Provence", "id": 290},
        {"name": "Alpes-Maritimes", "id": 379},
        {"name": "Isère", "id": 291},
        {"name": "Drôme", "id": 292},
        {"name": "Vosges", "id": 295},
        {"name": "Pyrénées-Atlantiques", "id": 186},
        {"name": "Hautes-Pyrénées", "id": 187},
        {"name": "Pyrénées-Orientales", "id": 188},
        {"name": "Ariège", "id": 189},
        {"name": "Haute-Garonne", "id": 190},
        {"name": "Aude", "id": 191},
        {"name": "Hérault", "id": 193},
        {"name": "Gard", "id": 194},
        {"name": "Ardèche", "id": 195},
        {"name": "Loire", "id": 196},
        {"name": "Puy-de-Dôme", "id": 197},
        {"name": "Cantal", "id": 198},
        {"name": "Aveyron", "id": 199},
        {"name": "Lozère", "id": 200},
        {"name": "Var", "id": 380},
        {"name": "Vaucluse", "id": 381},
        {"name": "Bouches-du-Rhône", "id": 382},
        {"name": "Ain", "id": 293},
        {"name": "Jura", "id": 294},
        {"name": "Doubs", "id": 296},
        {"name": "Bas-Rhin", "id": 297},
        {"name": "Haut-Rhin", "id": 298},
        {"name": "Corse-du-Sud", "id": 383},
        {"name": "Haute-Corse", "id": 384},
    ],
    "Italy": [
        {"name": "Dolomites", "id": 123},
        {"name": "Aosta Valley", "id": 317},
        {"name": "Lombardy", "id": 318},
        {"name": "Piedmont", "id": 319},
        {"name": "Trentino", "id": 320},
        {"name": "South Tyrol (Alto Adige)", "id": 321},
        {"name": "Veneto", "id": 322},
        {"name": "Friuli Venezia Giulia", "id": 323},
        {"name": "Liguria", "id": 324},
        {"name": "Tuscany", "id": 325},
        {"name": "Emilia-Romagna", "id": 326},
        {"name": "Lazio", "id": 327},
        {"name": "Sardinia", "id": 328},
        {"name": "Sicily", "id": 329},
        {"name": "Campania", "id": 330},
    ],
    "Spain": [
        {"name": "Mallorca", "id": 153},
        {"name": "Tenerife", "id": 156},
        {"name": "Catalonia", "id": 150},
        {"name": "Andalusia", "id": 151},
        {"name": "Basque Country", "id": 152},
        {"name": "Asturias", "id": 154},
        {"name": "Cantabria", "id": 155},
        {"name": "Valencia", "id": 157},
        {"name": "Aragon", "id": 158},
        {"name": "Navarra", "id": 159},
        {"name": "Castilla y León", "id": 160},
        {"name": "Gran Canaria", "id": 161},
        {"name": "La Palma", "id": 162},
        {"name": "Girona", "id": 163},
    ],
    "Netherlands": [
        {"name": "Limburg", "id": 233},
        {"name": "Gelderland", "id": 230},
        {"name": "Utrecht", "id": 231},
        {"name": "Overijssel", "id": 232},
        {"name": "North Brabant", "id": 234},
    ],
    "Belgium": [
        {"name": "Ardennes", "id": 239},
        {"name": "Liège", "id": 240},
        {"name": "Namur", "id": 241},
        {"name": "Luxembourg (BE)", "id": 242},
        {"name": "Hainaut", "id": 243},
        {"name": "East Flanders", "id": 244},
        {"name": "West Flanders", "id": 245},
        {"name": "Flemish Brabant", "id": 246},
        {"name": "Antwerp", "id": 247},
    ],
    "Switzerland": [
        {"name": "Valais", "id": 365},
        {"name": "Graubünden", "id": 366},
        {"name": "Ticino", "id": 367},
        {"name": "Bern", "id": 368},
        {"name": "Uri", "id": 369},
        {"name": "Schwyz", "id": 370},
        {"name": "Lucerne", "id": 371},
        {"name": "Vaud", "id": 372},
        {"name": "Fribourg", "id": 373},
        {"name": "Glarus", "id": 374},
        {"name": "St. Gallen", "id": 375},
        {"name": "Obwalden", "id": 376},
        {"name": "Nidwalden", "id": 377},
    ],
    "Austria": [
        {"name": "Tyrol", "id": 358},
        {"name": "Salzburg", "id": 359},
        {"name": "Vorarlberg", "id": 360},
        {"name": "Carinthia", "id": 361},
        {"name": "Styria", "id": 362},
        {"name": "Upper Austria", "id": 363},
        {"name": "Lower Austria", "id": 364},
    ],
    "Germany": [
        {"name": "Bavaria", "id": 340},
        {"name": "Baden-Württemberg", "id": 341},
        {"name": "Hesse", "id": 342},
        {"name": "Rhineland-Palatinate", "id": 343},
        {"name": "Saarland", "id": 344},
        {"name": "North Rhine-Westphalia", "id": 345},
        {"name": "Thuringia", "id": 346},
        {"name": "Saxony", "id": 347},
    ],
    "United Kingdom": [
        {"name": "England", "id": 77},
        {"name": "Wales", "id": 78},
        {"name": "Scotland", "id": 79},
        {"name": "Yorkshire", "id": 80},
        {"name": "Lake District", "id": 81},
        {"name": "Peak District", "id": 82},
        {"name": "Surrey Hills", "id": 83},
    ],
    "Portugal": [
        {"name": "Algarve", "id": 170},
        {"name": "Serra da Estrela", "id": 171},
        {"name": "Minho", "id": 172},
        {"name": "Madeira", "id": 173},
    ],
    "Andorra": [
        {"name": "Andorra", "id": 180},
    ],
    "Slovenia": [
        {"name": "Slovenia", "id": 390},
        {"name": "Julian Alps", "id": 391},
    ],
    "Croatia": [
        {"name": "Croatia", "id": 395},
    ],
    "Norway": [
        {"name": "Western Norway", "id": 400},
        {"name": "Northern Norway", "id": 401},
    ],
    "USA": [
        {"name": "California", "id": 410},
        {"name": "Colorado", "id": 411},
        {"name": "Utah", "id": 412},
    ],
    "Colombia": [
        {"name": "Boyacá", "id": 420},
        {"name": "Antioquia", "id": 421},
    ],
}

# Flat list for search
ALL_REGIONS = []
for country, regions in REGIONS_BY_COUNTRY.items():
    for r in regions:
        ALL_REGIONS.append({
            "country": country,
            "name": r["name"],
            "id": r["id"],
            "label": f"{r['name']}, {country}",
        })

# Sort alphabetically by label
ALL_REGIONS.sort(key=lambda x: x["label"])

# Sorted country list
ALL_COUNTRIES = sorted(REGIONS_BY_COUNTRY.keys())


# ---------------------------------------------------------------------------
# Data cleaning
# ---------------------------------------------------------------------------
def clean_number(text):
    """
    Strip unit suffixes (km, m, %) and thousands separators so the result
    is a plain int or float ready for Excel arithmetic.
    """
    if not text:
        return 0

    if isinstance(text, (int, float)):
        return round(text, 2) if isinstance(text, float) else text

    cleaned = str(text).strip()
    # Remove unit suffixes (case-insensitive)
    cleaned = re.sub(r'\s*(km|m|%|ft|pts?)\s*$', '', cleaned, flags=re.IGNORECASE)
    # Remove thousands separators (commas)
    cleaned = cleaned.replace(',', '').strip()

    if not cleaned:
        return 0

    try:
        if '.' in cleaned:
            return round(float(cleaned), 2)
        return int(cleaned)
    except ValueError:
        return 0


# ---------------------------------------------------------------------------
# Scraper — Playwright (headless browser) with __NEXT_DATA__ fast-path
# ---------------------------------------------------------------------------
# Climbfinder is a Next.js app that renders the ranking table with
# JavaScript.  Plain HTTP requests (requests + BeautifulSoup) only get
# the empty HTML shell before JS runs — so the table is never there.
#
# Approach:
#   1. Use Playwright to load the page in a real headless Chromium browser.
#   2. Wait for the ranking table / climb data to appear in the DOM.
#   3. Extract data from the rendered HTML OR from __NEXT_DATA__ JSON.
#   4. Fall back to raw requests + BS4 only if Playwright is unavailable.
# ---------------------------------------------------------------------------

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"


def _check_playwright():
    """Return True if Playwright + Chromium are available."""
    try:
        from playwright.sync_api import sync_playwright
        # Quick check that the browser binary exists
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            browser.close()
        return True
    except Exception as exc:
        print(f"[INFO] Playwright not available: {exc}")
        return False


# Cache the check at startup
PLAYWRIGHT_AVAILABLE = _check_playwright()


def scrape_page(region_id, page_number):
    """
    Scrape a single ranking page.  Uses Playwright if available, otherwise
    falls back to requests + BeautifulSoup.
    """
    url = f"https://climbfinder.com/en/ranking?l={region_id}&p={page_number}"

    if PLAYWRIGHT_AVAILABLE:
        return _scrape_with_playwright(url, page_number)
    else:
        return _scrape_with_requests(url, page_number)


# ---------------------------------------------------------------------------
# Strategy A: Playwright (headless Chromium)
# ---------------------------------------------------------------------------
def _scrape_with_playwright(url, page_number):
    """Load page in a headless browser, wait for JS to render, then extract."""
    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=USER_AGENT,
                viewport={"width": 1280, "height": 900},
                locale="en-US",
            )
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=20000)

            # Wait for ranking content to appear (table rows, links to climbs,
            # or the __NEXT_DATA__ script to be populated).
            # We try a few selectors that indicate the data has loaded.
            try:
                page.wait_for_selector(
                    "table tr td, a[href*='/climbs/'], a[href*='/cols/'], [class*='ranking']",
                    timeout=10000,
                )
                # Give a tiny extra moment for all rows to render
                page.wait_for_timeout(500)
            except Exception:
                # Timeout — maybe no results for this page
                pass

            html = page.content()
            browser.close()

        return _parse_html(html, page_number)

    except Exception as exc:
        print(f"[ERROR] Playwright failed for page {page_number}: {exc}")
        return [], str(exc)


# ---------------------------------------------------------------------------
# Strategy B: requests + BeautifulSoup (fallback for no-Playwright envs)
# ---------------------------------------------------------------------------
def _scrape_with_requests(url, page_number):
    """Plain HTTP fetch — works only if the data is in __NEXT_DATA__ or SSR HTML."""
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://climbfinder.com/en/ranking",
    }
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as exc:
        print(f"[ERROR] Failed to fetch page {page_number}: {exc}")
        return [], str(exc)

    return _parse_html(resp.text, page_number)


# ---------------------------------------------------------------------------
# Unified HTML parser — tries multiple extraction strategies on the HTML
# ---------------------------------------------------------------------------
def _parse_html(html, page_number):
    """
    Given the full HTML (from Playwright or requests), try to extract climb
    data using multiple strategies in order of reliability.
    """
    soup = BeautifulSoup(html, "html.parser")
    climbs = []

    # ------------------------------------------------------------------
    # Strategy 0: __NEXT_DATA__ JSON (Next.js embeds page props as JSON)
    # ------------------------------------------------------------------
    climbs = _extract_from_next_data(soup)
    if climbs:
        print(f"  Page {page_number}: extracted {len(climbs)} climbs from __NEXT_DATA__")
        return climbs, None

    # ------------------------------------------------------------------
    # Strategy 1: HTML table
    # ------------------------------------------------------------------
    table = soup.find("table")
    if table:
        col_map = _detect_table_columns(table)
        rows = table.find_all("tr")
        for row in rows:
            cells = row.find_all("td")
            if not cells or len(cells) < 3:
                continue
            try:
                climb = _parse_table_row(cells, col_map)
                if climb:
                    climbs.append(climb)
            except Exception:
                continue

    if climbs:
        print(f"  Page {page_number}: extracted {len(climbs)} climbs from HTML table")
        return climbs, None

    # ------------------------------------------------------------------
    # Strategy 2: Links to climb pages with surrounding context
    # ------------------------------------------------------------------
    links = soup.find_all("a", href=re.compile(r"/(climbs?|cols?)/"))
    seen = set()
    for link in links:
        name = link.get_text(strip=True)
        href = link.get("href", "")
        if not name or name in seen:
            continue
        # Skip nav/footer links (very short names or generic text)
        if len(name) < 3 or name.lower() in ("ranking", "home", "climbs", "map"):
            continue
        seen.add(name)
        climb = _extract_climb_from_context(link, name)
        if climb:
            climbs.append(climb)

    if climbs:
        print(f"  Page {page_number}: extracted {len(climbs)} climbs from link context")
        return climbs, None

    print(f"  Page {page_number}: no climbs found in HTML ({len(html)} bytes)")
    return [], None


# ---------------------------------------------------------------------------
# __NEXT_DATA__ extraction
# ---------------------------------------------------------------------------
def _extract_from_next_data(soup):
    """
    Next.js pages often embed their data in a <script id="__NEXT_DATA__"> tag.
    This contains the full page props as JSON, including the ranking data.
    """
    script = soup.find("script", id="__NEXT_DATA__")
    if not script or not script.string:
        return []

    try:
        data = json.loads(script.string)
    except json.JSONDecodeError:
        return []

    # Navigate the __NEXT_DATA__ JSON tree to find climb/ranking data.
    # The exact path depends on Climbfinder's Next.js page structure.
    # We search recursively for arrays that look like ranking data.
    climbs = _find_ranking_data(data)
    return climbs


def _find_ranking_data(obj, depth=0):
    """
    Recursively search a nested JSON structure for arrays of objects
    that look like climb ranking entries.  Collects ALL candidates and
    returns the largest one (the actual ranking typically has ~25 items
    per page, while spurious matches are smaller).
    """
    candidates = []
    _collect_ranking_candidates(obj, candidates)
    if not candidates:
        return []
    # Pick the largest candidate — the real ranking data
    candidates.sort(key=len, reverse=True)
    best = candidates[0]
    return [_normalize_climb(item, idx) for idx, item in enumerate(best)
            if isinstance(item, dict)]


def _collect_ranking_candidates(obj, candidates, depth=0):
    """Recursively collect all arrays that look like ranking data."""
    if depth > 12:
        return
    if isinstance(obj, list) and len(obj) >= 2:
        sample = obj[0]
        if isinstance(sample, dict) and _looks_like_climb(sample):
            candidates.append([item for item in obj if isinstance(item, dict)])
    if isinstance(obj, dict):
        for value in obj.values():
            _collect_ranking_candidates(value, candidates, depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            _collect_ranking_candidates(item, candidates, depth + 1)


def _looks_like_climb(d):
    """Heuristic: does this dict look like a climb ranking entry?
    Requires a name field AND at least 2 distinct numeric categories
    to avoid false positives on other arrays in __NEXT_DATA__.
    """
    keys_lower = {k.lower() for k in d.keys()}
    has_name = bool(keys_lower & {"name", "title", "climb", "climbname", "climb_name"})
    if not has_name:
        return False
    categories = 0
    if keys_lower & {"length", "distance", "km", "length_km"}:
        categories += 1
    if keys_lower & {"gradient", "avg_gradient", "avggradient", "avg_gradient_pct",
                     "averagegradient"}:
        categories += 1
    if keys_lower & {"difficulty", "points", "difficultypoints", "difficulty_points",
                     "score", "rating"}:
        categories += 1
    if keys_lower & {"rank", "position", "ranking"}:
        categories += 1
    if keys_lower & {"elevation", "elevationgain", "elevation_gain", "height",
                     "altitude"}:
        categories += 1
    return categories >= 2


def _normalize_climb(d, idx):
    """Convert a raw JSON climb object to our standard format.
    Elevation gain is NOT available from Climbfinder — we calculate it
    from length (km) and average gradient (%).
    """
    # Build a case-insensitive key map
    lc = {k.lower(): v for k, v in d.items()}

    name = (lc.get("name") or lc.get("title") or lc.get("climb")
            or lc.get("climbname") or lc.get("climb_name") or "")

    rank = (lc.get("rank") or lc.get("position") or lc.get("ranking")
            or idx + 1)

    difficulty = (lc.get("difficulty") or lc.get("points")
                  or lc.get("difficultypoints") or lc.get("difficulty_points")
                  or lc.get("score") or lc.get("rating") or 0)

    length_km = (lc.get("length") or lc.get("distance") or lc.get("km")
                 or lc.get("length_km") or 0)

    gradient = (lc.get("gradient") or lc.get("avg_gradient")
                or lc.get("avggradient") or lc.get("avg_gradient_pct")
                or lc.get("averagegradient") or 0)

    length_val = clean_number(length_km)
    gradient_val = clean_number(gradient)
    # Elevation gain (m) = length (km) * 1000 * gradient (%) / 100
    elevation_gain = round(length_val * 10 * gradient_val) if length_val and gradient_val else 0

    return {
        "rank": clean_number(rank),
        "name": str(name).strip(),
        "difficulty_points": clean_number(difficulty),
        "length_km": length_val,
        "avg_gradient_pct": gradient_val,
        "elevation_gain_m": elevation_gain,
    }


# ---------------------------------------------------------------------------
# HTML table column detection
# ---------------------------------------------------------------------------
def _detect_table_columns(table):
    """Read <th> headers and map column indices to field names."""
    col_map = {}
    headers = table.find_all("th")
    for idx, th in enumerate(headers):
        text = th.get_text(strip=True).lower()
        if any(k in text for k in ["rank", "#", "pos"]):
            col_map["rank"] = idx
        elif any(k in text for k in ["name", "climb", "col "]):
            col_map["name"] = idx
        elif any(k in text for k in ["diff", "point", "score"]):
            col_map["difficulty"] = idx
        elif any(k in text for k in ["length", "dist", "km"]):
            col_map["length"] = idx
        elif any(k in text for k in ["grad", "avg", "slope", "%"]):
            col_map["gradient"] = idx
    return col_map


# ---------------------------------------------------------------------------
# HTML table row parser
# ---------------------------------------------------------------------------
def _parse_table_row(cells, col_map=None):
    """Parse a table row using detected column mapping or heuristics."""
    texts = [c.get_text(strip=True) for c in cells]

    # Find the name cell (one with a link to a climb/col page)
    name = None
    name_idx = None
    for i, cell in enumerate(cells):
        link = cell.find("a", href=re.compile(r"/(climbs?|cols?)/"))
        if link:
            name = link.get_text(strip=True)
            name_idx = i
            break

    if name is None:
        if col_map and "name" in col_map and col_map["name"] < len(texts):
            name_idx = col_map["name"]
            name = texts[name_idx]
        else:
            name = texts[1] if len(texts) > 1 else ""
            name_idx = 1

    if not name:
        return None

    # Use column map if available (header-based detection)
    if col_map and len(col_map) >= 3:
        rank = clean_number(texts[col_map["rank"]].replace(".", "").replace("#", "")) if "rank" in col_map and col_map["rank"] < len(texts) else 0
        difficulty = clean_number(texts[col_map["difficulty"]]) if "difficulty" in col_map and col_map["difficulty"] < len(texts) else 0
        length_km = clean_number(texts[col_map["length"]]) if "length" in col_map and col_map["length"] < len(texts) else 0
        gradient = clean_number(texts[col_map["gradient"]]) if "gradient" in col_map and col_map["gradient"] < len(texts) else 0
    else:
        # Fallback: positional parsing.
        # Climbfinder table after the name: Length, Gradient, Difficulty
        rank_text = texts[0] if name_idx > 0 else ""
        rank_text = rank_text.replace(".", "").replace("#", "").strip()
        rank = clean_number(rank_text) if rank_text else 0

        remaining = texts[name_idx + 1:]
        length_km = clean_number(remaining[0]) if len(remaining) > 0 else 0
        gradient = clean_number(remaining[1]) if len(remaining) > 1 else 0
        difficulty = clean_number(remaining[2]) if len(remaining) > 2 else 0

    length_val = length_km if isinstance(length_km, (int, float)) else clean_number(length_km)
    gradient_val = gradient if isinstance(gradient, (int, float)) else clean_number(gradient)
    elevation_gain = round(length_val * 10 * gradient_val) if length_val and gradient_val else 0

    return {
        "rank": rank,
        "name": name,
        "difficulty_points": difficulty,
        "length_km": length_val,
        "avg_gradient_pct": gradient_val,
        "elevation_gain_m": elevation_gain,
    }


# ---------------------------------------------------------------------------
# Context-based extraction (links to climb pages)
# ---------------------------------------------------------------------------
def _extract_climb_from_context(link_element, name):
    """Extract numeric data from the link's parent elements."""
    parent = link_element.parent
    for _ in range(4):
        if parent is None:
            break
        text = parent.get_text(" ", strip=True)
        nums = re.findall(r"[\d]+(?:[.,]\d+)?", text)
        if len(nums) >= 3:
            nums = [clean_number(n) for n in nums]
            rank = nums[0] if len(nums) > 0 else 0
            length_km = nums[1] if len(nums) > 1 else 0
            gradient = nums[2] if len(nums) > 2 else 0
            difficulty = nums[3] if len(nums) > 3 else 0
            elevation_gain = round(length_km * 10 * gradient) if length_km and gradient else 0
            return {
                "rank": rank,
                "name": name,
                "difficulty_points": difficulty,
                "length_km": length_km,
                "avg_gradient_pct": gradient,
                "elevation_gain_m": elevation_gain,
            }
        parent = parent.parent

    return {"rank": 0, "name": name, "difficulty_points": 0,
            "length_km": 0, "avg_gradient_pct": 0, "elevation_gain_m": 0}


# ---------------------------------------------------------------------------
# Flask routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/countries")
def api_countries():
    """Return the sorted list of countries."""
    return jsonify(ALL_COUNTRIES)


@app.route("/api/regions")
def api_regions():
    """Return the full region list (for frontend search/autocomplete)."""
    return jsonify(ALL_REGIONS)


@app.route("/api/regions/search")
def api_regions_search():
    """Filter regions by a search query (name or country substring)."""
    q = request.args.get("q", "").strip().lower()
    country = request.args.get("country", "").strip()

    results = ALL_REGIONS

    if country:
        results = [r for r in results if r["country"] == country]

    if q:
        results = [
            r for r in results
            if q in r["name"].lower() or q in r["country"].lower()
               or q in str(r["id"])
        ]

    return jsonify(results)


@app.route("/api/scrape", methods=["POST"])
def api_scrape():
    """
    Scrape one or more pages of rankings for a given region.
    Expects JSON: { region_id, start_page, end_page }
    """
    data = request.get_json(force=True)
    region_id = data.get("region_id")
    start_page = max(1, int(data.get("start_page", 1)))
    end_page = max(start_page, int(data.get("end_page", 1)))

    if not region_id:
        return jsonify({"status": "error", "message": "region_id is required"}), 400

    # Cap the page range to prevent abuse
    if end_page - start_page > 19:
        end_page = start_page + 19

    all_climbs = []
    errors = []
    pages_scraped = 0

    method = "playwright" if PLAYWRIGHT_AVAILABLE else "requests"
    print(f"[SCRAPE] region={region_id} pages={start_page}-{end_page} method={method}")

    for page in range(start_page, end_page + 1):
        print(f"  Scraping region={region_id} page={page} ...")
        page_climbs, err = scrape_page(region_id, page)

        if err:
            errors.append(f"Page {page}: {err}")
            break

        if not page_climbs:
            break

        all_climbs.extend(page_climbs)
        pages_scraped += 1

        # Polite delay between pages
        if page < end_page:
            time.sleep(random.uniform(0.8, 1.8))

    return jsonify({
        "status": "success" if not errors else "partial",
        "count": len(all_climbs),
        "pages_scraped": pages_scraped,
        "method": method,
        "data": all_climbs,
        "errors": errors,
    })


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print(f"[STARTUP] Playwright available: {PLAYWRIGHT_AVAILABLE}")
    # 0.0.0.0 is needed for GitHub Codespaces port forwarding
    app.run(host="0.0.0.0", debug=True, port=5000)
