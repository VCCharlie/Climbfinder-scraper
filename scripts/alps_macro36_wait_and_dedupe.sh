#!/usr/bin/env bash
# Wait until no Climbfinder import run is queued/in_progress, then dedupe all duplicates.
set -euo pipefail
REPO="${GITHUB_REPOSITORY:-VCCharlie/Climbfinder-scraper}"
POLL_SEC="${POLL_SEC:-120}"

echo "Waiting for Climbfinder import queue to drain (poll every ${POLL_SEC}s)…"
while true; do
  pending=$(gh run list -R "$REPO" --workflow=climbfinder-import.yml --limit 20 \
    --json status -q '[.[] | select(.status=="queued" or .status=="in_progress")] | length')
  if [[ "${pending}" == "0" ]]; then
    echo "No import runs in progress."
    break
  fi
  echo "$(date -u +%H:%M:%S) still ${pending} import run(s) queued/in_progress…"
  sleep "$POLL_SEC"
done

echo "Dispatch dedupe-all-smallest-region…"
gh workflow run dedupe-all-smallest-region.yml -R "$REPO"
echo "Done."
