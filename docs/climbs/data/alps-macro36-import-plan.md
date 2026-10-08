# Alpen (macro l=36) — importplan

**Klimgebieden-groep `l=36`** in `region-hierarchy.json` staat alleen onder **Frankrijk** (13 regio’s na skip van World/Europe/France). IT/CH/AT-Alpen zitten onder **eigen** macro’s (`l=59`, `l=56`, `l=87`, …), niet onder `l=36`.

## Overgeslagen (al ● op site)

| l | Regio | Popular | Site |
|---|--------|---------|------|
| 654 | Vaucluse | 232 | 232 |
| 42 | Briançon | 112 | 112 |

## Batch (11 runs, `pages=all`, limit ≈ Popular+50)

Volgorde: blad → ouder (minder dubbele rommel tot dedupe).

| # | Status | l | Regio | Popular | Site | limit | meta_id |
|---|--------|---|--------|---------|------|-------|---------|
| 1 | ◐ | 63 | La Maurienne | 96 | 84 | 146 | cf-l63-la-maurienne |
| 2 | ◐ | 65 | Annecy | 165 | 141 | 215 | cf-l65-annecy |
| 3 | ◐ | 39 | Serre Ponçon | 223 | 50 | 273 | cf-l39-serre-pon-on |
| 4 | ◐ | 192 | Hautes Alpes | 270 | 169 | 320 | cf-l192-hautes-alpes |
| 5 | ◐ | 288 | Haute Savoie | 359 | 237 | 409 | cf-l288-haute-savoie |
| 6 | ◐ | 289 | Isère | 439 | 390 | 489 | cf-l289-is-re |
| 7 | ○ | 957 | Savoie | 419 | 0 | 469 | cf-l957-savoie |
| 8 | ○ | 646 | Provence | 1020 | 0 | 1070 | cf-l646-provence |
| 9 | ◐ | 58 | PACA | 1292 | 336 | 1342 | cf-l58-provence-alpes-c-te-d-azur |
| 10 | ◐ | 37 | French Alps | 2271 | 363 | 2321 | cf-l37-french-alps |
| 11 | ○ | 445 | Auvergne-Rhône-Alpes | 3795 | 0 | 3845 | cf-l445-auvergne-rh-ne-alpes |

## Starten

1. **Aanbevolen:** GitHub → Actions → **Alps macro36 import batch** → Run workflow (branch `main`, na merge).
2. Of losse runs: `scripts/alps_macro36_import_batch.sh` (vereist `gh` met **Actions: write**), daarna `scripts/alps_macro36_wait_and_dedupe.sh`.

Policy B (`region` + `resolved_locality_id`) zit in `climbfinder_import.py`. Na overlap tussen ouder/kind: dedupe **kleinste dataset** (in batch-workflow standaard aan).
