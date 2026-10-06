#!/usr/bin/env python3
"""
Import climbs from Climbfinder into docs/climbs/data/*.json

Uses:
  - Ranking (Playwright): locality l=ID and/or geo g=LONIlAT (+25 km)
  - Climb page HTML: embedded climbgeojson + encoded elevation profile (cfDecode)

Usage:
  python scripts/climbfinder_import.py --preset nl-limburg
  python scripts/climbfinder_import.py --preset fr-alps --pages 2 --limit 80
  python scripts/climbfinder_import.py --locality 288 --pages 3 --meta-id fr-test ...
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

USER_AGENT = "Mozilla/5.0 (compatible; FietsKlimDB/1.0)"

PRESETS: dict[str, dict[str, Any]] = {
    "nl-limburg": {
        "meta_id": "nl-limburg",
        "title": "Zuid-Limburg beklimmingen (Climbfinder Popular)",
        "country": "NL",
        "region_label": "Zuid-Limburg",
        "tags": ["climbfinder", "zuid-limburg"],
        # Climbfinder URL: …/ranking?l=27&s=popular (≈688). l=280 is provincie Limburg (ander, kleiner).
        "geo": None,
        "localities": [27],
        "out": "docs/climbs/data/nl-limburg.json",
        "default_pages": 2,
        "default_limit": 688,
    },
    "fr-alps": {
        "meta_id": "fr-alps",
        "title": "Franse Alpen (Climbfinder)",
        "country": "FR",
        "region_label": "Alpes",
        "tags": ["climbfinder", "fr-alps"],
        "geo": None,
        "localities": [
            288,  # Haute-Savoie
            957,  # Savoie
            192,  # Hautes-Alpes
            290,  # Alpes-de-Haute-Provence
            379,  # Alpes-Maritimes
        ],
        "locality_labels": {
            "288": "Haute-Savoie",
            "957": "Savoie",
            "192": "Hautes-Alpes",
            "290": "Alpes-de-Haute-Provence",
            "379": "Alpes-Maritimes",
        },
        "out": "docs/climbs/data/fr-alps.json",
        "default_pages": 2,
        "default_limit": 80,
    },
}


def cf_decode(b64: str, scale: float, seed: int) -> list[float]:
    """Port of Climbfinder's cfDecode() from climb profile pages."""
    raw = base64.b64decode(b64)
    n = len(raw)
    s = (((int(seed) | 0) ^ 0x5EEDC11B) ^ ((n * 2654435761) & 0xFFFFFFFF)) & 0xFFFFFFFF
    if not s:
        s = 0x1F2E3D4C
    xored = bytearray(n)
    for k in range(n):
        s = (s ^ ((s << 13) & 0xFFFFFFFF)) & 0xFFFFFFFF
        s = (s ^ (s >> 17)) & 0xFFFFFFFF
        s = (s ^ ((s << 5) & 0xFFFFFFFF)) & 0xFFFFFFFF
        xored[k] = raw[k] ^ (s & 0xFF)

    out: list[float] = []
    prev = 0
    i = 0
    while i < n:
        z = 0
        shift = 0
        while True:
            b = xored[i]
            i += 1
            z += (b & 0x7F) * (2**shift)
            shift += 7
            if not (b & 0x80):
                break
        if z % 2 == 1:
            prev += -((z + 1) // 2)
        else:
            prev += z // 2
        out.append(prev / scale)
    return out


def extract_coordinates_array(text: str, marker: str = '"coordinates":') -> list[list[float]]:
    start = text.find(marker)
    if start < 0:
        raise ValueError("coordinates marker not found")
    i = text.index("[", start)
    depth = 0
    for j in range(i, len(text)):
        ch = text[j]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return json.loads(text[i : j + 1])
    raise ValueError("unclosed coordinates array")


def _parse_difficulty(category: str | None) -> float | None:
    if not category:
        return None
    try:
        return float(category)
    except ValueError:
        return None


def normalize_climb_category(category: str | None) -> str | None:
    """HC / SHC / 1–5 as on Climbfinder (Alpine-style classification)."""
    if not category or not str(category).strip():
        return None
    c = str(category).strip().upper()
    if c in ("HC", "SHC"):
        return c
    if c.isdigit() and 1 <= int(c) <= 5:
        return c
    return c if len(c) <= 4 else None


def steepest_gradient_pct(
    distances_m: list[float] | list[int],
    elevations_m: list[float],
    window_m: float,
) -> float:
    """Max average gradient over any contiguous segment of at least window_m."""
    n = len(distances_m)
    best = 0.0
    for i in range(n):
        for j in range(i + 1, n):
            d = float(distances_m[j]) - float(distances_m[i])
            if d < window_m:
                continue
            g = 100.0 * (elevations_m[j] - elevations_m[i]) / d
            if g > best:
                best = g
            break
    return round(best, 1)


def decode_graph_gradients_pct(grad_enc: str, sd: int) -> list[float]:
    """graphGradientsEnc uses the same cfDecode stream with scale 100 → %."""
    return [round(x, 1) for x in cf_decode(grad_enc, 100, sd)]


def fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_climb_page(
    page_html: str,
    url: str,
    *,
    region_label: str,
    country: str,
    tags: list[str],
) -> dict[str, Any]:
    m_id = re.search(r"climbId\s*=\s*(\d+)", page_html)
    m_slug = re.search(r"/en/climbs/([a-z0-9-]+)", url)
    climb_id = int(m_id.group(1)) if m_id else None
    slug = m_slug.group(1) if m_slug else None

    geo_start = page_html.find("const climbgeojson")
    geo_end = page_html.find("const finishgeojson", geo_start)
    geo_chunk = page_html[geo_start:geo_end] if geo_start >= 0 and geo_end > geo_start else page_html
    coordinates = extract_coordinates_array(geo_chunk)
    geometry = {"type": "LineString", "coordinates": coordinates}

    m_data = re.search(
        r"const DATA = \{\s*"
        r'name:\s*"([^"]*)",\s*'
        r'category:\s*"([^"]*)",\s*'
        r'sd:\s*(\d+),\s*'
        r'graphInterval:\s*(\d+),\s*'
        r'graphGradientsEnc:\s*"([^"]+)",\s*'
        r'pathInterval:\s*(\d+),\s*'
        r'pathElevationsEnc:\s*"([^"]+)",\s*'
        r'length:\s*(\d+)',
        page_html,
        re.DOTALL,
    )
    if not m_data:
        raise ValueError("No DATA block with profile encoding")
    name, category, sd, graph_interval, grad_enc, path_interval, elev_enc, length_m = m_data.groups()
    name = html.unescape(name)
    sd_i = int(sd)
    graph_interval_i = int(graph_interval)
    path_interval_i = int(path_interval)
    length_i = int(length_m)
    elevations = cf_decode(elev_enc, 10, sd_i)
    n = len(elevations)
    distances_m = [min(i * path_interval_i, length_i) for i in range(n)]

    graph_gradients_pct = decode_graph_gradients_pct(grad_enc, sd_i)
    graph_distances_m = [
        min(i * graph_interval_i, length_i) for i in range(len(graph_gradients_pct))
    ]

    coords = geometry["coordinates"]
    gain = sum(max(0.0, elevations[i] - elevations[i - 1]) for i in range(1, n))
    loss = sum(max(0.0, elevations[i - 1] - elevations[i]) for i in range(1, n))
    avg_grad = (100.0 * gain / length_i) if length_i else 0.0
    gradients = []
    for i in range(1, n):
        d = distances_m[i] - distances_m[i - 1]
        if d > 0:
            gradients.append(100.0 * (elevations[i] - elevations[i - 1]) / d)

    steepest_100m = steepest_gradient_pct(distances_m, elevations, 100.0)
    steepest_1km = steepest_gradient_pct(distances_m, elevations, 1000.0)

    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]

    slug_id = slug or re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    classification = normalize_climb_category(category)

    return {
        "id": slug_id,
        "name": name,
        "region": region_label,
        "country": country,
        "classification": classification,
        "climbfinder": {
            "id": climb_id,
            "slug": slug,
            "url": f"https://climbfinder.com/en/climbs/{slug}",
            "category": category,
        },
        "stats": {
            "length_m": length_i,
            "elevation_gain_m": round(gain),
            "elevation_loss_m": round(loss),
            "avg_gradient_pct": round(avg_grad, 1),
            "max_gradient_pct": round(max(gradients), 1) if gradients else 0.0,
            "steepest_100m_pct": steepest_100m,
            "steepest_1km_pct": steepest_1km,
            "classification": classification,
        },
        "difficulty_score": _parse_difficulty(category),
        "geometry": {"type": "LineString", "coordinates": coords},
        "profile": {
            "distances_m": distances_m,
            "elevations_m": [round(e, 1) for e in elevations],
            "path_interval_m": path_interval_i,
            "graph_interval_m": graph_interval_i,
            "graph_distances_m": graph_distances_m,
            "graph_gradients_pct": graph_gradients_pct,
        },
        "bbox": [min(lons), min(lats), max(lons), max(lats)],
        "start": {"lng": coords[0][0], "lat": coords[0][1]},
        "summit": {"lng": coords[-1][0], "lat": coords[-1][1]},
        "tags": list(tags),
        "sources": [
            {
                "name": "climbfinder",
                "url": f"https://climbfinder.com/en/climbs/{slug}",
                "note": "Route geometry + elevation profile from climb page",
            }
        ],
    }


