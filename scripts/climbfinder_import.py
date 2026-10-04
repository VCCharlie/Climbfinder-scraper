#!/usr/bin/env python3
"""
Import climbs from Climbfinder into docs/climbs/data/*.json

Uses:
  - Ranking (Playwright): geo filter g=LONIlAT (+25 km), same as the website
  - Climb page HTML: embedded climbgeojson + encoded elevation profile (cfDecode)

Usage:
  python scripts/climbfinder_import.py
  python scripts/climbfinder_import.py --pages 2 --limit 30
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import re
import urllib.request
from datetime import datetime, timezone
from typing import Any

USER_AGENT = "Mozilla/5.0 (compatible; FietsKlimDB/1.0)"


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


def fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_climb_page(html: str, url: str) -> dict[str, Any]:
    m_id = re.search(r"climbId\s*=\s*(\d+)", html)
    m_slug = re.search(r'/en/climbs/([a-z0-9-]+)', url)
    climb_id = int(m_id.group(1)) if m_id else None
    slug = m_slug.group(1) if m_slug else None

    geo_start = html.find("const climbgeojson")
    geo_end = html.find("const finishgeojson", geo_start)
    geo_chunk = html[geo_start:geo_end] if geo_start >= 0 and geo_end > geo_start else html
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
        html,
        re.DOTALL,
    )
    if not m_data:
        raise ValueError("No DATA block with profile encoding")
    name, category, sd, _graph_interval, _grad_enc, path_interval, elev_enc, length_m = m_data.groups()
    sd_i = int(sd)
    path_interval_i = int(path_interval)
    length_i = int(length_m)
    elevations = cf_decode(elev_enc, 10, sd_i)
    n = len(elevations)
    distances_m = [min(i * path_interval_i, length_i) for i in range(n)]

    coords = geometry["coordinates"]
    gain = sum(max(0.0, elevations[i] - elevations[i - 1]) for i in range(1, n))
    loss = sum(max(0.0, elevations[i - 1] - elevations[i]) for i in range(1, n))
    avg_grad = (100.0 * gain / length_i) if length_i else 0.0
    gradients = []
    for i in range(1, n):
        d = distances_m[i] - distances_m[i - 1]
        if d > 0:
            gradients.append(100.0 * (elevations[i] - elevations[i - 1]) / d)

    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]

    slug_id = slug or re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")

    return {
        "id": slug_id,
        "name": name,
        "region": "Zuid-Limburg",
        "country": "NL",
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
        },
        "difficulty_score": float(category) if category else None,
        "geometry": {"type": "LineString", "coordinates": coords},
        "profile": {
            "distances_m": distances_m,
            "elevations_m": [round(e, 1) for e in elevations],
            "path_interval_m": path_interval_i,
        },
        "bbox": [min(lons), min(lats), max(lons), max(lats)],
        "start": {"lng": coords[0][0], "lat": coords[0][1]},
        "summit": {"lng": coords[-1][0], "lat": coords[-1][1]},
        "tags": ["climbfinder", "zuid-limburg"],
        "sources": [
            {
                "name": "climbfinder",
                "url": f"https://climbfinder.com/en/climbs/{slug}",
                "note": "Route geometry + elevation profile from climb page",
            }
        ],
    }


def ranking_slugs_playwright(geo: str, pages: int) -> list[str]:
    from playwright.sync_api import sync_playwright

    slugs: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        for page_num in range(1, pages + 1):
            url = f"https://climbfinder.com/en/ranking?g={geo}&p={page_num}&s=popular"
            page.goto(url, wait_until="networkidle", timeout=120000)
            page.wait_for_timeout(1500)
            hrefs = page.eval_on_selector_all(
                "a.ranking-item-link",
                "els => els.map(e => e.getAttribute('href')).filter(Boolean)",
            )
            for href in hrefs:
                m = re.search(r"/climbs/([a-z0-9-]+)", href)
                if m:
                    slugs.append(m.group(1))
        browser.close()
    # preserve order, unique
    seen = set()
    out = []
    for s in slugs:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--geo",
        default="5.83I50.86",
        help="Climbfinder g= param (lonIlat), default Valkenburg area +25km",
    )
    parser.add_argument("--pages", type=int, default=2, help="Ranking pages (25 climbs each)")
    parser.add_argument("--limit", type=int, default=40, help="Max climbs to import")
    parser.add_argument(
        "--out",
        default="docs/climbs/data/nl-limburg.json",
    )
    args = parser.parse_args()

    print(f"Fetching ranking slugs (g={args.geo}, pages={args.pages})…")
    slugs = ranking_slugs_playwright(args.geo, args.pages)[: args.limit]
    print(f"Found {len(slugs)} unique slugs")

    climbs: list[dict[str, Any]] = []
    errors: list[str] = []
    for slug in slugs:
        url = f"https://climbfinder.com/en/climbs/{slug}"
        try:
            html = fetch_html(url)
            climb = parse_climb_page(html, url)
            climbs.append(climb)
            print(f"  OK {climb['name']} ({climb['stats']['length_m']} m)")
        except Exception as exc:
            errors.append(f"{slug}: {exc}")
            print(f"  SKIP {slug}: {exc}")

    payload = {
        "schema_version": "1.0",
        "meta": {
            "id": "nl-limburg",
            "title": "Zuid-Limburg beklimmingen (Climbfinder)",
            "country": "NL",
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "count": len(climbs),
            "source": {
                "name": "climbfinder",
                "ranking_geo": args.geo,
                "ranking_url": f"https://climbfinder.com/en/ranking?g={args.geo}&s=popular",
            },
            "import_errors": errors,
        },
        "climbs": climbs,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Wrote {len(climbs)} climbs to {args.out}")
    if errors:
        print(f"{len(errors)} slugs skipped")


if __name__ == "__main__":
    main()
