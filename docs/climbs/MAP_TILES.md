# Kaarttegels (Leaflet basemaps)

De databasekaart op `climbs/index.html` kiest automatisch een basemap:

| Situatie | Standaardlaag |
| -------- | ------------- |
| CARTO API-sleutel in `firebase-config.js` | **Carto Voyager** (licht kleurig, OSM-data) |
| Geen sleutel | **Topo licht (Esri)** — gratis, rustig maar met kleur (topo/hydro) |

Esri grijs, OpenStreetMap, OpenTopoMap, CyclOSM en satelliet blijven in het lagenmenu.

## CARTO Basemaps (2025/2026)

CARTO serveert raster- en vectorbasemaps op **`basemaps.cartocdn.com`**. Raster (`rastertiles/…`) vereist sinds eind 2025 een **API-sleutel** in productie; zonder sleutel krijg je watermark-tegels (“API KEY REQUIRED”), niet de echte kaart.

### Gratis sleutel (client-side OK)

1. Vraag een sleutel aan: [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey/) of [dashboard.basemaps.carto.com](https://dashboard.basemaps.carto.com/) — geen CARTO-account nodig, sleutel per e-mail.
2. **Gratis tier**: ca. 5 miljoen tegelrequests per kalendermaand (raster + vector samen). Geschikt voor persoonlijk / niet-commercieel gebruik; zie [Basemaps-voorwaarden](https://carto.com/basemaps/).
3. **GitHub Pages (`vccharlie.github.io`)**: sleutel staat in de browser (firebase-config.js). Beperk misbruik via **Referer-restrictie** in het CARTO-dashboard:
   - `vccharlie.github.io`
   - `localhost` (aparte sleutel of extra referer-regel — CARTO adviseert localhost op een eigen sleutel)
4. Plak de sleutel **alleen** in lokale `docs/auth/firebase-config.js` (niet committen):

```js
window.FIETSKLIM_AUTH_CONFIG = {
  // … firebase, allowedEmails, …
  mapTiles: {
    cartoApiKey: "jouw-sleutel-hier",
  },
  // of: CARTO_API_KEY: "jouw-sleutel-hier",
};
```

### URL-patroon (Leaflet, Voyager)

Zelfde host als de open CDN; alleen queryparameter `key`:

```
https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=YOUR_KEY
```

Varianten (zelfde `key`-parameter): `voyager_nolabels`, `light_all` (Positron met labels), `dark_all`, enz. — zie [CARTO Basemaps FAQ](https://docs.carto.com/faqs/carto-basemaps).

Attributie op de kaart houden: © OpenStreetMap contributors, © CARTO.

### Maximaal inzoomen (Voyager)

Met een **gratis** API-sleutel leveren Voyager-rastertegels vaak alleen tot **zoom 18** (hogere `z` → HTTP **403**). FietsKlim zet `maxZoom` daarom op 18 voor Carto Voyager, zodat de +-knop niet verder gaat dan er echte tegels zijn. Voor dieper inzoomen: wissel tijdelijk naar **OpenStreetMap** of **CyclOSM** in het lagenmenu.

### Zonder sleutel getest (curl, 2026-10)

| URL | Resultaat |
| --- | --------- |
| `a.basemaps.cartocdn.com/rastertiles/voyager/…` | HTTP 200, maar ~2 KB watermark-tegel |
| `a.basemaps.cartocdn.com/rastertiles/light_all/…` | Idem watermark |
| Esri `World_Topo_Map` | Volledige tegels, geen sleutel |

## Esri-lagen

Esri Canvas Light Gray (grijs + labels), World Topo Map en World Imagery gebruiken `server.arcgisonline.com` zonder API-sleutel; respecteer Esri-attributie in het lagenmenu.
