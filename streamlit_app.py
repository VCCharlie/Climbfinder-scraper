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


_playwright_error: str = ""   # set by _check_playwright so the UI can show it


def _check_playwright():
    global _playwright_error
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            browser.close()
        _playwright_error = ""
        return True
    except Exception as exc:
        _playwright_error = str(exc)
        return False


@st.cache_resource
def playwright_available():
    return _check_playwright()


def scrape_page(region_id, page_number, sort_mode="popular"):
    url = f"https://climbfinder.com/en/ranking?l={region_id}&p={page_number}&s={sort_mode}"
    if playwright_available():
        return _scrape_with_playwright(url, page_number)
    return _scrape_with_requests(url, page_number, region_id=region_id, sort_mode=sort_mode)


def _scrape_with_playwright(url, page_number):
    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(user_agent=USER_AGENT,
                                          viewport={"width": 1280, "height": 900},
                                          locale="en-US")
            page = context.new_page()

            # ── Network interception: capture API responses ───────────────
            captured_json = []

            def on_response(response):
                try:
                    if response.status != 200:
                        return
                    ct = response.headers.get("content-type", "")
                    if "json" not in ct:
                        return
                    resp_url = response.url
                    # Capture ALL JSON from climbfinder.com (not just known sub-paths)
                    if "climbfinder.com" in resp_url:
                        data = response.json()
                        captured_json.append({"url": resp_url, "data": data})
                        print(f"[API] Captured: {resp_url}")
                except Exception:
                    pass

            page.on("response", on_response)

            page.goto(url, wait_until="domcontentloaded", timeout=25000)

            # Wait for ranking rows to appear in the DOM
            try:
                page.wait_for_selector(
                    "table tr td, a[href*='/climbs/'], a[href*='/cols/'], [class*='ranking']",
                    timeout=12000)
                page.wait_for_timeout(800)
            except Exception:
                pass

            # ── DOM table extraction: headers + rows ─────────────────────
            dom_table = None
            try:
                dom_table = page.evaluate("""
                    () => {
                        const table = document.querySelector('table');
                        if (!table) return null;
                        // Prefer <th> elements; fall back to first <tr> cells as headers
                        const ths = Array.from(table.querySelectorAll('th'));
                        let headers;
                        let skipFirstRow = false;
                        if (ths.length > 0) {
                            headers = ths.map(th => th.innerText.trim());
                        } else {
                            const firstRow = table.querySelector('tr');
                            if (firstRow) {
                                headers = Array.from(firstRow.querySelectorAll('td'))
                                              .map(td => td.innerText.trim());
                                skipFirstRow = true;
                            } else {
                                headers = [];
                            }
                        }
                        const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
                        let allRows = bodyRows.length > 0
                            ? bodyRows
                            : Array.from(table.querySelectorAll('tr')).slice(1);
                        if (skipFirstRow && bodyRows.length === 0) {
                            allRows = Array.from(table.querySelectorAll('tr')).slice(1);
                        }
                        const rows = allRows.map(tr => {
                            const tds = Array.from(tr.querySelectorAll('td'));
                            if (tds.length < 2) return null;
                            const linkEl = tr.querySelector(
                                'a[href*="/climb"], a[href*="/col"]'
                            );
                            return {
                                cells: tds.map(td => td.innerText.trim()),
                                link: linkEl ? linkEl.href : null,
                                linkText: linkEl ? linkEl.innerText.trim() : null
                            };
                        }).filter(r => r !== null && r.cells.some(c => c.length > 0));
                        return { headers: headers, rows: rows };
                    }
                """)
            except Exception as e:
                print(f"[DOM] evaluate failed: {e}")

            html = page.content()
            browser.close()

        # ── Choose best data source ───────────────────────────────────────
        global _debug_info
        _debug_info = {
            "dom_table_found": dom_table is not None,
            "dom_table_headers": dom_table.get("headers", []) if dom_table else [],
            "dom_table_rows": len(dom_table.get("rows", [])) if dom_table else 0,
            "api_responses": len(captured_json),
            "api_urls": [r["url"] for r in captured_json],
            "html_length": len(html),
            "html_snippet": html[:3000],
            "path": "none",
        }

        # 1. DOM table with real column headers (Playwright rendered the page)
        if dom_table and dom_table.get("rows"):
            climbs = _parse_dom_table(dom_table, page_number)
            if climbs:
                _debug_info["path"] = "dom_table"
                return climbs, None
            _debug_info["dom_table_parse_result"] = "0 climbs extracted"

        # 2. Intercepted API JSON responses
        for resp_info in captured_json:
            climbs = _find_ranking_data(resp_info["data"])
            if climbs:
                _debug_info["path"] = f"api:{resp_info['url']}"
                print(f"  Page {page_number}: {len(climbs)} climbs from API {resp_info['url']}")
                return climbs, None

        # 3. Full HTML fallback (also handles __NEXT_DATA__ if present)
        _debug_info["path"] = "html_fallback"
        return _parse_html(html, page_number)

    except Exception as exc:
        print(f"[ERROR] Playwright failed for page {page_number}: {exc}")
        return [], str(exc)


