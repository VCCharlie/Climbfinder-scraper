"""
Climbfinder Ranking Aggregator — Streamlit version.

Lightweight alternative to the Flask app. No Codespace needed — runs
anywhere Python is available (laptop, NAS, Docker container, etc.).

Usage:
    pip install streamlit requests beautifulsoup4 lxml
    streamlit run streamlit_app.py

For Synology NAS (DS225+) Docker deployment:
    1. Create a Python container (python:3.11-slim)
    2. pip install streamlit requests beautifulsoup4 lxml playwright
    3. playwright install --with-deps chromium   (optional, for JS sites)
    4. streamlit run streamlit_app.py --server.port 8501
    5. Forward port 8501 in Docker → access via http://nas-ip:8501
"""

import json
import re
import time
import io
import requests
from bs4 import BeautifulSoup

import streamlit as st
import pandas as pd

# ---------------------------------------------------------------------------
# Region data (same as app.py)
# ---------------------------------------------------------------------------
REGIONS_BY_COUNTRY = {
    "France": [
        {"name": "Haute-Savoie", "id": 288}, {"name": "Savoie", "id": 957},
        {"name": "Hautes-Alpes", "id": 192}, {"name": "Alpes-de-Haute-Provence", "id": 290},
        {"name": "Alpes-Maritimes", "id": 379}, {"name": "Isère", "id": 291},
        {"name": "Drôme", "id": 292}, {"name": "Vosges", "id": 295},
        {"name": "Pyrénées-Atlantiques", "id": 186}, {"name": "Hautes-Pyrénées", "id": 187},
        {"name": "Pyrénées-Orientales", "id": 188}, {"name": "Ariège", "id": 189},
        {"name": "Haute-Garonne", "id": 190}, {"name": "Aude", "id": 191},
        {"name": "Hérault", "id": 193}, {"name": "Gard", "id": 194},
        {"name": "Ardèche", "id": 195}, {"name": "Loire", "id": 196},
        {"name": "Puy-de-Dôme", "id": 197}, {"name": "Cantal", "id": 198},
        {"name": "Aveyron", "id": 199}, {"name": "Lozère", "id": 200},
        {"name": "Var", "id": 380}, {"name": "Vaucluse", "id": 381},
        {"name": "Bouches-du-Rhône", "id": 382}, {"name": "Ain", "id": 293},
        {"name": "Jura", "id": 294}, {"name": "Doubs", "id": 296},
        {"name": "Bas-Rhin", "id": 297}, {"name": "Haut-Rhin", "id": 298},
        {"name": "Corse-du-Sud", "id": 383}, {"name": "Haute-Corse", "id": 384},
    ],
    "Italy": [
        {"name": "Dolomites", "id": 123}, {"name": "Aosta Valley", "id": 317},
        {"name": "Lombardy", "id": 318}, {"name": "Piedmont", "id": 319},
        {"name": "Trentino", "id": 320}, {"name": "South Tyrol (Alto Adige)", "id": 321},
        {"name": "Veneto", "id": 322}, {"name": "Friuli Venezia Giulia", "id": 323},
        {"name": "Liguria", "id": 324}, {"name": "Tuscany", "id": 325},
        {"name": "Emilia-Romagna", "id": 326}, {"name": "Lazio", "id": 327},
        {"name": "Sardinia", "id": 328}, {"name": "Sicily", "id": 329},
        {"name": "Campania", "id": 330},
    ],
    "Spain": [
        {"name": "Mallorca", "id": 153}, {"name": "Tenerife", "id": 156},
        {"name": "Catalonia", "id": 150}, {"name": "Andalusia", "id": 151},
        {"name": "Basque Country", "id": 152}, {"name": "Asturias", "id": 154},
        {"name": "Cantabria", "id": 155}, {"name": "Valencia", "id": 157},
        {"name": "Aragon", "id": 158}, {"name": "Navarra", "id": 159},
        {"name": "Castilla y León", "id": 160}, {"name": "Gran Canaria", "id": 161},
        {"name": "La Palma", "id": 162}, {"name": "Girona", "id": 163},
    ],
    "Netherlands": [
        {"name": "Limburg", "id": 233}, {"name": "Gelderland", "id": 230},
        {"name": "Utrecht", "id": 231}, {"name": "Overijssel", "id": 232},
        {"name": "North Brabant", "id": 234},
    ],
    "Belgium": [
        {"name": "Ardennes", "id": 239}, {"name": "Liège", "id": 240},
        {"name": "Namur", "id": 241}, {"name": "Luxembourg (BE)", "id": 242},
        {"name": "Hainaut", "id": 243}, {"name": "East Flanders", "id": 244},
        {"name": "West Flanders", "id": 245}, {"name": "Flemish Brabant", "id": 246},
        {"name": "Antwerp", "id": 247},
    ],
    "Switzerland": [
        {"name": "Valais", "id": 365}, {"name": "Graubünden", "id": 366},
        {"name": "Ticino", "id": 367}, {"name": "Bern", "id": 368},
        {"name": "Uri", "id": 369}, {"name": "Schwyz", "id": 370},
        {"name": "Lucerne", "id": 371}, {"name": "Vaud", "id": 372},
        {"name": "Fribourg", "id": 373}, {"name": "Glarus", "id": 374},
        {"name": "St. Gallen", "id": 375}, {"name": "Obwalden", "id": 376},
        {"name": "Nidwalden", "id": 377},
    ],
    "Austria": [
        {"name": "Tyrol", "id": 358}, {"name": "Salzburg", "id": 359},
        {"name": "Vorarlberg", "id": 360}, {"name": "Carinthia", "id": 361},
        {"name": "Styria", "id": 362}, {"name": "Upper Austria", "id": 363},
        {"name": "Lower Austria", "id": 364},
    ],
    "Germany": [
        {"name": "Bavaria", "id": 340}, {"name": "Baden-Württemberg", "id": 341},
        {"name": "Hesse", "id": 342}, {"name": "Rhineland-Palatinate", "id": 343},
        {"name": "Saarland", "id": 344}, {"name": "North Rhine-Westphalia", "id": 345},
        {"name": "Thuringia", "id": 346}, {"name": "Saxony", "id": 347},
    ],
    "United Kingdom": [
        {"name": "England", "id": 77}, {"name": "Wales", "id": 78},
        {"name": "Scotland", "id": 79}, {"name": "Yorkshire", "id": 80},
        {"name": "Lake District", "id": 81}, {"name": "Peak District", "id": 82},
        {"name": "Surrey Hills", "id": 83},
    ],
    "Portugal": [
        {"name": "Algarve", "id": 170}, {"name": "Serra da Estrela", "id": 171},
        {"name": "Minho", "id": 172}, {"name": "Madeira", "id": 173},
    ],
    "Andorra": [{"name": "Andorra", "id": 180}],
    "Slovenia": [{"name": "Slovenia", "id": 390}, {"name": "Julian Alps", "id": 391}],
    "Croatia": [{"name": "Croatia", "id": 395}],
    "Norway": [{"name": "Western Norway", "id": 400}, {"name": "Northern Norway", "id": 401}],
    "USA": [{"name": "California", "id": 410}, {"name": "Colorado", "id": 411}, {"name": "Utah", "id": 412}],
    "Colombia": [{"name": "Boyacá", "id": 420}, {"name": "Antioquia", "id": 421}],
}

