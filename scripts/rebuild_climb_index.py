#!/usr/bin/env python3
"""
Rebuild docs/climbs/data/index.json from climb bundle files in that folder.

Any *.json with schema_version + meta + climbs is listed for the map dropdown.
Run after uploading datasets (or let GitHub Actions do it on push).

  python scripts/rebuild_climb_index.py
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/climbs/data"
INDEX = DATA / "index.json"

SKIP_NAMES = {
    "index.json",
    "schema.json",
    "climbfinder-regions.json",
    "climbfinder-regions-geo.json",
    "climbfinder-region-popular-counts.json",
    "climb-slug-search-index.json",
    "published-locality-overlaps.json",
    "published-duplicate-climbs.json",
}


def locality_id_from_meta(meta: dict) -> int | None:
    src = meta.get("source") if isinstance(meta.get("source"), dict) else {}
    if src.get("locality_id") is not None:
        try:
            return int(src["locality_id"])
        except (TypeError, ValueError):
            pass
    meta_id = str(meta.get("id") or "")
    m = __import__("re").match(r"^cf-l(\d+)-", meta_id)
    if m:
        return int(m.group(1))
    if meta_id == "nl-limburg":
        return 27
    return None


def display_title(meta: dict) -> str:
    raw = (meta.get("region_label") or meta.get("title") or "").strip()
    import re

    t = re.sub(r"\s*\(Climbfinder Popular[^)]*\)\s*$", "", raw, flags=re.I)
    t = re.sub(r"\s*—\s*Climbfinder Popular[^)]*$", "", t, flags=re.I)
    t = re.sub(r"\s*-\s*Climbfinder Popular.*$", "", t, flags=re.I)
    t = re.sub(r"\s*\(Climbfinder\)\s*$", "", t, flags=re.I)
    return t.strip() or raw


def is_climb_bundle(path: Path) -> bool:
    if path.name in SKIP_NAMES:
        return False
    if not path.is_file() or path.suffix.lower() != ".json":
        return False
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return False
    if not isinstance(data.get("climbs"), list):
        return False
    meta = data.get("meta")
    if not isinstance(meta, dict):
        return False
    if not meta.get("id") or not meta.get("title"):
        return False
    return True


def climb_slug(climb: dict) -> str | None:
    slug = (climb.get("climbfinder") or {}).get("slug")
    if slug:
        return str(slug)
    cid = climb.get("id")
    return str(cid) if cid else None


def load_region_name_index() -> dict[int, str]:
    catalog = DATA / "climbfinder-regions.json"
    names: dict[int, str] = {}
    if not catalog.is_file():
        return names
    with catalog.open(encoding="utf-8") as f:
        data = json.load(f)
    for block in data.get("countries") or []:
        for r in block.get("regions") or []:
            rid = r.get("id")
            if rid is not None:
                names[int(rid)] = str(r.get("name") or r.get("label") or rid)
    return names


def write_locality_overlaps(
    loc_slugs: dict[int, set[str]], region_names: dict[int, str]
) -> None:
    out_path = DATA / "published-locality-overlaps.json"
    by_locality: dict[str, list[dict]] = {}
    loc_ids = sorted(loc_slugs.keys())
    for loc_a in loc_ids:
        slugs_a = loc_slugs[loc_a]
        if not slugs_a:
            continue
        overlaps: list[dict] = []
        for loc_b in loc_ids:
            if loc_b == loc_a:
                continue
            shared = len(slugs_a & loc_slugs[loc_b])
            if shared <= 0:
                continue
            overlaps.append(
                {
                    "locality_id": loc_b,
                    "name": region_names.get(loc_b, f"l={loc_b}"),
                    "shared_climbs": shared,
                    "pct_of_this": round(100.0 * shared / len(slugs_a), 1),
                }
            )
        overlaps.sort(key=lambda x: (-x["shared_climbs"], x["name"]))
        by_locality[str(loc_a)] = overlaps[:8]
    payload = {
        "schema_version": "1.0",
        "updated_at": __import__("datetime")
        .datetime.now(__import__("datetime").timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "by_locality": by_locality,
    }
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote locality overlaps → {out_path.relative_to(ROOT)}")


def write_duplicate_climbs_report(slug_copies: dict[str, list[dict]]) -> None:
    out_path = DATA / "published-duplicate-climbs.json"
    groups = []
    for slug, copies in slug_copies.items():
        if len(copies) < 2:
            continue
        copies_sorted = sorted(
            copies,
            key=lambda c: (c.get("region_count") or 0, c.get("dataset_id") or ""),
        )
        groups.append(
            {
                "slug": slug,
                "name": copies_sorted[0].get("name") or slug,
                "copies": [
                    {
                        "dataset_id": c["dataset_id"],
                        "title": c["title"],
                        "locality_id": c.get("locality_id"),
                        "climb_id": c.get("climb_id"),
                        "region_count": c.get("region_count"),
                    }
                    for c in copies_sorted
                ],
            }
        )
    groups.sort(key=lambda g: g["name"].lower())
    extra_rows = sum(len(g["copies"]) - 1 for g in groups)
    payload = {
        "schema_version": "1.0",
        "updated_at": __import__("datetime")
        .datetime.now(__import__("datetime").timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "duplicate_groups": len(groups),
        "extra_rows": extra_rows,
        "groups": groups,
    }
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote duplicate report ({len(groups)} groups) → {out_path.relative_to(ROOT)}")


def main() -> None:
    regions = []
    loc_slugs: dict[int, set[str]] = {}
    global_slugs: set[str] = set()
    slug_copies: dict[str, list[dict]] = defaultdict(list)
    for path in sorted(DATA.glob("*.json")):
        if not is_climb_bundle(path):
            continue
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
        meta = data["meta"]
        climbs = data["climbs"]
        meta_id = meta["id"]
        if path.stem != meta_id:
            print(f"  warn: {path.name} meta.id={meta_id!r} (filename mismatch)")
        entry = {
            "id": meta_id,
            "title": meta["title"],
            "displayTitle": display_title(meta),
            "country": meta.get("country") or "XX",
            "url": f"data/{path.name}",
            "count": len(climbs),
        }
        loc = locality_id_from_meta(meta)
        if loc is not None:
            entry["locality_id"] = loc
        regions.append(entry)
        region_count = len(climbs)
        disp = display_title(meta)
        if loc is not None:
            bucket = loc_slugs.setdefault(loc, set())
        for c in climbs:
            s = climb_slug(c)
            if not s:
                continue
            global_slugs.add(s)
            if loc is not None:
                bucket.add(s)
            slug_copies[s].append(
                {
                    "dataset_id": meta_id,
                    "title": disp,
                    "locality_id": loc,
                    "climb_id": c.get("id"),
                    "name": c.get("name") or s,
                    "region_count": region_count,
                }
            )

    regions.sort(key=lambda r: (r.get("country", ""), r.get("displayTitle", r.get("title", ""))))
    total_climbs = sum(r.get("count") or 0 for r in regions)
    unique_climbs = len(global_slugs)
    duplicate_rows = total_climbs - unique_climbs
    write_locality_overlaps(loc_slugs, load_region_name_index())
    write_duplicate_climbs_report(slug_copies)
    payload = {
        "schema_version": "1.0",
        "total_climbs": total_climbs,
        "unique_climbs": unique_climbs,
        "duplicate_rows_across_regions": max(0, duplicate_rows),
        "region_count": len(regions),
        "regions": regions,
    }
    INDEX.parent.mkdir(parents=True, exist_ok=True)
    with INDEX.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote {len(regions)} region(s) → {INDEX.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