def _collect_slugs_from_page(page, ranking_url: str) -> list[str]:
    page.goto(ranking_url, wait_until="networkidle", timeout=120000)
    page.wait_for_timeout(1200)
    hrefs = page.eval_on_selector_all(
        "a.ranking-item-link",
        "els => els.map(e => e.getAttribute('href')).filter(Boolean)",
    )
    slugs: list[str] = []
    for href in hrefs:
        m = re.search(r"/climbs/([a-z0-9-]+)", href)
        if m:
            slugs.append(m.group(1))
    return slugs


def _fetch_ranking_slugs_page(
    *,
    locality: int,
    offset: int,
    per_page: int,
    sort: str,
    headers: dict[str, str],
    api: str,
) -> list[str]:
    import urllib.parse
    import urllib.request

    q = urllib.parse.urlencode(
        {
            "language": "en",
            "offset": offset,
            "limit": per_page,
            "sort": sort,
            "locality": locality,
            "radius": 25,
        }
    )
    req = urllib.request.Request(f"{api}?{q}", headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    return [r["slug"] for r in (data.get("data") or []) if r.get("slug")]


def ranking_slugs_api(
    *,
    localities: list[int],
    pages: int,
    per_page: int = 25,
    sort: str = "popular",
    all_pages: bool = False,
) -> list[str]:
    import time
    import urllib.request

    api = "https://uphill.climbfinder.com/v2/climbs"
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Referer": "https://climbfinder.com/",
        "Origin": "https://climbfinder.com",
    }
    slugs: list[str] = []
    seen: set[str] = set()
    for locality in localities:
        page_num = 0
        while True:
            if not all_pages and page_num >= pages:
                break
            if all_pages and page_num >= 200:
                print(f"  warn: stopped at 200 pages for locality {locality}")
                break
            offset = page_num * per_page
            batch = _fetch_ranking_slugs_page(
                locality=locality,
                offset=offset,
                per_page=per_page,
                sort=sort,
                headers=headers,
                api=api,
            )
            if not batch:
                break
            for slug in batch:
                if slug not in seen:
                    seen.add(slug)
                    slugs.append(slug)
            page_num += 1
            time.sleep(0.2)
        if all_pages:
            print(f"  locality {locality}: {len(slugs)} slugs from {page_num} API page(s)")
    return slugs


