#!/usr/bin/env python3
"""
Unified import plan: één locality-id → één of meer subregio-imports (zoals Klimgebieden-batch).

Regels:
- Macro-groep (groene klimgebied-rij, group.locality_id) → alle niet-● subregio’s.
- Land-/vergaarbak-locality (country-level, bv. l=45 Switzerland) → zelfde batch, zonder die bak.
- Gewone subregio (bv. Bern, South Holland) → één import met workflow limit/pages.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from climb_locality_resolve import country_level_locality_ids, locality_catalog_name
from plan_macro_group_import import meta_id_from_region, plan_macro_import

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/climbs/data"
HIERARCHY = DATA / "region-hierarchy.json"
REGIONS = DATA / "climbfinder-regions.json"


def _load_hierarchy() -> dict:
    return json.loads(HIERARCHY.read_text(encoding="utf-8"))


def _catalog_by_id() -> dict[int, dict]:
    out: dict[int, dict] = {}
    if not REGIONS.is_file():
        return out
    catalog = json.loads(REGIONS.read_text(encoding="utf-8"))
    for block in catalog.get("countries") or []:
        for r in block.get("regions") or []:
            if r.get("id") is not None:
                out[int(r["id"])] = r
    return out


def is_macro_group_id(locality_id: int, country_iso: str | None = None) -> bool:
    hierarchy = _load_hierarchy()
    for block in hierarchy.get("countries") or []:
        if country_iso and block.get("country_iso") != country_iso.upper():
            continue
        for group in block.get("groups") or []:
            if int(group.get("locality_id") or 0) == locality_id:
                return True
    return False


def find_group_for_locality(
    locality_id: int, country_iso: str | None
) -> tuple[dict | None, dict | None, int | None]:
    """Return (country_block, group, macro_locality_id) if locality sits in a klimgebied-groep."""
    hierarchy = _load_hierarchy()
    for block in hierarchy.get("countries") or []:
        if country_iso and block.get("country_iso") != country_iso.upper():
            continue
        for group in block.get("groups") or []:
            macro_id = int(group.get("locality_id") or 0)
            member_ids = {int(loc["locality_id"]) for loc in group.get("localities") or []}
            if locality_id == macro_id or locality_id in member_ids:
                return block, group, macro_id
    return None, None, None


def _single_row(
    locality_id: int,
    *,
    country_iso: str,
    meta_id: str | None,
    title: str | None,
    region_label: str | None,
    limit: int,
    pages: str,
) -> dict:
    by_id = _catalog_by_id()
    cat = by_id.get(locality_id, {})
    iso = str(cat.get("country_iso") or country_iso or "XX").upper()
    name = title or locality_catalog_name(iso, locality_id) or str(cat.get("name") or f"l={locality_id}")
    mid = meta_id or meta_id_from_region(locality_id, name)
    pop = int(cat.get("popular_count") or 0)
    lim = limit if limit > 0 else max(pop + 50, 100) if pop else 500
    return {
        "locality": locality_id,
        "meta_id": mid,
        "name": name,
        "country": iso,
        "limit": lim,
        "pages": pages,
        "region_label": region_label or name,
        "batch": False,
    }


def plan_locality_import(
    locality_id: int,
    *,
    country_iso: str | None = None,
    include_full: bool = False,
    meta_id: str | None = None,
    title: str | None = None,
    region_label: str | None = None,
    limit: int = 50,
    pages: str = "2",
) -> list[dict]:
    lid = int(locality_id)
    iso_hint = str(country_iso or "").strip().upper() or None

    def batch_rows(macro_id: int, iso: str, extra_skip: set[int] | None = None) -> list[dict]:
        raw = plan_macro_import(
            macro_id,
            country_iso=iso,
            include_full=include_full,
            extra_skip=extra_skip,
        )
        out: list[dict] = []
        for r in raw:
            out.append(
                {
                    "locality": r["locality"],
                    "meta_id": r["meta_id"],
                    "name": r["name"],
                    "country": r["country"],
                    "limit": r["limit"],
                    "pages": "all",
                    "region_label": r["name"],
                    "batch": True,
                }
            )
        return out

    if is_macro_group_id(lid, iso_hint):
        block, _group, macro_id = find_group_for_locality(lid, iso_hint)
        iso = (block or {}).get("country_iso") or iso_hint or "XX"
        return batch_rows(int(macro_id or lid), str(iso))

    block, group, macro_id = find_group_for_locality(lid, iso_hint)
    if group is not None and macro_id is not None:
        iso = str(block.get("country_iso") or iso_hint or "XX").upper()
        country_levels = country_level_locality_ids(iso)
        if lid == macro_id or lid in country_levels:
            extra = {lid} if lid in country_levels else set()
            return batch_rows(macro_id, iso, extra_skip=extra)

    iso = iso_hint or str(_catalog_by_id().get(lid, {}).get("country_iso") or "XX").upper()
    return [
        _single_row(
            lid,
            country_iso=iso,
            meta_id=meta_id,
            title=title,
            region_label=region_label,
            limit=limit,
            pages=pages,
        )
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description="Plan Climbfinder import (subregio’s waar nodig)")
    parser.add_argument("--locality", type=int, required=True)
    parser.add_argument("--country-iso", default="")
    parser.add_argument("--include-full", action="store_true")
    parser.add_argument("--meta-id", default="")
    parser.add_argument("--title", default="")
    parser.add_argument("--region-label", default="")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--pages", default="2")
    parser.add_argument("--format", choices=("tsv", "json"), default="tsv")
    args = parser.parse_args()

    rows = plan_locality_import(
        args.locality,
        country_iso=args.country_iso.strip().upper() or None,
        include_full=args.include_full,
        meta_id=args.meta_id.strip() or None,
        title=args.title.strip() or None,
        region_label=args.region_label.strip() or None,
        limit=args.limit,
        pages=args.pages,
    )

    if args.format == "json":
        json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return

    for r in rows:
        title = str(r["name"]).replace("|", " ")
        region = str(r["region_label"]).replace("|", " ")
        sys.stdout.write(
            f"{r['locality']}|{r['meta_id']}|{title}|{r['country']}|{r['limit']}|{r['pages']}|{region}\n"
        )


if __name__ == "__main__":
    main()