def _parse_dom_table(dom_table, page_number):
    """Parse a table structure extracted from the DOM via page.evaluate().

    This is the most reliable source when Playwright has rendered the page:
    we get the exact column headers and cell text, so no guessing needed.
    """
    global _debug_raw_sample

    headers_raw = dom_table.get("headers", [])
    rows = dom_table.get("rows", [])
    headers = [h.lower() for h in headers_raw]

    print(f"  [DOM] headers={headers_raw!r}  rows={len(rows)}")

    # Map headers to semantic column roles
    col_map = {}
    for idx, h in enumerate(headers):
        if "rank" not in col_map and any(k in h for k in ["#", "rank", "pos", "nr"]):
            col_map["rank"] = idx
        elif "length" not in col_map and any(k in h for k in ["length", "dist", "km", "lengte", "afstand"]):
            col_map["length"] = idx
        elif "gradient" not in col_map and any(k in h for k in ["grad", "avg", "slope", "%", "stijg", "gemiddeld"]):
            col_map["gradient"] = idx
        elif "name" not in col_map and any(k in h for k in ["name", "climb", "klim", "col ", "naam", "parcours"]):
            col_map["name"] = idx
        elif "difficulty" not in col_map and any(k in h for k in ["diff", "point", "punten", "moeilijk", "cotacol", "popular", "score"]):
            col_map["difficulty"] = idx
        elif "review" not in col_map and any(k in h for k in ["rating", "review", "beoordeling", "cijfer", "stars"]):
            col_map["review"] = idx

    print(f"  [DOM] col_map={col_map}")

    # Store first 3 rows as debug sample (with header labels)
    _debug_raw_sample = []
    for row in rows[:3]:
        sample = {}
        for i, cell in enumerate(row.get("cells", [])):
            label = headers_raw[i] if i < len(headers_raw) else f"col_{i}"
            sample[label] = cell
        sample["_link"] = row.get("link")
        _debug_raw_sample.append(sample)

    climbs = []
    for row in rows:
        cells = row.get("cells", [])
        link_text = (row.get("linkText") or "").strip()
        if not cells:
            continue

        # Determine climb name
        if "name" in col_map and col_map["name"] < len(cells):
            name = link_text or cells[col_map["name"]]
        else:
            name = link_text or next(
                (c for c in cells if re.search(r'[a-zA-ZÀ-ÿ]{3,}', c) and len(c) > 3), ""
            )
        if not name:
            continue

        def _cell(key):
            i = col_map.get(key)
            return clean_number(cells[i]) if i is not None and i < len(cells) else 0

        if len(col_map) >= 2:
            rank = _cell("rank")
            length_km = _cell("length")
            gradient = _cell("gradient")
            difficulty = _cell("difficulty")
        else:
            # No headers — positional fallback.
            # Climbfinder ranking table column order:
            #   # | Naam | Lengte (km) | Gem. stijging | Punten | Beoordeling
            name_idx = next(
                (i for i, c in enumerate(cells) if c == link_text and link_text), 1
            )
            rank = clean_number(cells[0]) if name_idx > 0 and cells[0] else 0
            rest = cells[name_idx + 1:]
            length_km  = clean_number(rest[0]) if len(rest) > 0 else 0
            gradient   = clean_number(rest[1]) if len(rest) > 1 else 0
            difficulty = clean_number(rest[2]) if len(rest) > 2 else 0
            # rest[3] = beoordeling (review score) — skip

        # Sanity check: avg gradient > 30% is virtually impossible
        if gradient > 30 and difficulty <= 30:
            gradient, difficulty = difficulty, gradient

        elevation_gain = round(length_km * 10 * gradient) if length_km and gradient else 0

        climbs.append({
            "rank": rank,
            "name": name,
            "length_km": length_km,
            "avg_gradient_pct": gradient,
            "score": difficulty,
            "elevation_gain_m": elevation_gain,
        })

    if climbs:
        print(f"  Page {page_number}: {len(climbs)} climbs from DOM table")
    return climbs


