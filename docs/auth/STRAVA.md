# Strava — koppelen & proef-sync

Automatisch **gedaan**-vinkjes op basis van **publieke** Strava-fietritten (`read`, `activity:read`). Sync **overschrijft** handmatige vinkjes voor gematchte klimmen.

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
  --project JOUW_PROJECT_ID
```

`redirect_uri` moet **byte-voor-byte** gelijk zijn aan wat Strava terugstuurt. Als je het weglaat, gebruikt de code dezelfde default als hierboven.

Optioneel: `strava.data_base_url` als JSON niet op raw GitHub staat.

## 3. Deploy

Workflow **Deploy Climbfinder import function** (deployt ook Strava), of:

```bash
firebase deploy --only \
  functions:getStravaConnectUrl,functions:stravaCompleteOAuth,functions:stravaDisconnect,functions:getStravaStatus,functions:stravaSyncTrial \
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

1. **Instellingen** → regio-dataset kiezen → **Koppel Strava** → na callback **Proef-sync (50 ritten)**.

Logboek bij match: `source: "strava"`, `stravaActivityId`, `matchCoverage`.

## 7. Migratie naar nieuw Firebase-project

Zie [MIGRATE_FIREBASE.md](./MIGRATE_FIREBASE.md).
