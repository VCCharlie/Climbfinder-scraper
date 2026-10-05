#!/usr/bin/env python3
"""
Fetch Climbfinder Popular ranking slugs (pages 1–2) via uphill v2/climbs API.

Writes docs/climbs/data/rankings/{locality_id}-popular-slugs.json

  python scripts/refresh_ranking_slugs.py --locality 290
  python scripts/refresh_ranking_slugs.py --all
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
OUT_DIR = ROOT / "docs/climbs/data/rankings"

API = "https://uphill.climbfinder.com/v2/climbs"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; FietsKlimDB/1.0)",
    "Accept": "application/json",
    "Referer": "https://climbfinder.com/",
    "Origin": "https://climbfinder.com",
}


def fetch_page(*, locality: int, offset: int, limit: int = 25, sort: str = "popular") -> list[str]:
    q = urllib.parse.urlencode(
        {
            "language": "en",
            "offset": offset,
            "limit": limit,
            "sort": sort,
            "locality": locality,
            "radius": 25,
        }
    )
    req = urllib.request.Request(f"{API}?{q}", headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    if "error" in data:
        raise RuntimeError(data["error"])
    rows = data.get("data") or []
    return [r["slug"] for r in rows if r.get("slug")]


def slugs_for_locality(locality: int, pages: int = 2, per_page: int = 25) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for page in range(pages):
        offset = page * per_page
        for slug in fetch_page(locality=locality, offset=offset, limit=per_page):
            if slug not in seen:
                seen.add(slug)
                out.append(slug)
        time.sleep(0.25)
    return out


def load_all_localities() -> list[tuple[int, str, str]]:
    with REGIONS_FILE.open(encoding="utf-8") as f:
        catalog = json.load(f)
    items: list[tuple[int, str, str]] = []
    for block in catalog.get("countries", []):
        country = block["country"]
        for r in block.get("regions", []):
            items.append((int(r["id"]), r["name"], country))
    return items


def write_locality_file(
    locality: int,
    name: str,
    country: str,
    slugs: list[str],
    *,
    pages: int,
    sort: str,
) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{locality}-popular-slugs.json"
    payload = {
        "schema_version": "1.0",
        "locality_id": locality,
        "name": name,
        "country": country,
        "sort": sort,
        "pages": pages,
        "ranking_url": f"https://climbfinder.com/en/ranking?l={locality}&s={sort}&p=1",
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(slugs),
        "slugs": slugs,
    }
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--locality", type=int, action="append", default=[], help="Locality id (l=)")
    parser.add_argument("--all", action="store_true", help="Refresh every region in climbfinder-regions.json")
    parser.add_argument("--pages", type=int, default=2)
    parser.add_argument("--sort", default="popular")
    args = parser.parse_args()

    if not REGIONS_FILE.is_file():
        raise SystemExit(f"Missing {REGIONS_FILE} — run scripts/export_climbfinder_regions.py first")

    meta_by_id: dict[int, tuple[str, str]] = {}
    for lid, name, country in load_all_localities():
        meta_by_id[lid] = (name, country)

    ids = args.locality
    if args.all:
        ids = sorted(meta_by_id.keys())
    if not ids:
        raise SystemExit("Specify --locality ID or --all")

    for locality in ids:
        name, country = meta_by_id.get(locality, (str(locality), "?"))
        print(f"Locality {locality} ({name}, {country})…")
        try:
            slugs = slugs_for_locality(locality, pages=args.pages)
        except (urllib.error.URLError, RuntimeError) as exc:
            print(f"  SKIP: {exc}")
            continue
        path = write_locality_file(
            locality, name, country, slugs, pages=args.pages, sort=args.sort
        )
        print(f"  → {len(slugs)} slugs → {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
