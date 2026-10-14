/* FietsKlim database explorer — map + elevation profile (Climbfinder JSON) */

(function () {
  const MIN_ZOOM_NEARBY_ROUTES = 12;
  const MIN_ZOOM_MARKER_LABELS = 12;
  /** Bij hogere zoom: aparte score per aanloop naar dezelfde top. */
  const MIN_ZOOM_SUMMIT_SPLIT = 14;
  const SUMMIT_CLUSTER_RADIUS_M = 55;
  const MAX_NEARBY_ROUTES = 40;
  const MAX_DIM_ROUTES = 35;
  const MAX_VIEWPORT_POINT_MARKERS = 48;
  const MAX_MAP_POLYLINE_POINTS = 96;
  const MAX_OVERVIEW_MAP_ENTRIES = 2200;
  const SPATIAL_CELL_DEG = 0.018;
  const VIEWPORT_REFRESH_MS = 300;
  const HOVER_GRADIENT_MAX_SEGMENTS = 28;
  const COARSE_POINTER_MQ = window.matchMedia("(pointer: coarse)");
  const MOBILE_LAYOUT_MQ = window.matchMedia("(max-width: 900px)");
  const ROUTE_HIT_WEIGHT_COARSE = 22;
  const ROUTE_HIT_WEIGHT_DIM = 16;
  const MAP_BASE_LAYER_KEY = "fietsklim-map-base-layer";

  /** UI-label: geen “(Climbfinder Popular)” suffix in dropdown/headers. */
  function displayRegionTitle(title) {
    if (!title) return "";
    let t = String(title).trim();
    t = t.replace(/\s*\(Climbfinder Popular[^)]*\)\s*$/i, "");
    t = t.replace(/\s*—\s*Climbfinder Popular[^)]*$/i, "");
    t = t.replace(/\s*-\s*Climbfinder Popular.*$/i, "");
    t = t.replace(/\s*\(Climbfinder\)\s*$/i, "");
    return t.trim() || String(title).trim();
  }

  function regionTitleFromMeta(meta) {
    if (!meta) return "";
    if (meta.region_label) return String(meta.region_label).trim();
    return displayRegionTitle(meta.title || "");
  }

  function regionTitleFromIndexEntry(region) {
    if (!region) return "";
    return region.displayTitle || displayRegionTitle(region.title || "");
  }

  /** NL labels + EN/FR voor zoeken op land. */
  const COUNTRY_LABELS = {
    AT: ["Oostenrijk", "Austria", "Österreich"],
    BE: ["België", "Belgium", "Belgique"],
    CH: ["Zwitserland", "Switzerland", "Schweiz", "Suisse"],
    DE: ["Duitsland", "Germany", "Deutschland"],
    ES: ["Spanje", "Spain", "España"],
    FR: ["Frankrijk", "France"],
    GB: ["Verenigd Koninkrijk", "United Kingdom", "UK", "England"],
    IT: ["Italië", "Italy", "Italia"],
    LU: ["Luxemburg", "Luxembourg"],
    NL: ["Nederland", "Netherlands"],
  };

  function countryDisplayLabel(code, regionCount) {
    const c = String(code || "").toUpperCase();
    const names = COUNTRY_LABELS[c];
    const label = names ? `${names[0]} (${c})` : c;
    return regionCount != null ? `${label} · ${regionCount} regio’s` : label;
  }

  function regionsForCountry(countryCode) {
    const c = String(countryCode || "").toUpperCase();
    return state.indexRegions
      .filter((r) => String(r.country || "").toUpperCase() === c)
      .slice()
      .sort((a, b) => regionTitleFromIndexEntry(a).localeCompare(regionTitleFromIndexEntry(b), "nl"));
  }

  function uniqueCountryCodes() {
    const set = new Set();
    for (const r of state.indexRegions) {
      if (r.country) set.add(String(r.country).toUpperCase());
    }
    return [...set].sort((a, b) => {
      const la = COUNTRY_LABELS[a]?.[0] || a;
      const lb = COUNTRY_LABELS[b]?.[0] || b;
      return la.localeCompare(lb, "nl");
    });
  }

  function regionShortDisambiguator(region) {
    const m = String(region?.id || "").match(/^cf-l(\d+)/i);
    if (m) return `L${m[1]}`;
    const id = String(region?.id || "");
    return id.length > 14 ? `${id.slice(0, 12)}…` : id;
  }

  function regionOptionLabel(region, pool) {
    const title = regionTitleFromIndexEntry(region);
    const base = `${title} (${region.count})`;
    const dup = pool.filter((r) => regionTitleFromIndexEntry(r) === title).length > 1;
    if (!dup) return base;
    const tag = regionShortDisambiguator(region);
    return tag ? `${base} · ${tag}` : base;
  }

  function fillCountrySelect() {
    const countrySel = $("countrySelect");
    if (!countrySel) return;
    const prev = countrySel.value;
    countrySel.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "Alle landen";
    countrySel.appendChild(allOpt);
    for (const code of uniqueCountryCodes()) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = countryDisplayLabel(code, regionsForCountry(code).length);
      countrySel.appendChild(opt);
    }
    if (prev && [...countrySel.options].some((o) => o.value === prev)) {
      countrySel.value = prev;
    } else {
      countrySel.value = "";
    }
  }

  function fillRegionSelect(countryCode, preferredUrl) {
    const regionSel = $("regionSelect");
    if (!regionSel) return;
    const code = String(countryCode || "").toUpperCase();
    const pool = code ? regionsForCountry(code) : [];
    const prev = preferredUrl !== undefined ? preferredUrl : regionSel.value;
    regionSel.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = code ? "Alle regio's" : "Kies eerst een land";
    regionSel.appendChild(allOpt);
    if (!code) {
      regionSel.value = "";
      regionSel.disabled = true;
      return;
    }
    regionSel.disabled = false;
    for (const region of pool) {
      const opt = document.createElement("option");
      opt.value = region.url;
      opt.textContent = regionOptionLabel(region, pool);
      regionSel.appendChild(opt);
    }
    if (prev && pool.some((r) => r.url === prev)) {
      regionSel.value = prev;
    } else {
      regionSel.value = "";
    }
  }

  function selectedCountryCode() {
    const v = $("countrySelect")?.value;
    return v ? String(v).toUpperCase() : "";
  }

  function clearRegionSelection() {
    state.currentRegionUrl = null;
    state.bundle = null;
    state.climbs = [];
    const meta = $("datasetMeta");
    if (meta) {
      meta.textContent =
        "Kies een regio voor de regionale lijst, of gebruik logboek/zoeken voor alle klimmen.";
    }
    clearDetailSelection();
    renderList(state.searchQuery);
    updateClimbLogSummary();
    updateMobileFiltersSummary();
    if (mapEntriesAvailable()) {
      if (state.mapMode === "overview") syncOverviewMarkers({ fit: false });
      else refreshViewportClimbs();
    } else {
      void loadRegionsGeo().then(() => syncRegionPreviewMarkers());
    }
    updateSearchHint();
  }

  function syncCountrySelectForRegionUrl(regionUrl) {
    const countrySel = $("countrySelect");
    if (!countrySel || !regionUrl) return;
    const reg = state.indexRegions.find((r) => r.url === regionUrl);
    if (!reg?.country) return;
    const code = String(reg.country).toUpperCase();
    if (countrySel.value !== code) {
      countrySel.value = code;
      fillRegionSelect(code, regionUrl);
    } else {
      fillRegionSelect(code, regionUrl);
    }
  }

  function countrySearchTokens(countryCode) {
    const c = String(countryCode || "").toUpperCase();
    const out = new Set([c.toLowerCase()]);
    for (const name of COUNTRY_LABELS[c] || []) {
      out.add(name.toLowerCase());
    }
    return [...out];
  }

  /** Land/ISO2 in zoekterm: geen q.includes("be") — anders matcht "Bettmeralp" op België. */
  function countryTokenMatchesQuery(q, token) {
    if (token.includes(q)) return true;
    if (token.length <= 2) return q === token;
    return q.includes(token);
  }

  function entryMatchesQuery(entry, q) {
    if (!q) return true;
    if (climbMatchesQuery(entry.climb, q)) return true;
    const regionTitle = (entry.regionTitle || "").toLowerCase();
    if (regionTitle.includes(q)) return true;
    const regionId = (entry.regionId || "").toLowerCase();
    if (regionId.includes(q)) return true;
    for (const token of countrySearchTokens(entry.country)) {
      if (countryTokenMatchesQuery(q, token)) return true;
    }
    return false;
  }

  /** Typeahead: alleen klimnaam of id bevat de zoekstring. */
  function entryMatchesSuggestQuery(entry, ql) {
    const name = (entry.climb.name || "").toLowerCase();
    const id = (entry.climb.id || "").toLowerCase();
    return name.includes(ql) || id.includes(ql);
  }

  function isCoarsePointer() {
    return COARSE_POINTER_MQ.matches;
  }

  function isMobileLayout() {
    return MOBILE_LAYOUT_MQ.matches;
  }

  function isMobileMapPaneActive() {
    const root = document.querySelector(".layout");
    return isMobileLayout() && root?.classList.contains("mobile-pane-map");
  }

  /** Lichte, Climbfinder-achtige lijnen (kleur komt uit score-tier fill). */
  const ROUTE_STYLE = {
    active: { color: "#fb923c", weight: 3.5, opacity: 0.9 },
    detail: { color: "#f97316", weight: 4.5, opacity: 0.92 },
    dim: { color: "#94a3b8", weight: 2.5, opacity: 0.42 },
    hover: { color: "#fbbf24", weight: 6, opacity: 0.95 },
  };

  const MAP_MARKER_RING = "#1e293b";

  const state = {
    bundle: null,
    climbs: [],
    selectedId: null,
    map: null,
    baseLayers: null,
    activeBaseLayer: null,
    routeLayer: null,
    markers: [],
    overviewCluster: null,
    viewportLayer: null,
    viewportSummitLayer: null,
    viewportRoutesLayer: null,
    viewportMoveTimer: null,
    chartMini: null,
    chartFull: null,
    profileExpanded: false,
    routeLayerOutline: null,
    hoverMarker: null,
    hoverHighlightGroup: null,
    hoveredEntryKey: null,
    hoverPreviewTimer: null,
    profileExpandMap: null,
    profileExpandMarker: null,
    profileExpandRouteLayer: null,
    profileExpandMapClimbId: null,
    viewportRouteByKey: new Map(),
    activeClimb: null,
    indexRegions: [],
    currentRegionUrl: null,
    regionCache: new Map(),
    globalSearchReady: false,
    globalEntries: [],
    globalIndexProgress: null,
    regionPreviewCluster: null,
    mapSyncTimer: null,
    spatialGrid: null,
    spatialGridPoolSize: 0,
    legendTimer: null,
    viewportRefreshToken: 0,
    viewportRefreshRaf: 0,
    searchBusy: false,
    searchQuery: "",
    mapMode: "overview",
    doneFilter: "all",
    geoWatchId: null,
    geoMarker: null,
    geoAccuracy: null,
    geoFollow: false,
    geoLocateBtn: null,
    userLatLng: null,
    /** Na mislukte poging: één retry met hoge nauwkeurigheid (alleen na gebruikersgebaar). */
    geoLocateRetried: false,
    /** Brave/PWA: extra poging met langere timeout bij code 1 + permission granted. */
    geoExtendedLocateRetry: false,
    geoAcquireInFlight: false,
    mapTilesHint: null,
    /** Vervangt normale searchHint-tekst (GPS-status / fout). */
    geoHintOverride: null,
    geoHintWarn: false,
    /** Tot eerste GPS-fix: geen fitBounds op regio (kaart blijft op jouw locatie). */
    geoInitialCenter: false,
    regionsGeo: null,
    regionsGeoPromise: null,
    geoRegionPickDone: false,
    /** Handmatige land/regio-keuze → geen GPS-auto-regio meer. */
    regionFiltersTouched: false,
    /** true = alle regio’s op kaart (gedimd); false = alleen land/regio-filter zichtbaar. */
    mapExploreAllRegions: false,
    searchSuggestHits: [],
    searchSuggestActive: -1,
  };

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function sortEntriesByDistance(entries, latlng) {
    if (!latlng) return entries;
    return [...entries].sort((a, b) => {
      const la = climbLatLng(a.climb);
      const lb = climbLatLng(b.climb);
      const da = la ? haversineM(latlng.lat, latlng.lng, la[0], la[1]) : Infinity;
      const db = lb ? haversineM(latlng.lat, latlng.lng, lb[0], lb[1]) : Infinity;
      return da - db;
    });
  }

  /** Automatisch uitzoomen op regio overslaan zodra GPS-fix bekend is. */
  function shouldAutoFitMapBounds() {
    return !state.geoInitialCenter && !state.userLatLng;
  }

  /** Kaart/lijst mogen deels geladen index gebruiken (niet wachten op alle ~29k klimmen). */
  function mapEntriesAvailable() {
    return state.globalSearchReady || state.globalEntries.length > 0;
  }

  function globalIndexLoadProgressText() {
    if (!state.searchBusy || state.globalSearchReady) return "";
    const p = state.globalIndexProgress;
    const n = state.globalEntries.length;
    if (!p?.totalRegions) {
      return n > 0 ? `Database laden… (${n.toLocaleString("nl-NL")} klimmen)` : "Database laden…";
    }
    return `Database laden… ${p.loadedRegions}/${p.totalRegions} regio’s (${n.toLocaleString("nl-NL")} klimmen)`;
  }

  function scheduleDeferredMapSync() {
    if (state.mapSyncTimer) return;
    state.mapSyncTimer = setTimeout(() => {
      state.mapSyncTimer = null;
      if (!state.map || state.mapMode === "detail" || !mapEntriesAvailable()) return;
      if (state.mapMode === "overview") syncOverviewMarkers({ fit: false });
      else refreshViewportClimbs();
      updateSearchHint();
    }, 650);
  }

  function hideRegionPreviewMarkers() {
    if (state.regionPreviewCluster && state.map) {
      state.map.removeLayer(state.regionPreviewCluster);
    }
    state.regionPreviewCluster = null;
  }

  function syncRegionPreviewMarkers() {
    if (!state.map || mapEntriesAvailable() || state.mapMode === "detail") {
      hideRegionPreviewMarkers();
      return;
    }
    if (!state.indexRegions.length) return;

    hideRegionPreviewMarkers();
    if (typeof L.markerClusterGroup === "function") {
      state.regionPreviewCluster = L.markerClusterGroup({
        showCoverageOnHover: false,
        maxClusterRadius: 52,
        spiderfyOnMaxZoom: true,
      });
    } else {
      state.regionPreviewCluster = L.layerGroup();
    }

    const byLoc = state.regionsGeo?.regions || {};
    for (const region of state.indexRegions) {
      const lid = region.locality_id;
      const g = lid != null ? byLoc[String(lid)] : null;
      if (!g || g.lat == null || g.lon == null) continue;
      const title = regionTitleFromIndexEntry(region);
      const count = region.count ?? 0;
      const icon = L.divIcon({
        className: "fietsklim-region-preview-marker",
        html: `<span class="fietsklim-region-preview-dot" aria-hidden="true"></span>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });
      const marker = L.marker([g.lat, g.lon], { icon });
      bindMapTooltip(marker, `${title} · ${count} klimmen`, { direction: "top" });
      marker.on("click", () => {
        state.regionFiltersTouched = true;
        state.mapExploreAllRegions = false;
        syncCountrySelectForRegionUrl(region.url);
        const regionSel = $("regionSelect");
        if (regionSel) regionSel.value = region.url;
        void loadRegion(region.url, { fitMap: true });
      });
      state.regionPreviewCluster.addLayer(marker);
    }

    if (state.regionPreviewCluster.getLayers().length) {
      state.regionPreviewCluster.addTo(state.map);
    } else {
      hideRegionPreviewMarkers();
    }
  }

  async function loadRegionsGeo() {
    if (state.regionsGeo) return state.regionsGeo;
    if (!state.regionsGeoPromise) {
      state.regionsGeoPromise = loadJson("data/climbfinder-regions-geo.json")
        .then((data) => {
          state.regionsGeo = data;
          return data;
        })
        .catch((err) => {
          console.warn("Regio-geo laden mislukt:", err.message);
          state.regionsGeo = null;
          return null;
        });
    }
    return state.regionsGeoPromise;
  }

  function findNearestIndexRegion(lat, lon) {
    const byLoc = state.regionsGeo?.regions;
    if (!byLoc || !state.indexRegions.length) return null;
    let best = null;
    let bestD = Infinity;
    for (const r of state.indexRegions) {
      const lid = r.locality_id;
      if (lid == null) continue;
      const g = byLoc[String(lid)];
      if (!g || g.lat == null || g.lon == null) continue;
      const d = haversineM(lat, lon, g.lat, g.lon);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  async function applyRegionFromUserLocation(latlng) {
    if (state.geoRegionPickDone || state.regionFiltersTouched) return;
    const hashClimb = window.location.hash.replace("#", "").trim();
    if (hashClimb) return;
    const regionSel = $("regionSelect");
    if (regionSel?.value) return;

    await loadRegionsGeo();
    const region = findNearestIndexRegion(latlng.lat, latlng.lng);
    if (!region?.url) return;

    state.geoRegionPickDone = true;
    state.mapExploreAllRegions = false;
    syncCountrySelectForRegionUrl(region.url);
    if (regionSel) regionSel.value = region.url;
    await loadRegion(region.url);
    updateMobileFiltersSummary();
    if (mapEntriesAvailable()) {
      syncOverviewMarkers({ fit: false });
      refreshViewportClimbs();
    }
    renderList(state.searchQuery);
    updateSearchHint();
  }

  function entryDatasetId(entry) {
    if (entry?.regionId) return entry.regionId;
    if (typeof FietsKlimClimbLog !== "undefined") {
      return FietsKlimClimbLog.datasetIdFromRegionUrl(entry?.regionUrl);
    }
    const url = entry?.regionUrl || "";
    const m = String(url).match(/data\/([^/?#]+)\.json/i);
    return m ? m[1] : "";
  }

  function climbIsDone(entry) {
    if (typeof FietsKlimClimbLog === "undefined" || !FietsKlimClimbLog.isReady()) return false;
    return FietsKlimClimbLog.isDone(entryDatasetId(entry), entry.climb.id);
  }

  function climbIsWishlist(entry) {
    if (typeof FietsKlimClimbLog === "undefined" || !FietsKlimClimbLog.isReady()) return false;
    return FietsKlimClimbLog.isWishlist(entryDatasetId(entry), entry.climb.id);
  }

  function isLogbookFilterActive() {
    return state.doneFilter !== "all";
  }

  function applyDoneFilter(items) {
    if (state.doneFilter === "all") return items;
    if (typeof FietsKlimClimbLog === "undefined" || !FietsKlimClimbLog.isReady()) return items;
    return items.filter((entry) => {
      const done = climbIsDone(entry);
      const wish = climbIsWishlist(entry);
      switch (state.doneFilter) {
        case "done":
          return done;
        case "todo":
          return !done;
        case "wishlist":
          return wish;
        case "wishlist-todo":
          return wish && !done;
        case "hide-wishlist":
          return !wish;
        default:
          return true;
      }
    });
  }

  function updateClimbLogSummary() {
    const el = $("climbLogSummary");
    if (!el) return;
    if (typeof FietsKlimClimbLog === "undefined" || !FietsKlimClimbLog.isReady()) {
      el.textContent = "Logboek: localStorage in deze browser (Firestore uit of Native mode vereist).";
      return;
    }
    const ds = state.bundle?.meta?.id;
    const total = state.climbs?.length || 0;
    if (ds && total) {
      const done = FietsKlimClimbLog.countDoneForDataset(ds);
      const wish = FietsKlimClimbLog.countWishlistForDataset(ds);
      el.textContent = `${done} / ${total} gedaan · ${wish} wishlist in deze regio · ${FietsKlimClimbLog.totalDone()} gedaan / ${FietsKlimClimbLog.totalWishlist()} wishlist totaal`;
    } else {
      el.textContent = `${FietsKlimClimbLog.totalDone()} gedaan · ${FietsKlimClimbLog.totalWishlist()} op wishlist (alle regio’s)`;
    }
  }

  async function toggleClimbDone(entry, done) {
    if (typeof FietsKlimClimbLog === "undefined") return;
    const datasetId = entryDatasetId(entry);
    if (!datasetId) return;
    try {
      await FietsKlimClimbLog.setDone(datasetId, entry.climb.id, done);
    } catch (e) {
      console.error(e);
      alert("Logboek opslaan mislukt: " + (e.message || e));
    }
  }

  async function markVisibleClimbsDone() {
    if (typeof FietsKlimClimbLog === "undefined" || !FietsKlimClimbLog.isReady()) {
      alert("Logboek niet geladen — log in en wacht tot Firestore klaar is (zie Instellingen).");
      return;
    }
    if (!state.map || state.mapMode === "detail") {
      alert("Zoom terug naar de kaart (niet in detailweergave).");
      return;
    }
    const entries = entriesInMapBounds().filter((e) => isEntryMapActive(e));
    if (!entries.length) {
      alert("Geen klimmen in dit kaartvenster. Zoom in of kies een regio.");
      return;
    }
    const n = entries.length;
    if (
      !confirm(
        `Zet ${n} klim(men) in beeld op «geklommen»?\n\nWishlist-vinkjes blijven staan; alleen «gedaan» wordt aangezet.`
      )
    ) {
      return;
    }
    const btn = $("mapMarkVisibleDone");
    if (btn) btn.disabled = true;
    try {
      for (const entry of entries) {
        const datasetId = entryDatasetId(entry);
        if (!datasetId) continue;
        await FietsKlimClimbLog.setDone(datasetId, entry.climb.id, true);
      }
      updateClimbLogSummary();
      refreshViewportClimbs();
      renderList(state.searchQuery || "");
      if (state.activeClimb) syncClimbDetailLogToggles();
    } catch (e) {
      console.error(e);
      alert("Batch opslaan mislukt: " + (e.message || e));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function toggleClimbWishlist(entry, wishlist) {
    if (typeof FietsKlimClimbLog === "undefined") return;
    const datasetId = entryDatasetId(entry);
    if (!datasetId) return;
    try {
      await FietsKlimClimbLog.setWishlist(datasetId, entry.climb.id, wishlist);
    } catch (e) {
      console.error(e);
      alert("Wishlist opslaan mislukt: " + (e.message || e));
    }
  }

  function refreshUiAfterClimbLogChange() {
    renderList(state.searchQuery);
    updateClimbLogSummary();
    syncClimbDetailLogToggles();
    syncProfileExpandLogToggles();
    if (state.activeClimb && isMobileMapPaneActive()) {
      updateMapTouchSheet(state.activeClimb);
    }
    if (mapEntriesAvailable()) {
      if (state.mapMode === "overview") syncOverviewMarkers({ fit: false });
      else if (state.mapMode !== "detail") refreshViewportClimbs();
    }
  }

  async function applyClimbStatusFlags(entry, flags) {
    if (typeof FietsKlimClimbLog === "undefined") return;
    const datasetId = entryDatasetId(entry);
    if (!datasetId) return;
    const patch = { ...flags };
    if (patch.done === true) patch.wishlist = false;
    if (patch.wishlist === true) patch.done = false;
    try {
      if (FietsKlimClimbLog.setFlags) {
        await FietsKlimClimbLog.setFlags(datasetId, entry.climb.id, patch);
      } else {
        if (patch.done !== undefined) await FietsKlimClimbLog.setDone(datasetId, entry.climb.id, patch.done);
        if (patch.wishlist !== undefined) {
          await FietsKlimClimbLog.setWishlist(datasetId, entry.climb.id, patch.wishlist);
        }
      }
      refreshUiAfterClimbLogChange();
    } catch (e) {
      console.error(e);
      alert("Status opslaan mislukt: " + (e.message || e));
    }
  }

  const STATUS_ICON = {
    done: `<svg class="climb-status-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l2.5 2.5L16 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    wishlist: `<svg class="climb-status-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4V4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
    none: `<svg class="climb-status-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3"/></svg>`,
  };

  function climbStatusSummaryText(entry) {
    const done = climbIsDone(entry);
    const wish = climbIsWishlist(entry);
    if (done) return "Geklommen";
    if (wish) return "Bucket list";
    return "Nog niet geklommen";
  }

  function climbStatusToggleButtonsHtml(entry) {
    const done = climbIsDone(entry);
    const wish = climbIsWishlist(entry);
    return `
      <div class="climb-status-toggles" role="group" aria-label="Mijn status">
        <button type="button" class="climb-status-icon-btn climb-status-icon-btn--done${done ? " is-on" : ""}" data-flag="done" title="Geklommen" aria-label="Geklommen" aria-pressed="${done}">
          ${STATUS_ICON.done}
        </button>
        <button type="button" class="climb-status-icon-btn climb-status-icon-btn--wish${wish ? " is-on" : ""}" data-flag="wishlist" title="Bucket list" aria-label="Bucket list" aria-pressed="${wish}">
          ${STATUS_ICON.wishlist}
        </button>
      </div>`;
  }

  function bindClimbStatusToggleButtons(container, entry) {
    if (!container) return;
    container.querySelectorAll(".climb-status-icon-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const flag = btn.dataset.flag;
        if (flag === "done") {
          void applyClimbStatusFlags(entry, { done: !climbIsDone(entry) });
        } else if (flag === "wishlist") {
          void applyClimbStatusFlags(entry, { wishlist: !climbIsWishlist(entry) });
        }
      });
    });
  }

  function closeClimbStatusMenu() {
    const menu = $("climbStatusMenu");
    if (menu) menu.hidden = true;
    $("climbStatusOpen")?.setAttribute("aria-expanded", "false");
  }

  function syncClimbStatusMenu(entry, menuEl) {
    const menu = menuEl || $("climbStatusMenu");
    if (!menu || menu.hidden) return;
    const done = climbIsDone(entry);
    const wish = climbIsWishlist(entry);
    menu.querySelectorAll("[data-status-action]").forEach((el) => {
      const action = el.dataset.statusAction;
      let on = false;
      if (action === "done") on = done;
      else if (action === "wishlist") on = wish;
      else if (action === "none") on = !done && !wish;
      el.classList.toggle("is-selected", on);
      el.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function bindClimbStatusMenu(entry, menuEl) {
    const menu = menuEl || $("climbStatusMenu");
    if (!menu) return;
    menu.querySelectorAll("[data-status-action]").forEach((el) => {
      el.onclick = () => {
        const action = el.dataset.statusAction;
        if (action === "done") {
          void applyClimbStatusFlags(entry, { done: !climbIsDone(entry) });
        } else if (action === "wishlist") {
          void applyClimbStatusFlags(entry, { wishlist: !climbIsWishlist(entry) });
        } else if (action === "none") {
          void applyClimbStatusFlags(entry, { done: false, wishlist: false });
          closeClimbStatusMenu();
        }
        syncClimbStatusMenu(entry);
      };
    });
  }

  function activeClimbLogEntry() {
    if (!state.activeClimb || !state.bundle?.meta?.id) return null;
    return {
      climb: state.activeClimb,
      regionId: state.bundle.meta.id,
      regionUrl: state.currentRegionUrl,
    };
  }

  function syncClimbDetailLogToggles() {
    const logWrap = $("climbDetailLogWrap");
    const toggles = $("climbDetailStatusToggles");
    if (!logWrap || !toggles) return;
    const entry = activeClimbLogEntry();
    if (!entry || state.mapMode !== "detail") {
      logWrap.hidden = true;
      return;
    }
    logWrap.hidden = false;
    const done = climbIsDone(entry);
    const wish = climbIsWishlist(entry);
    toggles.querySelector(".climb-status-icon-btn--done")?.classList.toggle("is-on", done);
    toggles.querySelector(".climb-status-icon-btn--done")?.setAttribute("aria-pressed", done ? "true" : "false");
    toggles.querySelector(".climb-status-icon-btn--wish")?.classList.toggle("is-on", wish);
    toggles.querySelector(".climb-status-icon-btn--wish")?.setAttribute("aria-pressed", wish ? "true" : "false");
  }

  function syncProfileExpandLogToggles() {
    const logWrap = $("profileExpandLogWrap");
    const toggles = $("profileExpandStatusToggles");
    if (!logWrap || !toggles) return;
    if (!state.profileExpanded || !state.activeClimb || !state.bundle?.meta?.id) {
      logWrap.hidden = true;
      return;
    }
    logWrap.hidden = false;
    const entry = {
      climb: state.activeClimb,
      regionId: state.bundle.meta.id,
      regionUrl: state.currentRegionUrl,
    };
    const done = climbIsDone(entry);
    const wish = climbIsWishlist(entry);
    toggles.querySelector(".climb-status-icon-btn--done")?.classList.toggle("is-on", done);
    toggles.querySelector(".climb-status-icon-btn--done")?.setAttribute("aria-pressed", done ? "true" : "false");
    toggles.querySelector(".climb-status-icon-btn--wish")?.classList.toggle("is-on", wish);
    toggles.querySelector(".climb-status-icon-btn--wish")?.setAttribute("aria-pressed", wish ? "true" : "false");
  }

  function difficultyColorsForClimb(climb) {
    if (typeof ClimbMetrics !== "undefined" && ClimbMetrics.difficultyMapColors) {
      return ClimbMetrics.difficultyMapColors(climb);
    }
    return { fill: "#cbd5e1", stroke: "#64748b", label: "?" };
  }

  function routeStyleForEntry(entry, baseStyle) {
    const colors = difficultyColorsForClimb(entry.climb);
    const dimmed = baseStyle === ROUTE_STYLE.dim;
    return {
      ...baseStyle,
      color: dimmed ? baseStyle.color : colors.fill,
      fillColor: colors.fill,
    };
  }

  function climbSummitLatLng(climb) {
    if (typeof ClimbMetrics !== "undefined" && ClimbMetrics.climbSummitLatLng) {
      return ClimbMetrics.climbSummitLatLng(climb);
    }
    const coords = climb?.geometry?.coordinates;
    if (coords?.length) {
      const [lng, lat] = coords[coords.length - 1];
      return [lat, lng];
    }
    return null;
  }

  function climbMarkerLatLng(climb) {
    return climbSummitLatLng(climb) || climbLatLng(climb);
  }

  function entryLightningScore(entry) {
    const s = climbLightningScore(entry.climb);
    return s != null && Number.isFinite(s) ? s : -1;
  }

  function pickSummitGroupWinner(entries) {
    let winner = entries[0];
    let best = entryLightningScore(winner);
    for (let i = 1; i < entries.length; i++) {
      const e = entries[i];
      const s = entryLightningScore(e);
      if (s > best) {
        best = s;
        winner = e;
      }
    }
    return winner;
  }

  /** Meerdere aanlopen naar dezelfde top → één marker met hoogste score (tot inzoomen). */
  function groupEntriesBySummit(entries, options = {}) {
    const { split = false, radiusM = SUMMIT_CLUSTER_RADIUS_M } = options;
    if (split) {
      return entries
        .map((entry) => {
          const ll = climbMarkerLatLng(entry.climb);
          if (!ll) return null;
          return { latlng: ll, entries: [entry], winner: entry };
        })
        .filter(Boolean);
    }
    const cellDeg = Math.max(radiusM / 111000, 0.00045);
    const buckets = new Map();
    for (const entry of entries) {
      const ll = climbMarkerLatLng(entry.climb);
      if (!ll) continue;
      const key = `${Math.round(ll[0] / cellDeg)},${Math.round(ll[1] / cellDeg)}`;
      let group = buckets.get(key);
      if (!group) {
        group = { latlng: ll, entries: [], latSum: 0, lngSum: 0, n: 0 };
        buckets.set(key, group);
      }
      group.entries.push(entry);
      group.latSum += ll[0];
      group.lngSum += ll[1];
      group.n += 1;
      group.latlng = [group.latSum / group.n, group.lngSum / group.n];
    }
    const groups = [...buckets.values()];
    for (const g of groups) g.winner = pickSummitGroupWinner(g.entries);
    return groups;
  }

  function summitPopupHtml(group) {
    const sorted = group.entries
      .slice()
      .sort((a, b) => entryLightningScore(b) - entryLightningScore(a));
    const rows = sorted
      .map((entry) => {
        const label =
          typeof ClimbMetrics !== "undefined" && ClimbMetrics.difficultyMarkerLabel
            ? ClimbMetrics.difficultyMarkerLabel(entry.climb)
            : "";
        const reg = regionTitleFromIndexEntry(
          state.indexRegions.find((r) => r.url === entry.regionUrl)
        );
        const meta = reg ? ` · ${reg}` : "";
        const scorePart = label ? `⚡ ${label}` : "";
        return `<button type="button" class="fietsklim-summit-popup-item" data-climb-id="${entry.climb.id}" data-region-url="${entry.regionUrl || ""}">${entry.climb.name}${meta}${scorePart ? ` — ${scorePart}` : ""}</button>`;
      })
      .join("");
    return `<div class="fietsklim-summit-popup"><p class="fietsklim-summit-popup-title">${sorted.length} aanlopen naar deze top</p>${rows}</div>`;
  }

  function bindSummitGroupMarker(marker, group, options = {}) {
    const { active = true, dimmed = false } = options;
    if (group.entries.length === 1) {
      const entry = group.entries[0];
      const regLabel = regionTitleFromIndexEntry(
        state.indexRegions.find((r) => r.url === entry.regionUrl)
      );
      const tip = dimmed
        ? `${entry.climb.name} · ${regLabel || "andere regio"} — klik = regio kiezen`
        : entry.climb.name;
      bindMapTooltip(marker, tip, { direction: "top" });
      bindMapEntryInteraction(marker, entry);
      return;
    }
    const winner = group.winner;
    const regLabel = regionTitleFromIndexEntry(
      state.indexRegions.find((r) => r.url === winner.regionUrl)
    );
    bindMapTooltip(
      marker,
      `${winner.climb.name} +${group.entries.length - 1} — hoogste score${regLabel ? ` · ${regLabel}` : ""}`,
      { direction: "top" }
    );
    marker.bindPopup(summitPopupHtml(group), { maxWidth: 300, className: "fietsklim-summit-popup-host" });
    marker.on("popupopen", () => {
      const host = marker.getPopup()?.getElement();
      if (!host) return;
      host.querySelectorAll(".fietsklim-summit-popup-item").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          const id = btn.getAttribute("data-climb-id");
          const regionUrl = btn.getAttribute("data-region-url") || null;
          marker.closePopup();
          void selectClimbFromList(id, regionUrl || undefined);
        });
      });
    });
    marker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      blurMapInteractionFocus();
      if (!isCoarsePointer()) {
        onMapRouteHover(winner);
      }
      marker.openPopup();
    });
    if (!isCoarsePointer()) {
      marker.on("mouseover", (e) => {
        L.DomEvent.stopPropagation(e);
        onMapRouteHover(winner);
      });
      marker.on("mouseout", (e) => {
        L.DomEvent.stopPropagation(e);
        scheduleClearRouteHover(winner);
      });
    }
  }

  function createMapMarkerForEntry(entry, options = {}) {
    const { active = false, dimmed = false, latlng: latlngOverride = null, summitGroup = null } =
      options;
    const latlng = latlngOverride || climbMarkerLatLng(entry.climb);
    if (!latlng) return null;
    const done = climbIsDone(entry);
    const colors = difficultyColorsForClimb(entry.climb);
    const zoom = state.map?.getZoom() ?? 0;
    const label =
      typeof ClimbMetrics !== "undefined" && ClimbMetrics.difficultyMarkerLabel
        ? ClimbMetrics.difficultyMarkerLabel(entry.climb)
        : "";
    const showLabel = zoom >= MIN_ZOOM_MARKER_LABELS && label && !dimmed;

    if (showLabel) {
      return createSummitLabelMarker(entry, latlng, { active, dimmed, summitGroup });
    }

    const fill = dimmed ? "#cbd5e1" : colors.fill;
    const stroke = dimmed ? "#94a3b8" : done ? "#15803d" : active ? MAP_MARKER_RING : colors.stroke;
    const touch = isCoarsePointer();
    const marker = L.circleMarker(latlng, {
      radius: touch ? (active ? 9 : 7) : active ? 7 : 5,
      color: stroke,
      weight: active || done ? 2.5 : 1.5,
      fillColor: fill,
      fillOpacity: dimmed ? 0.65 : active || done ? 0.95 : 0.88,
    });
    if (summitGroup) bindSummitGroupMarker(marker, summitGroup, { active, dimmed });
    return marker;
  }

  function createSummitLabelMarker(entry, latlng, options = {}) {
    const { active = false, dimmed = false, summitGroup = null } = options;
    if (!latlng) return null;
    const colors = difficultyColorsForClimb(entry.climb);
    const label =
      typeof ClimbMetrics !== "undefined" && ClimbMetrics.difficultyMarkerLabel
        ? ClimbMetrics.difficultyMarkerLabel(entry.climb)
        : "";
    if (!label) return null;
    const done = climbIsDone(entry);
    const bolt =
      climbLightningScore(entry.climb) != null
        ? '<span class="fietsklim-map-marker-bolt" aria-hidden="true">⚡</span>'
        : "";
    const icon = L.divIcon({
      className: "fietsklim-map-marker-host",
      html: `<div class="fietsklim-map-marker${active ? " is-active" : ""}${done ? " is-done" : ""}${dimmed ? " is-dim" : ""}" style="--mk-fill:${colors.fill};--mk-stroke:${colors.stroke}">${bolt}<span class="fietsklim-map-marker-label">${label}</span></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    const marker = L.marker(latlng, { icon });
    if (summitGroup) bindSummitGroupMarker(marker, summitGroup, { active, dimmed });
    return marker;
  }

  function addSummitScoreMarkers(entries, layer, options = {}) {
    if (!layer || !entries?.length) return;
    const zoom = options.zoom ?? state.map?.getZoom() ?? 0;
    if (zoom < MIN_ZOOM_MARKER_LABELS) return;
    const split = zoom >= MIN_ZOOM_SUMMIT_SPLIT;
    const groups = groupEntriesBySummit(entries, { split });
    for (const group of groups) {
      const entry = group.winner;
      const active = options.dimmed
        ? false
        : group.entries.some((e) => isEntryMapActive(e));
      const dimmed = Boolean(options.dimmed);
      const marker = createSummitLabelMarker(entry, group.latlng, {
        active,
        dimmed,
        summitGroup: group,
      });
      if (marker) layer.addLayer(marker);
    }
  }

  function updateMapDifficultyLegend() {
    if (state.legendTimer) clearTimeout(state.legendTimer);
    state.legendTimer = setTimeout(() => {
      state.legendTimer = null;
      updateMapDifficultyLegendNow();
    }, 160);
  }

  function updateMapDifficultyLegendNow() {
    const el = $("mapDifficultyLegend");
    if (!el || !state.map || state.mapMode === "detail") {
      if (el) el.hidden = true;
      return;
    }
    if (typeof ClimbMetrics === "undefined" || !ClimbMetrics.difficultyLegendTiers) {
      el.hidden = true;
      return;
    }
    const entries =
      state.mapMode === "overview" ? entriesForMapMarkers() : entriesInMapBounds();
    const counts = new Map();
    for (const entry of entries) {
      const key = ClimbMetrics.difficultyTierKey(entry.climb);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (!counts.size) {
      el.hidden = true;
      return;
    }
    const tiers = ClimbMetrics.difficultyLegendTiers().filter((t) => counts.has(t));
    if (!tiers.length) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const legendTitle =
      typeof ClimbMetrics.difficultyLegendTitle === "function"
        ? ClimbMetrics.difficultyLegendTitle(entries.map((e) => e.climb))
        : "Zwaarte";
    const anyLightning = entries.some((e) => climbLightningScore(e.climb) != null);
    const helpBtn = anyLightning
      ? `<button type="button" class="map-difficulty-legend-help" data-klimpunten-help title="Uitleg klimpunten">?</button>`
      : "";
    el.innerHTML = `<span class="map-difficulty-legend-title">${legendTitle}</span>${helpBtn}${tiers
      .map((t) => {
        const pal = ClimbMetrics.DIFFICULTY_MAP_COLORS[t];
        const n = counts.get(t) || 0;
        const bolt = String(t).startsWith("L") ? "⚡ " : "";
        return `<span class="map-difficulty-legend-item"><span class="map-difficulty-swatch" style="background:${pal.fill};border-color:${pal.stroke}"></span>${bolt}${pal.label} <span class="map-difficulty-count">(${n})</span></span>`;
      })
      .join("")}`;
  }

  function stravaActivityUrl(activityId) {
    if (!activityId) return null;
    return `https://www.strava.com/activities/${activityId}`;
  }

  function parseExplorerQuery() {
    const params = new URLSearchParams(window.location.search);
    const dataset = params.get("dataset");
    const climb = params.get("climb");
    const back = params.get("back");
    if (back && typeof FietsKlimClimbLog !== "undefined") {
      FietsKlimClimbLog.rememberNavBack?.(back);
    }
    if (!dataset && !climb) return null;
    return { dataset, climb, back };
  }

  function regionUrlForDatasetId(datasetId) {
    if (!datasetId || !state.indexRegions?.length) return null;
    const norm = String(datasetId).toLowerCase();
    for (const r of state.indexRegions) {
      if (r.id === datasetId || String(r.id).toLowerCase() === norm) return r.url;
      const fromUrl =
        typeof FietsKlimClimbLog !== "undefined"
          ? FietsKlimClimbLog.datasetIdFromRegionUrl(r.url)
          : "";
      if (fromUrl && fromUrl.toLowerCase() === norm) return r.url;
    }
    return null;
  }

  function syncClimbNavBackBar() {
    const bar = $("climbNavBack");
    if (!bar) return;
    const nav =
      typeof FietsKlimClimbLog !== "undefined" ? FietsKlimClimbLog.getNavBack?.() : null;
    if (!nav?.href) {
      bar.hidden = true;
      return;
    }
    bar.href = nav.href;
    bar.textContent = `← ${nav.label || "Terug"}`;
    bar.hidden = false;
  }

  function clearExplorerQueryFromUrl() {
    if (!window.location.search) return;
    const url = window.location.pathname + window.location.hash;
    history.replaceState(null, "", url);
  }

  function renderStravaLinkElement(el, datasetId, climb) {
    if (!el || !climb || !datasetId) {
      if (el) el.hidden = true;
      return;
    }
    if (typeof FietsKlimClimbLog === "undefined" || !FietsKlimClimbLog.isReady?.()) {
      el.hidden = true;
      return;
    }
    const row = FietsKlimClimbLog.getLogEntry?.(datasetId, climb.id);
    const actId = row?.stravaActivityId;
    if (!actId) {
      el.hidden = true;
      return;
    }
    const count = Math.max(1, Number(row.stravaAscentCount) || 1);
    const actName = row.stravaActivityName || "Strava-rit";
    const countPart = count > 1 ? ` · ${count}× gedetecteerd op Strava` : "";
    el.hidden = false;
    el.textContent = "";
    const label = document.createTextNode("Strava: ");
    el.appendChild(label);
    const wrap = document.createElement("span");
    wrap.className = "strava-link-actions";
    const a = document.createElement("a");
    a.textContent = actName;
    if (FietsKlimClimbLog.applyStravaActivityAnchor) {
      FietsKlimClimbLog.applyStravaActivityAnchor(a, actId);
    } else {
      a.href = stravaActivityUrl(actId);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    wrap.appendChild(a);
    el.appendChild(wrap);
    if (countPart) el.appendChild(document.createTextNode(countPart));
  }

  function syncClimbDetailStravaLink() {
    const datasetId = state.bundle?.meta?.id;
    const climb = state.activeClimb;
    renderStravaLinkElement($("climbStravaLink"), datasetId, climb);
    renderStravaLinkElement($("profileStravaLink"), datasetId, climb);
  }

  function syncClimbDetailDoneToggle() {
    syncClimbDetailLogToggles();
    syncClimbDetailStravaLink();
  }

  function $(id) {
    return document.getElementById(id);
  }

  function resolveDataUrl(url) {
    return new URL(url, window.location.href).href;
  }

  async function loadJson(url) {
    const cfg = window.FIETSKLIM_AUTH_CONFIG;
    if (cfg?.useStorage) {
      if (typeof firebase === "undefined" || !firebase.storage || !cfg.storageDataPrefix) {
        throw new Error("useStorage staat aan maar Firebase Storage is niet beschikbaar.");
      }
      const rel = url.replace(/^\.\//, "").replace(/^data\//, "");
      const path = `${cfg.storageDataPrefix}/${rel}`;
      const downloadUrl = await firebase.storage().ref(path).getDownloadURL();
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error(`Kon dataset niet laden uit Storage (${res.status})`);
      return res.json();
    }
    const fullUrl = resolveDataUrl(url);
    const res = await fetch(fullUrl, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} voor ${fullUrl} — staat dit JSON-bestand op GitHub Pages (map docs/climbs/data/)?`
      );
    }
    return res.json();
  }

  function formatKm(m) {
    return (m / 1000).toFixed(2) + " km";
  }

  function formatM(m) {
    return `${Math.round(m).toLocaleString("nl-NL")} m`;
  }

  function latLngsFromClimb(climb) {
    return climb.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  }

  function latLngsForMapDisplay(climb, maxPoints = MAX_MAP_POLYLINE_POINTS) {
    const latlngs = latLngsFromClimb(climb);
    if (latlngs.length <= maxPoints) return latlngs;
    const out = [latlngs[0]];
    const step = (latlngs.length - 1) / (maxPoints - 1);
    for (let i = 1; i < maxPoints - 1; i++) {
      out.push(latlngs[Math.min(latlngs.length - 1, Math.round(i * step))]);
    }
    out.push(latlngs[latlngs.length - 1]);
    return out;
  }

  function invalidateSpatialIndex() {
    state.spatialGrid = null;
    state.spatialGridPoolSize = 0;
  }

  function spatialCellKey(lat, lng) {
    const gx = Math.floor(lat / SPATIAL_CELL_DEG);
    const gy = Math.floor(lng / SPATIAL_CELL_DEG);
    return `${gx},${gy}`;
  }

  function ensureSpatialIndex(pool) {
    if (state.spatialGrid && state.spatialGridPoolSize === pool.length) return state.spatialGrid;
    const grid = new Map();
    for (const entry of pool) {
      const ll = climbMarkerLatLng(entry.climb) || climbLatLng(entry.climb);
      if (ll) {
        const key = spatialCellKey(ll[0], ll[1]);
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(entry);
        continue;
      }
      const b = entry.climb?.bbox;
      if (b && b.length >= 4) {
        const lat = (b[1] + b[3]) / 2;
        const lng = (b[0] + b[2]) / 2;
        const key = spatialCellKey(lat, lng);
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(entry);
      }
    }
    state.spatialGrid = grid;
    state.spatialGridPoolSize = pool.length;
    return grid;
  }

  function entryIntersectsBounds(entry, bounds) {
    const start = climbLatLng(entry.climb);
    const summit = climbMarkerLatLng(entry.climb);
    if (start && bounds.contains(start)) return true;
    if (summit && bounds.contains(summit)) return true;
    const b = entry.climb.bbox;
    if (b && b.length >= 4) {
      const cb = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
      return bounds.intersects(cb);
    }
    return false;
  }

  /** Beperk pool vóór bounds-check (regio/land-filter). */
  function narrowedMapPool() {
    const pool = mapVisibleEntries();
    if (!mapFilterStrictActive()) return pool;
    if (state.currentRegionUrl) {
      return pool.filter((e) => e.regionUrl === state.currentRegionUrl);
    }
    const country = selectedCountryCode();
    if (country) {
      return pool.filter((e) => String(e.country || "").toUpperCase() === country);
    }
    return pool;
  }

  function entriesForMapMarkers() {
    const entries = entriesForMapDisplay();
    if (!state.map || entries.length <= 700) return entries;
    return entriesInMapBounds(0.16, entries);
  }

  function climbLightningScore(climb) {
    return typeof ClimbMetrics !== "undefined" ? ClimbMetrics.climbLightningScore(climb) : null;
  }

  function klimpuntenListSuffix(climb) {
    const score = climbLightningScore(climb);
    if (score == null) return "";
    return ` · ⚡ ${Math.round(score)} kp`;
  }

  function syncKlimpuntenRow(climb, elId) {
    const el = $(elId);
    if (!el) return;
    const score = climbLightningScore(climb);
    if (score == null) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = `<span class="climb-klimpunten-score" title="Climbfinder moeilijkheidspunten">⚡ <strong>${Math.round(score)}</strong> klimpunten</span>
      <button type="button" class="climb-klimpunten-help-btn" data-klimpunten-help>Klimpunten?</button>`;
  }

  function syncStreetViewRow(climb, elId) {
    const el = $(elId);
    if (!el || typeof ClimbMetrics === "undefined") return;
    const pts = ClimbMetrics.climbStreetViewEndpoints(climb);
    if (!pts.length) {
      el.innerHTML = "";
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const links = pts
      .map((p) => {
        const url = ClimbMetrics.streetViewMapsUrl(p.lat, p.lng);
        if (!url) return "";
        return `<a class="climb-streetview-link" href="${url}" target="_blank" rel="noopener noreferrer">Street View — ${p.label}</a>`;
      })
      .filter(Boolean)
      .join("");
    el.innerHTML = links
      ? `<span class="climb-streetview-label">Beelden:</span> ${links}`
      : "";
  }

  function openKlimpuntenHelpDialog() {
    const dlg = $("klimpuntenHelpDialog");
    if (dlg?.showModal) dlg.showModal();
  }

  function ensureHoverRouteVisible(latlngs) {
    if (!state.map || latlngs.length < 2 || state.mapMode === "detail") return;
    const bounds = L.latLngBounds(latlngs);
    const padded = state.map.getBounds().pad(-0.05);
    if (!padded.intersects(bounds)) {
      state.map.fitBounds(bounds, {
        padding: [52, 52],
        maxZoom: Math.max(state.map.getZoom(), MIN_ZOOM_NEARBY_ROUTES),
        animate: true,
        duration: 0.35,
      });
    }
  }

  function climbEndpointStyles(size = "md") {
    const r = size === "sm" ? 5 : 8;
    return {
      start: {
        radius: r,
        color: "#166534",
        fillColor: "#4ade80",
        weight: 2,
        fillOpacity: 1,
      },
      end: {
        radius: r,
        color: "#9a3412",
        fillColor: "#fca5a5",
        weight: 2,
        fillOpacity: 1,
      },
    };
  }

  /** Groen = start, zacht rood = finish (Climbfinder-achtig). */
  function addClimbStartEndMarkers(latlngs, options = {}) {
    const { size = "md", layer, onClick, tooltip, skipEnd = false } = options;
    const styles = climbEndpointStyles(size);
    const created = [];
    if (!latlngs?.length) return created;

    const attach = (marker, label) => {
      if (tooltip) marker.bindTooltip(`${tooltip}${label ? ` (${label})` : ""}`, { direction: "top" });
      if (onClick) {
        marker.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          onClick(e);
        });
      }
      if (layer) layer.addLayer(marker);
      else marker.addTo(state.map);
      created.push(marker);
    };

    attach(L.circleMarker(latlngs[0], styles.start), "start");
    if (latlngs.length > 1 && !skipEnd) {
      attach(L.circleMarker(latlngs[latlngs.length - 1], styles.end), "finish");
    }
    return created;
  }

  function profilePoints(climb) {
    const dist = climb.profile.distances_m;
    const elev = climb.profile.elevations_m;
    return dist.map((d, i) => ({ x: d / 1000, y: elev[i] }));
  }

  function yAxisBounds(values) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = Math.max(5, (max - min) * 0.08);
    return { min: Math.floor(min - pad), max: Math.ceil(max + pad) };
  }

  function climbMatchesQuery(climb, q) {
    const cat =
      typeof ClimbMetrics !== "undefined" ? ClimbMetrics.climbCategory(climb) : climb.classification;
    const catDesc =
      cat && typeof ClimbMetrics !== "undefined" ? ClimbMetrics.categoryDescription(cat).toLowerCase() : "";
    return (
      climb.name.toLowerCase().includes(q) ||
      (climb.region || "").toLowerCase().includes(q) ||
      (climb.tags || []).some((t) => t.toLowerCase().includes(q)) ||
      (climb.id || "").toLowerCase().includes(q) ||
      (cat && cat.toLowerCase() === q) ||
      (catDesc && catDesc.includes(q)) ||
      (q === "1e" && cat === "1") ||
      (q === "2e" && cat === "2") ||
      (q === "3e" && cat === "3")
    );
  }

  function categoryBadgeHtml(climb, size) {
    if (typeof ClimbMetrics === "undefined") return "";
    return ClimbMetrics.categoryBadgeHtml(climb, size);
  }

  function syncCategoryBadgeElement(climb, elId) {
    const el = $(elId);
    if (!el) return;
    el.innerHTML = climb ? categoryBadgeHtml(climb, "md") : "";
  }

  function climbLatLng(climb) {
    if (climb.start?.lat != null && climb.start?.lng != null) {
      return [climb.start.lat, climb.start.lng];
    }
    const c0 = climb.geometry?.coordinates?.[0];
    if (c0) return [c0[1], c0[0]];
    return null;
  }

  function entryKey(entry) {
    return `${entry.regionUrl}::${entry.climb.id}`;
  }

  function climbGlobalKey(climb) {
    if (typeof FietsKlimClimbDedupe !== "undefined") {
      return FietsKlimClimbDedupe.climbGlobalKey(climb);
    }
    const slug = climb?.climbfinder?.slug;
    if (slug) return `slug:${slug}`;
    if (climb?.id) return `id:${climb.id}`;
    return null;
  }

  function regionEntryCount(regionUrl) {
    const reg = state.indexRegions.find((r) => r.url === regionUrl);
    return reg?.count ?? Number.MAX_SAFE_INTEGER;
  }

  /** Bij dubbele slug: smallere regio (minder klimmen) wint; gekozen regio wint altijd. */
  function shouldPreferGlobalEntry(candidate, existing) {
    if (state.currentRegionUrl === candidate.regionUrl && state.currentRegionUrl !== existing.regionUrl) {
      return true;
    }
    if (state.currentRegionUrl === existing.regionUrl) return false;
    return regionEntryCount(candidate.regionUrl) < regionEntryCount(existing.regionUrl);
  }

  /** Kaart: alle regio’s; zoekterm + logboek-filter. */
  function mapVisibleEntries() {
    const q = state.searchQuery.trim().toLowerCase();
    let entries = !q
      ? state.globalEntries
      : state.globalEntries.filter((entry) => entryMatchesQuery(entry, q));
    return applyDoneFilter(entries);
  }

  /** Geselecteerde regio = highlight; andere klimmen blijven zichtbaar (gedimd). */
  function isEntryMapActive(entry) {
    const q = state.searchQuery.trim().toLowerCase();
    if (q) return entryMatchesQuery(entry, q);
    if (state.currentRegionUrl) return entry.regionUrl === state.currentRegionUrl;
    const country = selectedCountryCode();
    if (country) return String(entry.country || "").toUpperCase() === country;
    return true;
  }

  function isEntryOutsideMapFilter(entry) {
    if (state.currentRegionUrl) return entry.regionUrl !== state.currentRegionUrl;
    const country = selectedCountryCode();
    if (country) return String(entry.country || "").toUpperCase() !== country;
    return false;
  }

  /** Alleen gekozen land/regio op kaart (clusters), tenzij zoeken of “alle regio’s”-modus. */
  function mapFilterStrictActive() {
    if (state.mapExploreAllRegions) return false;
    if (state.searchQuery.trim()) return false;
    return Boolean(state.currentRegionUrl || selectedCountryCode());
  }

  function entriesForMapDisplay() {
    const entries = mapVisibleEntries();
    if (!mapFilterStrictActive()) return entries;
    return entries.filter((e) => isEntryMapActive(e));
  }

  function boundsForEntries(entries) {
    const bounds = [];
    for (const entry of entries) {
      const ll = climbLatLng(entry.climb);
      if (ll) bounds.push(ll);
    }
    return bounds;
  }

  /** Handmatige regio-keuze: kaart springt naar regio (ook als GPS actief is). */
  function focusMapOnRegion() {
    if (!state.map || !state.currentRegionUrl) return;

    state.geoFollow = false;
    updateGeoLocateUi();

    if (state.mapMode === "detail") {
      if (window.location.hash) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      state.selectedId = null;
      state.activeClimb = null;
      state.mapMode = "overview";
      clearMapLayers();
      resetProfilePanel();
      hideMapTouchSheet();
      updateOverviewBackButton();
    }

    let bounds = [];
    if (state.climbs?.length) {
      bounds = boundsForEntries(state.climbs.map((climb) => ({ climb })));
    }
    if (!bounds.length && mapEntriesAvailable()) {
      bounds = boundsForEntries(
        state.globalEntries.filter((e) => e.regionUrl === state.currentRegionUrl)
      );
    }
    if (!bounds.length) return;

    state.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 14 });
    state.mapMode = state.map.getZoom() >= MIN_ZOOM_NEARBY_ROUTES ? "local" : "overview";

    if (mapEntriesAvailable()) {
      syncOverviewMarkers({ fit: false });
      refreshViewportClimbs();
    }
    updateSearchHint();
    requestAnimationFrame(() => {
      state.map?.invalidateSize();
      refreshViewportClimbs();
    });
  }

  function setGeoHint(message, { warn = false } = {}) {
    state.geoHintOverride = message;
    state.geoHintWarn = warn;
    const el = $("searchHint");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("field-hint--geo-warn", warn);
  }

  function clearGeoHintOverride() {
    if (!state.geoHintOverride) return;
    state.geoHintOverride = null;
    state.geoHintWarn = false;
    const el = $("searchHint");
    el?.classList.remove("field-hint--geo-warn");
    updateSearchHint();
  }

  function appendMapTilesHint(text) {
    if (!state.mapTilesHint) return text;
    if (!text) return state.mapTilesHint;
    return `${text} ${state.mapTilesHint}`;
  }

  function updateSearchHint() {
    const el = $("searchHint");
    if (!el) return;
    if (state.geoHintOverride) {
      el.textContent = state.geoHintOverride;
      el.classList.toggle("field-hint--geo-warn", state.geoHintWarn);
      return;
    }
    el.classList.remove("field-hint--geo-warn");
    const indexProgress = globalIndexLoadProgressText();
    if (indexProgress && !state.searchQuery.trim() && !isLogbookFilterActive()) {
      el.textContent = appendMapTilesHint(indexProgress);
      updateMobileFiltersSummary();
      return;
    }
    const q = state.searchQuery.trim();
    if (mapFilterStrictActive()) {
      el.textContent = appendMapTilesHint(
        "Kaart: alleen gekozen land/regio. Klik een klim buiten de filter of deselecteer (kaart naast route) om alles te zien."
      );
      updateMobileFiltersSummary();
      return;
    }
    if (q) {
      const n = state.globalEntries.filter((entry) => entryMatchesQuery(entry, q.toLowerCase())).length;
      el.textContent = appendMapTilesHint(
        `${n} treffer in alle regio’s (Enter-zoek) — kies uit dropdown voor land/regio + klim.`
      );
    } else {
      const n = state.globalEntries.length;
      const reg = state.indexRegions.find((r) => r.url === state.currentRegionUrl);
      const regN = reg
        ? state.globalEntries.filter((e) => e.regionUrl === state.currentRegionUrl).length
        : 0;
      if (isLogbookFilterActive()) {
        const filtered = applyDoneFilter(state.globalEntries).length;
        const tagByFilter = {
          done: "gedaan",
          todo: "nog open",
          wishlist: "wishlist",
          "wishlist-todo": "wishlist (open)",
          "hide-wishlist": "zonder wishlist",
        };
        const tag = tagByFilter[state.doneFilter] || "filter";
        el.textContent = appendMapTilesHint(
          n > 0
            ? `Lijst: ${filtered} klimmen (${tag}, alle regio’s). Kaart: ${n} klimmen. Klik klim = regio wisselt mee.${
                indexProgress ? ` ${indexProgress}` : ""
              }`
            : indexProgress || "Index laden…"
        );
      } else if (reg) {
        el.textContent = appendMapTilesHint(
          `Kaart: ${n} klimmen (alle regio’s). Lijst: ${regionTitleFromIndexEntry(reg)} (${regN}). Klik klim (ook grijs) = regio wisselt mee.`
        );
      } else {
        el.textContent = appendMapTilesHint(
          n > 0
            ? `Kaart: ${n} klimmen (alle regio’s). Lijst: kies een regio, of logboek/zoeken.`
            : "Leeg = alle klimmen op kaart. Typ om te filteren, of kies logboek-filter."
        );
      }
    }
    updateMobileFiltersSummary();
  }

  function setMobileFiltersOpen(open) {
    const wrap = document.querySelector(".app-header-filters");
    const btn = $("mobileFiltersToggle");
    if (!wrap || !btn) return;
    if (!isMobileLayout()) {
      wrap.classList.add("is-filters-open");
      btn.setAttribute("aria-expanded", "true");
      return;
    }
    wrap.classList.toggle("is-filters-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function updateDatabaseTotals(indexMeta) {
    const el = $("databaseTotals");
    if (!el) return;
    const total =
      indexMeta?.total_climbs ?? state.indexRegions.reduce((s, r) => s + (r.count || 0), 0);
    const unique = indexMeta?.unique_climbs;
    const dup = indexMeta?.duplicate_rows_across_regions;
    const nReg = indexMeta?.region_count ?? state.indexRegions.length;
    let line = `${Number(total).toLocaleString("nl-NL")} klimmen in database · ${nReg} regio’s`;
    if (unique != null && dup > 0) {
      line += ` · ${Number(unique).toLocaleString("nl-NL")} uniek (${Number(dup).toLocaleString("nl-NL")} overlap tussen regio’s)`;
    }
    el.textContent = line;
  }

  function updateMobileFiltersSummary() {
    const el = $("mobileFiltersSummary");
    if (!el) return;
    const parts = [];
    if (state.doneFilter === "todo") parts.push("open");
    if (state.doneFilter === "done") parts.push("gedaan");
    if (state.doneFilter === "wishlist") parts.push("wishlist");
    if (state.doneFilter === "wishlist-todo") parts.push("wishlist open");
    if (state.doneFilter === "hide-wishlist") parts.push("−wishlist");
    const reg = state.indexRegions.find((r) => r.url === state.currentRegionUrl);
    if (reg) parts.push(regionTitleFromIndexEntry(reg));
    const q = state.searchQuery.trim();
    if (q) parts.push(q.length > 20 ? `${q.slice(0, 18)}…` : q);
    el.textContent = parts.join(" · ") || "tik om te filteren";
  }

  function initMobileFiltersCollapse() {
    const wrap = document.querySelector(".app-header-filters");
    const btn = $("mobileFiltersToggle");
    if (!wrap || !btn) return;

    btn.addEventListener("click", () => {
      wrap.dataset.userToggled = "1";
      setMobileFiltersOpen(!wrap.classList.contains("is-filters-open"));
    });

    const applyLayout = () => {
      if (isMobileLayout()) {
        if (!wrap.dataset.userToggled) setMobileFiltersOpen(false);
      } else {
        delete wrap.dataset.userToggled;
        setMobileFiltersOpen(true);
      }
      updateMobileFiltersSummary();
    };

    MOBILE_LAYOUT_MQ.addEventListener("change", applyLayout);
    applyLayout();
  }

  function renderGradientStrip(buckets, stripId = "profileGradientStripMini") {
    const strip = $(stripId);
    if (!strip) return;
    strip.innerHTML = "";
    if (!buckets?.length) return;
    const totalKm = buckets[buckets.length - 1].endKm || 1;
    for (const b of buckets) {
      const seg = document.createElement("div");
      seg.className = "profile-gradient-seg";
      seg.style.flex = `${((b.endKm - b.startKm) / totalKm) * 100} 1 0`;
      seg.style.backgroundColor = b.color;
      seg.title = `${b.startKm.toFixed(1)}–${b.endKm.toFixed(1)} km: gem. ${b.gradientPct}%`;
      seg.textContent = `${b.label}%`;
      strip.appendChild(seg);
    }
  }

  function updateOverviewBackButton() {
    const btn = $("mapBackOverview");
    if (!btn) return;
    const show = state.mapMode === "detail" || state.mapMode === "local";
    btn.hidden = !show;
    btn.textContent =
      state.mapMode === "detail" ? "← Overzichtskaart" : "← Heel overzicht";
  }

  function destroyProfileChart(key) {
    if (state[key]) {
      state[key].destroy();
      state[key] = null;
    }
  }

  function setClimbDetailVisible(visible) {
    const panel = $("climbDetailPanel");
    const root = document.querySelector(".layout");
    if (panel) panel.hidden = !visible;
    if (root) root.classList.toggle("layout-has-climb", visible);
    syncClimbDetailPanelMode();
  }

  function syncClimbDetailPanelMode() {
    const panel = $("climbDetailPanel");
    if (!panel || panel.hidden) {
      panel?.classList.remove("climb-detail-panel--preview", "climb-detail-panel--selected");
      const hint = $("climbDetailPreviewHint");
      if (hint) hint.hidden = true;
      return;
    }
    const isSelected = state.mapMode === "detail" && Boolean(state.selectedId);
    const isPreview = Boolean(state.activeClimb && !isSelected);
    panel.classList.toggle("climb-detail-panel--preview", isPreview);
    panel.classList.toggle("climb-detail-panel--selected", isSelected);
    const hint = $("climbDetailPreviewHint");
    if (hint) hint.hidden = !isPreview;
  }

  const PROFILE_HOVER_MARKER = {
    radius: 7,
    color: "#b45309",
    fillColor: "#f59e0b",
    fillOpacity: 1,
    weight: 2,
  };

  function teardownProfileExpandMap() {
    if (state.profileExpandMap) {
      state.profileExpandMap.remove();
      state.profileExpandMap = null;
    }
    state.profileExpandMarker = null;
    state.profileExpandRouteLayer = null;
    state.profileExpandMapClimbId = null;
  }

  function mountProfileExpandMap(climb) {
    const el = $("profileExpandMap");
    if (!el || typeof L === "undefined") return;

    const sameClimb = state.profileExpandMap && state.profileExpandMapClimbId === climb.id;
    if (!sameClimb) {
      teardownProfileExpandMap();
      state.profileExpandMap = L.map(el, {
        zoomControl: true,
        attributionControl: true,
        tapTolerance: isCoarsePointer() ? 25 : 15,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap",
      }).addTo(state.profileExpandMap);
      state.profileExpandMapClimbId = climb.id;
    }

    const latlngs = latLngsFromClimb(climb);
    if (!latlngs.length) return;

    if (!sameClimb) {
      if (state.profileExpandRouteLayer) {
        state.profileExpandMap.removeLayer(state.profileExpandRouteLayer);
      }
      state.profileExpandRouteLayer = buildDetailRouteLayer(climb, latlngs);
      addClimbStartEndMarkers(latlngs, {
        size: "md",
        layer: state.profileExpandRouteLayer,
        tooltip: climb.name,
      });
      state.profileExpandRouteLayer.addTo(state.profileExpandMap);
      state.profileExpandMap.fitBounds(L.latLngBounds(latlngs), { padding: [14, 14] });
    }

    requestAnimationFrame(() => {
      state.profileExpandMap?.invalidateSize();
      setTimeout(() => state.profileExpandMap?.invalidateSize(), 120);
    });
  }

  function setProfileHoverPosition(climb, profileIndex) {
    if (!climb?.geometry?.coordinates?.length) return;
    const geoIdx = geometryIndexForProfile(climb, profileIndex);
    const [lng, lat] = climb.geometry.coordinates[geoIdx];

    if (state.map) {
      if (!state.hoverMarker) {
        state.hoverMarker = L.circleMarker([lat, lng], PROFILE_HOVER_MARKER).addTo(state.map);
      } else {
        state.hoverMarker.setLatLng([lat, lng]);
      }
    }

    if (state.profileExpandMap && state.profileExpanded) {
      if (!state.profileExpandMarker) {
        state.profileExpandMarker = L.circleMarker([lat, lng], {
          ...PROFILE_HOVER_MARKER,
          radius: 8,
        }).addTo(state.profileExpandMap);
      } else {
        state.profileExpandMarker.setLatLng([lat, lng]);
      }
    }
  }

  function closeProfileExpand() {
    state.profileExpanded = false;
    const overlay = $("profileExpandOverlay");
    if (overlay) overlay.hidden = true;
    const logWrap = $("profileExpandLogWrap");
    if (logWrap) logWrap.hidden = true;
    closeClimbStatusMenu();
    destroyProfileChart("chartFull");
    teardownProfileExpandMap();
  }

  function openProfileExpand() {
    if (!state.activeClimb) return;
    state.profileExpanded = true;
    const overlay = $("profileExpandOverlay");
    if (overlay) overlay.hidden = false;
    const st = state.activeClimb.stats || {};
    $("profileTitleFull").textContent = state.activeClimb.name;
    syncCategoryBadgeElement(state.activeClimb, "profileCategoryBadgeFull");
    $("profileStatsFull").textContent = climbStatsLine(st, state.activeClimb);
    syncKlimpuntenRow(state.activeClimb, "profileKlimpuntenFull");
    syncStreetViewRow(state.activeClimb, "profileStreetViewFull");
    const buckets =
      typeof ClimbMetrics !== "undefined" ? ClimbMetrics.profileBuckets(state.activeClimb) : [];
    renderGradientStrip(buckets, "profileGradientStripFull");
    const hintEl = $("profileExpandMapHint");
    if (hintEl) {
      hintEl.textContent = isCoarsePointer()
        ? "Positie op de route — veeg over het profiel"
        : "Positie op de route — beweeg de muis over het profiel";
    }
    mountProfileExpandMap(state.activeClimb);
    syncProfileExpandLogToggles();
    mountProfileChart("profileChartFull", "chartFull", state.activeClimb, false);
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (state.chartFull) state.chartFull.resize();
        state.profileExpandMap?.invalidateSize();
      }, 50);
      setTimeout(() => {
        if (state.chartFull) state.chartFull.resize();
        state.profileExpandMap?.invalidateSize();
      }, 280);
    });
  }

  function resetProfilePanel() {
    setClimbDetailVisible(false);
    closeProfileExpand();
    destroyProfileChart("chartMini");
    renderGradientStrip([], "profileGradientStripMini");
    renderGradientStrip([], "profileGradientStripFull");
  }

  function climbStatsLine(st, climb) {
    const steep =
      st.steepest_100m_pct != null
        ? ` · steil 100 m ${st.steepest_100m_pct}% · steil 1 km ${st.steepest_1km_pct ?? "—"}%`
        : steepestLabel(climb);
    const bucketStepM =
      typeof ClimbMetrics !== "undefined"
        ? ClimbMetrics.profileBucketSizeM(
            climb.profile?.distances_m?.slice(-1)[0] || st.length_m || 0
          )
        : 500;
    const blockHint = bucketStepM >= 1000 ? "1 km" : bucketStepM >= 500 ? "500 m" : "100 m";
    return `${formatKm(st.length_m)} · ${st.avg_gradient_pct}% gem. · max ${st.max_gradient_pct}%${steep} · +${formatM(st.elevation_gain_m)} · kleur per ${blockHint}`;
  }

  function clearViewportLayers() {
    if (state.viewportLayer) state.viewportLayer.clearLayers();
    if (state.viewportSummitLayer) state.viewportSummitLayer.clearLayers();
    if (state.viewportRoutesLayer) state.viewportRoutesLayer.clearLayers();
    state.viewportRouteByKey.clear();
  }

  function syncListHoverHighlight(climbId) {
    document.querySelectorAll(".climb-item").forEach((el) => {
      el.classList.toggle("hover-preview", Boolean(climbId && el.dataset.id === climbId));
    });
  }

  function clearRouteHoverHighlight() {
    if (state.hoverHighlightGroup && state.map) {
      state.map.removeLayer(state.hoverHighlightGroup);
    }
    state.hoverHighlightGroup = null;
    state.hoveredEntryKey = null;
  }

  function applyRouteHoverHighlight(entry) {
    if (!state.map || state.mapMode === "detail") return;
    const latlngs = latLngsForMapDisplay(entry.climb);
    if (latlngs.length < 2) return;
    clearRouteHoverHighlight();
    ensureHoverRouteVisible(latlngs);
    state.hoveredEntryKey = entryKey(entry);
    const segments =
      typeof ClimbMetrics !== "undefined" ? ClimbMetrics.routeGradientSegments(entry.climb) : [];
    if (segments.length > HOVER_GRADIENT_MAX_SEGMENTS) {
      state.hoverHighlightGroup = L.layerGroup();
      L.polyline(latlngs, {
        color: "#ffffff",
        weight: 14,
        opacity: 0.98,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      }).addTo(state.hoverHighlightGroup);
      L.polyline(latlngs, { ...ROUTE_STYLE.hover, interactive: false }).addTo(state.hoverHighlightGroup);
    } else {
      state.hoverHighlightGroup = buildGradientRouteLayer(entry.climb, latlngs, {
        outlineWeight: 14,
        segmentWeight: 8,
        interactive: false,
      });
    }
    state.hoverHighlightGroup.addTo(state.map);
    state.hoverHighlightGroup.eachLayer((layer) => {
      if (layer.bringToFront) layer.bringToFront();
    });
  }

  function showClimbPreview(climb) {
    if (!climb) return;
    if (state.mapMode === "detail" && state.selectedId === climb.id) return;
    syncListHoverHighlight(climb.id);
    if (state.activeClimb?.id === climb.id && state.mapMode !== "detail") {
      syncClimbDetailPanelMode();
      return;
    }
    updateChart(climb);
  }

  function clearClimbPreview() {
    if (state.mapMode === "detail") return;
    syncListHoverHighlight(null);
    if (state.selectedId) return;
    resetProfilePanel();
  }

  function scheduleClearRouteHover(entry) {
    if (state.hoverPreviewTimer) clearTimeout(state.hoverPreviewTimer);
    const key = entryKey(entry);
    state.hoverPreviewTimer = setTimeout(() => {
      state.hoverPreviewTimer = null;
      if (state.hoveredEntryKey !== key) return;
      clearRouteHoverHighlight();
      if (state.selectedId !== entry.climb.id) clearClimbPreview();
    }, 160);
  }

  function onMapRouteHover(entry) {
    if (state.mapMode === "detail") return;
    if (state.hoverPreviewTimer) {
      clearTimeout(state.hoverPreviewTimer);
      state.hoverPreviewTimer = null;
    }
    applyRouteHoverHighlight(entry);
    showClimbPreview(entry.climb);
  }

  function bindMapEntryHover(layer, entry) {
    layer.on("mouseover", (e) => {
      L.DomEvent.stopPropagation(e);
      onMapRouteHover(entry);
    });
    layer.on("mouseout", (e) => {
      L.DomEvent.stopPropagation(e);
      scheduleClearRouteHover(entry);
    });
  }

  function stripLeafletPathFocus(layer) {
    if (!layer?.on) return;
    const strip = () => {
      const el = layer.getElement?.();
      if (!el) return;
      el.setAttribute("tabindex", "-1");
      el.style.outline = "none";
    };
    if (layer.getElement?.()) strip();
    else layer.on("add", strip);
  }

  function blurMapInteractionFocus() {
    const active = document.activeElement;
    if (active?.closest?.("#map") && active !== state.map?.getContainer?.()) {
      active.blur();
    }
  }

  /** Geen sticky/interactive tooltips op touch — voorkomt focus-kader en dubbel-tikken. */
  function bindMapTooltip(layer, content, extra = {}) {
    if (!layer?.bindTooltip || !content) return;
    const touch = isCoarsePointer();
    if (touch) return;
    layer.bindTooltip(content, {
      direction: "top",
      sticky: true,
      interactive: false,
      ...extra,
    });
  }

  function bindMapEntryInteraction(layer, entry) {
    stripLeafletPathFocus(layer);
    layer.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      blurMapInteractionFocus();
      void selectClimbFromList(entry.climb.id, entry.regionUrl);
    });
    if (!isCoarsePointer()) {
      bindMapEntryHover(layer, entry);
    }
  }

  function hideMapTouchSheet() {
    const sheet = $("mapTouchSheet");
    if (sheet) sheet.hidden = true;
  }

  function updateMapTouchSheet(climb) {
    const sheet = $("mapTouchSheet");
    if (!sheet || !climb) return;
    if (!isMobileMapPaneActive()) {
      sheet.hidden = true;
      return;
    }
    const st = climb.stats || {};
    $("mapTouchTitle").textContent = climb.name;
    $("mapTouchStats").textContent = climbStatsLine(st, climb);
    const statusHost = $("mapTouchStatus");
    if (statusHost && state.bundle?.meta?.id && state.mapMode === "detail") {
      const entry = {
        climb,
        regionId: state.bundle.meta.id,
        regionUrl: state.currentRegionUrl,
      };
      statusHost.innerHTML = `
        <p class="map-touch-sheet-kicker">Mijn status</p>
        ${climbStatusToggleButtonsHtml(entry)}
        <button type="button" class="map-touch-status-clear" data-status-action="none">Nog niet geklommen</button>`;
      bindClimbStatusToggleButtons(statusHost, entry);
      statusHost.querySelector(".map-touch-status-clear")?.addEventListener("click", () => {
        void applyClimbStatusFlags(entry, { done: false, wishlist: false });
      });
      statusHost.hidden = false;
    } else if (statusHost) {
      statusHost.hidden = true;
      statusHost.innerHTML = "";
    }
    sheet.hidden = false;
  }

  function setMobilePane(pane) {
    const root = document.querySelector(".layout");
    if (!root || !isMobileLayout()) return;
    const showMap = pane === "map";
    root.classList.toggle("mobile-pane-map", showMap);
    root.classList.toggle("mobile-pane-list", !showMap);
    const listBtn = $("mobileViewList");
    const mapBtn = $("mobileViewMap");
    listBtn?.classList.toggle("is-active", !showMap);
    mapBtn?.classList.toggle("is-active", showMap);
    listBtn?.setAttribute("aria-pressed", String(!showMap));
    mapBtn?.setAttribute("aria-pressed", String(showMap));
    if (showMap) {
      setMobileFiltersOpen(false);
      hideMapTouchSheet();
      requestAnimationFrame(() => {
        refreshMapSize();
        setTimeout(refreshMapSize, 150);
      });
    } else if (state.activeClimb) {
      $("climbDetailPanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function initMobileViewSwitch() {
    const root = document.querySelector(".layout");
    if (!root) return;
    const applyDefault = () => {
      if (isMobileLayout()) {
        if (!root.classList.contains("mobile-pane-map") && !root.classList.contains("mobile-pane-list")) {
          setMobilePane("map");
        }
      } else {
        root.classList.remove("mobile-pane-map", "mobile-pane-list");
        hideMapTouchSheet();
      }
    };
    applyDefault();
    MOBILE_LAYOUT_MQ.addEventListener("change", applyDefault);
    $("mobileViewList")?.addEventListener("click", () => setMobilePane("list"));
    $("mobileViewMap")?.addEventListener("click", () => setMobilePane("map"));
    $("mapTouchSheetClose")?.addEventListener("click", () => hideMapTouchSheet());
    $("mapTouchOpenList")?.addEventListener("click", () => {
      setMobilePane("list");
      $("climbDetailPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => {
        if (isMobileLayout() && isMobileMapPaneActive()) refreshMapSize();
      });
    }
  }

  function afterClimbSelectedOnMobile(climb) {
    if (!isMobileLayout()) return;
    if (isMobileMapPaneActive()) {
      updateMapTouchSheet(climb);
      refreshMapSize();
    } else {
      hideMapTouchSheet();
      requestAnimationFrame(() => {
        $("climbDetailPanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
  }

  function ensureViewportLayers() {
    if (!state.map) return;
    if (!state.viewportLayer) {
      state.viewportLayer = L.layerGroup().addTo(state.map);
    }
    if (!state.viewportRoutesLayer) {
      state.viewportRoutesLayer = L.layerGroup().addTo(state.map);
    }
    if (!state.viewportSummitLayer) {
      state.viewportSummitLayer = L.layerGroup().addTo(state.map);
    }
  }

  function entriesInMapBounds(pad = 0.12, poolOverride = null) {
    if (!state.map) return [];
    const bounds = state.map.getBounds().pad(pad);
    const pool = poolOverride || narrowedMapPool();
    if (pool.length <= 400) {
      return pool.filter((entry) => entryIntersectsBounds(entry, bounds));
    }
    const grid = ensureSpatialIndex(pool);
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const minGx = Math.floor(sw.lat / SPATIAL_CELL_DEG) - 1;
    const maxGx = Math.floor(ne.lat / SPATIAL_CELL_DEG) + 1;
    const minGy = Math.floor(sw.lng / SPATIAL_CELL_DEG) - 1;
    const maxGy = Math.floor(ne.lng / SPATIAL_CELL_DEG) + 1;
    const seen = new Set();
    const out = [];
    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gy = minGy; gy <= maxGy; gy++) {
        const bucket = grid.get(`${gx},${gy}`);
        if (!bucket) continue;
        for (const entry of bucket) {
          const k = entryKey(entry);
          if (seen.has(k)) continue;
          if (entryIntersectsBounds(entry, bounds)) {
            seen.add(k);
            out.push(entry);
          }
        }
      }
    }
    return out;
  }

  function refreshViewportClimbsNow() {
    if (!state.map || !mapEntriesAvailable() || state.mapMode === "detail") return;

    const zoom = state.map.getZoom();
    const useViewport = state.mapMode === "local" || zoom >= MIN_ZOOM_NEARBY_ROUTES;

    if (!useViewport) {
      clearViewportLayers();
      if (state.mapMode === "overview" && state.overviewCluster) {
        state.overviewCluster.addTo(state.map);
      }
      return;
    }

    if (state.overviewCluster) state.map.removeLayer(state.overviewCluster);
    ensureViewportLayers();
    clearViewportLayers();

    const entries = entriesInMapBounds();
    const strict = mapFilterStrictActive();
    const activeEntries = entries.filter((e) => isEntryMapActive(e));
    const inactiveEntries = strict ? [] : entries.filter((e) => !isEntryMapActive(e));
    const withRouteKeys = new Set();

    const addRoute = (entry, style) => {
      const latlngs = latLngsForMapDisplay(entry.climb);
      if (latlngs.length < 2) return;
      withRouteKeys.add(entryKey(entry));
      const isDim = style === ROUTE_STYLE.dim;
      const regLabel = regionTitleFromIndexEntry(
        state.indexRegions.find((r) => r.url === entry.regionUrl)
      );
      const tip = regLabel ? `${entry.climb.name} · ${regLabel}` : entry.climb.name;
      const routePaint = routeStyleForEntry(entry, style);
      if (!isDim) {
        L.polyline(latlngs, {
          color: "#ffffff",
          weight: routePaint.weight + 3,
          opacity: 0.92,
          lineCap: "round",
          lineJoin: "round",
          interactive: false,
        }).addTo(state.viewportRoutesLayer);
      }
      const line = L.polyline(latlngs, {
        ...routePaint,
        lineCap: "round",
        lineJoin: "round",
        interactive: !isCoarsePointer() && !isDim,
      });
      bindMapTooltip(line, tip);
      state.viewportRoutesLayer.addLayer(line);
      const needsHit = isCoarsePointer() || isDim;
      if (needsHit) {
        const hit = L.polyline(latlngs, {
          className: "fietsklim-route-hit",
          color: "transparent",
          weight: isDim ? ROUTE_HIT_WEIGHT_DIM : ROUTE_HIT_WEIGHT_COARSE,
          opacity: 0.001,
          interactive: true,
        });
        bindMapTooltip(
          hit,
          isDim ? `${tip} — klik om regio «${regLabel || "?"}» te kiezen` : tip
        );
        bindMapEntryInteraction(hit, entry);
        state.viewportRoutesLayer.addLayer(hit);
        state.viewportRouteByKey.set(entryKey(entry), hit);
      } else {
        bindMapEntryInteraction(line, entry);
        state.viewportRouteByKey.set(entryKey(entry), line);
      }
      if (style !== ROUTE_STYLE.dim) {
        addClimbStartEndMarkers(latlngs, {
          size: isCoarsePointer() ? "md" : "sm",
          layer: state.viewportLayer,
          tooltip: entry.climb.name,
          skipEnd: zoom >= MIN_ZOOM_MARKER_LABELS,
          onClick: () => void selectClimbFromList(entry.climb.id, entry.regionUrl),
        });
      }
    };

    if (zoom >= MIN_ZOOM_NEARBY_ROUTES) {
      for (const entry of inactiveEntries.slice(0, MAX_DIM_ROUTES)) {
        addRoute(entry, ROUTE_STYLE.dim);
      }
      for (const entry of activeEntries.slice(0, MAX_NEARBY_ROUTES)) {
        addRoute(entry, ROUTE_STYLE.active);
      }
    }

    const addStartMarker = (entry, dimmed) => {
      if (withRouteKeys.has(entryKey(entry))) return;
      const marker = createMapMarkerForEntry(entry, { active: !dimmed, dimmed });
      if (!marker) return;
      const regLabel = regionTitleFromIndexEntry(
        state.indexRegions.find((r) => r.url === entry.regionUrl)
      );
      const tip = dimmed
        ? `${entry.climb.name} · ${regLabel || "andere regio"} — klik = regio kiezen`
        : entry.climb.name;
      bindMapTooltip(marker, tip, { direction: "top" });
      bindMapEntryInteraction(marker, entry);
      state.viewportLayer.addLayer(marker);
    };

    for (const entry of inactiveEntries.slice(0, MAX_VIEWPORT_POINT_MARKERS)) addStartMarker(entry, true);
    for (const entry of activeEntries.slice(0, MAX_VIEWPORT_POINT_MARKERS)) addStartMarker(entry, false);

    if (zoom >= MIN_ZOOM_MARKER_LABELS) {
      const routedActive = activeEntries.filter((e) => withRouteKeys.has(entryKey(e)));
      const routedInactive = inactiveEntries
        .filter((e) => withRouteKeys.has(entryKey(e)))
        .slice(0, MAX_DIM_ROUTES);
      addSummitScoreMarkers(routedActive, state.viewportSummitLayer, { zoom, dimmed: false });
      if (!strict) {
        addSummitScoreMarkers(routedInactive, state.viewportSummitLayer, { zoom, dimmed: true });
      }
    }
    updateMapDifficultyLegend();
  }

  function refreshViewportClimbs() {
    state.viewportRefreshToken += 1;
    const token = state.viewportRefreshToken;
    if (state.viewportRefreshRaf) cancelAnimationFrame(state.viewportRefreshRaf);
    state.viewportRefreshRaf = requestAnimationFrame(() => {
      state.viewportRefreshRaf = 0;
      if (token !== state.viewportRefreshToken) return;
      refreshViewportClimbsNow();
    });
  }

  function scheduleViewportRefresh() {
    if (state.viewportMoveTimer) clearTimeout(state.viewportMoveTimer);
    state.viewportMoveTimer = setTimeout(() => refreshViewportClimbs(), VIEWPORT_REFRESH_MS);
  }

  function clearDetailSelection() {
    state.selectedId = null;
    state.activeClimb = null;
    state.mapMode = "overview";
    clearMapLayers();
    resetProfilePanel();
    hideMapTouchSheet();
    updateOverviewBackButton();
  }

  function returnToLocalView() {
    if (!state.map) return;

    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    state.selectedId = null;
    state.activeClimb = null;
    state.mapExploreAllRegions = false;
    const zoom = state.map.getZoom();
    state.mapMode = zoom >= MIN_ZOOM_NEARBY_ROUTES ? "local" : "overview";
    clearMapLayers();
    resetProfilePanel();
    hideMapTouchSheet();
    updateOverviewBackButton();
    renderList(state.searchQuery);

    /* Geen zoom/center wijzigen — alleen contextlagen in huidige viewport herstellen. */
    if (state.mapMode === "overview") {
      if (mapEntriesAvailable()) syncOverviewMarkers({ fit: false });
      updateSearchHint();
    } else {
      refreshViewportClimbs();
    }
  }

  function returnToOverview() {
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    state.selectedId = null;
    state.activeClimb = null;
    state.mapMode = "overview";
    clearMapLayers();
    clearViewportLayers();
    resetProfilePanel();
    updateOverviewBackButton();
    renderList(state.searchQuery);
    if (mapEntriesAvailable()) syncOverviewMarkers({ fit: true });
    else void loadRegionsGeo().then(() => syncRegionPreviewMarkers());
    updateSearchHint();
  }

  function ensureOverviewCluster() {
    if (state.overviewCluster) return;
    if (typeof L.markerClusterGroup !== "function") {
      state.overviewCluster = L.layerGroup();
      state.map.addLayer(state.overviewCluster);
      return;
    }
    state.overviewCluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 42,
      spiderfyOnMaxZoom: true,
      chunkedLoading: true,
      chunkInterval: 100,
      chunkDelay: 40,
    });
    state.map.addLayer(state.overviewCluster);
  }

  function syncOverviewMarkers(options = {}) {
    const { fit = false } = options;
    if (!state.map || !mapEntriesAvailable()) return;
    hideRegionPreviewMarkers();
    if (state.mapMode !== "overview") {
      refreshViewportClimbs();
      return;
    }

    clearViewportLayers();
    ensureOverviewCluster();
    if (!state.map.hasLayer(state.overviewCluster)) {
      state.overviewCluster.addTo(state.map);
    }
    state.overviewCluster.clearLayers();
    const allEntries = mapVisibleEntries();
    let entries = entriesForMapMarkers();
    if (entries.length > MAX_OVERVIEW_MAP_ENTRIES) {
      entries = entries.slice(0, MAX_OVERVIEW_MAP_ENTRIES);
    }
    const fitBounds = [];
    if (fit && state.currentRegionUrl && !state.searchQuery.trim()) {
      const regionEntries = allEntries.filter((e) => e.regionUrl === state.currentRegionUrl);
      fitBounds.push(...boundsForEntries(regionEntries));
    } else {
      fitBounds.push(...boundsForEntries(mapFilterStrictActive() ? entries : allEntries));
    }
    const zoom = state.map.getZoom();
    const split = zoom >= MIN_ZOOM_SUMMIT_SPLIT;
    const summitGroups = groupEntriesBySummit(entries, { split });
    for (const group of summitGroups) {
      const entry = group.winner;
      const active = group.entries.some((e) => isEntryMapActive(e));
      const dimmed = !active;
      const showLabel = zoom >= MIN_ZOOM_MARKER_LABELS;
      const marker = showLabel
        ? createSummitLabelMarker(entry, group.latlng, { active, dimmed, summitGroup: group })
        : createMapMarkerForEntry(entry, {
            active,
            dimmed,
            latlng: group.latlng,
            summitGroup: group,
          });
      if (!marker) continue;
      if (!showLabel) {
        const reg = entry.regionTitle ? ` · ${displayRegionTitle(entry.regionTitle)}` : "";
        const activeTip = `${entry.climb.name}${reg}`;
        const dimTip = `${entry.climb.name}${reg}${reg ? " — klik = regio kiezen" : ""}`;
        bindMapTooltip(marker, active ? activeTip : dimTip, { direction: "top" });
        bindMapEntryInteraction(marker, entry);
      }
      state.overviewCluster.addLayer(marker);
    }
    if (fit && shouldAutoFitMapBounds() && fitBounds.length) {
      state.map.fitBounds(fitBounds, { padding: [36, 36], maxZoom: 14 });
    }
    if (zoom >= MIN_ZOOM_NEARBY_ROUTES) {
      refreshViewportClimbs();
    } else {
      updateMapDifficultyLegend();
    }
    updateSearchHint();
  }

  function steepestLabel(climb) {
    const s = climb.stats || {};
    if (s.steepest_100m_pct != null) {
      const km = s.steepest_1km_pct != null ? ` · steil 1 km ${s.steepest_1km_pct}%` : "";
      return ` · steil 100 m ${s.steepest_100m_pct}%${km}`;
    }
    if (typeof ClimbMetrics !== "undefined" && climb.profile?.distances_m) {
      const d = climb.profile.distances_m;
      const e = climb.profile.elevations_m;
      const a = ClimbMetrics.steepestGradientPct(d, e, 100);
      const b = ClimbMetrics.steepestGradientPct(d, e, 1000);
      return ` · steil 100 m ${a}% · steil 1 km ${b}%`;
    }
    return "";
  }

  function renderList(filterText) {
    const list = $("climbList");
    const q = (filterText || "").trim().toLowerCase();
    const logbookList = !q && isLogbookFilterActive();
    const needsGlobal = Boolean(q) || logbookList;

    if (needsGlobal && !state.globalSearchReady && !state.globalEntries.length) {
      list.innerHTML = `<p class="list-hint">${globalIndexLoadProgressText() || "Zoekindex laden…"}</p>`;
      void ensureGlobalSearchIndex({ background: false });
      return;
    }
    if (needsGlobal && !state.globalSearchReady && !state.searchBusy) {
      void ensureGlobalSearchIndex({ background: true });
    }

    list.innerHTML = "";
    let partialIndex = needsGlobal && !state.globalSearchReady;
    let items;
    let capped = false;
    if (q) {
      items = state.globalEntries.filter((entry) => entryMatchesQuery(entry, q));
      items = applyDoneFilter(items);
      if (items.length > 200) {
        items = items.slice(0, 200);
        capped = true;
      }
    } else if (logbookList) {
      items = applyDoneFilter(state.globalEntries);
      if (mapFilterStrictActive()) {
        items = items.filter((e) => isEntryMapActive(e));
      }
      if (items.length > 200) {
        items = items.slice(0, 200);
        capped = true;
      }
    } else if (state.currentRegionUrl && state.climbs.length) {
      const country = selectedCountryCode() || String(state.bundle?.meta?.country || "").toUpperCase();
      items = state.climbs.map((climb) => ({
        climb,
        regionUrl: state.currentRegionUrl,
        regionTitle: state.bundle?.meta?.title || "",
        regionId: state.bundle?.meta?.id || "",
        country,
      }));
      items = applyDoneFilter(items);
      if (state.userLatLng) {
        items = sortEntriesByDistance(items, state.userLatLng);
      }
    } else if (selectedCountryCode() && mapEntriesAvailable()) {
      items = applyDoneFilter(state.globalEntries.filter((e) => isEntryMapActive(e)));
      if (state.userLatLng) {
        items = sortEntriesByDistance(items, state.userLatLng);
      }
      if (items.length > 200) {
        items = items.slice(0, 200);
        capped = true;
      }
    } else if (mapEntriesAvailable() && state.userLatLng && state.map) {
      items = sortEntriesByDistance(entriesInMapBounds(), state.userLatLng);
      if (items.length > 200) {
        items = items.slice(0, 200);
        capped = true;
      }
    } else {
      list.innerHTML =
        '<p class="list-hint">Kies een regio voor de lijst, of gebruik logboek (al gedaan / nog niet) of zoeken voor alle klimmen.</p>';
      updateClimbLogSummary();
      return;
    }

    if (!items.length) {
      if (q) {
        list.innerHTML =
          isLogbookFilterActive()
            ? '<p class="list-hint">Geen klimmen voor dit logboek-filter.</p>'
            : '<p class="list-hint">Geen klimmen gevonden in alle regio’s.</p>';
      } else {
        list.innerHTML = '<p class="list-hint">Geen klimmen voor dit logboek-filter.</p>';
      }
      updateClimbLogSummary();
      return;
    }

    for (const entry of items) {
      const climb = entry.climb;
      const done = climbIsDone(entry);
      const wish = climbIsWishlist(entry);
      const el = document.createElement("div");
      el.className =
        "climb-item" +
        (climb.id === state.selectedId ? " active" : "") +
        (done ? " climb-item--done" : "") +
        (wish ? " climb-item--wishlist" : "");
      el.dataset.id = climb.id;
      const tags = (climb.tags || [])
        .slice(0, 3)
        .map((t) => `<span class="badge">${t}</span>`)
        .join("");
      const cf = climb.climbfinder?.url
        ? `<a href="${climb.climbfinder.url}" target="_blank" rel="noopener" class="text-teal-700 text-xs">Climbfinder</a>`
        : "";
      const datasetLine =
        (q || logbookList) && entry.regionTitle
          ? `<div class="dataset-tag">${displayRegionTitle(entry.regionTitle)}</div>`
          : "";
      el.innerHTML = `
        ${climbStatusToggleButtonsHtml(entry)}
        <div class="climb-item-body">
          <h3 class="climb-item-title">${categoryBadgeHtml(climb, "sm")}<span>${climb.name}</span></h3>
          ${datasetLine}
          <div class="meta">${formatKm(climb.stats.length_m)} · ${climb.stats.avg_gradient_pct}% gem. · +${formatM(climb.stats.elevation_gain_m)}${klimpuntenListSuffix(climb)} · ${climb.region || ""}${steepestLabel(climb)}</div>
          <div>${tags} ${cf}</div>
        </div>
      `;
      bindClimbStatusToggleButtons(el, entry);
      el.addEventListener("click", (e) => {
        if (e.target.closest(".climb-status-toggles")) return;
        if (e.target.tagName === "A") return;
        void selectClimbFromList(climb.id, entry.regionUrl);
      });
      if (!isCoarsePointer()) {
        el.addEventListener("mouseenter", () => {
          if (state.mapMode === "detail") return;
          onMapRouteHover(entry);
        });
        el.addEventListener("mouseleave", () => scheduleClearRouteHover(entry));
      }
      list.appendChild(el);
    }
    updateClimbLogSummary();
    if (partialIndex) {
      const hint = document.createElement("p");
      hint.className = "list-hint";
      hint.textContent =
        globalIndexLoadProgressText() ||
        "Nog niet alle regio’s geladen — resultaten kunnen incompleet zijn.";
      list.appendChild(hint);
    }
    if (capped && state.globalEntries.length) {
      const hint = document.createElement("p");
      hint.className = "list-hint";
      hint.textContent = logbookList
        ? "Eerste 200 resultaten — kies een regio of verfijn met zoeken."
        : state.userLatLng && !q
          ? "Eerste 200 klimmen in de kaart rond jou — zoom/pan of kies een regio."
          : "Eerste 200 resultaten — verfijn je zoekterm.";
      list.appendChild(hint);
    }
  }

  async function loadRegionBundle(r) {
    if (state.regionCache.has(r.url)) return state.regionCache.get(r.url);
    const bundle = await loadJson(r.url);
    state.regionCache.set(r.url, bundle);
    return bundle;
  }

  function reprioritizeGlobalEntriesForCurrentRegion() {
    if (!state.globalSearchReady || !state.currentRegionUrl || !state.bundle) return;
    const r = state.indexRegions.find((x) => x.url === state.currentRegionUrl);
    if (!r) return;
    mergeBundleIntoGlobalEntries(r, state.bundle);
  }

  function mergeBundleIntoGlobalEntries(r, bundle) {
    if (!state.globalEntryByClimbKey) state.globalEntryByClimbKey = new Map();
    const seenRegionKeys = new Set(state.globalEntries.map((e) => entryKey(e)));

    for (const c of bundle.climbs || []) {
      const regionKey = entryKey({ regionUrl: r.url, climb: { id: c.id } });
      if (seenRegionKeys.has(regionKey)) continue;

      const entry = {
        climb: c,
        regionUrl: r.url,
        regionTitle: regionTitleFromIndexEntry(r),
        regionId: r.id,
        country: String(r.country || bundle.meta?.country || "").toUpperCase(),
      };

      const globalKey = climbGlobalKey(c);
      if (globalKey) {
        const prev = state.globalEntryByClimbKey.get(globalKey);
        if (prev) {
          if (!shouldPreferGlobalEntry(entry, prev)) continue;
          const idx = state.globalEntries.indexOf(prev);
          if (idx >= 0) state.globalEntries.splice(idx, 1);
          seenRegionKeys.delete(entryKey(prev));
          state.globalEntryByClimbKey.set(globalKey, entry);
        } else {
          state.globalEntryByClimbKey.set(globalKey, entry);
        }
      }

      seenRegionKeys.add(regionKey);
      state.globalEntries.push(entry);
    }
    invalidateSpatialIndex();
  }

  function seedGlobalEntriesFromCurrentRegion() {
    if (!state.bundle || !state.currentRegionUrl || state.globalSearchReady) return;
    const r = state.indexRegions.find((x) => x.url === state.currentRegionUrl);
    if (!r) return;
    state.globalEntries = [];
    state.globalEntryByClimbKey = new Map();
    invalidateSpatialIndex();
    mergeBundleIntoGlobalEntries(r, state.bundle);
    syncOverviewMarkers({ fit: shouldAutoFitMapBounds() });
    updateSearchHint();
  }

  async function waitForGlobalSearchIndex() {
    if (state.globalSearchReady) return;
    await new Promise((resolve) => {
      const tick = () => {
        if (state.globalSearchReady) {
          resolve();
          return;
        }
        if (!state.searchBusy) {
          resolve();
          return;
        }
        setTimeout(tick, 40);
      };
      tick();
    });
    if (!state.globalSearchReady) await ensureGlobalSearchIndex({ background: false });
  }

  async function ensureGlobalSearchIndex(options = {}) {
    const { background = false } = options;
    if (state.globalSearchReady) return;
    if (state.searchBusy) {
      if (!background) await waitForGlobalSearchIndex();
      return;
    }
    state.searchBusy = true;
    if (!background) renderList(state.searchQuery);
    const regions = state.indexRegions;
    if (!state.globalEntries.length && !background) {
      state.globalEntries = [];
      state.globalEntryByClimbKey = new Map();
    }
    const loadOrder = [...regions].sort((a, b) => (a.count || 0) - (b.count || 0));
    if (state.currentRegionUrl) {
      const curIdx = loadOrder.findIndex((r) => r.url === state.currentRegionUrl);
      if (curIdx > 0) {
        const [cur] = loadOrder.splice(curIdx, 1);
        loadOrder.unshift(cur);
      }
    }
    state.globalIndexProgress = { loadedRegions: 0, totalRegions: loadOrder.length };
    updateSearchHint();
    let next = 0;
    const workers = Math.min(8, Math.max(1, loadOrder.length));

    async function worker() {
      while (next < loadOrder.length) {
        const i = next++;
        const r = loadOrder[i];
        try {
          const bundle = await loadRegionBundle(r);
          mergeBundleIntoGlobalEntries(r, bundle);
          if (state.globalIndexProgress) {
            state.globalIndexProgress.loadedRegions += 1;
          }
          if (background) scheduleDeferredMapSync();
          else if (state.globalIndexProgress.loadedRegions % 3 === 0) updateSearchHint();
        } catch (err) {
          console.warn("Dataset laden mislukt:", r.url, err);
          if (state.globalIndexProgress) state.globalIndexProgress.loadedRegions += 1;
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: workers }, () => worker()));
      state.globalSearchReady = true;
      state.globalIndexProgress = null;
      syncOverviewMarkers({
        fit: !background && !state.searchQuery.trim() && shouldAutoFitMapBounds(),
      });
    } finally {
      state.searchBusy = false;
      state.globalIndexProgress = null;
      renderList(state.searchQuery);
      updateSearchHint();
    }
  }

  function resetSearchToOverview() {
    state.searchQuery = "";
    const input = $("searchInput");
    if (input && input.value !== "") input.value = "";
    hideSearchSuggest();
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    clearDetailSelection();
    state.mapExploreAllRegions = false;
    renderList("");
    if (mapEntriesAvailable()) syncOverviewMarkers({ fit: true });
    updateSearchHint();
  }

  function setSearchSuggestOpen(open) {
    const input = $("searchInput");
    const list = $("searchSuggestList");
    if (input) input.setAttribute("aria-expanded", open ? "true" : "false");
    if (list) list.hidden = !open;
  }

  function hideSearchSuggest() {
    state.searchSuggestHits = [];
    state.searchSuggestActive = -1;
    const list = $("searchSuggestList");
    if (list) {
      list.innerHTML = "";
      list.hidden = true;
    }
    setSearchSuggestOpen(false);
  }

  function scoreSearchEntry(entry, ql) {
    if (!entryMatchesSuggestQuery(entry, ql)) return 0;
    const name = (entry.climb.name || "").toLowerCase();
    const id = (entry.climb.id || "").toLowerCase();
    if (name === ql) return 100;
    if (id === ql) return 95;
    if (name.startsWith(ql)) return 85;
    if (name.includes(ql)) return 70;
    if (id.includes(ql)) return 65;
    return 0;
  }

  function rankSearchEntries(q, limit = 14) {
    const ql = q.trim().toLowerCase();
    if (ql.length < 2) return [];
    const scored = [];
    for (const entry of state.globalEntries) {
      const score = scoreSearchEntry(entry, ql);
      if (score) scored.push({ entry, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.climb.name.localeCompare(b.entry.climb.name, "nl", { sensitivity: "base" })
    );
    return scored.slice(0, limit).map((s) => s.entry);
  }

  function renderSearchSuggest(hits, q) {
    const list = $("searchSuggestList");
    if (!list) return;
    state.searchSuggestHits = hits;
    state.searchSuggestActive = -1;
    if (!q.trim()) {
      hideSearchSuggest();
      return;
    }
    if (!hits.length) {
      list.innerHTML =
        '<li class="climb-search-suggest-empty" role="presentation">Geen treffers — Enter zoekt over alle regio’s</li>';
      setSearchSuggestOpen(true);
      return;
    }
    list.innerHTML = hits
      .map((entry, i) => {
        const reg = displayRegionTitle(entry.regionTitle || "");
        const c = String(entry.country || "").toUpperCase();
        return `<li role="option" data-index="${i}" id="searchSuggestOpt${i}">
          <span class="climb-search-suggest-name">${escapeHtml(entry.climb.name)}</span>
          <span class="climb-search-suggest-meta">${escapeHtml(reg)} · ${escapeHtml(c)}</span>
        </li>`;
      })
      .join("");
    list.innerHTML +=
      '<li class="climb-search-suggest-hint" role="presentation">Enter = alle treffers op kaart</li>';
    setSearchSuggestOpen(true);
  }

  function highlightSearchSuggestOption(index) {
    const list = $("searchSuggestList");
    if (!list) return;
    list.querySelectorAll("li[data-index]").forEach((li) => {
      li.classList.toggle("is-active", Number(li.dataset.index) === index);
    });
    state.searchSuggestActive = index;
    const el = list.querySelector(`#searchSuggestOpt${index}`);
    el?.scrollIntoView({ block: "nearest" });
  }

  async function pickSearchSuggestion(index) {
    const entry = state.searchSuggestHits?.[index];
    if (!entry) return;
    hideSearchSuggest();
    const input = $("searchInput");
    if (input) input.value = entry.climb.name;
    state.searchQuery = "";
    state.regionFiltersTouched = true;
    state.mapExploreAllRegions = false;
    await selectClimbFromList(entry.climb.id, entry.regionUrl);
    if (isMobileLayout()) setMobilePane("map");
    updateMobileFiltersSummary();
    updateSearchHint();
  }

  async function refreshSearchSuggest(raw) {
    const q = raw.trim();
    if (q.length < 2) {
      hideSearchSuggest();
      if (!q && state.searchQuery) resetSearchToOverview();
      return;
    }
    await ensureGlobalSearchIndex({ background: true });
    renderSearchSuggest(rankSearchEntries(q), q);
  }

  async function applySearchQuery(raw) {
    const q = raw.trim();
    state.searchQuery = q;
    hideSearchSuggest();
    if (!q) {
      resetSearchToOverview();
      return;
    }
    state.mapExploreAllRegions = true;
    await ensureGlobalSearchIndex();
    clearDetailSelection();
    syncOverviewMarkers({ fit: true });
    renderList(q);
    updateSearchHint();
  }

  function initClimbSearchSuggest() {
    const input = $("searchInput");
    const wrap = $("climbSearchWrap");
    const list = $("searchSuggestList");
    if (!input) return;

    let suggestTimer = null;

    input.addEventListener("input", (e) => {
      const q = e.target.value;
      if (suggestTimer) clearTimeout(suggestTimer);
      suggestTimer = setTimeout(() => void refreshSearchSuggest(q), 140);
    });

    input.addEventListener("focus", () => {
      if (isMobileLayout()) setMobileFiltersOpen(true);
      if (input.value.trim().length >= 2) void refreshSearchSuggest(input.value);
    });

    input.addEventListener("keydown", (e) => {
      const hits = state.searchSuggestHits || [];
      if (e.key === "ArrowDown" && hits.length) {
        e.preventDefault();
        const next = state.searchSuggestActive + 1;
        highlightSearchSuggestOption(next >= hits.length ? 0 : next);
        return;
      }
      if (e.key === "ArrowUp" && hits.length) {
        e.preventDefault();
        const prev = state.searchSuggestActive - 1;
        highlightSearchSuggestOption(prev < 0 ? hits.length - 1 : prev);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (state.searchSuggestActive >= 0 && hits[state.searchSuggestActive]) {
          void pickSearchSuggestion(state.searchSuggestActive);
          return;
        }
        hideSearchSuggest();
        void applySearchQuery(input.value);
        return;
      }
      if (e.key === "Escape") {
        hideSearchSuggest();
      }
    });

    input.addEventListener("search", () => {
      if (!input.value.trim()) resetSearchToOverview();
    });

    list?.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-index]");
      if (!li) return;
      void pickSearchSuggestion(Number(li.dataset.index));
    });

    document.addEventListener("click", (e) => {
      if (wrap?.contains(e.target)) return;
      hideSearchSuggest();
    });
  }

  async function selectClimbFromList(id, regionUrl) {
    if (mapFilterStrictActive() && regionUrl) {
      const reg = state.indexRegions.find((r) => r.url === regionUrl);
      const probe = { regionUrl, country: reg?.country || "" };
      if (isEntryOutsideMapFilter(probe)) {
        state.mapExploreAllRegions = true;
      }
    }
    if (regionUrl && regionUrl !== state.currentRegionUrl) {
      syncCountrySelectForRegionUrl(regionUrl);
      const select = $("regionSelect");
      if (select.value !== regionUrl) select.value = regionUrl;
      await loadRegion(regionUrl, { keepSearch: true, selectId: id });
      select.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    } else {
      selectClimb(id);
    }
  }

  function clearMapLayers() {
    if (state.routeLayerOutline) {
      state.map.removeLayer(state.routeLayerOutline);
      state.routeLayerOutline = null;
    }
    if (state.routeLayer) {
      state.map.removeLayer(state.routeLayer);
      state.routeLayer = null;
    }
    for (const m of state.markers) state.map.removeLayer(m);
    state.markers = [];
    if (state.hoverMarker) {
      state.map.removeLayer(state.hoverMarker);
      state.hoverMarker = null;
    }
    clearRouteHoverHighlight();
    if (state.hoverPreviewTimer) {
      clearTimeout(state.hoverPreviewTimer);
      state.hoverPreviewTimer = null;
    }
    clearViewportLayers();
  }

  function geometryIndexForProfile(climb, profileIndex) {
    const coords = climb.geometry.coordinates;
    const dist = climb.profile.distances_m;
    if (!coords.length || !dist.length) return 0;
    const targetM = dist[profileIndex] ?? dist[dist.length - 1];
    const total = dist[dist.length - 1] || 1;
    const ratio = targetM / total;
    return Math.min(coords.length - 1, Math.max(0, Math.round(ratio * (coords.length - 1))));
  }

  function segmentGradientsForChart(climb) {
    if (typeof ClimbMetrics !== "undefined") {
      return ClimbMetrics.gradientsForClimb(climb);
    }
    const dist = climb.profile.distances_m;
    const elev = climb.profile.elevations_m;
    const out = [0];
    for (let i = 1; i < elev.length; i++) {
      const d = dist[i] - dist[i - 1];
      out.push(d > 0 ? (100 * (elev[i] - elev[i - 1])) / d : 0);
    }
    return out;
  }

  function bucketAtDistanceKm(buckets, km) {
    if (!buckets?.length) return null;
    return buckets.find((b) => km >= b.startKm && km <= b.endKm + 1e-6) || buckets[buckets.length - 1];
  }

  function ensureProfileChartPlugin() {
    if (typeof ClimbMetrics === "undefined" || window.__fietsklimProfileFillRegistered) return;
    Chart.register(ClimbMetrics.profileFillPlugin);
    window.__fietsklimProfileFillRegistered = true;
  }

  function mountProfileChart(canvasId, chartKey, climb, compact) {
    ensureProfileChartPlugin();
    const canvas = $(canvasId);
    if (!canvas) return;
    const points = profilePoints(climb);
    const elevValues = points.map((p) => p.y);
    const bounds = yAxisBounds(elevValues);
    const segGrad = segmentGradientsForChart(climb);
    const buckets =
      typeof ClimbMetrics !== "undefined" ? ClimbMetrics.profileBuckets(climb) : [];

    destroyProfileChart(chartKey);

    state[chartKey] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        datasets: [
          {
            label: "Hoogte (m)",
            data: points,
            parsing: false,
            borderColor: "rgba(15,23,42,0.35)",
            backgroundColor: "transparent",
            fill: false,
            pointRadius: 0,
            borderWidth: compact ? 1.25 : 1.5,
            tension: 0.12,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: {
          legend: { display: false },
          fietsklimProfileFill: {
            buckets,
            profile: climb.profile,
          },
          tooltip: {
            callbacks: {
              title: (items) => `${items[0].parsed.x.toFixed(2)} km`,
              label: (item) => {
                const idx = item.dataIndex;
                const g = segGrad[idx];
                const lines = [`${item.parsed.y.toFixed(1)} m hoogte`];
                if (g != null && Number.isFinite(g)) lines.push(`${g.toFixed(1)}% helling (profiel)`);
                const block = bucketAtDistanceKm(buckets, item.parsed.x);
                if (block) {
                  lines.push(
                    `Blok ${block.startKm.toFixed(1)}–${block.endKm.toFixed(1)} km: gem. ${block.gradientPct}%`
                  );
                }
                return lines;
              },
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            title: { display: !compact, text: "Afstand (km)" },
            ticks: { maxTicksLimit: compact ? 5 : 10 },
          },
          y: {
            type: "linear",
            min: bounds.min,
            max: bounds.max,
            title: { display: !compact, text: "Hoogte (m)" },
            ticks: { maxTicksLimit: compact ? 5 : 8 },
          },
        },
        onHover: (_evt, elements) => {
          if (!elements.length || !state.activeClimb) return;
          setProfileHoverPosition(state.activeClimb, elements[0].index);
        },
      },
    });
  }

  function updateChart(climb) {
    const list = $("climbList");
    const scrollTop = list?.scrollTop ?? 0;
    const sameClimb = state.activeClimb?.id === climb.id;

    state.activeClimb = climb;
    setClimbDetailVisible(true);
    closeProfileExpand();

    const st = climb.stats || {};
    $("profileTitle").textContent = climb.name;
    syncCategoryBadgeElement(climb, "profileCategoryBadge");
    $("profileStats").textContent = climbStatsLine(st, climb);
    syncKlimpuntenRow(climb, "profileKlimpunten");
    syncStreetViewRow(climb, "profileStreetView");

    const buckets =
      typeof ClimbMetrics !== "undefined" ? ClimbMetrics.profileBuckets(climb) : [];
    renderGradientStrip(buckets, "profileGradientStripMini");
    if (!sameClimb) {
      mountProfileChart("profileChartMini", "chartMini", climb, true);
    } else if (state.chartMini) {
      state.chartMini.resize();
    }
    syncClimbDetailDoneToggle();

    requestAnimationFrame(() => {
      if (list) list.scrollTop = scrollTop;
    });
  }

  function stopRouteClickToMap(e) {
    L.DomEvent.stopPropagation(e);
  }

  function buildGradientRouteLayer(climb, latlngs, options = {}) {
    const {
      outlineWeight = 10,
      segmentWeight = 7,
      interactive = true,
      fallbackStyle = ROUTE_STYLE.detail,
    } = options;
    const group = L.layerGroup();
    L.polyline(latlngs, {
      color: "#ffffff",
      weight: outlineWeight,
      opacity: 0.96,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(group);

    const segments =
      typeof ClimbMetrics !== "undefined" ? ClimbMetrics.routeGradientSegments(climb) : [];

    if (segments.length) {
      for (const seg of segments) {
        const line = L.polyline(seg.latlngs, {
          color: seg.color,
          weight: segmentWeight,
          opacity: 1,
          lineCap: "round",
          lineJoin: "round",
          interactive,
        });
        if (interactive) {
          line.bindTooltip(`${seg.gradientPct}% gem.`, { sticky: true, direction: "top" });
          line.on("click", stopRouteClickToMap);
        }
        line.addTo(group);
      }
    } else {
      const fallback = L.polyline(latlngs, { ...fallbackStyle, interactive });
      if (interactive) fallback.on("click", stopRouteClickToMap);
      fallback.addTo(group);
    }

    return group;
  }

  function buildDetailRouteLayer(climb, latlngs) {
    return buildGradientRouteLayer(climb, latlngs, {
      outlineWeight: 10,
      segmentWeight: 7,
      interactive: true,
      fallbackStyle: ROUTE_STYLE.detail,
    });
  }

  function selectClimb(id) {
    const climb = state.climbs.find((c) => c.id === id);
    if (!climb) return;
    state.selectedId = id;
    state.mapMode = "detail";
    updateOverviewBackButton();
    renderList(state.searchQuery);

    if (state.overviewCluster) state.overviewCluster.clearLayers();
    clearMapLayers();
    const latlngs = latLngsFromClimb(climb);
    state.routeLayerOutline = null;
    state.routeLayer = buildDetailRouteLayer(climb, latlngs);
    state.routeLayer.addTo(state.map);
    state.markers.push(...addClimbStartEndMarkers(latlngs, { size: "md", tooltip: climb.name }));
    state.map.fitBounds(L.latLngBounds(latlngs), { padding: [30, 30] });
    clearRouteHoverHighlight();
    updateChart(climb);
    afterClimbSelectedOnMobile(climb);
    syncClimbDetailDoneToggle();
    syncClimbNavBackBar();

    if (window.location.hash !== `#${id}`) {
      history.replaceState(null, "", window.location.pathname + window.location.search + `#${id}`);
    }
  }

  const GEO_LOCATE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';

  function updateGeoLocateUi() {
    const btn = state.geoLocateBtn;
    if (!btn) return;
    const on = state.geoWatchId != null;
    btn.classList.toggle("is-active", on);
    btn.classList.toggle("is-following", on && state.geoFollow);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on
      ? state.geoFollow
        ? "Locatie volgen uit (tik opnieuw)"
        : "Locatie getoond — tik om kaart weer te volgen"
      : "Mijn locatie op de kaart (volgen)";
  }

  function clearGeoWatchOnly() {
    if (state.geoWatchId != null) {
      navigator.geolocation.clearWatch(state.geoWatchId);
      state.geoWatchId = null;
    }
  }

  function stopGeoLocate() {
    clearGeoWatchOnly();
    state.geoAcquireInFlight = false;
    state.geoFollow = false;
    if (state.geoMarker && state.map) {
      state.map.removeLayer(state.geoMarker);
      state.geoMarker = null;
    }
    if (state.geoAccuracy && state.map) {
      state.map.removeLayer(state.geoAccuracy);
      state.geoAccuracy = null;
    }
    updateGeoLocateUi();
  }

  function geoAcquireOptions(highAccuracy, { extended = false } = {}) {
    let timeout = highAccuracy ? 50000 : 60000;
    if (extended) timeout = Math.max(timeout, 120000);
    return {
      enableHighAccuracy: highAccuracy,
      maximumAge: highAccuracy ? 15000 : 120000,
      timeout,
    };
  }

  function geoWatchUpdateOptions() {
    return {
      enableHighAccuracy: false,
      maximumAge: 15000,
      timeout: 60000,
    };
  }

  async function queryGeoPermission() {
    if (!navigator.permissions?.query) return null;
    try {
      const status = await navigator.permissions.query({ name: "geolocation" });
      return status.state;
    } catch {
      return null;
    }
  }

  const BRAVE_GEO_HINT_KEY = "fietsklim.braveGeoHintSeen";

  async function isBraveBrowser() {
    if (navigator.brave?.isBrave) {
      try {
        return await navigator.brave.isBrave();
      } catch {
        return true;
      }
    }
    return /Brave/i.test(navigator.userAgent);
  }

  function braveAndroidAppPermissionHint() {
    return (
      " Brave/Android: controleer ook app-locatie via Instellingen → Apps → Brave → Machtigingen → Locatie → Toestaan. " +
      "Open FietsKlim daarna opnieuw via het icoon op je startscherm (PWA), niet alleen een tabblad."
    );
  }

  async function maybeAppendBraveGeoHint(baseMsg, { force = false } = {}) {
    let msg = baseMsg;
    const brave = await isBraveBrowser();
    if (!brave && !force) return msg;
    try {
      if (!force && localStorage.getItem(BRAVE_GEO_HINT_KEY) === "1") return msg;
      localStorage.setItem(BRAVE_GEO_HINT_KEY, "1");
    } catch {
      /* ignore */
    }
    msg += braveAndroidAppPermissionHint();
    return msg;
  }

  function buildGeoErrorMessage(err, permissionState) {
    const code = err?.code;
    if (code === 1) {
      if (permissionState === "granted") {
        return (
          "Locatie staat voor deze site op Toegestaan, maar de browser gaf geen GPS-fix (typisch bij PWA/Brave). " +
          "Zet locatie/GPS aan op je telefoon en controleer browser-app-machtigingen."
        );
      }
      if (permissionState === "denied") {
        return (
          "Locatie is geblokkeerd voor deze site. Tik op het slot-icoon naast het adres → " +
          "Site-instellingen → Locatie → Toestaan, en laad de pagina opnieuw."
        );
      }
      return (
        "Geen toestemming voor locatie. Sta locatie toe via het slot-icoon / site-instellingen " +
        "van je browser (niet alleen systeem-GPS)."
      );
    }
    if (code === 2) {
      return "Locatie niet beschikbaar (GPS uit, binnen zonder signaal, of vliegtuigstand?).";
    }
    if (code === 3) {
      return "Locatie opvragen duurde te lang. Ga naar buiten of probeer het opnieuw (eventueel zonder hoge nauwkeurigheid).";
    }
    return "Locatie kon niet worden bepaald. Probeer opnieuw of controleer GPS en browserinstellingen.";
  }

  async function notifyGeoError(err) {
    console.warn("Geolocatie:", err);
    stopGeoLocate();
    state.geoLocateRetried = false;
    state.geoExtendedLocateRetry = false;
    if (state.geoInitialCenter) state.geoInitialCenter = false;
    const perm = await queryGeoPermission();
    let msg = buildGeoErrorMessage(err, perm);
    const needsBraveHint =
      perm === "granted" || err?.code === 1 || err?.code === 2 || (await isBraveBrowser());
    if (needsBraveHint) {
      msg = await maybeAppendBraveGeoHint(msg, { force: perm === "granted" });
    }
    setGeoHint(msg, { warn: true });
  }

  function onGeoPosition(pos) {
    if (!state.map) return;
    state.geoLocateRetried = false;
    state.geoExtendedLocateRetry = false;
    const { latitude, longitude, accuracy } = pos.coords;
    const latlng = L.latLng(latitude, longitude);
    state.userLatLng = latlng;
    const acc = Math.max(accuracy || 25, 8);
    const firstFix = state.geoInitialCenter;

    if (!state.geoMarker) {
      state.geoAccuracy = L.circle(latlng, {
        radius: acc,
        color: "#2563eb",
        weight: 1,
        fillColor: "#3b82f6",
        fillOpacity: 0.15,
        interactive: false,
      }).addTo(state.map);
      state.geoMarker = L.circleMarker(latlng, {
        radius: 8,
        color: "#fff",
        weight: 2,
        fillColor: "#2563eb",
        fillOpacity: 1,
        interactive: false,
      }).addTo(state.map);
    } else {
      state.geoAccuracy.setLatLng(latlng).setRadius(acc);
      state.geoMarker.setLatLng(latlng);
    }

    if (state.geoFollow) {
      const z = Math.max(state.map.getZoom(), isMobileLayout() ? 14 : 13);
      state.map.setView(latlng, z, { animate: !isCoarsePointer() && !firstFix });
    }
    if (firstFix) {
      state.geoInitialCenter = false;
      state.mapMode = state.map.getZoom() >= MIN_ZOOM_NEARBY_ROUTES ? "local" : "overview";
      void applyRegionFromUserLocation(latlng);
      if (mapEntriesAvailable()) {
        syncOverviewMarkers({ fit: false });
        refreshViewportClimbs();
      }
      renderList(state.searchQuery);
    }
    clearGeoHintOverride();
    updateGeoLocateUi();
  }

  async function handleGeoAcquireError(err, { silent, highAccuracy }) {
    if (silent) {
      console.warn("Geolocatie (achtergrond):", err);
      state.geoInitialCenter = false;
      state.geoAcquireInFlight = false;
      clearGeoWatchOnly();
      state.geoFollow = false;
      updateGeoLocateUi();
      return;
    }
    if (!highAccuracy && !state.geoLocateRetried) {
      state.geoLocateRetried = true;
      requestGeoFix(false, true);
      return;
    }
    if (err?.code === 1 && !state.geoExtendedLocateRetry) {
      const perm = await queryGeoPermission();
      if (perm === "granted" && (await isBraveBrowser())) {
        state.geoExtendedLocateRetry = true;
        setGeoHint("Locatie opvragen… (Brave kan extra lang duren)", { warn: false });
        requestGeoFix(false, highAccuracy, { extended: true });
        return;
      }
    }
    await notifyGeoError(err);
  }

  function startGeoWatchUpdates() {
    clearGeoWatchOnly();
    state.geoWatchId = navigator.geolocation.watchPosition(
      onGeoPosition,
      (err) => {
        if (state.userLatLng) {
          console.warn("Geolocatie (watch):", err);
          return;
        }
        void handleGeoAcquireError(err, { silent: true, highAccuracy: false });
      },
      geoWatchUpdateOptions()
    );
    updateGeoLocateUi();
  }

  function requestGeoFix(silent, highAccuracy, { extended = false } = {}) {
    if (state.geoAcquireInFlight) return;
    state.geoAcquireInFlight = true;
    state.geoFollow = true;
    if (!state.userLatLng) state.geoInitialCenter = true;
    clearGeoWatchOnly();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.geoAcquireInFlight = false;
        onGeoPosition(pos);
        startGeoWatchUpdates();
      },
      (err) => {
        state.geoAcquireInFlight = false;
        void handleGeoAcquireError(err, { silent, highAccuracy });
      },
      geoAcquireOptions(highAccuracy, { extended })
    );
    updateGeoLocateUi();
  }

  function startGeoLocate(options = {}) {
    const { silent = false, highAccuracy = false } = options;
    if (!navigator.geolocation) {
      if (!silent) {
        setGeoHint("Geolocatie wordt niet ondersteund in deze browser.", { warn: true });
      }
      return;
    }
    if (!silent) {
      state.geoLocateRetried = false;
      state.geoExtendedLocateRetry = false;
      setGeoHint("Locatie opvragen… (kan een halve minuut duren)", { warn: false });
    }
    requestGeoFix(silent, highAccuracy);
  }

  function toggleGeoLocate() {
    if (!navigator.geolocation) {
      setGeoHint("Geolocatie wordt niet ondersteund in deze browser.", { warn: true });
      return;
    }
    const waitingForFix =
      state.geoAcquireInFlight || (state.geoWatchId != null && !state.userLatLng);
    if (waitingForFix) {
      clearGeoWatchOnly();
      state.geoAcquireInFlight = false;
      startGeoLocate({ silent: false, highAccuracy: false });
      return;
    }
    if (state.geoWatchId != null || state.userLatLng) {
      if (!state.geoFollow) {
        state.geoFollow = true;
        updateGeoLocateUi();
        if (state.userLatLng) {
          const z = Math.max(state.map.getZoom(), isMobileLayout() ? 14 : 13);
          state.map.setView(state.userLatLng, z);
        }
        if (!state.geoWatchId) startGeoWatchUpdates();
        return;
      }
      stopGeoLocate();
      return;
    }
    startGeoLocate({ silent: false, highAccuracy: false });
  }

  function initGeoLocateControl() {
    if (!state.map || state.geoLocateBtn) return;

    const LocateControl = L.Control.extend({
      options: { position: "bottomright" },
      onAdd() {
        const wrap = L.DomUtil.create("div", "leaflet-bar leaflet-control fietsklim-locate-control");
        const btn = L.DomUtil.create("button", "fietsklim-locate-btn", wrap);
        btn.type = "button";
        btn.innerHTML = GEO_LOCATE_SVG;
        btn.setAttribute("aria-label", "Mijn locatie op de kaart");
        btn.setAttribute("aria-pressed", "false");
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.on(btn, "click", (e) => {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          toggleGeoLocate();
        });
        state.geoLocateBtn = btn;
        return wrap;
      },
    });
    state.map.addControl(new LocateControl());

    state.map.on("dragstart", () => {
      if (state.geoWatchId != null && state.geoFollow) {
        state.geoFollow = false;
        updateGeoLocateUi();
      }
    });
  }

  const CARTO_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attribution/">CARTO</a>';

  const CARTO_KEY_PLACEHOLDER_RE =
    /^(?:PLAK_HIER(?:_CARTO_API_KEY)?|YOUR_KEY|jouw-sleutel-hier|changeme|xxx+|test)$/i;

  function resolveCartoApiKey() {
    const cfg = window.FIETSKLIM_AUTH_CONFIG;
    if (!cfg || typeof cfg !== "object") return "";
    const tiles = cfg.mapTiles;
    const raw =
      (tiles && typeof tiles === "object" ? tiles.cartoApiKey : undefined) ??
      cfg.CARTO_API_KEY ??
      cfg.cartoApiKey ??
      "";
    const key = String(raw).trim();
    if (!key || CARTO_KEY_PLACEHOLDER_RE.test(key) || /PLAK_HIER/i.test(key)) return "";
    return key;
  }

  function cartoVoyagerLayerLabel(hasValidKey) {
    return hasValidKey
      ? "Carto Voyager"
      : "Carto Voyager (API-sleutel in firebase-config.js)";
  }

  /** Gratis CARTO-sleutel: tegels vaak tot z18 (z19+ → HTTP 403). Zie MAP_TILES.md */
  const CARTO_VOYAGER_MAX_ZOOM = 18;

  function cartoVoyagerTileLayer(apiKey) {
    const keyQuery = apiKey ? `?key=${encodeURIComponent(apiKey)}` : "";
    return L.tileLayer(
      `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png${keyQuery}`,
      {
        maxZoom: CARTO_VOYAGER_MAX_ZOOM,
        maxNativeZoom: CARTO_VOYAGER_MAX_ZOOM,
        subdomains: "abcd",
        attribution: CARTO_ATTRIBUTION,
      }
    );
  }

  function maxZoomForBaseLayer(layer) {
    if (!layer) return 19;
    if (typeof layer.getMaxZoom === "function") {
      const z = layer.getMaxZoom();
      if (Number.isFinite(z)) return z;
    }
    if (typeof layer.eachLayer === "function") {
      let maxZ = 0;
      layer.eachLayer((child) => {
        const cz = child.options?.maxZoom;
        if (Number.isFinite(cz)) maxZ = Math.max(maxZ, cz);
      });
      return maxZ || 19;
    }
    return layer.options?.maxZoom ?? 19;
  }

  function syncMapZoomLimitsToBaseLayer(layer) {
    if (!state.map || !layer) return;
    const maxZ = maxZoomForBaseLayer(layer);
    state.map.setMaxZoom(maxZ);
    if (state.map.getZoom() > maxZ) state.map.setZoom(maxZ);
  }

  function esriWorldTopoBasemap() {
    return L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 19,
        attribution:
          'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, DeLorme, NAVTEQ, TomTom, USGS, EPA, NPS',
      }
    );
  }

  function initMap() {
    if (state.map) return;
    if (typeof L === "undefined") {
      throw new Error("Leaflet (kaart) is niet geladen. Check netwerk/adblocker.");
    }
    state.map = L.map("map", {
      zoomControl: false,
      keyboard: false,
      tapTolerance: isCoarsePointer() ? 28 : 15,
    });
    L.control.zoom({ position: "topleft" }).addTo(state.map);

    const cartoApiKey = resolveCartoApiKey();
    const cartoVoyagerLabel = cartoVoyagerLayerLabel(Boolean(cartoApiKey));
    state.mapTilesHint = cartoApiKey
      ? null
      : "Carto Voyager staat in het lagenmenu; vul mapTiles.cartoApiKey in docs/auth/firebase-config.js en ververs de pagina (Ctrl+F5).";
    const esriGrayAttribution =
      'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom';
    function esriLightGrayBasemap() {
      const base = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 16, attribution: esriGrayAttribution }
      );
      const labels = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 16, pane: "overlayPane" }
      );
      return L.layerGroup([base, labels]);
    }
    state.baseLayers = {
      [cartoVoyagerLabel]: cartoVoyagerTileLayer(cartoApiKey),
      "Topo licht (Esri)": esriWorldTopoBasemap(),
      "Licht (Esri)": esriLightGrayBasemap(),
      OpenStreetMap: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap",
      }),
      OpenTopoMap: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
        maxZoom: 17,
        attribution: "&copy; OpenTopoMap (CC-BY-SA)",
      }),
      CyclOSM: L.tileLayer("https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png", {
        maxZoom: 20,
        subdomains: "abc",
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://www.openstreetmap.fr/">OSM France</a>',
      }),
      Satelliet: L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
          maxZoom: 19,
          attribution: "&copy; Esri",
        }
      ),
    };
    const defaultBaseName = cartoApiKey ? cartoVoyagerLabel : "Topo licht (Esri)";
    let chosenBaseName = defaultBaseName;
    try {
      const savedBase = localStorage.getItem(MAP_BASE_LAYER_KEY);
      if (savedBase && state.baseLayers[savedBase]) chosenBaseName = savedBase;
    } catch {
      /* ignore */
    }
    state.activeBaseLayer = state.baseLayers[chosenBaseName];
    state.activeBaseLayer.addTo(state.map);
    syncMapZoomLimitsToBaseLayer(state.activeBaseLayer);
    L.control.layers(state.baseLayers, null, { collapsed: true, position: "topright" }).addTo(state.map);
    state.map.on("baselayerchange", (e) => {
      syncMapZoomLimitsToBaseLayer(e.layer);
      try {
        if (e.name) localStorage.setItem(MAP_BASE_LAYER_KEY, e.name);
      } catch {
        /* ignore */
      }
    });
    updateSearchHint();
    if (!cartoApiKey && /localhost|127\.0\.0\.1/.test(window.location.hostname)) {
      console.info(
        "[FietsKlim] Geen geldige CARTO-sleutel (mapTiles.cartoApiKey / CARTO_API_KEY in firebase-config.js)."
      );
    }

    state.map.setView([50.85, 5.88], 11);

    state.map.on("click", () => {
      if (state.mapMode === "detail") returnToLocalView();
    });

    state.map.on("moveend zoomend", () => {
      if (state.mapMode === "detail") return;
      scheduleViewportRefresh();
      if (
        state.userLatLng &&
        !state.searchQuery.trim() &&
        state.doneFilter === "all" &&
        !state.currentRegionUrl &&
        !selectedCountryCode()
      ) {
        renderList("");
      }
    });

    initGeoLocateControl();
  }

  async function loadRegion(url, options = {}) {
    const { keepSearch = false, selectId = null, fitMap = false } = options;
    const hashOnEntry = window.location.hash.replace("#", "");
    let bundle = state.regionCache.get(url);
    if (!bundle) {
      bundle = await loadJson(url);
      state.regionCache.set(url, bundle);
    }
    state.currentRegionUrl = url;
    syncCountrySelectForRegionUrl(url);
    state.bundle = bundle;
    state.climbs = bundle.climbs || [];
    const src = state.bundle.meta?.source?.name || "onbekend";
    const label = regionTitleFromMeta(state.bundle.meta);
    const sortTag = state.bundle.meta?.source?.sort ? ` · ${state.bundle.meta.source.sort}` : "";
    $("datasetMeta").textContent = `${label} · ${state.climbs.length} klimmen · bron: ${src}${sortTag} · ${state.bundle.meta.updated_at}`;

    if (!keepSearch) {
      state.searchQuery = "";
      const input = $("searchInput");
      if (input) input.value = "";
      if (!hashOnEntry && !selectId) {
        if (window.location.hash) {
          history.replaceState(null, "", window.location.pathname + window.location.search);
        }
        clearDetailSelection();
      }
    }

    renderList(state.searchQuery);
    updateClimbLogSummary();
    updateMobileFiltersSummary();

    const pick =
      selectId ||
      (hashOnEntry && state.climbs.some((c) => c.id === hashOnEntry) ? hashOnEntry : null);

    if (pick && state.climbs.some((c) => c.id === pick)) {
      selectClimb(pick);
      return;
    }

    clearDetailSelection();
    const regionMeta = state.indexRegions.find((x) => x.url === url);
    if (regionMeta) mergeBundleIntoGlobalEntries(regionMeta, state.bundle);
    if (fitMap) {
      focusMapOnRegion();
    } else if (mapEntriesAvailable()) {
      if (state.globalSearchReady) reprioritizeGlobalEntriesForCurrentRegion();
      syncOverviewMarkers({ fit: !pick && !state.searchQuery.trim() && shouldAutoFitMapBounds() });
    }
  }

  async function init() {
    initMap();

    document.addEventListener("click", (e) => {
      if (!e.target.closest("[data-klimpunten-help]")) return;
      e.preventDefault();
      openKlimpuntenHelpDialog();
    });
    $("klimpuntenHelpClose")?.addEventListener("click", () => {
      $("klimpuntenHelpDialog")?.close?.();
    });

    const index = await loadJson("data/index.json");
    state.indexRegions = index.regions || [];
    void loadRegionsGeo().then(() => {
      if (!mapEntriesAvailable()) syncRegionPreviewMarkers();
    });
    updateDatabaseTotals(index);
    fillCountrySelect();
    const countrySel = $("countrySelect");
    const select = $("regionSelect");

    countrySel?.addEventListener("change", () => {
      state.regionFiltersTouched = true;
      state.mapExploreAllRegions = false;
      const prevUrl = state.currentRegionUrl;
      const code = countrySel.value;
      const keepUrl =
        code && prevUrl && regionsForCountry(code).some((r) => r.url === prevUrl) ? prevUrl : "";
      fillRegionSelect(code, keepUrl);
      const nextUrl = select.value;
      if (!nextUrl) {
        clearRegionSelection();
        return;
      }
      if (nextUrl !== state.currentRegionUrl) {
        void loadRegion(nextUrl, { fitMap: true });
      } else if (nextUrl) {
        focusMapOnRegion();
      }
    });

    $("doneFilter")?.addEventListener("change", (e) => {
      state.doneFilter = e.target.value || "all";
      void (async () => {
        if (isLogbookFilterActive()) {
          await ensureGlobalSearchIndex({ background: false });
        }
        renderList(state.searchQuery);
        updateMobileFiltersSummary();
        updateSearchHint();
        if (state.globalSearchReady) {
          if (state.mapMode === "overview") syncOverviewMarkers({ fit: false });
          else refreshViewportClimbs();
        }
      })();
    });

    document.addEventListener("fietsklim-climb-log-changed", () => {
      updateClimbLogSummary();
      renderList(state.searchQuery);
      syncClimbDetailDoneToggle();
      syncProfileExpandLogToggles();
      if (state.activeClimb && isMobileMapPaneActive()) {
        updateMapTouchSheet(state.activeClimb);
      }
      if (state.globalSearchReady && state.mapMode !== "detail") {
        if (state.mapMode === "overview") syncOverviewMarkers({ fit: false });
        else refreshViewportClimbs();
      }
      updateMapDifficultyLegend();
    });

    select.addEventListener("change", () => {
      state.regionFiltersTouched = true;
      state.mapExploreAllRegions = false;
      const url = select.value;
      if (!url) {
        clearRegionSelection();
        return;
      }
      syncCountrySelectForRegionUrl(url);
      void loadRegion(url, { fitMap: true });
    });

    initClimbSearchSuggest();

    initMobileViewSwitch();
    initMobileFiltersCollapse();
    $("mapBackOverview")?.addEventListener("click", () => {
      if (state.mapMode === "detail") returnToLocalView();
      else returnToOverview();
    });
    $("mapMarkVisibleDone")?.addEventListener("click", () => {
      void markVisibleClimbsDone();
    });
    $("profileExpandOpen")?.addEventListener("click", () => openProfileExpand());
    $("profileExpandLink")?.addEventListener("click", () => openProfileExpand());
    $("profileExpandClose")?.addEventListener("click", () => closeProfileExpand());
    $("profileExpandBackdrop")?.addEventListener("click", () => closeProfileExpand());
    function toggleClimbStatusPicker(menuId, btnId, resync) {
      const menu = $(menuId);
      const btn = $(btnId);
      if (!menu || !btn) return;
      if (menu.hidden) {
        closeClimbStatusMenu();
        menu.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        resync();
      } else {
        closeClimbStatusMenu();
      }
    }
    const climbDetailToggles = $("climbDetailStatusToggles");
    if (climbDetailToggles && !climbDetailToggles.dataset.bound) {
      climbDetailToggles.dataset.bound = "1";
      climbDetailToggles.addEventListener("click", (e) => {
        const btn = e.target.closest(".climb-status-icon-btn");
        if (!btn || !climbDetailToggles.contains(btn)) return;
        e.stopPropagation();
        const entry = activeClimbLogEntry();
        if (!entry) return;
        const flag = btn.dataset.flag;
        if (flag === "done") {
          void applyClimbStatusFlags(entry, { done: !climbIsDone(entry) });
        } else if (flag === "wishlist") {
          void applyClimbStatusFlags(entry, { wishlist: !climbIsWishlist(entry) });
        }
      });
    }
    const profileExpandToggles = $("profileExpandStatusToggles");
    if (profileExpandToggles && !profileExpandToggles.dataset.bound) {
      profileExpandToggles.dataset.bound = "1";
      profileExpandToggles.addEventListener("click", (e) => {
        const btn = e.target.closest(".climb-status-icon-btn");
        if (!btn || !profileExpandToggles.contains(btn)) return;
        e.stopPropagation();
        if (!state.activeClimb || !state.bundle?.meta?.id) return;
        const entry = {
          climb: state.activeClimb,
          regionId: state.bundle.meta.id,
          regionUrl: state.currentRegionUrl,
        };
        const flag = btn.dataset.flag;
        if (flag === "done") {
          void applyClimbStatusFlags(entry, { done: !climbIsDone(entry) });
        } else if (flag === "wishlist") {
          void applyClimbStatusFlags(entry, { wishlist: !climbIsWishlist(entry) });
        }
      });
    }
    document.addEventListener("click", (e) => {
      if (e.target.closest(".climb-status-picker")) return;
      closeClimbStatusMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeClimbStatusMenu();
      if (e.key === "Escape" && state.profileExpanded) {
        closeProfileExpand();
        return;
      }
      if (e.key !== "Escape") return;
      if (state.mapMode === "detail") returnToLocalView();
      else if (state.mapMode === "local") returnToOverview();
    });

    $("climbDetailPanel")?.addEventListener("mouseenter", () => {
      if (state.hoverPreviewTimer) {
        clearTimeout(state.hoverPreviewTimer);
        state.hoverPreviewTimer = null;
      }
    });
    document.querySelector(".sidebar")?.addEventListener("mouseleave", (e) => {
      if (state.mapMode === "detail") return;
      const next = e.relatedTarget;
      if (next && e.currentTarget.contains(next)) return;
      if (state.hoverPreviewTimer) {
        clearTimeout(state.hoverPreviewTimer);
        state.hoverPreviewTimer = null;
      }
      clearRouteHoverHighlight();
      if (!state.selectedId) clearClimbPreview();
    });

    fillRegionSelect(countrySel?.value || "", "");
    if (!select.value) {
      $("datasetMeta").textContent =
        "Kies een regio voor de regionale lijst, of gebruik logboek/zoeken voor alle klimmen.";
      updateSearchHint();
    }

    const explorerQuery = parseExplorerQuery();
    const queryClimbId = explorerQuery?.climb || null;
    const hashRegion = window.location.hash.replace("#", "");
    const initialSelectId =
      queryClimbId || (hashRegion && !state.selectedId ? hashRegion : null);

    if (explorerQuery?.dataset) {
      const regionUrl = regionUrlForDatasetId(explorerQuery.dataset);
      if (regionUrl) {
        syncCountrySelectForRegionUrl(regionUrl);
        if (select.value !== regionUrl) select.value = regionUrl;
        await loadRegion(regionUrl, {
          keepSearch: true,
          selectId: initialSelectId,
        });
        seedGlobalEntriesFromCurrentRegion();
      }
    } else if (select.value) {
      syncCountrySelectForRegionUrl(select.value);
      await loadRegion(select.value, {
        selectId: initialSelectId,
      });
      seedGlobalEntriesFromCurrentRegion();
    }

    if (explorerQuery?.climb && state.selectedId) {
      clearExplorerQueryFromUrl();
      syncClimbNavBackBar();
    }

    void ensureGlobalSearchIndex({ background: true }).then(async () => {
      if (explorerQuery?.climb && !state.selectedId) {
        let regionUrl = explorerQuery.dataset
          ? regionUrlForDatasetId(explorerQuery.dataset)
          : null;
        if (!regionUrl) {
          const hit = state.globalEntries.find(({ climb }) => climb.id === explorerQuery.climb);
          regionUrl = hit?.regionUrl;
        }
        if (regionUrl) {
          await selectClimbFromList(explorerQuery.climb, regionUrl);
          clearExplorerQueryFromUrl();
          syncClimbNavBackBar();
          return;
        }
      }
      const deepLink = window.location.hash.replace("#", "");
      if (deepLink && !state.selectedId) {
        const hit = state.globalEntries.find(({ climb }) => climb.id === deepLink);
        if (hit) await selectClimbFromList(hit.climb.id, hit.regionUrl);
      }
      syncClimbNavBackBar();
    });

    $("climbNavBack")?.addEventListener("click", () => {
      FietsKlimClimbLog?.clearNavBack?.();
    });
  }

  function refreshMapSize() {
    if (!state.map) return;
    state.map.invalidateSize();
    if (state.routeLayer) {
      state.map.fitBounds(state.routeLayer.getBounds(), { padding: [30, 30] });
    }
  }

  function isUnlocked() {
    return (
      window.__FIETSKLIM_AUTH_READY === true ||
      document.body.classList.contains("fietsklim-unlocked")
    );
  }

  async function bootExplorer() {
    if (!isUnlocked()) return;
    if (window.__fietsklimExplorerBooted) return;
    window.__fietsklimExplorerBooted = true;
    const meta = $("datasetMeta");
    if (meta) meta.textContent = "Dataset laden…";
    try {
      if (typeof FietsKlimClimbLog !== "undefined") {
        await FietsKlimClimbLog.init();
      }
      await init();
      requestAnimationFrame(() => {
        setTimeout(refreshMapSize, 100);
        setTimeout(refreshMapSize, 500);
      });
    } catch (err) {
      window.__fietsklimExplorerBooted = false;
      console.error(err);
      if (meta) {
        meta.textContent = `Fout bij laden: ${err.message}`;
      }
      alert(
        err.message.includes("Storage")
          ? "Dataset laden mislukt. Zet useStorage: false of upload JSON naar Firebase Storage."
          : err.message
      );
    }
  }

  window.FietsKlimExplorer = { init, selectClimb, loadJson, bootExplorer };

  document.addEventListener("fietsklim-authenticated", () => {
    setTimeout(bootExplorer, 0);
  });

  if (isUnlocked()) {
    setTimeout(bootExplorer, 0);
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        if (isUnlocked()) {
          clearInterval(timer);
          bootExplorer();
        } else if (tries > 40) {
          clearInterval(timer);
        }
      }, 250);
    });
  }
})();
