# CPL (Climb Performance Lab) → FietsKlim logboek

Server-sync leest **routes uit CPL Firestore** (`strava_map` of `intervals_map`) en matcht tegen de FietsKlim-klimdatabase. Geen Strava rate limits tijdens deze sync.

## Vereisten

1. **Zelfde Google-account** in FietsKlim en in [Climb Performance Lab](https://github.com/VCCharlie/Climb-Performance-Lab) (CPL Auth uid ≠ FietsKlim uid; koppeling via e-mail).
2. **Routes in CPL**: Strava-enrich (`strava_map`) of Intervals map-backfill (`intervals_map`) op activiteiten.
3. **IAM op project `climb-performance-lab`** voor de Functions service account van `climb-database`:
   - `roles/datastore.viewer` (Firestore read)
   - `roles/firebaseauth.viewer` + `firebaseauth.users.get` (of **Firebase Authentication Admin** voor `getUserByEmail`)

   Service account: `climb-database@appspot.gserviceaccount.com` (of de runtime SA van je Functions).

## Firebase Functions config (`climb-database`)

```bash
firebase functions:config:set \
  cpl.project_id="climb-performance-lab" \
  cpl.worker_secret="GENEREER_LANG_GEHEIM"
```

Optioneel: `cpl.worker_url` als de worker-URL afwijkt.

## Cloud Tasks queue

```bash
gcloud tasks queues create cpl-sync \
  --location=europe-west1 \
  --project=climb-database
```

IAM: runtime SA → **Cloud Tasks Enqueuer** op `climb-database`.

## Callable / HTTP

| Functie | Doel |
|---------|------|
| `getCplStatus` | CPL gekoppeld? laatste sync, actieve job |
| `cplEnqueueFullSync` | Start server-sync (`datasetId: "__all__"`, optioneel `after` / `before` ms) |
| `getCplSyncJob` / `cplCancelSyncJob` | Status / annuleren |
| `cplSyncWorkerHttp` | Cloud Tasks worker (header `x-fietsklim-cpl-worker-secret`) |

## Logboek-velden

Bij match: `source: "cpl"`, `cplActivityId`, `cplActivityName`, …  
Als de CPL-activiteit een `strava_id` heeft, worden ook de bestaande Strava-logvelden gezet.

## UI

Instellingen → **Logboek sync**: bovenaan zie je **Performance Lab: gekoppeld / niet gekoppeld**. Koppeling = dezelfde **Google-mail** als Firebase Auth in project `climb-performance-lab` (geen aparte “koppel CPL”-knop).

Scope **hele database** → primaire server-knop **CPL · Intervals→Strava** wanneer gekoppeld. Routes: eerst `intervals_map`, anders `strava_map`. Zonder CPL valt server-sync terug op **Strava API**. Ritdatum **van/tot** op dezelfde pagina.

Zet `cpl.prefer_route_sync=false` in Functions-config om voor hele database terug te vallen op Strava API-sync.
