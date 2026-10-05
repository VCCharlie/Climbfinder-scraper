#!/usr/bin/env python3
"""Compare catalog locality IDs with Climbfinder API countryIso + page label."""

from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "docs/climbs/data/climbfinder-regions.json"

ISO = {
    "France": "FR",
    "Netherlands": "NL",
    "Andorra": "AD",
    "Belgium": "BE",
    "Germany": "DE",
    "Italy": "IT",
    "Spain": "ES",
    "Switzerland": "CH",
    "Austria": "AT",
    "United Kingdom": "GB",
    "Portugal": "PT",
    "Denmark": "DK",
}


def api_iso(locality: int) -> str | None:
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
    req = urllib.request.Request(
        f"https://uphill.climbfinder.com/v2/climbs?{q}",
        headers={
            "Origin": "https://climbfinder.com",
            "Referer": "https://climbfinder.com/",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.loads(r.read())
    rows = d.get("data") or []
    return rows[0].get("countryIso") if rows else None


def main() -> None:
    data = json.loads(CATALOG.read_text())
    bad = []
    for block in data.get("countries", []):
        country = block["country"]
        expect = ISO.get(country)
        for r in block.get("regions", []):
            lid = int(r["id"])
            got = api_iso(lid)
            if got and expect and got != expect:
                bad.append((country, r["name"], lid, expect, got))
    for row in bad:
        print(f"MISMATCH {row[0]}/{row[1]} l={row[2]} expected={row[3]} api={row[4]}")
    print(f"\n{len(bad)} mismatches")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