# Build flat list
ALL_REGIONS = []
for country, regions in REGIONS_BY_COUNTRY.items():
    for r in regions:
        ALL_REGIONS.append({"country": country, "name": r["name"], "id": r["id"],
                            "label": f"{r['name']}, {country}"})
ALL_REGIONS.sort(key=lambda x: x["label"])


# ---------------------------------------------------------------------------
# Scraper helpers (same logic as app.py)
# ---------------------------------------------------------------------------
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"


def clean_number(text):
    if not text:
        return 0
    if isinstance(text, (int, float)):
        return round(text, 2) if isinstance(text, float) else text
    cleaned = str(text).strip()
    cleaned = re.sub(r'\s*(km|m|%|ft|pts?)\s*$', '', cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.replace(',', '').strip()
    if not cleaned:
        return 0
    try:
        return round(float(cleaned), 2) if '.' in cleaned else int(cleaned)
    except ValueError:
        return 0


def _check_playwright():
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            browser.close()
        return True
    except Exception:
        return False


@st.cache_resource
def playwright_available():
    return _check_playwright()


def scrape_page(region_id, page_number, sort_mode="popular"):
    url = f"https://climbfinder.com/en/ranking?l={region_id}&p={page_number}&s={sort_mode}"
    if playwright_available():
        return _scrape_with_playwright(url, page_number)
    return _scrape_with_requests(url, page_number)


def _scrape_with_playwright(url, page_number):
    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(user_agent=USER_AGENT,
                                          viewport={"width": 1280, "height": 900},
                                          locale="en-US")
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=20000)
            try:
                page.wait_for_selector(
                    "table tr td, a[href*='/climbs/'], a[href*='/cols/'], [class*='ranking']",
                    timeout=10000)
                page.wait_for_timeout(500)
            except Exception:
                pass
            html = page.content()
            browser.close()
        return _parse_html(html, page_number)
    except Exception as exc:
        return [], str(exc)


