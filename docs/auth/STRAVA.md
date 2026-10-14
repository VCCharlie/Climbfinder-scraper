# Strava — koppelen & proef-sync

Automatisch **gedaan**-vinkjes op basis van Strava-fietritten **buiten** (geen trainer, geen VirtualRide/Zwift/FulGaz; korte ritten &lt; 800 m worden overgeslagen). Een match telt alleen als je de klim **beklimt in de richting van de database** (voet → top langs de polyline; **afdaling de andere kant op** matcht niet). Standaard **publiek** (`read`, `activity:read`); optioneel **privé** (`activity:read_all`) via Instellingen. Sync zet **gedaan** aan, haalt **wishlist** weg bij match, en **overschrijft** handmatige gedaan-vinkjes voor gematchte klimmen.

## Callback op `vccharlie.github.io` (verplicht bij gedeelde Strava-app)

Strava staat **één Authorization Callback Domain** toe. Als die **`vccharlie.github.io`** is, mag de redirect **niet** naar `cloudfunctions.net`.

Flow:

1. **Koppel Strava** → Strava authoriseert → redirect naar  
   `https://vccharlie.github.io/Climbfinder-scraper/climbs/strava-callback.html?code=…&state=…`
2. Die pagina (ingelogd met Google) roept **`stravaCompleteOAuth`** aan → tokens in Firestore.
3. Terug naar **Instellingen** met `?strava=connected`.

In de Strava-app (My API Application):

- **Authorization Callback Domain:** `vccharlie.github.io`
- De **exacte** redirect URI in Functions moet overeenkomen (zie config hieronder).

Andere GitHub-projecten op hetzelfde domein kunnen een **eigen** pad gebruiken (bv. `…/ander-repo/strava-callback.html`) zolang het domein `vccharlie.github.io` blijft.

## 1. Strava API-app

