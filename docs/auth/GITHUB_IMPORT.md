# Climbfinder-import via GitHub Actions (vanaf de site)

De browser kan Climbfinder **niet** betrouwbaar ophalen (CORS). Wel:

1. Jij kiest regio op **Climbfinder import** (`climbs/import.html`).
2. **GitHub Actions** draait `scripts/climbfinder_import.py` op GitHub (zelfde als lokaal / agent).
3. Met **`publish_to_site: true`** (standaard) commit de workflow automatisch naar `docs/climbs/data/` → **`index.json` wordt automatisch gegenereerd** → na ~1 min op de **kaart**. Geen zip uitpakken nodig.

### Alleen JSON uploaden (zonder index handmatig te editen)

1. Zet je `.json` in **`docs/climbs/data/`** op `main` (bestandsnaam = `meta.id` + `.json` is het handigst).
2. Workflow **Rebuild climb index** maakt **`index.json`** bij en pusht die (of lokaal: `python scripts/rebuild_climb_index.py` + commit).
3. Hard refresh op de kaart.
4. Artifact blijft beschikbaar als backup download.

## Optie A — GitHub (aanbevolen)

1. Op de importpagina: kies land/regio → **Kopieer `gh`-commando** of open de Actions-link.
2. GitHub → **Actions** → **Climbfinder import** → **Run workflow**.
3. Vul de velden in; laat **publish_to_site** op **`true`**.
4. Na de run: dataset staat op de site; kies de regio in de **kaart-dropdown**.

### Meerdere regio’s in één bestand (optioneel)

Zet **merge_into** op bijv. `nl-popular`. Elke import voegt klimmen toe aan `docs/climbs/data/nl-popular.json` (dubbele id’s worden overschreven). Eén entry in de kaart-dropdown i.p.v. tien losse JSON-bestanden.

### Lokaal met GitHub CLI

```bash
gh workflow run climbfinder-import.yml \
  -f locality=277 \
  -f pages=2 \
  -f meta_id=nl-zuid-holland \
  -f title="South Holland (Climbfinder Popular)" \
  -f country=NL \
  -f region_label="South Holland" \
  -f limit=50 \
  -f publish_to_site=true
```

Handmatig zip + upload is alleen nodig als `publish_to_site=false`.

## Optie B — Knop op de site (Firebase Function)

GitHub staat **geen** PAT toe in de browser. Daarom: een kleine **Firebase Callable Function** die met een server-side PAT `workflow_dispatch` aanroept.

### Vereisten

- Firebase **Blaze** plan (Functions)
- GitHub **fine-grained PAT** met **Actions: Read and write** op deze repo

### Deploy (eenmalig)

```bash
cd functions
npm install
firebase login
firebase use climbfinder-scraper   # jouw project-id

firebase functions:config:set \
  github.pat="github_pat_…" \
  github.repo="VCCharlie/Climbfinder-scraper" \
  github.ref="main"

firebase deploy --only functions:requestClimbfinderImport
```

In `firebase-config.js`:

```javascript
githubImport: {
  enabled: true,
  // optioneel: regio voor Functions (europe-west1)
},
```

Voeg in `import.html` al geladen Firebase scripts toe (alleen als je Optie B gebruikt):

```html
<script src="https://www.gstatic.com/firebasejs/10.14.0/firebase-functions-compat.js"></script>
```

Na login: **Start serverimport (GitHub Actions)** op de importpagina.

### PAT beveiliging

- PAT **alleen** in Firebase Functions config, nooit in `firebase-config.js` of GitHub Pages.
- Callable controleert hetzelfde Google-account als `allowedEmails`.

## Workflow-bestand

`.github/workflows/climbfinder-import.yml` — inputs komen overeen met de velden op de importpagina.
