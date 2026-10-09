#!/usr/bin/env bash
# Deploy Firebase Callable requestClimbfinderImport for one-click import on climbs/import.html
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v firebase >/dev/null 2>&1; then
  echo "Installeer Firebase CLI: npm install -g firebase-tools"
  exit 1
fi

echo "Firebase project: climb-database (zie .firebaserc)"
firebase use climb-database

if [ -z "${CLIMBFINDER_IMPORT_PAT:-}" ]; then
  echo "Export CLIMBFINDER_IMPORT_PAT= (fine-grained PAT, Actions read+write op deze repo) en run opnieuw."
  echo "Of gebruik GitHub Actions: Deploy Climbfinder import function (secrets FIREBASE_SERVICE_ACCOUNT + CLIMBFINDER_IMPORT_PAT)."
  exit 1
fi

firebase functions:config:set \
  github.pat="$CLIMBFINDER_IMPORT_PAT" \
  github.repo="${GITHUB_REPO:-VCCharlie/Climbfinder-scraper}" \
  github.ref="${GITHUB_REF_NAME:-main}"

npm ci --prefix functions
firebase deploy --only functions:requestClimbfinderImport

echo ""
echo "Klaar. Zet githubImport.enabled: true in docs/auth/firebase-config.js (staat al in repo) en push naar main voor GitHub Pages."
echo "Test: climbs/import.html → inloggen → regio → Start import (één klik)."
