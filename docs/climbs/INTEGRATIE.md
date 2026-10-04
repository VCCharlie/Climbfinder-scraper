# FietsKlim Database — integratie op andere sites

Deze map is bedoeld als **centrale klimdatabase** (Climbfinder/Strava-achtig): elke klim heeft metadata, een `LineString`-polyline en een hoogteprofiel in JSON. Je kunt dezelfde bestanden in andere GitHub-projecten gebruiken via een vaste URL.

## JSON-structuur

- **Regio-index:** `data/index.json` — welke datasets er zijn
- **Regio-bundle:** bijv. `data/nl-limburg.json`
- **Schema:** `data/schema.json`

Publieke URL (GitHub Pages, branch `main`, map `/docs`):

```text
https://vccharlie.github.io/Climbfinder-scraper/climbs/data/nl-limburg.json
```

Of raw GitHub (handig voor CI/build scripts):

```text
https://raw.githubusercontent.com/VCCharlie/Climbfinder-scraper/main/docs/climbs/data/nl-limburg.json
```

## Volledige explorer

Open op GitHub Pages:

```text
https://vccharlie.github.io/Climbfinder-scraper/climbs/
```

## Embed op een andere website

Laad Leaflet, Chart.js en het embed-script. Vul `data-dataset` en optioneel `data-climb` in:

```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>

<div
  id="cauberg-widget"
  data-fietsklim
  data-dataset="https://vccharlie.github.io/Climbfinder-scraper/climbs/data/nl-limburg.json"
  data-climb="cauberg-valkenburg"
></div>
<script src="https://vccharlie.github.io/Climbfinder-scraper/climbs/assets/embed.js"></script>
```

Programmatisch:

```javascript
await FietsKlimDB.render(document.getElementById("cauberg-widget"), {
  dataset: "https://…/nl-limburg.json",
  climb: "keutenberg-schin-op-geul",
});
```

## Data toevoegen

1. **GPX (aanbevolen voor exacte lijn):**

   ```bash
   python scripts/gpx_to_climb_json.py mijn_klim.gpx \
     --name "Cauberg" --region "Zuid-Limburg" --country NL > /tmp/climb.json
   ```

   Voeg het object toe aan `climbs[]` in je regio-JSON (of schrijf een klein merge-script).

2. **Climbfinder (aanbevolen — echte route + profiel):**

   ```bash
   pip install playwright
   playwright install chromium
   python scripts/climbfinder_import.py --pages 2 --limit 35
   ```

   Dit leest de ranking rond Valkenburg (`g=5.83I50.86`, +25 km) en importeert per klim de **Climbfinder-polyline** en het **officiële hoogteprofiel** (decoded `pathElevationsEnc`).

3. **Start/eindpunt (alleen fallback, geen Climbfinder-geometrie):**

   ```bash
   python scripts/climb_builder.py --out docs/climbs/data/nl-limburg.json
   ```

3. **Ranking-scraper → stubs:** gebruik de bestaande scraper (`docs/index.html` / Streamlit) om namen en statistieken te verzamelen, koppel daarna GPX of handmatige polyline.

## Tips voor je andere repos

- Houd **één canonical JSON** in deze repo; andere sites `fetch()`en alleen de URL (geen kopieën).
- Versioneer grote wijzigingen via `meta.updated_at` en eventueel git tags.
- Voor kaarttegels: OpenStreetMap (zoals in de demo); voor productie kun je MapTiler/Mapbox gebruiken met dezelfde GeoJSON-geometrie.
