# Referentie-implementatie: `intervals_map` (branch `cursor/cpl-intervals-map-578c`)

Deze map is een **vastgelegde kopie** van de CPL-wijzigingen die op de Cloud Agent al gebouwd en getest zijn (`node`-tests + vitest).  
Gebruik dit als **bron van waarheid** — geen herontwerp.

## Bestanden kopiëren (1:1)

| Van (deze map) | Naar (Climb-Performance-Lab) |
|----------------|------------------------------|
| `intervalsMapFetch.js` | `src/utils/intervalsMapFetch.js` |
| `intervalsMapEnrich.js` | `src/utils/intervalsMapEnrich.js` |
| `intervalsMapFetch.test.js` | `src/__tests__/utils/intervalsMapFetch.test.js` |

## Handmatige integratie (twee bestaande bestanden)

### `src/utils/firestoreActivityMerge.js`

Direct na het blok dat `strava_map` beschermt, toevoegen:

```javascript
    const inIntervalsMap =
        incoming.intervals_map != null && String(incoming.intervals_map).trim() !== '';
    const exIntervalsMap =
        existing.intervals_map != null && String(existing.intervals_map).trim() !== '';
    if (exIntervalsMap && !inIntervalsMap) {
        out.intervals_map = existing.intervals_map;
    }
```

### `src/hooks/useDataHubIntervalsSync.js`

1. Import: `import { buildIntervalsMapEnrichmentUpdates } from '../utils/intervalsMapEnrich.js';`
2. `applyIntervalsMapEnrichmentToList` callback (zie `INTEGRATION.useDataHubIntervalsSync.md` in deze map).
3. Na Strava-enrich in **selected sync** en **fetch-range sync**: `applyIntervalsMapEnrichmentToList(...)` aanroepen.

Volledige referentie-hook staat in `useDataHubIntervalsSync.intervals_map.reference.js` (alleen diff/context, niet blind hele bestand overschrijven).

## Acceptatiecriteria

- [ ] Activiteit zonder `strava_map` krijgt na Intervals-sync `intervals_map` (Google-encoded polyline).
- [ ] Fetch: Intervals `GET .../activity/{id}/map`, fallback `streams?types=latlng`.
- [ ] Merge van Intervals-import wist bestaande `intervals_map` niet.
- [ ] `npm test -- --run src/__tests__/utils/intervalsMapFetch.test.js` slaagt.

## Cloud Agent-opdracht (copy-paste)

```
Repository: VCCharlie/Climb-Performance-Lab
Branch: cursor/cpl-intervals-map-578c (van main)

Implementeer intervals_map ZONDER eigen ontwerp:
1. Lees https://github.com/VCCharlie/Climbfinder-scraper/tree/cursor/cpl-performance-lab-sync-578c/docs/cpl-intervals-map-578c/README.md
2. Kopieer de drie bestanden 1:1 naar de paden in de tabel.
3. Pas firestoreActivityMerge.js en useDataHubIntervalsSync.js aan exact zoals README + INTEGRATION doc.
4. Run: npm test -- --run src/__tests__/utils/intervalsMapFetch.test.js
5. Commit, push, draft PR. Geen extra features.
```
