#!/usr/bin/env bash
# Push current branch to origin/main after long jobs (remote may have moved).
set -euo pipefail

BRANCH="${1:-main}"
MAX="${CI_PUSH_RETRIES:-8}"

git fetch origin "$BRANCH"

for attempt in $(seq 1 "$MAX"); do
  if git push origin "HEAD:${BRANCH}"; then
    echo "Push succeeded on attempt ${attempt}."
    exit 0
  fi
  echo "Push rejected (attempt ${attempt}/${MAX}); integrating origin/${BRANCH}…"
  if git rebase "origin/${BRANCH}"; then
    continue
  fi
  echo "Rebase conflict — merge origin/${BRANCH} and rebuild index.json"
  git rebase --abort || true
  git merge "origin/${BRANCH}" -m "chore: merge ${BRANCH} before data push" || true
  if [ -f scripts/rebuild_climb_index.py ]; then
    python3 scripts/rebuild_climb_index.py
    git add docs/climbs/data/index.json docs/climbs/data/published-*.json docs/climbs/data/slug-*.json docs/climbs/data/region-hierarchy.json 2>/dev/null || git add docs/climbs/data/
    if ! git diff --staged --quiet; then
      git commit -m "chore(climbs): rebuild index after merge [skip ci]" || true
    fi
  fi
done

echo "::error::Push to origin/${BRANCH} failed after ${MAX} attempts."
exit 1
