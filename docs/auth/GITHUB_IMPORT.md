# Climbfinder-import via GitHub Actions (vanaf de site)

De browser kan Climbfinder **niet** betrouwbaar ophalen (CORS). Wel:

1. Jij kiest regio op **Climbfinder import** (`climbs/import.html`) — dropdown, **Zoek klim op naam** (bv. Ventoux → land/regio + kaart; meerdere treffers zoals Madeleine → keuzelijst), **of** tab **Regio op kaart** (land → klik stip → status op FietsKlim-kaart). In de regio-dropdown staat per regio **~N Popular** (Climbfinder-telling; ververs: `python scripts/refresh_region_popular_counts.py`).
2. **GitHub Actions** draait `scripts/climbfinder_import.py` op GitHub (zelfde als lokaal / agent).
3. Met **`publish_to_site: true`** (standaard) commit de workflow automatisch naar `docs/climbs/data/` → **`index.json` wordt automatisch gegenereerd** → na ~1 min op de **kaart**. Geen zip uitpakken nodig.

### Regio-stippen op de importkaart

Coördinaten staan in `docs/climbs/data/climbfinder-regions-geo.json`. Ververs (centroid van Popular-klimmen via Climbfinder API):

```bash
python scripts/enrich_region_centroids.py --climbfinder --all --merge --sleep 0.22 --force
```

Zonder `--climbfinder` krijg je alleen een **placeholder-spiraal** rond het landcentrum — onbruikbaar op de kaart.

### Klim-zoekindex (naam → regio)

Het veld **Zoek klim op naam** gebruikt `docs/climbs/data/climb-slug-search-index.json` (~Popular-ranking cache per regio, plus namen uit geïmporteerde JSON’s — niet de volledige Climbfinder-site).

```bash
# Optioneel eerst meer regio’s in ranking-cache:
python scripts/refresh_ranking_slugs.py --all
python scripts/build_climb_slug_search_index.py
git add docs/climbs/data/climb-slug-search-index.json && git commit -m "Refresh climb search index"
```

### Alleen JSON uploaden (zonder index handmatig te editen)

1. Zet je `.json` in **`docs/climbs/data/`** (bestandsnaam = `meta.id` + `.json` is het handigst).
2. **`index.json` hoef je niet zelf te editen:**
   - **GitHub Actions import** (`publish_to_site: true`): `rebuild_climb_index.py` draait vóór de commit.
   - **Push naar `main`** met nieuwe/gewijzigde bundle-JSON: workflow **Rebuild climb index** genereert en pusht `index.json`.
   - **Pull request** met bundle-wijzigingen: dezelfde workflow commit **`index.json` automatisch op je PR-branch** (zelfde repo). Daarna eventueel **Validate docs site** opnieuw laten lopen.
3. Lokaal altijd mogelijk: `python scripts/rebuild_climb_index.py` + commit.
4. Hard refresh op de kaart na deploy.

## Optie A — GitHub (aanbevolen)

1. Op de importpagina: kies land/regio → **Kopieer `gh`-commando** of open de Actions-link.
2. GitHub → **Actions** → **Climbfinder import** → **Run workflow**.
3. Vul de velden in; laat **publish_to_site** op **`true`**.
4. Na de run: dataset staat op de site; kies de regio in de **kaart-dropdown**.

### Meerdere regio’s in één bestand (optioneel)

Zet **merge_into** op bijv. `nl-limburg`. Elke import voegt klimmen toe aan dat bestand (zelfde **slug/id** = één klim, nieuwste wint). Eén dropdown-entry, geen overlap tussen oude Zuid-Limburg (35) en een nieuwe Limburg-import.

### Dezelfde klim in meerdere regio-datasets?

Climbfinder koppelt één klim (zelfde **slug**) aan meerdere **localities** (bijv. French Alps én Isère, of Liège Province én Pays de Herve). Importeer je beide regio’s als aparte JSON-bestanden, staan dezelfde klimmen **twee keer** in de site-database (regio-totalen tellen op).

- **Kaart / zoeken / logboek:** de app toont elke klim **één keer** (dedupe op slug in de UI).
- **Importpagina:** in de regio-lijst staat **overlap site:** … als klimmen al in een andere geïmporteerde regio staan (`published-locality-overlaps.json`, gebouwd bij index-rebuild).
- **Opruimen:** voorkom dubbele imports van ouder + kind-regio, of merge met `merge_climb_bundles.py` / `merge_into`.

### Klimgebieden (hiërarchie)

