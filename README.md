# FietsKlim — Climbfinder database & import

Persoonlijke **klimdatabase** op GitHub Pages: kaart, lijst, hoogteprofielen en logboek, plus **Climbfinder-import** en onderhoud via de importpagina.

Live (voorbeeld):

- **Database:** `https://vccharlie.github.io/Climbfinder-scraper/climbs/`
- **Import:** `https://vccharlie.github.io/Climbfinder-scraper/climbs/import.html`
- Repo-root (`/`) redirect naar de database.

## Wat zit waar

| Onderdeel | Pad |
|-----------|-----|
| Explorer (kaart, profiel, logboek) | `docs/climbs/index.html`, `docs/climbs/assets/app.js` |
| Climbfinder import UI | `docs/climbs/import.html` |
| Instellingen (Strava, logboek) | `docs/climbs/settings.html` |
| JSON-datasets | `docs/climbs/data/*.json` (schema: `data/schema.json`) |
| Import & publish scripts | `scripts/climbfinder_import.py`, `scripts/publish_climb_json.py`, … |
| GitHub Actions dispatch | Firebase Functions `functions/` → workflows in `.github/workflows/` |
| Google-login (persoonlijk) | `docs/auth/` — zie [`docs/auth/SETUP.md`](docs/auth/SETUP.md) |

## GitHub Pages

1. **Settings → Pages** → branch `main`, folder **`/docs`**
2. Site: `https://<username>.github.io/Climbfinder-scraper/` → doorverwijzing naar `climbs/`

## Data importeren

1. Log in op **Import** (zelfde Firebase-gate als de database).
2. Kies een Climbfinder-regio op de kaart of in de lijst.
3. **Start import op GitHub** (vereist deployed `requestClimbfinderImport` + PAT in Functions config).

Zie [`docs/auth/GITHUB_IMPORT.md`](docs/auth/GITHUB_IMPORT.md).

Lokaal / CI (zelfde logica als de workflow):

```bash
pip install -r requirements.txt
python -m playwright install chromium
python scripts/climbfinder_import.py --locality 288 --meta-id cf-l288-haute-savoie \
  --title "Haute-Savoie" --country FR --region-label "Haute-Savoie" \
  --pages 2 --limit 50 --out docs/climbs/data/cf-l288-haute-savoie.json
python scripts/publish_climb_json.py   # indien je publish-stap gebruikt
python scripts/rebuild_climb_index.py
```

## Cursor Cloud Agents / environment

[`.cursor/environment.json`](.cursor/environment.json) installeert `requirements.txt` en Playwright Chromium.

## Integratie & embed

[`docs/climbs/INTEGRATIE.md`](docs/climbs/INTEGRATIE.md)

## Projectstructuur (kern)

```
docs/
  index.html              # redirect → climbs/
  climbs/                 # FietsKlim app (Pages)
  auth/                   # Firebase gate + config
scripts/                  # import, index rebuild, dedupe
functions/                # Firebase callables (import, Strava)
.github/workflows/        # climbfinder-import, validate-docs-site, …
```
