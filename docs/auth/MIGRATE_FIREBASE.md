# Migratie naar een nieuw Firebase-project (Native Firestore)

Gebruik dit als je van een oud project (bv. Datastore mode) naar een **nieuw** project gaat.

## 1. Nieuw project in Firebase Console

1. Project aanmaken → **Firestore** → **Native mode** (niet Datastore).
2. **Authentication** → Google → authorized domains: `vccharlie.github.io`, `localhost`.
3. Web-app registreren → kopieer `firebaseConfig`.

## 2. `firebase-config.js` op GitHub Pages

```bash
cp docs/auth/firebase-config.example.js docs/auth/firebase-config.js
```

Vul het **nieuwe** `projectId`, `apiKey`, enz. Commit/push naar `main` (of jouw deploy-flow voor Pages).

```js
climbLog: { useFirestore: true },
githubImport: { enabled: true, region: "europe-west1" },
strava: { enabled: true },
```

## 3. Firestore rules

Plak `docs/auth/firestore.rules.example` in Console → Firestore → Rules → publish.

## 4. Functions naar het nieuwe project

1. Pas **`.firebaserc`** aan:

   ```json
   { "projects": { "default": "JOUW_NIEUWE_PROJECT_ID" } }
   ```

2. Pas in **`.github/workflows/deploy-climbfinder-import-function.yml`** alle `--project climbfinder-scraper` aan naar je nieuwe id (of gebruik een GitHub secret `FIREBASE_PROJECT_ID`).

3. Service account + secrets in GitHub Actions (zie [GITHUB_IMPORT.md](./GITHUB_IMPORT.md)):
   - `FIREBASE_SERVICE_ACCOUNT` (JSON van deploy-SA in het **nieuwe** project)
   - `CLIMBFINDER_IMPORT_PAT`
   - `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`

4. Run workflow **Deploy Climbfinder import function**.

5. Handmatig `auth.allowed_emails` indien nodig:

   ```bash
   firebase functions:config:set auth.allowed_emails="jouw@email.com" --project JOUW_NIEUWE_PROJECT_ID
   ```

## 5. Strava

- Callback domain Strava-app: **`vccharlie.github.io`**
- `strava.redirect_uri`:  
  `https://vccharlie.github.io/Climbfinder-scraper/climbs/strava-callback.html`  
  (zie [STRAVA.md](./STRAVA.md))

## 6. Logboek / localStorage

Na merge van sprint-logboekcode: eerste keer Database openen met Firestore aan → bestaande **localStorage**-vinkjes worden eenmalig naar Firestore geüpload.

## 7. Controleren

| Check | Verwacht |
|--------|----------|
| Instellingen → geen Datastore-fout | Native Firestore + rules |
| Koppel Strava | Redirect naar `…/strava-callback.html` → terug naar Instellingen |
| Import één-klik | Geen `failed-precondition` op PAT |

Hard refresh (Ctrl+Shift+R) na elke Pages-deploy.