Tab **Klimgebieden** op `import.html`: macro-gebieden (Alpen, Pyrenéeën, …) met daaronder Climbfinder-regio’s. Data: `region-hierarchy.json` + `slug-smallest-locality.json` (gebouwd door `scripts/build_region_hierarchy.py`, ook na `rebuild_climb_index.py`).

Bij **import** krijgt elke klim automatisch **`region`** (weergave: **grootste sub-land**-locality uit ranking, Climbfinder-naam of *Overig*) en **`resolved_locality_id`** (kleinste locality, intern/dedupe) — ook als je een heel land importeert (bv. NL l=26 → *Gelderland* op de klim, niet *Netherlands*).

**Bestaande data:** tab **Onderhoud** → **Herlabel alle klimmen op site**, of workflow **Backfill climb regions** / `python scripts/backfill_climb_resolved_regions.py` (na `build_region_hierarchy.py`). Herhaalt weergave-labels op alle JSON’s (handig na `refresh_ranking_slugs.py`, minder *Overig*).

Op `import.html` staat een uitklapbaar **“Wat doet wat?”**-overzicht (download vs onderhoud).

### Duplicaten op de importpagina

Tab **Duplicaten** leest `published-duplicate-climbs.json`. Per slug in meerdere JSON-bestanden: behoud kopie in het **kleinste dataset** (min. klimmen in dat bestand) — niet hetzelfde als herlabelen van `region`.

Na deploy van Functions (workflow **Deploy Climbfinder import function**): **`requestClimbDuplicateRemovals`**, **`requestClimbDedupeAllSmallest`**, **`requestClimbRegionBackfill`**, **`requestClimbMacroBatchImport`** (Klimgebieden → **Importeer gebied**), **`requestSplitMonolithBundle`** (Onderhoud → monolith splitsen) en **`requestClimbfinderScoreBackfill`** (difficulty points op bestaande klimmen). Zonder Firebase: de bijbehorende workflows handmatig **Run workflow** op GitHub.

### Heel klimgebied (macro) — tab Klimgebieden

Op de **groene macro-regel**: **Importeer gebied (N)** start workflow **Macro klimgebied import batch** voor alle niet-● subregio’s (`pages=all`, Policy B, dedupe). Plan: `python scripts/plan_macro_group_import.py --macro 350 --country-iso FR`.

Handmatig:

```bash
gh workflow run macro-klimgebied-import-batch.yml \
  -f macro_locality_id=350 \
  -f country_iso=FR \
  -f skip_dedupe=false
```

- **Alle duplicaten opschonen** → `dedupe-all-smallest-region.yml` (Firebase: **`requestClimbDedupeAllSmallest`**)
- **Handmatige selectie** → `remove-duplicate-climbs.yml` (Firebase: **`requestClimbDuplicateRemovals`**, max 120 per run)

### Herlabel alle klimmen — werkt één-klik?

