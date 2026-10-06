#!/usr/bin/env python3
"""
Build climb name/slug → Climbfinder region index from local Popular ranking caches.

Output: docs/climbs/data/climb-slug-search-index.json
Refresh ranking caches first for broader coverage:
  python scripts/refresh_ranking_slugs.py --all
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RANKINGS = ROOT / "docs/climbs/data/rankings"
OUT = ROOT / "docs/climbs/data/climb-slug-search-index.json"
BUNDLES_DIR = ROOT / "docs/climbs/data"


def humanize_slug(slug: str) -> str:
    s = slug.replace("-", " ").strip()
    return s[:1].upper() + s[1:] if s else slug


def main() -> None:
    entries: list[dict] = []
    seen: set[tuple[str, int]] = set()

    for path in sorted(RANKINGS.glob("*-popular-slugs.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        loc = int(data.get("locality_id") or path.stem.split("-")[0])
        region_name = data.get("name") or f"l={loc}"
        country = data.get("country") or "?"
        country_iso = data.get("country_iso")
        for slug in data.get("slugs") or []:
            if not slug:
                continue
            key = (slug, loc)
            if key in seen:
                continue
            seen.add(key)
            entries.append(
                {
                    "slug": slug,
                    "locality_id": loc,
                    "region_name": region_name,
                    "country": country,
                    "country_iso": country_iso,
                    "label": humanize_slug(slug),
                }
            )

    # Names from already-imported site bundles (better labels)
    for path in BUNDLES_DIR.glob("*.json"):
        if path.name in ("index.json", "climbfinder-regions.json", "climbfinder-regions-geo.json"):
            continue
        if "search-index" in path.name or "popular-counts" in path.name:
            continue
        try:
            bundle = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        meta = bundle.get("meta") or {}
        src = meta.get("source") or {}
        loc = src.get("locality_id")
        if loc is None:
            m = re.match(r"^cf-l(\d+)-", meta.get("id") or path.stem)
            if m:
                loc = int(m.group(1))
        if loc is None:
            continue
        country = meta.get("country") or "?"
        region_name = meta.get("region_label") or meta.get("title") or path.stem
        for climb in bundle.get("climbs") or []:
            slug = climb.get("slug") or climb.get("id")
            name = climb.get("name") or humanize_slug(slug or "")
            if not slug:
                continue
            key = (slug, int(loc))
            if key in seen:
                continue
            seen.add(key)
            entries.append(
                {
                    "slug": slug,
                    "locality_id": int(loc),
                    "region_name": region_name,
                    "country": country,
                    "country_iso": None,
                    "label": name,
                }
            )

    entries.sort(key=lambda e: (e["label"].lower(), e["locality_id"], e["slug"]))

    payload = {
        "schema_version": "1.0",
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "docs/climbs/data/rankings/*-popular-slugs.json + imported climb bundles",
        "note": "Zoekt in Popular-ranking cache (typisch 50 slugs/regio). Volledige Climbfinder niet gegarandeerd.",
        "count": len(entries),
        "entries": entries,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT} ({len(entries)} entries)")


if __name__ == "__main__":
    main()