def _scrape_with_requests(url, page_number):
    headers = {"User-Agent": USER_AGENT,
               "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
               "Accept-Language": "en-US,en;q=0.9",
               "Referer": "https://climbfinder.com/en/ranking"}
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as exc:
        return [], str(exc)
    return _parse_html(resp.text, page_number)


# ---------------------------------------------------------------------------
# HTML parsing (same strategies as app.py)
# ---------------------------------------------------------------------------
def _parse_html(html, page_number):
    soup = BeautifulSoup(html, "html.parser")
    climbs = []

    # Strategy 0: __NEXT_DATA__
    script = soup.find("script", id="__NEXT_DATA__")
    if script and script.string:
        try:
            data = json.loads(script.string)
            climbs = _find_ranking_data(data)
        except json.JSONDecodeError:
            pass
    if climbs:
        return climbs, None

    # Strategy 1: HTML table
    table = soup.find("table")
    if table:
        col_map = _detect_table_columns(table)
        for row in table.find_all("tr"):
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
        return climbs, None

    # Strategy 2: links
    links = soup.find_all("a", href=re.compile(r"/(climbs?|cols?)/"))
    seen = set()
    for link in links:
        name = link.get_text(strip=True)
        if not name or name in seen or len(name) < 3:
            continue
        if name.lower() in ("ranking", "home", "climbs", "map"):
            continue
        seen.add(name)
        climb = _extract_from_context(link, name)
        if climb:
            climbs.append(climb)

    return climbs, None


def _find_ranking_data(obj):
    candidates = []
    _collect_ranking_candidates(obj, candidates)
    if not candidates:
        return []

    def _stats_name_count(candidate):
        """Count items whose 'name' field looks like a stats string,
        e.g. '34.8 km 6 % 1556' — the format used in real ranking rows."""
        count = 0
        for item in candidate:
            if isinstance(item, dict):
                name = item.get("name", "")
                if isinstance(name, str) and re.search(
                    r'[\d]+[.,]?[\d]*\s*km', name
                ):
                    count += 1
        return count

    # Prefer candidates with stats-format names; break ties by array length.
    candidates.sort(key=lambda c: (_stats_name_count(c), len(c)), reverse=True)
    return [_normalize_climb(item, idx) for idx, item in enumerate(candidates[0])
            if isinstance(item, dict)]


