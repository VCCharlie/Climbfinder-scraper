# Inloggen (persoonlijk gebruik)

De hele site onder `docs/` is afgeschermd met **Google-inloggen**. Alleen adressen in `allowedEmails` (standaard `vr.deruiter@gmail.com`) krijgen toegang.

## Nieuw Firebase-project (migratie)

Als je een **nieuw** project gebruikt (bv. van Datastore mode af): **[MIGRATE_FIREBASE.md](./MIGRATE_FIREBASE.md)**.

## 1. Firebase-project (eenmalig)

1. Ga naar [Firebase Console](https://console.firebase.google.com/) → **Project toevoegen**.
2. **Authentication** → **Sign-in method** → **Google** inschakelen.
3. **Authentication** → **Settings** → **Authorized domains**:
   - `localhost` (lokaal testen)
   - Jouw GitHub Pages-host, bv. `vccharlie.github.io`
   - Eventueel eigen domein
4. **Project settings** → **Your apps** → Web-app (`</>`) toevoegen → kopieer `firebaseConfig`.

## 2. Config in deze repo

```bash
cp docs/auth/firebase-config.example.js docs/auth/firebase-config.js
```

Vul in `firebase-config.js` je `apiKey`, `authDomain`, `projectId`, enz.

**GitHub Pages:** dit bestand moet **wel** op de gepubliceerde site staan (Firebase web keys zijn bedoeld om public te zijn). Je kunt het committen na invullen, of via een deploy-stap toevoegen. Het staat in `.gitignore` zolang je lokaal test; voor Pages: tijdelijk committen of `.gitignore`-regel verwijderen.

## Kaart blijft leeg na login?

1. **`useStorage` moet `false` zijn** zolang JSON op GitHub Pages staat (jouw config is goed).
2. **JSON op de live site:** open in de browser (ingelogd):
   - `…/climbs/data/index.json`
   - `…/climbs/data/nl-limburg.json`  
   Krijg je **404**? Merge/push dan de branch met `docs/climbs/data/*.json` naar `main` en wacht op Pages-deploy.
3. **F12 → Network:** filter op `index.json` / `nl-limburg.json` — status moet **200** zijn.
4. **Hard refresh** (Ctrl+Shift+R) na deploy van de nieuwste `app.js` / `gate.js`.
5. **`storageBucket`:** mag `….appspot.com` of `….firebasestorage.app` zijn; alleen relevant als `useStorage: true`.

## 3. Lokaal testen

```bash
cd docs && python3 -m http.server 8765
```

Open `http://localhost:8765/climbs/index.html` — voeg `localhost` toe als authorized domain.

## Belangrijk: JSON-bestanden op GitHub Pages

De **HTML** is afgeschermd, maar URLs zoals  
`https://…github.io/…/climbs/data/fr-alps.json`  
blijven **direct downloadbaar** zolang ze op GitHub Pages staan. Iemand die de URL kent, hoeft niet in te loggen.

**Echte afscherming van de dataset (aanbevolen voor Climbfinder-data):**

1. Upload JSON naar **Firebase Storage** (`climbs/data/*.json`).
2. Zet in `firebase-config.js`: `"useStorage": true`.
3. Deploy regels uit `storage.rules.example` (Storage → Rules):

   ```
   allow read: if request.auth != null
     && request.auth.token.email == 'vr.deruiter@gmail.com';
   ```

4. Optioneel: verwijder grote JSON uit `docs/climbs/data/` op Pages (alleen `index.json` stub + loader).

**Alternatief zonder Firebase Storage:** [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) voor je **hele domein** (Google login + e-mailbeleid) — sterkste optie voor statische GitHub/custom hosting.

## 4. Strava (optioneel)

Zie **[STRAVA.md](./STRAVA.md)** — Strava koppelen + proef-sync met dataset uit `index.json`.

## 5. Klim-logboek (Fase 1 — handmatig “gedaan”)

Op **FietsKlim Database** (`climbs/index.html`) kun je klimmen afvinken. Data staat per Google-account:

- **Firestore** (aanbevolen): `users/{uid}/climbLog/{datasetId__climbId}`
- **Fallback:** `localStorage` in de browser als Firestore niet bereikbaar is

### Firestore eenmalig inschakelen (Native mode)

Het logboek gebruikt de **Firebase-web-SDK** → dat vereist **Cloud Firestore in Native mode** (standaard in Firebase Console).

1. Firebase Console → **Build** → **Firestore Database**.
2. Bij **eerste** aanmaken: kies **Firestore in Native mode** — **niet** “Cloud Datastore mode”.
3. **Rules** → plak `docs/auth/firestore.rules.example` (alleen eigen `uid` mag lezen/schrijven).
4. In `firebase-config.js`:

   ```js
   climbLog: { useFirestore: true },
   ```

Na deploy: hard refresh. Vinkjes in de lijst, filter **Nog niet gedaan / Al gedaan**, groene stippen op de kaart.

#### Melding “Datastore mode” / alleen Google Cloud Console?

Dan staat het project op **Firestore in Datastore mode** (legacy, voor App Engine). Die database werkt **niet** met `firebase.firestore()` op de website.

| Optie | Wat |
|--------|-----|
| **A — Logboek zonder Firestore** | Zet `climbLog: { useFirestore: false }` → vinkjes in **localStorage** (per browser, geen sync telefoon ↔ pc). Werkt meteen. |
| **B — Nieuw Firebase-project** | Nieuw project → Firestore **Native mode** → zelfde `firebaseConfig` in `firebase-config.js` (Auth + Firestore rules opnieuw). |
| **C — Blijft Datastore** | Geen Firebase Console Firestore voor deze app; alleen optie A of later **Realtime Database** (andere code). |

**Datastore → Native omzetten op hetzelfde project gaat meestal niet** (eenmalige keuze). Daarom optie A of B.

Zonder Firestore toont de site onder het filter kort: *localStorage fallback* — dat is normaal.

## 6. Account wijzigen

Pas `allowedEmails` in `firebase-config.js` aan (niet alleen in de UI-tekst).

## PWA installeren (Chrome Android)

Open **`…/climbs/index.html`** (niet alleen de sitewortel). Menu → **App installeren** / **Toevoegen aan startscherm**.

### Chrome zegt “App is al geïnstalleerd” maar je ziet hem niet?

1. **App-lade controleren** — soms heet hij **FietsKlim** en staat hij in het app-overzicht, niet op het startscherm.
2. **Oude “spook”-installatie** — een eerdere versie gebruikte een te generieke manifest-`id` (`./`). Na deploy van de fix (`id`: `fietsklim-database-climbs`):  
   - Chrome → **Site-instellingen** voor `vccharlie.github.io` → **Opslag wissen** (of “Sitegegevens wissen”).  
   - Of: **Instellingen → Apps → Chrome** → geïnstalleerde sites / web-apps → verwijder oude **FietsKlim**-vermelding.  
   - Pagina hard verversen, opnieuw proberen.
3. **Installeer vanaf de database-URL** — `…/climbs/` of `…/climbs/index.html`, niet `import.html`.
4. **Geen incognito** — installatie werkt in een normaal Chrome-profiel.
