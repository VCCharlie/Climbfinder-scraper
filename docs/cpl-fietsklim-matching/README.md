# FietsKlim matching op CPL-activiteiten

Climb-matches worden opgeslagen op **CPL Firestore** (`climb-performance-lab`):

- **Rit:** `activities/{id}` → `fietsklim_match` (engine) + `fietsklim_user_links` (handmatig)
- **Logboek (CPL):** `users/{cplOwnerId}/fietsklim_journal/{datasetId__climbId}` → teller, eerste/laatste ritdatum, `ascents[]`
- **Logboek (FietsKlim):** import uit CPL-journal naar `users/{fietsklimUid}/climbLog`

Portable kopie voor CPL-repo: [portable/README.md](./portable/README.md).

**API & CPL-app integratie:** [CPL_API.md](./CPL_API.md) · UI: [link-ride.html](../climbs/link-ride.html).

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

## Journal-velden (`fietsklim_journal`)

| Veld | Betekenis |
|------|-----------|
| `ascent_count` | Unieke CPL-activiteiten met deze klim |
| `first_claimed_at` | **Oudste** rit (epoch ms) — “claim”-datum in FietsKlim (`doneUpdatedAt`, `cplFirstClaimedAt`) |
| `last_ascent_at` | Meest recente rit — Strava/CPL-link in UI |
| `ascents[]` | `{ activity_id, activity_start_at, source: engine\|user, coverage?, … }` |

Schema: `functions/fietsklimJournalSchema.js`, aggregatie: `functions/cplClimbJournal.js`.

## Wie schrijft?

1. **FietsKlim CPL-sync** — match op activiteit → journal op CPL → import naar FietsKlim logboek.
2. **Callable `cplLinkClimbOnActivity`** — handmatige klim op een CPL-rit (`datasetId`, `climbId`, `cplActivityId`).
3. **Climb Performance Lab** (optioneel): zelfde schema’s uit `docs/cpl-fietsklim-matching/portable/`.

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
