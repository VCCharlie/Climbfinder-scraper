#!/usr/bin/env python3
"""
Build docs/climbs/data/climbfinder-regions-geo.json — lat/lon per Climbfinder locality.

Uses (in order of preference):
  1. Climbfinder uphill API — centroid of Popular climb markers (best for map)
  2. Nominatim (optional, rate-limited)
  3. Deterministic spiral around country centre (placeholder only)

  python scripts/enrich_region_centroids.py --climbfinder --all --merge
  python scripts/enrich_region_centroids.py --geocode --countries Netherlands,Belgium
  python scripts/enrich_region_centroids.py
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
CLIMBFINDER_API = "https://uphill.climbfinder.com/v2/climbs"
CLIMBFINDER_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json",
    "Referer": "https://climbfinder.com/",
    "Origin": "https://climbfinder.com",
}

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


def climbfinder_popular_centroid(locality_id: int, *, limit: int = 25) -> dict | None:
    """Mean lat/lon of climb finish markers on Popular page 1 for this locality."""
    q = urllib.parse.urlencode(
        {
            "language": "en",
            "offset": 0,
            "limit": limit,
            "sort": "popular",
            "locality": locality_id,
            "radius": 25,
        }
    )
    req = urllib.request.Request(f"{CLIMBFINDER_API}?{q}", headers=CLIMBFINDER_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None
    if data.get("error"):
        return None
    lats: list[float] = []
    lons: list[float] = []
    for row in data.get("data") or []:
        marker = row.get("marker") or {}
        coords = marker.get("coordinates")
        if not coords or len(coords) < 2:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            lons.append(lon)
            lats.append(lat)
    if not lats:
        return None
    return {
        "lat": round(sum(lats) / len(lats), 6),
        "lon": round(sum(lons) / len(lons), 6),
        "sample_count": len(lats),
    }


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
        "--climbfinder",
        action="store_true",
        help="Centroid from Climbfinder Popular climb markers (uphill API)",
    )
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
    parser.add_argument(
        "--sleep",
        type=float,
        default=1.15,
        help="Seconds between API/Nominatim calls (use ~0.22 for --climbfinder)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Refresh even if entry already has climbfinder/nominatim coords",
    )
    parser.add_argument("--merge", action="store_true", help="Merge into existing geo file (keep prior hits)")
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
    cf_hits = 0
    refresh_sources = {"nominatim", "climbfinder_popular_centroid"}

    for item in items:
        rid = str(item["id"])
        prev = regions_out.get(rid)
        if (
            prev
            and prev.get("source") in refresh_sources
            and not args.force
            and not args.geocode
            and not args.climbfinder
        ):
            continue
        if (
            prev
            and prev.get("source") in refresh_sources
            and not args.force
            and args.climbfinder
            and prev.get("source") == "climbfinder_popular_centroid"
        ):
            continue

        iso = item["country_iso"]
        lat, lon = fallback_lat_lon(iso, item["index_in_country"], item["total_in_country"], item["id"])
        entry: dict = dict(prev) if prev else {}
        entry.update(
            {
                "lat": lat,
                "lon": lon,
                "source": "fallback",
                "country_iso": iso,
                "name": item["name"],
                "country": item["country"],
            }
        )
        for drop in ("display_name", "boundingbox", "geocode_query", "sample_count"):
            entry.pop(drop, None)

        in_scope = args.all or not country_filter or item["country"] in country_filter
        do_cf = args.climbfinder and in_scope
        do_geo = args.geocode and in_scope

        if do_cf:
            hit = climbfinder_popular_centroid(item["id"])
            time.sleep(args.sleep)
            if hit:
                entry["lat"] = hit["lat"]
                entry["lon"] = hit["lon"]
                entry["source"] = "climbfinder_popular_centroid"
                entry["sample_count"] = hit["sample_count"]
                cf_hits += 1
            else:
                entry["climbfinder_note"] = "no markers on Popular page 1"

        elif do_geo:
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
    print(
        f"Wrote {OUT_FILE} ({len(regions_out)} regions, "
        f"{cf_hits} climbfinder centroids, {geocoded} nominatim hits this run)"
    )


if __name__ == "__main__":
    main()
