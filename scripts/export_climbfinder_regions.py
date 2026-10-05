#!/usr/bin/env python3
"""
DEPRECATED: streamlit IDs often mismatch Climbfinder (e.g. Andorra 180 → Denmark).

Use: python scripts/build_climbfinder_regions.py
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STREAMLIT = ROOT / "streamlit_app.py"
OUT = ROOT / "docs/climbs/data/climbfinder-regions.json"


def load_regions_by_country() -> dict:
    text = STREAMLIT.read_text(encoding="utf-8")
    start = text.index("REGIONS_BY_COUNTRY = {")
    end = text.index("\nALL_REGIONS = []", start)
    chunk = text[start + len("REGIONS_BY_COUNTRY = ") : end].strip()
    return ast.literal_eval(chunk)


def main() -> None:
    regions_by_country = load_regions_by_country()
    countries = []
    for country, regions in sorted(regions_by_country.items()):
        countries.append(
            {
                "country": country,
                "regions": [
                    {"id": r["id"], "name": r["name"], "label": f"{r['name']}, {country}"}
                    for r in regions
                ],
            }
        )
    payload = {
        "schema_version": "1.0",
        "source": "climbfinder_locality_ids",
        "countries": countries,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    n = sum(len(c["regions"]) for c in countries)
    print(f"Wrote {n} regions in {len(countries)} countries → {OUT}")


if __name__ == "__main__":
    main()
