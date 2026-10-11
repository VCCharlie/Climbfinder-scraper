# PWA-updates (FietsKlim / docs/climbs)

Na een merge op GitHub Pages zien gebruikers soms oude HTML/JS/CSS door **browsercache** en de **service worker**. Volg deze checklist bij elke PR die de climbs-app raakt.

## Checklist (verplicht bij UI-/config-wijzigingen)

1. **`docs/climbs/service-worker.js`** — verhoog `CACHE_VERSION` (bijv. `20261011swforce2`).
2. **`docs/climbs/index.html`** — zet dezelfde `?v=…` op:
   - `assets/pwa-register.js`
   - `assets/styles.css`
   - `assets/app.js`
   - (en andere gewijzigde assets in die pagina)
3. **`docs/climbs/import.html`** / **`settings.html`** — minimaal `pwa-register.js?v=…` gelijk trekken.
4. Deploy naar GitHub Pages laten afronden; open de site **eenmaal** (auto-reload na nieuwe SW) of hard refresh.

## Wat de app automatisch doet

- Nieuwe service worker: `skipWaiting` + `clients.claim`, oude `fietsklim-*` caches worden gewist.
- Pagina: bij `updatefound` → `SKIP_WAITING`; bij `controllerchange` → **één** reload (`sessionStorage`, geen loop).
- `index.html` en `firebase-config.js`: **network-first** (`cache: no-store`), zodat de shell niet veroudert.

## Handmatig testen

1. Open DevTools → Application → Service Workers.
2. Vink “Update on reload” aan tijdens ontwikkelen.
3. Na deploy: “Unregister” + lege cache alleen nodig als je een oude kapotte SW wilt opruimen.

## Geen CI-auto-bump

Versienummers blijven bewust handmatig (één duidelijke plek in de PR-diff). Vergeten `?v=` is de meest voorkomende oorzaak van “ik zie de merge niet”.