def _scrape_with_requests(url, page_number, region_id=None, sort_mode=None):
    global _debug_info
    _debug_info = {
        "dom_table_found": False,
        "dom_table_headers": [],
        "dom_table_rows": 0,
        "api_responses": 0,
        "path": "requests",
        "playwright_error": _playwright_error,
    }

    # ── Try the JSON API directly (works without JavaScript) ──────────────
    # Climbfinder loads ranking data from uphill.climbfinder.com; try that
    # endpoint directly with an Accept: application/json header.
    if region_id:
        api_url = (f"https://uphill.climbfinder.com/en/ranking"
                   f"?l={region_id}&p={page_number}&s={sort_mode or 'popular'}")
        try:
            api_resp = requests.get(
                api_url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json, text/plain, */*",
                    "Referer": "https://climbfinder.com/",
                    "Origin": "https://climbfinder.com",
                },
                timeout=15,
            )
            if api_resp.status_code == 200:
                ct = api_resp.headers.get("content-type", "")
                _debug_info["api_status"] = api_resp.status_code
                _debug_info["api_content_type"] = ct
                _debug_info["api_url_tried"] = api_url
                if "json" in ct:
                    climbs = _find_ranking_data(api_resp.json())
                    if climbs:
                        _debug_info["path"] = "api_direct"
                        return climbs, None
                # Not JSON — store snippet for debugging
                _debug_info["api_snippet"] = api_resp.text[:500]
            else:
                _debug_info["api_status"] = api_resp.status_code
                _debug_info["api_url_tried"] = api_url
        except requests.RequestException as exc:
            _debug_info["api_error"] = str(exc)
            _debug_info["api_url_tried"] = api_url

    # ── Fall back to HTML page ─────────────────────────────────────────────
    html_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://climbfinder.com/en/ranking",
    }
    try:
        resp = requests.get(url, headers=html_headers, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as exc:
        return [], str(exc)
    _debug_info["html_length"] = len(resp.text)
    _debug_info["html_snippet"] = resp.text[:3000]
    return _parse_html(resp.text, page_number)


# Module-level storage so the Streamlit debug expander can read it
# after a scrape without changing the function return signatures.
_debug_raw_sample: list = []   # raw dicts of first 3 climb objects found
_debug_info: dict = {}          # scrape path metadata (updated each scrape)


def _normalize_climb(d, idx):
    """Convert a raw JSON climb object to our standard format.

    Strategy A  — scan ALL string fields for a stats pattern.
    Climbfinder embeds formatted stats in the JSON, e.g. "34.8 km 6 % 1556",
    but the field name that carries this string differs between ranking modes:
    - cotacol ranking  → typically the "name" field
    - popular ranking  → may be a different field (label, subtitle, stats, …)
    So we scan every string value in the object and pick the first match.

    Stats string format: "LENGTH_KM km AVG_GRADIENT_PCT % SCORE"

    Strategy B  — fall back to individual named fields if no stats string found.

    Note: "score"/"rating" are user star-review scores — deliberately excluded
    from the difficulty/score lookup to avoid confusing them with ranking scores.
    """
    lc = {k.lower(): v for k, v in d.items()}
    name = _best_name(lc)
    rank = lc.get("rank") or lc.get("position") or lc.get("ranking") or idx + 1

    # ------------------------------------------------------------------
    # Strategy A: scan ALL string fields for "LENGTH km GRADIENT % SCORE"
    # ------------------------------------------------------------------
    _stats_re = re.compile(r'^\s*([\d.,]+)\s*km\s+([\d.,]+)\s*%\s+([\d.,]+)')
    length_val = 0
    gradient_val = 0
    difficulty_val = 0
    _stats_field = None   # which field held the stats string (debug only)

    # Preferred order: check "name" first (most common), then all others
    field_order = ["name"] + [k for k in lc if k != "name"]
    for field_key in field_order:
        field_val = lc.get(field_key, "")
        if not isinstance(field_val, str):
            continue
        m = _stats_re.match(field_val.strip())
        if not m:
            continue
        cand_length = clean_number(m.group(1))
        cand_gradient = clean_number(m.group(2))
        cand_score = clean_number(m.group(3))
        # Reject if "length" looks implausibly small (< 0.3 km) —
        # that would mean the matched value is probably not a real length.
        if cand_length >= 0.3:
            length_val = cand_length
            gradient_val = cand_gradient
            difficulty_val = cand_score
            _stats_field = field_key
            break

    # ------------------------------------------------------------------
    # Strategy B: individual named-field lookups (fallback)
    # ------------------------------------------------------------------
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
        # "score"/"rating" = user star-review — intentionally excluded here
        difficulty_val = clean_number(
            lc.get("difficulty") or lc.get("points")
            or lc.get("difficultypoints") or lc.get("difficulty_points") or 0
        )

    # ------------------------------------------------------------------
    # Sanity check
    # ------------------------------------------------------------------
    # avg_gradient > 20% is virtually impossible for a real climb.
    # If gradient_val is huge AND difficulty_val is small, they are swapped.
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
        "_debug": {
            "raw_keys": list(lc.keys()),
            "raw_values": {k: v for k, v in lc.items()
                           if not isinstance(v, (dict, list))},
            "stats_field": _stats_field,
        },
    }
def _parse_html(html, page_number):
    global _debug_raw_sample
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
        # Populate debug sample using real <th> headers
        th_labels = [th.get_text(strip=True) for th in table.find_all("th")]
        debug_sample = []
        for row in table.find_all("tr"):
            tds = row.find_all("td")
            if not tds:
                continue
            sample = {}
            for i, td in enumerate(tds):
                label = th_labels[i] if i < len(th_labels) else f"col_{i}"
                sample[label] = td.get_text(strip=True)
            link_el = row.find("a", href=re.compile(r"/(climbs?|cols?)/"))
            sample["_link"] = link_el["href"] if link_el else None
            debug_sample.append(sample)
            if len(debug_sample) >= 3:
                break
        if debug_sample:
            _debug_raw_sample = debug_sample

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
            if len(_debug_raw_sample) < 3:
                parent_text = (link.parent.get_text(" ", strip=True) if link.parent else "")[:200]
                _debug_raw_sample.append({
                    "naam": name,
                    "href": link.get("href", ""),
                    "context_tekst": parent_text,
                    "_strategy": "link-context",
                })

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
    best = candidates[0]

    # Store first 3 raw objects for the debug expander (module-level)
    global _debug_raw_sample
    _debug_raw_sample = [dict(item) for item in best[:3] if isinstance(item, dict)]

    normalized = [_normalize_climb(item, idx) for idx, item in enumerate(best)
                  if isinstance(item, dict)]
    return normalized


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
    """Read <th> headers (or first-row <td> if no <th>) and map indices to field names.
    "score"/"rating" = user review — must be checked BEFORE "diff/point".
    """
    col_map = {}
    header_cells = table.find_all("th")
    if not header_cells:
        # Climbfinder may use <td> for all cells; treat first row as header
        first_row = table.find("tr")
        if first_row:
            header_cells = first_row.find_all("td")
    for idx, th in enumerate(header_cells):
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
        # Positional fallback — Climbfinder ranking table column order:
        #   # | Naam | Lengte (km) | Gem. stijging | Punten | Beoordeling
        rank_text = texts[0] if name_idx > 0 else ""
        rank = clean_number(rank_text.replace(".", "").replace("#", "").strip())
        remaining = texts[name_idx + 1:]
        length_km  = clean_number(remaining[0]) if len(remaining) > 0 else 0
        gradient   = clean_number(remaining[1]) if len(remaining) > 1 else 0
        difficulty = clean_number(remaining[2]) if len(remaining) > 2 else 0
        # remaining[3] = beoordeling (review score) — skip

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

# Playwright status banner — shown once at startup
if not playwright_available():
    _pw_err = _playwright_error or "onbekende fout"
    st.error(
        "**Playwright-browser niet beschikbaar** — volledige data vereist Playwright.\n\n"
        f"Fout: `{_pw_err}`\n\n"
        "Voer dit eenmalig uit in je terminal om de browser te installeren:\n"
        "```\n"
        r".\.venv\Scripts\python.exe -m playwright install chromium"
        "\n```\n"
        "Herstart daarna de app. Tot die tijd probeert de scraper de API direct te benaderen."
    )

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
                # Strip internal _debug key before building the display DataFrame
                clean_climbs = [{k: v for k, v in c.items() if k != "_debug"}
                                for c in all_climbs]
                df = pd.DataFrame(clean_climbs)
                # Always show all 5 columns — length is essential
                display_cols = ["length_km", "name", "avg_gradient_pct", "score", "elevation_gain_m"]
                df_display = df[display_cols].copy()
                df_display.columns = ["Lengte (km)", "Klim", "Gem. stijging (%)", "Moeilijkheid (punten)", "Hoogtemeters (m)"]

                # Save to session state BEFORE any export calls that might crash
                st.session_state["last_results"] = df_display
                st.session_state["_debug_raw_sample"] = _debug_raw_sample[:]
                st.session_state["_debug_info"] = dict(_debug_info)

                st.dataframe(df_display, use_container_width=True, hide_index=True)

                # ---- Debug expander ----------------------------------------
                with st.expander("🔍 Debug: bekijk exacte tabel-kolommen (eerste 3 klimmen)"):
                    st.caption(
                        "Kolomnamen en waarden zoals gelezen uit de gerenderde DOM-tabel of HTML.  "
                        "Deel deze output als de kolommen nog steeds verkeerd staan."
                    )

                    # Always show scrape-path metadata
                    info = _debug_info
                    path = info.get("path", "onbekend")
                    path_labels = {
                        "dom_table":    "DOM-tabel (Playwright evaluate)",
                        "html_fallback":"HTML-fallback (BeautifulSoup tabel of links)",
                        "api_direct":   "Directe API-call (uphill.climbfinder.com)",
                        "requests":     "Requests (geen Playwright) → link-fallback",
                        "none":         "Geen pad bepaald",
                    }
                    if path.startswith("api:"):
                        path_label = f"API-respons (Playwright): {path[4:]}"
                    else:
                        path_label = path_labels.get(path, path)

                    st.markdown(f"**Scrape-pad:** `{path_label}`")

                    # Show API probe result when Playwright not available
                    if info.get("api_url_tried"):
                        st.markdown(f"**API geprobeerd:** `{info['api_url_tried']}`")
                        st.markdown(f"HTTP status: `{info.get('api_status', '?')}` — "
                                    f"Content-Type: `{info.get('api_content_type', '?')}`")
                        if info.get("api_error"):
                            st.error(f"API-fout: {info['api_error']}")
                        if info.get("api_snippet"):
                            with st.expander("API-respons snippet"):
                                st.code(info["api_snippet"])

                    if info.get("dom_table_found"):
                        dom_hdrs = info.get("dom_table_headers", [])
                        dom_rows = info.get("dom_table_rows", 0)
                        st.markdown(
                            f"**DOM-tabel headers** ({dom_rows} rijen):  \n`{dom_hdrs}`"
                        )
                        if info.get("dom_table_parse_result"):
                            st.warning(f"DOM-tabel parsing: {info['dom_table_parse_result']}")
                    else:
                        if path not in ("requests",):
                            st.warning("Geen `<table>` gevonden in gerenderde DOM.")
                        api_urls = info.get("api_urls", [])
                        if api_urls:
                            st.markdown("**Gevangen API-verzoeken:**  \n" +
                                        "\n".join(f"- `{u}`" for u in api_urls))
                        else:
                            st.info("Geen climbfinder.com JSON-API calls onderschept.")

                    # Raw sample rows
                    debug_rows = []
                    for i, raw in enumerate(_debug_raw_sample[:3]):
                        for field, val in raw.items():
                            if not isinstance(val, (dict, list)):
                                debug_rows.append({
                                    "klimnr": i + 1,
                                    "veldnaam": field,
                                    "waarde": str(val)[:160],
                                })
                    if debug_rows:
                        st.markdown("**Eerste 3 ruwe rijen:**")
                        st.dataframe(pd.DataFrame(debug_rows), use_container_width=True, hide_index=True)
                    else:
                        st.warning("Geen ruwe rij-data — data komt waarschijnlijk via link-context heuristiek.")

                    # Stats-field info from JSON path
                    first_debug = all_climbs[0].get("_debug", {}) if all_climbs else {}
                    sf = first_debug.get("stats_field")
                    if sf:
                        st.success(f"Stats-veld: **{sf!r}** — patroon `LENGTH km GRADIENT % SCORE`")

                    # HTML snippet for deep debugging
                    snippet = info.get("html_snippet", "")
                    if snippet:
                        with st.expander("🔎 HTML-snippet (eerste 3000 tekens van de paginabron)"):
                            st.code(snippet, language="html")
                # ------------------------------------------------------------

                # Export buttons
                col_a, col_b = st.columns(2)
                filename_prefix = f"Climbfinder_{sort_mode.capitalize()}"

                # Excel export (requires openpyxl)
                try:
                    excel_buf = io.BytesIO()
                    df_display.to_excel(excel_buf, index=False, sheet_name="Rankings")
                    col_a.download_button("Download Excel", data=excel_buf.getvalue(),
                                          file_name=f"{filename_prefix}_Rankings.xlsx",
                                          mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                except ImportError:
                    col_a.error("Excel vereist openpyxl:  \n`pip install openpyxl`")

                # CSV export (no extra dependency)
                csv_data = df_display.to_csv(index=False)
                col_b.download_button("Download CSV", data=csv_data,
                                      file_name=f"{filename_prefix}_Rankings.csv",
                                      mime="text/csv")

# Show previous results if available
elif "last_results" in st.session_state:
    df_display = st.session_state["last_results"]
    st.dataframe(df_display, use_container_width=True, hide_index=True)

    # Debug expander — uses data saved in session state from last scrape
    with st.expander("🔍 Debug: bekijk exacte tabel-kolommen (eerste 3 klimmen)"):
        saved_info = st.session_state.get("_debug_info", {})
        if saved_info:
            path = saved_info.get("path", "onbekend")
            path_labels = {
                "dom_table": "DOM-tabel (Playwright evaluate)",
                "html_fallback": "HTML-fallback (BeautifulSoup tabel of links)",
            }
            path_label = (
                f"API-respons: {path[4:]}" if path.startswith("api:")
                else path_labels.get(path, path)
            )
            st.markdown(f"**Scrape-pad:** `{path_label}`")
            if saved_info.get("dom_table_found"):
                st.markdown(
                    f"**DOM-tabel headers** ({saved_info.get('dom_table_rows', 0)} rijen):  \n"
                    f"`{saved_info.get('dom_table_headers', [])}`"
                )
        saved_sample = st.session_state.get("_debug_raw_sample", [])
        debug_rows = []
        for i, raw in enumerate(saved_sample[:3]):
            for field, val in raw.items():
                if not isinstance(val, (dict, list)):
                    debug_rows.append({"klimnr": i + 1, "veldnaam": field, "waarde": str(val)[:120]})
        if debug_rows:
            st.dataframe(pd.DataFrame(debug_rows), use_container_width=True, hide_index=True)
        elif not saved_info:
            st.info("Geen debug-data beschikbaar. Scrape opnieuw om de analyse te zien.")

    col_a, col_b = st.columns(2)
    try:
        excel_buf = io.BytesIO()
        df_display.to_excel(excel_buf, index=False, sheet_name="Rankings")
        col_a.download_button("Download Excel", data=excel_buf.getvalue(),
                              file_name="Climbfinder_Rankings.xlsx",
                              mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    except ImportError:
        col_a.error("Excel vereist openpyxl:  \n`pip install openpyxl`")
    csv_data = df_display.to_csv(index=False)
    col_b.download_button("Download CSV", data=csv_data,
                          file_name="Climbfinder_Rankings.csv", mime="text/csv")
