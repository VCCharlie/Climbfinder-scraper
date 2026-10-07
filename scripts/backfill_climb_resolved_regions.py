#!/usr/bin/env python3
"""
Update region (display), display_locality_id + resolved_locality_id on published climbs.

Uses slug-display-region.json + slug-smallest-locality.json (build_region_hierarchy.py).

  python scripts/backfill_climb_resolved_regions.py
  python scripts/backfill_climb_resolved_regions.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/climbs/data"

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from climb_locality_resolve import clear_resolution_cache, resolve_climb_labels  # noqa: E402
from rebuild_climb_index import is_climb_bundle  # noqa: E402


def climb_slug(climb: dict) -> str | None:
    slug = (climb.get("climbfinder") or {}).get("slug")
    if slug:
        return str(slug)
    cid = climb.get("id")
    return str(cid) if cid else None


def apply_climb_resolution(
    climb: dict,
    country_iso: str,
    import_locality_id: int | None,
    import_region_label: str | None,
) -> bool:
    slug = climb_slug(climb)
    if not slug:
        return False
    labels = resolve_climb_labels(
        slug,
        country_iso,
        import_locality_id=import_locality_id,
        import_region_label=import_region_label,
    )
    if not labels or not labels.get("region_name"):
        return False
    changed = False
    new_region = str(labels["region_name"])
    if climb.get("region") != new_region:
        climb["region"] = new_region
        changed = True
    rid = labels.get("resolved_locality_id")
    if rid is not None:
        if climb.get("resolved_locality_id") != rid:
            climb["resolved_locality_id"] = rid
            changed = True
        cf = climb.setdefault("climbfinder", {})
        if isinstance(cf, dict) and cf.get("resolved_locality_id") != rid:
            cf["resolved_locality_id"] = rid
            changed = True
    did = labels.get("display_locality_id")
    if did is not None:
        if climb.get("display_locality_id") != did:
            climb["display_locality_id"] = did
            changed = True
    return changed


def import_locality_from_meta(meta: dict) -> int | None:
    src = meta.get("source") if isinstance(meta.get("source"), dict) else {}
    if src.get("locality_id") is not None:
        try:
            return int(src["locality_id"])
        except (TypeError, ValueError):
            pass
    meta_id = str(meta.get("id") or "")
    import re

    m = re.match(r"^cf-l(\d+)-", meta_id)
    if m:
        return int(m.group(1))
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    clear_resolution_cache()
    for name in ("slug-smallest-locality.json", "slug-display-region.json"):
        if not (DATA / name).is_file():
            print(f"Missing {name} — run build_region_hierarchy.py first.", file=sys.stderr)
            return 1

    total_climbs = 0
    total_updated = 0
    files_touched = 0

    for path in sorted(DATA.glob("*.json")):
        if not is_climb_bundle(path):
            continue
        with path.open(encoding="utf-8") as f:
            bundle = json.load(f)
        meta = bundle.get("meta") or {}
        country = str(meta.get("country") or "XX").upper()
        import_loc = import_locality_from_meta(meta)
        import_label = str(meta.get("region_label") or meta.get("title") or "")
        file_updates = 0
        for climb in bundle.get("climbs") or []:
            total_climbs += 1
            if apply_climb_resolution(climb, country, import_loc, import_label):
                file_updates += 1
                total_updated += 1
        if file_updates <= 0:
            continue
        files_touched += 1
        print(f"  {path.name}: {file_updates} climb(s) updated")
        if not args.dry_run:
            meta = dict(meta)
            meta["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            notes = meta.setdefault("maintenance", {})
            if isinstance(notes, dict):
                notes["macro_region_labels_backfill"] = meta["updated_at"]
            bundle["meta"] = meta
            with path.open("w", encoding="utf-8") as f:
                json.dump(bundle, f, ensure_ascii=False, indent=2)
                f.write("\n")

    print(f"Climbs scanned: {total_climbs}, updated: {total_updated}, files: {files_touched}")
    if args.dry_run:
        print("(dry-run — no files written)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