def ranking_slugs_playwright(
    *,
    geo: str | None,
    localities: list[int],
    pages: int,
) -> list[str]:
    from playwright.sync_api import sync_playwright

    slugs: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        if geo:
            for page_num in range(1, pages + 1):
                url = f"https://climbfinder.com/en/ranking?g={geo}&p={page_num}&s=popular"
                print(f"  ranking {url}")
                slugs.extend(_collect_slugs_from_page(page, url))
        for locality in localities:
            for page_num in range(1, pages + 1):
                url = f"https://climbfinder.com/en/ranking?l={locality}&p={page_num}&s=popular"
                print(f"  ranking {url}")
                slugs.extend(_collect_slugs_from_page(page, url))
        browser.close()

    seen: set[str] = set()
    out: list[str] = []
    for s in slugs:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--preset",
        choices=sorted(PRESETS.keys()),
        help="Built-in region bundle (overrides meta/out defaults)",
    )
    parser.add_argument(
        "--geo",
        default=None,
        help="Climbfinder g= param (lonIlat), +25 km radius ranking",
    )
    parser.add_argument(
        "--locality",
        type=int,
        action="append",
        default=[],
        help="Climbfinder locality id (l=), repeatable",
    )
    parser.add_argument(
        "--pages",
        type=int,
        default=None,
        help="Ranking pages per source (25 slugs each). Ignored if --all-pages.",
    )
    parser.add_argument(
        "--all-pages",
        action="store_true",
        help="Fetch Popular ranking until API returns no more (e.g. ~688 for l=27)",
    )
    parser.add_argument("--limit", type=int, default=None, help="Max climbs to import")
    parser.add_argument("--out", default=None)
    parser.add_argument("--meta-id", default=None)
    parser.add_argument("--title", default=None)
    parser.add_argument("--country", default=None)
    parser.add_argument("--region-label", default=None)
    parser.add_argument("--tag", action="append", default=[])
    args = parser.parse_args()

    cfg: dict[str, Any] = {}
    if args.preset:
        cfg = dict(PRESETS[args.preset])

    geo = args.geo if args.geo is not None else cfg.get("geo")
    localities = args.locality or cfg.get("localities") or []
    pages = args.pages if args.pages is not None else cfg.get("default_pages", 2)
    limit = args.limit if args.limit is not None else cfg.get("default_limit", 40)
    out_path = args.out or cfg.get("out", "docs/climbs/data/climbs.json")
    meta_id = args.meta_id or cfg.get("meta_id", "region")
    title = args.title or cfg.get("title", meta_id)
    country = args.country or cfg.get("country", "XX")
    region_label = args.region_label or cfg.get("region_label", title)
    tags = args.tag or cfg.get("tags") or ["climbfinder"]

    if not geo and not localities:
        raise SystemExit("Specify --geo, --locality, or --preset with a defined source.")

    mode = "all API pages" if args.all_pages else f"{pages} page(s)"
    print(f"Fetching ranking slugs (geo={geo!r}, localities={localities}, {mode})…")
    if localities and not geo:
        slugs = ranking_slugs_api(
            localities=localities,
            pages=pages,
            all_pages=args.all_pages,
        )[:limit]
    else:
        if args.all_pages:
            raise SystemExit("--all-pages only works with --locality (not --geo / Playwright).")
        slugs = ranking_slugs_playwright(geo=geo, localities=localities, pages=pages)[:limit]
    if args.all_pages:
        print(f"Found {len(slugs)} unique slugs (limit {limit}, fetched until API exhausted)")
    else:
        max_from_pages = pages * 25 * max(1, len(localities) or 1)
        print(f"Found {len(slugs)} unique slugs (limit {limit}, max ~{max_from_pages} from {pages} page(s) × 25)")
        if limit > max_from_pages:
            print(
                f"Note: --limit {limit} > {max_from_pages} from {pages} pages; "
                f"use --pages {-(limit // -25)} or --all-pages for full region (e.g. l=27 ≈ 688)."
            )

    climbs: list[dict[str, Any]] = []
    errors: list[str] = []
    seen_ids: set[str] = set()
    for slug in slugs:
        url = f"https://climbfinder.com/en/climbs/{slug}"
        try:
            page_html = fetch_html(url)
            climb = parse_climb_page(
                page_html,
                url,
                region_label=region_label,
                country=country,
                tags=tags,
            )
            if climb["id"] in seen_ids:
                continue
            seen_ids.add(climb["id"])
            climbs.append(climb)
            print(f"  OK {climb['name']} ({climb['stats']['length_m']} m)")
        except Exception as exc:
            errors.append(f"{slug}: {exc}")
            print(f"  SKIP {slug}: {exc}")

    source_meta: dict[str, Any] = {"name": "climbfinder", "sort": "popular"}
    if geo:
        source_meta["ranking_geo"] = geo
        source_meta["ranking_url"] = f"https://climbfinder.com/en/ranking?g={geo}&s=popular"
    if localities:
        labels = cfg.get("locality_labels") or {}
        source_meta["localities"] = [
            {"id": lid, "label": labels.get(str(lid), str(lid))} for lid in localities
        ]
        if len(localities) == 1:
            source_meta["locality_id"] = int(localities[0])

    payload = {
        "schema_version": "1.0",
        "meta": {
            "id": meta_id,
            "title": title,
            "region_label": region_label,
            "country": country,
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "count": len(climbs),
            "source": source_meta,
            "import_errors": errors,
        },
        "climbs": climbs,
    }

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Wrote {len(climbs)} climbs to {out_path}")
    if errors:
        print(f"{len(errors)} slugs skipped")


if __name__ == "__main__":
    main()
