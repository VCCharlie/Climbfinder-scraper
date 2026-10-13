#!/usr/bin/env bash
# Run a TSV plan from plan_locality_import.py / plan_macro_group_import.py
# Columns: locality|meta_id|title|country|limit|pages|region_label
set -euo pipefail

PLAN_FILE="${1:?plan TSV path}"
PUBLISH="${2:-true}"
MERGE_INTO="${3:-}"

mkdir -p out
BATCH_COUNT=0

while IFS='|' read -r locality meta_id title country limit pages region_label; do
  [[ -z "${locality:-}" ]] && continue
  echo "========== l=${locality} ${title} limit=${limit} pages=${pages} =========="
  PAGE_ARGS=()
  if [[ "${pages}" == "all" || "${pages}" == "0" ]]; then
    PAGE_ARGS=(--all-pages)
  else
    PAGE_ARGS=(--pages "${pages}")
  fi
  python scripts/climbfinder_import.py \
    --locality "${locality}" \
    --locality-label "${locality}:${title}" \
    "${PAGE_ARGS[@]}" \
    --meta-id "${meta_id}" \
    --title "${title}" \
    --country "${country}" \
    --region-label "${region_label}" \
    --limit "${limit}" \
    --out "out/${meta_id}.json"
  if [[ "${PUBLISH}" == "true" ]]; then
    MERGE_ARGS=()
    if [[ -n "${MERGE_INTO}" ]]; then
      MERGE_ARGS=(--merge-into "${MERGE_INTO}")
    fi
    python scripts/publish_climb_json.py --bundle "out/${meta_id}.json" "${MERGE_ARGS[@]}"
  fi
  BATCH_COUNT=$((BATCH_COUNT + 1))
done < "${PLAN_FILE}"

if [[ "${PUBLISH}" == "true" ]]; then
  python scripts/rebuild_climb_index.py
fi

if [[ "${BATCH_COUNT}" -gt 1 ]]; then
  python scripts/dedupe_keep_smallest_region.py
  python scripts/rebuild_climb_index.py
fi

echo "Import plan done (${BATCH_COUNT} region(s))."
