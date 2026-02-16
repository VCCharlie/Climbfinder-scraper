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

    cleaned = text.strip()
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
# Scraper
# ---------------------------------------------------------------------------
# Rotate through realistic User-Agent strings
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
]


def get_headers():
    """Return realistic browser headers with a randomly-selected User-Agent."""
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://climbfinder.com/en/ranking",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
    }


def choose_parser():
    """Return the best available HTML parser."""
    try:
        import lxml  # noqa: F401
        return "lxml"
    except ImportError:
        return "html.parser"


HTML_PARSER = choose_parser()


def fetch_with_retry(session, url, max_retries=3):
    """
    Fetch a URL with exponential backoff on transient failures.
    Returns the Response object or raises the last exception.
    """
    last_exc = None
    for attempt in range(max_retries):
        try:
            resp = session.get(url, headers=get_headers(), timeout=15)
            resp.raise_for_status()
            return resp
        except requests.RequestException as exc:
            last_exc = exc
            status = getattr(exc.response, 'status_code', None) if hasattr(exc, 'response') else None
            # Don't retry on 4xx client errors (except 429 Too Many Requests)
            if status and 400 <= status < 500 and status != 429:
                raise
            if attempt < max_retries - 1:
                wait = (2 ** attempt) + random.uniform(0.5, 1.5)
                print(f"  [RETRY] Attempt {attempt + 1} failed: {exc}. Waiting {wait:.1f}s...")
                time.sleep(wait)
    raise last_exc


def scrape_page(region_id, page_number, session=None):
    """
    Scrape a single page of the Climbfinder ranking for the given region.
    Returns a list of dicts with cleaned numeric values.
    """
    url = f"https://climbfinder.com/en/ranking?l={region_id}&p={page_number}"

    requester = session or requests.Session()
    try:
        resp = fetch_with_retry(requester, url)
    except requests.RequestException as exc:
        print(f"[ERROR] Failed to fetch page {page_number}: {exc}")
        return [], str(exc)

    soup = BeautifulSoup(resp.content, HTML_PARSER)

    # Try to locate the ranking table.  Climbfinder typically uses a
    # standard <table> but the layout may vary.  We look for several
    # fallback strategies.
    climbs = []

    # Strategy 1: look for a <table> element
    table = soup.find("table")
    if table:
        rows = table.find_all("tr")
        for row in rows:
            # Skip header rows
            cells = row.find_all("td")
            if not cells or len(cells) < 5:
                continue
            try:
                climb = parse_table_row(cells)
                if climb:
                    climbs.append(climb)
            except Exception:
                continue

    # Strategy 2: if no <table> found, look for repeated card/div structures
    # that Climbfinder sometimes uses for responsive layouts.
    if not climbs:
        cards = soup.select(".ranking-row, .climb-row, [class*=ranking], [class*=climb-item]")
        for card in cards:
            try:
                climb = parse_card_element(card)
                if climb:
                    climbs.append(climb)
            except Exception:
                continue

    # Strategy 3: broader fallback – look for any structured list of links
    # that point to climb detail pages (URL pattern /en/climbs/...).
    if not climbs:
        links = soup.find_all("a", href=re.compile(r"/climbs?/"))
        seen_names = set()
        for link in links:
            name = link.get_text(strip=True)
            if name and name not in seen_names:
                seen_names.add(name)
                # Try to extract numbers from siblings / parent
                climb = extract_climb_from_context(link)
                if climb:
                    climbs.append(climb)

    return climbs, None


