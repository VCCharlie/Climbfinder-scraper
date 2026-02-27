"""
debug_climbfinder.py — standalone inspector

Run this script on your LOCAL machine (where the site is accessible) to see
the exact raw __NEXT_DATA__ JSON structure that Climbfinder uses.  The output
tells us exactly which field names hold name / length / gradient / score.

Usage:
    python debug_climbfinder.py
    python debug_climbfinder.py --region 957 --mode popular
    python debug_climbfinder.py --region 957 --mode cotacol

Requirements:  pip install requests beautifulsoup4 lxml
Playwright is NOT required for this script.

The script saves:
  climbfinder_raw.json      — full __NEXT_DATA__ payload
  climbfinder_first_items.json — the first 3 items of every candidate array
"""

import argparse
import json
import re
import sys
import time

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("Missing packages.  Run:  pip install requests beautifulsoup4 lxml")
    sys.exit(1)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)

HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://climbfinder.com/en/ranking",
}


def fetch_html(url: str) -> str:
    print(f"\n→ Fetching: {url}")
    resp = requests.get(url, headers=HEADERS, timeout=20)
    resp.raise_for_status()
    print(f"  Status: {resp.status_code}  ({len(resp.text):,} bytes)")
    return resp.text


def extract_next_data(html: str) -> dict | None:
    """Extract the __NEXT_DATA__ script JSON from the HTML."""
    # Fast regex first
    m = re.search(
        r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>',
        html, re.DOTALL
    )
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError as e:
            print(f"  JSON parse error: {e}")

    # BeautifulSoup fallback
    soup = BeautifulSoup(html, "html.parser")
    tag = soup.find("script", id="__NEXT_DATA__")
    if tag and tag.string:
        try:
            return json.loads(tag.string)
        except json.JSONDecodeError as e:
            print(f"  JSON parse error (soup): {e}")

    return None


def collect_all_arrays(obj, results=None, path="", depth=0):
    """Recursively collect every array of dicts that has >= 2 items."""
    if results is None:
        results = []
    if depth > 15:
        return results
    if isinstance(obj, list) and len(obj) >= 2:
        if all(isinstance(x, dict) for x in obj[:3]):
            results.append({"path": path, "items": obj})
    if isinstance(obj, dict):
        for k, v in obj.items():
            collect_all_arrays(v, results, f"{path}.{k}", depth + 1)
    elif isinstance(obj, list):
        for i, item in enumerate(obj[:5]):  # limit breadth
            collect_all_arrays(item, results, f"{path}[{i}]", depth + 1)
    return results


def print_object(d: dict, indent: int = 4):
    """Pretty-print a dict, truncating long strings."""
    pad = " " * indent
    for k, v in d.items():
        if isinstance(v, str) and len(v) > 120:
            v_display = v[:120] + "…"
        elif isinstance(v, (dict, list)):
            v_display = f"<{type(v).__name__} with {len(v)} items>"
        else:
            v_display = repr(v)
        print(f"{pad}{k!r:30s}: {v_display}")


def main():
    parser = argparse.ArgumentParser(description="Inspect Climbfinder __NEXT_DATA__")
    parser.add_argument("--region", default="957", help="Region ID (default: 957 Savoie)")
    parser.add_argument("--mode", default="popular", choices=["popular", "cotacol"],
                        help="Ranking mode (default: popular)")
    parser.add_argument("--page", default=1, type=int, help="Page number (default: 1)")
    args = parser.parse_args()

    url = (
        f"https://climbfinder.com/en/ranking"
        f"?l={args.region}&p={args.page}&s={args.mode}"
    )

    html = fetch_html(url)

    # ------------------------------------------------------------------
    # 1. Check if page loaded at all
    # ------------------------------------------------------------------
    if "climbfinder" not in html.lower():
        print("\n⚠  Response does not look like Climbfinder — may be a CAPTCHA or block.")
        print("   Try running with Playwright instead (see README).")
        print("\n--- First 2000 chars of response ---")
        print(html[:2000])
        return

    # ------------------------------------------------------------------
    # 2. Extract __NEXT_DATA__
    # ------------------------------------------------------------------
    data = extract_next_data(html)
    if not data:
        print("\n❌  Could not find __NEXT_DATA__ in the page.")
        print("   The page may require JavaScript rendering (use Playwright).")
        print("\n--- Looking for any JSON-like data in the HTML ---")
        # Print any script tags
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup.find_all("script"):
            content = (tag.string or "").strip()
            if content and len(content) > 100:
                print(f"\n<script> ({len(content)} chars):")
                print(content[:500])
        return

    print("\n✅  Found __NEXT_DATA__!")

    # Save full JSON
    with open("climbfinder_raw.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print("   Saved full JSON → climbfinder_raw.json")

    # ------------------------------------------------------------------
    # 3. Find all arrays of dicts
    # ------------------------------------------------------------------
    arrays = collect_all_arrays(data)
    print(f"\n   Found {len(arrays)} arrays of dicts in __NEXT_DATA__")

    # ------------------------------------------------------------------
    # 4. Print details of every candidate array
    # ------------------------------------------------------------------
    first_items_dump = []

    for i, arr in enumerate(arrays):
        items = arr["items"]
        path = arr["path"]
        size = len(items)
        first = items[0] if items else {}
        keys = list(first.keys())

        print(f"\n{'='*70}")
        print(f"  Array #{i+1}  |  path: {path}")
        print(f"  Size: {size} items  |  Keys in first item: {keys}")
        print(f"  First 3 items:")
        for j, item in enumerate(items[:3]):
            print(f"\n  --- Item {j+1} ---")
            print_object(item)

        first_items_dump.append({
            "index": i + 1,
            "path": path,
            "size": size,
            "keys": keys,
            "first_3_items": items[:3],
        })

    # Save candidate arrays
    with open("climbfinder_first_items.json", "w", encoding="utf-8") as f:
        json.dump(first_items_dump, f, indent=2, ensure_ascii=False)
    print(f"\n\n   Saved candidate arrays → climbfinder_first_items.json")

    # ------------------------------------------------------------------
    # 5. Try to identify the real ranking array
    # ------------------------------------------------------------------
    print(f"\n{'='*70}")
    print("  BEST GUESS — real ranking array:")
    stats_re = re.compile(r'[\d]+[.,]?[\d]*\s*km')

    def score(arr_entry):
        count = sum(
            1 for item in arr_entry["items"]
            if isinstance(item, dict) and stats_re.search(str(item.get("name", "")))
        )
        return (count, arr_entry["size"])

    ranked = sorted(arrays, key=score, reverse=True)
    if ranked:
        best = ranked[0]
        print(f"  Path: {best['path']}  (size: {best['size']})")
        print(f"  First item:")
        print_object(best["items"][0])

    print(f"\n✅  Done.  Review climbfinder_raw.json and climbfinder_first_items.json")
    print("   for the complete picture.\n")


if __name__ == "__main__":
    main()
