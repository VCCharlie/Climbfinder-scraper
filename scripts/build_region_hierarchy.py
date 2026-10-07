#!/usr/bin/env python3
"""
Build region-hierarchy.json (macro klimgebieden + nested localities) and
slug-smallest-locality.json for import-time region assignment.

  python scripts/build_region_hierarchy.py
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/climbs/data"
CATALOG = DATA / "climbfinder-regions.json"
SLUG_INDEX = DATA / "climb-slug-search-index.json"
POPULAR = DATA / "climbfinder-region-popular-counts.json"
OUT_HIER = DATA / "region-hierarchy.json"
OUT_SLUG = DATA / "slug-smallest-locality.json"
OUT_DISPLAY = DATA / "slug-display-region.json"

TARGET_ISO = ("NL", "BE", "FR", "DE", "IT", "ES", "CH", "AT")
MEGA_LOCALITY_IDS = {1, 25}

# Macro klimgebieden = Climbfinder locality ids (roots in UI)
MACRO_LOCALITY_BY_ISO: dict[str, list[dict]] = {
    "NL": [
        {"locality_id": 26, "name_nl": "Nederland (heel)"},
        {"locality_id": 27, "name_nl": "Zuid-Limburg"},
    ],
    "BE": [
        {"locality_id": 370, "name_nl": "Vlaanderen"},
        {"locality_id": 371, "name_nl": "Wallonië"},
        {"locality_id": 133, "name_nl": "Hoge Venen & Oostkantons"},
        {"locality_id": 304, "name_nl": "Luik (provincie)"},
        {"locality_id": 315, "name_nl": "Luxemburg (BE)"},
    ],
    "FR": [
        {"locality_id": 36, "name_nl": "Alpen"},
        {"locality_id": 53, "name_nl": "Pyrenéeën"},
        {"locality_id": 61, "name_nl": "Massif Central (Auvergne)"},
        {"locality_id": 145, "name_nl": "Cévennes"},
        {"locality_id": 422, "name_nl": "Ardennen (FR)"},
        {"locality_id": 446, "name_nl": "Bretagne"},
        {"locality_id": 80, "name_nl": "Corsica"},
        {"locality_id": 450, "name_nl": "Île-de-France"},
        {"locality_id": 350, "name_nl": "Armoricaans Massief"},
    ],
    "DE": [
        {"locality_id": 348, "name_nl": "Beierse Alpen"},
        {"locality_id": 341, "name_nl": "Allgäu"},
        {"locality_id": 342, "name_nl": "Ammergau"},
        {"locality_id": 347, "name_nl": "Berchtesgaden"},
        {"locality_id": 106, "name_nl": "Eifel"},
        {"locality_id": 245, "name_nl": "Harz"},
        {"locality_id": 257, "name_nl": "Sauerland"},
        {"locality_id": 74, "name_nl": "Zwart Woud"},
    ],
    "IT": [
        {"locality_id": 59, "name_nl": "Italiaanse Alpen"},
        {"locality_id": 60, "name_nl": "Dolomieten"},
        {"locality_id": 166, "name_nl": "Apennijnen"},
    ],
    "ES": [
        {"locality_id": 83, "name_nl": "Pyrenéeën (ES)"},
        {"locality_id": 212, "name_nl": "Sierra Nevada"},
    ],
    "CH": [
        {"locality_id": 56, "name_nl": "Zwitserse Alpen"},
        {"locality_id": 143, "name_nl": "Liechtenstein Alpen"},
    ],
    "AT": [
        {"locality_id": 87, "name_nl": "Oostenrijkse Alpen"},
        {"locality_id": 305, "name_nl": "Karinthië"},
        {"locality_id": 306, "name_nl": "Salzburg"},
    ],
}


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def catalog_by_iso() -> dict[str, dict]:
    catalog = load_json(CATALOG)
    out: dict[str, dict] = {}
    for block in catalog.get("countries") or []:
        regions = block.get("regions") or []
        if not regions:
            continue
        iso = str(regions[0].get("country_iso") or "").upper()
        if not iso:
            continue
        by_id = {int(r["id"]): r for r in regions if r.get("id") is not None}
        out[iso] = {
            "country": block.get("country"),
            "country_iso": iso,
            "by_id": by_id,
        }
    return out


def popular_counts() -> dict[int, int]:
    if not POPULAR.is_file():
        return {}
    data = load_json(POPULAR)
    raw = data.get("by_locality") or {}
    return {int(k): int(v.get("popular_count") or 0) for k, v in raw.items()}


def build_slug_sets_by_locality(entries: list[dict]) -> dict[int, set[str]]:
    loc_slugs: dict[int, set[str]] = defaultdict(set)
    for e in entries:
        lid = e.get("locality_id")
        slug = e.get("slug")
        if lid is None or not slug:
            continue
        loc_slugs[int(lid)].add(str(slug))
    return loc_slugs


def immediate_parent(
    loc_id: int,
    slug_sets: dict[int, set[str]],
    popular: dict[int, int],
    country_ids: set[int],
) -> int | None:
    own = slug_sets.get(loc_id)
    if not own:
        return None
    best: tuple[int, int] | None = None
    parent_id: int | None = None
    for pid in country_ids:
        if pid == loc_id:
            continue
        ps = slug_sets.get(pid)
        if not ps or not own.issubset(ps) or len(ps) <= len(own):
            continue
        score = (len(ps), popular.get(pid, 10**9))
        if best is None or score < best:
            best = score
            parent_id = pid
    return parent_id


def macro_for_locality_by_slug_overlap(
    loc_id: int,
    macro_ids: set[int],
    slug_sets: dict[int, set[str]],
    *,
    min_overlap: int = 3,
) -> int | None:
    own = slug_sets.get(loc_id)
    if not own:
        return None
    best_mid: int | None = None
    best_score: tuple[int, int] | None = None
    for mid in macro_ids:
        if mid == loc_id:
            continue
        inter = own & slug_sets.get(mid, set())
        n = len(inter)
        if n < min_overlap:
            continue
        score = (n, -len(slug_sets.get(mid, set())))
        if best_score is None or score > best_score:
            best_score = score
            best_mid = mid
    return best_mid


def build_smallest_locality_map(
    entries: list[dict],
    catalog: dict[str, dict],
    popular: dict[int, int],
) -> dict[str, dict[str, dict]]:
    by_country: dict[str, dict[str, dict]] = defaultdict(dict)
    country_level: dict[str, set[int]] = {}
    for iso, block in catalog.items():
        if iso not in TARGET_ISO:
            continue
        names = {str(block["country"]).lower()}
        country_level[iso] = {
            lid
            for lid, r in block["by_id"].items()
            if str(r.get("name") or "").lower() in names
        }

    slug_to_locs: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for e in entries:
        iso = str(e.get("country_iso") or "").upper()
        if iso not in TARGET_ISO:
            continue
        slug = e.get("slug")
        if not slug:
            continue
        lid = e.get("locality_id")
        if lid is None:
            continue
        slug_to_locs[(iso, str(slug))].append(e)

    for (iso, slug), rows in slug_to_locs.items():
        candidates: list[tuple[int, int, str]] = []
        for row in rows:
            lid = int(row["locality_id"])
            if lid in MEGA_LOCALITY_IDS or lid in country_level.get(iso, set()):
                continue
            pc = popular.get(lid, 10**9)
            name = str(row.get("region_name") or catalog[iso]["by_id"].get(lid, {}).get("name") or lid)
            candidates.append((pc, lid, name))
        if not candidates:
            continue
        candidates.sort(key=lambda x: (x[0], x[1]))
        pc, lid, name = candidates[0]
        by_country[iso][slug] = {
            "locality_id": lid,
            "region_name": name,
            "popular_count": pc,
        }
    return by_country


def build_display_region_map(
    entries: list[dict],
    catalog: dict[str, dict],
    popular: dict[int, int],
) -> dict[str, dict[str, dict]]:
    """
    Coarsest sub-national region per slug (max Popular count among non-country localities).
    Used for climb.region (policy B).
    """
    by_country: dict[str, dict[str, dict]] = defaultdict(dict)
    country_level: dict[str, set[int]] = {}
    for iso, block in catalog.items():
        if iso not in TARGET_ISO:
            continue
        names = {str(block["country"]).lower()}
        country_level[iso] = {
            lid
            for lid, r in block["by_id"].items()
            if str(r.get("name") or "").lower() in names
        }

    slug_to_locs: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for e in entries:
        iso = str(e.get("country_iso") or "").upper()
        if iso not in TARGET_ISO:
            continue
        slug = e.get("slug")
        if not slug:
            continue
        lid = e.get("locality_id")
        if lid is None:
            continue
        slug_to_locs[(iso, str(slug))].append(e)

    for (iso, slug), rows in slug_to_locs.items():
        candidates: list[tuple[int, int, str]] = []
        for row in rows:
            lid = int(row["locality_id"])
            if lid in MEGA_LOCALITY_IDS or lid in country_level.get(iso, set()):
                continue
            pc = popular.get(lid, 0)
            name = str(row.get("region_name") or catalog[iso]["by_id"].get(lid, {}).get("name") or lid)
            candidates.append((pc, lid, name))
        if not candidates:
            continue
        candidates.sort(key=lambda x: (-x[0], x[1]))
        pc, lid, name = candidates[0]
        by_country[iso][slug] = {
            "display_locality_id": lid,
            "display_name": name,
            "popular_count": pc,
            "source": "largest_subcountry",
        }
    return by_country


def main() -> None:
    catalog = catalog_by_iso()
    popular = popular_counts()
    slug_index = load_json(SLUG_INDEX)
    entries = slug_index.get("entries") or []
    slug_sets = build_slug_sets_by_locality(entries)

    parents: dict[int, int | None] = {}
    for iso in TARGET_ISO:
        block = catalog.get(iso)
        if not block:
            continue
        ids = set(block["by_id"].keys())
        for lid in ids:
            parents[lid] = immediate_parent(lid, slug_sets, popular, ids)

    by_country_slug = build_smallest_locality_map(entries, catalog, popular)
    by_country_display = build_display_region_map(entries, catalog, popular)
    ts = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    display_payload = {
        "schema_version": "1.0",
        "updated_at": ts,
        "note": "Weergave-regio per slug: grootste sub-land-locality (max Popular), excl. land/World/Europe.",
        "by_country": by_country_display,
    }
    with OUT_DISPLAY.open("w", encoding="utf-8") as f:
        json.dump(display_payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote display region map → {OUT_DISPLAY.relative_to(ROOT)}")

    slug_payload = {
        "schema_version": "1.0",
        "updated_at": ts,
        "note": "Kleinste Climbfinder-locality per slug (laagste Popular-telling, excl. World/Europe/land).",
        "by_country": by_country_slug,
    }
    with OUT_SLUG.open("w", encoding="utf-8") as f:
        json.dump(slug_payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote slug resolution → {OUT_SLUG.relative_to(ROOT)}")

    countries_out = []
    for iso in TARGET_ISO:
        block = catalog.get(iso)
        if not block:
            continue
        macro_defs = {m["locality_id"]: m for m in MACRO_LOCALITY_BY_ISO.get(iso, [])}
        macro_ids = set(macro_defs.keys())
        groups: dict[int, dict] = {
            mid: {
                "locality_id": mid,
                "name": block["by_id"].get(mid, {}).get("name") or macro_defs[mid]["name_nl"],
                "name_nl": macro_defs[mid]["name_nl"],
                "popular_count": popular.get(mid),
                "localities": [],
            }
            for mid in macro_ids
            if mid in block["by_id"]
        }
        ungrouped: list[dict] = []

        for lid, reg in sorted(block["by_id"].items(), key=lambda x: str(x[1].get("name", "")).lower()):
            if lid in macro_ids:
                continue
            macro = macro_for_locality_by_slug_overlap(lid, macro_ids, slug_sets)
            row = {
                "locality_id": lid,
                "name": reg.get("name"),
                "label": reg.get("label"),
                "popular_count": popular.get(lid),
                "parent_locality_id": parents.get(lid),
                "macro_locality_id": macro,
            }
            if macro and macro in groups:
                groups[macro]["localities"].append(row)
            else:
                ungrouped.append(row)

        for g in groups.values():
            g["localities"].sort(
                key=lambda x: (x.get("popular_count") is None, -(x.get("popular_count") or 0), x.get("name") or "")
            )

        countries_out.append(
            {
                "country_iso": iso,
                "country": block["country"],
                "groups": sorted(groups.values(), key=lambda g: g["name_nl"].lower()),
                "ungrouped": ungrouped,
            }
        )

    hier_payload = {
        "schema_version": "1.0",
        "updated_at": ts,
        "countries": countries_out,
    }
    with OUT_HIER.open("w", encoding="utf-8") as f:
        json.dump(hier_payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote region hierarchy → {OUT_HIER.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