def parse_table_row(cells):
    """Parse a standard HTML table row into a climb dict."""
    texts = [c.get_text(strip=True) for c in cells]

    # Try to find the name cell (the one with a link to a climb page)
    name = None
    name_idx = None
    for i, cell in enumerate(cells):
        link = cell.find("a", href=re.compile(r"/climbs?/|/cols?/"))
        if link:
            name = link.get_text(strip=True)
            name_idx = i
            break

    if name is None:
        # Fallback: assume column 1 is the name
        name = texts[1] if len(texts) > 1 else ""
        name_idx = 1

    if not name:
        return None

    # Extract rank – usually the first column before the name
    rank_text = texts[0] if name_idx > 0 else ""
    rank_text = rank_text.replace(".", "").replace("#", "").strip()
    rank = clean_number(rank_text) if rank_text else 0

    # Remaining numeric columns come after the name.
    remaining = texts[name_idx + 1:]

    difficulty = clean_number(remaining[0]) if len(remaining) > 0 else 0
    length_km = clean_number(remaining[1]) if len(remaining) > 1 else 0
    elevation = clean_number(remaining[2]) if len(remaining) > 2 else 0
    gradient = clean_number(remaining[3]) if len(remaining) > 3 else 0

    # Heuristic: if difficulty seems like a very large number and the
    # others look reasonable, the column order is probably correct.
    # If difficulty looks like a distance (<50), columns may be shifted.
    if difficulty < 10 and length_km > 100:
        difficulty, length_km, elevation, gradient = (
            gradient, difficulty, length_km, elevation
        )

    return {
        "rank": rank,
        "name": name,
        "difficulty_points": difficulty,
        "length_km": length_km,
        "elevation_gain_m": elevation,
        "avg_gradient_pct": gradient,
    }


def parse_card_element(card):
    """Parse a card-style div element into a climb dict."""
    link = card.find("a", href=re.compile(r"/climbs?/|/cols?/"))
    name = link.get_text(strip=True) if link else card.get_text(strip=True)
    if not name:
        return None

    # Try to find numeric text nodes
    nums = re.findall(r"[\d.,]+", card.get_text())
    nums = [clean_number(n) for n in nums]

    return {
        "rank": nums[0] if len(nums) > 0 else 0,
        "name": name,
        "difficulty_points": nums[1] if len(nums) > 1 else 0,
        "length_km": nums[2] if len(nums) > 2 else 0,
        "elevation_gain_m": nums[3] if len(nums) > 3 else 0,
        "avg_gradient_pct": nums[4] if len(nums) > 4 else 0,
    }


def extract_climb_from_context(link_element):
    """Last-resort extraction: pull numbers from the link's parent row."""
    name = link_element.get_text(strip=True)
    if not name:
        return None

    parent = link_element.parent
    # Walk up a few levels to find a container with numbers
    for _ in range(3):
        if parent is None:
            break
        text = parent.get_text(" ", strip=True)
        nums = re.findall(r"[\d.,]+", text)
        if len(nums) >= 3:
            nums = [clean_number(n) for n in nums]
            return {
                "rank": nums[0] if len(nums) > 0 else 0,
                "name": name,
                "difficulty_points": nums[1] if len(nums) > 1 else 0,
                "length_km": nums[2] if len(nums) > 2 else 0,
                "elevation_gain_m": nums[3] if len(nums) > 3 else 0,
                "avg_gradient_pct": nums[4] if len(nums) > 4 else 0,
            }
        parent = parent.parent

    return {"rank": 0, "name": name, "difficulty_points": 0,
            "length_km": 0, "elevation_gain_m": 0, "avg_gradient_pct": 0}


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

    # Filter by country if provided
    if country:
        results = [r for r in results if r["country"] == country]

    # Filter by text query
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

    # Use a session for connection pooling / cookie persistence
    session = requests.Session()

    for page in range(start_page, end_page + 1):
        print(f"  Scraping region={region_id} page={page} ...")
        page_climbs, err = scrape_page(region_id, page, session=session)

        if err:
            errors.append(f"Page {page}: {err}")
            # On a hard error, stop – the remaining pages likely fail too
            break

        if not page_climbs:
            # Empty page = end of listing
            break

        all_climbs.extend(page_climbs)
        pages_scraped += 1

        # Polite delay between pages (skip delay after last page)
        if page < end_page:
            time.sleep(random.uniform(0.8, 1.8))

    session.close()

    return jsonify({
        "status": "success" if not errors else "partial",
        "count": len(all_climbs),
        "pages_scraped": pages_scraped,
        "data": all_climbs,
        "errors": errors,
    })


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # 0.0.0.0 is needed for GitHub Codespaces port forwarding
    app.run(host="0.0.0.0", debug=True, port=5000)