| Wat je ziet na OK | Betekenis |
|-------------------|-----------|
| Log: *Firebase één-klik niet actief* | Alleen bevestiging; **jij** moet op GitHub **Backfill climb regions → Run workflow** (branch `main`). |
| Log: *Backfill gestart…* + Actions-link | Firebase heeft GitHub aangeroepen. Binnen ~30 sec: [Backfill climb regions runs](https://github.com/VCCharlie/Climbfinder-scraper/actions/workflows/backfill-climb-regions.yml) — nieuwe regel **In progress** / **Completed**. |
| Log: *not-found* / *404* op callable | Function **`requestClimbRegionBackfill`** nog niet gedeployed. Run workflow **Deploy Climbfinder import function** (deployt alle import-callables). |
| Geen run, wel “gestart” | Popup geblokkeerd? Open de Actions-link uit het logveld onderaan de importpagina. |

Een geslaagde run eindigt met commit `data(climbs): backfill smallest-region labels on climbs`. Herhaal vooral na index-wijzigingen of `refresh_ranking_slugs.py` (minder *Overig*).

### Bestaande twee JSON’s samenvoegen

```bash
python scripts/merge_climb_bundles.py --into nl-limburg --title "Zuid-Limburg (samengevoegd)" \
  docs/climbs/data/nl-limburg.json docs/climbs/data/JOUW-NIEUWE-LIMBURG.json
```

Verwijder daarna het **overbodige** JSON-bestand op GitHub en push (index rebuildt automatisch als workflow actief is).

### “150 klimmen” terwijl Climbfinder ~688 toont?

Climbfinder levert **25 slugs per rankingpagina**. De import stopt na **`pages`** pagina’s, daarna pas **`limit`**.

| Instelling | Effect |
|------------|--------|
| `pages=6`, `limit=280` | **150** klimmen (6×25) — de limit helpt niet als er maar 150 slugs zijn opgehaald |
| `pages=all`, `limit=700` | Volledige Popular-lijst tot de API leeg is |

**Zuid-Limburg:** gebruik **`locality=27`** (zelfde als [ranking?l=27&s=popular](https://climbfinder.com/en/ranking?l=27&s=popular), ~688 klimmen). **`l=280`** is een andere regio (“Limburg” provincie), niet de 688-lijst.

Voorbeeld volledige Zuid-Limburg:

```bash
gh workflow run climbfinder-import.yml \
  -f locality=27 \
  -f pages=all \
  -f meta_id=nl-limburg \
  -f title="Zuid-Limburg — Climbfinder Popular (~688)" \
  -f country=NL \
  -f region_label="Zuid-Limburg" \
  -f limit=700 \
  -f publish_to_site=true
```

De run duurt lang (~688 climb-pagina’s ophalen); timeout workflow is 45 min.

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

### Deploy (eenmalig) {#deploy-eenmalig}

**Optie 1 — vanaf je pc**

```bash
export CLIMBFINDER_IMPORT_PAT="github_pat_…"   # fine-grained, Actions read+write
./scripts/setup-one-click-import.sh
```

**Optie 2 — alleen browser/GitHub (geen lokale Firebase CLI)**

1. Maak een **service account** voor GitHub Actions (bijv. `github-deploy-functions@climbfinder-scraper.iam.gserviceaccount.com`) en download een JSON-sleutel.
2. Geef die service account **projectrollen** (IAM → project `climbfinder-scraper` → Grant access → principal = het SA-e-mailadres):

   | Rol | Waarom |
   |-----|--------|
   | **Firebase Admin** | `functions:config:set` + deploy (eenvoudig; persoonlijk project) |
   | *of* **Cloud Functions Admin** + **Cloud Build Editor** | Strakkere variant |
   | **Artifact Registry Administrator** (optioneel) | Voorkomt rode workflow na *Deploy complete* door cleanup `artifactregistry.packages.delete` 403 |

3. **Belangrijk (veel deploy-fouten):** je **deploy-SA** moet **Service Account User** (`iam.serviceAccounts.actAs`) op **twee** runtime-accounts hebben — herhaal per account: tab **Principals with access** → **Grant access** → principal = deploy-SA (`client_email` uit JSON) → rol **Service Account User**:

   | Service account | Wanneer nodig |
   |-----------------|---------------|
   | **`climbfinder-scraper@appspot.gserviceaccount.com`** | App Engine default |
   | **`267954743255-compute@developer.gserviceaccount.com`** | Default Compute (1st Gen Functions gebruikt deze vaak bij *create*) |

   [Alle service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=climbfinder-scraper) → klik het account → **Principals with access** (niet “Manage access” op Permissions — dat wijzigt projectrollen *van* die SA, niet wie hem mag impersonaten).

   Typische fout na `@appspot` fix: *ActAs on **267954743255-compute@developer.gserviceaccount.com***.

   **PAT:** deel deploy-logs (`--debug`) niet publiek — daarin kunnen `runtimeconfig`-waarden (GitHub PAT) staan. Log gelekt? PAT intrekken op GitHub en opnieuw zetten via workflow/`functions:config:set`.

4. **API’s eenmalig inschakelen** (als project owner, in browser — deploy-SA mag dit vaak niet zelf):

   - [Firebase Extensions API](https://console.cloud.google.com/apis/library/firebaseextensions.googleapis.com?project=climbfinder-scraper) → **Enable**
   - Meestal al aan na eerdere deploy-poging: Cloud Functions, Cloud Build, Artifact Registry.

5. Repo **Settings → Secrets → Actions**: `FIREBASE_SERVICE_ACCOUNT` (hele JSON), `CLIMBFINDER_IMPORT_PAT` (fine-grained PAT; mag **niet** met `GITHUB_` beginnen — GitHub-regel).
6. **Actions → Deploy Climbfinder import function → Run workflow** (eenmalig). Bij IAM/API-fout: stappen 3–4 controleren en opnieuw runnen.

**Optie 3 — handmatig**

```bash
cd functions
npm install
firebase login
firebase use climbfinder-scraper   # jouw project-id

firebase functions:config:set \
  github.pat="github_pat_…" \
  github.repo="VCCharlie/Climbfinder-scraper" \
  github.ref="main"

firebase deploy --only functions:requestClimbfinderImport,functions:requestClimbDuplicateRemovals,functions:requestClimbDedupeAllSmallest,functions:requestClimbRegionBackfill,functions:requestClimbMacroBatchImport,functions:requestSplitMonolithBundle,functions:requestClimbfinderScoreBackfill
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

### Wat je ziet (werkt het?)

| Situatie | Gedrag knop **Start serverimport** |
|----------|-------------------------------------|
| `githubImport.enabled` **false** of ontbreekt | Log: *Firebase Function niet actief* → opent GitHub Actions; jij vult **Run workflow** handmatig in (geen `gh` nodig). |
| `enabled: true` (in repo), Function + PAT OK | Log: *Import gestart…* + **Actions-tab opent automatisch**. Geen terminal, geen formulier invullen. |
| `enabled: true`, PAT ontbreekt | Foutmelding over PAT / failed-precondition. |

**Verwachting:** één klik na regio-keuze = zelfde als **Run workflow** met de velden uit het workflow-veld op de importpagina. Geen terminal, geen `gh`, wel **Blaze + eenmalige** Function-deploy.

**Alleen Cursor + GitHub (browser):** zet `githubImport.enabled: true` in je **lokale** `firebase-config.js` (niet committen met secrets), deploy Function eenmalig vanaf pc, daarna op telefoon/pc alleen de knop gebruiken.

### PAT beveiliging

- PAT **alleen** in Firebase Functions config, nooit in `firebase-config.js` of GitHub Pages.
- Callable controleert hetzelfde Google-account als `allowedEmails`.

## Workflow-bestand

`.github/workflows/climbfinder-import.yml` — inputs komen overeen met de velden op de importpagina.

## Actions / Pages mislukt?

| Symptoom | Oorzaak | Wat doen |
|----------|---------|----------|
| Job **~15 min**, log leeg, melding *“not acquired by Runner”* | GitHub-hosted runner kwam niet vrij (wachtrij/infra) | **Geen bug in import/script.** Open de run → **Re-run failed jobs** (of start import opnieuw). |
| **pages build and deployment** idem | Zelfde runner-probleem bij GitHub Pages | Push naar `main` triggert opnieuw, of repo **Settings → Pages →** redeploy indien beschikbaar. |
| Import **wel** gedraaid maar site oud | Pages-build faalde ná commit | Fix Pages-run; laatste **geslaagde** Pages-run bepaalt wat live staat. |
| Deploy function: **ActAs** / **Service Account User** | GitHub-deploy-SA mag niet “als” App Engine-SA draaien | Optie B stap 3: **Principals with access** → deploy-SA → **Service Account User** op `@appspot`. |
| Deploy: **Permissions denied enabling firebaseextensions.googleapis.com** | Deploy-SA mag API’s niet zelf aanzetten | Als **owner**: [Firebase Extensions API](https://console.cloud.google.com/apis/library/firebaseextensions.googleapis.com?project=climbfinder-scraper) → **Enable**, daarna workflow opnieuw. |
| Deploy: **`creating Node.js 20 (1st Gen) function…`** daarna **`failed to create function`** | Geen PAT; GCP weigert function aanmaken (Firebase toont weinig detail) | 1) **Owner:** [App Engine starten](https://console.cloud.google.com/appengine/start?project=climbfinder-scraper) → regio **europe-west** (bij 1st Gen + `europe-west1`). 2) [Compute Engine API](https://console.cloud.google.com/apis/library/compute.googleapis.com?project=climbfinder-scraper) → Enable. 3) [Logging](https://console.cloud.google.com/logs/query?project=climbfinder-scraper) → filter `resource.type="cloud_function"` rond deploy-tijd. 4) Deploy-SA: **Cloud Functions Admin** + **Service Account User** op `@appspot`. 5) Workflow opnieuw; bij falen **firebase-deploy-log** artifact downloaden (`--debug`). |
| Deploy log: **`artifactregistry.packages.delete` denied** + Troubleshooter-link | Functions zijn vaak **wel** live (`Deploy complete!`); Firebase faalt op opruimen oude build-packages | Deploy-SA: **Artifact Registry Administrator**. Troubleshooter-URL: alleen het stuk na `errorId=` plakken (niet `,https:` erachter). Workflow na fix #99 telt deploy als geslaagd als `0 Functions Errored`. |

Workflow **Validate docs site** (`.github/workflows/validate-docs-site.yml`) controleert JSON en `index.json` op een normale runner — handig als Pages even in de wachtrij hangt.
