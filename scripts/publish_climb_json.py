#!/usr/bin/env python3
"""
Copy an import bundle into docs/climbs/data/ and update data/index.json for the map UI.

  python scripts/publish_climb_json.py --bundle out/cf-l277-south-holland.json
  python scripts/publish_climb_json.py --bundle out/new.json --merge-into nl-popular
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/climbs/data"
DEFAULT_INDEX = DATA / "index.json"


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _climb_dedupe_key(climb: dict) -> str | None:
    cid = climb.get("id")
    if cid:
        return str(cid)
    slug = (climb.get("climbfinder") or {}).get("slug")
    return str(slug) if slug else None


def merge_climbs(existing: list[dict], incoming: list[dict]) -> list[dict]:
    by_key: dict[str, dict] = {}
    for c in existing + incoming:
        key = _climb_dedupe_key(c)
        if key:
            by_key[key] = c
    return sorted(by_key.values(), key=lambda x: x.get("name", "").lower())


def update_index(index_path: Path, *, meta_id: str, title: str, country: str, count: int, filename: str) -> None:
    index = load_json(index_path) if index_path.is_file() else {"schema_version": "1.0", "regions": []}
    regions = index.setdefault("regions", [])
    entry = {
        "id": meta_id,
        "title": title,
        "country": country,
        "url": f"data/{filename}",
        "count": count,
    }
    for i, r in enumerate(regions):
        if r.get("id") == meta_id:
            regions[i] = entry
            break
    else:
        regions.append(entry)
    regions.sort(key=lambda r: (r.get("country", ""), r.get("title", "")))
    save_json(index_path, index)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True, help="Imported JSON (schema 1.0 bundle)")
    parser.add_argument("--index", default=str(DEFAULT_INDEX))
    parser.add_argument(
        "--merge-into",
        default=None,
        help="If set, append climbs into data/{name}.json instead of meta.id filename",
    )
    args = parser.parse_args()

    bundle_path = Path(args.bundle)
    bundle = load_json(bundle_path)
    meta = bundle.get("meta") or {}
    meta_id = meta.get("id") or bundle_path.stem
    title = meta.get("title") or meta_id
    country = meta.get("country") or "XX"
    incoming = bundle.get("climbs") or []

    if args.merge_into:
        file_stem = args.merge_into.strip().removesuffix(".json")
        dest = DATA / f"{file_stem}.json"
        if dest.is_file():
            combined = load_json(dest)
            climbs = merge_climbs(combined.get("climbs") or [], incoming)
            meta_out = dict(combined.get("meta") or meta)
            meta_out["id"] = file_stem
            meta_out["title"] = meta_out.get("title") or title
            meta_out["count"] = len(climbs)
            meta_out["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            sources = meta_out.setdefault("source", {})
            if isinstance(sources, dict):
                merged_from = sources.setdefault("merged_imports", [])
                if meta_id not in merged_from:
                    merged_from.append(meta_id)
            payload = {
                "schema_version": bundle.get("schema_version", "1.0"),
                "meta": meta_out,
                "climbs": climbs,
            }
        else:
            meta = dict(meta)
            meta["id"] = file_stem
            meta["count"] = len(incoming)
            payload = {
                "schema_version": bundle.get("schema_version", "1.0"),
                "meta": meta,
                "climbs": incoming,
            }
        save_json(dest, payload)
        publish_id = file_stem
        publish_title = payload["meta"]["title"]
        publish_count = len(payload["climbs"])
        filename = f"{file_stem}.json"
    else:
        dest = DATA / f"{meta_id}.json"
        save_json(dest, bundle)
        publish_id = meta_id
        publish_title = title
        publish_count = len(incoming)
        filename = f"{meta_id}.json"

    print(f"Published {publish_count} climbs → {dest.relative_to(ROOT)}")
    import subprocess
    import sys

    subprocess.check_call([sys.executable, str(ROOT / "scripts/rebuild_climb_index.py")])


if __name__ == "__main__":
    main()
