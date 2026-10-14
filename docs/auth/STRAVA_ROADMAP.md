# Strava — fase na Phase 2 (volledige history & privé)

Status (in de app): privé-toggle, **Ververs Strava-toestemming**, proef/volledige sync, **`__all__`** database-scope, wishlist-clear bij match, **checkpoint-hervatting** (client: `sessionStorage` + auto-resume op instellingen na terugkeer, Screen Wake Lock tijdens sync). **Nog open:** echte achtergrond-sync zonder tab open (Scheduler/queue + Functions-deploy), snellere spatial index over alle klimmen.

## Doel (product)

1. **Hele Strava-history** doorlopen (paginatie API), niet alleen 50 ritten.
2. **Optioneel privé-activiteiten** (instellingen: schuifje/checkbox).
3. Per match: **gedaan** aan, **wishlist** uit als die stond.
4. Meerdere **datasets** (alle regio’s in `data/index.json` of gebruikerskeuze), niet alleen één proef-dataset.

## Technisch

### Scopes & opnieuw koppelen

| Modus | Strava scopes |
|--------|----------------|
| Alleen publiek | `read`, `activity:read` (huidige) |
| Inclusief privé | + `activity:read_all` |

- Voorkeur opslaan in Firestore: `users/{uid}/prefs/strava` → `{ includePrivate: boolean, datasetIds: string[], lastFullSyncAt, … }`.
- Bij wijziging naar privé: **Loskoppelen + opnieuw Koppel Strava** zodat Strava de extra scope vraagt (`approval_prompt=force` of disconnect flow).

### Backend

- Nieuwe callable bv. `stravaSyncFull` (of uitbreiden trial):
  - Haal activities met `page`/`per_page` tot leeg (respect rate limits; evt. checkpoint in Firestore).
  - Filter `type === Ride` (en evt. VirtualRide).
  - Zelfde bbox/polyline-match als `functions/strava.js` nu.
  - Batch-writes: `done: true`, `source: "strava"`, `wishlist: false` bij match.
- Timeout: trial gebruikt al 300s; volledige sync kan **meerdere aanroepen** nodig hebben (cursor `before` / laatste activity-id in prefs).
- Optioneel: Cloud Scheduler + queue (later) voor zeer grote accounts.

### Frontend (`settings.html` / `strava-sync.js`)

- Toggle **Publieke + privé activiteiten** (disabled tot scope OK; hint bij scope mismatch).
- Knop **Volledige sync** (met progress: “pagina 3, 450 ritten, 12 matches…”).
- Dataset: multi-select of “alle datasets in index” (zwaar — bbox per dataset laden).
- Status: laatste sync-tijd, aantal verwerkte ritten, fouten.

### Gedrag (afgesproken)

- Sync **overschrijft** handmatige **gedaan** voor gematchte klimmen (zoals nu).
- Wishlist op match: **verwijderen** (niet alleen `done`).
- Geen match: logboek ongewijzigd.

### Deploy / config

Zie [`STRAVA.md`](STRAVA.md). Geen wijziging callback-domein. Na Functions-deploy: zelfde GitHub workflow + `climb-database` project.

## Volgorde implementatie (voorstel)

1. Firestore prefs + UI toggle (zonder sync) + scope-detectie in `getStravaStatus`.
2. `stravaSyncFull` met paginatie + checkpoint (één dataset).
3. Wishlist-clear in batch writes.
4. Multi-dataset loop + UI.
5. Privé scope + filter op activity `private` flag wanneer toggle uit.
