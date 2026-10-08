#!/usr/bin/env bash
# Dispatch Climbfinder imports for all non-● localities under Klimgebieden "Alpen" (macro l=36).
# Skips l=1, l=25, l=44, l=36. pages=all, Policy B via climbfinder_import.py.
# Order: smaller/leaf regions first, then French Alps / PACA / Auvergne (overlap → dedupe after).
set -euo pipefail
REPO="${GITHUB_REPOSITORY:-VCCharlie/Climbfinder-scraper}"

run_one() {
  local locality=$1 meta_id=$2 title=$3 country=$4 limit=$5
  echo "==> Dispatch l=${locality} ${title} (limit=${limit}, meta_id=${meta_id})"
  gh workflow run climbfinder-import.yml -R "$REPO" \
    -f "locality=${locality}" \
    -f pages=all \
    -f "meta_id=${meta_id}" \
    -f "title=${title}" \
    -f "country=${country}" \
    -f "region_label=${title}" \
    -f "limit=${limit}" \
    -f publish_to_site=true
  sleep 2
}

# status from index @ plan time — skip ● Briançon (42), Vaucluse (654)
run_one 63   cf-l63-la-maurienne              "La Maurienne"                    FR 146
run_one 65   cf-l65-annecy                    "Annecy"                          FR 215
run_one 39   cf-l39-serre-pon-on              "Serre Ponçon"                    FR 273
run_one 192  cf-l192-hautes-alpes             "Hautes Alpes"                    FR 320
run_one 288  cf-l288-haute-savoie             "Haute Savoie"                    FR 409
run_one 289  cf-l289-is-re                    "Isère"                           FR 489
run_one 957  cf-l957-savoie                   "Savoie"                          FR 469
run_one 646  cf-l646-provence                 "Provence"                        FR 1070
run_one 58   cf-l58-provence-alpes-c-te-d-azur "Provence-Alpes-Côte d'Azur"     FR 1342
run_one 37   cf-l37-french-alps               "French Alps"                     FR 2321
run_one 445  cf-l445-auvergne-rh-ne-alpes     "Auvergne-Rhône-Alpes"            FR 3845

echo "All 11 import workflows dispatched (queued one-at-a-time on repo concurrency)."
