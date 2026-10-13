#!/usr/bin/env python3
"""Build import queue for a Klimgebieden macro group (non-● localities only)."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/climbs/data"
HIERARCHY = DATA / "region-hierarchy.json"
INDEX = DATA / "index.json"
REGIONS = DATA / "climbfinder-regions.json"

GLOBAL_SKIP = {1, 25}
EXTRA_SKIP_BY_MACRO: dict[int, set[int]] = {
    36: {44},  # France whole under Alpen UI — not a sub-import
}


def meta_id_from_region(rid: int, name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return f"cf-l{rid}-{slug}"


def load_published_by_locality(index: dict) -> dict[int, dict]:
    pub: dict[int, dict] = {}
    for entry in index.get("regions") or []:
        eid = entry.get("id") or ""
        m = re.match(r"cf-l(\d+)-", eid)
        loc = int(m.group(1)) if m else (27 if eid == "nl-limburg" else None)
        if loc is None:
            continue
        count = int(entry.get("count") or 0)
        prev = pub.get(loc)
        if not prev or count >= prev["count"]:
            pub[loc] = {"count": count, "id": eid}
    return pub


def find_group(hierarchy: dict, macro_id: int, country_iso: str | None) -> tuple[dict, dict]:
    matches: list[tuple[dict, dict]] = []
    for block in hierarchy.get("countries") or []:
        if country_iso and block.get("country_iso") != country_iso.upper():
            continue
        for group in block.get("groups") or []:
            if int(group.get("locality_id") or 0) == macro_id:
                matches.append((block, group))
    if not matches:
        raise SystemExit(f"Geen klimgebied-groep met macro l={macro_id}" + (f" in {country_iso}" if country_iso else ""))
    if len(matches) > 1 and not country_iso:
        iso_list = ", ".join(b["country_iso"] for b, _ in matches)
        raise SystemExit(f"Macro l={macro_id} komt meerdere keren voor ({iso_list}) — geef --country-iso")
    return matches[0]


def status_key(published: int, popular: int | None) -> str:
    if published <= 0:
        return "none"
    if popular and popular > 0 and published >= popular:
        return "full"
    return "partial"


def plan_macro_import(
    macro_id: int,
    *,
    country_iso: str | None = None,
    include_full: bool = False,
    extra_skip: set[int] | None = None,
) -> list[dict]:
    hierarchy = json.loads(HIERARCHY.read_text(encoding="utf-8"))
    index = json.loads(INDEX.read_text(encoding="utf-8")) if INDEX.is_file() else {"regions": []}
    catalog = json.loads(REGIONS.read_text(encoding="utf-8")) if REGIONS.is_file() else {"countries": []}

    by_id: dict[int, dict] = {}
    for block in catalog.get("countries") or []:
        for r in block.get("regions") or []:
            if r.get("id") is not None:
                by_id[int(r["id"])] = r

    block, group = find_group(hierarchy, macro_id, country_iso)
    iso = block["country_iso"]
    pub = load_published_by_locality(index)

    try:
        from climb_locality_resolve import country_level_locality_ids
    except ImportError:
        country_level_locality_ids = None  # type: ignore[assignment,misc]

    skip = set(GLOBAL_SKIP) | {macro_id} | EXTRA_SKIP_BY_MACRO.get(macro_id, set())
    if country_level_locality_ids:
        skip |= country_level_locality_ids(iso)
    if extra_skip:
        skip |= {int(x) for x in extra_skip}
    rows: list[dict] = []
    seen: set[int] = set()

    for loc in group.get("localities") or []:
        lid = int(loc["locality_id"])
        if lid in skip or lid in seen:
            continue
        seen.add(lid)
        pop = int(loc.get("popular_count") or 0)
        site = pub.get(lid, {}).get("count", 0)
        st = status_key(site, pop if pop > 0 else None)
        if st == "full" and not include_full:
            continue
        cat = by_id.get(lid, {})
        cc = str(cat.get("country_iso") or iso).upper()
        name = str(loc.get("name") or cat.get("name") or f"l={lid}")
        meta_id = pub.get(lid, {}).get("id") or meta_id_from_region(lid, name)
        limit = max(pop + 50, 100) if pop else 500
        rows.append(
            {
                "status": st,
                "locality": lid,
                "name": name,
                "popular": pop,
                "site": site,
                "meta_id": meta_id,
                "country": cc,
                "limit": limit,
            }
        )

    rows.sort(key=lambda r: (r["popular"], r["locality"]))
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Plan macro klimgebied batch import")
    parser.add_argument("--macro", type=int, required=True, help="Macro locality id (group.locality_id)")
    parser.add_argument("--country-iso", default="", help="Disambiguate if needed (e.g. FR)")
    parser.add_argument("--include-full", action="store_true", help="Include already ● regions")
    parser.add_argument("--format", choices=("tsv", "json"), default="tsv")
    args = parser.parse_args()

    country = args.country_iso.strip().upper() or None
    rows = plan_macro_import(args.macro, country_iso=country, include_full=args.include_full)

    if args.format == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return

    for r in rows:
        # locality|meta_id|title|country|limit
        title = r["name"].replace("|", " ")
        sys.stdout.write(f"{r['locality']}|{r['meta_id']}|{title}|{r['country']}|{r['limit']}\n")


if __name__ == "__main__":
    main()
