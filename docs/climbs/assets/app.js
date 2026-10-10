/* FietsKlim database explorer — map + elevation profile (Climbfinder JSON) */

(function () {
  const MIN_ZOOM_NEARBY_ROUTES = 12;
  const MAX_NEARBY_ROUTES = 40;
  const MAX_DIM_ROUTES = 35;
  const COARSE_POINTER_MQ = window.matchMedia("(pointer: coarse)");
  const MOBILE_LAYOUT_MQ = window.matchMedia("(max-width: 900px)");
  const ROUTE_HIT_WEIGHT_COARSE = 22;
  const ROUTE_HIT_WEIGHT_DIM = 16;

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
    if (state.globalSearchReady) {
      if (state.mapMode === "overview") syncOverviewMarkers({ fit: false });
      else refreshViewportClimbs();
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

  /** Goed zichtbaar op groen OSM-terrein (niet teal). */
  const ROUTE_STYLE = {
    active: { color: "#6d28d9", weight: 4, opacity: 0.92 },
    detail: { color: "#5b21b6", weight: 5, opacity: 0.95 },
    dim: { color: "#475569", weight: 2.5, opacity: 0.52 },
    hover: { color: "#7c3aed", weight: 6, opacity: 1 },
  };

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
    if (state.globalSearchReady) {
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

  function syncClimbDetailLogToggles() {
    const logWrap = $("climbDetailLogWrap");
    const doneWrap = $("climbDetailDoneWrap");
    const box = $("climbDetailDone");
    const wishWrap = $("climbDetailWishlistWrap");
    const wishBox = $("climbDetailWishlist");
    if (!logWrap || !doneWrap || !box || !wishWrap || !wishBox) return;
    if (!state.activeClimb || !state.bundle?.meta?.id || state.mapMode !== "detail") {
      logWrap.hidden = true;
      return;
    }
    logWrap.hidden = false;
    doneWrap.hidden = false;
    wishWrap.hidden = false;
    const entry = {
      climb: state.activeClimb,
      regionId: state.bundle.meta.id,
      regionUrl: state.currentRegionUrl,
    };
    box.checked = climbIsDone(entry);
    wishBox.checked = climbIsWishlist(entry);
    box.onchange = () => {
      void toggleClimbDone(entry, box.checked).then(() => {
        renderList(state.searchQuery);
        updateClimbLogSummary();
        if (state.globalSearchReady) {
          if (state.mapMode === "overview") syncOverviewMarkers({ fit: false });
          else refreshViewportClimbs();
        }
      });
    };
    wishBox.onchange = () => {
      void toggleClimbWishlist(entry, wishBox.checked).then(() => {
        renderList(state.searchQuery);
        updateClimbLogSummary();
        if (state.globalSearchReady) {
          if (state.mapMode === "overview") syncOverviewMarkers({ fit: false });
          else refreshViewportClimbs();
        }
      });
    };
  }

  function syncClimbDetailDoneToggle() {
    syncClimbDetailLogToggles();
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
    return Math.round(m) + " m";
  }

  function latLngsFromClimb(climb) {
    return climb.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
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
    const { size = "md", layer, onClick, tooltip } = options;
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
    if (latlngs.length > 1) {
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
    if (!bounds.length && state.globalSearchReady) {
      bounds = boundsForEntries(
        state.globalEntries.filter((e) => e.regionUrl === state.currentRegionUrl)
      );
    }
    if (!bounds.length) return;

    state.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 14 });
    state.mapMode = state.map.getZoom() >= MIN_ZOOM_NEARBY_ROUTES ? "local" : "overview";

    if (state.globalSearchReady) {
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

  function updateSearchHint() {
    const el = $("searchHint");
    if (!el) return;
    if (state.geoHintOverride) {
      el.textContent = state.geoHintOverride;
      el.classList.toggle("field-hint--geo-warn", state.geoHintWarn);
      return;
    }
    el.classList.remove("field-hint--geo-warn");
    const q = state.searchQuery.trim();
    if (mapFilterStrictActive()) {
      el.textContent =
        "Kaart: alleen gekozen land/regio. Klik een klim buiten de filter of deselecteer (kaart naast route) om alles te zien.";
      return;
    }
    if (q) {
      const n = state.globalEntries.filter((entry) => entryMatchesQuery(entry, q.toLowerCase())).length;
      el.textContent = `${n} treffer in alle regio’s (Enter-zoek) — kies uit dropdown voor land/regio + klim.`;
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
        el.textContent =
          n > 0
            ? `Lijst: ${filtered} klimmen (${tag}, alle regio’s). Kaart: ${n} klimmen. Klik klim = regio wisselt mee.`
            : "Index laden…";
      } else if (reg) {
        el.textContent = `Kaart: ${n} klimmen (alle regio’s). Lijst: ${regionTitleFromIndexEntry(reg)} (${regN}). Klik klim (ook grijs) = regio wisselt mee.`;
      } else {
        el.textContent =
          n > 0
            ? `Kaart: ${n} klimmen (alle regio’s). Lijst: kies een regio, of logboek/zoeken.`
            : "Leeg = alle klimmen op kaart. Typ om te filteren, of kies logboek-filter.";
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
    const latlngs = latLngsFromClimb(entry.climb);
    if (latlngs.length < 2) return;
    clearRouteHoverHighlight();
    state.hoveredEntryKey = entryKey(entry);
    state.hoverHighlightGroup = L.layerGroup();
    L.polyline(latlngs, {
      color: "#ffffff",
      weight: 10,
      opacity: 0.96,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(state.hoverHighlightGroup);
    L.polyline(latlngs, { ...ROUTE_STYLE.hover, interactive: false }).addTo(state.hoverHighlightGroup);
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
  }

  function entriesInMapBounds(pad = 0.12) {
    if (!state.map) return [];
    const bounds = state.map.getBounds().pad(pad);
    return mapVisibleEntries().filter(({ climb }) => {
      const ll = climbLatLng(climb);
      if (ll && bounds.contains(ll)) return true;
      const b = climb.bbox;
      if (b && b.length >= 4) {
        const cb = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
        return bounds.intersects(cb);
      }
      return false;
    });
  }

  function refreshViewportClimbs() {
    if (!state.map || !state.globalSearchReady || state.mapMode === "detail") return;

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
      const latlngs = latLngsFromClimb(entry.climb);
      if (latlngs.length < 2) return;
      withRouteKeys.add(entryKey(entry));
      const isDim = style === ROUTE_STYLE.dim;
      const regLabel = regionTitleFromIndexEntry(
        state.indexRegions.find((r) => r.url === entry.regionUrl)
      );
      const tip = regLabel ? `${entry.climb.name} · ${regLabel}` : entry.climb.name;
      const line = L.polyline(latlngs, {
        ...style,
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
      const latlngs = latLngsFromClimb(entry.climb);
      const start = latlngs[0] || climbLatLng(entry.climb);
      if (!start) return;
      const style = { ...climbEndpointStyles(isCoarsePointer() ? "md" : "sm").start };
      if (dimmed) {
        style.fillColor = "#cbd5e1";
        style.color = "#94a3b8";
        style.fillOpacity = 0.75;
      }
      const marker = L.circleMarker(start, style);
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

    for (const entry of inactiveEntries) addStartMarker(entry, true);
    for (const entry of activeEntries) addStartMarker(entry, false);
  }

  function scheduleViewportRefresh() {
    if (state.viewportMoveTimer) clearTimeout(state.viewportMoveTimer);
    state.viewportMoveTimer = setTimeout(() => refreshViewportClimbs(), 120);
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
      if (state.globalSearchReady) syncOverviewMarkers({ fit: false });
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
    if (state.globalSearchReady) syncOverviewMarkers({ fit: true });
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
    });
    state.map.addLayer(state.overviewCluster);
  }

  function syncOverviewMarkers(options = {}) {
    const { fit = false } = options;
    if (!state.map || !state.globalSearchReady) return;
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
    const entries = entriesForMapDisplay();
    const fitBounds = [];
    if (fit && state.currentRegionUrl && !state.searchQuery.trim()) {
      const regionEntries = allEntries.filter((e) => e.regionUrl === state.currentRegionUrl);
      fitBounds.push(...boundsForEntries(regionEntries));
    } else {
      fitBounds.push(...boundsForEntries(mapFilterStrictActive() ? entries : allEntries));
    }
    for (const entry of entries) {
      const latlng = climbLatLng(entry.climb);
      if (!latlng) continue;
      const active = isEntryMapActive(entry);
      const done = climbIsDone(entry);
      const touch = isCoarsePointer();
      const marker = L.circleMarker(latlng, {
        radius: touch ? (active ? 9 : 7) : active ? 6 : 4,
        color: done ? "#15803d" : active ? "#5b21b6" : "#94a3b8",
        weight: active || done ? 2 : 1,
        fillColor: done ? "#22c55e" : active ? "#7c3aed" : "#cbd5e1",
        fillOpacity: active || done ? 0.9 : 0.55,
      });
      const reg = entry.regionTitle ? ` · ${displayRegionTitle(entry.regionTitle)}` : "";
      const activeTip = `${entry.climb.name}${reg}`;
      const dimTip = `${entry.climb.name}${reg}${reg ? " — klik = regio kiezen" : ""}`;
      bindMapTooltip(marker, active ? activeTip : dimTip, { direction: "top" });
      bindMapEntryInteraction(marker, entry);
      state.overviewCluster.addLayer(marker);
    }
    if (fit && shouldAutoFitMapBounds() && fitBounds.length) {
      state.map.fitBounds(fitBounds, { padding: [36, 36], maxZoom: 14 });
    }
    refreshViewportClimbs();
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

    if (needsGlobal && !state.globalSearchReady) {
      list.innerHTML = '<p class="list-hint">Zoekindex laden…</p>';
      void ensureGlobalSearchIndex({ background: false });
      return;
    }

    list.innerHTML = "";
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
    } else if (selectedCountryCode() && state.globalSearchReady) {
      items = applyDoneFilter(state.globalEntries.filter((e) => isEntryMapActive(e)));
      if (state.userLatLng) {
        items = sortEntriesByDistance(items, state.userLatLng);
      }
      if (items.length > 200) {
        items = items.slice(0, 200);
        capped = true;
      }
    } else if (state.globalSearchReady && state.userLatLng && state.map) {
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
        <div class="climb-item-toggles">
          <label class="climb-wishlist-toggle" title="Op wishlist">
            <input type="checkbox" class="climb-wishlist-checkbox" ${wish ? "checked" : ""} aria-label="Wishlist: ${climb.name.replace(/"/g, "&quot;")}" />
          </label>
          <label class="climb-done-toggle" title="Markeer als gedaan">
            <input type="checkbox" class="climb-done-checkbox" ${done ? "checked" : ""} aria-label="Gedaan: ${climb.name.replace(/"/g, "&quot;")}" />
          </label>
        </div>
        <div class="climb-item-body">
          <h3 class="climb-item-title">${categoryBadgeHtml(climb, "sm")}<span>${climb.name}</span></h3>
          ${datasetLine}
          <div class="meta">${formatKm(climb.stats.length_m)} · ${climb.stats.avg_gradient_pct}% gem. · +${formatM(climb.stats.elevation_gain_m)} · ${climb.region || ""}${steepestLabel(climb)}</div>
          <div>${tags} ${cf}</div>
        </div>
      `;
      for (const sel of [".climb-done-checkbox", ".climb-wishlist-checkbox"]) {
        el.querySelector(sel)?.addEventListener("click", (e) => {
          e.stopPropagation();
        });
      }
      el.querySelector(".climb-done-checkbox")?.addEventListener("change", (e) => {
        e.stopPropagation();
        void toggleClimbDone(entry, e.target.checked);
      });
      el.querySelector(".climb-wishlist-checkbox")?.addEventListener("change", (e) => {
        e.stopPropagation();
        void toggleClimbWishlist(entry, e.target.checked);
      });
      el.addEventListener("click", (e) => {
        if (e.target.closest(".climb-item-toggles")) return;
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
  }

  function seedGlobalEntriesFromCurrentRegion() {
    if (!state.bundle || !state.currentRegionUrl || state.globalSearchReady) return;
    const r = state.indexRegions.find((x) => x.url === state.currentRegionUrl);
    if (!r) return;
    state.globalEntries = [];
    state.globalEntryByClimbKey = new Map();
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
    let next = 0;
    let loaded = 0;
    const workers = Math.min(8, Math.max(1, loadOrder.length));

    async function worker() {
      while (next < loadOrder.length) {
        const i = next++;
        const r = loadOrder[i];
        try {
          const bundle = await loadRegionBundle(r);
          mergeBundleIntoGlobalEntries(r, bundle);
          loaded += 1;
          if (background && loaded % 4 === 0) syncOverviewMarkers({ fit: false });
        } catch (err) {
          console.warn("Dataset laden mislukt:", r.url, err);
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: workers }, () => worker()));
      state.globalSearchReady = true;
      syncOverviewMarkers({
        fit: !background && !state.searchQuery.trim() && shouldAutoFitMapBounds(),
      });
    } finally {
      state.searchBusy = false;
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
    if (state.globalSearchReady) syncOverviewMarkers({ fit: true });
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

  function buildDetailRouteLayer(climb, latlngs) {
    const group = L.layerGroup();
    L.polyline(latlngs, {
      color: "#ffffff",
      weight: 10,
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
          weight: 7,
          opacity: 1,
          lineCap: "round",
          lineJoin: "round",
        });
        line.bindTooltip(`${seg.gradientPct}% gem.`, { sticky: true, direction: "top" });
        line.on("click", stopRouteClickToMap);
        line.addTo(group);
      }
    } else {
      const fallback = L.polyline(latlngs, ROUTE_STYLE.detail);
      fallback.on("click", stopRouteClickToMap);
      fallback.addTo(group);
    }

    return group;
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

    if (window.location.hash !== `#${id}`) {
      history.replaceState(null, "", `#${id}`);
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
      if (state.globalSearchReady) {
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

  function initMap() {
    if (state.map) return;
    if (typeof L === "undefined") {
      throw new Error("Leaflet (kaart) is niet geladen. Check netwerk/adblocker.");
    }
    state.map = L.map("map", {
      zoomControl: true,
      keyboard: false,
      tapTolerance: isCoarsePointer() ? 28 : 15,
    });

    state.baseLayers = {
      OpenStreetMap: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap",
      }),
      OpenTopoMap: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
        maxZoom: 17,
        attribution: "&copy; OpenTopoMap (CC-BY-SA)",
      }),
      Satelliet: L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
          maxZoom: 19,
          attribution: "&copy; Esri",
        }
      ),
    };
    state.activeBaseLayer = state.baseLayers.OpenStreetMap;
    state.activeBaseLayer.addTo(state.map);
    L.control.layers(state.baseLayers, null, { collapsed: true, position: "topright" }).addTo(state.map);

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
    if (fitMap) {
      focusMapOnRegion();
    } else if (state.globalSearchReady) {
      reprioritizeGlobalEntriesForCurrentRegion();
      syncOverviewMarkers({ fit: !pick && !state.searchQuery.trim() && shouldAutoFitMapBounds() });
    }
  }

  async function init() {
    initMap();

    const index = await loadJson("data/index.json");
    state.indexRegions = index.regions || [];
    void loadRegionsGeo();
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
      syncClimbDetailLogToggles();
      if (state.globalSearchReady && state.mapMode !== "detail") {
        if (state.mapMode === "overview") syncOverviewMarkers({ fit: false });
        else refreshViewportClimbs();
      }
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
    $("profileExpandOpen")?.addEventListener("click", () => openProfileExpand());
    $("profileExpandLink")?.addEventListener("click", () => openProfileExpand());
    $("profileExpandClose")?.addEventListener("click", () => closeProfileExpand());
    $("profileExpandBackdrop")?.addEventListener("click", () => closeProfileExpand());
    document.addEventListener("keydown", (e) => {
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

    const hashRegion = window.location.hash.replace("#", "");
    if (select.value) {
      syncCountrySelectForRegionUrl(select.value);
      await loadRegion(select.value, {
        selectId: hashRegion && !state.selectedId ? hashRegion : null,
      });
      seedGlobalEntriesFromCurrentRegion();
    }

    void ensureGlobalSearchIndex({ background: true }).then(async () => {
      const deepLink = window.location.hash.replace("#", "");
      if (deepLink && !state.selectedId) {
        const hit = state.globalEntries.find(({ climb }) => climb.id === deepLink);
        if (hit) await selectClimbFromList(hit.climb.id, hit.regionUrl);
      }
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
