#!/usr/bin/env python3
"""
Fetch Climbfinder difficulty points + category for climbs already in data bundles.

Lightweight: one HTML GET per slug (no geometry/profile re-import). Matches by climbfinder.slug.

  python scripts/backfill_climbfinder_scores.py --dry-run --limit 5
  python scripts/backfill_climbfinder_scores.py --limit 500
  python scripts/backfill_climbfinder_scores.py --count-only
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/climbs/data"

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from climbfinder_import import (  # noqa: E402
    _parse_difficulty,
    fetch_html,
    normalize_climb_category,
    parse_difficulty_points,
)
from rebuild_climb_index import is_climb_bundle  # noqa: E402


def climb_slug(climb: dict) -> str | None:
    slug = (climb.get("climbfinder") or {}).get("slug")
    if slug:
        return str(slug)
    cid = climb.get("id")
    return str(cid) if cid else None


def needs_score_backfill(climb: dict) -> bool:
    cf = climb.get("climbfinder") if isinstance(climb.get("climbfinder"), dict) else {}
    stats = climb.get("stats") if isinstance(climb.get("stats"), dict) else {}
    if cf.get("difficulty_points") is not None or stats.get("difficulty_points") is not None:
        return False
    return bool(climb_slug(climb))


def parse_scores_from_html(page_html: str) -> dict:
    m_cat = re.search(r'category:\s*"([^"]*)"', page_html)
    category_raw = m_cat.group(1) if m_cat else None
    classification = normalize_climb_category(category_raw)
    difficulty_points = parse_difficulty_points(page_html)
    m_id = re.search(r"climbId\s*=\s*(\d+)", page_html)
    climb_id = int(m_id.group(1)) if m_id else None
    return {
        "category_raw": category_raw,
        "classification": classification,
        "difficulty_points": difficulty_points,
        "difficulty_score": _parse_difficulty(category_raw),
        "climbfinder_id": climb_id,
    }


def apply_scores(climb: dict, scores: dict) -> bool:
    changed = False
    cf = climb.setdefault("climbfinder", {})
    if not isinstance(cf, dict):
        return False

    if scores.get("climbfinder_id") is not None and cf.get("id") != scores["climbfinder_id"]:
        cf["id"] = scores["climbfinder_id"]
        changed = True

    if scores.get("category_raw") and cf.get("category") != scores["category_raw"]:
        cf["category"] = scores["category_raw"]
        changed = True

    dp = scores.get("difficulty_points")
    if dp is not None:
        if cf.get("difficulty_points") != dp:
            cf["difficulty_points"] = dp
            changed = True
        stats = climb.setdefault("stats", {})
        if isinstance(stats, dict) and stats.get("difficulty_points") != dp:
            stats["difficulty_points"] = dp
            changed = True

    cls = scores.get("classification")
    if cls:
        if climb.get("classification") != cls:
            climb["classification"] = cls
            changed = True
        stats = climb.setdefault("stats", {})
        if isinstance(stats, dict) and stats.get("classification") != cls:
            stats["classification"] = cls
            changed = True

    ds = scores.get("difficulty_score")
    if ds is not None and climb.get("difficulty_score") != ds:
        climb["difficulty_score"] = ds
        changed = True

    return changed


def build_queue(bundle_filter: str, missing_only: bool) -> list[tuple[Path, int, str]]:
    queue: list[tuple[Path, int, str]] = []
    for path in sorted(DATA.glob("*.json")):
        if bundle_filter and path.name != bundle_filter and path.stem != bundle_filter.removesuffix(".json"):
            continue
        if not is_climb_bundle(path):
            continue
        with path.open(encoding="utf-8") as f:
            bundle = json.load(f)
        for idx, climb in enumerate(bundle.get("climbs") or []):
            slug = climb_slug(climb)
            if not slug:
                continue
            if missing_only and not needs_score_backfill(climb):
                continue
            queue.append((path, idx, slug))
    return queue


def write_bundle(path: Path, bundle: dict, now: str) -> None:
    meta = dict(bundle.get("meta") or {})
    meta["updated_at"] = now
    notes = meta.setdefault("maintenance", {})
    if isinstance(notes, dict):
        notes["climbfinder_scores_backfill"] = now
    bundle["meta"] = meta
    with path.open("w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False, indent=2)
        f.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill Climbfinder difficulty points on published climbs")
    parser.add_argument("--bundle", default="", help="Only this data filename (e.g. cf-l277-south-holland.json)")
    parser.add_argument("--all", action="store_true", help="Re-fetch scores even when already present")
    parser.add_argument("--limit", type=int, default=0, help="Max climbs to fetch this run (0 = no cap)")
    parser.add_argument(
        "--offset",
        type=int,
        default=0,
        help="Skip first N climbs in queue (vaste volgorde; bij ontbrekende scores meestal 0)",
    )
    parser.add_argument("--delay", type=float, default=0.35, help="Seconds between HTTP requests")
    parser.add_argument(
        "--flush-every",
        type=int,
        default=40,
        help="Schrijf gewijzigde bundle naar disk elke N verwerkte klimmen (tussentijds opslaan)",
    )
    parser.add_argument("--count-only", action="store_true", help="Print queue size and exit")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    bundle_filter = args.bundle.strip()
    missing_only = not args.all
    full_queue = build_queue(bundle_filter, missing_only)
    total_pending = len(full_queue)

    if args.count_only:
        print(f"pending={total_pending} missing_only={missing_only} bundle={bundle_filter or '*'}")
        return 0

    offset = max(0, args.offset)
    queue = full_queue[offset:]
    if args.limit > 0:
        queue = queue[: args.limit]

    remaining_after = max(0, total_pending - offset - len(queue))
    print(
        f"Climbs this run: {len(queue)} (pending total {total_pending}, offset {offset}, "
        f"remaining after batch ~{remaining_after}, missing_only={missing_only})"
    )
    if not queue:
        return 0

    bundles: dict[Path, dict] = {}
    dirty_counts: dict[Path, int] = {}
    updated = 0
    errors = 0
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def flush_path(path: Path) -> None:
        if path not in bundles or args.dry_run:
            return
        write_bundle(path, bundles[path], now)
        dirty_counts[path] = 0

    for i, (path, climb_idx, slug) in enumerate(queue, 1):
        if path not in bundles:
            with path.open(encoding="utf-8") as f:
                bundles[path] = json.load(f)
        climb = bundles[path]["climbs"][climb_idx]
        url = f"https://climbfinder.com/en/climbs/{slug}"
        try:
            html = fetch_html(url)
            scores = parse_scores_from_html(html)
            if scores.get("difficulty_points") is None and scores.get("classification") is None:
                print(f"  [{i}/{len(queue)}] {slug}: no scores in HTML")
                continue
            if apply_scores(climb, scores):
                updated += 1
                dirty_counts[path] = dirty_counts.get(path, 0) + 1
                print(
                    f"  [{i}/{len(queue)}] {slug}: "
                    f"points={scores.get('difficulty_points')} cat={scores.get('classification')}"
                )
            else:
                print(f"  [{i}/{len(queue)}] {slug}: unchanged")
        except Exception as exc:
            errors += 1
            print(f"  [{i}/{len(queue)}] {slug}: ERROR {exc}", file=sys.stderr)
        if args.flush_every > 0 and dirty_counts.get(path, 0) >= args.flush_every:
            flush_path(path)
        if args.delay > 0 and i < len(queue):
            time.sleep(args.delay)

    print(f"Updated {updated} climb(s), errors {errors}, files touched {len(bundles)}")
    if remaining_after > 0 and not args.dry_run:
        print(f"TIP: nog ~{remaining_after} klim(men) — start volgende batch (offset {offset + len(queue)} of opnieuw met limit).")

    if args.dry_run:
        print("(dry-run — no files written)")
        return 0

    for path in bundles:
        flush_path(path)

    return 0 if errors == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
