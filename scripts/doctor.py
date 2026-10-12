#!/usr/bin/env python3
"""FietsKlim repo health checks (local dev / CI-friendly). Exit 0 = all OK, 1 = issues."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def ok(msg: str) -> None:
    print(f"  OK  {msg}")


def fail(msg: str) -> None:
    print(f"FAIL  {msg}", file=sys.stderr)


def check_path(rel: str, *, must_exist: bool = True) -> bool:
    p = ROOT / rel
    if must_exist and not p.is_file():
        fail(f"missing file: {rel}")
        return False
    ok(rel)
    return True


def check_firebase_config() -> bool:
    path = ROOT / "docs/auth/firebase-config.js"
    if not path.is_file():
        fail("missing docs/auth/firebase-config.js (copy from firebase-config.example.js)")
        return False
    text = path.read_text(encoding="utf-8")
    if "YOUR_API_KEY" in text or "YOUR_PROJECT_ID" in text:
        fail("docs/auth/firebase-config.js still has placeholder values")
        return False
    ok("firebase-config.js looks configured")
    return True


def check_climbs_index() -> bool:
    path = ROOT / "docs/climbs/data/index.json"
    if not path.is_file():
        fail("missing docs/climbs/data/index.json")
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"index.json invalid JSON: {e}")
        return False
    regions = data.get("regions") or data.get("datasets") or []
    if not regions:
        fail("index.json has no regions/datasets list")
        return False
    ok(f"index.json ({len(regions)} region entries)")
    return True


def check_functions_exports() -> bool:
    index = ROOT / "functions/index.js"
    strava = ROOT / "functions/strava.js"
    if not index.is_file():
        fail("missing functions/index.js")
        return False
    if not strava.is_file():
        fail("missing functions/strava.js")
        return False
    index_text = index.read_text(encoding="utf-8")
    if "requestClimbfinderImport" not in index_text:
        fail("functions/index.js missing requestClimbfinderImport")
        return False
    if 'require("./strava")' not in index_text and "require('./strava')" not in index_text:
        fail("functions/index.js should re-export ./strava")
        return False
    strava_text = strava.read_text(encoding="utf-8")
    needed = ["getStravaConnectUrl", "stravaCompleteOAuth", "stravaSyncTrial"]
    missing = [n for n in needed if n not in strava_text]
    if missing:
        fail(f"functions/strava.js missing exports: {', '.join(missing)}")
        return False
    ok("functions export import + Strava callables")
    return True


def check_deploy_workflow_project() -> bool:
    wf = ROOT / ".github/workflows/deploy-climbfinder-import-function.yml"
    if not wf.is_file():
        fail("missing deploy workflow")
        return False
    text = wf.read_text(encoding="utf-8")
    if "FIREBASE_PROJECT_ID" not in text:
        fail("deploy workflow should set FIREBASE_PROJECT_ID")
        return False
    ok("deploy workflow references FIREBASE_PROJECT_ID")
    return True


def check_pwa_versions_aligned() -> bool:
    sw = ROOT / "docs/climbs/service-worker.js"
    if not sw.is_file():
        fail("missing service-worker.js")
        return False
    sw_text = sw.read_text(encoding="utf-8")
    m = re.search(r'CACHE_VERSION\s*=\s*"([^"]+)"', sw_text)
    if not m:
        fail("service-worker.js: no CACHE_VERSION")
        return False
    cache_v = m.group(1)
    pwa = ROOT / "docs/climbs/assets/pwa-register.js"
    pwa_text = pwa.read_text(encoding="utf-8")
    m2 = re.search(r'BUILD_STAMP\s*=\s*"([^"]+)"', pwa_text)
    if not m2:
        fail("pwa-register.js: no BUILD_STAMP")
        return False
    build_v = m2.group(1)
    if cache_v != build_v:
        fail(f"PWA version mismatch: CACHE_VERSION={cache_v} vs BUILD_STAMP={build_v}")
        return False
    for page in ("docs/climbs/index.html", "docs/climbs/import.html", "docs/climbs/settings.html"):
        html = (ROOT / page).read_text(encoding="utf-8")
        if f"pwa-register.js?v={cache_v}" not in html:
            fail(f"{page}: pwa-register.js?v= should match {cache_v}")
            return False
    ok(f"PWA versions aligned ({cache_v})")
    return True


def main() -> int:
    print("FietsKlim doctor\n")
    checks = [
        lambda: check_path("requirements.txt"),
        lambda: check_path("functions/package.json"),
        lambda: check_path("docs/climbs/index.html"),
        lambda: check_path("docs/climbs/settings.html"),
        lambda: check_path("docs/climbs/assets/climb-log.js"),
        lambda: check_firebase_config(),
        lambda: check_climbs_index(),
        lambda: check_functions_exports(),
        lambda: check_deploy_workflow_project(),
        lambda: check_pwa_versions_aligned(),
    ]
    good = all(fn() for fn in checks)
    print()
    if good:
        print("All checks passed.")
        return 0
    print("Some checks failed.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
