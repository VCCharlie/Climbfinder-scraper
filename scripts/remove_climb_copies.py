#!/usr/bin/env python3
"""
Remove selected climb rows from region bundle JSON files (dedupe cleanup).

  python scripts/remove_climb_copies.py --removals-json '[{"dataset_id":"cf-l289-is-re","climb_id":"alpe-d-huez"}]'
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


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: dict) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def climb_matches_removal(climb: dict, climb_id: str | None, slug: str | None) -> bool:
    if climb_id and str(climb.get("id")) == str(climb_id):
        return True
    if slug:
        cs = (climb.get("climbfinder") or {}).get("slug")
        if cs and str(cs) == str(slug):
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--removals-json", default=None, help="JSON array inline")
    parser.add_argument("--removals-file", default=None, help="Path to JSON array file")
    args = parser.parse_args()

    raw = None
    if args.removals_file:
        raw = Path(args.removals_file).read_text(encoding="utf-8")
    elif args.removals_json:
        raw = args.removals_json
    else:
        print("Provide --removals-json or --removals-file", file=sys.stderr)
        return 1

    try:
        removals = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON: {e}", file=sys.stderr)
        return 1
    if not isinstance(removals, list) or not removals:
        print("removals-json must be a non-empty JSON array", file=sys.stderr)
        return 1

    by_dataset: dict[str, list[dict]] = defaultdict(list)
    for i, row in enumerate(removals):
        if not isinstance(row, dict):
            print(f"Row {i} is not an object", file=sys.stderr)
            return 1
        ds = str(row.get("dataset_id") or "").strip()
        if not ds:
            print(f"Row {i}: dataset_id required", file=sys.stderr)
            return 1
        if not row.get("climb_id") and not row.get("slug"):
            print(f"Row {i}: climb_id or slug required", file=sys.stderr)
            return 1
        by_dataset[ds].append(row)

    total_removed = 0
    for dataset_id, specs in by_dataset.items():
        path = DATA / f"{dataset_id}.json"
        if not path.is_file():
            print(f"Missing bundle: {path.relative_to(ROOT)}", file=sys.stderr)
            return 1
        bundle = load_json(path)
        climbs = list(bundle.get("climbs") or [])
        before = len(climbs)
        kept = []
        for c in climbs:
            drop = False
            for spec in specs:
                if climb_matches_removal(
                    c,
                    spec.get("climb_id"),
                    spec.get("slug"),
                ):
                    drop = True
                    break
            if not drop:
                kept.append(c)
        removed = before - len(kept)
        if removed <= 0:
            print(f"  {dataset_id}: no matching climbs removed")
            continue
        meta = dict(bundle.get("meta") or {})
        meta["count"] = len(kept)
        meta["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        bundle["meta"] = meta
        bundle["climbs"] = kept
        save_json(path, bundle)
        total_removed += removed
        print(f"  {dataset_id}: removed {removed} climb(s) → {len(kept)} left")

    if total_removed <= 0:
        print("Nothing removed.", file=sys.stderr)
        return 1

    print(f"Total removed: {total_removed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
