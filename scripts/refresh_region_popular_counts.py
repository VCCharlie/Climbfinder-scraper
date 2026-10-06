#!/usr/bin/env python3
"""
Fetch Climbfinder Popular ranking totals (filteredCount) per locality via uphill v2/climbs.

Writes docs/climbs/data/climbfinder-region-popular-counts.json

  python scripts/refresh_region_popular_counts.py
  python scripts/refresh_region_popular_counts.py --locality 96
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGIONS_FILE = ROOT / "docs/climbs/data/climbfinder-regions.json"
OUT = ROOT / "docs/climbs/data/climbfinder-region-popular-counts.json"

API = "https://uphill.climbfinder.com/v2/climbs"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; FietsKlimDB/1.0)",
    "Accept": "application/json",
    "Referer": "https://climbfinder.com/",
    "Origin": "https://climbfinder.com",
}


def popular_count_for_locality(locality: int) -> int | None:
    q = urllib.parse.urlencode(
        {
            "language": "en",
            "offset": 0,
            "limit": 1,
            "sort": "popular",
            "locality": locality,
            "radius": 25,
        }
    )
    req = urllib.request.Request(f"{API}?{q}", headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    if data.get("error"):
        return None
    meta_wrap = data.get("meta") or {}
    inner = meta_wrap.get("meta") if isinstance(meta_wrap.get("meta"), dict) else meta_wrap
    if not isinstance(inner, dict):
        return None
    for key in ("filteredCount", "total"):
        val = inner.get(key)
        if isinstance(val, int) and val >= 0:
            return val
    return None


def all_locality_ids() -> list[int]:
    catalog = json.loads(REGIONS_FILE.read_text(encoding="utf-8"))
    ids: list[int] = []
    for block in catalog.get("countries", []):
        for r in block.get("regions", []):
            ids.append(int(r["id"]))
    return sorted(set(ids))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--locality", type=int, action="append", help="Only refresh these l= IDs")
    parser.add_argument("--delay", type=float, default=0.18, help="Seconds between API calls")
    args = parser.parse_args()

    existing: dict[str, dict] = {}
    if OUT.is_file():
        try:
            existing = json.loads(OUT.read_text(encoding="utf-8")).get("by_locality") or {}
        except json.JSONDecodeError:
            existing = {}

    ids = args.locality if args.locality else all_locality_ids()
    by_locality: dict[str, dict] = dict(existing)
    failed: list[int] = []

    for i, lid in enumerate(ids, 1):
        try:
            count = popular_count_for_locality(lid)
            if count is None:
                failed.append(lid)
            else:
                by_locality[str(lid)] = {"popular_count": count}
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            failed.append(lid)
        if i % 50 == 0:
            print(f"  … {i}/{len(ids)}")
        time.sleep(args.delay)

    payload = {
        "schema_version": "1.0",
        "sort": "popular",
        "source": "uphill.climbfinder.com/v2/climbs meta.filteredCount",
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "by_locality": by_locality,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT} ({len(by_locality)} localities, {len(failed)} failed this run)")


if __name__ == "__main__":
    main()
