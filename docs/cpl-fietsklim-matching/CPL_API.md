# FietsKlim ↔ CPL API (matching, journal, handmatig linken)

Project **climb-database** (Firebase Functions, regio `europe-west1`). Authenticatie: ingelogde Google-gebruiker (zelfde allowlist als overige FietsKlim-callables).

Project **climb-performance-lab** (CPL Firestore): data wordt door Functions geschreven met service account `climb-database@appspot.gserviceaccount.com` (IAM: read + write).

---

## Firestore-contract (CPL)

| Locatie | Veld / collectie | Doel |
|---------|------------------|------|
| `activities/{id}` | `fietsklim_match` | Engine-hits per rit |
| `activities/{id}` | `fietsklim_user_links[]` | Handmatige koppelingen |
| `users/{cplOwnerId}/fietsklim_journal/{datasetId__climbId}` | journal | Teller, eerste/laatste ritdatum, `ascents[]` |

Schema’s: `functions/fietsklimMatchSchema.js`, `fietsklimUserLinksSchema.js`, `fietsklimJournalSchema.js`.

---

## Callable: `cplListActivitiesForLink`

Lijst CPL-ritten voor de ingelogde gebruiker (ook **zonder** route — handmatig linken).

**Request (JSON):**

```json
{
  "after": 1717200000000,
  "before": 1719791999999,
  "pageSize": 40,
  "cursor": { "startAfterDate": "2024-06-01T…", "startAfterId": "abc123" }
}
```

`after` / `before`: optioneel, epoch ms (zelfde als logboek-sync). `cursor`: voor volgende pagina.

**Response:**

```json
{
  "ok": true,
  "cplOwnerId": "firebaseUidInCpl",
  "activities": [
    {
      "id": "activityDocId",
      "title": "Morning Ride",
      "date": "2024-06-15",
      "hasRoute": true,
      "engineHitCount": 2,
      "userLinkCount": 0
    }
  ],
  "cursor": null,
  "completed": true
}
```

**Client (Firebase Web):**

```javascript
const fn = firebase.app().functions("europe-west1").httpsCallable("cplListActivitiesForLink");
const { data } = await fn({ after: null, before: null, pageSize: 35 });
```

---

## Callable: `cplLinkClimbOnActivity`

Handmatig: klim koppelen aan één CPL-rit → `fietsklim_user_links` + journal-merge + FietsKlim `climbLog`.

**Request:**

```json
{
  "cplActivityId": "CPL_FIRESTORE_DOC_ID",
  "datasetId": "cf-l315-belgian-luxembourg",
  "climbId": "12345",
  "climbName": "Côte de…",
  "note": "optioneel"
}
```

**Response:**

```json
{
  "ok": true,
  "activityId": "…",
  "datasetId": "…",
  "climbId": "…",
  "journalEntries": 1,
  "matchesWritten": 1
}
```

**Fouten:** `not-found` (activiteit), `permission-denied` (ownerId ≠ jouw CPL-account), `failed-precondition` (geen CPL-koppeling).

---

## Callable: sync (bestaand)

| Callable | Gebruik |
|----------|---------|
| `getCplStatus` | Gekoppeld? actieve job |
| `cplEnqueueFullSync` | Match + journal + logboek (`importOnly`, `forceRematch`) |
| `cplImportLogbookFromCpl` | Alleen import uit CPL (geen nieuwe matches) |

---

## CPL-app: zelfde data zonder FietsKlim-UI

### Optie A — Firestore direct (ingelogde gebruiker)

```javascript
import { doc, setDoc, arrayUnion } from "firebase/firestore";

// Handmatige link (zelfde shape als buildUserLink)
await setDoc(
  doc(db, "activities", activityId),
  {
    fietsklim_user_links: arrayUnion({
      datasetId: "cf-l…",
      climbId: "…",
      climbName: "…",
      linked_at: new Date().toISOString(),
      engine_status: "unverified",
    }),
  },
  { merge: true }
);
```

Daarna journal bijwerken met dezelfde merge als `applyActivitiesToCplJournal` in `functions/cplClimbJournal.js` (kopieer portable modules).

### Optie B — FietsKlim Callable vanuit CPL

Als de CPL-webapp het **climb-database** Firebase-project gebruikt voor Functions (of HTTP proxy):

1. Gebruiker logt in met Google (zelfde account).
2. Roep `cplLinkClimbOnActivity` aan met `cplActivityId` + FietsKlim `datasetId` / `climbId`.

`datasetId` / `climbId` komen uit de FietsKlim-klimdatabase (`docs/climbs/data/*.json`), niet uit Climbfinder-slugs alleen.

### Optie C — Alleen journal in CPL, import later

1. Schrijf `fietsklim_user_links` + update journal lokaal in CPL.
2. Gebruiker start in FietsKlim `cplImportLogbookFromCpl` of `cplEnqueueFullSync` met `importOnly: true`.

---

## FietsKlim UI

- **Instellingen / Logboek** → link naar [`docs/climbs/link-ride.html`](../climbs/link-ride.html): rit kiezen, klim zoeken, `cplLinkClimbOnActivity`.

---

## IAM-checklist (CPL-project)

- `datastore.viewer` + `datastore.user` voor FietsKlim Functions SA
- Firestore rules: gebruiker mag eigen `activities` en `users/{uid}/fietsklim_journal` schrijven
- Composite index `activities`: `ownerId` ASC, `date` DESC (datumbereik)

Zie ook [CPL_SYNC.md](../auth/CPL_SYNC.md) en [README.md](./README.md).
