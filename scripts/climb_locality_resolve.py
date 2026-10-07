"""Resolve Climbfinder slug → display region (macro / sub-country) + smallest locality id."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/climbs/data"
SMALLEST_FILE = DATA / "slug-smallest-locality.json"
DISPLAY_FILE = DATA / "slug-display-region.json"
REGIONS_FILE = DATA / "climbfinder-regions.json"
HIERARCHY_FILE = DATA / "region-hierarchy.json"

MEGA_LOCALITY_IDS = {1, 25}
OVERIG_LABEL = "Overig"


@lru_cache(maxsize=1)
def _load_smallest_index() -> dict:
    if not SMALLEST_FILE.is_file():
        return {}
    with SMALLEST_FILE.open(encoding="utf-8") as f:
        return (json.load(f).get("by_country") or {})


@lru_cache(maxsize=1)
def _load_display_index() -> dict:
    if not DISPLAY_FILE.is_file():
        return {}
    with DISPLAY_FILE.open(encoding="utf-8") as f:
        return (json.load(f).get("by_country") or {})


@lru_cache(maxsize=1)
def _catalog_by_iso() -> dict[str, dict[int, dict]]:
    out: dict[str, dict[int, dict]] = {}
    if not REGIONS_FILE.is_file():
        return out
    with REGIONS_FILE.open(encoding="utf-8") as f:
        catalog = json.load(f)
    for block in catalog.get("countries") or []:
        regions = block.get("regions") or []
        if not regions:
            continue
        iso = str(regions[0].get("country_iso") or "").upper()
        if not iso:
            continue
        out[iso] = {int(r["id"]): r for r in regions if r.get("id") is not None}
    return out


@lru_cache(maxsize=1)
def _country_level_ids() -> dict[str, set[int]]:
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
        iso = ""
        for r in block.get("regions") or []:
            if not iso:
                iso = str(r.get("country_iso") or "").upper()
            if str(r.get("name") or "").strip().lower() == country_name.lower():
                ids.add(int(r["id"]))
        if ids and iso:
            out[iso] = ids
    return out


@lru_cache(maxsize=1)
def _macro_group_names() -> dict[tuple[str, int], str]:
    """(iso, macro_locality_id) → name_nl for UI macro groups."""
    out: dict[tuple[str, int], str] = {}
    if not HIERARCHY_FILE.is_file():
        return out
    with HIERARCHY_FILE.open(encoding="utf-8") as f:
        hier = json.load(f)
    for block in hier.get("countries") or []:
        iso = str(block.get("country_iso") or "").upper()
        for group in block.get("groups") or []:
            mid = group.get("locality_id")
            if mid is None:
                continue
            out[(iso, int(mid))] = str(group.get("name_nl") or group.get("name") or mid)
    return out


def _locality_name(iso: str, locality_id: int) -> str | None:
    reg = _catalog_by_iso().get(iso, {}).get(int(locality_id))
    if not reg:
        return None
    return str(reg.get("name") or "").strip() or None


def _is_country_level(iso: str, locality_id: int | None) -> bool:
    if locality_id is None:
        return False
    return int(locality_id) in _country_level_ids().get(iso, set())


def resolve_smallest_locality(
    slug: str,
    country_iso: str,
    *,
    import_locality_id: int | None = None,
) -> dict | None:
    """Smallest non-country locality (dedupe / geo). {locality_id, region_name, popular_count}."""
    iso = str(country_iso or "").upper()
    hit = (_load_smallest_index().get(iso) or {}).get(slug)
    if hit:
        return dict(hit)
    if import_locality_id is None:
        return None
    name = _locality_name(iso, int(import_locality_id))
    return {
        "locality_id": int(import_locality_id),
        "region_name": name,
        "popular_count": None,
        "fallback": True,
    }


def resolve_climb_labels(
    slug: str,
    country_iso: str,
    *,
    import_locality_id: int | None = None,
    import_region_label: str | None = None,
) -> dict | None:
    """
    Policy B: `region` = coarse sub-country / macro / CF name / Overig;
    `resolved_locality_id` = smallest meaningful locality.
    """
    iso = str(country_iso or "").upper()
    smallest = resolve_smallest_locality(slug, iso, import_locality_id=import_locality_id)
    display_hit = (_load_display_index().get(iso) or {}).get(slug)

    resolved_id: int | None = None
    if smallest and smallest.get("locality_id") is not None and not _is_country_level(iso, smallest["locality_id"]):
        resolved_id = int(smallest["locality_id"])
    elif smallest and smallest.get("locality_id") is not None and not smallest.get("fallback"):
        resolved_id = int(smallest["locality_id"])

    display_name: str | None = None
    display_id: int | None = None
    source = "unknown"

    if display_hit:
        display_name = str(display_hit.get("display_name") or "").strip() or None
        if display_hit.get("display_locality_id") is not None:
            display_id = int(display_hit["display_locality_id"])
        source = str(display_hit.get("source") or "display_index")

    if not display_name and smallest and smallest.get("region_name"):
        sid = smallest.get("locality_id")
        if sid is not None and not _is_country_level(iso, sid):
            display_name = str(smallest["region_name"])
            display_id = int(sid)
            source = "smallest"

    if not display_name and import_locality_id is not None and not _is_country_level(iso, import_locality_id):
        display_name = _locality_name(iso, import_locality_id) or import_region_label
        display_id = int(import_locality_id)
        source = "import_locality"

    if not display_name and import_region_label:
        label = str(import_region_label).strip()
        country_names = {str(_catalog_by_iso().get(iso, {}).get(lid, {}).get("name") or "").lower()
                         for lid in _country_level_ids().get(iso, set())}
        if label and label.lower() not in country_names and label.lower() not in ("netherlands", "france", "belgium"):
            display_name = label
            source = "import_label"

    if not display_name:
        display_name = OVERIG_LABEL
        source = "overig"

    if display_id is None and resolved_id is not None:
        display_id = resolved_id

    return {
        "region_name": display_name,
        "display_locality_id": display_id,
        "resolved_locality_id": resolved_id,
        "source": source,
        "smallest": smallest,
    }


def clear_resolution_cache() -> None:
    _load_smallest_index.cache_clear()
    _load_display_index.cache_clear()
    _catalog_by_iso.cache_clear()
    _country_level_ids.cache_clear()
    _macro_group_names.cache_clear()
