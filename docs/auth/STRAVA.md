# Strava — koppelen & proef-sync (Fase A/B)

Automatisch **gedaan**-vinkjes op basis van **publieke** Strava-fietritten (geen `activity:read_all`). Strava-sync **overschrijft** handmatige vinkjes voor gematchte klimmen.

## 1. Strava API-app

1. [Strava → Settings → My API Application](https://www.strava.com/settings/api) → **Create App**.
2. **Authorization Callback Domain:** `europe-west1-climb-database.cloudfunctions.net` (Firebase-project **`climb-database`**).
3. Noteer **Client ID** en **Client Secret**.

## 2. Firebase Functions config

**Optie A — GitHub Secrets (aanbevolen):** repo **Settings → Secrets → Actions** → `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`. De deploy-workflow zet `strava.*` automatisch.

**Optie B — handmatig:**

```bash
firebase functions:config:set \
  strava.client_id="YOUR_CLIENT_ID" \
  strava.client_secret="YOUR_CLIENT_SECRET" \
  strava.redirect_uri="https://europe-west1-climb-database.cloudfunctions.net/stravaOAuthCallback" \
  strava.site_return_url="https://vccharlie.github.io/Climbfinder-scraper/climbs/settings.html" \
  --project climb-database
```

Optioneel: `strava.data_base_url` als JSON niet op raw GitHub staat (Firebase Storage URL-prefix).

## 3. Deploy (verplicht na code-merge)

Zonder deploy blijft de site **`internal`** of **`not-found`** geven — de browser praat dan nog niet met `getStravaConnectUrl`.

Workflow **Deploy Climbfinder import function** deployt ook Strava-callables, of handmatig:

```bash
firebase deploy --only functions:getStravaConnectUrl,functions:stravaOAuthCallback,functions:stravaDisconnect,functions:getStravaStatus,functions:stravaSyncTrial \
  --project climb-database
```

## 4. Firestore rules

Voeg toe (client mag **geen** tokens lezen):

```
match /users/{userId}/integrations/{doc} {
  allow read, write: if false;
}
match /stravaOAuthStates/{stateId} {
  allow read, write: if false;
}
```

`climbLog` blijft: alleen eigen `uid` read/write.

## 5. Site-scripts

Op **`climbs/index.html`** moet **`firebase-functions-compat.js`** geladen zijn (zelfde versie als app/auth), anders: `functions is not a function` bij Koppel Strava.

## 6. Gebruik op de site

1. **Instellingen** (`climbs/settings.html`) → **Koppel Strava** (OAuth keert hier terug).
2. Na terugkeer: **Proef-sync (50 ritten · nl-limburg)** — matcht publieke ritten tegen `nl-limburg.json` (Policy: ~65% overlap, 45 m buffer).

Logboekvelden bij Strava-match: `source: "strava"`, `stravaActivityId`, `matchCoverage`.

## 7. Volgende fases (nog niet gebouwd)

- Volledige history-backfill + alle regio’s uit `index.json`
- Strava webhooks / dagelijkse incrementele sync
- UI-filter “alleen Strava / alleen handmatig”