1. [Strava → Settings → My API Application](https://www.strava.com/settings/api).
2. **Authorization Callback Domain:** `vccharlie.github.io`
3. Noteer **Client ID** en **Client Secret**.

## 2. Firebase Functions config

**Optie A — GitHub Secrets:** `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`. Workflow **Deploy Climbfinder import function** zet `strava.*`.

**Optie B — handmatig** (pas `--project` aan naar je **nieuwe** Firebase-project):

```bash
firebase functions:config:set \
  strava.client_id="YOUR_CLIENT_ID" \
  strava.client_secret="YOUR_CLIENT_SECRET" \
  strava.redirect_uri="https://vccharlie.github.io/Climbfinder-scraper/climbs/strava-callback.html" \
  strava.site_return_url="https://vccharlie.github.io/Climbfinder-scraper/climbs/settings.html" \
  strava.data_base_url="https://vccharlie.github.io/Climbfinder-scraper/climbs/data" \
  --project JOUW_PROJECT_ID
```

`redirect_uri` moet **byte-voor-byte** gelijk zijn aan wat Strava terugstuurt. Als je het weglaat, gebruikt de code dezelfde default als hierboven.

**`strava.data_base_url`:** GitHub Pages-pad naar `data/` (standaard in code + deploy-workflow). Raw `githubusercontent.com` geeft voor deze dataset vaak **404** — gebruik Pages niet raw.

## 3. Deploy

**Privé-scope blijft rood?** Na OAuth slaat de app `activity:read_all` op (ook als Strava de scope-string anders formatteert). Draai de nieuwste Functions-deploy; open Instellingen opnieuw — vaak geen tweede Strava-login nodig.

Na elke Strava-wijziging in `functions/strava.js`: workflow **Deploy Climbfinder import function** op `main` (deployt ook `setStravaSyncPrefs`, `stravaSyncFull`, …). Zonder deploy: privé-toggle kan “interne serverfout” geven — de site bewaart de voorkeur dan lokaal tot je opnieuw **Koppel Strava** klikt (na deploy).

Workflow **Deploy Climbfinder import function** (deployt ook Strava), of:

```bash
firebase deploy --only \
  functions:getStravaConnectUrl,functions:setStravaSyncPrefs,functions:stravaCompleteOAuth,functions:stravaDisconnect,functions:getStravaStatus,functions:stravaSyncTrial,functions:stravaSyncFull \
  --project JOUW_PROJECT_ID
```

(`stravaOAuthCallback` op cloudfunctions.net is **legacy** — niet nodig met GitHub Pages callback.)

## 4. Firestore (Native mode)

Strava-tokens en OAuth-state staan in Firestore (`users/…/integrations/strava`, `stravaOAuthStates`). Vereist **Cloud Firestore Native mode** in je Firebase-project — zie [SETUP.md](./SETUP.md).

## 5. Site-config

In `firebase-config.js` (optioneel, voor andere host/pad):

```js
strava: {
  enabled: true,
  oauthCallbackUrl: "https://vccharlie.github.io/Climbfinder-scraper/climbs/strava-callback.html",
  settingsUrl: "https://vccharlie.github.io/Climbfinder-scraper/climbs/settings.html",
  region: "europe-west1", // zelfde als Functions
},
```

`climbs/settings.html` moet **firebase-functions-compat.js** laden.

## 6. Gebruik

1. **Instellingen** → optioneel **Privé-activiteiten** aan (daarna opnieuw koppelen als Strava extra scope vraagt).
2. **Hele database** of één regio-dataset kiezen → **Koppel Strava** → **Proef-sync** of **Volledige history sync** (`datasetId: "__all__"` = alle regio’s uit `index.json`; history in batches).

Voorkeuren: Firestore `users/{uid}/prefs/strava` → `{ includePrivate }`.

Logboek bij match: `done: true`, `wishlist: false`, `source: "strava"`, `stravaActivityId`, `stravaActivityStartAt` (epoch-ms, Strava `start_date_local`), …

**Route-match (strak):** ~**82%** van de klim binnen **28 m** van de GPS-track, begin **en** eind binnen **~45 m**, gemiddelde sample-afstand **≤ 58 m**, rijrichting voet→top. Strava-polylines worden gesplitst bij GPS-**spikes** (&gt; **350 m** tussen opeenvolgende punten) zodat een rechte “teleport”-lijn geen match 7 km verderop geeft. Detail-activiteit (`map.polyline` indien aanwezig) i.p.v. alleen summary. Alleen **buitenritten** (geen VirtualRide/trainer).

**Datumfilter (Instellingen):** velden *Ritdatum van/tot* → Strava `after`/`before` op alle sync-knoppen (proef + volledige history). Leeg = geen datumfilter (proef = laatste 50 ritten).

Callable **`stravaCleanupLogMatches`** ruimt indoor + losse matches op (zelfde match-engine). Laatste sync-run: `lastSyncSummary.matches` (max 120).

### Phase 3 — server-sync (parallel aan browser-loop)

Na deploy staan extra callables live: **`stravaEnqueueFullSync`**, **`getStravaSyncJob`**, **`stravaCancelSyncJob`**, task worker **`stravaSyncWorker`** (Firebase Task Queue, ~22 s tussen batches).

| `firebase-config.js` → `strava` | Effect |
|---------------------------------|--------|
| `backgroundSync: false` (default) | **Volledige history sync** = browser-loop (`stravaSyncFull`), zoals nu |
| `showServerSyncBeta: true` | Extra knop **Volledige sync (server, beta)** → enqueue; tab mag dicht |
| `backgroundSync: true` | Standaardknop volledige sync gebruikt de server-queue (cutover) |

**Eén sync tegelijk:** tijdens een actieve server-job (`queued`/`running`) weigert `stravaSyncFull` (geen gedeelde cursor corruptie).

**Firestore rules:** voeg `users/{uid}/stravaSyncJobs/{jobId}` toe (read eigen user) — zie `docs/auth/firestore.rules.example`.

**GCP:** workflow schakelt **Cloud Tasks API** in; eerste deploy van `stravaSyncWorker` maakt de task queue aan. Bij enqueue-fouten: Functions-logs `stravaSyncWorker` / IAM Cloud Tasks Enqueuer op runtime-SA.

Zie ook [`STRAVA_ROADMAP.md`](./STRAVA_ROADMAP.md).

## 7. Migratie naar nieuw Firebase-project

Zie [MIGRATE_FIREBASE.md](./MIGRATE_FIREBASE.md).
