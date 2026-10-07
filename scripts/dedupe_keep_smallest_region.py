#!/usr/bin/env python3
"""
Remove duplicate climb slugs across region bundles; keep one copy per slug in the
smallest region file (fewest climbs in bundle). Tie-break: dataset_id ascending.

  python scripts/dedupe_keep_smallest_region.py
  python scripts/dedupe_keep_smallest_region.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/climbs/data"

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


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: dict) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def climb_slug(climb: dict) -> str | None:
    slug = (climb.get("climbfinder") or {}).get("slug")
    if slug:
        return str(slug)
    cid = climb.get("id")
    return str(cid) if cid else None


def is_climb_bundle(path: Path) -> bool:
    if path.name in SKIP_NAMES or path.suffix.lower() != ".json":
        return False
    try:
        data = load_json(path)
    except (json.JSONDecodeError, OSError):
        return False
    return isinstance(data.get("climbs"), list) and isinstance(data.get("meta"), dict)


def pick_keep_copy(copies: list[dict]) -> dict:
    return min(copies, key=lambda c: (c["region_count"], c["dataset_id"], c["climb_id"]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Print stats only, do not write files")
    args = parser.parse_args()

    slug_copies: dict[str, list[dict]] = defaultdict(list)
    bundle_paths: dict[str, Path] = {}

    for path in sorted(DATA.glob("*.json")):
        if not is_climb_bundle(path):
            continue
        data = load_json(path)
        meta = data["meta"]
        meta_id = str(meta.get("id") or path.stem)
        bundle_paths[meta_id] = path
        region_count = len(data.get("climbs") or [])
        for c in data["climbs"]:
            s = climb_slug(c)
            if not s:
                continue
            slug_copies[s].append(
                {
                    "dataset_id": meta_id,
                    "climb_id": str(c.get("id") or ""),
                    "region_count": region_count,
                }
            )

    remove_ids_by_dataset: dict[str, set[str]] = defaultdict(set)
    groups = 0
    for slug, copies in slug_copies.items():
        if len(copies) < 2:
            continue
        groups += 1
        keep = pick_keep_copy(copies)
        for c in copies:
            if c["dataset_id"] == keep["dataset_id"] and c["climb_id"] == keep["climb_id"]:
                continue
            remove_ids_by_dataset[c["dataset_id"]].add(c["climb_id"])

    total_remove = sum(len(v) for v in remove_ids_by_dataset.values())
    print(f"Duplicate slug groups: {groups}")
    print(f"Climb rows to remove: {total_remove}")
    if total_remove <= 0:
        print("Nothing to do.")
        return 0

    if args.dry_run:
        return 0

    changed = 0
    for dataset_id, ids in remove_ids_by_dataset.items():
        path = bundle_paths.get(dataset_id)
        if not path:
            continue
        bundle = load_json(path)
        before = len(bundle.get("climbs") or [])
        kept = [c for c in bundle["climbs"] if str(c.get("id") or "") not in ids]
        removed = before - len(kept)
        if removed <= 0:
            continue
        meta = dict(bundle.get("meta") or {})
        meta["count"] = len(kept)
        meta["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        bundle["meta"] = meta
        bundle["climbs"] = kept
        save_json(path, bundle)
        changed += 1
        print(f"  {dataset_id}: -{removed} → {len(kept)} climbs")

    print(f"Updated {changed} bundle file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
