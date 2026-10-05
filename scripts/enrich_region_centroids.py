#!/usr/bin/env python3
"""
Build docs/climbs/data/climbfinder-regions-geo.json — lat/lon per Climbfinder locality.

Uses Nominatim (optional, rate-limited) with a deterministic country-centre fallback
so the import map always has markers.

  python scripts/enrich_region_centroids.py
  python scripts/enrich_region_centroids.py --geocode --countries Netherlands,Belgium
  python scripts/enrich_region_centroids.py --geocode --all
"""

from __future__ import annotations

import argparse
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGIONS_FILE = ROOT / "docs/climbs/data/climbfinder-regions.json"
OUT_FILE = ROOT / "docs/climbs/data/climbfinder-regions-geo.json"

USER_AGENT = "FietsKlimDB/1.0 (github.com/VCCharlie/Climbfinder-scraper)"

# Approximate map centres (lat, lon, default zoom when filtering country)
COUNTRY_CENTRE: dict[str, tuple[float, float, int]] = {
    "NL": (52.15, 5.35, 8),
    "BE": (50.55, 4.75, 8),
    "FR": (46.6, 2.4, 6),
    "DE": (51.1, 10.4, 6),
    "IT": (42.8, 12.5, 6),
    "ES": (40.2, -3.5, 6),
    "CH": (46.8, 8.2, 8),
    "AT": (47.6, 14.1, 7),
    "GB": (54.0, -2.5, 6),
    "PT": (39.5, -8.0, 7),
    "AD": (42.55, 1.58, 10),
    "SI": (46.1, 14.8, 8),
    "HR": (45.1, 15.2, 7),
    "NO": (61.0, 8.0, 5),
    "US": (39.0, -98.0, 4),
    "CO": (4.5, -74.0, 6),
    "DK": (56.0, 10.0, 7),
    "AL": (41.15, 20.15, 8),
    "AU": (-25.0, 133.0, 4),
}


def iso_for_region(region: dict, country_block: str) -> str:
    if region.get("country_iso"):
        return str(region["country_iso"]).upper()
    name_map = {
        "Netherlands": "NL",
        "Belgium": "BE",
        "France": "FR",
        "Germany": "DE",
        "Italy": "IT",
        "Spain": "ES",
        "Switzerland": "CH",
        "Austria": "AT",
        "United Kingdom": "GB",
        "Portugal": "PT",
        "Andorra": "AD",
        "Slovenia": "SI",
        "Croatia": "HR",
        "Norway": "NO",
        "USA": "US",
        "Colombia": "CO",
        "Denmark": "DK",
        "Albania": "AL",
        "Australia": "AU",
    }
    return name_map.get(country_block, "XX")


def spiral_offset(index: int, total: int, region_id: int) -> tuple[float, float]:
    """Degrees offset from country centre (small enough to stay in country at zoom 8)."""
    if total <= 1:
        return 0.0, 0.0
    golden = math.pi * (3 - math.sqrt(5))
    t = index + (region_id % 13) * 0.07
    angle = t * golden
    radius = 0.35 + 0.55 * math.sqrt((index + 1) / total)
    return radius * math.cos(angle), radius * math.sin(angle)


def fallback_lat_lon(iso: str, index: int, total: int, region_id: int) -> tuple[float, float]:
    base = COUNTRY_CENTRE.get(iso, (20.0, 0.0, 4))
    lat0, lon0 = base[0], base[1]
    dlat, dlon = spiral_offset(index, total, region_id)
    # Longitude degrees shrink with cos(lat)
    scale_lon = max(0.4, math.cos(math.radians(lat0)))
    return round(lat0 + dlat, 6), round(lon0 + dlon * scale_lon, 6)


def nominatim_search(query: str) -> dict | None:
    q = urllib.parse.urlencode({"q": query, "format": "json", "limit": "1"})
    req = urllib.request.Request(
        f"https://nominatim.openstreetmap.org/search?{q}",
        headers={"User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            rows = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None
    if not rows:
        return None
    row = rows[0]
    bbox = row.get("boundingbox")
    return {
        "lat": float(row["lat"]),
        "lon": float(row["lon"]),
        "display_name": row.get("display_name"),
        "boundingbox": bbox,
    }


def load_catalog() -> list[dict]:
    with REGIONS_FILE.open(encoding="utf-8") as f:
        catalog = json.load(f)
    items: list[dict] = []
    for block in catalog.get("countries", []):
        country = block["country"]
        regions = block.get("regions", [])
        for i, r in enumerate(regions):
            iso = iso_for_region(r, country)
            items.append(
                {
                    "id": int(r["id"]),
                    "name": r["name"],
                    "country": country,
                    "country_iso": iso,
                    "index_in_country": i,
                    "total_in_country": len(regions),
                }
            )
    return items


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--geocode",
        action="store_true",
        help="Query Nominatim for each region (slow; respect --sleep)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="With --geocode, geocode every region in catalog",
    )
    parser.add_argument(
        "--countries",
        default="",
        help="Comma-separated country names (catalog block names), e.g. Netherlands,Belgium",
    )
    parser.add_argument("--sleep", type=float, default=1.15, help="Seconds between Nominatim calls")
    parser.add_argument("--merge", action="store_true", help="Merge into existing geo file (keep prior nominatim hits)")
    args = parser.parse_args()

    items = load_catalog()
    existing: dict[str, dict] = {}
    if args.merge and OUT_FILE.is_file():
        with OUT_FILE.open(encoding="utf-8") as f:
            prev = json.load(f)
        existing = prev.get("regions") or {}

    country_filter = {c.strip() for c in args.countries.split(",") if c.strip()}
    regions_out: dict[str, dict] = dict(existing)
    geocoded = 0

    for item in items:
        rid = str(item["id"])
        if rid in regions_out and regions_out[rid].get("source") == "nominatim" and not args.geocode:
            continue

        iso = item["country_iso"]
        lat, lon = fallback_lat_lon(iso, item["index_in_country"], item["total_in_country"], item["id"])
        entry: dict = {
            "lat": lat,
            "lon": lon,
            "source": "fallback",
            "country_iso": iso,
            "name": item["name"],
            "country": item["country"],
        }

        do_geo = args.geocode and (args.all or not country_filter or item["country"] in country_filter)
        if do_geo:
            query = f"{item['name']}, {item['country']}"
            hit = nominatim_search(query)
            time.sleep(args.sleep)
            if hit:
                entry["lat"] = hit["lat"]
                entry["lon"] = hit["lon"]
                entry["source"] = "nominatim"
                if hit.get("display_name"):
                    entry["display_name"] = hit["display_name"]
                if hit.get("boundingbox"):
                    entry["boundingbox"] = hit["boundingbox"]
                geocoded += 1
            else:
                entry["geocode_query"] = query

        regions_out[rid] = entry

    countries_out = {
        iso: {"lat": c[0], "lon": c[1], "zoom": c[2]}
        for iso, c in COUNTRY_CENTRE.items()
    }

    payload = {
        "schema_version": "1.0",
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "enrich_region_centroids.py",
        "countries": countries_out,
        "regions": regions_out,
    }
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OUT_FILE.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote {OUT_FILE} ({len(regions_out)} regions, {geocoded} new nominatim hits this run)")


if __name__ == "__main__":
    main()
