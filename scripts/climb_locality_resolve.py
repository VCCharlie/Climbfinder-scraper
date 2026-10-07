"""Resolve Climbfinder slug → smallest meaningful locality (per country)."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/climbs/data"
RESOLUTION_FILE = DATA / "slug-smallest-locality.json"
REGIONS_FILE = DATA / "climbfinder-regions.json"

# Climbfinder mega-regions (not useful as climb home region)
MEGA_LOCALITY_IDS = {1, 25}  # World, Europe


@lru_cache(maxsize=1)
def _load_resolution_index() -> dict:
    if not RESOLUTION_FILE.is_file():
        return {}
    with RESOLUTION_FILE.open(encoding="utf-8") as f:
        data = json.load(f)
    return data.get("by_country") or {}


@lru_cache(maxsize=1)
def _country_level_ids() -> dict[str, set[int]]:
    """Locality ids that match whole-country regions (e.g. France l=44)."""
    out: dict[str, set[int]] = {}
    if not REGIONS_FILE.is_file():
        return out
    with REGIONS_FILE.open(encoding="utf-8") as f:
        catalog = json.load(f)
    for block in catalog.get("countries") or []:
        country_name = str(block.get("country") or "").strip()
        if not country_name:
            continue
        ids: set[int] = set()
        for r in block.get("regions") or []:
            if str(r.get("name") or "").strip().lower() == country_name.lower():
                ids.add(int(r["id"]))
        if ids:
            iso = str((block.get("regions") or [{}])[0].get("country_iso") or "").upper()
            if iso:
                out[iso] = ids
    return out


def resolve_smallest_locality(
    slug: str,
    country_iso: str,
    *,
    import_locality_id: int | None = None,
) -> dict | None:
    """
    Return {locality_id, region_name, popular_count} or None.
    import_locality_id: fallback label if slug not in index.
    """
    iso = str(country_iso or "").upper()
    by_slug = _load_resolution_index().get(iso) or {}
    hit = by_slug.get(slug)
    if hit:
        return hit
    if import_locality_id is None:
        return None
    return {
        "locality_id": int(import_locality_id),
        "region_name": None,
        "popular_count": None,
        "fallback": True,
    }


def clear_resolution_cache() -> None:
    _load_resolution_index.cache_clear()
    _country_level_ids.cache_clear()
