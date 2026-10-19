# FietsKlim matching op CPL-activiteiten

Climb-matches worden opgeslagen op **CPL Firestore** (`climb-performance-lab`), veld `fietsklim_match` op `activities/{id}`. FietsKlim **importeert** die hits naar `users/{uid}/climbLog`.

## Veld `fietsklim_match`

| Veld | Betekenis |
|------|-----------|
| `schema_version` | Contractversie (nu `1`) |
| `matcher_version` | FietsKlim matcher build (bijv. `2026.10.1`) |
| `polyline_fingerprint` | Hash van de gebruikte summary-polyline |
| `climb_index_revision` | `index.json` revisie (dataset-wijzigingen) |
| `route_map_policy` | `default` \| `intervals_only` |
| `computed_at` | ISO-timestamp |
| `hits[]` | `{ datasetId, climbId, climbName, coverage }` |

Bron in code: `functions/fietsklimMatchSchema.js`.

## Wie schrijft?

1. **FietsKlim CPL-sync** (`runCplSyncBatch` → `ensureFietsklimMatchOnCplActivity` in `functions/cplMatchOnCpl.js`): leest route uit CPL, matcht tegen alle regio’s, schrijft `fietsklim_match` terug naar CPL, schrijft logboek in FietsKlim.
2. **Climb Performance Lab** (optioneel, zelfde contract): portable matcher — zie snippet hieronder.

Herberekening alleen als polyline-fingerprint, index-revisie, policy of schema veranderen (of `forceRematch`).

## FietsKlim import-only

Callable `cplEnqueueFullSync` met payload:

```json
{ "datasetId": "__all__", "importOnly": true }
```

Leest bestaande `fietsklim_match` van CPL, **geen** nieuwe CPL-writes (handig als CPL-app al gematcht heeft).

## IAM (climb-performance-lab)

Naast read (`datastore.viewer`) heeft `climb-database@appspot.gserviceaccount.com` **Firestore write** nodig voor `activities` merge:

- `roles/datastore.user` (of een custom role met `firestore.documents.update` op `activities/*`)

Zie ook `docs/auth/CPL_SYNC.md`.

## CPL-app: minimale Node-snippet

```javascript
// Zelfde velden als fietsklimMatchSchema.buildFietsklimMatchPayload
await firestore.collection("activities").doc(activityId).set(
  { fietsklim_match: payload },
  { merge: true }
);
```

Matcher-logica: hergebruik `matchStoredActivitiesToClimbs` + `DETECTION_MATCH_OPTS` uit FietsKlim `functions/syncPipeline.js` en klim-JSON van GitHub Pages (`index.json` + per-regio datasets).
