#!/usr/bin/env python3
"""
Merge multiple climb JSON bundles into one file (dedupe by climb id / Climbfinder slug).

  python scripts/merge_climb_bundles.py --into nl-limburg \\
    docs/climbs/data/nl-limburg.json docs/climbs/data/cf-l280-limburg.json

Then remove extra files from data/ and run: python scripts/rebuild_climb_index.py
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/climbs/data"


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def climb_dedupe_key(climb: dict) -> str | None:
    cid = climb.get("id")
    if cid:
        return str(cid)
    slug = (climb.get("climbfinder") or {}).get("slug")
    return str(slug) if slug else None


def merge_climb_lists(chunks: list[list[dict]]) -> list[dict]:
    by_key: dict[str, dict] = {}
    for climbs in chunks:
        for c in climbs:
            key = climb_dedupe_key(c)
            if key:
                by_key[key] = c
    return sorted(by_key.values(), key=lambda x: x.get("name", "").lower())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--into",
        required=True,
        help="Output dataset id / filename stem (e.g. nl-limburg → data/nl-limburg.json)",
    )
    parser.add_argument(
        "--title",
        default=None,
        help="meta.title for merged bundle (default: from first source or --into)",
    )
    parser.add_argument(
        "sources",
        nargs="+",
        help="One or more climb bundle JSON paths (order: later overwrites same id/slug)",
    )
    args = parser.parse_args()

    stem = args.into.strip().removesuffix(".json")
    dest = DATA / f"{stem}.json"

    sources: list[Path] = []
    for s in args.sources:
        p = Path(s)
        if not p.is_file():
            p = DATA / s
        if not p.is_file():
            raise SystemExit(f"Not found: {s}")
        sources.append(p)

    bundles = [load_json(p) for p in sources]
    merged_climbs = merge_climb_lists([b.get("climbs") or [] for b in bundles])

    meta = dict(bundles[0].get("meta") or {})
    meta["id"] = stem
    meta["title"] = args.title or meta.get("title") or f"Merged ({stem})"
    meta["count"] = len(merged_climbs)
    meta["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    src = meta.setdefault("source", {})
    if isinstance(src, dict):
        src["merged_from"] = [p.name for p in sources]

    payload = {
        "schema_version": bundles[0].get("schema_version", "1.0"),
        "meta": meta,
        "climbs": merged_climbs,
    }
    save_json(dest, payload)
    print(f"Merged {len(sources)} file(s) → {len(merged_climbs)} unique climbs → {dest.relative_to(ROOT)}")

    subprocess.check_call([sys.executable, str(ROOT / "scripts/rebuild_climb_index.py")])


if __name__ == "__main__":
    main()
