#!/usr/bin/env python3
"""
Split a country-level (monolith) climb bundle into per-locality datasets without re-import.

Uses slug resolution indexes, existing climb locality fields, and optional nearest-region
geo fallback (climbfinder-regions-geo.json centroids).

  python scripts/split_monolith_bundle.py --bundle docs/climbs/data/cf-l45-switzerland.json --dry-run
  python scripts/split_monolith_bundle.py --bundle docs/climbs/data/cf-l45-switzerland.json --geo-fallback --remove-source
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/climbs/data"
GEO_FILE = DATA / "climbfinder-regions-geo.json"
INDEX_FILE = DATA / "index.json"
REGIONS_FILE = DATA / "climbfinder-regions.json"

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from backfill_climb_resolved_regions import (  # noqa: E402
    apply_climb_resolution,
    climb_slug,
    import_locality_from_meta,
)
from climb_locality_resolve import (  # noqa: E402
    clear_resolution_cache,
    country_level_locality_ids,
    locality_catalog_name,
    resolve_climb_labels,
)
from build_region_hierarchy import MACRO_LOCALITY_BY_ISO  # noqa: E402
from plan_macro_group_import import meta_id_from_region  # noqa: E402
from publish_climb_json import load_json, merge_climbs, save_json  # noqa: E402


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p = math.pi / 180.0
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin(
        (lon2 - lon1) * p / 2
    ) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _catalog_by_id() -> dict[int, dict]:
    out: dict[int, dict] = {}
    if not REGIONS_FILE.is_file():
        return out
    catalog = load_json(REGIONS_FILE)
    for block in catalog.get("countries") or []:
        for r in block.get("regions") or []:
            if r.get("id") is not None:
                out[int(r["id"])] = r
    return out


def _published_meta_by_locality(index: dict) -> dict[int, str]:
    pub: dict[int, str] = {}
    for entry in index.get("regions") or []:
        eid = str(entry.get("id") or "")
        m = re.match(r"^cf-l(\d+)-", eid)
        if not m:
            continue
        loc = int(m.group(1))
        count = int(entry.get("count") or 0)
        prev = pub.get(loc)
        if not prev:
            pub[loc] = eid
            continue
        prev_count = next(
            (int(e.get("count") or 0) for e in index.get("regions") or [] if e.get("id") == prev),
            0,
        )
        if count >= prev_count:
            pub[loc] = eid
    return pub


def _macro_locality_ids(country_iso: str) -> set[int]:
    return {int(m["locality_id"]) for m in MACRO_LOCALITY_BY_ISO.get(country_iso.upper(), [])}


def _centroids_for_country(country_iso: str, *, skip_ids: set[int]) -> list[tuple[int, float, float]]:
    if not GEO_FILE.is_file():
        return []
    skip_ids = set(skip_ids) | _macro_locality_ids(country_iso)
    geo = load_json(GEO_FILE)
    regions = geo.get("regions") or {}
    out: list[tuple[int, float, float]] = []
    for sid, row in regions.items():
        if not isinstance(row, dict):
            continue
        if str(row.get("country_iso") or "").upper() != country_iso.upper():
            continue
        try:
            lid = int(sid)
        except (TypeError, ValueError):
            continue
        if lid in skip_ids:
            continue
        lat, lon = row.get("lat"), row.get("lon")
        if lat is None or lon is None:
            continue
        out.append((lid, float(lat), float(lon)))
    return out


def _climb_start_lat_lon(climb: dict) -> tuple[float, float] | None:
    start = climb.get("start") if isinstance(climb.get("start"), dict) else {}
    lat, lng = start.get("lat"), start.get("lng")
    if lat is not None and lng is not None:
        return float(lat), float(lng)
    geom = climb.get("geometry") if isinstance(climb.get("geometry"), dict) else {}
    coords = geom.get("coordinates")
    if isinstance(coords, list) and coords and isinstance(coords[0], (list, tuple)) and len(coords[0]) >= 2:
        lng, lat = coords[0][0], coords[0][1]
        return float(lat), float(lng)
    return None


def _locality_from_climb_fields(climb: dict, country_iso: str, country_levels: set[int]) -> int | None:
    for key in ("resolved_locality_id", "display_locality_id"):
        val = climb.get(key)
        if val is None:
            continue
        lid = int(val)
        if lid in country_levels:
            continue
        return lid
    cf = climb.get("climbfinder")
    if isinstance(cf, dict) and cf.get("resolved_locality_id") is not None:
        lid = int(cf["resolved_locality_id"])
        if lid not in country_levels:
            return lid
    slug = climb_slug(climb)
    if slug:
        labels = resolve_climb_labels(slug, country_iso, import_locality_id=None)
        for key in ("resolved_locality_id", "display_locality_id"):
            val = labels.get(key) if labels else None
            if val is None:
                continue
            lid = int(val)
            if lid in country_levels:
                continue
            return lid
    return None


def _geo_locality(
    climb: dict,
    centroids: list[tuple[int, float, float]],
    *,
    max_km: float,
) -> int | None:
    if not centroids:
        return None
    pt = _climb_start_lat_lon(climb)
    if not pt:
        return None
    lat, lon = pt
    best_id: int | None = None
    best_d = max_km + 1.0
    for lid, clat, clon in centroids:
        d = _haversine_km(lat, lon, clat, clon)
        if d < best_d:
            best_d = d
            best_id = lid
    return best_id if best_d <= max_km else None


def _target_meta_id(locality_id: int, country_iso: str, published: dict[int, str]) -> str:
    if locality_id in published:
        return published[locality_id]
    name = locality_catalog_name(country_iso, locality_id) or str(
        _catalog_by_id().get(locality_id, {}).get("name") or locality_id
    )
    return meta_id_from_region(locality_id, name)


def _write_split_bundle(
    *,
    meta_id: str,
    country_iso: str,
    locality_id: int,
    climbs: list[dict],
    source_meta_id: str,
    dry_run: bool,
) -> None:
    dest = DATA / f"{meta_id}.json"
    title = locality_catalog_name(country_iso, locality_id) or meta_id
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if dest.is_file():
        existing = load_json(dest)
        merged = merge_climbs(existing.get("climbs") or [], climbs)
        meta_out = dict(existing.get("meta") or {})
        meta_out["count"] = len(merged)
        meta_out["updated_at"] = now
        src = meta_out.setdefault("source", {})
        if isinstance(src, dict):
            splits = src.setdefault("split_from_monolith", [])
            if source_meta_id not in splits:
                splits.append(source_meta_id)
        payload = {
            "schema_version": existing.get("schema_version", "1.0"),
            "meta": meta_out,
            "climbs": merged,
        }
    else:
        meta_out = {
            "id": meta_id,
            "title": title,
            "country": country_iso,
            "count": len(climbs),
            "updated_at": now,
            "source": {
                "locality_id": locality_id,
                "split_from_monolith": [source_meta_id],
            },
        }
        payload = {"schema_version": "1.0", "meta": meta_out, "climbs": climbs}

    print(f"  → {meta_id}: +{len(climbs)} climb(s) → {len(payload['climbs'])} total")
    if not dry_run:
        save_json(dest, payload)


def main() -> int:
    parser = argparse.ArgumentParser(description="Split monolith climb bundle into subregion files")
    parser.add_argument("--bundle", required=True, help="Path to monolith JSON (under data/ or absolute)")
    parser.add_argument("--geo-fallback", action="store_true", help="Assign unresolved climbs via nearest region centroid")
    parser.add_argument("--geo-max-km", type=float, default=120.0, help="Max distance for geo fallback (default 120)")
    parser.add_argument("--dry-run", action="store_true", help="Report only; do not write files")
    parser.add_argument(
        "--remove-source",
        action="store_true",
        help="Delete source bundle and drop from index after successful split (requires no unassigned unless --leave-unassigned)",
    )
    parser.add_argument(
        "--leave-unassigned-in-source",
        action="store_true",
        help="Keep unassigned climbs in the source file; only split assigned climbs",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit 1 if any climb cannot be assigned to a sub-locality",
    )
    parser.add_argument("--report", default="", help="Write JSON assignment report to this path")
    args = parser.parse_args()

    bundle_path = Path(args.bundle)
    if not bundle_path.is_file():
        bundle_path = DATA / args.bundle
    if not bundle_path.is_file():
        print(f"Bundle not found: {args.bundle}", file=sys.stderr)
        return 1

    clear_resolution_cache()
    bundle = load_json(bundle_path)
    meta = bundle.get("meta") or {}
    source_meta_id = str(meta.get("id") or bundle_path.stem)
    country_iso = str(meta.get("country") or "XX").upper()
    import_loc = import_locality_from_meta(meta)
    country_levels = country_level_locality_ids(country_iso)
    if import_loc is not None and import_loc not in country_levels:
        print(
            f"Note: source locality l={import_loc} is not marked country-level for {country_iso}; continuing.",
            file=sys.stderr,
        )

    index = load_json(INDEX_FILE) if INDEX_FILE.is_file() else {"regions": []}
    published = _published_meta_by_locality(index)
    centroids = _centroids_for_country(country_iso, skip_ids=country_levels) if args.geo_fallback else []

    groups: dict[int, list[dict]] = defaultdict(list)
    unassigned: list[dict] = []
    sources = Counter()

    for climb in bundle.get("climbs") or []:
        lid = _locality_from_climb_fields(climb, country_iso, country_levels)
        src = "fields_or_slug_index"
        if lid is None and args.geo_fallback:
            lid = _geo_locality(climb, centroids, max_km=args.geo_max_km)
            src = "geo_fallback" if lid is not None else "unassigned"
        elif lid is None:
            src = "unassigned"

        if lid is None:
            unassigned.append(climb)
            sources[src] += 1
            continue

        apply_climb_resolution(
            climb,
            country_iso,
            lid,
            locality_catalog_name(country_iso, lid),
        )
        groups[int(lid)].append(climb)
        sources[src] += 1

    print(f"Source {source_meta_id}: {len(bundle.get('climbs') or [])} climbs")
    print(f"  Assigned to {len(groups)} localities; unassigned: {len(unassigned)}")
    for src, n in sources.most_common():
        print(f"    {src}: {n}")

    if args.strict and unassigned:
        print("Strict mode: unassigned climbs remain.", file=sys.stderr)
        return 1

    for locality_id, climbs in sorted(groups.items()):
        meta_id = _target_meta_id(locality_id, country_iso, published)
        _write_split_bundle(
            meta_id=meta_id,
            country_iso=country_iso,
            locality_id=locality_id,
            climbs=climbs,
            source_meta_id=source_meta_id,
            dry_run=args.dry_run,
        )

    if unassigned and args.leave_unassigned_in_source and not args.dry_run:
        leftover = {
            "schema_version": bundle.get("schema_version", "1.0"),
            "meta": {
                **meta,
                "count": len(unassigned),
                "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "maintenance": {
                    **(meta.get("maintenance") if isinstance(meta.get("maintenance"), dict) else {}),
                    "split_monolith_leftover": True,
                },
            },
            "climbs": unassigned,
        }
        save_json(bundle_path, leftover)
        print(f"Left {len(unassigned)} unassigned climb(s) in {bundle_path.name}")
    elif unassigned and not args.leave_unassigned_in_source and not args.dry_run:
        print(f"Warning: {len(unassigned)} unassigned climbs were not written anywhere.", file=sys.stderr)

    if args.remove_source and not unassigned and not args.dry_run:
        bundle_path.unlink(missing_ok=True)
        regions = index.get("regions") or []
        index["regions"] = [r for r in regions if r.get("id") != source_meta_id]
        save_json(INDEX_FILE, index)
        print(f"Removed source bundle {bundle_path.name} and index entry {source_meta_id}")
    elif args.remove_source and unassigned:
        print("Source not removed: unassigned climbs remain (use --geo-fallback or --leave-unassigned-in-source).")

    if args.report:
        report_path = Path(args.report)
        report = {
            "source_meta_id": source_meta_id,
            "country": country_iso,
            "assigned_by_locality": {str(k): len(v) for k, v in sorted(groups.items())},
            "unassigned_count": len(unassigned),
            "sources": dict(sources),
            "dry_run": args.dry_run,
        }
        if not args.dry_run:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        else:
            print(json.dumps(report, indent=2))

    if not args.dry_run and groups:
        subprocess.check_call([sys.executable, str(ROOT / "scripts/rebuild_climb_index.py")])
        if len(groups) > 1:
            subprocess.check_call([sys.executable, str(ROOT / "scripts/dedupe_keep_smallest_region.py")])
            subprocess.check_call([sys.executable, str(ROOT / "scripts/rebuild_climb_index.py")])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
