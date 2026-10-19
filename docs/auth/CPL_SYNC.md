# CPL (Climb Performance Lab) → FietsKlim logboek

Server-sync leest **routes uit CPL Firestore** (`strava_map` of `intervals_map`), matcht tegen de FietsKlim-klimdatabase en schrijft resultaten naar **`fietsklim_match`** op CPL-activiteiten (bron van waarheid). FietsKlim importeert die hits naar het logboek. Geen Strava rate limits tijdens deze sync.

Zie `docs/cpl-fietsklim-matching/README.md` voor het veldcontract.

## Vereisten

1. **Zelfde Google-account** in FietsKlim en in [Climb Performance Lab](https://github.com/VCCharlie/Climb-Performance-Lab) (CPL Auth uid ≠ FietsKlim uid; koppeling via **e-mail** of **google.com provider-id** in Firebase Auth).
2. **Routes in CPL**: Strava-enrich (`strava_map`) of Intervals map-backfill (`intervals_map`) op activiteiten.
3. **IAM op project `climb-performance-lab`** voor de Functions service account van `climb-database`:
   - `roles/datastore.viewer` (Firestore read)
   - `roles/datastore.user` (Firestore write op `activities` voor veld `fietsklim_match`)
   - `roles/firebaseauth.viewer` + `firebaseauth.users.get` (of **Firebase Authentication Admin** voor `getUserByEmail`)

   Service account: `climb-database@appspot.gserviceaccount.com` (App Engine default — wat 1st-gen Functions normaal gebruiken).

   **“CPL niet gekoppeld” terwijl IAM goed lijkt?** Dat is meestal **geen IAM-fout** maar `auth/user-not-found`: er staat geen gebruiker in **CPL → Firebase Authentication → Users** voor jouw mail. Log opnieuw in bij CPL en controleer die lijst. Als de gebruiker wél staat, redeploy `getCplStatus` (google-uid fallback) en kijk in FietsKlim-status naar `linkReason` / `linkHint`.

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
| `cplEnqueueFullSync` | Start server-sync (`datasetId: "__all__"`, optioneel `after` / `before` ms, `importOnly`, `forceRematch`) |
| `cplImportLogbookFromCpl` | Zelfde als full sync maar alleen import uit bestaande `fietsklim_match` (geen CPL-writes) |
| `getCplSyncJob` / `cplCancelSyncJob` | Status / annuleren |
| `cplSyncWorkerHttp` | Cloud Tasks worker (header `x-fietsklim-cpl-worker-secret`) |

## Logboek-velden

Bij match: `source: "cpl"`, `cplActivityId`, `cplActivityName`, …  
Als de CPL-activiteit een `strava_id` heeft, worden ook de bestaande Strava-logvelden gezet.

## UI

Instellingen → **Logboek sync**: bovenaan zie je **Performance Lab: gekoppeld / niet gekoppeld**. Koppeling = dezelfde **Google-mail** als Firebase Auth in project `climb-performance-lab` (geen aparte “koppel CPL”-knop).

Op **Instellingen → Logboek sync**: vul **ritdatum van/tot** in en kies expliciet **CPL**, **Intervals-map** (alleen `intervals_map` in CPL), of **Strava API** (`forceStravaApi` op `stravaEnqueueFullSync`). CPL/Intervals vereisen scope **hele database** + gekoppeld Performance Lab-account.

Zet `cpl.prefer_route_sync=false` in Functions-config om voor hele database terug te vallen op Strava API-sync.