def _collect_ranking_candidates(obj, candidates, depth=0):
    if depth > 12:
        return
    if isinstance(obj, list) and len(obj) >= 2:
        if isinstance(obj[0], dict) and _looks_like_climb(obj[0]):
            candidates.append([item for item in obj if isinstance(item, dict)])
    if isinstance(obj, dict):
        for value in obj.values():
            _collect_ranking_candidates(value, candidates, depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            _collect_ranking_candidates(item, candidates, depth + 1)


def _looks_like_climb(d):
    keys_lower = {k.lower() for k in d.keys()}
    if not (keys_lower & {"name", "title", "climb", "climbname", "climb_name"}):
        return False
    cats = 0
    if keys_lower & {"length", "distance", "km", "length_km"}:
        cats += 1
    if keys_lower & {"gradient", "avg_gradient", "avggradient", "avg_gradient_pct", "averagegradient"}:
        cats += 1
    if keys_lower & {"difficulty", "points", "difficultypoints", "difficulty_points", "score", "rating"}:
        cats += 1
    if keys_lower & {"rank", "position", "ranking"}:
        cats += 1
    if keys_lower & {"elevation", "elevationgain", "elevation_gain", "height", "altitude"}:
        cats += 1
    return cats >= 2


def _normalize_climb(d, idx):
    """Convert a raw JSON climb object to our standard format.

    Climbfinder's __NEXT_DATA__ JSON has a "name" field containing
    formatted stats, e.g. "34.8 km 6 % 1556".  The actual name is in
    "title".  We parse the stats string first to get reliable values,
    then fall back to individual field lookups.

    Stats string format: "LENGTH_KM km AVG_GRADIENT_PCT % DIFFICULTY_PTS"

    Note: "score"/"rating" are user review scores, not difficulty points.
    """
    lc = {k.lower(): v for k, v in d.items()}
    name = _best_name(lc)
    rank = lc.get("rank") or lc.get("position") or lc.get("ranking") or idx + 1

    # Strategy A: parse from "name" field stats string
    length_val = 0
    gradient_val = 0
    difficulty_val = 0

    name_field = lc.get("name", "")
    if isinstance(name_field, str):
        m = re.match(r'^\s*([\d.,]+)\s*km\s+([\d.,]+)\s*%\s+([\d.,]+)', name_field.strip())
        if m:
            length_val = clean_number(m.group(1))
            gradient_val = clean_number(m.group(2))
            difficulty_val = clean_number(m.group(3))

    # Strategy B: individual field lookups (fallback)
    # Note: "score"/"rating" are user review scores — excluded from difficulty.
    if not length_val:
        length_val = clean_number(
            lc.get("length") or lc.get("distance") or lc.get("km") or lc.get("length_km") or 0
        )
    if not gradient_val:
        gradient_val = clean_number(
            lc.get("gradient") or lc.get("avg_gradient") or lc.get("avggradient")
            or lc.get("avg_gradient_pct") or lc.get("averagegradient") or 0
        )
    if not difficulty_val:
        difficulty_val = clean_number(
            lc.get("difficulty") or lc.get("points")
            or lc.get("difficultypoints") or lc.get("difficulty_points") or 0
        )

    # Sanity check: avg_gradient > 20% is virtually impossible for a real climb.
    # If we see this, gradient and difficulty are almost certainly swapped.
    if gradient_val > 20 and difficulty_val <= 20:
        gradient_val, difficulty_val = difficulty_val, gradient_val

    elevation_gain = round(length_val * 10 * gradient_val) if length_val and gradient_val else 0

    return {
        "rank": clean_number(rank),
        "name": name,
        "score": difficulty_val,
        "length_km": length_val,
        "avg_gradient_pct": gradient_val,
        "elevation_gain_m": elevation_gain,
    }


def _best_name(lc):
    """Pick the best human-readable climb name from available fields.
    Skips values that look like concatenated stats (e.g. '34.8 km 6 % 1556')
    by requiring at least one word with 3+ letters.
    """
    for key in ("title", "name", "climb", "climbname", "climb_name",
                "displayname", "display_name", "routename", "route_name"):
        val = lc.get(key)
        if not val:
            continue
        if isinstance(val, dict):
            for lang in ("en", "nl", "fr", "de", "es", "it"):
                if lang in val and isinstance(val[lang], str) and val[lang].strip():
                    return val[lang].strip()
            for v in val.values():
                if isinstance(v, str) and v.strip():
                    return v.strip()
            continue
        if not isinstance(val, str) or not val.strip():
            continue
        s = val.strip()
        if re.search(r'[a-zA-ZÀ-ÿ]{3,}', s):
            return s
    slug = lc.get("slug") or ""
    if isinstance(slug, str) and slug.strip():
        return slug.strip().split("/")[-1].replace("-", " ").title()
    raw = lc.get("name") or lc.get("title") or ""
    return str(raw).strip() if raw else ""


def _detect_table_columns(table):
    """Read <th> headers and map column indices to field names.
    "score"/"rating" = user review — must be checked BEFORE "diff/point".
    """
    col_map = {}
    for idx, th in enumerate(table.find_all("th")):
        text = th.get_text(strip=True).lower()
        if any(k in text for k in ["rank", "#", "pos"]):
            col_map["rank"] = idx
        elif any(k in text for k in ["name", "climb", "col ", "klim", "naam"]):
            col_map["name"] = idx
        elif any(k in text for k in ["score", "rating", "review", "beoordeling", "cijfer"]):
            # Review / user rating — NOT difficulty points
            col_map["review_score"] = idx
        elif any(k in text for k in ["diff", "point", "punten", "moeilijk"]):
            col_map["difficulty"] = idx
        elif any(k in text for k in ["length", "dist", "km", "lengte", "afstand"]):
            col_map["length"] = idx
        elif any(k in text for k in ["grad", "avg", "slope", "%", "stijg", "gemiddeld"]):
            col_map["gradient"] = idx
    return col_map


def _parse_table_row(cells, col_map=None):
    texts = [c.get_text(strip=True) for c in cells]
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

    if col_map and len(col_map) >= 3:
        rank = clean_number(texts[col_map["rank"]].replace(".", "").replace("#", "")) if "rank" in col_map and col_map["rank"] < len(texts) else 0
        # review_score is intentionally excluded from difficulty_points
        difficulty = clean_number(texts[col_map["difficulty"]]) if "difficulty" in col_map and col_map["difficulty"] < len(texts) else 0
        length_km = clean_number(texts[col_map["length"]]) if "length" in col_map and col_map["length"] < len(texts) else 0
        gradient = clean_number(texts[col_map["gradient"]]) if "gradient" in col_map and col_map["gradient"] < len(texts) else 0
    else:
        # Positional fallback — Climbfinder ranking table order after name:
        # [0] avg_gradient_pct  [1] difficulty_points  [2] review_score (skip)
        # Length (km) is NOT a separate column in Climbfinder's ranking table.
        rank_text = texts[0] if name_idx > 0 else ""
        rank = clean_number(rank_text.replace(".", "").replace("#", "").strip())
        remaining = texts[name_idx + 1:]
        gradient = clean_number(remaining[0]) if len(remaining) > 0 else 0
        difficulty = clean_number(remaining[1]) if len(remaining) > 1 else 0
        # remaining[2] = review score — intentionally skipped
        length_km = 0  # not a column in Climbfinder's ranking table HTML

    lv = length_km if isinstance(length_km, (int, float)) else clean_number(length_km)
    gv = gradient if isinstance(gradient, (int, float)) else clean_number(gradient)
    # Sanity check: avg_gradient > 20% is virtually impossible for a real climb
    if gv > 20 and difficulty <= 20:
        gv, difficulty = difficulty, gv
    elevation_gain = round(lv * 10 * gv) if lv and gv else 0

    return {"rank": rank, "name": name, "score": difficulty,
            "length_km": lv, "avg_gradient_pct": gv, "elevation_gain_m": elevation_gain}


def _extract_from_context(link_element, name):
    parent = link_element.parent
    for _ in range(4):
        if parent is None:
            break
        text = parent.get_text(" ", strip=True)
        nums = re.findall(r"[\d]+(?:[.,]\d+)?", text)
        if len(nums) >= 3:
            nums = [clean_number(n) for n in nums]
            # Climbfinder context order: rank, avg_gradient, difficulty, review_score
            gr = nums[1] if len(nums) > 1 else 0
            diff = nums[2] if len(nums) > 2 else 0
            # Sanity check
            if gr > 20 and diff <= 20:
                gr, diff = diff, gr
            return {"rank": nums[0], "name": name, "length_km": 0,
                    "avg_gradient_pct": gr, "score": diff,
                    "elevation_gain_m": 0}
        parent = parent.parent
    return {"rank": 0, "name": name, "score": 0,
            "length_km": 0, "avg_gradient_pct": 0, "elevation_gain_m": 0}


# ---------------------------------------------------------------------------
# Streamlit UI
# ---------------------------------------------------------------------------
st.set_page_config(page_title="Climbfinder Aggregator", page_icon="⛰️", layout="wide")

st.title("Climbfinder Ranking Aggregator")
st.caption("Search regions, scrape climb rankings, and export to Excel or CSV.")

# --- Sidebar: Region selection ---
with st.sidebar:
    st.header("Region Selection")

    countries = sorted(REGIONS_BY_COUNTRY.keys())
    country = st.selectbox("Country", ["All Countries"] + countries)

    if country == "All Countries":
        region_options = ALL_REGIONS
    else:
        region_options = [r for r in ALL_REGIONS if r["country"] == country]

    region_labels = [f"{r['name']}, {r['country']}  (ID: {r['id']})" for r in region_options]
    selected_idx = st.selectbox("Region", range(len(region_labels)),
                                format_func=lambda i: region_labels[i],
                                index=None, placeholder="Select a region...")

    st.markdown("---")
    custom_id = st.text_input("Or enter Region ID directly", placeholder="e.g. 288")

    st.markdown("---")
    sort_mode = st.radio(
        "Ranking type",
        options=["popular", "cotacol"],
        format_func=lambda x: "Populairste klimmen" if x == "popular" else "Moeilijkste klimmen (Cotacol)",
        index=0,
    )

    st.markdown("---")
    col1, col2 = st.columns(2)
    start_page = col1.number_input("Start page", min_value=1, value=1)
    end_page = col2.number_input("End page", min_value=1, value=5)

    fetch_btn = st.button("Fetch Rankings", type="primary", use_container_width=True)

# --- Main area ---
if fetch_btn:
    region_id = custom_id.strip() if custom_id.strip() else (
        region_options[selected_idx]["id"] if selected_idx is not None else None
    )

    if not region_id:
        st.warning("Please select a region or enter a custom Region ID.")
    else:
        if end_page < start_page:
            st.warning("End page must be ≥ start page.")
        else:
            end_page = min(end_page, start_page + 19)
            total_pages = end_page - start_page + 1

            method = "playwright" if playwright_available() else "requests"
            sort_label = "populairste" if sort_mode == "popular" else "moeilijkste (cotacol)"
            st.info(f"Scraping **{sort_label}** klimmen voor regio **{region_id}** — pagina's {start_page}–{end_page} via {method}")

            progress_bar = st.progress(0)
            all_climbs = []
            errors = []

            for page_num in range(start_page, end_page + 1):
                pct = int(((page_num - start_page) / total_pages) * 100)
                progress_bar.progress(pct, text=f"Fetching page {page_num - start_page + 1} of {total_pages}...")

                page_climbs, err = scrape_page(region_id, page_num, sort_mode)
                if err:
                    errors.append(f"Page {page_num}: {err}")
                    break
                if not page_climbs:
                    break
                all_climbs.extend(page_climbs)

                if page_num < end_page:
                    time.sleep(1.0)

            progress_bar.progress(100, text="Done!")

            if errors:
                st.warning(f"Completed with issues: {'; '.join(errors)}")
            elif not all_climbs:
                st.warning("No climbs found. Check the region ID or try a different region.")
            else:
                st.success(f"Fetched **{len(all_climbs)}** climbs across **{len(range(start_page, start_page + len(all_climbs) // 25 + (1 if len(all_climbs) % 25 else 0)))}** pages.")

            if all_climbs:
                df = pd.DataFrame(all_climbs)
                # Show only the 5 relevant columns in the correct order
                display_cols = ["length_km", "name", "avg_gradient_pct", "score", "elevation_gain_m"]
                df_display = df[display_cols].copy()
                score_label = "Populariteit" if sort_mode == "popular" else "Cotacol score"
                df_display.columns = ["Lengte (km)", "Klim", "Gem. stijging (%)", score_label, "Hoogtemeters (m)"]

                st.dataframe(df_display, use_container_width=True, hide_index=True)

                # Export buttons
                col_a, col_b = st.columns(2)

                # Excel export
                excel_buf = io.BytesIO()
                df_display.to_excel(excel_buf, index=False, sheet_name="Rankings")
                filename_prefix = f"Climbfinder_{sort_mode.capitalize()}"
                col_a.download_button("Download Excel", data=excel_buf.getvalue(),
                                      file_name=f"{filename_prefix}_Rankings.xlsx",
                                      mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

                # CSV export
                csv_data = df_display.to_csv(index=False)
                col_b.download_button("Download CSV", data=csv_data,
                                      file_name=f"{filename_prefix}_Rankings.csv",
                                      mime="text/csv")

                # Store in session state for persistence
                st.session_state["last_results"] = df_display

# Show previous results if available
elif "last_results" in st.session_state:
    df_display = st.session_state["last_results"]
    st.dataframe(df_display, use_container_width=True, hide_index=True)

    col_a, col_b = st.columns(2)
    excel_buf = io.BytesIO()
    df_display.to_excel(excel_buf, index=False, sheet_name="Rankings")
    col_a.download_button("Download Excel", data=excel_buf.getvalue(),
                          file_name="Climbfinder_Rankings.xlsx",
                          mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    csv_data = df_display.to_csv(index=False)
    col_b.download_button("Download CSV", data=csv_data,
                          file_name="Climbfinder_Rankings.csv", mime="text/csv")
