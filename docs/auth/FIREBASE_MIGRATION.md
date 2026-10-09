# Firebase-project `climb-database`

FietsKlim (logboek, Strava, import-callables) gebruikt **GCP/Firebase-project `climb-database`** (Firestore **Standard / Native**, regio **eur3**).

Het oude project **`climbfinder-scraper`** (Datastore mode) wordt **niet** meer gebruikt voor Auth/Firestore/Functions.

Console: [Firestore rules](https://console.firebase.google.com/u/0/project/climb-database/firestore/databases/-default-/security/rules)

---

## Jouw checklist (Firebase + GCP)

### Eenmalig — Firebase Console (`climb-database`)

- [ ] **Authentication → Sign-in method:** Google **Enabled**
- [ ] **Authentication → Settings → Authorized domains:** `localhost`, `vccharlie.github.io` (+ eigen domein)
- [ ] **Project settings → Your apps:** Web-app (`</>`) aangemaakt → **`firebaseConfig` gekopieerd** naar `docs/auth/firebase-config.js`
- [ ] **Firestore → Rules:** inhoud van `docs/auth/firestore.rules.example` gepubliceerd (production)
- [ ] **Firestore:** database `(default)`, location **eur3** — al gedaan als je rules ziet
- [ ] (Optioneel later) **Storage** + rules uit `storage.rules.example` als `useStorage: true`

### Eenmalig — GitHub repo secrets

Vervang de service account van het **oude** project:

- [ ] **`FIREBASE_SERVICE_ACCOUNT`:** JSON-sleutel van een **nieuwe** deploy service account in **`climb-database`** (niet `climbfinder-scraper`)
- [ ] **`CLIMBFINDER_IMPORT_PAT`:** ongewijzigd (PAT op GitHub-repo)
- [ ] **`STRAVA_CLIENT_ID`** / **`STRAVA_CLIENT_SECRET`:** ongewijzigd, maar **Strava-app** moet nieuwe callback-URL toestaan (zie Strava)

### Eenmalig — GCP IAM (`climb-database`)

Zie `docs/auth/GITHUB_IMPORT.md` (project-id overal **`climb-database`**):

- [ ] Deploy service account: o.a. **Firebase Admin** of **Cloud Functions Admin** + **Cloud Build**, **Service Account User** op **`climb-database@appspot.gserviceaccount.com`**
- [ ] Indien nodig **Service Account User** op **`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`**
- [ ] (Optioneel) **Artifact Registry Administrator** als deploy cleanup 403 geeft
- [ ] **App Engine** app aanmaken in regio **europe-west** (vereist voor 1st Gen Functions) — [App Engine start](https://console.cloud.google.com/appengine/start?project=climb-database)
- [ ] APIs enabled (workflow probeert dit): Cloud Functions, Cloud Build, Compute, App Engine, Firebase Extensions

### Deploy Functions + config

- [ ] GitHub Actions: **Deploy Climbfinder import function** (workflow_dispatch) — zet `github.pat` + optioneel `strava.*` op **`climb-database`**
- [ ] Controleer in Firebase → **Functions** dat callables in **`europe-west1`** staan
- [ ] Strava **Authorization Callback Domain:** `europe-west1-climb-database.cloudfunctions.net` (of `vccharlie.github.io` als je later Pages-callback gebruikt)
- [ ] Strava **redirect URI** moet exact matchen met `strava.redirect_uri` in Functions config (zie `docs/auth/STRAVA.md`)

### Site-config

- [ ] `docs/auth/firebase-config.js`: volledige `firebase`-object + `climbLog: { useFirestore: true }` na succesvolle rules-test
- [ ] Push naar `main` → GitHub Pages → hard refresh Database / Instellingen
- [ ] Test: inloggen, vinkje op kaart, refresh → blijft staan (Firestore)
- [ ] Test: Instellingen → Strava status (geen Datastore-fout meer)

### Oud project `climbfinder-scraper` (optioneel opschonen)

- [ ] Geen secrets meer nodig voor FietsKlim — oude `FIREBASE_SERVICE_ACCOUNT` key **intrekken/verwijderen**
- [ ] Functions in oud project uitzetten of laten staan (niet meer gebruikt)
- [ ] Geen climb-log data in oud project (Datastore) — logboek start **leeg** in `climb-database`

### Nieuwe Strava-tool repo (later)

- [ ] Zelfde **`climb-database`** project + zelfde Google login → gedeeld `climbLog` / integrations
- [ ] Of apart project + sync-callable (zie eerdere architectuur-notities)

---

## Snelle links

| Wat | URL |
|-----|-----|
| Firebase project | https://console.firebase.google.com/project/climb-database |
| Firestore rules | https://console.firebase.google.com/project/climb-database/firestore/rules |
| Functions | https://console.firebase.google.com/project/climb-database/functions |
| IAM | https://console.cloud.google.com/iam-admin/iam?project=climb-database |
| App Engine | https://console.cloud.google.com/appengine/start?project=climb-database |
