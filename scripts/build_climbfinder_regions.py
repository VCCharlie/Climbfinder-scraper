#!/usr/bin/env python3
"""
Build docs/climbs/data/climbfinder-regions.json by scanning Climbfinder locality IDs.

Uses ranking page #selectedlocation label + v2/climbs countryIso (not streamlit_app IDs).
"""

from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/climbs/data/climbfinder-regions.json"

API = "https://uphill.climbfinder.com/v2/climbs"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; FietsKlimDB/1.0)",
    "Accept": "application/json",
    "Referer": "https://climbfinder.com/",
    "Origin": "https://climbfinder.com",
}

SKIP_LABELS = {"Region/mountain range/location"}

ISO_COUNTRY = {
    "AD": "Andorra",
    "AT": "Austria",
    "BE": "Belgium",
    "CH": "Switzerland",
    "CO": "Colombia",
    "DE": "Germany",
    "DK": "Denmark",
    "ES": "Spain",
    "FR": "France",
    "GB": "United Kingdom",
    "HR": "Croatia",
    "IT": "Italy",
    "NL": "Netherlands",
    "NO": "Norway",
    "PT": "Portugal",
    "SI": "Slovenia",
    "US": "USA",
}


def api_country_iso(locality: int) -> str | None:
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
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode())
        rows = data.get("data") or []
        return rows[0].get("countryIso") if rows else None
    except Exception:
        return None


def scan_playwright_labels(max_id: int) -> dict[int, str]:
    from playwright.sync_api import sync_playwright

    labels: dict[int, str] = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        for lid in range(1, max_id + 1):
            try:
                page.goto(
                    f"https://climbfinder.com/en/ranking?l={lid}&s=popular&p=1",
                    wait_until="domcontentloaded",
                    timeout=45000,
                )
                page.wait_for_timeout(350)
                text = page.locator("#selectedlocation").inner_text(timeout=3000).strip()
                if not text or text in SKIP_LABELS:
                    continue
                labels[lid] = text
            except Exception:
                continue
            if lid % 100 == 0:
                print(f"  scanned l={lid}, found {len(labels)} labels…")
        browser.close()
    return labels


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--max-id", type=int, default=1000)
    args = parser.parse_args()

    print(f"Scanning Climbfinder locality labels 1…{args.max_id}…")
    labels = scan_playwright_labels(args.max_id)
    print(f"Found {len(labels)} locality labels")

    regions: list[dict] = []
    for lid, name in sorted(labels.items()):
        iso = api_country_iso(lid)
        if not iso:
            continue
        country = ISO_COUNTRY.get(iso, iso)
        regions.append(
            {
                "id": lid,
                "name": name,
                "label": f"{name} (l={lid})",
                "country_iso": iso,
                "country": country,
            }
        )
        time.sleep(0.12)

    by_country: dict[str, list] = defaultdict(list)
    for r in regions:
        by_country[r["country"]].append(
            {"id": r["id"], "name": r["name"], "label": r["label"], "country_iso": r["country_iso"]}
        )
    for c in by_country:
        by_country[c].sort(key=lambda x: x["name"].lower())

    countries = [{"country": c, "regions": by_country[c]} for c in sorted(by_country.keys())]

    payload = {
        "schema_version": "2.0",
        "source": "climbfinder_scan",
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "countries": countries,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Wrote {len(regions)} regions → {OUT}")


if __name__ == "__main__":
    main()
