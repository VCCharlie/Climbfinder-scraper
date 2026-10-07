#!/usr/bin/env python3
"""
Rebuild docs/climbs/data/index.json from climb bundle files in that folder.

Any *.json with schema_version + meta + climbs is listed for the map dropdown.
Run after uploading datasets (or let GitHub Actions do it on push).

  python scripts/rebuild_climb_index.py
"""

from __future__ import annotations

import json
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


def main() -> None:
    regions = []
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

    regions.sort(key=lambda r: (r.get("country", ""), r.get("displayTitle", r.get("title", ""))))
    total_climbs = sum(r.get("count") or 0 for r in regions)
    payload = {
        "schema_version": "1.0",
        "total_climbs": total_climbs,
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
