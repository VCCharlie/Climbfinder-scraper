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
}


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
        regions.append(
            {
                "id": meta_id,
                "title": meta["title"],
                "country": meta.get("country") or "XX",
                "url": f"data/{path.name}",
                "count": len(climbs),
            }
        )

    regions.sort(key=lambda r: (r.get("country", ""), r.get("title", "")))
    payload = {"schema_version": "1.0", "regions": regions}
    INDEX.parent.mkdir(parents=True, exist_ok=True)
    with INDEX.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote {len(regions)} region(s) → {INDEX.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
