# Inloggen (persoonlijk gebruik)

De hele site onder `docs/` is afgeschermd met **Google-inloggen**. Alleen adressen in `allowedEmails` (standaard `vr.deruiter@gmail.com`) krijgen toegang.

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

## 4. Account wijzigen

Pas `allowedEmails` in `firebase-config.js` aan (niet alleen in de UI-tekst).
