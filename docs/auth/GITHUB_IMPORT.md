# Climbfinder-import via GitHub Actions (vanaf de site)

De browser kan Climbfinder **niet** betrouwbaar ophalen (CORS). Wel:

1. Jij kiest regio op **Climbfinder import** (`climbs/import.html`).
2. **GitHub Actions** draait `scripts/climbfinder_import.py` op GitHub (zelfde als lokaal / agent).
3. Je downloadt het JSON-bestand onder **Actions → run → Artifacts**.

## Optie A — Handmatig op GitHub (geen extra setup)

1. Op de importpagina: kies land/regio → **Kopieer `gh`-commando** of open de Actions-link.
2. GitHub → **Actions** → **Climbfinder import** → **Run workflow**.
3. Vul dezelfde velden in (`locality`, `meta_id`, `title`, …).
4. Na ~5–20 min: artifact `climbfinder-<meta_id>.json` downloaden.
5. Plaats in `docs/climbs/data/`, update `index.json`, push naar `main` (Pages).

### Lokaal met GitHub CLI

```bash
gh workflow run climbfinder-import.yml \
  -f locality=277 \
  -f pages=2 \
  -f meta_id=nl-zuid-holland \
  -f title="South Holland (Climbfinder Popular)" \
  -f country=NL \
  -f region_label="South Holland" \
  -f limit=50
```

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
